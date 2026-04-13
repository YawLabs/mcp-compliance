import { createRequire } from "node:module";
import { request } from "undici";
import { generateBadge } from "./badge.js";
import { computeScore } from "./grader.js";
import { type HttpTransport, createHttpTransport } from "./transport/http.js";
import type { Transport } from "./transport/index.js";
import { createStdioTransport } from "./transport/stdio.js";
import type { ComplianceReport, TestDefinition, TestResult, TransportTarget } from "./types.js";
import { REPORT_SCHEMA_VERSION, TEST_DEFINITIONS } from "./types.js";

export type { TestResult, ComplianceReport } from "./types.js";
export { TEST_DEFINITIONS } from "./types.js";
export { computeGrade, computeScore } from "./grader.js";
export { generateBadge } from "./badge.js";

const TEST_DEFINITIONS_MAP = new Map(TEST_DEFINITIONS.map((t) => [t.id, t]));

const _require = createRequire(import.meta.url);
const { version: TOOL_VERSION } = _require("../package.json");

export const SPEC_VERSION = "2025-11-25";
export const SPEC_BASE = `https://modelcontextprotocol.io/specification/${SPEC_VERSION}`;

const VALID_CONTENT_TYPES = ["text", "image", "audio", "resource", "resource_link"];

const INJECTION_PAYLOADS = {
  command: ["; cat /etc/passwd", "$(whoami)", "| ls -la", "`id`", "&& echo pwned"],
  sql: ["' OR 1=1 --", "'; DROP TABLE users; --", "1 UNION SELECT * FROM information_schema.tables--"],
  pathTraversal: ["../../etc/passwd", "..\\..\\windows\\system.ini", "%2e%2e%2f%2e%2e%2fetc%2fpasswd"],
  ssrf: ["http://169.254.169.254/latest/meta-data/", "http://127.0.0.1:22", "http://[::1]/", "http://10.0.0.1/"],
};

const STACK_TRACE_PATTERNS = [
  /at\s+\S+\s+\(.*:\d+:\d+\)/i, // Node.js: "at Function (file.js:10:5)"
  /Traceback\s+\(most recent/i, // Python
  /\.py",\s+line\s+\d+/i, // Python file reference
  /\.java:\d+\)/i, // Java
  /\.go:\d+/i, // Go
  /from\s+\S+\.rb:\d+/i, // Ruby
  /\.cs:line\s+\d+/i, // C#/.NET
  /#\d+\s+\/.*\.php\(\d+\)/i, // PHP
  /panicked\s+at\s+'/i, // Rust
  /ENOENT|EACCES|EPERM/, // Node.js system errors
  /node_modules\//, // Node.js module paths
  /\/usr\/local\/|\/home\//, // Unix paths
  /[A-Z]:\\.*\\/, // Windows paths
  /password|passwd|secret|credential/i, // Sensitive terms
  /jdbc:|mysql:|postgres:|mongodb:/i, // DB connection strings
];

const INTERNAL_IP_PATTERNS = [
  /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,
  /\b172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/,
  /\b192\.168\.\d{1,3}\.\d{1,3}\b/,
  /\b127\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,
  /\b::1\b/, // IPv6 loopback
  /\bfe80:/i, // IPv6 link-local
  /\bf[cd][0-9a-f]{2}:/i, // IPv6 unique local (fc00::/fd00::)
];

function createIdCounter(start = 0) {
  let id = start;
  return () => ++id;
}

/**
 * Parse SSE (text/event-stream) response body.
 * Handles multi-line data fields per the SSE specification:
 * consecutive "data:" lines are concatenated with "\n".
 * An empty line marks the end of an event.
 * @internal Exported for testing.
 */
export { parseSSEResponse } from "./sse.js";
import { parseSSEResponse } from "./sse.js";

/**
 * Known-HTTP-only tests that use raw HTTP primitives (status codes,
 * headers, TLS, metadata discovery) and have no meaningful stdio
 * equivalent. Kept in code rather than TEST_DEFINITIONS for easy churn.
 */
const STDIO_INCOMPATIBLE_IDS = new Set<string>([
  // Lifecycle tests that use raw undici for HTTP-specific checks
  "lifecycle-string-id",
  // Lifecycle tests that interpret HTTP status codes — for stdio these
  // would always read as the wrapper's default 200 and produce
  // misleading "(HTTP 200)" failure messages.
  "lifecycle-reinit-reject",
  "lifecycle-cancellation",
  "lifecycle-progress",
  "lifecycle-progress-token",
  // Error tests that send hand-crafted malformed bytes via raw HTTP
  // (JSON-RPC layer would reject them before they hit the wire). Could
  // be reimplemented for stdio later by writing raw bytes to stdin.
  "error-invalid-jsonrpc",
  "error-invalid-json",
  "error-parse-code",
  "error-invalid-request-code",
  // Security tests that are inherently HTTP-layer (auth headers,
  // sessions, CORS, TLS, rate limits, RFC 9728 metadata). For stdio
  // servers these don't apply — the parent process owns the trust
  // boundary, not the server.
  "security-tls-required",
  "security-oauth-metadata",
  "security-token-in-uri",
  "security-rate-limiting",
  "security-cors-headers",
  "security-origin-validation",
  "security-session-not-auth",
  "security-auth-required",
  "security-auth-malformed",
  "security-www-authenticate",
  "security-session-entropy",
]);

/**
 * Checks whether a test applies to the active transport.
 * HTTP runs every test. Stdio skips:
 *   - the entire transport category (all HTTP wire-format tests);
 *   - individual tests flagged via `transports` in TEST_DEFINITIONS;
 *   - individual tests in STDIO_INCOMPATIBLE_IDS above.
 */
function supportsTransport(def: TestDefinition | undefined, kind: "http" | "stdio"): boolean {
  if (!def) return true;
  if (def.transports) return def.transports.includes(kind);
  if (kind === "http") return true;
  if (def.category === "transport") return false;
  if (STDIO_INCOMPATIBLE_IDS.has(def.id)) return false;
  return true;
}

export interface PreviewOptions {
  /** Transport to filter against. Defaults to "http". */
  transport?: "http" | "stdio";
  /** Only include matching categories or test IDs. */
  only?: string[];
  /** Exclude matching categories or test IDs. */
  skip?: string[];
}

/**
 * Return the set of TestDefinitions that would actually run given the
 * filters. Powers the CLI's --list flag without requiring a connection.
 * Capability-gated tests are still included — that gating happens after
 * the live initialize handshake and can't be predicted offline.
 */
export function previewTests(opts: PreviewOptions = {}): TestDefinition[] {
  const transport = opts.transport ?? "http";
  return TEST_DEFINITIONS.filter((def) => {
    if (!supportsTransport(def, transport)) return false;
    if (opts.only?.length) {
      if (!opts.only.includes(def.category) && !opts.only.includes(def.id)) return false;
    }
    if (opts.skip?.length) {
      if (opts.skip.includes(def.category) || opts.skip.includes(def.id)) return false;
    }
    return true;
  });
}

export interface RunOptions {
  /** Optional callback for progress updates (legacy minimal signature). */
  onProgress?: (testId: string, passed: boolean, details: string) => void;
  /**
   * Optional callback fired after each test completes with the full
   * TestResult (category, required, durationMs, specRef). Prefer this
   * over onProgress for live dashboards and streaming UIs that need
   * structured data per test.
   */
  onTestComplete?: (result: TestResult) => void;
  /** Extra headers to include on all requests */
  headers?: Record<string, string>;
  /** Request timeout in milliseconds (default: 15000) */
  timeout?: number;
  /** Number of retries for failed tests (default: 0) */
  retries?: number;
  /** Only run tests matching these category names or test IDs */
  only?: string[];
  /** Skip tests matching these category names or test IDs */
  skip?: string[];
  /** Preflight connectivity check timeout in milliseconds (default: min(timeout, 10000)) */
  preflightTimeout?: number;
}

/**
 * Run the full MCP compliance test suite. Accepts either a URL string
 * (HTTP) or a TransportTarget descriptor (HTTP or stdio).
 */
export async function runComplianceSuite(
  target: string | TransportTarget,
  options: RunOptions = {},
): Promise<ComplianceReport> {
  const resolvedTarget: TransportTarget =
    typeof target === "string" ? { type: "http", url: target, headers: options.headers } : target;

  // Validate the target per transport.
  if (resolvedTarget.type === "http") {
    try {
      const parsed = new URL(resolvedTarget.url);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        throw new Error("Only HTTP and HTTPS URLs are supported");
      }
    } catch (e: unknown) {
      if (e instanceof Error && e.message.includes("Only HTTP")) throw e;
      throw new Error(`Invalid URL: ${resolvedTarget.url}`);
    }
  } else if (!resolvedTarget.command) {
    throw new Error("stdio target requires a command");
  }

  // Construct transport.
  const transport: Transport =
    resolvedTarget.type === "http"
      ? createHttpTransport({
          url: resolvedTarget.url,
          headers: resolvedTarget.headers ?? options.headers,
        })
      : createStdioTransport({
          command: resolvedTarget.command,
          args: resolvedTarget.args,
          env: resolvedTarget.env,
          cwd: resolvedTarget.cwd,
          verbose: resolvedTarget.verbose,
        });

  // Wrap everything below in try/finally so the child process is always
  // cleaned up — even if a test throws or the runner aborts mid-suite.
  try {
    // For HTTP, preserve the backwards-compatible `backendUrl` local for the
    // raw-undici code paths that inspect HTTP-specific behavior (status
    // codes, headers, batch requests, etc). Those paths are gated to the
    // HTTP transport via supportsTransport().
    const backendUrl = resolvedTarget.type === "http" ? resolvedTarget.url : "";
    const userHeaders = resolvedTarget.type === "http" ? (resolvedTarget.headers ?? options.headers ?? {}) : {};

    // Display URL for warnings and reports.
    const displayUrl =
      resolvedTarget.type === "http"
        ? resolvedTarget.url
        : `stdio:${resolvedTarget.command}${resolvedTarget.args?.length ? ` ${resolvedTarget.args.join(" ")}` : ""}`;

    // Preflight connectivity check — fail fast instead of running all tests
    // against an unreachable server. HTTP-only: a quick ping catches DNS,
    // TLS, and connection-refused failures before we burn through 80
    // tests. For stdio there's no equivalent — spawn errors surface via
    // the child 'error' event (handled by the transport) and the
    // lifecycle-init test is the real reachability signal.
    let serverReachable = true;
    if (resolvedTarget.type === "http") {
      try {
        const preflightTimeout = options.preflightTimeout ?? Math.min(options.timeout || 15000, 10000);
        const preflight = await request(resolvedTarget.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            ...userHeaders,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }),
          signal: AbortSignal.timeout(preflightTimeout),
        });
        await preflight.body.text();
      } catch {
        serverReachable = false;
      }
    }

    const tests: TestResult[] = [];
    const warnings: string[] = [];
    if (!serverReachable) {
      warnings.push(
        `Server at ${displayUrl} is unreachable — all tests will fail. Check the URL or command and ensure the server is running.`,
      );
    }
    // Use high start offset for the main ID counter to avoid collision with transport test hardcoded IDs
    const nextId = createIdCounter(1000);
    const timeout = options.timeout || 15000;
    const retries = options.retries || 0;

    // Session state — kept as locals for backwards-compat with existing
    // call sites that reference `sessionId`/`negotiatedProtocolVersion`
    // directly. Updates are mirrored to the transport so any transport
    // that cares (future work) can read them.
    let sessionId: string | null = null;
    let negotiatedProtocolVersion: string | null = null;

    function buildHeaders(): Record<string, string> {
      const h: Record<string, string> = { ...userHeaders };
      if (sessionId) h["mcp-session-id"] = sessionId;
      if (negotiatedProtocolVersion) h["mcp-protocol-version"] = negotiatedProtocolVersion;
      return h;
    }

    // Local closures with the old signatures — delegate to the transport.
    // The `_backendUrl` parameter is ignored (transport already knows the
    // URL) but kept for minimal churn at call sites.
    async function mcpRequest(
      _backendUrl: string,
      method: string,
      params: unknown | undefined,
      idCounter: () => number,
      extraHeaders: Record<string, string> | undefined,
      timeoutMs: number,
    ): Promise<{ statusCode: number; body: any; headers: Record<string, string>; requestId: number }> {
      const res = await transport.request(method, params, idCounter, {
        timeout: timeoutMs,
        headers: extraHeaders,
      });
      return {
        statusCode: res.statusCode ?? 200,
        body: res.body as any,
        headers: res.headers ?? {},
        requestId: res.requestId,
      };
    }
    async function mcpNotification(
      _backendUrl: string,
      method: string,
      params: unknown | undefined,
      extraHeaders: Record<string, string> | undefined,
      timeoutMs: number,
    ) {
      const res = await transport.notify(method, params, {
        timeout: timeoutMs,
        headers: extraHeaders,
      });
      return { statusCode: res.statusCode ?? 200, headers: res.headers ?? {} };
    }

    const rpc = (method: string, params?: unknown) =>
      mcpRequest(backendUrl, method, params, nextId, buildHeaders(), timeout);

    function shouldRun(id: string, category: string): boolean {
      const def = TEST_DEFINITIONS_MAP.get(id);
      if (!supportsTransport(def, transport.kind)) return false;
      if (options.only && options.only.length > 0) {
        return options.only.includes(category) || options.only.includes(id);
      }
      if (options.skip && options.skip.length > 0) {
        return !options.skip.includes(category) && !options.skip.includes(id);
      }
      return true;
    }

    const serverInfo = {
      protocolVersion: null as string | null,
      name: null as string | null,
      version: null as string | null,
      capabilities: {} as Record<string, unknown>,
    };
    let toolCount = 0;
    let toolNames: string[] = [];
    let resourceCount = 0;
    let resourceNames: string[] = [];
    let promptCount = 0;
    let promptNames: string[] = [];

    async function test(
      id: string,
      name: string,
      category: TestResult["category"],
      required: boolean,
      specRef: string,
      fn: () => Promise<{ passed: boolean; details: string }>,
    ): Promise<void> {
      if (!shouldRun(id, category)) return;

      const start = Date.now();
      let lastResult = { passed: false, details: "" };

      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          lastResult = await fn();
          if (lastResult.passed) break;
          if (attempt < retries) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          lastResult = { passed: false, details: `Error: ${message}` };
          if (attempt < retries) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        }
      }

      const result: TestResult = {
        id,
        name,
        category,
        required,
        passed: lastResult.passed,
        details: lastResult.details,
        durationMs: Date.now() - start,
        specRef: `${SPEC_BASE}/${specRef}`,
      };
      tests.push(result);
      options.onProgress?.(id, lastResult.passed, lastResult.details);
      options.onTestComplete?.(result);
    }

    // ── 1. TRANSPORT (basic, pre-init) ───────────────────────────────

    await test(
      "transport-post",
      "HTTP POST accepted",
      "transport",
      true,
      "basic/transports#streamable-http",
      async () => {
        const res = await request(backendUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            ...userHeaders,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 99901, method: "ping" }),
          signal: AbortSignal.timeout(timeout),
        });
        const text = await res.body.text();
        if (res.statusCode >= 200 && res.statusCode < 300) {
          return { passed: true, details: `HTTP ${res.statusCode}` };
        }
        if (res.statusCode === 401 || res.statusCode === 403) {
          return { passed: false, details: `HTTP ${res.statusCode} (auth required — pass --auth)` };
        }
        // 400 with a JSON-RPC error body is acceptable — server processed the POST
        // but rejected the pre-init request (e.g., session required)
        if (res.statusCode === 400) {
          try {
            const body = JSON.parse(text);
            if (body?.error || body?.jsonrpc) {
              return {
                passed: true,
                details: "HTTP 400 with JSON-RPC response (server requires initialization first)",
              };
            }
          } catch {}
        }
        return { passed: false, details: `HTTP ${res.statusCode}` };
      },
    );

    await test(
      "transport-content-type",
      "Responds with JSON or SSE",
      "transport",
      true,
      "basic/transports#streamable-http",
      async () => {
        const res = await request(backendUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            ...userHeaders,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 99902, method: "ping" }),
          signal: AbortSignal.timeout(timeout),
        });
        await res.body.text();
        const rawCt = res.headers["content-type"];
        const ct = (Array.isArray(rawCt) ? rawCt[0] : rawCt || "").toLowerCase();
        const valid = ct.includes("application/json") || ct.includes("text/event-stream");
        return { passed: valid, details: `Content-Type: ${ct}` };
      },
    );

    await test(
      "transport-content-type-reject",
      "Rejects non-JSON request Content-Type",
      "transport",
      false,
      "basic/transports#streamable-http",
      async () => {
        // Send a request with text/plain instead of application/json
        const res = await request(backendUrl, {
          method: "POST",
          headers: { "Content-Type": "text/plain", Accept: "application/json, text/event-stream", ...userHeaders },
          body: JSON.stringify({ jsonrpc: "2.0", id: 99905, method: "ping" }),
          signal: AbortSignal.timeout(timeout),
        });
        await res.body.text();
        if (res.statusCode >= 400 && res.statusCode < 500) {
          return { passed: true, details: `HTTP ${res.statusCode} (incorrect Content-Type rejected)` };
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          return {
            passed: false,
            details: `HTTP ${res.statusCode} — server accepted text/plain Content-Type (should require application/json)`,
          };
        }
        return { passed: false, details: `HTTP ${res.statusCode}` };
      },
    );

    await test(
      "transport-get",
      "GET returns SSE stream or 405",
      "transport",
      false,
      "basic/transports#streamable-http",
      async () => {
        const getHeaders: Record<string, string> = { Accept: "text/event-stream", ...buildHeaders() };
        const res = await request(backendUrl, {
          method: "GET",
          headers: getHeaders,
          signal: AbortSignal.timeout(timeout),
        });
        const body = await res.body.text();
        const rawCt = res.headers["content-type"];
        const ct = (Array.isArray(rawCt) ? rawCt[0] : rawCt || "").toLowerCase();
        if (res.statusCode === 405) {
          return { passed: true, details: "HTTP 405 Method Not Allowed (acceptable)" };
        }
        if (ct.includes("text/event-stream")) {
          // Validate the SSE payload has proper format if non-empty
          if (body.trim().length > 0) {
            const hasDataFields = body.includes("data:");
            const hasEventFields = body.includes("event:");
            if (!hasDataFields && !hasEventFields) {
              return {
                passed: false,
                details: "Content-Type is text/event-stream but body has no SSE data: or event: fields",
              };
            }
          }
          return { passed: true, details: "Returns text/event-stream with valid SSE format" };
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          return { passed: true, details: `HTTP ${res.statusCode} (accepted)` };
        }
        return { passed: false, details: `HTTP ${res.statusCode}, Content-Type: ${ct}` };
      },
    );

    await test(
      "transport-batch-reject",
      "Rejects JSON-RPC batch requests",
      "transport",
      true,
      "basic/transports#streamable-http",
      async () => {
        const res = await request(backendUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            ...userHeaders,
          },
          body: JSON.stringify([
            { jsonrpc: "2.0", id: 99903, method: "ping" },
            { jsonrpc: "2.0", id: 99904, method: "ping" },
          ]),
          signal: AbortSignal.timeout(timeout),
        });
        const text = await res.body.text();
        // Server should reject batch with error or 4xx
        if (res.statusCode >= 400 && res.statusCode < 500) {
          return { passed: true, details: `HTTP ${res.statusCode} (batch rejected)` };
        }
        try {
          const body = JSON.parse(text);
          if (body?.error) {
            return { passed: true, details: `JSON-RPC error: ${body.error.code} — ${body.error.message}` };
          }
          // If server returned a batch response (array), that's a failure
          if (Array.isArray(body)) {
            return { passed: false, details: "Server processed batch request (MCP forbids batch)" };
          }
        } catch {}
        return { passed: false, details: `HTTP ${res.statusCode} — expected error or 4xx for batch request` };
      },
    );

    // ── 2. LIFECYCLE SETUP (always runs) ─────────────────────────────

    let initRes: any = null;
    try {
      initRes = await rpc("initialize", {
        protocolVersion: SPEC_VERSION,
        capabilities: {},
        clientInfo: { name: "mcp-compliance", version: TOOL_VERSION },
      });
      const result = initRes?.body?.result;
      if (result) {
        serverInfo.protocolVersion = result.protocolVersion || null;
        serverInfo.name = result.serverInfo?.name || null;
        serverInfo.version = result.serverInfo?.version || null;
        serverInfo.capabilities = result.capabilities || {};
        const sid = initRes.headers["mcp-session-id"];
        if (sid) {
          sessionId = sid;
          transport.setSessionId(sid);
        }
        if (result.protocolVersion) {
          negotiatedProtocolVersion = result.protocolVersion;
          transport.setProtocolVersion(result.protocolVersion);
        }
      }
    } catch {
      // Init failed — lifecycle tests will report the failure
    }

    // Send initialized notification (always, for session setup)
    try {
      await mcpNotification(backendUrl, "notifications/initialized", undefined, buildHeaders(), timeout);
    } catch {}

    // Capability flags computed once post-init. Some later-section tests
    // read these from closures declared before the tools/resources/prompts
    // sections; hoist them here to avoid TDZ errors.
    const hasTools = !!serverInfo.capabilities.tools;
    const hasResources = !!serverInfo.capabilities.resources;
    const hasPrompts = !!serverInfo.capabilities.prompts;

    // ── 3. LIFECYCLE TESTS ───────────────────────────────────────────

    await test(
      "lifecycle-init",
      "Initialize handshake",
      "lifecycle",
      true,
      "basic/lifecycle#initialization",
      async () => {
        if (!initRes) return { passed: false, details: "Initialize request failed" };
        const result = initRes.body?.result;
        if (!result) return { passed: false, details: "No result in response" };
        return { passed: !!result.protocolVersion, details: `Protocol: ${result.protocolVersion || "missing"}` };
      },
    );

    await test(
      "lifecycle-proto-version",
      "Returns valid protocol version",
      "lifecycle",
      true,
      "basic/lifecycle#version-negotiation",
      async () => {
        const version = initRes?.body?.result?.protocolVersion;
        if (!version) return { passed: false, details: "No protocolVersion" };
        const valid = /^\d{4}-\d{2}-\d{2}$/.test(version);
        if (valid && version !== SPEC_VERSION) {
          warnings.push(`Server negotiated protocol version ${version} (latest is ${SPEC_VERSION})`);
        }
        return { passed: valid, details: `Version: ${version}` };
      },
    );

    await test(
      "lifecycle-version-negotiate",
      "Handles unknown protocol version",
      "lifecycle",
      false,
      "basic/lifecycle#version-negotiation",
      async () => {
        // Send initialize with a future version — server should respond with its own supported version
        try {
          const futureRes = await mcpRequest(
            backendUrl,
            "initialize",
            {
              protocolVersion: "2099-01-01",
              capabilities: {},
              clientInfo: { name: "mcp-compliance", version: TOOL_VERSION },
            },
            createIdCounter(99960),
            userHeaders,
            timeout,
          );
          const result = futureRes.body?.result;
          const error = futureRes.body?.error;
          if (error) {
            return {
              passed: true,
              details: `Server rejected unknown version with error: ${error.code} — ${error.message}`,
            };
          }
          if (result?.protocolVersion) {
            const offered = result.protocolVersion;
            if (offered === "2099-01-01") {
              return {
                passed: false,
                details:
                  'Server accepted impossible future version "2099-01-01" — should offer a version it actually supports',
              };
            }
            return { passed: true, details: `Server negotiated down to ${offered} (correct)` };
          }
          return { passed: false, details: "No protocolVersion or error in response" };
        } catch {
          return { passed: true, details: "Connection rejected for unknown version (acceptable)" };
        }
      },
    );

    await test(
      "lifecycle-server-info",
      "Includes serverInfo",
      "lifecycle",
      false,
      "basic/lifecycle#initialization",
      async () => {
        const info = initRes?.body?.result?.serverInfo;
        return { passed: !!info?.name, details: info ? `${info.name} v${info.version || "?"}` : "Missing serverInfo" };
      },
    );

    await test(
      "lifecycle-capabilities",
      "Returns capabilities object",
      "lifecycle",
      true,
      "basic/lifecycle#capability-negotiation",
      async () => {
        const caps = initRes?.body?.result?.capabilities;
        if (!caps || typeof caps !== "object") return { passed: false, details: "No capabilities object in response" };
        const declared = Object.keys(caps).filter((k) => caps[k] !== undefined);
        return {
          passed: true,
          details: declared.length > 0 ? `Capabilities: ${declared.join(", ")}` : "Empty capabilities (valid)",
        };
      },
    );

    await test("lifecycle-jsonrpc", "Response is valid JSON-RPC 2.0", "lifecycle", true, "basic", async () => {
      const body = initRes?.body;
      const valid =
        body?.jsonrpc === "2.0" && body?.id !== undefined && (body?.result !== undefined || body?.error !== undefined);
      return {
        passed: valid,
        details: valid ? "Valid JSON-RPC 2.0 response" : `Missing fields: jsonrpc=${body?.jsonrpc}, id=${body?.id}`,
      };
    });

    await test("lifecycle-ping", "Responds to ping", "lifecycle", true, "basic/utilities#ping", async () => {
      const res = await rpc("ping");
      const body = res.body;
      if (body?.error) return { passed: false, details: `Error: ${body.error.message}` };
      if (body?.result !== undefined) return { passed: true, details: "Ping responded successfully" };
      return { passed: false, details: "No result in ping response" };
    });

    await test(
      "lifecycle-instructions",
      "Instructions field is valid",
      "lifecycle",
      false,
      "basic/lifecycle#initialization",
      async () => {
        const result = initRes?.body?.result;
        if (!result) return { passed: false, details: "No init result" };
        if (result.instructions === undefined) {
          return { passed: true, details: "No instructions field (optional)" };
        }
        if (typeof result.instructions === "string") {
          const preview =
            result.instructions.length > 80 ? result.instructions.slice(0, 80) + "..." : result.instructions;
          return { passed: true, details: `Instructions: "${preview}"` };
        }
        return { passed: false, details: `instructions should be a string, got ${typeof result.instructions}` };
      },
    );

    await test("lifecycle-id-match", "Response ID matches request ID", "lifecycle", true, "basic", async () => {
      const res = await rpc("ping");
      const body = res.body;
      if (body?.id === undefined) return { passed: false, details: "No id in response" };
      const match = body.id === res.requestId;
      return {
        passed: match,
        details: match
          ? `Request id=${res.requestId}, response id=${body.id} (match)`
          : `Request id=${res.requestId}, response id=${body.id} (MISMATCH)`,
      };
    });

    await test("lifecycle-string-id", "Supports string request IDs", "lifecycle", false, "basic", async () => {
      // JSON-RPC 2.0 allows both string and number IDs — send a string ID and verify echo
      const stringId = "compliance-test-string-id";
      const body = JSON.stringify({ jsonrpc: "2.0", id: stringId, method: "ping", params: {} });
      const res = await request(backendUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...buildHeaders(),
        },
        body,
        signal: AbortSignal.timeout(timeout),
      });
      const text = await res.body.text();
      const rawCtStr = res.headers["content-type"];
      const ct = (Array.isArray(rawCtStr) ? rawCtStr[0] : rawCtStr || "").toLowerCase();
      let parsed: any;
      if (ct.includes("text/event-stream")) {
        parsed = parseSSEResponse(text);
      }
      if (!parsed) {
        try {
          parsed = JSON.parse(text);
        } catch {}
      }
      if (!parsed) return { passed: false, details: "Could not parse response" };
      if (parsed.id === stringId) {
        return { passed: true, details: `String id="${stringId}" echoed back correctly` };
      }
      if (parsed.id === undefined) {
        return { passed: false, details: "No id in response" };
      }
      return {
        passed: false,
        details: `String id="${stringId}" sent, got back id=${JSON.stringify(parsed.id)} (type: ${typeof parsed.id})`,
      };
    });

    await test(
      "lifecycle-reinit-reject",
      "Rejects second initialize request",
      "lifecycle",
      false,
      "basic/lifecycle#initialization",
      async () => {
        // Spec: client MUST NOT send initialize more than once per session
        try {
          const res = await rpc("initialize", {
            protocolVersion: SPEC_VERSION,
            capabilities: {},
            clientInfo: { name: "mcp-compliance", version: TOOL_VERSION },
          });
          const error = res.body?.error;
          if (error) {
            return { passed: true, details: `Re-initialization rejected with error: ${error.code} — ${error.message}` };
          }
          if (res.statusCode >= 400) {
            return { passed: true, details: `HTTP ${res.statusCode} (re-initialization rejected)` };
          }
          return {
            passed: false,
            details: `Server accepted second initialize (HTTP ${res.statusCode}) — should reject duplicate initialization`,
          };
        } catch {
          return { passed: true, details: "Connection rejected (acceptable)" };
        }
      },
    );

    // Logging capability test
    const hasLogging = !!serverInfo.capabilities.logging;
    await test(
      "lifecycle-logging",
      "logging/setLevel accepted",
      "lifecycle",
      hasLogging,
      "server/utilities#logging",
      async () => {
        if (!hasLogging) return { passed: true, details: "Server does not declare logging capability (skipped)" };
        // Test with a valid level
        const res = await rpc("logging/setLevel", { level: "info" });
        if (res.body?.error) {
          return { passed: false, details: `Error: ${res.body.error.code} — ${res.body.error.message}` };
        }
        // Test with an invalid level to verify the server validates input
        const invalidRes = await rpc("logging/setLevel", { level: "__invalid_level__" });
        const validatesInput = !!invalidRes.body?.error;
        const validLevels = ["debug", "warning", "error"];
        const accepted: string[] = [];
        for (const level of validLevels) {
          const r = await rpc("logging/setLevel", { level });
          if (!r.body?.error) accepted.push(level);
        }
        const details = validatesInput
          ? `logging/setLevel accepted (validates levels, ${accepted.length + 1} levels accepted)`
          : "logging/setLevel accepted (warning: server does not reject invalid log levels)";
        if (!validatesInput) warnings.push("Server accepts invalid log levels without error");
        return { passed: true, details };
      },
    );

    // Completions capability test
    const hasCompletions = !!serverInfo.capabilities.completions;
    await test(
      "lifecycle-completions",
      "completion/complete accepted",
      "lifecycle",
      hasCompletions,
      "server/utilities#completion",
      async () => {
        if (!hasCompletions)
          return { passed: true, details: "Server does not declare completions capability (skipped)" };
        const res = await rpc("completion/complete", {
          ref: { type: "ref/prompt", name: "__test__" },
          argument: { name: "test", value: "" },
        });
        if (res.body?.error) {
          // -32602 (invalid params) is acceptable — the prompt doesn't exist
          if (res.body.error.code === -32602) {
            return { passed: true, details: "InvalidParams for test ref (acceptable)" };
          }
          return { passed: false, details: `Error: ${res.body.error.code} — ${res.body.error.message}` };
        }
        const values = res.body?.result?.completion?.values;
        if (Array.isArray(values)) {
          return { passed: true, details: `Returned ${values.length} completion(s)` };
        }
        return { passed: true, details: "completion/complete accepted" };
      },
    );

    // Cancellation handling test
    await test(
      "lifecycle-cancellation",
      "Handles cancellation notifications",
      "lifecycle",
      false,
      "basic/utilities#cancellation",
      async () => {
        // Send a cancellation notification for a nonexistent request — server should accept it gracefully
        const res = await mcpNotification(
          backendUrl,
          "notifications/cancelled",
          { requestId: 99999, reason: "compliance test" },
          buildHeaders(),
          timeout,
        );
        // 202 is ideal, any 2xx is acceptable for a notification
        if (res.statusCode >= 200 && res.statusCode < 300) {
          return { passed: true, details: `HTTP ${res.statusCode} (cancellation accepted)` };
        }
        return { passed: false, details: `HTTP ${res.statusCode} — server should accept cancellation notifications` };
      },
    );

    // Progress notification test — validates server gracefully handles unexpected notifications.
    // Note: per spec, progress flows from server→client. This tests server resilience, not spec compliance.
    await test(
      "lifecycle-progress",
      "Handles progress notifications gracefully",
      "lifecycle",
      false,
      "basic/utilities#progress",
      async () => {
        const res = await mcpNotification(
          backendUrl,
          "notifications/progress",
          { progressToken: "compliance-test-token", progress: 50, total: 100 },
          buildHeaders(),
          timeout,
        );
        if (res.statusCode >= 200 && res.statusCode < 300) {
          return { passed: true, details: `HTTP ${res.statusCode} (notification handled gracefully)` };
        }
        return {
          passed: false,
          details: `HTTP ${res.statusCode} — server should accept unknown notifications without error`,
        };
      },
    );

    // listChanged notification tests — server should accept these gracefully
    await test(
      "lifecycle-list-changed",
      "Accepts listChanged notifications",
      "lifecycle",
      false,
      "basic/lifecycle#capability-negotiation",
      async () => {
        // Send notifications for tools/resources/prompts list changes
        // Servers should accept these without error (they are client→server notifications)
        const notifications = [
          { method: "notifications/tools/list_changed", gate: hasTools },
          { method: "notifications/resources/list_changed", gate: hasResources },
          { method: "notifications/prompts/list_changed", gate: hasPrompts },
        ];
        const applicable = notifications.filter((n) => n.gate);
        if (applicable.length === 0) {
          return { passed: true, details: "No capabilities declared — listChanged notifications not applicable" };
        }
        const issues: string[] = [];
        for (const { method } of applicable) {
          try {
            const res = await mcpNotification(backendUrl, method, undefined, buildHeaders(), timeout);
            if (res.statusCode < 200 || res.statusCode >= 300) {
              issues.push(`${method}: HTTP ${res.statusCode}`);
            }
          } catch (err: unknown) {
            issues.push(`${method}: ${err instanceof Error ? err.message : "error"}`);
          }
        }
        if (issues.length > 0) return { passed: false, details: issues.join("; ") };
        return {
          passed: true,
          details: `${applicable.length} listChanged notification(s) accepted: ${applicable.map((n) => n.method).join(", ")}`,
        };
      },
    );

    // Progress token test — send request with _meta.progressToken and check for progress events
    await test(
      "lifecycle-progress-token",
      "Supports progress tokens in requests",
      "lifecycle",
      false,
      "basic/utilities#progress",
      async () => {
        if (!hasTools || toolNames.length === 0) {
          return { passed: true, details: "No tools available for progress token test (skipped)" };
        }
        // Send a tools/call with _meta.progressToken via raw request to read SSE for progress events
        const progressToken = "compliance-progress-test";
        const reqBody = JSON.stringify({
          jsonrpc: "2.0",
          id: nextId(),
          method: "tools/call",
          params: {
            name: toolNames[0],
            arguments: {},
            _meta: { progressToken },
          },
        });
        try {
          const res = await request(backendUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "text/event-stream",
              ...buildHeaders(),
            },
            body: reqBody,
            signal: AbortSignal.timeout(timeout),
          });
          const text = await res.body.text();
          const rawCtProgress = res.headers["content-type"];
          const ct = (Array.isArray(rawCtProgress) ? rawCtProgress[0] : rawCtProgress || "").toLowerCase();
          // Check if any SSE events contain progress notifications
          if (ct.includes("text/event-stream") && text.includes("notifications/progress")) {
            return { passed: true, details: "Server sent progress notifications via SSE with progressToken" };
          }
          // Server may not support progress — that's acceptable, just note it
          if (res.statusCode >= 200 && res.statusCode < 300) {
            return {
              passed: true,
              details: "Server accepted request with progressToken (no progress events observed — optional)",
            };
          }
          return { passed: true, details: `HTTP ${res.statusCode} — request with progressToken accepted` };
        } catch {
          return {
            passed: true,
            details: "Request with progressToken handled (no progress events observed — optional)",
          };
        }
      },
    );

    // _meta tolerance: send a ping with a benign _meta and verify the
    // server doesn't choke on unknown _meta keys. Spec (2025-11-25)
    // reserves _meta for protocol metadata + extension; servers must
    // pass it through validation gracefully.
    await test(
      "lifecycle-meta-tolerance",
      "Tolerates _meta field on requests",
      "lifecycle",
      false,
      "basic/utilities#_meta",
      async () => {
        try {
          const res = await rpc("ping", { _meta: { "mcp-compliance/probe": "1" } });
          const body = res.body as { error?: { code?: number }; result?: unknown };
          if (body.error) {
            return {
              passed: false,
              details: `Server rejected _meta on ping (code ${body.error.code}). _meta should be ignored, not error.`,
            };
          }
          return { passed: true, details: "Server accepted ping with arbitrary _meta field" };
        } catch (err: unknown) {
          return { passed: false, details: `Error: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    );

    // ── 4. TRANSPORT (session-dependent, post-init) ──────────────────

    await test(
      "transport-content-type-init",
      "Initialize response has valid content type",
      "transport",
      false,
      "basic/transports#streamable-http",
      async () => {
        if (!initRes) return { passed: false, details: "No init response to check" };
        const ct = (initRes.headers["content-type"] || "").toLowerCase();
        const valid = ct.includes("application/json") || ct.includes("text/event-stream");
        return { passed: valid, details: `Content-Type: ${ct || "missing"}` };
      },
    );

    await test(
      "transport-notification-202",
      "Notification returns 202 Accepted",
      "transport",
      false,
      "basic/transports#streamable-http",
      async () => {
        const res = await request(backendUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            ...buildHeaders(),
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/cancelled",
            params: { requestId: "nonexistent", reason: "compliance test" },
          }),
          signal: AbortSignal.timeout(timeout),
        });
        await res.body.text();
        if (res.statusCode === 202) {
          return { passed: true, details: "HTTP 202 Accepted (correct)" };
        }
        // Spec says MUST return 202; other 2xx codes violate this requirement
        if (res.statusCode >= 200 && res.statusCode < 300) {
          warnings.push(`Notification returned HTTP ${res.statusCode} instead of spec-required 202 Accepted`);
          return {
            passed: false,
            details: `HTTP ${res.statusCode} — spec requires 202 Accepted for notifications (MUST)`,
          };
        }
        return { passed: false, details: `HTTP ${res.statusCode} — expected 202 Accepted for notifications` };
      },
    );

    await test(
      "transport-session-id",
      "Enforces MCP-Session-Id after init",
      "transport",
      false,
      "basic/transports#streamable-http",
      async () => {
        if (!sessionId) {
          warnings.push("Server did not issue MCP-Session-Id header");
          return { passed: true, details: "Server did not issue session ID (test not applicable)" };
        }
        // Send a request WITHOUT the session ID
        const headersWithout: Record<string, string> = { ...userHeaders };
        if (negotiatedProtocolVersion) headersWithout["mcp-protocol-version"] = negotiatedProtocolVersion;
        // Explicitly do NOT include mcp-session-id
        const res = await mcpRequest(backendUrl, "ping", undefined, createIdCounter(99910), headersWithout, timeout);
        if (res.statusCode === 400) {
          return { passed: true, details: "HTTP 400 for missing session ID (correct)" };
        }
        // Some servers may accept the request anyway (lenient)
        if (res.statusCode >= 200 && res.statusCode < 300) {
          return {
            passed: false,
            details: `HTTP ${res.statusCode} — server should return 400 when session ID is missing`,
          };
        }
        return { passed: false, details: `HTTP ${res.statusCode}` };
      },
    );

    await test(
      "transport-session-invalid",
      "Returns 404 for unknown session ID",
      "transport",
      false,
      "basic/transports#streamable-http",
      async () => {
        if (!sessionId) {
          return { passed: true, details: "Server did not issue session ID (test not applicable)" };
        }
        // Send a request with a fabricated/unknown session ID
        const fakeHeaders: Record<string, string> = {
          ...userHeaders,
          "mcp-session-id": "invalid-nonexistent-session-id",
        };
        if (negotiatedProtocolVersion) fakeHeaders["mcp-protocol-version"] = negotiatedProtocolVersion;
        const res = await mcpRequest(backendUrl, "ping", undefined, createIdCounter(99915), fakeHeaders, timeout);
        if (res.statusCode === 404) {
          return { passed: true, details: "HTTP 404 for unknown session ID (correct per spec)" };
        }
        if (res.statusCode === 400) {
          return {
            passed: false,
            details: "HTTP 400 — spec requires 404 (Not Found) for unrecognized session IDs, not 400",
          };
        }
        return { passed: false, details: `HTTP ${res.statusCode} — spec requires 404 for unrecognized MCP-Session-Id` };
      },
    );

    await test(
      "transport-get-stream",
      "GET with session returns SSE or 405",
      "transport",
      false,
      "basic/transports#streamable-http",
      async () => {
        // This test requires an active session to be meaningful
        if (!sessionId) {
          return { passed: true, details: "No session ID — server-initiated messages not applicable" };
        }
        const res = await request(backendUrl, {
          method: "GET",
          headers: { Accept: "text/event-stream", ...buildHeaders() },
          signal: AbortSignal.timeout(Math.min(timeout, 3000)),
        });
        const body = await res.body.text();
        const rawCt2 = res.headers["content-type"];
        const ct = (Array.isArray(rawCt2) ? rawCt2[0] : rawCt2 || "").toLowerCase();
        if (res.statusCode === 405) {
          return { passed: true, details: "HTTP 405 (server does not support server-initiated messages)" };
        }
        if (ct.includes("text/event-stream")) {
          // Validate SSE format if body is non-empty
          if (body.trim().length > 0) {
            const hasSSEFields = body.includes("data:") || body.includes("event:");
            if (!hasSSEFields) {
              return { passed: false, details: "Content-Type is text/event-stream but body has no SSE fields" };
            }
          }
          return { passed: true, details: "GET with session returns SSE stream for server-initiated messages" };
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          return { passed: true, details: `HTTP ${res.statusCode} (accepted)` };
        }
        return { passed: false, details: `HTTP ${res.statusCode}, Content-Type: ${ct}` };
      },
    );

    await test(
      "transport-concurrent",
      "Handles concurrent requests",
      "transport",
      false,
      "basic/transports#streamable-http",
      async () => {
        // Send 3 ping requests in parallel with distinct IDs
        const ids = [createIdCounter(99930)(), createIdCounter(99931)(), createIdCounter(99932)()];
        const promises = ids.map((id) =>
          request(backendUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              ...buildHeaders(),
            },
            body: JSON.stringify({ jsonrpc: "2.0", id, method: "ping" }),
            signal: AbortSignal.timeout(timeout),
          }).then(async (res) => {
            const text = await res.body.text();
            const rawCtConcurrent = res.headers["content-type"];
            const ct = (Array.isArray(rawCtConcurrent) ? rawCtConcurrent[0] : rawCtConcurrent || "").toLowerCase();
            let body: any;
            if (ct.includes("text/event-stream")) {
              body = parseSSEResponse(text);
            }
            if (!body) {
              try {
                body = JSON.parse(text);
              } catch {}
            }
            return { statusCode: res.statusCode, body, requestId: id };
          }),
        );
        const results = await Promise.all(promises);
        const issues: string[] = [];
        for (const r of results) {
          if (r.statusCode < 200 || r.statusCode >= 300) {
            issues.push(`Request id=${r.requestId}: HTTP ${r.statusCode}`);
          } else if (r.body?.id !== r.requestId) {
            issues.push(`Request id=${r.requestId}: response id=${r.body?.id} (mismatch)`);
          }
        }
        if (issues.length > 0) return { passed: false, details: issues.join("; ") };
        return { passed: true, details: `${results.length} concurrent requests handled correctly` };
      },
    );

    // SSE event field validation — spec requires event: message for JSON-RPC messages in SSE
    await test(
      "transport-sse-event-field",
      "SSE responses include event: message",
      "transport",
      false,
      "basic/transports#streamable-http",
      async () => {
        // Send a request and check if SSE responses include the event: message field
        const res = await request(backendUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            ...buildHeaders(),
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: createIdCounter(99940)(), method: "ping" }),
          signal: AbortSignal.timeout(timeout),
        });
        const text = await res.body.text();
        const rawCtSse = res.headers["content-type"];
        const ct = (Array.isArray(rawCtSse) ? rawCtSse[0] : rawCtSse || "").toLowerCase();
        if (!ct.includes("text/event-stream")) {
          // Server responded with JSON, not SSE — test is not applicable
          return { passed: true, details: "Server responded with JSON (not SSE) — event field check not applicable" };
        }
        // Check that the SSE response includes event: message
        const hasEventMessage = /^event:\s*message\s*$/m.test(text);
        if (hasEventMessage) {
          return { passed: true, details: "SSE response includes required event: message field" };
        }
        if (text.includes("data:")) {
          return {
            passed: false,
            details:
              "SSE response has data: fields but missing required event: message field (spec: MUST include event: message)",
          };
        }
        return { passed: true, details: "SSE response empty or no data fields — check not applicable" };
      },
    );

    // ── 5. TOOLS ─────────────────────────────────────────────────────

    let cachedToolsList: any[] | null = null;

    await test(
      "tools-list",
      "tools/list returns valid response",
      "tools",
      hasTools,
      "server/tools#listing-tools",
      async () => {
        const res = await rpc("tools/list");
        const tools = res.body?.result?.tools;
        if (!Array.isArray(tools)) return { passed: false, details: "No tools array in result" };
        cachedToolsList = tools;
        toolCount = tools.length;
        toolNames = tools.map((t: any) => t.name).filter(Boolean);
        return {
          passed: true,
          details: `${toolCount} tool(s): ${toolNames.slice(0, 5).join(", ")}${toolCount > 5 ? "..." : ""}`,
        };
      },
    );

    // Schema tests for tools (depend on tools-list succeeding)
    const toolsListOk = cachedToolsList !== null;
    await test(
      "tools-schema",
      "All tools have name and inputSchema",
      "schema",
      hasTools,
      "server/tools#data-types",
      async () => {
        if (!toolsListOk) return { passed: false, details: "Skipped: tools/list failed" };
        const tools = cachedToolsList ?? [];
        const issues: string[] = [];
        for (const tool of tools) {
          if (!tool.name) {
            issues.push("Tool missing name");
            continue;
          }
          if (tool.name.length > 128 || !/^[A-Za-z0-9_.\-]+$/.test(tool.name)) {
            issues.push(`${tool.name}: name format invalid`);
          }
          if (!tool.description) warnings.push(`Tool "${tool.name}" missing description`);
          if (!tool.inputSchema) {
            issues.push(`${tool.name}: missing inputSchema (required)`);
          } else if (typeof tool.inputSchema !== "object" || tool.inputSchema === null) {
            issues.push(`${tool.name}: inputSchema must be a valid JSON Schema object`);
          } else if (tool.inputSchema.type !== "object") {
            issues.push(
              `${tool.name}: inputSchema.type must be "object" (got "${tool.inputSchema.type || "undefined"}")`,
            );
          }
        }
        const detail = issues.length === 0 ? "All tools have valid schemas" : issues.join("; ");
        return { passed: issues.length === 0, details: detail };
      },
    );

    await test(
      "tools-annotations",
      "Tool annotations are valid",
      "schema",
      false,
      "server/tools#annotations",
      async () => {
        if (!toolsListOk) return { passed: false, details: "Skipped: tools/list failed" };
        const tools = cachedToolsList ?? [];
        if (tools.length === 0) return { passed: true, details: "No tools to validate" };
        const issues: string[] = [];
        let annotatedCount = 0;
        for (const tool of tools) {
          const ann = tool.annotations;
          if (!ann) continue;
          annotatedCount++;
          if (typeof ann !== "object" || ann === null) {
            issues.push(`${tool.name}: annotations must be an object`);
            continue;
          }
          const boolFields = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];
          for (const field of boolFields) {
            if (ann[field] !== undefined && typeof ann[field] !== "boolean") {
              issues.push(`${tool.name}: annotations.${field} should be boolean, got ${typeof ann[field]}`);
            }
          }
        }
        if (issues.length > 0) return { passed: false, details: issues.join("; ") };
        return {
          passed: true,
          details:
            annotatedCount > 0
              ? `${annotatedCount} tool(s) with valid annotations`
              : "No tools have annotations (optional)",
        };
      },
    );

    await test(
      "tools-title-field",
      "Tools include title field",
      "schema",
      false,
      "server/tools#data-types",
      async () => {
        if (!toolsListOk) return { passed: false, details: "Skipped: tools/list failed" };
        const tools = cachedToolsList ?? [];
        if (tools.length === 0) return { passed: true, details: "No tools to validate" };
        const withTitle = tools.filter((t: any) => typeof t.title === "string");
        const issues: string[] = [];
        for (const tool of tools) {
          if (tool.title !== undefined && typeof tool.title !== "string") {
            issues.push(`${tool.name}: title should be a string`);
          }
        }
        if (issues.length > 0) return { passed: false, details: issues.join("; ") };
        if (withTitle.length === 0) {
          return { passed: true, details: "No tools have title field (optional, added in 2025-11-25)" };
        }
        return { passed: true, details: `${withTitle.length}/${tools.length} tool(s) have title field` };
      },
    );

    await test(
      "tools-output-schema",
      "Tools with outputSchema are valid",
      "schema",
      false,
      "server/tools#structured-content",
      async () => {
        if (!toolsListOk) return { passed: false, details: "Skipped: tools/list failed" };
        const tools = cachedToolsList ?? [];
        if (tools.length === 0) return { passed: true, details: "No tools to validate" };
        const issues: string[] = [];
        let withSchema = 0;
        for (const tool of tools) {
          if (tool.outputSchema === undefined) continue;
          withSchema++;
          if (typeof tool.outputSchema !== "object" || tool.outputSchema === null) {
            issues.push(`${tool.name}: outputSchema must be a JSON Schema object`);
          } else if (tool.outputSchema.type !== "object") {
            issues.push(
              `${tool.name}: outputSchema.type must be "object" (got "${tool.outputSchema.type || "undefined"}")`,
            );
          }
        }
        if (issues.length > 0) return { passed: false, details: issues.join("; ") };
        return {
          passed: true,
          details:
            withSchema > 0 ? `${withSchema} tool(s) with valid outputSchema` : "No tools have outputSchema (optional)",
        };
      },
    );

    if (toolNames.length > 0) {
      await test(
        "tools-call",
        "tools/call responds correctly",
        "tools",
        false,
        "server/tools#calling-tools",
        async () => {
          const res = await rpc("tools/call", { name: toolNames[0], arguments: {} });
          const result = res.body?.result;
          const error = res.body?.error;
          if (error) {
            const code = error.code;
            if (code === -32602 || code === -32600) {
              return { passed: true, details: `Invalid params error (acceptable): code ${code}` };
            }
            return { passed: true, details: `Protocol error: code ${code} — ${error.message}` };
          }
          if (result?.content && Array.isArray(result.content)) {
            if (result.isError) {
              return { passed: true, details: "Tool returned execution error with content (valid)" };
            }
            const badItems = result.content.filter((c: any) => !c.type);
            if (badItems.length > 0)
              return { passed: false, details: `${badItems.length} content item(s) missing 'type' field` };
            return { passed: true, details: `Returned ${result.content.length} content item(s)` };
          }
          return { passed: false, details: "Response missing content array" };
        },
      );

      await test(
        "tools-content-types",
        "Tool content items have valid types",
        "tools",
        false,
        "server/tools#calling-tools",
        async () => {
          const res = await rpc("tools/call", { name: toolNames[0], arguments: {} });
          const result = res.body?.result;
          const error = res.body?.error;
          if (error) {
            return { passed: true, details: `Tool returned error (content types not applicable): code ${error.code}` };
          }
          const content = result?.content;
          if (!Array.isArray(content) || content.length === 0) {
            return { passed: true, details: "No content items to validate" };
          }
          const issues: string[] = [];
          const types = new Set<string>();
          for (const item of content) {
            if (!item.type) {
              issues.push("Content item missing type field");
            } else if (!VALID_CONTENT_TYPES.includes(item.type)) {
              issues.push(`Unknown content type: "${item.type}"`);
            } else {
              types.add(item.type);
            }
          }
          if (issues.length > 0) return { passed: false, details: issues.join("; ") };
          return { passed: true, details: `Content types: ${[...types].join(", ")}` };
        },
      );
    }

    // Pagination test for tools
    if (hasTools) {
      await test(
        "tools-pagination",
        "tools/list supports pagination",
        "tools",
        false,
        "server/tools#listing-tools",
        async () => {
          const res = await rpc("tools/list");
          const result = res.body?.result;
          if (!result) return { passed: false, details: "No result from tools/list" };
          if (!Array.isArray(result.tools)) return { passed: false, details: "No tools array" };
          if (result.nextCursor !== undefined) {
            if (typeof result.nextCursor !== "string") {
              return { passed: false, details: `nextCursor should be string, got ${typeof result.nextCursor}` };
            }
            // Try fetching next page
            const nextRes = await rpc("tools/list", { cursor: result.nextCursor });
            const nextResult = nextRes.body?.result;
            if (!nextResult || !Array.isArray(nextResult.tools)) {
              return { passed: false, details: "Next page failed to return tools array" };
            }
            return {
              passed: true,
              details: `Pagination works: page 1 had ${result.tools.length} tools, page 2 had ${nextResult.tools.length} tools`,
            };
          }
          return { passed: true, details: `${result.tools.length} tool(s), no nextCursor (single page)` };
        },
      );

      // tools-call-unknown moved outside toolNames guard so it runs for all tools-capable servers
      await test(
        "tools-call-unknown",
        "Returns error for unknown tool name",
        "errors",
        false,
        "server/tools#error-handling",
        async () => {
          const res = await rpc("tools/call", { name: "__nonexistent_tool_compliance_test__", arguments: {} });
          const error = res.body?.error;
          const isError = res.body?.result?.isError;
          if (error) return { passed: true, details: `Error code: ${error.code} — ${error.message}` };
          if (isError) return { passed: true, details: "Tool execution error with isError=true (valid)" };
          return { passed: false, details: "No error returned for nonexistent tool" };
        },
      );
    }

    // ── 6. RESOURCES ─────────────────────────────────────────────────

    const resourcesCap = serverInfo.capabilities.resources;
    const hasSubscribe = !!(
      typeof resourcesCap === "object" &&
      resourcesCap !== null &&
      "subscribe" in resourcesCap &&
      (resourcesCap as Record<string, unknown>).subscribe
    );

    if (hasResources) {
      let cachedResourcesList: any[] | null = null;

      await test(
        "resources-list",
        "resources/list returns valid response",
        "resources",
        true,
        "server/resources#listing-resources",
        async () => {
          const res = await rpc("resources/list");
          const resources = res.body?.result?.resources;
          if (!Array.isArray(resources)) return { passed: false, details: "No resources array" };
          cachedResourcesList = resources;
          resourceCount = resources.length;
          resourceNames = resources.map((r: any) => r.name).filter(Boolean);
          return { passed: true, details: `${resourceCount} resource(s)` };
        },
      );

      const resourcesListOk = cachedResourcesList !== null;
      await test(
        "resources-schema",
        "Resources have uri and name",
        "schema",
        true,
        "server/resources#data-types",
        async () => {
          if (!resourcesListOk) return { passed: false, details: "Skipped: resources/list failed" };
          const resources = cachedResourcesList ?? [];
          const issues: string[] = [];
          for (const r of resources) {
            if (!r.uri) issues.push("Resource missing uri");
            else {
              try {
                new URL(r.uri);
              } catch {
                issues.push(`${r.uri}: invalid URI format`);
              }
            }
            if (!r.name) issues.push(`${r.uri || "?"}: missing name`);
            if (!r.description) warnings.push(`Resource "${r.name || r.uri}" missing description`);
            if (!r.mimeType) warnings.push(`Resource "${r.name || r.uri}" missing mimeType`);
          }
          return {
            passed: issues.length === 0,
            details: issues.length === 0 ? "All resources valid" : issues.join("; "),
          };
        },
      );

      if (resourceCount > 0) {
        await test(
          "resources-read",
          "resources/read returns content",
          "resources",
          false,
          "server/resources#reading-resources",
          async () => {
            const resources = cachedResourcesList ?? [];
            const firstUri = resources[0]?.uri;
            if (!firstUri) return { passed: false, details: "No resource URI to test" };
            const readRes = await rpc("resources/read", { uri: firstUri });
            const contents = readRes.body?.result?.contents;
            if (!Array.isArray(contents)) return { passed: false, details: "No contents array" };
            const issues: string[] = [];
            for (const c of contents) {
              if (!c.uri) issues.push("Content item missing uri");
              if (!c.text && !c.blob) issues.push(`Content item for ${c.uri || "?"} missing both text and blob`);
            }
            if (issues.length > 0) return { passed: false, details: issues.join("; ") };
            return { passed: true, details: `Read ${contents.length} content item(s) from ${firstUri}` };
          },
        );
      }

      await test(
        "resources-templates",
        "resources/templates/list returns valid response",
        "resources",
        false,
        "server/resources#resource-templates",
        async () => {
          const res = await rpc("resources/templates/list");
          const error = res.body?.error;
          if (error) {
            if (error.code === -32601) return { passed: true, details: "Method not supported (acceptable)" };
            return { passed: false, details: `Error: ${error.message}` };
          }
          const templates = res.body?.result?.resourceTemplates;
          if (!Array.isArray(templates)) return { passed: false, details: "No resourceTemplates array" };
          const issues: string[] = [];
          for (const t of templates) {
            if (!t.uriTemplate) {
              issues.push("Template missing uriTemplate");
            } else if (typeof t.uriTemplate !== "string") {
              issues.push(`uriTemplate should be a string, got ${typeof t.uriTemplate}`);
            } else if (!t.uriTemplate.includes("{") || !t.uriTemplate.includes("}")) {
              warnings.push(`Template "${t.name || t.uriTemplate}" has no URI template parameters (e.g., {id})`);
            }
            if (!t.name) issues.push(`${t.uriTemplate || "?"}: missing name`);
            if (!t.description) warnings.push(`Template "${t.name || t.uriTemplate || "?"}" missing description`);
          }
          if (issues.length > 0) return { passed: false, details: issues.join("; ") };
          return { passed: true, details: `${templates.length} resource template(s)` };
        },
      );

      await test(
        "resources-pagination",
        "resources/list supports pagination",
        "resources",
        false,
        "server/resources#listing-resources",
        async () => {
          const res = await rpc("resources/list");
          const result = res.body?.result;
          if (!result) return { passed: false, details: "No result from resources/list" };
          if (!Array.isArray(result.resources)) return { passed: false, details: "No resources array" };
          if (result.nextCursor !== undefined) {
            if (typeof result.nextCursor !== "string") {
              return { passed: false, details: `nextCursor should be string, got ${typeof result.nextCursor}` };
            }
            const nextRes = await rpc("resources/list", { cursor: result.nextCursor });
            const nextResult = nextRes.body?.result;
            if (!nextResult || !Array.isArray(nextResult.resources)) {
              return { passed: false, details: "Next page failed to return resources array" };
            }
            return {
              passed: true,
              details: `Pagination works: page 1 had ${result.resources.length}, page 2 had ${nextResult.resources.length}`,
            };
          }
          return { passed: true, details: `${result.resources.length} resource(s), no nextCursor (single page)` };
        },
      );

      if (hasSubscribe && resourceCount > 0) {
        await test(
          "resources-subscribe",
          "Resource subscribe/unsubscribe",
          "resources",
          true,
          "server/resources#subscriptions",
          async () => {
            const resources = cachedResourcesList ?? [];
            const firstUri = resources[0]?.uri;
            if (!firstUri) return { passed: false, details: "No resource URI for subscribe test" };

            // Subscribe
            const subRes = await rpc("resources/subscribe", { uri: firstUri });
            if (subRes.body?.error) {
              return {
                passed: false,
                details: `Subscribe error: ${subRes.body.error.code} — ${subRes.body.error.message}`,
              };
            }

            // Unsubscribe
            const unsubRes = await rpc("resources/unsubscribe", { uri: firstUri });
            if (unsubRes.body?.error) {
              return {
                passed: false,
                details: `Unsubscribe error: ${unsubRes.body.error.code} — ${unsubRes.body.error.message}`,
              };
            }

            return { passed: true, details: `Subscribe/unsubscribe for ${firstUri} succeeded` };
          },
        );
      }
    }

    // ── 7. PROMPTS ───────────────────────────────────────────────────

    if (hasPrompts) {
      let cachedPromptsList: any[] | null = null;

      await test(
        "prompts-list",
        "prompts/list returns valid response",
        "prompts",
        true,
        "server/prompts#listing-prompts",
        async () => {
          const res = await rpc("prompts/list");
          const prompts = res.body?.result?.prompts;
          if (!Array.isArray(prompts)) return { passed: false, details: "No prompts array" };
          cachedPromptsList = prompts;
          promptCount = prompts.length;
          promptNames = prompts.map((p: any) => p.name).filter(Boolean);
          return {
            passed: true,
            details: `${promptCount} prompt(s): ${promptNames.slice(0, 5).join(", ")}${promptCount > 5 ? "..." : ""}`,
          };
        },
      );

      const promptsListOk = cachedPromptsList !== null;
      await test("prompts-schema", "Prompts have name field", "schema", true, "server/prompts#data-types", async () => {
        if (!promptsListOk) return { passed: false, details: "Skipped: prompts/list failed" };
        const prompts = cachedPromptsList ?? [];
        const issues: string[] = [];
        for (const p of prompts) {
          if (!p.name) issues.push("Prompt missing name");
          if (!p.description) warnings.push(`Prompt "${p.name || "?"}" missing description`);
          if (p.arguments && !Array.isArray(p.arguments)) issues.push(`${p.name || "?"}: arguments must be an array`);
          if (Array.isArray(p.arguments)) {
            for (const arg of p.arguments) {
              if (!arg.name) issues.push(`${p.name}: argument missing name`);
            }
          }
        }
        return { passed: issues.length === 0, details: issues.length === 0 ? "All prompts valid" : issues.join("; ") };
      });

      if (promptNames.length > 0) {
        await test(
          "prompts-get",
          "prompts/get returns valid messages",
          "prompts",
          false,
          "server/prompts#getting-a-prompt",
          async () => {
            const res = await rpc("prompts/get", { name: promptNames[0] });
            const error = res.body?.error;
            if (error) return { passed: true, details: `Error (may need arguments): code ${error.code}` };
            const messages = res.body?.result?.messages;
            if (!Array.isArray(messages)) return { passed: false, details: "No messages array in result" };
            const issues: string[] = [];
            for (const msg of messages) {
              if (!msg.role || !["user", "assistant"].includes(msg.role)) issues.push(`Invalid role: ${msg.role}`);
              if (!msg.content) issues.push("Message missing content");
            }
            if (issues.length > 0) return { passed: false, details: issues.join("; ") };
            return { passed: true, details: `${messages.length} message(s) from ${promptNames[0]}` };
          },
        );
      }

      await test(
        "prompts-pagination",
        "prompts/list supports pagination",
        "prompts",
        false,
        "server/prompts#listing-prompts",
        async () => {
          const res = await rpc("prompts/list");
          const result = res.body?.result;
          if (!result) return { passed: false, details: "No result from prompts/list" };
          if (!Array.isArray(result.prompts)) return { passed: false, details: "No prompts array" };
          if (result.nextCursor !== undefined) {
            if (typeof result.nextCursor !== "string") {
              return { passed: false, details: `nextCursor should be string, got ${typeof result.nextCursor}` };
            }
            const nextRes = await rpc("prompts/list", { cursor: result.nextCursor });
            const nextResult = nextRes.body?.result;
            if (!nextResult || !Array.isArray(nextResult.prompts)) {
              return { passed: false, details: "Next page failed to return prompts array" };
            }
            return {
              passed: true,
              details: `Pagination works: page 1 had ${result.prompts.length}, page 2 had ${nextResult.prompts.length}`,
            };
          }
          return { passed: true, details: `${result.prompts.length} prompt(s), no nextCursor (single page)` };
        },
      );
    }

    // ── 8. ERROR HANDLING ────────────────────────────────────────────

    await test(
      "error-unknown-method",
      "Returns JSON-RPC error for unknown method",
      "errors",
      true,
      "basic",
      async () => {
        const res = await rpc("nonexistent/method");
        const error = res.body?.error;
        if (!error) return { passed: false, details: "No JSON-RPC error returned for unknown method" };
        const correctCode = error.code === -32601;
        return {
          passed: true,
          details: `Error code: ${error.code}${correctCode ? " (correct: Method not found)" : " (expected -32601)"} — ${error.message}`,
        };
      },
    );

    await test(
      "error-method-code",
      "Uses correct JSON-RPC error code for unknown method",
      "errors",
      false,
      "basic",
      async () => {
        const res = await rpc("nonexistent/method");
        const error = res.body?.error;
        if (!error) return { passed: false, details: "No error returned" };
        return { passed: error.code === -32601, details: `Expected -32601, got ${error.code}` };
      },
    );

    await test("error-invalid-jsonrpc", "Handles malformed JSON-RPC", "errors", true, "basic", async () => {
      const res = await request(backendUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...buildHeaders(),
        },
        body: JSON.stringify({ not: "a valid jsonrpc message" }),
        signal: AbortSignal.timeout(timeout),
      });
      const text = await res.body.text();
      try {
        const body = JSON.parse(text);
        if (body?.error) {
          const correctCode = body.error.code === -32600;
          return {
            passed: true,
            details: `Error code: ${body.error.code}${correctCode ? " (correct: Invalid Request)" : ""} — ${body.error.message}`,
          };
        }
      } catch {}
      if (res.statusCode >= 400 && res.statusCode < 500)
        return { passed: true, details: `HTTP ${res.statusCode} (acceptable)` };
      return { passed: false, details: `HTTP ${res.statusCode} — expected JSON-RPC error or 4xx status` };
    });

    await test("error-invalid-json", "Handles invalid JSON body", "errors", false, "basic", async () => {
      const res = await request(backendUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...buildHeaders(),
        },
        body: "{this is not valid json!!!",
        signal: AbortSignal.timeout(timeout),
      });
      const text = await res.body.text();
      try {
        const body = JSON.parse(text);
        if (body?.error) return { passed: true, details: `Error code: ${body.error.code} — ${body.error.message}` };
      } catch {}
      if (res.statusCode >= 400 && res.statusCode < 500)
        return { passed: true, details: `HTTP ${res.statusCode} (acceptable)` };
      return { passed: false, details: `HTTP ${res.statusCode} — expected parse error or 4xx status` };
    });

    await test(
      "error-missing-params",
      "Returns error for tools/call without name",
      "errors",
      false,
      "server/tools#error-handling",
      async () => {
        const res = await rpc("tools/call", {});
        const error = res.body?.error;
        const isError = res.body?.result?.isError;
        if (error) {
          const correctCode = error.code === -32602;
          return {
            passed: true,
            details: `Error code: ${error.code}${correctCode ? " (correct: Invalid params)" : ""} — ${error.message}`,
          };
        }
        if (isError) return { passed: true, details: "Tool execution error (valid)" };
        return { passed: false, details: "No error for tools/call without name" };
      },
    );

    await test("error-parse-code", "Returns -32700 for invalid JSON", "errors", false, "basic", async () => {
      const res = await request(backendUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...buildHeaders(),
        },
        body: "<<<not json>>>",
        signal: AbortSignal.timeout(timeout),
      });
      const text = await res.body.text();
      try {
        const body = JSON.parse(text);
        if (body?.error?.code === -32700) {
          return { passed: true, details: `Error code: -32700 (Parse error) — ${body.error.message}` };
        }
        if (body?.error) {
          return { passed: false, details: `Expected -32700, got ${body.error.code} — ${body.error.message}` };
        }
      } catch {}
      if (res.statusCode >= 400 && res.statusCode < 500) {
        return { passed: false, details: `HTTP ${res.statusCode} — server should return JSON-RPC error code -32700` };
      }
      return { passed: false, details: `HTTP ${res.statusCode} — expected error code -32700` };
    });

    await test(
      "error-invalid-request-code",
      "Returns -32600 for invalid request",
      "errors",
      false,
      "basic",
      async () => {
        const res = await request(backendUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            ...buildHeaders(),
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 99999 }),
          signal: AbortSignal.timeout(timeout),
        });
        const text = await res.body.text();
        try {
          const body = JSON.parse(text);
          if (body?.error?.code === -32600) {
            return { passed: true, details: `Error code: -32600 (Invalid Request) — ${body.error.message}` };
          }
          if (body?.error) {
            return { passed: false, details: `Expected -32600, got ${body.error.code} — ${body.error.message}` };
          }
        } catch {}
        if (res.statusCode >= 400 && res.statusCode < 500) {
          return { passed: false, details: `HTTP ${res.statusCode} — server should return JSON-RPC error code -32600` };
        }
        return { passed: false, details: `HTTP ${res.statusCode} — expected error code -32600` };
      },
    );

    // Capability-gated method rejection — tests that undeclared methods return errors
    const undeclaredMethods: Array<{ method: string; capability: string; declared: boolean }> = [
      { method: "tools/list", capability: "tools", declared: hasTools },
      { method: "resources/list", capability: "resources", declared: hasResources },
      { method: "prompts/list", capability: "prompts", declared: hasPrompts },
    ];
    const undeclared = undeclaredMethods.filter((m) => !m.declared);
    await test(
      "error-capability-gated",
      "Rejects methods for undeclared capabilities",
      "errors",
      false,
      "basic/lifecycle#capability-negotiation",
      async () => {
        if (undeclared.length === 0) {
          return {
            passed: true,
            details: "Server declares all capabilities (tools, resources, prompts) — no undeclared methods to test",
          };
        }
        const issues: string[] = [];
        for (const { method, capability } of undeclared) {
          const res = await rpc(method);
          const error = res.body?.error;
          if (!error && res.body?.result) {
            issues.push(`${method} returned success despite missing ${capability} capability`);
          }
        }
        if (issues.length > 0) return { passed: false, details: issues.join("; ") };
        return {
          passed: true,
          details: `Tested ${undeclared.length} undeclared method(s): ${undeclared.map((m) => m.method).join(", ")} — all returned errors`,
        };
      },
    );

    // Invalid cursor test — send garbage cursor to a list method
    const listMethodForCursor = hasTools
      ? "tools/list"
      : hasResources
        ? "resources/list"
        : hasPrompts
          ? "prompts/list"
          : null;
    await test(
      "error-invalid-cursor",
      "Handles invalid pagination cursor gracefully",
      "errors",
      false,
      "basic",
      async () => {
        if (!listMethodForCursor) {
          return { passed: true, details: "No list methods available to test (skipped)" };
        }
        const res = await rpc(listMethodForCursor, { cursor: "!!!invalid-garbage-cursor-$$$" });
        const error = res.body?.error;
        if (error) {
          return { passed: true, details: `Invalid cursor rejected with error: ${error.code} — ${error.message}` };
        }
        // If server ignores the invalid cursor and returns first page, that's also acceptable
        const result = res.body?.result;
        if (result) {
          return { passed: true, details: "Server returned results (likely ignored invalid cursor)" };
        }
        return { passed: false, details: "No error or result for invalid cursor" };
      },
    );

    // ── 9. SECURITY TESTS ────────────────────────────────────────────

    // Auth & Transport security tests
    // These tests detect whether the server requires authentication.
    // If --auth was passed and the server accepted it, we test with auth stripped.
    const hasAuth = !!userHeaders.Authorization || !!userHeaders.authorization;

    await test(
      "security-auth-required",
      "Rejects unauthenticated requests",
      "security",
      false,
      "basic/authorization",
      async () => {
        if (!hasAuth) {
          return {
            passed: false,
            details: "Server does not require auth (no --auth provided and server accepted unauthenticated requests)",
          };
        }
        // Re-send initialize without auth header
        const noAuthHeaders: Record<string, string> = {};
        if (sessionId) noAuthHeaders["mcp-session-id"] = sessionId;
        try {
          const res = await mcpRequest(backendUrl, "ping", undefined, nextId, noAuthHeaders, timeout);
          if (res.statusCode === 401 || res.statusCode === 403) {
            return { passed: true, details: `HTTP ${res.statusCode} (unauthenticated request rejected)` };
          }
          return { passed: false, details: `HTTP ${res.statusCode} — server accepted unauthenticated request` };
        } catch (err: unknown) {
          return { passed: true, details: "Connection rejected (acceptable)" };
        }
      },
    );

    await test(
      "security-www-authenticate",
      "401 responses include WWW-Authenticate header",
      "security",
      false,
      "basic/authorization",
      async () => {
        if (!hasAuth) {
          return { passed: true, details: "Skipped: server does not require auth" };
        }
        // Send request without auth and check for WWW-Authenticate header on 401
        const noAuthHeaders: Record<string, string> = {};
        if (sessionId) noAuthHeaders["mcp-session-id"] = sessionId;
        try {
          const res = await mcpRequest(backendUrl, "ping", undefined, nextId, noAuthHeaders, timeout);
          if (res.statusCode === 401) {
            const wwwAuth = res.headers["www-authenticate"];
            if (wwwAuth) {
              return { passed: true, details: `WWW-Authenticate: ${wwwAuth}` };
            }
            return {
              passed: false,
              details:
                "HTTP 401 but missing WWW-Authenticate header (spec: SHOULD include to indicate required auth scheme)",
            };
          }
          if (res.statusCode === 403) {
            return { passed: true, details: "HTTP 403 (WWW-Authenticate not applicable for 403)" };
          }
          return { passed: true, details: `HTTP ${res.statusCode} — not a 401 response` };
        } catch {
          return { passed: true, details: "Connection rejected (acceptable)" };
        }
      },
    );

    await test(
      "security-auth-malformed",
      "Rejects malformed auth credentials",
      "security",
      false,
      "basic/authorization",
      async () => {
        if (!hasAuth) {
          return { passed: false, details: "Skipped: server does not require auth" };
        }
        const malformedHeaders: Record<string, string> = {
          Authorization: "Bearer INVALID_GARBAGE_TOKEN_!@#$%^&*()",
        };
        if (sessionId) malformedHeaders["mcp-session-id"] = sessionId;
        try {
          const res = await mcpRequest(backendUrl, "ping", undefined, nextId, malformedHeaders, timeout);
          if (res.statusCode === 401 || res.statusCode === 403) {
            return { passed: true, details: `HTTP ${res.statusCode} (malformed auth rejected)` };
          }
          return { passed: false, details: `HTTP ${res.statusCode} — server accepted malformed auth token` };
        } catch (err: unknown) {
          return { passed: true, details: "Connection rejected (acceptable)" };
        }
      },
    );

    await test("security-tls-required", "Enforces HTTPS/TLS", "security", false, "basic/authorization", async () => {
      const parsedUrl = new URL(backendUrl);
      if (parsedUrl.protocol !== "https:") {
        return {
          passed: false,
          details: `Server URL uses ${parsedUrl.protocol} — production servers should use HTTPS`,
        };
      }
      // Try HTTP variant
      const httpUrl = backendUrl.replace(/^https:/, "http:");
      try {
        const res = await request(httpUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 99950, method: "ping" }),
          signal: AbortSignal.timeout(Math.min(timeout, 5000)),
        });
        await res.body.text();
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 308) {
          return { passed: true, details: `HTTP ${res.statusCode} redirect to HTTPS (good)` };
        }
        if (res.statusCode >= 400) {
          return { passed: true, details: `HTTP ${res.statusCode} (plaintext rejected)` };
        }
        return { passed: false, details: `HTTP ${res.statusCode} — server accepts plaintext HTTP connections` };
      } catch {
        return { passed: true, details: "HTTP connection refused (HTTPS enforced)" };
      }
    });

    await test(
      "security-session-entropy",
      "Session IDs are high-entropy",
      "security",
      false,
      "basic/transports#streamable-http",
      async () => {
        if (!sessionId) {
          return { passed: true, details: "Server does not issue session IDs (skipped)" };
        }
        // Check length (should be at least 16 chars for reasonable entropy)
        if (sessionId.length < 16) {
          return {
            passed: false,
            details: `Session ID too short (${sessionId.length} chars): "${sessionId}" — should be ≥16 chars`,
          };
        }
        // Check for sequential/numeric patterns
        if (/^\d+$/.test(sessionId)) {
          return {
            passed: false,
            details: `Session ID is purely numeric: "${sessionId}" — likely sequential, not random`,
          };
        }
        // Check character diversity (at least 8 unique chars)
        const uniqueChars = new Set(sessionId.toLowerCase()).size;
        if (uniqueChars < 8) {
          return {
            passed: false,
            details: `Session ID has low character diversity (${uniqueChars} unique chars): "${sessionId}"`,
          };
        }
        return {
          passed: true,
          details: `Session ID has good entropy (${sessionId.length} chars, ${uniqueChars} unique): "${sessionId.substring(0, 16)}..."`,
        };
      },
    );

    await test(
      "security-session-not-auth",
      "Session ID does not bypass auth",
      "security",
      false,
      "basic/transports#streamable-http",
      async () => {
        if (!hasAuth) {
          return { passed: true, details: "Skipped: server does not require auth" };
        }
        if (!sessionId) {
          return { passed: true, details: "Skipped: server does not issue session IDs" };
        }
        // Send request with session ID but NO auth
        const sessionOnlyHeaders: Record<string, string> = {
          "mcp-session-id": sessionId,
        };
        try {
          const res = await mcpRequest(backendUrl, "ping", undefined, nextId, sessionOnlyHeaders, timeout);
          if (res.statusCode === 401 || res.statusCode === 403) {
            return { passed: true, details: `HTTP ${res.statusCode} (session ID alone not sufficient for auth)` };
          }
          return {
            passed: false,
            details: `HTTP ${res.statusCode} — server accepted session ID without auth (spec: MUST NOT use sessions for authentication)`,
          };
        } catch {
          return { passed: true, details: "Connection rejected (acceptable)" };
        }
      },
    );

    await test(
      "security-oauth-metadata",
      "Protected Resource Metadata endpoint exists",
      "security",
      false,
      "basic/authorization",
      async () => {
        if (!hasAuth) {
          return { passed: true, details: "Skipped: server does not require auth" };
        }
        const parsedUrl = new URL(backendUrl);
        // Per MCP 2025-11-25: the MCP server hosts Protected Resource Metadata (RFC 9728)
        // at /.well-known/oauth-protected-resource, which points to the authorization server(s).
        const prmUrl = `${parsedUrl.protocol}//${parsedUrl.host}/.well-known/oauth-protected-resource`;
        try {
          const res = await request(prmUrl, {
            method: "GET",
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(Math.min(timeout, 5000)),
          });
          const text = await res.body.text();
          if (res.statusCode === 200) {
            try {
              const meta = JSON.parse(text);
              if (!meta.resource) {
                return { passed: false, details: "PRM response missing required 'resource' field" };
              }
              if (!Array.isArray(meta.authorization_servers) || meta.authorization_servers.length === 0) {
                return { passed: false, details: "PRM response missing 'authorization_servers' array" };
              }
              return {
                passed: true,
                details: `Protected Resource Metadata found: resource=${meta.resource}, ${meta.authorization_servers.length} auth server(s)`,
              };
            } catch {
              return { passed: false, details: "PRM endpoint returned non-JSON response" };
            }
          }
          // Fall back to legacy /.well-known/oauth-authorization-server check
          const legacyUrl = `${parsedUrl.protocol}//${parsedUrl.host}/.well-known/oauth-authorization-server`;
          try {
            const legacyRes = await request(legacyUrl, {
              method: "GET",
              headers: { Accept: "application/json" },
              signal: AbortSignal.timeout(Math.min(timeout, 5000)),
            });
            const legacyText = await legacyRes.body.text();
            if (legacyRes.statusCode === 200) {
              try {
                const legacyMeta = JSON.parse(legacyText);
                if (legacyMeta.issuer && legacyMeta.token_endpoint) {
                  warnings.push(
                    "Server uses legacy /.well-known/oauth-authorization-server instead of /.well-known/oauth-protected-resource (RFC 9728). Update to PRM for 2025-11-25 compliance.",
                  );
                  return {
                    passed: true,
                    details: `Legacy OAuth AS metadata found: issuer=${legacyMeta.issuer} (should migrate to PRM)`,
                  };
                }
              } catch {}
            }
          } catch {}
          return {
            passed: false,
            details: `PRM endpoint returned HTTP ${res.statusCode} and no legacy OAuth metadata found`,
          };
        } catch {
          return { passed: false, details: "PRM endpoint unreachable" };
        }
      },
    );

    await test(
      "security-token-in-uri",
      "Rejects auth tokens in query string",
      "security",
      false,
      "basic/authorization",
      async () => {
        if (!hasAuth) {
          return { passed: true, details: "Skipped: server does not require auth" };
        }
        const authValue = userHeaders.Authorization || userHeaders.authorization || "";
        const token = authValue.replace(/^Bearer\s+/i, "");
        if (!token) {
          return { passed: true, details: "Skipped: could not extract token from auth header" };
        }
        const uriWithToken = `${backendUrl}${backendUrl.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`;
        try {
          // Send WITHOUT auth header, WITH token in URI
          const noAuthHeaders: Record<string, string> = {};
          if (sessionId) noAuthHeaders["mcp-session-id"] = sessionId;
          const res = await mcpRequest(uriWithToken, "ping", undefined, nextId, noAuthHeaders, timeout);
          if (res.statusCode === 401 || res.statusCode === 403) {
            return { passed: true, details: `HTTP ${res.statusCode} (token in query string rejected)` };
          }
          // If server accepted it, that's a fail
          if (res.statusCode >= 200 && res.statusCode < 300) {
            return {
              passed: false,
              details: "Server accepted auth token in query string (spec: MUST NOT transmit credentials in URIs)",
            };
          }
          return { passed: true, details: `HTTP ${res.statusCode} (token in query string not accepted)` };
        } catch {
          return { passed: true, details: "Connection rejected (acceptable)" };
        }
      },
    );

    await test(
      "security-cors-headers",
      "CORS headers are restrictive",
      "security",
      false,
      "basic/transports#streamable-http",
      async () => {
        // Send an OPTIONS preflight or check CORS headers from a normal response
        try {
          const res = await request(backendUrl, {
            method: "OPTIONS",
            headers: {
              Origin: "https://evil.example.com",
              "Access-Control-Request-Method": "POST",
              ...buildHeaders(),
            },
            signal: AbortSignal.timeout(Math.min(timeout, 5000)),
          });
          await res.body.text();
          const acao = res.headers["access-control-allow-origin"];
          if (!acao) {
            return { passed: true, details: "No CORS headers returned (server-to-server only, acceptable)" };
          }
          if (acao === "*") {
            return {
              passed: false,
              details: 'Access-Control-Allow-Origin is "*" (wildcard) — allows cross-origin credential theft',
            };
          }
          if (acao === "https://evil.example.com") {
            return { passed: false, details: "Server reflects arbitrary Origin in CORS — effectively wildcard" };
          }
          return { passed: true, details: `CORS restricted to: ${acao}` };
        } catch {
          return { passed: true, details: "OPTIONS request failed (no CORS, acceptable)" };
        }
      },
    );

    await test(
      "security-origin-validation",
      "Validates Origin header on requests",
      "security",
      false,
      "basic/transports#streamable-http",
      async () => {
        // Send a POST with a suspicious Origin header — server should validate it for DNS rebinding protection
        try {
          const res = await request(backendUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              Origin: "https://evil-rebinding-attack.example.com",
              ...buildHeaders(),
            },
            body: JSON.stringify({ jsonrpc: "2.0", id: createIdCounter(99970)(), method: "ping" }),
            signal: AbortSignal.timeout(timeout),
          });
          await res.body.text();
          if (res.statusCode === 403 || res.statusCode === 401) {
            return { passed: true, details: `HTTP ${res.statusCode} (suspicious Origin rejected)` };
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            return {
              passed: false,
              details: `HTTP ${res.statusCode} — server accepted request with untrusted Origin header (spec: MUST validate Origin for DNS rebinding protection)`,
            };
          }
          if (res.statusCode >= 400) {
            return { passed: true, details: `HTTP ${res.statusCode} (suspicious Origin rejected)` };
          }
          return { passed: false, details: `HTTP ${res.statusCode}` };
        } catch {
          return { passed: true, details: "Connection rejected (acceptable)" };
        }
      },
    );

    // Input validation security tests (only run if tools are available)
    // Shared helper for injection tests: sends payloads to a tool param, checks output against a detection pattern
    /**
     * Heuristic patterns that indicate the server REJECTED the payload
     * rather than executing it. If a response matches both `detectPattern`
     * (suggesting execution) AND a rejection pattern, treat as a pass —
     * the server defended correctly and just happened to echo the payload
     * in its error message. Without this, well-defended servers like
     * @modelcontextprotocol/server-filesystem look like they're vulnerable
     * just because their error responses include the offending input.
     */
    const REJECTION_PATTERNS = [
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

    function looksRejected(text: string, isErrorFlag: boolean): boolean {
      if (isErrorFlag) return true;
      return REJECTION_PATTERNS.some((p) => p.test(text));
    }

    async function runInjectionTest(
      toolName: string,
      paramName: string,
      payloads: string[],
      detectPattern: RegExp,
      label: string,
    ): Promise<{ passed: boolean; details: string }> {
      const issues: string[] = [];
      let defended = 0;
      for (const payload of payloads) {
        try {
          const res = await rpc("tools/call", { name: toolName, arguments: { [paramName]: payload } });
          const result = res.body?.result;
          const content = result?.content;
          const isErrorFlag = result?.isError === true;
          if (Array.isArray(content)) {
            const text = content.map((c: any) => c.text || "").join(" ");
            if (detectPattern.test(text)) {
              if (looksRejected(text, isErrorFlag)) {
                defended++;
              } else {
                issues.push(`Payload "${payload}" ${label} (output: ${text.substring(0, 100)})`);
              }
            } else {
              defended++;
            }
          }
        } catch {
          // Error is acceptable — server rejected the input
          defended++;
        }
      }
      if (issues.length > 0) return { passed: false, details: issues.join("; ") };
      return {
        passed: true,
        details:
          defended === payloads.length
            ? `Tested ${payloads.length} payloads against ${toolName}.${paramName} — server defended (rejected or sanitized)`
            : `Tested ${payloads.length} payloads against ${toolName}.${paramName} — no ${label.split(" ")[0]} detected`,
      };
    }

    if (toolNames.length > 0) {
      const allTools: any[] = cachedToolsList ?? [];
      const toolsWithStringParams = allTools.filter((t) => {
        const props = t.inputSchema?.properties;
        if (!props) return false;
        return Object.values(props).some((p: any) => p.type === "string");
      });

      const injectionTarget: any = toolsWithStringParams[0] || allTools[0];
      const targetStringParam: string | null = injectionTarget?.inputSchema?.properties
        ? (Object.entries(injectionTarget.inputSchema.properties).find(
            ([_, v]: [string, any]) => v.type === "string",
          )?.[0] ?? null)
        : null;

      await test(
        "security-command-injection",
        "Resists command injection in tool params",
        "security",
        false,
        "server/tools#calling-tools",
        async () => {
          if (!injectionTarget || !targetStringParam)
            return { passed: true, details: "No tools with string parameters to test" };
          return runInjectionTest(
            injectionTarget.name,
            targetStringParam,
            INJECTION_PAYLOADS.command,
            /root:.*:\d+:\d+:.*:\/|uid=\d+\(\w+\)|drwxr|pwned/i,
            "appears to have executed",
          );
        },
      );

      await test(
        "security-sql-injection",
        "Resists SQL injection in tool params",
        "security",
        false,
        "server/tools#calling-tools",
        async () => {
          if (!injectionTarget || !targetStringParam)
            return { passed: true, details: "No tools with string parameters to test" };
          return runInjectionTest(
            injectionTarget.name,
            targetStringParam,
            INJECTION_PAYLOADS.sql,
            /syntax error|sql|mysql|postgres|sqlite|information_schema|table_name/i,
            "triggered database error",
          );
        },
      );

      await test(
        "security-path-traversal",
        "Resists path traversal in tool params",
        "security",
        false,
        "server/tools#calling-tools",
        async () => {
          if (!injectionTarget || !targetStringParam)
            return { passed: true, details: "No tools with string parameters to test" };
          return runInjectionTest(
            injectionTarget.name,
            targetStringParam,
            INJECTION_PAYLOADS.pathTraversal,
            /root:.*:0:0|\[boot loader\]|\[extensions\]/i,
            "returned sensitive file content",
          );
        },
      );

      await test(
        "security-ssrf-internal",
        "Resists SSRF to internal networks",
        "security",
        false,
        "server/tools#calling-tools",
        async () => {
          const urlParamTool = allTools.find((t: any) => {
            const props = t.inputSchema?.properties;
            if (!props) return false;
            return Object.entries(props).some(
              ([k, v]: [string, any]) => v.type === "string" && /url|uri|endpoint|link|href/i.test(k),
            );
          });
          if (!urlParamTool) return { passed: true, details: "No tools with URL parameters found (skipped)" };
          const urlParam = Object.entries(urlParamTool.inputSchema.properties).find(
            ([k, v]: [string, any]) => v.type === "string" && /url|uri|endpoint|link|href/i.test(k),
          )?.[0];
          if (!urlParam) return { passed: true, details: "No URL parameter found" };
          return runInjectionTest(
            urlParamTool.name,
            urlParam,
            INJECTION_PAYLOADS.ssrf,
            /ami-|instance-id|hostname|iam|security-credentials/i,
            "returned internal data",
          );
        },
      );
    } else {
      // No tools — auto-pass input validation tests
      for (const testId of [
        "security-command-injection",
        "security-sql-injection",
        "security-path-traversal",
        "security-ssrf-internal",
      ]) {
        await test(
          testId,
          TEST_DEFINITIONS_MAP.get(testId)?.name || testId,
          "security",
          false,
          "server/tools#calling-tools",
          async () => ({ passed: true, details: "No tools available to test (skipped)" }),
        );
      }
    }

    await test(
      "security-oversized-input",
      "Handles oversized inputs gracefully",
      "security",
      false,
      "server/tools#calling-tools",
      async () => {
        const largeValue = "A".repeat(1_048_576);
        try {
          const res = await request(backendUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              ...buildHeaders(),
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: nextId(),
              method: "tools/call",
              params: { name: toolNames[0] || "test", arguments: { data: largeValue } },
            }),
            signal: AbortSignal.timeout(timeout),
          });
          await res.body.text();
          if (res.statusCode === 413) {
            return { passed: true, details: "HTTP 413 Payload Too Large (good)" };
          }
          if (res.statusCode >= 400) {
            return { passed: true, details: `HTTP ${res.statusCode} (oversized input rejected)` };
          }
          return { passed: true, details: `HTTP ${res.statusCode} — server handled 1MB payload without crashing` };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("timeout") || msg.includes("abort")) {
            return { passed: false, details: "Request timed out — server may be struggling with oversized input" };
          }
          return { passed: true, details: "Connection rejected (acceptable for oversized input)" };
        }
      },
    );

    await test(
      "security-extra-params",
      "Rejects or ignores extra tool params",
      "security",
      false,
      "server/tools#calling-tools",
      async () => {
        if (toolNames.length === 0) {
          return { passed: true, details: "No tools available to test (skipped)" };
        }
        try {
          const res = await rpc("tools/call", {
            name: toolNames[0],
            arguments: { __injected_param__: "malicious_value", __proto__: { admin: true } },
          });
          const error = res.body?.error;
          if (error) {
            return { passed: true, details: `Extra params rejected with error: ${error.code} — ${error.message}` };
          }
          // If server accepted but ignored extra params, that's acceptable
          return { passed: true, details: "Server processed request (extra params likely ignored)" };
        } catch {
          return { passed: true, details: "Request rejected (acceptable)" };
        }
      },
    );

    // Tool integrity tests
    await test(
      "security-tool-schema-defined",
      "All tools define inputSchema",
      "security",
      false,
      "server/tools#data-types",
      async () => {
        if (!toolsListOk) return { passed: true, details: "Skipped: tools/list not available" };
        const tools = cachedToolsList ?? [];
        if (tools.length === 0) return { passed: true, details: "No tools to validate" };
        const missing = tools.filter((t: any) => !t.inputSchema || t.inputSchema.type !== "object");
        if (missing.length > 0) {
          return {
            passed: false,
            details: `${missing.length} tool(s) missing inputSchema: ${missing.map((t: any) => t.name).join(", ")}`,
          };
        }
        return { passed: true, details: `All ${tools.length} tool(s) have inputSchema defined` };
      },
    );

    await test(
      "security-tool-rug-pull",
      "Tool definitions are stable across calls",
      "security",
      false,
      "server/tools#listing-tools",
      async () => {
        if (!toolsListOk) return { passed: true, details: "Skipped: tools/list not available" };
        // Fetch tools/list again and compare
        try {
          const res = await rpc("tools/list");
          const tools2 = res.body?.result?.tools;
          if (!Array.isArray(tools2)) return { passed: false, details: "Second tools/list call failed" };
          const tools1 = cachedToolsList ?? [];
          if (tools1.length !== tools2.length) {
            return {
              passed: false,
              details: `Tool count changed: ${tools1.length} → ${tools2.length} (possible rug-pull)`,
            };
          }
          const names1 = tools1
            .map((t: any) => t.name)
            .sort()
            .join(",");
          const names2 = tools2
            .map((t: any) => t.name)
            .sort()
            .join(",");
          if (names1 !== names2) {
            return { passed: false, details: "Tool names changed between calls (possible rug-pull)" };
          }
          // Check descriptions haven't changed
          for (const t1 of tools1) {
            const t2 = tools2.find((t: any) => t.name === t1.name);
            if (t2 && t1.description !== t2.description) {
              return {
                passed: false,
                details: `Tool "${t1.name}" description changed between calls (possible rug-pull)`,
              };
            }
          }
          return { passed: true, details: `${tools1.length} tool(s) consistent across 2 calls` };
        } catch {
          return { passed: false, details: "Second tools/list call threw an error" };
        }
      },
    );

    await test(
      "security-tool-description-poisoning",
      "Tool descriptions free of injection patterns",
      "security",
      false,
      "server/tools#data-types",
      async () => {
        if (!toolsListOk) return { passed: true, details: "Skipped: tools/list not available" };
        const tools = cachedToolsList ?? [];
        if (tools.length === 0) return { passed: true, details: "No tools to validate" };

        const suspiciousPatterns = [
          { pattern: /ignore\s+(all\s+)?previous/i, label: "ignore previous instructions" },
          { pattern: /override\s+(system|instructions|rules)/i, label: "override instructions" },
          { pattern: /system\s+prompt/i, label: "system prompt reference" },
          { pattern: /you\s+must\s+(always|never)/i, label: "behavioral override" },
          { pattern: /do\s+not\s+(tell|inform|mention)/i, label: "concealment instruction" },
          { pattern: /\b[A-Za-z0-9+/]{40,}={0,2}\b/, label: "possible Base64-encoded payload" },
          // Zero-width characters (U+200B, U+200C, U+200D, U+FEFF)
          { pattern: /\u200B|\u200C|\u200D|\uFEFF/, label: "hidden Unicode characters" },
        ];

        const issues: string[] = [];
        for (const tool of tools) {
          const textsToCheck = [
            tool.description || "",
            ...(tool.inputSchema?.properties
              ? Object.values(tool.inputSchema.properties).map((p: any) => p.description || "")
              : []),
          ];
          const combined = textsToCheck.join(" ");
          for (const { pattern, label } of suspiciousPatterns) {
            if (pattern.test(combined)) {
              issues.push(`Tool "${tool.name}": ${label}`);
            }
          }
        }
        if (issues.length > 0) return { passed: false, details: issues.join("; ") };
        return { passed: true, details: `${tools.length} tool(s) scanned — no injection patterns found` };
      },
    );

    await test(
      "security-tool-cross-reference",
      "Tools do not reference other tools by name",
      "security",
      false,
      "server/tools#data-types",
      async () => {
        if (!toolsListOk) return { passed: true, details: "Skipped: tools/list not available" };
        const tools = cachedToolsList ?? [];
        if (tools.length < 2)
          return { passed: true, details: "Fewer than 2 tools — cross-reference check not applicable" };

        const names = tools.map((t: any) => t.name).filter(Boolean);
        const issues: string[] = [];
        for (const tool of tools) {
          const desc = (tool.description || "").toLowerCase();
          for (const otherName of names) {
            if (otherName === tool.name) continue;
            if (desc.includes(otherName.toLowerCase())) {
              issues.push(`Tool "${tool.name}" description references "${otherName}"`);
            }
          }
        }
        if (issues.length > 0) {
          warnings.push(`Cross-tool references found: ${issues.join("; ")}`);
          return { passed: false, details: issues.join("; ") };
        }
        return { passed: true, details: `${tools.length} tool(s) checked — no cross-references found` };
      },
    );

    // Information disclosure tests
    await test(
      "security-error-no-stacktrace",
      "Error responses do not leak stack traces",
      "security",
      false,
      "basic",
      async () => {
        const errorResponses: string[] = [];
        // Trigger several error conditions and collect response text
        const errorPayloads = [
          "{this is not valid json!!!",
          JSON.stringify({ jsonrpc: "2.0", id: nextId(), method: "nonexistent/___crash___test___" }),
          JSON.stringify({
            jsonrpc: "2.0",
            id: nextId(),
            method: "tools/call",
            params: { name: "___nonexistent___tool___" },
          }),
        ];
        for (const payload of errorPayloads) {
          try {
            const res = await request(backendUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Accept: "application/json, text/event-stream",
                ...buildHeaders(),
              },
              body: payload,
              signal: AbortSignal.timeout(timeout),
            });
            const text = await res.body.text();
            errorResponses.push(text);
          } catch {
            // Connection error — no response to check
          }
        }

        const issues: string[] = [];
        for (const text of errorResponses) {
          for (const pattern of STACK_TRACE_PATTERNS) {
            if (pattern.test(text)) {
              issues.push(`Response contains: ${pattern.source} (matched in: ${text.substring(0, 80)}...)`);
              break; // One match per response is enough
            }
          }
        }
        if (issues.length > 0) return { passed: false, details: issues.slice(0, 3).join("; ") };
        return {
          passed: true,
          details: `${errorResponses.length} error responses checked — no stack traces or sensitive data found`,
        };
      },
    );

    await test(
      "security-error-no-internal-ip",
      "Error responses do not leak internal IPs",
      "security",
      false,
      "basic",
      async () => {
        // Trigger an error and check for internal IPs
        try {
          const res = await request(backendUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              ...buildHeaders(),
            },
            body: JSON.stringify({ jsonrpc: "2.0", id: nextId(), method: "___trigger_error___" }),
            signal: AbortSignal.timeout(timeout),
          });
          const text = await res.body.text();
          for (const pattern of INTERNAL_IP_PATTERNS) {
            const match = text.match(pattern);
            if (match) {
              return { passed: false, details: `Error response contains internal IP: ${match[0]}` };
            }
          }
          return { passed: true, details: "No internal IP addresses found in error responses" };
        } catch {
          return { passed: true, details: "No response to check (connection error)" };
        }
      },
    );

    await test(
      "security-rate-limiting",
      "Rate limiting is enforced",
      "security",
      false,
      "basic/transports#streamable-http",
      async () => {
        // Send a burst of 50 rapid requests
        const burstSize = 50;
        let got429 = false;
        const promises = Array.from({ length: burstSize }, () =>
          mcpRequest(backendUrl, "ping", undefined, nextId, buildHeaders(), timeout)
            .then((res) => {
              if (res.statusCode === 429) got429 = true;
              return res.statusCode;
            })
            .catch(() => 0),
        );
        const statusCodes = await Promise.all(promises);
        if (got429) {
          return { passed: true, details: `Rate limiting detected (429 returned after ${burstSize} rapid requests)` };
        }
        const errorCount = statusCodes.filter((c) => c >= 500).length;
        if (errorCount > burstSize / 2) {
          return {
            passed: false,
            details: `Server returned ${errorCount}/${burstSize} 5xx errors under load — should return 429 instead of crashing`,
          };
        }
        return {
          passed: false,
          details: `No rate limiting detected (${burstSize} rapid requests all returned ${[...new Set(statusCodes)].join(",")})`,
        };
      },
    );

    // ── 10. SESSION CLEANUP (runs last to avoid breaking other tests) ──

    await test(
      "transport-delete",
      "DELETE accepted or returns 405",
      "transport",
      false,
      "basic/transports#streamable-http",
      async () => {
        const deleteHeaders: Record<string, string> = { ...buildHeaders() };
        const res = await request(backendUrl, {
          method: "DELETE",
          headers: deleteHeaders,
          signal: AbortSignal.timeout(timeout),
        });
        await res.body.text();
        if (res.statusCode === 405) {
          return { passed: true, details: "HTTP 405 Method Not Allowed (acceptable)" };
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          // Session terminated — verify subsequent request with old session ID is rejected
          if (sessionId) {
            try {
              const verifyRes = await mcpRequest(
                backendUrl,
                "ping",
                undefined,
                createIdCounter(99920),
                deleteHeaders,
                timeout,
              );
              if (verifyRes.statusCode === 400 || verifyRes.statusCode === 404 || verifyRes.statusCode === 409) {
                return {
                  passed: true,
                  details: `HTTP ${res.statusCode} (session terminated, post-delete request correctly rejected with ${verifyRes.statusCode})`,
                };
              }
            } catch {
              // Connection refused after delete is also acceptable
              return {
                passed: true,
                details: `HTTP ${res.statusCode} (session terminated, post-delete request rejected)`,
              };
            }
          }
          return { passed: true, details: `HTTP ${res.statusCode} (session termination supported)` };
        }
        // 400/404 are also acceptable (no active session)
        if (res.statusCode === 400 || res.statusCode === 404) {
          return { passed: true, details: `HTTP ${res.statusCode} (no active session, acceptable)` };
        }
        return { passed: false, details: `HTTP ${res.statusCode}` };
      },
    );

    // ── STDIO-SPECIFIC TESTS ─────────────────────────────────────────
    // All gated behind supportsTransport() via transports:["stdio"] in
    // TEST_DEFINITIONS, so they only run for stdio targets.

    await test(
      "stdio-framing",
      "Newline-delimited JSON framing",
      "transport",
      true,
      "basic/transports#stdio",
      async () => {
        // Fire 5 rapid pings. If the server frames responses incorrectly,
        // the transport's line-splitter will fail to parse one or more.
        const results = await Promise.all(
          Array.from({ length: 5 }, () => rpc("ping").catch((e: Error) => ({ _err: e.message }))),
        );
        const failed = results.filter((r) => "_err" in (r as object));
        if (failed.length) {
          return { passed: false, details: `${failed.length}/5 rapid pings failed — framing likely broken` };
        }
        return { passed: true, details: "5/5 rapid pings returned cleanly" };
      },
    );

    await test("stdio-unicode", "UTF-8 unicode roundtrip", "transport", false, "basic/transports#stdio", async () => {
      const probe = "héllo 世界 🚀";
      // Prefer tools/call on the first tool if one exists; otherwise fall
      // back to tools/list which will at worst exercise the parser.
      if (hasTools && toolNames.length > 0) {
        try {
          const res = await rpc("tools/call", {
            name: toolNames[0],
            arguments: { message: probe, text: probe, input: probe, query: probe },
          });
          const serialized = JSON.stringify(res.body);
          if (serialized.includes(probe)) {
            return { passed: true, details: "Unicode string round-tripped through tool call" };
          }
          return { passed: true, details: "Tool echoed something, but not the exact probe — likely still UTF-8-safe" };
        } catch (err: unknown) {
          return { passed: false, details: `tools/call threw — ${err instanceof Error ? err.message : String(err)}` };
        }
      }
      // Fallback: just ensure tools/list (a canonical call) succeeds.
      // If the server can parse this at all, encoding is plausible.
      const res = await rpc("tools/list");
      if ((res.body as { error?: unknown }).error) {
        return { passed: false, details: "tools/list returned error" };
      }
      return { passed: true, details: "tools/list returned successfully (no tools to probe with unicode)" };
    });

    await test(
      "stdio-unknown-method-recovers",
      "Recovers after unknown method",
      "transport",
      false,
      "basic/transports#stdio",
      async () => {
        // Send an unknown method; server should reply with JSON-RPC error.
        const errRes = await rpc("this/method/does/not/exist-xyzzy");
        const errBody = errRes.body as { error?: { code?: number }; result?: unknown };
        if (!errBody.error) {
          return { passed: false, details: "Unknown method did not produce a JSON-RPC error" };
        }
        // Now send a valid request; server must still be alive.
        const okRes = await rpc("ping");
        const okBody = okRes.body as { error?: unknown; result?: unknown };
        if (okBody.error) {
          return {
            passed: false,
            details: "Server responded with error to ping after unknown method — may have desynced",
          };
        }
        return { passed: true, details: "Unknown method returned JSON-RPC error; subsequent ping succeeded" };
      },
    );

    // ── Cap warnings ─────────────────────────────────────────────────

    const MAX_WARNINGS = 100;
    if (warnings.length > MAX_WARNINGS) {
      const truncated = warnings.length - MAX_WARNINGS;
      warnings.splice(MAX_WARNINGS, truncated, `... and ${truncated} more warning(s) suppressed`);
    }

    // ── Compute score ────────────────────────────────────────────────

    const { score, grade, overall, summary, categories } = computeScore(tests);
    const badge = generateBadge(displayUrl);

    return {
      schemaVersion: REPORT_SCHEMA_VERSION,
      specVersion: SPEC_VERSION,
      toolVersion: TOOL_VERSION,
      url: displayUrl,
      timestamp: new Date().toISOString(),
      score,
      grade,
      overall,
      summary,
      categories,
      tests,
      warnings,
      serverInfo,
      toolCount,
      toolNames,
      resourceCount,
      resourceNames,
      promptCount,
      promptNames,
      badge,
    };
  } finally {
    // Always close the transport — swallow any close error so we don't
    // mask the real failure that brought us here.
    await transport.close().catch(() => {});
  }
}
