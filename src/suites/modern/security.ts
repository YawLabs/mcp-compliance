import { request } from "undici";
import {
  INJECTION_PAYLOADS,
  INTERNAL_IP_PATTERNS,
  looksRejected,
  POISONING_PATTERNS,
  STACK_TRACE_PATTERNS,
} from "../../checks/patterns.js";
import { errorCodeText, errorWithCode } from "../../checks/validators.js";
import { type AuthRefusal, authRefusalHint, namesHostOrOriginValidation, readAuthRefusal } from "../../detect.js";
import type { TestOutcome } from "../../harness.js";
import { errorOf, type RpcResponse, resultOf } from "../../modern/client.js";
import { parseSSEMessages } from "../../sse.js";
import type { StdioTransport } from "../../transport/stdio.js";
import {
  ensureTools,
  hasPrompts,
  hasResources,
  hasTools,
  listUnavailable,
  type ModernSuiteContext,
} from "./context.js";
import { pickTool } from "./features.js";

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
 * Tool-dependent tests read the tools list through `ensureTools`, which
 * fetches it once on demand, so a `--only security` run measures the
 * server instead of skip-passing. They skip-pass when the server declares
 * no tools capability or lists none. When the list call itself failed they
 * go through `listUnavailable`: a skip-pass pointing at tools-list when
 * that test is in the run, a failure naming the recorded reason when the
 * run filtered it out (`--only security`).
 *
 * On stdio, a check whose own tools/call kills the server process (an
 * injection payload, the 1 MB argument, unknown arguments) fails as "server
 * died" and has the process replaced before it returns
 * (restartStdioServer, which stdio.ts's stdio-unicode uses too) -- on every
 * attempt that kills it, --retries included -- so the checks after it
 * measure the server. After a
 * replacement, security-tool-rug-pull compares two lists from the
 * replacement rather than one from each process (rugPullOnReplacement).
 */

const DISCOVER = "server/discover";
const TOOLS_CALL = "tools/call";
const TOOLS_LIST = "tools/list";

/** Raw-probe ids, outside the runner's 1000+ counter and the legacy 999xx transport ids. */
const RAW_ID_TLS = 99950;
const RAW_ID_TOKEN_IN_URI = 99951;

const CORS_ORIGIN = "https://evil.example.com";
const REBINDING_ORIGIN = "https://evil-rebinding-attack.example.com";
/**
 * Outside RFC 6750's b64token grammar: a MALFORMED authorization request,
 * which the spec's error table lets a server answer with 400 as well as
 * 401 (basic/authorization#error-handling).
 */
const MALFORMED_AUTH = "Bearer INVALID_GARBAGE_TOKEN_!@#$%^&*()";
/** A well-formed b64token ("invalid-token") no authorization server issued: MUST draw 401. */
const INVALID_TOKEN_AUTH = "Bearer aW52YWxpZC10b2tlbg";

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

/** Argument names that suggest an outbound URL (SSRF) or a filesystem path (traversal). */
const URL_PARAM_NAME = /url|uri|href|endpoint|host|link/i;
const PATH_PARAM_NAME = /path|file|dir|folder/i;
const PATH_OR_URL_PARAM_NAME = /path|file|dir|url|uri|href|endpoint|host/i;

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

/** First line of an error message: the stdio transport appends the child's stderr on later lines. */
function firstLine(text: string): string {
  return text.split("\n")[0] ?? "";
}

/**
 * Error codes of a connection that was never established (refused, no
 * such host, unroutable, connect timeout): nothing reached the server's
 * HTTP layer, so the server never read the request.
 */
const CONNECT_FAILURE_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EADDRNOTAVAIL",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/**
 * Error codes of an established connection the peer closed or reset
 * without a complete HTTP response: undici's SocketError "other side
 * closed" (UND_ERR_SOCKET) for a FIN, ECONNRESET for an RST, EPIPE when
 * the write side was already gone. undici reports the same codes whether
 * the server closed right after accepting the connection or after reading
 * the request, so the client cannot tell those two apart.
 *
 * EOF is that last one on a Windows pipe: a write to a stdio child that
 * exited partway through reading a line fails with EOF there and with EPIPE
 * on POSIX -- one event, read the same way on both.
 */
const DROPPED_CODES = new Set(["UND_ERR_SOCKET", "ECONNRESET", "EPIPE", "EOF", "ECONNABORTED"]);

/**
 * The stdio transport's diagnostics for a child that is gone: its exit
 * rejection ("crashed with exit code N", "exited cleanly", "terminated by
 * signal"), the write guard's "stdin is closed", and a write the child's
 * stdin refused -- named by the exit it waits for, or "stdin is closed: the
 * server stopped reading its input" when no exit follows (transport/stdio.ts).
 */
const STDIO_GONE = /crashed with exit code|exited cleanly|terminated by signal|stdin is closed/i;

/** How classifyTransportError reads a request that produced no response. */
export type TransportFailure = "connect" | "dropped" | "timeout" | "other";

/**
 * What a request that produced no response ran into, read from the error
 * itself rather than guessed from its wording:
 *
 * - "connect": the connection was never established (a CONNECT_FAILURE_CODES code);
 * - "dropped": the server closed or reset a connection it had accepted, or
 *   the stdio child exited (DROPPED_CODES, STDIO_GONE) -- it went away
 *   instead of answering;
 * - "timeout": the deadline elapsed with the connection still open (undici's
 *   TimeoutError / HeadersTimeoutError / BodyTimeoutError names, the stdio
 *   transport's "timed out after");
 * - "other": anything else (an unparseable HTTP response, a spawn failure,
 *   a caller's abort).
 *
 * Codes are checked first, so a connect timeout is "connect", not "timeout".
 * Only the first line of the message is read: the stdio transport appends
 * the child's stderr below it, and a server that logs "timed out" or
 * "terminated by signal" must not change what happened to the request.
 *
 * @internal Exported for testing, and for the 2025-11-25 security checks
 * in runner.ts, which read a missing answer the same way.
 */
export function classifyTransportError(err: unknown): TransportFailure {
  const e = err as { code?: unknown; name?: unknown } | null;
  // undici's request() (the HTTP transport and the raw probes) puts the
  // socket error's code on the rejection itself.
  if (typeof e?.code === "string") {
    if (CONNECT_FAILURE_CODES.has(e.code)) return "connect";
    if (DROPPED_CODES.has(e.code)) return "dropped";
  }
  const message = firstLine(errorMessage(err));
  if (STDIO_GONE.test(message)) return "dropped";
  if ((typeof e?.name === "string" && /timeout/i.test(e.name)) || /\btimed out\b/i.test(message)) return "timeout";
  return "other";
}

/**
 * "no response within Nms" for a timeout, "no response (connection
 * closed: ...)" for a drop, "no response (connection failed: ...)" for
 * everything else -- the same reading of the error classifyTransportError
 * gives, so a connect timeout (never established) is a failed connection,
 * not a silent server.
 */
function noResponse(err: unknown, timeout: number): string {
  const failure = classifyTransportError(err);
  if (failure === "timeout") return `no response within ${timeout}ms`;
  const how = failure === "dropped" ? "connection closed" : "connection failed";
  return `no response (${how}: ${clip(firstLine(errorMessage(err)), 90)})`;
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

/**
 * The one verdict for a probe that got no HTTP answer at all. A timeout
 * and a connection error are told apart, and neither is mistaken for an
 * auth refusal (a 401 is an answer) or a quiet server. With `err` the
 * details read "<what> got no response ..."; without it, `what` is the
 * whole clause.
 */
export function unreachable(ctx: ModernSuiteContext, what: string, err?: unknown): TestOutcome {
  if (err === undefined) return { passed: false, details: `server unreachable: ${what}` };
  return { passed: false, details: clip(`server unreachable: ${what} got ${noResponse(err, ctx.timeout)}`, 220) };
}

/**
 * The verdict for a negative HTTP probe (no credential, a token in the
 * query string, a foreign Origin) that got no HTTP response, or null when
 * the missing answer counts as the server refusing the probe.
 *
 * Which transport errors still count as a refusal is read from the error
 * (classifyTransportError), not from its wording:
 *
 * - a timeout is never a refusal: the connection stayed open and nothing
 *   came back, so the probe measured nothing (a hung server or gateway);
 * - a connection that was never established (ECONNREFUSED, ENOTFOUND, a
 *   connect timeout) is never a refusal: the server did not see the request
 *   at all, so nothing about the probe's defect was decided;
 * - an accepted connection the server closed or reset without an HTTP
 *   answer (UND_ERR_SOCKET "other side closed", ECONNRESET -- including a
 *   reset right after connect) is the one shape a connection-level refusal
 *   takes: some gateways drop a request that lacks a credential instead of
 *   answering 401. But a drop carries no reason, and the client cannot see
 *   whether it came before or after the request was read, so it counts
 *   only when `attributable` -- the conformant request that differs from
 *   the probe in nothing but the defect was served, so the defect is what
 *   drew the drop. Without that comparison a server that drops everything
 *   would pass (the same rule notEvaluable in lifecycle.ts applies to a
 *   rejection of any negative probe);
 * - anything else (an unparseable response) is not a refusal either.
 *
 * Every probe that is not a refusal gets unreachable() -- the verdict
 * security-oauth-metadata gives for the same missing answer. A run the
 * caller aborted is rethrown, not graded.
 */
function unansweredProbe(
  ctx: ModernSuiteContext,
  what: string,
  err: unknown,
  attributable: boolean,
): TestOutcome | null {
  if (ctx.signal?.aborted) throw err;
  if (attributable && classifyTransportError(err) === "dropped") return null;
  return unreachable(ctx, what, err);
}

/**
 * Whether the conformant setup server/discover got past whatever stands in
 * front of the server: answered with a DiscoverResult, or with any other
 * 2xx. A JSON-RPC error at HTTP 200 (a server that needs a client
 * capability the suite leaves undeclared answers -32021 that way) is the
 * application's answer: an auth gate, Host guard or gateway passed the
 * request through, so a refusal of a probe that differs from it in one
 * header is that header's doing. A 401, 403, 404, 429, 5xx or no answer at
 * all is not: a gate may have refused the conformant request too.
 *
 * Wider than `ctx.state.discover !== null`, which lifecycle.ts's
 * notEvaluable reads for the JSON-RPC-level negative probes: there a
 * JSON-RPC error on the conformant request means the application rejects
 * everything; here the probes are refused at the HTTP layer, before the
 * application, and the question is only whether the conformant request
 * reached it.
 */
function conformantDiscoverServed(ctx: ModernSuiteContext): boolean {
  if (ctx.state.discover !== null) return true;
  const rejection = ctx.state.discoverRejection;
  return rejection !== null && is2xx(rejection.statusCode);
}

/**
 * Whether a refusal of (or a drop on) a credential-less probe can be pinned
 * on the missing credential: --auth was given and the conformant setup
 * server/discover, which carried it, got past the gate (conformantDiscoverServed).
 */
function credentialedDiscoverServed(ctx: ModernSuiteContext): boolean {
  return ctx.hasAuth && conformantDiscoverServed(ctx);
}

/**
 * 401 when --auth was given and the credentialed setup server/discover was
 * refused with 401 -- "Authorization required or token invalid"
 * (basic/authorization#error-handling): the server rejected the very
 * credential the run was given. Next to that, the 401 an invalid token or a
 * token moved into the query string draws is what the configured one drew
 * too, so it cannot tell token validation from a server that refuses every
 * credential. Null otherwise: no --auth, a credentialed discover that got
 * past the gate, one refused some other way (a 403 may be insufficient
 * scope on a token the server did validate), or one never answered.
 */
function credentialRefusedStatus(ctx: ModernSuiteContext): number | null {
  if (!ctx.hasAuth) return null;
  return ctx.state.discoverRejection?.statusCode === 401 ? 401 : null;
}

/**
 * The skip for a check whose only evidence is a refusal of a credential when
 * the configured credential was refused too (credentialRefusedStatus).
 * `what` names what the refusal would otherwise have shown.
 */
function credentialRefusedSkip(status: number, what: string): TestOutcome {
  return {
    passed: true,
    details: clip(
      `Skipped: the configured credential was refused too (the credentialed server/discover drew HTTP ${status}), so ${what} (check the configured credential)`,
      220,
    ),
  };
}

/**
 * security-auth-required's verdict for a 401 or 403 answering the
 * server/discover sent without an Authorization header, read the way
 * readAuthRefusal reads it:
 *
 * - a 401, or a 403 carrying a Bearer challenge (kind "auth-required"), asks
 *   for a credential: the unauthenticated request was rejected;
 * - a 403 without one (kind "forbidden") cannot be pinned on the missing
 *   credential by itself. streamable-http requires a bare 403 for an invalid
 *   Origin, the official SDK's Host validation answers a hostname it does not
 *   allow (a tunnel or proxy name) with one -- `{"error":{"code":-32000,
 *   "message":"Invalid Host: ..."}}`, no WWW-Authenticate -- and so may a
 *   gateway, while basic/authorization answers missing authorization with 401
 *   ("Authorization required or token invalid"). It counts only when the
 *   credential is the one variable, the rule unansweredProbe applies to a
 *   drop: --auth was given and the conformant setup server/discover, which
 *   carried it, got past the gate -- served, or answered by the application
 *   at 2xx even with a JSON-RPC error (credentialedDiscoverServed). That
 *   passes, still naming the 401 the spec expects. Otherwise the check is
 *   not evaluable and fails, naming the other readings and how the
 *   credentialed request was answered (its status and JSON-RPC code, the way
 *   lifecycle.ts's notEvaluable names them) -- or, without --auth, that
 *   --auth is what makes the comparison possible.
 *
 * The advice depends on what refused. A message naming Host/Origin
 * validation (namesHostOrOriginValidation: the SDK's "Invalid Host: ...")
 * refuses every request whatever credential it carries, so --auth is no way
 * past it: the details say to allow the hostname the server was reached
 * through. A credentialed server/discover refused with 403 too points the
 * same way (the gate stands in front of every request). Otherwise, without
 * --auth, --auth is what makes the comparison possible.
 *
 * The server's JSON-RPC error message is quoted in the not-evaluable
 * details when the 220-character limit leaves room for it; the fixed text
 * is kept short so a tunnel hostname (the actionable part of "Invalid Host:
 * abc123.ngrok-free.app") fits whole.
 */
function unauthenticatedRefusalVerdict(ctx: ModernSuiteContext, refusal: AuthRefusal): TestOutcome {
  const status = refusal.statusCode;
  if (refusal.kind !== "forbidden") {
    const hint = ctx.hasAuth ? "" : "; pass --auth to exercise the rest of the auth suite";
    return { passed: true, details: `HTTP ${status} (unauthenticated request rejected)${hint}` };
  }
  const bare = `HTTP ${status} without a Bearer challenge`;
  if (credentialedDiscoverServed(ctx)) {
    return {
      passed: true,
      details: `${bare} (unauthenticated request rejected; the same request with the credential was served) -- the spec expects 401 when authorization is required`,
    };
  }
  const head = `not evaluable: ${bare}`;
  const rejection = ctx.state.discoverRejection;
  let tail: string;
  if (namesHostOrOriginValidation(refusal.message)) {
    tail = " names Host/Origin validation, not authentication: allow the hostname you tested through";
  } else if (!ctx.hasAuth) {
    tail = " may be Host/Origin validation or a gateway; pass --auth to compare with a credentialed request";
  } else if (rejection?.statusCode === 403) {
    tail =
      " may be Host/Origin validation or a gateway; the credentialed request got 403 too: fix the gateway or allowed hosts";
  } else {
    // Never a 2xx here: a credentialed discover answered at 2xx got past the
    // gate, and credentialedDiscoverServed passed the check above.
    const seen = rejection
      ? ` (HTTP ${rejection.statusCode}${rejection.code === null ? "" : `, ${errorWithCode(rejection.rawCode)}`})`
      : "";
    tail = ` may be Host/Origin validation or a gateway; the credentialed request was not served either${seen}`;
  }
  // ` ("` and `")` around the message; a message clipped below 16 characters says too little to keep.
  const room = 220 - head.length - tail.length - 5;
  const quoted = refusal.message && room >= 16 ? ` ("${clip(refusal.message, room)}")` : "";
  return { passed: false, details: clip(`${head}${quoted}${tail}`, 220) };
}

/**
 * security-auth-required's verdict for an unauthenticated server/discover
 * the server answered with neither 401 nor 403 (readAuthRefusal found no
 * refusal to read). Only a 2xx is the accepted request the check is looking
 * for. Every other status refused the request without asking for a
 * credential -- a 404 from a wrong path, a gateway's or rate limiter's 4xx,
 * a 3xx that sends the client somewhere else -- and a 5xx is the server
 * breaking on the request rather than refusing it. All of them fail: none
 * shows the server rejecting unauthenticated requests. They are worded
 * apart because the fix differs (put an auth gate in front / fix the URL /
 * fix the server), and calling a 500 an "accepted request" is simply untrue.
 */
function unauthenticatedOtherStatus(ctx: ModernSuiteContext, res: RpcResponse): TestOutcome {
  const seen = `HTTP ${res.statusCode}, ${summarize(res)}`;
  if (is2xx(res.statusCode)) {
    const hint = ctx.hasAuth ? "" : " (no --auth provided)";
    return { passed: false, details: `${seen} -- server accepted unauthenticated request${hint}` };
  }
  let what: string;
  if (res.statusCode >= 500) {
    what = "the server failed on the request rather than refusing it (a broken server, or a gateway with no backend)";
  } else if (is4xx(res.statusCode)) {
    what = "the request was refused, but not as an authentication refusal (a wrong path, a gateway or a rate limiter)";
  } else {
    what = "the server redirected the request instead of answering it";
  }
  return { passed: false, details: clip(`${seen} -- ${what}; the spec answers a missing credential with 401`, 220) };
}

/** "Connection closed without a response (<first line of the error>)" for a drop that counted as a refusal. */
function closedWithoutResponse(err: unknown): string {
  return `Connection closed without a response (${clip(firstLine(errorMessage(err)), 60)})`;
}

/** Push a warning unless the identical text is already queued (tests sharing a target share the note). */
function warnOnce(ctx: ModernSuiteContext, text: string): void {
  if (!ctx.harness.warnings.includes(text)) ctx.harness.warnings.push(text);
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
  if (err) return errorWithCode(err.rawCode);
  return resultOf(res.body) ? "result" : "non-JSON-RPC body";
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The JSON-RPC response in a raw HTTP response body. The server MUST
 * answer a POSTed request with either application/json or
 * text/event-stream, and the client MUST support both
 * (basic/transports/streamable-http#sending-messages), so an SSE body is
 * read as its events: the first one carrying `result` or `error` is the
 * response (notifications before it are skipped; an error without an id,
 * which a rejection may carry, still counts). Anything else is plain JSON.
 */
function rpcBodyOf(text: string, contentType: string | string[] | undefined): unknown {
  const type = (Array.isArray(contentType) ? contentType.join(", ") : (contentType ?? "")).toLowerCase();
  if (type.includes("text/event-stream")) {
    const response = parseSSEMessages(text).find(
      (m) => !!m && typeof m === "object" && ("result" in m || "error" in m),
    );
    return response ?? parseJson(text);
  }
  return parseJson(text);
}

/**
 * RFC 8707 / MCP canonical form of a server URI for comparison: lowercase
 * scheme and host (URL parsing does that), no trailing slash, no fragment.
 * Returns null when the value is not an absolute URI.
 */
function canonicalUri(value: string): string | null {
  try {
    const u = new URL(value);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return null;
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

function requiredOf(tool: any): string[] {
  const required = tool?.inputSchema?.required;
  return Array.isArray(required) ? required.filter((r: unknown): r is string => typeof r === "string") : [];
}

function isNamedTool(tool: any): boolean {
  return !!tool && typeof tool.name === "string";
}

/**
 * How a tool's annotations place it on the write-safety ladder the
 * injection tests climb. The spec defaults are readOnlyHint false and
 * destructiveHint TRUE, so a tool that says nothing is destructive until
 * proven otherwise; only an explicit readOnlyHint true or destructiveHint
 * false clears it.
 *
 * @internal Exported for testing.
 */
export type ToolSafety = "read-only" | "non-destructive" | "unannotated" | "destructive";

const SAFETY_ORDER: ToolSafety[] = ["read-only", "non-destructive", "unannotated", "destructive"];

export function toolSafety(tool: any): ToolSafety {
  const annotations = tool?.annotations;
  if (annotations?.readOnlyHint === true) return "read-only";
  if (annotations?.destructiveHint === false) return "non-destructive";
  if (annotations?.destructiveHint === true) return "destructive";
  return "unannotated";
}

function isReadOnly(tool: any): boolean {
  return toolSafety(tool) === "read-only";
}

function isHeaderMirrored(schema: any): boolean {
  return typeof schema?.["x-mcp-header"] === "string" && schema["x-mcp-header"].length > 0;
}

/** The first non-null JSON Schema type of a schema, inferred from its shape when `type` is absent. */
function schemaType(schema: any): string | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  const declared = schema.type;
  if (Array.isArray(declared)) {
    const first = declared.find((t: unknown) => t !== "null");
    return typeof first === "string" ? first : declared.length > 0 ? "null" : undefined;
  }
  if (typeof declared === "string") return declared;
  if (schema.properties && typeof schema.properties === "object") return "object";
  if (schema.items !== undefined) return "array";
  return undefined;
}

/** A string argument whose value space is fixed (enum/const) or shaped (pattern): a payload can never satisfy it. */
function isConstrainedString(schema: any): boolean {
  return (
    (Array.isArray(schema?.enum) && schema.enum.length > 0) ||
    (!!schema && typeof schema === "object" && "const" in schema) ||
    typeof schema?.pattern === "string"
  );
}

/** Names of a tool's string-typed arguments: free-form ones first (declaration order), enum/const/pattern ones last. */
function stringParamsOf(tool: any): string[] {
  const strings = Object.entries(propertiesOf(tool)).filter(([, schema]) => schemaType(schema) === "string");
  return [
    ...strings.filter(([, schema]) => !isConstrainedString(schema)),
    ...strings.filter(([, schema]) => isConstrainedString(schema)),
  ].map(([name]) => name);
}

/** Every (tool, string argument) pair: free-form arguments of every tool first (list order), constrained ones last. */
function stringParams(tools: any[]): StringParam[] {
  const free: StringParam[] = [];
  const constrained: StringParam[] = [];
  for (const tool of tools) {
    if (!isNamedTool(tool)) continue;
    const props = propertiesOf(tool);
    for (const param of stringParamsOf(tool)) {
      (isConstrainedString(props[param]) ? constrained : free).push({ tool, param });
    }
  }
  return [...free, ...constrained];
}

const MAX_PLACEHOLDER_DEPTH = 4;

const FORMAT_PLACEHOLDERS: Record<string, string> = {
  email: "test@example.com",
  uri: "https://example.com/",
  url: "https://example.com/",
  "uri-reference": "https://example.com/",
  iri: "https://example.com/",
  hostname: "example.com",
  ipv4: "192.0.2.1",
  ipv6: "2001:db8::1",
  uuid: "00000000-0000-4000-8000-000000000000",
  date: "2024-01-01",
  time: "00:00:00Z",
  "date-time": "2024-01-01T00:00:00Z",
  duration: "PT1S",
};

function numberPlaceholder(schema: any, integer: boolean): number {
  let value = 1;
  if (typeof schema.minimum === "number" && value < schema.minimum) value = schema.minimum;
  if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) {
    value = schema.exclusiveMinimum + 1;
  }
  if (typeof schema.maximum === "number" && value > schema.maximum) value = schema.maximum;
  if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) {
    value = schema.exclusiveMaximum - 1;
  }
  return integer ? Math.ceil(value) : value;
}

function stringPlaceholder(schema: any): string {
  let value = typeof schema.format === "string" ? (FORMAT_PLACEHOLDERS[schema.format] ?? "test") : "test";
  const min = schema.minLength;
  if (Number.isInteger(min) && min > value.length) value = value.repeat(Math.ceil(min / value.length)).slice(0, min);
  const max = schema.maxLength;
  if (Number.isInteger(max) && max >= 0 && value.length > max) value = value.slice(0, max);
  return value;
}

/**
 * A placeholder that satisfies `schema` as far as its constraints can be
 * read: const, enum, default and examples verbatim; the first oneOf/anyOf
 * alternative; the first non-null type; minimum/exclusiveMinimum,
 * minItems (repeating the items placeholder), minLength/maxLength and
 * format on strings; nested required properties on objects. Used for a
 * required argument the probe is not targeting, so the payload in the
 * targeted argument reaches the handler instead of dying in validation.
 *
 * @internal Exported for testing.
 */
export function placeholderFor(schema: any, depth = 0): unknown {
  if (!schema || typeof schema !== "object" || depth > MAX_PLACEHOLDER_DEPTH) return "test";
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if ("default" in schema) return schema.default;
  if (Array.isArray(schema.examples) && schema.examples.length > 0) return schema.examples[0];
  for (const key of ["oneOf", "anyOf", "allOf"]) {
    const alternatives = schema[key];
    if (Array.isArray(alternatives) && alternatives.length > 0) return placeholderFor(alternatives[0], depth + 1);
  }
  const type = schemaType(schema);
  switch (type) {
    case "integer":
      return numberPlaceholder(schema, true);
    case "number":
      return numberPlaceholder(schema, false);
    case "boolean":
      return false;
    case "null":
      return null;
    case "array": {
      const min = Number.isInteger(schema.minItems) && schema.minItems > 0 ? schema.minItems : 0;
      const items = Array.isArray(schema.items) ? schema.items[0] : schema.items;
      return Array.from({ length: min }, () => placeholderFor(items, depth + 1));
    }
    case "object": {
      const props = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
      const out: Record<string, unknown> = {};
      for (const name of requiredOf({ inputSchema: schema })) out[name] = placeholderFor(props[name], depth + 1);
      return out;
    }
    default:
      return stringPlaceholder(schema);
  }
}

/** Placeholders for every required argument of `tool` other than `except`. */
function requiredFill(tool: any, except: string): Record<string, unknown> {
  const props = propertiesOf(tool);
  const fill: Record<string, unknown> = {};
  for (const name of requiredOf(tool)) {
    if (name === except) continue;
    fill[name] = placeholderFor(props[name]);
  }
  return fill;
}

/**
 * The single (tool, argument) an injection test probes.
 *
 * @internal Exported for testing.
 */
export interface InjectionTarget {
  tool: any;
  param: string;
  /** Placeholders for the tool's other required arguments, so the payload reaches the handler. */
  fill: Record<string, unknown>;
  /** Where the chosen tool sits on the annotation ladder. */
  safety: ToolSafety;
  /** Tools annotated destructiveHint true that were passed over in favour of this one. */
  skippedDestructive: string[];
  /** Unannotated tools (destructive by the spec default) passed over in favour of this one. */
  skippedUnannotated: string[];
  /** True when the chosen tool is destructive (annotated so, or by default) because nothing safer had a string argument. */
  destructiveProbed: boolean;
}

/**
 * Pick the one target an injection test sends its payloads to. Tools with
 * a string argument are tiered by annotation -- readOnlyHint true, then
 * destructiveHint false, then unannotated (destructive by the spec
 * default), then destructiveHint true -- and only the safest non-empty
 * tier is searched: a read-only tool is always preferred over any tool
 * that may write, whatever its argument names. Within the tier, `prefer`
 * lists argument-name patterns tried in order across the tools (a URL-ish
 * name for SSRF, a path-ish one for traversal); free-form string
 * arguments rank before enum/const/pattern ones, which no payload can
 * satisfy. When nothing matches, the target is the tier's first free-form
 * string argument -- the same target the other injection tests use.
 *
 * @internal Exported for testing.
 */
export function pickInjectionTarget(tools: any[], prefer: RegExp[] = []): InjectionTarget | null {
  const withStrings = tools.filter((t) => isNamedTool(t) && stringParamsOf(t).length > 0);
  if (withStrings.length === 0) return null;
  const tiers = SAFETY_ORDER.map((safety) => withStrings.filter((t) => toolSafety(t) === safety));
  const index = tiers.findIndex((tier) => tier.length > 0);
  const tier = tiers[index];
  const safety = SAFETY_ORDER[index];
  const passedOver = tiers.slice(index + 1).flat();

  const pairs = stringParams(tier);
  let chosen: StringParam | undefined;
  for (const re of prefer) {
    chosen = pairs.find(({ param }) => re.test(param));
    if (chosen) break;
  }
  chosen ??= pairs[0];
  return {
    tool: chosen.tool,
    param: chosen.param,
    fill: requiredFill(chosen.tool, chosen.param),
    safety,
    skippedDestructive: passedOver.filter((t) => toolSafety(t) === "destructive").map((t) => t.name),
    skippedUnannotated: passedOver.filter((t) => toolSafety(t) === "unannotated").map((t) => t.name),
    destructiveProbed: safety === "unannotated" || safety === "destructive",
  };
}

/** "a, b, c and 4 more" for a details/warning string. */
function nameList(names: string[], max = 6): string {
  if (names.length <= max) return names.join(", ");
  return `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
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
 * What a tool's output says about a payload. Every verbatim copy of the
 * payload is removed before the detector runs, so "&& echo pwned" coming
 * back as-is is not "pwned" produced by a shell:
 *
 * - "issue": the detector matched and nothing says the input was refused;
 * - "rejected": isError, or rejection wording (the server defended);
 * - "benign": a result with no evidence either way (an echo, "done", ...).
 *
 * @internal Exported for testing.
 */
export function classifyInjectionOutput(
  text: string,
  payload: string,
  detector: RegExp,
  isErrorFlag: boolean,
): "rejected" | "benign" | "issue" {
  const rejected = looksRejected(text, isErrorFlag);
  const scrubbed = payload ? text.split(payload).join(" ") : text;
  if (detector.test(scrubbed)) return rejected ? "rejected" : "issue";
  return rejected ? "rejected" : "benign";
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

/**
 * A tool name that cannot be an ordinary word in prose: it carries an
 * underscore, dot, hyphen, slash, colon or digit, or an internal capital
 * (camelCase). "read_file", "fs.read", "get-user", "v2" and "getUser" are
 * distinctive; "a", "get", "search" and "Search" are not.
 */
function isDistinctiveName(name: string): boolean {
  return /[_.\-/:0-9]/.test(name) || /[a-z][A-Z]/.test(name);
}

/**
 * The punctuation that can continue a tool name: the spec's tool-name
 * alphabet is letters, digits, underscore, hyphen and dot
 * (server/tools#tool-names), so a dot or hyphen followed by another name
 * character extends the identifier ("fs.read.all"), while a slash or colon
 * ends it ("fs.read/fs.write" names both).
 */
const IDENTIFIER_JOINER = "[.\\-]";

/**
 * Whether `text` mentions the tool `name`, case-insensitively.
 *
 * A distinctive name (see isDistinctiveName) counts wherever it stands as
 * a whole identifier: no letter, digit or underscore directly before or
 * after, and no further segment joined on with a dot or hyphen, so "call
 * fs.read first" and "fs.read." (sentence end) mention fs.read but
 * "fsXread", "fs.readAll", "fs.read.all" and "my.fs.read" do not (the name
 * is regex-escaped). A plain-word name is only a mention in code-like
 * context -- in backticks or quotes (`search`, "search", 'search'), called
 * (search()), or named as a tool ("the search tool") -- because the bare
 * word is ordinary prose: a tool named "a" or "search" next to "Search the
 * web for a page" is not a cross-reference.
 *
 * @internal Exported for testing.
 */
export function mentionsName(text: string, name: string): boolean {
  if (!name) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (isDistinctiveName(name)) {
    const before = `(?<![A-Za-z0-9_]|[A-Za-z0-9_]${IDENTIFIER_JOINER})`;
    const after = `(?![A-Za-z0-9_]|${IDENTIFIER_JOINER}[A-Za-z0-9_])`;
    return new RegExp(`${before}${escaped}${after}`, "i").test(text);
  }
  const codeLike = [
    `\`${escaped}\``,
    `"${escaped}"`,
    `'${escaped}'`,
    // Curly double and single quotes, as escapes to keep this file ASCII.
    `\u201C${escaped}\u201D`,
    `\u2018${escaped}\u2019`,
    `(^|[^A-Za-z0-9_])${escaped}\\(`,
    `\\bthe\\s+${escaped}\\s+tool\\b`,
  ];
  return new RegExp(codeLike.join("|"), "i").test(text);
}

/**
 * Verdict for a tool-dependent test that got no tools list: a skip-pass
 * when the server declares no tools; otherwise the list call failed, and
 * `listUnavailable` skip-passes pointing at tools-list when that test is
 * in the run, or fails with the recorded reason when it was filtered out.
 */
function toolsUnavailable(ctx: ModernSuiteContext): TestOutcome {
  if (!hasTools(ctx)) return { passed: true, details: "Skipped: server declares no tools" };
  return listUnavailable(ctx, "tools", "no tools to test");
}

/**
 * The tools list for a tool-dependent test, fetched once on demand, or
 * the verdict when there is none to test (`toolsUnavailable`, or a
 * skip-pass when the server lists no tools).
 */
async function toolsOrSkip(ctx: ModernSuiteContext): Promise<{ tools: any[]; skip: TestOutcome | null }> {
  const tools = await ensureTools(ctx);
  if (tools === null) return { tools: [], skip: toolsUnavailable(ctx) };
  if (tools.length === 0) return { tools, skip: { passed: true, details: "No tools available to test (skipped)" } };
  return { tools, skip: null };
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
 * params. Issues are keyed on the leaked text itself, so one stack frame
 * repeated across every error response is one issue (with the first
 * sample as context and a repeat count), and the `max` cap covers
 * distinct leaks.
 *
 * @internal Exported for testing.
 */
export function findLeaks(samples: ErrorSample[], patterns: RegExp[], max = 3): string[] {
  const leaks = new Map<string, { context: string; count: number }>();
  for (const sample of samples) {
    for (const pattern of patterns) {
      const match = pattern.exec(sample.text);
      if (!match) continue;
      if (sample.requestText.includes(match[0])) continue;
      const seen = leaks.get(match[0]);
      if (seen) seen.count++;
      else leaks.set(match[0], { context: sample.text, count: 1 });
      break; // one finding per sample is enough
    }
  }
  return [...leaks.entries()]
    .slice(0, max)
    .map(
      ([leak, { context, count }]) =>
        `Response contains: ${clip(leak, 60)} (matched in: ${clip(context, 80)}${count > 1 ? `; in ${count} responses` : ""})`,
    );
}

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------

export async function runSecurity(ctx: ModernSuiteContext): Promise<void> {
  // The unauthenticated `server/discover` is shared by the auth tests so
  // the suite sends it once (memoized per run, fetched lazily so a
  // `--only` on any one of them still works).
  let unauthenticated: Promise<RpcResponse> | null = null;
  const unauthenticatedDiscover = () => {
    unauthenticated ??= ctx.client.rpc(DISCOVER, {}, { omitUserHeaders: ["authorization"] });
    return unauthenticated;
  };

  // The failure probes are shared by the two information-disclosure
  // tests the same way.
  let probes: Promise<ErrorProbes> | null = null;
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

  /**
   * Whether the credential-less server/discover drew a refusal
   * security-auth-required could not attribute to authentication: a 403
   * with no Bearer challenge that no served credentialed request pins on
   * the missing credential (unauthenticatedRefusalVerdict's not-evaluable
   * branch). Its siblings send a request with no valid credential and
   * credit the 401/403 that answers it -- a Host guard, an Origin check or
   * a gateway answers every request with that same 403, so crediting it
   * would turn one unattributable refusal into four passes. They skip
   * instead (the 2025-11-25 siblings take the same skip).
   *
   * Read from the memoized probe rather than from a flag another check
   * sets, so `--only security-www-authenticate` reads it too. False when
   * the probe got no HTTP answer at all: each caller reads a missing
   * answer through unansweredProbe itself.
   */
  let attribution: Promise<boolean> | null = null;
  const authNotEvaluable = () => {
    attribution ??= unauthenticatedDiscover().then(
      (res) => readAuthRefusal(res, false)?.kind === "forbidden" && !credentialedDiscoverServed(ctx),
      () => false,
    );
    return attribution;
  };
  /**
   * The skip itself says what was seen and why it proves nothing -- only a
   * 403 reads as "forbidden" -- so it stands on its own in a report that was
   * filtered (`--only`, `--skip`) to leave security-auth-required out; the
   * pointer is where the full reading (the quoted message, the advice) is.
   */
  const AUTH_NOT_EVALUABLE: TestOutcome = {
    passed: true,
    details:
      "Skipped: HTTP 403 without a Bearer challenge, not attributable to authentication (see security-auth-required)",
  };

  await check("security-auth-required", async () => {
    if (ctx.kind !== "http") return notApplicable("no HTTP auth");
    // Sent with or without --auth: the server's answer to a request that
    // carries no Authorization is the fact under test either way.
    try {
      const res = await unauthenticatedDiscover();
      // The probe carried no Authorization, whatever --auth says.
      const refusal = readAuthRefusal(res, false);
      if (refusal) return unauthenticatedRefusalVerdict(ctx, refusal);
      // Neither 401 nor 403: a 2xx is the accepted request, and every
      // other status is a refusal that is not an auth refusal (or a
      // server that broke on it). See unauthenticatedOtherStatus.
      return unauthenticatedOtherStatus(ctx, res);
    } catch (err) {
      // No HTTP answer: a refusal only when the server dropped a request
      // it served with the credential (see unansweredProbe).
      const verdict = unansweredProbe(ctx, "unauthenticated server/discover", err, credentialedDiscoverServed(ctx));
      if (verdict) return verdict;
      return {
        passed: true,
        details: `${closedWithoutResponse(err)}; the same request with the credential was served (unauthenticated request rejected)`,
      };
    }
  });

  await check("security-www-authenticate", async () => {
    if (ctx.kind !== "http") return notApplicable("no HTTP auth");
    try {
      const res = await unauthenticatedDiscover();
      // Read the refusal the way security-auth-required reads it. A 401,
      // or a 403 carrying a Bearer challenge, asks for the credential the
      // request lacked, and the challenge is what a client starts
      // authorization from either way (the spec's insufficient-scope 403
      // SHOULD carry resource_metadata "for consistency with 401
      // responses"), so both are checked here -- the details name the
      // status when it is not the 401 the spec expects.
      const refusal = readAuthRefusal(res, false);
      if (refusal && refusal.kind !== "forbidden") {
        const challenge = headerOf(res.headers, "www-authenticate");
        if (challenge) {
          const prm = parseResourceMetadata(challenge);
          if (!prm.present) {
            ctx.harness.warnings.push(
              "security-www-authenticate: the WWW-Authenticate challenge carries no resource_metadata parameter; clients must fall back to the well-known Protected Resource Metadata URL.",
            );
          } else if (!prm.url) {
            ctx.harness.warnings.push(
              `security-www-authenticate: the WWW-Authenticate resource_metadata value "${clip(prm.raw, 80)}" is not an absolute http(s) URL (RFC 9728 section 5.1 requires one); clients cannot locate the Protected Resource Metadata from it.`,
            );
          }
          const where = refusal.statusCode === 401 ? "" : ` (HTTP ${refusal.statusCode})`;
          return { passed: true, details: `WWW-Authenticate: ${clip(challenge, 150)}${where}` };
        }
        // Only a 401 reaches this: a 403 reads as auth-required precisely
        // when it carries a Bearer challenge.
        return {
          passed: false,
          details:
            "HTTP 401 but missing WWW-Authenticate header (spec: SHOULD include to indicate required auth scheme)",
        };
      }
      if (refusal) {
        // A bare 403. When security-auth-required could not attribute it to
        // authentication, the same refusal is no evidence here either, so
        // this skips rather than passing on it (see authNotEvaluable).
        if (await authNotEvaluable()) return AUTH_NOT_EVALUABLE;
        return { passed: true, details: "HTTP 403 (WWW-Authenticate not applicable for 403)" };
      }
      return { passed: true, details: `HTTP ${res.statusCode} -- not a 401 response (skipped)` };
    } catch (err) {
      const verdict = unansweredProbe(ctx, "unauthenticated server/discover", err, credentialedDiscoverServed(ctx));
      if (verdict) return verdict;
      warnOnce(
        ctx,
        "security-www-authenticate: the server closed the connection on the unauthenticated server/discover instead of answering HTTP 401; MCP clients start authorization from the 401 and its WWW-Authenticate challenge, so a dropped connection leaves them nothing to act on. Answer 401 with WWW-Authenticate: Bearer resource_metadata=...",
      );
      // No response, so no challenge: nothing was checked.
      return {
        passed: true,
        details: `${closedWithoutResponse(err)} -- not a 401 response, no challenge to check (see warning)`,
        skipped: true,
      };
    }
  });

  await check("security-auth-malformed", async () => {
    if (ctx.kind !== "http") return notApplicable("no HTTP auth");
    // Only meaningful next to a credential the server accepts: without
    // one, "rejects invalid tokens" cannot be told from "rejects everything".
    if (!ctx.hasAuth)
      return { passed: true, details: "Skipped: needs a valid credential to compare against (pass --auth)" };
    // Nor when the credential-less server/discover drew a 403 nothing could
    // attribute to authentication: the malformed credential draws the same
    // 403 from the same guard, which proves nothing about token validation.
    if (await authNotEvaluable()) return AUTH_NOT_EVALUABLE;
    const outcome = await checkMalformedAuth(ctx);
    // Nor when the server refused the configured credential too: then the
    // 401 the invalid ones drew is what every credential draws, the
    // "rejects everything" the comparison exists to rule out. Only a pass
    // turns into the skip -- an invalid credential the server ACCEPTED, or a
    // 5xx on one, is a finding whatever the valid one drew.
    const refused = credentialRefusedStatus(ctx);
    if (outcome.passed && refused !== null) {
      return credentialRefusedSkip(refused, "rejecting invalid tokens cannot be told from rejecting everything");
    }
    return outcome;
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
    const probeTimeout = Math.min(ctx.timeout, 5000);
    try {
      const res = await request(httpUrl, {
        method: "POST",
        headers: probe.headers,
        body: probe.body,
        signal: AbortSignal.timeout(probeTimeout),
      });
      await res.body.text();
      const status = res.statusCode;
      if ([301, 302, 307, 308].includes(status)) return tlsRedirectVerdict(status, res.headers.location, httpUrl);
      if (status >= 400) return { passed: true, details: `HTTP ${status} (plaintext rejected)` };
      return { passed: false, details: `HTTP ${status} -- server accepts plaintext HTTP connections` };
    } catch (err) {
      // Unlike the auth probes, no answer IS the answer here: the question
      // is whether the endpoint is served in the clear, and a refused,
      // dropped or silent plaintext connection serves nothing.
      return { passed: true, details: `Plaintext http:// probe got ${noResponse(err, probeTimeout)} (HTTPS enforced)` };
    }
  });

  await check("security-oauth-metadata", async () => {
    if (ctx.kind !== "http") return notApplicable("no OAuth");
    // The challenge on the unauthenticated discover names the metadata
    // URL clients try first; without --auth that refusal is also what
    // says the server is auth-protected at all, so it is read the way
    // security-auth-required reads it:
    //
    // - a 401, or a 403 carrying a Bearer challenge, is an authentication
    //   refusal, and its challenge is the URL clients MUST use;
    // - a bare 403 is not one on its own (Origin validation, the SDK's
    //   Host guard and gateways answer with it). With --auth the run is
    //   testing a protected resource whatever that 403 was, so the
    //   well-known locations are still worth checking; without one there
    //   is no evidence the server is auth-protected at all, so the check
    //   skips instead of reporting a missing PRM document on a server
    //   that may not be an OAuth resource server (see authNotEvaluable).
    //   With --auth, a 403 security-auth-required could not attribute is
    //   handed to the lookup as the guard's status: a Host guard or gateway
    //   refusing every request refuses the well-known locations too, and
    //   when every one of them drew that same status the lookup measured
    //   the guard, not a missing document, and skips the same way (a
    //   document it does find, or any other answer, still decides);
    // - any other status is neither a served request nor a refusal: the
    //   2xx says the server needs no credential, and the rest say only
    //   that this run never reached an auth gate.
    //
    // An rpc that throws got no HTTP answer of any status: an unreachable
    // (or hung) server, never an auth refusal -- except a drop the
    // credentialed discover pins on the missing credential (see
    // unansweredProbe), which leaves an auth-protected server with no
    // challenge, so the well-known locations are what a client has.
    let challenge: string | undefined;
    let guardStatus: number | undefined;
    try {
      const res = await unauthenticatedDiscover();
      const refusal = readAuthRefusal(res, false);
      if (refusal && refusal.kind !== "forbidden") {
        challenge = headerOf(res.headers, "www-authenticate");
      } else if (refusal) {
        if (await authNotEvaluable()) {
          if (!ctx.hasAuth) return AUTH_NOT_EVALUABLE;
          guardStatus = refusal.statusCode;
        }
      } else if (!ctx.hasAuth) {
        return is2xx(res.statusCode)
          ? {
              passed: true,
              details: `Skipped: server does not require auth (unauthenticated server/discover answered HTTP ${res.statusCode})`,
            }
          : {
              passed: true,
              details: `Skipped: the unauthenticated server/discover answered HTTP ${res.statusCode}, neither a served request nor an authentication refusal (pass --auth to check the metadata anyway)`,
            };
      }
    } catch (err) {
      const verdict = unansweredProbe(ctx, "unauthenticated server/discover", err, credentialedDiscoverServed(ctx));
      if (verdict) return verdict;
    }
    return checkProtectedResourceMetadata(ctx, challenge, guardStatus);
  });

  await check("security-token-in-uri", async () => {
    if (ctx.kind !== "http") return notApplicable("no HTTP auth");
    if (!ctx.hasAuth)
      return { passed: true, details: "Skipped: needs a valid credential to place in the URI (pass --auth)" };
    const token = authorizationOf(ctx)
      .replace(/^Bearer\s+/i, "")
      .trim();
    if (!token) return { passed: true, details: "Skipped: could not extract token from auth header" };
    // The probe is sent whatever the refusals so far say: a server that
    // accepts the token in the query string fails however it treats the
    // header. Only a refusal is read against them. A 401/403 is no evidence
    // when the credential-less server/discover drew a 403 nothing could
    // attribute to authentication (a Host guard or gateway answers this
    // probe with the same 403: see authNotEvaluable), and no refusal is when
    // the server refused the configured credential in the header too
    // (credentialRefusedStatus): the token was never going to be accepted
    // anywhere, so where it travelled decided nothing.
    const refused = credentialRefusedStatus(ctx);
    const notAccepted = (details: string): TestOutcome =>
      refused === null
        ? { passed: true, details }
        : credentialRefusedSkip(refused, "refusing it in the query string proves nothing");
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
        if (await authNotEvaluable()) return AUTH_NOT_EVALUABLE;
        return notAccepted(`HTTP ${status} (token in query string rejected)`);
      }
      if (is2xx(status)) {
        const body = rpcBodyOf(text, res.headers["content-type"]);
        const err = errorOf(body);
        if (err)
          return notAccepted(`HTTP ${status}, ${errorWithCode(err.rawCode)} (token in query string not accepted)`);
        const shape = resultOf(body) ? "result" : "non-error body";
        return {
          passed: false,
          details: `HTTP ${status}, ${shape} -- server accepted the auth token in the query string (MUST NOT)`,
        };
      }
      return notAccepted(`HTTP ${status} (token in query string not accepted)`);
    } catch (err) {
      // The probe differs from the served credentialed discover only in
      // where the token travels, so a drop is pinned on that.
      const verdict = unansweredProbe(
        ctx,
        "server/discover with the token in the query string",
        err,
        credentialedDiscoverServed(ctx),
      );
      if (verdict) return verdict;
      return { passed: true, details: `${closedWithoutResponse(err)} (token in query string not accepted)` };
    }
  });

  await check("security-cors-headers", async () => {
    if (ctx.kind !== "http") return notApplicable("no CORS");
    return checkCorsHeaders(ctx);
  });

  await check("security-origin-validation", async () => {
    if (ctx.kind !== "http") return notApplicable("no Origin header");
    return checkOriginValidation(ctx);
  });
}

/**
 * security-origin-validation: a fully valid server/discover -- the setup
 * request, same headers, same credential -- with a foreign Origin, which
 * streamable-http says MUST draw 403 Forbidden. What the answer shows:
 *
 * - a 2xx: the server accepted the request; fails;
 * - a 401/403: the refusal the spec asks for, when the Origin is the one
 *   variable -- the conformant setup discover got past whatever stands in
 *   front of the server (conformantDiscoverServed), or was answered with a
 *   different status (a server that checks the Origin before auth answers
 *   the credential-less setup request 401 and the foreign Origin 403). When
 *   the setup request drew the same status or no answer, that 401/403 is
 *   what an auth gate, a Host guard or a gateway answers every request
 *   with, and it says nothing about the Origin: the check skips, as the
 *   auth siblings skip the refusal security-auth-required could not
 *   attribute;
 * - a 429: a rate limiter answered before the server read the request. The
 *   probe is resent once after the wait it asks for (retryAfterMs), and a
 *   second 429 is not evaluable -- the Origin was never looked at;
 * - a 5xx: the server failed on the request rather than refusing it (the
 *   reading security-auth-required and security-oversized-input give the
 *   same status); fails;
 * - any other 4xx (400, 404, ...): refused, and passes as before -- the
 *   spec's status is 403, but a request rejected for its Origin is rejected;
 * - anything else (a redirect): fails, naming the status.
 *
 * A dropped connection counts as a refusal only when the conformant
 * discover got past the gate (unansweredProbe); a timeout or a refused
 * connection measured nothing.
 */
async function checkOriginValidation(ctx: ModernSuiteContext): Promise<TestOutcome> {
  // A fully valid discover: the Origin is the only defect.
  const send = () => ctx.client.rpc(DISCOVER, {}, { headers: { Origin: REBINDING_ORIGIN } });
  try {
    let res = await send();
    /** "HTTP 429, then after Nms " once a throttled probe was resent. */
    let throttled = "";
    if (res.statusCode === 429) {
      const wait = retryAfterMs(res.headers);
      await pause(wait, ctx.signal);
      throttled = `HTTP 429, then after ${wait}ms `;
      res = await send();
    }
    const status = res.statusCode;
    if (is2xx(status)) {
      return {
        passed: false,
        details: `${throttled}HTTP ${status}, ${summarize(res)} -- server accepted a request with an untrusted Origin (MUST validate Origin, 403)`,
      };
    }
    if (status === 429) {
      return {
        passed: false,
        details: `${throttled}HTTP 429 -- not evaluable: a rate limiter answered before the server read the request, so the Origin was never checked`,
      };
    }
    if (status >= 500) {
      return {
        passed: false,
        details: clip(
          `${throttled}HTTP ${status}, ${summarize(res)} -- the server failed on the request rather than refusing it (a broken server, or a gateway with no backend); an untrusted Origin MUST draw 403`,
          220,
        ),
      };
    }
    const setupStatus = ctx.state.discoverRejection?.statusCode;
    const originDecided = conformantDiscoverServed(ctx) || (setupStatus !== undefined && setupStatus !== status);
    if ((status === 401 || status === 403) && !originDecided) {
      return {
        passed: true,
        details: `Skipped: HTTP ${status} to the foreign Origin, but the conformant server/discover was not served either, so the refusal is not attributable to the Origin (see security-auth-required)`,
      };
    }
    if (is4xx(status)) return { passed: true, details: `${throttled}HTTP ${status} (suspicious Origin rejected)` };
    return { passed: false, details: `${throttled}HTTP ${status}` };
  } catch (err) {
    // The probe is the conformant discover plus a foreign Origin, so a
    // drop is pinned on the Origin when that discover got past the gate.
    const verdict = unansweredProbe(ctx, "server/discover with a foreign Origin", err, conformantDiscoverServed(ctx));
    if (verdict) return verdict;
    return { passed: true, details: `${closedWithoutResponse(err)} (suspicious Origin rejected)` };
  }
}

/**
 * A redirect answer to the plaintext probe. It enforces TLS only when its
 * Location, resolved against the http:// URL the probe used (a relative
 * "/mcp" stays on http), is an https URL: a redirect to http, or with no
 * usable Location, leaves the client on plaintext, which the catalog's
 * "redirect http to https or refuse" and the spec's communication security
 * ("Implementations MUST follow OAuth 2.1 Section 1.5",
 * basic/authorization/security-considerations#communication-security) do
 * not allow. Location is a single URI-reference (RFC 9110 section 10.2.2),
 * so a response carrying several (undici hands them over as an array) names
 * no one target and does not enforce anything either.
 */
function tlsRedirectVerdict(status: number, location: string | string[] | undefined, httpUrl: string): TestOutcome {
  const values = (Array.isArray(location) ? location : [location])
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((v) => v !== "");
  if (values.length > 1) {
    return {
      passed: false,
      details: clip(
        `HTTP ${status} redirect with ${values.length} Location headers (${values.join(", ")}) -- no single target, the plaintext request is not sent to HTTPS`,
        220,
      ),
    };
  }
  const raw = values[0];
  if (!raw) {
    return {
      passed: false,
      details: `HTTP ${status} redirect with no Location header -- the plaintext request is not sent to HTTPS`,
    };
  }
  let target: URL | null = null;
  try {
    target = new URL(raw, httpUrl);
  } catch {}
  if (!target) {
    return {
      passed: false,
      details: `HTTP ${status} redirect to an unparseable Location "${clip(raw, 80)}" -- the plaintext request is not sent to HTTPS`,
    };
  }
  if (target.protocol !== "https:") {
    return {
      passed: false,
      details: `HTTP ${status} redirect to ${clip(target.href, 80)} -- not HTTPS, the client stays on plaintext`,
    };
  }
  return { passed: true, details: `HTTP ${status} redirect to HTTPS (${clip(raw, 80)})` };
}

/**
 * Two credentials in place of the configured one: a well-formed token no
 * authorization server issued (MUST draw 401; 403 tolerated) and a value
 * outside the b64token grammar (a malformed request, which may draw 400
 * per RFC 6750 invalid_request and the spec's error table, or 401/403).
 * A probe that got no HTTP answer is read the way unansweredProbe reads
 * every other negative probe: a dropped connection the served credentialed
 * discover pins on the credential is "connection rejected", a timeout or a
 * refused connection measured nothing, and a caller's abort is rethrown.
 */
async function checkMalformedAuth(ctx: ModernSuiteContext): Promise<TestOutcome> {
  /** The unreachable() verdict of each probe that got no answer and no refusal either. */
  const unanswered: TestOutcome[] = [];
  const probe = async (value: string, what: string): Promise<RpcResponse | null> => {
    try {
      // Drop the configured (valid) Authorization first, then supply the
      // replacement; without the omit the valid user header would
      // survive the case-insensitive merge and the server would accept.
      return await ctx.client.rpc(
        DISCOVER,
        {},
        { omitUserHeaders: ["authorization"], headers: { Authorization: value } },
      );
    } catch (err) {
      const verdict = unansweredProbe(ctx, `server/discover with ${what}`, err, credentialedDiscoverServed(ctx));
      if (verdict) unanswered.push(verdict);
      return null;
    }
  };
  const invalid = await probe(INVALID_TOKEN_AUTH, "a well-formed invalid token");
  const garbage = await probe(MALFORMED_AUTH, "a malformed Authorization header");

  const issues: string[] = [];
  const seen: string[] = [];
  if (!invalid) {
    seen.push("well-formed invalid token: connection rejected");
  } else if (invalid.statusCode === 401 || invalid.statusCode === 403) {
    seen.push(`well-formed invalid token: HTTP ${invalid.statusCode}`);
  } else if (is2xx(invalid.statusCode)) {
    issues.push(
      `well-formed invalid token: HTTP ${invalid.statusCode}, ${summarize(invalid)} -- server accepted an invalid bearer token (MUST answer 401)`,
    );
  } else {
    issues.push(
      `well-formed invalid token: HTTP ${invalid.statusCode}, ${summarize(invalid)} -- expected 401 (invalid tokens MUST receive 401)`,
    );
  }
  if (!garbage) {
    seen.push("malformed credential: connection rejected");
  } else if (garbage.statusCode === 400) {
    seen.push("malformed credential: HTTP 400 (RFC 6750 invalid_request)");
  } else if (garbage.statusCode === 401 || garbage.statusCode === 403) {
    seen.push(`malformed credential: HTTP ${garbage.statusCode}`);
  } else if (is2xx(garbage.statusCode)) {
    issues.push(
      `malformed credential: HTTP ${garbage.statusCode}, ${summarize(garbage)} -- server accepted a malformed Authorization header`,
    );
  } else {
    issues.push(`malformed credential: HTTP ${garbage.statusCode}, ${summarize(garbage)} -- expected 400 or 401`);
  }
  if (issues.length > 0) return { passed: false, details: clip(issues.join("; "), 220) };
  // A wrong answer to one probe outranks the other probe measuring nothing;
  // without one, a probe that was never answered leaves the check unmeasured.
  if (unanswered.length > 0) return unanswered[0];
  return { passed: true, details: seen.join("; ") };
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
 * The resource_metadata parameter of a WWW-Authenticate challenge (RFC
 * 9728 section 5.1): whether it is there at all, its (trimmed) value, and
 * that value as a URL when it is an absolute http(s) one -- the only form
 * a client can fetch. security-www-authenticate and security-oauth-metadata
 * read the challenge through this one parser so they cannot disagree.
 *
 * @internal Exported for testing.
 */
export function parseResourceMetadata(challenge: string | undefined): {
  present: boolean;
  raw: string;
  url: string | null;
} {
  const m = challenge ? /resource_metadata\s*=\s*(?:"([^"]*)"|([^\s,;]+))/i.exec(challenge) : null;
  if (!m) return { present: false, raw: "", url: null };
  const raw = (m[1] ?? m[2] ?? "").trim();
  let url: string | null = null;
  try {
    const u = new URL(raw);
    if (u.protocol === "http:" || u.protocol === "https:") url = raw;
  } catch {}
  return { present: true, raw, url };
}

type PrmFetch =
  | { ok: true; resource: string; authorizationServers: number }
  | { ok: false; status: number | null; problem: string };

/** One GET of a Protected Resource Metadata candidate, validated to the RFC 9728 minimum MCP needs. */
async function fetchProtectedResourceMetadata(url: string, timeout: number): Promise<PrmFetch> {
  let res: Awaited<ReturnType<typeof getJson>>;
  try {
    res = await getJson(url, timeout);
  } catch (err) {
    return { ok: false, status: null, problem: `is unreachable (${clip(errorMessage(err), 60)})` };
  }
  if (res.status !== 200) return { ok: false, status: res.status, problem: `answered HTTP ${res.status}` };
  const meta = res.json;
  if (!meta || typeof meta !== "object") return { ok: false, status: 200, problem: "returned a non-JSON body" };
  if (!meta.resource) return { ok: false, status: 200, problem: "is missing the required 'resource' field" };
  if (!Array.isArray(meta.authorization_servers) || meta.authorization_servers.length === 0) {
    return { ok: false, status: 200, problem: "is missing the 'authorization_servers' array" };
  }
  return { ok: true, resource: String(meta.resource), authorizationServers: meta.authorization_servers.length };
}

/**
 * RFC 9728 Protected Resource Metadata, located the way the spec makes
 * clients locate it (authorization-server-discovery#protected-resource-
 * metadata-discovery-requirements). When the 401's WWW-Authenticate
 * challenge carries resource_metadata, clients MUST fetch that URL and
 * nothing else, so a challenge URL that is unreachable, non-200 or
 * malformed fails outright -- the well-known locations are consulted only
 * to say whether a valid document exists that the challenge should point
 * at. Without a challenge URL the well-known locations are tried in spec
 * order: the endpoint-path variant, then the root. The document's
 * `resource` must be the MCP endpoint (canonical form); a mismatch passes
 * with a warning. A legacy authorization-server document passes with a
 * warning.
 *
 * `guardStatus` is the status of a refusal of the endpoint nothing could
 * attribute to authentication (a bare 403, security-oauth-metadata's
 * caller). When every well-known location and the legacy document drew that
 * same status, the lookup only met the guard again -- a Host guard answers
 * every path of the host alike -- so "no metadata" is not what it found:
 * the check skips instead of advising a document the guard would never let
 * through.
 */
async function checkProtectedResourceMetadata(
  ctx: ModernSuiteContext,
  challenge?: string,
  guardStatus?: number,
): Promise<TestOutcome> {
  const parsed = new URL(ctx.backendUrl);
  const origin = `${parsed.protocol}//${parsed.host}`;
  const root = `${origin}/.well-known/oauth-protected-resource`;
  const path = parsed.pathname.replace(/\/+$/, "");
  const wellKnown = path && path !== "/" ? [`${root}${path}`, root] : [root];
  const whereOf = (url: string) => (url.startsWith(`${origin}/`) ? url.slice(origin.length) : clip(url, 80));

  const found = (label: string, doc: Extract<PrmFetch, { ok: true }>): TestOutcome => {
    let note = "";
    if (canonicalUri(doc.resource) !== canonicalUri(ctx.backendUrl)) {
      ctx.harness.warnings.push(
        `security-oauth-metadata: the Protected Resource Metadata at ${label} names resource "${clip(doc.resource, 80)}", which is not the MCP endpoint ${ctx.backendUrl} in canonical form; RFC 9728 section 3.3 has clients discard metadata whose resource does not match the URL they used.`,
      );
      note = " (resource does not match the endpoint, see warning)";
    }
    return {
      passed: true,
      details: `Protected Resource Metadata found at ${label}: resource=${clip(doc.resource, 60)}, ${doc.authorizationServers} auth server(s)${note}`,
    };
  };

  const prm = parseResourceMetadata(challenge);
  if (prm.present) {
    if (!prm.url) {
      return {
        passed: false,
        details: clip(
          `WWW-Authenticate resource_metadata "${clip(prm.raw, 80)}" is not an absolute http(s) URL (RFC 9728 section 5.1) -- clients MUST use the advertised URL and cannot fetch this one`,
          220,
        ),
      };
    }
    const label = `${whereOf(prm.url)} (via WWW-Authenticate)`;
    const doc = await fetchProtectedResourceMetadata(prm.url, ctx.timeout);
    if (doc.ok) return found(label, doc);
    // The spec sends clients to the advertised URL only, so a valid
    // document elsewhere does not rescue the verdict -- but it is worth
    // naming, since the fix is then one header.
    let elsewhere = "";
    for (const url of wellKnown) {
      if (url === prm.url) continue;
      const alt = await fetchProtectedResourceMetadata(url, ctx.timeout);
      if (alt.ok) {
        elsewhere = `; valid document at ${whereOf(url)}`;
        break;
      }
    }
    return {
      passed: false,
      details: clip(
        `WWW-Authenticate resource_metadata ${whereOf(prm.url)} ${doc.problem} -- clients MUST use the advertised URL, not the well-known fallback${elsewhere}`,
        220,
      ),
    };
  }

  const statuses: string[] = [];
  let malformed: string | null = null;
  let reachable = false;
  /** Whether every lookup so far drew guardStatus (see the doc comment). */
  let onlyTheGuard = guardStatus !== undefined;
  for (const url of wellKnown) {
    const label = whereOf(url);
    const doc = await fetchProtectedResourceMetadata(url, ctx.timeout);
    if (doc.ok) return found(label, doc);
    if (doc.status !== guardStatus) onlyTheGuard = false;
    if (doc.status === null) {
      statuses.push(`${label} -> unreachable`);
      continue;
    }
    reachable = true;
    statuses.push(`${label} -> HTTP ${doc.status}`);
    if (doc.status === 200) malformed ??= `PRM document at ${label} ${doc.problem}`;
  }
  if (malformed) return { passed: false, details: clip(malformed, 200) };
  if (!reachable) return { passed: false, details: "PRM endpoint unreachable" };

  // Legacy fallback: an authorization-server document at the root.
  try {
    const legacy = await getJson(`${origin}/.well-known/oauth-authorization-server`, ctx.timeout);
    if (legacy.status !== guardStatus) onlyTheGuard = false;
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
  } catch {
    onlyTheGuard = false;
  }
  if (onlyTheGuard) {
    return {
      passed: true,
      details: `Skipped: HTTP ${guardStatus} without a Bearer challenge on the endpoint and on every well-known metadata location, not attributable to authentication (see security-auth-required)`,
    };
  }
  return {
    passed: false,
    details: clip(`No Protected Resource Metadata (${statuses.join("; ")}) and no legacy OAuth metadata`, 220),
  };
}

type HttpRawRequest = (
  method: "GET" | "POST" | "DELETE" | "OPTIONS",
  body: string | undefined,
  extraHeaders: Record<string, string>,
  timeout: number,
  omitUserHeaders?: string[],
  signal?: AbortSignal,
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
 * a reflected foreign origin on either fails; when neither probe got a
 * response there is nothing to inspect, and the verdict is unreachable().
 */
async function checkCorsHeaders(ctx: ModernSuiteContext): Promise<TestOutcome> {
  const seen: string[] = [];
  const observations: CorsObservation[] = [];
  /** Why each probe got no response, for the verdict when neither did. */
  const failures: Array<{ probe: string; err: unknown; reason: string }> = [];

  const rawRequest = (ctx.transport as { rawRequest?: HttpRawRequest }).rawRequest;
  if (rawRequest) {
    const optionsTimeout = Math.min(ctx.timeout, 5000);
    try {
      const res = await rawRequest(
        "OPTIONS",
        undefined,
        {
          Origin: CORS_ORIGIN,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type, authorization, mcp-protocol-version, mcp-method",
        },
        optionsTimeout,
        undefined,
        ctx.signal,
      );
      observations.push({
        via: "OPTIONS",
        status: res.statusCode,
        acao: headerOf(res.headers, "access-control-allow-origin"),
        credentials: headerOf(res.headers, "access-control-allow-credentials"),
      });
    } catch (err: unknown) {
      if (ctx.signal?.aborted) throw err;
      seen.push("OPTIONS failed");
      failures.push({ probe: "OPTIONS preflight", err, reason: noResponse(err, optionsTimeout) });
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
  } catch (err: unknown) {
    if (ctx.signal?.aborted) throw err;
    seen.push("POST with Origin failed");
    failures.push({ probe: "POST server/discover with Origin", err, reason: noResponse(err, ctx.timeout) });
  }
  if (observations.length === 0) {
    // No response carried headers to inspect, so "no CORS headers" would
    // be a claim about responses that never arrived. Both probes carry
    // the foreign Origin and nothing else the served setup discover
    // lacked, so -- by the rule unansweredProbe applies to the Origin
    // probe of security-origin-validation -- a connection the server
    // accepted and closed on each of them is a refusal of cross-origin
    // access (a browser gets no CORS grant from a dropped connection
    // either). A timeout or a refused connection measured nothing.
    const probes = failures.map((f) => f.probe).join(" and ");
    const allDropped = failures.every((f) => classifyTransportError(f.err) === "dropped");
    if (allDropped && ctx.state.discover !== null) {
      return {
        passed: true,
        details: clip(
          `Connection closed without a response on ${probes}; the same server/discover without an Origin was served (cross-origin requests refused, no CORS headers to check)`,
          220,
        ),
      };
    }
    const reasons = [...new Set(failures.map((f) => f.reason))];
    const what =
      reasons.length === 1
        ? `${probes} got ${reasons[0]}`
        : failures.map((f) => `${f.probe} got ${f.reason}`).join("; ");
    return unreachable(ctx, clip(`${what}, so there are no CORS headers to check`, 200));
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
  const restricted = observations.find((o) => o.acao)?.acao;
  if (restricted) {
    return { passed: true, details: `CORS restricted to: ${clip(restricted, 60)} (${seen.join(", ")})` };
  }
  return { passed: true, details: `No CORS headers returned (${seen.join(", ")}; server-to-server only, acceptable)` };
}

// ── Input validation (6) ─────────────────────────────────────────────

async function runInputValidation(ctx: ModernSuiteContext) {
  const { check } = ctx.harness;

  const injection = (id: string, payloads: string[], detector: RegExp, label: string, prefer?: RegExp[]) =>
    check(id, async () => {
      const { tools, skip } = await toolsOrSkip(ctx);
      if (skip) return skip;
      const target = pickInjectionTarget(tools, prefer);
      if (!target) return { passed: true, details: "No tools with string parameters to test", skipped: true };
      noteInjectionScope(ctx, target);
      return runInjectionTest(ctx, id, target, payloads, detector, label);
    });

  await injection(
    "security-command-injection",
    INJECTION_PAYLOADS.command,
    INJECTION_DETECTORS.command,
    "appears to have executed",
  );

  await injection(
    "security-sql-injection",
    INJECTION_PAYLOADS.sql,
    INJECTION_DETECTORS.sql,
    "triggered database error",
  );

  await injection(
    "security-path-traversal",
    INJECTION_PAYLOADS.pathTraversal,
    INJECTION_DETECTORS.pathTraversal,
    "returned sensitive file content",
    [PATH_PARAM_NAME, PATH_OR_URL_PARAM_NAME],
  );

  await injection(
    "security-ssrf-internal",
    INJECTION_PAYLOADS.ssrf,
    INJECTION_DETECTORS.ssrf,
    "returned internal data",
    [URL_PARAM_NAME, PATH_OR_URL_PARAM_NAME],
  );

  await check("security-oversized-input", async () => {
    const { tools, skip } = await toolsOrSkip(ctx);
    return skip ?? checkOversizedInput(ctx, tools);
  });

  await check("security-extra-params", async () => {
    const { tools, skip } = await toolsOrSkip(ctx);
    if (skip) return skip;
    return checkExtraParams(ctx, tools[0]);
  });
}

/** Warnings about how the injection target was chosen (one per fact; tests sharing a target share them). */
function noteInjectionScope(ctx: ModernSuiteContext, target: InjectionTarget): void {
  const name = String(target.tool.name);
  if (target.skippedDestructive.length > 0) {
    warnOnce(
      ctx,
      `security injection tests: skipped destructive tool(s) ${nameList(target.skippedDestructive)} (annotations.destructiveHint true).`,
    );
  }
  if (target.skippedUnannotated.length > 0) {
    warnOnce(
      ctx,
      `security injection tests: skipped ${target.skippedUnannotated.length} unannotated tool(s) ${nameList(target.skippedUnannotated)}: the spec defaults destructiveHint to true, so a tool without readOnlyHint true or destructiveHint false counts as destructive; annotate read-only tools to have them probed.`,
    );
  }
  if (target.destructiveProbed) {
    const why =
      target.safety === "destructive"
        ? "annotations.destructiveHint true"
        : "unannotated, and the spec defaults destructiveHint to true";
    warnOnce(
      ctx,
      `security injection tests: no tool with a string argument is annotated readOnlyHint true or destructiveHint false, so ${name} (${why}) was probed with live payloads; run against a disposable dataset, or annotate read-only tools with readOnlyHint true.`,
    );
  }
  const filled = Object.entries(target.fill);
  if (filled.length > 0) {
    const listed = filled.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ");
    warnOnce(
      ctx,
      `security injection tests: filled required argument(s) ${listed} of ${name} with placeholders so the payload could reach the handler.`,
    );
  }
}

/**
 * Send every payload to the one target and count what came back. Only a
 * rejection (isError or rejection wording) is evidence the server
 * defended; a benign result proves nothing either way, and a JSON-RPC
 * error or a timeout means the payload never reached a verdict. A server
 * that goes away on a payload fails naming that payload: the stdio child
 * exits, or an accepted HTTP connection is closed or reset and a follow-up
 * server/discover is neither served nor refused by a gate still in front of
 * the server (discoverAfterDrop). A stdio child that died on a payload is
 * restarted for the checks after this one (restartStdioServer, which names
 * `check`). A drop the server outlives (a WAF or IPS, a keep-alive close,
 * one crashed worker of several) never reached the tool, with a warning.
 * One that was already gone when a payload was sent (a dead child, a
 * refused connection) stops the probe with an unreachable() verdict, and is
 * not restarted. When no payload reached the tool at all, nothing was
 * measured: the pass is flagged as a skip, with a warning.
 * `toolInputSchema` keeps `x-mcp-header` arguments callable: their values
 * are mirrored into `Mcp-Param-*` headers so the server does not reject
 * the request as a header mismatch before the tool ever runs.
 */
async function runInjectionTest(
  ctx: ModernSuiteContext,
  check: string,
  target: InjectionTarget,
  payloads: string[],
  detector: RegExp,
  label: string,
): Promise<TestOutcome> {
  const { tool, param, fill } = target;
  const where = `${tool.name}.${param}`;
  const issues: string[] = [];
  let rejected = 0;
  let benign = 0;
  let unreached = 0;
  const stdioExited = () => ctx.kind === "stdio" && (ctx.transport as { exited?: boolean }).exited === true;
  for (const payload of payloads) {
    // A child that is already gone was not killed by this payload: an
    // earlier test (or payload) did it, and nothing more can be sent.
    const alreadyGone = stdioExited();
    try {
      const res = await ctx.client.rpc(
        TOOLS_CALL,
        { name: tool.name, arguments: { ...fill, [param]: payload } },
        { toolInputSchema: tool.inputSchema },
      );
      const result = resultOf(res.body);
      if (!result) {
        unreached++;
        continue;
      }
      const text = resultText(result);
      const verdict = classifyInjectionOutput(text, payload, detector, result.isError === true);
      if (verdict === "issue") {
        issues.push(`Payload "${clip(payload, 30)}" ${label} in ${where} (output: ${clip(text, 60)})`);
      } else if (verdict === "rejected") {
        rejected++;
      } else {
        benign++;
      }
    } catch (err) {
      if (ctx.signal?.aborted) throw err;
      const failure = classifyTransportError(err);
      const reason = clip(firstLine(errorMessage(err)), 100);
      // The stdio child exited on this payload: the crash the test exists
      // to catch -- the same behaviour security-extra-params fails as
      // "died" -- not a payload that merely never reached the tool. The
      // exit event makes that conclusive. A new instance takes its place
      // for the checks after this one.
      if (failure === "dropped" && !alreadyGone && ctx.kind === "stdio") {
        const died = `server died on payload "${clip(payload, 30)}" sent to ${where}: ${reason}`;
        await restartStdioServer(ctx, check, `an injection payload sent to ${where}`);
        return { passed: false, details: issuesThenCrash(issues, died) };
      }
      // An HTTP connection closed or reset instead of answered says nothing
      // on its own about whether the server is still up: a WAF or IPS drops
      // attack payloads at the connection level, and a keep-alive
      // connection the server closes as the request is sent drops it too.
      // A follow-up server/discover decides (discoverAfterDrop): served, or
      // refused by a gate still standing in front of the server, the payload
      // never reached the tool; otherwise the server went away on it.
      if (failure === "dropped" && ctx.kind === "http") {
        const after = await discoverAfterDrop(ctx);
        if ("gone" in after) {
          const died = `server may have crashed: connection dropped on payload "${clip(payload, 30)}" sent to ${where}: ${clip(reason, 40)}; server/discover then ${after.gone}`;
          return { passed: false, details: issuesThenCrash(issues, died) };
        }
        warnOnce(
          ctx,
          `security injection tests: a tools/call to ${where} carrying a payload had its connection closed without a response, but ${after.alive}, so the payload is counted as never reaching the tool rather than as a crash. ${DROP_CAUSES} Refuse a payload with HTTP 4xx or a JSON-RPC error so a client can tell a refusal from a crash.`,
        );
        unreached++;
        continue;
      }
      // Gone before this payload (a dead child, a refused connection): no
      // payload after it can be sent either, so the probe stops here. When
      // nothing was answered at all, nothing was measured.
      if (failure === "dropped" || failure === "connect") {
        if (issues.length > 0) return { passed: false, details: clip(issues.join("; "), 200) };
        const gone = unreachable(ctx, `tools/call ${where} with payload "${clip(payload, 30)}"`, err);
        const earlier = rejected + benign + unreached;
        if (earlier === 0) return gone;
        return { passed: false, details: clip(`${gone.details}, after ${earlier} earlier payload(s)`, 220) };
      }
      // A timeout (the tool may just be slow; the server is still up) or
      // an unclassifiable error: the payload never reached a verdict.
      unreached++;
    }
  }
  if (issues.length > 0) return { passed: false, details: clip(issues.join("; "), 200) };
  const counts = `${rejected} rejected, ${benign} returned without evidence of execution, ${unreached} never reached the tool (JSON-RPC or transport error)`;
  const details = `Tested ${payloads.length} payload(s) against ${where}: ${counts}`;
  if (rejected === payloads.length) return { passed: true, details: `${details} -- server defended` };
  if (unreached === payloads.length) {
    // Nothing was measured: every call died before the handler. The
    // placeholders may not satisfy the schema, or the target argument is
    // validated away (an enum, a pattern); say so rather than pass quietly.
    warnOnce(
      ctx,
      `security injection tests: no payload sent to ${where} reached the tool (every tools/call drew a JSON-RPC or transport error), so the verdict is inconclusive; check that the placeholder arguments satisfy the tool's schema, or expose a read-only tool with a free-form string argument.`,
    );
    return { passed: true, details: `${details} -- inconclusive (see warning)`, skipped: true };
  }
  return { passed: true, details };
}

/**
 * What a drop the server outlived may have been. A black-box client sees
 * the same thing for each: one connection closed, the next request answered.
 */
const DROP_CAUSES =
  "The drop may be a WAF or IPS dropping the request, a keep-alive connection closed as it was sent, or a crash of one worker of a multi-process server (Node cluster, PM2, gunicorn) while the others still answer -- a black-box client cannot tell these apart.";

/**
 * Failure details for a crash found after `issues` (execution evidence)
 * were recorded, within the 220-character limit: the issues come first,
 * clipped only as far as needed to leave the crash clause its first 60
 * characters, which state the conclusion ("server died ...", "server may
 * have crashed ..."); the crash clause gets whatever room remains.
 */
function issuesThenCrash(issues: string[], crash: string): string {
  if (issues.length === 0) return clip(crash, 220);
  const head = clip(issues.join("; "), 220 - 2 - Math.min(crash.length, 60));
  return `${head}; ${clip(crash, 220 - 2 - head.length)}`;
}

/** The longest a follow-up server/discover waits on a 429's Retry-After before its one retry. */
const RETRY_AFTER_CAP_MS = 2000;
/** The wait before that retry when the 429 carries no usable Retry-After. */
const RETRY_AFTER_DEFAULT_MS = 1000;

/**
 * The wait a 429's Retry-After asks for (delay-seconds or an HTTP-date,
 * RFC 9110 section 10.2.3), capped at RETRY_AFTER_CAP_MS;
 * RETRY_AFTER_DEFAULT_MS when the header is missing or unparseable.
 *
 * @internal Exported for testing, and for the 2025-11-25 security checks
 * in runner.ts, which retry a follow-up request after a 429 the same way.
 */
export function retryAfterMs(headers: Record<string, string>): number {
  const value = headerOf(headers, "retry-after")?.trim() ?? "";
  let ms: number;
  if (/^\d+$/.test(value)) ms = Number(value) * 1000;
  else {
    // Every HTTP-date form (IMF-fixdate, RFC 850, asctime) opens with a day
    // name; Date.parse alone would read "-5" or "1.5" as a date in 2001.
    const at = /^[A-Za-z]{3}/.test(value) ? Date.parse(value) : Number.NaN;
    if (Number.isNaN(at)) return RETRY_AFTER_DEFAULT_MS;
    ms = at - Date.now();
  }
  return Math.min(Math.max(ms, 0), RETRY_AFTER_CAP_MS);
}

/** Resolve after `ms`, or reject with the abort reason as soon as `signal` aborts. */
function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * The gate a 401 or 403 answering the follow-up server/discover shows is
 * still standing in front of the server, or undefined for any other answer.
 * Read the way the era probe and transport-post read a 401/403
 * (readAuthRefusal): one that asks for a credential (no Authorization
 * header; a 401, or a 403 with a Bearer challenge) or refuses the one sent
 * (a 401, or a 403 whose Bearer challenge carries an error) is an auth
 * gate. Any other 403 says nothing about the credential -- it is also what
 * an Origin or Host check answers -- and after a dropped attack payload is
 * most likely a WAF or IPS now blocking this client.
 */
function gateAnswering(ctx: ModernSuiteContext, res: RpcResponse): string | undefined {
  const refusal = readAuthRefusal(res, ctx.hasAuth);
  if (!refusal) return undefined;
  return refusal.kind === "forbidden"
    ? "a gate in front of the server such as a WAF or IPS now blocking this client"
    : "an auth gate";
}

/**
 * After an HTTP connection was dropped (an injection payload, a 1 MB
 * argument, unknown arguments), one conformant server/discover tells a
 * connection-level refusal from a crash:
 *
 * - served (a DiscoverResult, as the setup discover that unlocked the tool
 *   tests was): the server is up;
 * - refused with 401 or 403 (gateAnswering): a gate in front of the server
 *   -- a WAF or IPS now blocking this client, an auth gate -- answered, so
 *   this is no crash either;
 * - refused with 429: a rate limiter answers before the server reads the
 *   request, and one running as a separate gateway answers for a backend
 *   that is gone, so the 429 alone proves nothing. The discover is retried
 *   once after Retry-After (at most RETRY_AFTER_CAP_MS) and the retry's
 *   answer decides by the rules above; a second 429 counts as gone;
 * - anything else (no response, a proxy's 502 for a backend that went away,
 *   a JSON-RPC error, a 413 or 415 -- which no size limit or media-type gate
 *   in front of a live server answers a small conformant discover with):
 *   the server may have crashed.
 *
 * `alive` / `gone` is the clause the warning / failure quotes. A run the
 * caller aborted (during the discover or the wait before its retry) is
 * rethrown.
 */
async function discoverAfterDrop(ctx: ModernSuiteContext): Promise<{ alive: string } | { gone: string }> {
  /** "answered HTTP 429, then after Nms " once the discover has been retried. */
  let retried = "";
  for (;;) {
    let res: RpcResponse;
    try {
      res = await ctx.client.rpc(DISCOVER, {});
    } catch (err) {
      if (ctx.signal?.aborted) throw err;
      return { gone: `${retried}got ${noResponse(err, ctx.timeout)}` };
    }
    if (resultOf(res.body)) {
      return {
        alive: retried
          ? `a follow-up server/discover ${retried}was served`
          : "the server still served a follow-up server/discover",
      };
    }
    const gate = gateAnswering(ctx, res);
    if (gate) {
      return { alive: `a follow-up server/discover ${retried}was still answered (HTTP ${res.statusCode}, ${gate})` };
    }
    if (res.statusCode !== 429 || retried) {
      return { gone: `${retried}answered HTTP ${res.statusCode}, ${summarize(res)}` };
    }
    // One retry, after the wait the limiter asked for (capped).
    const wait = retryAfterMs(res.headers);
    await pause(wait, ctx.signal);
    retried = `answered HTTP 429, then after ${wait}ms `;
  }
}

/**
 * Replace a stdio child that exited on a check's own request -- an
 * injection payload, security-oversized-input's 1 MB value,
 * security-extra-params' unknown arguments, the tools/call
 * security-tool-rug-pull sends a replacement, stdio-unicode's CJK/emoji
 * tools/call or server/discover (stdio.ts), lifecycle-progress-token's
 * tools/call with or without its token (lifecycle.ts) -- with a fresh
 * instance: the policy the 2025-11-25 suite applies to the same checks
 * (restartStdioServer in runner.ts). The check already fails as "server died"; left dead, the
 * child would fail every later check under a diagnosis of its own ("server
 * unreachable", "Second tools/list call threw"), so one crash would be
 * counted over and over under the wrong names.
 *
 * The new instance is set up the way the suite set up the first one: a
 * server/discover within the startup budget (the first exchange with a
 * cold process), then, once that is served, one modern request that is not
 * a discover -- the list the server declared, else ping -- which pins a
 * dual-era process (the SDK 2.0 default) to this era before the claim-less
 * probes reach it (the late lifecycle block's, after a stdio-unicode or
 * lifecycle-progress-token restart; the information-disclosure checks'), as
 * the feature modules pinned the first process. The cached lists and
 * capabilities stay as they are (they describe the same server); ctx.state.replacement
 * records that the process changed, with the new instance's tools/list
 * from that pin, read before any tools/call reached it, for
 * security-tool-rug-pull (rugPullOnReplacement).
 *
 * `check` is the check that killed the child, which the warning names along
 * with `cause`; the warning also says whether the new instance served
 * server/discover. Callers restart only a child that died on the check's
 * own request (one already gone before it was not killed by it: "server
 * unreachable"), and they restart it every time that happens. Under
 * --retries a check whose retry kills the new instance too restarts it
 * again, so the checks after it measure a live server whatever --retries
 * is; the harness runs a check at most retries+1 times, which bounds the
 * restarts, and identical warnings from those attempts collapse into one
 * when the report is assembled. A context with no way to spawn the server
 * (ctx.replaceStdioProcess undefined) keeps the dead child. A run the
 * caller aborts is rethrown.
 */
export async function restartStdioServer(ctx: ModernSuiteContext, check: string, cause: string): Promise<void> {
  const replace = ctx.replaceStdioProcess;
  if (ctx.kind !== "stdio" || !replace) return;
  const exited = `${check}: the server exited on ${cause}`;
  try {
    await replace();
  } catch (err) {
    if (ctx.signal?.aborted) throw err;
    ctx.harness.warnings.push(
      `${exited}, and starting a new instance failed (${clip(firstLine(errorMessage(err)), 90)}); the tests after it ran against the exited process.`,
    );
    return;
  }
  // From here on the suite talks to a process none of the cached lists
  // came from, whatever the new instance answers below.
  const replacement: { after: string; tools: unknown[] | null } = { after: check, tools: null };
  ctx.state.replacement = replacement;
  const consequence = "the tests after it ran against the new instance and may fail for that reason";
  let res: RpcResponse;
  try {
    res = await ctx.client.rpc(DISCOVER, {}, { timeout: ctx.startupTimeout });
  } catch (err) {
    if (ctx.signal?.aborted) throw err;
    ctx.harness.warnings.push(
      `${exited} and was restarted, but the new instance's server/discover got ${noResponse(err, ctx.startupTimeout)}; ${consequence}.`,
    );
    return;
  }
  if (!resultOf(res.body)) {
    const err = errorOf(res.body);
    ctx.harness.warnings.push(
      `${exited} and was restarted, but the new instance answered server/discover with no result${err ? ` (${errorWithCode(err.rawCode)})` : ""}; ${consequence}.`,
    );
    return;
  }
  const pin = hasTools(ctx)
    ? TOOLS_LIST
    : hasResources(ctx)
      ? "resources/list"
      : hasPrompts(ctx)
        ? "prompts/list"
        : "ping";
  try {
    const pinned = await ctx.client.rpc(pin, {});
    if (pin === TOOLS_LIST) {
      const listed = resultOf(pinned.body)?.tools;
      if (Array.isArray(listed)) replacement.tools = listed;
    }
  } catch (err) {
    if (ctx.signal?.aborted) throw err;
    ctx.harness.warnings.push(
      `${exited} and was restarted with a fresh server/discover, but the ${pin} that pins its era got ${noResponse(err, ctx.timeout)}; ${consequence}.`,
    );
    return;
  }
  ctx.harness.warnings.push(
    `${exited} and was restarted with a fresh server/discover, so the tests after it ran against the new instance.`,
  );
}

/**
 * A ~1 MB string in the first string argument that is NOT header-mirrored
 * (an `x-mcp-header` value would travel in an Mcp-Param-* header too, and
 * the header limit would be measured instead of the body). A mirrored
 * argument is used only when no other string argument exists, and the
 * details say so; any tool's `data` when no tool takes a string at all. A
 * stdio child that dies on the value fails as died and is restarted for the
 * checks after this one (restartStdioServer); one already gone before the
 * call is unreachable and is not restarted.
 */
async function checkOversizedInput(ctx: ModernSuiteContext, tools: any[]): Promise<TestOutcome> {
  const strings = stringParams(tools);
  const plain = strings.find(({ tool, param }) => !isHeaderMirrored(propertiesOf(tool)[param]));
  const target = plain ?? strings[0] ?? { tool: tools[0], param: "data" };
  const tool = target.tool;
  if (!tool || typeof tool.name !== "string") return { passed: true, details: "No tools available to test (skipped)" };
  const where = `${tool.name}.${target.param}`;
  const note =
    !plain && strings.length > 0 ? ` [${target.param} is x-mcp-header: measured the header limit, not the body]` : "";
  const withNote = (o: TestOutcome): TestOutcome => (note ? { ...o, details: `${o.details}${note}` } : o);
  const largeValue = "A".repeat(OVERSIZED_BYTES);
  const what = `tools/call ${where} with a 1 MB value`;
  const stdio = ctx.transport as Partial<StdioTransport>;
  // Scopes the "reply dropped by the runner" verdict to output produced
  // during THIS call: the stdio transport counts every overflow of its
  // line buffer for its whole life (see transport/stdio.ts).
  const overflows = () => stdio.stdoutOverflows ?? 0;
  const overflowsBefore = overflows();
  // A child already gone was not killed by the 1 MB value (see runInjectionTest).
  const exited = () => ctx.kind === "stdio" && stdio.exited === true;
  const alreadyGone = exited();
  const callBig = () =>
    ctx.client.rpc(
      TOOLS_CALL,
      { name: tool.name, arguments: { [target.param]: largeValue } },
      { toolInputSchema: tool.inputSchema },
    );
  try {
    let res = await callBig();
    /** "HTTP 429, then after Nms " once a throttled call was resent. */
    let throttled = "";
    if (ctx.kind === "http" && res.statusCode === 429) {
      // A rate limiter answers before the server reads the request, so a 429
      // says nothing about the 1 MB value: wait what it asks (capped,
      // retryAfterMs) and send the call once more.
      const wait = retryAfterMs(res.headers);
      await pause(wait, ctx.signal);
      throttled = `HTTP 429, then after ${wait}ms `;
      res = await callBig();
    }
    const status = res.statusCode;
    if (ctx.kind === "http") {
      if (status === 413)
        return withNote({ passed: true, details: `HTTP 413 Payload Too Large on a 1 MB ${where} (good)` });
      if (status === 429) {
        return withNote({
          passed: false,
          details: clip(
            `${throttled}HTTP 429 on a 1 MB ${where} -- not evaluable: a rate limiter answered before the server read the request`,
            220,
          ),
        });
      }
      // A 401, or a 403 that reads as an auth gate (readAuthRefusal),
      // answered before the server read the request: nothing about the 1 MB
      // value was measured. A bare 403 is also what a WAF or size rule
      // blocking the body answers, and it passes like any other 4xx: the
      // tool list this call needs came from a served server/discover (its
      // tools capability) with the same headers, so the value is the one
      // variable. (The 2025-11-25 check, which falls back to a tool named
      // "test" with no list at all, needs that comparison spelled out.)
      const refusal = readAuthRefusal(res, ctx.hasAuth);
      if (refusal && refusal.kind !== "forbidden") {
        return withNote({
          passed: false,
          details: clip(
            `HTTP ${status} on a 1 MB ${where} -- not evaluable: an auth gate answered before the server read the request (${authRefusalHint(refusal, "pass --auth")})`,
            220,
          ),
        });
      }
      if (is4xx(status)) return withNote({ passed: true, details: `HTTP ${status} (oversized input rejected)` });
      if (status >= 500) {
        return withNote({
          passed: false,
          details: `HTTP ${status} -- server error on a 1 MB ${where} (should answer 413/4xx or a JSON-RPC error)`,
        });
      }
    }
    const err = errorOf(res.body);
    if (err) return withNote({ passed: true, details: `${errorWithCode(err.rawCode)} (oversized input rejected)` });
    if (resultOf(res.body)) {
      ctx.harness.warnings.push(
        `security-oversized-input: the server completed a tools/call carrying a 1 MB string argument (${where}) instead of rejecting it; enforce a request body limit (413) or maxLength in inputSchema.`,
      );
      const prefix = ctx.kind === "http" ? `HTTP ${status}, result` : "result";
      return withNote({
        passed: true,
        details: `${prefix} -- server processed a 1 MB ${where} without rejecting it (survived)`,
      });
    }
    const frame = ctx.kind === "http" ? `HTTP ${status}, non-JSON-RPC body` : "broken stdio frame";
    return withNote({ passed: false, details: `${frame} -- no result or error for a 1 MB ${where}` });
  } catch (err) {
    if (ctx.signal?.aborted) throw err;
    const message = errorMessage(err);
    const failure = classifyTransportError(err);
    if (ctx.kind === "stdio") {
      // The exit decides before the overflow does: a child that wrote an
      // over-long line and then exited was rejected by its exit, however
      // much it wrote first. A child this call killed is restarted for
      // the checks after this one; one already gone is not.
      if (failure === "dropped" || exited()) {
        if (alreadyGone) return withNote(unreachable(ctx, what, err));
        const died = withNote({ passed: false, details: `server died on a 1 MB ${where}: ${clip(message, 120)}` });
        await restartStdioServer(ctx, "security-oversized-input", `a 1 MB ${where}`);
        return died;
      }
      if (overflows() > overflowsBefore) {
        // The server answered, but with a single line longer than the
        // runner's 1 MiB stdio buffer, and is still running: a runner
        // limit, not a server fault. An overflow from before this call (an
        // earlier over-long reply, a startup banner) says nothing about
        // this one, and neither does the same text on the child's own stderr.
        ctx.harness.warnings.push(
          `security-oversized-input: the server's reply to a 1 MB ${where} exceeded the runner's 1 MiB stdio line buffer and was dropped; treated as survived. Prefer rejecting oversized arguments with a JSON-RPC error.`,
        );
        return withNote({
          passed: true,
          details: `response to a 1 MB ${where} exceeded the runner's stdio line buffer (server survived)`,
        });
      }
    } else {
      // Refused before anything was sent: nothing about the 1 MB value was measured.
      if (failure === "connect") return withNote(unreachable(ctx, what, err));
      // Closing the connection on a 1 MB body is an acceptable refusal only
      // when the server is still there afterwards (discoverAfterDrop).
      if (failure === "dropped") {
        const reason = clip(firstLine(message), 40);
        const after = await discoverAfterDrop(ctx);
        if ("gone" in after) {
          return withNote({
            passed: false,
            details: clip(
              `server may have crashed: connection dropped on a 1 MB ${where}: ${reason}; server/discover then ${after.gone}`,
              220,
            ),
          });
        }
        return withNote({
          passed: true,
          details: clip(`Connection rejected (acceptable for oversized input): ${reason}; ${after.alive}`, 220),
        });
      }
    }
    if (isTimeout(err)) {
      return withNote({ passed: false, details: `Request timed out -- server may be struggling with a 1 MB ${where}` });
    }
    // On HTTP a rejection is an answer (a 4xx, a JSON-RPC error) or a
    // connection closed on the body that the server outlives, all read
    // above. What is left got no usable response at all -- bytes that are
    // not an HTTP response, a TLS failure -- and rejects nothing: the
    // verdict security-extra-params gives the same error.
    if (ctx.kind === "http") {
      return withNote({
        passed: false,
        details: clip(`no usable response to a 1 MB ${where}: ${clip(firstLine(message), 120)}`, 220),
      });
    }
    return withNote({
      passed: true,
      details: `Connection rejected (acceptable for oversized input): ${clip(message, 80)}`,
    });
  }
}

/**
 * Unknown arguments on the first tool. Rejected (-32602) or ignored both
 * pass; a 5xx or a dead server fails. A request that merely times out is
 * neither (the tool may simply be slow with placeholder-free arguments):
 * it passes with a warning that the verdict is inconclusive, and so does an
 * HTTP connection dropped on the call that the server outlives
 * (discoverAfterDrop) -- the same reading the injection checks give a drop.
 * Both inconclusive passes measured nothing and are flagged as skips. A
 * stdio child that dies on the call fails as died and is restarted for the
 * checks after this one (restartStdioServer). A server already gone before
 * the call (a refused connection, a child an earlier test killed) is
 * unreachable, not a crash on these arguments, and is not restarted.
 */
async function checkExtraParams(ctx: ModernSuiteContext, tool: any): Promise<TestOutcome> {
  // Build the arguments via JSON.parse so "__proto__" lands as a real own
  // enumerable property: the object-literal form sets the prototype
  // instead and JSON.stringify would drop it before it reached the wire.
  const maliciousArgs = JSON.parse('{"__injected_param__":"malicious_value","__proto__":{"admin":true}}');
  const name = String(tool?.name);
  const what = `tools/call ${name} with unknown arguments`;
  const exited = () => ctx.kind === "stdio" && (ctx.transport as Partial<StdioTransport>).exited === true;
  const alreadyGone = exited();
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
      return {
        passed: true,
        details: `Extra params rejected with error: ${errorCodeText(err.rawCode)} -- ${clip(err.message, 100)}`,
      };
    }
    if (resultOf(res.body)) {
      return { passed: true, details: "Server processed request (extra params likely ignored)" };
    }
    return {
      passed: false,
      details: `malformed response to unknown tool arguments (HTTP ${res.statusCode}, no result or error)`,
    };
  } catch (err) {
    if (ctx.signal?.aborted) throw err;
    const message = errorMessage(err);
    const failure = classifyTransportError(err);
    // The stdio transport rejects every pending request with its exit
    // diagnostic ("crashed with exit code N", "exited cleanly",
    // "terminated by signal") the moment the child goes away. A child this
    // call killed is restarted for the checks after this one.
    if (ctx.kind === "stdio" && (failure === "dropped" || exited())) {
      if (alreadyGone) return unreachable(ctx, what, err);
      const died: TestOutcome = {
        passed: false,
        details: `server died on unknown tool arguments (tools/call ${name}): ${clip(message, 120)}`,
      };
      await restartStdioServer(ctx, "security-extra-params", `unknown tool arguments (tools/call ${name})`);
      return died;
    }
    if (ctx.kind === "http") {
      // Refused before anything was sent: an earlier test took the server down.
      if (failure === "connect") return unreachable(ctx, what, err);
      if (failure === "dropped") {
        const after = await discoverAfterDrop(ctx);
        if ("gone" in after) {
          return {
            passed: false,
            details: clip(
              `server may have crashed: connection dropped on unknown tool arguments (tools/call ${name}): ${clip(firstLine(message), 40)}; server/discover then ${after.gone}`,
              220,
            ),
          };
        }
        ctx.harness.warnings.push(
          `security-extra-params: tools/call ${name} with unknown arguments had its connection closed without a response, but ${after.alive}, so the verdict is inconclusive rather than a crash. ${DROP_CAUSES} Reject unknown arguments with a JSON-RPC error or ignore them so a client can tell a refusal from a crash.`,
        );
        return {
          passed: true,
          details: `tools/call ${name} had its connection closed without a response -- extra-params verdict inconclusive (see warning)`,
          skipped: true,
        };
      }
    }
    if (isTimeout(err)) {
      ctx.harness.warnings.push(
        `security-extra-params: tools/call ${name} with unknown arguments did not answer within ${ctx.timeout}ms; the server was still up, so the verdict is inconclusive (not a crash). Re-run with a larger --timeout or a faster first tool.`,
      );
      return {
        passed: true,
        details: `tools/call ${name} did not answer within ${ctx.timeout}ms -- extra-params verdict inconclusive (see warning)`,
        skipped: true,
      };
    }
    // Neither an answer nor a transport failure the server can be judged
    // by (an unparseable HTTP response, a spawn failure).
    return {
      passed: false,
      details: `no usable response to unknown tool arguments (tools/call ${name}): ${clip(firstLine(message), 120)}`,
    };
  }
}

/**
 * security-tool-rug-pull once an earlier check killed the stdio server and
 * restartStdioServer replaced it. The list the suite cached came from the
 * first process, so a second list read from the replacement would compare
 * two processes: a server whose tools change after use would pass (its
 * replacement has not been used yet), and one whose descriptions differ
 * per process (a pid, a start time) would be accused of a rug-pull. Both
 * lists come from the replacement instead: the one restartStdioServer read
 * before any tools/call reached it, then -- after a tools/call, the one the
 * feature checks send (pickTool, no arguments), so the process has been
 * used whatever the checks since the restart sent it -- a second one.
 *
 * With nothing to compare the check is a skip naming the restart: the
 * replacement's list before use was not obtained (the restart's warning
 * says why), or the tools/call killed the replacement too -- which is then
 * replaced again for the checks after this one, like any check whose own
 * request killed the server. A caller's abort is rethrown.
 */
async function rugPullOnReplacement(
  ctx: ModernSuiteContext,
  replacement: { after: string; tools: unknown[] | null },
): Promise<TestOutcome> {
  const on = `the server restarted after ${replacement.after}`;
  const before = replacement.tools;
  if (!before) {
    return {
      passed: true,
      details: `Skipped: the tools/list of ${on} was not read before use, so there are no two lists from one process to compare (see warning)`,
      skipped: true,
    };
  }
  const tool = pickTool(before);
  if (tool) {
    const exited = () => (ctx.transport as Partial<StdioTransport>).exited === true;
    const alreadyGone = exited();
    try {
      await ctx.client.rpc(TOOLS_CALL, { name: tool.name, arguments: {} }, { toolInputSchema: tool.inputSchema });
    } catch (err) {
      if (ctx.signal?.aborted) throw err;
      if (!alreadyGone && (classifyTransportError(err) === "dropped" || exited())) {
        await restartStdioServer(ctx, "security-tool-rug-pull", `a tools/call to ${tool.name} with no arguments`);
        return {
          passed: true,
          details: clip(
            `Skipped: ${on} exited on a tools/call to ${tool.name} with no arguments, before its tools could be listed again (see warning)`,
            200,
          ),
          skipped: true,
        };
      }
      // A timeout or an unreadable reply: the call still reached the
      // process, and the second list decides.
    }
  }
  const between = tool ? "before and after a tools/call" : "no tool to call between them";
  try {
    const res = await ctx.client.rpc(TOOLS_LIST, {});
    const again = resultOf(res.body)?.tools;
    if (!Array.isArray(again)) {
      return { passed: false, details: clip(`Second tools/list call failed (${summarize(res)}) on ${on}`, 200) };
    }
    const diff = compareToolLists(before, again);
    if (diff) return { passed: false, details: clip(`${diff}; both lists from ${on} (${between})`, 200) };
    return {
      passed: true,
      details: clip(`${before.length} tool(s) consistent across 2 calls to ${on} (${between})`, 200),
    };
  } catch (err) {
    if (ctx.signal?.aborted) throw err;
    return { passed: false, details: `Second tools/list call threw: ${clip(errorMessage(err), 120)}` };
  }
}

// ── Tool integrity (4) ───────────────────────────────────────────────

async function runToolIntegrity(ctx: ModernSuiteContext) {
  const { check } = ctx.harness;

  await check("security-tool-schema-defined", async () => {
    const tools = await ensureTools(ctx);
    if (tools === null) return toolsUnavailable(ctx);
    if (tools.length === 0) return { passed: true, details: "No tools to validate", skipped: true };
    const missing = tools.filter((t: any) => t?.inputSchema?.type !== "object");
    if (missing.length > 0) {
      const names = missing.map((t: any) => t?.name).join(", ");
      return { passed: false, details: clip(`${missing.length} tool(s) missing inputSchema: ${names}`, 200) };
    }
    return { passed: true, details: `All ${tools.length} tool(s) have inputSchema defined` };
  });

  await check("security-tool-rug-pull", async () => {
    const tools = await ensureTools(ctx);
    if (tools === null) return toolsUnavailable(ctx);
    // The cached list came from a process an earlier check killed.
    if (ctx.state.replacement) return rugPullOnReplacement(ctx, ctx.state.replacement);
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
    const tools = await ensureTools(ctx);
    if (tools === null) return toolsUnavailable(ctx);
    if (tools.length === 0) return { passed: true, details: "No tools to validate", skipped: true };
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
    const tools = await ensureTools(ctx);
    if (tools === null) return toolsUnavailable(ctx);
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

interface ErrorProbes {
  samples: ErrorSample[];
  /** How many probes were sent, and how many got an answer of any shape (0 answered = unreachable). */
  sent: number;
  answered: number;
}

/**
 * Trigger a range of failures with conformant envelopes so the errors
 * come from the server's own handlers, not the transport layer. A
 * JSON-RPC error is kept as the JSON of its error object -- the same form
 * the recorder holds it in, so the two sources dedupe -- and a body that
 * was not JSON-RPC (a 500 page) as text; a result is not an error
 * response and is dropped.
 */
async function collectErrorProbes(ctx: ModernSuiteContext): Promise<ErrorProbes> {
  const samples: ErrorSample[] = [];
  let sent = 0;
  let answered = 0;
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
    sent++;
    try {
      const res = await ctx.client.rpc(method, params, opts);
      answered++;
      const text = errorSampleText(res.body);
      if (text === null) continue;
      samples.push({ text, requestText: JSON.stringify(ctx.client.paramsFor(params, opts) ?? null) });
    } catch {
      // No response to inspect.
    }
  }
  if (ctx.kind === "http") {
    sent++;
    try {
      const res = await ctx.client.raw("{this is not valid json!!!", { method: DISCOVER });
      answered++;
      const parsed = parseJson(res.body);
      const text = parsed === undefined ? res.body : errorSampleText(parsed);
      if (text) samples.push({ text, requestText: "" });
    } catch {}
  }
  return { samples, sent, answered };
}

/** The scannable text of a response body: the error object, a raw non-JSON body, or null for a result. */
function errorSampleText(body: unknown): string | null {
  if (body === undefined || body === null) return null;
  if (typeof body !== "object") return JSON.stringify(body);
  const raw = (body as { _raw?: unknown })._raw;
  if (typeof raw === "string") return raw;
  if ("error" in body) return JSON.stringify((body as { error?: unknown }).error ?? null);
  if ("result" in body) return null;
  return JSON.stringify(body);
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

async function runInformationDisclosure(ctx: ModernSuiteContext, errorProbes: () => Promise<ErrorProbes>) {
  const { check } = ctx.harness;

  // A scan over nothing proves nothing: when none of the failure probes
  // got an answer of any shape and the run recorded no server message
  // either, the server never spoke, and the verdict says so instead of
  // "0 unique error responses checked".
  const gather = async (): Promise<{ samples: ErrorSample[]; silent: TestOutcome | null }> => {
    const probes = await errorProbes();
    if (probes.answered === 0 && ctx.recorder.size === 0) {
      return {
        samples: [],
        silent: unreachable(
          ctx,
          `none of the ${probes.sent} failure probes was answered and the run recorded no server message, so there are no error responses to scan`,
        ),
      };
    }
    // The probes are recorded too, in the same error-object form, so the
    // union dedupes by text: one sample per distinct response. Probe
    // samples come first because they carry the fuller request text for
    // the echo check.
    const seen = new Set<string>();
    const all: ErrorSample[] = [];
    for (const s of [...probes.samples, ...recordedErrorSamples(ctx)]) {
      if (seen.has(s.text)) continue;
      seen.add(s.text);
      all.push(s);
    }
    return { samples: all, silent: null };
  };

  // With no error response at all (every probe answered with a result, or
  // went unanswered, and the run recorded none) there was nothing to scan:
  // the pass is flagged as a skip.
  await check("security-error-no-stacktrace", async () => {
    const { samples, silent } = await gather();
    if (silent) return silent;
    const issues = findLeaks(samples, STACK_TRACE_PATTERNS);
    if (issues.length > 0) return { passed: false, details: clip(issues.join("; "), 200) };
    return {
      passed: true,
      details: `${samples.length} unique error response(s) checked -- no stack traces or sensitive data found`,
      ...(samples.length === 0 ? { skipped: true } : {}),
    };
  });

  await check("security-error-no-internal-ip", async () => {
    const { samples, silent } = await gather();
    if (silent) return silent;
    const issues = findLeaks(samples, INTERNAL_IP_PATTERNS, 1);
    if (issues.length > 0) {
      return { passed: false, details: clip(`Error response contains internal IP: ${issues[0]}`, 200) };
    }
    return {
      passed: true,
      details: `${samples.length} unique error response(s) checked -- no internal IP addresses or hostnames found`,
      ...(samples.length === 0 ? { skipped: true } : {}),
    };
  });
}

// ── Rate limiting (1) ────────────────────────────────────────────────

/**
 * The spec's MUST is on tool invocations (server/tools#security-
 * considerations), so the burst goes to a read-only tool that needs no
 * arguments when the server has one, and to `server/discover` otherwise.
 * A 429 anywhere in the burst passes; a burst the server falls over on
 * (mostly 5xx) fails. A quiet burst is graded the same way on both
 * paths -- pass with a warning naming what was bursted -- because 50
 * requests cannot prove the absence of a limiter (a per-minute quota
 * above 50 never trips), and failing only the servers that annotate a
 * read-only tool would punish the annotation. A burst that never
 * reached a handler (every answer 401/403, or no answer at all) is
 * inconclusive, not quiet -- and a 403 in it that is no auth refusal
 * (readAuthRefusal) points at security-auth-required's reading of it, not
 * at the credential.
 */
async function runRateLimiting(ctx: ModernSuiteContext) {
  await ctx.harness.check("security-rate-limiting", async () => {
    if (ctx.kind !== "http") return notApplicable("no HTTP status codes");
    const tools = await ensureTools(ctx);
    const tool = (tools ?? []).find((t) => isNamedTool(t) && isReadOnly(t) && requiredOf(t).length === 0);
    const method = tool ? `tools/call ${tool.name}` : DISCOVER;
    const fire = () =>
      tool
        ? ctx.client.rpc(TOOLS_CALL, { name: tool.name, arguments: {} }, { toolInputSchema: tool.inputSchema })
        : ctx.client.rpc(DISCOVER, {});
    let got429 = false;
    const responses = await Promise.all(
      Array.from({ length: RATE_LIMIT_BURST }, () =>
        fire()
          .then((res) => {
            if (res.statusCode === 429) got429 = true;
            return res;
          })
          .catch(() => null),
      ),
    );
    const statuses = responses.map((res) => res?.statusCode ?? 0);
    if (got429) {
      return {
        passed: true,
        details: `Rate limiting detected (429 returned within ${RATE_LIMIT_BURST} rapid ${method} requests)`,
      };
    }
    if (statuses.every((c) => c === 0)) {
      return unreachable(ctx, `none of the ${RATE_LIMIT_BURST} rapid ${method} requests got a response`);
    }
    const errorCount = statuses.filter((c) => c >= 500).length;
    if (errorCount > RATE_LIMIT_BURST / 2) {
      return {
        passed: false,
        details: `Server returned ${errorCount}/${RATE_LIMIT_BURST} 5xx errors under a burst of ${method} -- should return 429 instead of crashing`,
      };
    }
    const observed = [...new Set(statuses)].join(",");
    if (statuses.every((c) => c === 401 || c === 403)) {
      // Read the way security-auth-required reads a refusal: a 403 that
      // neither asks for a credential nor refuses the one sent (no Bearer
      // challenge without --auth, no Bearer error with it) is what a Host
      // guard, an Origin check or a gateway answers every request with, so
      // the credential is not what to check.
      const unattributed = responses.some((res) => res && readAuthRefusal(res, ctx.hasAuth)?.kind === "forbidden");
      if (unattributed) {
        return {
          passed: true,
          details: clip(
            `Skipped: all ${RATE_LIMIT_BURST} rapid ${method} requests drew HTTP ${observed} before reaching a handler, not as an auth refusal (Host/Origin validation or a gateway), so rate limiting was not measured (see security-auth-required)`,
            220,
          ),
        };
      }
      const hint = ctx.hasAuth ? " (check the configured credential)" : "; pass --auth";
      return {
        passed: true,
        details: `Skipped: all ${RATE_LIMIT_BURST} rapid ${method} requests were rejected by auth (HTTP ${observed}) before reaching a handler, so rate limiting could not be measured${hint}`,
      };
    }
    if (!tool) {
      const why =
        tools === null
          ? ctx.state.discover === null
            ? "capabilities unknown (server/discover rejected)"
            : hasTools(ctx)
              ? "tools/list unavailable"
              : "server declares no tools"
          : "no read-only tool without required arguments";
      ctx.harness.warnings.push(
        `security-rate-limiting: ${why}, so only ${DISCOVER} was bursted (${RATE_LIMIT_BURST} requests, none answered 429); tool invocations, which servers MUST rate limit, could not be exercised -- rate-limit tools/call and verify it by hand.`,
      );
      return {
        passed: true,
        details: `${RATE_LIMIT_BURST} rapid ${DISCOVER} requests all returned ${observed}; tool invocations could not be bursted (${why}, see warning)`,
      };
    }
    ctx.harness.warnings.push(
      `security-rate-limiting: ${RATE_LIMIT_BURST} rapid tools/call ${tool.name} requests drew no 429 (HTTP ${observed}); servers MUST rate limit tool invocations -- apply a per-client limiter to tools/call (429 + Retry-After) and verify it by hand. The burst invoked ${tool.name} ${RATE_LIMIT_BURST} times.`,
    );
    return {
      passed: true,
      details: `No 429 within ${RATE_LIMIT_BURST} rapid ${method} requests (HTTP ${observed}); rate limiting not detected (see warning)`,
    };
  });
}
