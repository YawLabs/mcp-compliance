import { errorOf } from "../../modern/client.js";
import {
  INPUT_REQUEST_METHODS,
  JSONRPC_ERROR_CODES,
  META,
  MRTR_METHODS,
  RETIRED_ERROR_CODES,
} from "../../modern/meta.js";
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

const RESULT_TYPE_INPUT_REQUIRED = "input_required";
/** Codes a server sends when it could not read the request envelope, so no id was available to echo. */
const ENVELOPE_ERROR_CODES = new Set<number>([JSONRPC_ERROR_CODES.PARSE_ERROR, JSONRPC_ERROR_CODES.INVALID_REQUEST]);
/** Violations named inline in schema-wire-valid's details; the next ones go to a warning. */
const INLINE_VIOLATIONS = 3;
const WARNED_VIOLATIONS = 5;
const VIOLATION_TEXT_MAX = 90;

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function isResponse(m: unknown): m is Record<string, unknown> {
  return isObject(m) && ("result" in m || "error" in m);
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
 * with `request: undefined`. The timeline replays sent and received
 * entries in sequence order and keeps the requests still awaiting an
 * answer; an unmatched response is attributed to the most recently sent
 * unanswered entry (the suite is sequential apart from a few
 * parallel-safe rpc calls, so this is the request whose connection or
 * turn it arrived on), and a notification is attributed to the request
 * in flight when it arrived. A raw probe or a client notification is a
 * legitimate owner of an id-less reply; an id-bearing request is not.
 */
interface Timeline {
  /** Unmatched responses -> the sent entry they most plausibly answer (null = nothing was pending). */
  unmatched: Map<ReceivedMessage, SentRequest | null>;
  /** Every received entry -> the request in flight when it arrived (null = none). */
  inFlight: Map<ReceivedMessage, SentRequest | null>;
}

function buildTimeline(recorder: Recorder): Timeline {
  type Event = { seq: number; sent?: SentRequest; received?: ReceivedMessage };
  const events: Event[] = [
    ...recorder.sent.map((sent) => ({ seq: sent.seq, sent })),
    ...recorder.received.map((received) => ({ seq: received.seq, received })),
  ].sort((a, b) => a.seq - b.seq);
  const unanswered: SentRequest[] = [];
  const unmatched = new Map<ReceivedMessage, SentRequest | null>();
  const inFlight = new Map<ReceivedMessage, SentRequest | null>();
  for (const ev of events) {
    if (ev.sent) {
      unanswered.push(ev.sent);
      continue;
    }
    const entry = ev.received as ReceivedMessage;
    inFlight.set(entry, unanswered[unanswered.length - 1] ?? null);
    if (!isResponse(entry.message)) continue; // notifications and server requests answer nothing
    if (entry.request) {
      const idx = unanswered.lastIndexOf(entry.request);
      if (idx !== -1) unanswered.splice(idx, 1);
      continue;
    }
    unmatched.set(entry, unanswered.pop() ?? null);
  }
  return { unmatched, inFlight };
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

/** Every way one InputRequiredResult can be malformed, in wire order. */
function inputRequiredProblems(result: Record<string, unknown>): string[] {
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
        if (typeof req.method !== "string" || !INPUT_REQUEST_METHODS.has(req.method)) {
          problems.push(
            `inputRequests.${k}.method ${brief(req.method)} is not one of ${[...INPUT_REQUEST_METHODS].join(", ")}`,
          );
        }
        if (!isObject(req.params)) problems.push(`inputRequests.${k}.params is not an object`);
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

  // ── transport-no-server-requests ───────────────────────────────
  await harness.check("transport-no-server-requests", async () => {
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
  await harness.check("lifecycle-log-level-gating", async () => {
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
  await harness.check("error-id-echo", async () => {
    const errors = recorder.errors();
    let scanned = 0;
    let exempt = 0;
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
      const owner = timeline.unmatched.get(entry) ?? null;
      // No id-bearing request owns this error: a raw probe, a client
      // notification, or nothing in flight. Nothing to echo.
      if (!owner || owner.id === undefined || owner.raw !== undefined) {
        exempt++;
        continue;
      }
      // The envelope could not be read (parse error, invalid request):
      // JSON-RPC 2.0 prescribes id null there even though the body we
      // sent had one.
      const code = errorOf(m)?.code;
      if ((m.id === null || m.id === undefined) && code !== undefined && ENVELOPE_ERROR_CODES.has(code)) {
        exempt++;
        continue;
      }
      scanned++;
      offenders.push({ method: owner.method, expected: owner.id, got: m.id });
    }
    const exemptNote = exempt > 0 ? ` (${exempt} answering raw probes or unparsable bodies exempt)` : "";
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
  await harness.check("error-retired-codes", async () => {
    const errors = recorder.errors();
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
  await harness.check("schema-result-type", async () => {
    const all = recorder.results();
    const results = all.filter((e) => !isLegacyInitializeReply(e));
    const legacyNote =
      all.length !== results.length ? ` (${all.length - results.length} legacy initialize reply exempt)` : "";
    const offenders = results.filter((e) => {
      const result = (e.message as Record<string, unknown>).result;
      return !isObject(result) || typeof result.resultType !== "string";
    });
    if (offenders.length > 0) {
      const first = offenders[0] as ReceivedMessage;
      const result = (first.message as Record<string, unknown>).result;
      const got = isObject(result) ? `resultType ${brief(result.resultType)}` : `result ${brief(result)}`;
      return {
        passed: false,
        details: `${offenders.length} of ${plural(results.length, "result")} lack a string resultType; first: ${methodOf(first, timeline)} (${got})${legacyNote}`,
      };
    }
    if (results.length === 0) return { passed: true, details: `no results recorded${legacyNote}` };
    return {
      passed: true,
      details: `${plural(results.length, "result")} scanned; every one carries a string resultType${legacyNote}`,
    };
  });

  // ── schema-no-input-required-on-lists ──────────────────────────
  await harness.check("schema-no-input-required-on-lists", async () => {
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
  await harness.check("schema-input-required-shape", async () => {
    const inputRequired = inputRequiredResults(recorder);
    if (inputRequired.length === 0) {
      return { passed: true, details: "no input_required results observed (nothing to validate)" };
    }
    const malformed: { entry: ReceivedMessage; problems: string[] }[] = [];
    for (const entry of inputRequired) {
      const result = (entry.message as Record<string, unknown>).result as Record<string, unknown>;
      const problems = inputRequiredProblems(result);
      if (problems.length > 0) malformed.push({ entry, problems });
    }
    if (malformed.length > 0) {
      const first = malformed[0] as { entry: ReceivedMessage; problems: string[] };
      return {
        passed: false,
        details: `${malformed.length} of ${plural(inputRequired.length, "input_required result")} malformed; first (${methodOf(first.entry, timeline)}): ${first.problems[0]}`,
      };
    }
    return {
      passed: true,
      details: `${plural(inputRequired.length, "input_required result")} observed, every one well-formed (inputRequests/requestState present, methods allowed)`,
    };
  });

  // ── schema-wire-valid ──────────────────────────────────────────
  await harness.check("schema-wire-valid", async () => {
    const validator = getWireValidator();
    let scanned = 0;
    let skipped = 0;
    const violations: string[] = [];
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
      const method = owner ? ascii(owner.method || "raw probe") : "unattributed";
      const text = ascii(formatViolation(worst));
      const more = found.length > 1 ? ` (+${found.length - 1} more)` : "";
      violations.push(
        `${method}: ${text.length > VIOLATION_TEXT_MAX ? `${text.slice(0, VIOLATION_TEXT_MAX - 3)}...` : text}${more}`,
      );
    }
    const skippedNote = skipped > 0 ? ` (${skipped} skipped: raw-probe replies, non-objects, legacy initialize)` : "";
    if (violations.length > 0) {
      const inline = violations.slice(0, INLINE_VIOLATIONS).join(" | ");
      const rest = violations.slice(INLINE_VIOLATIONS, INLINE_VIOLATIONS + WARNED_VIOLATIONS);
      if (rest.length > 0) {
        const beyond = violations.length - INLINE_VIOLATIONS - rest.length;
        harness.warnings.push(
          `schema-wire-valid: ${violations.length - INLINE_VIOLATIONS} more message(s) violate the 2026-07-28 schema: ${rest.join(" | ")}${beyond > 0 ? ` (and ${beyond} more)` : ""}`,
        );
      }
      return {
        passed: false,
        details: `${violations.length} of ${plural(scanned, "server message")} violate the 2026-07-28 schema: ${inline}${skippedNote}`,
      };
    }
    if (scanned === 0) return { passed: true, details: `no server messages to validate${skippedNote}` };
    return {
      passed: true,
      details: `${plural(scanned, "server message")} validated against the 2026-07-28 schema; no violations${skippedNote}`,
    };
  });
}
