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
  /[A-Z]:\\[\w\s.-]+\\[\w\s.-]+/, // Windows absolute paths (drive + 2+ segments)
  /jdbc:|mysql:\/\/|postgres(?:ql)?:\/\/|mongodb(?:\+srv)?:\/\//i, // DB connection strings
];

export const INTERNAL_IP_PATTERNS = [
  /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,
  /\b172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/,
  /\b192\.168\.\d{1,3}\.\d{1,3}\b/,
  /\b127\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,
  /\b::1\b/, // IPv6 loopback
  /\bfe80:/i, // IPv6 link-local
  /\bf[cd][0-9a-f]{2}:/i, // IPv6 unique local (fc00::/fd00::)
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
