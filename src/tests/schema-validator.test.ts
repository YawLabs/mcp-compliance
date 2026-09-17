import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  createWireValidator,
  formatViolation,
  getWireValidator,
  MAX_VIOLATIONS_PER_MESSAGE,
  patchJsonValueDef,
  RESULT_DEF_BY_METHOD,
  SCHEMA_KEY,
  type SchemaViolation,
} from "../modern/schema-validator.js";
import vendoredSchema from "../schemas/mcp-2026-07-28.schema.json";

const validator = createWireValidator();

const messages = (violations: SchemaViolation[]) => violations.map(formatViolation).join("\n");

/** Assert conformance with the full violation list in the failure text. */
function expectClean(violations: SchemaViolation[]) {
  expect(violations, messages(violations)).toEqual([]);
}

function expectViolation(violations: SchemaViolation[], def: string, path: string, fragment: string) {
  const hit = violations.find((v) => v.def === def && v.path === path && v.message.includes(fragment));
  expect(hit, `expected ${def} at "${path}" mentioning "${fragment}"; got:\n${messages(violations)}`).toBeDefined();
}

// ---------------------------------------------------------------------------
// Fixtures: copies of schema/2026-07-28/examples/<Def>/*.json (spec commit in
// src/schemas/README.md). Inlined so the test needs nothing outside the repo.
// ---------------------------------------------------------------------------

const discoverResponse = {
  jsonrpc: "2.0",
  id: "discover-1",
  result: {
    resultType: "complete",
    supportedVersions: ["2026-07-28"],
    capabilities: { tools: {}, resources: {} },
    _meta: { "io.modelcontextprotocol/serverInfo": { name: "ExampleServer", version: "1.0.0" } },
    ttlMs: 3600000,
    cacheScope: "public",
  },
};

const listToolsResponse = {
  jsonrpc: "2.0",
  id: "list-tools-example",
  result: {
    resultType: "complete",
    tools: [
      {
        name: "get_weather",
        title: "Weather Information Provider",
        description: "Get current weather information for a location",
        inputSchema: {
          type: "object",
          properties: { location: { type: "string", description: "City name or zip code" } },
          required: ["location"],
        },
        icons: [{ src: "https://example.com/weather-icon.png", mimeType: "image/png", sizes: ["48x48"] }],
      },
    ],
    nextCursor: "next-page-cursor",
    ttlMs: 3600000,
    cacheScope: "public",
  },
};

const callToolResponse = {
  jsonrpc: "2.0",
  id: "call-tool-example",
  result: {
    resultType: "complete",
    content: [{ type: "text", text: "Current weather in New York:\nTemperature: 72 F\nConditions: Partly cloudy" }],
    isError: false,
  },
};

/** examples/ReadResourceResultResponse/read-resource-result-response-with-ttl.json */
const readResourceResponse = {
  jsonrpc: "2.0",
  id: "read-resource-with-ttl-example",
  result: {
    resultType: "complete",
    contents: [
      {
        uri: "file:///project/src/main.rs",
        mimeType: "text/x-rust",
        text: 'fn main() {\n    println!("Hello world!");\n}',
      },
    ],
    ttlMs: 60000,
    cacheScope: "private",
  },
};

/**
 * examples/ReadResourceResultResponse/read-resource-result-response.json --
 * the spec's own example omits ttlMs/cacheScope, which ReadResourceResult
 * requires; it only "passes" upstream through the toothless union
 * (schema-diff section 9, pitfall 2).
 */
const readResourceResponseNoTtl = {
  jsonrpc: "2.0",
  id: "read-resource-example",
  result: {
    resultType: "complete",
    contents: [
      {
        uri: "file:///project/src/main.rs",
        mimeType: "text/x-rust",
        text: 'fn main() {\n    println!("Hello world!");\n}',
      },
    ],
  },
};

const getPromptResponse = {
  jsonrpc: "2.0",
  id: "get-prompt-example",
  result: {
    resultType: "complete",
    description: "Code review prompt",
    messages: [
      {
        role: "user",
        content: { type: "text", text: "Please review this Python code:\ndef hello():\n    print('world')" },
      },
    ],
  },
};

const completeResponse = {
  jsonrpc: "2.0",
  id: "completion-example",
  result: { resultType: "complete", completion: { values: ["flask"], total: 1, hasMore: false } },
};

const listResourcesResponse = {
  jsonrpc: "2.0",
  id: "list-resources-example",
  result: {
    resultType: "complete",
    resources: [
      {
        uri: "file:///project/src/main.rs",
        name: "main.rs",
        title: "Rust Software Application Main File",
        description: "Primary application entry point",
        mimeType: "text/x-rust",
        icons: [{ src: "https://example.com/rust-file-icon.png", mimeType: "image/png", sizes: ["48x48"] }],
      },
    ],
    nextCursor: "eyJwYWdlIjogM30=",
    ttlMs: 600000,
    cacheScope: "private",
  },
};

const listPromptsResponse = {
  jsonrpc: "2.0",
  id: "list-prompts-example",
  result: {
    resultType: "complete",
    prompts: [
      {
        name: "code_review",
        title: "Request Code Review",
        description: "Asks the LLM to analyze code quality and suggest improvements",
        arguments: [{ name: "code", description: "The code to review", required: true }],
        icons: [{ src: "https://example.com/review-icon.svg", mimeType: "image/svg+xml", sizes: ["any"] }],
      },
    ],
    nextCursor: "next-page-cursor",
    ttlMs: 600000,
    cacheScope: "public",
  },
};

const listResourceTemplatesResponse = {
  jsonrpc: "2.0",
  id: "list-resource-templates-example",
  result: {
    resultType: "complete",
    resourceTemplates: [
      {
        uriTemplate: "file:///{path}",
        name: "Project Files",
        title: "Project Files",
        description: "Access files in the project directory",
        mimeType: "application/octet-stream",
        icons: [{ src: "https://example.com/folder-icon.png", mimeType: "image/png", sizes: ["48x48"] }],
      },
    ],
    ttlMs: 3600000,
    cacheScope: "public",
  },
};

const listenClosedResponse = {
  jsonrpc: "2.0",
  id: "listen-1",
  result: { resultType: "complete", _meta: { "io.modelcontextprotocol/subscriptionId": "listen-1" } },
};

const listenAcknowledged = {
  jsonrpc: "2.0",
  method: "notifications/subscriptions/acknowledged",
  params: {
    _meta: { "io.modelcontextprotocol/subscriptionId": "listen-1" },
    notifications: { toolsListChanged: true, resourceSubscriptions: ["file:///project/config.json"] },
  },
};

const logNotification = {
  jsonrpc: "2.0",
  method: "notifications/message",
  params: {
    level: "error",
    logger: "database",
    data: { error: "Connection failed", details: { host: "localhost", port: 5432 } },
  },
};

const progressNotification = {
  jsonrpc: "2.0",
  method: "notifications/progress",
  params: { progressToken: "oivaizmir", progress: 50, total: 100, message: "Reticulating splines..." },
};

const resourceUpdatedNotification = {
  jsonrpc: "2.0",
  method: "notifications/resources/updated",
  params: { _meta: { "io.modelcontextprotocol/subscriptionId": "listen-1" }, uri: "file:///project/src/main.rs" },
};

const cancelledNotification = {
  jsonrpc: "2.0",
  method: "notifications/cancelled",
  params: { requestId: "123", reason: "User requested cancellation" },
};

const headerMismatchError = {
  jsonrpc: "2.0",
  id: 1,
  error: { code: -32020, message: "Header mismatch: Mcp-Name header value 'foo' does not match body value 'bar'" },
};

const unsupportedVersionError = {
  jsonrpc: "2.0",
  id: 1,
  error: {
    code: -32022,
    message: "Unsupported protocol version",
    data: { supported: ["2026-07-28", "2025-11-25"], requested: "1900-01-01" },
  },
};

const missingCapabilityError = {
  jsonrpc: "2.0",
  id: 1,
  error: {
    code: -32021,
    message: "Server requires the elicitation capability for this request",
    data: { requiredCapabilities: { elicitation: {} } },
  },
};

/** examples/InvalidParamsError/unknown-tool.json (a bare error), wrapped in an envelope. */
const invalidParamsResponse = {
  jsonrpc: "2.0",
  id: 7,
  error: { code: -32602, message: "Unknown tool: invalid_tool_name" },
};

/** examples/MethodNotFoundError/prompts-not-supported.json, wrapped. */
const methodNotFoundResponse = {
  jsonrpc: "2.0",
  id: 8,
  error: {
    code: -32601,
    message: "Prompts not supported",
    data: { reason: "Server does not support the prompts capability" },
  },
};

/** examples/InputRequiredResult/input-required-result-with-request-state-only.json, wrapped. */
const inputRequiredResponse = {
  jsonrpc: "2.0",
  id: 9,
  result: { resultType: "input_required", requestState: "eyJwcm9ncmVzcyI6IjUwJSIsInN0YXRlIjoicHJvY2Vzc2luZyJ9" },
};

const toolWithArrayOutput = {
  name: "list_users",
  title: "User List",
  description: "Returns a list of all users",
  inputSchema: { type: "object", properties: {} },
  outputSchema: {
    type: "array",
    items: {
      type: "object",
      properties: { id: { type: "string" }, name: { type: "string" }, email: { type: "string" } },
      required: ["id", "name", "email"],
    },
  },
};

const toolWithCompositionInput = {
  name: "find_resource",
  title: "Resource Finder",
  description: "Find a resource by ID or name",
  inputSchema: {
    type: "object",
    oneOf: [
      { properties: { id: { type: "string", description: "Resource ID" } }, required: ["id"] },
      { properties: { name: { type: "string", description: "Resource name" } }, required: ["name"] },
    ],
  },
};

// ---------------------------------------------------------------------------

describe("spec examples validate against their concrete def", () => {
  const cases: Array<[string, unknown, string | undefined]> = [
    ["DiscoverResultResponse", discoverResponse, "server/discover"],
    ["ListToolsResultResponse", listToolsResponse, "tools/list"],
    ["CallToolResultResponse", callToolResponse, "tools/call"],
    ["ReadResourceResultResponse (with ttl)", readResourceResponse, "resources/read"],
    ["GetPromptResultResponse", getPromptResponse, "prompts/get"],
    ["CompleteResultResponse", completeResponse, "completion/complete"],
    ["ListResourcesResultResponse", listResourcesResponse, "resources/list"],
    ["ListPromptsResultResponse", listPromptsResponse, "prompts/list"],
    ["ListResourceTemplatesResultResponse", listResourceTemplatesResponse, "resources/templates/list"],
    ["SubscriptionsListenResultResponse", listenClosedResponse, "subscriptions/listen"],
    ["InputRequiredResult (requestState only)", inputRequiredResponse, "tools/call"],
    ["SubscriptionsAcknowledgedNotification", listenAcknowledged, undefined],
    ["LoggingMessageNotification", logNotification, undefined],
    ["ProgressNotification", progressNotification, undefined],
    ["ResourceUpdatedNotification", resourceUpdatedNotification, undefined],
    ["CancelledNotification", cancelledNotification, undefined],
    ["HeaderMismatchError", headerMismatchError, undefined],
    ["UnsupportedProtocolVersionError", unsupportedVersionError, undefined],
    ["MissingRequiredClientCapabilityError", missingCapabilityError, undefined],
    ["InvalidParamsError (wrapped)", invalidParamsResponse, undefined],
    ["MethodNotFoundError (wrapped)", methodNotFoundResponse, undefined],
  ];
  for (const [name, message, requestMethod] of cases) {
    it(name, () => {
      expectClean(validator.validateServerMessage(message, { requestMethod }));
    });
  }

  it("Tool examples via validateAgainst (array outputSchema, root oneOf inputSchema)", () => {
    expectClean(validator.validateAgainst("Tool", toolWithArrayOutput));
    expectClean(validator.validateAgainst("Tool", toolWithCompositionInput));
  });

  it("ServerCapabilities examples via validateAgainst", () => {
    for (const caps of [
      { completions: {} },
      { extensions: { "io.modelcontextprotocol/tasks": {} } },
      { logging: {} },
      { prompts: { listChanged: true } },
      { resources: { subscribe: true, listChanged: true } },
      { tools: {} },
    ]) {
      expectClean(validator.validateAgainst("ServerCapabilities", caps));
    }
  });

  it("the spec's own ttl-less resources/read example is rejected by the concrete def (pitfall 2)", () => {
    const v = validator.validateServerMessage(readResourceResponseNoTtl, { requestMethod: "resources/read" });
    expectViolation(v, "ReadResourceResult", "/result", "ttlMs");
    expectViolation(v, "ReadResourceResult", "/result", "cacheScope");
  });
});

describe("dispatch", () => {
  it("method + id = server request -> JSONRPCRequest", () => {
    expectClean(validator.validateServerMessage({ jsonrpc: "2.0", id: 5, method: "roots/list" }));
    const v = validator.validateServerMessage({ jsonrpc: "1.0", id: 5, method: "roots/list" });
    expectViolation(v, "JSONRPCRequest", "/jsonrpc", '"2.0"');
  });

  it("known notification method -> its concrete def", () => {
    const v = validator.validateServerMessage({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progressToken: "t" },
    });
    expectViolation(v, "ProgressNotification", "/params", "progress");
    const log = validator.validateServerMessage({
      jsonrpc: "2.0",
      method: "notifications/message",
      params: { data: "x" },
    });
    expectViolation(log, "LoggingMessageNotification", "/params", "level");
    const ack = validator.validateServerMessage({
      jsonrpc: "2.0",
      method: "notifications/subscriptions/acknowledged",
      params: {},
    });
    expectViolation(ack, "SubscriptionsAcknowledgedNotification", "/params", "notifications");
    const cancel = validator.validateServerMessage({ jsonrpc: "2.0", method: "notifications/cancelled", params: {} });
    expectViolation(cancel, "CancelledNotification", "/params", "requestId");
    // Param-less list_changed notifications are valid bare.
    for (const method of [
      "notifications/tools/list_changed",
      "notifications/prompts/list_changed",
      "notifications/resources/list_changed",
    ]) {
      expectClean(validator.validateServerMessage({ jsonrpc: "2.0", method }));
    }
  });

  it("unknown notification method -> generic JSONRPCNotification", () => {
    expectClean(
      validator.validateServerMessage({ jsonrpc: "2.0", method: "notifications/com.example/custom", params: {} }),
    );
    const v = validator.validateServerMessage({ method: "notifications/com.example/custom" });
    expectViolation(v, "JSONRPCNotification", "", "jsonrpc");
  });

  it("notification and error maps are derived from the schema as expected", () => {
    expect(Object.fromEntries(validator.notificationDefs)).toEqual({
      "notifications/cancelled": "CancelledNotification",
      "notifications/message": "LoggingMessageNotification",
      "notifications/progress": "ProgressNotification",
      "notifications/prompts/list_changed": "PromptListChangedNotification",
      "notifications/resources/list_changed": "ResourceListChangedNotification",
      "notifications/resources/updated": "ResourceUpdatedNotification",
      "notifications/subscriptions/acknowledged": "SubscriptionsAcknowledgedNotification",
      "notifications/tools/list_changed": "ToolListChangedNotification",
    });
    expect(Object.fromEntries(validator.envelopeErrorDefs)).toEqual({
      [-32020]: "HeaderMismatchError",
      [-32021]: "MissingRequiredClientCapabilityError",
      [-32022]: "UnsupportedProtocolVersionError",
    });
    expect(Object.fromEntries(validator.bareErrorDefs)).toEqual({
      [-32700]: "ParseError",
      [-32600]: "InvalidRequestError",
      [-32601]: "MethodNotFoundError",
      [-32602]: "InvalidParamsError",
      [-32603]: "InternalError",
    });
    expect(Object.keys(RESULT_DEF_BY_METHOD)).toHaveLength(10);
    for (const def of Object.values(RESULT_DEF_BY_METHOD)) expect(validator.hasDef(def), def).toBe(true);
  });

  it("MCP error codes -> full-envelope defs", () => {
    const v = validator.validateServerMessage({ jsonrpc: "2.0", id: 1, error: { code: -32022, message: "nope" } });
    expectViolation(v, "UnsupportedProtocolVersionError", "/error", "data");
    const partial = validator.validateServerMessage({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32022, message: "nope", data: { supported: ["2026-07-28"] } },
    });
    expectViolation(partial, "UnsupportedProtocolVersionError", "/error/data", "requested");
    const cap = validator.validateServerMessage({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32021, message: "cap", data: {} },
    });
    expectViolation(cap, "MissingRequiredClientCapabilityError", "/error/data", "requiredCapabilities");
  });

  it("JSON-RPC error codes -> envelope + bare def on /error", () => {
    const v = validator.validateServerMessage({ jsonrpc: "2.0", id: 1, error: { code: -32602 } });
    expectViolation(v, "InvalidParamsError", "/error", "message");
    const bad = validator.validateServerMessage({ id: 1, error: { code: "-32601", message: "x" } });
    expectViolation(bad, "JSONRPCErrorResponse", "", "jsonrpc");
    expectViolation(bad, "JSONRPCErrorResponse", "/error/code", "integer");
  });

  it("implementation-defined error codes -> generic envelope only", () => {
    expectClean(
      validator.validateServerMessage({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "custom", data: 1 } }),
    );
    // id may be absent on an error response (parse errors)...
    expectClean(validator.validateServerMessage({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" } }));
    // ...but JSON-RPC's `id: null` convention is not a RequestId in this schema.
    const nullId = validator.validateServerMessage({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
    expectViolation(nullId, "JSONRPCErrorResponse", "/id", "got null");
  });

  it("result with requestMethod -> concrete def; unknown or absent -> Result", () => {
    const listWithoutTools = {
      jsonrpc: "2.0",
      id: 1,
      result: { resultType: "complete", ttlMs: 0, cacheScope: "public" },
    };
    expectViolation(
      validator.validateServerMessage(listWithoutTools, { requestMethod: "tools/list" }),
      "ListToolsResult",
      "/result",
      "tools",
    );
    expectClean(validator.validateServerMessage(listWithoutTools, { requestMethod: "com.example/unknown" }));
    expectClean(validator.validateServerMessage(listWithoutTools));
    expectClean(validator.validateServerMessage({ jsonrpc: "2.0", id: 1, result: { resultType: "complete" } }));
  });

  it("result without resultType fails even with no request context", () => {
    const v = validator.validateServerMessage({ jsonrpc: "2.0", id: 1, result: {} });
    expectViolation(v, "JSONRPCResultResponse", "/result", "resultType");
  });

  it("input_required -> InputRequiredResult plus the at-least-one rule", () => {
    const withRequests = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        resultType: "input_required",
        inputRequests: {
          q1: {
            method: "elicitation/create",
            params: { mode: "form", message: "Name?", requestedSchema: { type: "object", properties: {} } },
          },
        },
      },
    };
    expectClean(validator.validateServerMessage(withRequests, { requestMethod: "tools/call" }));
    // Same message on a cacheable method: the resultType branch wins, so
    // no ttlMs/cacheScope complaint. Whether input_required is ALLOWED on
    // that method is a policy check, not a schema one.
    expectClean(validator.validateServerMessage(withRequests, { requestMethod: "resources/read" }));

    const neither = validator.validateServerMessage(
      { jsonrpc: "2.0", id: 1, result: { resultType: "input_required" } },
      { requestMethod: "tools/call" },
    );
    expectViolation(neither, "InputRequiredResult", "/result", "at least one of inputRequests or requestState");

    const badShape = validator.validateServerMessage(
      { jsonrpc: "2.0", id: 1, result: { resultType: "input_required", requestState: 42 } },
      { requestMethod: "prompts/get" },
    );
    expectViolation(badShape, "InputRequiredResult", "/result/requestState", "string");
  });

  it("non-message shapes", () => {
    for (const bad of [null, "text", 42, [discoverResponse]]) {
      const v = validator.validateServerMessage(bad);
      expect(v).toHaveLength(1);
      expect(v[0].def).toBe("JSONRPCMessage");
    }
    expectViolation(
      validator.validateServerMessage({ jsonrpc: "2.0", id: 1 }),
      "JSONRPCMessage",
      "",
      "no method, result, or error",
    );
    expectViolation(
      validator.validateServerMessage({
        jsonrpc: "2.0",
        id: 1,
        result: { resultType: "complete" },
        error: { code: 1, message: "" },
      }),
      "JSONRPCResponse",
      "",
      "both result and error",
    );
  });

  it.each([
    [null, "null"],
    ["ok", '"ok"'],
    [42, "42"],
    [[], "[]"],
  ])("a non-object result (%j) skips the concrete def: only the envelope's 'must be object'", (result, got) => {
    // result: null is what generic JSON-RPC libraries return for a void handler.
    expect(validator.validateServerMessage({ jsonrpc: "2.0", id: 1, result }, { requestMethod: "tools/list" })).toEqual(
      [{ def: "JSONRPCResultResponse", path: "/result", message: `must be object (got ${got})` }],
    );
  });

  it.each([
    ["boom", '"boom"'],
    [null, "null"],
    [-32601, "-32601"],
    [[{ code: -32601, message: "x" }], '[{"code":-32601,"message":"x"}]'],
  ])("a non-object error member (%j) skips code dispatch: only the envelope's 'must be object'", (error, got) => {
    expect(validator.validateServerMessage({ jsonrpc: "2.0", id: 1, error })).toEqual([
      { def: "JSONRPCErrorResponse", path: "/error", message: `must be object (got ${got})` },
    ]);
  });
});

describe("negative cases", () => {
  const cacheable = { resultType: "complete", tools: [], ttlMs: 1000, cacheScope: "public" };
  const wrap = (result: unknown) => ({ jsonrpc: "2.0", id: 1, result });

  it("missing resultType (labelled with the concrete def when one applies)", () => {
    const { resultType: _omit, ...rest } = cacheable;
    void _omit;
    expectViolation(
      validator.validateServerMessage(wrap(rest), { requestMethod: "tools/list" }),
      "ListToolsResult",
      "/result",
      "resultType",
    );
  });

  it("missing ttlMs", () => {
    const { ttlMs: _omit, ...rest } = cacheable;
    void _omit;
    expectViolation(
      validator.validateServerMessage(wrap(rest), { requestMethod: "tools/list" }),
      "ListToolsResult",
      "/result",
      "ttlMs",
    );
  });

  it('cacheScope "shared" (enum message names the allowed values)', () => {
    const v = validator.validateServerMessage(wrap({ ...cacheable, cacheScope: "shared" }), {
      requestMethod: "tools/list",
    });
    expectViolation(v, "ListToolsResult", "/result/cacheScope", '"private", "public" (got "shared")');
  });

  it("ttlMs 1.5 and ttlMs -1", () => {
    const frac = validator.validateServerMessage(wrap({ ...cacheable, ttlMs: 1.5 }), { requestMethod: "tools/list" });
    expectViolation(frac, "ListToolsResult", "/result/ttlMs", "must be integer (got 1.5)");
    const neg = validator.validateServerMessage(wrap({ ...cacheable, ttlMs: -1 }), { requestMethod: "tools/list" });
    expectViolation(neg, "ListToolsResult", "/result/ttlMs", ">= 0");
  });

  it("-32022 without data", () => {
    const v = validator.validateServerMessage({ jsonrpc: "2.0", id: 1, error: { code: -32022, message: "x" } });
    expect(v.length).toBeGreaterThan(0);
    expect(v.every((x) => x.def === "UnsupportedProtocolVersionError")).toBe(true);
  });

  it("subscriptions/listen result without _meta.subscriptionId", () => {
    const noMeta = validator.validateServerMessage(wrap({ resultType: "complete" }), {
      requestMethod: "subscriptions/listen",
    });
    expectViolation(noMeta, "SubscriptionsListenResult", "/result", "_meta");
    const emptyMeta = validator.validateServerMessage(wrap({ resultType: "complete", _meta: {} }), {
      requestMethod: "subscriptions/listen",
    });
    expectViolation(emptyMeta, "SubscriptionsListenResult", "/result/_meta", "io.modelcontextprotocol/subscriptionId");
  });

  it("capability objects with null / float values PASS after the JSONValue patch", () => {
    const caps = {
      extensions: { "com.example/x": { flag: null, ratio: 0.5, nested: { list: [null, 1.25, "s", true] } } },
      logging: { level: 0.5 },
      experimental: { "com.example/y": { off: null } },
    };
    expectClean(validator.validateAgainst("ServerCapabilities", caps));
    expectClean(
      validator.validateServerMessage(wrap({ ...discoverResponse.result, capabilities: caps }), {
        requestMethod: "server/discover",
      }),
    );
    expectClean(validator.validateAgainst("ClientCapabilities", { elicitation: { form: { x: null } } }));
  });

  it("the unpatched upstream JSONValue really rejects null and floats (pins pitfall 3)", () => {
    // If this starts failing, upstream fixed the generator: drop the
    // patch (patchJsonValueDef will also throw on the new shape).
    const ajv = new Ajv2020({ strict: true, allowUnionTypes: true });
    addFormats(ajv);
    ajv.addSchema(vendoredSchema as unknown as Record<string, unknown>, "raw");
    const raw = ajv.getSchema("raw#/$defs/ServerCapabilities");
    expect(raw).toBeDefined();
    expect(raw!({ extensions: { "com.example/x": { flag: null } } })).toBe(false);
    expect(raw!({ logging: { level: 0.5 } })).toBe(false);
    expect(raw!({ logging: { level: 1 } })).toBe(true);
  });

  it("patchJsonValueDef refuses an unexpected shape", () => {
    expect(() => patchJsonValueDef({ $schema: "", $defs: { JSONValue: { type: "object" } } })).toThrow(/JSONValue/);
    expect(() => patchJsonValueDef({ $schema: "", $defs: {} })).toThrow(/JSONValue/);
  });

  it("a CallToolResult with no content fails, though the schema's union would accept it (pitfall 1)", () => {
    const msg = wrap({ resultType: "complete" });
    expectViolation(
      validator.validateServerMessage(msg, { requestMethod: "tools/call" }),
      "CallToolResult",
      "/result",
      "content",
    );
    // The union is the reason dispatch exists: same message, "valid".
    expectClean(validator.validateAgainst("CallToolResultResponse", msg));
  });

  it("content blocks are checked inside a CallToolResult", () => {
    const v = validator.validateServerMessage(wrap({ resultType: "complete", content: [{ type: "text" }] }), {
      requestMethod: "tools/call",
    });
    expectViolation(v, "CallToolResult", "/result/content/0", "text");
  });

  it("Tool without inputSchema.type", () => {
    const v = validator.validateAgainst("Tool", { name: "t", inputSchema: {} });
    expectViolation(v, "Tool", "/inputSchema", "type");
  });

  it("unknown def name", () => {
    expect(validator.hasDef("NoSuchDef")).toBe(false);
    const v = validator.validateAgainst("NoSuchDef", {});
    expect(v).toEqual([{ def: "NoSuchDef", path: "", message: 'unknown schema definition "NoSuchDef"' }]);
  });
});

describe("output hygiene", () => {
  it("dedupes identical path + message pairs across the envelope and concrete passes", () => {
    const v = validator.validateServerMessage(
      { jsonrpc: "2.0", id: 1, result: { tools: [] } },
      { requestMethod: "tools/list" },
    );
    expect(v.filter((x) => x.message.includes("resultType"))).toHaveLength(1);
  });

  it("caps at MAX_VIOLATIONS_PER_MESSAGE with a sentinel", () => {
    const tools = Array.from({ length: 40 }, (_, i) => ({ name: `t${i}` }));
    const v = validator.validateServerMessage(
      { jsonrpc: "2.0", id: 1, result: { resultType: "complete", tools, ttlMs: 0, cacheScope: "public" } },
      { requestMethod: "tools/list" },
    );
    expect(v).toHaveLength(MAX_VIOLATIONS_PER_MESSAGE);
    expect(v[MAX_VIOLATIONS_PER_MESSAGE - 1].message).toMatch(/^\.\.\. and \d+ more violation\(s\) suppressed$/);
    expect(v[0].path).toBe("/result/tools/0");
  });

  it("messages carry the expected constant and the observed value", () => {
    const v = validator.validateServerMessage({ jsonrpc: "2.0", id: 1, result: { resultType: 7 } });
    expectViolation(v, "JSONRPCResultResponse", "/result/resultType", "must be string (got 7)");
    expect(formatViolation(v[0])).toBe("JSONRPCResultResponse at /result/resultType: must be string (got 7)");
    expect(formatViolation({ def: "X", path: "", message: "m" })).toBe("X: m");
    expect(formatViolation({ def: "", path: "", message: "sentinel" })).toBe("sentinel");
  });

  it("getWireValidator shares one compiled instance", () => {
    expect(getWireValidator()).toBe(getWireValidator());
    expect(getWireValidator().hasDef("Implementation")).toBe(true);
  });

  it("the vendored schema is the draft 2020-12 document keyed as expected", () => {
    expect(vendoredSchema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(SCHEMA_KEY).toBe("mcp-2026-07-28");
    expect(Object.keys(vendoredSchema.$defs)).toHaveLength(155);
  });
});
