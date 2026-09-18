import { errorWithCode } from "../../checks/validators.js";
import type { TestOutcome } from "../../harness.js";
import { errorOf, type RpcOptions, type RpcResponse, resultOf } from "../../modern/client.js";
import { JSONRPC_ERROR_CODES, META } from "../../modern/meta.js";
import type { StdioTransport } from "../../transport/stdio.js";
import { ensureTools, type ModernSuiteContext } from "./context.js";
import { restartStdioServer, unreachable } from "./security.js";

/**
 * Stdio-only tests of the 2026-07-28 suite. The catalog gates every id
 * here to `transports: ["stdio"]`, so on HTTP `harness.check` skips them
 * and none of this runs. They probe the one thing HTTP gets for free
 * from the connection model: a single long-lived process whose stdout
 * must stay a clean stream of newline-delimited JSON no matter what the
 * client writes to stdin.
 *
 * A child that exits on stdio-unicode's own probe -- before answering it,
 * or right after -- is replaced before the check returns (security.ts's
 * restartStdioServer, the same policy the security checks follow), so the
 * checks after it -- the rest of this module, the late lifecycle block,
 * security, post-hoc -- measure a live server. Every check therefore sends through `ctx.client`, read at send
 * time, never a client captured before a restart.
 */

/** Same probe the 2025-11-25 suite uses: Latin-1 accent, CJK, an astral-plane emoji. */
const UNICODE_PROBE = "héllo 世界 🚀";
/** The probe's first word: present intact when only the astral/CJK part was lost. */
const UNICODE_PROBE_LATIN1_WORD = "héllo";
/** The probe's CJK word and emoji: either one anywhere in a reply rules out "dropped". */
const UNICODE_PROBE_CJK = "世界";
const UNICODE_PROBE_EMOJI = "🚀";
/** What a UTF-8 byte stream decoded as Latin-1 makes of the first word ("hÃ©llo"). */
const UNICODE_PROBE_MISDECODED = Buffer.from(UNICODE_PROBE_LATIN1_WORD, "utf8").toString("latin1");
/**
 * The probe with every non-ASCII character dropped, up to the space that
 * follows its first word ("hllo "): the skeleton a stripping decoder
 * leaves. The space keeps it out of base64 blobs.
 */
const UNICODE_PROBE_STRIPPED = Array.from(UNICODE_PROBE)
  .filter((c) => c.charCodeAt(0) < 128)
  .join("")
  .replace(/ +$/, " ");
/**
 * The first word as an encoder on a legacy code page writes it: every
 * unencodable character replaced by '?' (one per code point, or one per
 * UTF-16 unit -- the .NET and Java default on a Windows code page).
 */
const UNICODE_PROBE_QUESTIONED = /h\?{1,2}llo/;
/** What a decoder substitutes for bytes it could not decode. */
const REPLACEMENT_CHARACTER = "\uFFFD";
/** Argument names a tool most plausibly echoes, in order of preference. */
const ECHO_ARGUMENT_NAMES = ["message", "text", "input", "query"] as const;
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

/** A server-chosen name for details and warnings: ASCII, clipped to `max`. */
function clipName(text: string, max = 60): string {
  const safe = ascii(text.replace(/\s+/g, " "));
  return safe.length > max ? `${safe.slice(0, max - 3)}...` : safe;
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

interface UnicodeTool {
  name: string;
  inputSchema: unknown;
  /** The argument names to carry the probe in. */
  args: string[];
}

/** The string-typed properties of a tool's inputSchema whose names suggest an echo path. */
function echoArguments(inputSchema: unknown): string[] {
  if (!isObject(inputSchema) || !isObject(inputSchema.properties)) return [];
  const props = inputSchema.properties;
  return ECHO_ARGUMENT_NAMES.filter((name) => {
    const p = props[name];
    return isObject(p) && (p.type === "string" || (Array.isArray(p.type) && p.type.includes("string")));
  });
}

/**
 * The tool to push the unicode probe through: a tool literally named
 * `echo` when the server has one; else the first tool with a string
 * property named message/text/input/query, so the echo path is real;
 * else the first listed tool (the 2025-11-25 suite's choice), which may
 * not echo anything -- the verdict then rests on the envelope probe.
 * Null when the server declares no tools or the list is unavailable.
 */
async function pickUnicodeTool(ctx: ModernSuiteContext): Promise<UnicodeTool | null> {
  const tools = await ensureTools(ctx);
  if (!tools || tools.length === 0) return null;
  const named = tools.filter((t): t is Record<string, unknown> => isObject(t) && typeof t.name === "string");
  const tool =
    named.find((t) => t.name === "echo") ?? named.find((t) => echoArguments(t.inputSchema).length > 0) ?? named[0];
  if (!tool) return null;
  const declared = echoArguments(tool.inputSchema);
  return {
    name: tool.name as string,
    inputSchema: tool.inputSchema,
    args: declared.length > 0 ? declared : [...ECHO_ARGUMENT_NAMES],
  };
}

/**
 * Evidence that a reply MANGLED the probe, or undefined when the probe is
 * merely absent (the tool did not echo its input). Absence proves
 * nothing: a `get_time` tool answers "12:00" whatever it was sent.
 * "Dropped" needs the first word (intact or as its ASCII skeleton) with
 * NEITHER the CJK word NOR the emoji anywhere in the reply: a search
 * tool that tokenizes or truncates its query reflects the pieces apart,
 * and that is not mangling.
 */
function manglingEvidence(serialized: string): string | undefined {
  if (serialized.includes(REPLACEMENT_CHARACTER)) return "the reply carries U+FFFD replacement characters";
  if (serialized.includes(UNICODE_PROBE_MISDECODED)) {
    return `the reply carries the probe decoded as Latin-1 (${escapeNonAscii(UNICODE_PROBE_MISDECODED)})`;
  }
  if (UNICODE_PROBE_QUESTIONED.test(serialized)) {
    return "the reply carries the probe with its non-ASCII characters replaced by '?'";
  }
  const firstWord = serialized.includes(UNICODE_PROBE_LATIN1_WORD) || serialized.includes(UNICODE_PROBE_STRIPPED);
  const rest = serialized.includes(UNICODE_PROBE_CJK) || serialized.includes(UNICODE_PROBE_EMOJI);
  if (firstWord && !rest) return "the reply carries the probe with its CJK/emoji characters dropped";
  return undefined;
}

/** Whether every non-ASCII piece of the probe appears in a reply, contiguous or not (a tokenizing tool). */
function reproducesEveryPiece(serialized: string): boolean {
  return (
    serialized.includes(UNICODE_PROBE_LATIN1_WORD) &&
    serialized.includes(UNICODE_PROBE_CJK) &&
    serialized.includes(UNICODE_PROBE_EMOJI)
  );
}

/** Non-ASCII as \uXXXX escapes, so a mis-decoded sample survives the ASCII details. */
function escapeNonAscii(text: string): string {
  return text.replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export async function runStdio(ctx: ModernSuiteContext): Promise<void> {
  const { harness } = ctx;

  // ── stdio-framing ──────────────────────────────────────────────
  // Five discovers written without awaiting between them. A server that
  // pretty-prints, forgets the trailing newline, or interleaves a log
  // line on stdout corrupts at least one frame; the transport's line
  // splitter then never matches that id and the request times out.
  await harness.check("stdio-framing", async () => {
    const settled = await Promise.all(
      Array.from({ length: RAPID_DISCOVERS }, () =>
        ctx.client.rpc("server/discover").then(
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
  // Same pass criteria as the 2025-11-25 test: push the probe through a
  // tool when one is available and pass when it comes back byte-for-byte
  // (or every piece of it, for a tool that tokenizes its input); fail
  // only on EVIDENCE of mangling (U+FFFD, a Latin-1 mis-decode, '?'
  // substitution, the non-ASCII characters stripped, a -32700). A reply
  // that merely lacks the probe means the tool did not echo its input --
  // an arbitrary first tool rarely does -- so the verdict then rests on
  // the discover envelope: the probe rides in clientInfo.name, and the
  // server parsing and answering that request is the round-trip verified.
  //
  // A crash or a hang on non-ASCII stdin is the likeliest real failure
  // here. A request that gets no reply fails with a one-line reason (never
  // the transport's multi-line stderr tail, which can echo the probe), and
  // so does one answered by a child that exits right after (a plain
  // server/discover sent after each answered probe finds it gone). A
  // child that exited on it is replaced (restartStdioServer, whose warning
  // names this check) so the checks after it measure the server instead
  // of a dead process -- on every attempt that kills it, --retries
  // included; one already gone before the request was not killed by it:
  // "server unreachable", and no restart. A caller's abort is rethrown.
  await harness.check("stdio-unicode", async () => {
    /**
     * Send one request carrying the probe: its reply, or the verdict for
     * none. `what` opens the details; `cause` names the request in the
     * restart's warning.
     */
    const send = async (
      what: string,
      cause: string,
      method: string,
      params: unknown,
      opts: RpcOptions,
    ): Promise<{ res: RpcResponse } | { verdict: TestOutcome }> => {
      const alreadyGone = exitState(ctx).exited;
      try {
        const res = await ctx.client.rpc(method, params, opts);
        if (alreadyGone) return { res };
        // A child can answer the probe and exit right after writing the
        // reply (a logger that chokes on the non-ASCII line it just echoed):
        // one plain server/discover tells a live process from one the probe
        // killed. An answer, or anything short of the child being gone, is
        // a live process; the probe's reply is judged as usual.
        try {
          await ctx.client.rpc("server/discover");
        } catch (err: unknown) {
          if (ctx.signal?.aborted) throw err;
          if (exitState(ctx).exited) {
            // Read before the restart replaces ctx.transport.
            const verdict = {
              passed: false,
              details: `${what} was answered, but the server exited right after (${explainFailure(ctx, err)})`,
            };
            await restartStdioServer(ctx, "stdio-unicode", cause);
            return { verdict };
          }
        }
        return { res };
      } catch (err: unknown) {
        if (ctx.signal?.aborted) throw err;
        if (alreadyGone) return { verdict: unreachable(ctx, what, err) };
        // Read before the restart replaces ctx.transport.
        const verdict = { passed: false, details: `${what} got no reply (${explainFailure(ctx, err)})` };
        if (exitState(ctx).exited) await restartStdioServer(ctx, "stdio-unicode", cause);
        return { verdict };
      }
    };

    let note = "";
    const tool = await pickUnicodeTool(ctx);
    if (tool) {
      const name = clipName(tool.name);
      const what = `tools/call ${name} with a CJK/emoji argument`;
      const sent = await send(
        what,
        what,
        "tools/call",
        { name: tool.name, arguments: Object.fromEntries(tool.args.map((arg) => [arg, UNICODE_PROBE])) },
        { toolInputSchema: tool.inputSchema },
      );
      if ("verdict" in sent) return sent.verdict;
      const res = sent.res;
      const serialized = JSON.stringify(res.body);
      if (serialized.includes(UNICODE_PROBE)) {
        return { passed: true, details: `tools/call ${name} reproduced the CJK/emoji probe byte-for-byte` };
      }
      if (reproducesEveryPiece(serialized)) {
        return {
          passed: true,
          details: `tools/call ${name} reproduced every non-ASCII piece of the CJK/emoji probe (split across the reply, not byte-for-byte)`,
        };
      }
      const err = errorOf(res.body);
      if (err?.code === JSONRPC_ERROR_CODES.PARSE_ERROR) {
        return { passed: false, details: `tools/call ${name} with a CJK/emoji argument -> -32700 parse error` };
      }
      const mangled = manglingEvidence(serialized);
      if (mangled) {
        return {
          passed: false,
          details: `tools/call ${name} mangled the CJK/emoji probe: ${mangled} (got ${firstText(res)})`,
        };
      }
      // Rejected (unknown args, schema mismatch) or answered without
      // reflecting its arguments: nothing to compare, so the envelope
      // probe decides.
      note = err
        ? `tools/call ${name} rejected the probe (${errorWithCode(err.rawCode)}); `
        : `tools/call ${name} did not echo the probe; `;
    }

    const envelope = "server/discover with a CJK/emoji clientInfo name";
    const sent = await send(`${note}${envelope}`, envelope, "server/discover", undefined, {
      meta: { [META.clientInfo]: { name: UNICODE_PROBE, version: "1.0.0" } },
    });
    if ("verdict" in sent) return sent.verdict;
    const res = sent.res;
    const err = errorOf(res.body);
    if (err) return { passed: false, details: `${note}${envelope} -> ${errorWithCode(err.rawCode)}` };
    if (!resultOf(res.body)) return { passed: false, details: `${note}${envelope} -> non-JSON-RPC reply` };
    const serialized = JSON.stringify(res.body);
    if (serialized.includes(UNICODE_PROBE)) {
      return { passed: true, details: `${note}server/discover reproduced the CJK/emoji clientInfo name byte-for-byte` };
    }
    const mangled = manglingEvidence(serialized);
    if (mangled) {
      return {
        passed: false,
        details: `${note}server/discover mangled the CJK/emoji clientInfo name: ${mangled}`,
      };
    }
    return {
      passed: true,
      details: `${note}envelope round-trip verified: server/discover accepted a request whose clientInfo name carries CJK/emoji (no echo path to compare byte-for-byte)`,
    };
  });

  // ── stdio-unknown-method-recovers ──────────────────────────────
  await harness.check("stdio-unknown-method-recovers", async () => {
    let first: RpcResponse;
    try {
      first = await ctx.client.rpc(BOGUS_METHOD);
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
        `stdio-unknown-method-recovers: unknown method drew ${errorWithCode(err.rawCode)}; -32601 Method not found is the expected code.`,
      );
    }
    let second: RpcResponse;
    try {
      second = await ctx.client.rpc("server/discover");
    } catch (e: unknown) {
      return {
        passed: false,
        details: `unknown method -> ${errorWithCode(err.rawCode)}, but server/discover afterwards got no reply (${explainFailure(ctx, e)})`,
      };
    }
    const err2 = errorOf(second.body);
    if (err2) {
      return {
        passed: false,
        details: `unknown method -> ${errorWithCode(err.rawCode)}, but server/discover afterwards -> ${errorWithCode(err2.rawCode)} (server may have desynced)`,
      };
    }
    if (!resultOf(second.body)) {
      return {
        passed: false,
        details: `unknown method -> ${errorWithCode(err.rawCode)}, but server/discover afterwards -> non-JSON-RPC reply`,
      };
    }
    return {
      passed: true,
      details: `unknown method -> ${errorWithCode(err.rawCode)}; server/discover answered afterwards on the same process`,
    };
  });

  // ── stdio-cancellation ─────────────────────────────────────────
  // A notification has no id, so the only things the server may do are
  // ignore it or cancel the (nonexistent) request. Anything written back
  // that is not the discover's own answer is a reply to the notification.
  await harness.check("stdio-cancellation", async () => {
    const before = ctx.recorder.received.length;
    try {
      await ctx.client.notify("notifications/cancelled", {
        requestId: UNKNOWN_CANCEL_ID,
        reason: "mcp-compliance: cancellation of a request that was never issued",
      });
    } catch (err: unknown) {
      return { passed: false, details: `could not write notifications/cancelled (${explainFailure(ctx, err)})` };
    }
    let res: RpcResponse;
    try {
      res = await ctx.client.rpc("server/discover");
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
        details: `server/discover after notifications/cancelled (unknown id) -> ${errorWithCode(err.rawCode)}`,
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
      const what = errorOf(m) ? errorWithCode(errorOf(m)?.rawCode) : "a result";
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
