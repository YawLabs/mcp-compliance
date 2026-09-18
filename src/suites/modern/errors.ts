import { randomBytes } from "node:crypto";
import { errorCodeText, errorWithCode } from "../../checks/validators.js";
import { errorOf, type JsonRpcErrorInfo, type RpcResponse, resultOf } from "../../modern/client.js";
import { JSONRPC_ERROR_CODES } from "../../modern/meta.js";
import type { JsonRpcId } from "../../transport/index.js";
import { hasPrompts, hasResources, hasTools, type ModernSuiteContext } from "./context.js";
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
 * evaluable (see `blanketRejection`). A served probe is judged on its
 * own whatever the discover state. The tools-gated ids cannot run
 * without a served discover, so they never see that case;
 * error-capability-gated sees it as "nothing declared" and fails as not
 * evaluable rather than call a served list method undeclared.
 */

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
    const probe = await rpcOrFailure(ctx, method);
    if ("failure" in probe) return { passed: false, details: probe.failure };
    const res = probe.res;
    const blanket = blanketRejection(ctx, res, "an unknown method");
    if (blanket) return blanket;
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
      harness.warnings.push(
        `Unknown method answered HTTP ${res.statusCode} with ${errorWithCode(err.rawCode)}; the spec requires 404 Not Found alongside the error body.`,
      );
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
    const blanket = blanketRejection(ctx, probe.res, "an unknown method");
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
    const probe = await rawOrFailure(ctx, JSON.stringify({ not: "a valid jsonrpc message" }));
    if ("failure" in probe) return { passed: false, details: probe.failure };
    const blanket = blanketRawRejection(ctx, probe, "a malformed envelope");
    if (blanket) return blanket;
    const { statusCode, error, result } = probe;
    if (statusCode >= 500)
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
    const probe = await rawOrFailure(ctx, "{not json");
    if ("failure" in probe) return { passed: false, details: probe.failure };
    const blanket = blanketRawRejection(ctx, probe, "invalid JSON");
    if (blanket) return blanket;
    const { statusCode, error, result } = probe;
    if (statusCode >= 500)
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
      const probe = await rpcOrFailure(ctx, "tools/call", {});
      if ("failure" in probe) return { passed: false, details: probe.failure };
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
    const unattributable = notEvaluable(ctx, "whether undeclared methods are rejected");
    const issues: string[] = [];
    const seen: string[] = [];
    for (const { method, capability } of undeclared) {
      const probe = await rpcOrFailure(ctx, method);
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
      if (err) {
        const note = err.code === JSONRPC_ERROR_CODES.METHOD_NOT_FOUND ? "" : " (expected -32601)";
        seen.push(`${method} -> ${errorCodeText(err.rawCode)}${note}`);
      } else {
        seen.push(`${method} -> rejected${status(ctx, probe.res)}`);
      }
    }
    if (issues.length > 0) return { passed: false, details: clip(issues.join("; ")) };
    if (unattributable) return { passed: false, details: `${seen.join(", ")}; ${unattributable}` };
    return { passed: true, details: clip(`Undeclared method(s) rejected: ${seen.join(", ")}`) };
  });

  await harness.check("error-invalid-cursor", async () => {
    const target = LIST_METHODS.find((m) => m.declared(ctx));
    if (!target) return { passed: true, details: "No list methods available to test (skipped)" };
    const cursor = `compliance-invalid-cursor-${randomBytes(4).toString("hex")}`;
    const probe = await rpcOrFailure(ctx, target.method, { cursor });
    if ("failure" in probe) return { passed: false, details: probe.failure };
    const res = probe.res;
    if (http && res.statusCode >= 500) {
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

type Probe<T> = { res: T } | { failure: string };

/** Send a request; a transport failure (timeout, closed pipe) becomes a failing outcome, never a throw. */
async function rpcOrFailure(ctx: ModernSuiteContext, method: string, params?: unknown): Promise<Probe<RpcResponse>> {
  try {
    return { res: await ctx.client.rpc(method, params) };
  } catch (err) {
    return { failure: clip(`No response to ${method}: ${errorMessage(err)}`) };
  }
}

/**
 * The not-evaluable failure for a rejection of `what` -- a JSON-RPC
 * error, or on HTTP any 4xx/5xx without one -- while the conformant setup
 * `server/discover` was itself rejected or unanswered (see
 * `notEvaluable`): the rejection is the server's answer to everything,
 * not a verdict on `what`. Null when the discover was served, so every
 * verdict after it is unchanged, and for a served probe (a result, or a
 * 2xx/3xx with no JSON-RPC error at all: an HTML page), which the check
 * judges on its own whatever the discover state, as
 * `evaluateHeaderRejection` in transport.ts does.
 */
function blanketRejection(
  ctx: ModernSuiteContext,
  res: RpcResponse,
  what: string,
): { passed: boolean; details: string } | null {
  const err = errorOf(res.body);
  if (resultOf(res.body)) return null;
  // stdio's status is a synthetic 200, so only HTTP reaches a bare rejection.
  if (!err && res.statusCode < 400) return null;
  const reason = notEvaluable(ctx);
  if (!reason) return null;
  const answer = err ? errorWithCode(err.rawCode) : "no JSON-RPC error body";
  return { passed: false, details: `${answer}${status(ctx, res)} for ${what}; ${reason}` };
}

interface RawProbe {
  statusCode: number;
  error?: JsonRpcErrorInfo;
  result?: Record<string, unknown>;
}

/** `blanketRejection` for a raw-body probe (always HTTP). */
function blanketRawRejection(
  ctx: ModernSuiteContext,
  probe: RawProbe,
  what: string,
): { passed: boolean; details: string } | null {
  if (probe.result) return null;
  if (!probe.error && probe.statusCode < 400) return null;
  const reason = notEvaluable(ctx);
  if (!reason) return null;
  const answer = probe.error ? errorWithCode(probe.error.rawCode) : "no JSON-RPC error body";
  return { passed: false, details: `${answer} on HTTP ${probe.statusCode} for ${what}; ${reason}` };
}

/**
 * POST a raw body with the headers a `server/discover` request carries
 * (MCP-Protocol-Version, Mcp-Method) so the body is the only defect.
 */
async function rawOrFailure(ctx: ModernSuiteContext, body: string): Promise<RawProbe | { failure: string }> {
  let res: { statusCode: number; body: string; headers: Record<string, string> };
  try {
    res = await ctx.client.raw(body, { method: "server/discover" });
  } catch (err) {
    return { failure: clip(`No response to the raw body probe: ${errorMessage(err)}`) };
  }
  const parsed = parseJsonRpcText(res.body, res.headers["content-type"] || "");
  const error = errorOf(parsed);
  return {
    statusCode: res.statusCode,
    error,
    result: resultOf(parsed),
  };
}

/** The exact-code half of a raw-body probe (error-parse-code, error-invalid-request-code). */
function exactCode(
  ctx: ModernSuiteContext,
  probe: RawProbe,
  code: number,
  name: string,
  what: string,
): { passed: boolean; details: string } {
  const blanket = blanketRawRejection(ctx, probe, what);
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
