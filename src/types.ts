export type TestCategory =
  | "transport"
  | "lifecycle"
  | "tools"
  | "resources"
  | "prompts"
  | "errors"
  | "schema"
  | "security";

export interface TestResult {
  id: string;
  name: string;
  category: TestCategory;
  passed: boolean;
  /**
   * The check measured nothing. A precondition was absent (no `--auth`,
   * the server declares no tools, the probe is HTTP-only on a stdio run)
   * or an earlier check could not attribute the server's refusal, so this
   * one had no evidence to judge.
   *
   * A skip is still recorded as `passed: true`: it is not a failure, and
   * schema-v1 consumers that only know `passed` must not read it as one.
   * The flag is what tells a reader the difference. Absent = not a skip;
   * a result with `passed: false` is a failure whatever its details say,
   * and never carries this flag.
   *
   * NOTE: skips still count toward `summary.passed` (so passed + failed =
   * total), but the score leaves them out of both its numerator and its
   * denominator: it is computed over measured checks only, and a run in
   * which every check skipped scores 0 / F, like a run with no checks.
   */
  skipped?: boolean;
  required: boolean;
  details: string;
  durationMs: number;
  specRef?: string;
}

export type Grade = "A" | "B" | "C" | "D" | "F";
export type Overall = "pass" | "partial" | "fail";

/**
 * Version of the ComplianceReport JSON schema. Incremented on breaking
 * changes to the report shape. Downstream consumers (Yaw MCP, third-party
 * dashboards) pin against this.
 *
 * See schemas/report.v1.json for the authoritative schema definition.
 */
export const REPORT_SCHEMA_VERSION = "1";

export interface ComplianceReport {
  /** Stable report-format version. See REPORT_SCHEMA_VERSION. */
  schemaVersion: string;
  specVersion: string;
  toolVersion: string;
  url: string;
  timestamp: string;
  score: number;
  grade: Grade;
  overall: Overall;
  summary: {
    total: number;
    passed: number;
    failed: number;
    required: number;
    requiredPassed: number;
    /**
     * How many of `passed` measured nothing (see `TestResult.skipped`).
     * Optional so a report written by an older tool still types as a
     * ComplianceReport; every report this tool writes carries it.
     */
    skipped?: number;
  };
  /**
   * Per-category counts. `passed` includes that category's skips, which
   * `skipped` counts separately; older reports omit `skipped`.
   */
  categories: Record<string, { passed: number; total: number; skipped?: number }>;
  tests: TestResult[];
  warnings: string[];
  serverInfo: {
    protocolVersion: string | null;
    name: string | null;
    version: string | null;
    capabilities: Record<string, unknown>;
  };
  toolCount: number;
  toolNames: string[];
  resourceCount: number;
  resourceNames: string[];
  promptCount: number;
  promptNames: string[];
  /**
   * @deprecated The hosted badge renderer (mcp.hosting) is retired; these
   * fields are always empty and will be removed in schema v2. For a local
   * badge image, use the CLI's `--output <file>.svg`.
   */
  badge: {
    imageUrl: string;
    reportUrl: string;
    markdown: string;
    html: string;
  };
}

export interface TestDefinition {
  id: string;
  name: string;
  category: TestCategory;
  required: boolean;
  specRef: string;
  description: string;
  recommendation: string;
  /** Transports this test applies to. Omit = all transports. */
  transports?: ("http" | "stdio")[];
  /**
   * Declares this test safe to run concurrently with other parallel-safe
   * tests. Default = false (serialized with other tests in the runner
   * loop). Tests are parallel-safe when they:
   *   - don't mutate shared closure state (sessionId, cachedToolsList, …)
   *   - don't depend on the result of another concurrently-running test
   *   - tolerate the server seeing >1 in-flight request at a time
   *
   * Setup tests (init, notifications/initialized) and tests that
   * populate caches (tools/list, resources/list) must stay `false`.
   */
  parallelSafe?: boolean;
}

/** Describes the server under test. URL string = HTTP for backwards compat. */
export type TransportTarget =
  | { type: "http"; url: string; headers?: Record<string, string> }
  | {
      type: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
      verbose?: boolean;
    };

/** All 88 test IDs with descriptions for the explain command */
export const TEST_DEFINITIONS: TestDefinition[] = [
  // ── Transport (16 tests: 13 HTTP + 3 stdio) ──────────────────────
  {
    id: "transport-post",
    name: "HTTP POST accepted",
    category: "transport",
    required: true,
    specRef: "basic/transports#streamable-http",
    description:
      "Verifies the server accepts HTTP POST requests and returns a 2xx status code. This is the fundamental transport requirement for Streamable HTTP MCP servers.",
    recommendation:
      "Ensure your server listens for POST requests on the MCP endpoint. If you see 401 (or a 403 with a WWW-Authenticate: Bearer challenge), pass --auth with a valid token; any other 403 may be Host/Origin validation (e.g. a tunnel hostname) or a gateway. Check that the URL is correct and the server is running.",
  },
  {
    id: "transport-content-type",
    name: "Responds with JSON or SSE",
    category: "transport",
    required: true,
    specRef: "basic/transports#streamable-http",
    description:
      "Checks that the server responds with Content-Type application/json or text/event-stream. MCP servers must use one of these two content types.",
    recommendation:
      'Set the Content-Type response header to "application/json" for synchronous responses or "text/event-stream" for streaming. Do not use text/html or other types.',
  },
  {
    id: "transport-notification-202",
    name: "Notification returns 202 Accepted",
    category: "transport",
    required: false,
    specRef: "basic/transports#streamable-http",
    description:
      "Verifies that sending a JSON-RPC notification (no id field) returns exactly HTTP 202 Accepted with no body. Per spec, servers MUST return 202 — not 200 or 204.",
    recommendation:
      "Detect JSON-RPC messages without an id field and return HTTP 202 with an empty body. Do not return 200 or 204 — the spec requires exactly 202 Accepted.",
  },
  {
    id: "transport-session-id",
    name: "Enforces MCP-Session-Id after init",
    category: "transport",
    required: false,
    specRef: "basic/transports#streamable-http",
    description:
      "Tests that the server returns HTTP 400 when MCP-Session-Id header is missing on requests after initialization (when the server issued a session ID).",
    recommendation:
      "If your server issues an MCP-Session-Id header in the initialize response, reject subsequent requests that omit this header with HTTP 400.",
  },
  {
    id: "transport-session-invalid",
    name: "Returns 404 for unknown session ID",
    category: "transport",
    required: false,
    specRef: "basic/transports#streamable-http",
    description:
      "Sends a request with a fabricated MCP-Session-Id and verifies the server returns HTTP 404. Per spec, servers managing sessions MUST return 404 for unrecognized session IDs.",
    recommendation:
      "Return HTTP 404 (Not Found) for requests with an MCP-Session-Id that does not match any active session. Do not return 400 — that is for missing session IDs.",
  },
  {
    id: "transport-content-type-reject",
    name: "Rejects non-JSON request Content-Type",
    category: "transport",
    required: false,
    specRef: "basic/transports#streamable-http",
    description:
      "Sends a POST with Content-Type: text/plain instead of application/json and verifies the server rejects it with a 4xx status. Only the server's own rejection counts: a 401 or an auth-gate 403 (one whose Bearer challenge reads as an auth refusal) and a 429 are answers something in front of the server gave in its place, and each fails as not evaluable. A 429 is first resent once after Retry-After, capped at 2 s, and the second answer decides. Any other 403 counts only when the same ping sent on its own as application/json (resent once after Retry-After when it draws a 429) was served or drew a status the server itself chose (a 2xx, or a 4xx other than 401, 403 or 429), whatever its message says; that ping is sent only in this case (at most once per run, shared with transport-batch-reject and lifecycle-jsonrpc). When that ping drew the same 403, a 401, a 429 again, a 5xx, a redirect or no answer, it never reached the server either and the probe fails as not evaluable, quoting the message when the ping drew the same 403 and the message names Host/Origin validation. A 5xx fails as the server failing on the request rather than refusing it.",
    recommendation:
      "Validate the Content-Type header on incoming POST requests. Reject requests that are not application/json with HTTP 415 (Unsupported Media Type) or 400.",
  },
  {
    id: "transport-get",
    name: "GET returns SSE stream or 405",
    category: "transport",
    required: false,
    specRef: "basic/transports#streamable-http",
    description:
      "Tests the GET endpoint for server-initiated messages. Server should return text/event-stream or 405 Method Not Allowed.",
    recommendation:
      "If your server supports server-initiated messages, handle GET with text/event-stream. Otherwise, return 405 Method Not Allowed.",
  },
  {
    id: "transport-delete",
    name: "DELETE accepted or returns 405",
    category: "transport",
    required: false,
    specRef: "basic/transports#streamable-http",
    description:
      "Tests the DELETE endpoint for session termination. Server should accept the request or return 405 Method Not Allowed.",
    recommendation:
      "Handle DELETE requests for session cleanup, or return 405 if session termination is not supported. Do not return 500.",
  },
  {
    id: "transport-batch-reject",
    name: "Rejects JSON-RPC batch requests",
    category: "transport",
    required: true,
    specRef: "basic/transports#streamable-http",
    description:
      "Sends a JSON-RPC batch request (array of messages) and verifies the server rejects it with an error. MCP does not support JSON-RPC batch requests. A 4xx or a JSON-RPC error counts only as the server's own: a 401 or an auth-gate 403 (one whose Bearer challenge reads as an auth refusal) and a 429 are answers something in front of the server gave in its place, and each fails as not evaluable, whether or not it carries a JSON-RPC error body. A 429 is first resent once after Retry-After, capped at 2 s, and the second answer decides. Any other 403 counts only when the same ping sent on its own as application/json (resent once after Retry-After when it draws a 429) was served or drew a status the server itself chose (a 2xx, or a 4xx other than 401, 403 or 429), whatever its message says; that ping is sent only in this case (at most once per run, shared with transport-content-type-reject and lifecycle-jsonrpc). When that ping drew the same 403, a 401, a 429 again, a 5xx, a redirect or no answer, it never reached the server either and the probe fails as not evaluable, quoting the message when the ping drew the same 403 and the message names Host/Origin validation. A 5xx fails as the server failing on the request rather than refusing it, unless it carries the server's own -32600 (Invalid Request): that passes, with a warning that a rejected request should get a 4xx. A 5xx with -32603, a server-defined -32000..-32099 code, or no JSON-RPC error still fails.",
    recommendation:
      "Check if the parsed JSON body is an array. If so, return a JSON-RPC error or HTTP 400. Do not process batch requests — MCP explicitly forbids them.",
  },

  {
    id: "transport-content-type-init",
    name: "Initialize response has valid content type",
    category: "transport",
    required: false,
    specRef: "basic/transports#streamable-http",
    description:
      "Validates that the initialize response uses application/json or text/event-stream content type. Some servers return other types for the handshake.",
    recommendation:
      'Ensure the initialize response uses Content-Type "application/json" or "text/event-stream". Do not return text/html or other types for JSON-RPC responses.',
  },

  {
    id: "transport-get-stream",
    name: "GET with session returns SSE or 405",
    category: "transport",
    required: false,
    specRef: "basic/transports#streamable-http",
    description:
      "Tests the GET endpoint with an active session ID for server-initiated messages. After initialization, the server should either return an SSE stream or 405.",
    recommendation:
      "If your server supports server-initiated messages, return text/event-stream on GET with a valid session ID. Otherwise, return 405 Method Not Allowed.",
  },

  {
    id: "transport-concurrent",
    name: "Handles concurrent requests",
    category: "transport",
    required: false,
    specRef: "basic/transports#streamable-http",
    description:
      "Sends multiple JSON-RPC requests in parallel and verifies the server responds to all with correct matching IDs. Tests that the server can handle concurrent connections.",
    recommendation:
      "Ensure your server can handle multiple simultaneous requests. Each response must include the correct id matching the request. Use async handlers or connection pooling.",
  },

  {
    id: "transport-sse-event-field",
    name: "SSE responses include event: message",
    category: "transport",
    required: false,
    specRef: "basic/transports#streamable-http",
    description:
      "Sends a request with Accept: text/event-stream and checks that SSE responses include the event: message field. Per spec, servers MUST set event: message for JSON-RPC messages in SSE streams.",
    recommendation:
      'Include "event: message" before each "data:" line in your SSE responses. This is required by the MCP spec for JSON-RPC messages sent over SSE.',
  },

  // ── Stdio transport (stdio-only) ─────────────────────────────────
  {
    id: "stdio-framing",
    name: "Newline-delimited JSON framing",
    category: "transport",
    required: true,
    specRef: "basic/transports#stdio",
    description:
      "Fires several JSON-RPC requests in rapid succession and verifies the server frames each response with a trailing newline per the MCP stdio transport spec.",
    recommendation:
      "Emit one JSON message per line on stdout, terminated by \\n. Do not split a single message across multiple lines or merge multiple messages onto one line.",
    transports: ["stdio"],
  },
  {
    id: "stdio-unicode",
    name: "UTF-8 unicode roundtrip",
    category: "transport",
    required: false,
    specRef: "basic/transports#stdio",
    description:
      "Sends non-ASCII characters (a Latin-1 accent, CJK and an emoji) and verifies they survive the round trip, the 2026-07-28 check's judgement. Catches latin-1 or platform-default decoding of stdin and encoding of stdout. The probe rides a tools/call to a tool named echo, else the first tool with a string property named message, text, input or query, else the first listed tool (tools/list is read on demand when tools-list did not run); it goes into those echo arguments, or into all four names when the tool declares none. A reply that reproduces the probe byte-for-byte passes, and so does one that reproduces every non-ASCII piece of it somewhere (a tool that tokenizes its input). Evidence of mangling fails: U+FFFD replacement characters, a Latin-1 mis-decode, the non-ASCII characters replaced by '?', the non-ASCII characters dropped (the probe's first word, or its ASCII skeleton, with neither the CJK word nor the emoji anywhere in the reply), or a -32700 parse error. A reply that merely does not echo its input (or rejects the arguments) proves nothing, so the verdict then rests on a ping whose _meta carries the probe (the 2026-07-28 check uses a server/discover whose clientInfo name carries it): answered with a result, it passes as the envelope round-trip verified; answered with an error or a non-JSON-RPC reply, or mangled, it fails. With no tool to call (none declared, none listed, or no list), the ping decides alone. A request that gets no reply fails with a one-line reason, and so does one answered by a child that exits right after (a plain ping sent after each answered probe finds it gone); a child that exited on it, or right after answering it, is restarted with a fresh initialize handshake, with a warning naming the check, so the checks after it measure the server, and one already gone before it fails as 'server unreachable'.",
    recommendation:
      "Decode stdin as UTF-8 and encode stdout as UTF-8. Avoid latin-1 or platform-default encodings on Windows. Most JSON libraries handle this correctly if you don't override defaults.",
    transports: ["stdio"],
  },
  {
    id: "stdio-unknown-method-recovers",
    name: "Recovers after unknown method",
    category: "transport",
    required: false,
    specRef: "basic/transports#stdio",
    description:
      "Sends an unknown method, then a valid ping immediately after. Verifies the server returns a JSON-RPC error for the unknown method and continues serving the subsequent request without crashing.",
    recommendation:
      "Return JSON-RPC error -32601 (Method not found) for unknown methods. Do not exit the process or disconnect — the client should be able to keep using the session after an error.",
    transports: ["stdio"],
  },

  // ── Lifecycle (21 tests) ─────────────────────────────────────────
  {
    id: "lifecycle-init",
    name: "Initialize handshake",
    category: "lifecycle",
    required: true,
    specRef: "basic/lifecycle#initialization",
    description:
      "Tests the initialize handshake by sending an initialize request with client capabilities. The server must return a result with protocolVersion.",
    recommendation:
      'Implement the "initialize" method handler. Return a result object with at least protocolVersion, capabilities, and serverInfo fields.',
  },
  {
    id: "lifecycle-proto-version",
    name: "Returns valid protocol version",
    category: "lifecycle",
    required: true,
    specRef: "basic/lifecycle#version-negotiation",
    description:
      "Validates that the protocolVersion returned by the server matches the YYYY-MM-DD date format required by the spec.",
    recommendation:
      'Return protocolVersion as a YYYY-MM-DD string (e.g., "2025-11-25"). The server should negotiate based on the client\'s requested version.',
  },
  {
    id: "lifecycle-server-info",
    name: "Includes serverInfo",
    category: "lifecycle",
    required: false,
    specRef: "basic/lifecycle#initialization",
    description:
      "Checks that the server includes a serverInfo object with at least a name field in its initialize response. While recommended, this is not strictly required.",
    recommendation:
      'Add a serverInfo object to your initialize response: { name: "your-server", version: "1.0.0" }. This helps clients identify your server.',
  },
  {
    id: "lifecycle-capabilities",
    name: "Returns capabilities object",
    category: "lifecycle",
    required: true,
    specRef: "basic/lifecycle#capability-negotiation",
    description:
      "Verifies the server returns a capabilities object in its initialize response. An empty object is valid (no optional features declared).",
    recommendation:
      "Include a capabilities object in your initialize response. Declare the features your server supports (tools, resources, prompts, logging, etc.). An empty object {} is valid.",
  },
  {
    id: "lifecycle-jsonrpc",
    name: "Response is valid JSON-RPC 2.0",
    category: "lifecycle",
    required: true,
    specRef: "basic",
    description:
      "Validates that the initialize response is a proper JSON-RPC 2.0 message with jsonrpc=\"2.0\", an id field, and either a result or error field. An initialize answered without a result counts only when the envelope is the server's own: one something in front of the server wrote (a gateway's -32001 'Unauthorized' on its 401) is no evidence of the server's JSON-RPC, however valid. It fails as not evaluable on a 401 or an auth-gate 403 (one whose Bearer challenge reads as an auth refusal), a 429 (a rate limiter), a 5xx that does not carry the server's own refusal of the initialize (-32600, -32601 or -32602: a broken server, or a gateway with no backend), or any other 403 when the same ping sent on its own as application/json (resent once after Retry-After when it draws a 429) never reached the server either: it drew the same 403, a 401, a 429 again, a 5xx, a redirect or no answer (a guard refusing every request; the message is quoted when the ping drew the same 403 and the message names Host/Origin validation). That ping is sent only for such a 403 (at most once per run, shared with transport-content-type-reject and transport-batch-reject), and a 403 next to a ping that was served or drew a status the server itself chose (a 2xx, or a 4xx other than 401, 403 or 429) is read as the server's own envelope. A 5xx carrying the server's own -32600, -32601 or -32602 is read as the server's envelope too, with a warning that a rejected request should get a 4xx. Over stdio every answer is the server's.",
    recommendation:
      'Ensure every response includes jsonrpc: "2.0", the matching id from the request, and either a result or error field. Never omit the jsonrpc field.',
  },
  {
    id: "lifecycle-ping",
    name: "Responds to ping",
    category: "lifecycle",
    required: true,
    specRef: "basic/utilities#ping",
    description:
      "Tests that the server responds to the ping method with an empty result object. This is a required utility method.",
    recommendation:
      'Implement a "ping" method handler that returns an empty result object {}. This is required by the MCP spec for keepalive and connectivity checking.',
    parallelSafe: true,
  },
  {
    id: "lifecycle-instructions",
    name: "Instructions field is valid",
    category: "lifecycle",
    required: false,
    specRef: "basic/lifecycle#initialization",
    description:
      "If the server includes an instructions field in the initialize response, validates it is a string. Instructions provide guidance for how the client should interact with the server.",
    recommendation:
      "If you include an instructions field in the initialize response, ensure it is a string. Remove the field or fix the type if it is not a string.",
    parallelSafe: true,
  },
  {
    id: "lifecycle-id-match",
    name: "Response ID matches request ID",
    category: "lifecycle",
    required: true,
    specRef: "basic",
    description:
      "Verifies that the JSON-RPC response id matches the request id sent by the client. This is a fundamental JSON-RPC 2.0 requirement.",
    recommendation:
      "Copy the id field from the request into the response. This is a core JSON-RPC 2.0 requirement. Check that your framework does not modify or discard the request ID.",
  },
  {
    id: "lifecycle-string-id",
    name: "Supports string request IDs",
    category: "lifecycle",
    required: false,
    specRef: "basic",
    description:
      "Sends a request with a string id instead of a number. JSON-RPC 2.0 allows both string and number IDs. The server must echo back the exact string id in the response.",
    recommendation:
      "Ensure your JSON-RPC implementation supports both string and number request IDs. Echo the id back exactly as received, preserving its type.",
  },
  {
    id: "lifecycle-version-negotiate",
    name: "Handles unknown protocol version",
    category: "lifecycle",
    required: false,
    specRef: "basic/lifecycle#version-negotiation",
    description:
      "Sends an initialize request with a future protocol version (\"2099-01-01\") and verifies the server either negotiates down to a version it supports or returns an error. A version offered back is judged on its own (echoing 2099-01-01 fails). A JSON-RPC error counts as the rejection only when the initialize handshake -- the same request with a known version and the same headers -- was served or drew a different status: a server that rejects every initialize proves nothing by rejecting this one (an HTTP error status without a JSON-RPC error body fails too, as no protocolVersion or error). Next to such a handshake, a 403 without a Bearer challenge is the server's, whatever its message says. It must also be the server's own answer: a 401 or an auth-gate 403, or a 429, fails as not evaluable (a 429 is first resent once after Retry-After, capped at 2 s). A 5xx fails as the server failing on the request, unless it carries the server's own -32600 or -32602: that passes, with a warning that a rejected request should get a 4xx. A probe that gets no answer is not a rejection. A timeout, a connection that was never established, or a stdio server already gone fails as 'server unreachable'. Over stdio the probe is always a second initialize on the live session, so a server that exits on it fails as having died on a second initialize -- the details do not blame the version, which it may negotiate correctly on a first initialize -- and is restarted with a fresh handshake for the tests after it (a warning names the check). An HTTP connection closed without an answer passes as the rejection only next to the served handshake: a drop leaves the server running, where a stdio exit takes it down. Anything else (bytes that are not an HTTP response) fails as no usable response, and a caller's abort is rethrown.",
    recommendation:
      "When the client requests an unsupported protocol version, respond with the closest version your server supports. Do not blindly accept unknown versions.",
  },
  {
    id: "lifecycle-reinit-reject",
    name: "Rejects second initialize request",
    category: "lifecycle",
    required: false,
    specRef: "basic/lifecycle#initialization",
    description:
      "Sends a second initialize request within the same session. Per spec, the client MUST NOT send initialize more than once. The server's own rejection passes: a JSON-RPC error, or another HTTP 4xx. A 429 is resent once after Retry-After, capped at 2 s, and the second answer decides. It fails as not evaluable when the first initialize was not served (the second is then no duplicate), or when something in front of the server answered in its place: a 401 or an auth-gate 403, or a 429 on the resend as well. Any other 403 is the server's, whatever its message names (Host/Origin validation included): the handshake, sent with the same Host and Origin, was served (lifecycle-version-negotiate reads the same 403 the same way). A 5xx fails as the server failing on the request rather than rejecting the duplicate, unless it carries the server's own -32600 (Invalid Request): that passes, with a warning that a rejected request should get a 4xx. A 2xx without a JSON-RPC error fails as accepting the duplicate, and a 3xx fails as neither a rejection nor a served duplicate. A connection closed without an answer passes as a rejection only next to the served handshake; a timeout or a connection never established fails as 'server unreachable', and a caller's abort is rethrown.",
    recommendation:
      "Track initialization state per session. Reject duplicate initialize requests with a JSON-RPC error or HTTP 4xx. Do not reset session state on re-initialization.",
  },
  {
    id: "lifecycle-logging",
    name: "logging/setLevel accepted",
    category: "lifecycle",
    required: false,
    specRef: "server/utilities#logging",
    description:
      "If the server declares logging capability, tests that logging/setLevel method is accepted with a valid log level.",
    recommendation:
      'If you declare logging in capabilities, implement the "logging/setLevel" handler. Accept standard log levels: debug, info, notice, warning, error, critical, alert, emergency.',
  },
  {
    id: "lifecycle-completions",
    name: "completion/complete accepted",
    category: "lifecycle",
    required: false,
    specRef: "server/utilities#completion",
    description:
      "If the server declares completions capability, tests that the completion/complete method is accepted.",
    recommendation:
      'If you declare completions in capabilities, implement the "completion/complete" handler. Return a completion object with a values array, even if empty.',
  },

  {
    id: "lifecycle-cancellation",
    name: "Handles cancellation notifications",
    category: "lifecycle",
    required: false,
    specRef: "basic/utilities#cancellation",
    description:
      "Tests that the server accepts notifications/cancelled without error. Servers should gracefully handle cancellation of unknown or completed requests.",
    recommendation:
      "Accept notifications/cancelled and stop any in-progress work for the referenced requestId. If the request is unknown or already complete, silently ignore the cancellation.",
  },

  {
    id: "lifecycle-progress",
    name: "Handles progress notifications gracefully",
    category: "lifecycle",
    required: false,
    specRef: "basic/utilities#progress",
    description:
      "Sends a notifications/progress to the server and verifies it does not error. Note: per spec, progress flows from server to client during long-running requests. This test validates the server handles unexpected notifications gracefully.",
    recommendation:
      "Accept unknown notifications without returning an error. The server should not crash or return a non-2xx status for notifications it does not recognize.",
  },

  {
    id: "lifecycle-list-changed",
    name: "Accepts listChanged notifications",
    category: "lifecycle",
    required: false,
    specRef: "basic/lifecycle#capability-negotiation",
    description:
      "Sends notifications/tools/list_changed, notifications/resources/list_changed, and notifications/prompts/list_changed for declared capabilities and verifies the server accepts them.",
    recommendation:
      "Accept listChanged notifications gracefully. When received, re-fetch the relevant list to detect changes. These notifications signal that the client's cached list may be stale.",
  },
  {
    id: "lifecycle-progress-token",
    name: "Supports progress tokens in requests",
    category: "lifecycle",
    required: false,
    specRef: "basic/utilities#progress",
    description:
      "Calls a tool with _meta.progressToken set and reads every message on the response (every SSE event). The tool is the first listed without required arguments, preferring one whose name or description mentions progress, else the first listed tool (the 2026-07-28 check's choice). Progress is optional: a receiver MAY send no notifications. But every notifications/progress that does arrive MUST carry the request's token and a progress number that increases with each notification, as the 2026-07-28 check judges it: a foreign token, a notification without params, a non-number or a value that does not increase fails, whatever the call's own answer. With no notification, a served call passes, and so does a 2xx with no JSON-RPC response on it. A server error on the call -- a JSON-RPC error, or an HTTP status >= 400 other than a 429, a 401 or an auth-gate 403 -- is blamed on the token only once it is reproduced: the same call without the token, sent right after with the same headers, is served, and the call carrying the token, resent after that, fails again (a JSON-RPC error or such a status). It then fails, since basic/utilities#progress lets a receiver ignore the token, not fail the request. A resent call that is served passes (a tool whose first call fails whatever it carries, such as a cold backend), and progress on it is judged as on the first; any other outcome is an observation, not a skip, and passes. A tools/call that gets no answer measures nothing: it passes, recorded as a skip. A caller's abort is rethrown.",
    recommendation:
      "When a request includes _meta.progressToken, send notifications/progress events via SSE to report progress. Include progressToken (the request's own token, in every notification), progress (current, increasing with each notification), and optionally total fields. A server that does not report progress should ignore the token, never fail the request because of it.",
  },
  {
    id: "lifecycle-sampling-capability",
    name: "Sampling capability shape",
    category: "lifecycle",
    required: false,
    specRef: "client/sampling",
    description:
      "If the server's initialize response or serverInfo implies it uses client-side sampling (sampling/createMessage), verify the capability declaration shape. Currently this is an advisory shape check — actually exercising the server→client flow requires a client-side sampling handler and is out of scope.",
    recommendation:
      "Sampling is a client capability (the client provides LLM access to the server). Servers don't declare sampling in their own capabilities; they just call sampling/createMessage against clients that advertise it. No server-side action required.",
    parallelSafe: true,
  },
  {
    id: "lifecycle-roots-capability",
    name: "Roots capability shape",
    category: "lifecycle",
    required: false,
    specRef: "client/roots",
    description:
      "Roots (filesystem root paths) is a client capability. This test verifies that if a server sends roots/list requests, it handles gracefully when the client doesn't declare the roots capability (i.e., doesn't crash).",
    recommendation:
      "Before calling roots/list, check if the initialized client capabilities include 'roots'. If not, skip the call — the client can't respond. Never assume roots is available; it's opt-in on the client side.",
    parallelSafe: true,
  },
  {
    id: "lifecycle-elicitation-capability",
    name: "Elicitation capability shape",
    category: "lifecycle",
    required: false,
    specRef: "client/elicitation",
    description:
      "Elicitation (asking the user for structured input mid-operation) is a client capability added in 2025-11-25. This test verifies servers that use elicitation/create handle the case where clients don't support it.",
    recommendation:
      "Before calling elicitation/create, check the initialized client capabilities. If elicitation is absent, fall back to a safer default (ask once up-front via tool parameters, or fail cleanly with a clear error).",
    parallelSafe: true,
  },
  {
    id: "lifecycle-meta-tolerance",
    name: "Tolerates _meta field on requests",
    category: "lifecycle",
    required: false,
    specRef: "basic/utilities#_meta",
    description:
      "Sends a ping with params._meta = { extra: 'value' } and verifies the server doesn't error. The 2025-11-25 spec allows arbitrary _meta on any request; servers should ignore unknown _meta fields gracefully.",
    recommendation:
      "Treat the _meta field as opaque — pass it through your request validator, but do not reject requests for unknown _meta keys. The MCP spec reserves _meta for protocol/transport metadata and forward-compat extensibility.",
    parallelSafe: true,
  },

  // ── Tools (4 tests) ──────────────────────────────────────────────
  {
    id: "tools-list",
    name: "tools/list returns valid response",
    category: "tools",
    required: false,
    specRef: "server/tools#listing-tools",
    description:
      "Calls tools/list and validates it returns an array of tool definitions. Dynamically required at runtime if the server declares tools capability.",
    recommendation:
      "Implement the tools/list handler to return { tools: [...] } with an array of tool definition objects. Each tool needs at least a name and inputSchema.",
  },
  {
    id: "tools-call",
    name: "tools/call responds correctly",
    category: "tools",
    required: false,
    specRef: "server/tools#calling-tools",
    description:
      "Calls the first tool with empty arguments and verifies the response format. Accepts both successful results and InvalidParams errors.",
    recommendation:
      "Ensure tools/call returns { content: [...] } with an array of content objects, each having a type field. Return isError: true for tool execution errors.",
  },
  {
    id: "tools-pagination",
    name: "tools/list supports pagination",
    category: "tools",
    required: false,
    specRef: "server/tools#listing-tools",
    description:
      "Tests cursor-based pagination on tools/list. Validates nextCursor is a string if present and that fetching the next page returns a valid response.",
    recommendation:
      "If your server has many tools, include a nextCursor string in the response. Ensure passing this cursor back in a subsequent request returns the next page.",
  },
  {
    id: "tools-content-types",
    name: "Tool content items have valid types",
    category: "tools",
    required: false,
    specRef: "server/tools#calling-tools",
    description:
      "Validates that content items returned by tools/call have a recognized type field (text, image, audio, resource, resource_link). A tool answering with an empty content array, or with an error, leaves nothing to validate; that pass is recorded as a skip. A malformed answer (content that is not an array, or no result) is not a skip: it passes here unflagged, and tools-call fails it.",
    recommendation:
      'Every content item returned by tools/call must have a type field set to one of: "text", "image", "audio", "resource", or "resource_link". Check for typos or missing type fields.',
  },

  // ── Resources (5 tests) ──────────────────────────────────────────
  {
    id: "resources-list",
    name: "resources/list returns valid response",
    category: "resources",
    required: false,
    specRef: "server/resources#listing-resources",
    description:
      "Calls resources/list and validates it returns an array. Dynamically required at runtime if the server declares resources capability.",
    recommendation:
      "Implement resources/list to return { resources: [...] } with an array of resource objects. Each resource needs at least a uri and name.",
  },
  {
    id: "resources-read",
    name: "resources/read returns content",
    category: "resources",
    required: false,
    specRef: "server/resources#reading-resources",
    description:
      "Reads the first resource and validates the response contains a contents array with proper uri and text/blob fields.",
    recommendation:
      "Implement resources/read to return { contents: [...] } where each item has a uri and either a text or blob field. Ensure the uri matches the requested resource.",
  },
  {
    id: "resources-templates",
    name: "resources/templates/list returns valid response",
    category: "resources",
    required: false,
    specRef: "server/resources#resource-templates",
    description:
      "Tests the resource templates endpoint. Accepts Method not found (-32601) since templates are optional.",
    recommendation:
      "If your server supports resource templates, implement resources/templates/list returning { resourceTemplates: [...] }. Otherwise, return error code -32601.",
  },
  {
    id: "resources-pagination",
    name: "resources/list supports pagination",
    category: "resources",
    required: false,
    specRef: "server/resources#listing-resources",
    description:
      "Tests cursor-based pagination on resources/list. Validates nextCursor is a string if present and that fetching the next page works.",
    recommendation:
      "If you return nextCursor in resources/list, ensure it is a string and that passing it back as cursor in the next request returns valid results.",
  },
  {
    id: "resources-subscribe",
    name: "Resource subscribe/unsubscribe",
    category: "resources",
    required: false,
    specRef: "server/resources#subscriptions",
    description:
      "If the server declares resources.subscribe capability, tests that resources/subscribe and resources/unsubscribe methods are accepted.",
    recommendation:
      "If you declare resources.subscribe capability, implement both resources/subscribe and resources/unsubscribe handlers. Both should accept a uri parameter.",
  },

  // ── Prompts (3 tests) ────────────────────────────────────────────
  {
    id: "prompts-list",
    name: "prompts/list returns valid response",
    category: "prompts",
    required: false,
    specRef: "server/prompts#listing-prompts",
    description:
      "Calls prompts/list and validates it returns an array. Dynamically required at runtime if the server declares prompts capability.",
    recommendation:
      "Implement prompts/list to return { prompts: [...] } with an array of prompt objects. Each prompt needs at least a name field.",
  },
  {
    id: "prompts-get",
    name: "prompts/get returns valid messages",
    category: "prompts",
    required: false,
    specRef: "server/prompts#getting-a-prompt",
    description:
      "Gets the first prompt and validates the response contains a messages array with proper role and content fields.",
    recommendation:
      'Implement prompts/get to return { messages: [...] } where each message has a role ("user" or "assistant") and a content field.',
  },
  {
    id: "prompts-pagination",
    name: "prompts/list supports pagination",
    category: "prompts",
    required: false,
    specRef: "server/prompts#listing-prompts",
    description:
      "Tests cursor-based pagination on prompts/list. Validates nextCursor is a string if present and that fetching the next page works.",
    recommendation:
      "If you return nextCursor in prompts/list, ensure it is a string and that passing it back as cursor in the next request returns valid results.",
  },

  // ── Error Handling (10 tests) ────────────────────────────────────
  {
    id: "error-unknown-method",
    name: "Returns JSON-RPC error for unknown method",
    category: "errors",
    required: true,
    specRef: "basic",
    description:
      "Sends an unknown method and verifies the server returns a JSON-RPC error. The spec requires error code -32601 (Method not found). The error counts only when the initialize handshake was served or drew a different status: a server that rejects everything proves nothing by rejecting an unknown method too. It must also be the server's own answer: a 401 or an auth-gate 403, or a 429, fails as not evaluable, whether or not it carries a JSON-RPC error body (a 429 is first resent once after Retry-After, capped at 2 s). A 5xx fails as the server failing on the request, unless it carries the server's own -32601: that passes, with a warning that a rejected request should get a 4xx. Any other 403 counts only when a ping with the same headers (resent once after Retry-After when it draws a 429) was served or drew a status the server itself chose (a 2xx, or a 4xx other than 401, 403 or 429), whatever its message says; that ping is sent only in this case. When that ping drew the same 403, a 401, a 429 again, a 5xx, a redirect or no answer, the check fails as not evaluable, quoting the message when the ping drew the same 403 and the message names Host/Origin validation. A gateway that lets initialize through and refuses every other method never showed the server the unknown method.",
    recommendation:
      "Return a JSON-RPC error with code -32601 (Method not found) for any unrecognized method name. Do not silently ignore unknown methods.",
  },
  {
    id: "error-method-code",
    name: "Uses correct JSON-RPC error code for unknown method",
    category: "errors",
    required: false,
    specRef: "basic",
    description:
      "Checks the error code is specifically -32601 (Method not found) for unknown methods, as required by JSON-RPC 2.0.",
    recommendation:
      "Use exactly error code -32601 for unknown methods. Do not use generic error codes like -32000. This is required by JSON-RPC 2.0.",
  },
  {
    id: "error-invalid-jsonrpc",
    name: "Handles malformed JSON-RPC",
    category: "errors",
    required: true,
    specRef: "basic",
    description:
      "Sends a malformed JSON-RPC message (missing required fields), with the headers every request of the session carries, and verifies the server returns an error or 4xx status. A 429 is first resent once after Retry-After, capped at 2 s, and the second answer decides. A JSON-RPC error or a 4xx counts only as the server's own rejection, read the way error-unknown-method reads its answer. It fails as not evaluable when the initialize handshake was not served and drew the same status (or no answer), when a 401 or an auth-gate 403, or a 429 on the resend as well, answered in the server's place, whether or not it carries a JSON-RPC error body (a gateway's -32001), or on any other 403 when a well-formed ping sent with the same headers (resent once after Retry-After when it draws a 429) drew the same 403, a 401, a 429 again, a 5xx, a redirect or no answer (quoting the message when the ping drew the same 403 and the message names Host/Origin validation); that ping is sent only in this case, and a 403 next to a ping that was served or drew a status the server itself chose (a 2xx, or a 4xx other than 401, 403 or 429) is the server's. A 5xx fails as the server failing on the request rather than rejecting it, unless it carries the server's own -32600 (Invalid Request): that passes, with a warning that a rejected request should get a 4xx. A caller's abort is rethrown.",
    recommendation:
      "Validate incoming JSON-RPC messages for required fields (jsonrpc, method). Return error code -32600 (Invalid Request) or HTTP 400 for malformed messages.",
  },
  {
    id: "error-invalid-json",
    name: "Handles invalid JSON body",
    category: "errors",
    required: false,
    specRef: "basic",
    description:
      "Sends invalid JSON and verifies the server returns a parse error (-32700) or 4xx status code. The answer is read as error-invalid-jsonrpc reads its probe: a 429 is resent once, and a rejection the unserved initialize handshake drew too (same status, or no answer), a 401 or an auth-gate 403, a 429 on the resend as well, or any other 403 when a well-formed ping sent with the same headers (resent once on a 429) drew the same 403, a 401, a 429 again, a 5xx, a redirect or no answer fails as not evaluable. A 5xx fails as the server failing on the request rather than rejecting it, unless it carries the server's own -32700 (Parse error): that passes, with a warning that a rejected request should get a 4xx. A caller's abort is rethrown.",
    recommendation:
      "Catch JSON parse errors and return error code -32700 (Parse error) with a descriptive message. Do not return 500 for malformed input.",
  },
  {
    id: "error-missing-params",
    name: "Returns error for tools/call without name",
    category: "errors",
    required: false,
    specRef: "server/tools#error-handling",
    description:
      "Calls tools/call with an empty params object (missing required name field) and verifies an error is returned (a JSON-RPC error, or a result flagged isError). A 429 is first resent once after Retry-After, capped at 2 s, and the second answer decides. A JSON-RPC error counts only as the server's own, read the way error-unknown-method reads its answer: one the initialize handshake drew too when it was not served (the same status, or no answer), a 401 or an auth-gate 403, or a 429 on the resend as well, whatever JSON-RPC error its body carries, or any other 403 when the same request for ping (resent once on a 429) drew the same 403, a 401, a 429 again, a 5xx, a redirect or no answer (that ping is sent only in this case), fails as not evaluable. A 5xx fails as the server failing on the request rather than rejecting it, unless it carries the server's own -32602 (Invalid params): that passes, with a warning that a rejected request should get a 4xx.",
    recommendation:
      "Validate tools/call params and return error code -32602 (Invalid params) when the required name field is missing.",
  },
  {
    id: "error-parse-code",
    name: "Returns -32700 for invalid JSON",
    category: "errors",
    required: false,
    specRef: "basic",
    description:
      "Checks that the server returns the specific JSON-RPC error code -32700 (Parse error) when receiving invalid JSON, as required by the JSON-RPC 2.0 specification.",
    recommendation:
      "Return exactly error code -32700 for JSON parse failures. Most JSON-RPC frameworks handle this automatically — check yours does not override the code.",
  },
  {
    id: "error-invalid-request-code",
    name: "Returns -32600 for invalid request",
    category: "errors",
    required: false,
    specRef: "basic",
    description:
      "Checks that the server returns the specific JSON-RPC error code -32600 (Invalid Request) for malformed JSON-RPC messages missing required fields.",
    recommendation:
      "Return exactly error code -32600 for structurally invalid JSON-RPC messages (e.g., missing method field). Check your JSON-RPC middleware configuration.",
  },
  {
    id: "tools-call-unknown",
    name: "Returns error for unknown tool name",
    category: "errors",
    required: false,
    specRef: "server/tools#error-handling",
    description: "Calls tools/call with a nonexistent tool name and verifies the server returns an error response.",
    recommendation:
      "Return a JSON-RPC error or set isError: true when tools/call receives an unrecognized tool name. Do not return an empty success response.",
  },

  {
    id: "error-capability-gated",
    name: "Rejects methods for undeclared capabilities",
    category: "errors",
    required: false,
    specRef: "basic/lifecycle#capability-negotiation",
    description:
      "Calls list methods (tools/list, resources/list, prompts/list) for capabilities the server did NOT declare, and verifies the server returns an error instead of success. A server that declares all three has no undeclared method to probe; that pass is recorded as a skip. When the initialize handshake was not served, the suite never saw a capability declaration: every list method is still probed and its answer recorded in the details, but the test fails as not evaluable whatever the answers, as the 2026-07-28 check withholds its verdict. Next to a served handshake a success fails, and a rejection counts only as the server's own, read the way error-unknown-method reads its answer: each method's 429 is resent once after Retry-After (capped at 2 s), and a 401 or an auth-gate 403, a 429 on the resend as well, or any other 403 when the same request for ping (asked at most once for the three methods, and resent once on a 429) drew the same 403, a 401, a 429 again, a 5xx, a redirect or no answer fails as not evaluable. A 5xx fails as the server failing on the request rather than rejecting the method, unless it carries the server's own -32601: that passes, with a warning that a rejected request should get a 4xx.",
    recommendation:
      "Return a JSON-RPC error (e.g., -32601 Method not found) for methods associated with capabilities not declared in your initialize response.",
  },
  {
    id: "error-invalid-cursor",
    name: "Handles invalid pagination cursor gracefully",
    category: "errors",
    required: false,
    specRef: "basic",
    description:
      "Sends a garbage pagination cursor to a list method and verifies the server handles it gracefully — either returning an error or ignoring the invalid cursor.",
    recommendation:
      "Validate pagination cursors before use. Return a JSON-RPC error for unrecognized cursors, or treat invalid cursors as a request for the first page.",
  },

  // ── Schema Validation (6 tests) ──────────────────────────────────
  {
    id: "tools-schema",
    name: "All tools have name and inputSchema",
    category: "schema",
    required: false,
    specRef: "server/tools#data-types",
    description:
      "Validates every tool has a valid name (1-128 chars, alphanumeric/underscore/hyphen/dot) and a required inputSchema of type \"object\". An empty tool list leaves nothing to validate ('No tools to validate', recorded as a skip).",
    recommendation:
      'Ensure every tool has a name (1-128 chars, [A-Za-z0-9_.-]) and an inputSchema with type: "object". Add descriptions to tools for better AI assistant integration.',
  },
  {
    id: "tools-annotations",
    name: "Tool annotations are valid",
    category: "schema",
    required: false,
    specRef: "server/tools#annotations",
    description:
      "Validates tool annotation fields if present: readOnlyHint, destructiveHint, idempotentHint, openWorldHint should be booleans. An empty tool list leaves nothing to validate ('No tools to validate', recorded as a skip).",
    recommendation:
      "If you include annotations on tools, ensure readOnlyHint, destructiveHint, idempotentHint, and openWorldHint are booleans. Note: title belongs on the Tool object, not inside annotations.",
  },
  {
    id: "tools-title-field",
    name: "Tools include title field",
    category: "schema",
    required: false,
    specRef: "server/tools#data-types",
    description:
      "Checks if tools include the optional title field for human-readable display names. Added in spec version 2025-11-25. An empty tool list leaves nothing to validate ('No tools to validate', recorded as a skip).",
    recommendation:
      "Add a title field (human-readable string) to each tool definition. This helps MCP clients display your tools in a user-friendly way.",
  },
  {
    id: "tools-output-schema",
    name: "Tools with outputSchema are valid",
    category: "schema",
    required: false,
    specRef: "server/tools#structured-content",
    description:
      "If tools declare an outputSchema, validates it is a valid JSON Schema object with type \"object\". Used for structured output validation. An empty tool list leaves nothing to validate ('No tools to validate', recorded as a skip).",
    recommendation:
      'If you declare outputSchema on a tool, ensure it is a valid JSON Schema object with type: "object". Remove outputSchema if you do not need structured output.',
  },
  {
    id: "prompts-schema",
    name: "Prompts have name field",
    category: "schema",
    required: false,
    specRef: "server/prompts#data-types",
    description:
      "Validates every prompt has a name and that any arguments array contains items with name fields. An empty prompt list leaves nothing to validate ('No prompts to validate', recorded as a skip).",
    recommendation:
      "Ensure every prompt has a name field. If the prompt has arguments, each argument object must include a name field.",
  },
  {
    id: "resources-schema",
    name: "Resources have uri and name",
    category: "schema",
    required: false,
    specRef: "server/resources#data-types",
    description:
      "Validates every resource has a valid URI (parseable as a URL) and a name field. An empty resource list leaves nothing to validate ('No resources to validate', recorded as a skip).",
    recommendation:
      "Ensure every resource has a valid, parseable URI and a name field. Add description and mimeType for better client integration.",
  },

  // ── Security: Auth & Transport (10 tests) ────────────────────────
  {
    id: "security-auth-required",
    name: "Rejects unauthenticated requests",
    category: "security",
    required: false,
    specRef: "basic/authorization",
    description:
      "Sends a ping without an Authorization header (with --auth, the configured header removed) and expects HTTP 401. A 401, or a 403 carrying a WWW-Authenticate: Bearer challenge, passes. A bare 403 (no Bearer challenge) is not attributed to authentication on its own: streamable-http requires a 403 for an invalid Origin, the SDK's Host validation answers a tunnel or proxy hostname with one, and gateways send them. With --auth it passes only when the same ping carrying the credential is served (resent once after Retry-After when it draws a 429; the details note that basic/authorization expects 401), and otherwise fails as not evaluable. Without --auth the unauthenticated preflight stands in for the probe; when the preflight got no HTTP answer, a ping is sent after the handshake instead. It fails as not requiring auth when initialize was served without any credential, whatever the probe drew, or when the probe itself was served (a JSON-RPC result on a 2xx), whatever else was refused (a server that requires authorization rejects every unauthenticated request, initialize included). Otherwise a 401 or Bearer 403 on the probe passes (the details suggest --auth to run the authenticated suite and the remaining auth tests). When the probe drew neither -- a bare 403, or an answer that is no authentication refusal at all, such as the -32601 a server gives behind a gateway that lets server/discover through -- a 401 or Bearer 403 on the unauthenticated initialize passes; failing that, a bare 403 fails as not evaluable. With or without --auth, an answer that is neither a 401/403 nor a served request fails worded for what it was: another 4xx as refused but not as an authentication refusal (a wrong path, a gateway or a rate limiter), a 5xx as the server failing on the request, a 3xx as a redirect, a 2xx carrying a JSON-RPC error as no HTTP authentication refusal, and a 2xx carrying neither result nor error as neither served nor refused. Only a served request is reported as accepted. The not-evaluable details advise allowing the hostname the server was reached through when the refusal's message names Host or Origin validation (the SDK's 'Invalid Host: ...'), or when the ping carrying the credential was refused with 403 too, and name --auth only when no credential was configured. A request with no HTTP answer fails as 'server unreachable': a timeout or a connection never established always, and a connection closed without an answer unless --auth was given and the same ping with the credential was served, which passes as a rejection. When --auth is given and a bare 403 is not evaluable, security-www-authenticate, security-auth-malformed and security-session-not-auth skip as not evaluable ('Skipped: HTTP 403 without a Bearer challenge, not attributable to authentication (see security-auth-required)', the 2026-07-28 wording) instead of crediting the same 403, security-token-in-uri skips a 401/403 on its probe the same way (a query-string token the server accepts still fails), and security-oauth-metadata skips when every well-known metadata location and the legacy authorization-server document drew that 403 too -- they read the same two pings, so the skip holds when --only / --skip leaves security-auth-required out of the run.",
    recommendation:
      "Implement authentication on your MCP endpoint. Return HTTP 401 Unauthorized for requests without valid credentials. Use OAuth 2.1 or Bearer tokens as recommended by the MCP spec.",
  },
  {
    id: "security-www-authenticate",
    name: "401 responses include WWW-Authenticate header",
    category: "security",
    required: false,
    specRef: "basic/authorization",
    description:
      "When the server returns HTTP 401, checks for a WWW-Authenticate header indicating the required authentication scheme. Per HTTP spec (RFC 9110), servers SHOULD include this header. A 403 carrying a Bearer challenge is read the same way (the details then name the HTTP 403); a bare 403 passes as not applicable (recorded as a skip). Any other answer, and a connection closed without an answer that counts as the rejection, leaves no challenge to check, so the pass is recorded as a skip. A probe that gets no HTTP answer fails as 'server unreachable' -- a timeout or a connection that was never established always, and a connection the server closes without answering unless the same request carrying the credential was served, which counts as the rejection it looks for. Skipped without --auth ('Skipped: no --auth provided'), and skipped as not evaluable ('Skipped: HTTP 403 without a Bearer challenge, not attributable to authentication (see security-auth-required)') when the unauthenticated ping draws a bare 403 and the same ping carrying the credential is not served either (security-auth-required's not-evaluable case), whether or not security-auth-required is in the run.",
    recommendation:
      "Include a WWW-Authenticate header in 401 responses to indicate the required auth scheme (e.g., 'WWW-Authenticate: Bearer realm=\"mcp\"').",
  },
  {
    id: "security-auth-malformed",
    name: "Rejects malformed auth credentials",
    category: "security",
    required: false,
    specRef: "basic/authorization",
    description:
      "Sends a request with a malformed Authorization header (garbage value) and verifies the server returns HTTP 401 or 403. Servers must validate auth tokens, not just check for presence. A status that is neither 401/403 nor a served request fails worded for what it was (another 4xx, a 5xx, a 3xx, a 2xx with no JSON-RPC result); 'server accepted ...' is kept for a served request. A probe that gets no HTTP answer fails as 'server unreachable' -- a timeout or a connection that was never established always, and a connection the server closes without answering unless the same request carrying the credential was served, which counts as the rejection it looks for. Skipped without --auth ('Skipped: no --auth provided'), and skipped as not evaluable ('Skipped: HTTP 403 without a Bearer challenge, not attributable to authentication (see security-auth-required)') when the unauthenticated ping draws a bare 403 and the same ping carrying the credential is not served either (security-auth-required's not-evaluable case), whether or not security-auth-required is in the run. It is also skipped when the same ping carrying the configured credential draws 401: the server refused the run's own credential, so a refusal of the malformed one cannot tell token validation from a server that refuses everything ('Skipped: the configured credential was refused too (the credentialed ping drew HTTP 401), so rejecting invalid tokens cannot be told from rejecting everything (check the configured credential)'). Only a pass becomes that skip: a malformed credential the server accepts, or any other failing answer, still fails.",
    recommendation:
      "Validate the format and signature of Authorization header values. Reject malformed or invalid tokens with HTTP 401. Do not treat any non-empty Authorization header as valid.",
  },
  {
    id: "security-tls-required",
    name: "Enforces HTTPS/TLS",
    category: "security",
    required: false,
    specRef: "basic/authorization",
    description:
      "If the server URL uses HTTPS, attempts an HTTP (plaintext) connection and verifies it is rejected or redirected. Production MCP servers should not accept plaintext connections.",
    recommendation:
      "Configure your server to reject HTTP connections or redirect to HTTPS. Use TLS 1.2 or higher. The MCP spec requires HTTPS for production deployments.",
  },
  {
    id: "security-session-entropy",
    name: "Session IDs are high-entropy",
    category: "security",
    required: false,
    specRef: "basic/transports#streamable-http",
    description:
      "Analyzes the MCP-Session-Id returned by the server. Session IDs should be cryptographically random and not sequential or predictable.",
    recommendation:
      "Generate session IDs using a cryptographically secure random source (e.g., crypto.randomUUID()). Session IDs should be at least 128 bits of entropy. Do not use sequential counters or timestamps.",
  },
  {
    id: "security-session-not-auth",
    name: "Session ID does not bypass auth",
    category: "security",
    required: false,
    specRef: "basic/transports#streamable-http",
    description:
      "Verifies that presenting a valid MCP-Session-Id without an Authorization header is still rejected. Per spec, servers MUST NOT use sessions for authentication. A status that is neither 401/403 nor a served request fails worded for what it was (another 4xx, a 5xx, a 3xx, a 2xx with no JSON-RPC result); 'server accepted ...' is kept for a served request. A probe that gets no HTTP answer fails as 'server unreachable' -- a timeout or a connection that was never established always, and a connection the server closes without answering unless the same request carrying the credential was served, which counts as the rejection it looks for. Skipped without --auth ('Skipped: no --auth provided'), skipped when the server issues no session ID, and skipped as not evaluable ('Skipped: HTTP 403 without a Bearer challenge, not attributable to authentication (see security-auth-required)') when the unauthenticated ping draws a bare 403 and the same ping carrying the credential is not served either (security-auth-required's not-evaluable case), whether or not security-auth-required is in the run.",
    recommendation:
      "Always validate the Authorization header independently of the MCP-Session-Id. Sessions are for request routing, not authentication. Reject requests that lack valid auth even if they have a valid session ID.",
  },
  {
    id: "security-oauth-metadata",
    name: "Protected Resource Metadata endpoint exists",
    category: "security",
    required: false,
    specRef: "basic/authorization",
    description:
      "Checks that the server publishes Protected Resource Metadata (RFC 9728) with a resource identifier and a non-empty authorization_servers array, located the way basic/authorization makes clients locate it, as the 2026-07-28 check does. Skipped without --auth ('Skipped: no --auth provided'). The WWW-Authenticate challenge is read from the unauthenticated ping security-auth-required sends (shared with it, so a run with both sends it once), when that ping drew a 401 or a 403 carrying a Bearer challenge. When the challenge carries resource_metadata, that URL, and only it, is fetched: clients MUST use it, so one that is not an absolute http(s) URL, or that is unreachable, answers non-200, or returns a document that is not JSON or lacks either field, fails outright, and the details name any valid document at a well-known location the challenge could point at. Without a challenge URL, /.well-known/oauth-protected-resource followed by the endpoint path is tried, then /.well-known/oauth-protected-resource, and the first valid document passes; a malformed one fails when no location has a valid one, and with none found a legacy /.well-known/oauth-authorization-server document passes with a warning. It fails when no location answers, or when no valid document and no legacy document is found. A document whose resource is not the MCP endpoint in canonical form passes with a warning (RFC 9728 section 3.3). When the unauthenticated ping drew a bare 403 security-auth-required could not attribute to authentication (the same ping carrying the credential was not served either), and every well-known location and the legacy document drew that same status, the lookup met the same guard rather than a missing document: it is then skipped ('Skipped: HTTP 403 without a Bearer challenge on the endpoint and on every well-known metadata location, not attributable to authentication (see security-auth-required)') instead of failing. An unauthenticated ping that gets no HTTP answer fails as 'server unreachable', except a connection closed without an answer next to the served credentialed handshake, which leaves no challenge and goes on to the well-known locations; a caller's abort is rethrown.",
    recommendation:
      "Publish a Protected Resource Metadata document at /.well-known/oauth-protected-resource followed by your endpoint path, or at /.well-known/oauth-protected-resource on your server's origin. Include 'resource' (your MCP endpoint's canonical URL) and 'authorization_servers' (array of OAuth AS URLs), and point the resource_metadata parameter of your 401's WWW-Authenticate challenge at the document with an absolute URL: once advertised it is the only URL clients try, so it must answer. See RFC 9728.",
  },
  {
    id: "security-token-in-uri",
    name: "Rejects auth tokens in query string",
    category: "security",
    required: false,
    specRef: "basic/authorization",
    description:
      "Sends a request with the auth token in the URL query string instead of the Authorization header. The MCP spec forbids transmitting credentials in URIs. With --auth and a token to extract, the probe is always sent, and a 2xx fails as accepting the token whatever else the run found; a 401/403 or any other status passes as not accepted. A probe that gets no HTTP answer fails as 'server unreachable' -- a timeout or a connection that was never established always, and a connection the server closes without answering unless the same request carrying the credential was served, which counts as the rejection it looks for. Skipped without --auth ('Skipped: no --auth provided'), and when no token can be extracted from the auth header. A 401/403 on the probe is skipped as not evaluable ('Skipped: HTTP 403 without a Bearer challenge, not attributable to authentication (see security-auth-required)') when the unauthenticated ping draws a bare 403 and the same ping carrying the credential is not served either (security-auth-required's not-evaluable case), whether or not security-auth-required is in the run. Any not-accepted pass is skipped when the same ping carrying the configured credential in the header draws 401 ('Skipped: the configured credential was refused too (the credentialed ping drew HTTP 401), so refusing it in the query string proves nothing (check the configured credential)'): the token was never going to be accepted anywhere.",
    recommendation:
      "Never accept authentication tokens from URL query parameters. Tokens in URIs are logged by proxies, appear in browser history, and leak via the Referer header. Only accept tokens in the Authorization header.",
  },
  {
    id: "security-cors-headers",
    name: "CORS headers are restrictive",
    category: "security",
    required: false,
    specRef: "basic/transports#streamable-http",
    description:
      "If the server returns CORS headers, verifies that Access-Control-Allow-Origin is not set to wildcard (*). Wildcard CORS on an authenticated API allows cross-origin credential theft. Two probes carry Origin: https://evil.example.com, read the way the 2026-07-28 check reads them: an OPTIONS preflight (capped at 5 s), and a ping, the handshake's request with its headers, sent as a POST with the run's timeout, since MCP does not require a server to handle OPTIONS. Access-Control-Allow-Origin set to * or reflecting the foreign origin on either answer fails, whatever its status (the details note Access-Control-Allow-Credentials); a specific origin, or no CORS headers on either, passes. A probe that gets no HTTP answer has no headers to read, so only when neither probe was answered is there nothing to inspect: a connection the server accepted and closed on both passes as cross-origin requests refused, but only when the initialize handshake was served; a timeout, a connection never established, or any other failure fails as 'server unreachable'. A caller's abort is rethrown.",
    recommendation:
      'Set Access-Control-Allow-Origin to specific trusted origins, not "*". If CORS is not needed (server-to-server only), do not send CORS headers at all.',
  },

  {
    id: "security-origin-validation",
    name: "Validates Origin header on requests",
    category: "security",
    required: false,
    specRef: "basic/transports#streamable-http",
    description:
      "Sends a ping with the handshake's headers plus a suspicious Origin header (https://evil-rebinding-attack.example.com) and verifies the server rejects it. Per spec, servers MUST validate the Origin header to prevent DNS rebinding attacks, answering an invalid one with 403. A 2xx fails. A 429 is a rate limiter answering before the server reads the request: the probe is resent once after Retry-After (capped at 2 s) and a second 429 fails as not evaluable. A 5xx fails as the server failing on the request rather than refusing it. A 401 or 403 passes when initialize -- sent with the same headers and no Origin -- was served or drew a different status; when initialize drew the same status or no answer, that refusal is what an auth gate, a Host guard or a gateway answers every request with, and the check skips as not attributable to the Origin (see security-auth-required). Any other 4xx passes; a redirect fails. A probe that gets no HTTP answer fails as 'server unreachable' -- a timeout or a connection that was never established always, and a connection the server closes without answering unless initialize was served, which counts as the rejection it looks for.",
    recommendation:
      "Validate the Origin header on all incoming requests. Reject requests from untrusted origins with HTTP 403. Maintain an allowlist of permitted origins.",
  },

  // ── Security: Input Validation (6 tests) ─────────────────────────
  {
    id: "security-command-injection",
    name: "Resists command injection in tool params",
    category: "security",
    required: false,
    specRef: "server/tools#calling-tools",
    description:
      "Calls the first listed tool that has a string parameter, in its first string parameter, with OS command injection payloads (e.g., '; cat /etc/passwd', '$(whoami)'). Verifies the server does not execute injected commands. Output that only reflects the payload back (an echo tool) is benign; the check fails on evidence of execution (uid=... id output, /etc/passwd lines, a directory listing). A payload that gets no answer is never counted as rejected. A stdio child that exits on a payload fails the check ('server died on payload ...'), after any execution evidence found on earlier payloads, and the runner restarts it with a fresh handshake, with a warning naming the check, so the checks after it measure the server. On HTTP a connection closed on a payload is followed by a ping: a server gone after it fails as a possible crash, and one still up counts the payload as unanswered, with a warning. A timeout counts as unanswered. A server already gone before a payload (a dead child, a refused connection) fails as 'server unreachable'. A run in which no payload got an answer passes as inconclusive, with a warning, recorded as a skip; with no listed tool that has a string parameter there is nothing to inject into ('No tools with string parameters to test', recorded as a skip).",
    recommendation:
      "Never pass tool argument values directly to shell commands. Use parameterized APIs, execFile() instead of exec(), or allowlists. Sanitize all user-provided input before use in system calls.",
  },
  {
    id: "security-sql-injection",
    name: "Resists SQL injection in tool params",
    category: "security",
    required: false,
    specRef: "server/tools#calling-tools",
    description:
      "Calls the same tool and parameter as security-command-injection with SQL injection payloads (e.g., \"' OR 1=1 --\"). Verifies the server does not return database errors or unexpected data. Output that only reflects the payload is benign; the check fails on a database error message or schema names in the output. A payload that gets no answer is never counted as rejected. A stdio child that exits on a payload fails the check ('server died on payload ...'), after any execution evidence found on earlier payloads, and the runner restarts it with a fresh handshake, with a warning naming the check, so the checks after it measure the server. On HTTP a connection closed on a payload is followed by a ping: a server gone after it fails as a possible crash, and one still up counts the payload as unanswered, with a warning. A timeout counts as unanswered. A server already gone before a payload (a dead child, a refused connection) fails as 'server unreachable'. A run in which no payload got an answer passes as inconclusive, with a warning, recorded as a skip; with no listed tool that has a string parameter there is nothing to inject into ('No tools with string parameters to test', recorded as a skip).",
    recommendation:
      "Use parameterized queries or prepared statements for all database operations. Never concatenate user input into SQL strings. Return generic error messages that do not reveal database structure.",
  },
  {
    id: "security-path-traversal",
    name: "Resists path traversal in tool params",
    category: "security",
    required: false,
    specRef: "server/tools#calling-tools",
    description:
      "Calls the same tool and parameter as security-command-injection with path traversal payloads (e.g., '../../etc/passwd', '..\\\\..\\\\windows\\\\system.ini'). Verifies the server does not expose files outside its intended scope. Output that only reflects the payload is benign; the check fails on sensitive file content (a root passwd entry, boot.ini / system.ini sections). A payload that gets no answer is never counted as rejected. A stdio child that exits on a payload fails the check ('server died on payload ...'), after any execution evidence found on earlier payloads, and the runner restarts it with a fresh handshake, with a warning naming the check, so the checks after it measure the server. On HTTP a connection closed on a payload is followed by a ping: a server gone after it fails as a possible crash, and one still up counts the payload as unanswered, with a warning. A timeout counts as unanswered. A server already gone before a payload (a dead child, a refused connection) fails as 'server unreachable'. A run in which no payload got an answer passes as inconclusive, with a warning, recorded as a skip; with no listed tool that has a string parameter there is nothing to inject into ('No tools with string parameters to test', recorded as a skip).",
    recommendation:
      "Validate and sanitize file paths. Use path.resolve() and verify the result is within the allowed directory. Reject paths containing '..' segments. Use a chroot or sandboxed filesystem for file operations.",
  },
  {
    id: "security-ssrf-internal",
    name: "Resists SSRF to internal networks",
    category: "security",
    required: false,
    specRef: "server/tools#calling-tools",
    description:
      "For the first listed tool with a string parameter whose name suggests a URL (url, uri, endpoint, link, href), submits internal IP addresses (169.254.169.254, 127.0.0.1, 10.0.0.0/8) and cloud metadata endpoints. Verifies the server blocks requests to internal networks. Output that only reflects the URL is benign; the check fails on metadata-service content (ami-, instance-id, hostname, iam, security-credentials). A payload that gets no answer is never counted as rejected. A stdio child that exits on a payload fails the check ('server died on payload ...'), after any execution evidence found on earlier payloads, and the runner restarts it with a fresh handshake, with a warning naming the check, so the checks after it measure the server. On HTTP a connection closed on a payload is followed by a ping: a server gone after it fails as a possible crash, and one still up counts the payload as unanswered, with a warning. A timeout counts as unanswered. A server already gone before a payload (a dead child, a refused connection) fails as 'server unreachable'. A run in which no payload got an answer passes as inconclusive, with a warning, recorded as a skip; with no listed tool that has a URL-named string parameter there is nothing to probe ('No tools with URL parameters found (skipped)').",
    recommendation:
      "Validate and restrict URLs in tool parameters. Block requests to private IP ranges (10.x, 172.16-31.x, 192.168.x, 127.x, 169.254.x), link-local addresses, and cloud metadata endpoints. Use an allowlist of permitted domains.",
  },
  {
    id: "security-oversized-input",
    name: "Handles oversized inputs gracefully",
    category: "security",
    required: false,
    specRef: "server/tools#calling-tools",
    description:
      "Sends a tools/call to the first listed tool ('test' when none was listed) with a 1 MiB string in a 'data' argument, through the transport on HTTP and stdio. On HTTP, 413 passes. A 429 is a rate limiter answering before the server reads the request: the call is resent once after Retry-After (capped at 2 s) and a second 429 fails as not evaluable. A 401, or a 403 that reads as an auth gate, fails as not evaluable. A bare 403 passes when initialize was served with the same headers (a WAF or size rule blocking the body) and otherwise fails as not evaluable. Any other 4xx passes. A JSON-RPC error passes as a rejection; a JSON-RPC result passes as survived, with a warning to enforce a request body limit (413) or maxLength in inputSchema. A 5xx fails as a server error, and a 2xx or 3xx with no JSON-RPC result or error fails. A connection closed or reset on the 1 MB body passes as a connection-level rejection only when a follow-up ping (with the session) is served, is answered by its own id with a JSON-RPC error at a status below 500 (other than 429), or is refused with 401/403; a 429 is retried once after Retry-After, capped at 2 s. Otherwise it fails as a possible crash naming what the ping got -- or as 'server unreachable' when neither the preflight nor initialize was answered in this run. A refused connection fails as 'server unreachable', bytes that are not an HTTP response fail as 'no usable response', and a timeout fails. On stdio a JSON-RPC error passes as a rejection and a result as survived, with the same warning. A child that exits on the call fails as died, and the runner then spawns a fresh instance and redoes the handshake so the tests after it measure the server rather than the crash (a warning naming the check says so, and says when the new instance did not complete initialize, or, for a restart after tools-list read its list, when the new instance's own tools/list, read for security-tool-rug-pull before any tools/call reaches it, was not obtained; the injection checks, security-extra-params, lifecycle-version-negotiate, stdio-unicode and security-tool-rug-pull restart a child that dies on their own request the same way, once for every attempt that kills it, so --retries can restart it again); a child already gone before the call fails as 'server unreachable'. A reply longer than the runner's 1 MiB line buffer passes as survived, with a warning, while the child is still running. A timeout, a frame with no result or error, or any other error fails.",
    recommendation:
      "Implement request body size limits. Return HTTP 413 or JSON-RPC error for oversized payloads. Set explicit maxBodyLength in your HTTP server configuration.",
  },
  {
    id: "security-extra-params",
    name: "Rejects or ignores extra tool params",
    category: "security",
    required: false,
    specRef: "server/tools#calling-tools",
    description:
      "Calls the first tool with unexpected additional parameters (__injected_param__ and a __proto__ pollution payload). A JSON-RPC error (rejected) or a result (ignored) passes. An HTTP 5xx fails as a server error, and an answer with neither a result nor an error fails as malformed. A call that gets no answer is never counted as a rejection: a stdio child that exits on the call fails as died, and the runner restarts it so the tests after it measure the server (a warning says so); an HTTP connection closed on the call fails as a possible crash unless a follow-up ping shows the server is still up, when it passes as inconclusive with a warning; a timeout passes as inconclusive with a warning (both recorded as skips); a server already gone before the call (a child an earlier check killed, a refused connection) fails as 'server unreachable'; anything else fails as 'no usable response'.",
    recommendation:
      "Use JSON Schema validation with additionalProperties: false to reject unexpected parameters, or strip unknown properties before processing. Do not pass unvalidated properties to internal functions.",
  },

  // ── Security: Tool Integrity (4 tests) ───────────────────────────
  {
    id: "security-tool-schema-defined",
    name: "All tools define inputSchema",
    category: "security",
    required: false,
    specRef: "server/tools#data-types",
    description:
      "Verifies all tools have an inputSchema with type 'object'. Tools without schemas cannot have their inputs validated, creating an injection risk. An empty tool list leaves nothing to validate ('No tools to validate', recorded as a skip).",
    recommendation:
      "Define a complete JSON Schema (inputSchema with type: 'object') for every tool. Specify all expected properties, their types, and constraints. This enables input validation and prevents parameter injection.",
  },
  {
    id: "security-tool-rug-pull",
    name: "Tool definitions are stable across calls",
    category: "security",
    required: false,
    specRef: "server/tools#listing-tools",
    description:
      "Calls tools/list twice and compares the results. Tool definitions should not change between calls within the same session, which could indicate a rug-pull attack. The first list is the one cached when the tools tests ran, and the tool count, the names and each tool's description are compared. On stdio, once an earlier check has killed the server and the runner restarted it after that list was read (see security-oversized-input), both lists come from the new process instead, as in the 2026-07-28 check: the tools/list read when it was restarted, before any tools/call reached it, then, after one tools/call with no arguments (to the first tool that requires none, else the first tool), a second one; the details name the check the restart followed. When the new process's list before use was not read (the restart's warning says why), or that tools/call kills it too (it is then restarted again for the checks after), there are no two lists from one process to compare and the test skips with a warning. After a restart before the tools tests ran (lifecycle-version-negotiate's), the cached list already comes from the new process and is compared as usual.",
    recommendation:
      "Ensure tools/list returns consistent results within a session. If tools change dynamically, send a tools/list_changed notification. Never silently alter tool definitions — this is a known MCP attack vector (tool poisoning).",
  },
  {
    id: "security-tool-description-poisoning",
    name: "Tool descriptions free of injection patterns",
    category: "security",
    required: false,
    specRef: "server/tools#data-types",
    description:
      "Scans all tool names, descriptions, and parameter descriptions for prompt injection patterns: 'ignore previous', 'override', 'system prompt', hidden Unicode characters, and Base64-encoded strings. An empty tool list leaves nothing to scan ('No tools to validate', recorded as a skip).",
    recommendation:
      "Review all tool descriptions for prompt injection patterns. Remove any text that attempts to override LLM instructions, references system prompts, or contains hidden characters. Tool descriptions are rendered to LLMs and can be used for prompt injection.",
  },
  {
    id: "security-tool-cross-reference",
    name: "Tools do not reference other tools by name",
    category: "security",
    required: false,
    specRef: "server/tools#data-types",
    description:
      "Checks that tool descriptions do not reference other tool names. Cross-references between tools can be used to manipulate LLM tool selection and create implicit execution chains.",
    recommendation:
      "Avoid referencing other tool names in tool descriptions. Each tool should be self-contained. If tools have dependencies, document them in server instructions, not in individual tool descriptions.",
  },

  // ── Security: Information Disclosure (3 tests) ───────────────────
  {
    id: "security-error-no-stacktrace",
    name: "Error responses do not leak stack traces",
    category: "security",
    required: false,
    specRef: "basic",
    description:
      "Triggers various error conditions and inspects responses for stack traces, file paths, and internal implementation details. Error responses should not reveal server internals. The probes are raw HTTP requests: over stdio the check is skipped ('Skipped: the error probes are raw HTTP requests, which a stdio target cannot receive, so no error response was scanned'). Over HTTP, when none of the probes gets an answer the check fails as 'server unreachable' instead of passing on an empty scan.",
    recommendation:
      "Sanitize error responses before returning them to clients. Remove stack traces, file paths, database connection strings, and internal IP addresses. Use generic error messages for unexpected failures.",
  },
  {
    id: "security-error-no-internal-ip",
    name: "Error responses do not leak internal IPs",
    category: "security",
    required: false,
    specRef: "basic",
    description:
      "Inspects error response bodies for private IP addresses (10.x, 172.16-31.x, 192.168.x, 127.x) that would reveal internal network topology. The probe is a raw HTTP request: over stdio the check is skipped ('Skipped: the error probe is a raw HTTP request, which a stdio target cannot receive, so no error response was scanned'). Over HTTP a probe that gets no answer fails as 'server unreachable'.",
    recommendation:
      "Strip internal IP addresses from error responses. Configure your reverse proxy to not forward X-Real-IP or internal addressing. Use a centralized error handler that sanitizes responses.",
  },
  {
    id: "security-rate-limiting",
    name: "Rate limiting is enforced",
    category: "security",
    required: false,
    specRef: "basic/transports#streamable-http",
    description:
      "Sends a burst of 50 rapid pings and checks whether the server returns HTTP 429 Too Many Requests. Production servers should implement rate limiting to prevent abuse. A burst with no 429 fails, and so does one where more than half the answers are 5xx. When every ping drew a 401 or 403 the burst never reached a handler, and it fails as not evaluable rather than as a missing limiter: when every refusal reads as an auth refusal (a 401, or a 403 whose Bearer challenge asks for a credential or refuses the one sent), the details name the auth gate (pass --auth, or check the credential); any other 403 -- what Host/Origin validation or a gateway answers every request with -- points at security-auth-required. A burst nothing answered fails as 'server unreachable'.",
    recommendation:
      "Implement rate limiting on your MCP endpoint. Return HTTP 429 with a Retry-After header when limits are exceeded. Consider per-IP, per-token, and per-session rate limits.",
  },
];
