import type { TestDefinition } from "../types.js";

/**
 * Test catalog for MCP spec 2026-07-28 (the stateless, per-request-_meta
 * era). `specRef` is relative to https://modelcontextprotocol.io/specification/2026-07-28
 * and every value names a page that exists in that revision plus an anchor
 * derived from one of its headings.
 *
 * 103 tests across the same 8 categories as the 2025-11-25 catalog, so the
 * v1 report schema is unchanged:
 *
 *   transport 20 (16 HTTP + 4 stdio) | lifecycle 22 | tools 6 | resources 8
 *   prompts 4 | errors 12 | schema 10 | security 21
 *
 * Id-reuse policy (design D4): an id shared with the 2025-11-25 catalog
 * covers the same feature (tools-list, stdio-unicode, security-cors-headers,
 * ...), but its wording, its pass criteria and its required flag may differ
 * between the catalogs: the request shapes differ by era, stdio-framing and
 * error-invalid-jsonrpc are optional here and required there,
 * error-method-code the reverse, and security-auth-required probes without
 * --auth here. A check whose verdict on the same server behaviour flipped
 * gets a NEW id even when it probes the same feature: lifecycle-discover
 * replaces lifecycle-init, transport-get-removed replaces transport-get (an
 * SSE stream now FAILS), resources-not-found is new because -32002 is now a
 * failure. Ids are therefore comparable only within one catalog; `diff`
 * refuses to compare reports across spec versions.
 *
 * Gating lives entirely in this catalog. The legacy suite skipped HTTP-only
 * tests on stdio through a runner-side STDIO_INCOMPATIBLE_IDS list plus a
 * blanket "transport category is HTTP" rule; here `transports` is the only
 * gate, so every test that reads an HTTP status, a header, a raw body, TLS,
 * CORS/Origin, OAuth metadata or a rate limit carries `transports: ["http"]`,
 * and the four stdio-* tests carry `["stdio"]`. `required` is the default
 * the suite overrides at runtime for capability-gated tests (R* in the
 * design: false here, true when the server declares the capability, exactly
 * like the legacy tools-list). `parallelSafe` marks read-only tests that
 * touch no shared state; post-hoc tests scan the Recorder after every other
 * test has drained and are never parallel-safe.
 *
 * Header-validation tests: the spec makes BOTH the HTTP 400 and the -32020
 * body a MUST for servers, but an intermediary is allowed to reject with a
 * bare 400, and the tool cannot tell the two apart. So HTTP 400 is the hard
 * requirement on every standard-header rejection and a missing -32020 is
 * reported as a warning. The one exception is the header/_meta version
 * mismatch, where the spec names the code in the same sentence as the status
 * and both are checked.
 */
export const MODERN_TEST_DEFINITIONS: TestDefinition[] = [
  // ── Transport (20 tests: 16 HTTP + 4 stdio) ──────────────────────
  {
    id: "transport-post",
    name: "HTTP POST accepted",
    category: "transport",
    required: true,
    specRef: "basic/transports/streamable-http#sending-messages",
    description:
      "POSTs a conformant server/discover request (standard headers plus _meta) to the MCP endpoint and verifies a 2xx status. The server MUST provide a single endpoint that supports POST and every client message MUST be its own POST; this is the baseline every other HTTP test builds on.",
    recommendation:
      "Listen for POST on the MCP endpoint and answer a well-formed server/discover with 200. A 401, or a 403 with a WWW-Authenticate: Bearer challenge, here means credentials are needed (pass --auth) or, with --auth, that the configured credential was rejected (check the --auth value); any other 403 may instead be Host or Origin validation (e.g. a tunnel hostname) or a gateway; a 404 usually means the URL points at a legacy HTTP+SSE endpoint or the wrong path.",
    transports: ["http"],
  },
  {
    id: "transport-content-type",
    name: "Responds with JSON or SSE",
    category: "transport",
    required: true,
    specRef: "basic/transports/streamable-http#sending-messages",
    description:
      "Checks the Content-Type of the server/discover response. For a JSON-RPC request the server MUST return either application/json (a single object) or text/event-stream (a request-scoped SSE stream); nothing else is valid.",
    recommendation:
      'Set Content-Type to "application/json" for a single-object response or "text/event-stream" for a streamed one. Never return text/html or text/plain for a JSON-RPC request, even on error paths.',
    transports: ["http"],
  },
  {
    id: "transport-content-type-reject",
    name: "Rejects non-JSON request Content-Type",
    category: "transport",
    required: false,
    specRef: "basic/transports/streamable-http#sending-messages",
    description:
      "Sends an otherwise valid server/discover (correct headers and _meta) with Content-Type: text/plain and expects a 4xx status. The POST body MUST be a single JSON-RPC message; a server that parses text/plain as JSON is trusting a content type it never checked. A rejection is credited only when it is the server's own: a 429 is resent once after Retry-After (capped at 2 s), and a 401, a 403 carrying a Bearer challenge (an auth gate; a gateway's -32001 body included), a 429 still a 429 after the resend, any 5xx, or a 403 without a Bearer challenge that a conformant server/discover sent next to it could not get past either fails as not evaluable. That twin is sent with the same headers only for such a 403, is resent once on a 429, and credits the 403 only when it was served or drew a status the server itself chose (a 2xx, or a 4xx other than 401, 403 or 429); when it drew the same 403, a message naming Host/Origin validation is quoted.",
    recommendation:
      "Validate the request Content-Type before parsing the body. Reject anything that is not application/json with 415 Unsupported Media Type or 400; do not sniff the body.",
    transports: ["http"],
  },
  {
    id: "transport-batch-reject",
    name: "Rejects JSON-RPC batch requests",
    category: "transport",
    required: true,
    specRef: "basic/transports/streamable-http#sending-messages",
    description:
      "POSTs a JSON array containing two valid server/discover requests and expects a 4xx status or a JSON-RPC error. The POST body MUST be a single JSON-RPC request or notification; batches were dropped in 2025-06-18 and remain unsupported. On a text/event-stream answer only JSON-RPC responses count: notifications before the error are ignored, and a stream that carries no response fails. An SSE data frame holding an array is the processed-batch shape, as the same array over application/json is, whatever its elements say. A rejecting status is credited only when it is the server's own: a 429 is resent once after Retry-After (capped at 2 s), and a 401, a 403 carrying a Bearer challenge (an auth gate; a gateway's -32001 body included), a 429 still a 429 after the resend, a 5xx without -32600, or a 403 without a Bearer challenge that a conformant server/discover sent next to it could not get past either fails as not evaluable. That twin is sent with the same headers only for such a 403, is resent once on a 429, and credits the 403 only when it was served or drew a status the server itself chose (a 2xx, or a 4xx other than 401, 403 or 429); when it drew the same 403, a message naming Host/Origin validation is quoted. A -32600 on a 5xx is credited, with a warning that a 4xx is expected.",
    recommendation:
      "If the parsed body is an array, respond with HTTP 400 (optionally carrying a -32600 Invalid Request error with no id). Do not process any element of the batch.",
    transports: ["http"],
  },
  {
    id: "transport-notification-202",
    name: "Notification returns 202 Accepted",
    category: "transport",
    required: false,
    specRef: "basic/transports/streamable-http#sending-messages",
    description:
      "POSTs a notifications/cancelled notification (no id) for an unknown request and expects HTTP 202 Accepted with an empty body. If the server accepts a notification it MUST return exactly 202; if it cannot accept it, it MUST return an HTTP error status. 202 passes, a 4xx refusal passes with a warning (this revision defines no client notifications over HTTP), and 200, 204 or 5xx fail.",
    recommendation:
      "Detect messages without an id and return 202 with no body. If you choose to refuse client notifications on HTTP (closing the stream is the cancellation signal there), return 400 -- never 200 or 204.",
    transports: ["http"],
  },
  {
    id: "transport-concurrent",
    name: "Handles concurrent requests",
    category: "transport",
    required: false,
    specRef: "basic/transports/streamable-http#sending-messages",
    description:
      "Fires three server/discover requests in parallel over separate POSTs and verifies every response arrives with its own matching id. Each message is its own HTTP POST with no shared session, so a stateless server must serve overlapping requests without cross-talk.",
    recommendation:
      "Handle requests concurrently (async handlers or a worker pool) and never key per-request state on the connection. Echo the id of the message being answered, not the id of the most recent one.",
    transports: ["http"],
  },
  {
    id: "transport-get-removed",
    name: "GET returns 405",
    category: "transport",
    required: false,
    specRef: "basic/transports/streamable-http#earlier-streamable-http-revisions",
    description:
      "Sends HTTP GET to the MCP endpoint. The standalone GET SSE stream was removed in 2026-07-28 (subscriptions/listen replaces it) and a server on this revision SHOULD answer legacy GET traffic with 405 Method Not Allowed. 405 passes, another 4xx passes with a warning, and a text/event-stream response fails.",
    recommendation:
      "Return 405 (with Allow: POST) for GET on the MCP endpoint. If you still open a legacy GET stream for 2025-11-25 clients on the same path you are dual-era; that is permitted, but this test grades the modern behaviour and will report it.",
    transports: ["http"],
  },
  {
    id: "transport-delete-removed",
    name: "DELETE returns 405",
    category: "transport",
    required: false,
    specRef: "basic/transports/streamable-http#earlier-streamable-http-revisions",
    description:
      "Sends HTTP DELETE to the MCP endpoint. Sessions and their DELETE termination were removed in 2026-07-28, so a server on this revision SHOULD answer with 405 Method Not Allowed. 405 passes, another 4xx passes with a warning, and 2xx or 5xx fail.",
    recommendation:
      "Return 405 for DELETE on the MCP endpoint. There is no session to terminate; do not answer 200 or 204 for a method you do not implement.",
    transports: ["http"],
  },
  {
    id: "transport-session-ignored",
    name: "Ignores Mcp-Session-Id",
    category: "transport",
    required: false,
    specRef: "basic/transports/streamable-http#earlier-streamable-http-revisions",
    description:
      "Sends a valid server/discover carrying a fabricated Mcp-Session-Id header and expects a normal result with no Mcp-Session-Id on the response. Protocol-level sessions are gone: a server SHOULD ignore the header and never mint or echo session ids. A 404 or 400 keyed to the bogus session, or a minted id, fails.",
    recommendation:
      "Ignore Mcp-Session-Id on incoming requests and never set it on responses. Do not reject a request because its session id is unknown -- there are no sessions to look up.",
    transports: ["http"],
  },
  {
    id: "transport-header-version-required",
    name: "Rejects missing MCP-Protocol-Version header",
    category: "transport",
    required: true,
    specRef: "basic/transports/streamable-http#protocol-version-header",
    description:
      "Sends a server/discover whose body is complete but whose MCP-Protocol-Version header is omitted. Every POST MUST carry the header, and a server that does not serve pre-2025-06-18 clients MUST reject its absence with HTTP 400 and a -32020 HeaderMismatch error. 400 is the hard requirement; a missing or different error code is reported as a warning. A 400 is credited only when the conformant server/discover was served; a server that rejects everything fails this test as not evaluable, as does a transport-level answer (401, 403, 413, 415 or 429 from an auth gate, size limit, media-type gate or rate limiter).",
    recommendation:
      "Validate MCP-Protocol-Version before dispatch. When it is absent, respond 400 with a JSON-RPC error { code: -32020 } echoing the request id. Only apply the 2025-03-26 legacy fallback for header-less requests whose body carries no modern _meta.",
    transports: ["http"],
  },
  {
    id: "transport-header-version-mismatch",
    name: "Rejects header/_meta version mismatch",
    category: "transport",
    required: true,
    specRef: "basic/transports/streamable-http#protocol-version-header",
    description:
      "Sends MCP-Protocol-Version: 2026-07-28 with _meta protocolVersion 1999-01-01. The header value MUST match the _meta field, and on a mismatch the server MUST respond 400 Bad Request with a -32020 HeaderMismatch error; both the status and the code are checked here. The 400 is credited only when the conformant server/discover was served and the answer is not a transport-level status (401, 403, 413, 415 or 429).",
    recommendation:
      "Compare the header to params._meta['io.modelcontextprotocol/protocolVersion'] byte-for-byte before any other validation and return 400 + -32020 when they differ. Do it before version negotiation so a mismatch is reported as a mismatch, not as an unsupported version.",
    transports: ["http"],
  },
  {
    id: "transport-header-method-required",
    name: "Rejects missing Mcp-Method header",
    category: "transport",
    required: true,
    specRef: "basic/transports/streamable-http#server-validation",
    description:
      "Sends a valid server/discover body without the Mcp-Method header. Mcp-Method is REQUIRED on every request; a missing standard header is a validation failure and the server MUST answer HTTP 400 with a -32020 HeaderMismatch error. 400 is the hard requirement; the -32020 code is checked as a warning because an intermediary may reject with a bare 400. A 400 is credited only when the conformant server/discover was served; a server that rejects everything fails this test as not evaluable, as does a transport-level answer (401, 403, 413, 415 or 429 from an auth gate, size limit, media-type gate or rate limiter).",
    recommendation:
      "Treat Mcp-Method as required and answer 400 + { code: -32020 } when it is missing. Do not silently fall back to the body's method field -- the header exists so gateways can route without parsing the body.",
    transports: ["http"],
  },
  {
    id: "transport-header-method-mismatch",
    name: "Rejects Mcp-Method/body mismatch",
    category: "transport",
    required: true,
    specRef: "basic/transports/streamable-http#server-validation",
    description:
      "Sends a server/discover body with Mcp-Method: tools/list. A header that does not match the corresponding body value MUST be rejected with HTTP 400 and a -32020 HeaderMismatch error, because a gateway routing on the header and a server executing on the body would otherwise disagree. 400 is required; -32020 is a warning. A 400 is credited only when the conformant server/discover was served; a server that rejects everything fails this test as not evaluable, as does a transport-level answer (401, 403, 413, 415 or 429 from an auth gate, size limit, media-type gate or rate limiter).",
    recommendation:
      "Validate every mirrored header (Mcp-Method, Mcp-Name, Mcp-Param-*) against the parsed body before dispatch and reject any difference with 400 + -32020. The body is the source of truth; never execute on the header alone.",
    transports: ["http"],
  },
  {
    id: "transport-header-name-mismatch",
    name: "Rejects Mcp-Name/body mismatch",
    category: "transport",
    required: false,
    specRef: "basic/transports/streamable-http#server-validation",
    description:
      "Sends a resources/read of the first listed resource (else a prompts/get of the first prompt without required arguments) whose Mcp-Name header names a different resource or prompt than the body. Mcp-Name is REQUIRED on tools/call, resources/read and prompts/get and MUST match params.uri or params.name after Base64 sentinel decoding, so the server MUST answer 400 + -32020; the 400 is credited only when the conformant server/discover was served and the answer is not a transport-level status (401, 403, 413, 415 or 429). The resource and prompt lists are fetched on demand when the feature tests did not run; skipped when the server declares neither capability or nothing listed can be read by name alone; when a declared list call failed (even if the other list worked but listed nothing readable by name) it skips pointing at the failed -list tests if they are in the run, and fails with the recorded reasons when they are not.",
    recommendation:
      "Decode a =?base64?...?= Mcp-Name value, then compare it to params.name (tools/call, prompts/get) or params.uri (resources/read). Reject a mismatch with 400 and -32020 before touching the named object.",
    transports: ["http"],
  },
  {
    id: "transport-header-case-insensitive",
    name: "Header names are case-insensitive",
    category: "transport",
    required: false,
    specRef: "basic/transports/streamable-http#case-sensitivity",
    description:
      "Sends a valid server/discover with the standard headers spelled in lowercase (mcp-protocol-version, mcp-method) and expects a normal result. Header names are case-insensitive per RFC 9110 and servers MUST compare them that way; only values are case-sensitive. A 400 HeaderMismatch here means the server matches on exact spelling.",
    recommendation:
      "Read headers through your framework's case-insensitive accessor (Node lowercases req.headers; Python header mappings are case-insensitive) rather than a raw compare on 'Mcp-Method'. Keep value comparison exact.",
    transports: ["http"],
  },
  {
    id: "transport-no-server-requests",
    name: "No server-initiated requests on any stream",
    category: "transport",
    required: true,
    specRef: "basic/transports#messages",
    description:
      "Post-hoc scan of every message the server sent during the run (JSON bodies, SSE frames, stdio lines) for a frame carrying both method and id, i.e. a server-to-client JSON-RPC request. No such direction exists in 2026-07-28: sampling, elicitation and roots MUST travel inside an InputRequiredResult (MRTR), and the server MUST NOT send independent requests on a response stream or to stdout.",
    recommendation:
      "Replace every server-initiated request (sampling/createMessage, elicitation/create, roots/list) with a resultType: input_required result carrying inputRequests, then complete the operation when the client retries with inputResponses. Audit SDK middleware that still pushes requests onto the SSE stream.",
  },

  // ── Stdio transport (stdio-only) ─────────────────────────────────
  {
    id: "stdio-framing",
    name: "Newline-delimited JSON framing",
    category: "transport",
    required: false,
    specRef: "basic/transports/stdio#receiving-messages",
    description:
      "Writes five server/discover requests to stdin in rapid succession and expects five responses, each a single line of JSON terminated by a newline. Messages are newline-delimited and MUST NOT contain embedded newlines, and the server MUST NOT write anything to stdout that is not a valid MCP message.",
    recommendation:
      "Serialise each message with a compact JSON encoder and append exactly one \\n. Never pretty-print to stdout, and route all logging to stderr -- a stray log line on stdout corrupts the frame that follows it.",
    transports: ["stdio"],
  },
  {
    id: "stdio-unicode",
    name: "UTF-8 unicode roundtrip",
    category: "transport",
    required: false,
    specRef: "basic/transports#messages",
    description:
      "Calls a tool with CJK and emoji characters in its string arguments -- a tool named echo, else the first tool with a string property named message, text, input or query, else the first tool (tools/list is fetched on demand) -- and passes when the reply reproduces them byte-for-byte, or reproduces every non-ASCII piece of the probe somewhere in the reply (a tool that tokenizes its input). Fails on evidence of mangling: U+FFFD replacement characters, a Latin-1 mis-decode, the non-ASCII characters replaced by '?', the non-ASCII characters stripped (the probe's Latin-1 word or its ASCII skeleton present with neither the CJK word nor the emoji anywhere in the reply), or a -32700 parse error. A tool that merely does not echo its input proves nothing, so the verdict then rests on a server/discover whose clientInfo name carries the same characters: the server parsing and answering it is the round-trip verified, and rejecting or mangling it fails. The server crashing on, or never answering, whichever probe is sent fails too, with a one-line reason: a tool call that gets no reply ends the check there, without falling back to the discover. So does a child that answers a probe and exits right after: a plain server/discover is sent after each answered probe, and a child found gone fails the check. A child that exits on the probe, or right after answering it, is restarted (a fresh server/discover plus one request that pins its era) with a warning naming this check, on every attempt that kills it, --retries included, so the checks after it measure a live process; a child already gone before the probe was sent fails as server unreachable and is not restarted. JSON-RPC messages MUST be UTF-8 encoded on every transport; this catches latin-1 or platform-default decoding of stdin.",
    recommendation:
      "Decode stdin and encode stdout as UTF-8 explicitly (process.stdin.setEncoding('utf8') in Node; reconfigure sys.stdin/sys.stdout with encoding='utf-8' in Python). Do not rely on the platform default, which is a legacy code page on Windows that drops or replaces with '?' every character it cannot encode.",
    transports: ["stdio"],
  },
  {
    id: "stdio-unknown-method-recovers",
    name: "Recovers after unknown method",
    category: "transport",
    required: false,
    specRef: "basic/transports/stdio#receiving-messages",
    description:
      "Sends a bogus method with a full modern _meta, then a valid server/discover immediately after. The unknown method should draw a JSON-RPC error (-32601 expected) and the server must keep serving: the discover that follows must succeed on the same process.",
    recommendation:
      "Return -32601 Method not found for unknown methods and keep reading stdin. Never exit or close stdout on a bad request; the client has no per-request stream to reopen, so a crash here loses every in-flight request.",
    transports: ["stdio"],
  },
  {
    id: "stdio-cancellation",
    name: "Ignores cancellation of unknown request",
    category: "transport",
    required: false,
    specRef: "basic/transports/stdio#cancellation",
    description:
      "Writes a notifications/cancelled referencing a request id that was never issued, then a server/discover. On stdio notifications/cancelled is the only cancellation signal and servers MAY ignore one for an unknown or completed request; the discover that follows must still be answered and nothing may be emitted in reply to the notification.",
    recommendation:
      "Look the requestId up in your in-flight table and drop the notification silently when it is unknown. Never respond to a notification (it has no id) and never treat an unknown requestId as a protocol error.",
    transports: ["stdio"],
  },

  // ── Lifecycle (22 tests) ─────────────────────────────────────────
  {
    id: "lifecycle-discover",
    name: "server/discover returns DiscoverResult",
    category: "lifecycle",
    required: true,
    specRef: "server/discover#response",
    description:
      "Sends server/discover with a conformant _meta and expects a result carrying a supportedVersions array and a capabilities object. Servers MUST implement server/discover; it replaces the initialize handshake and is the first response the suite trusts.",
    recommendation:
      "Implement a server/discover handler returning { resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: {...}, ttlMs, cacheScope } plus _meta['io.modelcontextprotocol/serverInfo']. Serve it without any prior request -- there is no initialize.",
  },
  {
    id: "lifecycle-discover-versions",
    name: "supportedVersions are well-formed",
    category: "lifecycle",
    required: true,
    specRef: "server/discover#discoverresult",
    description:
      "Validates supportedVersions on the discover result: non-empty, every entry a YYYY-MM-DD string. Warns when 2026-07-28 itself is absent, since the run grades that revision and the server just answered a request declaring it.",
    recommendation:
      "List every protocol revision you implement as a date string, e.g. ['2026-07-28', '2025-11-25'] for a dual-era server. Include 2026-07-28 if you answer modern requests at all; clients pick their version from this list.",
  },
  {
    id: "lifecycle-discover-caching",
    name: "server/discover carries caching hints",
    category: "lifecycle",
    required: true,
    specRef: "server/utilities/caching#cacheable-results",
    description:
      "Checks that the discover result carries ttlMs (an integer >= 0) and cacheScope ('public' or 'private'). Servers MUST include both caching hints on every complete server/discover result; a negative or missing ttlMs or an unknown scope fails.",
    recommendation:
      "Add ttlMs and cacheScope to the discover result. A stable server can use ttlMs: 3600000 with cacheScope: 'public'; use 'private' when capabilities or instructions vary by caller. ttlMs: 0 is valid and means 'always re-fetch'.",
  },
  {
    id: "lifecycle-jsonrpc",
    name: "Response is valid JSON-RPC 2.0",
    category: "lifecycle",
    required: true,
    specRef: "basic/index#result-responses",
    description:
      "Validates the discover response envelope: jsonrpc is exactly '2.0', the id is echoed, and exactly one of result (an object) or error is present. All MCP messages MUST follow JSON-RPC 2.0 and a result response MUST include a result field. Over HTTP, the envelope of a discover answered without a result is judged only when the server wrote it: a 429 is resent once after Retry-After (capped at 2 s) and the second answer is judged, and a 401, a 403 carrying a Bearer challenge, any other 403 (it refused the conformant request itself, so nothing is left to compare it with; the message is quoted when it names Host/Origin validation), a 429 still a 429 after the resend, or a 5xx carrying none of -32600, -32601, -32602, -32020, -32021 or -32022 fails as not evaluable, because a gateway's envelope (its -32001 on a 401, echoing the id) proves nothing about the server's JSON-RPC. A 5xx carrying one of those codes is the server's own refusal and is credited, with a warning that a 4xx is expected. Over stdio every answer is the server's.",
    recommendation:
      "Emit { jsonrpc: '2.0', id, result } for success and { jsonrpc: '2.0', id, error: { code, message } } for failure. Never send both result and error, and never omit jsonrpc.",
  },
  {
    id: "lifecycle-id-match",
    name: "Response id matches request id",
    category: "lifecycle",
    required: true,
    specRef: "basic/index#result-responses",
    description:
      "Verifies the id on the discover response equals the id the suite sent. Result and error responses MUST include the same id as the request they answer; the suite issues numeric ids from 1000 upward so a stale or fabricated id is easy to spot.",
    recommendation:
      "Copy the request id into the response verbatim, preserving its type. Check that your framework does not renumber ids or answer with the id of a different in-flight request.",
  },
  {
    id: "lifecycle-string-id",
    name: "Supports string request ids",
    category: "lifecycle",
    required: false,
    specRef: "basic/index#requests",
    description:
      "Sends server/discover with a string id and expects the response to echo it byte-for-byte as a string, on HTTP and stdio alike. Requests MUST carry a string or integer id and the server MUST return the same one; coercing '42' to 42 or dropping the id fails.",
    recommendation:
      "Accept both string and integer ids and echo the exact JSON value back. Do not parse string ids as numbers or generate your own.",
    parallelSafe: true,
  },
  {
    id: "lifecycle-capabilities",
    name: "Returns capabilities object",
    category: "lifecycle",
    required: true,
    specRef: "server/discover#discoverresult",
    description:
      "Checks that the discover result has a capabilities object and that each declared feature (tools, resources, prompts, completions, logging, experimental, extensions) is itself an object. An empty {} is valid; a capability declared as true or a string is not, because sub-features such as listChanged live inside it.",
    recommendation:
      "Declare capabilities as nested objects: { tools: { listChanged: true }, resources: {}, prompts: {} }. Do not use booleans at the top level, and declare only the features you actually serve.",
  },
  {
    id: "lifecycle-server-info",
    name: "Includes serverInfo in _meta",
    category: "lifecycle",
    required: false,
    specRef: "server/discover#discoverresult",
    description:
      "Looks for result._meta['io.modelcontextprotocol/serverInfo'] on the discover result and checks it carries string name and version fields. Servers SHOULD include serverInfo on every result so a client can identify them without connection state; the report's serverInfo comes from here.",
    recommendation:
      "Attach _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'my-server', version: '1.2.3' } } to every result, not just discover. The legacy top-level serverInfo field is not read in 2026-07-28.",
    parallelSafe: true,
  },
  {
    id: "lifecycle-instructions",
    name: "Instructions field is valid",
    category: "lifecycle",
    required: false,
    specRef: "server/discover#discoverresult",
    description:
      "If the discover result includes instructions, verifies it is a string. Instructions are optional natural-language guidance for the model on how to use the server; absence passes and any other type fails.",
    recommendation:
      "Set instructions to a short string describing when and how to use the server, or omit the field. Do not send an array or object.",
    parallelSafe: true,
  },
  {
    id: "lifecycle-meta-required",
    name: "Rejects request without _meta",
    category: "lifecycle",
    required: true,
    specRef: "basic/index#meta",
    description:
      "Sends server/discover with params carrying no _meta at all (on HTTP the headers are still correct). protocolVersion and clientCapabilities are required on every request, so the request is malformed and the server MUST reject it with -32602 Invalid params; on HTTP the status MUST be 400. A rejection with a different code is reported as a warning; a result fails, because the server is inferring version and capabilities from nowhere. On HTTP, a bare 400 with no JSON-RPC error body (an intermediary answering with a status alone) passes with a warning; any other status without a JSON-RPC error body -- a 404, a 422, a plain-text 500 -- fails, since the spec requires -32602 on HTTP 400. Runs late, after the feature tests and before the security tests: a dual-era stdio server that is still deciding its era treats a claim-less message as a legacy opening, and by then a modern request has pinned the process (a --only run that skipped the feature tests sends one first on stdio -- the first declared list, else ping); the security rate-limit burst comes afterwards so an intermediary it trips cannot answer this probe. Not evaluable -- and failed -- when the conformant server/discover was itself rejected, since the rejection then proves nothing about the missing _meta, and likewise when the answer is a transport-level status (401, 403, 413, 415 or 429: an auth gate, size limit, media-type gate or rate limiter answering before the JSON-RPC layer read the request).",
    recommendation:
      "Validate params._meta before dispatch: require 'io.modelcontextprotocol/protocolVersion' and 'io.modelcontextprotocol/clientCapabilities' on every request, server/discover included. Return { code: -32602 } with HTTP 400 and do not default the missing fields.",
  },
  {
    id: "lifecycle-meta-protocol-version-required",
    name: "Rejects _meta without protocolVersion",
    category: "lifecycle",
    required: true,
    specRef: "basic/index#meta",
    description:
      "Sends server/discover whose _meta carries clientCapabilities and clientInfo but no protocolVersion (on HTTP the MCP-Protocol-Version header is present and correct). The field is required, so the server MUST answer -32602 Invalid params and, on HTTP, status 400. A rejection with another code (-32020 is the common one) passes with a warning; a result fails. A bare HTTP 400 with no JSON-RPC body passes with a warning; any other status without a JSON-RPC error body (404, 422, 5xx) fails. Runs late, after the feature tests and before the security tests, for the same reasons as lifecycle-meta-required. Not evaluable -- and failed -- when the conformant server/discover was itself rejected, or when the answer is a transport-level status (401, 403, 413, 415 or 429).",
    recommendation:
      "Require 'io.modelcontextprotocol/protocolVersion' in every request's _meta and reject its absence with -32602 / HTTP 400. Do not fill it in from the HTTP header -- the body is the source of truth and the header only mirrors it.",
  },
  {
    id: "lifecycle-meta-client-capabilities-required",
    name: "Rejects _meta without clientCapabilities",
    category: "lifecycle",
    required: true,
    specRef: "basic/index#meta",
    description:
      "Sends server/discover whose _meta has protocolVersion and clientInfo but no clientCapabilities. Capabilities are per-request input the server MUST NOT infer from prior requests, so the field is required even when empty; the server MUST answer -32602 (HTTP 400). Serving the request as if {} had been sent fails. A bare HTTP 400 with no JSON-RPC body passes with a warning; any other status without a JSON-RPC error body (404, 422, 5xx) fails. Not evaluable -- and failed -- when the conformant server/discover was itself rejected, since the rejection then proves nothing about the missing field. A transport-level status (401, 403, 413, 415 or 429) is not evaluable either.",
    recommendation:
      "Require 'io.modelcontextprotocol/clientCapabilities' on every request and reject its absence with -32602 / HTTP 400. Clients send {} when they have nothing to declare; treat absence and {} differently.",
  },
  {
    id: "lifecycle-meta-client-info-optional",
    name: "Serves _meta without clientInfo",
    category: "lifecycle",
    required: true,
    specRef: "basic/index#meta",
    description:
      "Sends server/discover whose _meta has the two required fields but omits clientInfo, and expects a normal result. clientInfo is a SHOULD for clients, not a requirement; a server that rejects its absence blocks conformant clients that are configured not to identify themselves. Not evaluable -- and failed -- when the conformant server/discover (clientInfo included) was itself rejected, or when the answer is a transport-level status (401, 403, 413, 415 or 429): the refusal then proves nothing about clientInfo.",
    recommendation:
      "Treat 'io.modelcontextprotocol/clientInfo' as optional: read it for logging when present and proceed when absent. Do not validate it as required and never make authorization decisions on it.",
  },
  {
    id: "lifecycle-version-unsupported",
    name: "Rejects unsupported protocol version",
    category: "lifecycle",
    required: true,
    specRef: "basic/versioning#protocol-version-negotiation",
    description:
      "Sends server/discover declaring protocol version 1999-01-01 in _meta (and in the header on HTTP). A version the server does not implement MUST be answered with UnsupportedProtocolVersionError (-32022) whose data.supported lists the server's versions and data.requested echoes '1999-01-01'; on HTTP the status MUST be 400. data.supported must be non-empty and a subset of the discover result's supportedVersions.",
    recommendation:
      "Check _meta protocolVersion against your supported list before dispatch and answer { code: -32022, message: 'Unsupported protocol version', data: { supported: [...], requested } } with HTTP 400. Keep data.supported identical to what server/discover advertises.",
  },
  {
    id: "lifecycle-removed-methods",
    name: "Removed legacy methods are rejected",
    category: "lifecycle",
    required: false,
    specRef: "changelog#major-changes",
    description:
      "Sends ping, logging/setLevel and resources/subscribe with a full modern _meta. All three were removed in 2026-07-28 (there is no keepalive RPC, log level is per-request _meta, subscriptions/listen replaces resources/subscribe), so each should draw a JSON-RPC error. -32601 Method not found (with HTTP 404 on HTTP) is expected; another error code passes with a warning and a result fails. On HTTP a bare 404 with no JSON-RPC body passes with a warning (the status streamable-http requires, without the body that tells it from a legacy server's 404); any other bare status (400, 405, 500, ...) fails naming it, and a transport-level status (401, 403, 413, 415, 429), with or without a JSON-RPC body, fails as not evaluable. A rejection is credited only when the conformant server/discover was served; a server that rejects everything fails this test as not evaluable.",
    recommendation:
      "Drop the ping, logging/setLevel, resources/subscribe and resources/unsubscribe handlers from the modern code path and let them fall through to -32601. A dual-era server may keep them behind the legacy initialize session only.",
  },
  {
    id: "lifecycle-dual-era",
    name: "Legacy initialize probe (informational)",
    category: "lifecycle",
    required: false,
    specRef: "basic/versioning#backward-compatibility-with-initialization-based-versions",
    description:
      "Sends a legacy initialize request (2025-11-25 shape, no modern _meta, legacy headers on HTTP) and reports which era the server speaks: a result alongside a served server/discover means dual-era; a result while server/discover was rejected or unanswered means legacy-only (the run graded the era the server does not speak, and a warning says so); an error means modern-only. All of those pass; the test is informational. No response (a timeout, named with its budget, or a connection error, named as such) and a transport-level status (401, 403, 413, 415 or 429) pass with a warning as era undetermined (flagged as a skip: nothing the server said about its era was read). On stdio the probe goes to a fresh process, because a dual-era server selects its era from how the client opens and the suite's own process is already modern; it waits the per-request timeout (stretched to three times the setup server/discover latency for a slow starter, never beyond --startup-timeout). If that fresh process exits unanswered, a second instance is started with no input at all: one that exits too shows a server that allows one instance at a time (a lock file, a fixed port) and cannot be probed alongside the suite's own process -- era undetermined, with the exit code and stderr in a warning (also a skip); one that stays up shows the request is what the server exits on, the only failure of this test. A modern-only server SHOULD name its supported versions in the error -- in data.supported (the UnsupportedProtocolVersionError shape) or in the message -- and one that names none (a message that only echoes the rejected 2025-11-25 does not count) draws a warning. Runs after the feature tests and before the security tests.",
    recommendation:
      "If you only implement 2026-07-28, reject initialize with a JSON-RPC error that lists your supported versions -- -32022 with data.supported ['2026-07-28'] is the canonical shape, and naming the version in the message (e.g. 'This server speaks MCP 2026-07-28; initialize is not supported') also satisfies the SHOULD. Legacy clients have no fall-forward mechanism, so that error may be the only diagnostic they see.",
  },
  {
    id: "lifecycle-capability-handlers-match",
    name: "Capability declarations match handlers",
    category: "lifecycle",
    required: false,
    specRef: "server/discover#discoverresult",
    description:
      "For each of tools, resources and prompts: when the capability is declared, the corresponding list method must return a result (servers that declare a capability MUST respond to its list request); when it is not declared, the list method must return a JSON-RPC error, -32601 expected. A declared capability whose list fails, or an undeclared one whose list succeeds, fails.",
    recommendation:
      "Derive the capabilities object from the handlers you register rather than hard-coding it. Register tools/list, resources/list and prompts/list exactly when you declare the matching capability, and let undeclared methods fall through to -32601.",
  },
  {
    id: "lifecycle-subscriptions-listen",
    name: "subscriptions/listen acknowledges first",
    category: "lifecycle",
    required: false,
    specRef: "basic/patterns/subscriptions#acknowledgment",
    description:
      "When any listChanged or subscribe capability is declared, opens a subscriptions/listen stream requesting the matching notification types and reads the first frame. It MUST be notifications/subscriptions/acknowledged carrying _meta['io.modelcontextprotocol/subscriptionId'] equal to the listen request's id and a notifications object naming the subset the server honours; no other notification may precede it. When nothing is advertised, either the acknowledgment or -32601 passes (another error code, or a 4xx without a JSON-RPC body, passes with a warning) -- the rejection credited only when the conformant server/discover was served (a server that rejects everything fails this test as not evaluable) and the rejection is the server's own. Over HTTP a 429 on the listen is resent once after Retry-After (capped at 2 s), and, advertised or not, a rejection fails as not evaluable when something in front of the server answered in its place: a 401, a 403 carrying a Bearer challenge (an auth gate; a gateway's -32001 included), a 429 still a 429 after the resend, a 5xx without -32601 (any 5xx when something is advertised), or a 403 without a Bearer challenge that a conformant server/discover sent next to it could not get past either (that twin credits the 403 only when it was served or drew a 2xx or a 4xx other than 401, 403 or 429). A -32601 on a 5xx is credited, with a warning that a 4xx is expected. An acknowledgment that honours a notification type or URI the request did not include passes with a warning: the server may send notifications outside the requested filter. A stream that opens but sends nothing within the listen window (the smaller of 3000 ms and --timeout) fails.",
    recommendation:
      "Implement subscriptions/listen as a long-lived response (an SSE stream on HTTP; tagged by subscriptionId on stdio). Send the acknowledgment first, with the request id as the subscription id and the filter you accepted, then keep the stream open until the client closes it.",
  },
  {
    id: "lifecycle-log-level-gating",
    name: "No log notifications without logLevel",
    category: "lifecycle",
    required: true,
    specRef: "server/utilities/logging#per-request-log-level",
    description:
      "Post-hoc scan of the recording: every notifications/message the server sent is traced to the request it arrived with, and that request must have carried _meta['io.modelcontextprotocol/logLevel']. The server MUST NOT emit notifications/message for a request that did not set a log level; a log frame on a request that never opted in, or on a subscriptions/listen stream, fails.",
    recommendation:
      "Gate every notifications/message on the current request's logLevel _meta field and send it only on that request's own response stream. Remove any global default log level left over from logging/setLevel.",
  },
  {
    id: "lifecycle-meta-tolerance",
    name: "Tolerates unknown _meta keys",
    category: "lifecycle",
    required: false,
    specRef: "basic/index#meta",
    description:
      "Sends server/discover with an extra vendor-prefixed key (com.example.compliance/probe) alongside the required _meta fields and expects a normal result. _meta is an open namespace for third-party and extension metadata, so a server must not reject a request for keys it does not recognise. A rejection is blamed on the unknown key only when the conformant server/discover was served and no transport-level status (401, 403, 413, 415, 429) answered the probe; otherwise the test fails as not evaluable.",
    recommendation:
      "Read the reserved io.modelcontextprotocol/* keys you need and ignore everything else in _meta. Do not validate _meta with additionalProperties: false.",
    parallelSafe: true,
  },
  {
    id: "lifecycle-completions",
    name: "completion/complete accepted",
    category: "lifecycle",
    required: false,
    specRef: "server/utilities/completion#requesting-completions",
    description:
      "If the server declares the completions capability, sends completion/complete for the first listed prompt argument, else the first resource-template variable (prompts/list and resources/templates/list are fetched on demand; a listed template is still used when prompts/list failed), else a placeholder ref where -32602 is acceptable, and expects a result with a completion.values array (empty is fine). When nothing is listed because a declared prompts/list or resources/templates/list failed (-32601 from resources/templates/list counts as no templates), the placeholder is not sent: the test skip-passes pointing at prompts-list / resources-templates when that test is in the run, and fails with the recorded reason when the run filtered it out. Servers that declare the capability must serve the method; skipped when the capability is absent.",
    recommendation:
      "When you declare completions, implement completion/complete and return at least { completion: { values: [], hasMore: false } }. Reference prompts by name and resource templates by uriTemplate exactly as listed.",
  },
  {
    id: "lifecycle-progress-token",
    name: "Progress notifications echo the token",
    category: "lifecycle",
    required: false,
    specRef: "basic/patterns/progress#progress-flow",
    description:
      "Calls the first tool without required arguments (preferring one whose name or description mentions progress, else the first listed tool) with _meta.progressToken set and reads the whole response; tools/list is fetched on demand when the tools tests did not run, and the test is skipped when the server declares no tools; when tools/list failed it skips pointing at tools-list if that test is in the run, and fails with the recorded reason when it is not. Progress is optional, so a call with no notifications/progress passes; but any progress notification that does arrive MUST carry the same token and its progress value MUST increase with each notification. A foreign token or a non-increasing value fails. A server may ignore the token but not fail the request because of it. A 429 on any of the check's calls is resent once after Retry-After (capped at 2 s). The call failing on the server's side -- a JSON-RPC error, an HTTP status >= 400 other than a 429 or an auth gate's 401 or Bearer-challenge 403, a connection the server closed, or a stdio child that exits on it -- is blamed on the token only once it is reproduced: the same call without the token, sent right after, is served, and the call carrying the token, resent after that, fails again (its progress notifications are judged like the first's). A tool whose first call fails whatever it carries (a cold backend) passes when the resent call is served; a failure the server's own answer to the call without the token shares, or a resent call answered without failing again, stays a passing observation. Only the server's own answers attribute anything: a gate's answer (a 429 still a 429 after its resend, a 401, a Bearer-challenge 403) on any of the three calls, a call without the token that gets no response, or a first or resent call that gets none (a timeout, a connection never established, a stdio child already gone) measured nothing about the token, so the check is skipped, never a scored pass. On stdio a child that exits on one of the calls is restarted before the next, with a warning naming the call, so the calls and checks after it reach a live process.",
    recommendation:
      "Copy _meta.progressToken from the request into every notifications/progress you emit for it, send them on that request's response stream before the final result, and make progress strictly increasing (total is optional).",
  },

  // ── Tools (6 tests) ──────────────────────────────────────────────
  {
    id: "tools-list",
    name: "tools/list returns valid response",
    category: "tools",
    required: false,
    specRef: "server/tools#listing-tools",
    description:
      "Calls tools/list and validates the result has a tools array of tool objects. Servers that declare the tools capability MUST respond to tools/list with the set of tools available to the caller; required at runtime when the capability is declared.",
    recommendation:
      "Implement tools/list returning { resultType: 'complete', tools: [...], ttlMs, cacheScope }. Each entry needs at least name and an object-typed inputSchema; an empty array is valid.",
  },
  {
    id: "tools-list-caching",
    name: "tools/list carries caching hints",
    category: "tools",
    required: false,
    specRef: "server/utilities/caching#cacheable-results",
    description:
      "Checks that the tools/list result carries ttlMs (an integer >= 0) and cacheScope ('public' or 'private'). Servers MUST include both hints on complete tools/list results; they let clients skip re-fetching and improve prompt-cache hit rates. Required at runtime when the tools capability is declared. Reuses the response the -list test obtained; a list call that got no response (a timeout, a connection error) is not repeated.",
    recommendation:
      "Add ttlMs and cacheScope to every tools/list page. Use 'public' when the list is identical for all callers and 'private' when it is filtered by the caller's credentials; the same scope MUST apply to every page of one list.",
  },
  {
    id: "tools-list-deterministic-order",
    name: "tools/list order is deterministic",
    category: "tools",
    required: false,
    specRef: "server/tools#capabilities",
    description:
      "Calls tools/list three times and compares the order of tool names. Servers SHOULD return tools in a deterministic order when the underlying set has not changed; a shuffled order defeats client caching and LLM prompt caching. tools/list is fetched on demand when tools-list did not run; when that call failed, skipped pointing at tools-list if that test is in the run, and failed with the recorded reason (--only tools-list-deterministic-order, or --skip tools-list) when it is not. Fewer than two listed tools, or a tool set that changed between the calls, leave no order to compare: the check passes, flagged as a skip.",
    recommendation:
      "Sort tools by name (or keep a fixed registration order) before returning them. Do not iterate an unordered map whose iteration order changes between calls.",
  },
  {
    id: "tools-call",
    name: "tools/call responds correctly",
    category: "tools",
    required: false,
    specRef: "server/tools#calling-tools",
    description:
      "Calls the first tool whose inputSchema declares no required properties (else the first tool) with empty arguments and validates the result shape: a content array whose items each carry a type (isError: true with content also passes), or resultType 'input_required' (an MRTR InputRequiredResult) with inputRequests entries of the { method, params } shape and/or a string requestState. A JSON-RPC error passes -- -32602 (or -32600) as the expected answer for a tool that needs arguments, any other code noted as a protocol error in the details. resultType 'complete' is not checked here; schema-result-type scans every result post-hoc. tools/list is fetched on demand when tools-list did not run; when that call failed, skipped pointing at tools-list if that test is in the run, and failed with the recorded reason (--only tools-call, or --skip tools-list) when it is not. A server that lists no tools skips. Required at runtime when the tools capability is declared.",
    recommendation:
      "Return { resultType: 'complete', content: [{ type: 'text', text }], isError?: boolean } for a completed call, or { resultType: 'input_required', inputRequests, requestState } when you need elicitation or sampling. Report missing arguments with -32602 rather than an empty content array.",
  },
  {
    id: "tools-content-types",
    name: "Tool content items have valid types",
    category: "tools",
    required: false,
    specRef: "server/tools#tool-result",
    description:
      "Validates that every item in a tools/call content array has a type of text, image, audio, resource or resource_link. These are the only content types defined for tool results; a typo or missing type breaks client rendering. tools/list is fetched on demand when tools-list did not run; when that call failed, skipped pointing at tools-list if that test is in the run, and failed with the recorded reason (--only tools-content-types, or --skip tools-list) when it is not. A server that lists no tools skips, and a result with no content items passes as a skip. Required at runtime when the tools capability is declared.",
    recommendation:
      "Set type on every content block to one of 'text', 'image', 'audio', 'resource', 'resource_link' and include the fields that type requires (text; data + mimeType; resource.uri; uri + name).",
  },
  {
    id: "tools-pagination",
    name: "tools/list supports pagination",
    category: "tools",
    required: false,
    specRef: "server/utilities/pagination#response-format",
    description:
      "Reads tools/list and, when nextCursor is present, verifies it is a string and that passing it back as cursor returns another valid page. Cursors are opaque and clients MUST NOT assume a page size, so the server decides when to paginate; a list with no nextCursor passes.",
    recommendation:
      "When the list is large, return nextCursor as an opaque string and honour it on the next request. Omit nextCursor on the last page and answer -32602 for a cursor you did not issue.",
  },

  // ── Resources (8 tests) ──────────────────────────────────────────
  {
    id: "resources-list",
    name: "resources/list returns valid response",
    category: "resources",
    required: false,
    specRef: "server/resources#listing-resources",
    description:
      "Calls resources/list and validates the result has a resources array of objects. Servers that declare the resources capability MUST respond to resources/list; required at runtime when the capability is declared.",
    recommendation:
      "Implement resources/list returning { resultType: 'complete', resources: [...], ttlMs, cacheScope }. Each entry needs uri and name; an empty array is valid.",
  },
  {
    id: "resources-list-caching",
    name: "resources/list carries caching hints",
    category: "resources",
    required: false,
    specRef: "server/utilities/caching#cacheable-results",
    description:
      "Checks ttlMs (an integer >= 0) and cacheScope ('public' or 'private') on the resources/list result. Both caching hints are a MUST on every complete resources/list result. Required at runtime when the resources capability is declared. Reuses the response the -list test obtained; a list call that got no response (a timeout, a connection error) is not repeated.",
    recommendation:
      "Add ttlMs and cacheScope to every resources/list page, choosing 'private' when the list depends on who is asking.",
  },
  {
    id: "resources-read",
    name: "resources/read returns content",
    category: "resources",
    required: false,
    specRef: "server/resources#reading-resources",
    description:
      "Reads the first listed resource that has a uri and validates the result: a contents array whose items carry uri and either text or blob, or resultType 'input_required' with a valid InputRequiredResult (inputRequests entries of the { method, params } shape and/or a string requestState). A JSON-RPC error for a resource the server itself listed fails, and an empty contents array passes with a warning. resultType 'complete' is not checked here; schema-result-type scans every result post-hoc. resources/list is fetched on demand when resources-list did not run; when that call failed, skipped pointing at resources-list if that test is in the run, and failed with the recorded reason (--only resources-read, or --skip resources-list) when it is not. A server that lists no resource with a uri skips. Required at runtime when the resources capability is declared.",
    recommendation:
      "Return { resultType: 'complete', contents: [{ uri, mimeType, text | blob }], ttlMs, cacheScope } and make each item's uri the one that was requested (or a child of it for directory reads).",
  },
  {
    id: "resources-read-caching",
    name: "resources/read carries caching hints",
    category: "resources",
    required: false,
    specRef: "server/utilities/caching#cacheable-results",
    description:
      "Checks ttlMs (an integer >= 0) and cacheScope on the resources/read result. resources/read is a cacheable operation and MUST carry both hints on complete results; input_required interim results carry none and are exempt. resources/list is fetched on demand when resources-list did not run; when that call failed, skipped pointing at resources-list if that test is in the run, and failed with the recorded reason (--only resources-read-caching, or --skip resources-list) when it is not. A server that lists no resource with a uri skips. Required at runtime when the resources capability is declared.",
    recommendation:
      "Add ttlMs and cacheScope to resources/read results. Content that depends on the authenticated user needs cacheScope: 'private'; use ttlMs: 0 for volatile data rather than omitting the field.",
  },
  {
    id: "resources-not-found",
    name: "Nonexistent resource returns -32602",
    category: "resources",
    required: false,
    specRef: "server/resources#error-handling",
    description:
      "Reads a URI that does not exist and expects a JSON-RPC error. Servers MUST return -32602 Invalid params for a missing resource and MUST NOT return an empty contents array: a result of any shape fails, and so does the retired -32002 code, which implementations of this revision MUST NOT emit. Any other error code fails too, -32603 included: -32603 is for internal errors, and a URI the server cannot resolve is a missing resource. data.uri naming the missing resource is a SHOULD, reported as a warning when absent. Required at runtime when the resources capability is declared.",
    recommendation:
      "Answer unknown URIs with { code: -32602, message: 'Resource not found', data: { uri } }. Replace any -32002 constant left over from 2025-11-25 and never return contents: [] for a URI you cannot resolve.",
  },
  {
    id: "resources-templates",
    name: "resources/templates/list returns valid response",
    category: "resources",
    required: false,
    specRef: "server/resources#resource-templates",
    description:
      "Calls resources/templates/list and validates the result has a resourceTemplates array whose entries carry uriTemplate and name. Templates are optional, so -32601 Method not found passes; a malformed result does not.",
    recommendation:
      "If you expose parameterised resources, implement resources/templates/list returning { resourceTemplates: [{ uriTemplate, name, ... }], ttlMs, cacheScope }. Otherwise leave the method unregistered so it answers -32601.",
  },
  {
    id: "resources-templates-caching",
    name: "resources/templates/list carries caching hints",
    category: "resources",
    required: false,
    specRef: "server/utilities/caching#cacheable-results",
    description:
      "When resources/templates/list succeeds, checks that the result carries ttlMs (an integer >= 0) and cacheScope. The method is on the list of operations that MUST carry caching hints; skipped when the server does not implement templates. Reuses the response the -list test obtained; a list call that got no response (a timeout, a connection error) is not repeated.",
    recommendation:
      "Add ttlMs and cacheScope to resources/templates/list results, typically the same values you use for resources/list.",
  },
  {
    id: "resources-pagination",
    name: "resources/list supports pagination",
    category: "resources",
    required: false,
    specRef: "server/utilities/pagination#response-format",
    description:
      "Reads resources/list and, when nextCursor is present, verifies it is a string and that passing it back as cursor returns another valid page. Clients MUST treat cursors as opaque tokens and MUST NOT assume a page size; a list with no nextCursor passes.",
    recommendation:
      "When paginating, return nextCursor as an opaque string, honour it on the next request and omit it on the last page. Answer -32602 for a cursor you do not recognise.",
  },

  // ── Prompts (4 tests) ────────────────────────────────────────────
  {
    id: "prompts-list",
    name: "prompts/list returns valid response",
    category: "prompts",
    required: false,
    specRef: "server/prompts#listing-prompts",
    description:
      "Calls prompts/list and validates the result has a prompts array of objects. Servers that declare the prompts capability must serve prompts/list; required at runtime when the capability is declared.",
    recommendation:
      "Implement prompts/list returning { resultType: 'complete', prompts: [...], ttlMs, cacheScope }. Each entry needs a name; arguments, if any, need name fields.",
  },
  {
    id: "prompts-list-caching",
    name: "prompts/list carries caching hints",
    category: "prompts",
    required: false,
    specRef: "server/utilities/caching#cacheable-results",
    description:
      "Checks ttlMs (an integer >= 0) and cacheScope ('public' or 'private') on the prompts/list result. Both hints are a MUST on every complete prompts/list result. Required at runtime when the prompts capability is declared. Reuses the response the -list test obtained; a list call that got no response (a timeout, a connection error) is not repeated.",
    recommendation: "Add ttlMs and cacheScope to every prompts/list page.",
  },
  {
    id: "prompts-get",
    name: "prompts/get returns valid messages",
    category: "prompts",
    required: false,
    specRef: "server/prompts#getting-a-prompt",
    description:
      "Gets the first listed prompt with no required arguments (else the first prompt, with each required argument filled by the placeholder 'test') and validates the result: a messages array whose items have a role of user or assistant and a content object, or resultType 'input_required' with a valid InputRequiredResult (inputRequests entries of the { method, params } shape and/or a string requestState). A -32602 (or -32600) error for a prompt that rejects the arguments also passes; any other JSON-RPC error fails. resultType 'complete' is not checked here; schema-result-type scans every result post-hoc. prompts/list is fetched on demand when prompts-list did not run; when that call failed, skipped pointing at prompts-list if that test is in the run, and failed with the recorded reason (--only prompts-get, or --skip prompts-list) when it is not. A server that lists no prompts skips. Required at runtime when the prompts capability is declared.",
    recommendation:
      "Return { resultType: 'complete', messages: [{ role, content: { type: 'text', text } }] }. Report missing required arguments with -32602 Invalid params, not an empty messages array.",
  },
  {
    id: "prompts-pagination",
    name: "prompts/list supports pagination",
    category: "prompts",
    required: false,
    specRef: "server/utilities/pagination#response-format",
    description:
      "Reads prompts/list and, when nextCursor is present, verifies it is a string and that passing it back as cursor returns another valid page. Cursors are opaque and page size is the server's choice; a list with no nextCursor passes.",
    recommendation:
      "When paginating prompts, return nextCursor as an opaque string, honour it on the next request and omit it on the last page.",
  },

  // ── Error Handling (12 tests) ────────────────────────────────────
  {
    id: "error-unknown-method",
    name: "Unknown method returns JSON-RPC error",
    category: "errors",
    required: true,
    specRef: "basic/transports/streamable-http#protocol-version-header",
    description:
      "Sends a method name that does not exist (compliance/nonexistent) with a full modern _meta and expects a JSON-RPC error response echoing the request id. On HTTP the server MUST respond 404 Not Found together with the JSON-RPC error body, so a 404 + error passes, an error carried on another status (a 200, a 400) passes with a warning on the status, and a result fails. A rejection is credited only when the conformant server/discover was served; a server that rejects everything fails this test as not evaluable. It is also not evaluable when something in front of the server answered in its place: a 401, a 403 carrying a Bearer challenge (an auth gate; a gateway's -32001 body included), a 429 still a 429 after one resend after Retry-After (capped at 2 s), a 5xx without -32601, or a 403 without a Bearer challenge that a conformant server/discover sent next to the probe could not get past either. That twin is sent with the same headers only for such a 403, is resent once on a 429, and credits the 403 only when it was served or drew a status the server itself chose (a 2xx, or a 4xx other than 401, 403 or 429); when it drew the same 403, a message naming Host/Origin validation is quoted. A -32601 on a 5xx passes, with a warning that the spec requires 404.",
    recommendation:
      "Route unknown methods to a handler that returns { code: -32601, message: 'Method not found' } and, on HTTP, sets status 404. The JSON-RPC body is what lets a modern client tell your 404 apart from a legacy HTTP+SSE server that has no MCP endpoint.",
  },
  {
    id: "error-method-code",
    name: "Unknown method uses -32601",
    category: "errors",
    required: true,
    specRef: "basic/index#error-codes",
    description:
      "Checks that the error returned for the unknown method carries exactly code -32601 (Method not found). MCP uses the standard JSON-RPC 2.0 codes for protocol failures and a server MUST use defined codes only with their specified meanings; -32600, -32000 or an application code here fail. A rejection is credited only when the conformant server/discover was served; a server that rejects everything fails this test as not evaluable.",
    recommendation:
      "Use -32601 for every unrecognised method name. Do not reuse -32600 (that is for malformed envelopes) or a generic -32000.",
  },
  {
    id: "error-invalid-jsonrpc",
    name: "Handles malformed JSON-RPC",
    category: "errors",
    required: false,
    specRef: "basic/index#requests",
    description:
      "POSTs a JSON object that is not a valid JSON-RPC request (no method, no id) with otherwise correct headers and expects a JSON-RPC error or a 4xx status. Requests MUST carry jsonrpc, method and a string or integer id; a result fails. A rejection is credited only when the conformant server/discover was served; a server that rejects everything fails this test as not evaluable. It is also not evaluable when something in front of the server answered in its place: a 401, a 403 carrying a Bearer challenge (an auth gate; a gateway's -32001 body included), a 429 still a 429 after one resend after Retry-After (capped at 2 s), a 5xx without -32600, or a 403 without a Bearer challenge that a conformant server/discover sent next to the probe could not get past either. That twin is sent with the same headers only for such a 403, is resent once on a 429, and credits the 403 only when it was served or drew a status the server itself chose (a 2xx, or a 4xx other than 401, 403 or 429); when it drew the same 403, a message naming Host/Origin validation is quoted. A -32600 on a 5xx passes, with a warning that a 4xx is expected.",
    recommendation:
      "Validate the envelope (jsonrpc === '2.0', method is a string, id is a string or integer when present) before dispatch and answer -32600 Invalid Request with HTTP 400. Use id: null only when the request id could not be read.",
    transports: ["http"],
  },
  {
    id: "error-invalid-json",
    name: "Handles invalid JSON body",
    category: "errors",
    required: false,
    specRef: "basic/index#error-codes",
    description:
      "POSTs a body that is not JSON ('{not json') with the standard headers and expects a parse error (-32700) or a 4xx status. A hang, a result, or a status below 400 carrying no JSON-RPC error (an HTML page on a 200) fails. A rejection is credited only when the conformant server/discover was served; a server that rejects everything fails this test as not evaluable. It is also not evaluable when something in front of the server answered in its place: a 401, a 403 carrying a Bearer challenge (an auth gate; a gateway's -32001 body included), a 429 still a 429 after one resend after Retry-After (capped at 2 s), a 5xx without -32700, or a 403 without a Bearer challenge that a conformant server/discover sent next to the probe could not get past either. That twin is sent with the same headers only for such a 403, is resent once on a 429, and credits the 403 only when it was served or drew a status the server itself chose (a 2xx, or a 4xx other than 401, 403 or 429); when it drew the same 403, a message naming Host/Origin validation is quoted. A -32700 on a 5xx passes, with a warning that a 4xx is expected.",
    recommendation:
      "Catch JSON parse failures and answer { code: -32700, message: 'Parse error' } with HTTP 400 and no id. Do not let the exception reach a generic 500 handler.",
    transports: ["http"],
  },
  {
    id: "error-parse-code",
    name: "Returns -32700 for invalid JSON",
    category: "errors",
    required: false,
    specRef: "basic/index#error-codes",
    description:
      "Checks that the response to the invalid-JSON body carries exactly code -32700 (Parse error), the JSON-RPC 2.0 code MCP reuses for unparsable input. A bare 400 with no JSON-RPC body passes with a warning; a different error code fails. A rejection is credited only when the conformant server/discover was served; a server that rejects everything fails this test as not evaluable.",
    recommendation:
      "Return exactly -32700 for JSON parse failures. Most JSON-RPC frameworks do this by default; check that a body-parser middleware is not converting the failure into its own error shape first.",
    transports: ["http"],
  },
  {
    id: "error-invalid-request-code",
    name: "Returns -32600 for invalid request",
    category: "errors",
    required: false,
    specRef: "basic/index#error-codes",
    description:
      "Checks that the malformed-envelope response carries exactly code -32600 (Invalid Request). A bare 400 without a JSON-RPC body passes with a warning; -32601 or -32602 for a message that has no method at all fails. A rejection is credited only when the conformant server/discover was served; a server that rejects everything fails this test as not evaluable.",
    recommendation:
      "Distinguish 'not a request' (-32600) from 'unknown method' (-32601) and 'bad params' (-32602). A message without a method field is -32600.",
    transports: ["http"],
  },
  {
    id: "error-missing-params",
    name: "tools/call without name returns error",
    category: "errors",
    required: false,
    specRef: "server/tools#error-handling",
    description:
      "Calls tools/call with params carrying only _meta (no name) and expects a JSON-RPC error, -32602 Invalid params expected. A request that fails the CallToolRequest schema is a protocol error and must not produce a result. Skipped when the server declares no tools. An error is credited only when the server wrote it; it fails as not evaluable when something in front of the server answered in its place: a 401, a 403 carrying a Bearer challenge (an auth gate; a gateway's -32001 body included), a 429 still a 429 after one resend after Retry-After (capped at 2 s), a 5xx without -32602, or a 403 without a Bearer challenge that a conformant server/discover sent next to the probe could not get past either. That twin is sent with the same headers only for such a 403, is resent once on a 429, and credits the 403 only when it was served or drew a status the server itself chose (a 2xx, or a 4xx other than 401, 403 or 429); when it drew the same 403, a message naming Host/Origin validation is quoted. A -32602 on a 5xx passes, with a warning that a 4xx is expected.",
    recommendation:
      "Validate tools/call params against the schema (name is required) and return -32602 when it is missing. Do not fall through to unknown-tool handling with an undefined name.",
  },
  {
    id: "tools-call-unknown",
    name: "Unknown tool name returns error",
    category: "errors",
    required: false,
    specRef: "server/tools#error-handling",
    description:
      "Calls tools/call with a tool name the server did not list and expects a JSON-RPC error (-32602 expected) or a result with isError: true. An unknown tool is a protocol error the model cannot fix; a successful result with empty content fails. Skipped when the server declares no tools.",
    recommendation:
      "Look the tool up before executing and return { code: -32602, message: 'Unknown tool: <name>' } when it is absent. Do not return content: [] for a tool that does not exist.",
  },
  {
    id: "error-capability-gated",
    name: "Rejects methods for undeclared capabilities",
    category: "errors",
    required: false,
    specRef: "server/discover#discoverresult",
    description:
      "Calls the list method (tools/list, resources/list, prompts/list) for every capability the discover result did NOT declare and expects a JSON-RPC error, -32601 expected. Capabilities are the contract for which methods exist; serving an undeclared one means clients cannot trust the discover result. Skipped when every capability is declared. Without a served server/discover no capability counts as declared and no answer can be judged against a declaration, so the list methods are still probed and their answers recorded, but the test fails as not evaluable. With one, a rejection counts only when it is the server's own: each method's 429 is resent once after Retry-After (capped at 2 s), and a 401, a 403 carrying a Bearer challenge (an auth gate; a gateway's -32001 body included), a 429 still a 429 after the resend, a 5xx without -32601, or a 403 without a Bearer challenge that a conformant server/discover could not get past either fails as not evaluable, the methods grouped by reason. That twin is sent at most once for all the methods, with the same headers and only for such a 403, is resent once on a 429, and credits the 403 only when it was served or drew a status the server itself chose (a 2xx, or a 4xx other than 401, 403 or 429). A -32601 on a 5xx passes, with a warning for each such method that a 4xx is expected.",
    recommendation:
      "Register a method handler only when you declare its capability, and let undeclared methods fall through to -32601 Method not found.",
  },
  {
    id: "error-invalid-cursor",
    name: "Handles invalid pagination cursor",
    category: "errors",
    required: false,
    specRef: "server/utilities/pagination#error-handling",
    description:
      "Sends a garbage cursor to the first list method the server supports and expects either a JSON-RPC error (-32602 expected, which is what the pagination page says an invalid cursor SHOULD produce) or a valid first page. A rejection is credited only when it is the server's own: a 429 is resent once after Retry-After (capped at 2 s), and a 401, a 403 carrying a Bearer challenge (an auth gate; a gateway's -32001 body included), a 429 still a 429 after the resend, a 5xx without -32602, or a 403 without a Bearer challenge that a conformant server/discover sent next to the probe could not get past either fails as not evaluable. That twin is sent with the same headers only for such a 403, is resent once on a 429, and credits the 403 only when it was served or drew a status the server itself chose (a 2xx, or a 4xx other than 401, 403 or 429); when it drew the same 403, a message naming Host/Origin validation is quoted. A -32602 on a 5xx is credited, with a warning that a 4xx is expected. A result on a 5xx, a crash, or a malformed result fails.",
    recommendation:
      "Validate cursors before decoding them and answer -32602 Invalid params for anything you did not issue. Falling back to the first page is tolerated but hides client bugs.",
  },
  {
    id: "error-id-echo",
    name: "Error responses echo the request id",
    category: "errors",
    required: false,
    specRef: "basic/index#error-responses",
    description:
      'Post-hoc scan of every JSON-RPC error response (a jsonrpc 2.0 message whose error object carries a numeric code; a gateway\'s {"error":"..."} or {"error":{"code":400,...}} body is not one) the server sent during the run: each one answering a request whose id was readable MUST carry that same id. A reply that echoes no id is attributed by timeline to the most recent send before it that could still draw a reply: a request that received neither its own reply (before or after the stray) nor an earlier id-less one, and whose exchange had not ended (an HTTP response the client finished reading, such as a subscriptions/listen stream it closed, or a request it cancelled), or a client notification or raw probe sent more recently than that. A notification or probe counts only while no request sent after it was answered before the stray arrived, and over HTTP only while its own exchange was open. When no send can still own the reply, it is a second answer to a request that already had its own, and it is blamed on the most recent request sent before it: a server that answers a request with its result and an id-less error fails in either frame order. Exempt: replies to the suite\'s raw malformed-body probes and to client notifications (there is no id to echo), a reply that arrives before the suite sent any request (a stray written at boot), and a reply WITHOUT an id on a transport-level rejection answered before the JSON-RPC layer read the request (HTTP 401/403/413/415/429). A present but wrong id -- retyped, or another request\'s -- fails whatever the status, and a null or missing id on the reply to a well-formed request fails whatever the error code, -32600 and -32700 included. With no error response to an id-bearing request the pass is flagged as a skip.',
    recommendation:
      "Copy the request id into every error response, including the validation failures (-32602, -32020, -32022) you produce before dispatch. Use id: null only when the body could not be parsed at all. An auth gate or proxy that rejects with 401/403 before reading the body is not held to this as long as it sends no id; an id it does send must be the request's own.",
  },
  {
    id: "error-retired-codes",
    name: "No retired error codes",
    category: "errors",
    required: false,
    specRef: "basic/index#error-codes",
    description:
      "Post-hoc scan of every error the server sent for the codes retired in 2026-07-28: -32002 (resource not found, replaced by -32602) and -32042 (URL elicitation required, replaced by MRTR). Implementations of this revision MUST NOT emit either; any occurrence fails. With no JSON-RPC error response at all the pass is flagged as a skip.",
    recommendation:
      "Grep your codebase for -32002 and -32042. Return -32602 for missing resources and express URL-mode elicitation as an inputRequests entry in an input_required result.",
  },

  // ── Schema Validation (10 tests) ─────────────────────────────────
  {
    id: "tools-schema",
    name: "All tools have name and inputSchema",
    category: "schema",
    required: false,
    specRef: "server/tools#tool",
    description:
      "Validates every listed tool has a name (1-128 characters of [A-Za-z0-9_.-], the SHOULD-level naming rule) and an inputSchema that is a JSON Schema object with type 'object'. inputSchema MUST be a valid JSON Schema object, not null. The list is fetched on demand when the corresponding feature tests did not run (--only schema); when that list call failed, skipped pointing at the -list test that reports it if that test is in the run, and failed with the recorded reason (--only schema, or --skip on the -list test) when it is not. A declared but empty list leaves nothing to validate: the pass is flagged as a skip.",
    recommendation:
      "Give every tool a name matching [A-Za-z0-9_.-]{1,128} and an inputSchema of { type: 'object', ... }. Use { type: 'object', additionalProperties: false } for tools with no parameters.",
  },
  {
    id: "tools-annotations",
    name: "Tool annotations are valid",
    category: "schema",
    required: false,
    specRef: "server/tools#tool",
    description:
      "If a tool carries annotations, validates that readOnlyHint, destructiveHint, idempotentHint and openWorldHint are booleans when present and that title, when present, is a string. Clients MUST treat annotations as untrusted hints, so a wrong type is a definition bug rather than a security control. The list is fetched on demand when the corresponding feature tests did not run (--only schema); when that list call failed, skipped pointing at the -list test that reports it if that test is in the run, and failed with the recorded reason (--only schema, or --skip on the -list test) when it is not. A declared but empty list leaves nothing to validate: the pass is flagged as a skip.",
    recommendation:
      "Keep annotation hints boolean and put the display name in the tool's top-level title (annotations.title is the lowest-precedence fallback). Remove annotations you do not mean.",
  },
  {
    id: "tools-title-field",
    name: "Tools include title field",
    category: "schema",
    required: false,
    specRef: "server/tools#tool",
    description:
      "Checks whether listed tools carry the optional title field, the human-readable display name clients prefer over name. A title that is present must be a string; tools without one are listed in the details but do not fail. The list is fetched on demand when the corresponding feature tests did not run (--only schema); when that list call failed, skipped pointing at the -list test that reports it if that test is in the run, and failed with the recorded reason (--only schema, or --skip on the -list test) when it is not. A declared but empty list leaves nothing to validate: the pass is flagged as a skip.",
    recommendation:
      "Add a short human-readable title to each tool. Display precedence is title, then annotations.title, then name.",
  },
  {
    id: "tools-output-schema",
    name: "Tools with outputSchema are valid",
    category: "schema",
    required: false,
    specRef: "server/tools#output-schema",
    description:
      "For tools that declare outputSchema, validates it is a JSON Schema object (a non-null object; type, $ref or a composition keyword may describe any JSON value). Unlike 2025-11-25 the root is no longer restricted to type 'object': array, string and other roots are valid because structuredContent may be any JSON value. The list is fetched on demand when the corresponding feature tests did not run (--only schema); when that list call failed, skipped pointing at the -list test that reports it if that test is in the run, and failed with the recorded reason (--only schema, or --skip on the -list test) when it is not. A declared but empty list leaves nothing to validate: the pass is flagged as a skip.",
    recommendation:
      "Declare outputSchema as a JSON Schema describing structuredContent, using whatever root type fits. Make sure structuredContent actually conforms -- servers MUST provide structured results that match the declared schema.",
  },
  {
    id: "prompts-schema",
    name: "Prompts have name field",
    category: "schema",
    required: false,
    specRef: "server/prompts#prompt",
    description:
      "Validates every listed prompt has a string name and that each entry in an arguments array has a name. Prompt arguments are matched by name in prompts/get and completion/complete, so a nameless argument is unreachable. The list is fetched on demand when the corresponding feature tests did not run (--only schema); when that list call failed, skipped pointing at the -list test that reports it if that test is in the run, and failed with the recorded reason (--only schema, or --skip on the -list test) when it is not. A declared but empty list leaves nothing to validate: the pass is flagged as a skip.",
    recommendation: "Give every prompt a name and every argument a name (plus description and required where useful).",
  },
  {
    id: "resources-schema",
    name: "Resources have uri and name",
    category: "schema",
    required: false,
    specRef: "server/resources#resource",
    description:
      "Validates every listed resource has a parseable URI and a string name. Custom URI schemes MUST conform to RFC 3986; an unparseable uri cannot be passed back to resources/read. The list is fetched on demand when the corresponding feature tests did not run (--only schema); when that list call failed, skipped pointing at the -list test that reports it if that test is in the run, and failed with the recorded reason (--only schema, or --skip on the -list test) when it is not. A declared but empty list leaves nothing to validate: the pass is flagged as a skip.",
    recommendation:
      "Ensure each resource has a valid absolute URI (scheme://...) and a name. Add mimeType, title and description where you can.",
  },
  {
    id: "schema-result-type",
    name: "Every result carries resultType",
    category: "schema",
    required: true,
    specRef: "basic/index#result-responses",
    description:
      "Post-hoc scan of every JSON-RPC result the server sent during the run: each result MUST include a string resultType that is 'complete' or 'input_required'. Any other value passes, with a warning naming it, only when server/discover advertised an extensions capability that could define it; without one it fails, since a resultType the client does not recognize MUST be treated as invalid. A result with no resultType is what a 2025-11-25 server returns and fails here (the reply to the suite's own legacy initialize probe is exempt). With no result recorded the pass is flagged as a skip.",
    recommendation:
      "Add resultType: 'complete' to every successful result, including subscriptions/listen closures and otherwise-empty results. Use 'input_required' only for InputRequiredResult, and any extension value only after advertising that extension in server/discover capabilities.",
  },
  {
    id: "schema-no-input-required-on-lists",
    name: "input_required only on MRTR methods",
    category: "schema",
    required: true,
    specRef: "basic/patterns/mrtr#supported-requests",
    description:
      "Post-hoc scan of every result with resultType 'input_required', traced back to the request that produced it. Servers MAY return an InputRequiredResult only for tools/call, prompts/get and resources/read and MUST NOT on any other request; an input_required result on server/discover, a list method, completion/complete or subscriptions/listen fails. With no result recorded the pass is flagged as a skip.",
    recommendation:
      "Return InputRequiredResult only from tool, prompt and resource-read handlers. List and discovery handlers must complete without client input.",
  },
  {
    id: "schema-input-required-shape",
    name: "InputRequiredResult is well-formed",
    category: "schema",
    required: false,
    specRef: "basic/patterns/mrtr#server-requirements-basic-workflow",
    description:
      "Post-hoc, opportunistic check of every input_required result observed against the MRTR server requirements: it MUST include at least one of inputRequests or requestState; each inputRequests value must be an object whose method is elicitation/create, sampling/createMessage or roots/list, with a params object for elicitation/create and sampling/createMessage (ListRootsRequest.params is optional); the client capability each method needs (elicitation, sampling, roots) MUST have been declared by the client -- this suite declares only elicitation, so a sampling/createMessage or roots/list input request fails; an elicitation/create's params.mode (form when absent) must be a mode the client's elicitation declaration covers -- this suite declares elicitation: {}, which is form only, so a url-mode request fails; requestState, when present, must be a string. Passes, flagged as a skip, when no input_required result was seen.",
    recommendation:
      "Build InputRequiredResult as { resultType: 'input_required', inputRequests: { key: { method, params } }, requestState }. Only request capabilities the client declared -- and, for elicitation, only the modes it declared (an empty elicitation object means form only) -- and treat requestState as attacker-controlled on the retry.",
  },
  {
    id: "schema-wire-valid",
    name: "Messages validate against the 2026-07-28 schema",
    category: "schema",
    required: false,
    specRef: "basic/index#schema",
    description:
      "Post-hoc validation of every recorded server message against the vendored 2026-07-28 JSON schema, dispatching by method for notifications, by resultType plus the originating request's method for results, and by error code for errors. Replies to the suite's raw malformed-body probes and to its legacy initialize probe are skipped, an error's id: null is treated as omitted (error-id-echo judges whether null was earned), and a non-JSON-RPC body on any HTTP 4xx or 5xx (an auth gate's 401, a header-validating intermediary's 400, a gateway's 502) is noted, not validated -- at 2xx the same body is the server's own answer and is. The TypeScript schema is the source of truth for every message; the details list the distinct violations, grouped by originating method and first schema error with a count, and overflow the rest to a warning. When nothing validatable was received the pass is flagged as a skip.",
    recommendation:
      "Compare your response types against schema.ts for the methods you implement and validate responses in your own tests with the published schema.json. Common misses: no resultType, no ttlMs/cacheScope on cacheable results, priority outside 0-1, and unknown content types.",
  },

  // ── Security: Auth & Transport (8 tests) ─────────────────────────
  {
    id: "security-auth-required",
    name: "Rejects unauthenticated requests",
    category: "security",
    required: false,
    specRef: "basic/authorization#token-handling",
    description:
      "Sends a fully conformant server/discover with the Authorization header removed and expects HTTP 401. Servers acting as OAuth 2.1 resource servers MUST answer missing or invalid tokens with 401. The probe is sent with or without --auth: a 401, or a 403 carrying a WWW-Authenticate Bearer challenge, passes either way (without --auth the details suggest passing it to exercise the rest of the auth tests), and a 2xx fails as an accepted unauthenticated request. Any other status fails too, worded for what it is rather than as an accepted request: a 4xx that is not 401/403 refused the request without asking for a credential (a wrong path, a gateway, a rate limiter), a 5xx is the server failing on the request, and a 3xx redirected it. A 403 without a Bearer challenge is also what Origin validation, the SDK's Host validation and gateways answer, so it passes only with --auth when the same server/discover carrying the credential got past the gate -- served, or answered at HTTP 2xx even with a JSON-RPC error such as -32021, which is the application answering (the details note that the spec expects 401); otherwise it fails as not evaluable: the details quote the server's message and, when that message names Host or Origin validation (the SDK's 'Invalid Host: ...') or the credentialed server/discover drew a 403 too, advise allowing the hostname you tested through rather than --auth; without --auth and without such a message they name --auth as the way to compare, and with --auth they name how the credentialed request was answered (its status and JSON-RPC error code). When the request gets no HTTP answer, a timeout or a connection that was never established fails as 'server unreachable'; a connection the server accepts and then closes without answering passes as a rejection only with --auth and when the same server/discover carrying the credential got past the gate, and otherwise fails as 'server unreachable'.",
    recommendation:
      "Require a Bearer token on every request to the MCP endpoint and answer 401 (with WWW-Authenticate) when it is missing. Authorization is per-request input in 2026-07-28; there is no session to carry it.",
    transports: ["http"],
  },
  {
    id: "security-www-authenticate",
    name: "401 responses include WWW-Authenticate",
    category: "security",
    required: false,
    specRef: "basic/authorization/authorization-server-discovery#protected-resource-metadata-discovery-requirements",
    description:
      'When the unauthenticated server/discover yields 401 (with or without --auth), checks for a WWW-Authenticate header. Servers MUST implement one of two discovery mechanisms, and the header form (Bearer resource_metadata="...") is the one clients try first; a 401 with no challenge leaves the client unable to locate the authorization server, and a challenge without resource_metadata, or whose resource_metadata is not an absolute http(s) URL (RFC 9728 section 5.1), passes with a warning. A 403 carrying a Bearer challenge is read as the refusal it is (the details name the HTTP 403). A bare 403 skips as not evaluable when security-auth-required could not attribute it to authentication, and passes as not applicable when it could (--auth, and the credentialed server/discover got past the gate). Skipped when no 401 was observed; a closed connection that security-auth-required counts as a rejection skips with a warning that clients need the 401 challenge (flagged as a skip: there is no challenge to check), and a request that got no answer fails as server unreachable.',
    recommendation:
      'Set WWW-Authenticate: Bearer resource_metadata="https://<host>/.well-known/oauth-protected-resource" (optionally with scope) on every 401, and serve that metadata document at the advertised URL.',
    transports: ["http"],
  },
  {
    id: "security-auth-malformed",
    name: "Rejects malformed auth credentials",
    category: "security",
    required: false,
    specRef: "basic/authorization#token-handling",
    description:
      "Sends two conformant server/discover requests in place of the configured credential: Authorization: Bearer aW52YWxpZC10b2tlbg, a well-formed token no authorization server issued, which MUST draw HTTP 401 (403 also passes); and a value outside the RFC 6750 b64token grammar, a malformed authorization request that the spec's error table lets a server answer with 400 Bad Request as well as 401 or 403. Servers MUST validate access tokens, including their audience. A server that accepts either credential fails, and so does one answering the well-formed invalid token with anything but 401/403; the details name both outcomes. When a probe gets no HTTP answer, a connection the server accepts and then closes counts as a rejection only when the same server/discover carrying the configured credential got past the gate (served, or answered at 2xx); a timeout, a refused connection, or a drop without that discover fails as 'server unreachable' (a wrong status on the other probe is reported instead). Requires --auth: without a credential the server accepts, rejecting invalid ones proves nothing. With --auth it still skips in two cases: as not evaluable when security-auth-required found a bare 403 it could not attribute to authentication (a Host guard or gateway refuses the invalid credentials with the same 403), and when the configured credential itself drew 401 on the setup server/discover, since a server that refuses every credential cannot show that it validates tokens. Only a pass turns into that second skip: an invalid credential the server accepts, or a wrong status, still fails.",
    recommendation:
      "Validate the token signature, expiry and audience (RFC 8707) on every request before dispatch. Answer 401 for a well-formed token that does not verify, 403 for a valid token lacking the required scope, and 400 (invalid_request) or 401 for a credential that is not even syntactically a bearer token.",
    transports: ["http"],
  },
  {
    id: "security-tls-required",
    name: "Enforces HTTPS/TLS",
    category: "security",
    required: false,
    specRef: "basic/authorization/security-considerations#communication-security",
    description:
      "If the server URL is https, sends the same modern server/discover over plain http to the same host and expects a refusal (a 4xx/5xx, or no plaintext answer at all: a refused, closed or silent connection) or a 301/302/307/308 redirect whose single Location resolves to an https URL; a redirect to http (a relative Location stays on http), without a Location, with an unparseable one or with several fails. Communication security follows OAuth 2.1: a bearer token on a plaintext connection is exposed to every intermediary. An http target fails outright (production servers should not be reachable in the clear).",
    recommendation:
      "Serve the MCP endpoint over TLS only. Redirect http to an https Location (301/308) or refuse the connection; never answer a POST with a result over plaintext.",
    transports: ["http"],
  },
  {
    id: "security-oauth-metadata",
    name: "Protected Resource Metadata endpoint exists",
    category: "security",
    required: false,
    specRef: "basic/authorization/authorization-server-discovery#authorization-server-location",
    description:
      "Locates RFC 9728 Protected Resource Metadata the way clients must: when the WWW-Authenticate challenge on the unauthenticated server/discover carries resource_metadata, that URL is fetched and nothing else -- clients MUST use it, so an advertised URL that is unreachable, non-200, non-JSON, missing resource or authorization_servers, or not an absolute http(s) URL fails outright (the details say when a valid document exists at a well-known location the challenge could point at). Only without a challenge URL are the well-known locations tried in spec order: /.well-known/oauth-protected-resource followed by the endpoint path, then the root; a legacy /.well-known/oauth-authorization-server hit then passes with a warning. Validates a JSON document with resource and a non-empty authorization_servers array, and warns when resource is not the MCP endpoint URL in canonical form (RFC 9728 section 3.3). MCP servers MUST implement one of the two discovery mechanisms and the document MUST name at least one authorization server. Runs without --auth when the unauthenticated request drew a 401, or a 403 carrying a Bearer challenge. Without --auth it skips otherwise: when that request was served (the server requires no auth), as not evaluable on a bare 403 (see security-auth-required), and on any other answer naming the status and suggesting --auth. With --auth the well-known locations are checked whatever that request drew; after a bare 403 security-auth-required could not attribute to authentication, the check skips as not evaluable when every well-known location and /.well-known/oauth-authorization-server drew that same 403 (a Host guard or gateway refusing every path), and a document found, or any other answer, decides as usual. Fails as 'server unreachable' when the unauthenticated request got no answer at all, except a connection closed without an answer that --auth and a credentialed server/discover that got past the gate pin on the missing credential, which goes on to the well-known locations.",
    recommendation:
      "Publish { resource: '<canonical MCP endpoint URI>', authorization_servers: ['https://as.example.com'] } at /.well-known/oauth-protected-resource/<endpoint path> or at the root, and point the WWW-Authenticate resource_metadata parameter at that document with an absolute URL (it may live anywhere, but once advertised it is the only URL clients try, so it must answer).",
    transports: ["http"],
  },
  {
    id: "security-token-in-uri",
    name: "Rejects auth tokens in query string",
    category: "security",
    required: false,
    specRef: "basic/authorization#token-requirements",
    description:
      "Sends a conformant server/discover with the Authorization header removed and the configured token placed in the URL query string (?access_token=...) and expects HTTP 401 (403, any other non-2xx status, or a 2xx carrying a JSON-RPC error as plain JSON or as an SSE event also passes; a 2xx result or other non-error body fails). A request that gets no HTTP answer fails as 'server unreachable', except a connection the server closes without answering after the credentialed server/discover got past the gate (served, or answered at 2xx), which passes as not accepted. Access tokens MUST NOT be included in the URI query string; a server that accepts them there teaches clients to leak tokens into logs and Referer headers. A refusal is read against the auth probes before it: a 401/403 skips as not evaluable when security-auth-required found a bare 403 it could not attribute to authentication (a Host guard or gateway answers this probe with the same 403), and a pass skips instead when the configured credential itself drew 401 on the setup server/discover (a token refused in the header proves nothing by being refused in the query string). A 2xx result fails whatever either says. Requires --auth.",
    recommendation:
      "Read credentials from the Authorization header only. Ignore access_token, token and similar query parameters entirely rather than treating them as a fallback.",
    transports: ["http"],
  },
  {
    id: "security-cors-headers",
    name: "CORS headers are restrictive",
    category: "security",
    required: false,
    specRef: "basic/transports/streamable-http#security-%26-endpoint",
    description:
      "Sends a conformant server/discover with an Origin header from a plausible web app and inspects Access-Control-Allow-Origin on the response. A wildcard (*) on an endpoint that accepts bearer credentials lets any page drive the server from a browser; specific origins, or no CORS headers at all, pass. When neither the OPTIONS preflight nor the POST gets an HTTP response there are no headers to inspect: the test fails as 'server unreachable', unless the server closed the connection on both while serving the same server/discover without an Origin, which passes as cross-origin requests refused.",
    recommendation:
      "Allow only the origins that legitimately embed a browser MCP client, or send no CORS headers at all for server-to-server deployments. Never combine Access-Control-Allow-Origin: * with Access-Control-Allow-Credentials.",
    transports: ["http"],
  },
  {
    id: "security-origin-validation",
    name: "Validates Origin header",
    category: "security",
    required: false,
    specRef: "basic/transports/streamable-http#security-%26-endpoint",
    description:
      "Sends a fully valid server/discover (correct headers and _meta) with Origin: https://evil-rebinding-attack.example.com so that the origin is the only defect, and expects HTTP 403. Servers MUST validate Origin on all incoming connections and MUST respond 403 Forbidden when it is present and invalid; that is the DNS-rebinding defence for locally bound servers. A 2xx fails. A 429 is a rate limiter answering before the server reads the request: the probe is resent once after Retry-After (capped at 2 s) and a second 429 fails as not evaluable. A 5xx fails as the server failing on the request rather than refusing it. A 401 or 403 counts only when the same server/discover without the Origin (the setup request) got past whatever stands in front of the server -- served, or answered at 2xx -- or drew a different status; when it drew the same status or no answer, that refusal is what an auth gate, a Host guard or a gateway answers every request with, and the check skips as not attributable to the Origin (see security-auth-required). Any other 4xx passes as rejected, and a 1xx or 3xx fails. A request that gets no HTTP answer fails as 'server unreachable'; a connection the server closes without answering passes only when the same server/discover without the Origin got past the gate.",
    recommendation:
      "Maintain an allowlist of origins and return 403 (optionally with an id-less JSON-RPC error body) for any Origin not on it. Requests without an Origin header (non-browser clients) may proceed.",
    transports: ["http"],
  },

  // ── Security: Input Validation (6 tests) ─────────────────────────
  {
    id: "security-command-injection",
    name: "Resists command injection in tool params",
    category: "security",
    required: false,
    specRef: "server/tools#security-considerations",
    description:
      "Calls one tool with OS command-injection payloads ('; cat /etc/passwd', '$(whoami)', backticks) in one string argument. Tools with a string argument are tiered by annotation -- readOnlyHint true, then destructiveHint false, then unannotated, then destructiveHint true -- and only the safest non-empty tier is searched, because the spec defaults destructiveHint to true: a tool that says nothing may write, so it is a last resort. Passed-over tools are named in a warning (destructive and unannotated separately), and when the probed tool is unannotated or destructive a warning says it was hit with live payloads. Within the tier a free-form string argument is chosen over an enum/const/pattern one, which no payload can satisfy. The tool's other required arguments are filled with placeholders that honour the schema (const/enum/default/examples, the first non-null type, minimum, minItems, minLength/format, nested required) so the payload reaches the handler (also warned), and x-mcp-header parameters are mirrored into Mcp-Param-* headers so the request stays valid. Results are inspected for evidence of execution (passwd lines, id output, directory listings) and the details count what came back: rejected (isError or rejection wording -- the only outcome counted as a defence), returned without evidence of execution, and never reached the tool (a JSON-RPC error or a timeout). A server that goes away on a payload fails naming the payload: the stdio child exits, or on HTTP the connection is closed or reset instead of answered and a follow-up server/discover is then neither served nor refused with 401 or 403. A 429 on that discover proves nothing by itself (a rate-limiting gateway answers for a backend that is gone), so the discover is retried once after Retry-After (at most 2 s, 1 s without a usable header) and counts only if the retry is served or refused with 401/403; a 413 or 415 on the small discover counts as gone. A drop the server outlives counts as never reached, with a warning naming what it may have been -- a WAF or IPS dropping the request, a keep-alive connection closed as it was sent, or a crash of one worker of a multi-process server (Node cluster, PM2, gunicorn) while the others still answer, which a black-box client cannot tell apart; a server already gone when a payload is sent (a dead child, a refused connection) fails as 'server unreachable'. On stdio a child that exits on a payload is replaced before the check returns: a fresh instance is spawned and sent a server/discover (within --startup-timeout), then one request that pins it to 2026-07-28 (the declared tools list, else the resources or prompts list, else ping). A warning names the check -- '<check>: the server exited on an injection payload sent to <tool>.<argument> and was restarted with a fresh server/discover, so the tests after it ran against the new instance.' -- or says what went wrong with the new instance (it failed to start, or its server/discover or the pinning request got no usable answer, and the checks after it may fail for that reason). The checks after it then measure the server, not a dead process. The child is restarted every time a check's own request kills it: under --retries a retry that kills the new instance restarts it again, so --retries never leaves the later checks running against a dead process (the harness runs a check at most retries+1 times, and identical warnings collapse into one). A child already gone before the check's own request is not restarted. When no payload reached the tool at all the test passes as inconclusive with a warning, flagged as a skip (it measured nothing), as does a server with no tool that takes a string argument. Servers MUST validate all tool inputs; a tool that echoes the payload back unexecuted passes. Skipped when the server declares or lists no tools; tools/list is fetched on demand under --only security, and when that call failed the test skips pointing at tools-list if that test is in the run, and fails with the recorded reason when it is not.",
    recommendation:
      "Never build shell strings from tool arguments. Use execFile/spawn with an argument array, parameterised APIs, or a strict allowlist, and return a tool error for anything outside the expected shape.",
  },
  {
    id: "security-sql-injection",
    name: "Resists SQL injection in tool params",
    category: "security",
    required: false,
    specRef: "server/tools#security-considerations",
    description:
      "Calls the same single target as security-command-injection with SQL-injection payloads (' OR 1=1 --, UNION SELECT, stacked statements), other required arguments filled with schema-honouring placeholders and x-mcp-header parameters mirrored into headers, and inspects results for database error text or unexpected row dumps. The details count rejected, benign and never-reached outcomes; only rejections count as a defence, and a run in which no payload reached the tool passes as inconclusive with a warning (flagged as a skip); a server that dies on a payload fails naming it (a stdio exit, the child then restarted for the checks after it as in security-command-injection; or on HTTP a dropped connection after which server/discover is neither served nor refused with 401/403, a 429 counting only when one retry after Retry-After is; a drop the server outlives -- a WAF or IPS, a keep-alive close, or one crashed worker of a multi-process server -- counts as never reached, with a warning), and one already unreachable fails as 'server unreachable'. Servers MUST validate all tool inputs and sanitise tool outputs. Skipped when the server declares or lists no tools; tools/list is fetched on demand under --only security, and when that call failed the test skips pointing at tools-list if that test is in the run, and fails with the recorded reason when it is not.",
    recommendation:
      "Use parameterised queries or prepared statements everywhere and never concatenate arguments into SQL. Return a generic tool error for database failures rather than the driver's message.",
  },
  {
    id: "security-path-traversal",
    name: "Resists path traversal in tool params",
    category: "security",
    required: false,
    specRef: "server/tools#security-considerations",
    description:
      "Calls one tool with path-traversal payloads (../../etc/passwd, ..\\\\..\\\\windows\\\\system.ini, URL-encoded variants) in one string argument, preferring an argument whose name suggests a path (path, file, dir, folder; then url, uri, href, endpoint, host) searched across the tools of the safest annotation tier only (readOnlyHint true first; see security-command-injection) -- a non-read-only tool's path argument is never chosen while a read-only tool has any string argument, since the spec defaults destructiveHint to true -- otherwise the shared injection target. Other required arguments are filled with schema-honouring placeholders and x-mcp-header parameters mirrored. Inspects results for file contents outside the tool's scope and counts rejected, benign and never-reached outcomes (all never-reached passes as inconclusive with a warning, flagged as a skip; a server that dies on a payload fails naming it (a stdio exit, the child then restarted for the checks after it as in security-command-injection; or on HTTP a dropped connection after which server/discover is neither served nor refused with 401/403, a 429 counting only when one retry after Retry-After is; a drop the server outlives -- a WAF or IPS, a keep-alive close, or one crashed worker of a multi-process server -- counts as never reached, with a warning), and one already unreachable fails as 'server unreachable'). Servers MUST validate inputs and, for file:// resources, MUST sanitise paths to prevent directory traversal. Skipped when the server declares or lists no tools; tools/list is fetched on demand under --only security, and when that call failed the test skips pointing at tools-list if that test is in the run, and fails with the recorded reason when it is not.",
    recommendation:
      "Resolve every path against a fixed base directory and reject results that escape it (path.resolve, then check the normalised result starts with the base). Reject '..' segments and null bytes outright.",
  },
  {
    id: "security-ssrf-internal",
    name: "Resists SSRF to internal networks",
    category: "security",
    required: false,
    specRef: "server/tools#security-considerations",
    description:
      "Submits internal targets (the 169.254.169.254 metadata service, 127.0.0.1, [::1], 10.0.0.1) to one string argument, preferring one whose name suggests a URL (url, uri, href, endpoint, host, link; then path, file, dir) searched across the tools of the safest annotation tier only (readOnlyHint true first; see security-command-injection); when no such argument exists the shared injection target is used, so the details always name the tool.argument probed. Other required arguments are filled with schema-honouring placeholders and x-mcp-header parameters mirrored. Inspects results for cloud-metadata or internal-service responses and counts rejected, benign and never-reached outcomes (all never-reached passes as inconclusive with a warning, flagged as a skip; a server that dies on a payload fails naming it (a stdio exit, the child then restarted for the checks after it as in security-command-injection; or on HTTP a dropped connection after which server/discover is neither served nor refused with 401/403, a 429 counting only when one retry after Retry-After is; a drop the server outlives -- a WAF or IPS, a keep-alive close, or one crashed worker of a multi-process server -- counts as never reached, with a warning), and one already unreachable fails as 'server unreachable'). Servers MUST validate all tool inputs; fetching internal addresses on a caller's behalf is server-side request forgery. Skipped when the server declares or lists no tools; tools/list is fetched on demand under --only security, and when that call failed the test skips pointing at tools-list if that test is in the run, and fails with the recorded reason when it is not.",
    recommendation:
      "Resolve the hostname and reject private, loopback, link-local and metadata addresses before connecting (and re-check after redirects). Prefer an allowlist of permitted hosts for outbound fetches.",
  },
  {
    id: "security-oversized-input",
    name: "Handles oversized inputs gracefully",
    category: "security",
    required: false,
    specRef: "server/tools#security-considerations",
    description:
      "Calls a tool with a string argument of roughly 1 MB in the first string argument that is not header-mirrored (an x-mcp-header value would also travel in an Mcp-Param-* header and measure the header limit instead of the body; such an argument is used only when no other exists, and the details say so; a tool with no string argument at all gets the value as 'data'), far beyond what any reasonable tool needs, and expects a prompt rejection: HTTP 413 or another 4xx on HTTP, or a JSON-RPC error on either transport. A 429 is a rate limiter answering before the server reads the request: the call is resent once after Retry-After (capped at 2 s) and a second 429 fails as not evaluable. A 401, or a 403 carrying a Bearer challenge that reads as an auth gate, fails as not evaluable; a 403 without one passes like any other 4xx, the tool list this call uses having come from a served server/discover. A completed result passes with a warning (the server survived), while a 5xx, a timeout, a broken stdio frame or no usable HTTP response at all (bytes that are not an HTTP response) fails. On HTTP a connection closed or reset on the 1 MB body passes as a connection-level rejection only when a follow-up server/discover is then served or refused with 401/403 (a 429 retried once, as in security-command-injection); otherwise it fails as a possible crash, and a connection refused before anything was sent fails as 'server unreachable'. On stdio a child that exits on the call (including partway through reading the 1 MB line) fails as died even if it first wrote a reply longer than the runner's 1 MiB line buffer; the child is then restarted for the checks after it, as in security-command-injection; such an overflow passes as survived (with a warning) only while the child is still running, and a child already gone before the call fails as 'server unreachable'. Skipped when the server declares or lists no tools; tools/list is fetched on demand under --only security, and when that call failed the test skips pointing at tools-list if that test is in the run, and fails with the recorded reason when it is not.",
    recommendation:
      "Enforce a request body limit (e.g. 1 MB) at the HTTP layer and return 413, and add maxLength to string properties in inputSchema so oversized arguments fail validation with -32602 before reaching the tool.",
  },
  {
    id: "security-extra-params",
    name: "Rejects or ignores extra tool params",
    category: "security",
    required: false,
    specRef: "server/tools#security-considerations",
    description:
      "Calls the first tool with arguments that include properties its inputSchema does not define and verifies the server either rejects them (-32602) or ignores them, without a 5xx, a malformed answer (no result or error), no usable HTTP response at all (bytes that are not an HTTP response), or a crash: a stdio child that exits (restarted for the checks after it, as in security-command-injection), or on HTTP a connection closed or reset without an answer after which server/discover is neither served nor refused with 401/403 (a 429 retried once, as in security-command-injection). A call that merely times out, and a dropped connection the server outlives (a WAF or IPS dropping the __proto__ payload, a keep-alive close, or a crash of one worker of a multi-process server), are inconclusive and pass with a warning, flagged as a skip (nothing was measured); a server already gone before the call (a refused connection, a dead child) fails as 'server unreachable'. Servers MUST validate tool inputs; unknown properties reaching internal functions are a classic parameter-injection vector. Skipped when the server declares or lists no tools; tools/list is fetched on demand under --only security, and when that call failed the test skips pointing at tools-list if that test is in the run, and fails with the recorded reason when it is not.",
    recommendation:
      "Validate arguments against inputSchema with additionalProperties: false, or strip unknown properties before use. Never spread raw arguments into internal calls.",
  },

  // ── Security: Tool Integrity (4 tests) ───────────────────────────
  {
    id: "security-tool-schema-defined",
    name: "All tools define inputSchema",
    category: "security",
    required: false,
    specRef: "server/tools#tool",
    description:
      "Verifies every listed tool has an inputSchema with type 'object'. inputSchema MUST be a valid JSON Schema object; a tool without one cannot have its arguments validated, so anything the model sends reaches the handler unchecked. Skipped when the server declares or lists no tools; tools/list is fetched on demand under --only security, and when that call failed the test skips pointing at tools-list if that test is in the run, and fails with the recorded reason when it is not.",
    recommendation:
      "Define inputSchema for every tool, listing each property with a type and marking required ones. Use { type: 'object', additionalProperties: false } for tools that take no arguments.",
  },
  {
    id: "security-tool-rug-pull",
    name: "Tool definitions are stable across calls",
    category: "security",
    required: false,
    specRef: "server/tools#capabilities",
    description:
      "Calls tools/list twice and compares the definitions (name, description, inputSchema, annotations). The set MUST NOT vary per-connection or as a side effect of other requests, and silently changing a definition between calls is the rug-pull pattern behind tool poisoning; a legitimate change is announced with notifications/tools/list_changed on a subscriptions/listen stream. On stdio, once an earlier check has killed the server and it was restarted, both lists come from the new process: the tools/list read when it was restarted (before any tools/call reached it), then, after one tools/call (the no-argument call tools-call sends to the same tool), a second one; the details name the check the restart followed. When the new process's list before use was not read, or that tools/call kills it too (it is then restarted again for the checks after), there are no two lists from one process to compare and the test skips with a warning. Skipped when the server declares no tools; tools/list is fetched on demand under --only security, and when that call failed the test skips pointing at tools-list if that test is in the run, and fails with the recorded reason when it is not.",
    recommendation:
      "Serve tool definitions from a stable registry and announce changes with notifications/tools/list_changed to subscribed clients. Never alter descriptions or schemas based on who is asking or how many times.",
  },
  {
    id: "security-tool-description-poisoning",
    name: "Tool descriptions free of injection patterns",
    category: "security",
    required: false,
    specRef: "server/tools#security-considerations",
    description:
      "Scans tool names, descriptions and parameter descriptions for prompt-injection patterns ('ignore previous instructions', 'system prompt', hidden Unicode such as zero-width and bidi controls, long Base64 runs). Tool text is rendered into the model context, so an injection here reaches every user of the server. Skipped when the server declares or lists no tools; tools/list is fetched on demand under --only security, and when that call failed the test skips pointing at tools-list if that test is in the run, and fails with the recorded reason when it is not.",
    recommendation:
      "Keep descriptions plain, factual and free of instructions to the model. Strip zero-width and bidi control characters and encoded blobs; if a tool needs usage rules, put them in the server's instructions field.",
  },
  {
    id: "security-tool-cross-reference",
    name: "Tools do not reference other tools by name",
    category: "security",
    required: false,
    specRef: "server/tools#security-considerations",
    description:
      "Checks that no tool description mentions another tool's name, case-insensitively. A name that cannot be an ordinary word (it contains an underscore, dot, hyphen or digit, or an internal capital) counts wherever it stands as a whole identifier, not inside a longer dotted or hyphenated one (fs.read.all does not mention fs.read); a plain-word name (a, get, search) counts only in code-like context: in backticks or quotes, as a call (search()), or as 'the search tool'. Cross-references let a description steer the model's tool selection and chain calls the user never asked for; a description should describe only the tool it belongs to. Skipped when the server declares no tools; tools/list is fetched on demand under --only security, and when that call failed the test skips pointing at tools-list if that test is in the run, and fails with the recorded reason when it is not.",
    recommendation:
      "Describe each tool on its own. Document multi-step workflows in the server's instructions field rather than inside individual tool descriptions.",
  },

  // ── Security: Information Disclosure (3 tests) ───────────────────
  {
    id: "security-error-no-stacktrace",
    name: "Error responses do not leak stack traces",
    category: "security",
    required: false,
    specRef: "basic/index#error-responses",
    description:
      "Triggers a range of failures (unknown method, malformed _meta, missing params, unknown tool, garbage cursor, and on HTTP an unparsable body) with conformant envelopes so the errors come from the server's own handlers rather than the transport layer, then scans every distinct error response the run received -- once each -- for stack traces, file paths (Unix and Windows, including the JSON-escaped form; a letter and a colon followed by a JSON escape, such as ERROR: before an escaped newline, is not a drive), module names, framework internals and database connection strings. One leak repeated across responses is reported once with a repeat count. Fails as 'server unreachable' when no probe was answered and the run recorded no server message. When no error response was received at all (the probes drew results or no answer, and the run recorded no JSON-RPC error), the pass is flagged as a skip. Error responses MAY carry data, but internals in it map the server for an attacker.",
    recommendation:
      "Return generic messages for unexpected failures and log the detail server-side. Strip stack traces, absolute paths and dependency names from every error's message and data before it leaves the process.",
  },
  {
    id: "security-error-no-internal-ip",
    name: "Error responses do not leak internal IPs",
    category: "security",
    required: false,
    specRef: "basic/index#error-responses",
    description:
      "Scans the same error responses for private and link-local IPv4 ranges (10.x, 172.16-31.x, 192.168.x, 127.x, 169.254.x), IPv6 loopback (::1, [::1]:port, ::1:port -- not a public address that merely ends in ::1), link-local and unique-local addresses, and internal hostnames (lowercase *.internal, *.local, *.corp, *.lan, *.intranet as the last label, with hostname context: two or more labels before the suffix, or a preceding //, @, getaddrinfo, ENOTFOUND or EAI_AGAIN, or a :port -- so ctx.internal, settings.local.json and api.corp-services.example.com are not flagged). Fails as 'server unreachable' when nothing was received. When no error response was received at all, the pass is flagged as a skip. Request bodies carry the full modern _meta so the errors originate from deeper layers such as upstream connectors, which is where addressing leaks.",
    recommendation:
      "Sanitise upstream connection errors before surfacing them (replace host:port with a generic 'upstream unavailable'). Configure your reverse proxy not to forward internal addressing into error bodies.",
  },
  {
    id: "security-rate-limiting",
    name: "Rate limiting is enforced",
    category: "security",
    required: false,
    specRef: "server/tools#security-considerations",
    description:
      "Sends a burst of 50 rapid tools/call requests to the first tool annotated readOnlyHint true that declares no required arguments and checks whether the server answers any of them with HTTP 429 Too Many Requests; the details name the method bursted and, for a tool, how many times it was invoked. Servers MUST rate limit tool invocations and SHOULD rate limit log and progress traffic; a 429 passes, and a burst where most responses are 5xx fails (the server should throttle, not fall over). A burst that draws no 429 passes with a warning on either path -- 50 requests cannot prove the absence of a limiter -- so annotating a tool readOnlyHint never lowers the grade. When no such tool exists, server/discover is bursted instead and the warning says tool invocations could not be exercised. Inconclusive cases are reported as such: a burst refused 401/403 on every request never reached a handler and skips. When every refusal reads as an auth refusal (a 401, or a 403 whose Bearer challenge asks for a credential -- with --auth, one whose challenge carries an error), the skip hints to pass --auth (or to check the credential when --auth was given); when any is a 403 that is no auth refusal, it names Host/Origin validation or a gateway and points at security-auth-required instead of the credential. No response at all fails as 'server unreachable'.",
    recommendation:
      "Apply a per-client (IP or token) limiter to tools/call and answer 429 with Retry-After when it is exceeded; a limiter in front of the whole endpoint satisfies the check too. Expose at least one read-only tool that needs no arguments if you want the burst to measure tool invocations rather than discovery -- the burst invokes that tool 50 times.",
    transports: ["http"],
  },
];
