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
import { notEvaluable, transportLevelRejection } from "./lifecycle.js";

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
    return `JSON-RPC error ${err.code}${msg}`;
  }
  return resultOf(res.body) ? "result" : "non-JSON-RPC body";
}

function clip(text: string, max: number): string {
  const ascii = text.replace(/[^\x20-\x7e]/g, "?");
  return ascii.length > max ? `${ascii.slice(0, max - 3)}...` : ascii;
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
  const codeText = err ? `error code ${err.code}` : "no JSON-RPC error body";
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
    if (res.statusCode === 401 || res.statusCode === 403) {
      return {
        passed: false,
        details: `HTTP ${res.statusCode} (${ctx.hasAuth ? "credential rejected -- check --auth" : "auth required -- pass --auth"})`,
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
    const params = client.paramsFor({});
    const body = JSON.stringify({ jsonrpc: "2.0", id: 99905, method: DISCOVER, params });
    const res = await client.raw(body, { method: DISCOVER, params, headers: { "Content-Type": "text/plain" } });
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
    const res = await client.raw(body, { method: DISCOVER, params });
    if (is4xx(res.statusCode)) return { passed: true, details: `HTTP ${res.statusCode} (batch rejected)` };
    let parsed: unknown;
    if (contentTypeOf(res.headers).includes("text/event-stream")) {
      // The stream MAY carry notifications before the response
      // (streamable-http "Receiving Messages") and a comment-only or empty
      // stream carries nothing, so only JSON-RPC responses count as
      // replies -- a batch answered as one array frame by its elements. A
      // 2xx stream with no response is neither the 4xx nor the JSON-RPC
      // error the rule expects, not "0 replies".
      const messages = parseSSEMessages(res.body).flatMap((m) => (Array.isArray(m) ? m : [m]));
      const replies = messages.filter(isJsonRpcResponse);
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
    if (err) return { passed: true, details: `HTTP ${res.statusCode}, JSON-RPC error ${err.code} (batch rejected)` };
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
 * nothing listed is readable with a name alone (skip-pass), or every
 * declared list call failed -- a skip-pass pointing at the `-list` tests
 * when they are in this run, else a failure carrying the recorded reason
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
  const failed = declared.filter((key) => (key === "resources" ? !resources : !prompts));
  if (failed.length === declared.length) {
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
