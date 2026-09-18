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
 * transport-content-type-reject) share -- the 2025-11-25 suite's
 * gateRefusal / bare403Verdict / ownRejectionCode / rpcResending429
 * (runner.ts) applied to the modern suite. A gateway in front of a server
 * answers 401 with a -32001 "Unauthorized" body that echoes the request id;
 * read as the server's own answer, that envelope passed all of them.
 *
 * Only an HTTP status can say something stood in front of the server, so
 * everything here is HTTP-only: over stdio nothing sits between the suite
 * and the process, and every answer is the server's.
 */

/** An answer as the reader needs it: its status, its headers and its body parsed as JSON. */
export interface GateAnswer {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * What the conformant twin of a probe got: a server/discover sent next to
 * it, with the same headers, differing from it in nothing but the defect.
 */
export interface TwinAnswer {
  /** A DiscoverResult on a 2xx. */
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
 * (see `GateSpec.ownCodes`) on a 5xx: credited, but the status tells
 * clients and gateways that the server failed.
 */
function rejectionOn5xxWarning(spec: GateSpec, statusCode: number, code: number): string {
  const expected = spec.expected ?? "a 4xx status is expected";
  return `${spec.check}: the server rejected ${spec.what} with JSON-RPC error ${code} on HTTP ${statusCode}; credited, but a rejected request is a client error, so ${expected} (a 5xx tells clients and gateways the server failed).`;
}

/**
 * Why an answer to a probe -- a JSON-RPC error, or a status >= 400 -- is
 * not the server's own answer, as a "not evaluable: ..." reason, or null
 * when it is. Read from the status, so a JSON-RPC error body on it (a
 * gateway's -32001 "Unauthorized") is the gate's too:
 *
 * - a 429: a rate limiter answered before the server read the request (the
 *   caller has already resent the probe once after Retry-After, see
 *   `resendOn429`);
 * - a 5xx: the server failed on the request rather than rejecting it, or a
 *   gateway with no backend answered -- unless the body carries one of
 *   `spec.ownCodes`, which only a server that read the request produces:
 *   that 5xx is credited, and `spec.check` is warned about the status;
 * - a 401, or a 403 carrying a Bearer challenge (readAuthRefusal): an auth
 *   gate, which refuses the credential, not the defect;
 * - any other 403 is the one refusal that may be either: a gate refusing
 *   every request, or the server (or a WAF) refusing the defect. The twin --
 *   a conformant server/discover sent next to the probe with the same
 *   headers, a 429 on it resent once -- tells them apart: when it was
 *   served, or drew a status the server itself chose (twinReachedServer: a
 *   2xx, or a 4xx other than 401, 403 or 429), the defect is what drew the
 *   403, and it is credited whatever its message says. When it drew the
 *   same 403, a 401, a 429 again, a 5xx or no answer, it never reached the
 *   server either and the 403 is not attributable, quoting the message when
 *   the twin drew the same 403 and the message names Host or Origin
 *   validation (a guard that refuses a request whatever it carries). With
 *   `twin: "self"` the probe is the conformant request itself, so no such
 *   403 is attributable.
 *
 * Null for every other answer (a 4xx the server chose: a 400, 404, 413,
 * 415 ...) and always over stdio. A caller's abort while the twin is sent
 * is rethrown.
 */
export async function gateVerdict(ctx: ModernSuiteContext, res: GateAnswer, spec: GateSpec): Promise<string | null> {
  if (ctx.kind !== "http") return null;
  const status = res.statusCode;
  const provesNothing = `so it proves nothing about ${spec.about}`;
  if (status === 429) {
    return `not evaluable: a rate limiter answered before the server read the request, ${provesNothing}`;
  }
  if (status >= 500) {
    const own = ownRejectionCode(res.body, spec.ownCodes);
    if (own === undefined) {
      const which = spec.ownCodes.length > 0 ? `a 5xx that carries no ${codeList(spec.ownCodes)}` : "a 5xx";
      return `not evaluable: ${which} is a server failure or a gateway with no backend, ${provesNothing}`;
    }
    ctx.harness.warnings.push(rejectionOn5xxWarning(spec, status, own));
    return null;
  }
  const refusal = readAuthRefusal(res, ctx.hasAuth);
  if (!refusal) return null;
  if (refusal.kind !== "forbidden") {
    return `not evaluable: an auth gate answered before the server read the request (${authRefusalHint(refusal, "pass --auth")}), ${provesNothing}`;
  }
  const hostOrOrigin = namesHostOrOriginValidation(refusal.message)
    ? `not evaluable: its message (${quoteMessage(refusal.message ?? "")}) names Host/Origin validation, which refuses a request whatever it carries, ${provesNothing}`
    : null;
  if (spec.twin === "self") {
    return (
      hostOrOrigin ??
      `not evaluable: a 403 without a Bearer challenge refused the conformant request itself (Host/Origin validation or a gateway), ${provesNothing} (see security-auth-required)`
    );
  }
  const twin = await spec.twin();
  if (twin.served || twinReachedServer(twin.statusCode)) return null;
  if (twin.statusCode === status && hostOrOrigin) return hostOrOrigin;
  return `not evaluable: a conformant server/discover sent next to it ${twin.outcome} too, so the 403 proves nothing about ${spec.about} (see security-auth-required)`;
}

/**
 * The conformant twin of the probes of one check: a server/discover sent
 * through the suite's client (the same headers, credential included), at
 * most once however many probes the check reads against it (see
 * `gateVerdict`). Sent only when a probe drew a 403 without a Bearer
 * challenge, so a server that answers otherwise is sent nothing more. A 429
 * on it is resent once after Retry-After, as the probes' are (resendOn429),
 * and the second answer is the twin's. A caller's abort is rethrown.
 */
export function discoverTwin(ctx: ModernSuiteContext): () => Promise<TwinAnswer> {
  let once: Promise<TwinAnswer> | null = null;
  return () => {
    once ??= (async (): Promise<TwinAnswer> => {
      /** "answered HTTP 429, and its resend " once the first answer was a 429. */
      let throttled = "";
      try {
        const send = () => ctx.client.rpc("server/discover", {});
        const first = await send();
        if (ctx.kind === "http" && first.statusCode === 429) throttled = "answered HTTP 429, and its resend ";
        const { res, throttledMs } = await resendOn429(ctx, first, send);
        const status = res.statusCode;
        if (status >= 200 && status < 300 && resultOf(res.body)) {
          return {
            served: true,
            outcome: throttledMs === null ? "was served" : "was served when resent after HTTP 429",
            statusCode: status,
          };
        }
        const refused = status === 401 || status === 403;
        return {
          served: false,
          outcome: `${refused ? "was refused" : "was not served"} (${httpStatusText(status, throttledMs)}${rpcErrorSuffix(res.body)})`,
          statusCode: status,
        };
      } catch (err) {
        if (ctx.signal?.aborted) throw err;
        return { served: false, outcome: `${throttled}got ${noResponse(err, ctx.timeout)}` };
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
