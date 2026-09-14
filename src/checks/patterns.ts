/**
 * Spec-neutral pattern tables shared by every suite. Nothing here depends
 * on the protocol era: injection payloads, leak signatures and rejection
 * heuristics are properties of tool implementations, not of the wire.
 */

/** Content block types a tool result may carry (unchanged in 2026-07-28). */
export const VALID_CONTENT_TYPES = ["text", "image", "audio", "resource", "resource_link"];

export const INJECTION_PAYLOADS = {
  command: ["; cat /etc/passwd", "$(whoami)", "| ls -la", "`id`", "&& echo pwned"],
  sql: ["' OR 1=1 --", "'; DROP TABLE users; --", "1 UNION SELECT * FROM information_schema.tables--"],
  pathTraversal: ["../../etc/passwd", "..\\..\\windows\\system.ini", "%2e%2e%2f%2e%2e%2fetc%2fpasswd"],
  ssrf: ["http://169.254.169.254/latest/meta-data/", "http://127.0.0.1:22", "http://[::1]/", "http://10.0.0.1/"],
};

// Patterns that indicate leakage of server internals in an error
// response. The test name (security-error-no-stacktrace) is historical —
// this catches stack traces *and* adjacent implementation-detail leaks
// (filesystem paths, DB connection strings) as the rubric calls out.
// Deliberately NOT included:
//   - /password|passwd|secret|credential/i — false-positives every
//     legitimate auth error ("Invalid password", "Missing credential").
//     If you want a secrets-leak check, it belongs in its own test with
//     a narrower signature (e.g. Bearer tokens, AWS keys).
//   - bare /ENOENT|EACCES|EPERM/ — these appear in well-formed error
//     messages ("ENOENT: no such file"), so we only flag them when they
//     co-occur with a filesystem path below.

/**
 * Windows absolute paths (drive + 2+ segments), any drive-letter case. The
 * samples the suites scan are JSON-serialised, so a path separator arrives
 * as a doubled backslash (`C:\\Users\\svc`) while a lone backslash is the
 * start of a JSON escape (`ERROR:\n  Expected string` is `R:` + `\n`, not
 * a drive). A separator is therefore either two backslashes or one that
 * does not begin an escape sequence; the second form keeps raw (non-JSON)
 * bodies covered, at the cost of a raw path whose segment starts with an
 * escape letter (`C:\temp\x` outside JSON), which stays unmatched.
 */
const WINDOWS_PATH_SEPARATOR = String.raw`(?:\\\\|\\(?![\\nrtbfu"/]))`;
export const WINDOWS_PATH_PATTERN = new RegExp(
  String.raw`[A-Za-z]:${WINDOWS_PATH_SEPARATOR}[\w\s.-]+${WINDOWS_PATH_SEPARATOR}[\w\s.-]+`,
);

export const STACK_TRACE_PATTERNS = [
  /at\s+\S+\s+\(.*:\d+:\d+\)/i, // Node.js: "at Function (file.js:10:5)"
  /Traceback\s+\(most recent/i, // Python
  /\.py",\s+line\s+\d+/i, // Python file reference
  /\.java:\d+\)/i, // Java
  /\.go:\d+/i, // Go
  /from\s+\S+\.rb:\d+/i, // Ruby
  /\.cs:line\s+\d+/i, // C#/.NET
  /#\d+\s+\/.*\.php\(\d+\)/i, // PHP
  /panicked\s+at\s+'/i, // Rust
  /node_modules\//, // Node.js module paths (filesystem layout leak)
  /\/usr\/local\/|\/home\/|\/root\//, // Unix absolute paths
  WINDOWS_PATH_PATTERN,
  /jdbc:|mysql:\/\/|postgres(?:ql)?:\/\/|mongodb(?:\+srv)?:\/\//i, // DB connection strings
];

/**
 * Internal hostnames (db01.corp.internal, cache.lan:6379). The suffix must
 * be the LAST label -- lowercase, not followed by a label character or
 * another label -- so `foo.internal-api.example.com`, `example.lan-party.com`
 * and `settings.local.json` are not hostnames. A bare `label.suffix` is a
 * property path as often as a host (`ctx.internal`, `settings.local`), so
 * it needs hostname context: at least two labels before the suffix, or a
 * preceding `//`, `@`, `getaddrinfo`/ENOTFOUND/EAI_AGAIN, or a `:port`.
 */
const HOST_LABEL = "[a-z0-9-]+";
const INTERNAL_HOST_SUFFIX = "(?:internal|local|corp|lan|intranet)";
const HOST_END = String.raw`(?![\w-]|\.\w)`;
export const INTERNAL_HOSTNAME_PATTERN = new RegExp(
  [
    String.raw`\b${HOST_LABEL}(?:\.${HOST_LABEL})+\.${INTERNAL_HOST_SUFFIX}${HOST_END}`,
    String.raw`(?<=\/\/|@|getaddrinfo |ENOTFOUND |EAI_AGAIN )${HOST_LABEL}\.${INTERNAL_HOST_SUFFIX}${HOST_END}`,
    String.raw`\b${HOST_LABEL}\.${INTERNAL_HOST_SUFFIX}(?=:\d)`,
  ].join("|"),
);

export const INTERNAL_IP_PATTERNS = [
  /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,
  /\b172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/,
  /\b192\.168\.\d{1,3}\.\d{1,3}\b/,
  /\b127\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,
  /\b169\.254\.\d{1,3}\.\d{1,3}\b/, // IPv4 link-local, incl. the cloud metadata service
  // IPv6 loopback in its usual forms: `::1`, `[::1]:5432`, `::1:5432`. No
  // hex digit or colon may precede it, so `2001:db8::1` (a public address
  // ending in ::1) is not loopback.
  /(?<![0-9a-f:])::1(?![0-9a-f])/i,
  /\bfe80:/i, // IPv6 link-local
  /\bf[cd][0-9a-f]{2}:/i, // IPv6 unique local (fc00::/fd00::)
  INTERNAL_HOSTNAME_PATTERN,
];

/**
 * Phrases that mean a server REJECTED an injection payload. If a tool
 * response contains both the payload (suggesting execution) AND a
 * rejection pattern, treat as a pass — the server defended correctly and
 * just happened to echo the payload in its error message. Without this,
 * well-defended servers like @modelcontextprotocol/server-filesystem look
 * like they're vulnerable just because their error responses include the
 * offending input.
 */
export const REJECTION_PATTERNS = [
  /access denied/i,
  /permission denied/i,
  /not allowed/i,
  /not permitted/i,
  /outside (allowed|permitted)/i,
  /forbidden/i,
  /unauthorized/i,
  /invalid (path|input|argument|parameter|request)/i,
  /(payload|request) (rejected|blocked|refused)/i,
  /enoent|eacces|eperm/i,
  /sandbox(ed)?/i,
  /(no such file|file not found)/i,
  /\binvalid\b.*\b(input|json|argument|parameter|character)/i,
];

export function looksRejected(text: string, isErrorFlag: boolean): boolean {
  if (isErrorFlag) return true;
  return REJECTION_PATTERNS.some((p) => p.test(text));
}

/** Tool-description poisoning signatures (security-tool-description-poisoning). */
export const POISONING_PATTERNS = [
  { pattern: /ignore\s+(all\s+)?previous/i, label: "ignore previous instructions" },
  { pattern: /override\s+(system|instructions|rules)/i, label: "override instructions" },
  { pattern: /system\s+prompt/i, label: "system prompt reference" },
  { pattern: /you\s+must\s+(always|never)/i, label: "behavioral override" },
  { pattern: /do\s+not\s+(tell|inform|mention)/i, label: "concealment instruction" },
  { pattern: /\b[A-Za-z0-9+/]{40,}={0,2}\b/, label: "possible Base64-encoded payload" },
  // Zero-width characters (U+200B, U+200C, U+200D, U+FEFF)
  { pattern: /\u200B|\u200C|\u200D|\uFEFF/, label: "hidden Unicode characters" },
];
