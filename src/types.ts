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
  required: boolean;
  details: string;
  durationMs: number;
  specRef?: string;
}

export type Grade = "A" | "B" | "C" | "D" | "F";
export type Overall = "pass" | "partial" | "fail";

export interface ComplianceReport {
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
  };
  categories: Record<string, { passed: number; total: number }>;
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
}

/** All 78 test IDs with descriptions for the explain command */
export const TEST_DEFINITIONS: TestDefinition[] = [
  // ── Transport (13 tests) ─────────────────────────────────────────
  {
    id: "transport-post",
    name: "HTTP POST accepted",
    category: "transport",
    required: true,
    specRef: "basic/transports#streamable-http",
    description:
      "Verifies the server accepts HTTP POST requests and returns a 2xx status code. This is the fundamental transport requirement for Streamable HTTP MCP servers.",
    recommendation:
      "Ensure your server listens for POST requests on the MCP endpoint. If you see 401/403, pass --auth with a valid token. Check that the URL is correct and the server is running.",
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
      "Sends a POST with Content-Type: text/plain instead of application/json and verifies the server rejects it with a 4xx status.",
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
      "Sends a JSON-RPC batch request (array of messages) and verifies the server rejects it with an error. MCP does not support JSON-RPC batch requests.",
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

  // ── Lifecycle (15 tests) ─────────────────────────────────────────
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
      'Validates that the initialize response is a proper JSON-RPC 2.0 message with jsonrpc="2.0", an id field, and either a result or error field.',
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
      'Sends an initialize request with a future protocol version ("2099-01-01") and verifies the server either negotiates down to a version it supports or returns an error.',
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
      "Sends a second initialize request within the same session. Per spec, the client MUST NOT send initialize more than once. The server should reject it.",
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
      "Validates that content items returned by tools/call have a recognized type field (text, image, audio, resource, resource_link).",
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
      "Sends an unknown method and verifies the server returns a JSON-RPC error. The spec requires error code -32601 (Method not found).",
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
      "Sends a malformed JSON-RPC message (missing required fields) and verifies the server returns an error or 4xx status.",
    recommendation:
      "Validate incoming JSON-RPC messages for required fields (jsonrpc, method). Return error code -32600 (Invalid Request) or HTTP 400 for malformed messages.",
  },
  {
    id: "error-invalid-json",
    name: "Handles invalid JSON body",
    category: "errors",
    required: false,
    specRef: "basic",
    description: "Sends invalid JSON and verifies the server returns a parse error (-32700) or 4xx status code.",
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
      "Calls tools/call with an empty params object (missing required name field) and verifies an error is returned.",
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
      "Calls list methods (tools/list, resources/list, prompts/list) for capabilities the server did NOT declare, and verifies the server returns an error instead of success.",
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
      'Validates every tool has a valid name (1-128 chars, alphanumeric/underscore/hyphen/dot) and a required inputSchema of type "object".',
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
      "Validates tool annotation fields if present: readOnlyHint, destructiveHint, idempotentHint, openWorldHint should be booleans.",
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
      "Checks if tools include the optional title field for human-readable display names. Added in spec version 2025-11-25.",
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
      'If tools declare an outputSchema, validates it is a valid JSON Schema object with type "object". Used for structured output validation.',
    recommendation:
      'If you declare outputSchema on a tool, ensure it is a valid JSON Schema object with type: "object". Remove outputSchema if you do not need structured output.',
  },
  {
    id: "prompts-schema",
    name: "Prompts have name field",
    category: "schema",
    required: false,
    specRef: "server/prompts#data-types",
    description: "Validates every prompt has a name and that any arguments array contains items with name fields.",
    recommendation:
      "Ensure every prompt has a name field. If the prompt has arguments, each argument object must include a name field.",
  },
  {
    id: "resources-schema",
    name: "Resources have uri and name",
    category: "schema",
    required: false,
    specRef: "server/resources#data-types",
    description: "Validates every resource has a valid URI (parseable as a URL) and a name field.",
    recommendation:
      "Ensure every resource has a valid, parseable URI and a name field. Add description and mimeType for better client integration.",
  },

  // ── Security: Auth & Transport (9 tests) ─────────────────────────
  {
    id: "security-auth-required",
    name: "Rejects unauthenticated requests",
    category: "security",
    required: false,
    specRef: "basic/authorization",
    description:
      "Sends a request without an Authorization header and verifies the server returns HTTP 401. Servers exposed over the network should require authentication.",
    recommendation:
      "Implement authentication on your MCP endpoint. Return HTTP 401 Unauthorized for requests without valid credentials. Use OAuth 2.1 or Bearer tokens as recommended by the MCP spec.",
  },
  {
    id: "security-auth-malformed",
    name: "Rejects malformed auth credentials",
    category: "security",
    required: false,
    specRef: "basic/authorization",
    description:
      "Sends a request with a malformed Authorization header (garbage value) and verifies the server returns HTTP 401 or 403. Servers must validate auth tokens, not just check for presence.",
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
      "Verifies that presenting a valid MCP-Session-Id without an Authorization header is still rejected. Per spec, servers MUST NOT use sessions for authentication.",
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
      "Checks for a Protected Resource Metadata (RFC 9728) endpoint at /.well-known/oauth-protected-resource. Per MCP 2025-11-25, the MCP server publishes PRM with a resource identifier and authorization_servers array. Falls back to legacy /.well-known/oauth-authorization-server with a warning.",
    recommendation:
      "Publish a Protected Resource Metadata document at /.well-known/oauth-protected-resource on your server's origin. Include 'resource' (your server's URL) and 'authorization_servers' (array of OAuth AS URLs). See RFC 9728.",
  },
  {
    id: "security-token-in-uri",
    name: "Rejects auth tokens in query string",
    category: "security",
    required: false,
    specRef: "basic/authorization",
    description:
      "Sends a request with the auth token in the URL query string instead of the Authorization header. The MCP spec forbids transmitting credentials in URIs.",
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
      "If the server returns CORS headers, verifies that Access-Control-Allow-Origin is not set to wildcard (*). Wildcard CORS on an authenticated API allows cross-origin credential theft.",
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
      "Sends a request with a suspicious Origin header (https://evil-rebinding-attack.example.com) and verifies the server rejects it. Per spec, servers MUST validate the Origin header to prevent DNS rebinding attacks.",
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
      "Calls each tool with OS command injection payloads in string parameters (e.g., '; cat /etc/passwd', '$(whoami)'). Verifies the server does not execute injected commands.",
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
      'Calls each tool with SQL injection payloads in string parameters (e.g., "\' OR 1=1 --"). Verifies the server does not return database errors or unexpected data.',
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
      "Calls each tool with path traversal payloads in string parameters (e.g., '../../etc/passwd', '..\\\\..\\\\windows\\\\system.ini'). Verifies the server does not expose files outside its intended scope.",
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
      "For tools that accept URL parameters, submits internal IP addresses (169.254.169.254, 127.0.0.1, 10.0.0.0/8) and cloud metadata endpoints. Verifies the server blocks requests to internal networks.",
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
      "Sends a tools/call request with an extremely large argument value (1MB+ string). Verifies the server rejects it with an error instead of crashing or consuming excessive resources.",
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
      "Calls a tool with unexpected additional parameters beyond what the schema defines. Verifies the server either rejects them (strict) or silently ignores them (permissive) without errors.",
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
      "Verifies all tools have an inputSchema with type 'object'. Tools without schemas cannot have their inputs validated, creating an injection risk.",
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
      "Calls tools/list twice and compares the results. Tool definitions should not change between calls within the same session, which could indicate a rug-pull attack.",
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
      "Scans all tool names, descriptions, and parameter descriptions for prompt injection patterns: 'ignore previous', 'override', 'system prompt', hidden Unicode characters, and Base64-encoded strings.",
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
      "Triggers various error conditions and inspects responses for stack traces, file paths, and internal implementation details. Error responses should not reveal server internals.",
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
      "Inspects error response bodies for private IP addresses (10.x, 172.16-31.x, 192.168.x, 127.x) that would reveal internal network topology.",
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
      "Sends a burst of rapid requests and checks if the server eventually returns HTTP 429 Too Many Requests. Production servers should implement rate limiting to prevent abuse.",
    recommendation:
      "Implement rate limiting on your MCP endpoint. Return HTTP 429 with a Retry-After header when limits are exceeded. Consider per-IP, per-token, and per-session rate limits.",
  },
];
