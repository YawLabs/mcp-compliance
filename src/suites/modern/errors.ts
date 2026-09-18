import { randomBytes } from "node:crypto";
import { errorCodeText, errorWithCode } from "../../checks/validators.js";
import { errorOf, type JsonRpcErrorInfo, type RpcResponse, resultOf } from "../../modern/client.js";
import { JSONRPC_ERROR_CODES } from "../../modern/meta.js";
import type { JsonRpcId } from "../../transport/index.js";
import { hasPrompts, hasResources, hasTools, type ModernSuiteContext } from "./context.js";
import { discoverTwin, type GateAnswer, type GateSpec, gateVerdict, httpStatusText, resendOn429 } from "./gate.js";
import { notEvaluable } from "./lifecycle.js";

/**
 * Error-handling tests of the 2026-07-28 suite (catalog category
 * "errors", the ten request-driven ids). The two post-hoc ids of the
 * category (error-id-echo, error-retired-codes) scan the recorder and
 * live in posthoc.ts.
 *
 * Every probe goes through the modern client, so it carries the full
 * `_meta` envelope and the standard headers; the four raw-body probes
 * are HTTP-only (catalog `transports`) and use `client.raw` with the
 * headers a `server/discover` would carry, so the only defect in the
 * request is the body itself.
 *
 * A rejection is credited to the probe's defect only when the conformant
 * setup `server/discover` was served (`notEvaluable`, as for the `_meta`
 * tests in lifecycle.ts and the header tests in transport.ts): a server
 * that rejects everything -- a 2025-era SDK answering 400 / -32000
 * "Server not initialized" to every POST -- proves nothing by rejecting an
 * unknown method or a malformed body too, so those ids fail as not
 * evaluable (see `rejectionVerdict`). A served probe is judged on its
 * own whatever the discover state. The tools-gated ids cannot run
 * without a served discover, so they never see that case;
 * error-capability-gated sees it as "nothing declared" and fails as not
 * evaluable rather than call a served list method undeclared.
 *
 * Next to a served discover, the six checks that credit ANY JSON-RPC
 * error or rejection (error-unknown-method, error-invalid-jsonrpc,
 * error-invalid-json, error-missing-params, error-capability-gated,
 * error-invalid-cursor) also ask whose answer it is (gate.ts's
 * gateVerdict): a gateway's 401 with a -32001 "Unauthorized" body that
 * echoes the id, a 403 carrying a Bearer challenge, a 403 the conformant
 * twin cannot credit, a 429 that is still a 429 after one resend, or a 5xx
 * without the check's own code (-32601, -32600, -32700, -32602, -32601,
 * -32602) is not the server's, and fails as not evaluable. A 5xx carrying
 * that code is credited, with a warning about the status. The exact-code
 * ids (error-method-code, error-parse-code, error-invalid-request-code)
 * credit only the one right code, which no gate produces, so they read the
 * discover state alone. tools-call-unknown is not read this way yet: a
 * gateway's -32001 on its tools/call still passes it.
 */

/** The five probes' own rejection codes and what each varies (see gateVerdict); error-invalid-cursor's is below. */
const UNKNOWN_METHOD_GATE = {
  check: "error-unknown-method",
  what: "an unknown method",
  about: "the unknown method",
  ownCodes: [JSONRPC_ERROR_CODES.METHOD_NOT_FOUND],
  // basic/transports/streamable-http: an unknown method is 404 with the error body.
  expected: "HTTP 404 is required for an unknown method",
};
const ENVELOPE_GATE = {
  check: "error-invalid-jsonrpc",
  what: "a malformed envelope",
  about: "the malformed envelope",
  ownCodes: [JSONRPC_ERROR_CODES.INVALID_REQUEST],
};
const PARSE_GATE = {
  check: "error-invalid-json",
  what: "invalid JSON",
  about: "the invalid JSON",
  ownCodes: [JSONRPC_ERROR_CODES.PARSE_ERROR],
};
const MISSING_NAME_GATE = {
  check: "error-missing-params",
  what: "a tools/call without a name",
  about: "the missing tool name",
  ownCodes: [JSONRPC_ERROR_CODES.INVALID_PARAMS],
};
/** What error-capability-gated's not-evaluable reasons say it could not measure. */
const GATED_ABOUT = "whether undeclared methods are rejected";
/** error-invalid-cursor's own rejection (pagination: an invalid cursor SHOULD draw -32602); `what` names the list method. */
const INVALID_CURSOR_GATE = {
  check: "error-invalid-cursor",
  about: "the invalid cursor",
  ownCodes: [JSONRPC_ERROR_CODES.INVALID_PARAMS],
};

const UNKNOWN_TOOL = "__nonexistent_tool_compliance_test__";

const LIST_METHODS: Array<{
  method: string;
  capability: string;
  key: string;
  declared: (c: ModernSuiteContext) => boolean;
}> = [
  { method: "tools/list", capability: "tools", key: "tools", declared: hasTools },
  { method: "resources/list", capability: "resources", key: "resources", declared: hasResources },
  { method: "prompts/list", capability: "prompts", key: "prompts", declared: hasPrompts },
];

/**
 * Capability gates read `ctx.state.capabilities`, which the lifecycle
 * module seeds from its setup `server/discover` before any `--only`
 * filter applies; nothing here re-fetches it.
 */
export async function runErrors(ctx: ModernSuiteContext): Promise<void> {
  const { harness } = ctx;
  const http = ctx.kind === "http";

  await harness.check("error-unknown-method", async () => {
    const method = unknownMethodName();
    const probe = await rpcOrFailure(ctx, method, undefined, true);
    if ("failure" in probe) return { passed: false, details: probe.failure };
    const res = probe.res;
    const unattributable = await rejectionVerdict(ctx, probe, "an unknown method", {
      ...UNKNOWN_METHOD_GATE,
      twin: discoverTwin(ctx),
    });
    if (unattributable) return unattributable;
    const err = errorOf(res.body);
    if (!err) {
      if (resultOf(res.body)) {
        return {
          passed: false,
          details: `Unknown method returned a result${status(ctx, res)}; expected a JSON-RPC error`,
        };
      }
      return { passed: false, details: `No JSON-RPC error body for unknown method${status(ctx, res)}` };
    }
    const echoed = (res.body as { id?: unknown }).id;
    if (!sameId(echoed, res.requestId)) {
      return {
        passed: false,
        details: `${errorWithCode(err.rawCode)} did not echo the request id (sent ${show(res.requestId)}, got ${show(echoed)})`,
      };
    }
    if (http && res.statusCode !== 404) {
      // A 5xx that got this far carried -32601 and drew gateVerdict's
      // rejection-on-5xx warning, which names the 404 already.
      if (res.statusCode < 500) {
        harness.warnings.push(
          `Unknown method answered HTTP ${res.statusCode} with ${errorWithCode(err.rawCode)}; the spec requires 404 Not Found alongside the error body.`,
        );
      }
      return {
        passed: true,
        details: `${errorWithCode(err.rawCode)} on HTTP ${res.statusCode} (spec requires 404), id echoed`,
      };
    }
    return { passed: true, details: `${errorWithCode(err.rawCode)}${http ? " on HTTP 404" : ""}, id echoed` };
  });

  await harness.check("error-method-code", async () => {
    const probe = await rpcOrFailure(ctx, unknownMethodName());
    if ("failure" in probe) return { passed: false, details: probe.failure };
    const blanket = await rejectionVerdict(ctx, probe, "an unknown method");
    if (blanket) return blanket;
    const err = errorOf(probe.res.body);
    if (!err) {
      return { passed: false, details: `No JSON-RPC error returned for unknown method${status(ctx, probe.res)}` };
    }
    if (err.code !== JSONRPC_ERROR_CODES.METHOD_NOT_FOUND) {
      return {
        passed: false,
        details: `Expected -32601 (Method not found), got ${errorCodeText(err.rawCode)}${message(err.message)}`,
      };
    }
    return { passed: true, details: "-32601 (Method not found)" };
  });

  await harness.check("error-invalid-jsonrpc", async () => {
    if (!http) return { passed: true, details: "Skipped: raw-body probe is HTTP-only" };
    const probe = await rawOrFailure(ctx, JSON.stringify({ not: "a valid jsonrpc message" }), true);
    if ("failure" in probe) return { passed: false, details: probe.failure };
    const unattributable = await rejectionVerdict(ctx, probe, "a malformed envelope", {
      ...ENVELOPE_GATE,
      twin: discoverTwin(ctx),
    });
    if (unattributable) return unattributable;
    const { statusCode, error, result } = probe;
    // Past the gate reading a rejected 5xx carries the server's own -32600
    // and is credited (with a warning); one that came with a result is not.
    if (statusCode >= 500 && !credited5xx(probe, ENVELOPE_GATE.ownCodes))
      return {
        passed: false,
        details: `HTTP ${statusCode} for a malformed envelope; expected a JSON-RPC error or 4xx`,
      };
    if (error) {
      const correct = error.code === JSONRPC_ERROR_CODES.INVALID_REQUEST ? " (correct: Invalid Request)" : "";
      return { passed: true, details: `${errorWithCode(error.rawCode)}${correct} on HTTP ${statusCode}` };
    }
    if (result) return { passed: false, details: `Malformed envelope produced a result on HTTP ${statusCode}` };
    if (statusCode >= 400) return { passed: true, details: `HTTP ${statusCode} without a JSON-RPC body (acceptable)` };
    return { passed: false, details: `HTTP ${statusCode} with no JSON-RPC error; expected a JSON-RPC error or 4xx` };
  });

  await harness.check("error-invalid-json", async () => {
    if (!http) return { passed: true, details: "Skipped: raw-body probe is HTTP-only" };
    const probe = await rawOrFailure(ctx, "{not json", true);
    if ("failure" in probe) return { passed: false, details: probe.failure };
    const unattributable = await rejectionVerdict(ctx, probe, "invalid JSON", {
      ...PARSE_GATE,
      twin: discoverTwin(ctx),
    });
    if (unattributable) return unattributable;
    const { statusCode, error, result } = probe;
    if (statusCode >= 500 && !credited5xx(probe, PARSE_GATE.ownCodes))
      return { passed: false, details: `HTTP ${statusCode} for invalid JSON; expected -32700 or a 4xx` };
    if (error) {
      const correct = error.code === JSONRPC_ERROR_CODES.PARSE_ERROR ? " (correct: Parse error)" : "";
      return { passed: true, details: `${errorWithCode(error.rawCode)}${correct} on HTTP ${statusCode}` };
    }
    if (result) return { passed: false, details: `Invalid JSON produced a result on HTTP ${statusCode}` };
    if (statusCode >= 400) return { passed: true, details: `HTTP ${statusCode} without a JSON-RPC body (acceptable)` };
    return { passed: false, details: `HTTP ${statusCode} with no JSON-RPC error; expected -32700 or a 4xx` };
  });

  await harness.check("error-parse-code", async () => {
    if (!http) return { passed: true, details: "Skipped: raw-body probe is HTTP-only" };
    const probe = await rawOrFailure(ctx, "{not json");
    if ("failure" in probe) return { passed: false, details: probe.failure };
    return exactCode(ctx, probe, JSONRPC_ERROR_CODES.PARSE_ERROR, "Parse error", "invalid JSON");
  });

  await harness.check("error-invalid-request-code", async () => {
    if (!http) return { passed: true, details: "Skipped: raw-body probe is HTTP-only" };
    const probe = await rawOrFailure(ctx, JSON.stringify({ jsonrpc: "2.0", id: 99999 }));
    if ("failure" in probe) return { passed: false, details: probe.failure };
    return exactCode(ctx, probe, JSONRPC_ERROR_CODES.INVALID_REQUEST, "Invalid Request", "a message with no method");
  });

  if (hasTools(ctx)) {
    await harness.check("error-missing-params", async () => {
      const probe = await rpcOrFailure(ctx, "tools/call", {}, true);
      if ("failure" in probe) return { passed: false, details: probe.failure };
      const unattributable = await rejectionVerdict(ctx, probe, "a tools/call without a name", {
        ...MISSING_NAME_GATE,
        twin: discoverTwin(ctx),
      });
      if (unattributable) return unattributable;
      const err = errorOf(probe.res.body);
      if (err) {
        const correct = err.code === JSONRPC_ERROR_CODES.INVALID_PARAMS ? " (correct: Invalid params)" : "";
        return { passed: true, details: `${errorWithCode(err.rawCode)}${correct}${message(err.message)}` };
      }
      const result = resultOf(probe.res.body);
      if (result) {
        const flagged = result.isError === true ? " with isError: true" : "";
        return {
          passed: false,
          details: `tools/call without name produced a result${flagged}${status(ctx, probe.res)}; a schema-invalid request must be a JSON-RPC error`,
        };
      }
      return { passed: false, details: `No JSON-RPC error for tools/call without name${status(ctx, probe.res)}` };
    });

    await harness.check("tools-call-unknown", async () => {
      const probe = await rpcOrFailure(ctx, "tools/call", { name: UNKNOWN_TOOL, arguments: {} });
      if ("failure" in probe) return { passed: false, details: probe.failure };
      const err = errorOf(probe.res.body);
      if (err) {
        const correct = err.code === JSONRPC_ERROR_CODES.INVALID_PARAMS ? " (correct: Invalid params)" : "";
        return { passed: true, details: `${errorWithCode(err.rawCode)}${correct}${message(err.message)}` };
      }
      const result = resultOf(probe.res.body);
      if (result?.isError === true) return { passed: true, details: "Tool execution error with isError: true (valid)" };
      if (result)
        return { passed: false, details: `Unknown tool produced a successful result${status(ctx, probe.res)}` };
      return { passed: false, details: `No JSON-RPC error for unknown tool${status(ctx, probe.res)}` };
    });
  }

  await harness.check("error-capability-gated", async () => {
    const undeclared = LIST_METHODS.filter((m) => !m.declared(ctx));
    if (undeclared.length === 0) {
      // Nothing undeclared, so nothing to probe: a skip, not a verdict.
      return {
        passed: true,
        details: "Server declares all capabilities (tools, resources, prompts); no undeclared methods to test",
        skipped: true,
      };
    }
    // Without a served discover nothing counts as declared, so every list
    // method is probed -- but no answer can be judged against a
    // declaration the suite never saw: a server that rejects everything
    // rejects these too, and one that serves them may well declare them.
    // The answers are still recorded; only the verdict is withheld.
    const unattributable = notEvaluable(ctx, GATED_ABOUT);
    const issues: string[] = [];
    const seen: string[] = [];
    // Next to a served discover, a rejection counts only when it is the
    // server's own (gateVerdict): not an auth gate, a 429 still a 429 after
    // one resend, a 5xx without -32601, or a 403 the conformant twin -- asked
    // once for all the methods -- could not get past either. Each such
    // answer is kept with its reason; a -32601 on a 5xx is credited, with a
    // warning about the status.
    const twin = discoverTwin(ctx);
    const gated: Array<{ answer: string; reason: string }> = [];
    for (const { method, capability } of undeclared) {
      const probe = await rpcOrFailure(ctx, method, undefined, true);
      if ("failure" in probe) {
        issues.push(`${method}: ${probe.failure}`);
        continue;
      }
      const err = errorOf(probe.res.body);
      const result = resultOf(probe.res.body);
      if (unattributable) {
        const answer = err
          ? errorCodeText(err.rawCode)
          : result
            ? "result"
            : `no JSON-RPC body${status(ctx, probe.res)}`;
        seen.push(`${method} -> ${answer}`);
        continue;
      }
      if (!err && result) {
        issues.push(`${method} returned a result despite the undeclared ${capability} capability`);
        continue;
      }
      if (err || (http && probe.res.statusCode >= 400)) {
        const reason = await gateVerdict(ctx, probe.res, {
          check: "error-capability-gated",
          what: `${method} (undeclared ${capability} capability)`,
          about: GATED_ABOUT,
          ownCodes: [JSONRPC_ERROR_CODES.METHOD_NOT_FOUND],
          twin,
        });
        if (reason) {
          const code = err ? errorCodeText(err.rawCode) : "no JSON-RPC body";
          gated.push({
            answer: `${method} -> ${code} (${httpStatusText(probe.res.statusCode, probe.throttledMs)})`,
            reason,
          });
          continue;
        }
      }
      if (err) {
        const note = err.code === JSONRPC_ERROR_CODES.METHOD_NOT_FOUND ? "" : " (expected -32601)";
        seen.push(`${method} -> ${errorCodeText(err.rawCode)}${note}`);
      } else {
        seen.push(`${method} -> rejected${status(ctx, probe.res)}`);
      }
    }
    if (issues.length > 0) return { passed: false, details: clip(issues.join("; ")) };
    if (unattributable) return { passed: false, details: `${seen.join(", ")}; ${unattributable}` };
    if (gated.length > 0) {
      // One reason per group of methods that drew it (a gate answers them alike).
      const byReason = new Map<string, string[]>();
      for (const { answer, reason } of gated) byReason.set(reason, [...(byReason.get(reason) ?? []), answer]);
      const groups = [...byReason].map(([reason, answers]) => `${answers.join(", ")}; ${reason}`);
      return { passed: false, details: groups.join("; ") };
    }
    return { passed: true, details: clip(`Undeclared method(s) rejected: ${seen.join(", ")}`) };
  });

  await harness.check("error-invalid-cursor", async () => {
    const target = LIST_METHODS.find((m) => m.declared(ctx));
    if (!target) return { passed: true, details: "No list methods available to test (skipped)" };
    const cursor = `compliance-invalid-cursor-${randomBytes(4).toString("hex")}`;
    const probe = await rpcOrFailure(ctx, target.method, { cursor }, true);
    if ("failure" in probe) return { passed: false, details: probe.failure };
    // A rejection is credited only when it is the server's own (gateVerdict,
    // as for the five checks above): an auth gate, a 429 still a 429 after
    // one resend, a 5xx without -32602, or a 403 the conformant twin could
    // not get past either is not evaluable. A -32602 on a 5xx is credited,
    // with a warning about the status.
    const unattributable = await rejectionVerdict(ctx, probe, `${target.method} with an invalid cursor`, {
      ...INVALID_CURSOR_GATE,
      what: `${target.method} with an invalid cursor`,
      twin: discoverTwin(ctx),
    });
    if (unattributable) return unattributable;
    const res = probe.res;
    // Past the gate reading a 5xx either carried -32602 (credited) or came
    // with a result, which fails for the status.
    if (http && res.statusCode >= 500 && resultOf(res.body)) {
      return { passed: false, details: `${target.method} with an invalid cursor answered HTTP ${res.statusCode}` };
    }
    const err = errorOf(res.body);
    if (err) {
      const correct = err.code === JSONRPC_ERROR_CODES.INVALID_PARAMS ? " (correct: Invalid params)" : "";
      return {
        passed: true,
        details: `${target.method} rejected the cursor: ${errorCodeText(err.rawCode)}${correct}${message(err.message)}`,
      };
    }
    const result = resultOf(res.body);
    if (result) {
      const items = result[target.key];
      if (!Array.isArray(items)) {
        return {
          passed: false,
          details: `${target.method} ignored the cursor but the result has no ${target.key} array`,
        };
      }
      return {
        passed: true,
        details: `${target.method} ignored the invalid cursor and returned a first page (${items.length} item(s))`,
      };
    }
    return { passed: false, details: `No JSON-RPC error or result for an invalid cursor${status(ctx, res)}` };
  });
}

// ── helpers ───────────────────────────────────────────────────────────

function unknownMethodName(): string {
  return `compliance/nonexistent-method-${randomBytes(3).toString("hex")}`;
}

/** A probe's answer, and the wait before its one resend when a rate limiter answered 429 (see resendOn429). */
type Probe<T> = { res: T; throttledMs: number | null } | { failure: string };

/**
 * Send a request; a transport failure (timeout, closed pipe) becomes a
 * failing outcome, never a throw -- except a caller's abort, which is
 * rethrown. With `resend429` a 429 is resent once after Retry-After and the
 * second answer decides (the six gate-read checks, see gateVerdict).
 */
async function rpcOrFailure(
  ctx: ModernSuiteContext,
  method: string,
  params?: unknown,
  resend429 = false,
): Promise<Probe<RpcResponse>> {
  try {
    const send = () => ctx.client.rpc(method, params);
    const first = await send();
    return resend429 ? await resendOn429(ctx, first, send) : { res: first, throttledMs: null };
  } catch (err) {
    if (ctx.signal?.aborted) throw err;
    return { failure: clip(`No response to ${method}: ${errorMessage(err)}`) };
  }
}

/** A raw-body probe's answer (always HTTP): its body parsed as JSON-RPC (see parseJsonRpcText). */
interface RawProbe extends GateAnswer {
  throttledMs: number | null;
  error?: JsonRpcErrorInfo;
  result?: Record<string, unknown>;
}

/**
 * The not-evaluable failure for a rejection of `what` -- a JSON-RPC error,
 * or on HTTP any 4xx/5xx without one -- that is not the server's answer to
 * the probe's defect, or null when it is:
 *
 * - while the conformant setup `server/discover` was itself rejected or
 *   unanswered (`notEvaluable`): the rejection is the server's answer to
 *   everything, not a verdict on `what`;
 * - with `gate` (the six checks that credit any error or rejection), when
 *   something in front of the server answered in its place (gateVerdict:
 *   an auth gate, a 429 still a 429 after one resend, a 5xx without the
 *   check's own code, a 403 the conformant twin could not get past either).
 *
 * Null for a served probe (a result, or a 2xx/3xx with no JSON-RPC error at
 * all: an HTML page), which the check judges on its own whatever the
 * discover state, as `evaluateHeaderRejection` in transport.ts does. A raw
 * probe (always HTTP) names its status "on HTTP n", an RPC probe
 * " (HTTP n)" on HTTP and nothing on stdio.
 */
async function rejectionVerdict(
  ctx: ModernSuiteContext,
  probe: { res: RpcResponse; throttledMs: number | null } | RawProbe,
  what: string,
  gate?: GateSpec,
): Promise<{ passed: boolean; details: string } | null> {
  const raw = !("res" in probe);
  const res: GateAnswer = "res" in probe ? probe.res : probe;
  const err = errorOf(res.body);
  if (resultOf(res.body)) return null;
  // stdio's status is a synthetic 200, so only HTTP reaches a bare rejection.
  if (!err && res.statusCode < 400) return null;
  const reason = notEvaluable(ctx) ?? (gate ? await gateVerdict(ctx, res, gate) : null);
  if (!reason) return null;
  const answer = err ? errorWithCode(err.rawCode) : "no JSON-RPC error body";
  const statusText = httpStatusText(res.statusCode, probe.throttledMs);
  const shown = raw ? ` on ${statusText}` : ctx.kind === "http" ? ` (${statusText})` : "";
  return { passed: false, details: `${answer}${shown} for ${what}; ${reason}` };
}

/**
 * Whether a raw probe's 5xx is one gateVerdict credited: a rejection (no
 * result) carrying one of the check's own codes. Any other 5xx that reaches
 * the check came with a result, and fails for the status as before.
 */
function credited5xx(probe: RawProbe, ownCodes: readonly number[]): boolean {
  return !probe.result && !!probe.error && ownCodes.includes(probe.error.code);
}

/**
 * POST a raw body with the headers a `server/discover` request carries
 * (MCP-Protocol-Version, Mcp-Method) so the body is the only defect. With
 * `resend429` a 429 is resent once after Retry-After. A caller's abort is
 * rethrown.
 */
async function rawOrFailure(
  ctx: ModernSuiteContext,
  body: string,
  resend429 = false,
): Promise<RawProbe | { failure: string }> {
  let res: { statusCode: number; body: string; headers: Record<string, string> };
  let throttledMs: number | null = null;
  try {
    const send = () => ctx.client.raw(body, { method: "server/discover" });
    const first = await send();
    ({ res, throttledMs } = resend429 ? await resendOn429(ctx, first, send) : { res: first, throttledMs: null });
  } catch (err) {
    if (ctx.signal?.aborted) throw err;
    return { failure: clip(`No response to the raw body probe: ${errorMessage(err)}`) };
  }
  const parsed = parseJsonRpcText(res.body, res.headers["content-type"] || "");
  return {
    statusCode: res.statusCode,
    headers: res.headers,
    body: parsed,
    throttledMs,
    error: errorOf(parsed),
    result: resultOf(parsed),
  };
}

/** The exact-code half of a raw-body probe (error-parse-code, error-invalid-request-code). */
async function exactCode(
  ctx: ModernSuiteContext,
  probe: RawProbe,
  code: number,
  name: string,
  what: string,
): Promise<{ passed: boolean; details: string }> {
  const blanket = await rejectionVerdict(ctx, probe, what);
  if (blanket) return blanket;
  const { statusCode, error, result } = probe;
  if (error) {
    if (error.code === code) return { passed: true, details: `${code} (${name}) on HTTP ${statusCode}` };
    return {
      passed: false,
      details: `Expected ${code} (${name}) for ${what}, got ${errorCodeText(error.rawCode)}${message(error.message)}`,
    };
  }
  if (result)
    return { passed: false, details: `Result instead of ${code} (${name}) for ${what} on HTTP ${statusCode}` };
  if (statusCode >= 400 && statusCode < 500) {
    ctx.harness.warnings.push(
      `HTTP ${statusCode} with no JSON-RPC body for ${what}; the spec expects a ${code} (${name}) JSON-RPC error body.`,
    );
    return {
      passed: true,
      details: `HTTP ${statusCode} without a JSON-RPC body (expected ${code} ${name}); passes with a warning`,
    };
  }
  return {
    passed: false,
    details: `HTTP ${statusCode} with no JSON-RPC error; expected ${code} (${name}) for ${what}`,
  };
}

/** First JSON-RPC message in a raw response body (plain JSON, or the `data:` lines of an SSE body). */
function parseJsonRpcText(text: string, contentType: string): unknown {
  if (!text.trim()) return undefined;
  if (contentType.toLowerCase().includes("text/event-stream")) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const parsed = jsonOrUndefined(line.slice(5).trim());
      if (parsed && typeof parsed === "object" && ("error" in parsed || "result" in parsed)) return parsed;
    }
    return undefined;
  }
  const parsed = jsonOrUndefined(text);
  return Array.isArray(parsed) ? parsed[0] : parsed;
}

function jsonOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function sameId(echoed: unknown, sent: JsonRpcId): boolean {
  return (typeof echoed === "number" || typeof echoed === "string") && echoed === sent;
}

/** " (HTTP <status>)" on HTTP, "" on stdio where the status is synthetic. */
function status(ctx: ModernSuiteContext, res: RpcResponse): string {
  return ctx.kind === "http" ? ` (HTTP ${res.statusCode})` : "";
}

function message(text: string): string {
  return text ? ` (${clip(text, 80)})` : "";
}

function show(id: unknown): string {
  return id === undefined ? "missing" : JSON.stringify(id);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message.split("\n")[0] : String(err);
}

function clip(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}
