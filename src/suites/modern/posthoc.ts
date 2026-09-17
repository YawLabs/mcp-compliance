import type { TestOutcome } from "../../harness.js";
import { errorOf, exchangeEndOf } from "../../modern/client.js";
import { INPUT_REQUEST_METHODS, META, MRTR_METHODS, RETIRED_ERROR_CODES } from "../../modern/meta.js";
import { formatViolation, getWireValidator } from "../../modern/schema-validator.js";
import type { ReceivedMessage, Recorder, SentRequest } from "../../recorder.js";
import type { ModernSuiteContext } from "./context.js";

/**
 * Post-hoc checks of the 2026-07-28 suite. Nothing here talks to the
 * server: every test scans the Recorder -- every message the server sent
 * during the run, correlated with the request that produced it -- and
 * judges wire-level properties the spec states as MUSTs over ALL
 * traffic ("every result carries resultType", "no server->client
 * requests", ...). The suite runs them last, after the pool is drained,
 * so the recording is complete.
 *
 * With `--only` filters the recording can be nearly empty; every check
 * then passes with a note saying how little it saw, never fails or
 * throws. The details always name the count scanned so a vacuous pass
 * is visible as one.
 */

/**
 * The post-hoc ids, in run order. The one table both paths of
 * `runPostHoc` draw from: the empty-recorder guard iterates it, and the
 * per-check calls below are typed to it, so an id cannot exist in one
 * place and not the other.
 */
export const POSTHOC_IDS = [
  "transport-no-server-requests",
  "lifecycle-log-level-gating",
  "error-id-echo",
  "error-retired-codes",
  "schema-result-type",
  "schema-no-input-required-on-lists",
  "schema-input-required-shape",
  "schema-wire-valid",
] as const;
export type PostHocId = (typeof POSTHOC_IDS)[number];

const RESULT_TYPE_INPUT_REQUIRED = "input_required";
/** The resultType values the core protocol defines; anything else needs an advertised extension. */
const CORE_RESULT_TYPES = new Set<string>(["complete", RESULT_TYPE_INPUT_REQUIRED]);
/** The client capability each inputRequests method needs (mrtr#server-requirements: MUST NOT request an undeclared one). */
const INPUT_REQUEST_CAPABILITY: Record<string, string> = {
  "elicitation/create": "elicitation",
  "sampling/createMessage": "sampling",
  "roots/list": "roots",
};
/** inputRequests methods whose request type makes `params` required (ListRootsRequest.params is optional). */
const INPUT_REQUEST_PARAMS_REQUIRED = new Set<string>(["elicitation/create", "sampling/createMessage"]);
/** The elicitation modes a client can declare (client/elicitation#capabilities); an empty `elicitation: {}` means form only. */
const ELICITATION_MODES = ["form", "url"] as const;
const DEFAULT_ELICITATION_MODE = "form";
/**
 * HTTP statuses an auth gate, proxy or body-size guard answers with
 * BEFORE the JSON-RPC layer reads the request, so a JSON-RPC error body
 * carrying `id: null` on one of them never had the id to echo. Only
 * error-id-echo consults this list; a non-JSON-RPC body is judged by the
 * status class alone (see isHttpError).
 */
const TRANSPORT_REJECTION_STATUSES = new Set<number>([401, 403, 413, 415, 429]);
/** Distinct violations named inline in schema-wire-valid's details; the next ones go to a warning. */
const INLINE_VIOLATIONS = 3;
const WARNED_VIOLATIONS = 5;
const VIOLATION_TEXT_MAX = 90;

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function isResponse(m: unknown): m is Record<string, unknown> {
  return isObject(m) && ("result" in m || "error" in m);
}

/**
 * A JSON-RPC error response: the `jsonrpc: "2.0"` member plus an `error`
 * object with a numeric code. A gateway body such as
 * `{"error":"Unauthorized"}` or `{"error":{"code":400,"message":...}}`
 * is not one, and the spec's id-echo MUST (basic/index#error-responses)
 * is about JSON-RPC error responses only.
 */
function isJsonRpcError(m: unknown): m is Record<string, unknown> {
  return isObject(m) && m.jsonrpc === "2.0" && isObject(m.error) && typeof m.error.code === "number";
}

/** A message shaped as JSON-RPC 2.0: the version member plus a method, a result, or a JSON-RPC error. */
function isJsonRpcMessage(m: unknown): m is Record<string, unknown> {
  return isObject(m) && m.jsonrpc === "2.0" && (typeof m.method === "string" || "result" in m || isJsonRpcError(m));
}

/** Whether the HTTP response that carried a message was a transport-level rejection (see TRANSPORT_REJECTION_STATUSES). */
function isTransportRejection(entry: ReceivedMessage): boolean {
  return entry.statusCode !== undefined && TRANSPORT_REJECTION_STATUSES.has(entry.statusCode);
}

/**
 * Whether the HTTP response that carried a message was any 4xx or 5xx.
 * An intermediary MUST answer a header-validation failure with an HTTP
 * error such as 400 but need not produce a JSON-RPC error
 * (streamable-http#server-validation), and a gateway's 502 body is
 * whatever the gateway writes: neither is a message the server composed.
 */
function isHttpError(entry: ReceivedMessage): boolean {
  return entry.statusCode !== undefined && entry.statusCode >= 400;
}

/** Whether a reply carries no usable id: null (JSON-RPC's "could not read it") or absent. */
function idAbsent(m: Record<string, unknown>): boolean {
  return m.id === null || m.id === undefined;
}

/** The recorder's error responses that are JSON-RPC errors (see isJsonRpcError). */
function jsonRpcErrors(recorder: Recorder): ReceivedMessage[] {
  return recorder.errors().filter((e) => isJsonRpcError(e.message));
}

/** Keep details ASCII: server-supplied text can carry anything. */
function ascii(text: string): string {
  return text.replace(/[^\x20-\x7e]/g, "?");
}

function brief(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  text = ascii(text);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/** Render a JSON-RPC id with its type visible: 1001, "abc", null, or "no id". */
function fmtId(id: unknown): string {
  if (id === undefined) return "no id";
  if (id === null) return "null";
  return brief(id);
}

/** JSON-RPC ids are compared by value AND type: 1001 and "1001" are different ids. */
function sameId(a: unknown, b: unknown): boolean {
  return typeof a === typeof b && a === b;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * Correlation the Recorder cannot do on its own. It links a response to
 * its request by the id the response carries -- which is exactly what a
 * server that drops or retypes the id breaks, leaving those responses
 * with `request: undefined`. The timeline attributes each such unmatched
 * response, and each received message to the request in flight when it
 * arrived.
 *
 * An unmatched response is attributed by one walk back through the sends
 * before it (see `candidateOwner`), the same for every one. Replies
 * overlap later sends in two ways: on stdio a notification's write
 * resolves on flush, so the suite's next request is often SENT before
 * the server's (illegitimate) reply to the notification arrives; and the
 * few parallel-safe tests have several id-bearing requests in flight at
 * once. So the most recent send is not simply the owner. Walking back
 * from the stray, the first entry that could still draw a reply owns it:
 *
 *  - an id-bearing request that received its own id-matched reply
 *    (before or after the stray) did not draw it, and neither did one an
 *    earlier stray was already attributed to;
 *  - an exchange that had ENDED before the stray arrived did not draw it:
 *    an HTTP exchange the client finished reading (a closed
 *    `subscriptions/listen` above all; see exchangeEndOf), or a request
 *    the client cancelled with notifications/cancelled;
 *  - an id-less entry (a client notification or raw probe) is a
 *    candidate only while no request sent after it was answered before
 *    the stray arrived: its reply would have come before that answer, so
 *    an old notification several answered requests back cannot capture
 *    (and exempt) a stray.
 *
 * A raw probe or a client notification is a legitimate owner of an
 * id-less reply; an id-bearing request is not. When no send before the
 * stray is still a candidate, every request the stray could answer had
 * already been answered: the stray is a SECOND answer (a result then an
 * id-less error, in either frame order). The timeline then names the
 * most recent id-bearing request sent before it (`repeated`), which
 * error-id-echo blames; the result scans leave such a reply
 * unattributed. Only a reply that arrives before anything was sent (a
 * stray written at boot) has neither.
 */
interface Timeline {
  /** Unmatched responses -> the sent entry still able to draw a reply that they most plausibly answer (null = none). */
  unmatched: Map<ReceivedMessage, SentRequest | null>;
  /** Unmatched responses with no such owner -> the most recent id-bearing request sent before them (a second answer). */
  repeated: Map<ReceivedMessage, SentRequest>;
  /** Every received entry -> the request in flight when it arrived (null = none). */
  inFlight: Map<ReceivedMessage, SentRequest | null>;
}

function buildTimeline(recorder: Recorder): Timeline {
  const { sent, received } = recorder;
  /**
   * When each request stopped being able to draw a reply: the seq of its
   * first id-matched response, or of an earlier stray attributed to it.
   * Pre-filled with every id-matched response, including those that
   * arrive after a stray; strays add theirs in seq order during the replay.
   */
  const answered = new Map<SentRequest, number>();
  for (const entry of received) {
    if (entry.request && isResponse(entry.message) && !answered.has(entry.request)) {
      answered.set(entry.request, entry.seq);
    }
  }
  const ends = exchangeEnds(sent);

  type Event = { seq: number; sent?: SentRequest; received?: ReceivedMessage; ended?: SentRequest };
  const events: Event[] = [
    ...sent.map((s) => ({ seq: s.seq, sent: s })),
    ...received.map((r) => ({ seq: r.seq, received: r })),
    // An end falls after the last entry it covers and before the next one.
    ...[...ends].map(([s, end]) => ({ seq: end + 0.5, ended: s })),
  ].sort((a, b) => a.seq - b.seq);
  /** Sent entries still open, in send order: the top is the request in flight. */
  const open: SentRequest[] = [];
  const close = (s: SentRequest) => {
    const idx = open.lastIndexOf(s);
    if (idx !== -1) open.splice(idx, 1);
  };
  const unmatched = new Map<ReceivedMessage, SentRequest | null>();
  const repeated = new Map<ReceivedMessage, SentRequest>();
  const inFlight = new Map<ReceivedMessage, SentRequest | null>();
  for (const ev of events) {
    if (ev.sent) {
      open.push(ev.sent);
      continue;
    }
    if (ev.ended) {
      close(ev.ended);
      continue;
    }
    const entry = ev.received as ReceivedMessage;
    inFlight.set(entry, open[open.length - 1] ?? null);
    if (!isResponse(entry.message)) continue; // notifications and server requests answer nothing
    if (entry.request) {
      close(entry.request);
      continue;
    }
    const owner = candidateOwner(sent, entry.seq, answered, ends);
    unmatched.set(entry, owner ?? null);
    if (owner) {
      close(owner);
      if (owner.id !== undefined && !answered.has(owner)) answered.set(owner, entry.seq);
      continue;
    }
    const latest = latestRequestBefore(sent, entry.seq);
    if (latest) repeated.set(entry, latest);
  }
  return { unmatched, repeated, inFlight };
}

/**
 * The last seq each ended exchange can own (see Timeline): the client's
 * mark for a finished HTTP exchange, or the seq of a notifications/cancelled
 * the client sent naming an earlier request's id, whichever is first.
 */
function exchangeEnds(sent: SentRequest[]): Map<SentRequest, number> {
  const ends = new Map<SentRequest, number>();
  /** The latest id-bearing request per id ("<type>:<value>"), for resolving a cancel's requestId. */
  const byId = new Map<string, SentRequest>();
  for (const s of sent) {
    const marked = exchangeEndOf(s);
    if (marked !== undefined) ends.set(s, marked);
    if (s.id !== undefined) {
      byId.set(`${typeof s.id}:${s.id}`, s);
      continue;
    }
    if (s.raw !== undefined || s.method !== "notifications/cancelled" || !isObject(s.params)) continue;
    const target = s.params.requestId;
    if (typeof target !== "number" && typeof target !== "string") continue;
    const cancelled = byId.get(`${typeof target}:${target}`);
    if (!cancelled) continue;
    const end = ends.get(cancelled);
    if (end === undefined || s.seq < end) ends.set(cancelled, s.seq);
  }
  return ends;
}

/**
 * The sent entry a stray reply at `seq` most plausibly answers (see
 * Timeline): walking back from the stray, the first id-less entry not
 * ruled out by a request answered after it, or the first id-bearing
 * request neither answered nor ended, whichever is more recent.
 * Undefined when no send before `seq` is still a candidate.
 */
function candidateOwner(
  sent: SentRequest[],
  seq: number,
  answered: Map<SentRequest, number>,
  ends: Map<SentRequest, number>,
): SentRequest | undefined {
  let answeredInBetween = false;
  for (let i = sent.length - 1; i >= 0; i--) {
    const s = sent[i] as SentRequest;
    if (s.seq >= seq) continue;
    const end = ends.get(s);
    const ended = end !== undefined && end < seq;
    if (s.id === undefined) {
      if (!ended && !answeredInBetween) return s;
      continue;
    }
    // Answered comes first: a finished HTTP request is ended too, and is still a barrier.
    const answeredAt = answered.get(s);
    if (answeredAt !== undefined) {
      if (answeredAt < seq) answeredInBetween = true;
      continue;
    }
    if (!ended) return s;
  }
  return undefined;
}

/** The most recent id-bearing request sent before `seq`, if any. */
function latestRequestBefore(sent: SentRequest[], seq: number): SentRequest | undefined {
  for (let i = sent.length - 1; i >= 0; i--) {
    const s = sent[i] as SentRequest;
    if (s.seq < seq && s.id !== undefined) return s;
  }
  return undefined;
}

/** The request a received entry answers, by id when the server echoed it, else by timeline. */
function requestOf(entry: ReceivedMessage, timeline: Timeline): SentRequest | null {
  return entry.request ?? timeline.unmatched.get(entry) ?? null;
}

function methodOf(entry: ReceivedMessage, timeline: Timeline): string {
  const req = requestOf(entry, timeline);
  if (!req) return "unattributed response";
  return req.raw !== undefined ? "raw probe" : ascii(req.method || "raw probe");
}

/**
 * A result answering the suite's legacy `initialize` probe
 * (lifecycle-dual-era) is a 2025-11-25 message by definition: a
 * dual-era server answers that handshake in the old shape, without
 * resultType. It is not held to the 2026-07-28 result rules.
 */
function isLegacyInitializeReply(entry: ReceivedMessage): boolean {
  return entry.request?.method === "initialize" && isObject(entry.message) && "result" in entry.message;
}

function inputRequiredResults(recorder: Recorder): ReceivedMessage[] {
  return recorder.results().filter((entry) => {
    const result = (entry.message as Record<string, unknown>).result;
    return isObject(result) && result.resultType === RESULT_TYPE_INPUT_REQUIRED;
  });
}

/**
 * The elicitation modes a client's capability declaration supports
 * (client/elicitation#capabilities): the `form` / `url` keys present, or
 * form alone for the backwards-compatible empty object.
 */
function declaredElicitationModes(elicitation: Record<string, unknown>): string[] {
  const modes = ELICITATION_MODES.filter((mode) => isObject(elicitation[mode]));
  return modes.length > 0 ? modes : [DEFAULT_ELICITATION_MODE];
}

/**
 * Every way one InputRequiredResult can violate the MRTR server
 * requirements (mrtr#server-requirements-basic-workflow), in wire order:
 * shape, the allowed methods, `params` where the request type requires
 * it, and -- the ones that bite a real client -- an inputRequests method
 * whose client capability this suite never declared, or an
 * elicitation/create whose mode the client's elicitation declaration
 * does not cover (servers MUST NOT elicit in a mode the client did not
 * declare; an absent mode is form).
 */
function inputRequiredProblems(result: Record<string, unknown>, clientCapabilities: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const { inputRequests, requestState } = result;
  if (inputRequests === undefined && requestState === undefined) {
    problems.push("neither inputRequests nor requestState present");
  }
  if (inputRequests !== undefined) {
    if (!isObject(inputRequests)) {
      problems.push(`inputRequests is not an object (got ${brief(inputRequests)})`);
    } else {
      for (const [key, req] of Object.entries(inputRequests)) {
        const k = ascii(key);
        if (!isObject(req)) {
          problems.push(`inputRequests.${k} is not an object`);
          continue;
        }
        const method = typeof req.method === "string" ? req.method : undefined;
        if (method === undefined || !INPUT_REQUEST_METHODS.has(method)) {
          problems.push(
            `inputRequests.${k}.method ${brief(req.method)} is not one of ${[...INPUT_REQUEST_METHODS].join(", ")}`,
          );
          continue;
        }
        const capability = INPUT_REQUEST_CAPABILITY[method];
        const declaration = capability !== undefined ? clientCapabilities[capability] : undefined;
        if (capability !== undefined && !isObject(declaration)) {
          const declared = Object.keys(clientCapabilities);
          problems.push(
            `server requested ${method} although the client declared ${declared.length > 0 ? `only ${declared.join(", ")}` : "no capabilities"}`,
          );
        }
        if (INPUT_REQUEST_PARAMS_REQUIRED.has(method) && !isObject(req.params)) {
          problems.push(`inputRequests.${k}.params is not an object (required for ${method})`);
        } else if (method === "elicitation/create" && isObject(declaration) && isObject(req.params)) {
          const modes = declaredElicitationModes(declaration);
          const mode = req.params.mode === undefined ? DEFAULT_ELICITATION_MODE : req.params.mode;
          if (typeof mode !== "string" || !modes.includes(mode)) {
            problems.push(
              `inputRequests.${k}.params.mode ${brief(mode)} is not an elicitation mode the client declared (${modes.join(", ")})`,
            );
          }
        }
      }
    }
  }
  if (requestState !== undefined && typeof requestState !== "string") {
    problems.push(`requestState is not a string (got ${brief(requestState)})`);
  }
  return problems;
}

export async function runPostHoc(ctx: ModernSuiteContext): Promise<void> {
  const { harness, recorder } = ctx;
  const timeline = buildTimeline(recorder);
  const total = recorder.size;
  /**
   * Every post-hoc check is a deterministic scan of a finished recording:
   * a retry cannot change its verdict, so `--retries` would only sleep
   * between identical failures. The id type ties each call to POSTHOC_IDS.
   */
  const check = (id: PostHocId, fn: () => Promise<TestOutcome>) => harness.check(id, fn, { retries: 0 });

  // A scan over nothing proves nothing. The lifecycle setup discover runs
  // unconditionally, so an empty recorder means no JSON-RPC message ever
  // came back (unreachable, dead on the first byte, or every reply a
  // non-JSON body such as an HTML 401 page); a vacuous pass here would
  // inflate the required-test count of a run that measured nothing.
  if (total === 0) {
    const nothing = async () => ({
      passed: false,
      details: "no JSON-RPC messages were received from the server during the run, so there is nothing to scan",
    });
    for (const id of POSTHOC_IDS) await check(id, nothing);
    return;
  }

  // ── transport-no-server-requests ───────────────────────────────
  await check("transport-no-server-requests", async () => {
    const requests = recorder.serverRequests();
    if (requests.length === 0) {
      return {
        passed: true,
        details: `${plural(total, "server message")} scanned; none is a server-to-client request`,
      };
    }
    const first = requests[0] as ReceivedMessage;
    const m = first.message as Record<string, unknown>;
    const during = timeline.inFlight.get(first);
    const where = during ? ` during ${ascii(during.method || "raw probe")}` : "";
    return {
      passed: false,
      details: `server sent ${plural(requests.length, "JSON-RPC request")} on a response stream; first: ${ascii(String(m.method))} (id ${fmtId(m.id)})${where}`,
    };
  });

  // ── lifecycle-log-level-gating ─────────────────────────────────
  await check("lifecycle-log-level-gating", async () => {
    const notifications = recorder.notifications();
    const logs = notifications.filter((e) => (e.message as Record<string, unknown>).method === "notifications/message");
    const optedIn = recorder.sent.filter(
      (s) => s.meta !== undefined && typeof s.meta[META.logLevel] === "string",
    ).length;
    const scanned = `${plural(total, "server message")} scanned (${plural(notifications.length, "notification")})`;
    if (logs.length === 0) {
      return {
        passed: true,
        details: `${scanned}; no notifications/message, ${plural(optedIn, "request")} set logLevel`,
      };
    }
    // A log frame is fine only when the request it arrived on opted in.
    const offenders = logs.filter((e) => {
      const req = timeline.inFlight.get(e);
      return !req || req.meta === undefined || typeof req.meta[META.logLevel] !== "string";
    });
    if (offenders.length === 0) {
      return {
        passed: true,
        details: `${scanned}; ${plural(logs.length, "notifications/message")}, each on a request that set logLevel`,
      };
    }
    const first = offenders[0] as ReceivedMessage;
    const req = timeline.inFlight.get(first);
    const params = (first.message as Record<string, unknown>).params;
    const level = isObject(params) ? brief(params.level) : "no level";
    const on = req ? `on ${ascii(req.method || "raw probe")}` : "outside any request";
    return {
      passed: false,
      details: `${plural(offenders.length, "notifications/message")} (level ${level}) ${on} without _meta logLevel; ${scanned}`,
    };
  });

  // ── error-id-echo ──────────────────────────────────────────────
  // Only JSON-RPC error responses count (basic/index#error-responses
  // scopes the id MUST to those): an auth gate's `{"error":"..."}` body
  // or a GCP-style `{"error":{"code":400,...}}` is not one. A null or
  // missing id is exempt only when no id-bearing request owns the reply
  // (a raw probe, a client notification, or nothing sent yet at all -- a
  // stray at boot, noted as such) or the reply is a
  // transport-level rejection (HTTP 401/403/413/415/429, answered before
  // the JSON-RPC layer read the id). A reply no open send can own is a
  // second answer and is blamed on the most recent request sent before
  // it (see Timeline), so a server that answers a request twice fails
  // in either frame order. A PRESENT but wrong id is an
  // offender whatever the status: the id was read and then retyped or
  // replaced. The error CODE does not exempt anything: every body the
  // client sent through rpc() is well-formed with a readable id, so a
  // null-id -32600/-32700 answering one is exactly the violation the
  // catalog names.
  await check("error-id-echo", async () => {
    const errors = jsonRpcErrors(recorder);
    const nonJsonRpc = recorder.errors().length - errors.length;
    let scanned = 0;
    let ownerless = 0;
    /** Unmatched replies that arrived before anything was sent (a stray written at boot). */
    let unowned = 0;
    let rejected = 0;
    const offenders: { method: string; expected: unknown; got: unknown }[] = [];
    for (const entry of errors) {
      const m = entry.message as Record<string, unknown>;
      if (entry.request) {
        scanned++;
        if (!sameId(m.id, entry.request.id)) {
          offenders.push({ method: entry.request.method, expected: entry.request.id, got: m.id });
        }
        continue;
      }
      const owner = timeline.unmatched.get(entry) ?? timeline.repeated.get(entry) ?? null;
      if (!owner) {
        unowned++;
        continue;
      }
      if (owner.id === undefined || owner.raw !== undefined) {
        ownerless++;
        continue;
      }
      if (idAbsent(m) && isTransportRejection(entry)) {
        rejected++;
        continue;
      }
      scanned++;
      offenders.push({ method: owner.method, expected: owner.id, got: m.id });
    }
    const exemptions: string[] = [];
    if (ownerless > 0) exemptions.push(`${ownerless} answering raw probes or client notifications`);
    if (unowned > 0) exemptions.push(`${unowned} received while no request was pending`);
    if (rejected > 0) {
      exemptions.push(`${rejected} without an id on transport-level rejections (HTTP 401/403/413/415/429)`);
    }
    if (nonJsonRpc > 0) {
      exemptions.push(`${nonJsonRpc} non-JSON-RPC error ${nonJsonRpc === 1 ? "body" : "bodies"} not counted`);
    }
    const exemptNote = exemptions.length > 0 ? ` (exempt: ${exemptions.join("; ")})` : "";
    if (offenders.length > 0) {
      const first = offenders[0] as { method: string; expected: unknown; got: unknown };
      return {
        passed: false,
        details: `${offenders.length} of ${plural(scanned, "error response")} did not echo the request id; first: ${ascii(first.method)} sent id ${fmtId(first.expected)}, reply carried ${fmtId(first.got)}${exemptNote}`,
      };
    }
    if (scanned === 0) {
      return { passed: true, details: `no error responses to id-bearing requests recorded${exemptNote}` };
    }
    return {
      passed: true,
      details: `${plural(scanned, "error response")} scanned; every one echoes its request id${exemptNote}`,
    };
  });

  // ── error-retired-codes ────────────────────────────────────────
  await check("error-retired-codes", async () => {
    const errors = jsonRpcErrors(recorder);
    const retired = Object.keys(RETIRED_ERROR_CODES).join(", ");
    const hits = errors.filter((e) => {
      const code = errorOf(e.message)?.code;
      return code !== undefined && code in RETIRED_ERROR_CODES;
    });
    if (hits.length === 0) {
      return {
        passed: true,
        details: `${plural(errors.length, "error response")} scanned; none uses a retired code (${retired})`,
      };
    }
    const first = hits[0] as ReceivedMessage;
    const code = errorOf(first.message)?.code as number;
    return {
      passed: false,
      details: `${hits.length} of ${plural(errors.length, "error response")} use a retired code; first: ${code} (${RETIRED_ERROR_CODES[code]}) on ${methodOf(first, timeline)}`,
    };
  });

  // ── schema-result-type ─────────────────────────────────────────
  // basic/index#result-responses: the value set is the core one
  // (complete, input_required) plus values of extensions ADVERTISED via
  // capabilities; anything unrecognized MUST be treated as invalid. So
  // without an `extensions` capability only the two core values pass;
  // with one, other strings pass with a warning naming the value (the
  // suite cannot tell which extension defines it).
  await check("schema-result-type", async () => {
    const all = recorder.results();
    const results = all.filter((e) => !isLegacyInitializeReply(e));
    const legacyNote =
      all.length !== results.length ? ` (${all.length - results.length} legacy initialize reply exempt)` : "";
    const extensions = ctx.state.capabilities.extensions;
    const advertised = isObject(extensions) ? Object.keys(extensions) : [];
    const offenders: { entry: ReceivedMessage; why: string }[] = [];
    const extensionValues = new Map<string, string>();
    for (const entry of results) {
      const result = (entry.message as Record<string, unknown>).result;
      if (!isObject(result)) {
        offenders.push({ entry, why: `result ${brief(result)}` });
        continue;
      }
      const type = result.resultType;
      if (typeof type !== "string") {
        offenders.push({ entry, why: `resultType ${brief(type)}` });
        continue;
      }
      if (CORE_RESULT_TYPES.has(type)) continue;
      if (advertised.length === 0) {
        offenders.push({
          entry,
          why: `resultType ${brief(type)} is neither complete nor input_required and no extension is advertised`,
        });
        continue;
      }
      if (!extensionValues.has(type)) extensionValues.set(type, methodOf(entry, timeline));
    }
    for (const [type, method] of extensionValues) {
      harness.warnings.push(
        `schema-result-type: resultType ${brief(type)} on ${method} is not a core value; accepted because the server advertises extensions (${advertised.join(", ")}) -- verify one of them defines it.`,
      );
    }
    if (offenders.length > 0) {
      const first = offenders[0] as { entry: ReceivedMessage; why: string };
      return {
        passed: false,
        details: `${offenders.length} of ${plural(results.length, "result")} ${offenders.length === 1 ? "lacks" : "lack"} a valid resultType; first: ${methodOf(first.entry, timeline)} (${first.why})${legacyNote}`,
      };
    }
    if (results.length === 0) return { passed: true, details: `no results recorded${legacyNote}` };
    const accepted =
      extensionValues.size > 0
        ? `complete, input_required, or an extension value (${[...extensionValues.keys()].map(brief).join(", ")}; see warning)`
        : "complete or input_required";
    return {
      passed: true,
      details: `${plural(results.length, "result")} scanned; every resultType is ${accepted}${legacyNote}`,
    };
  });

  // ── schema-no-input-required-on-lists ──────────────────────────
  await check("schema-no-input-required-on-lists", async () => {
    const results = recorder.results();
    const inputRequired = inputRequiredResults(recorder);
    if (inputRequired.length === 0) {
      return {
        passed: true,
        details: `${plural(results.length, "result")} scanned; no input_required result observed`,
      };
    }
    let unattributed = 0;
    const offenders = inputRequired.filter((e) => {
      const req = requestOf(e, timeline);
      if (!req || req.raw !== undefined) {
        unattributed++;
        return false;
      }
      return !MRTR_METHODS.has(req.method);
    });
    const unattributedNote = unattributed > 0 ? ` (${unattributed} could not be attributed to a request)` : "";
    if (offenders.length > 0) {
      const first = offenders[0] as ReceivedMessage;
      return {
        passed: false,
        details: `input_required returned for ${methodOf(first, timeline)}, which is not an MRTR method (${offenders.length} of ${plural(inputRequired.length, "input_required result")})${unattributedNote}`,
      };
    }
    return {
      passed: true,
      details: `${plural(inputRequired.length, "input_required result")} among ${results.length} results, all on ${[...MRTR_METHODS].join(", ")}${unattributedNote}`,
    };
  });

  // ── schema-input-required-shape ────────────────────────────────
  await check("schema-input-required-shape", async () => {
    const inputRequired = inputRequiredResults(recorder);
    if (inputRequired.length === 0) {
      return { passed: true, details: "no input_required results observed (nothing to validate)" };
    }
    const capabilities = ctx.client.clientCapabilities;
    const declared = Object.keys(capabilities);
    const elicitation = capabilities.elicitation;
    const modesNote = isObject(elicitation)
      ? `, elicitation modes within the declared [${declaredElicitationModes(elicitation).join(", ")}]`
      : "";
    const violating: { entry: ReceivedMessage; problems: string[] }[] = [];
    for (const entry of inputRequired) {
      const result = (entry.message as Record<string, unknown>).result as Record<string, unknown>;
      const problems = inputRequiredProblems(result, capabilities);
      if (problems.length > 0) violating.push({ entry, problems });
    }
    if (violating.length > 0) {
      const first = violating[0] as { entry: ReceivedMessage; problems: string[] };
      return {
        passed: false,
        details: `${violating.length} of ${plural(inputRequired.length, "input_required result")} ${violating.length === 1 ? "violates" : "violate"} the MRTR server requirements; first (${methodOf(first.entry, timeline)}): ${first.problems[0]}`,
      };
    }
    return {
      passed: true,
      details: `${plural(inputRequired.length, "input_required result")} observed, every one well-formed (inputRequests/requestState present, methods allowed and declared by the client [${declared.join(", ")}], params present where required${modesNote})`,
    };
  });

  // ── schema-wire-valid ──────────────────────────────────────────
  await check("schema-wire-valid", async () => {
    const validator = getWireValidator();
    let scanned = 0;
    let skipped = 0;
    /** Non-JSON-RPC bodies on HTTP error responses (4xx/5xx), by status. */
    const rejectionBodies = new Map<number, number>();
    /** Distinct violations in first-seen order: (method or resultType, first schema error) -> count. */
    const groups = new Map<string, { label: string; text: string; count: number }>();
    let violating = 0;
    for (const entry of recorder.received) {
      const m = entry.message;
      const owner = requestOf(entry, timeline);
      // Replies to raw probes (malformed bodies) are whatever the server
      // could make of garbage; non-objects are the batch/scalar cases
      // other tests own; a legacy initialize reply is a 2025 message.
      if (!isObject(m) || owner?.raw !== undefined || isLegacyInitializeReply(entry)) {
        skipped++;
        continue;
      }
      // A non-JSON-RPC body on an HTTP error status is an intermediary's
      // (an auth gate's 401, a header-validating proxy's 400, a gateway's
      // 502): the spec lets such a body be anything, a JSON-RPC error
      // only MAY appear. Not a schema violation: noted. At 2xx the same
      // body IS the server's answer and is validated.
      if (!isJsonRpcMessage(m) && isHttpError(entry)) {
        const status = entry.statusCode as number;
        rejectionBodies.set(status, (rejectionBodies.get(status) ?? 0) + 1);
        continue;
      }
      scanned++;
      // JSON-RPC 2.0 requires `id: null` on an error whose request id
      // could not be read; the 2026-07-28 schema models the same case as
      // an omitted id. Treat null as omitted so a conformant parse error
      // is not reported; error-id-echo judges whether null was earned.
      const target =
        "error" in m && m.id === null ? Object.fromEntries(Object.entries(m).filter(([k]) => k !== "id")) : m;
      const found = validator.validateServerMessage(target, { requestMethod: owner?.method || undefined });
      const worst = found[0];
      if (!worst) continue;
      violating++;
      const label = violationLabel(m, owner);
      const text = ascii(formatViolation(worst));
      const clipped = text.length > VIOLATION_TEXT_MAX ? `${text.slice(0, VIOLATION_TEXT_MAX - 3)}...` : text;
      const more = found.length > 1 ? ` (+${found.length - 1} more)` : "";
      const key = `${label}: ${text}`;
      const group = groups.get(key);
      if (group) group.count++;
      else groups.set(key, { label, text: `${clipped}${more}`, count: 1 });
    }
    const notes: string[] = [];
    if (skipped > 0) notes.push(`${skipped} skipped: raw-probe replies, non-objects, legacy initialize`);
    if (rejectionBodies.size > 0) {
      const total = [...rejectionBodies.values()].reduce((n, c) => n + c, 0);
      const byStatus = [...rejectionBodies].map(([status, n]) => `HTTP ${status} x${n}`).join(", ");
      notes.push(
        `${total} non-JSON-RPC ${total === 1 ? "body" : "bodies"} on HTTP error responses not validated (${byStatus})`,
      );
    }
    const skippedNote = notes.length > 0 ? ` (${notes.join("; ")})` : "";
    if (violating > 0) {
      const distinct = [...groups.values()];
      const render = (g: { label: string; text: string; count: number }) =>
        `${g.label}${g.count > 1 ? ` x${g.count}` : ""}: ${g.text}`;
      const inline = distinct.slice(0, INLINE_VIOLATIONS);
      const rest = distinct.slice(INLINE_VIOLATIONS, INLINE_VIOLATIONS + WARNED_VIOLATIONS);
      if (rest.length > 0) {
        const beyond = distinct.length - INLINE_VIOLATIONS - rest.length;
        const inlineMessages = inline.reduce((n, g) => n + g.count, 0);
        harness.warnings.push(
          `schema-wire-valid: ${violating - inlineMessages} more message(s) violate the 2026-07-28 schema: ${rest.map(render).join(" | ")}${beyond > 0 ? ` (and ${beyond} more distinct violation(s))` : ""}`,
        );
      }
      return {
        passed: false,
        details: `${violating} of ${plural(scanned, "server message")} violate the 2026-07-28 schema (${plural(distinct.length, "distinct violation")}): ${inline.map(render).join(" | ")}${skippedNote}`,
      };
    }
    if (scanned === 0) return { passed: true, details: `no server messages to validate${skippedNote}` };
    return {
      passed: true,
      details: `${plural(scanned, "server message")} validated against the 2026-07-28 schema; no violations${skippedNote}`,
    };
  });
}

/**
 * What a schema violation is grouped and labelled by: the originating
 * request's method for a response (plus `input_required` when that is
 * the result's type, since the def differs), the message's own method
 * for a notification or server request, "unattributed" otherwise.
 */
function violationLabel(m: Record<string, unknown>, owner: SentRequest | null): string {
  if (typeof m.method === "string") return ascii(m.method);
  const method = owner ? ascii(owner.method || "raw probe") : "unattributed";
  const result = m.result;
  if (isObject(result) && result.resultType === RESULT_TYPE_INPUT_REQUIRED) return `${method} (input_required)`;
  return method;
}
