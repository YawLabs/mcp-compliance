import { errorWithCode } from "../../checks/validators.js";
import { authRefusalHint, namesHostOrOriginValidation, readAuthRefusal } from "../../detect.js";
import { resultOf } from "../../modern/client.js";
import type { ModernSuiteContext } from "./context.js";
import { classifyTransportError, retryAfterMs } from "./security.js";

/**
 * Whose answer a rejection is: the one reader the 2026-07-28 checks that
 * credit a JSON-RPC error or a rejecting status (lifecycle-jsonrpc,
 * lifecycle-subscriptions-listen, error-unknown-method,
 * error-invalid-jsonrpc, error-invalid-json, error-missing-params,
 * error-capability-gated, error-invalid-cursor, transport-batch-reject,
 * transport-content-type-reject, and error-parse-code /
 * error-invalid-request-code for the bodiless 4xx they credit) share --
 * the 2025-11-25 suite's gateRefusal / bare403Verdict / ownRejectionCode /
 * rpcResending429 (runner.ts) applied to the modern suite. A gateway in front of a server
 * answers 401 with a -32001 "Unauthorized" body that echoes the request id;
 * read as the server's own answer, that envelope passed all of them.
 *
 * Only an HTTP status can say something stood in front of the server, so
 * everything here is HTTP-only: over stdio nothing sits between the suite
 * and the process, and every answer is the server's.
 */

/** The length a check's details keep within (security.ts, lifecycle.ts). */
export const DETAILS_MAX = 220;

/** An answer as the reader needs it: its status, its headers and its body parsed as JSON. */
export interface GateAnswer {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * What the conformant twin of a probe got: a conformant request sent next
 * to it through the suite's client, so with the same credential and
 * protocol headers -- a server/discover, or for a list probe the same list
 * method without the defect (see `discoverTwin`). Its Mcp-Method (and
 * params) may differ from the probe's.
 */
export interface TwinAnswer {
  /** The twin's method, as the not-evaluable reason names it ("server/discover", "tools/list"). */
  request: string;
  /** A result on a 2xx. */
  served: boolean;
  /** "was served", "was refused (HTTP 403, JSON-RPC error -32000)", "got no response within 5000ms", ... */
  outcome: string;
  /** Its HTTP status, when it got an answer. */
  statusCode?: number;
}

/**
 * The twin a 403 without a Bearer challenge is read against (see
 * `gateVerdict`): a function that sends it (`discoverTwin`), or "self" when
 * the probe IS the conformant request (lifecycle-jsonrpc's setup
 * server/discover), so there is nothing left to compare it with.
 */
export type Twin = (() => Promise<TwinAnswer>) | "self";

export interface GateSpec {
  /** The check id, for the rejection-on-5xx warning. */
  check: string;
  /** The probe as the warning names it ("an unknown method"). */
  what: string;
  /** What the probe varies, as the not-evaluable reason names it ("the unknown method"). */
  about: string;
  /**
   * The JSON-RPC error codes that are the server's own rejection of the
   * probe's defect (-32601 for an unknown method, -32600 for a malformed
   * envelope, ...). A gateway with no backend cannot produce them -- it has
   * not read the request -- so a 5xx carrying one is the server rejecting the
   * defect on an odd status, and is credited.
   */
  ownCodes: readonly number[];
  twin: Twin;
  /** The status the spec expects instead of a 5xx, for the warning (default "a 4xx status is expected"). */
  expected?: string;
}

/** `text` in printable ASCII (anything else as "?"), cut to `max` characters with "..." when longer. */
export function clipAscii(text: string, max: number): string {
  const ascii = text.replace(/[^\x20-\x7e]/g, "?");
  return ascii.length > max ? `${ascii.slice(0, Math.max(max - 3, 0))}...` : ascii;
}

/**
 * A gate-read failure's details within `max` (DETAILS_MAX by default): what
 * was seen -- `answer` ("JSON-RPC error -32001") and its `status` (" (HTTP
 * 401)", " on HTTP 401", or "" when the answer names it) -- then `detail`
 * (what it was for: " for an unknown method") when there is room, then the
 * reason. The reason is the conclusion and is kept whole, and so is the
 * status; only the answer side is shortened -- `detail` dropped first,
 * `answer` clipped after -- so the details never end mid-reason. An answer
 * with less than MIN_ANSWER characters of room left is dropped rather than
 * cut to a stub, leaving the status (without its " (" / " on " framing)
 * before the reason, or the reason alone, so the result never runs past
 * `max` while the reason fits it. Printable ASCII only.
 */
export function gateDetails(answer: string, status: string, detail: string, reason: string, max = DETAILS_MAX): string {
  const all = (text: string) => clipAscii(text, Number.POSITIVE_INFINITY);
  const full = all(`${answer}${status}${detail}; ${reason}`);
  if (full.length <= max) return full;
  const short = all(`${answer}${status}; ${reason}`);
  if (short.length <= max) return short;
  const keep = max - 2 - reason.length - status.length - 3;
  if (keep >= MIN_ANSWER) {
    // Cut the answer at a word boundary when there is one in its second half.
    const cut = all(answer).slice(0, keep);
    const space = cut.lastIndexOf(" ");
    return `${space >= cut.length / 2 ? cut.slice(0, space) : cut}...${all(status)}; ${all(reason)}`;
  }
  const bare = status.replace(/^\s*(?:on\s+|\()?/, "").replace(/\)\s*$/, "");
  const statusOnly = all(`${bare}; ${reason}`);
  if (bare !== "" && statusOnly.length <= max) return statusOnly;
  return all(reason);
}

/** The shortest cut of an answer gateDetails keeps: below it the answer is dropped. */
const MIN_ANSWER = 13;

/** The JSON-RPC error code a body carries, when it is one of `codes`. */
function ownRejectionCode(body: unknown, codes: readonly number[]): number | undefined {
  const code = (body as { error?: { code?: unknown } } | null | undefined)?.error?.code;
  return typeof code === "number" && codes.includes(code) ? code : undefined;
}

/** "-32601", or "-32600, -32601 or -32602". */
function codeList(codes: readonly number[]): string {
  if (codes.length <= 1) return codes.map(String).join("");
  return `${codes.slice(0, -1).join(", ")} or ${codes[codes.length - 1]}`;
}

/**
 * Whether the conformant twin's status is one the server itself chose, so
 * the twin got past whatever stands in front of the server and a 403 on the
 * probe next to it is the probe's own: a 2xx (served, or the application's
 * JSON-RPC error on it), or a 4xx other than an auth gate's 401 / 403 or a
 * rate limiter's 429. A 5xx (a server failure, or a gateway with no
 * backend), a 401, a 403, a 429 (still a 429 after its one resend) or a
 * redirect is no evidence the twin reached the server, so it credits
 * nothing. Shared with the 2025-11-25 suite (bare403Verdict in runner.ts).
 */
export function twinReachedServer(statusCode: number | undefined): boolean {
  if (statusCode === undefined) return false;
  if (statusCode >= 200 && statusCode < 300) return true;
  return statusCode >= 400 && statusCode < 500 && statusCode !== 401 && statusCode !== 403 && statusCode !== 429;
}

/** A server-chosen message for a details string: quoted, anything outside printable ASCII replaced by "?". */
function quoteMessage(message: string): string {
  return JSON.stringify(message.replace(/[^\x20-\x7e]/g, "?"));
}

/** ", JSON-RPC error <code>" when a body carries a JSON-RPC error, "" otherwise. */
export function rpcErrorSuffix(body: unknown): string {
  const error = (body as { error?: unknown } | null | undefined)?.error;
  if (!error || typeof error !== "object") return "";
  return `, ${errorWithCode((error as { code?: unknown }).code)}`;
}

/** "no response within Nms" for a timeout, "no response (connection closed|failed: ...)" otherwise. */
function noResponse(err: unknown, timeout: number): string {
  const failure = classifyTransportError(err);
  if (failure === "timeout") return `no response within ${timeout}ms`;
  const how = failure === "dropped" ? "connection closed" : "connection failed";
  const line = ((err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "")
    .replace(/\s+/g, " ")
    .replace(/[^\x20-\x7e]/g, "?");
  return `no response (${how}: ${line.length > 60 ? `${line.slice(0, 57)}...` : line})`;
}

/**
 * The warning for a probe the server rejected with its own JSON-RPC error
 * (see `GateSpec.ownCodes`) on a 5xx. It names the status only, never the
 * verdict: the caller may still fail the check on another criterion (an id
 * not echoed, another undeclared method).
 */
function rejectionOn5xxWarning(spec: GateSpec, statusCode: number, code: number): string {
  const expected = spec.expected ?? "a 4xx status is expected";
  return `${spec.check}: the server answered ${spec.what} with its own JSON-RPC error ${code} on HTTP ${statusCode}; a rejected request is a client error, so ${expected} (a 5xx tells clients and gateways the server failed)`;
}

/** The pointer a bare-403 reason ends with, where the 403 itself is read. */
const SEE_AUTH_REQUIRED = " (see security-auth-required)";

/** A message that has to be clipped below this many characters says too little to quote. */
const MIN_QUOTE = 16;

/**
 * Why an answer to a probe -- a JSON-RPC error, or a status >= 400 -- is
 * not the server's own rejection of its defect, as a reason for the
 * failure, or null when it is. Read from the status, so a JSON-RPC error
 * body on it (a gateway's -32001 "Unauthorized") is the gate's too:
 *
 * - a 429: a rate limiter answered before the server read the request (the
 *   caller has already resent the probe once after Retry-After, see
 *   `resendOn429`): not evaluable;
 * - a 5xx: unless the body carries one of `spec.ownCodes`, which only a
 *   server that read the request produces (that 5xx is credited, and
 *   `spec.check` is warned about the status), the server failed on the
 *   request rather than rejecting it, or a gateway with no backend
 *   answered. On a defect probe that is a failure of the check on its own
 *   terms (a parse exception reaching a generic 500 handler is exactly what
 *   the checks look for), so its reason is no "not evaluable"; on the
 *   conformant request itself (`twin: "self"`) it is not evaluable, as the
 *   envelope need not be the server's;
 * - a 401, or a 403 carrying a Bearer challenge (readAuthRefusal): an auth
 *   gate, which refuses the credential, not the defect: not evaluable;
 * - any other 403 is the one refusal that may be either: a gate refusing
 *   every request, or the server (or a WAF) refusing the defect. The twin --
 *   a conformant request sent next to the probe through the same client (a
 *   server/discover, or the probe's own list method without the defect), a
 *   429 on it resent once -- tells them apart: when it was served, or drew a
 *   status the server itself chose (twinReachedServer: a 2xx, or a 4xx
 *   other than 401, 403 or 429), the defect is what drew the 403, and it is
 *   credited whatever its message says. When it drew the same 403, a 401, a
 *   429 again, a 5xx or no answer, it never reached the server either and
 *   the 403 is not evaluable, quoting the message when the twin drew the
 *   same 403 and the message names Host or Origin validation (a guard that
 *   refuses a request whatever it carries). With `twin: "self"` the probe is
 *   the conformant request itself, so no such 403 is attributable.
 *
 * `room` is how long the reason may be for the caller's details to stay
 * within DETAILS_MAX (see `gateDetails`): the quoted message is clipped to
 * it (and left out below MIN_QUOTE characters), a twin's outcome is clipped
 * to it, and the "(see security-auth-required)" pointer is added only when
 * it fits. Every caller passes one (the reasons for a 429, an auth gate or
 * a 5xx are fixed text well within any room a caller leaves); unbounded
 * when not given.
 *
 * Null for every other answer (a 4xx the server chose: a 400, 404, 413,
 * 415 ...) and always over stdio. A caller's abort while the twin is sent
 * is rethrown.
 */
export async function gateVerdict(
  ctx: ModernSuiteContext,
  res: GateAnswer,
  spec: GateSpec,
  room = Number.POSITIVE_INFINITY,
): Promise<string | null> {
  if (ctx.kind !== "http") return null;
  const status = res.statusCode;
  const provesNothing = `so it proves nothing about ${spec.about}`;
  /** `base`, and the security-auth-required pointer when `room` leaves space for it. */
  const pointed = (base: string) =>
    base.length + SEE_AUTH_REQUIRED.length <= room ? `${base}${SEE_AUTH_REQUIRED}` : base;
  if (status === 429) {
    return `not evaluable: a rate limiter answered before the server read the request, ${provesNothing}`;
  }
  if (status >= 500) {
    const own = ownRejectionCode(res.body, spec.ownCodes);
    if (own !== undefined) {
      ctx.harness.warnings.push(rejectionOn5xxWarning(spec, status, own));
      return null;
    }
    if (spec.twin === "self") {
      return `not evaluable: a server error (or a gateway with no backend) answered, ${provesNothing}`;
    }
    const expected = spec.ownCodes.length > 0 ? `; ${codeList(spec.ownCodes)} on a 4xx is expected` : "";
    return `the server failed on the request rather than rejecting it (a broken server, or a gateway with no backend)${expected}`;
  }
  const refusal = readAuthRefusal(res, ctx.hasAuth);
  if (!refusal) return null;
  if (refusal.kind !== "forbidden") {
    return `not evaluable: an auth gate answered before the server read the request (${authRefusalHint(refusal, "pass --auth")}), ${provesNothing}`;
  }
  const hostOrOrigin = namesHostOrOriginValidation(refusal.message)
    ? hostOrOriginReason(refusal.message ?? "", provesNothing, room)
    : null;
  if (spec.twin === "self") {
    if (hostOrOrigin) return hostOrOrigin;
    const refused = "not evaluable: a 403 without a Bearer challenge refused the conformant request itself";
    const explained = `${refused} (Host/Origin validation or a gateway), ${provesNothing}`;
    return pointed(explained.length <= room ? explained : `${refused}, ${provesNothing}`);
  }
  const twin = await spec.twin();
  if (twin.served || twinReachedServer(twin.statusCode)) return null;
  if (twin.statusCode === status && hostOrOrigin) return hostOrOrigin;
  const opening = `not evaluable: a conformant ${twin.request} `;
  const closing = ` too, so the 403 proves nothing about ${spec.about}`;
  const outcome = clipAscii(twin.outcome, Math.max(room - opening.length - closing.length, 24));
  return pointed(`${opening}${outcome}${closing}`);
}

/**
 * The reason for a 403 whose message names Host or Origin validation. With
 * no `room` (a caller that does not budget its details) the message is
 * quoted whole and the reason explains the guard. Within a `room` (see
 * `gateVerdict`) the quoted message, which says which host or origin was
 * refused, outranks that explanation, so the reason is always the short
 * form: the message whole, or clipped to fit (to no fewer than MIN_QUOTE
 * characters), or not quoted at all.
 */
function hostOrOriginReason(message: string, provesNothing: string, room: number): string {
  const quoted = (text: string, tail: string) => `not evaluable: its message (${quoteMessage(text)})${tail}`;
  if (room === Number.POSITIVE_INFINITY) {
    return quoted(
      message,
      ` names Host/Origin validation, which refuses a request whatever it carries, ${provesNothing}`,
    );
  }
  const plain = ` names Host/Origin validation, ${provesNothing}`;
  // "not evaluable: its message (" and ")", and the two quotes quoteMessage adds.
  const quoteRoom = room - "not evaluable: its message ()".length - plain.length - 2;
  const candidates = [
    quoted(message, plain),
    quoteRoom >= MIN_QUOTE ? quoted(clipAscii(message, quoteRoom), plain) : "",
  ];
  return candidates.find((c) => c !== "" && c.length <= room) ?? `not evaluable: its message${plain}`;
}

/**
 * The conformant twin of the probes of one check: a `method` request (a
 * server/discover by default; error-invalid-cursor sends its list method
 * without the cursor) with no params beyond the suite's `_meta`, sent
 * through the suite's client (so the same credential and protocol headers
 * as the probes), at most once however many probes the check reads against
 * it (see `gateVerdict`). Sent only when a probe drew a 403 without a
 * Bearer challenge, so a server that answers otherwise is sent nothing
 * more. A result on a 2xx is served. A 429 on it is resent once after
 * Retry-After, as the probes' are (resendOn429), and the second answer is
 * the twin's. A caller's abort is rethrown.
 */
export function discoverTwin(ctx: ModernSuiteContext, method = "server/discover"): () => Promise<TwinAnswer> {
  let once: Promise<TwinAnswer> | null = null;
  return () => {
    once ??= (async (): Promise<TwinAnswer> => {
      /** "answered HTTP 429, and its resend " once the first answer was a 429. */
      let throttled = "";
      try {
        const send = () => ctx.client.rpc(method, {});
        const first = await send();
        if (ctx.kind === "http" && first.statusCode === 429) throttled = "answered HTTP 429, and its resend ";
        const { res, throttledMs } = await resendOn429(ctx, first, send);
        const status = res.statusCode;
        if (status >= 200 && status < 300 && resultOf(res.body)) {
          return {
            request: method,
            served: true,
            outcome: throttledMs === null ? "was served" : "was served when resent after HTTP 429",
            statusCode: status,
          };
        }
        const refused = status === 401 || status === 403;
        return {
          request: method,
          served: false,
          outcome: `${refused ? "was refused" : "was not served"} (${httpStatusText(status, throttledMs)}${rpcErrorSuffix(res.body)})`,
          statusCode: status,
        };
      } catch (err) {
        if (ctx.signal?.aborted) throw err;
        return { request: method, served: false, outcome: `${throttled}got ${noResponse(err, ctx.timeout)}` };
      }
    })();
    return once;
  };
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
 * Resend a probe once after Retry-After (capped at 2 s, `retryAfterMs`)
 * when a rate limiter answered it 429 over HTTP; the second answer decides.
 * `throttledMs` is the wait when it was resent, null otherwise. A caller's
 * abort (during the wait or the resend) is thrown; a resend that got no
 * answer throws what the transport threw.
 */
export async function resendOn429<T extends { statusCode: number; headers: Record<string, string> }>(
  ctx: ModernSuiteContext,
  first: T,
  send: () => Promise<T>,
): Promise<{ res: T; throttledMs: number | null }> {
  if (ctx.kind !== "http" || first.statusCode !== 429) return { res: first, throttledMs: null };
  const wait = retryAfterMs(first.headers);
  await pause(wait, ctx.signal);
  return { res: await send(), throttledMs: wait };
}

/** "HTTP 401", or "HTTP 429, then after 0ms HTTP 429" for a probe resent after a 429. */
export function httpStatusText(statusCode: number, throttledMs: number | null): string {
  return throttledMs === null ? `HTTP ${statusCode}` : `HTTP 429, then after ${throttledMs}ms HTTP ${statusCode}`;
}
