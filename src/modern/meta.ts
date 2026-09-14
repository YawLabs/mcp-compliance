/**
 * Reserved `_meta` keys and error codes of the 2026-07-28 (modern) era.
 * Source: schema/2026-07-28/schema.ts — RequestMetaObject, ResultMetaObject,
 * NotificationMetaObject, and the error-code constants.
 */

export const META = {
  /** Required on every request. Must equal the MCP-Protocol-Version header on HTTP. */
  protocolVersion: "io.modelcontextprotocol/protocolVersion",
  /** Required on every request (`{}` = none). Servers MUST NOT infer from prior requests. */
  clientCapabilities: "io.modelcontextprotocol/clientCapabilities",
  /** SHOULD be on every request. */
  clientInfo: "io.modelcontextprotocol/clientInfo",
  /** Opt-in per request; absent => server MUST NOT send notifications/message. */
  logLevel: "io.modelcontextprotocol/logLevel",
  /** SHOULD be on every result. */
  serverInfo: "io.modelcontextprotocol/serverInfo",
  /** Tags every notification on a subscriptions/listen stream; required on its result. */
  subscriptionId: "io.modelcontextprotocol/subscriptionId",
} as const;

/** MCP-reserved JSON-RPC error codes introduced in 2026-07-28. */
export const MODERN_ERROR_CODES = {
  HEADER_MISMATCH: -32020,
  MISSING_REQUIRED_CLIENT_CAPABILITY: -32021,
  UNSUPPORTED_PROTOCOL_VERSION: -32022,
} as const;

/** Codes retired in 2026-07-28 that a modern server MUST NOT emit. */
export const RETIRED_ERROR_CODES: Record<number, string> = {
  [-32002]: "resource not found (replaced by -32602)",
  [-32042]: "URL elicitation required (replaced by MRTR input_required)",
};

export const JSONRPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

/** Methods removed in 2026-07-28. A modern server answers them with -32601. */
export const REMOVED_METHODS = [
  "initialize",
  "ping",
  "logging/setLevel",
  "resources/subscribe",
  "resources/unsubscribe",
] as const;

/** The only methods whose result may be `resultType: "input_required"`. */
export const MRTR_METHODS = new Set(["tools/call", "prompts/get", "resources/read"]);

/** Methods a server may embed in InputRequiredResult.inputRequests. */
export const INPUT_REQUEST_METHODS = new Set(["elicitation/create", "sampling/createMessage", "roots/list"]);

/** Results that must carry `ttlMs` + `cacheScope` (CacheableResult). */
export const CACHEABLE_METHODS = new Set([
  "server/discover",
  "tools/list",
  "prompts/list",
  "resources/list",
  "resources/templates/list",
  "resources/read",
]);

export interface ClientIdentity {
  name: string;
  version: string;
}

export interface MetaOptions {
  protocolVersion: string;
  clientCapabilities: Record<string, unknown>;
  clientInfo?: ClientIdentity;
  logLevel?: string;
}

/** Build a conformant request `_meta` object. */
export function buildMeta(opts: MetaOptions): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    [META.protocolVersion]: opts.protocolVersion,
    [META.clientCapabilities]: opts.clientCapabilities,
  };
  if (opts.clientInfo) meta[META.clientInfo] = opts.clientInfo;
  if (opts.logLevel) meta[META.logLevel] = opts.logLevel;
  return meta;
}

/**
 * Merge `_meta` into params. Keys the caller already set in
 * `params._meta` win (progressToken, deliberately corrupted values, a
 * narrowed clientCapabilities for a capability test).
 */
export function withMeta(params: unknown, meta: Record<string, unknown>): Record<string, unknown> {
  const base = params && typeof params === "object" && !Array.isArray(params) ? { ...(params as object) } : {};
  const existing = (base as { _meta?: unknown })._meta;
  const existingMeta = existing && typeof existing === "object" ? (existing as Record<string, unknown>) : {};
  return { ...base, _meta: { ...meta, ...existingMeta } };
}

/** Read a reserved key off a `_meta` object without caring about shape. */
export function metaOf(obj: unknown): Record<string, unknown> | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const m = (obj as { _meta?: unknown })._meta;
  return m && typeof m === "object" ? (m as Record<string, unknown>) : undefined;
}
