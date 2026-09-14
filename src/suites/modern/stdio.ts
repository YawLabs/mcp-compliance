import { errorOf, type RpcResponse, resultOf } from "../../modern/client.js";
import { JSONRPC_ERROR_CODES, META } from "../../modern/meta.js";
import type { StdioTransport } from "../../transport/stdio.js";
import { hasTools, type ModernSuiteContext } from "./context.js";

/**
 * Stdio-only tests of the 2026-07-28 suite. The catalog gates every id
 * here to `transports: ["stdio"]`, so on HTTP `harness.check` skips them
 * and none of this runs. They probe the one thing HTTP gets for free
 * from the connection model: a single long-lived process whose stdout
 * must stay a clean stream of newline-delimited JSON no matter what the
 * client writes to stdin.
 */

/** Same probe the 2025-11-25 suite uses: Latin-1 accent, CJK, an astral-plane emoji. */
const UNICODE_PROBE = "héllo 世界 🚀";
const BOGUS_METHOD = "this/method/does/not/exist-xyzzy";
/** A request id the suite never issues (the counter starts at 1000 and never reaches this). */
const UNKNOWN_CANCEL_ID = 987654321;
const RAPID_DISCOVERS = 5;

interface ExitState {
  exited: boolean;
  exitCode: number | null;
}

/** Child-process state, when the transport is the stdio one (never throws on HTTP). */
function exitState(ctx: ModernSuiteContext): ExitState {
  if (ctx.kind !== "stdio") return { exited: false, exitCode: null };
  const t = ctx.transport as Partial<StdioTransport>;
  return { exited: t.exited === true, exitCode: typeof t.exitCode === "number" ? t.exitCode : null };
}

/** "server exited (code N)" when the child is gone, else the thrown error's first line. */
function explainFailure(ctx: ModernSuiteContext, err: unknown): string {
  const exit = exitState(ctx);
  if (exit.exited) return `server exited (code ${exit.exitCode === null ? "unknown" : exit.exitCode})`;
  const message = err instanceof Error ? err.message : String(err);
  return ascii(message.split("\n")[0] ?? "").slice(0, 100);
}

/** Keep details ASCII: a server's text can carry anything. */
function ascii(text: string): string {
  return text.replace(/[^\x20-\x7e]/g, "?");
}

/** Short ASCII rendering of a value for "got X" clauses. */
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

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Whether a JSON-RPC message answers a request: it has result or error. */
function isResponse(m: unknown): m is Record<string, unknown> {
  return isObject(m) && ("result" in m || "error" in m);
}

/** The first text content of a tools/call result, for the failure detail. */
function firstText(res: RpcResponse): string {
  const result = resultOf(res.body);
  const content = result?.content;
  if (Array.isArray(content)) {
    const text = content.find((c) => isObject(c) && typeof c.text === "string") as { text: string } | undefined;
    if (text) return brief(text.text);
  }
  return brief(result ?? res.body);
}

/**
 * The tool to push the unicode probe through: a tool literally named
 * `echo` when the server has one, else the first listed tool (the
 * 2025-11-25 suite's choice). Null when the tools list is not available
 * -- undeclared capability, or the features module did not run under an
 * `--only` filter.
 */
function pickUnicodeTool(ctx: ModernSuiteContext): { name: string; inputSchema: unknown } | null {
  if (!hasTools(ctx)) return null;
  const tools = ctx.state.tools;
  if (!tools || tools.length === 0) return null;
  const byName = (name: string) => tools.find((t) => isObject(t) && t.name === name);
  const tool = byName("echo") ?? tools[0];
  if (!isObject(tool) || typeof tool.name !== "string") return null;
  return { name: tool.name, inputSchema: tool.inputSchema };
}

export async function runStdio(ctx: ModernSuiteContext): Promise<void> {
  const { client, harness } = ctx;

  // ── stdio-framing ──────────────────────────────────────────────
  // Five discovers written without awaiting between them. A server that
  // pretty-prints, forgets the trailing newline, or interleaves a log
  // line on stdout corrupts at least one frame; the transport's line
  // splitter then never matches that id and the request times out.
  await harness.check("stdio-framing", async () => {
    const settled = await Promise.all(
      Array.from({ length: RAPID_DISCOVERS }, () =>
        client.rpc("server/discover").then(
          (res) => ({ res, err: undefined }),
          (err: unknown) => ({ res: undefined, err }),
        ),
      ),
    );
    const unanswered = settled.filter((s) => s.res === undefined);
    if (unanswered.length > 0) {
      const why = explainFailure(ctx, unanswered[0]?.err);
      return {
        passed: false,
        details: `${unanswered.length}/${RAPID_DISCOVERS} rapid discovers unanswered -- framing likely broken (${why})`,
      };
    }
    const answered = settled.map((s) => s.res as RpcResponse);
    // The transport only resolves a request when a line carries its id
    // with the same type; this is the explicit form of that guarantee.
    const mismatched = answered.filter((res) => !isObject(res.body) || res.body.id !== res.requestId);
    if (mismatched.length > 0) {
      const first = mismatched[0] as RpcResponse;
      return {
        passed: false,
        details: `${mismatched.length}/${RAPID_DISCOVERS} responses did not echo their request id (sent ${brief(first.requestId)}, got ${brief(isObject(first.body) ? first.body.id : first.body)})`,
      };
    }
    const errored = answered.filter((res) => errorOf(res.body) !== undefined).length;
    const note = errored > 0 ? ` (${errored} answered with a JSON-RPC error)` : "";
    return {
      passed: true,
      details: `${RAPID_DISCOVERS}/${RAPID_DISCOVERS} rapid discovers answered as single JSON lines with matching ids${note}`,
    };
  });

  // ── stdio-unicode ──────────────────────────────────────────────
  // Same shape as the 2025-11-25 test: push the probe through a tool
  // when one is available and demand it back byte-for-byte; otherwise
  // carry it in the discover envelope's clientInfo name, where the only
  // observable is that the server parsed the request and answered.
  await harness.check("stdio-unicode", async () => {
    let note = "";
    const tool = pickUnicodeTool(ctx);
    if (tool) {
      const res = await client.rpc(
        "tools/call",
        {
          name: tool.name,
          arguments: { message: UNICODE_PROBE, text: UNICODE_PROBE, input: UNICODE_PROBE, query: UNICODE_PROBE },
        },
        { toolInputSchema: tool.inputSchema },
      );
      if (JSON.stringify(res.body).includes(UNICODE_PROBE)) {
        return { passed: true, details: `tools/call ${tool.name} reproduced the CJK/emoji probe byte-for-byte` };
      }
      const err = errorOf(res.body);
      if (!err) {
        // The tool produced output and the characters are gone: this is
        // the decoding defect the test exists for.
        return {
          passed: false,
          details: `tools/call ${tool.name} answered without the probe characters (got ${firstText(res)})`,
        };
      }
      if (err.code === JSONRPC_ERROR_CODES.PARSE_ERROR) {
        return { passed: false, details: `tools/call ${tool.name} with a CJK/emoji argument -> -32700 parse error` };
      }
      // The tool rejected the arguments (unknown args, schema mismatch):
      // nothing echoed, so fall through to the envelope probe.
      note = `tools/call ${tool.name} rejected the probe (JSON-RPC error ${err.code}); `;
    }

    const res = await client.rpc("server/discover", undefined, {
      meta: { [META.clientInfo]: { name: UNICODE_PROBE, version: "1.0.0" } },
    });
    const err = errorOf(res.body);
    if (err) {
      return {
        passed: false,
        details: `${note}server/discover with a CJK/emoji clientInfo name -> JSON-RPC error ${err.code}`,
      };
    }
    if (!resultOf(res.body)) {
      return {
        passed: false,
        details: `${note}server/discover with a CJK/emoji clientInfo name -> non-JSON-RPC reply`,
      };
    }
    if (JSON.stringify(res.body).includes(UNICODE_PROBE)) {
      return { passed: true, details: `${note}server/discover reproduced the CJK/emoji clientInfo name byte-for-byte` };
    }
    return {
      passed: true,
      details: `${note}server/discover accepted a request whose clientInfo name carries CJK/emoji (no echo path to verify byte-for-byte)`,
    };
  });

  // ── stdio-unknown-method-recovers ──────────────────────────────
  await harness.check("stdio-unknown-method-recovers", async () => {
    let first: RpcResponse;
    try {
      first = await client.rpc(BOGUS_METHOD);
    } catch (err: unknown) {
      return { passed: false, details: `unknown method drew no response (${explainFailure(ctx, err)})` };
    }
    const err = errorOf(first.body);
    if (!err) {
      const what = resultOf(first.body) ? "a result" : `a non-error reply (${brief(first.body)})`;
      return { passed: false, details: `unknown method answered with ${what} instead of a JSON-RPC error` };
    }
    if (err.code !== JSONRPC_ERROR_CODES.METHOD_NOT_FOUND) {
      harness.warnings.push(
        `stdio-unknown-method-recovers: unknown method drew JSON-RPC error ${err.code}; -32601 Method not found is the expected code.`,
      );
    }
    let second: RpcResponse;
    try {
      second = await client.rpc("server/discover");
    } catch (e: unknown) {
      return {
        passed: false,
        details: `unknown method -> JSON-RPC error ${err.code}, but server/discover afterwards got no reply (${explainFailure(ctx, e)})`,
      };
    }
    const err2 = errorOf(second.body);
    if (err2) {
      return {
        passed: false,
        details: `unknown method -> JSON-RPC error ${err.code}, but server/discover afterwards -> JSON-RPC error ${err2.code} (server may have desynced)`,
      };
    }
    if (!resultOf(second.body)) {
      return {
        passed: false,
        details: `unknown method -> JSON-RPC error ${err.code}, but server/discover afterwards -> non-JSON-RPC reply`,
      };
    }
    return {
      passed: true,
      details: `unknown method -> JSON-RPC error ${err.code}; server/discover answered afterwards on the same process`,
    };
  });

  // ── stdio-cancellation ─────────────────────────────────────────
  // A notification has no id, so the only things the server may do are
  // ignore it or cancel the (nonexistent) request. Anything written back
  // that is not the discover's own answer is a reply to the notification.
  await harness.check("stdio-cancellation", async () => {
    const before = ctx.recorder.received.length;
    try {
      await client.notify("notifications/cancelled", {
        requestId: UNKNOWN_CANCEL_ID,
        reason: "mcp-compliance: cancellation of a request that was never issued",
      });
    } catch (err: unknown) {
      return { passed: false, details: `could not write notifications/cancelled (${explainFailure(ctx, err)})` };
    }
    let res: RpcResponse;
    try {
      res = await client.rpc("server/discover");
    } catch (err: unknown) {
      return {
        passed: false,
        details: `server/discover after notifications/cancelled (unknown id) got no reply (${explainFailure(ctx, err)})`,
      };
    }
    const err = errorOf(res.body);
    if (err) {
      return {
        passed: false,
        details: `server/discover after notifications/cancelled (unknown id) -> JSON-RPC error ${err.code}`,
      };
    }
    if (!resultOf(res.body)) {
      return {
        passed: false,
        details: "server/discover after notifications/cancelled (unknown id) -> non-JSON-RPC reply",
      };
    }
    const stray = ctx.recorder.received
      .slice(before)
      .map((entry) => entry.message)
      .filter((m) => isResponse(m) && m.id !== res.requestId);
    if (stray.length > 0) {
      const m = stray[0] as Record<string, unknown>;
      const what = errorOf(m) ? `JSON-RPC error ${errorOf(m)?.code}` : "a result";
      return {
        passed: false,
        details: `server replied to notifications/cancelled with ${what} (id ${brief(m.id)}); notifications must not be answered`,
      };
    }
    const exit = exitState(ctx);
    if (exit.exited) {
      return {
        passed: false,
        details: `server exited (code ${exit.exitCode}) after notifications/cancelled for an unknown id`,
      };
    }
    return {
      passed: true,
      details: `notifications/cancelled for unknown id ${UNKNOWN_CANCEL_ID} drew no reply; server/discover answered afterwards`,
    };
  });
}
