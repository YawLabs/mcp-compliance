import { VALID_CONTENT_TYPES } from "./patterns.js";

/**
 * Pure validators over the shapes both suites inspect: tool / prompt /
 * resource definitions from the list methods, tool-call content blocks,
 * resource contents, prompt messages, the 2026-07-28 caching hints and
 * InputRequiredResult, plus the pagination cursor walk. No transport, no
 * harness: every function takes plain JSON and returns `issues` (hard
 * failures) and, where the legacy runner emitted them, `warnings`
 * (SHOULD-level nits the caller pushes into the report warnings).
 *
 * The 2026-07-28 suite calls these from src/suites/modern; the legacy
 * body in runner.ts still carries its own inline copies and can be
 * refactored onto these without changing verdicts (the logic is a port).
 */

export interface ValidationResult {
  issues: string[];
  warnings: string[];
}

/** SHOULD-level tool naming rule (server/tools#tool): 1-128 chars of [A-Za-z0-9_.-]. */
export const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

/** Boolean annotation hints (server/tools#tool). */
export const BOOLEAN_ANNOTATION_HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;

export const CACHE_SCOPES = ["public", "private"] as const;

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function nameOf(item: Record<string, unknown>, key = "name"): string {
  const v = item[key];
  return typeof v === "string" && v.length > 0 ? v : "?";
}

/** Short, single-line, ASCII-safe rendering of a JSON value for details strings. */
export function brief(value: unknown, max = 40): string {
  let s: string;
  if (value === undefined) s = "undefined";
  else if (typeof value === "string") s = `"${value}"`;
  else {
    try {
      s = JSON.stringify(value) ?? String(value);
    } catch {
      s = String(value);
    }
  }
  s = s.replace(/[^\x20-\x7e]/g, "?");
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

/**
 * A JSON-RPC error code as details render it. JSON-RPC 2.0 requires an
 * integer; anything else is shown as the server sent it, clipped, never as
 * "NaN": `-32601`, `non-integer code "E_LIST"`, or `no code` when the
 * member is missing.
 */
export function errorCodeText(code: unknown): string {
  if (Number.isInteger(code)) return String(code);
  if (code === undefined) return "no code";
  return `non-integer code ${brief(code)}`;
}

/**
 * `<label> <code>` for an integer code, `<label> with <errorCodeText>`
 * otherwise: "JSON-RPC error -32601", "JSON-RPC error with no code",
 * "error with non-integer code "E_LIST"".
 */
export function errorWithCode(code: unknown, label = "JSON-RPC error"): string {
  return Number.isInteger(code) ? `${label} ${code}` : `${label} with ${errorCodeText(code)}`;
}

/**
 * Join issues for a details string without flooding it: the first `max`
 * issues, a count of the rest, and a hard character cap so a server with
 * fifty broken tools still produces a readable line.
 */
export function summarizeIssues(issues: string[], max = 3, maxChars = 220): string {
  const shown = issues.slice(0, max).join("; ");
  const rest = issues.length - max;
  const s = rest > 0 ? `${shown}; ... and ${rest} more` : shown;
  return s.length > maxChars ? `${s.slice(0, maxChars - 3)}...` : s;
}

// ── Tool definitions (tools/list) ─────────────────────────────────

/** tools-schema: name + naming rule + inputSchema is a JSON Schema object of type "object". */
export function validateToolSchemas(tools: unknown[]): ValidationResult {
  const issues: string[] = [];
  const warnings: string[] = [];
  for (const tool of tools) {
    if (!isPlainObject(tool)) {
      issues.push(`Tool entry is not an object (${brief(tool)})`);
      continue;
    }
    const name = tool.name;
    if (typeof name !== "string" || name.length === 0) {
      issues.push("Tool missing name");
      continue;
    }
    if (!TOOL_NAME_PATTERN.test(name)) issues.push(`${name}: name format invalid (expected [A-Za-z0-9_.-]{1,128})`);
    if (!tool.description) warnings.push(`Tool "${name}" missing description`);
    const schema = tool.inputSchema;
    if (schema === undefined || schema === null) {
      issues.push(`${name}: missing inputSchema (required)`);
    } else if (!isPlainObject(schema)) {
      issues.push(`${name}: inputSchema must be a valid JSON Schema object`);
    } else if (schema.type !== "object") {
      issues.push(`${name}: inputSchema.type must be "object" (got ${brief(schema.type)})`);
    }
  }
  return { issues, warnings };
}

export interface AnnotationsResult {
  issues: string[];
  /** Number of tools that carry an annotations object. */
  annotated: number;
}

/** tools-annotations: hint fields boolean when present; annotations.title a string when present. */
export function validateToolAnnotations(tools: unknown[]): AnnotationsResult {
  const issues: string[] = [];
  let annotated = 0;
  for (const tool of tools) {
    if (!isPlainObject(tool)) continue;
    const ann = tool.annotations;
    if (ann === undefined || ann === null) continue;
    annotated++;
    const name = nameOf(tool);
    if (!isPlainObject(ann)) {
      issues.push(`${name}: annotations must be an object`);
      continue;
    }
    for (const field of BOOLEAN_ANNOTATION_HINTS) {
      if (ann[field] !== undefined && typeof ann[field] !== "boolean") {
        issues.push(`${name}: annotations.${field} should be boolean, got ${typeof ann[field]}`);
      }
    }
    if (ann.title !== undefined && typeof ann.title !== "string") {
      issues.push(`${name}: annotations.title should be a string, got ${typeof ann.title}`);
    }
  }
  return { issues, annotated };
}

export interface TitleResult {
  issues: string[];
  withTitle: string[];
  withoutTitle: string[];
}

/** tools-title-field: title is a string when present; reports which tools lack one. */
export function validateToolTitles(tools: unknown[]): TitleResult {
  const issues: string[] = [];
  const withTitle: string[] = [];
  const withoutTitle: string[] = [];
  for (const tool of tools) {
    if (!isPlainObject(tool)) continue;
    const name = nameOf(tool);
    if (tool.title === undefined) withoutTitle.push(name);
    else if (typeof tool.title !== "string") issues.push(`${name}: title should be a string, got ${typeof tool.title}`);
    else withTitle.push(name);
  }
  return { issues, withTitle, withoutTitle };
}

export interface OutputSchemaResult {
  issues: string[];
  /** Number of tools declaring an outputSchema. */
  withSchema: number;
}

/**
 * tools-output-schema (2026-07-28): outputSchema, when declared, is a
 * non-null JSON Schema object. The root type is NOT restricted -- a
 * structuredContent may be any JSON value, so `{ type: "integer" }` is
 * valid here (2025-11-25 required type "object").
 */
export function validateToolOutputSchemas(tools: unknown[]): OutputSchemaResult {
  const issues: string[] = [];
  let withSchema = 0;
  for (const tool of tools) {
    if (!isPlainObject(tool)) continue;
    if (tool.outputSchema === undefined) continue;
    withSchema++;
    if (!isPlainObject(tool.outputSchema)) {
      issues.push(`${nameOf(tool)}: outputSchema must be a JSON Schema object (got ${brief(tool.outputSchema)})`);
    }
  }
  return { issues, withSchema };
}

// ── Prompt definitions (prompts/list) ─────────────────────────────

/** prompts-schema: string name; arguments (if any) an array of named entries. */
export function validatePromptSchemas(prompts: unknown[]): ValidationResult {
  const issues: string[] = [];
  const warnings: string[] = [];
  for (const p of prompts) {
    if (!isPlainObject(p)) {
      issues.push(`Prompt entry is not an object (${brief(p)})`);
      continue;
    }
    const name = typeof p.name === "string" && p.name.length > 0 ? p.name : undefined;
    if (!name) issues.push("Prompt missing name");
    if (!p.description) warnings.push(`Prompt "${name ?? "?"}" missing description`);
    if (p.arguments !== undefined && !Array.isArray(p.arguments)) {
      issues.push(`${name ?? "?"}: arguments must be an array`);
    } else if (Array.isArray(p.arguments)) {
      for (const arg of p.arguments) {
        if (!isPlainObject(arg) || typeof arg.name !== "string" || arg.name.length === 0) {
          issues.push(`${name ?? "?"}: argument missing name`);
        }
      }
    }
  }
  return { issues, warnings };
}

// ── Resource definitions (resources/list, resources/templates/list) ──

/** resources-schema: parseable absolute uri + string name; description/mimeType are warnings. */
export function validateResourceSchemas(resources: unknown[]): ValidationResult {
  const issues: string[] = [];
  const warnings: string[] = [];
  for (const r of resources) {
    if (!isPlainObject(r)) {
      issues.push(`Resource entry is not an object (${brief(r)})`);
      continue;
    }
    const uri = typeof r.uri === "string" && r.uri.length > 0 ? r.uri : undefined;
    if (!uri) {
      issues.push("Resource missing uri");
    } else {
      try {
        new URL(uri);
      } catch {
        issues.push(`${uri}: invalid URI format`);
      }
    }
    const name = typeof r.name === "string" && r.name.length > 0 ? r.name : undefined;
    if (!name) issues.push(`${uri ?? "?"}: missing name`);
    const label = name ?? uri ?? "?";
    if (!r.description) warnings.push(`Resource "${label}" missing description`);
    if (!r.mimeType) warnings.push(`Resource "${label}" missing mimeType`);
  }
  return { issues, warnings };
}

/** resources-templates: uriTemplate string + name; missing {params}/description are warnings. */
export function validateResourceTemplates(templates: unknown[]): ValidationResult {
  const issues: string[] = [];
  const warnings: string[] = [];
  for (const t of templates) {
    if (!isPlainObject(t)) {
      issues.push(`Template entry is not an object (${brief(t)})`);
      continue;
    }
    const tpl = t.uriTemplate;
    const name = typeof t.name === "string" && t.name.length > 0 ? t.name : undefined;
    if (tpl === undefined || tpl === null || tpl === "") {
      issues.push("Template missing uriTemplate");
    } else if (typeof tpl !== "string") {
      issues.push(`uriTemplate should be a string, got ${typeof tpl}`);
    } else if (!tpl.includes("{") || !tpl.includes("}")) {
      warnings.push(`Template "${name ?? tpl}" has no URI template parameters (e.g., {id})`);
    }
    if (!name) issues.push(`${typeof tpl === "string" && tpl ? tpl : "?"}: missing name`);
    if (!t.description)
      warnings.push(`Template "${name ?? (typeof tpl === "string" ? tpl : "?")}" missing description`);
  }
  return { issues, warnings };
}

// ── Call results ──────────────────────────────────────────────────

export interface ContentTypesResult {
  issues: string[];
  /** Distinct valid types seen, in order of first appearance. */
  types: string[];
}

/** tools-content-types: every content block has a type from the defined set. */
export function validateContentBlocks(content: unknown[]): ContentTypesResult {
  const issues: string[] = [];
  const types: string[] = [];
  for (const item of content) {
    const type = isPlainObject(item) ? item.type : undefined;
    if (typeof type !== "string" || type.length === 0) {
      issues.push("Content item missing type field");
    } else if (!VALID_CONTENT_TYPES.includes(type)) {
      issues.push(`Unknown content type: "${type}"`);
    } else if (!types.includes(type)) {
      types.push(type);
    }
  }
  return { issues, types };
}

/** resources-read: each contents item has a uri and a string text or blob. */
export function validateResourceContents(contents: unknown[]): { issues: string[] } {
  const issues: string[] = [];
  for (const c of contents) {
    if (!isPlainObject(c)) {
      issues.push(`Content item is not an object (${brief(c)})`);
      continue;
    }
    const uri = typeof c.uri === "string" && c.uri.length > 0 ? c.uri : undefined;
    if (!uri) issues.push("Content item missing uri");
    if (typeof c.text !== "string" && typeof c.blob !== "string") {
      issues.push(`Content item for ${uri ?? "?"} missing both text and blob`);
    }
  }
  return { issues };
}

/** prompts-get: each message has role user|assistant and a content block. */
export function validatePromptMessages(messages: unknown[]): { issues: string[] } {
  const issues: string[] = [];
  for (const msg of messages) {
    if (!isPlainObject(msg)) {
      issues.push(`Message is not an object (${brief(msg)})`);
      continue;
    }
    if (msg.role !== "user" && msg.role !== "assistant") issues.push(`Invalid role: ${brief(msg.role)}`);
    if (!isPlainObject(msg.content)) issues.push("Message missing content");
  }
  return { issues };
}

// ── 2026-07-28 result envelopes ───────────────────────────────────

export interface CachingHintsResult {
  issues: string[];
  /** e.g. `ttlMs=60000 cacheScope=public` -- for pass details. */
  summary: string;
}

/**
 * Caching hints (server/utilities/caching#cacheable-model): ttlMs an
 * integer >= 0 and cacheScope "public" | "private". Both are a MUST on
 * every complete result of a cacheable method.
 */
export function validateCachingHints(result: Record<string, unknown>): CachingHintsResult {
  const issues: string[] = [];
  const ttl = result.ttlMs;
  if (ttl === undefined) issues.push("ttlMs missing");
  else if (typeof ttl !== "number" || !Number.isInteger(ttl))
    issues.push(`ttlMs must be an integer (got ${brief(ttl)})`);
  else if (ttl < 0) issues.push(`ttlMs must be >= 0 (got ${ttl})`);
  const scope = result.cacheScope;
  if (scope === undefined) issues.push("cacheScope missing");
  else if (!(CACHE_SCOPES as readonly unknown[]).includes(scope)) {
    issues.push(`cacheScope must be "public" or "private" (got ${brief(scope)})`);
  }
  return { issues, summary: `ttlMs=${brief(ttl)} cacheScope=${brief(scope)}` };
}

export function isInputRequired(result: Record<string, unknown> | undefined): boolean {
  return result?.resultType === "input_required";
}

export interface InputRequiredShape {
  issues: string[];
  /** Keys of inputRequests, for details. */
  requestKeys: string[];
  hasRequestState: boolean;
}

/**
 * Minimal InputRequiredResult shape (basic/patterns/mrtr): at least one of
 * inputRequests (object of { method, params }) / requestState (string).
 * The allowed method set is checked post-hoc by schema-input-required-shape.
 */
export function validateInputRequired(result: Record<string, unknown>): InputRequiredShape {
  const issues: string[] = [];
  const requestKeys: string[] = [];
  const reqs = result.inputRequests;
  if (reqs !== undefined) {
    if (!isPlainObject(reqs)) {
      issues.push(`inputRequests must be an object (got ${brief(reqs)})`);
    } else {
      for (const [key, req] of Object.entries(reqs)) {
        requestKeys.push(key);
        if (!isPlainObject(req) || typeof req.method !== "string") {
          issues.push(`inputRequests.${key} must be { method, params }`);
        }
      }
    }
  }
  const state = result.requestState;
  const hasRequestState = state !== undefined;
  if (hasRequestState && typeof state !== "string") issues.push(`requestState must be a string (got ${brief(state)})`);
  if (reqs === undefined && !hasRequestState)
    issues.push("input_required result has neither inputRequests nor requestState");
  return { issues, requestKeys, hasRequestState };
}

// ── Pagination walk ───────────────────────────────────────────────

/** A JSON-RPC call returning the parsed response body (`{ result }` or `{ error }`). */
export type RpcBodyCall = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

export interface PaginationOutcome {
  passed: boolean;
  details: string;
  warnings: string[];
}

/** The error object of a JSON-RPC error body, its `code` member as sent; undefined for anything else. */
function jsonRpcErrorOf(body: unknown): { code: unknown } | undefined {
  if (!isPlainObject(body) || !isPlainObject(body.error)) return undefined;
  return { code: body.error.code };
}

function resultListOf(body: unknown, key: string): { result?: Record<string, unknown>; list?: unknown[] } {
  if (!isPlainObject(body) || !isPlainObject(body.result)) return {};
  const list = body.result[key];
  return { result: body.result, list: Array.isArray(list) ? list : undefined };
}

/**
 * The cursor walk shared by tools-/resources-/prompts-pagination: read the
 * first page; when nextCursor is present it must be a string and passing
 * it back must yield another page with the same array key. A list with
 * no nextCursor passes (page size is the server's choice). On 2026-07-28
 * every page MUST carry the same cacheScope; a mismatch is reported as a
 * warning so the verdict stays the legacy one.
 */
export async function checkPagination(rpc: RpcBodyCall, method: string, key: string): Promise<PaginationOutcome> {
  const warnings: string[] = [];
  const first = await rpc(method);
  const firstError = jsonRpcErrorOf(first);
  if (firstError) {
    return { passed: false, details: `No result from ${method} (${errorWithCode(firstError.code)})`, warnings };
  }
  const page1 = resultListOf(first, key);
  if (!page1.result) return { passed: false, details: `No result from ${method}`, warnings };
  if (!page1.list) return { passed: false, details: `No ${key} array`, warnings };
  const cursor = page1.result.nextCursor;
  if (cursor === undefined) {
    return { passed: true, details: `${page1.list.length} ${key}, no nextCursor (single page)`, warnings };
  }
  if (typeof cursor !== "string") {
    return { passed: false, details: `nextCursor should be string, got ${typeof cursor}`, warnings };
  }
  const second = await rpc(method, { cursor });
  const secondError = jsonRpcErrorOf(second);
  if (secondError) {
    return {
      passed: false,
      details: `Next page failed: ${method} with cursor returned ${errorWithCode(secondError.code, "error")}`,
      warnings,
    };
  }
  const page2 = resultListOf(second, key);
  if (!page2.list) return { passed: false, details: `Next page failed to return ${key} array`, warnings };
  const scope1 = page1.result.cacheScope;
  const scope2 = page2.result?.cacheScope;
  if (typeof scope1 === "string" && typeof scope2 === "string" && scope1 !== scope2) {
    warnings.push(
      `${method}: cacheScope differs between pages (${brief(scope1)} vs ${brief(scope2)}); every page of one list MUST share a scope`,
    );
  }
  return {
    passed: true,
    details: `Pagination works: page 1 had ${page1.list.length} ${key}, page 2 had ${page2.list.length}`,
    warnings,
  };
}
