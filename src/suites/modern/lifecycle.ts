import { errorCodeText, errorWithCode } from "../../checks/validators.js";
import { readAuthRefusal } from "../../detect.js";
import type { TestOutcome } from "../../harness.js";
import {
  createModernClient,
  describeResponse,
  errorOf,
  type RpcOptions,
  type RpcResponse,
  resultOf,
} from "../../modern/client.js";
import { JSONRPC_ERROR_CODES, META, MODERN_ERROR_CODES, metaOf } from "../../modern/meta.js";
import { LEGACY_SPEC_VERSION, MODERN_SPEC_VERSION } from "../../spec.js";
import type { Transport, TransportStream } from "../../transport/index.js";
import type { StdioTransport } from "../../transport/stdio.js";
import {
  ensurePrompts,
  ensureResources,
  ensureResourceTemplates,
  ensureTools,
  hasCapability,
  hasCompletions,
  hasPrompts,
  hasResources,
  hasTools,
  LIST_METHOD,
  LIST_TEST_ID,
  type ListKey,
  listUnavailable,
  type ModernSuiteContext,
  publishList,
} from "./context.js";
import { discoverTwin, gateVerdict, httpStatusText, resendOn429 } from "./gate.js";
import { classifyTransportError, restartStdioServer } from "./security.js";

/**
 * Lifecycle category of the 2026-07-28 suite. There is no handshake in
 * this era: `server/discover` is the first request the suite trusts and
 * its result seeds every capability gate, so `runLifecycle` runs first
 * and populates `ctx.state` before registering its own tests.
 * `runLifecycleLate` holds the tests that need the feature lists
 * (completions, progress), the two claim-less `_meta` probes, and the
 * legacy `initialize` probe. The claim-less probes run late because a
 * dual-era stdio server (the SDK 2.0 default) that has not yet been
 * pinned modern by a non-discover request treats ANY claim-less message
 * as a legacy opening and pins the whole process to legacy semantics; by
 * the time the late tests run, the feature modules have pinned it modern
 * (and a `--only` run that skipped them sends one modern request first,
 * see `ensureEraPinned`) and the probes draw the -32602 the spec
 * requires. The initialize probe goes to a fresh child on stdio for the
 * mirror-image reason. The whole late block runs BEFORE the security
 * module: its rate-limit burst can leave an intermediary answering 429
 * for a while, and a bare 429 must not be read as the server rejecting a
 * malformed request (see `transportLevelRejection`).
 */

const ACK_METHOD = "notifications/subscriptions/acknowledged";
const PROGRESS_METHOD = "notifications/progress";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Every YYYY-MM-DD in prose (the versions a rejected initialize SHOULD name). */
const VERSION_MENTION_RE = /\d{4}-\d{2}-\d{2}/g;
const UNSUPPORTED_VERSION = "1999-01-01";
const PROGRESS_TOKEN = "compliance-progress-1";
const VENDOR_META_KEY = "com.example.compliance/probe";
/**
 * JSON-RPC id of the legacy initialize sent to a FRESH stdio child: the
 * first (and only) request that process sees, so a low id is what a real
 * legacy client would send. Distinct from the suite's counter (1000+) and
 * the raw transport probes (99901+), so the recorder correlates it.
 */
const LEGACY_INITIALIZE_ID = 1;
/**
 * HTTP statuses an auth gate, a size limit, a media-type gate or a rate
 * limiter answers BEFORE the JSON-RPC layer reads the request. None of
 * them is the server's verdict on the request body, so a negative probe
 * that draws one measured nothing (the same list error-id-echo exempts).
 */
export const TRANSPORT_LEVEL_STATUS: Record<number, string> = {
  401: "an auth gate",
  403: "an auth gate",
  413: "a body-size limit",
  415: "a media-type gate",
  429: "rate limiting",
};
/**
 * How long a fresh stdio child spawned WITHOUT any input is watched
 * before "it stayed up" is concluded (lifecycle-dual-era, see
 * `exitsAtStartup`): at least this, and at least three times as long as
 * the child that exited took to do so.
 */
const IDLE_PROBE_FLOOR_MS = 2000;
const IDLE_PROBE_POLL_MS = 50;

/**
 * The JSON-RPC errors that are a server's own refusal of the conformant
 * server/discover -- one that does not speak 2026-07-28 (-32601), or refuses
 * the request's envelope, `_meta` or standard headers (-32600, -32602,
 * -32020, -32021, -32022). A gateway with no backend has not read the
 * request and cannot produce them, so lifecycle-jsonrpc credits one on a 5xx
 * (see gateVerdict).
 */
const DISCOVER_REFUSAL_CODES: readonly number[] = [
  JSONRPC_ERROR_CODES.INVALID_REQUEST,
  JSONRPC_ERROR_CODES.METHOD_NOT_FOUND,
  JSONRPC_ERROR_CODES.INVALID_PARAMS,
  MODERN_ERROR_CODES.HEADER_MISMATCH,
  MODERN_ERROR_CODES.MISSING_REQUIRED_CLIENT_CAPABILITY,
  MODERN_ERROR_CODES.UNSUPPORTED_PROTOCOL_VERSION,
];

/** Removed in 2026-07-28; each must draw a JSON-RPC error. `initialize` is probed separately (lifecycle-dual-era). */
const REMOVED_METHOD_PROBES: Array<[string, Record<string, unknown>]> = [
  ["ping", {}],
  ["logging/setLevel", { level: "info" }],
  ["resources/subscribe", { uri: "test://x" }],
];

let stringIdSeq = 0;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function describeType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  return typeof v === "object" ? "an object" : typeof v;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** First line of an error message, clipped, so transport diagnostics do not flood a details string. */
function short(text: string, max = 100): string {
  const line = text.split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

function listOf(values: unknown[], max = 6): string {
  const shown = values.slice(0, max).map((v) => (typeof v === "string" ? v : JSON.stringify(v)));
  return values.length > max ? `${shown.join(", ")}, ... (${values.length} total)` : shown.join(", ");
}

/** " (HTTP 400)" on HTTP, "" on stdio. */
function statusOf(ctx: ModernSuiteContext, res: RpcResponse): string {
  return ctx.kind === "http" ? ` (HTTP ${res.statusCode})` : "";
}

function fail(details: string): TestOutcome {
  return { passed: false, details };
}

function pass(details: string): TestOutcome {
  return { passed: true, details };
}

/**
 * A pass that judged nothing, flagged as a skip (see `TestOutcome.skipped`):
 * the probe drew no answer from the server itself to read -- none at all, a
 * gate's answer instead, or no probe could be sent.
 */
function unanswered(details: string): TestOutcome {
  return { passed: true, details, skipped: true };
}

/** The setup `server/discover` exchange, shared by the lifecycle tests. */
interface DiscoverProbe {
  /** The response, or null when the transport produced none (timeout, crash, connection failure). */
  res: RpcResponse | null;
  /** Transport-level failure message when `res` is null. */
  error: string | null;
  /** The DiscoverResult object, when the response carried one. */
  result: Record<string, unknown> | undefined;
  /** The wait before the discover's one resend when a rate limiter answered it 429 over HTTP (resendOn429); null when it was not resent. */
  throttledMs: number | null;
  /** The discover was answered 429 and its resend got no answer (`error` is the resend's). */
  resendLost: boolean;
}

function describeProbeFailure(probe: DiscoverProbe, ctx: ModernSuiteContext): string {
  if (!probe.res) {
    if (probe.resendLost) {
      return `server unreachable: server/discover answered HTTP 429, and its resend got no response (${short(probe.error ?? "unknown error", 80)})`;
    }
    return `server/discover got no response (${short(probe.error ?? "unknown error")})`;
  }
  const status = ctx.kind === "http" ? ` (${httpStatusText(probe.res.statusCode, probe.throttledMs)})` : "";
  return `server/discover answered ${describeResponse(probe.res)}${status}`;
}

/**
 * Populate `ctx.state` from a DiscoverResult. Anything malformed is left
 * at its empty default so a later capability gate reads "not declared"
 * rather than crashing on a boolean where an object was expected.
 */
function seedState(ctx: ModernSuiteContext, res: RpcResponse, result: Record<string, unknown>): void {
  ctx.state.discover = res;
  ctx.state.supportedVersions = Array.isArray(result.supportedVersions)
    ? result.supportedVersions.filter((v): v is string => typeof v === "string")
    : [];
  ctx.state.capabilities = isObject(result.capabilities) ? result.capabilities : {};
  const info = metaOf(result)?.[META.serverInfo];
  ctx.state.serverInfo = {
    name: isObject(info) && typeof info.name === "string" ? info.name : null,
    version: isObject(info) && typeof info.version === "string" ? info.version : null,
  };
  ctx.state.instructions = typeof result.instructions === "string" ? result.instructions : null;
}

/**
 * Why a rejection of a deliberately malformed request cannot be credited
 * to the injected defect: the CONFORMANT setup `server/discover` was
 * itself rejected (or never answered), so the server rejects everything
 * and the negative probe measured nothing. Null when the discover result
 * is in hand. Shared by the `_meta` tests here and the header tests in
 * transport.ts; every negative probe reads it after seeing a rejection.
 * `about` names what the probe varied, for a probe whose variation is
 * not a defect (lifecycle-meta-client-info-optional omits an optional
 * field).
 */
export function notEvaluable(ctx: ModernSuiteContext, about = "the injected defect"): string | null {
  if (ctx.state.discover) return null;
  const rejection = ctx.state.discoverRejection;
  if (!rejection) {
    return `not evaluable: the conformant server/discover got no response, so this rejection proves nothing about ${about}`;
  }
  const code = rejection.code === null ? "no JSON-RPC error code" : errorCodeText(rejection.rawCode);
  const status = ctx.kind === "http" ? ` (HTTP ${rejection.statusCode})` : "";
  return `not evaluable: the conformant server/discover was itself rejected with ${code}${status}, so this rejection proves nothing about ${about}`;
}

/**
 * Why an HTTP rejection cannot be credited to the injected defect: the
 * status is one an auth gate, size limit, media-type gate or rate
 * limiter answers before the JSON-RPC layer reads the request (401, 403,
 * 413, 415, 429). A gateway that rate-limits the security burst answers
 * every later request 429 for a while, and that says nothing about
 * whether the server validates `_meta` or the standard headers. Null on
 * stdio and for every other status. Read AFTER `notEvaluable`, which
 * names the root cause when the conformant discover drew the same gate.
 * `about` as for `notEvaluable`.
 */
export function transportLevelRejection(
  ctx: ModernSuiteContext,
  res: RpcResponse,
  about = "the injected defect",
): string | null {
  if (ctx.kind !== "http") return null;
  const source = TRANSPORT_LEVEL_STATUS[res.statusCode];
  if (!source) return null;
  return `not evaluable: HTTP ${res.statusCode} is a transport-level rejection (${source} answered before the JSON-RPC layer read the request), so it proves nothing about ${about}`;
}

/**
 * Whether a transport error is the request deadline elapsing (undici's
 * TimeoutError / HeadersTimeoutError names; the stdio transport's "timed
 * out after" message) rather than a connection failure or an exit.
 */
function isTimeout(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  if (typeof name === "string" && /timeout/i.test(name)) return true;
  return /\btimed out\b/i.test(messageOf(err));
}

/**
 * Shared verdict for the "request must be rejected" tests: a result
 * fails, a JSON-RPC error with `expectedCode` passes, any other code
 * passes with a warning, and on HTTP the status must be 400 (basic/index
 * #meta: "the server MUST reject it with JSON-RPC error code -32602 ...
 * On HTTP, the response status MUST be 400 Bad Request"). A bare HTTP 400
 * with no JSON-RPC body (an intermediary rejecting the request, which
 * streamable-http lets answer with a status alone) is accepted with a
 * warning: it is a rejection, just not a diagnosable one. Any other bare
 * status fails for the status, as `evaluateHeaderRejection` in
 * transport.ts does: a 404 or a plain-text 500 crash is not the 400 the
 * spec requires -- unless it is a transport-level gate
 * (401/403/413/415/429), which is not evaluable (see
 * `transportLevelRejection`). Any rejection is credited only when the
 * conformant discover was served (see `notEvaluable`).
 */
async function expectRejection(
  ctx: ModernSuiteContext,
  id: string,
  what: string,
  expectedCode: number,
  send: () => Promise<RpcResponse>,
): Promise<TestOutcome> {
  let res: RpcResponse;
  try {
    res = await send();
  } catch (err) {
    return fail(`${what}: no response (${short(messageOf(err))})`);
  }
  const status = statusOf(ctx, res);
  if (resultOf(res.body)) {
    return fail(`${what}: server returned a result${status} (expected JSON-RPC error ${expectedCode})`);
  }
  const unattributable = notEvaluable(ctx) ?? transportLevelRejection(ctx, res);
  if (unattributable) return fail(`${what}: ${unattributable}`);
  const err = errorOf(res.body);
  if (!err) {
    if (ctx.kind === "http" && res.statusCode >= 400) {
      if (res.statusCode !== 400) {
        return fail(
          `${what}: rejected with HTTP ${res.statusCode} and no JSON-RPC error body (expected HTTP 400 with JSON-RPC error ${expectedCode})`,
        );
      }
      ctx.harness.warnings.push(
        `${id}: ${what} was rejected with HTTP ${res.statusCode} but no JSON-RPC error body (expected ${expectedCode})`,
      );
      return pass(`${what}: rejected with HTTP ${res.statusCode}, no JSON-RPC error body (see warning)`);
    }
    return fail(`${what}: neither result nor JSON-RPC error in the response${status}`);
  }
  if (ctx.kind === "http" && res.statusCode !== 400) {
    return fail(`${what}: ${errorWithCode(err.rawCode)} with HTTP ${res.statusCode} (expected 400)`);
  }
  if (err.code !== expectedCode) {
    ctx.harness.warnings.push(
      `${id}: ${what} was rejected with ${errorCodeText(err.rawCode)}${err.message ? ` (${short(err.message, 60)})` : ""} (expected ${expectedCode})`,
    );
    return pass(
      `${what}: rejected with ${errorCodeText(err.rawCode)}${status}, expected ${expectedCode} (see warning)`,
    );
  }
  return pass(`${what}: rejected with ${errorCodeText(err.rawCode)}${status}`);
}

/**
 * Problems with an UnsupportedProtocolVersionError's `data`: `supported`
 * must be a non-empty array of strings that is a subset of the versions
 * `server/discover` advertised (when known), and `requested` must echo
 * the version the request declared. Exported for unit tests: the fixture
 * has no knob for a non-subset `supported` list.
 */
export function unsupportedVersionDataProblems(data: unknown, requested: string, known: readonly string[]): string[] {
  const problems: string[] = [];
  const obj = isObject(data) ? data : undefined;
  const supported = obj?.supported;
  if (!Array.isArray(supported) || supported.length === 0) {
    problems.push("data.supported missing or empty");
  } else {
    const foreign = supported.filter((v) => typeof v !== "string" || (known.length > 0 && !known.includes(v)));
    if (foreign.length > 0) {
      problems.push(
        `data.supported [${listOf(supported)}] is not a subset of supportedVersions [${listOf([...known])}]: ${listOf(foreign)}`,
      );
    }
  }
  if (obj?.requested !== requested) {
    problems.push(`data.requested ${obj ? JSON.stringify(obj.requested) : "missing"} (expected "${requested}")`);
  }
  return problems;
}

/**
 * Where a rejected legacy `initialize` names the versions the server
 * supports (basic/versioning: a modern-only server SHOULD name them "in
 * any error it returns to an initialize request"): in `data.supported`
 * (the UnsupportedProtocolVersionError shape -- a non-empty string array),
 * in the message (a YYYY-MM-DD other than the version the probe itself
 * requested, which a message merely echoing the rejected version does not
 * satisfy), or both. Null when neither names one. Exported for unit
 * tests: the fixture has no knob for a data-only rejection.
 */
export function supportedVersionsNamedIn(
  err: { message: string; data?: unknown },
  requested: string = LEGACY_SPEC_VERSION,
): string | null {
  const supported = isObject(err.data) ? err.data.supported : undefined;
  const inData = Array.isArray(supported) && supported.length > 0 && supported.every((v) => typeof v === "string");
  const mentioned = err.message.match(VERSION_MENTION_RE) ?? [];
  const inMessage = mentioned.some((v) => v !== requested);
  if (inData && inMessage) return "message and data.supported name supported versions";
  if (inData) return "data.supported names supported versions";
  if (inMessage) return "message names supported versions";
  return null;
}

export async function runLifecycle(ctx: ModernSuiteContext): Promise<void> {
  const { harness, client } = ctx;

  // ── Setup: the discover exchange every capability gate reads ──────
  // A rate limiter's 429 is resent once after Retry-After (resendOn429), as
  // every probe of the suite is, and the second answer is the discover's:
  // lifecycle-discover and its siblings, lifecycle-jsonrpc, the capability
  // gates and notEvaluable all read that one answer, so a server throttled
  // once is measured instead of read as rejecting everything. The latency
  // is the exchange that decided, not the wait before it.
  const probe: DiscoverProbe = { res: null, error: null, result: undefined, throttledMs: null, resendLost: false };
  let sentAt = Date.now();
  try {
    const first = await client.rpc("server/discover", {}, { timeout: ctx.startupTimeout });
    probe.resendLost = ctx.kind === "http" && first.statusCode === 429;
    const decided = await resendOn429(ctx, first, () => {
      sentAt = Date.now();
      return client.rpc("server/discover", {});
    });
    probe.resendLost = false;
    probe.res = decided.res;
    probe.throttledMs = decided.throttledMs;
    probe.result = resultOf(probe.res.body);
    ctx.state.discoverLatencyMs = Date.now() - sentAt;
  } catch (err) {
    probe.error = messageOf(err);
  }
  if (probe.res && probe.result) {
    seedState(ctx, probe.res, probe.result);
  } else if (probe.res) {
    // The conformant request was rejected: remember how, so the negative
    // probes can tell "rejected the defect" from "rejects everything".
    // `code` is null only when the body is no JSON-RPC error at all; an
    // error whose code is missing or not a number keeps NaN there, and
    // `rawCode` what was sent (rendered by errorCodeText).
    const err = errorOf(probe.res.body);
    ctx.state.discoverRejection = {
      code: err ? err.code : null,
      rawCode: err?.rawCode,
      statusCode: probe.res.statusCode,
    };
  }

  await harness.check("lifecycle-discover", async () => {
    const { result } = probe;
    if (!result || !probe.res) return fail(describeProbeFailure(probe, ctx));
    const problems: string[] = [];
    if (!Array.isArray(result.supportedVersions)) {
      problems.push(`supportedVersions is ${describeType(result.supportedVersions)}, expected an array`);
    }
    if (!isObject(result.capabilities)) {
      problems.push(`capabilities is ${describeType(result.capabilities)}, expected an object`);
    }
    if (problems.length > 0) return fail(`DiscoverResult invalid: ${problems.join("; ")}`);
    const caps = Object.keys(result.capabilities as object);
    return pass(
      `supportedVersions [${listOf(result.supportedVersions as unknown[])}], capabilities: ${caps.length ? caps.join(", ") : "(none)"}${statusOf(ctx, probe.res)}`,
    );
  });

  await harness.check("lifecycle-discover-versions", async () => {
    const { result } = probe;
    if (!result) return fail(`${describeProbeFailure(probe, ctx)}; supportedVersions unavailable`);
    const raw = result.supportedVersions;
    if (!Array.isArray(raw) || raw.length === 0) {
      return fail("supportedVersions missing or empty (expected a non-empty array of YYYY-MM-DD strings)");
    }
    const malformed = raw.filter((v) => typeof v !== "string" || !DATE_RE.test(v));
    if (malformed.length > 0) {
      return fail(`supportedVersions has malformed entries: ${listOf(malformed)} (expected YYYY-MM-DD strings)`);
    }
    if (!raw.includes(MODERN_SPEC_VERSION)) {
      // Same wording as the suite-level warning so the two dedupe.
      harness.warnings.push(
        `Server advertises supportedVersions [${raw.join(", ")}] without ${MODERN_SPEC_VERSION}; tests still run against ${MODERN_SPEC_VERSION}.`,
      );
    }
    return pass(`supportedVersions: ${listOf(raw)}${raw.includes(MODERN_SPEC_VERSION) ? "" : " (see warning)"}`);
  });

  await harness.check("lifecycle-discover-caching", async () => {
    const { result } = probe;
    if (!result) return fail(`${describeProbeFailure(probe, ctx)}; no caching hints to check`);
    const problems: string[] = [];
    const ttl = result.ttlMs;
    if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < 0) {
      problems.push(`ttlMs ${ttl === undefined ? "missing" : JSON.stringify(ttl)} (expected an integer >= 0)`);
    }
    const scope = result.cacheScope;
    if (scope !== "public" && scope !== "private") {
      problems.push(
        `cacheScope ${scope === undefined ? "missing" : JSON.stringify(scope)} (expected "public" or "private")`,
      );
    }
    if (problems.length > 0) return fail(problems.join("; "));
    return pass(`ttlMs=${ttl}, cacheScope=${scope}`);
  });

  await harness.check("lifecycle-jsonrpc", async () => {
    if (!probe.res) return fail(describeProbeFailure(probe, ctx));
    const res = probe.res;
    if (ctx.kind === "http" && !resultOf(res.body)) {
      // A discover answered without a result may not have been answered by
      // the server at all: an envelope something in front of it wrote (a
      // gateway's -32001 "Unauthorized" on its 401, echoing the id) is no
      // evidence of the server's JSON-RPC, however valid. Read the way the
      // error checks read a rejection (gateVerdict), on the answer the setup
      // exchange settled on (a 429 there was already resent once after
      // Retry-After): an auth gate, a 429 again, a 5xx without a server's own
      // refusal of the discover, or a 403 without a Bearer challenge -- which
      // refused the conformant request itself, so nothing is left to compare
      // it with -- is not evaluable. A server's own refusal code on a 5xx is
      // credited, with a warning about the status.
      const reason = await gateVerdict(ctx, res, {
        check: "lifecycle-jsonrpc",
        what: "the conformant server/discover",
        about: "the server's JSON-RPC envelope",
        ownCodes: DISCOVER_REFUSAL_CODES,
        twin: "self",
      });
      if (reason) {
        const err = errorOf(res.body);
        const answer = err ? errorWithCode(err.rawCode) : "no JSON-RPC error body";
        return fail(
          `server/discover answered ${answer} (${httpStatusText(res.statusCode, probe.throttledMs)}); ${reason}`,
        );
      }
    }
    /** "; resent once after HTTP 429" when the envelope judged is the resent discover's. */
    const resent = probe.throttledMs !== null ? "; resent once after HTTP 429" : "";
    const body = res.body;
    if (!isObject(body)) return fail(`response body is ${describeType(body)}, expected a JSON-RPC object`);
    const problems: string[] = [];
    if (body.jsonrpc !== "2.0") problems.push(`jsonrpc=${JSON.stringify(body.jsonrpc)} (expected "2.0")`);
    if (body.id !== res.requestId) {
      problems.push(`id=${JSON.stringify(body.id)} does not echo request id ${JSON.stringify(res.requestId)}`);
    }
    const hasResult = "result" in body;
    const hasError = "error" in body;
    if (hasResult && hasError) problems.push("both result and error present");
    if (!hasResult && !hasError) problems.push("neither result nor error present");
    if (hasResult && !isObject(body.result))
      problems.push(`result is ${describeType(body.result)}, expected an object`);
    if (problems.length > 0) return fail(`Invalid JSON-RPC 2.0 envelope: ${problems.join("; ")}`);
    return pass(
      `Valid JSON-RPC 2.0 response (id ${JSON.stringify(body.id)} echoed, ${hasResult ? "result" : "error"}${resent})`,
    );
  });

  await harness.check("lifecycle-id-match", async () => {
    let res: RpcResponse;
    try {
      res = await client.rpc("server/discover", {});
    } catch (err) {
      const sent = ctx.recorder.sent[ctx.recorder.sent.length - 1];
      return fail(
        `no response matched request id ${JSON.stringify(sent?.id)} within ${ctx.timeout}ms; a retyped or dropped id never resolves (${short(messageOf(err), 60)})`,
      );
    }
    const body = res.body;
    const id = isObject(body) ? body.id : undefined;
    if (id === undefined) return fail(`No id in response${statusOf(ctx, res)}`);
    if (id === res.requestId)
      return pass(`Request id=${JSON.stringify(res.requestId)}, response id=${JSON.stringify(id)} (match)`);
    return fail(
      `Request id=${JSON.stringify(res.requestId)} (${typeof res.requestId}), response id=${JSON.stringify(id)} (${typeof id}): MISMATCH`,
    );
  });

  await harness.check("lifecycle-string-id", async () => {
    const stringId = `compliance-str-${++stringIdSeq}`;
    let res: RpcResponse;
    try {
      res = await client.rpc("server/discover", {}, { id: stringId });
    } catch (err) {
      return fail(
        `no response echoed string id "${stringId}" within ${ctx.timeout}ms; a coerced or dropped id never resolves (${short(messageOf(err), 60)})`,
      );
    }
    const id = isObject(res.body) ? res.body.id : undefined;
    if (id === stringId) return pass(`String id "${stringId}" echoed back as a string`);
    if (id === undefined) return fail(`No id in response${statusOf(ctx, res)}`);
    return fail(`String id "${stringId}" sent, got back id=${JSON.stringify(id)} (${typeof id})`);
  });

  await harness.check("lifecycle-capabilities", async () => {
    const { result } = probe;
    if (!result) return fail(`${describeProbeFailure(probe, ctx)}; no capabilities object`);
    const caps = result.capabilities;
    if (!isObject(caps)) return fail(`capabilities is ${describeType(caps)}, expected an object`);
    const declared = Object.entries(caps).filter(([, v]) => v !== undefined);
    const bad = declared.filter(([, v]) => !isObject(v)).map(([k, v]) => `${k} is ${describeType(v)}`);
    if (bad.length > 0) return fail(`Declared capabilities must be objects: ${bad.join(", ")}`);
    return pass(
      declared.length > 0 ? `Capabilities: ${declared.map(([k]) => k).join(", ")}` : "Empty capabilities (valid)",
    );
  });

  await harness.check("lifecycle-server-info", async () => {
    const { result } = probe;
    if (!result) return fail(`${describeProbeFailure(probe, ctx)}; no serverInfo`);
    const info = metaOf(result)?.[META.serverInfo];
    if (!isObject(info)) return fail(`No _meta["${META.serverInfo}"] object on the discover result`);
    if (typeof info.name !== "string" || typeof info.version !== "string") {
      return fail(`serverInfo needs string name and version, got ${short(JSON.stringify(info), 80)}`);
    }
    return pass(`${info.name} v${info.version}`);
  });

  await harness.check("lifecycle-instructions", async () => {
    const { result } = probe;
    if (!result) return fail(describeProbeFailure(probe, ctx));
    if (result.instructions === undefined) return pass("No instructions field (optional)");
    if (typeof result.instructions === "string") return pass(`Instructions: "${short(result.instructions, 80)}"`);
    return fail(`instructions should be a string, got ${describeType(result.instructions)}`);
  });

  // The two claim-less `_meta` probes (no _meta at all; _meta without
  // protocolVersion) live in runLifecycleLate -- see the module comment.
  // This one still carries a protocolVersion claim, so it cannot re-select
  // a dual-era server's era and stays early.
  await harness.check("lifecycle-meta-client-capabilities-required", () =>
    expectRejection(
      ctx,
      "lifecycle-meta-client-capabilities-required",
      "server/discover without _meta clientCapabilities",
      JSONRPC_ERROR_CODES.INVALID_PARAMS,
      () => client.rpc("server/discover", {}, { meta: { [META.clientCapabilities]: undefined } }),
    ),
  );

  await harness.check("lifecycle-meta-client-info-optional", async () => {
    let res: RpcResponse;
    try {
      res = await client.rpc("server/discover", {}, { meta: { [META.clientInfo]: undefined } });
    } catch (err) {
      return fail(`server/discover without clientInfo: no response (${short(messageOf(err))})`);
    }
    const status = statusOf(ctx, res);
    const err = errorOf(res.body);
    const served = resultOf(res.body);
    if (err || !served) {
      const refusal = err
        ? `server/discover without clientInfo rejected with ${errorCodeText(err.rawCode)}${status}`
        : `server/discover without clientInfo: no result${status}`;
      // Blame clientInfo only when the conformant discover (clientInfo
      // included) was served and no gate answered before the JSON-RPC
      // layer (see notEvaluable, transportLevelRejection): a server that
      // rejects everything, or a rate limiter, says nothing about whether
      // it treats clientInfo as optional.
      const about = "omitting clientInfo";
      const unattributable = served ? null : (notEvaluable(ctx, about) ?? transportLevelRejection(ctx, res, about));
      if (unattributable) return fail(`${refusal}; ${unattributable}`);
      return fail(err ? `${refusal}; clientInfo is optional` : refusal);
    }
    if (ctx.kind === "http" && (res.statusCode < 200 || res.statusCode >= 300)) {
      return fail(`server/discover without clientInfo returned a result with HTTP ${res.statusCode} (expected 2xx)`);
    }
    return pass(`Served server/discover without clientInfo${status}`);
  });

  await harness.check("lifecycle-version-unsupported", async () => {
    const what = `server/discover declaring protocol version ${UNSUPPORTED_VERSION}`;
    let res: RpcResponse;
    try {
      res = await client.rpc("server/discover", {}, { protocolVersion: UNSUPPORTED_VERSION });
    } catch (err) {
      return fail(`${what}: no response (${short(messageOf(err))})`);
    }
    const status = statusOf(ctx, res);
    if (resultOf(res.body)) return fail(`${what} was served (result)${status}; expected -32022`);
    const err = errorOf(res.body);
    if (!err) return fail(`${what}: no JSON-RPC error in the response${status} (expected -32022)`);
    if (err.code !== MODERN_ERROR_CODES.UNSUPPORTED_PROTOCOL_VERSION) {
      return fail(
        `${what}: rejected with ${errorCodeText(err.rawCode)}${status}, expected -32022 UnsupportedProtocolVersionError`,
      );
    }
    const problems: string[] = [];
    if (ctx.kind === "http" && res.statusCode !== 400) problems.push(`HTTP ${res.statusCode} (expected 400)`);
    problems.push(...unsupportedVersionDataProblems(err.data, UNSUPPORTED_VERSION, ctx.state.supportedVersions));
    if (problems.length > 0) return fail(`-32022 returned but ${problems.join("; ")}`);
    const supported = (err.data as { supported: unknown[] }).supported;
    return pass(`-32022${status}; data.supported [${listOf(supported)}], data.requested ${UNSUPPORTED_VERSION}`);
  });

  await harness.check("lifecycle-removed-methods", async () => {
    const failures: string[] = [];
    const summary: string[] = [];
    let warned = false;
    // A rejection is credited only when the conformant discover was served
    // (see notEvaluable): a server that rejects everything also rejects
    // ping, and that says nothing about whether ping was removed.
    const unattributable = notEvaluable(ctx);
    for (const [method, params] of REMOVED_METHOD_PROBES) {
      let res: RpcResponse;
      try {
        res = await client.rpc(method, params);
      } catch (err) {
        failures.push(`${method}: no response (${short(messageOf(err), 60)})`);
        continue;
      }
      if (resultOf(res.body)) {
        failures.push(`${method}: served (result)${statusOf(ctx, res)}`);
        continue;
      }
      const err = errorOf(res.body);
      if (unattributable) {
        summary.push(`${method} ${err ? errorCodeText(err.rawCode) : `HTTP ${res.statusCode}`}`);
        continue;
      }
      // A gate that answered before the JSON-RPC layer (401/403/413/415/429,
      // see transportLevelRejection) says nothing about the method, body or no.
      const gated = transportLevelRejection(ctx, res);
      if (gated) {
        failures.push(`${method}: ${gated}`);
        continue;
      }
      if (!err) {
        // streamable-http: a server that does not implement the method "MUST
        // respond with 404 Not Found and a JSON-RPC error with code -32601".
        // A bare 404 has the status but not the body that tells it from a
        // legacy server's 404: credited with a warning, as expectRejection
        // credits a bare 400. Any other bare status (a 400 validator, a 500
        // crash page, a 405 route) is not that answer.
        if (ctx.kind === "http" && res.statusCode === 404) {
          harness.warnings.push(
            `lifecycle-removed-methods: ${method} rejected with HTTP ${res.statusCode} but no JSON-RPC error body`,
          );
          warned = true;
          summary.push(`${method} HTTP ${res.statusCode}`);
        } else if (ctx.kind === "http" && res.statusCode >= 400) {
          failures.push(
            `${method}: rejected with HTTP ${res.statusCode} and no JSON-RPC error body (expected HTTP 404 with JSON-RPC error -32601)`,
          );
        } else {
          failures.push(`${method}: neither result nor JSON-RPC error${statusOf(ctx, res)}`);
        }
        continue;
      }
      if (err.code !== JSONRPC_ERROR_CODES.METHOD_NOT_FOUND) {
        harness.warnings.push(
          `lifecycle-removed-methods: ${method} rejected with ${errorCodeText(err.rawCode)} (expected -32601 Method not found)`,
        );
        warned = true;
      } else if (ctx.kind === "http" && res.statusCode !== 404) {
        harness.warnings.push(
          `lifecycle-removed-methods: ${method} answered -32601 with HTTP ${res.statusCode} (expected 404)`,
        );
        warned = true;
      }
      summary.push(`${method} ${errorCodeText(err.rawCode)}${ctx.kind === "http" ? `/${res.statusCode}` : ""}`);
    }
    if (failures.length > 0) return fail(failures.join("; "));
    if (unattributable) return fail(`${summary.join(", ")} rejected; ${unattributable}`);
    return pass(`${summary.join(", ")}${warned ? " (see warnings)" : ""}`);
  });

  await harness.check("lifecycle-capability-handlers-match", async () => {
    if (!probe.result) return fail(`${describeProbeFailure(probe, ctx)}; capability declarations unknown`);
    const features: Array<[string, string, ListKey]> = [
      ["tools", "tools/list", "tools"],
      ["resources", "resources/list", "resources"],
      ["prompts", "prompts/list", "prompts"],
    ];
    const failures: string[] = [];
    const summary: string[] = [];
    for (const [cap, method, key] of features) {
      const declared = hasCapability(ctx, cap);
      let res: RpcResponse;
      try {
        res = await client.rpc(method, {});
      } catch (err) {
        failures.push(`${cap}: ${method} got no response (${short(messageOf(err), 60)})`);
        continue;
      }
      const result = resultOf(res.body);
      const err = errorOf(res.body);
      if (declared) {
        // A declared list this check obtained is the list: publish it so a
        // `--only lifecycle` run's later readers (progress, completions)
        // reuse it through ensureList instead of sending it again.
        ctx.state.listAttempts.add(key);
        const items = publishList(ctx, key, res) ?? (Array.isArray(result?.[key]) ? (result[key] as unknown[]) : null);
        if (items) summary.push(`${cap}: declared, ${items.length} listed`);
        else if (result) failures.push(`${cap}: declared but ${method} result has no ${key} array`);
        else failures.push(`${cap}: declared but ${method} returned ${describeResponse(res)}${statusOf(ctx, res)}`);
        continue;
      }
      if (!err) {
        failures.push(
          `${cap}: not declared but ${method} ${result ? "returned a result" : "gave no JSON-RPC error"}${statusOf(ctx, res)}`,
        );
        continue;
      }
      if (err.code !== JSONRPC_ERROR_CODES.METHOD_NOT_FOUND) {
        harness.warnings.push(
          `lifecycle-capability-handlers-match: undeclared ${method} rejected with ${errorCodeText(err.rawCode)} (expected -32601)`,
        );
      }
      summary.push(`${cap}: undeclared, ${method} -> ${errorCodeText(err.rawCode)}`);
    }
    if (failures.length > 0) return fail(failures.join("; "));
    return pass(summary.join("; "));
  });

  await harness.check("lifecycle-subscriptions-listen", () => checkSubscriptionsListen(ctx));

  await harness.check("lifecycle-meta-tolerance", async () => {
    let res: RpcResponse;
    try {
      res = await client.rpc("server/discover", {}, { meta: { [VENDOR_META_KEY]: "x" } });
    } catch (err) {
      return fail(`server/discover with an extra _meta key: no response (${short(messageOf(err))})`);
    }
    const status = statusOf(ctx, res);
    const err = errorOf(res.body);
    const served = resultOf(res.body);
    if (err || !served) {
      const refusal = err
        ? `server/discover with unknown _meta key "${VENDOR_META_KEY}" rejected with ${errorCodeText(err.rawCode)}${status}`
        : `server/discover with an extra _meta key: no result${status}`;
      // Blame the key only when the conformant discover (the same envelope
      // without it) was served and no gate answered before the JSON-RPC
      // layer (see notEvaluable, transportLevelRejection), as
      // lifecycle-meta-client-info-optional does: a server that rejects
      // everything, or a rate limiter, says nothing about unknown keys.
      const about = "the unknown _meta key";
      const unattributable = served ? null : (notEvaluable(ctx, about) ?? transportLevelRejection(ctx, res, about));
      if (unattributable) return fail(`${refusal}; ${unattributable}`);
      return fail(err ? `${refusal}; unknown keys must be ignored` : refusal);
    }
    return pass(`Served server/discover with unknown _meta key "${VENDOR_META_KEY}"`);
  });
}

/**
 * The listen filter the suite requests: every listChanged the server
 * advertises. `advertised` names what gates the acknowledgment
 * requirement (resources.subscribe counts, though with no URI to
 * subscribe to it adds nothing to the filter). Exported for unit tests.
 */
export function listenFilterFor(capabilities: Record<string, unknown>): {
  filter: Record<string, boolean>;
  advertised: string[];
} {
  const flag = (cap: string, key: string) => {
    const c = capabilities[cap];
    return isObject(c) && c[key] === true;
  };
  const filter: Record<string, boolean> = {};
  const advertised: string[] = [];
  if (flag("tools", "listChanged")) {
    filter.toolsListChanged = true;
    advertised.push("tools.listChanged");
  }
  if (flag("prompts", "listChanged")) {
    filter.promptsListChanged = true;
    advertised.push("prompts.listChanged");
  }
  if (flag("resources", "listChanged")) {
    filter.resourcesListChanged = true;
    advertised.push("resources.listChanged");
  }
  // resources.subscribe advertises resources/updated; the suite has no URI to
  // subscribe to, so it counts as "advertised" without adding to the filter.
  if (flag("resources", "subscribe")) advertised.push("resources.subscribe");
  return { filter, advertised };
}

async function checkSubscriptionsListen(ctx: ModernSuiteContext): Promise<TestOutcome> {
  const { filter, advertised } = listenFilterFor(ctx.state.capabilities);
  const isAdvertised = advertised.length > 0;
  const listenTimeout = Math.min(3000, ctx.timeout);
  const advertisedNote = isAdvertised
    ? `${advertised.join(", ")} advertised`
    : "nothing subscription-related advertised";

  // A 429 is resent once after Retry-After, and the second answer decides
  // (resendOn429), as for the error checks.
  const open = async () => {
    const opened = await ctx.client.stream(
      "subscriptions/listen",
      { notifications: filter },
      { timeout: listenTimeout },
    );
    return { statusCode: opened.statusCode ?? 0, headers: opened.headers ?? {}, stream: opened };
  };
  let stream: TransportStream;
  let throttledMs: number | null = null;
  try {
    const first = await open();
    // The 429's status and headers are all that is read of it.
    if (ctx.kind === "http" && first.statusCode === 429) await first.stream.close();
    ({
      res: { stream },
      throttledMs,
    } = await resendOn429(ctx, first, open));
  } catch (err) {
    // An aborted run is not a verdict: let the harness see the abort.
    if (ctx.signal?.aborted) throw err;
    return fail(`subscriptions/listen: no response (${short(messageOf(err))})`);
  }

  // Read until the first notification or the response to the listen itself.
  let first: Record<string, unknown> | undefined;
  let response: Record<string, unknown> | undefined;
  try {
    for await (const msg of stream.messages) {
      if (!isObject(msg)) continue;
      if (typeof msg.method === "string" && msg.id === undefined) {
        first = msg;
        break;
      }
      if (msg.id === stream.requestId && ("result" in msg || "error" in msg)) {
        response = msg;
        break;
      }
    }
  } finally {
    await stream.close();
  }
  // Both transports end the iterator quietly on an abort, exactly as on
  // the listen timeout: with no frame in hand, the wait was cut short by
  // the run, not by a server that never acknowledged. Not a verdict.
  if (!first && !response && ctx.signal?.aborted) throw ctx.signal.reason ?? new Error("Aborted");

  const httpStatus =
    ctx.kind === "http" && stream.statusCode !== undefined
      ? ` (${httpStatusText(stream.statusCode, throttledMs)})`
      : "";
  const err = response ? errorOf(response) : undefined;
  // A rejection counts as "unsupported, and said so" only when the
  // conformant discover was served (see notEvaluable): a server that
  // rejects everything proves nothing by rejecting the listen too.
  const unattributable = notEvaluable(ctx);
  // Nor when something in front of the server answered in its place
  // (gateVerdict, as for the error checks): an auth gate (a gateway's 401
  // with a -32001 body that echoes the id), a 429 still a 429 after one
  // resend, a 5xx without -32601, or a 403 the conformant twin could not get
  // past either. Read for a JSON-RPC error and for a bare status >= 400
  // alike. With something advertised no rejection is the server's right
  // answer, so no 5xx is credited there -- but a -32601 on a 5xx is still
  // the server's own answer (a gateway with no backend has not read the
  // request and cannot produce it): it is not gated, and fails below as the
  // server refusing a method it advertises.
  const rejected = !!err || (!first && !response && stream.statusCode !== undefined && stream.statusCode >= 400);
  const ownRefusalOn5xx =
    isAdvertised && err?.code === JSONRPC_ERROR_CODES.METHOD_NOT_FOUND && (stream.statusCode ?? 0) >= 500;
  if (rejected && !unattributable && !ownRefusalOn5xx && ctx.kind === "http" && stream.statusCode !== undefined) {
    const reason = await gateVerdict(
      ctx,
      { statusCode: stream.statusCode, headers: stream.headers ?? {}, body: response },
      {
        check: "lifecycle-subscriptions-listen",
        what: "subscriptions/listen",
        about: "subscriptions/listen",
        ownCodes: isAdvertised ? [] : [JSONRPC_ERROR_CODES.METHOD_NOT_FOUND],
        twin: discoverTwin(ctx),
      },
    );
    if (reason) {
      const answer = err ? `rejected with ${errorCodeText(err.rawCode)}` : "rejected";
      return fail(`subscriptions/listen ${answer}${httpStatus}; ${reason}`);
    }
  }
  if (err) {
    if (isAdvertised) {
      return fail(
        `subscriptions/listen rejected with ${errorCodeText(err.rawCode)}${httpStatus} although ${advertisedNote}`,
      );
    }
    if (unattributable) {
      return fail(`subscriptions/listen rejected with ${errorCodeText(err.rawCode)}${httpStatus}; ${unattributable}`);
    }
    if (err.code !== JSONRPC_ERROR_CODES.METHOD_NOT_FOUND) {
      ctx.harness.warnings.push(
        `lifecycle-subscriptions-listen: rejected with ${errorCodeText(err.rawCode)} (expected -32601 when unsupported)`,
      );
    }
    return pass(`${advertisedNote}; subscriptions/listen rejected with ${errorCodeText(err.rawCode)}${httpStatus}`);
  }
  if (response) return fail(`subscriptions/listen ended with a result before any acknowledgment${httpStatus}`);
  if (!first) {
    if (ctx.kind === "http" && stream.statusCode !== undefined && stream.statusCode >= 400) {
      if (isAdvertised)
        return fail(`subscriptions/listen rejected up front with HTTP ${stream.statusCode} although ${advertisedNote}`);
      if (unattributable)
        return fail(`subscriptions/listen rejected with HTTP ${stream.statusCode}; ${unattributable}`);
      ctx.harness.warnings.push(
        `lifecycle-subscriptions-listen: rejected with HTTP ${stream.statusCode} but no JSON-RPC error body`,
      );
      return pass(`${advertisedNote}; subscriptions/listen rejected with HTTP ${stream.statusCode}, no JSON-RPC body`);
    }
    if (stream.exit) {
      const how = stream.exit.signal ? `signal ${stream.exit.signal}` : `code ${stream.exit.code}`;
      return fail(`server exited (${how}) after subscriptions/listen before any acknowledgment; ${advertisedNote}`);
    }
    return fail(`No acknowledgment within ${listenTimeout}ms of subscriptions/listen${httpStatus}; ${advertisedNote}`);
  }
  const problem = acknowledgmentProblem(first, stream.requestId);
  if (problem) return fail(problem);
  const honoured = (first.params as Record<string, unknown>).notifications as Record<string, unknown>;
  const surplus = acknowledgmentSurplus(honoured, filter);
  if (surplus.length > 0) {
    ctx.harness.warnings.push(
      `lifecycle-subscriptions-listen: acknowledgment honours ${surplus.join(", ")}; the listen request did not ask for that, so the server may send notifications outside the requested filter`,
    );
  }
  return pass(
    `Acknowledged subscription ${JSON.stringify(stream.requestId)} first; honoured ${short(JSON.stringify(honoured), 80)}${surplus.length > 0 ? " (see warning)" : ""}`,
  );
}

/**
 * Why the first notification on a listen stream is not a valid
 * acknowledgment, or undefined when it is: it must be
 * notifications/subscriptions/acknowledged, its _meta subscriptionId must
 * equal the listen request id (same JSON type: "1" is not 1), and it must
 * carry a notifications object. Exported for unit tests: no fixture knob
 * retypes the subscription id.
 */
export function acknowledgmentProblem(first: Record<string, unknown>, requestId: string | number): string | undefined {
  if (first.method !== ACK_METHOD) {
    return `First frame on the listen stream was ${String(first.method)}, expected ${ACK_METHOD}`;
  }
  const params = isObject(first.params) ? first.params : undefined;
  const subscriptionId = metaOf(params)?.[META.subscriptionId];
  if (subscriptionId !== requestId) {
    return `Acknowledgment _meta subscriptionId ${JSON.stringify(subscriptionId)} does not equal the listen request id ${JSON.stringify(requestId)}`;
  }
  if (!params || !isObject(params.notifications)) {
    return "Acknowledgment has no notifications object naming the honoured filter";
  }
  return undefined;
}

/**
 * What an acknowledgment honours beyond the filter the listen requested:
 * a `true` for a listChanged type the request did not ask for, a
 * resourceSubscriptions URI the request did not name, or a value of the
 * wrong type. The ack "reflects the subset the server agreed to honor"
 * (basic/patterns/subscriptions#acknowledgment), so a surplus entry is a
 * server that may send notifications outside the requested filter; the
 * spec puts no MUST on the ack's contents, so the caller warns rather
 * than fails. Exported for unit tests: no fixture knob over-declares.
 */
export function acknowledgmentSurplus(honoured: Record<string, unknown>, requested: Record<string, unknown>): string[] {
  const surplus: string[] = [];
  for (const [key, value] of Object.entries(honoured)) {
    if (key === "resourceSubscriptions") {
      if (!Array.isArray(value)) {
        surplus.push(`resourceSubscriptions ${JSON.stringify(value)} (expected an array of URIs)`);
        continue;
      }
      const asked = Array.isArray(requested.resourceSubscriptions) ? requested.resourceSubscriptions : [];
      for (const uri of value) {
        if (!asked.includes(uri)) surplus.push(`resourceSubscriptions ${JSON.stringify(uri)} (not requested)`);
      }
      continue;
    }
    if (typeof value !== "boolean") {
      surplus.push(`${key}: ${JSON.stringify(value)} (expected a boolean)`);
      continue;
    }
    if (value && requested[key] !== true) surplus.push(`${key}: true (not requested)`);
  }
  return surplus;
}

/** Verdict over the progress notifications observed for one request. */
export interface ProgressVerdict {
  ok: boolean;
  problem?: string;
  values: number[];
}

/**
 * Every notifications/progress observed for a request must echo its
 * progressToken and carry a strictly increasing progress value
 * (basic/patterns/progress: "MUST increase with each notification").
 * Exported so the rule is unit-testable without a fixture that misbehaves.
 */
export function evaluateProgress(token: string | number, notifications: unknown[]): ProgressVerdict {
  const values: number[] = [];
  for (const n of notifications) {
    const params = isObject(n) && isObject(n.params) ? n.params : undefined;
    if (!params) return { ok: false, problem: `${PROGRESS_METHOD} without a params object`, values };
    if (params.progressToken !== token) {
      return {
        ok: false,
        problem: `${PROGRESS_METHOD} carries token ${JSON.stringify(params.progressToken)}, expected ${JSON.stringify(token)}`,
        values,
      };
    }
    const progress = params.progress;
    if (typeof progress !== "number" || Number.isNaN(progress)) {
      return { ok: false, problem: `${PROGRESS_METHOD} progress ${JSON.stringify(progress)} is not a number`, values };
    }
    const previous = values[values.length - 1];
    if (previous !== undefined && progress <= previous) {
      return {
        ok: false,
        problem: `progress did not increase (${previous} -> ${progress})`,
        values: [...values, progress],
      };
    }
    values.push(progress);
  }
  return { ok: true, values };
}

function requiresArguments(inputSchema: unknown): boolean {
  return isObject(inputSchema) && Array.isArray(inputSchema.required) && inputSchema.required.length > 0;
}

/**
 * The tool to call with a progressToken: one without required arguments
 * (so `arguments: {}` is valid), preferring one that advertises progress
 * in its name or description, else the first listed tool.
 */
function pickProgressTool(tools: unknown[]): Record<string, unknown> | undefined {
  const named = tools.filter(isObject).filter((t) => typeof t.name === "string");
  const noArgs = named.filter((t) => !requiresArguments(t.inputSchema));
  const mentionsProgress = (t: Record<string, unknown>) =>
    /progress/i.test(String(t.name)) || /progress/i.test(typeof t.description === "string" ? t.description : "");
  return noArgs.find(mentionsProgress) ?? noArgs[0] ?? named[0];
}

/** ASCII-only, whitespace-collapsed, bounded copy of server-supplied text (a tool name, an error message) for a details string. */
function clipDetail(text: string, max: number): string {
  const ascii = text.replace(/\s+/g, " ").replace(/[^\x20-\x7e]/g, "?");
  return ascii.length > max ? `${ascii.slice(0, max - 3)}...` : ascii;
}

/**
 * What a request that got no response ran into, read from the error the
 * way the security checks read it (classifyTransportError): "no response
 * within Nms" for a timeout, "no response (connection closed: ...)" for a
 * connection the server closed or a stdio child that exited, "no response
 * (connection failed: ...)" otherwise.
 */
function noResponseTo(ctx: ModernSuiteContext, err: unknown): string {
  const failure = classifyTransportError(err);
  if (failure === "timeout") return `no response within ${ctx.timeout}ms`;
  const how = failure === "dropped" ? "connection closed" : "connection failed";
  return `no response (${how}: ${clipDetail(short(messageOf(err), 200), 90)})`;
}

/** One tools/call of lifecycle-progress-token: its answer, and the notifications/progress observed for it. */
interface ProgressCall {
  /** The response, or null when none came back (timeout, connection failure, a stdio child that exited). */
  res: RpcResponse | null;
  /** The transport error when `res` is null. */
  err?: unknown;
  notifications: unknown[];
  /** The wait before the call's one resend when a rate limiter answered it 429 over HTTP (resendOn429); null when it was not resent. */
  throttledMs: number | null;
  /** The call was answered 429 and its resend got no answer (`err` is the resend's). */
  resendLost: boolean;
  /** stdio: the child was gone before the call was sent, so the call measured nothing (and nothing is restarted). */
  alreadyGone: boolean;
  /**
   * stdio: the child exited on this call, not before it -- "exit code 3:
   * <stderr summary>" (describeExit). It has been replaced since
   * (restartStdioServer), so the calls and checks after it reach a live
   * process.
   */
  exit?: string;
}

/**
 * The tools/call lifecycle-progress-token sends: `name` with no arguments,
 * carrying `_meta.progressToken` next to the conformant envelope when
 * `withToken`, and otherwise identical (the same envelope, the same
 * standard headers). A 429 over HTTP is resent once after Retry-After
 * (resendOn429), and the second answer is the call's. The
 * notifications/progress it drew are collected from the response (HTTP:
 * they ride its stream) and from the recording (stdio: only the recorder
 * sees them), unioned by identity so the HTTP copies are not counted twice.
 *
 * On stdio a child that exits on the call (alive when it was sent) is
 * replaced before this returns (restartStdioServer, whose warning names the
 * call as `call` carrying or without the token), as the security checks and
 * stdio-unicode replace one their own request killed, so the next call and
 * the checks after this one reach a live process; with no way to spawn one,
 * a warning says the rest ran against the exited process. A child already
 * gone before the call is left as it is. A caller's abort is rethrown; any
 * other transport error comes back as `err`.
 */
async function sendProgressCall(
  ctx: ModernSuiteContext,
  name: string,
  inputSchema: unknown,
  withToken: boolean,
  call: string,
): Promise<ProgressCall> {
  const seqStart = ctx.recorder.received.length;
  const params: Record<string, unknown> = { name, arguments: {} };
  if (withToken) params._meta = { progressToken: PROGRESS_TOKEN };
  const child = ctx.kind === "stdio" ? (ctx.transport as StdioTransport) : undefined;
  const alreadyGone = child?.exited === true;
  let res: RpcResponse | null = null;
  let err: unknown;
  let throttledMs: number | null = null;
  let resendLost = false;
  try {
    const rpc = () => ctx.client.rpc("tools/call", params, { toolInputSchema: inputSchema });
    const first = await rpc();
    resendLost = ctx.kind === "http" && first.statusCode === 429;
    ({ res, throttledMs } = await resendOn429(ctx, first, rpc));
    resendLost = false;
  } catch (e) {
    if (ctx.signal?.aborted) throw e;
    err = e;
  }
  const seen = new Set<unknown>();
  const notifications: unknown[] = [];
  const consider = (m: unknown) => {
    if (isObject(m) && m.method === PROGRESS_METHOD && !seen.has(m)) {
      seen.add(m);
      notifications.push(m);
    }
  };
  for (const m of res?.messages ?? []) consider(m);
  for (const r of ctx.recorder.received.slice(seqStart)) consider(r.message);
  const sent: ProgressCall = { res, notifications, throttledMs, resendLost, alreadyGone };
  if (!res) sent.err = err;
  if (!res && child && !alreadyGone && child.exited) {
    // Read before the restart replaces ctx.transport.
    sent.exit = await describeExit(child);
    const cause = `${call} ${withToken ? "carrying" : "without"} _meta.progressToken`;
    if (ctx.replaceStdioProcess) {
      await restartStdioServer(ctx, "lifecycle-progress-token", cause);
    } else {
      ctx.harness.warnings.push(
        `lifecycle-progress-token: the server exited on ${cause} (${sent.exit}); the tests after it ran against the exited process.`,
      );
    }
  }
  return sent;
}

/** Whether the call was served: a result (on HTTP, on a 2xx). */
function servedCall(ctx: ModernSuiteContext, res: RpcResponse): boolean {
  if (!resultOf(res.body)) return false;
  return ctx.kind !== "http" || (res.statusCode >= 200 && res.statusCode < 300);
}

/**
 * What answered the call in the server's place, or undefined: on HTTP a
 * 429 (a rate limiter; the call has already been resent once), or a 401 / a
 * 403 carrying a Bearer challenge (an auth gate, read the way
 * readAuthRefusal reads one). A 403 without a challenge is not a gate here:
 * whether it refused the token is for the same call without it to say.
 */
function gateOnCall(ctx: ModernSuiteContext, res: RpcResponse): string | undefined {
  if (ctx.kind !== "http") return undefined;
  if (res.statusCode === 429) return TRANSPORT_LEVEL_STATUS[429];
  const refusal = readAuthRefusal(res, ctx.hasAuth);
  return refusal && refusal.kind !== "forbidden" ? TRANSPORT_LEVEL_STATUS[refusal.statusCode] : undefined;
}

/** A server error on the call: a JSON-RPC error, or on HTTP a status >= 400, other than a gate's answer (gateOnCall). */
function failedCall(ctx: ModernSuiteContext, res: RpcResponse): boolean {
  if (gateOnCall(ctx, res)) return false;
  return errorOf(res.body) !== undefined || (ctx.kind === "http" && res.statusCode >= 400);
}

/**
 * Whether the server went away on the call instead of answering it: the
 * connection it had accepted was closed or reset (classifyTransportError's
 * "dropped"), or the stdio child exited on it. A child already gone before
 * the call was sent is not this call's doing, and a timeout or a connection
 * never established is no answer at all.
 */
function droppedCall(c: ProgressCall): boolean {
  if (c.res || c.alreadyGone) return false;
  return c.exit !== undefined || classifyTransportError(c.err) === "dropped";
}

/**
 * Whether the call failed on the server's side: a server error in its
 * answer (failedCall), or the server going away on it (droppedCall) -- a
 * closed connection counts as a refusal only next to a served twin, which
 * the check asks for before it blames the token.
 */
function callFailed(ctx: ModernSuiteContext, c: ProgressCall): boolean {
  return c.res ? failedCall(ctx, c.res) : droppedCall(c);
}

/**
 * "JSON-RPC error -32602 (Invalid params) (HTTP 400)", "a result (HTTP 200)",
 * "HTTP 502 with no JSON-RPC response"; the status as "HTTP 429, then after
 * 0ms HTTP 400" when the call was resent after a 429.
 */
function callShape(ctx: ModernSuiteContext, res: RpcResponse, throttledMs: number | null = null): string {
  const statusText = httpStatusText(res.statusCode, throttledMs);
  const status = ctx.kind === "http" ? ` (${statusText})` : "";
  const err = errorOf(res.body);
  if (err) {
    const code = clipDetail(errorWithCode(err.rawCode), 80);
    return `${code}${err.message ? ` (${clipDetail(err.message, 60)})` : ""}${status}`;
  }
  if (resultOf(res.body)) return `a result${status}`;
  return ctx.kind === "http" ? `${statusText} with no JSON-RPC response` : "a message with neither result nor error";
}

/**
 * How a call was answered, for a details string: "succeeded", "returned
 * <error>", "answered <shape>", "answered HTTP 401 (an auth gate)", "made
 * the server exit (exit code 3: ...)", "got no response ...".
 */
function callOutcome(ctx: ModernSuiteContext, c: ProgressCall): string {
  if (!c.res) {
    if (c.exit !== undefined) return `made the server exit (${c.exit})`;
    return `${c.resendLost ? "answered HTTP 429, and its resend " : ""}got ${noResponseTo(ctx, c.err)}`;
  }
  if (servedCall(ctx, c.res)) return c.throttledMs === null ? "succeeded" : "succeeded when resent after HTTP 429";
  const gate = gateOnCall(ctx, c.res);
  if (gate) return `answered ${httpStatusText(c.res.statusCode, c.throttledMs)} (${gate})`;
  return `${failedCall(ctx, c.res) ? "returned" : "answered"} ${callShape(ctx, c.res, c.throttledMs)}`;
}

/**
 * How a call failed, for telling whether two calls failed alike: "gone"
 * when the server went away on it (droppedCall); else the JSON-RPC error
 * code its answer carried, whatever the HTTP status (a server that answers
 * a call carrying a progress token on an SSE stream reports the same error
 * on a 200 that a plain JSON answer carries on a 400); else what it carried
 * instead and, on HTTP, its status. Null for a call no answer of the
 * server's own came back to (a timeout, a connection never established).
 */
function failureKey(ctx: ModernSuiteContext, c: ProgressCall): string | null {
  if (droppedCall(c)) return "gone";
  if (!c.res) return null;
  const err = errorOf(c.res.body);
  if (err) return `JSON-RPC error ${errorCodeText(err.rawCode)}`;
  const answer = resultOf(c.res.body) ? "a result" : "no JSON-RPC error";
  return ctx.kind === "http" ? `${answer} on HTTP ${c.res.statusCode}` : answer;
}

/** The details budget every check keeps to. */
const DETAILS_MAX = 220;

/**
 * `render(...parts)` within the details budget: the text around the parts
 * -- the conclusion -- is kept whole, and the parts (the answers quoted)
 * share the room left, a part shorter than its share keeping all of it and
 * the longer ones clipped to what remains.
 */
function fitDetails(render: (...parts: string[]) => string, ...parts: string[]): string {
  const full = render(...parts);
  if (full.length <= DETAILS_MAX) return full;
  let room = DETAILS_MAX - render(...parts.map(() => "")).length;
  const allotted = parts.map(() => 0);
  let open = parts.map((_, i) => i);
  while (open.length > 0) {
    const share = Math.max(0, Math.floor(room / open.length));
    const whole = open.filter((i) => parts[i].length <= share);
    if (whole.length === 0) {
      let extra = room - share * open.length;
      for (const i of open) allotted[i] = share + (extra-- > 0 ? 1 : 0);
      break;
    }
    for (const i of whole) {
      allotted[i] = parts[i].length;
      room -= parts[i].length;
    }
    open = open.filter((i) => !whole.includes(i));
  }
  const clipped = parts.map((p, i) =>
    p.length <= allotted[i] ? p : allotted[i] > 3 ? clipDetail(p, allotted[i]) : "...",
  );
  return clipDetail(render(...clipped), DETAILS_MAX);
}

/**
 * The verdict over the notifications/progress a call drew (evaluateProgress):
 * a failure naming the problem, a pass naming the values, or null when it
 * drew none. `call` is "tools/call <name>", `when` qualifies the answer
 * (" when resent"). A pass settles the check only on a call the server did
 * not fail: next to a failure the check reads on (see lifecycle-progress-token).
 */
function judgeProgress(ctx: ModernSuiteContext, c: ProgressCall, call: string, when = ""): TestOutcome | null {
  const verdict = evaluateProgress(PROGRESS_TOKEN, c.notifications);
  if (!verdict.ok) return fail(clipDetail(`${verdict.problem} (${call} ${callOutcome(ctx, c)}${when})`, 220));
  if (c.notifications.length === 0) return null;
  return pass(
    `${c.notifications.length} ${PROGRESS_METHOD} echoed token "${PROGRESS_TOKEN}" with increasing progress (${listOf(verdict.values, 8)})`,
  );
}

/** The progress note of a lifecycle-progress-token details string when no call drew a notification. */
const NO_PROGRESS = `no ${PROGRESS_METHOD} observed (optional)`;

/**
 * lifecycle-progress-token, once the call without the token failed too, but
 * not the way the call carrying it did (failureKey): a tool whose required
 * arguments the empty call lacks answers -32602 without the token, and exits,
 * drops the connection or answers -32603 with it. That failure clears
 * nothing, so the call carrying the token is resent (`sendAgain`), its
 * progress judged like the first's. Failing the way the first did again,
 * the token is what failed it: FAIL. Served, or answered the way the call
 * without the token was, the first failure was not the token's: a pass.
 * Anything else -- a gate's answer, no answer, a third kind of failure --
 * reproduced nothing: a skip. `judged` is the first call's passing progress
 * verdict, when it drew valid notifications. The details keep to the
 * budget (fitDetails): the answers quoted are clipped, the conclusion kept.
 */
async function resendAfterUnlikeTwin(
  ctx: ModernSuiteContext,
  call: string,
  first: ProgressCall,
  twin: ProgressCall,
  judged: TestOutcome | null,
  sendAgain: () => Promise<ProgressCall>,
): Promise<TestOutcome> {
  const again = await sendAgain();
  const judgedAgain = judgeProgress(ctx, again, call, " when resent");
  if (judgedAgain && (!judgedAgain.passed || !callFailed(ctx, again))) return judgedAgain;
  const observed = judged?.details ?? judgedAgain?.details ?? NO_PROGRESS;
  const withToken = answerText(ctx, first);
  const without = answerText(ctx, twin);
  if (callFailed(ctx, again) && failureKey(ctx, again) === failureKey(ctx, first)) {
    return fail(
      fitDetails(
        (a, b) =>
          `${call} with _meta.progressToken: ${a}, and again when resent; without it: ${b} -- so the token is what failed it`,
        withToken,
        without,
      ),
    );
  }
  if (again.res && servedCall(ctx, again.res)) {
    return pass(
      fitDetails(
        (a, b) => `${call} succeeded when resent with _meta.progressToken (first: ${a}; without it: ${b}); ${observed}`,
        withToken,
        without,
      ),
    );
  }
  if (again.res && !gateOnCall(ctx, again.res) && failureKey(ctx, again) === failureKey(ctx, twin)) {
    return pass(
      fitDetails(
        (a, c) =>
          `${call} with _meta.progressToken: ${a}; resent: ${c}, as without it, so the token is not what failed it; ${observed}`,
        briefAnswer(ctx, first),
        briefAnswer(ctx, again),
      ),
    );
  }
  return unanswered(
    fitDetails(
      (a, b, c) =>
        `${call} with _meta.progressToken: ${a}; without it: ${b}; resent: ${c}; no failure reproduced (not evaluable); ${observed}`,
      briefAnswer(ctx, first),
      briefAnswer(ctx, twin),
      briefAnswer(ctx, again),
    ),
  );
}

/**
 * A call's answer without a verb, for the compact details of
 * resendAfterUnlikeTwin: "JSON-RPC error -32602 (Invalid params) (HTTP
 * 400)", "server exited (exit code 3: ...)", "no response within 5000ms",
 * "HTTP 429, then after 0ms HTTP 429 (rate limiting)".
 */
function answerText(ctx: ModernSuiteContext, c: ProgressCall): string {
  if (!c.res) {
    if (c.exit !== undefined) return `server exited (${c.exit})`;
    return `${c.resendLost ? "HTTP 429, then " : ""}${noResponseTo(ctx, c.err)}`;
  }
  const gate = gateOnCall(ctx, c.res);
  if (gate) return `${httpStatusText(c.res.statusCode, c.throttledMs)} (${gate})`;
  return callShape(ctx, c.res, c.throttledMs);
}

/**
 * `answerText` without the parts a details string can spare when it quotes
 * three answers: the stderr of an exit, the message of a JSON-RPC error.
 */
function briefAnswer(ctx: ModernSuiteContext, c: ProgressCall): string {
  if (c.exit !== undefined) return "server exited";
  if (droppedCall(c)) return "connection closed";
  const err = c.res && !gateOnCall(ctx, c.res) ? errorOf(c.res.body) : undefined;
  if (!c.res || !err) return answerText(ctx, c);
  const status = ctx.kind === "http" ? ` (${httpStatusText(c.res.statusCode, c.throttledMs)})` : "";
  return `${clipDetail(errorWithCode(err.rawCode), 40)}${status}`;
}

/**
 * First variable name of an RFC 6570 template ("{id}", "{?q,lang}",
 * "{+path*}" -> id, q, path): the operator prefix, any further variables
 * in the list, and a modifier (":3", "*") are not part of the name.
 * Undefined for a template with no expression. Exported for unit tests:
 * the fixture lists one simple "{id}" template.
 */
export function firstTemplateVariable(uriTemplate: string): string | undefined {
  const m = /\{([^}]+)\}/.exec(uriTemplate);
  if (!m) return undefined;
  const name = m[1]
    .replace(/^[+#./;?&]/, "")
    .split(",")[0]
    .replace(/[:*].*$/, "")
    .trim();
  return name || undefined;
}

/**
 * How long the fresh-process legacy initialize may wait. The suite's own
 * process has already proven the server starts, so the per-request
 * budget is the base; a pinned stdio run's setup discover was the first
 * exchange with a cold process and bounds its start, so a slow starter
 * gets three times that. Never more than the startup budget.
 */
function freshInitializeBudget(ctx: ModernSuiteContext): number {
  const observed = ctx.state.discoverLatencyMs ?? 0;
  return Math.min(ctx.startupTimeout, Math.max(ctx.timeout, 3 * observed));
}

/**
 * The legacy `initialize` exchange on a FRESH stdio child, recorded like
 * any other exchange. A dual-era stdio server selects its era from how the
 * client opens the process, so on the suite's already-modern process a
 * late initialize is rejected even by a server that serves legacy clients
 * (the SDK 2.0 default); only a fresh process shows what a legacy client
 * actually gets. The caller owns `fresh` and closes it.
 */
async function initializeOnFresh(
  ctx: ModernSuiteContext,
  fresh: Transport,
  params: Record<string, unknown>,
  opts: RpcOptions,
  timeout: number,
): Promise<RpcResponse> {
  const probeClient = createModernClient({
    transport: fresh,
    recorder: ctx.recorder,
    nextId: () => LEGACY_INITIALIZE_ID,
    timeout,
    protocolVersion: ctx.client.protocolVersion,
    clientCapabilities: ctx.client.clientCapabilities,
    clientInfo: ctx.client.clientInfo,
    signal: ctx.signal,
  });
  const unsubscribe = fresh.onMessage((m, meta) => ctx.recorder.recordReceived(m, meta));
  try {
    return await probeClient.rpc("initialize", params, { ...opts, timeout });
  } finally {
    unsubscribe();
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The stderr a dead child left behind, summarised to the lines that name
 * the cause: stack frames ("at ...") and bare punctuation are dropped,
 * the last three meaningful lines are kept, ASCII-fied and clipped. The
 * 'exit' event can land before the parent has read the pipe, so the
 * stream gets a moment to drain first.
 */
async function stderrSummary(dead: StdioTransport): Promise<string> {
  const deadline = Date.now() + 200;
  while (!dead.stderrTail().trim() && Date.now() < deadline) await sleep(20);
  await sleep(20);
  const lines = dead
    .stderrTail()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^at\s/.test(l) && /[A-Za-z0-9]/.test(l))
    .slice(-3)
    .map((l) => l.replace(/[^\x20-\x7e]/g, "?"))
    .join(" | ");
  return lines.length > 120 ? `${lines.slice(0, 117)}...` : lines;
}

/** "exit code 1" / "signal-terminated" plus the stderr summary when there is one. */
async function describeExit(dead: StdioTransport): Promise<string> {
  const code = dead.exitCode === null ? "no exit code" : `exit code ${dead.exitCode}`;
  const stderr = await stderrSummary(dead);
  return stderr ? `${code}: ${stderr}` : code;
}

/**
 * Whether a second instance of the server exits on its own: spawn one,
 * send it NOTHING, and watch it for `graceMs`. A fresh child that died on
 * the legacy initialize could have died for two reasons the suite cannot
 * tell apart from that child alone -- the request killed it, or the
 * server allows one instance at a time (a lock file, a fixed port, an
 * exclusive database) and exits at startup while the suite's own process
 * holds the lock. An idle instance separates them: one that stays up
 * would have served a legacy client, so the request is what the server
 * exits on; one that exits with no input exits regardless of the probe.
 */
async function exitsAtStartup(ctx: ModernSuiteContext, graceMs: number): Promise<string | null> {
  if (!ctx.spawnFresh) return null;
  const idle = ctx.spawnFresh() as StdioTransport;
  try {
    const deadline = Date.now() + graceMs;
    while (!idle.exited && Date.now() < deadline) {
      if (ctx.signal?.aborted) throw ctx.signal.reason ?? new Error("Aborted");
      await sleep(IDLE_PROBE_POLL_MS);
    }
    return idle.exited ? await describeExit(idle) : null;
  } finally {
    await idle.close();
  }
}

/**
 * stdio only: make sure a claim-bearing, non-discover request has reached
 * the process before the claim-less `_meta` probes are sent. The full run
 * gets that from the feature modules; a `--only lifecycle-meta-required`
 * run has sent nothing but the setup discover, which does not pin a
 * dual-era server (the SDK 2.0 default keeps deciding its era until the
 * first modern non-discover request), so its verdict would differ from
 * the full run's. The pin request is a list the server declared (cached
 * for later readers), else `ping` -- any valid modern request pins, and a
 * removed method's -32601 is the cheapest answer to draw.
 */
async function ensureEraPinned(ctx: ModernSuiteContext): Promise<void> {
  if (ctx.kind !== "stdio") return;
  const pinned = ctx.recorder.sent.some(
    (s) =>
      s.id !== undefined &&
      s.method !== "server/discover" &&
      s.meta?.[META.protocolVersion] === ctx.client.protocolVersion,
  );
  if (pinned) return;
  if (hasTools(ctx)) {
    await ensureTools(ctx);
  } else if (hasResources(ctx)) {
    await ensureResources(ctx);
  } else if (hasPrompts(ctx)) {
    await ensurePrompts(ctx);
  } else {
    try {
      await ctx.client.rpc("ping", {});
    } catch {
      // The probes that follow report their own failures.
    }
  }
}

/**
 * Whether resources/templates/list failed only because the method is not
 * served: resources-templates accepts -32601 ("Method not supported"), so
 * for lifecycle-completions that means "no templates", not a broken list.
 * Reads the reason `listFailureReason` recorded ("JSON-RPC error -32601 (...)").
 */
function templatesUnsupported(ctx: ModernSuiteContext): boolean {
  const reason = ctx.state.listFailures.resourceTemplates ?? "";
  return new RegExp(`^JSON-RPC error ${JSONRPC_ERROR_CODES.METHOD_NOT_FOUND}(?: |$)`).test(reason);
}

/**
 * `listUnavailable` over every list a check could have drawn its probe
 * from. One list reads exactly as `listUnavailable`. Several: FAIL naming
 * each list whose owning `-list` test this run filtered out (nothing else
 * in the report names it), else a skip-pass pointing at the owning tests.
 */
function listsUnavailable(ctx: ModernSuiteContext, failed: ListKey[], what: string): TestOutcome {
  const [first] = failed;
  if (failed.length === 1 && first) return listUnavailable(ctx, first, what);
  const unreported = failed.filter((key) => !listUnavailable(ctx, key, what).passed);
  if (unreported.length > 0) {
    const reasons = unreported.map(
      (key) => `${LIST_METHOD[key]} failed (${ctx.state.listFailures[key] ?? "no list obtained"})`,
    );
    return fail(`${reasons.join(" and ")}; ${what}`);
  }
  return pass(
    `skipped: ${failed.map((key) => LIST_METHOD[key]).join(" and ")} failed, ${what} (see ${failed.map((key) => LIST_TEST_ID[key]).join(", ")})`,
  );
}

export async function runLifecycleLate(ctx: ModernSuiteContext): Promise<void> {
  const { harness } = ctx;

  if (hasCompletions(ctx)) {
    await harness.check(
      "lifecycle-completions",
      async () => {
        let ref: Record<string, unknown> | undefined;
        let argument: Record<string, unknown> | undefined;
        let source = "";
        let fallback = false;
        const prompts = await ensurePrompts(ctx);
        let templates: unknown[] | null = null;
        const prompt = (prompts ?? []).find(
          (p) =>
            isObject(p) &&
            typeof p.name === "string" &&
            Array.isArray(p.arguments) &&
            p.arguments.some((a) => isObject(a) && typeof a.name === "string"),
        ) as Record<string, unknown> | undefined;
        if (prompt) {
          const arg = (prompt.arguments as unknown[]).find((a) => isObject(a) && typeof a.name === "string") as Record<
            string,
            unknown
          >;
          ref = { type: "ref/prompt", name: prompt.name };
          argument = { name: arg.name, value: "" };
          source = `prompt "${String(prompt.name)}" argument "${String(arg.name)}"`;
        } else {
          // Templates are consulted even when prompts/list FAILED: a listed
          // template variable is a real argument, so completion/complete is
          // still measured on the server's own data and this rule's claim
          // (the method is served) is fully tested. The broken prompts/list
          // is prompts-list's to report, not this rule's. A failed list only
          // decides the verdict when no argument was found (below).
          templates = await ensureResourceTemplates(ctx);
          for (const t of templates ?? []) {
            if (!isObject(t) || typeof t.uriTemplate !== "string") continue;
            const variable = firstTemplateVariable(t.uriTemplate);
            if (!variable) continue;
            ref = { type: "ref/resource", uri: t.uriTemplate };
            argument = { name: variable, value: "" };
            source = `resource template "${t.uriTemplate}" variable "${variable}"`;
            break;
          }
        }
        if (!ref || !argument) {
          // No listed argument. When a declared list the probe draws from
          // FAILED, the placeholder would pass on -32602 without knowing
          // whether the server lists an argument it cannot complete: report
          // the broken list instead (see listUnavailable). An undeclared
          // capability, a genuinely empty list, or a resources/templates/list
          // answered -32601 (not supported, which resources-templates
          // accepts) leaves nothing to complete and keeps the placeholder.
          const failed: ListKey[] = [];
          if (hasPrompts(ctx) && !prompts) failed.push("prompts");
          if (hasResources(ctx) && !templates && !templatesUnsupported(ctx)) failed.push("resourceTemplates");
          if (failed.length > 0) return listsUnavailable(ctx, failed, "no prompt or template argument to complete");
          // Nothing listed to complete: probe with a placeholder ref, where
          // InvalidParams is an acceptable answer.
          ref = { type: "ref/prompt", name: "__test__" };
          argument = { name: "test", value: "" };
          source = 'probe prompt "__test__" (no prompt or template argument listed)';
          fallback = true;
        }
        let res: RpcResponse;
        try {
          res = await ctx.client.rpc("completion/complete", { ref, argument });
        } catch (err) {
          return fail(`completion/complete for ${source}: no response (${short(messageOf(err), 60)})`);
        }
        const err = errorOf(res.body);
        if (err) {
          if (fallback && err.code === JSONRPC_ERROR_CODES.INVALID_PARAMS) {
            return pass(`InvalidParams for ${source} (acceptable)`);
          }
          return fail(`completion/complete for ${source}: ${describeResponse(res)}${statusOf(ctx, res)}`);
        }
        const result = resultOf(res.body);
        const completion = result && isObject(result.completion) ? result.completion : undefined;
        if (!completion || !Array.isArray(completion.values)) {
          return fail(`completion/complete for ${source}: result has no completion.values array`);
        }
        return pass(`Returned ${completion.values.length} completion(s) for ${source}`);
      },
      { required: true },
    );
  }

  await harness.check("lifecycle-progress-token", async () => {
    if (!hasTools(ctx)) return pass("skipped: server declares no tools");
    const tools = await ensureTools(ctx);
    if (!tools) return listUnavailable(ctx, "tools", "no tool to call with a progressToken");
    if (tools.length === 0) return pass("skipped: server lists no tools");
    const tool = pickProgressTool(tools);
    if (!tool) return pass("skipped: no listed tool has a name");
    // Progress is optional (basic/patterns/progress: a server MAY send no
    // notifications), but what the server does send is judged
    // (evaluateProgress): every notifications/progress for the call MUST
    // carry its token and a progress value that increases with each one.
    //
    // With no notification, the call's own answer is read. Served (or
    // answered in some other way that is no server error) passes. A 429 on
    // any of the calls below is resent once after Retry-After first
    // (sendProgressCall). The call failing on the server's side -- a
    // JSON-RPC error, or on HTTP a status >= 400 other than a rate limiter's
    // 429 or an auth gate's refusal (gateOnCall); or the server going away on
    // it, a closed connection or a stdio child that exits on it (droppedCall,
    // the child replaced before the next call) -- is blamed on the token only
    // once it is reproduced: the same call without the token, sent right
    // after, is served, and the call carrying the token, resent after that,
    // fails again. A tool whose first call fails whatever it carries (a cold
    // backend) is served by then, and passes on the resent call; a failure
    // the server's own answer to the call without the token shares (the same
    // JSON-RPC error code; see failureKey), or that the resent call answers
    // without repeating, stays an observation. A call without the token that
    // fails differently -- a tool whose required arguments the empty call
    // lacks answers -32602 without the token, and exits with it -- clears
    // nothing: the call carrying the token is resent, and failing the same way
    // again, the token is blamed; answered the way the call without it was,
    // it is not. Only the server's own answer attributes anything: a gate's
    // answer (a 429 again, a 401 or a Bearer 403) or no answer at all -- on
    // the first call, on the call without the token, or on the resent call --
    // measured nothing about the token: a skip, never a pass that claims a
    // verdict. Valid notifications settle the check only on a call the server
    // did not fail; next to a failure they are named in the details, and the
    // failure is read as above.
    const name = String(tool.name);
    const call = `tools/call ${clipDetail(name, 60)}`;
    const gated = "it was answered before the server read the request, so it proves nothing about the progress token";
    const send = (withToken: boolean) => sendProgressCall(ctx, name, tool.inputSchema, withToken, call);
    const first = await send(true);
    const judged = judgeProgress(ctx, first, call);
    if (judged && (!judged.passed || !callFailed(ctx, first))) return judged;
    /** What the progress notifications showed: the first call's valid ones, else none. */
    const observed = judged?.details ?? NO_PROGRESS;
    if (first.res && gateOnCall(ctx, first.res)) {
      return unanswered(`${call} with progressToken ${callOutcome(ctx, first)}; not evaluable: ${gated}; ${observed}`);
    }
    if (!callFailed(ctx, first)) {
      if (first.res) return pass(`${call} ${callOutcome(ctx, first)}; ${observed}`);
      return unanswered(`${call} with progressToken ${callOutcome(ctx, first)}; ${observed}`);
    }
    const twin = await send(false);
    if (!twin.res || gateOnCall(ctx, twin.res)) {
      return unanswered(
        `${call} ${callOutcome(ctx, first)}, but the same call without the token ${callOutcome(ctx, twin)}, so no answer of the server's own tells whether the progress token is what failed it (not evaluable); ${observed}`,
      );
    }
    if (!servedCall(ctx, twin.res)) {
      if (failureKey(ctx, first) === failureKey(ctx, twin)) {
        return pass(
          `${call} ${callOutcome(ctx, first)}, and the same call without the token was not served either (${callShape(ctx, twin.res, twin.throttledMs)}), so the progress token is not what failed it; ${observed}`,
        );
      }
      return resendAfterUnlikeTwin(ctx, call, first, twin, judged, () => send(true));
    }
    const again = await send(true);
    const judgedAgain = judgeProgress(ctx, again, call, " when resent");
    if (judgedAgain && (!judgedAgain.passed || !callFailed(ctx, again))) return judgedAgain;
    if (callFailed(ctx, again)) {
      const repeated = again.res ? callShape(ctx, again.res, again.throttledMs) : callOutcome(ctx, again);
      return fail(
        `${call} carrying _meta.progressToken ${callOutcome(ctx, first)}, and ${repeated} when it was resent, while the same call without it, sent in between, was served -- the server failed the request because of its progress token (basic/patterns/progress lets a server ignore the token and send no notifications, not fail the request)`,
      );
    }
    if (again.res && servedCall(ctx, again.res)) {
      return pass(
        `${call} succeeded when resent: it first ${callOutcome(ctx, first)}, then the same call without the token and the resent one were served; ${observed}`,
      );
    }
    const resent = `the same call without the token was served, but resent, the call carrying it ${callOutcome(ctx, again)}`;
    if (!again.res || gateOnCall(ctx, again.res)) {
      return unanswered(
        `${call} ${callOutcome(ctx, first)}; ${resent}, so the failure could not be reproduced (not evaluable); ${observed}`,
      );
    }
    return pass(`${call} ${callOutcome(ctx, first)}; ${resent}, so the failure was not reproduced; ${observed}`);
  });

  // The claim-less probes: a request with no protocolVersion claim is
  // malformed (basic/index#meta, -32602). They run here, after the feature
  // modules, because a dual-era stdio server that is still deciding its
  // era treats a claim-less message as a legacy opening and pins the
  // process to legacy for good; by now a non-discover modern request has
  // pinned it modern (ensureEraPinned sends one when a `--only` run has
  // not) and the probes measure the validation they target. Only when a
  // probe is selected: the pin request is not free on a stdio server.
  if (
    harness.shouldRun("lifecycle-meta-required", "lifecycle") ||
    harness.shouldRun("lifecycle-meta-protocol-version-required", "lifecycle")
  ) {
    await ensureEraPinned(ctx);
  }

  await harness.check("lifecycle-meta-required", () =>
    expectRejection(
      ctx,
      "lifecycle-meta-required",
      "server/discover without _meta",
      JSONRPC_ERROR_CODES.INVALID_PARAMS,
      () => ctx.client.rpc("server/discover", {}, { meta: false }),
    ),
  );

  await harness.check("lifecycle-meta-protocol-version-required", () =>
    expectRejection(
      ctx,
      "lifecycle-meta-protocol-version-required",
      "server/discover without _meta protocolVersion",
      JSONRPC_ERROR_CODES.INVALID_PARAMS,
      () => ctx.client.rpc("server/discover", {}, { meta: { [META.protocolVersion]: undefined } }),
    ),
  );

  // On stdio the probe goes to a FRESH child: a dual-era server selects
  // its era per process, so the suite's process (pinned modern by now)
  // would reject an initialize that a legacy client opening a new process
  // is served. On HTTP every request is its own opening.
  await harness.check("lifecycle-dual-era", async () => {
    const legacyParams = {
      protocolVersion: LEGACY_SPEC_VERSION,
      capabilities: {},
      clientInfo: ctx.client.clientInfo,
    };
    // Exactly what a 2025-11-25 client sends: no modern _meta, no Mcp-Method,
    // and the legacy protocol version in the header.
    const opts: RpcOptions = {
      meta: false,
      headers: { "Mcp-Method": null, "MCP-Protocol-Version": LEGACY_SPEC_VERSION },
    };
    const budget = ctx.kind === "stdio" ? freshInitializeBudget(ctx) : ctx.timeout;
    const spawnedAt = Date.now();
    const fresh = ctx.kind === "stdio" ? ctx.spawnFresh?.() : undefined;
    const where = fresh ? " on a fresh process" : "";
    const shouldName = "a modern-only server SHOULD reject it with an error naming its supported versions";
    let res: RpcResponse;
    try {
      res = fresh
        ? await initializeOnFresh(ctx, fresh, legacyParams, opts, budget)
        : await ctx.client.rpc("initialize", legacyParams, { ...opts, timeout: budget });
    } catch (err) {
      // An aborted run is not a verdict: let the harness see the abort.
      if (ctx.signal?.aborted) throw err;
      const message = messageOf(err);
      const probed = (fresh ?? ctx.transport) as StdioTransport;
      if (ctx.kind === "stdio" && probed.exited) {
        const exit = await describeExit(probed);
        // Died on the request, or died at startup because the suite's own
        // process holds a single-instance lock? Ask an idle instance.
        const elapsed = Date.now() - spawnedAt;
        const grace = Math.min(ctx.startupTimeout, Math.max(IDLE_PROBE_FLOOR_MS, 3 * elapsed));
        const idleExit = fresh ? await exitsAtStartup(ctx, grace) : null;
        if (idleExit !== null) {
          harness.warnings.push(
            `lifecycle-dual-era: a fresh instance exited (${exit}) before answering the legacy initialize, and one spawned with no input exited too (${idleExit}); a server that allows one instance at a time cannot be probed alongside the suite's own process, so its era is undetermined`,
          );
          return unanswered(
            `era undetermined: a second instance exits at startup alongside the suite's process (${idleExit}), so the legacy initialize could not be probed (see warning)`,
          );
        }
        const stayedUp = fresh
          ? "; an instance spawned with no input stays up, so the request is what it exits on"
          : "";
        return fail(`Server exited after a legacy initialize request${where} (${exit})${stayedUp}`);
      }
      if (isTimeout(err)) {
        harness.warnings.push(
          `lifecycle-dual-era: legacy initialize got no response within ${budget}ms${where}; ${shouldName}`,
        );
        return unanswered(
          `No response to legacy initialize${where} within ${budget}ms; era undetermined (see warning)`,
        );
      }
      harness.warnings.push(
        `lifecycle-dual-era: legacy initialize got no response${where} (${short(message)}); ${shouldName}`,
      );
      return unanswered(
        `legacy initialize got no response${where} (${short(message)}); era undetermined (see warning)`,
      );
    } finally {
      await fresh?.close();
    }
    const status = statusOf(ctx, res);
    const result = resultOf(res.body);
    if (result) {
      if (typeof result.protocolVersion !== "string") {
        return pass(`initialize returned a result without protocolVersion${status}${where}; era ambiguous`);
      }
      // The suite-level warnings key on this: SDK 2.0 servers advertise
      // only modern versions yet still serve the handshake (dual-era); a
      // server that served it while REJECTING the conformant discover is
      // legacy-only and pinned to the wrong suite.
      ctx.state.legacyInitializeServed = true;
      if (!ctx.state.discover) {
        return pass(
          `legacy-only: initialize answered with protocolVersion ${result.protocolVersion}${where} but server/discover was rejected; only the legacy handshake is served (see warning)`,
        );
      }
      return pass(
        `dual-era: initialize answered with protocolVersion ${result.protocolVersion}${where}; legacy handshake served alongside ${MODERN_SPEC_VERSION}`,
      );
    }
    // An auth gate or rate limiter answering the probe (with or without a
    // JSON-RPC body) is not the server's verdict on the handshake.
    const gate = transportLevelRejection(ctx, res);
    if (gate) {
      harness.warnings.push(`lifecycle-dual-era: legacy initialize was answered HTTP ${res.statusCode}; ${gate}`);
      return unanswered(
        `era undetermined: initialize answered HTTP ${res.statusCode}, a transport-level rejection (see warning)`,
      );
    }
    const err = errorOf(res.body);
    if (err) {
      const named = supportedVersionsNamedIn(err);
      if (!named) {
        harness.warnings.push(
          `lifecycle-dual-era: initialize rejected with ${errorCodeText(err.rawCode)} but neither the message nor data.supported names a supported protocol version (spec SHOULD): "${short(err.message, 80)}"`,
        );
      }
      return pass(
        `modern-only: initialize rejected with ${errorCodeText(err.rawCode)}${status}${where}${named ? `; ${named}` : " (see warning)"}`,
      );
    }
    if (ctx.kind === "http" && res.statusCode >= 400) {
      harness.warnings.push(
        `lifecycle-dual-era: initialize rejected with HTTP ${res.statusCode} and no JSON-RPC error body; a modern-only server SHOULD name its supported versions in the error`,
      );
      return pass(
        `modern-only: initialize rejected with HTTP ${res.statusCode} and no JSON-RPC error body (see warning)`,
      );
    }
    return pass(`initialize answered with neither result nor error${status}${where}; era undetermined`);
  });
}
