import { request } from "undici";
import {
  INJECTION_PAYLOADS,
  INTERNAL_IP_PATTERNS,
  looksRejected,
  POISONING_PATTERNS,
  STACK_TRACE_PATTERNS,
} from "../../checks/patterns.js";
import type { TestOutcome } from "../../harness.js";
import { errorOf, type RpcResponse, resultOf } from "../../modern/client.js";
import type { ModernSuiteContext } from "./context.js";

/**
 * Security tests of the 2026-07-28 suite (21 in the catalog). Ported from
 * the legacy (2025-11-25) implementations in runner.ts with the modern
 * envelope on every request: `server/discover` replaces `ping` as the
 * probe, `_meta` and the standard headers ride on every body, and no
 * request ever carries a session id (there are none in this era).
 *
 * The auth trio, TLS, OAuth metadata, token-in-URI, CORS, Origin and
 * rate-limiting tests are `transports: ["http"]` in the catalog, so the
 * harness never runs them on stdio; the `ctx.kind` guards only keep a
 * future catalog change from crashing a stdio run. Everything else runs
 * on both transports and reads HTTP status codes only when they exist.
 *
 * Tool-dependent tests read `ctx.state.tools`, filled by the feature
 * module. Under a `--only` filter that list can be null; those tests
 * then skip-pass (they never re-fetch).
 */

const DISCOVER = "server/discover";
const TOOLS_CALL = "tools/call";
const TOOLS_LIST = "tools/list";

/** Raw-probe ids, outside the runner's 1000+ counter and the legacy 999xx transport ids. */
const RAW_ID_TLS = 99950;
const RAW_ID_TOKEN_IN_URI = 99951;

const CORS_ORIGIN = "https://evil.example.com";
const REBINDING_ORIGIN = "https://evil-rebinding-attack.example.com";
const MALFORMED_AUTH = "Bearer INVALID_GARBAGE_TOKEN_!@#$%^&*()";

const OVERSIZED_BYTES = 1_000_000;
const RATE_LIMIT_BURST = 50;

/** Evidence that a payload was executed rather than echoed. */
export const INJECTION_DETECTORS = {
  /** passwd lines (full or the root entry alone), id(1) output, ls -l listings, our echo marker. */
  command: /root:[^:\s]*:0:0|root:.*:\d+:\d+:.*:\/|uid=\d+\(\w+\)|drwxr|pwned/i,
  sql: /syntax error|sql|mysql|postgres|sqlite|information_schema|table_name/i,
  pathTraversal: /root:.*:0:0|\[boot loader\]|\[extensions\]/i,
  ssrf: /ami-|instance-id|hostname|iam|security-credentials/i,
} as const;

const URL_PARAM_NAME = /url|uri|endpoint|link|href/i;

/** The stdio transport's marker for a response line it dropped (see transport/stdio.ts). */
const STDIO_BUFFER_DROPPED = "stdout buffer exceeded";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function is2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

function is4xx(status: number): boolean {
  return status >= 400 && status < 500;
}

/** ASCII-only, bounded copy of free text for a details string. */
function clip(text: string, max: number): string {
  const ascii = text.replace(/\s+/g, " ").replace(/[^\x20-\x7e]/g, "?");
  return ascii.length > max ? `${ascii.slice(0, max - 3)}...` : ascii;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isTimeout(err: unknown): boolean {
  return /timed out|timeout|abort/i.test(errorMessage(err));
}

/** Case-insensitive lookup in a response header map. */
function headerOf(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

function notApplicable(what: string): TestOutcome {
  return { passed: true, details: `not applicable on stdio (${what})` };
}

/** The configured Authorization value, whatever case the user typed the header name in. */
function authorizationOf(ctx: ModernSuiteContext): string {
  const key = Object.keys(ctx.userHeaders).find((h) => h.toLowerCase() === "authorization");
  return key ? ctx.userHeaders[key] : "";
}

function userHeadersWithoutAuthorization(ctx: ModernSuiteContext): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(ctx.userHeaders)) {
    if (k.toLowerCase() !== "authorization") out[k] = v;
  }
  return out;
}

/** A conformant `server/discover` body + headers for probes that must bypass the transport (other URLs). */
function discoverProbe(ctx: ModernSuiteContext, id: number): { body: string; headers: Record<string, string> } {
  const params = ctx.client.paramsFor({});
  return {
    body: JSON.stringify({ jsonrpc: "2.0", id, method: DISCOVER, params }),
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...ctx.client.headersFor(DISCOVER, params),
    },
  };
}

function summarize(res: RpcResponse): string {
  const err = errorOf(res.body);
  if (err) return `JSON-RPC error ${err.code}`;
  return resultOf(res.body) ? "result" : "non-JSON-RPC body";
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Tool helpers
// ---------------------------------------------------------------------------

interface StringParam {
  tool: any;
  param: string;
}

function propertiesOf(tool: any): Record<string, any> {
  const props = tool?.inputSchema?.properties;
  return props && typeof props === "object" && !Array.isArray(props) ? props : {};
}

/** Every (tool, string argument) pair, optionally filtered by argument name. */
function stringParams(tools: any[], nameFilter?: RegExp): StringParam[] {
  const out: StringParam[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool.name !== "string") continue;
    for (const [param, schema] of Object.entries(propertiesOf(tool))) {
      if (schema?.type !== "string") continue;
      if (nameFilter && !nameFilter.test(param)) continue;
      out.push({ tool, param });
    }
  }
  return out;
}

/** Text a tool result exposes to the model: every text block plus structured output. */
function resultText(result: Record<string, unknown>): string {
  const parts: string[] = [];
  const content = result.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      const text = (block as { text?: unknown } | null)?.text;
      if (typeof text === "string") parts.push(text);
    }
  }
  if (result.structuredContent !== undefined) {
    try {
      parts.push(JSON.stringify(result.structuredContent));
    } catch {}
  }
  return parts.join(" ");
}

/**
 * Whether a tool's output shows a payload was EXECUTED. A tool that merely
 * echoes the payload passes: every verbatim copy of the payload is removed
 * before the detector runs, so "&& echo pwned" coming back as-is is not
 * "pwned" produced by a shell. Rejection wording (or isError) still wins
 * even when the detector matches, as in the legacy suite.
 *
 * @internal Exported for testing.
 */
export function classifyInjectionOutput(
  text: string,
  payload: string,
  detector: RegExp,
  isErrorFlag: boolean,
): "defended" | "issue" {
  const scrubbed = payload ? text.split(payload).join(" ") : text;
  if (!detector.test(scrubbed)) return "defended";
  return looksRejected(text, isErrorFlag) ? "defended" : "issue";
}

/**
 * The fields security-tool-rug-pull compares. Returns the first difference
 * between two tools/list snapshots, or null when they match.
 *
 * @internal Exported for testing.
 */
export function compareToolLists(first: any[], second: any[]): string | null {
  if (first.length !== second.length) {
    return `Tool count changed: ${first.length} -> ${second.length} (possible rug-pull)`;
  }
  const names1 = first.map((t) => String(t?.name)).sort();
  const names2 = second.map((t) => String(t?.name)).sort();
  if (names1.join(",") !== names2.join(",")) return "Tool names changed between calls (possible rug-pull)";
  for (const t1 of first) {
    const t2 = second.find((t) => t?.name === t1?.name);
    if (!t2) continue;
    for (const field of ["description", "inputSchema", "annotations"] as const) {
      if (stableStringify(t1[field]) !== stableStringify(t2[field])) {
        return `Tool "${t1.name}" ${field} changed between calls (possible rug-pull)`;
      }
    }
  }
  return null;
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(v).sort()) sorted[key] = (v as Record<string, unknown>)[key];
      return sorted;
    }
    return v;
  });
}

/** Word-bounded, case-insensitive "does this text mention that tool name". */
function mentionsName(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`, "i").test(text);
}

// ---------------------------------------------------------------------------
// Leak scanning (information disclosure)
// ---------------------------------------------------------------------------

export interface ErrorSample {
  /** The error as text (JSON of the error object, or the raw body when it was not JSON-RPC). */
  text: string;
  /** JSON of the request that produced it; a match that also appears here is our own input echoed back. */
  requestText: string;
}

/**
 * First pattern hit per sample that is not an echo of the request's own
 * params. Issues are deduplicated; at most `max` are returned.
 *
 * @internal Exported for testing.
 */
export function findLeaks(samples: ErrorSample[], patterns: RegExp[], max = 3): string[] {
  const issues = new Set<string>();
  for (const sample of samples) {
    for (const pattern of patterns) {
      const match = pattern.exec(sample.text);
      if (!match) continue;
      if (sample.requestText.includes(match[0])) continue;
      issues.add(`Response contains: ${clip(match[0], 60)} (matched in: ${clip(sample.text, 80)})`);
      break; // one finding per sample is enough
    }
    if (issues.size >= max) break;
  }
  return [...issues];
}

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------

export async function runSecurity(ctx: ModernSuiteContext): Promise<void> {
  // The unauthenticated `server/discover` is shared by the auth trio so
  // the suite sends it once (memoized per run, fetched lazily so a
  // `--only` on any one of them still works).
  let unauthenticated: Promise<RpcResponse> | null = null;
  const unauthenticatedDiscover = () => {
    unauthenticated ??= ctx.client.rpc(DISCOVER, {}, { omitUserHeaders: ["authorization"] });
    return unauthenticated;
  };

  // The failure probes are shared by the two information-disclosure
  // tests the same way.
  let probes: Promise<ErrorSample[]> | null = null;
  const errorProbes = () => {
    probes ??= collectErrorProbes(ctx);
    return probes;
  };

  await runAuthAndTransport(ctx, unauthenticatedDiscover);
  await runInputValidation(ctx);
  await runToolIntegrity(ctx);
  await runInformationDisclosure(ctx, errorProbes);
  await runRateLimiting(ctx);
}

// ── Auth & transport (8) ─────────────────────────────────────────────

async function runAuthAndTransport(ctx: ModernSuiteContext, unauthenticatedDiscover: () => Promise<RpcResponse>) {
  const { check } = ctx.harness;

  await check("security-auth-required", async () => {
    if (ctx.kind !== "http") return notApplicable("no HTTP auth");
    if (!ctx.hasAuth) {
      return {
        passed: false,
        details: "Server does not require auth (no --auth provided and server accepted unauthenticated requests)",
      };
    }
    try {
      const res = await unauthenticatedDiscover();
      if (res.statusCode === 401 || res.statusCode === 403) {
        return { passed: true, details: `HTTP ${res.statusCode} (unauthenticated request rejected)` };
      }
      return {
        passed: false,
        details: `HTTP ${res.statusCode}, ${summarize(res)} -- server accepted unauthenticated request`,
      };
    } catch {
      return { passed: true, details: "Connection rejected (acceptable)" };
    }
  });

  await check("security-www-authenticate", async () => {
    if (ctx.kind !== "http") return notApplicable("no HTTP auth");
    if (!ctx.hasAuth) return { passed: true, details: "Skipped: server does not require auth" };
    try {
      const res = await unauthenticatedDiscover();
      if (res.statusCode === 401) {
        const challenge = headerOf(res.headers, "www-authenticate");
        if (challenge) {
          if (!/resource_metadata=/i.test(challenge)) {
            ctx.harness.warnings.push(
              "security-www-authenticate: the WWW-Authenticate challenge carries no resource_metadata parameter; clients must fall back to the well-known Protected Resource Metadata URL.",
            );
          }
          return { passed: true, details: `WWW-Authenticate: ${clip(challenge, 150)}` };
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
      return { passed: true, details: `HTTP ${res.statusCode} -- not a 401 response (skipped)` };
    } catch {
      return { passed: true, details: "Connection rejected (acceptable)" };
    }
  });

  await check("security-auth-malformed", async () => {
    if (ctx.kind !== "http") return notApplicable("no HTTP auth");
    if (!ctx.hasAuth) return { passed: true, details: "Skipped: server does not require auth" };
    try {
      // Drop the configured (valid) Authorization first, then supply the
      // garbage value; without the omit the valid user header would
      // survive the case-insensitive merge and the server would accept.
      const res = await ctx.client.rpc(
        DISCOVER,
        {},
        { omitUserHeaders: ["authorization"], headers: { Authorization: MALFORMED_AUTH } },
      );
      if (res.statusCode === 401 || res.statusCode === 403) {
        return { passed: true, details: `HTTP ${res.statusCode} (malformed auth rejected)` };
      }
      return {
        passed: false,
        details: `HTTP ${res.statusCode}, ${summarize(res)} -- server accepted malformed auth token`,
      };
    } catch {
      return { passed: true, details: "Connection rejected (acceptable)" };
    }
  });

  await check("security-tls-required", async () => {
    if (ctx.kind !== "http") return notApplicable("no TLS");
    const parsed = new URL(ctx.backendUrl);
    if (parsed.protocol !== "https:") {
      return { passed: false, details: `Server URL uses ${parsed.protocol} -- production servers should use HTTPS` };
    }
    // The same modern discover over plaintext to the same host. No user
    // headers: the point is to see whether the endpoint answers in the
    // clear, and a real bearer token must never be sent over http.
    const httpUrl = ctx.backendUrl.replace(/^https:/, "http:");
    const probe = discoverProbe(ctx, RAW_ID_TLS);
    try {
      const res = await request(httpUrl, {
        method: "POST",
        headers: probe.headers,
        body: probe.body,
        signal: AbortSignal.timeout(Math.min(ctx.timeout, 5000)),
      });
      await res.body.text();
      const status = res.statusCode;
      if ([301, 302, 307, 308].includes(status)) {
        const location = res.headers.location;
        const target = typeof location === "string" ? clip(location, 80) : "no Location header";
        return { passed: true, details: `HTTP ${status} redirect to HTTPS (${target})` };
      }
      if (status >= 400) return { passed: true, details: `HTTP ${status} (plaintext rejected)` };
      return { passed: false, details: `HTTP ${status} -- server accepts plaintext HTTP connections` };
    } catch {
      return { passed: true, details: "HTTP connection refused (HTTPS enforced)" };
    }
  });

  await check("security-oauth-metadata", async () => {
    if (ctx.kind !== "http") return notApplicable("no OAuth");
    if (!ctx.hasAuth) return { passed: true, details: "Skipped: server does not require auth" };
    return checkProtectedResourceMetadata(ctx);
  });

  await check("security-token-in-uri", async () => {
    if (ctx.kind !== "http") return notApplicable("no HTTP auth");
    if (!ctx.hasAuth) return { passed: true, details: "Skipped: server does not require auth" };
    const token = authorizationOf(ctx)
      .replace(/^Bearer\s+/i, "")
      .trim();
    if (!token) return { passed: true, details: "Skipped: could not extract token from auth header" };
    const joiner = ctx.backendUrl.includes("?") ? "&" : "?";
    const uriWithToken = `${ctx.backendUrl}${joiner}access_token=${encodeURIComponent(token)}`;
    const probe = discoverProbe(ctx, RAW_ID_TOKEN_IN_URI);
    try {
      // The token travels ONLY in the query string: no Authorization
      // header, every other configured user header kept.
      const res = await request(uriWithToken, {
        method: "POST",
        headers: { ...userHeadersWithoutAuthorization(ctx), ...probe.headers },
        body: probe.body,
        signal: AbortSignal.timeout(ctx.timeout),
      });
      const text = await res.body.text();
      const status = res.statusCode;
      if (status === 401 || status === 403) {
        return { passed: true, details: `HTTP ${status} (token in query string rejected)` };
      }
      if (is2xx(status)) {
        const body = parseJson(text);
        const err = errorOf(body);
        if (err) {
          return {
            passed: true,
            details: `HTTP ${status}, JSON-RPC error ${err.code} (token in query string not accepted)`,
          };
        }
        const shape = resultOf(body) ? "result" : "non-error body";
        return {
          passed: false,
          details: `HTTP ${status}, ${shape} -- server accepted the auth token in the query string (MUST NOT)`,
        };
      }
      return { passed: true, details: `HTTP ${status} (token in query string not accepted)` };
    } catch {
      return { passed: true, details: "Connection rejected (acceptable)" };
    }
  });

  await check("security-cors-headers", async () => {
    if (ctx.kind !== "http") return notApplicable("no CORS");
    return checkCorsHeaders(ctx);
  });

  await check("security-origin-validation", async () => {
    if (ctx.kind !== "http") return notApplicable("no Origin header");
    try {
      // A fully valid discover: the Origin is the only defect.
      const res = await ctx.client.rpc(DISCOVER, {}, { headers: { Origin: REBINDING_ORIGIN } });
      const status = res.statusCode;
      if (status === 403 || status === 401) {
        return { passed: true, details: `HTTP ${status} (suspicious Origin rejected)` };
      }
      if (is2xx(status)) {
        return {
          passed: false,
          details: `HTTP ${status}, ${summarize(res)} -- server accepted a request with an untrusted Origin (MUST validate Origin, 403)`,
        };
      }
      if (status >= 400) return { passed: true, details: `HTTP ${status} (suspicious Origin rejected)` };
      return { passed: false, details: `HTTP ${status}` };
    } catch {
      return { passed: true, details: "Connection rejected (acceptable)" };
    }
  });
}

async function getJson(url: string, timeout: number): Promise<{ status: number; json: any; text: string }> {
  const res = await request(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(Math.min(timeout, 5000)),
  });
  const text = await res.body.text();
  return { status: res.statusCode, json: parseJson(text), text };
}

/**
 * RFC 9728 Protected Resource Metadata: the root well-known URL first,
 * then the endpoint-path variant (/.well-known/oauth-protected-resource
 * followed by the MCP endpoint's path). A legacy authorization-server
 * document passes with a warning.
 */
async function checkProtectedResourceMetadata(ctx: ModernSuiteContext): Promise<TestOutcome> {
  const parsed = new URL(ctx.backendUrl);
  const origin = `${parsed.protocol}//${parsed.host}`;
  const root = `${origin}/.well-known/oauth-protected-resource`;
  const path = parsed.pathname.replace(/\/+$/, "");
  const candidates = path && path !== "/" ? [root, `${root}${path}`] : [root];

  const statuses: string[] = [];
  let malformed: string | null = null;
  let reachable = false;
  for (const url of candidates) {
    const where = url.slice(origin.length);
    try {
      const res = await getJson(url, ctx.timeout);
      reachable = true;
      statuses.push(`${where} -> HTTP ${res.status}`);
      if (res.status !== 200) continue;
      const meta = res.json;
      if (!meta || typeof meta !== "object") {
        malformed ??= `PRM endpoint ${where} returned non-JSON response`;
        continue;
      }
      if (!meta.resource) {
        malformed ??= `PRM response at ${where} missing required 'resource' field`;
        continue;
      }
      if (!Array.isArray(meta.authorization_servers) || meta.authorization_servers.length === 0) {
        malformed ??= `PRM response at ${where} missing 'authorization_servers' array`;
        continue;
      }
      return {
        passed: true,
        details: `Protected Resource Metadata found at ${where}: resource=${clip(String(meta.resource), 60)}, ${meta.authorization_servers.length} auth server(s)`,
      };
    } catch {
      statuses.push(`${where} -> unreachable`);
    }
  }
  if (malformed) return { passed: false, details: clip(malformed, 200) };
  if (!reachable) return { passed: false, details: "PRM endpoint unreachable" };

  // Legacy fallback: an authorization-server document at the root.
  try {
    const legacy = await getJson(`${origin}/.well-known/oauth-authorization-server`, ctx.timeout);
    const doc = legacy.json;
    if (legacy.status === 200 && doc && typeof doc === "object" && doc.issuer && doc.token_endpoint) {
      ctx.harness.warnings.push(
        "security-oauth-metadata: server publishes legacy /.well-known/oauth-authorization-server instead of /.well-known/oauth-protected-resource (RFC 9728); 2026-07-28 requires Protected Resource Metadata.",
      );
      return {
        passed: true,
        details: `Legacy OAuth AS metadata found: issuer=${clip(String(doc.issuer), 60)} (should migrate to PRM)`,
      };
    }
  } catch {}
  return {
    passed: false,
    details: clip(`No Protected Resource Metadata (${statuses.join("; ")}) and no legacy OAuth metadata`, 200),
  };
}

type HttpRawRequest = (
  method: "GET" | "POST" | "DELETE" | "OPTIONS",
  body: string | undefined,
  extraHeaders: Record<string, string>,
  timeout: number,
  omitUserHeaders?: string[],
) => Promise<{ statusCode: number; body: string; headers: Record<string, string> }>;

interface CorsObservation {
  via: "OPTIONS" | "POST";
  status: number;
  acao: string | undefined;
  credentials: string | undefined;
}

/**
 * CORS on both shapes a browser would send: the OPTIONS preflight (legacy
 * probe) and a conformant POST discover carrying an Origin. A wildcard or
 * a reflected foreign origin on either fails.
 */
async function checkCorsHeaders(ctx: ModernSuiteContext): Promise<TestOutcome> {
  const seen: string[] = [];
  const observations: CorsObservation[] = [];

  const rawRequest = (ctx.transport as { rawRequest?: HttpRawRequest }).rawRequest;
  if (rawRequest) {
    try {
      const res = await rawRequest(
        "OPTIONS",
        undefined,
        {
          Origin: CORS_ORIGIN,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type, authorization, mcp-protocol-version, mcp-method",
        },
        Math.min(ctx.timeout, 5000),
      );
      observations.push({
        via: "OPTIONS",
        status: res.statusCode,
        acao: headerOf(res.headers, "access-control-allow-origin"),
        credentials: headerOf(res.headers, "access-control-allow-credentials"),
      });
    } catch {
      seen.push("OPTIONS failed");
    }
  }
  try {
    const res = await ctx.client.rpc(DISCOVER, {}, { headers: { Origin: CORS_ORIGIN } });
    observations.push({
      via: "POST",
      status: res.statusCode,
      acao: headerOf(res.headers, "access-control-allow-origin"),
      credentials: headerOf(res.headers, "access-control-allow-credentials"),
    });
  } catch {
    seen.push("POST with Origin failed");
  }

  for (const o of observations) {
    seen.push(`${o.via} HTTP ${o.status}${o.acao ? ` ACAO=${clip(o.acao, 40)}` : ""}`);
    if (!o.acao) continue;
    const credentials = o.credentials?.toLowerCase() === "true" ? " with Allow-Credentials" : "";
    if (o.acao.trim() === "*") {
      return {
        passed: false,
        details: `Access-Control-Allow-Origin is "*" (wildcard${credentials}) on ${o.via} -- allows cross-origin credential theft`,
      };
    }
    if (o.acao.trim() === CORS_ORIGIN) {
      return {
        passed: false,
        details: `Server reflects arbitrary Origin in CORS${credentials} on ${o.via} -- effectively wildcard`,
      };
    }
  }
  if (observations.length === 0) {
    return { passed: true, details: `${seen.join(", ")} (no CORS, acceptable)` };
  }
  const restricted = observations.find((o) => o.acao)?.acao;
  if (restricted) {
    return { passed: true, details: `CORS restricted to: ${clip(restricted, 60)} (${seen.join(", ")})` };
  }
  return { passed: true, details: `No CORS headers returned (${seen.join(", ")}; server-to-server only, acceptable)` };
}

// ── Input validation (6) ─────────────────────────────────────────────

interface InjectionLabels {
  /** "appears to have executed" -- what an issue line says the payload did. */
  label: string;
  /** "command execution" -- what the pass line says was not detected. */
  noun: string;
  /** Details when no argument qualifies. */
  none: string;
}

async function runInputValidation(ctx: ModernSuiteContext) {
  const { check } = ctx.harness;
  const tools = ctx.state.tools;

  const skipReason = (): TestOutcome | null => {
    if (tools === null) return { passed: true, details: "Skipped: tools/list not available" };
    if (tools.length === 0) return { passed: true, details: "No tools available to test (skipped)" };
    return null;
  };

  const injection = (id: string, payloads: string[], detector: RegExp, labels: InjectionLabels, nameFilter?: RegExp) =>
    check(id, async () => {
      return skipReason() ?? runInjectionTest(ctx, stringParams(tools ?? [], nameFilter), payloads, detector, labels);
    });

  await injection("security-command-injection", INJECTION_PAYLOADS.command, INJECTION_DETECTORS.command, {
    label: "appears to have executed",
    noun: "command execution",
    none: "No tools with string parameters to test",
  });

  await injection("security-sql-injection", INJECTION_PAYLOADS.sql, INJECTION_DETECTORS.sql, {
    label: "triggered database error",
    noun: "database errors",
    none: "No tools with string parameters to test",
  });

  await injection("security-path-traversal", INJECTION_PAYLOADS.pathTraversal, INJECTION_DETECTORS.pathTraversal, {
    label: "returned sensitive file content",
    noun: "file content leaks",
    none: "No tools with string parameters to test",
  });

  await injection(
    "security-ssrf-internal",
    INJECTION_PAYLOADS.ssrf,
    INJECTION_DETECTORS.ssrf,
    {
      label: "returned internal data",
      noun: "internal data",
      none: "No tools with URL parameters found (skipped)",
    },
    URL_PARAM_NAME,
  );

  await check("security-oversized-input", async () => {
    return skipReason() ?? checkOversizedInput(ctx, tools ?? []);
  });

  await check("security-extra-params", async () => {
    const skip = skipReason();
    if (skip) return skip;
    const tool = (tools ?? [])[0];
    // Build the arguments via JSON.parse so "__proto__" lands as a real own
    // enumerable property: the object-literal form sets the prototype
    // instead and JSON.stringify would drop it before it reached the wire.
    const maliciousArgs = JSON.parse('{"__injected_param__":"malicious_value","__proto__":{"admin":true}}');
    try {
      const res = await ctx.client.rpc(
        TOOLS_CALL,
        { name: tool.name, arguments: maliciousArgs },
        { toolInputSchema: tool.inputSchema },
      );
      if (ctx.kind === "http" && res.statusCode >= 500) {
        return { passed: false, details: `HTTP ${res.statusCode} -- server error on unknown tool arguments` };
      }
      const err = errorOf(res.body);
      if (err) {
        return { passed: true, details: `Extra params rejected with error: ${err.code} -- ${clip(err.message, 100)}` };
      }
      if (resultOf(res.body)) {
        return { passed: true, details: "Server processed request (extra params likely ignored)" };
      }
      return {
        passed: false,
        details: `malformed response to unknown tool arguments (HTTP ${res.statusCode}, no result or error)`,
      };
    } catch (err) {
      return {
        passed: false,
        details: `Request failed on unknown tool arguments: ${clip(errorMessage(err), 120)} (server may have crashed)`,
      };
    }
  });
}

/**
 * Send every payload to every qualifying (tool, argument) and classify the
 * output. `toolInputSchema` keeps `x-mcp-header` arguments callable: their
 * values are mirrored into `Mcp-Param-*` headers so the server does not
 * reject the request as a header mismatch before the tool ever runs.
 */
async function runInjectionTest(
  ctx: ModernSuiteContext,
  targets: StringParam[],
  payloads: string[],
  detector: RegExp,
  labels: InjectionLabels,
): Promise<TestOutcome> {
  if (targets.length === 0) return { passed: true, details: labels.none };
  const issues: string[] = [];
  let defended = 0;
  let calls = 0;
  for (const { tool, param } of targets) {
    for (const payload of payloads) {
      calls++;
      try {
        const res = await ctx.client.rpc(
          TOOLS_CALL,
          { name: tool.name, arguments: { [param]: payload } },
          { toolInputSchema: tool.inputSchema },
        );
        const result = resultOf(res.body);
        if (!result) {
          // A JSON-RPC error (or no result at all) means the input never
          // reached the tool: defended.
          defended++;
          continue;
        }
        const text = resultText(result);
        const verdict = classifyInjectionOutput(text, payload, detector, result.isError === true);
        if (verdict === "issue") {
          issues.push(
            `Payload "${clip(payload, 30)}" ${labels.label} in ${tool.name}.${param} (output: ${clip(text, 60)})`,
          );
        } else {
          defended++;
        }
      } catch {
        // Transport-level rejection of the input: defended.
        defended++;
      }
    }
  }
  const toolCount = new Set(targets.map((t) => t.tool.name)).size;
  if (issues.length > 0) return { passed: false, details: clip(issues.join("; "), 200) };
  const scope = `${payloads.length} payload(s) x ${targets.length} argument(s) across ${toolCount} tool(s)`;
  return {
    passed: true,
    details:
      defended === calls
        ? `Tested ${scope} -- server defended (rejected or sanitized)`
        : `Tested ${scope} -- no ${labels.noun} detected`,
  };
}

/**
 * A ~1 MB string in the first string argument the server declares (any
 * tool's first argument named `data` when no tool takes a string).
 */
async function checkOversizedInput(ctx: ModernSuiteContext, tools: any[]): Promise<TestOutcome> {
  const target = stringParams(tools)[0] ?? { tool: tools[0], param: "data" };
  const tool = target.tool;
  if (!tool || typeof tool.name !== "string") return { passed: true, details: "No tools available to test (skipped)" };
  const where = `${tool.name}.${target.param}`;
  const largeValue = "A".repeat(OVERSIZED_BYTES);
  try {
    const res = await ctx.client.rpc(
      TOOLS_CALL,
      { name: tool.name, arguments: { [target.param]: largeValue } },
      { toolInputSchema: tool.inputSchema },
    );
    const status = res.statusCode;
    if (ctx.kind === "http") {
      if (status === 413) return { passed: true, details: `HTTP 413 Payload Too Large on a 1 MB ${where} (good)` };
      if (is4xx(status)) return { passed: true, details: `HTTP ${status} (oversized input rejected)` };
      if (status >= 500) {
        return {
          passed: false,
          details: `HTTP ${status} -- server error on a 1 MB ${where} (should answer 413/4xx or a JSON-RPC error)`,
        };
      }
    }
    const err = errorOf(res.body);
    if (err) return { passed: true, details: `JSON-RPC error ${err.code} (oversized input rejected)` };
    if (resultOf(res.body)) {
      ctx.harness.warnings.push(
        `security-oversized-input: the server completed a tools/call carrying a 1 MB string argument (${where}) instead of rejecting it; enforce a request body limit (413) or maxLength in inputSchema.`,
      );
      const prefix = ctx.kind === "http" ? `HTTP ${status}, result` : "result";
      return { passed: true, details: `${prefix} -- server processed a 1 MB ${where} without rejecting it (survived)` };
    }
    const frame = ctx.kind === "http" ? `HTTP ${status}, non-JSON-RPC body` : "broken stdio frame";
    return { passed: false, details: `${frame} -- no result or error for a 1 MB ${where}` };
  } catch (err) {
    const message = errorMessage(err);
    if (ctx.kind === "stdio") {
      const tail = (ctx.transport as { stderrTail?: () => string }).stderrTail?.() ?? "";
      if (tail.includes(STDIO_BUFFER_DROPPED)) {
        // The server answered, but with a single line longer than the
        // runner's 1 MiB stdio buffer: a runner limit, not a server fault.
        ctx.harness.warnings.push(
          `security-oversized-input: the server's reply to a 1 MB ${where} exceeded the runner's 1 MiB stdio line buffer and was dropped; treated as survived. Prefer rejecting oversized arguments with a JSON-RPC error.`,
        );
        return {
          passed: true,
          details: `response to a 1 MB ${where} exceeded the runner's stdio line buffer (server survived)`,
        };
      }
      if (/exit|crash|terminated|closed/i.test(message)) {
        return { passed: false, details: `server died on a 1 MB ${where}: ${clip(message, 120)}` };
      }
    }
    if (isTimeout(err)) {
      return { passed: false, details: `Request timed out -- server may be struggling with a 1 MB ${where}` };
    }
    return { passed: true, details: `Connection rejected (acceptable for oversized input): ${clip(message, 100)}` };
  }
}

// ── Tool integrity (4) ───────────────────────────────────────────────

async function runToolIntegrity(ctx: ModernSuiteContext) {
  const { check } = ctx.harness;
  const tools = ctx.state.tools;
  const unavailable: TestOutcome = { passed: true, details: "Skipped: tools/list not available" };

  await check("security-tool-schema-defined", async () => {
    if (tools === null) return unavailable;
    if (tools.length === 0) return { passed: true, details: "No tools to validate" };
    const missing = tools.filter((t: any) => t?.inputSchema?.type !== "object");
    if (missing.length > 0) {
      const names = missing.map((t: any) => t?.name).join(", ");
      return { passed: false, details: clip(`${missing.length} tool(s) missing inputSchema: ${names}`, 200) };
    }
    return { passed: true, details: `All ${tools.length} tool(s) have inputSchema defined` };
  });

  await check("security-tool-rug-pull", async () => {
    if (tools === null) return unavailable;
    try {
      const res = await ctx.client.rpc(TOOLS_LIST, {});
      const again = resultOf(res.body)?.tools;
      if (!Array.isArray(again)) {
        return { passed: false, details: `Second tools/list call failed (${summarize(res)})` };
      }
      const diff = compareToolLists(tools, again);
      if (diff) return { passed: false, details: clip(diff, 200) };
      return { passed: true, details: `${tools.length} tool(s) consistent across 2 calls` };
    } catch (err) {
      return { passed: false, details: `Second tools/list call threw: ${clip(errorMessage(err), 120)}` };
    }
  });

  await check("security-tool-description-poisoning", async () => {
    if (tools === null) return unavailable;
    if (tools.length === 0) return { passed: true, details: "No tools to validate" };
    const issues: string[] = [];
    for (const tool of tools) {
      const prose = [
        typeof tool?.description === "string" ? tool.description : "",
        ...Object.values(propertiesOf(tool)).map((p: any) => (typeof p?.description === "string" ? p.description : "")),
      ].join(" ");
      // Names and titles are model-visible too, but a long identifier is
      // not a Base64 blob, so that one pattern is prose-only.
      const identifiers = [tool?.name, tool?.title].filter((v) => typeof v === "string").join(" ");
      for (const { pattern, label } of POISONING_PATTERNS) {
        const inProse = pattern.test(prose);
        const inName = !label.startsWith("possible Base64") && pattern.test(identifiers);
        if (inProse || inName) issues.push(`Tool "${tool?.name}": ${label}`);
      }
    }
    if (issues.length > 0) return { passed: false, details: clip(issues.join("; "), 200) };
    return { passed: true, details: `${tools.length} tool(s) scanned -- no injection patterns found` };
  });

  await check("security-tool-cross-reference", async () => {
    if (tools === null) return unavailable;
    if (tools.length < 2) {
      return { passed: true, details: "Fewer than 2 tools -- cross-reference check not applicable" };
    }
    const names: string[] = tools.map((t: any) => t?.name).filter((n: unknown) => typeof n === "string" && n);
    const issues: string[] = [];
    for (const tool of tools) {
      const desc = typeof tool?.description === "string" ? tool.description : "";
      if (!desc) continue;
      for (const other of names) {
        if (other === tool.name) continue;
        if (mentionsName(desc, other)) issues.push(`Tool "${tool.name}" description references "${other}"`);
      }
    }
    if (issues.length > 0) {
      ctx.harness.warnings.push(`security-tool-cross-reference: ${clip(issues.join("; "), 300)}`);
      return { passed: false, details: clip(issues.join("; "), 200) };
    }
    return { passed: true, details: `${tools.length} tool(s) checked -- no cross-references found` };
  });
}

// ── Information disclosure (2) ───────────────────────────────────────

type RpcOpts = Parameters<ModernSuiteContext["client"]["rpc"]>[2];

/**
 * Trigger a range of failures with conformant envelopes so the errors
 * come from the server's own handlers, not the transport layer. Each
 * probe's body is kept as text (a non-JSON 500 page counts too); every
 * JSON-RPC error the whole run received is added by the caller from the
 * recorder.
 */
async function collectErrorProbes(ctx: ModernSuiteContext): Promise<ErrorSample[]> {
  const samples: ErrorSample[] = [];
  const rpcProbes: Array<[string, unknown, RpcOpts?]> = [
    ["nonexistent/___crash___test___", {}],
    // Malformed _meta: a string where the envelope object belongs.
    [DISCOVER, { _meta: "not-an-object" }, { meta: false }],
    // Missing params: a tools/call with no name.
    [TOOLS_CALL, {}],
    [TOOLS_CALL, { name: "___nonexistent___tool___", arguments: {} }],
    [TOOLS_LIST, { cursor: "!!!invalid-garbage-cursor-$$$" }],
  ];
  for (const [method, params, opts] of rpcProbes) {
    try {
      const res = await ctx.client.rpc(method, params, opts);
      const raw = (res.body as { _raw?: unknown } | null)?._raw;
      samples.push({
        text: typeof raw === "string" ? raw : JSON.stringify(res.body ?? null),
        requestText: JSON.stringify(ctx.client.paramsFor(params, opts) ?? null),
      });
    } catch {
      // No response to inspect.
    }
  }
  if (ctx.kind === "http") {
    try {
      const res = await ctx.client.raw("{this is not valid json!!!", { method: DISCOVER });
      samples.push({ text: res.body, requestText: "" });
    } catch {}
  }
  return samples;
}

function recordedErrorSamples(ctx: ModernSuiteContext): ErrorSample[] {
  const samples: ErrorSample[] = [];
  for (const entry of ctx.recorder.errors()) {
    const error = (entry.message as { error?: unknown }).error;
    samples.push({
      text: JSON.stringify(error ?? null),
      requestText: entry.request ? JSON.stringify(entry.request.params ?? null) : "",
    });
  }
  return samples;
}

async function runInformationDisclosure(ctx: ModernSuiteContext, errorProbes: () => Promise<ErrorSample[]>) {
  const { check } = ctx.harness;

  const gather = async (): Promise<ErrorSample[]> => {
    const probes = await errorProbes();
    // The probes are recorded too; the union dedupes by text so a
    // response is not reported twice.
    const seen = new Set<string>();
    const all: ErrorSample[] = [];
    for (const s of [...probes, ...recordedErrorSamples(ctx)]) {
      const key = `${s.text} ${s.requestText}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(s);
    }
    return all;
  };

  await check("security-error-no-stacktrace", async () => {
    const samples = await gather();
    const issues = findLeaks(samples, STACK_TRACE_PATTERNS);
    if (issues.length > 0) return { passed: false, details: clip(issues.join("; "), 200) };
    return {
      passed: true,
      details: `${samples.length} error response(s) checked -- no stack traces or sensitive data found`,
    };
  });

  await check("security-error-no-internal-ip", async () => {
    const samples = await gather();
    const issues = findLeaks(samples, INTERNAL_IP_PATTERNS, 1);
    if (issues.length > 0) {
      return { passed: false, details: clip(`Error response contains internal IP: ${issues[0]}`, 200) };
    }
    return { passed: true, details: `${samples.length} error response(s) checked -- no internal IP addresses found` };
  });
}

// ── Rate limiting (1) ────────────────────────────────────────────────

async function runRateLimiting(ctx: ModernSuiteContext) {
  await ctx.harness.check("security-rate-limiting", async () => {
    if (ctx.kind !== "http") return notApplicable("no HTTP status codes");
    let got429 = false;
    const statuses = await Promise.all(
      Array.from({ length: RATE_LIMIT_BURST }, () =>
        ctx.client
          .rpc(DISCOVER, {})
          .then((res) => {
            if (res.statusCode === 429) got429 = true;
            return res.statusCode;
          })
          .catch(() => 0),
      ),
    );
    if (got429) {
      return {
        passed: true,
        details: `Rate limiting detected (429 returned within ${RATE_LIMIT_BURST} rapid requests)`,
      };
    }
    const errorCount = statuses.filter((c) => c >= 500).length;
    if (errorCount > RATE_LIMIT_BURST / 2) {
      return {
        passed: false,
        details: `Server returned ${errorCount}/${RATE_LIMIT_BURST} 5xx errors under load -- should return 429 instead of crashing`,
      };
    }
    return {
      passed: false,
      details: `No rate limiting detected (${RATE_LIMIT_BURST} rapid requests all returned ${[...new Set(statuses)].join(",")})`,
    };
  });
}
