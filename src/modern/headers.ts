/**
 * Streamable HTTP request-metadata headers of the 2026-07-28 era
 * (basic/transports/streamable-http#request-metadata). Every POST carries
 * `MCP-Protocol-Version` and `Mcp-Method`; `tools/call`, `prompts/get`
 * and `resources/read` also carry `Mcp-Name`; tool arguments whose
 * inputSchema property declares `x-mcp-header` are mirrored as
 * `Mcp-Param-{Name}`.
 */

export const HEADER_PROTOCOL_VERSION = "MCP-Protocol-Version";
export const HEADER_METHOD = "Mcp-Method";
export const HEADER_NAME = "Mcp-Name";
export const HEADER_PARAM_PREFIX = "Mcp-Param-";

const BASE64_PREFIX = "=?base64?";
const BASE64_SUFFIX = "?=";

/** Methods that carry `Mcp-Name`, mapped to the params field it mirrors. */
export const NAME_HEADER_SOURCE: Record<string, "name" | "uri"> = {
  "tools/call": "name",
  "prompts/get": "name",
  "resources/read": "uri",
};

/**
 * RFC 9110 field-value characters: VCHAR (0x21-0x7E), SP, HTAB. A value
 * outside that set, with leading/trailing whitespace, or matching the
 * sentinel pattern itself, MUST be carried Base64-encoded.
 */
export function needsBase64(value: string): boolean {
  if (value.length === 0) return false;
  if (value !== value.trim()) return true;
  if (value.startsWith(BASE64_PREFIX) && value.endsWith(BASE64_SUFFIX)) return true;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === 0x20 || c === 0x09) continue;
    if (c < 0x21 || c > 0x7e) return true;
  }
  return false;
}

/** Encode a header value per the spec's value-encoding rules. */
export function encodeHeaderValue(value: string): string {
  if (!needsBase64(value)) return value;
  return `${BASE64_PREFIX}${Buffer.from(value, "utf8").toString("base64")}${BASE64_SUFFIX}`;
}

/** Decode a possibly-sentinel-encoded header value. */
export function decodeHeaderValue(value: string): string {
  if (value.startsWith(BASE64_PREFIX) && value.endsWith(BASE64_SUFFIX)) {
    const inner = value.slice(BASE64_PREFIX.length, value.length - BASE64_SUFFIX.length);
    return Buffer.from(inner, "base64").toString("utf8");
  }
  return value;
}

/** The `Mcp-Name` value for a request, or undefined when the method has none. */
export function mcpNameFor(method: string, params: unknown): string | undefined {
  const field = NAME_HEADER_SOURCE[method];
  if (!field || !params || typeof params !== "object") return undefined;
  const v = (params as Record<string, unknown>)[field];
  return typeof v === "string" ? v : undefined;
}

/** Convert a tool argument to its header string form (string/integer/boolean only). */
function paramToHeaderString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return undefined;
}

/**
 * `Mcp-Param-{Name}` headers for a tools/call, derived from the tool's
 * inputSchema `x-mcp-header` annotations. Null / absent arguments produce
 * no header (the server MUST NOT expect one).
 */
export function mcpParamHeadersFor(inputSchema: unknown, args: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!inputSchema || typeof inputSchema !== "object") return out;
  const props = (inputSchema as { properties?: unknown }).properties;
  if (!props || typeof props !== "object") return out;
  if (!args || typeof args !== "object") return out;
  for (const [prop, schema] of Object.entries(props as Record<string, unknown>)) {
    if (!schema || typeof schema !== "object") continue;
    const suffix = (schema as Record<string, unknown>)["x-mcp-header"];
    if (typeof suffix !== "string" || !suffix) continue;
    const value = (args as Record<string, unknown>)[prop];
    if (value === undefined || value === null) continue;
    const str = paramToHeaderString(value);
    if (str === undefined) continue;
    out[`${HEADER_PARAM_PREFIX}${suffix}`] = encodeHeaderValue(str);
  }
  return out;
}

export interface StandardHeaderInput {
  method: string;
  params: unknown;
  protocolVersion: string;
  /** inputSchema of the tool being called; enables Mcp-Param-* mirroring. */
  toolInputSchema?: unknown;
}

/** The full conformant header set for one request. */
export function standardHeadersFor(input: StandardHeaderInput): Record<string, string> {
  const headers: Record<string, string> = {
    [HEADER_PROTOCOL_VERSION]: input.protocolVersion,
    [HEADER_METHOD]: input.method,
  };
  const name = mcpNameFor(input.method, input.params);
  if (name !== undefined) headers[HEADER_NAME] = encodeHeaderValue(name);
  if (input.method === "tools/call" && input.toolInputSchema) {
    const args = (input.params as { arguments?: unknown } | undefined)?.arguments;
    Object.assign(headers, mcpParamHeadersFor(input.toolInputSchema, args));
  }
  return headers;
}
