import { request } from "undici";
// Intentional dual-layer HTTP: this `request` import is used only by
// wire-level transport tests that need raw status codes, headers, and
// ill-formed bodies (batch arrays, unknown Content-Types, session-id
// absence, etc.). Everything past `lifecycle-init` should go through
// the Transport abstraction in ./transport/* so both HTTP and stdio
// share the same code path. If you find yourself reaching for `request`
// below the lifecycle gate, first check whether Transport.rawRequest /
// rawPost already exposes what you need.
import {
  INJECTION_PAYLOADS,
  INTERNAL_IP_PATTERNS,
  POISONING_PATTERNS,
  STACK_TRACE_PATTERNS,
  VALID_CONTENT_TYPES,
} from "./checks/patterns.js";
import { errorWithCode } from "./checks/validators.js";
import { getTestDefinitionMap } from "./definitions/index.js";
import {
  type AuthRefusal,
  authRefusalHint,
  buildDiscoverProbe,
  classifyDiscoverResponse,
  type DetectionResult,
  detectSpecVersion,
  namesHostOrOriginValidation,
  type ProbeExit,
  probeAnswerShowsEra,
  probeExitOf,
  probeExitWarning,
  REASON_PREFIX,
  readAuthRefusal,
  settledStderr,
  summarizeStderr,
} from "./detect.js";
import { createHarness, supportsTransportByDefinition, type TestOutcome } from "./harness.js";
import { readPackageVersion } from "./pkg-version.js";
import { assembleReport } from "./report.js";
import {
  AUTO_DETECT_NOTE_PREFIX,
  LEGACY_SPEC_VERSION,
  MODERN_SPEC_VERSION,
  type SpecVersion,
  type SpecVersionOption,
  specBaseFor,
} from "./spec.js";
import { pickTool } from "./suites/modern/features.js";
import { twinReachedServer } from "./suites/modern/gate.js";
import { runModernSuite } from "./suites/modern/index.js";
import { evaluateProgress } from "./suites/modern/lifecycle.js";
import {
  classifyInjectionOutput,
  classifyTransportError,
  parseResourceMetadata,
  retryAfterMs,
} from "./suites/modern/security.js";
import { createHttpTransport } from "./transport/http.js";
import type { Transport, TransportResponse } from "./transport/index.js";
import { createStdioTransport, type StdioTransport } from "./transport/stdio.js";
import type { ComplianceReport, TestDefinition, TestResult, TransportTarget } from "./types.js";
import { TEST_DEFINITIONS } from "./types.js";

export { findTestDefinition, getTestDefinitions, MODERN_TEST_DEFINITIONS } from "./definitions/index.js";
export { classifyDiscoverResponse, type DetectionResult, detectSpecVersion } from "./detect.js";
export { computeGrade, computeScore } from "./grader.js";
export { dedupAndCapWarnings } from "./harness.js";
export {
  DEFAULT_SPEC_VERSION,
  LEGACY_SPEC_VERSION,
  MODERN_SPEC_VERSION,
  parseSpecVersionOption,
  type SpecVersion,
  type SpecVersionOption,
  SUPPORTED_SPEC_VERSIONS,
  specBaseFor,
} from "./spec.js";
export type { ComplianceReport, TestResult } from "./types.js";
export { TEST_DEFINITIONS } from "./types.js";

const TEST_DEFINITIONS_MAP = new Map(TEST_DEFINITIONS.map((t) => [t.id, t]));

const TOOL_VERSION = readPackageVersion(import.meta.url);

/**
 * The legacy (2025-11-25) spec version. Kept for library consumers that
 * pinned against a single global; runs may now resolve to a different
 * version (see `RunOptions.specVersion`), so read `report.specVersion`
 * and use `specBaseFor(report.specVersion)` for spec links.
 *
 * @deprecated Use `LEGACY_SPEC_VERSION` / `SUPPORTED_SPEC_VERSIONS` and `specBaseFor()`.
 */
export const SPEC_VERSION: SpecVersion = LEGACY_SPEC_VERSION;
/** @deprecated Use `specBaseFor(version)`. */
export const SPEC_BASE = specBaseFor(LEGACY_SPEC_VERSION);

function createIdCounter(start = 0) {
  let id = start;
  return () => ++id;
}

/**
 * undici rejects an `AbortSignal.timeout()` with a DOMException named
 * `TimeoutError`; its own deadlines reject with `HeadersTimeoutError` /
 * `BodyTimeoutError`. A refused connection or DNS failure is a plain
 * Error with an errno code (ECONNREFUSED, ENOTFOUND) and no such name.
 */
function isTimeoutError(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return typeof name === "string" && /timeout/i.test(name);
}

function formatSeconds(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${(ms / 1000).toFixed(1)}s`;
}

/** Collapse whitespace (a transport error carries a multi-line stderr tail) and cap the length for a details string. */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

/** The first line of an error's message, capped: the stdio transport appends the child's stderr below it. */
function errorLine(err: unknown, max: number): string {
  const message = err instanceof Error ? err.message : String(err);
  return oneLine(message.split("\n")[0] ?? "", max);
}

/**
 * What a request that got no response ran into, read from the error the
 * way the 2026-07-28 suite reads it (classifyTransportError): "no response
 * within Nms" for a timeout, "no response (connection closed: ...)" for a
 * connection the server closed or reset (or a stdio child that exited),
 * and "no response (connection failed: ...)" for everything else, a
 * connection that was never established included.
 */
function noResponse(err: unknown, timeoutMs: number): string {
  const failure = classifyTransportError(err);
  if (failure === "timeout") return `no response within ${timeoutMs}ms`;
  const how = failure === "dropped" ? "connection closed" : "connection failed";
  return `no response (${how}: ${errorLine(err, 90)})`;
}

/**
 * One check's verdict, as the legacy suite's test bodies return it: the
 * harness's own TestOutcome, so a pass that measured nothing carries
 * `skipped: true` through every helper to the report (TestResult.skipped).
 */
type LegacyOutcome = TestOutcome;

/** The verdict for a probe that got no HTTP answer at all: "server unreachable: <what> got no response ...". */
function unreachable(what: string, err: unknown, timeoutMs: number): LegacyOutcome {
  return { passed: false, details: `server unreachable: ${what} got ${noResponse(err, timeoutMs)}` };
}

/**
 * The verdict for a negative probe (no credential, a token in the query
 * string, a foreign Origin, a duplicate initialize) that got no HTTP
 * response, or null when the missing answer counts as the server refusing
 * the probe. The 2026-07-28 suite's `unansweredProbe` rule, applied to the
 * 2025-11-25 checks:
 *
 * - a run the caller aborted is rethrown, never graded;
 * - a timeout is never a refusal: the connection stayed open and nothing
 *   came back, so the probe measured nothing (a hung server or gateway);
 * - a connection that was never established (ECONNREFUSED, ENOTFOUND, a
 *   connect timeout) is never a refusal either: the server never saw the
 *   request, so nothing about the probe's defect was decided;
 * - an accepted connection the server closed or reset without answering is
 *   the one shape a connection-level refusal takes (some gateways drop a
 *   request that lacks a credential instead of answering 401). A drop
 *   carries no reason, so it counts only when `attributable` -- the
 *   comparison request that differs from the probe in nothing but the
 *   defect (the same request carrying the credential, or without the
 *   offending header) was served, so the defect is what drew the drop.
 *   Without that comparison a server that drops everything would pass.
 */
function unansweredProbe(
  what: string,
  err: unknown,
  attributable: boolean,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): LegacyOutcome | null {
  if (signal?.aborted) throw err;
  if (attributable && classifyTransportError(err) === "dropped") return null;
  return unreachable(what, err, timeoutMs);
}

/** "Connection closed without a response (<first line of the error>)" for a drop that counted as a refusal. */
function closedWithoutResponse(err: unknown): string {
  return `Connection closed without a response (${errorLine(err, 60)})`;
}

/** An undici header map with repeated headers joined, as the transports normalize it. */
function flatHeaders(raw: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (value !== undefined) out[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

/** ", JSON-RPC error <code>" when a response body carries a JSON-RPC error, "" otherwise. */
function rpcErrorSuffix(body: unknown): string {
  const error = (body as { error?: unknown } | null | undefined)?.error;
  if (!error || typeof error !== "object") return "";
  return `, ${errorWithCode((error as { code?: unknown }).code)}`;
}

/**
 * The details for an answer that is neither a 401 nor a 403 to a request
 * sent without a valid credential -- security-auth-required's
 * unauthenticated probe, security-auth-malformed's garbage token,
 * security-session-not-auth's session-only ping. The 2025-11-25 counterpart
 * of the 2026-07-28 suite's unauthenticatedOtherStatus, and it FAILS every
 * case the same way; only the reason differs, because the fix does:
 *
 * - a 2xx carrying a JSON-RPC result is the request being served, the one
 *   answer worded `accepted` ("server accepted unauthenticated request");
 * - a 2xx carrying a JSON-RPC error is no HTTP authentication refusal:
 *   whether the server dispatched the request and failed it or refused the
 *   credential in JSON-RPC, a client cannot tell (basic/authorization
 *   refuses a missing or invalid token with 401);
 * - a 2xx carrying anything else (a login page, an intermediary's page) was
 *   neither served nor refused;
 * - another 4xx refused the request, but not as an authentication refusal
 *   (a wrong path, a gateway or a rate limiter);
 * - a 5xx is the server failing on the request rather than refusing it;
 * - a 3xx sent the client somewhere else instead of answering.
 *
 * `what` names the probe ("the unauthenticated ping"); `tail` is what the
 * spec expects instead, appended to every case but the served one.
 */
function unrefusedAnswer(
  res: { statusCode: number; body: unknown },
  what: string,
  accepted: string,
  tail: string,
): LegacyOutcome {
  const status = res.statusCode;
  const body = res.body as { result?: unknown; error?: unknown } | null | undefined;
  const is2xx = status >= 200 && status < 300;
  if (is2xx && body?.result !== undefined && body?.error === undefined) {
    return { passed: false, details: `HTTP ${status} — ${accepted}` };
  }
  const seen = `HTTP ${status}${rpcErrorSuffix(body)} on ${what}`;
  let reading: string;
  if (is2xx) {
    reading =
      body?.error !== undefined && body?.error !== null
        ? "a JSON-RPC error on a 2xx, not an HTTP authentication refusal (a client cannot tell it from the server failing the request)"
        : "a non-JSON-RPC body, neither served nor refused (a login page or an intermediary's page)";
  } else if (status >= 500) {
    reading =
      "the server failed on the request rather than refusing it (a broken server, or a gateway with no backend)";
  } else if (status >= 400) {
    reading =
      "the request was refused, but not as an authentication refusal (a wrong path, a gateway or a rate limiter)";
  } else {
    reading = "the server redirected the request instead of answering it";
  }
  return { passed: false, details: `${seen} -- ${reading}; ${tail}` };
}

/**
 * What the conformant twin of a negative probe got: the request the probe
 * differs from in nothing but its defect (a ping next to the same ping
 * without a credential, or next to an unknown method; a single
 * application/json ping next to a text/plain one or a batch).
 */
interface TwinAnswer {
  /** Whether the twin was served: a JSON-RPC result on a 2xx. */
  served: boolean;
  /** "was served", "was refused (HTTP 403, JSON-RPC error -32000)", "was not served (HTTP 400, ...)", "got no response ...". */
  outcome: string;
  /** The twin's HTTP status, when it got an answer. */
  statusCode?: number;
}

/**
 * Read a twin's answer (see TwinAnswer). `throttled` is "HTTP 429, then
 * after Nms " when the twin was resent once after a 429 (credentialedPing,
 * preInitPing), so its outcome names both answers.
 */
function twinAnswer(res: { statusCode: number; body: unknown }, throttled = ""): TwinAnswer {
  const body = res.body as { result?: unknown } | null | undefined;
  if (res.statusCode >= 200 && res.statusCode < 300 && body?.result !== undefined) {
    return {
      served: true,
      outcome: throttled ? "was served when resent after HTTP 429" : "was served",
      statusCode: res.statusCode,
    };
  }
  const refused = res.statusCode === 401 || res.statusCode === 403;
  return {
    served: false,
    outcome: `${refused ? "was refused" : "was not served"} (${throttled}HTTP ${res.statusCode}${rpcErrorSuffix(res.body)})`,
    statusCode: res.statusCode,
  };
}

/** A server-chosen message for a details string: quoted, with anything outside printable ASCII replaced by "?". */
function quoteMessage(message: string): string {
  return JSON.stringify(message.replace(/[^\x20-\x7e]/g, "?"));
}

/** A raw HTTP body read the way the preflight reads one: SSE, then JSON, else undefined. */
function parseRawBody(text: string, contentType: string | string[] | undefined): unknown {
  const ct = (Array.isArray(contentType) ? contentType[0] : contentType || "").toLowerCase();
  if (ct.includes("text/event-stream")) {
    const parsed = parseSSEResponse(text);
    if (parsed !== null) return parsed;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The JSON-RPC error codes that are a server's own rejection of each
 * negative probe's defect: -32600 (Invalid Request) for a batch, -32600 or
 * -32602 (Invalid params) for an initialize requesting an unknown protocol
 * version, -32601 (Method not found) for an unknown method. A gateway with
 * no backend cannot produce them -- it has not read the request -- so a
 * 5xx carrying one is the server rejecting the defect on an odd status
 * (gateRefusal). -32603 (Internal error), a server-defined -32000..-32099
 * code, or no JSON-RPC error at all is no such rejection.
 */
const BATCH_REJECTION_CODES: readonly number[] = [-32600];
const VERSION_REJECTION_CODES: readonly number[] = [-32600, -32602];
const METHOD_REJECTION_CODES: readonly number[] = [-32601];
/**
 * The same for the error checks' probes: -32600 (Invalid Request) for a
 * body that is JSON but no JSON-RPC message (error-invalid-jsonrpc), -32700
 * (Parse error) for a body that is not JSON (error-invalid-json), -32602
 * (Invalid params) for a tools/call without a name (error-missing-params);
 * error-capability-gated's methods are rejected with METHOD_REJECTION_CODES.
 * lifecycle-jsonrpc reads the initialize the same way: -32600, -32601 (a
 * server that does not speak 2025-11-25) or -32602 (an unsupported version)
 * on a 5xx is a server that read the initialize and refused it.
 */
const ENVELOPE_REJECTION_CODES: readonly number[] = [-32600];
/**
 * A second initialize on a live session is rejected with -32600 (Invalid
 * Request: "Server already initialized", the SDK's answer) --
 * lifecycle-reinit-reject's own code on a 5xx.
 */
const REINIT_REJECTION_CODES: readonly number[] = [-32600];
/** What lifecycle-reinit-reject's probe varies, for its details and warning. */
const REINIT_DEFECT = "the duplicate initialize";
const PARSE_REJECTION_CODES: readonly number[] = [-32700];
const PARAMS_REJECTION_CODES: readonly number[] = [-32602];
const INIT_REFUSAL_CODES: readonly number[] = [-32600, -32601, -32602];

/** The JSON-RPC error code a response body carries, when it is one of `codes`. */
function ownRejectionCode(body: unknown, codes: readonly number[]): number | undefined {
  const code = (body as { error?: { code?: unknown } } | null | undefined)?.error?.code;
  return typeof code === "number" && codes.includes(code) ? code : undefined;
}

/**
 * The warning for a negative probe the server answered with its own
 * JSON-RPC error (see ownRejectionCode) on a 5xx: the status tells clients
 * and gateways that the server failed. It describes the status only and
 * says nothing about the verdict, because it is pushed before the check has
 * decided: the check may still fail on something else (another undeclared
 * method in error-capability-gated). Worded as the 2026-07-28 suite's
 * (suites/modern/gate.ts).
 */
function rejectionOn5xxWarning(check: string, statusCode: number, code: number, defect: string): string {
  return `${check}: the server answered ${defect} with its own JSON-RPC error ${code} on HTTP ${statusCode}; a rejected request is a client error, so a 4xx status is expected (a 5xx tells clients and gateways the server failed).`;
}

/**
 * The verdict for an answer to a negative probe -- a text/plain POST, a
 * batch, an initialize requesting an unknown protocol version, an unknown
 * method, a duplicate initialize -- that something in front of the server
 * gave in its place. Read from the status, so a JSON-RPC error body on it (a
 * gateway's -32001 "Unauthorized") is the gate's too:
 *
 * - a 429: a rate limiter answered before the server read the request (the
 *   caller has already resent the probe once after Retry-After);
 * - a 5xx: the server failed on the request rather than refusing it, or a
 *   gateway with no backend answered -- no rejection either way -- unless
 *   its body carries one of `ownCodes`, the JSON-RPC error that is the
 *   server's own rejection of the defect (see ownRejectionCode): that 5xx
 *   is credited, and the caller warns about the status;
 * - a 401, or a 403 carrying a Bearer challenge: an auth gate (readAuthRefusal),
 *   which refuses the credential, not the defect.
 *
 * Null for any other answer, every 403 without a Bearer challenge included:
 * whether one is a gate is for the probe's conformant twin to say (see
 * bare403Verdict), even when its message names Host or Origin validation.
 * `seen` opens the details ("HTTP 401, JSON-RPC error -32001 on the batch");
 * `defect` names what the probe varies ("the Content-Type").
 */
function gateRefusal(
  seen: string,
  res: { statusCode: number; headers: Record<string, string>; body: unknown },
  authorizationSent: boolean,
  defect: string,
  ownCodes: readonly number[] = [],
): LegacyOutcome | null {
  if (res.statusCode === 429) {
    return {
      passed: false,
      details: `${seen} -- not evaluable: a rate limiter answered before the server read the request, so ${defect} was never looked at`,
    };
  }
  if (res.statusCode >= 500) {
    if (ownRejectionCode(res.body, ownCodes) !== undefined) return null;
    return {
      passed: false,
      details: `${seen} -- the server failed on the request rather than refusing it (a broken server, or a gateway with no backend), which is no rejection of ${defect}`,
    };
  }
  const refusal = readAuthRefusal(res, authorizationSent);
  if (!refusal || refusal.kind === "forbidden") return null;
  return {
    passed: false,
    details: `${seen} -- not evaluable: an auth gate answered before the server read the request (${authRefusalHint(refusal, "pass --auth")})`,
  };
}

/**
 * A 403 without a Bearer challenge on a negative probe is the one refusal
 * that may be either: a gate refusing every request, or the server (or a
 * WAF) refusing the defect. `twin` -- the conformant request the probe
 * differs from in nothing but the defect, with the same headers (Host and
 * Origin included), a 429 on it resent once -- tells them apart: when it
 * was served, or drew a status the server itself chose (twinReachedServer:
 * a 2xx, or a 4xx other than 401, 403 or 429), the defect is what drew the
 * 403, and the refusal is credited (null here), whatever its message says.
 * When it drew the same 403, a 401, a 429 again, a 5xx or no answer, it
 * never reached the server either, so the 403 is not attributable and the
 * probe fails as not evaluable, security-origin-validation's reading of the
 * same 403: quoting the message when the twin drew the same 403 and the
 * message names Host or Origin validation (a guard that refuses a request
 * whatever it carries), naming the twin's answer otherwise. `twinName` names the twin
 * ("the same request for ping"). Only asked for a 403, so a server that
 * answers otherwise is sent nothing more. A caller's abort (while the twin
 * is sent) is rethrown by `twin`.
 */
async function bare403Verdict(
  seen: string,
  res: { statusCode: number; headers: Record<string, string>; body: unknown },
  authorizationSent: boolean,
  defect: string,
  twinName: string,
  twin: () => Promise<TwinAnswer>,
): Promise<LegacyOutcome | null> {
  if (res.statusCode !== 403) return null;
  const answer = await twin();
  if (answer.served || twinReachedServer(answer.statusCode)) return null;
  const message = readAuthRefusal(res, authorizationSent)?.message;
  if (answer.statusCode === res.statusCode && namesHostOrOriginValidation(message)) {
    return {
      passed: false,
      details: `${seen} (${quoteMessage(message ?? "")}) -- not evaluable: the message names Host/Origin validation, which refuses a request whatever it carries`,
    };
  }
  return {
    passed: false,
    details: `${seen} -- not evaluable: ${twinName} ${answer.outcome} too, so the 403 is not attributable to ${defect} (see security-auth-required)`,
  };
}

/** A request's signal: the caller's abort, when there is one, and a deadline of `ms`. */
function requestSignal(signal: AbortSignal | undefined, ms: number): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}

/** ASCII-only, whitespace-collapsed, bounded copy of free text for a details string. */
function clipAscii(text: string, max: number): string {
  const ascii = text.replace(/\s+/g, " ").replace(/[^\x20-\x7e]/g, "?");
  return ascii.length > max ? `${ascii.slice(0, max - 3)}...` : ascii;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// ── security-oauth-metadata: the Protected Resource Metadata lookup ──────
// The 2026-07-28 suite's checkProtectedResourceMetadata, applied to the
// 2025-11-25 check: basic/authorization#protected-resource-metadata-discovery-requirements
// words the discovery the same way in both revisions.

/**
 * RFC 8707 / MCP canonical form of a server URI for comparison: lowercase
 * scheme and host (URL parsing does that), no trailing slash, no fragment.
 * Null when the value is not an absolute URI.
 */
function canonicalUri(value: string): string | null {
  try {
    const u = new URL(value);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return null;
  }
}

/** One GET of a JSON document: its status and the body parsed (undefined when it is not JSON). A caller's abort is rethrown. */
async function getJson(
  url: string,
  timeout: number,
  signal: AbortSignal | undefined,
): Promise<{ status: number; json: any }> {
  const res = await request(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: requestSignal(signal, Math.min(timeout, 5000)),
  });
  const text = await res.body.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.statusCode, json };
}

type PrmFetch =
  | { ok: true; resource: string; authorizationServers: number }
  | { ok: false; status: number | null; problem: string };

/** One GET of a Protected Resource Metadata candidate, validated to the RFC 9728 minimum MCP needs. */
async function fetchProtectedResourceMetadata(
  url: string,
  timeout: number,
  signal: AbortSignal | undefined,
): Promise<PrmFetch> {
  let res: Awaited<ReturnType<typeof getJson>>;
  try {
    res = await getJson(url, timeout, signal);
  } catch (err: unknown) {
    if (signal?.aborted) throw err;
    return { ok: false, status: null, problem: `is unreachable (${clipAscii(errorLine(err, 200), 60)})` };
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
 * security-oauth-metadata's verdict: RFC 9728 Protected Resource Metadata,
 * located the way the spec makes clients locate it. When the 401's
 * WWW-Authenticate challenge carries resource_metadata, clients MUST use
 * that URL, so a challenge URL that is not an absolute http(s) URL, or that
 * is unreachable, non-200 or malformed, fails outright -- the well-known
 * locations are consulted only to say whether a valid document exists that
 * the challenge should point at. Without a challenge URL the well-known
 * locations are tried in spec order: the endpoint-path variant
 * (/.well-known/oauth-protected-resource/<path>), then the root. The
 * document's `resource` must be the MCP endpoint in canonical form; a
 * mismatch passes with a warning. A legacy authorization-server document at
 * the root passes with a warning.
 *
 * `guardStatus` is the status of a refusal of the endpoint nothing could
 * attribute to authentication (a bare 403 security-auth-required could not
 * pin on the credential: authNotEvaluable). When every well-known location
 * and the legacy document drew that same status, the lookup only met the
 * guard again -- a Host guard answers every path of the host alike -- so the
 * check skips instead of advising a document the guard would never let
 * through. A caller's abort is rethrown.
 */
async function protectedResourceMetadataVerdict(
  backendUrl: string,
  timeout: number,
  signal: AbortSignal | undefined,
  warnings: string[],
  challenge: string | undefined,
  guardStatus: number | undefined,
): Promise<LegacyOutcome> {
  const parsed = new URL(backendUrl);
  const origin = `${parsed.protocol}//${parsed.host}`;
  const root = `${origin}/.well-known/oauth-protected-resource`;
  const path = parsed.pathname.replace(/\/+$/, "");
  const wellKnown = path && path !== "/" ? [`${root}${path}`, root] : [root];
  const whereOf = (url: string) => (url.startsWith(`${origin}/`) ? url.slice(origin.length) : clipAscii(url, 80));

  const found = (label: string, doc: Extract<PrmFetch, { ok: true }>): LegacyOutcome => {
    let note = "";
    if (canonicalUri(doc.resource) !== canonicalUri(backendUrl)) {
      warnings.push(
        `security-oauth-metadata: the Protected Resource Metadata at ${label} names resource "${clipAscii(doc.resource, 80)}", which is not the MCP endpoint ${backendUrl} in canonical form; RFC 9728 section 3.3 has clients discard metadata whose resource does not match the URL they used.`,
      );
      note = " (resource does not match the endpoint, see warning)";
    }
    return {
      passed: true,
      details: `Protected Resource Metadata found at ${label}: resource=${clipAscii(doc.resource, 60)}, ${doc.authorizationServers} auth server(s)${note}`,
    };
  };

  const prm = parseResourceMetadata(challenge);
  if (prm.present) {
    if (!prm.url) {
      return {
        passed: false,
        details: clipAscii(
          `WWW-Authenticate resource_metadata "${clipAscii(prm.raw, 80)}" is not an absolute http(s) URL (RFC 9728 section 5.1) -- clients MUST use the advertised URL and cannot fetch this one`,
          220,
        ),
      };
    }
    const label = `${whereOf(prm.url)} (via WWW-Authenticate)`;
    const doc = await fetchProtectedResourceMetadata(prm.url, timeout, signal);
    if (doc.ok) return found(label, doc);
    // Clients go to the advertised URL only, so a valid document elsewhere
    // does not rescue the verdict -- but it is worth naming, since the fix
    // is then one header.
    let elsewhere = "";
    for (const url of wellKnown) {
      if (url === prm.url) continue;
      const alt = await fetchProtectedResourceMetadata(url, timeout, signal);
      if (alt.ok) {
        elsewhere = `; valid document at ${whereOf(url)}`;
        break;
      }
    }
    return {
      passed: false,
      details: clipAscii(
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
    const doc = await fetchProtectedResourceMetadata(url, timeout, signal);
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
  if (malformed) return { passed: false, details: clipAscii(malformed, 200) };
  if (!reachable) return { passed: false, details: "PRM endpoint unreachable" };

  // Legacy fallback: an authorization-server document at the root.
  try {
    const legacy = await getJson(`${origin}/.well-known/oauth-authorization-server`, timeout, signal);
    if (legacy.status !== guardStatus) onlyTheGuard = false;
    const doc = legacy.json;
    if (legacy.status === 200 && doc && typeof doc === "object" && doc.issuer && doc.token_endpoint) {
      warnings.push(
        "Server uses legacy /.well-known/oauth-authorization-server instead of /.well-known/oauth-protected-resource (RFC 9728). Update to PRM for 2025-11-25 compliance.",
      );
      return {
        passed: true,
        details: `Legacy OAuth AS metadata found: issuer=${clipAscii(String(doc.issuer), 60)} (should migrate to PRM)`,
      };
    }
  } catch (err: unknown) {
    if (signal?.aborted) throw err;
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
    details: clipAscii(`No Protected Resource Metadata (${statuses.join("; ")}) and no legacy OAuth metadata`, 220),
  };
}

// ── stdio-unicode: the probe and how a reply to it reads ────────────────
// The 2026-07-28 suite's stdio-unicode reading (suites/modern/stdio.ts),
// applied to the 2025-11-25 check.

/** Latin-1 accent, CJK, an astral-plane emoji. */
const UNICODE_PROBE = "héllo 世界 🚀";
/** The probe's first word: present intact when only the astral/CJK part was lost. */
const UNICODE_PROBE_LATIN1_WORD = "héllo";
/** The probe's CJK word and emoji: either one anywhere in a reply rules out "dropped". */
const UNICODE_PROBE_CJK = "世界";
const UNICODE_PROBE_EMOJI = "🚀";
/** What a UTF-8 byte stream decoded as Latin-1 makes of the first word ("hÃ©llo"). */
const UNICODE_PROBE_MISDECODED = Buffer.from(UNICODE_PROBE_LATIN1_WORD, "utf8").toString("latin1");
/**
 * The probe with every non-ASCII character dropped, up to the space that
 * follows its first word ("hllo "): the skeleton a stripping decoder
 * leaves. The space keeps it out of base64 blobs.
 */
const UNICODE_PROBE_STRIPPED = Array.from(UNICODE_PROBE)
  .filter((c) => c.charCodeAt(0) < 128)
  .join("")
  .replace(/ +$/, " ");
/**
 * The first word as an encoder on a legacy code page writes it: every
 * unencodable character replaced by '?' (one per code point, or one per
 * UTF-16 unit).
 */
const UNICODE_PROBE_QUESTIONED = /h\?{1,2}llo/;
/** Argument names a tool most plausibly echoes, in order of preference. */
const ECHO_ARGUMENT_NAMES = ["message", "text", "input", "query"] as const;
/**
 * The _meta key of the envelope probe: a ping whose _meta carries the
 * unicode probe, the 2025-11-25 stand-in for the 2026-07-28 check's
 * server/discover whose clientInfo name carries it (basic/index#meta allows
 * any prefixed key).
 */
const UNICODE_META_KEY = "com.example.compliance/unicode-probe";
/**
 * How long stdio-unicode waits, once its last probe is answered, for the
 * child to exit before the liveness ping after it (LIVENESS_PING_MS). A
 * child that answers and crashes a moment later (an async logger or
 * callback throwing on the non-ASCII input) is caught here, not by the
 * check after it. Paid once per run by a healthy stdio server.
 */
const UNICODE_EXIT_GRACE_MS = 250;
/** How often that wait looks at the child: the transport reports the exit as a flag. */
const EXIT_POLL_MS = 10;
/**
 * The budget, capped by --timeout, of the plain ping stdio-unicode sends to
 * tell a live child from one its probe killed: between its two probes, and
 * after the bounded wait that follows the last one. A child that has exited
 * but whose exit is not reported yet (a loaded machine is slow to reap it)
 * never answers it, and the transport fails it the moment the exit is
 * reported, so a longer wait could tell nothing more; a ping still
 * unanswered when it runs out means a live child.
 */
const LIVENESS_PING_MS = 2000;

/**
 * Whether a stdio child exits within `ms`: true as soon as it has (at once
 * when it already had), false when the time runs out first. Polled, since
 * the transport reports the exit as a flag. A caller's abort rejects at once
 * with its reason (pause).
 */
async function exitsWithin(stdio: StdioTransport, ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!stdio.exited) {
    const left = deadline - Date.now();
    if (left <= 0) return false;
    await pause(Math.min(EXIT_POLL_MS, left), signal);
  }
  return true;
}

/** The string-typed properties of a tool's inputSchema whose names suggest an echo path. */
function echoArguments(inputSchema: unknown): string[] {
  if (!isRecord(inputSchema) || !isRecord(inputSchema.properties)) return [];
  const props = inputSchema.properties;
  return ECHO_ARGUMENT_NAMES.filter((name) => {
    const p = props[name];
    return isRecord(p) && (p.type === "string" || (Array.isArray(p.type) && p.type.includes("string")));
  });
}

/**
 * The tool to push the unicode probe through: a tool literally named `echo`
 * when the server has one; else the first tool with a string property named
 * message/text/input/query, so the echo path is real; else the first listed
 * tool, which may not echo anything (the envelope probe then decides). The
 * probe goes into the declared echo arguments, or all four names when the
 * tool declares none of them. Null when no listed tool has a name.
 */
function pickUnicodeTool(tools: unknown[]): { name: string; args: string[] } | null {
  const named = tools.filter((t): t is Record<string, unknown> => isRecord(t) && typeof t.name === "string");
  const tool =
    named.find((t) => t.name === "echo") ?? named.find((t) => echoArguments(t.inputSchema).length > 0) ?? named[0];
  if (!tool) return null;
  const declared = echoArguments(tool.inputSchema);
  return { name: tool.name as string, args: declared.length > 0 ? declared : [...ECHO_ARGUMENT_NAMES] };
}

/** Non-ASCII as \uXXXX escapes, so a mis-decoded sample survives the ASCII details. */
function escapeNonAscii(text: string): string {
  return text.replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/**
 * Evidence that a reply MANGLED the unicode probe, or undefined when the
 * probe is merely absent (the tool did not echo its input -- a `get_time`
 * tool answers "12:00" whatever it was sent). "Dropped" needs the first
 * word (intact or as its ASCII skeleton) with NEITHER the CJK word NOR the
 * emoji anywhere in the reply: a search tool that tokenizes or truncates its
 * query reflects the pieces apart, and that is not mangling.
 */
function unicodeManglingEvidence(serialized: string): string | undefined {
  if (serialized.includes("�")) return "the reply carries U+FFFD replacement characters";
  if (serialized.includes(UNICODE_PROBE_MISDECODED)) {
    return `the reply carries the probe decoded as Latin-1 (${escapeNonAscii(UNICODE_PROBE_MISDECODED)})`;
  }
  if (UNICODE_PROBE_QUESTIONED.test(serialized)) {
    return "the reply carries the probe with its non-ASCII characters replaced by '?'";
  }
  const firstWord = serialized.includes(UNICODE_PROBE_LATIN1_WORD) || serialized.includes(UNICODE_PROBE_STRIPPED);
  const rest = serialized.includes(UNICODE_PROBE_CJK) || serialized.includes(UNICODE_PROBE_EMOJI);
  if (firstWord && !rest) return "the reply carries the probe with its CJK/emoji characters dropped";
  return undefined;
}

/** Whether every non-ASCII piece of the probe appears in a reply, contiguous or not (a tokenizing tool). */
function reproducesEveryUnicodePiece(serialized: string): boolean {
  return (
    serialized.includes(UNICODE_PROBE_LATIN1_WORD) &&
    serialized.includes(UNICODE_PROBE_CJK) &&
    serialized.includes(UNICODE_PROBE_EMOJI)
  );
}

/** Short ASCII rendering of a value for a "got X" clause. */
function briefAscii(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return clipAscii(text, 60);
}

/** The first text content of a tools/call answer, for a mangling detail. */
function firstTextOf(body: unknown): string {
  const result = isRecord(body) ? body.result : undefined;
  const content = isRecord(result) ? result.content : undefined;
  if (Array.isArray(content)) {
    const text = content.find((c) => isRecord(c) && typeof c.text === "string") as { text: string } | undefined;
    if (text) return briefAscii(text.text);
  }
  return briefAscii(result ?? body);
}

// ── lifecycle-progress-token: the tool it calls ─────────────────────────

/**
 * The tool to call with a progressToken, as the 2026-07-28 check picks it:
 * one without required arguments (so `arguments: {}` is valid), preferring
 * one that advertises progress in its name or description, else the first
 * listed tool.
 */
function pickProgressTool(tools: unknown[]): string | undefined {
  const named = tools.filter((t): t is Record<string, unknown> => isRecord(t) && typeof t.name === "string");
  const requiresArguments = (t: Record<string, unknown>) =>
    isRecord(t.inputSchema) && Array.isArray(t.inputSchema.required) && t.inputSchema.required.length > 0;
  const noArgs = named.filter((t) => !requiresArguments(t));
  const mentionsProgress = (t: Record<string, unknown>) =>
    /progress/i.test(String(t.name)) || /progress/i.test(typeof t.description === "string" ? t.description : "");
  const tool = noArgs.find(mentionsProgress) ?? noArgs[0] ?? named[0];
  return tool ? String(tool.name) : undefined;
}

/**
 * The first difference security-tool-rug-pull finds between two tools/list
 * snapshots -- the tool count, the set of names, a tool's description -- or
 * null when they match. `arrow` joins the two counts: the first-process
 * path keeps the wording it always had, the replacement path is ASCII.
 */
function toolListDiff(first: any[], second: any[], arrow: string): string | null {
  if (first.length !== second.length) {
    return `Tool count changed: ${first.length} ${arrow} ${second.length} (possible rug-pull)`;
  }
  const names1 = first
    .map((t: any) => t.name)
    .sort()
    .join(",");
  const names2 = second
    .map((t: any) => t.name)
    .sort()
    .join(",");
  if (names1 !== names2) return "Tool names changed between calls (possible rug-pull)";
  for (const t1 of first) {
    const t2 = second.find((t: any) => t.name === t1.name);
    if (t2 && t1.description !== t2.description) {
      return `Tool "${t1.name}" description changed between calls (possible rug-pull)`;
    }
  }
  return null;
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

/** The probe answer in a pinned-run warning: "a DiscoverResult (...)" or the raw shape ("JSON-RPC error -32601"). */
function describeProbeAnswer(d: DetectionResult): string {
  if (d.discover) return `a DiscoverResult (supportedVersions [${(d.supportedVersions ?? []).join(", ")}])`;
  const rest = d.reason.startsWith(REASON_PREFIX) ? d.reason.slice(REASON_PREFIX.length) : d.reason;
  const shape = rest.replace(/, legacy$/, "");
  return /^(JSON-RPC|HTTP|modern|no )/.test(shape) ? shape : `a ${shape}`;
}

/**
 * Why a credential-rejected 401/403 refused the token, from its Bearer
 * challenge's `error` when it names one (RFC 6750 3.1), else from the
 * status (basic/authorization: "Invalid or expired tokens MUST receive a
 * HTTP 401"; 403 is "Invalid scopes or insufficient permissions").
 */
function credentialRejectionReason(refusal: AuthRefusal): string {
  const { statusCode: status, bearerError: error } = refusal;
  if (error === undefined) {
    return status === 403
      ? "a 403 means the token lacks a required scope or permission"
      : "a 401 means the token is invalid or expired";
  }
  const challenge = `the ${status}'s Bearer error="${error}" challenge`;
  switch (error) {
    case "invalid_token":
      return `${challenge} means the token is invalid or expired${status === 403 ? " (basic/authorization requires a 401 for that)" : ""}`;
    case "insufficient_scope":
      return `${challenge} means the token lacks a required scope or permission`;
    case "invalid_request":
      return `${challenge} means the request is malformed (an unsupported parameter, or the token sent more than one way)`;
    default:
      return `${challenge} refuses the token`;
  }
}

/**
 * The first-position warning for a preflight / era probe that drew
 * 401/403, worded from how the refusal reads (see readAuthRefusal):
 * - `auth-required` (no Authorization header; a 401, or a 403 with a
 *   Bearer challenge): re-run with --auth.
 * - `credential-rejected` (a header was sent; a 401, or a 403 whose Bearer
 *   challenge carries an error): check the --auth value, with the reason
 *   named from the challenge's error.
 * - `forbidden` (any other 403): neutral. It is as likely Host/Origin
 *   validation (streamable-http requires 403 for an invalid Origin; the
 *   SDK's Host guard answers a tunnel hostname with it) or a gateway, so
 *   it names those first, then the token's permissions or, with no header
 *   sent, --auth only if the server does require a credential (a server
 *   that wants a token answers 401). A JSON-RPC error message in the body
 *   ("Invalid Host: ...") is quoted.
 */
function authRejectionWarning(opts: {
  displayUrl: string;
  refusal: AuthRefusal;
  spec: SpecVersion;
  auto: boolean;
}): string {
  const { displayUrl, refusal, spec } = opts;
  const status = refusal.statusCode;
  const probe = opts.auto ? "the server/discover probe" : "the preflight";
  const era = opts.auto ? "the era could not be determined and " : "";
  switch (refusal.kind) {
    case "auth-required":
      return `Server at ${displayUrl} requires authentication (${probe} got HTTP ${status}) and no Authorization header was sent, so ${era}the ${spec} grade below is not meaningful. Re-run with --auth <token> (or -H "Authorization: ...").`;
    case "credential-rejected":
      return `Server at ${displayUrl} rejected the configured credential (${probe} carried an Authorization header and got HTTP ${status}), so ${era}the ${spec} grade below is not meaningful. Check the --auth value (or the -H "Authorization: ..." header): ${credentialRejectionReason(refusal)}.`;
  }
  const said = refusal.message ? ` (${JSON.stringify(refusal.message)})` : "";
  if (refusal.authorizationSent) {
    return `Server at ${displayUrl} refused ${probe} with HTTP ${status}${said}, so ${era}the ${spec} grade below is not meaningful. The request carried an Authorization header, but the ${status} has no WWW-Authenticate: Bearer challenge with an error parameter, so it need not be about the credential: check the server's Host and Origin validation (a tunnel or proxy hostname it does not allow), any gateway in front of it, and the permissions of the --auth token.`;
  }
  return `Server at ${displayUrl} refused ${probe} with HTTP ${status}${said} and no Authorization header was sent, so ${era}the ${spec} grade below is not meaningful. The ${status} has no WWW-Authenticate: Bearer challenge, and a server that requires a token answers 401, so it need not be about authentication: check the server's Host and Origin validation (a tunnel or proxy hostname it does not allow) and any gateway in front of it; re-run with --auth <token> (or -H "Authorization: ...") only if the server does require a credential.`;
}

/** The refusal to word a warning from when an undetermined era carries none (classifyDiscoverResponse always sets one). */
function assumedRefusal(authorizationSent: boolean): AuthRefusal {
  return { statusCode: 401, authorizationSent, kind: authorizationSent ? "credential-rejected" : "auth-required" };
}

/** Propagate a caller's abort between phases that no test() gate covers (preflight, detection, handshake). */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
}

/**
 * Spawn the stdio child a target describes. Shared with the benchmark so
 * both re-spawn the same way when the era probe kills a legacy child.
 * @internal
 */
export function spawnStdioTarget(target: Extract<TransportTarget, { type: "stdio" }>): StdioTransport {
  return createStdioTransport({
    command: target.command,
    args: target.args,
    env: target.env,
    cwd: target.cwd,
    verbose: target.verbose,
  });
}

/**
 * Whether a server-chosen value can go out verbatim as an HTTP header
 * value: one or more visible ASCII characters, so no whitespace, no CR/LF
 * and nothing non-ASCII. The negotiated protocolVersion is carried into
 * MCP-Protocol-Version on every later request, and undici throws "invalid
 * mcp-protocol-version header" for anything else -- one bad initialize
 * result would fail every request after it on the client's side. Shared
 * with the benchmark's handshake.
 * @internal
 */
export function isHeaderToken(value: unknown): value is string {
  return typeof value === "string" && /^[\x21-\x7e]+$/.test(value);
}

/**
 * Warnings for `only` / `skip` values that select nothing in a catalog:
 * values that name no test id or category in it (ids are only meaningful
 * within one catalog -- a legacy id such as lifecycle-init does not exist
 * in 2026-07-28), and `only` values whose every match is gated off the
 * target transport (transport-post on a stdio target). Without these a
 * filtered run silently produces an empty (grade F) or partial report.
 * Shared by the live run and `--list`.
 * @internal
 */
export function filterWarnings(
  specVersion: SpecVersion,
  transport: "http" | "stdio",
  only: readonly string[] | undefined,
  skip: readonly string[] | undefined,
): string[] {
  const catalog = getTestDefinitionMap(specVersion);
  const defs = [...catalog.values()];
  const categories = new Set(defs.map((d) => d.category as string));
  const supports = specVersion === LEGACY_SPEC_VERSION ? supportsTransport : supportsTransportByDefinition;
  const out: string[] = [];
  const unknown = [...(only ?? []), ...(skip ?? [])].filter((f) => !catalog.has(f) && !categories.has(f));
  if (unknown.length > 0) {
    out.push(
      `Filter value(s) ${unknown.map((u) => `"${u}"`).join(", ")} match no test id or category in the ${specVersion} catalog; run --list --spec-version ${specVersion} to see valid ids.`,
    );
  }
  const other = transport === "http" ? "stdio" : "http";
  const gated = (only ?? []).filter((f) => {
    const matches = defs.filter((d) => d.id === f || d.category === f);
    return matches.length > 0 && matches.every((d) => !supports(d, transport));
  });
  if (gated.length > 0) {
    out.push(
      `Filter value(s) ${gated.map((g) => `"${g}"`).join(", ")} match only tests that do not apply to a ${transport} target (${other}-only), so they select nothing here; run --list --transport ${transport} --spec-version ${specVersion} to see the ids that apply.`,
    );
  }
  return out;
}

/**
 * Parse SSE (text/event-stream) response body.
 * Handles multi-line data fields per the SSE specification:
 * consecutive "data:" lines are concatenated with "\n".
 * An empty line marks the end of an event.
 * @internal Exported for testing.
 */
export { parseSSEResponse } from "./sse.js";

import { parseSSEMessages, parseSSEResponse } from "./sse.js";

/**
 * Known-HTTP-only tests that use raw HTTP primitives (status codes,
 * headers, TLS, metadata discovery) and have no meaningful stdio
 * equivalent. Kept in code rather than TEST_DEFINITIONS for easy churn.
 */
const STDIO_INCOMPATIBLE_IDS = new Set<string>([
  // Lifecycle tests that use raw undici for HTTP-specific checks
  "lifecycle-string-id",
  // Lifecycle tests that interpret HTTP status codes — for stdio these
  // would always read as the wrapper's default 200 and produce
  // misleading "(HTTP 200)" failure messages.
  "lifecycle-reinit-reject",
  "lifecycle-cancellation",
  "lifecycle-progress",
  "lifecycle-progress-token",
  // Error tests that send hand-crafted malformed bytes via raw HTTP
  // (JSON-RPC layer would reject them before they hit the wire). Could
  // be reimplemented for stdio later by writing raw bytes to stdin.
  "error-invalid-jsonrpc",
  "error-invalid-json",
  "error-parse-code",
  "error-invalid-request-code",
  // Security tests that are inherently HTTP-layer (auth headers,
  // sessions, CORS, TLS, rate limits, RFC 9728 metadata). For stdio
  // servers these don't apply — the parent process owns the trust
  // boundary, not the server.
  "security-tls-required",
  "security-oauth-metadata",
  "security-token-in-uri",
  "security-rate-limiting",
  "security-cors-headers",
  "security-origin-validation",
  "security-session-not-auth",
  "security-auth-required",
  "security-auth-malformed",
  "security-www-authenticate",
  "security-session-entropy",
]);

/**
 * Checks whether a test applies to the active transport.
 * HTTP runs every test. Stdio skips:
 *   - the entire transport category (all HTTP wire-format tests);
 *   - individual tests flagged via `transports` in TEST_DEFINITIONS;
 *   - individual tests in STDIO_INCOMPATIBLE_IDS above.
 */
function supportsTransport(def: TestDefinition | undefined, kind: "http" | "stdio"): boolean {
  if (!def) return true;
  if (def.transports) return def.transports.includes(kind);
  if (kind === "http") return true;
  if (def.category === "transport") return false;
  if (STDIO_INCOMPATIBLE_IDS.has(def.id)) return false;
  return true;
}

export interface PreviewOptions {
  /** Transport to filter against. Defaults to "http". */
  transport?: "http" | "stdio";
  /** Only include matching categories or test IDs. */
  only?: string[];
  /** Exclude matching categories or test IDs. */
  skip?: string[];
  /**
   * Spec revision whose catalog to preview. Defaults to 2025-11-25.
   * There is no `auto` here: a preview never connects, so it cannot
   * detect the server's era.
   */
  specVersion?: SpecVersion;
}

/**
 * Return the set of TestDefinitions that would actually run given the
 * filters. Powers the CLI's --list flag without requiring a connection.
 * Capability-gated tests are still included — that gating happens after
 * the live handshake / discover and can't be predicted offline.
 *
 * Filter precedence mirrors the live run (`only` wins; `skip` is only
 * consulted when `only` is empty) so `--list` predicts what will run.
 */
export function previewTests(opts: PreviewOptions = {}): TestDefinition[] {
  const transport = opts.transport ?? "http";
  const specVersion = opts.specVersion ?? LEGACY_SPEC_VERSION;
  const supports = specVersion === LEGACY_SPEC_VERSION ? supportsTransport : supportsTransportByDefinition;
  const defs = [...getTestDefinitionMap(specVersion).values()];
  return defs.filter((def) => {
    if (!supports(def, transport)) return false;
    if (opts.only?.length) {
      return opts.only.includes(def.category) || opts.only.includes(def.id);
    }
    if (opts.skip?.length) {
      return !opts.skip.includes(def.category) && !opts.skip.includes(def.id);
    }
    return true;
  });
}

export interface RunOptions {
  /**
   * Optional callback for progress updates (legacy minimal signature).
   * It carries no skip flag: a skip arrives as `passed: true`. Use
   * `onTestComplete` and read `result.skipped` to tell them apart.
   */
  onProgress?: (testId: string, passed: boolean, details: string) => void;
  /**
   * Optional callback fired after each test completes with the full
   * TestResult (category, required, skipped, durationMs, specRef). Prefer this
   * over onProgress for live dashboards and streaming UIs that need
   * structured data per test.
   */
  onTestComplete?: (result: TestResult) => void;
  /** Extra headers to include on all requests */
  headers?: Record<string, string>;
  /** Request timeout in milliseconds (default: 15000) */
  timeout?: number;
  /**
   * Deadline for the initial `initialize` handshake + `initialized`
   * notification, in milliseconds. Kept separate from `timeout` because
   * cold-started stdio servers — especially `npx @pkg ...` targets where
   * npm has to resolve and fetch the package before the MCP server
   * starts — can take tens of seconds to produce their first response,
   * while steady-state requests complete in milliseconds. Default is
   * `max(timeout, 60000)` so users who bump `--timeout` keep that value
   * and users on defaults get 60s for startup. Does not apply to any
   * per-test requests past the handshake.
   */
  startupTimeout?: number;
  /** Number of retries for failed tests (default: 0) */
  retries?: number;
  /** Only run tests matching these category names or test IDs */
  only?: string[];
  /** Skip tests matching these category names or test IDs */
  skip?: string[];
  /**
   * HTTP only: deadline for the preflight request, in milliseconds
   * (default: min(timeout, 10000)). The preflight body is the era probe,
   * so under `specVersion: "auto"` a preflight that TIMES OUT (as
   * opposed to a refused connection) is re-probed once within
   * `startupTimeout` before the run defaults to 2025-11-25.
   */
  preflightTimeout?: number;
  /**
   * Optional callback for human-facing status lines while the runner is
   * waiting on something no test has started yet -- today the stdio era
   * probe, which fires this ~2s in when a 2025-11-25 server that ignores
   * unknown methods is silently costing the whole startup timeout. Not
   * part of the report; the CLI prints it dim to stderr in terminal mode.
   */
  onStatus?: (message: string) => void;
  /**
   * Maximum number of parallel-safe tests in flight at once. Default 1
   * (strictly sequential — matches pre-0.12 behavior). Tests are only
   * eligible for parallel execution when their `TestDefinition.parallelSafe`
   * is true; everything else stays sequential regardless. See
   * docs/PERFORMANCE.md for the design.
   */
  concurrency?: number;
  /**
   * AbortSignal that cancels the suite mid-flight. When the signal fires,
   * no further tests start; the in-flight test is cancelled if its
   * underlying request supports the signal. The promise rejects with the
   * signal's reason (an `AbortError` by default).
   *
   * Useful for live UIs (SSE, WebSocket) where the client may disconnect
   * before the suite finishes — wiring the disconnect to abort here
   * stops the server from burning compute on a dropped client.
   */
  signal?: AbortSignal;
  /**
   * Which MCP specification revision to test against. `auto` (default)
   * probes the server with a modern `server/discover` request and grades
   * the newest era it speaks: a DiscoverResult or a recognised modern
   * error (-32020/-32021/-32022) selects 2026-07-28, anything else —
   * including no reply — selects 2025-11-25. A dual-era server is graded
   * as 2026-07-28 and the report warns that the legacy side was not
   * tested. The report's `specVersion` is always the RESOLVED version.
   */
  specVersion?: SpecVersionOption;
}

/**
 * Run the full MCP compliance test suite. Accepts either a URL string
 * (HTTP) or a TransportTarget descriptor (HTTP or stdio).
 */
export async function runComplianceSuite(
  target: string | TransportTarget,
  options: RunOptions = {},
): Promise<ComplianceReport> {
  const resolvedTarget: TransportTarget =
    typeof target === "string" ? { type: "http", url: target, headers: options.headers } : target;

  // Validate the target per transport.
  if (resolvedTarget.type === "http") {
    try {
      const parsed = new URL(resolvedTarget.url);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        throw new Error("Only HTTP and HTTPS URLs are supported");
      }
    } catch (e: unknown) {
      if (e instanceof Error && e.message.includes("Only HTTP")) throw e;
      throw new Error(`Invalid URL: ${resolvedTarget.url}`);
    }
  } else if (!resolvedTarget.command) {
    throw new Error("stdio target requires a command");
  }

  // Construct transport. The stdio factory is kept so the modern suite
  // can spawn an independent second instance for probes that must not
  // share the suite's process (a dual-era stdio server pins its era per
  // process).
  const spawnStdio = () => (resolvedTarget.type === "stdio" ? spawnStdioTarget(resolvedTarget) : null);
  // Reassigned once, and only on stdio: when the era probe kills the child
  // (a legacy server that exits on an unknown pre-initialize request) the
  // suite runs against a fresh instance; `finally` closes whichever is
  // current.
  let transport: Transport =
    resolvedTarget.type === "http"
      ? createHttpTransport({
          url: resolvedTarget.url,
          headers: resolvedTarget.headers ?? options.headers,
        })
      : (spawnStdio() as Transport);

  // Wrap everything below in try/finally so the child process is always
  // cleaned up — even if a test throws or the runner aborts mid-suite.
  try {
    // For HTTP, preserve the backwards-compatible `backendUrl` local for the
    // raw-undici code paths that inspect HTTP-specific behavior (status
    // codes, headers, batch requests, etc). Those paths are gated to the
    // HTTP transport via supportsTransport().
    const backendUrl = resolvedTarget.type === "http" ? resolvedTarget.url : "";
    const userHeaders = resolvedTarget.type === "http" ? (resolvedTarget.headers ?? options.headers ?? {}) : {};

    // Display URL for warnings and reports.
    const displayUrl =
      resolvedTarget.type === "http"
        ? resolvedTarget.url
        : `stdio:${resolvedTarget.command}${resolvedTarget.args?.length ? ` ${resolvedTarget.args.join(" ")}` : ""}`;

    const clientInfo = { name: "mcp-compliance", version: TOOL_VERSION };
    const requested: SpecVersionOption = options.specVersion ?? "auto";

    // Use high start offset for the main ID counter to avoid collision with transport test hardcoded IDs
    const nextId = createIdCounter(1000);
    const timeout = options.timeout || 15000;
    // Startup budget covers the first exchange: the stdio era probe, the
    // legacy initialize + initialized notification, and on HTTP the era
    // re-probe after a preflight timeout. Cold `npx @pkg serve` targets
    // can take 20-40s to resolve and exec the package before the MCP loop
    // runs; a 15s request timeout would fire before the first byte.
    // Default to max(timeout, 60000).
    const startupTimeout = options.startupTimeout ?? Math.max(timeout, 60000);
    const preflightTimeout = options.preflightTimeout ?? Math.min(timeout, 10000);

    // Preflight connectivity check — fail fast instead of running all tests
    // against an unreachable server. HTTP-only: a quick request catches DNS,
    // TLS, and connection-refused failures before we burn through the
    // suite. For stdio there's no equivalent — spawn errors surface via
    // the child 'error' event (handled by the transport) and the first
    // exchange is the real reachability signal.
    //
    // The preflight body is the spec's era probe — a modern
    // `server/discover` with full `_meta` and headers — so on HTTP one
    // round-trip answers both "is it up" and "which era does it speak".
    // Any HTTP response at all counts as reachable. A thrown error is
    // split two ways: a TIMEOUT (the server may just be cold; under
    // `auto` the probe is retried within the startup budget below) and a
    // connection failure (refused, DNS, TLS), which marks the server
    // unreachable right away.
    let serverReachable = true;
    let preflightResponse: TransportResponse | null = null;
    let preflightTimedOut = false;
    let preflightError = "";
    if (resolvedTarget.type === "http") {
      try {
        const probe = buildDiscoverProbe(clientInfo);
        // The caller's abort must cancel the preflight too: on HTTP it is
        // the era probe, and the first test() gate is up to
        // preflightTimeout away.
        const deadline = AbortSignal.timeout(preflightTimeout);
        const preflight = await request(resolvedTarget.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            ...probe.headers,
            ...userHeaders,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "server/discover", params: probe.params }),
          signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline,
        });
        const text = await preflight.body.text();
        const rawCt = preflight.headers["content-type"];
        const ct = (Array.isArray(rawCt) ? rawCt[0] : rawCt || "").toLowerCase();
        let body: unknown = null;
        if (ct.includes("text/event-stream")) body = parseSSEResponse(text);
        if (body === null) {
          try {
            body = JSON.parse(text);
          } catch {
            body = { _raw: text };
          }
        }
        // The headers are kept: a 401/403's WWW-Authenticate challenge
        // decides how the refusal reads (readAuthRefusal).
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(preflight.headers)) {
          if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(", ") : value;
        }
        preflightResponse = { body, requestId: 0, statusCode: preflight.statusCode, headers };
      } catch (err: unknown) {
        throwIfAborted(options.signal);
        serverReachable = false;
        preflightTimedOut = isTimeoutError(err);
        preflightError = err instanceof Error ? err.message : String(err);
      }
    }

    const preWarnings: string[] = [];
    const hasAuthHeader = Object.keys(userHeaders).some((h) => h.toLowerCase() === "authorization");

    // ── Spec version resolution ──────────────────────────────────────
    // `auto` classifies the spec's own era probe (a modern
    // `server/discover`). On HTTP the preflight already sent it; on stdio
    // it is the first exchange and shares the startup budget. An
    // unreachable HTTP server takes the legacy default, so today's
    // "everything fails" report shape is preserved.
    let detection: DetectionResult | undefined;
    let resolvedSpec: SpecVersion;
    let reprobedAfterTimeout = false;
    if (requested === "auto" && resolvedTarget.type === "http" && preflightTimedOut) {
      // The preflight deadline is short by design (min(timeout, 10s)) and
      // a modern server on a cold start can miss it; the legacy path gave
      // that server the whole startup budget for `initialize`, so give
      // the era probe the same budget before defaulting to 2025-11-25.
      reprobedAfterTimeout = true;
      options.onStatus?.(
        `Preflight got no reply within ${preflightTimeout}ms; re-sending the era probe (server/discover, up to ${formatSeconds(startupTimeout)}) before defaulting to ${LEGACY_SPEC_VERSION}.`,
      );
      const retry = await detectSpecVersion(transport, {
        nextId,
        timeout: startupTimeout,
        clientInfo,
        signal: options.signal,
        authorizationSent: hasAuthHeader,
      });
      throwIfAborted(options.signal);
      if (retry.responded) {
        serverReachable = true;
        detection = retry;
      }
    }
    // The unreachable warning is provisional on a preflight TIMEOUT: a
    // pinned run is not re-probed, so a slow cold start can miss the
    // preflight and still answer the handshake; once it does, the
    // warning is replaced (see settleUnreachableWarning).
    let unreachableWarning: string | null = null;
    if (!serverReachable) {
      unreachableWarning = preflightTimedOut
        ? `Server at ${displayUrl} did not answer the preflight within ${preflightTimeout}ms${reprobedAfterTimeout ? ` or the era probe within ${startupTimeout}ms` : ""}; treating it as unreachable -- every test that needs the server will fail. A slow cold start needs a higher --preflight-timeout${reprobedAfterTimeout ? " / --startup-timeout" : ""}.`
        : `Server at ${displayUrl} is unreachable (${preflightError}) -- every test that needs the server will fail. Check the URL or command and ensure the server is running.`;
      preWarnings.push(unreachableWarning);
    }
    const settleUnreachableWarning = (warnings: string[], answered: boolean) => {
      if (!unreachableWarning || !preflightTimedOut || !answered) return;
      const i = warnings.indexOf(unreachableWarning);
      if (i === -1) return;
      // Re-probed means auto with no era seen, so the legacy suite ran by
      // default (a modern verdict needs an answered probe). A slow cold
      // start is one reading; a server that never answers server/discover
      // (a bridge in front of a 2025-11-25 server that ignores unknown
      // methods) is the other, and for it a higher timeout only adds wait.
      warnings[i] = reprobedAfterTimeout
        ? `Server at ${displayUrl} did not answer the preflight within ${preflightTimeout}ms or the era probe within ${startupTimeout}ms but did answer initialize, so its era was not detected and this run defaulted to ${LEGACY_SPEC_VERSION}. A slow cold start needs a higher --preflight-timeout / --startup-timeout; a server that never answers server/discover costs that wait on every auto run, and --spec-version ${LEGACY_SPEC_VERSION} skips the re-probe.`
        : `Server at ${displayUrl} did not answer the preflight within ${preflightTimeout}ms but did answer later requests; a slow cold start needs a higher --preflight-timeout.`;
    };
    // A stdio child that died on the era probe; the warning is composed
    // once the fresh instance's first exchange has settled (a server that
    // exits at startup regardless of the probe must not be told to pin).
    let probeExit: ProbeExit | null = null;
    if (requested === "auto" && serverReachable) {
      if (!detection) {
        detection =
          resolvedTarget.type === "http"
            ? classifyDiscoverResponse(preflightResponse, { authorizationSent: hasAuthHeader })
            : await detectSpecVersion(transport, {
                nextId,
                timeout: startupTimeout,
                clientInfo,
                signal: options.signal,
                onStatus: options.onStatus,
              });
        throwIfAborted(options.signal);
      }
      resolvedSpec = detection.version;
      preWarnings.push(
        `${AUTO_DETECT_NOTE_PREFIX}${resolvedSpec} (${detection.reason}). Pin with --spec-version to override.`,
      );
      // A legacy server whose dispatcher throws on an unknown method dies
      // on the probe. The transport already rejected the probe with the
      // exit diagnostic (detectSpecVersion folds that into "no response");
      // give the suite a live child instead of a dead one, and say so
      // once that child has shown whether it survives at all.
      probeExit = await probeExitOf(transport);
      if (probeExit) {
        await transport.close().catch(() => {});
        transport = spawnStdio() as Transport;
        if (detection.era === "modern") {
          // The modern suite's first exchange is its own discover; the
          // probe was answered, so the child did not exit at startup.
          preWarnings.push(
            await probeExitWarning(probeExit, transport, { era: "modern", answered: true, spawner: "suite" }),
          );
          probeExit = null;
        }
      }
      if (detection.eraUndetermined) {
        // Read from the classified answer: after a preflight timeout the
        // re-probe answered, and the preflight holds nothing.
        preWarnings.unshift(
          authRejectionWarning({
            displayUrl,
            refusal: detection.refusal ?? assumedRefusal(hasAuthHeader),
            spec: resolvedSpec,
            auto: true,
          }),
        );
      }
    } else {
      resolvedSpec = requested === "auto" ? LEGACY_SPEC_VERSION : requested;
      // A pinned HTTP run still sent the probe as its preflight; when the
      // answer plainly belongs to the OTHER era, say so -- a pinned
      // 2025-11-25 run against a modern-only server otherwise fails 20
      // tests whose headline ("lifecycle-init: ...") never mentions
      // 2026-07-28. A dual-era server pinned to its legacy side is not a
      // mismatch, and a 5xx or an intermediary's page is not an era.
      if (requested !== "auto" && preflightResponse) {
        const seen = classifyDiscoverResponse(preflightResponse, { authorizationSent: hasAuthHeader });
        if (seen.eraUndetermined) {
          preWarnings.unshift(
            authRejectionWarning({
              displayUrl,
              refusal: seen.refusal ?? assumedRefusal(hasAuthHeader),
              spec: resolvedSpec,
              auto: false,
            }),
          );
        } else if (seen.version !== requested && !seen.eraUndetermined) {
          if (seen.supportedVersions?.includes(requested)) {
            preWarnings.push(
              `Server is dual-era (server/discover advertised supportedVersions [${seen.supportedVersions.join(", ")}]); this run grades its ${requested} side.`,
            );
          } else if (seen.era === "modern" || probeAnswerShowsEra(preflightResponse)) {
            preWarnings.push(
              `Server answered the ${MODERN_SPEC_VERSION} server/discover probe with ${describeProbeAnswer(seen)}; this run is pinned to ${requested}. Re-run with --spec-version ${seen.version} (or auto) to grade it.`,
            );
          }
        }
      }
    }

    // `--only` / `--skip` values that match nothing in the resolved
    // catalog, or only tests gated off this transport, would silently
    // produce an empty (grade F) or partial run: name the miss.
    preWarnings.push(...filterWarnings(resolvedSpec, transport.kind, options.only, options.skip));

    if (resolvedSpec === MODERN_SPEC_VERSION) {
      const report = await runModernSuite({
        transport,
        options,
        nextId,
        timeout,
        startupTimeout,
        backendUrl,
        userHeaders,
        displayUrl,
        toolVersion: TOOL_VERSION,
        detection,
        warnings: preWarnings,
        spawnFresh: resolvedTarget.type === "stdio" ? () => spawnStdio() as Transport : undefined,
      });
      // A served discover (the suite's first exchange) is proof the server
      // was reachable after all.
      settleUnreachableWarning(report.warnings, report.serverInfo.protocolVersion !== null);
      return report;
    }

    const harness = createHarness({
      definitions: TEST_DEFINITIONS_MAP,
      specBase: SPEC_BASE,
      transportKind: transport.kind,
      supportsTransport,
      only: options.only,
      skip: options.skip,
      retries: options.retries,
      concurrency: options.concurrency,
      signal: options.signal,
      onProgress: options.onProgress,
      onTestComplete: options.onTestComplete,
    });
    const { tests, warnings, test, drainPool } = harness;
    warnings.push(...preWarnings);

    // Session state — kept as locals for backwards-compat with existing
    // call sites that reference `sessionId`/`negotiatedProtocolVersion`
    // directly. Updates are mirrored to the transport so any transport
    // that cares (future work) can read them.
    let sessionId: string | null = null;
    let negotiatedProtocolVersion: string | null = null;

    function buildHeaders(): Record<string, string> {
      const h: Record<string, string> = { ...userHeaders };
      if (sessionId) h["mcp-session-id"] = sessionId;
      if (negotiatedProtocolVersion) h["mcp-protocol-version"] = negotiatedProtocolVersion;
      return h;
    }

    // Local closures with the old signatures — delegate to the transport.
    // The `_backendUrl` parameter is ignored (transport already knows the
    // URL) but kept for minimal churn at call sites.
    async function mcpRequest(
      _backendUrl: string,
      method: string,
      params: unknown | undefined,
      idCounter: () => number,
      extraHeaders: Record<string, string> | undefined,
      timeoutMs: number,
      omitUserHeaders?: string[],
    ): Promise<{ statusCode: number; body: any; headers: Record<string, string>; requestId: number }> {
      const res = await transport.request(method, params, idCounter, {
        timeout: timeoutMs,
        headers: extraHeaders,
        omitUserHeaders,
        signal: options.signal,
      });
      return {
        statusCode: res.statusCode ?? 200,
        body: res.body as any,
        headers: res.headers ?? {},
        // The legacy suite only ever allocates numeric ids.
        requestId: res.requestId as number,
      };
    }
    async function mcpNotification(
      _backendUrl: string,
      method: string,
      params: unknown | undefined,
      extraHeaders: Record<string, string> | undefined,
      timeoutMs: number,
    ) {
      const res = await transport.notify(method, params, {
        timeout: timeoutMs,
        headers: extraHeaders,
        signal: options.signal,
      });
      return { statusCode: res.statusCode ?? 200, headers: res.headers ?? {} };
    }

    const rpc = (method: string, params?: unknown) =>
      mcpRequest(backendUrl, method, params, nextId, buildHeaders(), timeout);

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

    // ── 1. TRANSPORT (basic, pre-init) ───────────────────────────────

    /**
     * The conformant twin of transport-content-type-reject's text/plain POST
     * and transport-batch-reject's batch: the same ping sent on its own as
     * application/json, before initialization, with the same headers --
     * transport-post's request. The handshake cannot be the twin of these
     * two: they run before it. Sent at most once per run, and only when one
     * of them drew a 403 without a Bearer challenge -- one whose message
     * names Host/Origin validation included (see bare403Verdict). A 429 is
     * resent once after Retry-After, as the probes' are, and the second
     * answer is the twin's. A caller's abort is rethrown.
     */
    let preInitPingOnce: Promise<TwinAnswer> | null = null;
    const preInitPing = (): Promise<TwinAnswer> => {
      preInitPingOnce ??= (async () => {
        const send = async () => {
          const res = await request(backendUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              ...userHeaders,
            },
            body: JSON.stringify({ jsonrpc: "2.0", id: 99906, method: "ping" }),
            signal: options.signal
              ? AbortSignal.any([options.signal, AbortSignal.timeout(timeout)])
              : AbortSignal.timeout(timeout),
          });
          const text = await res.body.text();
          return {
            statusCode: res.statusCode,
            headers: flatHeaders(res.headers),
            body: parseRawBody(text, res.headers["content-type"]),
          };
        };
        let throttled = "";
        try {
          let res = await send();
          if (res.statusCode === 429) {
            const wait = retryAfterMs(res.headers);
            await pause(wait, options.signal);
            throttled = `HTTP 429, then after ${wait}ms `;
            res = await send();
          }
          return twinAnswer(res, throttled);
        } catch (err: unknown) {
          if (options.signal?.aborted) throw err;
          const resent = throttled ? "answered HTTP 429, and its resend " : "";
          return { served: false, outcome: `${resent}got ${noResponse(err, timeout)}` };
        }
      })();
      return preInitPingOnce;
    };
    const PRE_INIT_TWIN = "the same ping sent on its own as application/json";

    /**
     * POST a pre-initialization probe (the text/plain ping, the batch) with
     * the run's headers -- or, with the session's headers passed in, a raw
     * body after the handshake (sendRawPostInit: error-invalid-jsonrpc,
     * error-invalid-json) -- resending it once after Retry-After (capped at 2 s,
     * retryAfterMs) when a rate limiter answered 429, as
     * lifecycle-reinit-reject does; the second answer decides. `throttled`
     * is "HTTP 429, then after Nms " once it was resent; `body` is the
     * answer parsed as JSON (undefined when it is not), `text` the raw one.
     * A caller's abort is rethrown.
     */
    const sendRawProbe = async (
      headers: Record<string, string>,
      body: string,
    ): Promise<{
      statusCode: number;
      headers: Record<string, string>;
      body: unknown;
      text: string;
      throttled: string;
    }> => {
      const send = async () => {
        const res = await request(backendUrl, {
          method: "POST",
          headers: { ...headers, ...userHeaders },
          body,
          signal: options.signal
            ? AbortSignal.any([options.signal, AbortSignal.timeout(timeout)])
            : AbortSignal.timeout(timeout),
        });
        const text = await res.body.text();
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {}
        return { statusCode: res.statusCode, headers: flatHeaders(res.headers), body: parsed, text };
      };
      let res = await send();
      let throttled = "";
      if (res.statusCode === 429) {
        const wait = retryAfterMs(res.headers);
        await pause(wait, options.signal);
        throttled = `HTTP 429, then after ${wait}ms `;
        res = await send();
      }
      return { ...res, throttled };
    };

    await test(
      "transport-post",
      "HTTP POST accepted",
      "transport",
      true,
      "basic/transports#streamable-http",
      async () => {
        const res = await request(backendUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            ...userHeaders,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 99901, method: "ping" }),
          signal: AbortSignal.timeout(timeout),
        });
        const text = await res.body.text();
        if (res.statusCode >= 200 && res.statusCode < 300) {
          return { passed: true, details: `HTTP ${res.statusCode}` };
        }
        // "pass --auth" only when the status asks for a credential none was
        // sent for; "credential rejected" only when it refused the one sent;
        // any other 403 may be Host/Origin validation (readAuthRefusal).
        const refusal = readAuthRefusal({ statusCode: res.statusCode, headers: res.headers }, hasAuthHeader);
        if (refusal) {
          const hint = authRefusalHint(refusal, "auth required — pass --auth", "—");
          return { passed: false, details: `HTTP ${res.statusCode} (${hint})` };
        }
        // 400 with a JSON-RPC error body is acceptable — server processed the POST
        // but rejected the pre-init request (e.g., session required)
        if (res.statusCode === 400) {
          try {
            const body = JSON.parse(text);
            if (body?.error || body?.jsonrpc) {
              return {
                passed: true,
                details: "HTTP 400 with JSON-RPC response (server requires initialization first)",
              };
            }
          } catch {}
        }
        return { passed: false, details: `HTTP ${res.statusCode}` };
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
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            ...userHeaders,
          },
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
      "transport-content-type-reject",
      "Rejects non-JSON request Content-Type",
      "transport",
      false,
      "basic/transports#streamable-http",
      async () => {
        // Send a request with text/plain instead of application/json. A 4xx
        // is the server rejecting it -- unless something in front of the
        // server answered in its place (gateRefusal: an auth gate, a rate
        // limiter, a 5xx), or a 403 that the same ping as application/json
        // drew too (bare403Verdict: a guard, Host/Origin validation among
        // them, refusing every request). A 403 the twin did not draw is the
        // Content-Type's, whatever its message names.
        const res = await sendRawProbe(
          { "Content-Type": "text/plain", Accept: "application/json, text/event-stream" },
          JSON.stringify({ jsonrpc: "2.0", id: 99905, method: "ping" }),
        );
        const seen = `${res.throttled}HTTP ${res.statusCode}${rpcErrorSuffix(res.body)} on the text/plain POST`;
        const gated =
          gateRefusal(seen, res, hasAuthHeader, "the Content-Type") ??
          (await bare403Verdict(seen, res, hasAuthHeader, "the Content-Type", PRE_INIT_TWIN, preInitPing));
        if (gated) return gated;
        if (res.statusCode >= 400 && res.statusCode < 500) {
          return { passed: true, details: `HTTP ${res.statusCode} (incorrect Content-Type rejected)` };
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          return {
            passed: false,
            details: `HTTP ${res.statusCode} — server accepted text/plain Content-Type (should require application/json)`,
          };
        }
        return { passed: false, details: `HTTP ${res.statusCode}` };
      },
    );

    await test(
      "transport-get",
      "GET returns SSE stream or 405",
      "transport",
      false,
      "basic/transports#streamable-http",
      async () => {
        const getHeaders: Record<string, string> = { Accept: "text/event-stream", ...buildHeaders() };
        const res = await request(backendUrl, {
          method: "GET",
          headers: getHeaders,
          signal: AbortSignal.timeout(timeout),
        });
        const body = await res.body.text();
        const rawCt = res.headers["content-type"];
        const ct = (Array.isArray(rawCt) ? rawCt[0] : rawCt || "").toLowerCase();
        if (res.statusCode === 405) {
          return { passed: true, details: "HTTP 405 Method Not Allowed (acceptable)" };
        }
        if (ct.includes("text/event-stream")) {
          // Validate the SSE payload has proper format if non-empty
          if (body.trim().length > 0) {
            const hasDataFields = body.includes("data:");
            const hasEventFields = body.includes("event:");
            if (!hasDataFields && !hasEventFields) {
              return {
                passed: false,
                details: "Content-Type is text/event-stream but body has no SSE data: or event: fields",
              };
            }
          }
          return { passed: true, details: "Returns text/event-stream with valid SSE format" };
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          return { passed: true, details: `HTTP ${res.statusCode} (accepted)` };
        }
        return { passed: false, details: `HTTP ${res.statusCode}, Content-Type: ${ct}` };
      },
    );

    await test(
      "transport-batch-reject",
      "Rejects JSON-RPC batch requests",
      "transport",
      true,
      "basic/transports#streamable-http",
      async () => {
        const res = await sendRawProbe(
          { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
          JSON.stringify([
            { jsonrpc: "2.0", id: 99903, method: "ping" },
            { jsonrpc: "2.0", id: 99904, method: "ping" },
          ]),
        );
        const text = res.text;
        // Server should reject batch with error or 4xx -- its own rejection:
        // an answer something in front of it gave in its place (gateRefusal),
        // or a 403 that the same ping sent on its own drew too
        // (bare403Verdict), is no rejection of the batch, JSON-RPC error body
        // or not. A 5xx is no rejection either, unless it carries the
        // server's own -32600 (credited, with a warning about the status).
        const seen = `${res.throttled}HTTP ${res.statusCode}${rpcErrorSuffix(res.body)} on the batch`;
        const gated =
          gateRefusal(seen, res, hasAuthHeader, "the batch", BATCH_REJECTION_CODES) ??
          (await bare403Verdict(seen, res, hasAuthHeader, "the batch", PRE_INIT_TWIN, preInitPing));
        if (gated) return gated;
        const on5xx = res.statusCode >= 500 ? ownRejectionCode(res.body, BATCH_REJECTION_CODES) : undefined;
        if (on5xx !== undefined) {
          warnings.push(rejectionOn5xxWarning("transport-batch-reject", res.statusCode, on5xx, "the batch"));
        }
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
    /**
     * Whether the handshake was served. It is the conformant twin of every
     * negative probe the suite sends later -- the same request without a
     * foreign Origin, without a duplicate, without a token in the query
     * string, and (with `hasAuth`) carrying the credential -- so a probe
     * that got dropped is pinned on its defect only when this is true. The
     * 2026-07-28 suite pins the same drops on its setup server/discover
     * (credentialedDiscoverServed).
     */
    const handshakeServed = () => initRes?.body?.result !== undefined;
    // Why the handshake produced no response at all (transport error:
    // timeout, crashed child, refused connection); lifecycle-init prints it.
    let initError: string | null = null;
    const initStart = Date.now();
    // The handshake uses `startupTimeout` (not `timeout`) to give
    // slow-starting stdio servers room (see RunOptions.startupTimeout) --
    // unless the server has already sat silent through the preflight AND
    // the era re-probe's full startup budget, in which case a third
    // startup-sized wait buys nothing and the per-request timeout bounds
    // it instead.
    const handshakeTimeout = reprobedAfterTimeout && !serverReachable ? timeout : startupTimeout;
    // Declare all three client capabilities so servers see us as a
    // fully-capable client. Servers that break on unknown or
    // unexpected client capabilities (they shouldn't — spec is
    // forward-compatible) will fail the lifecycle-*-capability
    // tests below. Shared with the handshake a restarted stdio child gets.
    const initializeParams = {
      protocolVersion: SPEC_VERSION,
      capabilities: {
        sampling: {},
        roots: { listChanged: true },
        elicitation: {},
      },
      clientInfo: { name: "mcp-compliance", version: TOOL_VERSION },
    };
    throwIfAborted(options.signal);
    try {
      initRes = await mcpRequest(backendUrl, "initialize", initializeParams, nextId, buildHeaders(), handshakeTimeout);
      const result = initRes?.body?.result;
      if (result) {
        serverInfo.protocolVersion = result.protocolVersion || null;
        serverInfo.name = result.serverInfo?.name || null;
        serverInfo.version = result.serverInfo?.version || null;
        serverInfo.capabilities = result.capabilities || {};
        const sid = initRes.headers["mcp-session-id"];
        if (sid) {
          sessionId = sid;
          transport.setSessionId(sid);
        }
        // Only a value that can be sent as a header is carried. Anything
        // else (CR/LF, spaces, non-ASCII) is left off the later requests
        // instead of failing each of them client-side; lifecycle-proto-version
        // still reports the value the server sent.
        if (isHeaderToken(result.protocolVersion)) {
          negotiatedProtocolVersion = result.protocolVersion;
          transport.setProtocolVersion(result.protocolVersion);
        }
      }
    } catch (err: unknown) {
      throwIfAborted(options.signal);
      // Init failed — lifecycle-init reports the failure with this reason.
      const message = err instanceof Error ? err.message : String(err);
      if (transport.kind === "stdio") {
        // The transport's message appends the raw stderr tail, which for a
        // crashing Node child is mostly stack frames; keep the diagnostic
        // ("server crashed with exit code 1 ...") and summarize the stderr
        // so the line naming the cause survives ahead of the frames.
        const head = message.split(/\n\s*child stderr:/)[0];
        const tail = summarizeStderr(await settledStderr(transport as StdioTransport));
        initError = tail ? `${head} (last stderr: ${tail})` : head;
      } else {
        initError = message;
      }
    }
    if (probeExit && detection) {
      warnings.push(
        await probeExitWarning(probeExit, transport, {
          era: detection.era,
          answered: initRes !== null,
          spawner: "suite",
        }),
      );
    }
    settleUnreachableWarning(warnings, initRes !== null);

    // Warn if initialize crossed the per-request timeout. The server
    // answered in the end (we got here), but steady-state tests will
    // re-use `timeout` and may start failing at the same rate the
    // handshake was almost killed at. Nudge users toward `--timeout`
    // so subsequent tests don't flake.
    const initElapsed = Date.now() - initStart;
    if (initRes && initElapsed > timeout) {
      warnings.push(
        `Initialize handshake took ${initElapsed}ms — longer than --timeout ${timeout}ms. Per-test requests use --timeout, so slow servers may flake. Consider raising --timeout.`,
      );
    }

    // Send initialized notification (for session setup). Shares the
    // startup budget — some servers don't write their prompt to stdout
    // until this lands. Skipped when initialize got no response at all:
    // there is nothing to acknowledge, and against a hung server the
    // notification would only cost a second startup-sized wait.
    if (initRes !== null) {
      try {
        await mcpNotification(backendUrl, "notifications/initialized", undefined, buildHeaders(), handshakeTimeout);
      } catch {}
    }

    // Capability flags computed once post-init. Some later-section tests
    // read these from closures declared before the tools/resources/prompts
    // sections; hoist them here to avoid TDZ errors.
    const hasTools = !!serverInfo.capabilities.tools;
    const hasResources = !!serverInfo.capabilities.resources;
    const hasPrompts = !!serverInfo.capabilities.prompts;

    /**
     * The tools/list result tools-list read (null until it read one).
     * Declared ahead of restartStdioServer, which reads it.
     */
    let cachedToolsList: any[] | null = null;

    /**
     * stdio: the process the suite talks to is not the one cachedToolsList
     * was read from. Set by restartStdioServer each time it replaces a child
     * that a check's own request killed after tools-list read the list (the
     * latest replacement wins); null while that process runs. `after` names
     * the check whose request killed the previous process. `tools` is the
     * replacement's tools/list result, read right after its handshake and
     * before any tools/call reached it; null when that list was not
     * obtained (the restart's warning says why). security-tool-rug-pull
     * takes its "before" from here, so both of its lists come from one
     * process (rugPullOnReplacement): the 2026-07-28 suite's
     * ModernState.replacement.
     */
    let replacement: { after: string; tools: any[] | null } | null = null;

    /**
     * Replace a stdio child that exited on a check's own request -- an
     * injection payload, security-oversized-input's 1 MB line,
     * security-extra-params' unknown arguments, lifecycle-version-negotiate's
     * second initialize (requesting an unknown version) -- with a fresh instance
     * and redo the initialize handshake. Declared ahead of every check that
     * calls it (a const arrow is not usable before its declaration runs). That check already
     * fails as "server died"; left dead, the child would fail every later
     * test with a diagnosis of its own -- stdio-framing's "framing likely
     * broken" (a required test), security-extra-params' "server
     * unreachable" -- so one crash would be counted over and over under the
     * wrong names. `check` is the check that killed the child, which the
     * warning names along with `cause`; it also says the later tests ran
     * against a restarted instance, and whether its handshake was served.
     * Only a child that died on the check's own request is restarted (one
     * already gone was not killed by it), so a server that dies on every
     * tools/call is respawned once per check attempt that sends one
     * (--retries repeats the attempt).
     *
     * Once tools-list has read the list (cachedToolsList), the lists cached
     * so far describe the process that just exited: the restart records
     * that (replacement) and, once the new instance's handshake is served,
     * reads its tools/list before any tools/call reaches it, for
     * security-tool-rug-pull (rugPullOnReplacement). The warning says when
     * that list was not obtained. A restart before tools-list ran (the one
     * lifecycle-version-negotiate triggers) sends no such list: tools-list
     * reads the new instance's own. A run the caller aborts during the
     * handshake or the list is rethrown.
     */
    const restartStdioServer = async (check: string, cause: string): Promise<void> => {
      await transport.close().catch(() => {});
      transport = spawnStdio() as Transport;
      // From here on the suite talks to a process the cached list did not come from.
      const current = cachedToolsList !== null ? { after: check, tools: null as any[] | null } : null;
      if (current) replacement = current;
      const restarted = `${check}: the server exited on ${cause} and was restarted`;
      const consequence = "the tests after it ran against the new instance and may fail for that reason";
      try {
        const res = await mcpRequest(
          backendUrl,
          "initialize",
          initializeParams,
          nextId,
          buildHeaders(),
          startupTimeout,
        );
        const result = res.body?.result;
        if (result) {
          if (isHeaderToken(result.protocolVersion)) transport.setProtocolVersion(result.protocolVersion);
          try {
            await mcpNotification(backendUrl, "notifications/initialized", undefined, buildHeaders(), startupTimeout);
          } catch {}
          const fresh = `${restarted} with a fresh initialize handshake`;
          if (current) {
            // The new instance's tools before any tools/call reached it.
            const listing = "its tools/list (read before any tools/call, for security-tool-rug-pull)";
            try {
              const listed = await mcpRequest(backendUrl, "tools/list", undefined, nextId, buildHeaders(), timeout);
              const tools = listed.body?.result?.tools;
              if (!Array.isArray(tools)) {
                warnings.push(
                  `${fresh}, so the tests after it ran against the new instance, but ${listing} answered with no tools array (${answerShape(listed)}).`,
                );
                return;
              }
              current.tools = tools;
            } catch (err: unknown) {
              if (options.signal?.aborted) throw err;
              warnings.push(`${fresh}, but ${listing} got ${noResponse(err, timeout)}; ${consequence}.`);
              return;
            }
          }
          warnings.push(`${fresh}, so the tests after it ran against the new instance.`);
          return;
        }
        const code = rpcErrorSuffix(res.body);
        warnings.push(
          `${restarted}, but the new instance answered initialize with no result${code ? ` (${code.slice(2)})` : ""}; ${consequence}.`,
        );
      } catch (err: unknown) {
        if (options.signal?.aborted) throw err;
        warnings.push(
          `${restarted}, but the new instance's initialize got ${noResponse(err, startupTimeout)}; ${consequence}.`,
        );
      }
    };

    /**
     * The same ping carrying the configured credential (and the session):
     * whether it was served (a JSON-RPC result on a 2xx), or else what it
     * got, as a clause ("was refused (HTTP 403)", "was not served (HTTP
     * 400, JSON-RPC error -32600)", "got no response ..."; see TwinAnswer).
     * Next to an unauthenticated ping that differs from it only in the
     * missing credential, a served twin pins a bare 403 or a dropped
     * connection on that credential; next to error-unknown-method's probe,
     * which differs from it only in the method, it pins a bare 403 on the
     * method. `statusCode` is the twin's status, when it got one. A 429 is
     * resent once after Retry-After (rpcResending429), as the probes' are,
     * and the second answer is the twin's. A caller's abort is rethrown.
     */
    const credentialedPing = async (): Promise<TwinAnswer> => {
      let throttledFirst = false;
      try {
        const { res, throttled } = await rpcResending429("ping", undefined, () => {
          throttledFirst = true;
        });
        return twinAnswer(res, throttled);
      } catch (err: unknown) {
        if (options.signal?.aborted) throw err;
        const resent = throttledFirst ? "answered HTTP 429, and its resend " : "";
        return { served: false, outcome: `${resent}got ${noResponse(err, timeout)}` };
      }
    };

    /**
     * How an answer reads in a details string: "HTTP 400, JSON-RPC error
     * -32600" over HTTP; "JSON-RPC error -32600" (or "no JSON-RPC error")
     * over stdio, where every status is a synthetic 200.
     */
    const answerShape = (res: { statusCode: number; body: unknown }): string => {
      if (resolvedTarget.type === "http") return `HTTP ${res.statusCode}${rpcErrorSuffix(res.body)}`;
      const suffix = rpcErrorSuffix(res.body);
      return suffix ? suffix.slice(2) : "no JSON-RPC error";
    };

    /**
     * The not-evaluable failure for a rejection of a negative probe sent
     * after the handshake (an initialize requesting an unknown version, an
     * unknown method) when the handshake -- the conformant request -- was
     * not served either and drew the same status, or no answer: a server
     * that rejects everything proves nothing by rejecting the defect too.
     * The 2026-07-28 suite's notEvaluable, read from the handshake the way
     * lifecycle-reinit-reject reads it. Null when the handshake was served
     * or drew a different status (over stdio only a served one counts).
     * `seen` opens the details; `defect` names what the probe varies.
     */
    const handshakeUnattributable = (seen: string, status: number, defect: string): LegacyOutcome | null => {
      if (handshakeServed()) return null;
      if (initRes && initRes.statusCode !== status) return null;
      const handshake = initRes ? `was not served either (${answerShape(initRes)})` : "got no response";
      return {
        passed: false,
        details: `${seen} -- not evaluable: the initialize handshake ${handshake}, so this rejection proves nothing about ${defect} (see lifecycle-init)`,
      };
    };

    /**
     * Send a request after the handshake, resending it once after
     * Retry-After (capped at 2 s, retryAfterMs) when a rate limiter
     * answered 429, as lifecycle-reinit-reject does; the second answer
     * decides. `throttled` is "HTTP 429, then after Nms " once it was
     * resent; `onThrottled` is told before the wait, so a caller whose
     * resend gets no answer can still say the first was a 429. A caller's
     * abort is rethrown.
     */
    const rpcResending429 = async (method: string, params?: unknown, onThrottled?: () => void) => {
      let res = await rpc(method, params);
      let throttled = "";
      if (res.statusCode === 429) {
        onThrottled?.();
        const wait = retryAfterMs(res.headers);
        await pause(wait, options.signal);
        throttled = `HTTP 429, then after ${wait}ms `;
        res = await rpc(method, params);
      }
      return { res, throttled };
    };

    /**
     * The verdict for a rejection of a negative probe sent after the
     * handshake -- an unknown method, a malformed message, invalid JSON, a
     * tools/call without a name, a method for an undeclared capability --
     * that is not the server's own answer to the probe's defect, or null
     * when it is. Called for a JSON-RPC error or a status >= 400. It is not
     * the server's answer:
     *
     * - when the handshake was not served either and drew the same status,
     *   or no answer (handshakeUnattributable);
     * - when something in front of the server answered in its place
     *   (gateRefusal): an auth gate (a 401, or a 403 carrying a Bearer
     *   challenge, whatever JSON-RPC error its body carries), a rate
     *   limiter's 429 (the caller has already resent the probe once), or a
     *   5xx whose body does not carry one of `ownCodes`, the JSON-RPC errors
     *   that are the server's own rejection of the defect;
     * - for any other 403, when `twin` -- the conformant request the probe
     *   differs from in nothing but the defect, with the same headers --
     *   drew the same 403 or no answer (bare403Verdict), quoting the message
     *   when it names Host/Origin validation.
     *
     * A 5xx carrying one of `ownCodes` is credited, and `check` is warned
     * about the status. `seen` opens the details; `defect` names what the
     * probe varies ("the unknown method").
     */
    const postInitRejection = async (
      check: string,
      seen: string,
      res: { statusCode: number; headers: Record<string, string>; body: unknown },
      defect: string,
      ownCodes: readonly number[],
      twinName: string,
      twin: () => Promise<TwinAnswer>,
    ): Promise<LegacyOutcome | null> => {
      const unattributable =
        handshakeUnattributable(seen, res.statusCode, defect) ??
        gateRefusal(seen, res, hasAuthHeader, defect, ownCodes) ??
        (await bare403Verdict(seen, res, hasAuthHeader, defect, twinName, twin));
      if (unattributable) return unattributable;
      const on5xx = res.statusCode >= 500 ? ownRejectionCode(res.body, ownCodes) : undefined;
      if (on5xx !== undefined) warnings.push(rejectionOn5xxWarning(check, res.statusCode, on5xx, defect));
      return null;
    };
    /** The twin postInitRejection asks for a probe sent through the transport: credentialedPing. */
    const PING_TWIN = "the same request for ping";

    // ── 3. LIFECYCLE TESTS ───────────────────────────────────────────

    await test(
      "lifecycle-init",
      "Initialize handshake",
      "lifecycle",
      true,
      "basic/lifecycle#initialization",
      async () => {
        if (!initRes) {
          return { passed: false, details: `Initialize request failed: ${oneLine(initError ?? "no response", 400)}` };
        }
        const result = initRes.body?.result;
        if (!result) {
          // A modern-only server answers initialize with a JSON-RPC error
          // that (per spec SHOULD) names the versions it does speak; that
          // message is the one diagnostic a pinned legacy run can show.
          const err = initRes.body?.error;
          if (err && typeof err === "object") {
            const code = typeof err.code === "number" ? err.code : "?";
            const message = typeof err.message === "string" ? err.message : "";
            return {
              passed: false,
              details: `Initialize answered with JSON-RPC error ${code}${message ? `: ${oneLine(message, 300)}` : ""}${initRes.statusCode !== 200 ? ` (HTTP ${initRes.statusCode})` : ""}`,
            };
          }
          return { passed: false, details: "No result in response" };
        }
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
      "lifecycle-version-negotiate",
      "Handles unknown protocol version",
      "lifecycle",
      false,
      "basic/lifecycle#version-negotiation",
      async () => {
        // Send initialize with a future version — server should respond with
        // its own supported version, or reject it. How the answer reads:
        //
        // - a version offered back is judged on its own;
        // - a rejection (a JSON-RPC error, or a status >= 400) is the
        //   server's only next to a handshake -- the same request with a
        //   version it knows, and the same headers -- that was served or
        //   drew a different status (handshakeUnattributable), so a 403 the
        //   handshake did not draw is the version's whatever its message
        //   names; and only when nothing in front of the server answered in
        //   its place (gateRefusal: an auth gate, a JSON-RPC error body on
        //   its 401/403 included, a 429 -- resent once after Retry-After
        //   first -- or a 5xx that does not carry the server's own -32600 or
        //   -32602); otherwise it fails as not evaluable. A -32600/-32602 on
        //   a 5xx is credited, with a warning about the status.
        //
        // No answer at all is read from the error the way
        // security-extra-params reads it (classifyTransportError), never as
        // a rejection by default:
        // - a caller's abort is rethrown, never graded;
        // - a timeout, a connection never established, or a stdio child
        //   already gone before the probe is "server unreachable";
        // - a stdio child that exits on the probe crashed on a request: it
        //   fails as died, and is restarted (restartStdioServer) so the tests
        //   after it measure the server. Over stdio this probe is always a
        //   second initialize on the live session, so the exit is not pinned
        //   on the version: the details say it died on a second initialize.
        //   (An HTTP drop leaves the server running, a stdio exit does not:
        //   the drop below is a refusal, the exit a crash.)
        // - an HTTP connection closed without a response is the (crude)
        //   rejection only next to the served handshake (unansweredProbe);
        // - anything else got no usable response, and fails.
        const what = "the initialize requesting protocol version 2099-01-01";
        const stdio = transport.kind === "stdio" ? (transport as StdioTransport) : null;
        // A child already gone was not killed by this probe.
        const alreadyGone = stdio?.exited === true;
        const send = () =>
          mcpRequest(
            backendUrl,
            "initialize",
            {
              protocolVersion: "2099-01-01",
              capabilities: {},
              clientInfo: { name: "mcp-compliance", version: TOOL_VERSION },
            },
            createIdCounter(99960),
            userHeaders,
            timeout,
          );
        let futureRes: Awaited<ReturnType<typeof send>>;
        /** "HTTP 429, then after Nms " once a throttled probe was resent. */
        let throttled = "";
        try {
          futureRes = await send();
          if (futureRes.statusCode === 429) {
            const wait = retryAfterMs(futureRes.headers);
            await pause(wait, options.signal);
            throttled = `HTTP 429, then after ${wait}ms `;
            futureRes = await send();
          }
        } catch (err: unknown) {
          if (options.signal?.aborted) throw err;
          const failure = classifyTransportError(err);
          // The stdio transport rejects every pending request with the
          // child's exit diagnostic the moment it goes away.
          if (stdio && (failure === "dropped" || stdio.exited)) {
            if (alreadyGone) return unreachable(what, err, timeout);
            const secondInit = "a second initialize (requesting protocol version 2099-01-01)";
            const died = {
              passed: false,
              details: `server died on ${secondInit} on the live session, so the exit is not pinned on the version: ${errorLine(err, 120)}`,
            };
            await restartStdioServer("lifecycle-version-negotiate", secondInit);
            return died;
          }
          if (failure === "dropped" || failure === "connect" || failure === "timeout") {
            // The comparison is the handshake: the same request with a known
            // version, served. A drop is pinned on the version only then.
            const verdict = unansweredProbe(what, err, handshakeServed(), timeout, options.signal);
            if (verdict) return verdict;
            return { passed: true, details: `${closedWithoutResponse(err)} (unknown version rejected)` };
          }
          // Neither an answer nor a transport failure the server can be
          // judged by: bytes that are not an HTTP response, a TLS failure.
          return { passed: false, details: `no usable response to ${what}: ${errorLine(err, 120)}` };
        }
        const result = futureRes.body?.result;
        const error = futureRes.body?.error;
        if (!error && result?.protocolVersion) {
          const offered = result.protocolVersion;
          if (offered === "2099-01-01") {
            return {
              passed: false,
              details:
                'Server accepted impossible future version "2099-01-01" — should offer a version it actually supports',
            };
          }
          return { passed: true, details: `Server negotiated down to ${offered} (correct)` };
        }
        const seen = `${throttled}${answerShape(futureRes)} on ${what}`;
        if (error || futureRes.statusCode >= 400) {
          const unattributable =
            handshakeUnattributable(seen, futureRes.statusCode, "the unknown version") ??
            gateRefusal(seen, futureRes, hasAuthHeader, "the unknown version", VERSION_REJECTION_CODES);
          if (unattributable) return unattributable;
          const on5xx =
            futureRes.statusCode >= 500 ? ownRejectionCode(futureRes.body, VERSION_REJECTION_CODES) : undefined;
          if (on5xx !== undefined) {
            warnings.push(
              rejectionOn5xxWarning("lifecycle-version-negotiate", futureRes.statusCode, on5xx, "the unknown version"),
            );
          }
        }
        if (error) {
          return {
            passed: true,
            details: `Server rejected unknown version with error: ${error.code} — ${error.message}`,
          };
        }
        return { passed: false, details: "No protocolVersion or error in response" };
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
      if (initRes && body?.result === undefined) {
        // An initialize answered without a result may not have been
        // answered by the server at all: an envelope that something in front
        // of it wrote (a gateway's -32001 "Unauthorized" on its 401) is no
        // evidence of the server's JSON-RPC, however valid. Read as the
        // negative probes read their answers: an auth gate or a rate
        // limiter (gateRefusal), a 5xx that does not carry a server's own
        // refusal of the initialize (a broken server, or a gateway with no
        // backend), or a 403 that the same ping sent on its own draws too
        // (bare403Verdict: a guard, Host/Origin validation among them,
        // refusing every request) is not evaluable. A server's own
        // -32600/-32601/-32602 on a 5xx is credited, with a warning about
        // the status.
        const seen = `${answerShape(initRes)} on the initialize handshake`;
        const what = "the initialize request";
        let gated: LegacyOutcome | null = null;
        if (initRes.statusCode >= 500) {
          const own = ownRejectionCode(body, INIT_REFUSAL_CODES);
          if (own === undefined) {
            gated = {
              passed: false,
              details: `${seen} -- not evaluable: a server error (or a gateway with no backend) answered, so the envelope need not be the server's`,
            };
          } else {
            warnings.push(rejectionOn5xxWarning("lifecycle-jsonrpc", initRes.statusCode, own, what));
          }
        } else {
          gated =
            gateRefusal(seen, initRes, hasAuthHeader, what) ??
            (await bare403Verdict(seen, initRes, hasAuthHeader, what, PRE_INIT_TWIN, preInitPing));
        }
        if (gated) return gated;
      }
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

    await test("lifecycle-string-id", "Supports string request IDs", "lifecycle", false, "basic", async () => {
      // JSON-RPC 2.0 allows both string and number IDs — send a string ID and verify echo
      const stringId = "compliance-test-string-id";
      const body = JSON.stringify({ jsonrpc: "2.0", id: stringId, method: "ping", params: {} });
      const res = await request(backendUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...buildHeaders(),
        },
        body,
        signal: AbortSignal.timeout(timeout),
      });
      const text = await res.body.text();
      const rawCtStr = res.headers["content-type"];
      const ct = (Array.isArray(rawCtStr) ? rawCtStr[0] : rawCtStr || "").toLowerCase();
      let parsed: any;
      if (ct.includes("text/event-stream")) {
        parsed = parseSSEResponse(text);
      }
      if (!parsed) {
        try {
          parsed = JSON.parse(text);
        } catch {}
      }
      if (!parsed) return { passed: false, details: "Could not parse response" };
      if (parsed.id === stringId) {
        return { passed: true, details: `String id="${stringId}" echoed back correctly` };
      }
      if (parsed.id === undefined) {
        return { passed: false, details: "No id in response" };
      }
      return {
        passed: false,
        details: `String id="${stringId}" sent, got back id=${JSON.stringify(parsed.id)} (type: ${typeof parsed.id})`,
      };
    });

    await test(
      "lifecycle-reinit-reject",
      "Rejects second initialize request",
      "lifecycle",
      false,
      "basic/lifecycle#initialization",
      async () => {
        // Spec: client MUST NOT send initialize more than once per session
        const reinitialize = () =>
          rpc("initialize", {
            protocolVersion: SPEC_VERSION,
            capabilities: {},
            clientInfo: { name: "mcp-compliance", version: TOOL_VERSION },
          });
        try {
          let res = await reinitialize();
          const seen = (prefix: string) =>
            `${prefix}HTTP ${res.statusCode}${rpcErrorSuffix(res.body)} on the second initialize`;
          // A duplicate is one only next to a served first initialize: when
          // the handshake was refused or failed, this request is just another
          // first one, and whatever refuses it (the auth gate, Host
          // validation, the dead backend that refused the first) says nothing
          // about how the server treats a duplicate. The catch below applies
          // the same gate to a dropped connection.
          if (!handshakeServed()) {
            return {
              passed: false,
              details: `${seen("")} -- not evaluable: the first initialize was not served, so this one is no duplicate (see lifecycle-init)`,
            };
          }
          /** "HTTP 429, then after Nms " once a throttled duplicate was resent. */
          let throttled = "";
          if (res.statusCode === 429) {
            // A rate limiter answers before the server reads the request:
            // wait what it asks (capped at 2 s, retryAfterMs) and send the
            // duplicate once more; the second answer decides.
            const wait = retryAfterMs(res.headers);
            await pause(wait, options.signal);
            throttled = `HTTP 429, then after ${wait}ms `;
            res = await reinitialize();
          }
          // The handshake was served, so an answer that is not the server's
          // own verdict on the duplicate came from something in front of it,
          // read the way the other negative probes read their answers
          // (gateRefusal): an auth gate (a credential that expired mid-run)
          // or a rate limiter is not evaluable, and a 5xx is the server
          // failing on the request (or a gateway with no backend), no
          // rejection -- unless it carries the server's own -32600 Invalid
          // Request (REINIT_REJECTION_CODES), which is credited with a
          // warning about the status. Any other 403 is decided by the
          // duplicate's twin, the handshake (bare403Verdict): it was served
          // with the same Host and Origin, so the 403 is the duplicate's,
          // whatever its message names -- the reading
          // lifecycle-version-negotiate gives the same 403 next to the same
          // handshake.
          const gated =
            gateRefusal(seen(throttled), res, hasAuthHeader, REINIT_DEFECT, REINIT_REJECTION_CODES) ??
            (await bare403Verdict(
              seen(throttled),
              res,
              hasAuthHeader,
              REINIT_DEFECT,
              "the initialize handshake",
              async () => twinAnswer(initRes),
            ));
          if (gated) return gated;
          const on5xx = res.statusCode >= 500 ? ownRejectionCode(res.body, REINIT_REJECTION_CODES) : undefined;
          if (on5xx !== undefined) {
            warnings.push(rejectionOn5xxWarning("lifecycle-reinit-reject", res.statusCode, on5xx, REINIT_DEFECT));
          }
          const error = res.body?.error;
          if (error) {
            return { passed: true, details: `Re-initialization rejected with error: ${error.code} — ${error.message}` };
          }
          if (res.statusCode >= 400) {
            return { passed: true, details: `HTTP ${res.statusCode} (re-initialization rejected)` };
          }
          if (res.statusCode >= 300) {
            return {
              passed: false,
              details: `${seen(throttled)} -- redirected instead of answered: neither a rejection nor a served duplicate`,
            };
          }
          return {
            passed: false,
            details: `Server accepted second initialize (HTTP ${res.statusCode}) — should reject duplicate initialization`,
          };
        } catch (err: unknown) {
          // The comparison is the handshake: the same request, served.
          // A connection dropped on the duplicate is then a (crude)
          // rejection of it; a timeout or a connection never established
          // measured nothing, and neither does a drop from a server whose
          // handshake was not served either.
          const verdict = unansweredProbe("the second initialize", err, handshakeServed(), timeout, options.signal);
          if (verdict) return verdict;
          return { passed: true, details: `${closedWithoutResponse(err)} (re-initialization rejected)` };
        }
      },
    );

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
        // Test with a valid level
        const res = await rpc("logging/setLevel", { level: "info" });
        if (res.body?.error) {
          return { passed: false, details: `Error: ${res.body.error.code} — ${res.body.error.message}` };
        }
        // Test with an invalid level to verify the server validates input
        const invalidRes = await rpc("logging/setLevel", { level: "__invalid_level__" });
        const validatesInput = !!invalidRes.body?.error;
        const validLevels = ["debug", "warning", "error"];
        const accepted: string[] = [];
        for (const level of validLevels) {
          const r = await rpc("logging/setLevel", { level });
          if (!r.body?.error) accepted.push(level);
        }
        const details = validatesInput
          ? `logging/setLevel accepted (validates levels, ${accepted.length + 1} levels accepted)`
          : "logging/setLevel accepted (warning: server does not reject invalid log levels)";
        if (!validatesInput) warnings.push("Server accepts invalid log levels without error");
        return { passed: true, details };
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
        if (!hasCompletions)
          return { passed: true, details: "Server does not declare completions capability (skipped)" };
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

    // Cancellation handling test
    await test(
      "lifecycle-cancellation",
      "Handles cancellation notifications",
      "lifecycle",
      false,
      "basic/utilities#cancellation",
      async () => {
        // Send a cancellation notification for a nonexistent request — server should accept it gracefully
        const res = await mcpNotification(
          backendUrl,
          "notifications/cancelled",
          { requestId: 99999, reason: "compliance test" },
          buildHeaders(),
          timeout,
        );
        // 202 is ideal, any 2xx is acceptable for a notification
        if (res.statusCode >= 200 && res.statusCode < 300) {
          return { passed: true, details: `HTTP ${res.statusCode} (cancellation accepted)` };
        }
        return { passed: false, details: `HTTP ${res.statusCode} — server should accept cancellation notifications` };
      },
    );

    // Progress notification test — validates server gracefully handles unexpected notifications.
    // Note: per spec, progress flows from server→client. This tests server resilience, not spec compliance.
    await test(
      "lifecycle-progress",
      "Handles progress notifications gracefully",
      "lifecycle",
      false,
      "basic/utilities#progress",
      async () => {
        const res = await mcpNotification(
          backendUrl,
          "notifications/progress",
          { progressToken: "compliance-test-token", progress: 50, total: 100 },
          buildHeaders(),
          timeout,
        );
        if (res.statusCode >= 200 && res.statusCode < 300) {
          return { passed: true, details: `HTTP ${res.statusCode} (notification handled gracefully)` };
        }
        return {
          passed: false,
          details: `HTTP ${res.statusCode} — server should accept unknown notifications without error`,
        };
      },
    );

    // listChanged notification tests — server should accept these gracefully
    await test(
      "lifecycle-list-changed",
      "Accepts listChanged notifications",
      "lifecycle",
      false,
      "basic/lifecycle#capability-negotiation",
      async () => {
        // Send notifications for tools/resources/prompts list changes
        // Servers should accept these without error (they are client→server notifications)
        const notifications = [
          { method: "notifications/tools/list_changed", gate: hasTools },
          { method: "notifications/resources/list_changed", gate: hasResources },
          { method: "notifications/prompts/list_changed", gate: hasPrompts },
        ];
        const applicable = notifications.filter((n) => n.gate);
        if (applicable.length === 0) {
          return { passed: true, details: "No capabilities declared — listChanged notifications not applicable" };
        }
        const issues: string[] = [];
        for (const { method } of applicable) {
          try {
            const res = await mcpNotification(backendUrl, method, undefined, buildHeaders(), timeout);
            if (res.statusCode < 200 || res.statusCode >= 300) {
              issues.push(`${method}: HTTP ${res.statusCode}`);
            }
          } catch (err: unknown) {
            issues.push(`${method}: ${err instanceof Error ? err.message : "error"}`);
          }
        }
        if (issues.length > 0) return { passed: false, details: issues.join("; ") };
        return {
          passed: true,
          details: `${applicable.length} listChanged notification(s) accepted: ${applicable.map((n) => n.method).join(", ")}`,
        };
      },
    );

    // Client capability awareness: we declare sampling/roots/elicitation
    // in our initialize (below) and verify the server accepts it. Full
    // bidirectional flow testing (server actually calling sampling/
    // createMessage, roots/list, elicitation/create against us) requires
    // client-side handlers and is out of scope for a one-shot compliance
    // suite. These tests document coverage and check the minimum: server
    // doesn't break when we advertise these capabilities.
    await test(
      "lifecycle-sampling-capability",
      "Sampling capability shape",
      "lifecycle",
      false,
      "client/sampling",
      async () => {
        if (!initRes || initRes.body?.error) {
          return { passed: false, details: "Server rejected initialize" };
        }
        return {
          passed: true,
          details:
            "Server accepted initialize with client sampling capability. Full server→client sampling flow not exercised.",
        };
      },
    );

    await test("lifecycle-roots-capability", "Roots capability shape", "lifecycle", false, "client/roots", async () => {
      if (!initRes || initRes.body?.error) {
        return { passed: false, details: "Server rejected initialize" };
      }
      return {
        passed: true,
        details:
          "Server accepted initialize. Full server→client roots/list flow not exercised (requires a roots-aware client).",
      };
    });

    await test(
      "lifecycle-elicitation-capability",
      "Elicitation capability shape",
      "lifecycle",
      false,
      "client/elicitation",
      async () => {
        if (!initRes || initRes.body?.error) {
          return { passed: false, details: "Server rejected initialize" };
        }
        return {
          passed: true,
          details: "Server accepted initialize. Full server→client elicitation/create flow not exercised.",
        };
      },
    );

    // _meta tolerance: send a ping with a benign _meta and verify the
    // server doesn't choke on unknown _meta keys. Spec (2025-11-25)
    // reserves _meta for protocol metadata + extension; servers must
    // pass it through validation gracefully.
    await test(
      "lifecycle-meta-tolerance",
      "Tolerates _meta field on requests",
      "lifecycle",
      false,
      "basic/utilities#_meta",
      async () => {
        try {
          const res = await rpc("ping", { _meta: { "mcp-compliance/probe": "1" } });
          const body = res.body as { error?: { code?: number }; result?: unknown };
          if (body.error) {
            return {
              passed: false,
              details: `Server rejected _meta on ping (code ${body.error.code}). _meta should be ignored, not error.`,
            };
          }
          return { passed: true, details: "Server accepted ping with arbitrary _meta field" };
        } catch (err: unknown) {
          return { passed: false, details: `Error: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    );

    // ── 4. TRANSPORT (session-dependent, post-init) ──────────────────

    await test(
      "transport-content-type-init",
      "Initialize response has valid content type",
      "transport",
      false,
      "basic/transports#streamable-http",
      async () => {
        if (!initRes) return { passed: false, details: "No init response to check" };
        const ct = (initRes.headers["content-type"] || "").toLowerCase();
        const valid = ct.includes("application/json") || ct.includes("text/event-stream");
        return { passed: valid, details: `Content-Type: ${ct || "missing"}` };
      },
    );

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
        // Spec says MUST return 202; other 2xx codes violate this requirement
        if (res.statusCode >= 200 && res.statusCode < 300) {
          warnings.push(`Notification returned HTTP ${res.statusCode} instead of spec-required 202 Accepted`);
          return {
            passed: false,
            details: `HTTP ${res.statusCode} — spec requires 202 Accepted for notifications (MUST)`,
          };
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

    await test(
      "transport-session-invalid",
      "Returns 404 for unknown session ID",
      "transport",
      false,
      "basic/transports#streamable-http",
      async () => {
        if (!sessionId) {
          return { passed: true, details: "Server did not issue session ID (test not applicable)" };
        }
        // Send a request with a fabricated/unknown session ID
        const fakeHeaders: Record<string, string> = {
          ...userHeaders,
          "mcp-session-id": "invalid-nonexistent-session-id",
        };
        if (negotiatedProtocolVersion) fakeHeaders["mcp-protocol-version"] = negotiatedProtocolVersion;
        const res = await mcpRequest(backendUrl, "ping", undefined, createIdCounter(99915), fakeHeaders, timeout);
        if (res.statusCode === 404) {
          return { passed: true, details: "HTTP 404 for unknown session ID (correct per spec)" };
        }
        if (res.statusCode === 400) {
          return {
            passed: false,
            details: "HTTP 400 — spec requires 404 (Not Found) for unrecognized session IDs, not 400",
          };
        }
        return { passed: false, details: `HTTP ${res.statusCode} — spec requires 404 for unrecognized MCP-Session-Id` };
      },
    );

    await test(
      "transport-get-stream",
      "GET with session returns SSE or 405",
      "transport",
      false,
      "basic/transports#streamable-http",
      async () => {
        // This test requires an active session to be meaningful
        if (!sessionId) {
          return { passed: true, details: "No session ID — server-initiated messages not applicable" };
        }
        const res = await request(backendUrl, {
          method: "GET",
          headers: { Accept: "text/event-stream", ...buildHeaders() },
          signal: AbortSignal.timeout(Math.min(timeout, 3000)),
        });
        const body = await res.body.text();
        const rawCt2 = res.headers["content-type"];
        const ct = (Array.isArray(rawCt2) ? rawCt2[0] : rawCt2 || "").toLowerCase();
        if (res.statusCode === 405) {
          return { passed: true, details: "HTTP 405 (server does not support server-initiated messages)" };
        }
        if (ct.includes("text/event-stream")) {
          // Validate SSE format if body is non-empty
          if (body.trim().length > 0) {
            const hasSSEFields = body.includes("data:") || body.includes("event:");
            if (!hasSSEFields) {
              return { passed: false, details: "Content-Type is text/event-stream but body has no SSE fields" };
            }
          }
          return { passed: true, details: "GET with session returns SSE stream for server-initiated messages" };
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          return { passed: true, details: `HTTP ${res.statusCode} (accepted)` };
        }
        return { passed: false, details: `HTTP ${res.statusCode}, Content-Type: ${ct}` };
      },
    );

    await test(
      "transport-concurrent",
      "Handles concurrent requests",
      "transport",
      false,
      "basic/transports#streamable-http",
      async () => {
        // Send 3 ping requests in parallel with distinct IDs
        const ids = [createIdCounter(99930)(), createIdCounter(99931)(), createIdCounter(99932)()];
        const promises = ids.map((id) =>
          request(backendUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              ...buildHeaders(),
            },
            body: JSON.stringify({ jsonrpc: "2.0", id, method: "ping" }),
            signal: AbortSignal.timeout(timeout),
          }).then(async (res) => {
            const text = await res.body.text();
            const rawCtConcurrent = res.headers["content-type"];
            const ct = (Array.isArray(rawCtConcurrent) ? rawCtConcurrent[0] : rawCtConcurrent || "").toLowerCase();
            let body: any;
            if (ct.includes("text/event-stream")) {
              body = parseSSEResponse(text);
            }
            if (!body) {
              try {
                body = JSON.parse(text);
              } catch {}
            }
            return { statusCode: res.statusCode, body, requestId: id };
          }),
        );
        const results = await Promise.all(promises);
        const issues: string[] = [];
        for (const r of results) {
          if (r.statusCode < 200 || r.statusCode >= 300) {
            issues.push(`Request id=${r.requestId}: HTTP ${r.statusCode}`);
          } else if (r.body?.id !== r.requestId) {
            issues.push(`Request id=${r.requestId}: response id=${r.body?.id} (mismatch)`);
          }
        }
        if (issues.length > 0) return { passed: false, details: issues.join("; ") };
        return { passed: true, details: `${results.length} concurrent requests handled correctly` };
      },
    );

    // SSE event field validation — spec requires event: message for JSON-RPC messages in SSE
    await test(
      "transport-sse-event-field",
      "SSE responses include event: message",
      "transport",
      false,
      "basic/transports#streamable-http",
      async () => {
        // Send a request and check if SSE responses include the event: message field
        const res = await request(backendUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            ...buildHeaders(),
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: createIdCounter(99940)(), method: "ping" }),
          signal: AbortSignal.timeout(timeout),
        });
        const text = await res.body.text();
        const rawCtSse = res.headers["content-type"];
        const ct = (Array.isArray(rawCtSse) ? rawCtSse[0] : rawCtSse || "").toLowerCase();
        if (!ct.includes("text/event-stream")) {
          // Server responded with JSON, not SSE — test is not applicable
          return { passed: true, details: "Server responded with JSON (not SSE) — event field check not applicable" };
        }
        // Check that the SSE response includes event: message
        const hasEventMessage = /^event:\s*message\s*$/m.test(text);
        if (hasEventMessage) {
          return { passed: true, details: "SSE response includes required event: message field" };
        }
        if (text.includes("data:")) {
          return {
            passed: false,
            details:
              "SSE response has data: fields but missing required event: message field (spec: MUST include event: message)",
          };
        }
        return { passed: true, details: "SSE response empty or no data fields — check not applicable" };
      },
    );

    // ── 5. TOOLS ─────────────────────────────────────────────────────

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

    // Schema tests for tools (depend on tools-list succeeding)
    const toolsListOk = cachedToolsList !== null;
    await test(
      "tools-schema",
      "All tools have name and inputSchema",
      "schema",
      hasTools,
      "server/tools#data-types",
      async () => {
        if (!toolsListOk) return { passed: false, details: "Skipped: tools/list failed" };
        const tools = cachedToolsList ?? [];
        // An empty list leaves nothing to validate (it read "All tools have
        // valid schemas"): a skip, worded as its siblings and the 2026-07-28
        // twin word it.
        if (tools.length === 0) return { passed: true, details: "No tools to validate", skipped: true };
        const issues: string[] = [];
        for (const tool of tools) {
          if (!tool.name) {
            issues.push("Tool missing name");
            continue;
          }
          if (tool.name.length > 128 || !/^[A-Za-z0-9_.-]+$/.test(tool.name)) {
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
        if (!toolsListOk) return { passed: false, details: "Skipped: tools/list failed" };
        const tools = cachedToolsList ?? [];
        if (tools.length === 0) return { passed: true, details: "No tools to validate", skipped: true };
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

    await test(
      "tools-title-field",
      "Tools include title field",
      "schema",
      false,
      "server/tools#data-types",
      async () => {
        if (!toolsListOk) return { passed: false, details: "Skipped: tools/list failed" };
        const tools = cachedToolsList ?? [];
        if (tools.length === 0) return { passed: true, details: "No tools to validate", skipped: true };
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
      },
    );

    await test(
      "tools-output-schema",
      "Tools with outputSchema are valid",
      "schema",
      false,
      "server/tools#structured-content",
      async () => {
        if (!toolsListOk) return { passed: false, details: "Skipped: tools/list failed" };
        const tools = cachedToolsList ?? [];
        if (tools.length === 0) return { passed: true, details: "No tools to validate", skipped: true };
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
            if (result.isError) {
              return { passed: true, details: "Tool returned execution error with content (valid)" };
            }
            const badItems = result.content.filter((c: any) => !c.type);
            if (badItems.length > 0)
              return { passed: false, details: `${badItems.length} content item(s) missing 'type' field` };
            return { passed: true, details: `Returned ${result.content.length} content item(s)` };
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
          // Only an empty content array leaves nothing to judge: a skip. A
          // content field that is not an array, or an answer with no result,
          // was answered and is malformed (tools-call fails it): not a skip,
          // and its verdict is left as it was (a plain pass here).
          if (Array.isArray(content) && content.length === 0) {
            return { passed: true, details: "No content items to validate", skipped: true };
          }
          if (!Array.isArray(content)) {
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

    // Progress token test — send request with _meta.progressToken and check
    // for progress events. Lives after the tools section on purpose: it
    // needs `toolNames`, which tools-list fills. It used to sit among the
    // lifecycle tests and always saw an empty list, so it never ran.
    await test(
      "lifecycle-progress-token",
      "Supports progress tokens in requests",
      "lifecycle",
      false,
      "basic/utilities#progress",
      async () => {
        if (!hasTools || toolNames.length === 0) {
          return { passed: true, details: "No tools available for progress token test (skipped)" };
        }
        // A tools/call with _meta.progressToken, sent raw so every message
        // on its SSE response is read. The tool is picked as the 2026-07-28
        // check picks it (pickProgressTool): one without required
        // arguments, preferring one that advertises progress. Progress is
        // optional (basic/utilities#progress: a receiver MAY send no
        // notifications), but what the server does send is judged the way
        // the 2026-07-28 check judges it (evaluateProgress): every
        // notifications/progress on the response MUST carry the request's
        // token and a progress number that increases with each one; a
        // foreign token, a missing params object, a non-number or a value
        // that does not increase fails.
        //
        // With no notification, the call's own answer is read. Served, or a
        // 2xx with no JSON-RPC response on it (a stream the server may close
        // early), it passes as before. A server error -- a JSON-RPC error,
        // or an HTTP status >= 400 other than a rate limiter's 429 or an
        // auth gate's 401 / Bearer 403 -- is blamed on the token only once
        // it is reproduced: the same call without the progress token, sent
        // right after with the same headers, is served, and the call
        // carrying the token, resent after that, fails the same way again.
        // A tool whose first call fails whatever it carries (a cold
        // backend) is served by then, and its answer is read instead.
        // Otherwise it stays an observation, not a skip.
        const name = pickProgressTool(cachedToolsList ?? []) ?? toolNames[0];
        const progressToken = "compliance-progress-test";
        const call = `tools/call ${clipAscii(name, 60)}`;
        /** The tools/call carrying the token, sent raw so every message on its SSE response is read. */
        const sendWithToken = async (): Promise<{
          status: number;
          headers: Record<string, string>;
          notifications: unknown[];
          response: Record<string, unknown> | undefined;
        }> => {
          // Both media types: a Streamable HTTP server MUST see both in
          // Accept on a POST (basic/transports#sending-messages-to-the-server),
          // and the SDK answers "text/event-stream" alone with 406 without
          // ever calling the tool.
          const res = await request(backendUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              ...buildHeaders(),
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: nextId(),
              method: "tools/call",
              params: { name, arguments: {}, _meta: { progressToken } },
            }),
            signal: requestSignal(options.signal, timeout),
          });
          const text = await res.body.text();
          const rawCtProgress = res.headers["content-type"];
          const ct = (Array.isArray(rawCtProgress) ? rawCtProgress[0] : rawCtProgress || "").toLowerCase();
          let messages: unknown[];
          if (ct.includes("text/event-stream")) {
            messages = parseSSEMessages(text);
          } else {
            const body = parseRawBody(text, rawCtProgress);
            messages = body === undefined ? [] : [body];
          }
          return {
            status: res.statusCode,
            headers: flatHeaders(res.headers),
            notifications: messages.filter((m) => isRecord(m) && m.method === "notifications/progress"),
            response: messages.find(
              (m): m is Record<string, unknown> => isRecord(m) && ("result" in m || "error" in m),
            ),
          };
        };
        type TokenAnswer = Awaited<ReturnType<typeof sendWithToken>>;
        const failedWith = (a: TokenAnswer) => a.response?.error !== undefined && a.response?.error !== null;
        /** The progress an answer carries, judged; a failure outcome, a pass naming it, or null when there was none. */
        const judgeProgress = (a: TokenAnswer): LegacyOutcome | null => {
          const progress = evaluateProgress(progressToken, a.notifications);
          if (!progress.ok) {
            const answer = failedWith(a)
              ? `${call} answered HTTP ${a.status}${rpcErrorSuffix(a.response)}`
              : a.response?.result !== undefined
                ? `${call} succeeded`
                : `${call} answered HTTP ${a.status}`;
            return { passed: false, details: clipAscii(`${progress.problem} (${answer})`, 220) };
          }
          if (a.notifications.length === 0) return null;
          const values = progress.values.slice(0, 8).join(", ");
          const more = progress.values.length > 8 ? `, ... (${progress.values.length} total)` : "";
          return {
            passed: true,
            details: `${a.notifications.length} notifications/progress echoed token "${progressToken}" with increasing progress (${values}${more})`,
          };
        };
        /** A server error on the call: a JSON-RPC error or a status >= 400, other than a 429 or an auth gate's refusal. */
        const serverError = (a: TokenAnswer) => {
          const gate =
            a.status === 429 ||
            (readAuthRefusal({ statusCode: a.status, headers: a.headers }, hasAuthHeader)?.kind ?? "forbidden") !==
              "forbidden";
          return (failedWith(a) || a.status >= 400) && !gate;
        };
        let first: TokenAnswer;
        try {
          first = await sendWithToken();
        } catch (err: unknown) {
          if (options.signal?.aborted) throw err;
          // No answer at all: nothing about the token was observed. The
          // details said "handled", a claim about an answer that never came.
          return {
            passed: true,
            details: `tools/call with progressToken got ${noResponse(err, timeout)} (no progress events observed -- optional)`,
            skipped: true,
          };
        }
        const status = first.status;
        const judged = judgeProgress(first);
        if (judged) return judged;
        const is2xx = status >= 200 && status < 300;
        if (serverError(first)) {
          let twin: TwinAnswer;
          try {
            twin = twinAnswer(await rpc("tools/call", { name, arguments: {} }));
          } catch (err: unknown) {
            if (options.signal?.aborted) throw err;
            twin = { served: false, outcome: `got ${noResponse(err, timeout)}` };
          }
          if (twin.served) {
            // The call without the token was served; before the token is
            // blamed, the call carrying it is resent once. The twin went
            // second, so a failure that belongs to the tool's first call
            // rather than to the token is not reproduced.
            let again: TokenAnswer | null = null;
            try {
              again = await sendWithToken();
            } catch (err: unknown) {
              if (options.signal?.aborted) throw err;
            }
            const firstShape = `HTTP ${status}${rpcErrorSuffix(first.response)}`;
            if (again) {
              const judgedAgain = judgeProgress(again);
              if (judgedAgain) return judgedAgain;
              if (serverError(again)) {
                return {
                  passed: false,
                  details: `${firstShape} on ${call} carrying _meta.progressToken, and HTTP ${again.status}${rpcErrorSuffix(again.response)} when it was resent, while the same call without it, sent in between, was served -- the server failed the request because of its progress token (basic/utilities#progress lets a receiver ignore the token and send no notifications, not fail the request)`,
                };
              }
              if (again.status >= 200 && again.status < 300 && again.response?.result !== undefined) {
                return {
                  passed: true,
                  details: `Server accepted request with progressToken when it was resent: ${call} first answered ${firstShape}, then the same call without the token and the resent one were served (no progress events observed -- optional)`,
                };
              }
            }
          }
        }
        // Server may not support progress — that's acceptable, just note it
        if (is2xx) {
          return {
            passed: true,
            details: "Server accepted request with progressToken (no progress events observed — optional)",
          };
        }
        // The call was answered, but not served, and not because of the
        // token (the same call without it was not served either, the call
        // carrying it did not fail the same way when resent, or a gate
        // answered). Not a skip: the server answered, so the status is an
        // observation.
        return {
          passed: true,
          details: `HTTP ${status} — tools/call with progressToken was not served (no progress events observed — optional)`,
        };
      },
    );

    // ── 6. RESOURCES ─────────────────────────────────────────────────

    const resourcesCap = serverInfo.capabilities.resources;
    const hasSubscribe = !!(
      typeof resourcesCap === "object" &&
      resourcesCap !== null &&
      "subscribe" in resourcesCap &&
      (resourcesCap as Record<string, unknown>).subscribe
    );

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

      const resourcesListOk = cachedResourcesList !== null;
      await test(
        "resources-schema",
        "Resources have uri and name",
        "schema",
        true,
        "server/resources#data-types",
        async () => {
          if (!resourcesListOk) return { passed: false, details: "Skipped: resources/list failed" };
          const resources = cachedResourcesList ?? [];
          // An empty list leaves nothing to validate (it read "All resources valid").
          if (resources.length === 0) return { passed: true, details: "No resources to validate", skipped: true };
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
            const resources = cachedResourcesList ?? [];
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
            if (!t.uriTemplate) {
              issues.push("Template missing uriTemplate");
            } else if (typeof t.uriTemplate !== "string") {
              issues.push(`uriTemplate should be a string, got ${typeof t.uriTemplate}`);
            } else if (!t.uriTemplate.includes("{") || !t.uriTemplate.includes("}")) {
              warnings.push(`Template "${t.name || t.uriTemplate}" has no URI template parameters (e.g., {id})`);
            }
            if (!t.name) issues.push(`${t.uriTemplate || "?"}: missing name`);
            if (!t.description) warnings.push(`Template "${t.name || t.uriTemplate || "?"}" missing description`);
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
            const resources = cachedResourcesList ?? [];
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

      const promptsListOk = cachedPromptsList !== null;
      await test("prompts-schema", "Prompts have name field", "schema", true, "server/prompts#data-types", async () => {
        if (!promptsListOk) return { passed: false, details: "Skipped: prompts/list failed" };
        const prompts = cachedPromptsList ?? [];
        // An empty list leaves nothing to validate (it read "All prompts valid").
        if (prompts.length === 0) return { passed: true, details: "No prompts to validate", skipped: true };
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

    await test(
      "error-unknown-method",
      "Returns JSON-RPC error for unknown method",
      "errors",
      true,
      "basic",
      async () => {
        // A rejection is the server's answer to the unknown method only when
        // the handshake was served or drew a different status
        // (handshakeUnattributable), nothing in front of the server answered
        // in its place (gateRefusal: an auth gate, a JSON-RPC error body on
        // its 401/403 included, a 429 -- resent once after Retry-After first
        // -- or a 5xx that does not carry the server's own -32601), and a 403
        // is one that the same request for ping did not draw too
        // (bare403Verdict: a gateway that lets initialize through and refuses
        // every other method, or Host/Origin validation refusing every
        // request). A -32601 on a 5xx is credited, with a warning about the
        // status.
        const { res, throttled } = await rpcResending429("nonexistent/method");
        const error = res.body?.error;
        if (error || res.statusCode >= 400) {
          const unattributable = await postInitRejection(
            "error-unknown-method",
            `${throttled}${answerShape(res)} on nonexistent/method`,
            res,
            "the unknown method",
            METHOD_REJECTION_CODES,
            PING_TWIN,
            credentialedPing,
          );
          if (unattributable) return unattributable;
        }
        if (!error) return { passed: false, details: "No JSON-RPC error returned for unknown method" };
        const correctCode = error.code === -32601;
        return {
          passed: true,
          details: `Error code: ${error.code}${correctCode ? " (correct: Method not found)" : " (expected -32601)"} — ${error.message}`,
        };
      },
    );

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

    /**
     * POST a raw body after the handshake (error-invalid-jsonrpc,
     * error-invalid-json) with the headers every request of the session
     * carries, so the body is its one defect; a 429 is resent once
     * (sendRawProbe). Its conformant twin is a well-formed ping sent with the
     * same headers (credentialedPing).
     */
    const sendRawPostInit = (body: string) =>
      sendRawProbe(
        { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...buildHeaders() },
        body,
      );
    const RAW_TWIN = "a well-formed ping sent with the same headers";

    await test("error-invalid-jsonrpc", "Handles malformed JSON-RPC", "errors", true, "basic", async () => {
      // A JSON-RPC error or a 4xx is the server rejecting the malformed
      // message -- unless it is not the server's answer (postInitRejection):
      // the handshake was refused the same way, an auth gate, a repeated
      // 429 or a 5xx without the server's own -32600 answered in its place,
      // or a 403 the same headers draw on a well-formed ping too. A -32600
      // on a 5xx is credited, with a warning about the status.
      const res = await sendRawPostInit(JSON.stringify({ not: "a valid jsonrpc message" }));
      const body = res.body as { error?: { code?: unknown; message?: unknown } } | undefined;
      if (body?.error || res.statusCode >= 400) {
        const unattributable = await postInitRejection(
          "error-invalid-jsonrpc",
          `${res.throttled}HTTP ${res.statusCode}${rpcErrorSuffix(body)} on the malformed JSON-RPC message`,
          res,
          "the malformed JSON-RPC message",
          ENVELOPE_REJECTION_CODES,
          RAW_TWIN,
          credentialedPing,
        );
        if (unattributable) return unattributable;
      }
      if (body?.error) {
        const correctCode = body.error.code === -32600;
        return {
          passed: true,
          details: `Error code: ${body.error.code}${correctCode ? " (correct: Invalid Request)" : ""} — ${body.error.message}`,
        };
      }
      if (res.statusCode >= 400 && res.statusCode < 500)
        return { passed: true, details: `HTTP ${res.statusCode} (acceptable)` };
      return { passed: false, details: `HTTP ${res.statusCode} — expected JSON-RPC error or 4xx status` };
    });

    await test("error-invalid-json", "Handles invalid JSON body", "errors", false, "basic", async () => {
      // Read as error-invalid-jsonrpc reads its probe; the server's own
      // rejection of a body that is not JSON is -32700.
      const res = await sendRawPostInit("{this is not valid json!!!");
      const body = res.body as { error?: { code?: unknown; message?: unknown } } | undefined;
      if (body?.error || res.statusCode >= 400) {
        const unattributable = await postInitRejection(
          "error-invalid-json",
          `${res.throttled}HTTP ${res.statusCode}${rpcErrorSuffix(body)} on the invalid JSON body`,
          res,
          "the invalid JSON body",
          PARSE_REJECTION_CODES,
          RAW_TWIN,
          credentialedPing,
        );
        if (unattributable) return unattributable;
      }
      if (body?.error) return { passed: true, details: `Error code: ${body.error.code} — ${body.error.message}` };
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
        // A JSON-RPC error is the server rejecting the missing name --
        // unless it is not the server's answer (postInitRejection, as for
        // error-unknown-method); a -32602 on a 5xx is credited, with a
        // warning about the status. A tool result flagged isError is judged
        // as before.
        const { res, throttled } = await rpcResending429("tools/call", {});
        const error = res.body?.error;
        const isError = res.body?.result?.isError;
        if (error || res.statusCode >= 400) {
          const unattributable = await postInitRejection(
            "error-missing-params",
            `${throttled}${answerShape(res)} on tools/call without a name`,
            res,
            "the missing tool name",
            PARAMS_REJECTION_CODES,
            PING_TWIN,
            credentialedPing,
          );
          if (unattributable) return unattributable;
        }
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
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...buildHeaders(),
        },
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

    await test(
      "error-invalid-request-code",
      "Returns -32600 for invalid request",
      "errors",
      false,
      "basic",
      async () => {
        const res = await request(backendUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            ...buildHeaders(),
          },
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
      },
    );

    // Capability-gated method rejection — tests that undeclared methods return errors
    const undeclaredMethods: Array<{ method: string; capability: string; declared: boolean }> = [
      { method: "tools/list", capability: "tools", declared: hasTools },
      { method: "resources/list", capability: "resources", declared: hasResources },
      { method: "prompts/list", capability: "prompts", declared: hasPrompts },
    ];
    const undeclared = undeclaredMethods.filter((m) => !m.declared);
    await test(
      "error-capability-gated",
      "Rejects methods for undeclared capabilities",
      "errors",
      false,
      "basic/lifecycle#capability-negotiation",
      async () => {
        if (undeclared.length === 0) {
          // Nothing undeclared, so nothing to probe: a skip, not a verdict.
          return {
            passed: true,
            details: "Server declares all capabilities (tools, resources, prompts) — no undeclared methods to test",
            skipped: true,
          };
        }
        if (!handshakeServed()) {
          // Without a served handshake nothing counts as declared, so every
          // list method is probed -- but no answer can be judged against a
          // declaration the suite never saw: a server that rejects
          // everything (or a gate in front of it) rejects these too, and one
          // that serves them may well declare them. The answers are recorded;
          // only the verdict is withheld, as the 2026-07-28 twin withholds it.
          const answers: string[] = [];
          for (const { method } of undeclared) {
            const res = await rpc(method);
            const served = res.body?.result !== undefined && !res.body?.error;
            const shape = answerShape(res);
            answers.push(
              `${method} -> ${served ? (resolvedTarget.type === "http" ? `a result (HTTP ${res.statusCode})` : "a result") : shape}`,
            );
          }
          const handshake = initRes ? `was not served (${answerShape(initRes)})` : "got no response";
          return {
            passed: false,
            details: `${answers.join(", ")} -- not evaluable: the initialize handshake ${handshake}, so the suite never saw which capabilities the server declares, and these answers prove nothing about undeclared methods (see lifecycle-init)`,
          };
        }
        // A rejection counts only when it is the server's own
        // (postInitRejection, as for error-unknown-method): not an auth
        // gate, a repeated 429, a 5xx without the server's own -32601, or a
        // 403 the same request for ping draws too (asked once for the three
        // methods). A -32601 on a 5xx is credited, with a warning about the
        // status.
        const issues: string[] = [];
        const unattributable: string[] = [];
        let pingOnce: Promise<TwinAnswer> | null = null;
        const pingTwin = () => {
          pingOnce ??= credentialedPing();
          return pingOnce;
        };
        for (const { method, capability } of undeclared) {
          const { res, throttled } = await rpcResending429(method);
          const error = res.body?.error;
          if (!error && res.body?.result) {
            issues.push(`${method} returned success despite missing ${capability} capability`);
            continue;
          }
          if (error || res.statusCode >= 400) {
            const verdict = await postInitRejection(
              "error-capability-gated",
              `${throttled}${answerShape(res)} on ${method}`,
              res,
              `a method of the undeclared ${capability} capability`,
              METHOD_REJECTION_CODES,
              PING_TWIN,
              pingTwin,
            );
            if (verdict) unattributable.push(verdict.details);
          }
        }
        if (issues.length > 0) return { passed: false, details: issues.join("; ") };
        if (unattributable.length > 0) return { passed: false, details: unattributable.join("; ") };
        return {
          passed: true,
          details: `Tested ${undeclared.length} undeclared method(s): ${undeclared.map((m) => m.method).join(", ")} — all returned errors`,
        };
      },
    );

    // Invalid cursor test — send garbage cursor to a list method
    const listMethodForCursor = hasTools
      ? "tools/list"
      : hasResources
        ? "resources/list"
        : hasPrompts
          ? "prompts/list"
          : null;
    await test(
      "error-invalid-cursor",
      "Handles invalid pagination cursor gracefully",
      "errors",
      false,
      "basic",
      async () => {
        if (!listMethodForCursor) {
          return { passed: true, details: "No list methods available to test (skipped)" };
        }
        const res = await rpc(listMethodForCursor, { cursor: "!!!invalid-garbage-cursor-$$$" });
        const error = res.body?.error;
        if (error) {
          return { passed: true, details: `Invalid cursor rejected with error: ${error.code} — ${error.message}` };
        }
        // If server ignores the invalid cursor and returns first page, that's also acceptable
        const result = res.body?.result;
        if (result) {
          return { passed: true, details: "Server returned results (likely ignored invalid cursor)" };
        }
        return { passed: false, details: "No error or result for invalid cursor" };
      },
    );

    // ── 9. SECURITY TESTS ────────────────────────────────────────────

    // Auth & Transport security tests
    // These tests detect whether the server requires authentication.
    // If --auth was passed and the server accepted it, we test with auth stripped.
    //
    // HTTP header names are case-insensitive (RFC 9110 5.1) and so is the
    // transport's own merge, so `-H "AUTHORIZATION: Bearer x"` configures a
    // credential just as `--auth` does: reading only the two spellings
    // `Authorization` and `authorization` made every auth check behave as
    // if none had been passed (2026-07-28's context does the same lookup,
    // case-insensitively).
    const authorizationHeader = (): string => {
      const key = Object.keys(userHeaders).find((h) => h.toLowerCase() === "authorization");
      return key ? userHeaders[key] : "";
    };
    const hasAuth = authorizationHeader() !== "";

    /**
     * Whether a drop on a credential-less probe can be pinned on the
     * missing credential: --auth was given and the handshake, which carried
     * it, was served (`handshakeServed`).
     */
    const credentialedRequestServed = () => hasAuth && handshakeServed();

    /**
     * The legacy ping the auth tests probe with, sent without the
     * Authorization header. The transport re-injects configured user
     * headers via sessionHeaders(), so Authorization must be omitted
     * explicitly -- otherwise the "unauthenticated" probe still carries
     * auth and false-passes against an auth-requiring server.
     */
    const unauthenticatedPing = () => {
      const noAuthHeaders: Record<string, string> = {};
      if (sessionId) noAuthHeaders["mcp-session-id"] = sessionId;
      return mcpRequest(backendUrl, "ping", undefined, nextId, noAuthHeaders, timeout, ["authorization"]);
    };

    // With --auth, security-auth-required's unauthenticated ping and the
    // credentialed twin it compares a bare 403 with are shared: each
    // attempt of auth-required sends them afresh (`fresh`, so --retries
    // still re-asks) and keeps the answers, and authNotEvaluable below reads
    // the very answers auth-required graded -- or, when --only / --skip left
    // auth-required out of the run, sends them itself, once.
    let unauthenticatedPingOnce: ReturnType<typeof unauthenticatedPing> | null = null;
    const sharedUnauthenticatedPing = (fresh = false) => {
      if (fresh || !unauthenticatedPingOnce) unauthenticatedPingOnce = unauthenticatedPing();
      return unauthenticatedPingOnce;
    };
    let credentialedPingOnce: ReturnType<typeof credentialedPing> | null = null;
    const sharedCredentialedPing = (fresh = false) => {
      if (fresh || !credentialedPingOnce) credentialedPingOnce = credentialedPing();
      return credentialedPingOnce;
    };

    /**
     * Whether, with --auth, the unauthenticated ping drew a bare 403 that
     * security-auth-required cannot attribute to authentication: no Bearer
     * challenge, and the same ping carrying the credential was not served
     * either. The sibling auth probes (www-authenticate, auth-malformed,
     * session-not-auth, token-in-uri) send a request without a valid
     * credential and credit a 401/403: that 403 is the same refusal -- a
     * Host guard answers every request with it -- so they skip, pointing at
     * auth-required, instead of passing on it.
     *
     * Read from the shared probes rather than from a flag auth-required
     * sets, so it holds when --only / --skip filtered auth-required out (the
     * 2026-07-28 suite's authNotEvaluable reads its memoized probe the same
     * way). False when the ping got no HTTP answer at all: each sibling reads
     * a missing answer through unansweredProbe itself. A caller's abort is
     * rethrown.
     */
    let attribution: Promise<boolean> | null = null;
    const authNotEvaluable = (): Promise<boolean> => {
      attribution ??= (async () => {
        if (!hasAuth) return false;
        let res: Awaited<ReturnType<typeof unauthenticatedPing>>;
        try {
          res = await sharedUnauthenticatedPing();
        } catch (err: unknown) {
          if (options.signal?.aborted) throw err;
          return false;
        }
        if (readAuthRefusal(res, false)?.kind !== "forbidden") return false;
        return !(await sharedCredentialedPing()).served;
      })();
      return attribution;
    };
    /**
     * The skip itself says what was seen and why it proves nothing -- only a
     * 403 reads as "forbidden" -- so it stands on its own in a report that
     * was filtered (--only, --skip) to leave security-auth-required out; the
     * pointer is where the full reading (the quoted message, the advice) is.
     * Worded exactly as the 2026-07-28 suite's AUTH_NOT_EVALUABLE, so both
     * eras say the same thing about the same server.
     */
    const authNotEvaluableSkip: LegacyOutcome = {
      passed: true,
      details:
        "Skipped: HTTP 403 without a Bearer challenge, not attributable to authentication (see security-auth-required)",
    };

    /**
     * 401 when --auth was given and the same ping carrying the configured
     * credential drew 401 -- "Authorization required or token invalid"
     * (basic/authorization#error-handling): the server refused the very
     * credential the run was given. Next to that, the 401 an invalid token
     * or a token moved into the query string draws is what the configured
     * one drew too, so it cannot tell token validation from a server that
     * refuses every credential. Null otherwise: no --auth, a credentialed
     * ping that was served, one refused some other way (a 403 may be
     * insufficient scope on a token the server did validate), or one never
     * answered. The 2026-07-28 suite's credentialRefusedStatus reads its
     * credentialed setup server/discover the same way; here the comparison
     * is the credentialed twin ping, the very request the probes differ
     * from in the credential alone. Read from the shared twin, so it costs
     * at most one ping per run, and only when a probe passed.
     */
    const credentialRefusedStatus = async (): Promise<number | null> => {
      if (!hasAuth) return null;
      return (await sharedCredentialedPing()).statusCode === 401 ? 401 : null;
    };

    /**
     * The skip for a check whose only evidence is a refusal of a credential
     * when the configured credential was refused too (credentialRefusedStatus).
     * `what` names what the refusal would otherwise have shown. Worded as
     * the 2026-07-28 suite's credentialRefusedSkip, naming the ping.
     */
    const credentialRefusedSkip = (status: number, what: string): LegacyOutcome => ({
      passed: true,
      details: `Skipped: the configured credential was refused too (the credentialed ping drew HTTP ${status}), so ${what} (check the configured credential)`,
    });

    await test(
      "security-auth-required",
      "Rejects unauthenticated requests",
      "security",
      false,
      "basic/authorization",
      async () => {
        // How a 401/403 reads (readAuthRefusal): a 401, or a 403 carrying a
        // WWW-Authenticate: Bearer challenge, asks for the credential the
        // request lacked. A bare 403 does not: streamable-http requires one
        // for an invalid Origin, the SDK's Host validation answers a tunnel
        // or proxy hostname with one, gateways send them, and
        // basic/authorization requires 401 for a missing token anyway. It is
        // an auth rejection only next to the same request WITH the
        // credential being served.
        const bare403 = (what: string, message: string | undefined) =>
          `HTTP 403${message ? ` (${JSON.stringify(message)})` : ""} on the ${what} with no WWW-Authenticate: Bearer challenge`;
        // A message naming Host/Origin validation (the SDK's "Invalid Host:
        // ...") refuses the request whatever it carries, so --auth is no way
        // past it: the advice is the allowed hostname instead.
        const hostOriginAdvice =
          "allow the hostname you tested through in the server's allowed hosts/origins, or test an address it allows";
        if (!hasAuth) {
          // The preflight was itself an unauthenticated request; when it
          // drew an auth rejection the server does reject unauthenticated
          // requests, and saying it "accepted" them would contradict
          // transport-post's HTTP 401/403 failure on the same report. It
          // holds its headers, so a Bearer challenge is read from it.
          let probe: { statusCode?: number; headers?: Record<string, string>; body?: unknown } | null =
            preflightResponse;
          let what = "unauthenticated preflight";
          let rejected = "unauthenticated preflight rejected";
          if (!probe) {
            // The preflight got no HTTP answer (a timeout -- re-probed or
            // not -- or a failed connection): ask again now, after the
            // handshake, rather than read "accepted" from a missing answer.
            what = "unauthenticated ping";
            rejected = "unauthenticated request rejected";
            try {
              probe = await unauthenticatedPing();
            } catch (err: unknown) {
              if (options.signal?.aborted) throw err;
              // Nothing to compare a dropped connection with: no credential
              // was configured, so it is not pinned on the missing one.
              return unreachable(what, err, timeout);
            }
          }
          const refusal = readAuthRefusal(probe, false);
          const accepted = {
            passed: false,
            details: "Server does not require auth (no --auth provided and server accepted unauthenticated requests)",
          };
          // Whatever refused this probe, a handshake served with no
          // credential IS the server serving an unauthenticated request:
          // the run holds proof of acceptance, so no refusal of another
          // request makes the server one that requires authorization.
          if (handshakeServed()) {
            // A bare 403 (or no refusal at all) says nothing about
            // authentication on its own, so the plain wording stands. A
            // 401, or a 403 with a Bearer challenge, did ask for a
            // credential: name both halves rather than either alone.
            if (!refusal || refusal.kind === "forbidden") return accepted;
            return {
              passed: false,
              details: `Server does not require auth: initialize was served with no credential, although the ${what} got HTTP ${refusal.statusCode} (a server that requires authorization rejects every unauthenticated request, initialize included)`,
            };
          }
          if (refusal && refusal.kind !== "forbidden") {
            return {
              passed: true,
              details: `HTTP ${refusal.statusCode} (${rejected}; pass --auth to run the authenticated suite and the remaining auth tests)`,
            };
          }
          // Only a probe that was served (a JSON-RPC result on a 2xx) is
          // proof of acceptance on its own; any other answer is read below.
          const status = probe.statusCode ?? 200;
          const probeBody = probe.body as { result?: unknown; error?: unknown } | null | undefined;
          if (!refusal && status >= 200 && status < 300 && probeBody?.result !== undefined && !probeBody?.error) {
            return accepted;
          }
          // The handshake was the other unauthenticated request of this run.
          // A gateway can refuse server/discover (a method outside its
          // policy) with a bare 403, or let it through to a server that
          // answers it -32601, and answer every method it guards, without a
          // token, with the 401 authentication answers: that 401 decides.
          const initRefusal = initRes ? readAuthRefusal(initRes, false) : undefined;
          if (initRefusal && initRefusal.kind !== "forbidden") {
            return {
              passed: true,
              details: `HTTP ${initRefusal.statusCode} on initialize (unauthenticated request rejected; pass --auth to run the authenticated suite and the remaining auth tests)`,
            };
          }
          if (refusal) {
            if (namesHostOrOriginValidation(refusal.message)) {
              return {
                passed: false,
                details: `${bare403(what, refusal.message)} -- not evaluable: the message names Host/Origin validation, which refuses the request with or without a credential (--auth does not get past it); ${hostOriginAdvice}`,
              };
            }
            return {
              passed: false,
              details: `${bare403(what, refusal.message)} -- not evaluable: it may be Host/Origin validation or a gateway rather than authentication (a server that requires a token answers 401); re-run with --auth to compare the same request with and without the credential`,
            };
          }
          // Neither served nor refused as authentication, and nothing else in
          // the run was served either: say what the answer was (a 5xx, a
          // redirect to a login page, another 4xx) instead of "accepted".
          return unrefusedAnswer(
            { statusCode: status, body: probe.body },
            `the ${what}`,
            "server accepted unauthenticated request",
            "the spec answers a missing credential with 401",
          );
        }
        let res: Awaited<ReturnType<typeof mcpRequest>>;
        try {
          res = await sharedUnauthenticatedPing(true);
        } catch (err: unknown) {
          if (options.signal?.aborted) throw err;
          const unmeasured = unreachable("unauthenticated ping", err, timeout);
          // A timeout or a connection never established measured nothing. A
          // connection the server accepted and closed without answering is
          // how some gateways refuse a request that lacks a credential, but
          // it carries no reason: it counts only when the same ping with the
          // credential is served, so the credential is what drew the drop.
          // This check asks a twin ping live (its outcome goes into the
          // details); its siblings read the served handshake instead.
          if (classifyTransportError(err) !== "dropped") return unmeasured;
          const twin = await sharedCredentialedPing(true);
          if (!twin.served) {
            return {
              passed: false,
              details: `${unmeasured.details}; the same ping with the credential ${twin.outcome}`,
            };
          }
          return {
            passed: true,
            details: `${closedWithoutResponse(err)}; the same request with the credential was served (unauthenticated request rejected)`,
          };
        }
        const refusal = readAuthRefusal(res, false);
        if (refusal && refusal.kind !== "forbidden") {
          return { passed: true, details: `HTTP ${res.statusCode} (unauthenticated request rejected)` };
        }
        if (refusal) {
          const twin = await sharedCredentialedPing(true);
          if (twin.served) {
            return {
              passed: true,
              details:
                "HTTP 403 (unauthenticated request rejected; the same ping with the credential was served) -- basic/authorization expects 401 with a WWW-Authenticate challenge for a missing token",
            };
          }
          // The siblings read this same verdict through authNotEvaluable().
          const head = `${bare403("unauthenticated ping", refusal.message)}, and the same ping with the credential ${twin.outcome} -- not evaluable`;
          if (namesHostOrOriginValidation(refusal.message)) {
            return {
              passed: false,
              details: `${head}: the message names Host/Origin validation rather than authentication; ${hostOriginAdvice}`,
            };
          }
          // Refused the same way with the credential: the gate stands in
          // front of every request, and re-running with --auth compares
          // nothing until the credentialed request is served.
          const advice =
            twin.statusCode === 403
              ? "; allow the hostname you tested through or fix the gateway (--auth compares only when the request carrying the credential is served)"
              : "";
          return {
            passed: false,
            details: `${head}: the 403 may be Host/Origin validation or a gateway rather than authentication${advice}`,
          };
        }
        return unrefusedAnswer(
          res,
          "the unauthenticated ping",
          "server accepted unauthenticated request",
          "the spec answers a missing credential with 401",
        );
      },
    );

    await test(
      "security-www-authenticate",
      "401 responses include WWW-Authenticate header",
      "security",
      false,
      "basic/authorization",
      async () => {
        if (!hasAuth) {
          return { passed: true, details: "Skipped: no --auth provided" };
        }
        if (await authNotEvaluable()) return authNotEvaluableSkip;
        // Send request without auth and check for WWW-Authenticate header on 401.
        // Omit Authorization for this request (see security-auth-required).
        const noAuthHeaders: Record<string, string> = {};
        if (sessionId) noAuthHeaders["mcp-session-id"] = sessionId;
        try {
          const res = await mcpRequest(backendUrl, "ping", undefined, nextId, noAuthHeaders, timeout, [
            "authorization",
          ]);
          // Read the refusal the way security-auth-required reads it. A 401,
          // or a 403 carrying a Bearer challenge, asks for the credential the
          // request lacked, and the challenge is what a client starts
          // authorization from either way (basic/authorization: the
          // insufficient-scope 403 carries resource_metadata "for
          // consistency with 401 responses"), so both are checked -- the
          // details name the status when it is not the 401 the spec expects.
          const refusal = readAuthRefusal(res, false);
          if (refusal && refusal.kind !== "forbidden") {
            const wwwAuth = Object.entries(res.headers).find(([k]) => k.toLowerCase() === "www-authenticate")?.[1];
            if (wwwAuth) {
              const where = res.statusCode === 401 ? "" : ` (HTTP ${res.statusCode})`;
              return { passed: true, details: `WWW-Authenticate: ${wwwAuth}${where}` };
            }
            // Only a 401 reaches this: a 403 reads as asking for a credential
            // precisely when it carries a Bearer challenge.
            return {
              passed: false,
              details:
                "HTTP 401 but missing WWW-Authenticate header (spec: SHOULD include to indicate required auth scheme)",
            };
          }
          if (res.statusCode === 403) {
            return { passed: true, details: "HTTP 403 (WWW-Authenticate not applicable for 403)" };
          }
          // No 401, so no challenge to check: a skip, as the 2026-07-28
          // twin's "HTTP N -- not a 401 response (skipped)" is.
          return { passed: true, details: `HTTP ${res.statusCode} — not a 401 response`, skipped: true };
        } catch (err: unknown) {
          // A drop is a refusal only next to the served handshake, which
          // carried the credential this ping omits. Either way there is no
          // 401 and no challenge to read: the refusal is the "not a 401"
          // pass (a skip: nothing was checked), the rest is a server that
          // answered nothing.
          const verdict = unansweredProbe(
            "unauthenticated ping",
            err,
            credentialedRequestServed(),
            timeout,
            options.signal,
          );
          if (verdict) return verdict;
          return {
            passed: true,
            details: `${closedWithoutResponse(err)} — not a 401 response, no challenge to check`,
            skipped: true,
          };
        }
      },
    );

    await test(
      "security-auth-malformed",
      "Rejects malformed auth credentials",
      "security",
      false,
      "basic/authorization",
      async () => {
        if (!hasAuth) {
          return { passed: true, details: "Skipped: no --auth provided" };
        }
        if (await authNotEvaluable()) return authNotEvaluableSkip;
        const malformedHeaders: Record<string, string> = {
          Authorization: "Bearer INVALID_GARBAGE_TOKEN_!@#$%^&*()",
        };
        if (sessionId) malformedHeaders["mcp-session-id"] = sessionId;
        const probe = async (): Promise<LegacyOutcome> => {
          try {
            // Omit the configured (valid) Authorization first, then let the
            // malformed value in malformedHeaders take its place — without the
            // omit, the valid user header would survive the case-insensitive
            // merge and the server would accept the request.
            const res = await mcpRequest(backendUrl, "ping", undefined, nextId, malformedHeaders, timeout, [
              "authorization",
            ]);
            if (res.statusCode === 401 || res.statusCode === 403) {
              return { passed: true, details: `HTTP ${res.statusCode} (malformed auth rejected)` };
            }
            return unrefusedAnswer(
              res,
              "the ping carrying a malformed credential",
              "server accepted malformed auth token",
              "the spec answers an invalid token with 401",
            );
          } catch (err: unknown) {
            // The probe differs from the served handshake only in the
            // credential it carries, so a drop is pinned on that; a timeout
            // or a failed connection measured nothing.
            const verdict = unansweredProbe(
              "the ping carrying a malformed credential",
              err,
              credentialedRequestServed(),
              timeout,
              options.signal,
            );
            if (verdict) return verdict;
            return { passed: true, details: `${closedWithoutResponse(err)} (malformed auth rejected)` };
          }
        };
        const outcome = await probe();
        // Nor when the server refused the configured credential too: then
        // the refusal the malformed one drew is what every credential draws,
        // the "rejects everything" the comparison exists to rule out. Only a
        // pass turns into the skip -- a malformed credential the server
        // ACCEPTED, or a 5xx on one, is a finding whatever the valid one drew.
        if (outcome.passed) {
          const refused = await credentialRefusedStatus();
          if (refused !== null) {
            return credentialRefusedSkip(refused, "rejecting invalid tokens cannot be told from rejecting everything");
          }
        }
        return outcome;
      },
    );

    await test("security-tls-required", "Enforces HTTPS/TLS", "security", false, "basic/authorization", async () => {
      const parsedUrl = new URL(backendUrl);
      if (parsedUrl.protocol !== "https:") {
        return {
          passed: false,
          details: `Server URL uses ${parsedUrl.protocol} — production servers should use HTTPS`,
        };
      }
      // Try HTTP variant
      const httpUrl = backendUrl.replace(/^https:/, "http:");
      try {
        const res = await request(httpUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 99950, method: "ping" }),
          signal: AbortSignal.timeout(Math.min(timeout, 5000)),
        });
        await res.body.text();
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 308) {
          return { passed: true, details: `HTTP ${res.statusCode} redirect to HTTPS (good)` };
        }
        if (res.statusCode >= 400) {
          return { passed: true, details: `HTTP ${res.statusCode} (plaintext rejected)` };
        }
        return { passed: false, details: `HTTP ${res.statusCode} — server accepts plaintext HTTP connections` };
      } catch {
        return { passed: true, details: "HTTP connection refused (HTTPS enforced)" };
      }
    });

    await test(
      "security-session-entropy",
      "Session IDs are high-entropy",
      "security",
      false,
      "basic/transports#streamable-http",
      async () => {
        if (!sessionId) {
          return { passed: true, details: "Server does not issue session IDs (skipped)" };
        }
        // Check length (should be at least 16 chars for reasonable entropy)
        if (sessionId.length < 16) {
          return {
            passed: false,
            details: `Session ID too short (${sessionId.length} chars): "${sessionId}" — should be ≥16 chars`,
          };
        }
        // Check for sequential/numeric patterns
        if (/^\d+$/.test(sessionId)) {
          return {
            passed: false,
            details: `Session ID is purely numeric: "${sessionId}" — likely sequential, not random`,
          };
        }
        // Check character diversity (at least 8 unique chars)
        const uniqueChars = new Set(sessionId.toLowerCase()).size;
        if (uniqueChars < 8) {
          return {
            passed: false,
            details: `Session ID has low character diversity (${uniqueChars} unique chars): "${sessionId}"`,
          };
        }
        return {
          passed: true,
          details: `Session ID has good entropy (${sessionId.length} chars, ${uniqueChars} unique): "${sessionId.substring(0, 16)}..."`,
        };
      },
    );

    await test(
      "security-session-not-auth",
      "Session ID does not bypass auth",
      "security",
      false,
      "basic/transports#streamable-http",
      async () => {
        if (!hasAuth) {
          return { passed: true, details: "Skipped: no --auth provided" };
        }
        if (await authNotEvaluable()) return authNotEvaluableSkip;
        if (!sessionId) {
          return { passed: true, details: "Skipped: server does not issue session IDs" };
        }
        // Send request with session ID but NO auth. Omit Authorization so
        // the session-id is the ONLY credential present — otherwise the
        // re-injected user auth would make this probe meaningless.
        const sessionOnlyHeaders: Record<string, string> = {
          "mcp-session-id": sessionId,
        };
        try {
          const res = await mcpRequest(backendUrl, "ping", undefined, nextId, sessionOnlyHeaders, timeout, [
            "authorization",
          ]);
          if (res.statusCode === 401 || res.statusCode === 403) {
            return { passed: true, details: `HTTP ${res.statusCode} (session ID alone not sufficient for auth)` };
          }
          return unrefusedAnswer(
            res,
            "the ping carrying only the session ID",
            "server accepted session ID without auth (spec: MUST NOT use sessions for authentication)",
            "the spec answers a request without a credential with 401, whatever session it names",
          );
        } catch (err: unknown) {
          // The session-only probe differs from the served handshake in
          // nothing but the missing credential, so a drop is pinned on it.
          const verdict = unansweredProbe(
            "the ping carrying only the session ID",
            err,
            credentialedRequestServed(),
            timeout,
            options.signal,
          );
          if (verdict) return verdict;
          return { passed: true, details: `${closedWithoutResponse(err)} (session ID alone not sufficient for auth)` };
        }
      },
    );

    await test(
      "security-oauth-metadata",
      "Protected Resource Metadata endpoint exists",
      "security",
      false,
      "basic/authorization",
      async () => {
        if (!hasAuth) {
          return { passed: true, details: "Skipped: no --auth provided" };
        }
        // Per MCP 2025-11-25 the server publishes Protected Resource
        // Metadata (RFC 9728), and clients find it the way the 2026-07-28
        // check looks for it (protectedResourceMetadataVerdict): the
        // resource_metadata URL of the WWW-Authenticate challenge when
        // there is one, else the endpoint-path well-known location, then
        // the root, then the legacy authorization-server document.
        //
        // The challenge is read from the unauthenticated ping
        // security-auth-required sends (shared with it, so a run that has
        // both sends it once), the way security-auth-required reads it:
        //
        // - a 401, or a 403 carrying a Bearer challenge, is an
        //   authentication refusal, and its challenge is the URL clients
        //   MUST use;
        // - a bare 403 is not one on its own (Host/Origin validation and
        //   gateways answer with it). With --auth the run tests a protected
        //   resource whatever that 403 was, so the well-known locations are
        //   still checked; when security-auth-required could not attribute
        //   it to authentication (authNotEvaluable), its status is handed to
        //   the lookup as the guard's, and a lookup that met only that
        //   status everywhere skips instead of advising a document the
        //   guard would never let through;
        // - any other answer carries no challenge to read.
        //
        // A ping that got no answer is read by unansweredProbe: a caller's
        // abort is rethrown, a timeout or a connection never established is
        // "server unreachable", and a connection dropped next to the served
        // credentialed handshake is the missing credential's refusal, which
        // leaves no challenge -- the well-known locations are what a client
        // has then.
        let challenge: string | undefined;
        let guardStatus: number | undefined;
        try {
          const res = await sharedUnauthenticatedPing();
          const refusal = readAuthRefusal(res, false);
          if (refusal && refusal.kind !== "forbidden") {
            challenge = Object.entries(res.headers).find(([k]) => k.toLowerCase() === "www-authenticate")?.[1];
          } else if (refusal && (await authNotEvaluable())) {
            guardStatus = refusal.statusCode;
          }
        } catch (err: unknown) {
          const verdict = unansweredProbe(
            "the unauthenticated ping",
            err,
            credentialedRequestServed(),
            timeout,
            options.signal,
          );
          if (verdict) return verdict;
        }
        return protectedResourceMetadataVerdict(backendUrl, timeout, options.signal, warnings, challenge, guardStatus);
      },
    );

    await test(
      "security-token-in-uri",
      "Rejects auth tokens in query string",
      "security",
      false,
      "basic/authorization",
      async () => {
        if (!hasAuth) {
          return { passed: true, details: "Skipped: no --auth provided" };
        }
        const token = authorizationHeader().replace(/^Bearer\s+/i, "");
        if (!token) {
          return { passed: true, details: "Skipped: could not extract token from auth header" };
        }
        // The probe is sent whatever the refusals so far say: a server that
        // accepts the token in the query string fails however it treats the
        // header (the 2026-07-28 twin reads it in the same order). Only a
        // refusal is read against them. A 401/403 is no evidence when the
        // unauthenticated ping drew a bare 403 nothing could attribute to
        // authentication (a Host guard or gateway answers this probe with
        // the same 403: see authNotEvaluable), and no refusal is when the
        // server refused the configured credential in the header too
        // (credentialRefusedStatus): the token was never going to be
        // accepted anywhere, so where it travelled decided nothing.
        const notAccepted = async (details: string): Promise<LegacyOutcome> => {
          const refused = await credentialRefusedStatus();
          return refused === null
            ? { passed: true, details }
            : credentialRefusedSkip(refused, "refusing it in the query string proves nothing");
        };
        const uriWithToken = `${backendUrl}${backendUrl.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`;
        let status: number;
        try {
          // Send WITHOUT the Authorization header, WITH the token in the
          // URI. This goes through undici directly: the transport is bound
          // to the plain URL and re-injects the configured Authorization
          // header on every request, which used to turn this probe into an
          // ordinary authenticated call whose 2xx read as "accepted a token
          // in the query string" — a false failure on every server with auth.
          const noAuthHeaders: Record<string, string> = {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          };
          for (const [k, v] of Object.entries(userHeaders)) {
            if (k.toLowerCase() !== "authorization") noAuthHeaders[k] = v;
          }
          if (sessionId) noAuthHeaders["mcp-session-id"] = sessionId;
          if (negotiatedProtocolVersion) noAuthHeaders["mcp-protocol-version"] = negotiatedProtocolVersion;
          const res = await request(uriWithToken, {
            method: "POST",
            headers: noAuthHeaders,
            body: JSON.stringify({ jsonrpc: "2.0", id: nextId(), method: "ping" }),
            signal: AbortSignal.timeout(timeout),
          });
          await res.body.text();
          status = res.statusCode;
        } catch (err: unknown) {
          // The probe differs from the served handshake only in where the
          // token travels, so a drop is pinned on that.
          const verdict = unansweredProbe(
            "the ping with the token in the query string",
            err,
            credentialedRequestServed(),
            timeout,
            options.signal,
          );
          if (verdict) return verdict;
          return notAccepted(`${closedWithoutResponse(err)} (token in query string not accepted)`);
        }
        // If server accepted it, that's a fail, whatever else is true.
        if (status >= 200 && status < 300) {
          return {
            passed: false,
            details: "Server accepted auth token in query string (spec: MUST NOT transmit credentials in URIs)",
          };
        }
        if (status === 401 || status === 403) {
          if (await authNotEvaluable()) return authNotEvaluableSkip;
          return notAccepted(`HTTP ${status} (token in query string rejected)`);
        }
        return notAccepted(`HTTP ${status} (token in query string not accepted)`);
      },
    );

    await test(
      "security-cors-headers",
      "CORS headers are restrictive",
      "security",
      false,
      "basic/transports#streamable-http",
      async () => {
        // CORS on both shapes a browser would send, read the way the
        // 2026-07-28 check (checkCorsHeaders) reads them: an OPTIONS
        // preflight from a foreign origin (capped at 5 s), and a conformant
        // POST carrying the same Origin -- a ping, the handshake's request,
        // with its headers -- given the run's timeout. MCP does not require
        // a server to handle OPTIONS, so a preflight nothing answers is no
        // verdict on its own: the POST's headers are read too. A wildcard or
        // the foreign origin reflected on either answer fails.
        //
        // A probe that got no HTTP answer has no headers to read; a
        // caller's abort is rethrown. Only when neither probe was answered
        // is there nothing to inspect: a connection the server accepted and
        // closed on both counts as cross-origin requests refused next to
        // the served handshake (the same server's answer to a request
        // without the Origin, the rule unansweredProbe applies); a timeout,
        // a connection never established or any other failure is "server
        // unreachable".
        const origin = "https://evil.example.com";
        const optionsTimeout = Math.min(timeout, 5000);
        const observations: Array<{
          via: "OPTIONS" | "POST";
          status: number;
          acao: string | undefined;
          credentials: string | undefined;
        }> = [];
        const seen: string[] = [];
        /** Why each probe got no response, for the verdict when neither did. */
        const failures: Array<{ probe: string; err: unknown; reason: string }> = [];
        try {
          const res = await request(backendUrl, {
            method: "OPTIONS",
            headers: {
              Origin: origin,
              "Access-Control-Request-Method": "POST",
              ...buildHeaders(),
            },
            signal: requestSignal(options.signal, optionsTimeout),
          });
          await res.body.text();
          const headers = flatHeaders(res.headers);
          observations.push({
            via: "OPTIONS",
            status: res.statusCode,
            acao: headers["access-control-allow-origin"],
            credentials: headers["access-control-allow-credentials"],
          });
        } catch (err: unknown) {
          if (options.signal?.aborted) throw err;
          seen.push("OPTIONS failed");
          failures.push({ probe: "the OPTIONS preflight", err, reason: noResponse(err, optionsTimeout) });
        }
        try {
          const res = await mcpRequest(
            backendUrl,
            "ping",
            undefined,
            nextId,
            { ...buildHeaders(), Origin: origin },
            timeout,
          );
          observations.push({
            via: "POST",
            status: res.statusCode,
            acao: res.headers["access-control-allow-origin"],
            credentials: res.headers["access-control-allow-credentials"],
          });
        } catch (err: unknown) {
          if (options.signal?.aborted) throw err;
          seen.push("POST with Origin failed");
          failures.push({ probe: "the ping carrying the foreign Origin", err, reason: noResponse(err, timeout) });
        }
        if (observations.length === 0) {
          const probes = failures.map((f) => f.probe).join(" and ");
          if (handshakeServed() && failures.every((f) => classifyTransportError(f.err) === "dropped")) {
            return {
              passed: true,
              details: clipAscii(
                `Connection closed without a response on ${probes}; the initialize handshake, sent without an Origin, was served (cross-origin requests refused, no CORS headers to check)`,
                240,
              ),
            };
          }
          const reasons = [...new Set(failures.map((f) => f.reason))];
          const what =
            reasons.length === 1
              ? `${probes} got ${reasons[0]}`
              : failures.map((f) => `${f.probe} got ${f.reason}`).join("; ");
          return {
            passed: false,
            details: clipAscii(`server unreachable: ${what}, so there are no CORS headers to check`, 240),
          };
        }
        for (const o of observations) {
          seen.push(`${o.via} HTTP ${o.status}${o.acao ? ` ACAO=${clipAscii(o.acao, 40)}` : ""}`);
          if (!o.acao) continue;
          const credentials = o.credentials?.toLowerCase() === "true" ? " with Allow-Credentials" : "";
          if (o.acao.trim() === "*") {
            return {
              passed: false,
              details: `Access-Control-Allow-Origin is "*" (wildcard${credentials}) on ${o.via} -- allows cross-origin credential theft`,
            };
          }
          if (o.acao.trim() === origin) {
            return {
              passed: false,
              details: `Server reflects arbitrary Origin in CORS${credentials} on ${o.via} -- effectively wildcard`,
            };
          }
        }
        const restricted = observations.find((o) => o.acao)?.acao;
        if (restricted) {
          return { passed: true, details: `CORS restricted to: ${clipAscii(restricted, 60)} (${seen.join(", ")})` };
        }
        return {
          passed: true,
          details: `No CORS headers returned (${seen.join(", ")}; server-to-server only, acceptable)`,
        };
      },
    );

    await test(
      "security-origin-validation",
      "Validates Origin header on requests",
      "security",
      false,
      "basic/transports#streamable-http",
      async () => {
        // A POST ping with the handshake's headers (session, credential)
        // plus a suspicious Origin, which streamable-http says MUST draw 403
        // Forbidden (DNS rebinding protection). What the answer shows, read
        // the way the 2026-07-28 twin reads it:
        //
        // - a 2xx: the server accepted the request; fails;
        // - a 429: a rate limiter answered before the server read the
        //   request. The probe is resent once after Retry-After (capped at
        //   2 s, retryAfterMs), and a second 429 is not evaluable -- the
        //   Origin was never looked at;
        // - a 5xx: the server failed on the request rather than refusing it
        //   (the reading security-auth-required and security-oversized-input
        //   give the same status); fails;
        // - a 401/403: the refusal the spec asks for when the Origin is the
        //   one variable -- initialize, the same request without it, was
        //   served, or was answered with a different status (a server that
        //   checks the Origin before auth answers the credential-less
        //   initialize 401 and the foreign Origin 403). When initialize drew
        //   the same status or no answer, the 401/403 is what an auth gate,
        //   a Host guard or a gateway answers every request with, and it says
        //   nothing about the Origin: the check skips, pointing at
        //   security-auth-required the way the auth siblings skip;
        // - any other 4xx (400, 404, ...): refused, and passes -- the spec's
        //   status is 403, but a request rejected for its Origin is rejected;
        // - anything else (a redirect): fails, naming the status.
        const send = async () => {
          const res = await request(backendUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              Origin: "https://evil-rebinding-attack.example.com",
              ...buildHeaders(),
            },
            body: JSON.stringify({ jsonrpc: "2.0", id: createIdCounter(99970)(), method: "ping" }),
            signal: options.signal
              ? AbortSignal.any([options.signal, AbortSignal.timeout(timeout)])
              : AbortSignal.timeout(timeout),
          });
          const text = await res.body.text();
          let body: unknown;
          try {
            body = JSON.parse(text);
          } catch {}
          return { statusCode: res.statusCode, headers: flatHeaders(res.headers), body };
        };
        try {
          let res = await send();
          /** "HTTP 429, then after Nms " once a throttled probe was resent. */
          let throttled = "";
          if (res.statusCode === 429) {
            const wait = retryAfterMs(res.headers);
            await pause(wait, options.signal);
            throttled = `HTTP 429, then after ${wait}ms `;
            res = await send();
          }
          const status = res.statusCode;
          if (status >= 200 && status < 300) {
            return {
              passed: false,
              details: `${throttled}HTTP ${status} — server accepted request with untrusted Origin header (spec: MUST validate Origin for DNS rebinding protection)`,
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
              details: `${throttled}HTTP ${status}${rpcErrorSuffix(res.body)} -- the server failed on the request rather than refusing it (a broken server, or a gateway with no backend); an untrusted Origin MUST draw 403`,
            };
          }
          const setupStatus: unknown = initRes?.statusCode;
          const originDecided = handshakeServed() || (typeof setupStatus === "number" && setupStatus !== status);
          if ((status === 401 || status === 403) && !originDecided) {
            return {
              passed: true,
              details: `Skipped: HTTP ${status} to the foreign Origin, but initialize was not served either, so the refusal is not attributable to the Origin (see security-auth-required)`,
            };
          }
          if (status >= 400) {
            return { passed: true, details: `${throttled}HTTP ${status} (suspicious Origin rejected)` };
          }
          return { passed: false, details: `${throttled}HTTP ${status}` };
        } catch (err: unknown) {
          // The probe is the handshake's request plus a foreign Origin, so
          // a drop is pinned on the Origin when that handshake was served
          // (no credential needed here: the Origin is the one variable).
          const verdict = unansweredProbe(
            "the ping carrying a foreign Origin",
            err,
            handshakeServed(),
            timeout,
            options.signal,
          );
          if (verdict) return verdict;
          return { passed: true, details: `${closedWithoutResponse(err)} (suspicious Origin rejected)` };
        }
      },
    );

    // The two helpers below serve the injection checks,
    // security-oversized-input and security-extra-params: declared ahead of
    // all of them, since a const arrow is not usable before its declaration
    // runs.

    /**
     * After an HTTP connection was dropped on a tools/call (the 1 MB value,
     * an injection payload, unknown arguments), one follow-up ping (with the session, the way
     * every later request goes) tells a connection-level rejection from a
     * crash -- the 2026-07-28 suite's follow-up server/discover, in this
     * era's method:
     *
     * - served (a JSON-RPC result): the server is up;
     * - refused with 401 or 403: a gate in front of the server answered --
     *   an auth gate when the refusal reads as one (readAuthRefusal), any
     *   other 403 most likely a WAF or IPS now blocking this client -- so
     *   this is no crash either;
     * - refused with 429: a rate limiter answers before the server reads the
     *   request (and one running as a separate gateway answers for a backend
     *   that is gone), so the ping is retried once after Retry-After (capped
     *   at 2 s, retryAfterMs) and the retry's answer decides; a second 429
     *   counts as gone;
     * - a JSON-RPC error answering the ping by its id, at any status below
     *   500 other than 401, 403 and 429 (read above): the server read and
     *   dispatched the request, so it is up (one that does not implement
     *   ping answers -32601, and both eras let an error travel on an HTTP
     *   4xx);
     * - anything else (no response, a proxy's 502 for a backend that went
     *   away, a JSON-RPC error that does not answer the ping -- the id-null
     *   404 "Session not found" of a server that restarted and lost the
     *   session -- or one on a 5xx, which a gateway in front of a dead
     *   backend can synthesize with the request's id): the server may have
     *   crashed.
     *
     * `alive` / `gone` is the clause the details quote. A run the caller
     * aborted (during the ping or the wait before its retry) is rethrown.
     */
    const pingAfterDrop = async (): Promise<{ alive: string } | { gone: string }> => {
      /** "answered HTTP 429, then after Nms " once the ping has been retried. */
      let retried = "";
      for (;;) {
        let res: Awaited<ReturnType<typeof mcpRequest>>;
        try {
          res = await rpc("ping");
        } catch (err: unknown) {
          if (options.signal?.aborted) throw err;
          return { gone: `${retried}got ${noResponse(err, timeout)}` };
        }
        if (res.body?.result !== undefined) {
          return {
            alive: retried ? `a follow-up ping ${retried}was served` : "the server still served a follow-up ping",
          };
        }
        // A 401/403 reads as the gate it is before its body is read: a gate's
        // JSON-RPC error can echo the id as well.
        const refusal = readAuthRefusal(res, hasAuthHeader);
        if (refusal) {
          const gate =
            refusal.kind === "forbidden"
              ? "a gate in front of the server such as a WAF or IPS now blocking this client"
              : "an auth gate";
          return { alive: `a follow-up ping ${retried}was still answered (HTTP ${res.statusCode}, ${gate})` };
        }
        // A 429 is the limiter's, whatever its body echoes: retried below.
        const error = res.body?.error;
        if (
          res.statusCode < 500 &&
          res.statusCode !== 429 &&
          error !== undefined &&
          error !== null &&
          res.body?.id === res.requestId
        ) {
          return {
            alive: `a follow-up ping ${retried}was answered (HTTP ${res.statusCode}${rpcErrorSuffix(res.body)})`,
          };
        }
        if (res.statusCode !== 429 || retried) {
          return { gone: `${retried}answered HTTP ${res.statusCode}${rpcErrorSuffix(res.body)}` };
        }
        const wait = retryAfterMs(res.headers);
        await pause(wait, options.signal);
        retried = `answered HTTP 429, then after ${wait}ms `;
      }
    };

    // Input validation security tests (only run if tools are available)
    // Shared helper for injection tests: sends payloads to a tool param and
    // classifies the output the way the 2026-07-28 suite does
    // (classifyInjectionOutput): every verbatim copy of the payload is
    // scrubbed before the detector runs, so an echo tool returning
    // "&& echo pwned" as-is is benign reflection, not "pwned" produced by
    // a shell, and only execution evidence (uid=..., root:x:..., a real
    // database error) counts as an issue. Rejection heuristics live in
    // src/checks/patterns.ts (looksRejected).
    //
    // A payload that got no answer at all is read from the error the way
    // the 2026-07-28 twin reads it (classifyTransportError), never as the
    // server rejecting the input:
    // - a stdio child that exits on a payload died on it -- the crash the
    //   check exists to catch: it fails naming the payload, and the child
    //   is restarted (restartStdioServer) so the checks after it measure
    //   the server rather than the corpse;
    // - an HTTP connection closed or reset on a payload is resolved with a
    //   follow-up ping (pingAfterDrop): a server gone after it fails as a
    //   possible crash; one still up means the payload never reached the
    //   tool (a WAF or IPS, a keep-alive close), counted as unanswered, with
    //   a warning;
    // - a server already gone before a payload (a child an earlier check
    //   killed, a refused connection) stops the probe as unreachable;
    // - a timeout is a payload that got no answer, counted as unanswered;
    // - a caller's abort is rethrown, never graded.

    async function runInjectionTest(
      check: string,
      toolName: string,
      paramName: string,
      payloads: string[],
      detectPattern: RegExp,
      label: string,
      evidence: string,
    ): Promise<LegacyOutcome> {
      const where = `${toolName}.${paramName}`;
      const issues: string[] = [];
      let rejected = 0;
      let benign = 0;
      /** Payloads that got no answer: a timeout, or a dropped connection the server outlived. */
      let unanswered = 0;
      for (const payload of payloads) {
        const stdio = transport.kind === "stdio" ? (transport as StdioTransport) : null;
        // A child already gone was not killed by this payload.
        const alreadyGone = stdio?.exited === true;
        try {
          const res = await rpc("tools/call", { name: toolName, arguments: { [paramName]: payload } });
          const result = res.body?.result;
          const content = result?.content;
          const isErrorFlag = result?.isError === true;
          if (Array.isArray(content)) {
            const text = content.map((c: any) => c.text || "").join(" ");
            const verdict = classifyInjectionOutput(text, payload, detectPattern, isErrorFlag);
            if (verdict === "issue") {
              issues.push(`Payload "${payload}" ${label} (output: ${text.substring(0, 100)})`);
            } else if (verdict === "rejected") {
              rejected++;
            } else {
              benign++;
            }
          } else {
            // A JSON-RPC error (invalid params, unknown tool): the input
            // never reached a handler.
            rejected++;
          }
        } catch (err: unknown) {
          if (options.signal?.aborted) throw err;
          const failure = classifyTransportError(err);
          const sent = `payload "${payload}" sent to ${where}`;
          // Execution evidence found on earlier payloads comes first.
          const afterIssues = (crash: string) => [...issues, crash].join("; ");
          if (stdio && !alreadyGone && (failure === "dropped" || stdio.exited)) {
            const died = { passed: false, details: afterIssues(`server died on ${sent}: ${errorLine(err, 120)}`) };
            await restartStdioServer(check, `an injection payload sent to ${where}`);
            return died;
          }
          if (!stdio && failure === "dropped") {
            const after = await pingAfterDrop();
            if ("gone" in after) {
              return {
                passed: false,
                details: afterIssues(
                  `server may have crashed: connection dropped on ${sent}: ${errorLine(err, 40)}; ping then ${after.gone}`,
                ),
              };
            }
            warnings.push(
              `${check}: a tools/call to ${where} carrying a payload had its connection closed without a response, but ${after.alive}, so the payload is counted as unanswered rather than as a crash or a rejection. The drop may be a WAF or IPS dropping the request, a keep-alive connection closed as it was sent, or one crashed worker of several; refuse a payload with HTTP 4xx or a JSON-RPC error so a client can tell a refusal from a crash.`,
            );
            unanswered++;
            continue;
          }
          // Gone before this payload (a child an earlier check killed, a
          // refused connection): no payload after it can be sent either.
          if (failure === "dropped" || failure === "connect") {
            if (issues.length > 0) return { passed: false, details: issues.join("; ") };
            const gone = unreachable(`tools/call ${where} with payload "${payload}"`, err, timeout);
            const earlier = rejected + benign + unanswered;
            return earlier === 0
              ? gone
              : { passed: false, details: `${gone.details}, after ${earlier} earlier payload(s)` };
          }
          // A timeout (the tool may just be slow) or an unclassifiable
          // error: the payload got no answer, which rejects nothing.
          unanswered++;
        }
      }
      if (issues.length > 0) return { passed: false, details: issues.join("; ") };
      const scope = `Tested ${payloads.length} payloads against ${where}`;
      if (unanswered === 0) {
        return {
          passed: true,
          details:
            benign === 0
              ? `${scope} — server defended (rejected or sanitized)`
              : `${scope} — no ${evidence} detected (${rejected} rejected, ${benign} returned without it)`,
        };
      }
      if (unanswered === payloads.length) {
        // Nothing was measured: say so rather than pass as "defended".
        warnings.push(
          `${check}: no payload sent to ${where} got an answer (every tools/call timed out, was dropped, or got no usable response), so the verdict is inconclusive.`,
        );
        return {
          passed: true,
          details: `${scope} — inconclusive: no payload got an answer (see warning)`,
          skipped: true,
        };
      }
      return {
        passed: true,
        details: `${scope} — no ${evidence} detected (${rejected} rejected, ${benign} returned without it, ${unanswered} unanswered)`,
      };
    }

    if (toolNames.length > 0) {
      const allTools: any[] = cachedToolsList ?? [];
      const toolsWithStringParams = allTools.filter((t) => {
        const props = t.inputSchema?.properties;
        if (!props) return false;
        return Object.values(props).some((p: any) => p.type === "string");
      });

      const injectionTarget: any = toolsWithStringParams[0] || allTools[0];
      const targetStringParam: string | null = injectionTarget?.inputSchema?.properties
        ? (Object.entries(injectionTarget.inputSchema.properties).find(
            ([_, v]: [string, any]) => v.type === "string",
          )?.[0] ?? null)
        : null;

      await test(
        "security-command-injection",
        "Resists command injection in tool params",
        "security",
        false,
        "server/tools#calling-tools",
        async () => {
          if (!injectionTarget || !targetStringParam)
            return { passed: true, details: "No tools with string parameters to test", skipped: true };
          return runInjectionTest(
            "security-command-injection",
            injectionTarget.name,
            targetStringParam,
            INJECTION_PAYLOADS.command,
            /root:.*:\d+:\d+:.*:\/|uid=\d+\(\w+\)|drwxr|pwned/i,
            "appears to have executed",
            "command execution",
          );
        },
      );

      await test(
        "security-sql-injection",
        "Resists SQL injection in tool params",
        "security",
        false,
        "server/tools#calling-tools",
        async () => {
          if (!injectionTarget || !targetStringParam)
            return { passed: true, details: "No tools with string parameters to test", skipped: true };
          return runInjectionTest(
            "security-sql-injection",
            injectionTarget.name,
            targetStringParam,
            INJECTION_PAYLOADS.sql,
            /syntax error|sql|mysql|postgres|sqlite|information_schema|table_name/i,
            "triggered database error",
            "database error",
          );
        },
      );

      await test(
        "security-path-traversal",
        "Resists path traversal in tool params",
        "security",
        false,
        "server/tools#calling-tools",
        async () => {
          if (!injectionTarget || !targetStringParam)
            return { passed: true, details: "No tools with string parameters to test", skipped: true };
          return runInjectionTest(
            "security-path-traversal",
            injectionTarget.name,
            targetStringParam,
            INJECTION_PAYLOADS.pathTraversal,
            /root:.*:0:0|\[boot loader\]|\[extensions\]/i,
            "returned sensitive file content",
            "sensitive file content",
          );
        },
      );

      await test(
        "security-ssrf-internal",
        "Resists SSRF to internal networks",
        "security",
        false,
        "server/tools#calling-tools",
        async () => {
          const urlParamTool = allTools.find((t: any) => {
            const props = t.inputSchema?.properties;
            if (!props) return false;
            return Object.entries(props).some(
              ([k, v]: [string, any]) => v.type === "string" && /url|uri|endpoint|link|href/i.test(k),
            );
          });
          if (!urlParamTool) return { passed: true, details: "No tools with URL parameters found (skipped)" };
          const urlParam = Object.entries(urlParamTool.inputSchema.properties).find(
            ([k, v]: [string, any]) => v.type === "string" && /url|uri|endpoint|link|href/i.test(k),
          )?.[0];
          if (!urlParam) return { passed: true, details: "No URL parameter found", skipped: true };
          return runInjectionTest(
            "security-ssrf-internal",
            urlParamTool.name,
            urlParam,
            INJECTION_PAYLOADS.ssrf,
            /ami-|instance-id|hostname|iam|security-credentials/i,
            "returned internal data",
            "internal data",
          );
        },
      );
    } else {
      // No tools — auto-pass input validation tests
      for (const testId of [
        "security-command-injection",
        "security-sql-injection",
        "security-path-traversal",
        "security-ssrf-internal",
      ]) {
        await test(
          testId,
          TEST_DEFINITIONS_MAP.get(testId)?.name || testId,
          "security",
          false,
          "server/tools#calling-tools",
          async () => ({ passed: true, details: "No tools available to test (skipped)" }),
        );
      }
    }

    await test(
      "security-oversized-input",
      "Handles oversized inputs gracefully",
      "security",
      false,
      "server/tools#calling-tools",
      async () => {
        const largeValue = "A".repeat(1_048_576);
        const toolName = toolNames[0] || "test";
        const where = `${toolName}.data`;
        const unreachable = (err: unknown) => ({
          passed: false,
          details: `server unreachable: tools/call ${where} with a 1 MB value got ${noResponse(err, timeout)}`,
        });
        // Sent through the transport, so it runs on stdio too (a raw POST to
        // backendUrl, which is empty for a stdio target, failed client-side
        // and passed as "Connection rejected"), parses an SSE answer, and
        // honours the caller's abort.
        const stdio = transport.kind === "stdio" ? (transport as StdioTransport) : null;
        // Scopes the stdio overflow verdict to output produced during THIS
        // call: the transport counts overflows for its whole life.
        const overflowsBefore = stdio?.stdoutOverflows ?? 0;
        // A child already gone was not killed by the 1 MB value.
        const alreadyGone = stdio?.exited === true;
        const callBig = () =>
          mcpRequest(
            backendUrl,
            "tools/call",
            { name: toolName, arguments: { data: largeValue } },
            nextId,
            buildHeaders(),
            timeout,
          );
        try {
          let res = await callBig();
          /** "HTTP 429, then after Nms " once a throttled call was resent. */
          let throttled = "";
          if (!stdio && res.statusCode === 429) {
            // A rate limiter answers before the server reads the request, so
            // a 429 says nothing about the 1 MB value: wait what it asks
            // (capped at 2 s, retryAfterMs) and send the call once more.
            const wait = retryAfterMs(res.headers);
            await pause(wait, options.signal);
            throttled = `HTTP 429, then after ${wait}ms `;
            res = await callBig();
          }
          const body = res.body;
          const rpcError = body?.error !== undefined && body?.error !== null;
          if (!stdio) {
            const status = res.statusCode;
            if (status === 413) return { passed: true, details: "HTTP 413 Payload Too Large (good)" };
            if (status === 429) {
              return {
                passed: false,
                details: `${throttled}HTTP 429 on a 1 MB ${where} -- not evaluable: a rate limiter answered before the server read the request`,
              };
            }
            // A 401, or a 403 that reads as an auth gate (readAuthRefusal),
            // answered before the server read the request: nothing about the
            // 1 MB value was measured. A bare 403 is what a WAF or size rule
            // blocking the body answers too, and counts when initialize --
            // sent with the same headers -- was served: the value is then
            // the one variable. Otherwise it may be Host/Origin validation
            // or a gateway refusing every request.
            const refusal = readAuthRefusal(res, hasAuthHeader);
            if (refusal && refusal.kind !== "forbidden") {
              return {
                passed: false,
                details: `HTTP ${status} on a 1 MB ${where} -- not evaluable: an auth gate answered before the server read the request (${authRefusalHint(refusal, "pass --auth")})`,
              };
            }
            if (refusal && !handshakeServed()) {
              const quoted = refusal.message ? ` (${JSON.stringify(refusal.message)})` : "";
              return {
                passed: false,
                details: `HTTP 403${quoted} on a 1 MB ${where} -- not evaluable: initialize was not served either, so the 403 may be Host/Origin validation or a gateway refusing every request rather than a size limit`,
              };
            }
            if (status >= 400 && status < 500) {
              return { passed: true, details: `HTTP ${status} (oversized input rejected)` };
            }
            if (status >= 500) {
              return {
                passed: false,
                details: `HTTP ${status} -- server error on a 1 MB ${where} (should answer 413/4xx or a JSON-RPC error)`,
              };
            }
          }
          // What the server itself answered, read the way the 2026-07-28 twin
          // reads it: a JSON-RPC error rejected the value; a result is a
          // server that processed a megabyte it could have refused -- it
          // survived, so it passes, with the warning that says so.
          if (rpcError) {
            return { passed: true, details: `${errorWithCode(body.error.code)} (oversized input rejected)` };
          }
          if (body?.result !== undefined) {
            warnings.push(
              `security-oversized-input: the server completed a tools/call carrying a 1 MB string argument (${where}) instead of rejecting it; enforce a request body limit (413) or maxLength in inputSchema.`,
            );
            const prefix = stdio ? "result" : `HTTP ${res.statusCode}, result`;
            return {
              passed: true,
              details: `${prefix} -- server processed a 1 MB ${where} without rejecting it (survived)`,
            };
          }
          const frame = stdio ? "broken stdio frame" : `HTTP ${res.statusCode}, non-JSON-RPC body`;
          return { passed: false, details: `${frame} -- no result or error for a 1 MB ${where}` };
        } catch (err: unknown) {
          if (options.signal?.aborted) throw err;
          const failure = classifyTransportError(err);
          if (stdio) {
            // The exit decides before the overflow does: a child that wrote
            // an over-long line and then exited was rejected by its exit.
            if (failure === "dropped" || stdio.exited) {
              if (alreadyGone) return unreachable(err);
              const died = { passed: false, details: `server died on a 1 MB ${where}: ${errorLine(err, 120)}` };
              await restartStdioServer("security-oversized-input", `a 1 MB ${where}`);
              return died;
            }
            if (stdio.stdoutOverflows > overflowsBefore) {
              // The server answered with a single line longer than the
              // runner's 1 MiB stdio buffer and is still running: a runner
              // limit, not a server fault.
              warnings.push(
                `security-oversized-input: the server's reply to a 1 MB ${where} exceeded the runner's 1 MiB stdio line buffer and was dropped; treated as survived. Prefer rejecting oversized arguments with a JSON-RPC error.`,
              );
              return {
                passed: true,
                details: `response to a 1 MB ${where} exceeded the runner's stdio line buffer (server survived)`,
              };
            }
          } else {
            // Refused before anything was sent: nothing about the 1 MB value was measured.
            if (failure === "connect") return unreachable(err);
            // Closing the connection on a 1 MB body is an acceptable
            // refusal only when the server is still there afterwards.
            if (failure === "dropped") {
              const reason = errorLine(err, 40);
              const after = await pingAfterDrop();
              if ("gone" in after) {
                if (!serverReachable && initRes === null) {
                  // Neither the preflight nor initialize was ever answered:
                  // the server was not reachable in this run at all, so the
                  // drop says nothing about the 1 MB value.
                  return {
                    passed: false,
                    details: `${unreachable(err).details}; ping then ${after.gone} (the preflight and initialize got no answer either)`,
                  };
                }
                return {
                  passed: false,
                  details: `server may have crashed: connection dropped on a 1 MB ${where}: ${reason}; ping then ${after.gone}`,
                };
              }
              return {
                passed: true,
                details: `Connection rejected (acceptable for oversized input): ${reason}; ${after.alive}`,
              };
            }
          }
          if (failure === "timeout") {
            return { passed: false, details: "Request timed out — server may be struggling with oversized input" };
          }
          // A rejection is an answer (a 4xx, a JSON-RPC error) or a
          // connection closed on the body that the server outlives, all read
          // above. What is left got no usable response at all -- bytes that
          // are not an HTTP response, a TLS failure, a child that never
          // spawned -- and rejects nothing.
          return { passed: false, details: `no usable response to a 1 MB ${where}: ${errorLine(err, 120)}` };
        }
      },
    );

    await test(
      "security-extra-params",
      "Rejects or ignores extra tool params",
      "security",
      false,
      "server/tools#calling-tools",
      async () => {
        if (toolNames.length === 0) {
          return { passed: true, details: "No tools available to test (skipped)" };
        }
        // Unknown arguments on the first tool, read the way the 2026-07-28
        // twin reads them. Rejected (a JSON-RPC error) or ignored (a result)
        // both pass; a 5xx, or an answer that is neither, fails. A request
        // that got no answer is read from the error, never as a rejection:
        // - a stdio child that exits on the call died on it -- the crash the
        //   check hunts: it fails as died, and the child is restarted
        //   (restartStdioServer) so the checks after it measure the server;
        // - an HTTP connection closed or reset on the call is resolved with
        //   a follow-up ping (pingAfterDrop): a server gone after it fails as
        //   a possible crash; one still up passes as inconclusive, with a
        //   warning (a WAF or IPS dropping the payload, a keep-alive close);
        // - a server already gone before the call (a child an earlier check
        //   killed, a refused connection) is unreachable, not a crash on
        //   these arguments;
        // - a timeout passes as inconclusive, with a warning: the tool may
        //   just be slow;
        // - anything else got no usable response, and fails;
        // - a caller's abort is rethrown, never graded.
        const name = toolNames[0];
        const what = `tools/call ${name} with unknown arguments`;
        const stdio = transport.kind === "stdio" ? (transport as StdioTransport) : null;
        // A child already gone was not killed by these arguments.
        const alreadyGone = stdio?.exited === true;
        try {
          // Build arguments via JSON.parse so "__proto__" lands as a real own
          // enumerable property: the `__proto__:` object-literal form sets the
          // prototype instead, and JSON.stringify would drop it, so the
          // pollution payload would never reach the wire.
          const maliciousArgs = JSON.parse('{"__injected_param__":"malicious_value","__proto__":{"admin":true}}');
          const res = await rpc("tools/call", {
            name,
            arguments: maliciousArgs,
          });
          // A stdio answer always reads 200 (mcpRequest), so this is HTTP's:
          // the server failed on the payload rather than refusing it.
          if (res.statusCode >= 500) {
            return { passed: false, details: `HTTP ${res.statusCode} -- server error on unknown tool arguments` };
          }
          const error = res.body?.error;
          if (error) {
            return { passed: true, details: `Extra params rejected with error: ${error.code} — ${error.message}` };
          }
          // If server accepted but ignored extra params, that's acceptable
          if (res.body?.result !== undefined) {
            return { passed: true, details: "Server processed request (extra params likely ignored)" };
          }
          const seen = stdio ? "" : `HTTP ${res.statusCode}, `;
          return {
            passed: false,
            details: `malformed response to unknown tool arguments (${seen}no result or error)`,
          };
        } catch (err: unknown) {
          if (options.signal?.aborted) throw err;
          const failure = classifyTransportError(err);
          // The stdio transport rejects every pending request with the
          // child's exit diagnostic the moment it goes away.
          if (stdio && (failure === "dropped" || stdio.exited)) {
            if (alreadyGone) return unreachable(what, err, timeout);
            const died = {
              passed: false,
              details: `server died on unknown tool arguments (tools/call ${name}): ${errorLine(err, 120)}`,
            };
            await restartStdioServer("security-extra-params", `unknown tool arguments (tools/call ${name})`);
            return died;
          }
          if (!stdio) {
            // Refused before anything was sent: an earlier check took the server down.
            if (failure === "connect") return unreachable(what, err, timeout);
            if (failure === "dropped") {
              const after = await pingAfterDrop();
              if ("gone" in after) {
                return {
                  passed: false,
                  details: `server may have crashed: connection dropped on unknown tool arguments (tools/call ${name}): ${errorLine(err, 40)}; ping then ${after.gone}`,
                };
              }
              warnings.push(
                `security-extra-params: tools/call ${name} with unknown arguments had its connection closed without a response, but ${after.alive}, so the verdict is inconclusive rather than a crash. The drop may be a WAF or IPS dropping the request, a keep-alive connection closed as it was sent, or one crashed worker of several; reject unknown arguments with a JSON-RPC error or ignore them so a client can tell a refusal from a crash.`,
              );
              // No answer to read: a skip, whatever the warning says.
              return {
                passed: true,
                details: `tools/call ${name} had its connection closed without a response -- extra-params verdict inconclusive (see warning)`,
                skipped: true,
              };
            }
          }
          if (failure === "timeout") {
            warnings.push(
              `security-extra-params: tools/call ${name} with unknown arguments did not answer within ${timeout}ms, so the verdict is inconclusive (no answer is neither a rejection nor a crash). Re-run with a larger --timeout or a faster first tool.`,
            );
            return {
              passed: true,
              details: `tools/call ${name} did not answer within ${timeout}ms -- extra-params verdict inconclusive (see warning)`,
              skipped: true,
            };
          }
          // Neither an answer nor a transport failure the server can be
          // judged by: bytes that are not an HTTP response, a TLS failure.
          return {
            passed: false,
            details: `no usable response to unknown tool arguments (tools/call ${name}): ${errorLine(err, 120)}`,
          };
        }
      },
    );

    /**
     * security-tool-rug-pull once an earlier check killed the stdio server
     * and restartStdioServer replaced it: the 2026-07-28 suite's
     * rugPullOnReplacement. cachedToolsList came from the first process, so
     * a second list read from the replacement would compare two processes:
     * a server whose tools change after use would pass (its replacement has
     * not been used yet), and one whose descriptions differ per process (a
     * pid, a start time) would be accused of a rug-pull. Both lists come
     * from the replacement instead: the one restartStdioServer read before
     * any tools/call reached it, then -- after a tools/call with no
     * arguments (pickTool: a tool that requires none, else the first), so
     * the process has been used whatever the checks since the restart sent
     * it -- a second one, compared on the fields the first-process path
     * compares (count, names, descriptions).
     *
     * With nothing to compare the check is a skip naming the restart: the
     * replacement's list before use was not obtained (the restart's warning
     * says why), or the tools/call killed the replacement too -- which is
     * then replaced again for the checks after this one, like any check
     * whose own request killed the server. A caller's abort is rethrown.
     */
    const rugPullOnReplacement = async (current: { after: string; tools: any[] | null }): Promise<LegacyOutcome> => {
      const on = `the server restarted after ${current.after}`;
      const before = current.tools;
      if (!before) {
        return {
          passed: true,
          details: `Skipped: the tools/list of ${on} was not read before use, so there are no two lists from one process to compare (see warning)`,
          skipped: true,
        };
      }
      const tool = pickTool(before);
      if (tool) {
        const stdio = transport.kind === "stdio" ? (transport as StdioTransport) : null;
        // A child already gone was not killed by this call.
        const alreadyGone = stdio?.exited === true;
        try {
          await rpc("tools/call", { name: tool.name, arguments: {} });
        } catch (err: unknown) {
          if (options.signal?.aborted) throw err;
          if (stdio && !alreadyGone && (classifyTransportError(err) === "dropped" || stdio.exited)) {
            await restartStdioServer("security-tool-rug-pull", `a tools/call to ${tool.name} with no arguments`);
            return {
              passed: true,
              details: clipAscii(
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
      // Every details string below is ASCII-clipped, as the 2026-07-28
      // original clips them: a tool name is the server's text.
      try {
        const res = await rpc("tools/list");
        const again = res.body?.result?.tools;
        if (!Array.isArray(again)) {
          return {
            passed: false,
            details: clipAscii(`Second tools/list call failed (${answerShape(res)}) on ${on}`, 200),
          };
        }
        const diff = toolListDiff(before, again, "->");
        if (diff) return { passed: false, details: clipAscii(`${diff}; both lists from ${on} (${between})`, 200) };
        return {
          passed: true,
          details: clipAscii(`${before.length} tool(s) consistent across 2 calls to ${on} (${between})`, 200),
        };
      } catch (err: unknown) {
        if (options.signal?.aborted) throw err;
        return { passed: false, details: `Second tools/list call threw: ${clipAscii(errorLine(err, 120), 120)}` };
      }
    };

    // Tool integrity tests
    await test(
      "security-tool-schema-defined",
      "All tools define inputSchema",
      "security",
      false,
      "server/tools#data-types",
      async () => {
        if (!toolsListOk) return { passed: true, details: "Skipped: tools/list not available" };
        const tools = cachedToolsList ?? [];
        if (tools.length === 0) return { passed: true, details: "No tools to validate", skipped: true };
        const missing = tools.filter((t: any) => t.inputSchema?.type !== "object");
        if (missing.length > 0) {
          return {
            passed: false,
            details: `${missing.length} tool(s) missing inputSchema: ${missing.map((t: any) => t.name).join(", ")}`,
          };
        }
        return { passed: true, details: `All ${tools.length} tool(s) have inputSchema defined` };
      },
    );

    await test(
      "security-tool-rug-pull",
      "Tool definitions are stable across calls",
      "security",
      false,
      "server/tools#listing-tools",
      async () => {
        if (!toolsListOk) return { passed: true, details: "Skipped: tools/list not available" };
        // The cached list came from a process an earlier check killed.
        if (replacement) return rugPullOnReplacement(replacement);
        // Fetch tools/list again and compare
        try {
          const res = await rpc("tools/list");
          const tools2 = res.body?.result?.tools;
          if (!Array.isArray(tools2)) return { passed: false, details: "Second tools/list call failed" };
          const tools1 = cachedToolsList ?? [];
          const diff = toolListDiff(tools1, tools2, "→");
          if (diff) return { passed: false, details: diff };
          return { passed: true, details: `${tools1.length} tool(s) consistent across 2 calls` };
        } catch {
          return { passed: false, details: "Second tools/list call threw an error" };
        }
      },
    );

    await test(
      "security-tool-description-poisoning",
      "Tool descriptions free of injection patterns",
      "security",
      false,
      "server/tools#data-types",
      async () => {
        if (!toolsListOk) return { passed: true, details: "Skipped: tools/list not available" };
        const tools = cachedToolsList ?? [];
        if (tools.length === 0) return { passed: true, details: "No tools to validate", skipped: true };

        const issues: string[] = [];
        for (const tool of tools) {
          const textsToCheck = [
            tool.description || "",
            ...(tool.inputSchema?.properties
              ? Object.values(tool.inputSchema.properties).map((p: any) => p.description || "")
              : []),
          ];
          const combined = textsToCheck.join(" ");
          for (const { pattern, label } of POISONING_PATTERNS) {
            if (pattern.test(combined)) {
              issues.push(`Tool "${tool.name}": ${label}`);
            }
          }
        }
        if (issues.length > 0) return { passed: false, details: issues.join("; ") };
        return { passed: true, details: `${tools.length} tool(s) scanned — no injection patterns found` };
      },
    );

    await test(
      "security-tool-cross-reference",
      "Tools do not reference other tools by name",
      "security",
      false,
      "server/tools#data-types",
      async () => {
        if (!toolsListOk) return { passed: true, details: "Skipped: tools/list not available" };
        const tools = cachedToolsList ?? [];
        if (tools.length < 2)
          return { passed: true, details: "Fewer than 2 tools — cross-reference check not applicable" };

        const names = tools.map((t: any) => t.name).filter(Boolean);
        const issues: string[] = [];
        for (const tool of tools) {
          const desc = (tool.description || "").toLowerCase();
          for (const otherName of names) {
            if (otherName === tool.name) continue;
            if (desc.includes(otherName.toLowerCase())) {
              issues.push(`Tool "${tool.name}" description references "${otherName}"`);
            }
          }
        }
        if (issues.length > 0) {
          warnings.push(`Cross-tool references found: ${issues.join("; ")}`);
          return { passed: false, details: issues.join("; ") };
        }
        return { passed: true, details: `${tools.length} tool(s) checked — no cross-references found` };
      },
    );

    // Information disclosure tests
    //
    // Both send their error probes as raw HTTP POSTs to backendUrl, which a
    // stdio target does not have (it is ""): every probe failed client-side
    // and the checks passed on nothing -- "0 error responses checked" and
    // "No response to check (connection error)" on every stdio run. There
    // they skip, saying so. Over HTTP a probe that got no answer is read the
    // way the rest of the suite reads one: a timeout, a refused connection
    // or a dropped one left no error response to scan, so when nothing
    // answered the check fails as "server unreachable" (the 2026-07-28
    // suite's information-disclosure checks do the same when the server
    // never answered), and a caller's abort is rethrown.
    const rawHttpSignal = () =>
      options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
    await test(
      "security-error-no-stacktrace",
      "Error responses do not leak stack traces",
      "security",
      false,
      "basic",
      async () => {
        if (transport.kind === "stdio") {
          return {
            passed: true,
            details:
              "Skipped: the error probes are raw HTTP requests, which a stdio target cannot receive, so no error response was scanned",
            skipped: true,
          };
        }
        const errorResponses: string[] = [];
        // Trigger several error conditions and collect response text
        const errorPayloads = [
          "{this is not valid json!!!",
          JSON.stringify({ jsonrpc: "2.0", id: nextId(), method: "nonexistent/___crash___test___" }),
          JSON.stringify({
            jsonrpc: "2.0",
            id: nextId(),
            method: "tools/call",
            params: { name: "___nonexistent___tool___" },
          }),
        ];
        /** Why the first unanswered probe got no response, for the verdict when none answered. */
        let firstFailure: unknown;
        for (const payload of errorPayloads) {
          try {
            const res = await request(backendUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Accept: "application/json, text/event-stream",
                ...buildHeaders(),
              },
              body: payload,
              signal: rawHttpSignal(),
            });
            const text = await res.body.text();
            errorResponses.push(text);
          } catch (err: unknown) {
            if (options.signal?.aborted) throw err;
            // No response to check from this probe.
            firstFailure ??= err;
          }
        }
        if (errorResponses.length === 0) {
          return {
            passed: false,
            details: `server unreachable: none of the ${errorPayloads.length} error probes was answered (the first got ${noResponse(firstFailure, timeout)}), so there are no error responses to scan`,
          };
        }

        const issues: string[] = [];
        for (const text of errorResponses) {
          for (const pattern of STACK_TRACE_PATTERNS) {
            if (pattern.test(text)) {
              issues.push(`Response contains: ${pattern.source} (matched in: ${text.substring(0, 80)}...)`);
              break; // One match per response is enough
            }
          }
        }
        if (issues.length > 0) return { passed: false, details: issues.slice(0, 3).join("; ") };
        return {
          passed: true,
          details: `${errorResponses.length} error responses checked — no stack traces or sensitive data found`,
        };
      },
    );

    await test(
      "security-error-no-internal-ip",
      "Error responses do not leak internal IPs",
      "security",
      false,
      "basic",
      async () => {
        if (transport.kind === "stdio") {
          return {
            passed: true,
            details:
              "Skipped: the error probe is a raw HTTP request, which a stdio target cannot receive, so no error response was scanned",
            skipped: true,
          };
        }
        // Trigger an error and check for internal IPs
        let text: string;
        try {
          const res = await request(backendUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              ...buildHeaders(),
            },
            body: JSON.stringify({ jsonrpc: "2.0", id: nextId(), method: "___trigger_error___" }),
            signal: rawHttpSignal(),
          });
          text = await res.body.text();
        } catch (err: unknown) {
          if (options.signal?.aborted) throw err;
          // Before: PASS "No response to check (connection error)" -- a
          // pass on a request nothing answered.
          return {
            passed: false,
            details: `${unreachable("the error probe (an unknown method)", err, timeout).details}, so there is no error response to scan`,
          };
        }
        for (const pattern of INTERNAL_IP_PATTERNS) {
          const match = text.match(pattern);
          if (match) {
            return { passed: false, details: `Error response contains internal IP: ${match[0]}` };
          }
        }
        return { passed: true, details: "No internal IP addresses found in error responses" };
      },
    );

    await test(
      "security-rate-limiting",
      "Rate limiting is enforced",
      "security",
      false,
      "basic/transports#streamable-http",
      async () => {
        // Send a burst of 50 rapid requests
        const burstSize = 50;
        let got429 = false;
        /** Why the first request that got no response got none. */
        let firstError: unknown;
        const promises = Array.from({ length: burstSize }, () =>
          mcpRequest(backendUrl, "ping", undefined, nextId, buildHeaders(), timeout)
            .then((res) => {
              if (res.statusCode === 429) got429 = true;
              return res;
            })
            .catch((err: unknown) => {
              firstError ??= err;
              return null;
            }),
        );
        const responses = await Promise.all(promises);
        if (got429) {
          return { passed: true, details: `Rate limiting detected (429 returned after ${burstSize} rapid requests)` };
        }
        throwIfAborted(options.signal);
        const statusCodes = responses.map((res) => res?.statusCode ?? 0);
        // A burst nothing answered measured no limiter, missing or not.
        if (statusCodes.every((c) => c === 0)) {
          return unreachable(`every one of the ${burstSize} rapid pings`, firstError, timeout);
        }
        const errorCount = statusCodes.filter((c) => c >= 500).length;
        if (errorCount > burstSize / 2) {
          return {
            passed: false,
            details: `Server returned ${errorCount}/${burstSize} 5xx errors under load — should return 429 instead of crashing`,
          };
        }
        const observed = [...new Set(statusCodes)].join(",");
        if (statusCodes.every((c) => c === 401 || c === 403)) {
          // A burst refused before it reached a handler measured no limiter
          // either, and the refusal is read the way security-auth-required
          // reads it (readAuthRefusal): a 403 that neither asks for a
          // credential nor refuses the one sent is what a Host guard, an
          // Origin check or a gateway answers every request with, so the
          // credential is not what to check. The verdict stays a failure,
          // as for any burst that drew no 429.
          const refusals = responses.map((res) => (res ? readAuthRefusal(res, hasAuthHeader) : undefined));
          const unattributed = refusals.find((r) => r?.kind === "forbidden");
          if (unattributed) {
            const quoted = unattributed.message ? ` (${JSON.stringify(unattributed.message)})` : "";
            return {
              passed: false,
              details: `HTTP ${observed}${quoted} on all ${burstSize} rapid pings, which does not read as an auth refusal -- not evaluable: it may be Host/Origin validation or a gateway refusing every request before the server reads it, so rate limiting was not measured (see security-auth-required)`,
            };
          }
          const refusal = refusals.find((r) => r !== undefined);
          const hint = refusal ? authRefusalHint(refusal, "pass --auth") : "pass --auth";
          return {
            passed: false,
            details: `HTTP ${observed} on all ${burstSize} rapid pings -- not evaluable: an auth gate answered before the server read the requests (${hint}), so rate limiting was not measured`,
          };
        }
        return {
          passed: false,
          details: `No rate limiting detected (${burstSize} rapid requests all returned ${observed})`,
        };
      },
    );

    // ── 10. SESSION CLEANUP (runs last to avoid breaking other tests) ──

    await test(
      "transport-delete",
      "DELETE accepted or returns 405",
      "transport",
      false,
      "basic/transports#streamable-http",
      async () => {
        const deleteHeaders: Record<string, string> = { ...buildHeaders() };
        const res = await request(backendUrl, {
          method: "DELETE",
          headers: deleteHeaders,
          signal: AbortSignal.timeout(timeout),
        });
        await res.body.text();
        if (res.statusCode === 405) {
          return { passed: true, details: "HTTP 405 Method Not Allowed (acceptable)" };
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          // Session terminated — verify subsequent request with old session ID is rejected
          if (sessionId) {
            try {
              const verifyRes = await mcpRequest(
                backendUrl,
                "ping",
                undefined,
                createIdCounter(99920),
                deleteHeaders,
                timeout,
              );
              if (verifyRes.statusCode === 400 || verifyRes.statusCode === 404 || verifyRes.statusCode === 409) {
                return {
                  passed: true,
                  details: `HTTP ${res.statusCode} (session terminated, post-delete request correctly rejected with ${verifyRes.statusCode})`,
                };
              }
            } catch {
              // Connection refused after delete is also acceptable
              return {
                passed: true,
                details: `HTTP ${res.statusCode} (session terminated, post-delete request rejected)`,
              };
            }
          }
          return { passed: true, details: `HTTP ${res.statusCode} (session termination supported)` };
        }
        // 400/404 are also acceptable (no active session)
        if (res.statusCode === 400 || res.statusCode === 404) {
          return { passed: true, details: `HTTP ${res.statusCode} (no active session, acceptable)` };
        }
        return { passed: false, details: `HTTP ${res.statusCode}` };
      },
    );

    // ── STDIO-SPECIFIC TESTS ─────────────────────────────────────────
    // All gated behind supportsTransport() via transports:["stdio"] in
    // TEST_DEFINITIONS, so they only run for stdio targets.

    await test(
      "stdio-framing",
      "Newline-delimited JSON framing",
      "transport",
      true,
      "basic/transports#stdio",
      async () => {
        // Fire 5 rapid pings. If the server frames responses incorrectly,
        // the transport's line-splitter will fail to parse one or more.
        const results = await Promise.all(
          Array.from({ length: 5 }, () => rpc("ping").catch((e: Error) => ({ _err: e.message }))),
        );
        const failed = results.filter((r) => "_err" in (r as object));
        if (failed.length) {
          return { passed: false, details: `${failed.length}/5 rapid pings failed — framing likely broken` };
        }
        return { passed: true, details: "5/5 rapid pings returned cleanly" };
      },
    );

    await test("stdio-unicode", "UTF-8 unicode roundtrip", "transport", false, "basic/transports#stdio", async () => {
      // Judged the way the 2026-07-28 check judges it: push the probe
      // (Latin-1, CJK, an emoji) through a tool when one is available
      // (pickUnicodeTool) and pass when it comes back byte-for-byte, or
      // every piece of it for a tool that tokenizes its input; fail only on
      // EVIDENCE of mangling (U+FFFD, a Latin-1 mis-decode, '?'
      // substitution, the non-ASCII characters stripped, a -32700). A reply
      // that merely lacks the probe means the tool did not echo its input,
      // so the verdict then rests on the envelope: a ping whose _meta
      // carries the probe (the 2026-07-28 check's server/discover carries
      // it in its clientInfo name), which the server parsing and answering
      // is the round-trip verified. With no tool to call -- none declared,
      // none listed, or a tools/list that failed -- the envelope decides
      // alone. A request that gets no reply fails, and so does one answered
      // by a child that exits right after it: a plain ping between the two
      // probes finds a child the tools/call killed, and after the last
      // answered probe one bounded wait (UNICODE_EXIT_GRACE_MS) and then a
      // plain ping find one that crashes a moment after answering, the ping
      // also one whose exit a loaded machine reports late (each ping's
      // budget capped at LIVENESS_PING_MS). A child that exited on the
      // check's probes is restarted (restartStdioServer) so the tests after
      // it measure the server, and one already gone before them is "server
      // unreachable". A caller's abort is rethrown.
      const stdio = transport as StdioTransport;
      /** The probe the child answered last, until a verdict that needs no liveness reading is reached. */
      let answered = null as { what: string; cause: string } | null;
      /** The verdict for a child gone after answering `probe`, which is restarted. */
      const exitedAfter = async (probe: { what: string; cause: string }): Promise<LegacyOutcome> => {
        answered = null;
        const verdict = {
          passed: false,
          details: `${probe.what} was answered, but the server exited right after (server exited (code ${stdio.exitCode ?? "unknown"}))`,
        };
        await restartStdioServer("stdio-unicode", probe.cause);
        return verdict;
      };
      /**
       * Send one request carrying the probe: its answer, or the verdict for
       * none. `what` opens the details; `cause` names the request in the
       * restart's warning.
       */
      const send = async (
        what: string,
        cause: string,
        method: string,
        params: unknown,
      ): Promise<{ body: any } | { verdict: LegacyOutcome }> => {
        // Gone after answering an earlier probe of this check: that probe killed it.
        if (stdio.exited && answered) return { verdict: await exitedAfter(answered) };
        const alreadyGone = stdio.exited === true;
        try {
          const body = (await rpc(method, params)).body;
          answered = { what, cause };
          return { body };
        } catch (err: unknown) {
          if (options.signal?.aborted) throw err;
          answered = null;
          if (alreadyGone) return { verdict: unreachable(what, err, timeout) };
          if (!stdio.exited) {
            return {
              verdict: { passed: false, details: `${what} got no reply (${clipAscii(errorLine(err, 200), 100)})` },
            };
          }
          const verdict = {
            passed: false,
            details: `${what} got no reply (server exited (code ${stdio.exitCode ?? "unknown"}))`,
          };
          await restartStdioServer("stdio-unicode", cause);
          return { verdict };
        }
      };
      /**
       * Whether the child is gone after answering a probe: one plain ping
       * (the 2026-07-28 check sends a server/discover). An answer, an
       * error, or no answer within its capped budget is a live child; the
       * transport fails the ping the moment the child's exit is reported.
       */
      const goneAfterPing = async (): Promise<boolean> => {
        try {
          await mcpRequest(backendUrl, "ping", undefined, nextId, buildHeaders(), Math.min(timeout, LIVENESS_PING_MS));
        } catch (err: unknown) {
          if (options.signal?.aborted) throw err;
        }
        return stdio.exited;
      };
      const judge = async (): Promise<LegacyOutcome> => {
        let tools: unknown[] | null = cachedToolsList;
        if (tools === null && hasTools) {
          // tools-list did not run (a filtered run): ask for the list now.
          try {
            const listed = (await rpc("tools/list")).body?.result?.tools;
            if (Array.isArray(listed)) tools = listed;
          } catch (err: unknown) {
            if (options.signal?.aborted) throw err;
          }
        }
        let note = "";
        const tool = hasTools && tools ? pickUnicodeTool(tools) : null;
        if (tool) {
          const name = clipAscii(tool.name, 60);
          const what = `tools/call ${name} with a CJK/emoji argument`;
          const sent = await send(what, what, "tools/call", {
            name: tool.name,
            arguments: Object.fromEntries(tool.args.map((arg) => [arg, UNICODE_PROBE])),
          });
          if ("verdict" in sent) return sent.verdict;
          const serialized = JSON.stringify(sent.body) ?? "";
          if (serialized.includes(UNICODE_PROBE)) {
            return { passed: true, details: `tools/call ${name} reproduced the CJK/emoji probe byte-for-byte` };
          }
          if (reproducesEveryUnicodePiece(serialized)) {
            return {
              passed: true,
              details: `tools/call ${name} reproduced every non-ASCII piece of the CJK/emoji probe (split across the reply, not byte-for-byte)`,
            };
          }
          const error = sent.body?.error;
          if (error?.code === -32700) {
            return { passed: false, details: `tools/call ${name} with a CJK/emoji argument -> -32700 parse error` };
          }
          const mangled = unicodeManglingEvidence(serialized);
          if (mangled) {
            return {
              passed: false,
              details: `tools/call ${name} mangled the CJK/emoji probe: ${mangled} (got ${firstTextOf(sent.body)})`,
            };
          }
          // Rejected (unknown arguments, a schema mismatch) or answered
          // without reflecting its arguments: nothing to compare, so the
          // envelope probe decides -- sent to a child the tools/call did
          // not kill.
          if (await goneAfterPing()) return exitedAfter({ what, cause: what });
          note = error
            ? `tools/call ${name} rejected the probe (${errorWithCode(error.code)}); `
            : `tools/call ${name} did not echo the probe; `;
        }
        const envelope = "ping with a CJK/emoji _meta value";
        const sent = await send(`${note}${envelope}`, envelope, "ping", {
          _meta: { [UNICODE_META_KEY]: UNICODE_PROBE },
        });
        if ("verdict" in sent) return sent.verdict;
        const error = sent.body?.error;
        if (error) return { passed: false, details: `${note}${envelope} -> ${errorWithCode(error.code)}` };
        if (sent.body?.result === undefined) {
          return { passed: false, details: `${note}${envelope} -> non-JSON-RPC reply` };
        }
        const serialized = JSON.stringify(sent.body) ?? "";
        if (serialized.includes(UNICODE_PROBE)) {
          return { passed: true, details: `${note}ping reproduced the CJK/emoji _meta value byte-for-byte` };
        }
        const mangled = unicodeManglingEvidence(serialized);
        if (mangled) return { passed: false, details: `${note}ping mangled the CJK/emoji _meta value: ${mangled}` };
        return {
          passed: true,
          details: `${note}envelope round-trip verified: ping answered a request whose _meta carries CJK/emoji (no echo path to compare byte-for-byte)`,
        };
      };
      const verdict = await judge();
      if (answered === null) return verdict;
      // The verdict read an answer. A child that answered and exited a
      // moment later is the verdict instead, so the check after this one is
      // not blamed for the crash: one bounded wait finds the exit, and a
      // plain ping after it an exit the child made in that window but a
      // loaded machine has not reported yet (the ping is never answered,
      // and fails once it is).
      const probe = answered;
      if ((await exitsWithin(stdio, UNICODE_EXIT_GRACE_MS, options.signal)) || (await goneAfterPing())) {
        return exitedAfter(probe);
      }
      return verdict;
    });

    await test(
      "stdio-unknown-method-recovers",
      "Recovers after unknown method",
      "transport",
      false,
      "basic/transports#stdio",
      async () => {
        // Send an unknown method; server should reply with JSON-RPC error.
        const errRes = await rpc("this/method/does/not/exist-xyzzy");
        const errBody = errRes.body as { error?: { code?: number }; result?: unknown };
        if (!errBody.error) {
          return { passed: false, details: "Unknown method did not produce a JSON-RPC error" };
        }
        // Now send a valid request; server must still be alive.
        const okRes = await rpc("ping");
        const okBody = okRes.body as { error?: unknown; result?: unknown };
        if (okBody.error) {
          return {
            passed: false,
            details: "Server responded with error to ping after unknown method — may have desynced",
          };
        }
        return { passed: true, details: "Unknown method returned JSON-RPC error; subsequent ping succeeded" };
      },
    );

    // Drain any still-pending parallel tests before finalizing the
    // report. Individual sequential tests already barrier, but if the
    // last-declared test was parallel-safe we still have work in flight
    // when we get here. MUST happen before warning dedup/cap below —
    // draining can push more warnings.
    await drainPool();

    // Dedup + cap warnings: a server with, say, 60 tools all missing
    // descriptions produces 60 near-identical lines that crowd out every
    // other signal.
    harness.finalizeWarnings();

    return assembleReport({
      specVersion: LEGACY_SPEC_VERSION,
      toolVersion: TOOL_VERSION,
      url: displayUrl,
      tests,
      warnings,
      serverInfo,
      toolCount,
      toolNames,
      resourceCount,
      resourceNames,
      promptCount,
      promptNames,
    });
  } finally {
    // Always close the transport — swallow any close error so we don't
    // mask the real failure that brought us here.
    await transport.close().catch(() => {});
  }
}
