import { errorCodeText, errorWithCode } from "../../checks/validators.js";
import { authRefusalHint, readAuthRefusal } from "../../detect.js";
import type { TestOutcome } from "../../harness.js";
import { errorOf, type RpcResponse, resultOf } from "../../modern/client.js";
import { HEADER_METHOD, HEADER_NAME, HEADER_PROTOCOL_VERSION } from "../../modern/headers.js";
import { META, MODERN_ERROR_CODES } from "../../modern/meta.js";
import { parseSSEMessages } from "../../sse.js";
import type { HttpTransport } from "../../transport/http.js";
import {
  ensurePrompts,
  ensureResources,
  hasPrompts,
  hasResources,
  LIST_METHOD,
  type ListKey,
  listUnavailable,
  type ModernSuiteContext,
} from "./context.js";
import {
  discoverTwin,
  type GateAnswer,
  gateVerdict,
  httpStatusText,
  resendOn429,
  rpcErrorSuffix,
  type Twin,
} from "./gate.js";
import { notEvaluable, transportLevelRejection } from "./lifecycle.js";
import { unreachable } from "./security.js";

/**
 * Streamable HTTP transport tests of the 2026-07-28 suite (16 in the
 * catalog; the post-hoc `transport-no-server-requests` lives in
 * posthoc.ts). Every test here is `transports: ["http"]` in the catalog,
 * so the harness never runs them on stdio; the `ctx.kind` guards below
 * only keep a future catalog change from crashing a stdio run.
 *
 * `transport-header-name-mismatch` reads the resource / prompt lists
 * through the context's `ensure*` loaders, which fetch once on demand, so
 * a `--only transport` run still reads a real resource; it skip-passes
 * when the server declares neither capability or nothing listed is
 * readable by name, and when the list calls failed it points at the
 * `-list` tests that report the failure -- or fails with the recorded
 * reason when this run filtered those tests out (see `listUnavailable`).
 */

const DISCOVER = "server/discover";
const HEADER_MISMATCH = MODERN_ERROR_CODES.HEADER_MISMATCH;

function notApplicable(what: string): TestOutcome {
  return { passed: true, details: `not applicable on stdio (${what})` };
}

function is2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

function is4xx(status: number): boolean {
  return status >= 400 && status < 500;
}

function contentTypeOf(headers: Record<string, string>): string {
  return (headers["content-type"] || "").toLowerCase();
}

/** A JSON-RPC response (result or error), as opposed to a notification, a request or junk. */
function isJsonRpcResponse(message: unknown): boolean {
  return !!message && typeof message === "object" && ("result" in message || "error" in message);
}

/** Case-insensitive header lookup on a normalized (lowercase-keyed) response header map. */
function headerOf(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/**
 * `describeResponse` without the server's message (which can be long and
 * is not needed to name the verdict); `withMessage` adds a clipped copy
 * where it helps the reader (an unexpected error on the baseline POST).
 */
function summarize(res: RpcResponse, withMessage = false): string {
  const err = errorOf(res.body);
  if (err) {
    const msg = withMessage && err.message ? ` (${clip(err.message, 80)})` : "";
    return `${errorWithCode(err.rawCode)}${msg}`;
  }
  return resultOf(res.body) ? "result" : "non-JSON-RPC body";
}

function clip(text: string, max: number): string {
  const ascii = text.replace(/[^\x20-\x7e]/g, "?");
  return ascii.length > max ? `${ascii.slice(0, max - 3)}...` : ascii;
}

/**
 * The server's own rejection of a batch: -32600 (Invalid Request). A
 * gateway with no backend has not read the batch and cannot produce it, so
 * a 5xx carrying it is credited, with a warning (gateVerdict).
 */
const BATCH_GATE = {
  check: "transport-batch-reject",
  what: "a batch",
  about: "the batch",
  ownCodes: [-32600],
};
/** A text/plain POST has no JSON-RPC code of its own, so every 5xx on it is a failure (gateVerdict). */
const TEXT_PLAIN_GATE = {
  check: "transport-content-type-reject",
  what: "a text/plain POST",
  about: "the Content-Type",
  ownCodes: [],
};

/** The first JSON-RPC message in a raw body: plain JSON, or the first response on an SSE stream. */
function rawRpcBody(res: { body: string; headers: Record<string, string> }): unknown {
  if (contentTypeOf(res.headers).includes("text/event-stream")) {
    return parseSSEMessages(res.body).find(isJsonRpcResponse);
  }
  try {
    return JSON.parse(res.body);
  } catch {
    return undefined;
  }
}

type RawAnswer = Awaited<ReturnType<ModernSuiteContext["client"]["raw"]>>;

const DETAILS_MAX = 220;

/**
 * Send a raw negative probe, resent once after Retry-After when a rate
 * limiter answered it 429 (resendOn429). A probe that got no answer at all
 * -- on the first send, or on the resend after a 429 -- is "server
 * unreachable" (`unreachable`: a timeout, a closed or a refused connection),
 * naming the 429 when it was the resend that went unanswered. A caller's
 * abort is rethrown.
 */
async function sendRawProbe(
  ctx: ModernSuiteContext,
  what: string,
  send: () => Promise<RawAnswer>,
): Promise<{ res: RawAnswer; throttledMs: number | null } | { outcome: TestOutcome }> {
  let throttled = false;
  try {
    const first = await send();
    throttled = ctx.kind === "http" && first.statusCode === 429;
    return await resendOn429(ctx, first, send);
  } catch (err) {
    if (ctx.signal?.aborted) throw err;
    return { outcome: unreachable(ctx, throttled ? `${what} answered HTTP 429, and its resend` : what, err) };
  }
}

/**
 * The conformant twin a 403 without a Bearer challenge on a probe is read
 * against (gateVerdict). When the setup server/discover -- the same
 * conformant request, with the same headers -- was itself refused with the
 * probe's status, its answer is the twin's: a fresh server/discover would
 * be refused the same way, and whatever it drew the rejection could not be
 * credited (rawProbeGate reads the rejected setup discover as not
 * evaluable). Otherwise a fresh one is sent (discoverTwin).
 */
function twinFor(ctx: ModernSuiteContext, statusCode: number): Twin {
  const setup = ctx.state.discoverRejection;
  if (ctx.state.discover || !setup || setup.statusCode !== statusCode) return discoverTwin(ctx);
  const refused = statusCode === 401 || statusCode === 403;
  const code = setup.code === null ? "" : `, ${errorWithCode(setup.rawCode)}`;
  return async () => ({
    request: DISCOVER,
    served: false,
    outcome: `${refused ? "was refused" : "was not served"} (HTTP ${statusCode}${code})`,
    statusCode,
  });
}

/**
 * "<status seen>, <JSON-RPC code> on <probe>; <reason>" within DETAILS_MAX.
 * The reason is the conclusion and is kept whole, so the head gives way:
 * first the probe's JSON-RPC code, then the probe's name (the reason names
 * what the probe varied), leaving the status. A reason too long to fit even
 * then is gateVerdict's own and is not cut.
 */
function gatedDetails(seen: string, rpcSuffix: string, on: string, reason: string): string {
  const heads = [`${seen}${rpcSuffix} on ${on}`, `${seen} on ${on}`, seen];
  const head = heads.find((h) => h.length + 2 + reason.length <= DETAILS_MAX) ?? seen;
  return `${head}; ${reason}`;
}

/**
 * Why a rejection of a raw negative probe -- the text/plain POST, the batch
 * -- is not the server's answer to its defect, or null when it is. A
 * rejection is a status >= 400, or a JSON-RPC error on any status (a
 * gateway's -32001 on HTTP 200); an answer below 400 without one (a
 * result, a processed batch, an HTML page) is judged by the check itself.
 *
 * - Something in front of the server answered in its place: the 2025-11-25
 *   checks' gateRefusal / bare403Verdict reading (gateVerdict). A 401, a
 *   403 carrying a Bearer challenge, a 429 still a 429 after its one
 *   resend, or a 403 the conformant server/discover (the twin) could not
 *   get past either. A 5xx without the probe's own code fails too, as the
 *   server failing on the probe rather than rejecting it (gateVerdict).
 * - The conformant setup server/discover was itself rejected or never
 *   answered (notEvaluable): a server that rejects everything proves
 *   nothing by rejecting the probe too. The gate's reason is preferred when
 *   it has one (it names the gate); a 5xx is not read by the gate then, so
 *   its own code is never credited with a warning next to this failure.
 *
 * The details open with what was seen ("HTTP 401, JSON-RPC error -32001 on
 * the batch"). A caller's abort (while the twin is sent) is rethrown.
 */
async function rawProbeGate(
  ctx: ModernSuiteContext,
  res: RawAnswer,
  throttledMs: number | null,
  on: string,
  spec: typeof BATCH_GATE | typeof TEXT_PLAIN_GATE,
): Promise<TestOutcome | null> {
  const answer: GateAnswer = { statusCode: res.statusCode, headers: res.headers, body: rawRpcBody(res) };
  if (res.statusCode < 400 && !errorOf(answer.body)) return null;
  const setup = notEvaluable(ctx, spec.about);
  const gated =
    res.statusCode >= 400 && !(setup && res.statusCode >= 500)
      ? await gateVerdict(ctx, answer, { ...spec, twin: twinFor(ctx, res.statusCode) })
      : null;
  const reason = gated ?? setup;
  if (!reason) return null;
  return {
    passed: false,
    details: gatedDetails(httpStatusText(res.statusCode, throttledMs), rpcErrorSuffix(answer.body), on, reason),
  };
}

/**
 * Shared verdict for the standard-header rejection tests. HTTP 400 is the
 * hard requirement (an intermediary may reject with a bare 400 the tool
 * cannot tell from the server's). The -32020 HeaderMismatch code is hard
 * only when `codeRequired`; otherwise a missing or different code passes
 * with a warning naming the test. A 400 is credited to the injected
 * header defect only when the conformant discover was served: a server
 * that rejects everything (a legacy-only server pinned to this suite)
 * proves nothing by rejecting a malformed variant too. A transport-level
 * status (401/403/413/415/429: an auth gate or rate limiter answering
 * before the JSON-RPC layer) is not evaluable either, rather than "the
 * wrong status".
 */
function evaluateHeaderRejection(
  ctx: ModernSuiteContext,
  testId: string,
  res: RpcResponse,
  opts: { codeRequired: boolean },
): TestOutcome {
  const err = errorOf(res.body);
  const observed = `HTTP ${res.statusCode}, ${summarize(res)}`;
  // A served request is a defect whatever the discover state; only a
  // rejection needs attributing.
  if (res.statusCode < 400 || resultOf(res.body)) {
    return { passed: false, details: `${observed} (expected HTTP 400)` };
  }
  const unattributable = notEvaluable(ctx) ?? transportLevelRejection(ctx, res);
  if (unattributable) return { passed: false, details: unattributable };
  if (res.statusCode !== 400) {
    return { passed: false, details: `${observed} (expected HTTP 400)` };
  }
  if (err && err.code === HEADER_MISMATCH) {
    return { passed: true, details: `HTTP 400, JSON-RPC error -32020 HeaderMismatch` };
  }
  const codeText = !err
    ? "no JSON-RPC error body"
    : Number.isInteger(err.rawCode)
      ? `error code ${err.rawCode}`
      : `a JSON-RPC error with ${errorCodeText(err.rawCode)}`;
  if (opts.codeRequired) {
    return { passed: false, details: `HTTP 400 but ${codeText} (expected -32020 HeaderMismatch)` };
  }
  ctx.harness.warnings.push(
    `${testId}: server rejected the request with HTTP 400 but ${codeText} instead of -32020 HeaderMismatch (SHOULD).`,
  );
  return { passed: true, details: `HTTP 400 with ${codeText} (expected -32020; reported as a warning)` };
}

export async function runTransport(ctx: ModernSuiteContext): Promise<void> {
  const { harness, client } = ctx;

  await harness.check("transport-post", async () => {
    const res = await client.rpc(DISCOVER, {});
    if (is2xx(res.statusCode)) return { passed: true, details: `HTTP ${res.statusCode}` };
    // "pass --auth" only when the status asks for a credential none was
    // sent for; "credential rejected" only when it refused the one sent;
    // any other 403 may be Host/Origin validation (readAuthRefusal).
    const refusal = readAuthRefusal(res, ctx.hasAuth);
    if (refusal) {
      return {
        passed: false,
        details: `HTTP ${res.statusCode} (${authRefusalHint(refusal, "auth required -- pass --auth")})`,
      };
    }
    return { passed: false, details: `HTTP ${res.statusCode}, ${summarize(res, true)}` };
  });

  await harness.check("transport-content-type", async () => {
    const res = await client.rpc(DISCOVER, {});
    const ct = contentTypeOf(res.headers);
    const valid = ct.includes("application/json") || ct.includes("text/event-stream");
    return { passed: valid, details: `HTTP ${res.statusCode}, Content-Type: ${ct || "missing"}` };
  });

  await harness.check("transport-content-type-reject", async () => {
    if (ctx.kind !== "http") return notApplicable("request Content-Type");
    // A fully conformant discover (headers + _meta) so the only defect is
    // the Content-Type; a 400 for a missing _meta could otherwise pass this.
    // A rejection is the server's only when nothing in front of it answered
    // in its place and the conformant setup discover was served
    // (rawProbeGate): a 429 is resent once, and an auth gate, a 429 again, a
    // 403 the conformant discover drew too, or any rejection of a server
    // that rejected the conformant discover as well is not evaluable; a 5xx
    // fails as the server failing on the POST. A 415 (or any other 4xx the
    // server chose) is credited.
    const params = client.paramsFor({});
    const body = JSON.stringify({ jsonrpc: "2.0", id: 99905, method: DISCOVER, params });
    const send = () => client.raw(body, { method: DISCOVER, params, headers: { "Content-Type": "text/plain" } });
    const sent = await sendRawProbe(ctx, "the text/plain POST", send);
    if ("outcome" in sent) return sent.outcome;
    const { res, throttledMs } = sent;
    const gated = await rawProbeGate(ctx, res, throttledMs, "the text/plain POST", TEXT_PLAIN_GATE);
    if (gated) return gated;
    if (is4xx(res.statusCode)) return { passed: true, details: `HTTP ${res.statusCode} (text/plain rejected)` };
    if (is2xx(res.statusCode)) {
      return { passed: false, details: `HTTP ${res.statusCode}: server accepted Content-Type text/plain` };
    }
    return { passed: false, details: `HTTP ${res.statusCode} (expected 4xx for text/plain)` };
  });

  await harness.check("transport-batch-reject", async () => {
    if (ctx.kind !== "http") return notApplicable("JSON-RPC batch over HTTP");
    const params = client.paramsFor({});
    const body = JSON.stringify([
      { jsonrpc: "2.0", id: 99903, method: DISCOVER, params },
      { jsonrpc: "2.0", id: 99904, method: DISCOVER, params },
    ]);
    // A rejection -- a status >= 400, or a JSON-RPC error on a 2xx -- is the
    // server's only when nothing in front of it answered in its place and
    // the conformant setup discover was served (rawProbeGate): a 429 is
    // resent once, and an auth gate, a 429 again, a 403 the conformant
    // discover drew too, or any rejection of a server that rejected the
    // conformant discover as well is not evaluable; a 5xx without the
    // server's own -32600 fails as the server failing on the batch. A -32600
    // on a 5xx is credited, with a warning about the status.
    const send = () => client.raw(body, { method: DISCOVER, params });
    const sent = await sendRawProbe(ctx, "the batch", send);
    if ("outcome" in sent) return sent.outcome;
    const { res, throttledMs } = sent;
    const gated = await rawProbeGate(ctx, res, throttledMs, "the batch", BATCH_GATE);
    if (gated) return gated;
    if (is4xx(res.statusCode)) return { passed: true, details: `HTTP ${res.statusCode} (batch rejected)` };
    let parsed: unknown;
    if (contentTypeOf(res.headers).includes("text/event-stream")) {
      // The stream MAY carry notifications before the response
      // (streamable-http "Receiving Messages") and a comment-only or empty
      // stream carries nothing, so only JSON-RPC responses count as
      // replies. A frame holding an array is the batch answered as a batch
      // -- JSON-RPC 2.0 answers a rejected batch with a single Response
      // object -- so it fails as processed, counting its elements, exactly
      // as the same array does over application/json below, even when its
      // one element is an error. A 2xx stream with no response is neither
      // the 4xx nor the JSON-RPC error the rule expects, not "0 replies".
      const messages = parseSSEMessages(res.body);
      const replies = messages.filter(isJsonRpcResponse);
      const arrays = messages.filter((m): m is unknown[] => Array.isArray(m));
      if (arrays.length > 0) {
        const count = arrays.reduce((n, a) => n + a.length, 0) + replies.length;
        return { passed: false, details: `HTTP ${res.statusCode}: server processed the batch (${count} replies)` };
      }
      if (replies.length === 0) {
        const carried =
          messages.length === 0 ? "no JSON-RPC message" : `${messages.length} message(s) but no JSON-RPC response`;
        return {
          passed: false,
          details: `HTTP ${res.statusCode} text/event-stream with ${carried}; expected 4xx or a JSON-RPC error`,
        };
      }
      parsed = replies.length === 1 ? replies[0] : replies;
    } else {
      try {
        parsed = JSON.parse(res.body);
      } catch {
        parsed = undefined;
      }
    }
    if (Array.isArray(parsed)) {
      return {
        passed: false,
        details: `HTTP ${res.statusCode}: server processed the batch (${parsed.length} replies)`,
      };
    }
    const err = errorOf(parsed);
    if (err) return { passed: true, details: `HTTP ${res.statusCode}, ${errorWithCode(err.rawCode)} (batch rejected)` };
    return { passed: false, details: `HTTP ${res.statusCode} without a JSON-RPC error (expected 4xx or error)` };
  });

  await harness.check("transport-notification-202", async () => {
    if (ctx.kind !== "http") return notApplicable("HTTP status of a notification POST");
    const res = await client.notify("notifications/cancelled", { requestId: 999999, reason: "compliance test" });
    if (res.statusCode === 202) return { passed: true, details: "HTTP 202 Accepted" };
    if (is4xx(res.statusCode)) {
      ctx.harness.warnings.push(
        `transport-notification-202: server refused a client notification with HTTP ${res.statusCode}; permitted (this revision defines no client notifications over HTTP) but 202 is expected when accepted.`,
      );
      return {
        passed: true,
        details: `HTTP ${res.statusCode} (notification refused; permitted, reported as a warning)`,
      };
    }
    if (is2xx(res.statusCode)) {
      return { passed: false, details: `HTTP ${res.statusCode} (an accepted notification MUST return exactly 202)` };
    }
    return { passed: false, details: `HTTP ${res.statusCode} (expected 202 Accepted)` };
  });

  await harness.check("transport-concurrent", async () => {
    const results = await Promise.all([0, 1, 2].map(() => client.rpc(DISCOVER, {})));
    const issues: string[] = [];
    for (const r of results) {
      if (!is2xx(r.statusCode)) issues.push(`id=${r.requestId}: HTTP ${r.statusCode}`);
      else if (!resultOf(r.body)) issues.push(`id=${r.requestId}: ${summarize(r)}`);
      else if (r.body?.id !== r.requestId)
        issues.push(`id=${r.requestId}: response id=${String(r.body?.id)} (mismatch)`);
    }
    if (issues.length > 0) return { passed: false, details: issues.join("; ") };
    return { passed: true, details: `${results.length} concurrent requests answered with matching ids` };
  });

  await harness.check("transport-get-removed", async () => {
    if (ctx.kind !== "http") return notApplicable("HTTP GET");
    const http = ctx.transport as HttpTransport;
    let res: Awaited<ReturnType<HttpTransport["rawRequest"]>>;
    try {
      res = await http.rawRequest(
        "GET",
        undefined,
        { Accept: "text/event-stream", [HEADER_PROTOCOL_VERSION]: client.protocolVersion },
        ctx.timeout,
        undefined,
        ctx.signal,
      );
    } catch (err: unknown) {
      // A cancelled run is not a held-open stream; let the harness record it.
      if (ctx.signal?.aborted) throw err;
      // A legacy GET stream held open never completes; the timeout is the signal.
      const message = err instanceof Error ? err.message : String(err);
      return {
        passed: false,
        details: `GET did not complete within ${ctx.timeout}ms (${message}); a held-open SSE stream fails`,
      };
    }
    const ct = contentTypeOf(res.headers);
    if (ct.includes("text/event-stream")) {
      return {
        passed: false,
        details: `HTTP ${res.statusCode} text/event-stream: legacy GET stream still served (removed)`,
      };
    }
    if (res.statusCode === 405) return { passed: true, details: "HTTP 405 Method Not Allowed" };
    if (is4xx(res.statusCode)) {
      ctx.harness.warnings.push(
        `transport-get-removed: GET answered HTTP ${res.statusCode}; 405 Method Not Allowed is the recommended response.`,
      );
      return { passed: true, details: `HTTP ${res.statusCode} (GET refused; 405 expected, reported as a warning)` };
    }
    return { passed: false, details: `HTTP ${res.statusCode}${ct ? `, Content-Type: ${ct}` : ""} (expected 405)` };
  });

  await harness.check("transport-delete-removed", async () => {
    if (ctx.kind !== "http") return notApplicable("HTTP DELETE");
    const http = ctx.transport as HttpTransport;
    const res = await http.rawRequest(
      "DELETE",
      undefined,
      { [HEADER_PROTOCOL_VERSION]: client.protocolVersion },
      ctx.timeout,
      undefined,
      ctx.signal,
    );
    if (res.statusCode === 405) return { passed: true, details: "HTTP 405 Method Not Allowed" };
    if (is4xx(res.statusCode)) {
      ctx.harness.warnings.push(
        `transport-delete-removed: DELETE answered HTTP ${res.statusCode}; 405 Method Not Allowed is the recommended response.`,
      );
      return { passed: true, details: `HTTP ${res.statusCode} (DELETE refused; 405 expected, reported as a warning)` };
    }
    if (is2xx(res.statusCode)) {
      return {
        passed: false,
        details: `HTTP ${res.statusCode}: DELETE accepted (sessions were removed; expected 405)`,
      };
    }
    return { passed: false, details: `HTTP ${res.statusCode} (expected 405)` };
  });

  await harness.check("transport-session-ignored", async () => {
    if (ctx.kind !== "http") return notApplicable("Mcp-Session-Id header");
    const res = await client.rpc(DISCOVER, {}, { headers: { "Mcp-Session-Id": "bogus-session-id" } });
    const minted = headerOf(res.headers, "Mcp-Session-Id");
    if (res.statusCode === 404 || res.statusCode === 400) {
      return {
        passed: false,
        details: `HTTP ${res.statusCode}, ${summarize(res)}: request rejected on the bogus session id`,
      };
    }
    if (!is2xx(res.statusCode) || !resultOf(res.body)) {
      return { passed: false, details: `HTTP ${res.statusCode}, ${summarize(res)} (expected a result)` };
    }
    if (minted !== undefined) {
      return {
        passed: false,
        details: `result served but the response carries Mcp-Session-Id: ${minted} (sessions were removed)`,
      };
    }
    return { passed: true, details: `HTTP ${res.statusCode} result, no Mcp-Session-Id on the response` };
  });

  await harness.check("transport-header-version-required", async () => {
    if (ctx.kind !== "http") return notApplicable("MCP-Protocol-Version header");
    const res = await client.rpc(DISCOVER, {}, { headers: { [HEADER_PROTOCOL_VERSION]: null } });
    return evaluateHeaderRejection(ctx, "transport-header-version-required", res, { codeRequired: false });
  });

  await harness.check("transport-header-version-mismatch", async () => {
    if (ctx.kind !== "http") return notApplicable("MCP-Protocol-Version header");
    // Header stays at the suite's version; only the _meta copy moves.
    const res = await client.rpc(DISCOVER, {}, { meta: { [META.protocolVersion]: "1999-01-01" } });
    return evaluateHeaderRejection(ctx, "transport-header-version-mismatch", res, { codeRequired: true });
  });

  await harness.check("transport-header-method-required", async () => {
    if (ctx.kind !== "http") return notApplicable("Mcp-Method header");
    const res = await client.rpc(DISCOVER, {}, { headers: { [HEADER_METHOD]: null } });
    return evaluateHeaderRejection(ctx, "transport-header-method-required", res, { codeRequired: false });
  });

  await harness.check("transport-header-method-mismatch", async () => {
    if (ctx.kind !== "http") return notApplicable("Mcp-Method header");
    const res = await client.rpc(DISCOVER, {}, { headers: { [HEADER_METHOD]: "tools/list" } });
    return evaluateHeaderRejection(ctx, "transport-header-method-mismatch", res, { codeRequired: false });
  });

  await harness.check("transport-header-name-mismatch", async () => {
    if (ctx.kind !== "http") return notApplicable("Mcp-Name header");
    const probe = await nameHeaderProbe(ctx);
    if ("outcome" in probe) return probe.outcome;
    const res = await client.rpc(probe.method, probe.params, { headers: { [HEADER_NAME]: "wrong-name" } });
    const outcome = evaluateHeaderRejection(ctx, "transport-header-name-mismatch", res, { codeRequired: false });
    return { passed: outcome.passed, details: `${probe.method} with Mcp-Name: wrong-name -> ${outcome.details}` };
  });

  await harness.check("transport-header-case-insensitive", async () => {
    if (ctx.kind !== "http") return notApplicable("HTTP header names");
    const res = await client.rpc(
      DISCOVER,
      {},
      {
        headers: {
          [HEADER_PROTOCOL_VERSION]: null,
          "mcp-protocol-version": client.protocolVersion,
          [HEADER_METHOD]: null,
          "mcp-method": DISCOVER,
        },
      },
    );
    if (is2xx(res.statusCode) && resultOf(res.body)) {
      return {
        passed: true,
        details: `HTTP ${res.statusCode} result with lowercase mcp-protocol-version / mcp-method`,
      };
    }
    const err = errorOf(res.body);
    if (err && err.code === HEADER_MISMATCH) {
      return {
        passed: false,
        details: `HTTP ${res.statusCode}, -32020 HeaderMismatch: header names matched case-sensitively`,
      };
    }
    return { passed: false, details: `HTTP ${res.statusCode}, ${summarize(res, true)} (expected a result)` };
  });
}

type NameHeaderProbe = { method: string; params: Record<string, unknown> } | { outcome: TestOutcome };

/**
 * A read-only request that carries `Mcp-Name`: the first listed resource
 * (resources/read on its uri), else the first prompt with no required
 * arguments (prompts/get). The lists are fetched once on demand through
 * the context (so `--only transport` still measures the server). When no
 * probe exists the outcome names why: the capability is undeclared or
 * nothing listed is readable with a name alone (skip-pass), or a declared
 * list call failed (even if the other list worked but held nothing
 * readable) -- a skip-pass pointing at the failed `-list` tests when they
 * are in this run, else a failure carrying the recorded reason
 * (`listUnavailable`), so a broken list is never a silent pass.
 */
async function nameHeaderProbe(ctx: ModernSuiteContext): Promise<NameHeaderProbe> {
  const resources = await ensureResources(ctx);
  const resource = resources?.find((r) => r && typeof r === "object" && typeof r.uri === "string");
  if (resource) return { method: "resources/read", params: { uri: resource.uri } };
  const prompts = await ensurePrompts(ctx);
  const prompt = prompts?.find((p) => {
    if (!p || typeof p !== "object" || typeof p.name !== "string") return false;
    const args = Array.isArray(p.arguments) ? p.arguments : [];
    return !args.some((a: unknown) => !!a && typeof a === "object" && (a as { required?: unknown }).required === true);
  });
  if (prompt) return { method: "prompts/get", params: { name: prompt.name } };
  const skip = (details: string): NameHeaderProbe => ({ outcome: { passed: true, details } });
  const declared: ListKey[] = [];
  if (hasResources(ctx)) declared.push("resources");
  if (hasPrompts(ctx)) declared.push("prompts");
  if (declared.length === 0) return skip("skipped: server declares no resources or prompts");
  // Any declared list that failed is named, even when the other one worked
  // but listed nothing readable: the failed list may have held the probe.
  const failed = declared.filter((key) => (key === "resources" ? !resources : !prompts));
  if (failed.length > 0) {
    const what = "no resource or prompt to read by name";
    // Filtered-out `-list` tests report nothing: fail with their reasons.
    const unreported = failed.filter((key) => !listUnavailable(ctx, key, what).passed);
    if (unreported.length > 0) {
      const reasons = unreported.map(
        (key) => `${LIST_METHOD[key]} failed (${ctx.state.listFailures[key] ?? "no list obtained"})`,
      );
      return { outcome: { passed: false, details: `${reasons.join(" and ")}; ${what}` } };
    }
    return skip(
      `skipped: ${failed.map((k) => `${k}/list`).join(" and ")} failed, ${what} (see ${failed.map((k) => `${k}-list`).join(", ")})`,
    );
  }
  return skip("skipped: no listed resource has a uri and no listed prompt is callable without arguments");
}
