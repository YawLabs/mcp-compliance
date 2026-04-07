import { createRequire } from "node:module";
import { request } from "undici";
import { generateBadge } from "./badge.js";
import { computeScore } from "./grader.js";
import type { ComplianceReport, TestResult } from "./types.js";

export type { TestResult, ComplianceReport } from "./types.js";
export { TEST_DEFINITIONS } from "./types.js";
export { computeGrade, computeScore } from "./grader.js";
export { generateBadge } from "./badge.js";

const _require = createRequire(import.meta.url);
const { version: TOOL_VERSION } = _require("../package.json");

const SPEC_VERSION = "2025-11-25";
const SPEC_BASE = `https://modelcontextprotocol.io/specification/${SPEC_VERSION}`;

const VALID_CONTENT_TYPES = ["text", "image", "audio", "resource", "resource_link"];

function createIdCounter(start = 0) {
  let id = start;
  return () => ++id;
}

/**
 * Parse SSE (text/event-stream) response body.
 * Handles multi-line data fields per the SSE specification:
 * consecutive "data:" lines are concatenated with "\n".
 * An empty line marks the end of an event.
 */
function parseSSEResponse(text: string): any {
  const lines = text.split("\n");
  let lastJsonRpcResponse: any = null;
  let currentData: string[] = [];

  function flushEvent() {
    if (currentData.length === 0) return;
    const data = currentData.join("\n");
    currentData = [];
    if (!data.trim()) return;
    try {
      const parsed = JSON.parse(data);
      if (parsed.jsonrpc === "2.0" && parsed.id !== undefined) {
        lastJsonRpcResponse = parsed;
      }
    } catch {
      // Not valid JSON, skip
    }
  }

  for (const line of lines) {
    if (line.startsWith("data:")) {
      const content = line.slice(5);
      currentData.push(content.startsWith(" ") ? content.slice(1) : content);
    } else if (line.trim() === "") {
      flushEvent();
    }
    // Ignore other fields: event:, id:, retry:, and comments starting with ":"
  }

  // Handle trailing data without final empty line
  flushEvent();

  return lastJsonRpcResponse;
}

async function mcpRequest(
  backendUrl: string,
  method: string,
  params: unknown | undefined,
  nextId: () => number,
  extraHeaders: Record<string, string> | undefined,
  timeout: number,
): Promise<{
  statusCode: number;
  body: any;
  headers: Record<string, string>;
  requestId: number;
}> {
  const id = nextId();
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    params: params || {},
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...extraHeaders,
  };

  const res = await request(backendUrl, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(timeout),
  });

  const text = await res.body.text();
  const responseHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers)) {
    if (typeof v === "string") responseHeaders[k] = v;
  }

  const contentType = (responseHeaders["content-type"] || "").toLowerCase();

  if (contentType.includes("text/event-stream")) {
    const parsed = parseSSEResponse(text);
    if (parsed) {
      return { statusCode: res.statusCode, body: parsed, headers: responseHeaders, requestId: id };
    }
    try {
      return { statusCode: res.statusCode, body: JSON.parse(text), headers: responseHeaders, requestId: id };
    } catch {
      return { statusCode: res.statusCode, body: { _raw: text }, headers: responseHeaders, requestId: id };
    }
  }

  try {
    return { statusCode: res.statusCode, body: JSON.parse(text), headers: responseHeaders, requestId: id };
  } catch {
    return { statusCode: res.statusCode, body: { _raw: text }, headers: responseHeaders, requestId: id };
  }
}

async function mcpNotification(
  backendUrl: string,
  method: string,
  params: unknown | undefined,
  extraHeaders: Record<string, string> | undefined,
  timeout: number,
): Promise<{ statusCode: number; headers: Record<string, string> }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...extraHeaders,
  };
  const res = await request(backendUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }),
    signal: AbortSignal.timeout(timeout),
  });
  await res.body.text();
  const responseHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers)) {
    if (typeof v === "string") responseHeaders[k] = v;
  }
  return { statusCode: res.statusCode, headers: responseHeaders };
}

export interface RunOptions {
  /** Optional callback for progress updates */
  onProgress?: (testId: string, passed: boolean, details: string) => void;
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
}

/**
 * Run the full MCP compliance test suite against a URL.
 */
export async function runComplianceSuite(url: string, options: RunOptions = {}): Promise<ComplianceReport> {
  let parsed: URL;
  try {
    parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("Only HTTP and HTTPS URLs are supported");
    }
  } catch (e: any) {
    if (e.message.includes("Only HTTP")) throw e;
    throw new Error(`Invalid URL: ${url}`);
  }

  const backendUrl = url;
  const tests: TestResult[] = [];
  const warnings: string[] = [];
  // Use high start offset for the main ID counter to avoid collision with transport test hardcoded IDs
  const nextId = createIdCounter(1000);
  const timeout = options.timeout || 15000;
  const retries = options.retries || 0;

  // Session state
  let sessionId: string | null = null;
  let negotiatedProtocolVersion: string | null = null;
  const userHeaders = options.headers || {};

  function buildHeaders(): Record<string, string> {
    const h: Record<string, string> = { ...userHeaders };
    if (sessionId) h["mcp-session-id"] = sessionId;
    if (negotiatedProtocolVersion) h["mcp-protocol-version"] = negotiatedProtocolVersion;
    return h;
  }

  const rpc = (method: string, params?: unknown) =>
    mcpRequest(backendUrl, method, params, nextId, buildHeaders(), timeout);

  function shouldRun(id: string, category: string): boolean {
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
      } catch (err: any) {
        lastResult = { passed: false, details: `Error: ${err.message}` };
        if (attempt < retries) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }

    tests.push({
      id,
      name,
      category,
      required,
      passed: lastResult.passed,
      details: lastResult.details,
      durationMs: Date.now() - start,
      specRef: `${SPEC_BASE}/${specRef}`,
    });
    options.onProgress?.(id, lastResult.passed, lastResult.details);
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
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...userHeaders },
        body: JSON.stringify({ jsonrpc: "2.0", id: 99901, method: "ping" }),
        signal: AbortSignal.timeout(timeout),
      });
      await res.body.text();
      const passed = res.statusCode >= 200 && res.statusCode < 300;
      const note = res.statusCode === 401 || res.statusCode === 403 ? " (auth required)" : "";
      return { passed, details: `HTTP ${res.statusCode}${note}` };
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
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...userHeaders },
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
    "transport-get",
    "GET returns SSE stream or 405",
    "transport",
    false,
    "basic/transports#streamable-http",
    async () => {
      const res = await request(backendUrl, {
        method: "GET",
        headers: { Accept: "text/event-stream", ...userHeaders },
        signal: AbortSignal.timeout(timeout),
      });
      await res.body.text();
      const ct = ((res.headers["content-type"] as string) || "").toLowerCase();
      if (res.statusCode === 405) {
        return { passed: true, details: "HTTP 405 Method Not Allowed (acceptable)" };
      }
      if (ct.includes("text/event-stream")) {
        return { passed: true, details: "Returns text/event-stream for SSE" };
      }
      if (res.statusCode >= 200 && res.statusCode < 300) {
        return { passed: true, details: `HTTP ${res.statusCode} (accepted)` };
      }
      return { passed: false, details: `HTTP ${res.statusCode}, Content-Type: ${ct}` };
    },
  );

  await test(
    "transport-delete",
    "DELETE accepted or returns 405",
    "transport",
    false,
    "basic/transports#streamable-http",
    async () => {
      const res = await request(backendUrl, {
        method: "DELETE",
        headers: { ...userHeaders },
        signal: AbortSignal.timeout(timeout),
      });
      await res.body.text();
      if (res.statusCode === 405) {
        return { passed: true, details: "HTTP 405 Method Not Allowed (acceptable)" };
      }
      if (res.statusCode >= 200 && res.statusCode < 300) {
        return { passed: true, details: `HTTP ${res.statusCode} (session termination supported)` };
      }
      // 400/404 are also acceptable (no active session)
      if (res.statusCode === 400 || res.statusCode === 404) {
        return { passed: true, details: `HTTP ${res.statusCode} (no active session, acceptable)` };
      }
      return { passed: false, details: `HTTP ${res.statusCode}` };
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
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...userHeaders },
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
      capabilities: { roots: { listChanged: true }, sampling: {} },
      clientInfo: { name: "mcp-compliance", version: TOOL_VERSION },
    });
    const result = initRes?.body?.result;
    if (result) {
      serverInfo.protocolVersion = result.protocolVersion || null;
      serverInfo.name = result.serverInfo?.name || null;
      serverInfo.version = result.serverInfo?.version || null;
      serverInfo.capabilities = result.capabilities || {};
      const sid = initRes.headers["mcp-session-id"];
      if (sid) sessionId = sid;
      if (result.protocolVersion) negotiatedProtocolVersion = result.protocolVersion;
    }
  } catch (err: any) {
    // Init failed — lifecycle tests will report the failure
  }

  // Send initialized notification (always, for session setup)
  try {
    await mcpNotification(backendUrl, "notifications/initialized", undefined, buildHeaders(), timeout);
  } catch {}

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
      const res = await rpc("logging/setLevel", { level: "info" });
      if (res.body?.error) {
        return { passed: false, details: `Error: ${res.body.error.code} — ${res.body.error.message}` };
      }
      return { passed: true, details: "logging/setLevel accepted" };
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
      if (!hasCompletions) return { passed: true, details: "Server does not declare completions capability (skipped)" };
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

  // ── 4. TRANSPORT (session-dependent, post-init) ──────────────────

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
      // Some servers return 200 or 204 for notifications — acceptable but not ideal
      if (res.statusCode >= 200 && res.statusCode < 300) {
        return { passed: true, details: `HTTP ${res.statusCode} (accepted, but 202 is preferred)` };
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

  // ── 5. TOOLS ─────────────────────────────────────────────────────

  const hasTools = !!serverInfo.capabilities.tools;
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

  // Schema tests for tools
  await test(
    "tools-schema",
    "All tools have name and inputSchema",
    "schema",
    hasTools,
    "server/tools#data-types",
    async () => {
      const tools = cachedToolsList ?? (await rpc("tools/list")).body?.result?.tools ?? [];
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
      const tools = cachedToolsList ?? (await rpc("tools/list")).body?.result?.tools ?? [];
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
        if (ann.title !== undefined && typeof ann.title !== "string") {
          issues.push(`${tool.name}: annotations.title should be string`);
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

  await test("tools-title-field", "Tools include title field", "schema", false, "server/tools#data-types", async () => {
    const tools = cachedToolsList ?? (await rpc("tools/list")).body?.result?.tools ?? [];
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
  });

  await test(
    "tools-output-schema",
    "Tools with outputSchema are valid",
    "schema",
    false,
    "server/tools#structured-content",
    async () => {
      const tools = cachedToolsList ?? (await rpc("tools/list")).body?.result?.tools ?? [];
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
          const badItems = result.content.filter((c: any) => !c.type);
          if (badItems.length > 0)
            return { passed: false, details: `${badItems.length} content item(s) missing 'type' field` };
          return { passed: true, details: `Returned ${result.content.length} content item(s)` };
        }
        if (result?.isError && result?.content && Array.isArray(result.content)) {
          return { passed: true, details: "Tool returned execution error with content (valid)" };
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

  const hasResources = !!serverInfo.capabilities.resources;
  const hasSubscribe = !!(serverInfo.capabilities.resources as any)?.subscribe;

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

    await test(
      "resources-schema",
      "Resources have uri and name",
      "schema",
      true,
      "server/resources#data-types",
      async () => {
        const resources = cachedResourcesList ?? (await rpc("resources/list")).body?.result?.resources ?? [];
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
          // Use cached list instead of re-fetching
          const resources = cachedResourcesList ?? (await rpc("resources/list")).body?.result?.resources ?? [];
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
          if (!t.uriTemplate) issues.push("Template missing uriTemplate");
          if (!t.name) issues.push(`${t.uriTemplate || "?"}: missing name`);
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
          const resources = cachedResourcesList ?? (await rpc("resources/list")).body?.result?.resources ?? [];
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

  const hasPrompts = !!serverInfo.capabilities.prompts;

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

    await test("prompts-schema", "Prompts have name field", "schema", true, "server/prompts#data-types", async () => {
      const prompts = cachedPromptsList ?? (await rpc("prompts/list")).body?.result?.prompts ?? [];
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

  await test("error-unknown-method", "Returns JSON-RPC error for unknown method", "errors", true, "basic", async () => {
    const res = await rpc("nonexistent/method");
    const error = res.body?.error;
    if (!error) return { passed: false, details: "No JSON-RPC error returned for unknown method" };
    const correctCode = error.code === -32601;
    return {
      passed: true,
      details: `Error code: ${error.code}${correctCode ? " (correct: Method not found)" : " (expected -32601)"} — ${error.message}`,
    };
  });

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
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...buildHeaders() },
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
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...buildHeaders() },
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
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...buildHeaders() },
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

  await test("error-invalid-request-code", "Returns -32600 for invalid request", "errors", false, "basic", async () => {
    const res = await request(backendUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...buildHeaders() },
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
  });

  // ── Compute score ────────────────────────────────────────────────

  const { score, grade, overall, summary, categories } = computeScore(tests);
  const badge = generateBadge(url);

  return {
    specVersion: SPEC_VERSION,
    toolVersion: TOOL_VERSION,
    url,
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
}
