import { describe, expect, it } from "vitest";
import { getTestDefinitionMap } from "../definitions/index.js";
import { createHarness } from "../harness.js";
import { createModernClient } from "../modern/client.js";
import { createRecorder } from "../recorder.js";
import { MODERN_SPEC_VERSION, specBaseFor } from "../spec.js";
import { createModernState, type ModernState, type ModernSuiteContext } from "../suites/modern/context.js";
import { runStdio } from "../suites/modern/stdio.js";
import type {
  JsonRpcId,
  MessageListener,
  Transport,
  TransportNotifyResult,
  TransportResponse,
  TransportStream,
} from "../transport/index.js";
import { createStdioTransport } from "../transport/stdio.js";
import { MODERN_FIXTURE, passedIds, runModern, startHttpFixture, stdioFixture } from "./helpers/modern-fixture.js";

/**
 * The four stdio-only tests of the 2026-07-28 suite.
 *
 * Three layers, because the fixture has a break knob for exactly one of
 * them (`unicode-broken`):
 *   1. the real suite over the real fixture (stdio passes; HTTP never
 *      runs them),
 *   2. `runStdio` over a real fixture process with the tools state
 *      hand-populated, so the tools/call branch of stdio-unicode is
 *      exercised without depending on the lifecycle/features modules,
 *   3. `runStdio` over an in-memory stdio transport scripted to
 *      misbehave in the ways the other three tests exist to catch
 *      (silent frames, a crash after an unknown method, a crash or a
 *      reply on notifications/cancelled) -- the red runs those checks
 *      would otherwise never have.
 */

const STDIO_IDS = ["stdio-framing", "stdio-unicode", "stdio-unknown-method-recovers", "stdio-cancellation"];
const ALL_PASS = Object.fromEntries(STDIO_IDS.map((id) => [id, "pass"]));
const TIMEOUT = 2000;

const EMPTY_STATE: ModernState = createModernState();

/** A suite context around any transport, the way runModernSuite builds one. */
function makeContext(transport: Transport, state: Partial<ModernState> = {}): ModernSuiteContext {
  const harness = createHarness({
    definitions: getTestDefinitionMap(MODERN_SPEC_VERSION),
    specBase: specBaseFor(MODERN_SPEC_VERSION),
    transportKind: transport.kind,
  });
  const recorder = createRecorder();
  transport.onMessage((m) => recorder.recordReceived(m));
  let id = 1000;
  const client = createModernClient({
    transport,
    recorder,
    nextId: () => id++,
    timeout: TIMEOUT,
    protocolVersion: MODERN_SPEC_VERSION,
    clientCapabilities: { elicitation: {} },
    clientInfo: { name: "mcp-compliance-test", version: "0.0.0" },
  });
  return {
    harness,
    client,
    recorder,
    transport,
    kind: transport.kind,
    timeout: TIMEOUT,
    startupTimeout: 5000,
    backendUrl: "",
    userHeaders: {},
    displayUrl: "stdio://modern-fixture",
    detection: undefined,
    hasAuth: false,
    state: { ...EMPTY_STATE, ...state },
  };
}

function outcome(ctx: ModernSuiteContext, id: string) {
  const r = ctx.harness.tests.find((t) => t.id === id);
  if (!r) throw new Error(`${id} did not run (ran: ${ctx.harness.tests.map((t) => t.id).join(", ")})`);
  return r;
}

/** The state the lifecycle + features modules leave behind on the fixture, minus everything stdio-unicode does not read. */
const TOOLS_STATE: Partial<ModernState> = {
  capabilities: { tools: {} },
  tools: [
    { name: "echo", inputSchema: { type: "object", properties: { message: { type: "string" } } } },
    { name: "add", inputSchema: { type: "object" } },
  ],
  toolNames: ["echo", "add"],
};

describe("2026-07-28 stdio tests: real suite over the fixture", () => {
  it("all four pass over stdio on the clean fixture", async () => {
    const report = await runModern(stdioFixture().target, { only: STDIO_IDS });
    expect(passedIds(report, STDIO_IDS)).toEqual(ALL_PASS);
    expect(report.tests.find((t) => t.id === "stdio-framing")?.details).toMatch(/5\/5 rapid discovers answered/);
    expect(report.tests.find((t) => t.id === "stdio-cancellation")?.details).toMatch(/drew no reply/);
  });

  it("never run over HTTP (catalog gates them to stdio)", async () => {
    const http = await startHttpFixture();
    try {
      const report = await runModern(http.url, { only: [...STDIO_IDS, "transport-no-server-requests"] });
      const ran = report.tests.map((t) => t.id);
      expect(ran).toContain("transport-no-server-requests");
      for (const id of STDIO_IDS) expect(ran).not.toContain(id);
    } finally {
      await http.stop();
    }
  });
});

describe("2026-07-28 stdio-unicode: tools/call branch over a real fixture process", () => {
  async function runWithTools(breaks: string[]) {
    const transport = createStdioTransport({
      command: process.execPath,
      args: [MODERN_FIXTURE],
      env: breaks.length ? { MODERN_FIXTURE_BREAK: breaks.join(",") } : undefined,
    });
    try {
      const ctx = makeContext(transport, TOOLS_STATE);
      await runStdio(ctx);
      return ctx;
    } finally {
      await transport.close();
    }
  }

  it("echo reproduces the probe byte-for-byte on the clean fixture (and the other three pass)", async () => {
    const ctx = await runWithTools([]);
    const unicode = outcome(ctx, "stdio-unicode");
    expect(unicode.passed, unicode.details).toBe(true);
    expect(unicode.details).toMatch(/tools\/call echo reproduced the CJK\/emoji probe byte-for-byte/);
    for (const id of STDIO_IDS) expect(outcome(ctx, id).passed, `${id}: ${outcome(ctx, id).details}`).toBe(true);
  });

  it("fetches tools/list itself when the capability is declared but no list is cached (--only shape)", async () => {
    const transport = createStdioTransport({ command: process.execPath, args: [MODERN_FIXTURE] });
    try {
      const ctx = makeContext(transport, { capabilities: { tools: {} } });
      await runStdio(ctx);
      const unicode = outcome(ctx, "stdio-unicode");
      expect(unicode.passed, unicode.details).toBe(true);
      // The tools/call branch ran (so the verdict does not depend on the features module having run first).
      expect(unicode.details).toMatch(/tools\/call echo reproduced the CJK\/emoji probe byte-for-byte/);
      expect(ctx.state.toolNames).toContain("echo");
    } finally {
      await transport.close();
    }
  });

  it("fails when the server strips non-ASCII (unicode-broken knob): the ASCII skeleton is evidence of mangling", async () => {
    const ctx = await runWithTools(["unicode-broken"]);
    const unicode = outcome(ctx, "stdio-unicode");
    expect(unicode.passed).toBe(false);
    expect(unicode.details).toMatch(
      /tools\/call echo mangled the CJK\/emoji probe: the reply carries the probe with its CJK\/emoji characters dropped \(got "hllo {2}"\)/,
    );
    // The knob only touches echo: the other three stay green.
    for (const id of STDIO_IDS.filter((i) => i !== "stdio-unicode")) {
      expect(outcome(ctx, id).passed, `${id}: ${outcome(ctx, id).details}`).toBe(true);
    }
  });
});

/**
 * An in-memory stdio transport whose behaviour is scripted per request.
 * `answer` decides what a request gets; `onNotify` what a notification
 * does. Messages the "server" writes spontaneously (a reply to a
 * notification) go through `emit`, exactly as a stdout line would.
 */
type Answer = "result" | "error" | "silent" | "crash";

interface FakeScript {
  answer: (method: string, id: JsonRpcId, n: number) => Answer;
  /** The `result` object for an answer of "result"; default: a minimal DiscoverResult. */
  result?: (method: string, params: unknown) => Record<string, unknown>;
  onNotify?: (method: string, fake: FakeStdio) => void;
}

interface FakeStdio extends Transport {
  exited: boolean;
  exitCode: number | null;
  /** Every request as sent: [method, params]. */
  calls: [string, unknown][];
  emit(message: unknown): void;
}

function fakeStdio(script: FakeScript): FakeStdio {
  const listeners = new Set<MessageListener>();
  let count = 0;
  const fake: FakeStdio = {
    kind: "stdio",
    exited: false,
    exitCode: null,
    calls: [],
    emit(message) {
      for (const l of listeners) l(message, {});
    },
    async request(method, params, nextId, init): Promise<TransportResponse> {
      const id = nextId();
      fake.calls.push([method, params]);
      if (fake.exited) throw new Error(`stdio transport: server crashed with exit code ${fake.exitCode}`);
      const answer = script.answer(method, id, count++);
      if (answer === "crash") {
        fake.exited = true;
        fake.exitCode = 1;
        throw new Error("server crashed with exit code 1 before completing the request");
      }
      if (answer === "silent") {
        await new Promise((r) => setTimeout(r, Math.min(init.timeout, 50)));
        throw new Error(`stdio transport: request timed out after ${init.timeout}ms (method=${method})`);
      }
      const body =
        answer === "error"
          ? { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } }
          : {
              jsonrpc: "2.0",
              id,
              result: script.result?.(method, params) ?? {
                resultType: "complete",
                supportedVersions: [MODERN_SPEC_VERSION],
              },
            };
      fake.emit(body);
      return { body, requestId: id };
    },
    async notify(method): Promise<TransportNotifyResult> {
      if (fake.exited) throw new Error("stdio transport: server crashed");
      script.onNotify?.(method, fake);
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

/** A well-behaved script: errors on unknown methods, answers everything else, ignores notifications. */
const conformant: FakeScript = {
  answer: (method) => (method === "server/discover" ? "result" : "error"),
};

describe("2026-07-28 stdio tests: scripted misbehaviour (no fixture knob exists for these)", () => {
  it("the conformant script passes all four (control)", async () => {
    const ctx = makeContext(fakeStdio(conformant));
    await runStdio(ctx);
    for (const id of STDIO_IDS) expect(outcome(ctx, id).passed, `${id}: ${outcome(ctx, id).details}`).toBe(true);
  });

  it("stdio-framing fails when two of the five rapid discovers are never answered", async () => {
    // The first five requests are the framing burst; drop the 2nd and 4th.
    const fake = fakeStdio({
      answer: (method, _id, n) => (n === 1 || n === 3 ? "silent" : conformant.answer(method, _id, n)),
    });
    const ctx = makeContext(fake);
    await runStdio(ctx);
    const framing = outcome(ctx, "stdio-framing");
    expect(framing.passed).toBe(false);
    expect(framing.details).toMatch(/2\/5 rapid discovers unanswered/);
    expect(framing.details).toMatch(/timed out/);
  });

  it("stdio-unknown-method-recovers fails when the unknown method draws a result", async () => {
    const ctx = makeContext(fakeStdio({ answer: () => "result" }));
    await runStdio(ctx);
    const r = outcome(ctx, "stdio-unknown-method-recovers");
    expect(r.passed).toBe(false);
    expect(r.details).toMatch(/answered with a result instead of a JSON-RPC error/);
  });

  it("stdio-unknown-method-recovers fails when the server exits after the unknown method", async () => {
    let sawBogus = false;
    const fake = fakeStdio({
      answer: (method) => {
        if (method !== "server/discover") {
          sawBogus = true;
          return "error";
        }
        return sawBogus ? "crash" : "result";
      },
    });
    const ctx = makeContext(fake);
    await runStdio(ctx);
    const r = outcome(ctx, "stdio-unknown-method-recovers");
    expect(r.passed).toBe(false);
    expect(r.details).toMatch(/server\/discover afterwards got no reply \(server exited \(code 1\)\)/);
  });

  it("stdio-cancellation fails when notifications/cancelled crashes the server", async () => {
    const fake = fakeStdio({
      ...conformant,
      onNotify: (method, f) => {
        if (method === "notifications/cancelled") {
          f.exited = true;
          f.exitCode = 2;
        }
      },
    });
    const ctx = makeContext(fake);
    await runStdio(ctx);
    const r = outcome(ctx, "stdio-cancellation");
    expect(r.passed).toBe(false);
    expect(r.details).toMatch(/got no reply \(server exited \(code 2\)\)/);
  });

  /** The clock-server shape from the review: one no-arg tool that answers "12:00" whatever it is sent. */
  const CLOCK_TOOLS: Record<string, unknown>[] = [
    { name: "get_time", inputSchema: { type: "object", properties: {}, additionalProperties: true } },
  ];

  /**
   * stdio-unicode on servers whose tools do not echo their input, or
   * whose echo mangles it. The fake answers server/discover with a
   * DiscoverResult and tools/call with a scripted text; ctx.state carries
   * the tools list so no tools/list round-trip is needed.
   */
  function unicodeFake(text: string, tools: Record<string, unknown>[] = CLOCK_TOOLS) {
    const fake = fakeStdio({
      answer: (method) => (method === "server/discover" || method === "tools/call" ? "result" : "error"),
      result: (method) =>
        method === "tools/call"
          ? { resultType: "complete", content: [{ type: "text", text }] }
          : { resultType: "complete", supportedVersions: [MODERN_SPEC_VERSION] },
    });
    const ctx = makeContext(fake, {
      capabilities: { tools: {} },
      tools,
      toolNames: tools.map((t) => t.name as string),
    });
    return { fake, ctx };
  }

  it("stdio-unicode passes on a conformant server whose only tool does not echo its input (clock-server shape)", async () => {
    const { fake, ctx } = unicodeFake("12:00");
    await runStdio(ctx);
    const r = outcome(ctx, "stdio-unicode");
    expect(r.passed, r.details).toBe(true);
    expect(r.details).toMatch(
      /^tools\/call get_time did not echo the probe; envelope round-trip verified: server\/discover accepted a request whose clientInfo name carries CJK\/emoji/,
    );
    // The tool WAS called (with the probe under every candidate name, since the schema names none).
    const call = fake.calls.find(([m]) => m === "tools/call") as [string, { arguments: Record<string, string> }];
    expect(call).toBeDefined();
    expect(Object.keys(call[1].arguments).sort()).toEqual(["input", "message", "query", "text"]);
  });

  it("stdio-unicode prefers a tool with a string message/text/input/query property over the first tool", async () => {
    const tools: Record<string, unknown>[] = [
      ...CLOCK_TOOLS,
      {
        name: "search",
        inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer" } } },
      },
    ];
    const { fake, ctx } = unicodeFake("no results for héllo 世界 🚀", tools);
    await runStdio(ctx);
    const r = outcome(ctx, "stdio-unicode");
    expect(r.passed, r.details).toBe(true);
    expect(r.details).toMatch(/^tools\/call search reproduced the CJK\/emoji probe byte-for-byte/);
    const call = fake.calls.find(([m]) => m === "tools/call") as [string, { name: string; arguments: unknown }];
    expect(call[1].name).toBe("search");
    // Only the declared echo argument is sent, so a strict schema does not reject the probe.
    expect(call[1].arguments).toEqual({ query: "héllo 世界 🚀" });
  });

  it.each([
    [
      "U+FFFD replacement characters",
      "h\uFFFDllo \uFFFD\uFFFD \uFFFD",
      /the reply carries U\+FFFD replacement characters/,
    ],
    [
      "a Latin-1 mis-decode",
      Buffer.from("héllo 世界 🚀", "utf8").toString("latin1"),
      /the reply carries the probe decoded as Latin-1 \(h\\u00c3\\u00a9llo\)/,
    ],
    [
      "the non-ASCII characters stripped",
      "hllo  ",
      /the reply carries the probe with its CJK\/emoji characters dropped/,
    ],
    ["only the Latin-1 word surviving", "héllo", /the reply carries the probe with its CJK\/emoji characters dropped/],
  ])("stdio-unicode fails on evidence of mangling: %s", async (_label, text, pattern) => {
    const { ctx } = unicodeFake(text);
    await runStdio(ctx);
    const r = outcome(ctx, "stdio-unicode");
    expect(r.passed).toBe(false);
    expect(r.details).toMatch(/^tools\/call get_time mangled the CJK\/emoji probe: /);
    expect(r.details).toMatch(pattern);
  });

  it("stdio-cancellation fails when the server answers the notification", async () => {
    const fake = fakeStdio({
      ...conformant,
      onNotify: (method, f) => {
        if (method === "notifications/cancelled") {
          f.emit({ jsonrpc: "2.0", id: null, error: { code: -32602, message: "unknown request 987654321" } });
        }
      },
    });
    const ctx = makeContext(fake);
    await runStdio(ctx);
    const r = outcome(ctx, "stdio-cancellation");
    expect(r.passed).toBe(false);
    expect(r.details).toMatch(/server replied to notifications\/cancelled with JSON-RPC error -32602 \(id null\)/);
    // The other three are untouched by the notification script.
    for (const id of STDIO_IDS.filter((i) => i !== "stdio-cancellation")) {
      expect(outcome(ctx, id).passed, `${id}: ${outcome(ctx, id).details}`).toBe(true);
    }
  });
});
