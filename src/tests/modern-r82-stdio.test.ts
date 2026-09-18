import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDefinitionMap } from "../definitions/index.js";
import { createHarness } from "../harness.js";
import { createModernClient } from "../modern/client.js";
import { createRecorder } from "../recorder.js";
import { MODERN_SPEC_VERSION, specBaseFor } from "../spec.js";
import { createModernState, type ModernState, type ModernSuiteContext } from "../suites/modern/context.js";
import { checkLiveness, LIVENESS_BUDGET_MS, unresponsiveReason } from "../suites/modern/liveness.js";
import { runStdio } from "../suites/modern/stdio.js";
import type {
  MessageListener,
  Transport,
  TransportNotifyResult,
  TransportResponse,
  TransportStream,
} from "../transport/index.js";
import type { ComplianceReport, TransportTarget } from "../types.js";
import { MODERN_FIXTURE, resultOf, runModern } from "./helpers/modern-fixture.js";

/**
 * 2026-07-28 stdio-unicode after review 82 (items 7, 11, 21), and the
 * liveness probe it shares with lifecycle-progress-token (liveness.ts).
 *
 * - A child that answers the probe and then stops answering (still
 *   running) FAILS the check, with a warning naming the probe. Before: the
 *   follow-up server/discover waited the full --timeout, its failure was
 *   thrown away, and the check PASSED ("reproduced the CJK/emoji probe
 *   byte-for-byte") while the next check took the blame for the hang.
 * - That follow-up discover waits at most LIVENESS_BUDGET_MS (2000 ms, less
 *   when --timeout is shorter), never a full --timeout; over HTTP it is not
 *   sent at all, and a healthy stdio server pays one quick round trip.
 * - Every stdio-unicode details string keeps to the 220-character budget
 *   by clipping its head (the note on a rejected tools/call, then the
 *   request's name), never its conclusion. Before: 233-260 characters with
 *   a long tool name, or, on the "server unreachable" path, the reason cut
 *   off the end.
 */

const PROBE = "héllo 世界 🚀";
const TOOL_PROBE = "tools/call echo with a CJK/emoji argument";
const ENVELOPE_PROBE = "server/discover with a CJK/emoji clientInfo name";
const NO_REPLY = `no reply to server/discover within ${LIVENESS_BUDGET_MS}ms`;
const STOPPED = (what: string) => `${what} was answered, but the server stopped answering right after (${NO_REPLY})`;
const STOPPED_WARNING = (cause: string) =>
  `stdio-unicode: the server stopped answering right after ${cause} was answered (${NO_REPLY}); it was not restarted, so the tests after it may fail on the same hang.`;
const ENVELOPE_PASS =
  "envelope round-trip verified: server/discover accepted a request whose clientInfo name carries CJK/emoji (no echo path to compare byte-for-byte)";

// ---------------------------------------------------------------------------
// An in-memory stdio transport, scripted per request
// ---------------------------------------------------------------------------

/**
 * What the scripted child does with one request: answer it with a result or
 * an error; "silent": never answer (the request times out, as the stdio
 * transport reports it); "exit": exit (code 3) on it; "stdin-closed": refuse
 * the write while the process keeps running.
 */
type Reply =
  | { result: Record<string, unknown> }
  | { error: { code: unknown; message: string } }
  | "silent"
  | "exit"
  | "stdin-closed";

interface FakeStdio extends Transport {
  exited: boolean;
  exitCode: number | null;
  /** Every request as sent, with the timeout it was sent with. */
  calls: { method: string; params: unknown; timeout: number }[];
}

const DISCOVER_RESULT = { resultType: "complete", supportedVersions: [MODERN_SPEC_VERSION] };

/**
 * A stdio child scripted by `reply` (`n` counts requests from 0). With
 * `exitAfter` true for a request, the child answers it and then exits (code
 * 3) before the next one arrives.
 */
function fakeStdio(
  reply: (method: string, params: unknown, n: number) => Reply,
  exitAfter: (method: string, params: unknown) => boolean = () => false,
): FakeStdio {
  const listeners = new Set<MessageListener>();
  let n = 0;
  const fake: FakeStdio = {
    kind: "stdio",
    exited: false,
    exitCode: null,
    calls: [],
    async request(method, params, nextId, init): Promise<TransportResponse> {
      const id = nextId();
      fake.calls.push({ method, params, timeout: init.timeout });
      if (fake.exited) {
        throw new Error(
          `stdio transport: server crashed with exit code ${fake.exitCode} before completing the request`,
        );
      }
      const r = reply(method, params, n++);
      if (r === "exit") {
        fake.exited = true;
        fake.exitCode = 3;
        throw new Error("stdio transport: server crashed with exit code 3 before completing the request");
      }
      if (r === "silent") {
        await new Promise((resolve) => setTimeout(resolve, 10));
        throw new Error(`stdio transport: request timed out after ${init.timeout}ms (method=${method})`);
      }
      if (r === "stdin-closed") {
        throw new Error("stdio transport: stdin is closed: the server stopped reading its input (write EPIPE)");
      }
      const body = "result" in r ? { jsonrpc: "2.0", id, result: r.result } : { jsonrpc: "2.0", id, error: r.error };
      for (const l of listeners) l(body, {});
      if (exitAfter(method, params)) {
        fake.exited = true;
        fake.exitCode = 3;
      }
      return { body, requestId: id };
    },
    async notify(): Promise<TransportNotifyResult> {
      if (fake.exited) throw new Error("stdio transport: server crashed with exit code 3");
      return {};
    },
    async stream(): Promise<TransportStream> {
      throw new Error("not scripted");
    },
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {},
    setSessionId() {},
    setProtocolVersion() {},
    getSessionId: () => null,
    getProtocolVersion: () => null,
  };
  return fake;
}

/** A suite context around `transport`, the way runModernSuite builds one. */
function makeContext(
  transport: Transport,
  state: Partial<ModernState> = {},
  timeout = 5000,
  kind: "stdio" | "http" = "stdio",
): ModernSuiteContext {
  const harness = createHarness({
    definitions: getTestDefinitionMap(MODERN_SPEC_VERSION),
    specBase: specBaseFor(MODERN_SPEC_VERSION),
    transportKind: kind,
  });
  const recorder = createRecorder();
  transport.onMessage((m) => recorder.recordReceived(m));
  let id = 1000;
  const client = createModernClient({
    transport,
    recorder,
    nextId: () => id++,
    timeout,
    protocolVersion: MODERN_SPEC_VERSION,
    clientCapabilities: { elicitation: {} },
    clientInfo: { name: "mcp-compliance-test", version: "0.0.0" },
  });
  return {
    harness,
    client,
    recorder,
    transport,
    kind,
    timeout,
    startupTimeout: 5000,
    backendUrl: "",
    userHeaders: {},
    displayUrl: "stdio://fake",
    detection: undefined,
    hasAuth: false,
    state: { ...createModernState(), ...state },
  };
}

function outcome(ctx: ModernSuiteContext, id: string) {
  const r = ctx.harness.tests.find((t) => t.id === id);
  if (!r) throw new Error(`${id} did not run (ran: ${ctx.harness.tests.map((t) => t.id).join(", ")})`);
  return r;
}

const carriesProbe = (params: unknown) => JSON.stringify(params ?? {}).includes(PROBE);

/** The liveness discover: a plain server/discover sent right after the probe. */
function livenessCalls(fake: FakeStdio) {
  return fake.calls.filter(
    (c, i) => c.method === "server/discover" && i > 0 && carriesProbe(fake.calls[i - 1]?.params),
  );
}

// ---------------------------------------------------------------------------
// checkLiveness itself
// ---------------------------------------------------------------------------

describe("checkLiveness (liveness.ts)", () => {
  const discover = () => ({ result: DISCOVER_RESULT });

  it("a live child: one server/discover, sent with the short budget, not the per-request timeout", async () => {
    const fake = fakeStdio(discover);
    const ctx = makeContext(fake, {}, 15_000);
    expect(await checkLiveness(ctx)).toEqual({ state: "alive" });
    expect(fake.calls.map((c) => [c.method, c.timeout])).toEqual([["server/discover", LIVENESS_BUDGET_MS]]);
  });

  it("a per-request timeout shorter than the budget wins", async () => {
    const fake = fakeStdio(discover);
    await checkLiveness(makeContext(fake, {}, 1500));
    expect(fake.calls.map((c) => c.timeout)).toEqual([1500]);
  });

  it("an answer that is a JSON-RPC error still means the process is serving", async () => {
    const fake = fakeStdio(() => ({ error: { code: -32603, message: "busy" } }));
    expect(await checkLiveness(makeContext(fake))).toEqual({ state: "alive" });
  });

  it("over HTTP nothing is sent: there is no child to lose", async () => {
    const fake = fakeStdio(discover);
    expect(await checkLiveness(makeContext(fake, {}, 5000, "http"))).toEqual({ state: "alive" });
    expect(fake.calls).toEqual([]);
  });

  it("a child gone is 'exited'; one that times out, or refuses the write while running, is 'unresponsive'", async () => {
    const exited = await checkLiveness(makeContext(fakeStdio(() => "exit")));
    expect(exited.state).toBe("exited");

    const silent = await checkLiveness(
      makeContext(
        fakeStdio(() => "silent"),
        {},
        15_000,
      ),
    );
    expect(silent.state).toBe("unresponsive");
    if (silent.state !== "unresponsive") throw new Error("unreachable");
    expect(silent.budgetMs).toBe(LIVENESS_BUDGET_MS);
    expect(unresponsiveReason(silent)).toBe(NO_REPLY);

    const closed = await checkLiveness(makeContext(fakeStdio(() => "stdin-closed")));
    expect(closed.state).toBe("unresponsive");
    if (closed.state !== "unresponsive") throw new Error("unreachable");
    expect(unresponsiveReason(closed)).toBe(
      "server/discover failed: stdin is closed: the server stopped reading its input (write EPIPE)",
    );
  });

  it("a caller's abort is rethrown, never read as a hang", async () => {
    const fake = fakeStdio(() => "silent");
    const ctx = makeContext(fake);
    const abort = new AbortController();
    abort.abort(new Error("caller aborted"));
    ctx.signal = abort.signal;
    await expect(checkLiveness(ctx)).rejects.toThrow(/timed out/);
  });
});

// ---------------------------------------------------------------------------
// stdio-unicode over scripted children
// ---------------------------------------------------------------------------

const ECHO_STATE: Partial<ModernState> = {
  capabilities: { tools: {} },
  tools: [{ name: "echo", inputSchema: { type: "object", properties: { message: { type: "string" } } } }],
  toolNames: ["echo"],
};

/** A tool name at the 70-character mark, clipped to 60 in the details. */
const LONG_NAME = `search_${"x".repeat(63)}`;
const LONG_STATE: Partial<ModernState> = {
  capabilities: { tools: {} },
  tools: [{ name: LONG_NAME, inputSchema: { type: "object", properties: { query: { type: "string" } } } }],
  toolNames: [LONG_NAME],
};

/**
 * Discover answered, tools/call echoes its arguments (or answers `toolReply`),
 * everything else -32601; `onProbe` decides what the child does with the
 * request carrying the probe that `probeMethod` names, and `afterProbe` with
 * every request after it.
 */
function unicodeChild(opts: {
  probeMethod: "tools/call" | "server/discover";
  toolReply?: Reply;
  onProbe?: Reply;
  afterProbe?: Reply;
  exitAfterProbe?: boolean;
}): FakeStdio {
  let probed = false;
  const isProbe = (method: string, params: unknown) => method === opts.probeMethod && carriesProbe(params);
  return fakeStdio(
    (method, params) => {
      if (probed && opts.afterProbe) return opts.afterProbe;
      if (isProbe(method, params)) {
        probed = true;
        if (opts.onProbe) return opts.onProbe;
      }
      if (method === "server/discover") return { result: DISCOVER_RESULT };
      if (method === "tools/call") {
        if (opts.toolReply) return opts.toolReply;
        const args = (params as { arguments?: Record<string, unknown> }).arguments ?? {};
        return {
          result: { resultType: "complete", content: [{ type: "text", text: String(Object.values(args)[0]) }] },
        };
      }
      return { error: { code: -32601, message: "Method not found" } };
    },
    (method, params) => opts.exitAfterProbe === true && isProbe(method, params),
  );
}

describe("2026-07-28 stdio-unicode: a child that stops answering right after the probe", () => {
  it("tools/call probe answered, then nothing: FAILS naming the hang, with a warning (before: PASS 'reproduced ... byte-for-byte')", async () => {
    const fake = unicodeChild({ probeMethod: "tools/call", afterProbe: "silent" });
    const ctx = makeContext(fake, ECHO_STATE, 15_000);
    await runStdio(ctx);
    const unicode = outcome(ctx, "stdio-unicode");
    expect(unicode.passed).toBe(false);
    expect(unicode.details).toBe(STOPPED(TOOL_PROBE));
    expect(ctx.harness.warnings).toContain(STOPPED_WARNING(TOOL_PROBE));
    // The follow-up discover waited the short budget, not the 15 s timeout.
    expect(livenessCalls(fake).map((c) => c.timeout)).toEqual([LIVENESS_BUDGET_MS]);
  });

  it("the envelope discover answered, then nothing: the same FAIL, on the envelope path", async () => {
    const fake = unicodeChild({ probeMethod: "server/discover", afterProbe: "silent" });
    const ctx = makeContext(fake, {}, 15_000);
    await runStdio(ctx);
    expect(outcome(ctx, "stdio-unicode").details).toBe(STOPPED(ENVELOPE_PROBE));
    expect(ctx.harness.warnings).toContain(STOPPED_WARNING(ENVELOPE_PROBE));
  });

  it("a child that closed its stdin after answering is a hang too, with the transport's reason", async () => {
    const fake = unicodeChild({ probeMethod: "tools/call", afterProbe: "stdin-closed" });
    const ctx = makeContext(fake, ECHO_STATE);
    await runStdio(ctx);
    expect(outcome(ctx, "stdio-unicode").details).toBe(
      `${TOOL_PROBE} was answered, but the server stopped answering right after (server/discover failed: stdin is closed: the server stopped reading its input (write EPIPE))`,
    );
  });

  it("a healthy child: PASS as before, after exactly one follow-up discover, and no warning", async () => {
    const fake = unicodeChild({ probeMethod: "tools/call" });
    const ctx = makeContext(fake, ECHO_STATE, 15_000);
    await runStdio(ctx);
    for (const id of ["stdio-framing", "stdio-unicode", "stdio-unknown-method-recovers", "stdio-cancellation"]) {
      expect(outcome(ctx, id).passed, `${id}: ${outcome(ctx, id).details}`).toBe(true);
    }
    expect(outcome(ctx, "stdio-unicode").details).toBe("tools/call echo reproduced the CJK/emoji probe byte-for-byte");
    expect(livenessCalls(fake)).toHaveLength(1);
    expect(ctx.harness.warnings).toEqual([]);
  });
});

describe("2026-07-28 stdio-unicode: details keep to 220 characters and keep the conclusion", () => {
  const rejectTool: Reply = { error: { code: -32602, message: "Invalid params" } };
  const clipped = `tools/call ${LONG_NAME.slice(0, 57)}...`;

  const check = (details: string, tail: string) => {
    expect(details.length, details).toBeLessThanOrEqual(220);
    expect(details, details).toMatch(/^[\x20-\x7e]+$/);
    expect(details.endsWith(tail), details).toBe(true);
  };

  it("the envelope discover answered, then the child exits (before: 237 characters)", async () => {
    const fake = unicodeChild({ probeMethod: "server/discover", toolReply: rejectTool, exitAfterProbe: true });
    const ctx = makeContext(fake, LONG_STATE);
    await runStdio(ctx);
    const details = outcome(ctx, "stdio-unicode").details;
    check(details, `${ENVELOPE_PROBE} was answered, but the server exited right after (server exited (code 3))`);
    // The tool's name gives way, not what it drew, the request or the conclusion.
    expect(details).toBe(
      `tools/call search_${"x".repeat(33)}... rejected the probe (JSON-RPC error -32602); ${ENVELOPE_PROBE} was answered, but the server exited right after (server exited (code 3))`,
    );
  });

  it("the envelope discover never answered (before: 233+ characters)", async () => {
    const fake = unicodeChild({ probeMethod: "server/discover", toolReply: rejectTool, onProbe: "silent" });
    const ctx = makeContext(fake, LONG_STATE, 2000);
    await runStdio(ctx);
    check(
      outcome(ctx, "stdio-unicode").details,
      `${ENVELOPE_PROBE} got no reply (stdio transport: request timed out after 2000ms (method=server/discover))`,
    );
  });

  it("the envelope discover answered, then the child stops answering", async () => {
    const fake = unicodeChild({ probeMethod: "server/discover", toolReply: rejectTool, afterProbe: "silent" });
    const ctx = makeContext(fake, LONG_STATE);
    await runStdio(ctx);
    check(outcome(ctx, "stdio-unicode").details, STOPPED(ENVELOPE_PROBE));
  });

  it("a PASS on the envelope after a long rejected-note (before: 254 characters)", async () => {
    const fake = unicodeChild({ probeMethod: "server/discover", toolReply: rejectTool });
    const ctx = makeContext(fake, LONG_STATE);
    await runStdio(ctx);
    const r = outcome(ctx, "stdio-unicode");
    expect(r.passed).toBe(true);
    check(r.details, `; ${ENVELOPE_PASS}`);
    expect(r.details).toBe(
      `tools/call search_${"x".repeat(10)}... rejected the probe (JSON-RPC error -32602); ${ENVELOPE_PASS}`,
    );
  });

  it("a tools/call reply that mangles the probe, from a long-named tool (before: 240+ characters)", async () => {
    const misdecoded = Buffer.from(PROBE, "utf8").toString("latin1");
    const fake = unicodeChild({
      probeMethod: "tools/call",
      toolReply: { result: { resultType: "complete", content: [{ type: "text", text: misdecoded.repeat(4) }] } },
    });
    const ctx = makeContext(fake, LONG_STATE);
    await runStdio(ctx);
    const r = outcome(ctx, "stdio-unicode");
    expect(r.passed).toBe(false);
    expect(r.details.length, r.details).toBeLessThanOrEqual(220);
    expect(r.details).toMatch(
      /^tools\/call search_x+\.\.\. mangled the CJK\/emoji probe: the reply carries the probe decoded as Latin-1 \(h\\u00c3\\u00a9llo\) \(got .*\)$/,
    );
  });

  it("'server unreachable' on the envelope keeps its reason (before: cut off the end at 220)", async () => {
    // The tools/call probe is rejected and the follow-up discover is
    // answered; the child exits right after that answer, so the envelope
    // probe finds it gone.
    let livenessAnswered = false;
    const fake = fakeStdio(
      (method) => {
        if (method === "server/discover") return { result: DISCOVER_RESULT };
        if (method === "tools/call") return rejectTool;
        return { error: { code: -32601, message: "Method not found" } };
      },
      (method, params) => {
        if (method !== "server/discover" || carriesProbe(params)) return false;
        const previous = fake.calls[fake.calls.length - 2];
        if (previous?.method === "tools/call" && !livenessAnswered) {
          livenessAnswered = true;
          return true;
        }
        return false;
      },
    );
    const ctx = makeContext(fake, LONG_STATE);
    await runStdio(ctx);
    const details = outcome(ctx, "stdio-unicode").details;
    check(
      details,
      `${ENVELOPE_PROBE} got no response (connection closed: stdio transport: server crashed with exit code 3 before completing the request)`,
    );
    expect(details.startsWith(`server unreachable: ${clipped.slice(0, 20)}`), details).toBe(true);
  });

  it("short names are untouched: the same details as before", async () => {
    const fake = unicodeChild({
      probeMethod: "server/discover",
      toolReply: rejectTool,
    });
    const ctx = makeContext(fake, {
      capabilities: { tools: {} },
      tools: [{ name: "get_time", inputSchema: { type: "object" } }],
      toolNames: ["get_time"],
    });
    await runStdio(ctx);
    expect(outcome(ctx, "stdio-unicode").details).toBe(
      `tools/call get_time rejected the probe (JSON-RPC error -32602); ${ENVELOPE_PASS}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Real children: the modern fixture with a preload, and a hand-rolled server
// ---------------------------------------------------------------------------

/**
 * Writes the first stdout line that carries non-ASCII (the echo of the
 * probe), then drops every later write while the process keeps running
 * and reading stdin: a server whose writer died on the line it just wrote.
 */
const WEDGE_AFTER_ECHO = [
  "const w = process.stdout.write.bind(process.stdout);",
  "let wedged = false;",
  "process.stdout.write = (chunk, enc, cb) => {",
  '  const done = typeof enc === "function" ? enc : cb;',
  "  if (wedged) { if (done) process.nextTick(done); return true; }",
  '  const s = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");',
  "  if (/[^\\x00-\\x7f]/.test(s)) wedged = true;",
  "  return w(chunk, enc, cb);",
  "};",
].join("\n");

function preloaded(server: string, preload?: string): TransportTarget {
  const args = preload ? ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, server] : [server];
  return { type: "stdio", command: process.execPath, args };
}

const stoppedWarnings = (report: ComplianceReport) => report.warnings.filter((w) => w.includes("stopped answering"));
const restartWarnings = (report: ComplianceReport) => report.warnings.filter((w) => w.includes("and was restarted"));

describe("2026-07-28 stdio-unicode over real children that stop answering after the probe", () => {
  it("the modern fixture, wedged after echoing the probe: FAIL within the short budget, not a full --timeout (before: PASS after 8 s)", async () => {
    const report = await runModern(preloaded(MODERN_FIXTURE, WEDGE_AFTER_ECHO), {
      only: ["stdio-framing", "stdio-unicode"],
      timeout: 8000,
    });
    expect(resultOf(report, "stdio-framing").passed).toBe(true);
    const unicode = resultOf(report, "stdio-unicode");
    expect(unicode.passed).toBe(false);
    expect(unicode.details).toBe(STOPPED(TOOL_PROBE));
    // Before: the follow-up discover waited the whole 8000 ms --timeout.
    expect(unicode.durationMs).toBeLessThan(6000);
    expect(stoppedWarnings(report)).toEqual([STOPPED_WARNING(TOOL_PROBE)]);
    expect(restartWarnings(report)).toEqual([]);
  }, 60_000);

  it("the same fixture without the preload: PASS, no warning, and no wait", async () => {
    const report = await runModern(preloaded(MODERN_FIXTURE), {
      only: ["stdio-framing", "stdio-unicode"],
      timeout: 8000,
    });
    const unicode = resultOf(report, "stdio-unicode");
    expect(unicode.details).toBe("tools/call echo reproduced the CJK/emoji probe byte-for-byte");
    expect(unicode.durationMs).toBeLessThan(LIVENESS_BUDGET_MS);
    expect(stoppedWarnings(report)).toEqual([]);
    expect(restartWarnings(report)).toEqual([]);
  }, 60_000);

  describe("a server with no tools (the envelope path)", () => {
    /**
     * Answers server/discover and -32601 otherwise; with WEDGE_AFTER set,
     * it answers the first line carrying non-ASCII and then answers
     * nothing more, still running until stdin closes.
     */
    const NO_TOOLS_SERVER = `
import { createInterface } from "node:readline";
let wedged = false;
const send = (o) => { if (!wedged) process.stdout.write(JSON.stringify(o) + "\\n"); };
const discover = {
  resultType: "complete",
  supportedVersions: [${JSON.stringify(MODERN_SPEC_VERSION)}],
  capabilities: {},
  serverInfo: { name: "no-tools-stdio", version: "1.0.0" },
  ttlMs: 1000,
  cacheScope: "public",
};
const rl = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
rl.on("line", (line) => {
  const probe = /[^\\x00-\\x7f]/.test(line);
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return;
  if (msg.method === "server/discover") send({ jsonrpc: "2.0", id: msg.id, result: discover });
  else send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
  if (probe && process.env.WEDGE_AFTER) wedged = true;
});
rl.on("close", () => process.exit(0));
`;
    let dir: string;
    let script: string;

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "mcp-r82-stdio-"));
      script = join(dir, "server.mjs");
      writeFileSync(script, NO_TOOLS_SERVER);
    });

    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("answered, then silent: FAIL naming the hang, with a warning (before: PASS 'envelope round-trip verified')", async () => {
      const report = await runModern(
        { type: "stdio", command: process.execPath, args: [script], env: { WEDGE_AFTER: "1" } },
        { only: ["stdio-framing", "stdio-unicode"], timeout: 8000 },
      );
      const unicode = resultOf(report, "stdio-unicode");
      expect(unicode.details).toBe(STOPPED(ENVELOPE_PROBE));
      expect(unicode.durationMs).toBeLessThan(6000);
      expect(stoppedWarnings(report)).toEqual([STOPPED_WARNING(ENVELOPE_PROBE)]);
    }, 60_000);

    it("the same server without the hang: PASS as before", async () => {
      const report = await runModern(
        { type: "stdio", command: process.execPath, args: [script], env: {} },
        { only: ["stdio-framing", "stdio-unicode", "stdio-unknown-method-recovers", "stdio-cancellation"] },
      );
      expect(report.tests.filter((t) => !t.passed).map((t) => `${t.id}: ${t.details}`)).toEqual([]);
      expect(resultOf(report, "stdio-unicode").details).toBe(ENVELOPE_PASS);
      expect(stoppedWarnings(report)).toEqual([]);
    }, 60_000);
  });
});
