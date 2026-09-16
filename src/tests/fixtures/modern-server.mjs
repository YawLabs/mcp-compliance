#!/usr/bin/env node
/**
 * Hand-rolled MCP server speaking spec 2026-07-28 (the "modern" era), used
 * by the vitest suites for the 2026-07-28 compliance tests. No SDK, on
 * purpose: every byte on the wire is under test control, including the
 * deliberate violations behind the break knobs below.
 *
 *   node modern-server.mjs           stdio: newline-delimited JSON-RPC on stdin/stdout
 *   node modern-server.mjs --http    HTTP on 127.0.0.1, random port. Prints exactly one
 *                                    line `MODERN_FIXTURE_PORT=<port>` to stdout, then
 *                                    serves POST /mcp. `--port <n>` pins the port. Exits on
 *                                    SIGTERM/SIGINT and when stdin closes (spawn it with a
 *                                    stdin pipe, not "ignore").
 *
 * Env:
 *   MODERN_FIXTURE_BREAK=knob,knob   each knob flips exactly one behaviour so a compliance
 *                                    test can be shown to FAIL (see KNOBS below)
 *   MODERN_FIXTURE_AUTH=<token>      HTTP only: require `Authorization: Bearer <token>`;
 *                                    401 + WWW-Authenticate otherwise, and serve the
 *                                    protected-resource metadata document
 *
 * One JSON-RPC core, two thin transports: the core returns an "outcome"
 * (single response / response stream / held-open listen stream) and each
 * transport renders it, so every knob behaves identically over stdio and
 * HTTP. HTTP-only rules (headers, status codes, Origin, Content-Type) live
 * in the HTTP layer.
 */

import { createServer } from "node:http";
import { createInterface } from "node:readline";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const HTTP_MODE = argv.includes("--http");
const portFlag = argv.indexOf("--port");
const PINNED_PORT = portFlag !== -1 ? Number(argv[portFlag + 1]) || 0 : 0;
const AUTH_TOKEN = process.env.MODERN_FIXTURE_AUTH || "";

/** Every knob the contract defines. Unknown knobs are rejected up front so a typo cannot silently test nothing. */
const KNOBS = new Set([
  "no-caching",
  "bad-caching",
  "no-result-type",
  "no-server-info",
  "no-discover",
  "discover-missing-versions",
  "accept-missing-meta",
  "meta-error-wrong-code",
  "require-client-info",
  "accept-any-version",
  "wrong-version-error",
  "version-error-no-data",
  "accept-header-mismatch",
  "header-error-wrong-code",
  "header-error-200",
  "unknown-method-200",
  "removed-methods-served",
  "initialize-ok",
  "initialize-vague",
  "log-without-level",
  "no-listen-ack",
  "listen-silent",
  "listen-untagged",
  "listen-ignores-filter",
  "unstable-tool-order",
  "input-required-on-list",
  "input-required-empty",
  "input-request-bad-method",
  "ignore-client-capabilities",
  "capability-error-bad-shape",
  "accept-tampered-state",
  "resource-not-found-legacy",
  "resource-not-found-no-uri",
  "empty-contents-not-found",
  "server-request-on-stream",
  "retired-codes",
  "no-id-echo",
  "wrong-id-type",
  "get-sse",
  "delete-ok",
  "mint-session",
  "batch-ok",
  "any-content-type",
  "notification-200",
  "no-origin-check",
  "stacktrace-errors",
  "internal-ip-errors",
  "injection-echo",
  "capabilities-mismatch",
  "boolean-capability",
  "completion-rejects-argument",
  "completion-no-values",
  "prompts-list-error",
  "templates-list-error",
  "tool-no-input-schema",
  "unicode-broken",
  "slow-discover",
]);

const BREAK = new Set(
  (process.env.MODERN_FIXTURE_BREAK ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
for (const knob of BREAK) {
  if (!KNOBS.has(knob)) {
    process.stderr.write(`modern-server: unknown MODERN_FIXTURE_BREAK knob "${knob}"\n`);
    process.exit(2);
  }
}
const broken = (knob) => BREAK.has(knob);

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

const MODERN = "2026-07-28";
const LEGACY = "2025-11-25";
const SERVER_INFO = { name: "modern-fixture", version: "0.0.1" };
const INSTRUCTIONS = "Fixture server for mcp-compliance tests.";

const META = {
  protocolVersion: "io.modelcontextprotocol/protocolVersion",
  clientCapabilities: "io.modelcontextprotocol/clientCapabilities",
  clientInfo: "io.modelcontextprotocol/clientInfo",
  logLevel: "io.modelcontextprotocol/logLevel",
  serverInfo: "io.modelcontextprotocol/serverInfo",
  subscriptionId: "io.modelcontextprotocol/subscriptionId",
};

const CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  HEADER_MISMATCH: -32020,
  MISSING_CLIENT_CAPABILITY: -32021,
  UNSUPPORTED_VERSION: -32022,
  // Retired in 2026-07-28; only ever emitted by a break knob.
  LEGACY_RESOURCE_NOT_FOUND: -32002,
  LEGACY_URL_ELICITATION: -32042,
};

const CACHEABLE = new Set([
  "server/discover",
  "tools/list",
  "prompts/list",
  "resources/list",
  "resources/templates/list",
  "resources/read",
]);

const REMOVED_METHODS = new Set(["ping", "logging/setLevel", "resources/subscribe", "resources/unsubscribe"]);

/** Methods whose `Mcp-Name` header mirrors a params field. */
const NAME_HEADER_SOURCE = { "tools/call": "name", "prompts/get": "name", "resources/read": "uri" };

const BASE64_PREFIX = "=?base64?";
const BASE64_SUFFIX = "?=";

function supportedVersions() {
  return broken("initialize-ok") ? [MODERN, LEGACY] : [MODERN];
}

function serverCapabilities() {
  const caps = {
    tools: { listChanged: true },
    resources: { listChanged: true, subscribe: true },
    prompts: { listChanged: true },
    completions: {},
  };
  if (broken("capabilities-mismatch")) delete caps.prompts;
  // A boolean where the spec requires an object: clients read it as undeclared.
  if (broken("boolean-capability")) caps.tools = true;
  return caps;
}

// ---------------------------------------------------------------------------
// Catalog: tools, resources, prompts
// ---------------------------------------------------------------------------

const readOnly = { readOnlyHint: true };
const noArgs = { type: "object", properties: {} };

const TOOLS = [
  {
    name: "echo",
    title: "Echo",
    description: "Echo a message back to the caller",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string", description: "Text to echo" } },
      required: ["message"],
    },
    annotations: readOnly,
  },
  {
    name: "add",
    title: "Add",
    description: "Add two integers and return the sum as structured content",
    inputSchema: {
      type: "object",
      properties: { a: { type: "integer" }, b: { type: "integer" } },
      required: ["a", "b"],
    },
    outputSchema: { type: "integer" },
    annotations: readOnly,
  },
  {
    name: "content_types",
    title: "Content types",
    description: "Return one content block of every type",
    inputSchema: noArgs,
    annotations: readOnly,
  },
  {
    name: "progress",
    title: "Progress",
    description: "Emit three progress notifications when a progressToken is supplied",
    inputSchema: noArgs,
    annotations: readOnly,
  },
  {
    name: "logger",
    title: "Logger",
    description: "Emit one log notification when the request opted into logging",
    inputSchema: noArgs,
    annotations: readOnly,
  },
  {
    name: "needs_input",
    title: "Needs input",
    description: "Ask for the caller's name via elicitation (multi round-trip)",
    inputSchema: noArgs,
    annotations: readOnly,
  },
  {
    name: "needs_sampling",
    title: "Needs sampling",
    description: "Ask the client to sample a completion (multi round-trip)",
    inputSchema: noArgs,
    annotations: readOnly,
  },
  {
    name: "regional",
    title: "Regional query",
    description: "Run a query in a region; the region is mirrored into the Mcp-Param-Region header",
    inputSchema: {
      type: "object",
      properties: {
        region: { type: "string", description: "Region to run in", "x-mcp-header": "Region" },
        query: { type: "string", description: "Query to run" },
      },
      required: ["region", "query"],
    },
    annotations: readOnly,
  },
  {
    name: "fail",
    title: "Fail",
    description: "Always returns a tool execution error",
    inputSchema: noArgs,
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  {
    name: "trigger_tools_changed",
    title: "Trigger tools changed",
    description: "Send notifications/tools/list_changed to every listen stream that asked for it",
    inputSchema: noArgs,
    annotations: readOnly,
  },
  {
    name: "trigger_prompts_changed",
    title: "Trigger prompts changed",
    description: "Send notifications/prompts/list_changed to every listen stream that asked for it",
    inputSchema: noArgs,
    annotations: readOnly,
  },
];

const RESOURCES = [
  { uri: "test://static-text", name: "static-text", mimeType: "text/plain" },
  { uri: "test://static-binary", name: "static-binary", mimeType: "application/octet-stream" },
];

const RESOURCE_TEMPLATES = [{ uriTemplate: "test://template/{id}/data", name: "template" }];

const PROMPTS = [
  { name: "simple", description: "A simple prompt" },
  { name: "greet", description: "Greets someone", arguments: [{ name: "name", required: true }] },
];

// 1x1 transparent PNG.
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** A valid 44-byte WAV header with no samples: enough for a decoder to accept it. */
function minimalWav() {
  const b = Buffer.alloc(44);
  b.write("RIFF", 0);
  b.writeUInt32LE(36, 4);
  b.write("WAVE", 8);
  b.write("fmt ", 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(8000, 24); // sample rate
  b.writeUInt32LE(16000, 28); // byte rate
  b.writeUInt16LE(2, 32); // block align
  b.writeUInt16LE(16, 34); // bits per sample
  b.write("data", 36);
  b.writeUInt32LE(0, 40);
  return b.toString("base64");
}
const WAV_EMPTY = minimalWav();

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const isRequestId = (v) => typeof v === "string" || typeof v === "number";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The id to put on a response: knobs can drop it or change its type. */
function outId(id, isError) {
  if (isError && broken("no-id-echo")) return null;
  if (broken("wrong-id-type") && typeof id === "number") return String(id);
  return id;
}

/** Error messages stay short; two knobs make them leak things a real server must not. */
function decorateMessage(text) {
  let m = text;
  if (broken("stacktrace-errors")) m += "\n    at Object.<anonymous> (/home/user/app/server.js:10:5)";
  if (broken("internal-ip-errors")) m += " (upstream 10.0.0.1)";
  return m;
}

function errorResponse(id, code, message, data) {
  const error = { code, message: decorateMessage(message) };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id: outId(id, true), error };
}

/** Outcome: a single JSON-RPC error. `status` is the HTTP status; stdio ignores it. */
function errorOutcome(id, code, message, { status = 200, data } = {}) {
  return { kind: "json", status, message: errorResponse(id, code, message, data) };
}

/** A handler that failed server-side: -32603 on HTTP 500. */
function internalError(id, what) {
  return errorOutcome(id, -32603, `Internal error: ${what}`, { status: 500 });
}

/**
 * Every result carries `resultType` and `_meta.serverInfo`; results of the
 * cacheable methods also carry `ttlMs` + `cacheScope`. A `resultType` the
 * handler set (input_required) is kept.
 */
function finishResult(method, result) {
  const out = { ...result };
  if (broken("no-result-type")) delete out.resultType;
  else if (out.resultType === undefined) out.resultType = "complete";
  if (!broken("no-server-info")) out._meta = { ...(out._meta ?? {}), [META.serverInfo]: SERVER_INFO };
  if (CACHEABLE.has(method)) {
    if (broken("bad-caching")) {
      out.ttlMs = -1;
      out.cacheScope = "shared";
    } else if (!broken("no-caching")) {
      out.ttlMs = 60000;
      out.cacheScope = "public";
    }
  }
  return out;
}

function resultResponse(id, method, result) {
  return { jsonrpc: "2.0", id: outId(id, false), result: finishResult(method, result) };
}

function resultOutcome(id, method, result) {
  return { kind: "json", status: 200, message: resultResponse(id, method, result) };
}

function textResult(text, extra = {}) {
  return { content: [{ type: "text", text }], ...extra };
}

function methodNotFound(id, message) {
  return errorOutcome(id, CODES.METHOD_NOT_FOUND, message, { status: broken("unknown-method-200") ? 200 : 404 });
}

function headerError(id, message) {
  return errorOutcome(id, broken("header-error-wrong-code") ? CODES.INVALID_PARAMS : CODES.HEADER_MISMATCH, message, {
    status: broken("header-error-200") ? 200 : 400,
  });
}

function unsupportedVersion(id, requested) {
  if (broken("wrong-version-error")) {
    return errorOutcome(id, CODES.INVALID_PARAMS, `Unsupported protocol version: ${requested}`, { status: 400 });
  }
  return errorOutcome(id, CODES.UNSUPPORTED_VERSION, `Unsupported protocol version: ${requested}`, {
    status: 400,
    data: broken("version-error-no-data") ? undefined : { supported: supportedVersions(), requested },
  });
}

function missingCapability(id, required) {
  const names = Object.keys(required).join(", ");
  return errorOutcome(id, CODES.MISSING_CLIENT_CAPABILITY, `Missing required client capability: ${names}`, {
    status: 400,
    data: broken("capability-error-bad-shape") ? undefined : { requiredCapabilities: required },
  });
}

/** Notification builder; `subscriptionId` tags listen-stream traffic unless a knob strips it. */
function notification(method, params = {}, subscriptionId) {
  const p = { ...params };
  if (subscriptionId !== undefined && !broken("listen-untagged")) {
    p._meta = { ...(p._meta ?? {}), [META.subscriptionId]: subscriptionId };
  }
  return { jsonrpc: "2.0", method, params: p };
}

// ---------------------------------------------------------------------------
// Header value decoding (Streamable HTTP "Value Encoding")
// ---------------------------------------------------------------------------

/**
 * Decode a possibly `=?base64?...?=` sentinel-encoded header value. Returns
 * undefined for a sentinel whose payload is not canonical base64 (bad
 * padding, stray characters): the spec requires rejecting a recognized
 * header that carries invalid characters, and Buffer.from() is too lenient
 * to notice on its own.
 */
function decodeHeaderValue(value) {
  const v = value.trim();
  if (!(v.startsWith(BASE64_PREFIX) && v.endsWith(BASE64_SUFFIX))) return v;
  const inner = v.slice(BASE64_PREFIX.length, v.length - BASE64_SUFFIX.length);
  if (inner.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(inner)) return undefined;
  return Buffer.from(inner, "base64").toString("utf8");
}

/**
 * Standard-header validation (Streamable HTTP "Server Validation"). Node
 * lower-cases header names, which gives the case-insensitive name match for
 * free; values are compared case-sensitively after OWS trimming. Returns a
 * problem description, or undefined when the headers are consistent with the
 * body. Deliberately does NOT look at the `_meta` version when it is absent:
 * a missing `_meta` is an invalid-params problem (-32602), not a mismatch.
 */
function headerProblem(headers, msg, params, meta) {
  const headerVersion = headers["mcp-protocol-version"];
  if (typeof headerVersion !== "string" || headerVersion.trim() === "") {
    return "Missing MCP-Protocol-Version header";
  }
  const headerMethod = headers["mcp-method"];
  if (typeof headerMethod !== "string" || headerMethod.trim() === "") return "Missing Mcp-Method header";
  if (headerMethod.trim() !== msg.method) {
    return `Header mismatch: Mcp-Method header value '${headerMethod.trim()}' does not match body method '${msg.method}'`;
  }
  const nameField = NAME_HEADER_SOURCE[msg.method];
  if (nameField && typeof params[nameField] === "string") {
    const raw = headers["mcp-name"];
    if (typeof raw !== "string") return `Missing Mcp-Name header for ${msg.method}`;
    const decoded = decodeHeaderValue(raw);
    if (decoded === undefined) return "Header mismatch: Mcp-Name header value is not valid Base64";
    if (decoded !== params[nameField]) {
      return `Header mismatch: Mcp-Name header value '${decoded}' does not match body value '${params[nameField]}'`;
    }
  }
  if (msg.method === "tools/call" && params.name === "regional") {
    const args = isObject(params.arguments) ? params.arguments : {};
    const raw = headers["mcp-param-region"];
    const bodyValue = typeof args.region === "string" ? args.region : undefined;
    if (bodyValue !== undefined && typeof raw !== "string") return "Missing Mcp-Param-Region header";
    if (typeof raw === "string") {
      const decoded = decodeHeaderValue(raw);
      if (decoded === undefined) return "Header mismatch: Mcp-Param-Region header value is not valid Base64";
      if (decoded !== bodyValue) {
        return `Header mismatch: Mcp-Param-Region header value '${decoded}' does not match body value '${bodyValue}'`;
      }
    }
  }
  const metaVersion = meta?.[META.protocolVersion];
  if (typeof metaVersion === "string" && metaVersion !== headerVersion.trim()) {
    return `Header mismatch: MCP-Protocol-Version header '${headerVersion.trim()}' does not match _meta protocolVersion '${metaVersion}'`;
  }
  return undefined;
}

/**
 * The `_meta` fields every request MUST carry; returns what is missing, or
 * undefined. The `require-client-info` knob also demands the OPTIONAL
 * clientInfo, the violation lifecycle-meta-client-info-optional must see.
 */
function metaProblem(params, meta) {
  if (!isObject(params._meta)) return "params._meta is required";
  if (typeof meta[META.protocolVersion] !== "string") return `params._meta["${META.protocolVersion}"] must be a string`;
  if (!isObject(meta[META.clientCapabilities])) return `params._meta["${META.clientCapabilities}"] must be an object`;
  if (broken("require-client-info") && !isObject(meta[META.clientInfo])) {
    return `params._meta["${META.clientInfo}"] must be an object`;
  }
  return undefined;
}

function clientCapabilitiesOf(meta) {
  const caps = meta?.[META.clientCapabilities];
  return isObject(caps) ? caps : {};
}

// ---------------------------------------------------------------------------
// Subscriptions (subscriptions/listen)
// ---------------------------------------------------------------------------

/** Open listen streams: { id, filter, send(message) }. Shared by both transports; one process runs one. */
const subscriptions = new Set();

/**
 * Deliver a list-changed notification to every stream that opted in. The
 * `listen-ignores-filter` knob leaks prompts/list_changed onto streams that
 * only asked for tools changes, which is the violation the filter test
 * must be able to see.
 */
function broadcast(filterKey, method) {
  for (const sub of subscriptions) {
    if (sub.filter[filterKey] === true) sub.send(notification(method, {}, sub.id));
    if (broken("listen-ignores-filter") && filterKey === "toolsListChanged") {
      sub.send(notification("notifications/prompts/list_changed", {}, sub.id));
    }
  }
}

function honouredFilter(requested) {
  const out = {};
  for (const key of ["toolsListChanged", "promptsListChanged", "resourcesListChanged"]) {
    if (requested[key] === true) out[key] = true;
  }
  if (Array.isArray(requested.resourceSubscriptions)) {
    const known = new Set(RESOURCES.map((r) => r.uri));
    const uris = requested.resourceSubscriptions.filter((u) => typeof u === "string" && known.has(u));
    if (uris.length > 0) out.resourceSubscriptions = uris;
  }
  return out;
}

function listenOutcome(id, params) {
  if (!isObject(params.notifications)) {
    return errorOutcome(id, CODES.INVALID_PARAMS, "Invalid params: notifications filter is required");
  }
  const filter = honouredFilter(params.notifications);
  // `listen-silent`: the stream opens (HTTP 200 with headers flushed) and
  // then nothing is ever written to it, not even the acknowledgment.
  if (broken("listen-silent")) return { kind: "listen", status: 200, id, filter, first: [] };
  const first = broken("no-listen-ack")
    ? notification("notifications/tools/list_changed", {}, id)
    : notification("notifications/subscriptions/acknowledged", { notifications: filter }, id);
  return { kind: "listen", status: 200, id, filter, first: [first] };
}

/** The graceful-closure response for a listen stream the server is ending. */
function listenClosedResponse(id) {
  return resultResponse(id, "subscriptions/listen", { _meta: { [META.subscriptionId]: id } });
}

// ---------------------------------------------------------------------------
// JSON-RPC core
// ---------------------------------------------------------------------------

let toolsListCalls = 0;

/**
 * Validate and dispatch one JSON-RPC request. `ctx.transport` is "http" or
 * "stdio"; `ctx.headers` is Node's lower-cased header map on HTTP.
 *
 * Order matters and is what the compliance tests assert:
 *   1. `initialize` is answered before any validation: a legacy client sends
 *      it without headers or `_meta`, and the error SHOULD still name the
 *      versions this server speaks.
 *   2. HTTP standard-header validation (-32020), so a header/_meta version
 *      mismatch beats "unsupported version".
 *   3. `_meta` presence (-32602).
 *   4. Protocol version support (-32022).
 *   5. Method dispatch (-32601 for removed/unknown).
 */
async function handleRequest(msg, ctx) {
  const { id, method } = msg;
  const params = isObject(msg.params) ? msg.params : {};
  const meta = isObject(params._meta) ? params._meta : undefined;

  if (method === "initialize") return handleInitialize(id, params);

  if (ctx.transport === "http" && !broken("accept-header-mismatch")) {
    const problem = headerProblem(ctx.headers, msg, params, meta);
    if (problem) return headerError(id, problem);
  }
  if (!broken("accept-missing-meta")) {
    const problem = metaProblem(params, meta);
    if (problem) {
      return broken("meta-error-wrong-code")
        ? errorOutcome(id, CODES.INVALID_REQUEST, `Invalid Request: ${problem}`, { status: 400 })
        : errorOutcome(id, CODES.INVALID_PARAMS, `Invalid params: ${problem}`, { status: 400 });
    }
  }
  const requested = meta?.[META.protocolVersion];
  if (typeof requested === "string" && !broken("accept-any-version") && !supportedVersions().includes(requested)) {
    return unsupportedVersion(id, requested);
  }
  return dispatch(id, method, params, meta);
}

function handleInitialize(id, params) {
  if (broken("initialize-ok")) {
    // Dual-era emulation: answer the legacy handshake with a legacy
    // InitializeResult (negotiating down to the client's version when it is
    // one we list).
    const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : LEGACY;
    return resultOutcome(id, "initialize", {
      protocolVersion: requested === MODERN ? MODERN : LEGACY,
      capabilities: serverCapabilities(),
      serverInfo: SERVER_INFO,
      instructions: INSTRUCTIONS,
    });
  }
  if (broken("initialize-vague")) return methodNotFound(id, "Method not found: initialize");
  return methodNotFound(
    id,
    `Method not found: initialize. This server speaks MCP ${supportedVersions().join(", ")} (no initialize handshake).`,
  );
}

async function dispatch(id, method, params, meta) {
  switch (method) {
    case "server/discover":
      return discover(id);
    case "tools/list":
      return listTools(id, params);
    case "tools/call":
      return callTool(id, params, meta);
    case "resources/list":
      return paginated(id, method, params, "resources", RESOURCES);
    case "resources/templates/list":
      // A declared list whose store is down: the call fails, it is not "unsupported".
      if (broken("templates-list-error")) return internalError(id, "resource template store unavailable");
      return paginated(id, method, params, "resourceTemplates", RESOURCE_TEMPLATES);
    case "resources/read":
      return readResource(id, params);
    case "prompts/list":
      if (broken("prompts-list-error")) return internalError(id, "prompt store unavailable");
      return paginated(id, method, params, "prompts", PROMPTS);
    case "prompts/get":
      return getPrompt(id, params);
    case "completion/complete":
      return complete(id, params);
    case "subscriptions/listen":
      return listenOutcome(id, params);
    default:
      if (REMOVED_METHODS.has(method)) {
        if (broken("removed-methods-served")) return resultOutcome(id, method, {});
        return methodNotFound(id, `Method not found: ${method} (removed in MCP ${MODERN})`);
      }
      return methodNotFound(id, `Method not found: ${method}`);
  }
}

async function discover(id) {
  if (broken("no-discover")) return methodNotFound(id, "Method not found: server/discover");
  if (broken("slow-discover")) await sleep(1500);
  const result = {
    supportedVersions: supportedVersions(),
    capabilities: serverCapabilities(),
    instructions: INSTRUCTIONS,
  };
  if (broken("discover-missing-versions")) delete result.supportedVersions;
  return resultOutcome(id, "server/discover", result);
}

/**
 * Cursor rules shared by every list method: no cursor -> the full list and
 * no `nextCursor`; cursor "page2" -> an empty page; anything else -> -32602.
 */
function pageFor(id, params, items) {
  const cursor = params.cursor;
  if (cursor === undefined) return { items };
  if (cursor === "page2") return { items: [] };
  return { error: errorOutcome(id, CODES.INVALID_PARAMS, "Invalid params: unknown cursor") };
}

function paginated(id, method, params, key, items) {
  const page = pageFor(id, params, items);
  if (page.error) return page.error;
  return resultOutcome(id, method, { [key]: page.items });
}

function listTools(id, params) {
  const page = pageFor(id, params, TOOLS);
  if (page.error) return page.error;
  let tools = page.items;
  if (broken("unstable-tool-order") && tools.length > 1) {
    const shift = toolsListCalls++ % tools.length;
    tools = [...tools.slice(shift), ...tools.slice(0, shift)];
  }
  if (broken("tool-no-input-schema")) {
    tools = tools.map(({ inputSchema: _omitted, ...rest }) => rest);
  }
  const result = { tools };
  if (broken("input-required-on-list")) result.resultType = "input_required";
  return resultOutcome(id, "tools/list", result);
}

function toolResult(id, result) {
  return resultOutcome(id, "tools/call", result);
}

function callTool(id, params, meta) {
  const name = params.name;
  const args = isObject(params.arguments) ? params.arguments : {};
  switch (name) {
    case "echo":
      return toolResult(id, textResult(echoText(String(args.message ?? ""))));
    case "add": {
      if (!Number.isInteger(args.a) || !Number.isInteger(args.b)) {
        return errorOutcome(id, CODES.INVALID_PARAMS, "Invalid params: a and b must be integers");
      }
      const sum = args.a + args.b;
      return toolResult(id, textResult(String(sum), { structuredContent: sum }));
    }
    case "content_types":
      return toolResult(id, {
        content: [
          { type: "text", text: "hello" },
          { type: "image", data: PNG_1X1, mimeType: "image/png" },
          { type: "audio", data: WAV_EMPTY, mimeType: "audio/wav" },
          { type: "resource", resource: { uri: "test://static-text", mimeType: "text/plain", text: "hello" } },
          { type: "resource_link", uri: "test://static-text", name: "static text" },
        ],
      });
    case "progress":
      return progressOutcome(id, meta);
    case "logger":
      return loggerOutcome(id, meta);
    case "needs_input":
      return needsInput(id, params, meta);
    case "needs_sampling":
      return needsSampling(id, params, meta);
    case "regional":
      if (typeof args.region !== "string" || typeof args.query !== "string") {
        return errorOutcome(id, CODES.INVALID_PARAMS, "Invalid params: region and query are required strings");
      }
      return toolResult(id, textResult(`${args.region}:${args.query}`));
    case "fail":
      if (broken("retired-codes")) return errorOutcome(id, CODES.LEGACY_URL_ELICITATION, "URL elicitation required");
      return toolResult(id, textResult("boom", { isError: true }));
    case "trigger_tools_changed":
      broadcast("toolsListChanged", "notifications/tools/list_changed");
      return toolResult(id, textResult("triggered"));
    case "trigger_prompts_changed":
      broadcast("promptsListChanged", "notifications/prompts/list_changed");
      return toolResult(id, textResult("triggered"));
    default:
      return errorOutcome(id, CODES.INVALID_PARAMS, `Unknown tool: ${String(name)}`);
  }
}

function echoText(message) {
  let text = message;
  if (broken("unicode-broken")) text = Array.from(text, (c) => (c.charCodeAt(0) < 128 ? c : "")).join("");
  if (broken("injection-echo")) text = `executed: root:x:0:0 ${text}`;
  return text;
}

/** Request-scoped notifications before the result -> a response stream (SSE on HTTP, lines on stdio). */
function streamOutcome(id, frames, result) {
  return { kind: "stream", status: 200, frames, message: resultResponse(id, "tools/call", result) };
}

function progressOutcome(id, meta) {
  const frames = [];
  const token = meta?.progressToken;
  if (isRequestId(token)) {
    for (const progress of [1, 2, 3]) {
      frames.push(notification("notifications/progress", { progressToken: token, progress, total: 3 }));
    }
  }
  if (broken("server-request-on-stream")) {
    // A server->client REQUEST on a response stream: forbidden in 2026-07-28 (MRTR replaced it).
    frames.push({ jsonrpc: "2.0", id: "srv-1", method: "roots/list" });
  }
  if (frames.length === 0) return toolResult(id, textResult("done"));
  return streamOutcome(id, frames, textResult("done"));
}

function loggerOutcome(id, meta) {
  const optedIn = typeof meta?.[META.logLevel] === "string";
  if (!optedIn && !broken("log-without-level")) return toolResult(id, textResult("logged"));
  return streamOutcome(
    id,
    [notification("notifications/message", { level: "info", data: "hello" })],
    textResult("logged"),
  );
}

/**
 * MRTR elicitation. The request state is a fixed token because the only
 * thing under test is the round trip: first call -> input_required, retry
 * with the elicitation result -> complete, tampered state -> -32602.
 */
function needsInput(id, params, meta) {
  if (!broken("ignore-client-capabilities") && !isObject(clientCapabilitiesOf(meta).elicitation)) {
    return missingCapability(id, { elicitation: {} });
  }
  const state = params.requestState;
  if (state !== undefined && state !== "state-1" && !broken("accept-tampered-state")) {
    return errorOutcome(id, CODES.INVALID_PARAMS, "Invalid params: invalid requestState");
  }
  const answer = isObject(params.inputResponses) ? params.inputResponses.user_name : undefined;
  if (isObject(answer) && answer.action === "accept") {
    const name = isObject(answer.content) && typeof answer.content.name === "string" ? answer.content.name : "";
    return toolResult(id, textResult(`Hello, ${name}`));
  }
  const result = { resultType: "input_required" };
  if (!broken("input-required-empty")) {
    result.inputRequests = {
      user_name: {
        method: broken("input-request-bad-method") ? "foo/bar" : "elicitation/create",
        params: {
          mode: "form",
          message: "Your name?",
          requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
        },
      },
    };
    result.requestState = "state-1";
  }
  return toolResult(id, result);
}

function needsSampling(id, params, meta) {
  if (!broken("ignore-client-capabilities") && !isObject(clientCapabilitiesOf(meta).sampling)) {
    return missingCapability(id, { sampling: {} });
  }
  const answer = isObject(params.inputResponses) ? params.inputResponses.answer : undefined;
  if (isObject(answer)) {
    const text = isObject(answer.content) && typeof answer.content.text === "string" ? answer.content.text : "sampled";
    return toolResult(id, textResult(text));
  }
  return toolResult(id, {
    resultType: "input_required",
    inputRequests: {
      answer: {
        method: "sampling/createMessage",
        params: { messages: [{ role: "user", content: { type: "text", text: "hi" } }], maxTokens: 10 },
      },
    },
  });
}

function readResource(id, params) {
  const uri = params.uri;
  if (typeof uri !== "string") return errorOutcome(id, CODES.INVALID_PARAMS, "Invalid params: uri is required");
  if (uri === "test://static-text") {
    return resultOutcome(id, "resources/read", { contents: [{ uri, mimeType: "text/plain", text: "hello" }] });
  }
  if (uri === "test://static-binary") {
    return resultOutcome(id, "resources/read", {
      contents: [{ uri, mimeType: "application/octet-stream", blob: "AAEC" }],
    });
  }
  const template = /^test:\/\/template\/([^/]+)\/data$/.exec(uri);
  if (template) {
    return resultOutcome(id, "resources/read", {
      contents: [{ uri, mimeType: "text/plain", text: `data for ${template[1]}` }],
    });
  }
  if (broken("empty-contents-not-found")) return resultOutcome(id, "resources/read", { contents: [] });
  if (broken("resource-not-found-legacy")) {
    return errorOutcome(id, CODES.LEGACY_RESOURCE_NOT_FOUND, "Resource not found", { data: { uri } });
  }
  return errorOutcome(id, CODES.INVALID_PARAMS, "Resource not found", {
    data: broken("resource-not-found-no-uri") ? undefined : { uri },
  });
}

function getPrompt(id, params) {
  const args = isObject(params.arguments) ? params.arguments : {};
  switch (params.name) {
    case "simple":
      return resultOutcome(id, "prompts/get", {
        description: "A simple prompt",
        messages: [{ role: "user", content: { type: "text", text: "Hi" } }],
      });
    case "greet":
      if (typeof args.name !== "string") {
        return errorOutcome(id, CODES.INVALID_PARAMS, "Invalid params: missing required argument: name");
      }
      return resultOutcome(id, "prompts/get", {
        description: "Greets someone",
        messages: [{ role: "user", content: { type: "text", text: `Hello ${args.name}` } }],
      });
    default:
      return errorOutcome(id, CODES.INVALID_PARAMS, `Unknown prompt: ${String(params.name)}`);
  }
}

function complete(id, params) {
  const ref = isObject(params.ref) ? params.ref : {};
  const argument = isObject(params.argument) ? params.argument : {};
  if (broken("completion-rejects-argument")) {
    return errorOutcome(id, CODES.INVALID_PARAMS, `Invalid params: cannot complete argument "${argument.name}"`, {
      status: 400,
    });
  }
  if (broken("completion-no-values")) return resultOutcome(id, "completion/complete", { completion: {} });
  const values = ref.type === "ref/prompt" && ref.name === "greet" && argument.name === "name" ? ["Alice", "Bob"] : [];
  return resultOutcome(id, "completion/complete", { completion: { values, hasMore: false } });
}

// ---------------------------------------------------------------------------
// Framing shared by both transports
// ---------------------------------------------------------------------------

/** Returns a -32600 reason when `msg` is not a JSON-RPC 2.0 request or notification. */
function framingProblem(msg) {
  if (!isObject(msg)) return "Invalid Request: expected a JSON object";
  if (msg.jsonrpc !== "2.0") return 'Invalid Request: jsonrpc must be "2.0"';
  if (typeof msg.method !== "string") return "Invalid Request: method must be a string";
  if (msg.id !== undefined && msg.id !== null && !isRequestId(msg.id))
    return "Invalid Request: id must be a string or number";
  return undefined;
}

/** Id to echo on a framing error: the request's own when it has a usable one, else null. */
function framingId(msg) {
  return isObject(msg) && isRequestId(msg.id) ? msg.id : null;
}

// ---------------------------------------------------------------------------
// stdio transport
// ---------------------------------------------------------------------------

function startStdio() {
  const write = (obj) => {
    process.stdout.write(`${JSON.stringify(obj)}\n`);
  };
  const rl = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  rl.on("line", (line) => {
    handleStdioLine(line, write).catch((err) => {
      process.stderr.write(`modern-server: ${err?.stack ?? err}\n`);
    });
  });
  rl.on("close", () => process.exit(0));
}

async function handleStdioLine(line, write) {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    write(errorResponse(null, CODES.PARSE_ERROR, "Parse error"));
    return;
  }
  if (Array.isArray(msg)) {
    if (!broken("batch-ok")) {
      write(errorResponse(null, CODES.INVALID_REQUEST, "Invalid Request: batches are not supported"));
      return;
    }
    const replies = [];
    for (const item of msg) {
      const reply = await stdioReply(item, write);
      if (reply) replies.push(reply);
    }
    if (replies.length > 0) write(replies);
    return;
  }
  const reply = await stdioReply(msg, write);
  if (reply) write(reply);
}

/** Handle one stdio message; returns the response to write (undefined for notifications and listen streams). */
async function stdioReply(msg, write) {
  const problem = framingProblem(msg);
  if (problem) return errorResponse(framingId(msg), CODES.INVALID_REQUEST, problem);
  if (msg.id === undefined || msg.id === null) {
    handleNotification(msg, write);
    return undefined;
  }
  const outcome = await handleRequest(msg, { transport: "stdio" });
  switch (outcome.kind) {
    case "json":
      return outcome.message;
    case "stream":
      for (const frame of outcome.frames) write(frame);
      return outcome.message;
    case "listen": {
      // Held open until a notifications/cancelled names this request id;
      // the transport then sends the graceful-closure response.
      const sub = { id: outcome.id, filter: outcome.filter, send: write };
      subscriptions.add(sub);
      for (const frame of outcome.first) write(frame);
      return undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Client notifications. `notifications/cancelled` naming an open listen
 * stream ends it (stdio cancellation per the subscriptions pattern); every
 * other notification is accepted silently.
 */
function handleNotification(msg, write) {
  if (msg.method !== "notifications/cancelled") return;
  const target = isObject(msg.params) ? msg.params.requestId : undefined;
  for (const sub of subscriptions) {
    if (sub.id === target) {
      subscriptions.delete(sub);
      write(listenClosedResponse(sub.id));
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP transport
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 8 * 1024 * 1024;
let httpPort = 0;

function startHttp() {
  const server = createServer((req, res) => {
    handleHttp(req, res).catch((err) => {
      process.stderr.write(`modern-server: ${err?.stack ?? err}\n`);
      if (!res.headersSent) {
        sendJson(res, 500, errorResponse(null, -32603, "Internal error"));
      } else {
        res.end();
      }
    });
  });
  server.listen(PINNED_PORT, "127.0.0.1", () => {
    const addr = server.address();
    httpPort = typeof addr === "object" && addr ? addr.port : PINNED_PORT;
    process.stdout.write(`MODERN_FIXTURE_PORT=${httpPort}\n`);
  });
  const shutdown = () => {
    for (const sub of subscriptions) sub.close?.();
    subscriptions.clear();
    server.closeAllConnections?.();
    server.close(() => process.exit(0));
    // A client holding a connection open must not keep the fixture alive.
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  // The test that spawned us closing its end of stdin is the portable
  // "parent went away" signal (a Windows kill cannot deliver SIGTERM).
  process.stdin.on("end", shutdown);
  process.stdin.on("error", shutdown);
  process.stdin.resume();
}

function baseUrl() {
  return `http://127.0.0.1:${httpPort}`;
}

function originAllowed(origin) {
  return origin === "null" || origin === baseUrl() || origin === `http://localhost:${httpPort}`;
}

function commonHeaders(req) {
  const h = {};
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin !== "null" && originAllowed(origin))
    h["Access-Control-Allow-Origin"] = origin;
  if (broken("mint-session")) h["Mcp-Session-Id"] = "fixture-session";
  return h;
}

function sendJson(res, status, body, extra = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text), ...extra });
  res.end(text);
}

function sendEmpty(res, status, extra = {}) {
  res.writeHead(status, extra);
  res.end();
}

function sseHeaders(extra = {}) {
  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    ...extra,
  };
}

function sseFrame(message) {
  return `event: message\ndata: ${JSON.stringify(message)}\n\n`;
}

/**
 * Read the whole body. Past the cap the rest is drained and discarded
 * rather than the socket destroyed, so the 413 still reaches the client.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) reject(Object.assign(new Error("Payload too large"), { tooLarge: true }));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

function authProblem(req) {
  if (!AUTH_TOKEN) return false;
  const header = req.headers.authorization;
  if (typeof header !== "string") return true;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return !m || m[1] !== AUTH_TOKEN;
}

async function handleHttp(req, res) {
  const url = new URL(req.url ?? "/", baseUrl());
  const origin = req.headers.origin;
  // Origin validation guards every endpoint (DNS rebinding); a present but
  // foreign Origin is the one thing a preflight cannot talk its way past.
  if (typeof origin === "string" && !broken("no-origin-check") && !originAllowed(origin)) {
    sendJson(res, 403, errorResponse(null, CODES.INVALID_REQUEST, "Forbidden: Origin not allowed"));
    return;
  }
  const common = commonHeaders(req);

  if (url.pathname === "/.well-known/oauth-protected-resource") {
    if (!AUTH_TOKEN) {
      sendEmpty(res, 404);
      return;
    }
    sendJson(res, 200, { resource: `${baseUrl()}/mcp`, authorization_servers: [`${baseUrl()}/as`] }, common);
    return;
  }
  if (url.pathname !== "/mcp") {
    sendEmpty(res, 404);
    return;
  }

  if (req.method === "OPTIONS") {
    const cors = common["Access-Control-Allow-Origin"]
      ? {
          ...common,
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers":
            "Content-Type, Accept, Authorization, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Param-Region",
          "Access-Control-Max-Age": "600",
        }
      : {};
    sendEmpty(res, 204, cors);
    return;
  }

  if (authProblem(req)) {
    sendJson(res, 401, errorResponse(null, CODES.INVALID_REQUEST, "Unauthorized"), {
      ...common,
      "WWW-Authenticate": `Bearer resource_metadata="${baseUrl()}/.well-known/oauth-protected-resource"`,
    });
    return;
  }

  if (req.method === "GET") {
    if (broken("get-sse")) {
      // The removed legacy GET stream. Ends immediately so a client reading
      // the whole body does not hang; the status + content type are the defect.
      res.writeHead(200, sseHeaders(common));
      res.end(": legacy stream\n\n");
      return;
    }
    sendEmpty(res, 405, { ...common, Allow: "POST" });
    return;
  }
  if (req.method === "DELETE") {
    if (broken("delete-ok")) {
      sendJson(res, 200, {}, common);
      return;
    }
    sendEmpty(res, 405, { ...common, Allow: "POST" });
    return;
  }
  if (req.method !== "POST") {
    sendEmpty(res, 405, { ...common, Allow: "POST" });
    return;
  }

  const session = req.headers["mcp-session-id"];
  if (broken("mint-session") && typeof session === "string" && session !== "fixture-session") {
    sendJson(res, 404, errorResponse(null, -32001, "Session not found"), common);
    return;
  }

  const mediaType = String(req.headers["content-type"] ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (mediaType !== "application/json" && !broken("any-content-type")) {
    sendJson(
      res,
      415,
      errorResponse(null, CODES.INVALID_REQUEST, "Unsupported Media Type: expected application/json"),
      common,
    );
    return;
  }

  let text;
  try {
    text = await readBody(req);
  } catch (err) {
    if (err?.tooLarge) sendJson(res, 413, errorResponse(null, CODES.INVALID_REQUEST, "Payload too large"), common);
    return;
  }
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    sendJson(res, 400, errorResponse(null, CODES.PARSE_ERROR, "Parse error"), common);
    return;
  }

  if (Array.isArray(msg)) {
    if (!broken("batch-ok")) {
      sendJson(
        res,
        400,
        errorResponse(null, CODES.INVALID_REQUEST, "Invalid Request: batches are not supported"),
        common,
      );
      return;
    }
    const replies = [];
    for (const item of msg) {
      const problem = framingProblem(item);
      if (problem) {
        replies.push(errorResponse(framingId(item), CODES.INVALID_REQUEST, problem));
        continue;
      }
      if (item.id === undefined || item.id === null) continue;
      const outcome = await handleRequest(item, { transport: "http", headers: req.headers });
      // Streams cannot be multiplexed into an array; the final message is what a batch can carry.
      if (outcome.kind === "listen") replies.push(listenClosedResponse(outcome.id));
      else replies.push(outcome.message);
    }
    sendJson(res, 200, replies, common);
    return;
  }

  const problem = framingProblem(msg);
  if (problem) {
    sendJson(res, 400, errorResponse(framingId(msg), CODES.INVALID_REQUEST, problem), common);
    return;
  }
  if (msg.id === undefined || msg.id === null) {
    // Notifications are accepted with 202 and no body. There is nothing to
    // cancel over HTTP (closing the stream is the cancellation signal).
    if (broken("notification-200")) sendJson(res, 200, {}, common);
    else sendEmpty(res, 202, common);
    return;
  }

  const outcome = await handleRequest(msg, { transport: "http", headers: req.headers });
  switch (outcome.kind) {
    case "json":
      sendJson(res, outcome.status, outcome.message, common);
      return;
    case "stream":
      res.writeHead(outcome.status, sseHeaders(common));
      for (const frame of outcome.frames) res.write(sseFrame(frame));
      res.end(sseFrame(outcome.message));
      return;
    case "listen": {
      res.writeHead(outcome.status, sseHeaders(common));
      // Send the status line now: a stream with no first frame
      // (`listen-silent`) is still an open stream, not a missing response.
      res.flushHeaders();
      const sub = {
        id: outcome.id,
        filter: outcome.filter,
        send: (message) => {
          if (!res.destroyed && res.writable) res.write(sseFrame(message));
        },
        close: () => {
          if (!res.destroyed) res.end();
        },
      };
      subscriptions.add(sub);
      // SSE comment lines keep intermediaries from closing a quiet stream;
      // clients must ignore them. The client closing its end is the
      // cancellation signal; nothing more may be sent for this request after.
      const keepAlive = setInterval(() => {
        if (!res.destroyed && res.writable) res.write(": keepalive\n\n");
      }, 15000);
      res.on("close", () => {
        clearInterval(keepAlive);
        subscriptions.delete(sub);
      });
      for (const frame of outcome.first) res.write(sseFrame(frame));
      return;
    }
    default:
      sendJson(res, 500, errorResponse(msg.id, -32603, "Internal error"), common);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (HTTP_MODE) startHttp();
else startStdio();
