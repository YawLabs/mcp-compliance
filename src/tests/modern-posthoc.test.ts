import { rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getTestDefinitionMap } from "../definitions/index.js";
import { createHarness } from "../harness.js";
import { createModernClient, type ModernClient } from "../modern/client.js";
import { createRecorder, type Recorder } from "../recorder.js";
import { MODERN_SPEC_VERSION, specBaseFor } from "../spec.js";
import { createModernState, type ModernState, type ModernSuiteContext } from "../suites/modern/context.js";
import { POSTHOC_IDS, runPostHoc } from "../suites/modern/posthoc.js";
import { createHttpTransport } from "../transport/http.js";
import type { Transport, TransportKind } from "../transport/index.js";
import { createStdioTransport } from "../transport/stdio.js";
import type { TestResult } from "../types.js";
import { MODERN_FIXTURE, passedIds, runModern, startHttpFixture, stdioFixture } from "./helpers/modern-fixture.js";

/**
 * The eight post-hoc (recorder-scanning) tests of the 2026-07-28 suite.
 *
 * Positive runs go through the real suite. The negative runs cannot: a
 * post-hoc check only sees what the other modules put on the wire, and
 * the fixture tools that trigger each violation (progress, logger,
 * needs_input, fail) are called by modules this file must not depend
 * on. So each knob run builds the suite context by hand around a real
 * fixture process, issues the one call that provokes the violation, and
 * then runs `runPostHoc` over the recording -- the recorder, client and
 * transport are the production ones, only the trigger is scripted.
 *
 * Shapes the fixture cannot produce (a gateway's non-JSON-RPC 401 body,
 * a null-id -32600 at HTTP 200, a reply to a client notification that
 * arrives after the next request went out, a null-id reply to one of
 * three overlapping requests) come from a node:http stub, a scripted
 * stdio child, or a hand-scripted recorder, scanned by the same
 * `runPostHoc`.
 */

const ALL_PASS = Object.fromEntries(POSTHOC_IDS.map((id) => [id, "pass"]));
/**
 * Generous: the first call on a stdio scan lands on a cold process, and
 * under a parallel vitest run a spawn can take well over a second. A
 * trigger that times out is swallowed by `fire`, and the check under
 * test then passes vacuously -- a false red for this file, not the suite.
 */
const TIMEOUT = 8000;
/** For the one trigger that is EXPECTED never to resolve (a null-id reply on stdio). */
const SHORT_TIMEOUT = 1500;

const EMPTY_STATE: ModernState = createModernState();

interface ContextOptions {
  clientCapabilities?: Record<string, unknown>;
  state?: Partial<ModernState>;
  /** The run-wide `--retries`, which the post-hoc checks must not honour. */
  retries?: number;
}

function makeContext(transport: Transport, opts: ContextOptions = {}): ModernSuiteContext {
  const harness = createHarness({
    definitions: getTestDefinitionMap(MODERN_SPEC_VERSION),
    specBase: specBaseFor(MODERN_SPEC_VERSION),
    transportKind: transport.kind,
    retries: opts.retries,
  });
  const recorder = createRecorder();
  transport.onMessage((m, meta) => recorder.recordReceived(m, meta));
  let id = 1000;
  const client = createModernClient({
    transport,
    recorder,
    nextId: () => id++,
    timeout: TIMEOUT,
    protocolVersion: MODERN_SPEC_VERSION,
    clientCapabilities: opts.clientCapabilities ?? { elicitation: {} },
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
    displayUrl: transport.kind === "http" ? "http://fixture" : "stdio://modern-fixture",
    detection: undefined,
    hasAuth: false,
    state: { ...EMPTY_STATE, ...opts.state },
  };
}

type Kind = "stdio" | "http";

/**
 * The eight results keyed by id. Every scan in this file runs
 * `runPostHoc` alone, so the harness must hold exactly POSTHOC_IDS in
 * order: an id in the table without a check, or a check outside the
 * table, shows up here on both the empty and the populated path.
 */
function collect(ctx: ModernSuiteContext): Record<string, TestResult> {
  expect(ctx.harness.tests.map((r) => r.id)).toEqual([...POSTHOC_IDS]);
  const out: Record<string, TestResult> = {};
  for (const r of ctx.harness.tests) out[r.id] = r;
  return out;
}

/**
 * Spawn the fixture with `breaks`, let `trigger` put traffic on the
 * wire through the production client, then scan it. Returns the eight
 * results keyed by id.
 */
async function scanAfter(
  kind: Kind,
  breaks: string[],
  trigger: (client: ModernClient) => Promise<void>,
): Promise<Record<string, TestResult>> {
  const env = breaks.length ? { MODERN_FIXTURE_BREAK: breaks.join(",") } : undefined;
  let transport: Transport;
  let stop: () => Promise<void>;
  if (kind === "stdio") {
    const t = createStdioTransport({ command: process.execPath, args: [MODERN_FIXTURE], env });
    transport = t;
    stop = () => t.close();
  } else {
    const http = await startHttpFixture({ breaks });
    transport = createHttpTransport({ url: http.url });
    stop = () => http.stop();
  }
  try {
    const ctx = makeContext(transport);
    await trigger(ctx.client);
    await runPostHoc(ctx);
    return collect(ctx);
  } finally {
    await stop();
  }
}

/** A tolerant rpc: the trigger only needs the bytes on the wire, not a resolved response. */
async function fire(client: ModernClient, method: string, params?: unknown, opts?: Parameters<ModernClient["rpc"]>[2]) {
  await client.rpc(method, params, opts).catch(() => undefined);
}

/** Every trigger the knob runs use, on one server: proves the calls themselves are clean. */
async function allTriggers(client: ModernClient) {
  await fire(client, "server/discover");
  await fire(client, "tools/list");
  await fire(client, "tools/call", { name: "progress", arguments: {}, _meta: { progressToken: "p-1" } });
  await fire(client, "tools/call", { name: "logger", arguments: {} });
  await fire(client, "tools/call", { name: "needs_input", arguments: {} });
  await fire(client, "tools/call", { name: "fail", arguments: {} });
  await fire(client, "tools/call", { name: "no_such_tool", arguments: {} });
  await fire(client, "resources/read", { uri: "test://does-not-exist" });
  await fire(client, "bogus/method");
}

function expectPassed(results: Record<string, TestResult>, ids: readonly string[]) {
  for (const id of ids) {
    const r = results[id] as TestResult;
    expect(r.passed, `${id}: ${r.details}`).toBe(true);
  }
}

/**
 * A transport nothing talks to: for scans over a hand-scripted recorder
 * (the post-hoc checks never touch the transport, only `kind`).
 */
function inertTransport(kind: TransportKind): Transport {
  const refuse = async () => {
    throw new Error("inert transport");
  };
  return {
    kind,
    request: refuse,
    notify: refuse,
    stream: refuse,
    onMessage: () => () => {},
    close: async () => {},
    setSessionId() {},
    setProtocolVersion() {},
    getSessionId: () => null,
    getProtocolVersion: () => null,
  };
}

/** Build a context over `kind`, script its recorder, scan it. */
async function scanRecording(
  kind: Kind,
  script: (recorder: Recorder) => void,
  opts: ContextOptions = {},
): Promise<{ results: Record<string, TestResult>; warnings: string[] }> {
  const ctx = makeContext(inertTransport(kind), opts);
  script(ctx.recorder);
  await runPostHoc(ctx);
  return { results: collect(ctx), warnings: ctx.harness.warnings };
}

/** A minimal node:http MCP endpoint whose every POST is answered by `handler`. */
async function stubHttp(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void,
): Promise<{ url: string; stop: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => handler(req, res, body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function scanStub(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void,
  trigger: (client: ModernClient) => Promise<void>,
): Promise<{ results: Record<string, TestResult>; warnings: string[] }> {
  const stub = await stubHttp(handler);
  try {
    const ctx = makeContext(createHttpTransport({ url: stub.url }));
    await trigger(ctx.client);
    await runPostHoc(ctx);
    return { results: collect(ctx), warnings: ctx.harness.warnings };
  } finally {
    await stub.stop();
  }
}

const DISCOVER_RESULT = {
  resultType: "complete",
  supportedVersions: [MODERN_SPEC_VERSION],
  capabilities: {},
  ttlMs: 1000,
  cacheScope: "public",
};

describe("2026-07-28 post-hoc tests: the real suite over the clean fixture", () => {
  it("all eight pass over stdio (full suite, no --only)", async () => {
    const report = await runModern(stdioFixture().target);
    expect(passedIds(report, [...POSTHOC_IDS])).toEqual(ALL_PASS);
  });

  it("all eight pass over HTTP (full suite, no --only)", async () => {
    const http = await startHttpFixture();
    try {
      const report = await runModern(http.url);
      expect(passedIds(report, [...POSTHOC_IDS])).toEqual(ALL_PASS);
    } finally {
      await http.stop();
    }
  });

  it("all eight pass with a note when nothing else ran (--only the post-hoc ids)", async () => {
    const report = await runModern(stdioFixture().target, { only: [...POSTHOC_IDS] });
    expect(passedIds(report, [...POSTHOC_IDS])).toEqual(ALL_PASS);
    // The lifecycle module's setup discover (outside any check) is the
    // only traffic, so every note names a count of 0 or 1.
    const details = Object.fromEntries(report.tests.map((t) => [t.id, t.details]));
    expect(details["transport-no-server-requests"]).toMatch(
      /^[01] server messages? scanned; none is a server-to-client request/,
    );
    expect(details["lifecycle-log-level-gating"]).toMatch(/no notifications\/message, 0 requests set logLevel/);
    expect(details["error-id-echo"]).toMatch(/^no error responses to id-bearing requests recorded/);
    expect(details["error-retired-codes"]).toMatch(/^0 error responses scanned/);
    expect(details["schema-result-type"]).toMatch(
      /^(no results recorded|1 result scanned; every resultType is complete or input_required)/,
    );
    expect(details["schema-no-input-required-on-lists"]).toMatch(
      /^[01] results? scanned; no input_required result observed/,
    );
    expect(details["schema-input-required-shape"]).toMatch(/^no input_required results observed/);
    expect(details["schema-wire-valid"]).toMatch(
      /^(no server messages to validate|1 server message validated against the 2026-07-28 schema; no violations)/,
    );
  });
});

describe("2026-07-28 post-hoc tests: hand-driven traffic over the clean fixture (control)", () => {
  it.each<Kind>(["stdio", "http"])("every trigger is clean on %s: all eight pass", async (kind) => {
    const results = await scanAfter(kind, [], allTriggers);
    expectPassed(results, POSTHOC_IDS);
    // The scan saw real traffic, not an empty recorder.
    expect(results["schema-result-type"]?.details).toMatch(/^[1-9]\d* results scanned/);
    expect(results["schema-input-required-shape"]?.details).toMatch(/1 input_required result observed/);
    expect(results["error-id-echo"]?.details).toMatch(/^[1-9]\d* error responses scanned/);
    expect(results["schema-wire-valid"]?.details).toMatch(
      /^[1-9]\d* server messages validated against the 2026-07-28 schema; no violations/,
    );
  });
});

describe("2026-07-28 post-hoc tests: each check goes red under its fixture knob", () => {
  it.each<Kind>([
    "stdio",
    "http",
  ])("server-request-on-stream: transport-no-server-requests fails on %s", async (kind) => {
    const results = await scanAfter(kind, ["server-request-on-stream"], (client) =>
      fire(client, "tools/call", { name: "progress", arguments: {}, _meta: { progressToken: "p-1" } }),
    );
    const r = results["transport-no-server-requests"] as TestResult;
    expect(r.passed).toBe(false);
    expect(r.details).toMatch(
      /server sent 1 JSON-RPC request on a response stream; first: roots\/list \(id "srv-1"\) during tools\/call/,
    );
    expectPassed(
      results,
      POSTHOC_IDS.filter((id) => id !== "transport-no-server-requests"),
    );
  });

  it.each<Kind>(["stdio", "http"])("log-without-level: lifecycle-log-level-gating fails on %s", async (kind) => {
    const results = await scanAfter(kind, ["log-without-level"], (client) =>
      fire(client, "tools/call", { name: "logger", arguments: {} }),
    );
    const r = results["lifecycle-log-level-gating"] as TestResult;
    expect(r.passed).toBe(false);
    expect(r.details).toMatch(/1 notifications\/message \(level "info"\) on tools\/call without _meta logLevel/);
    expectPassed(
      results,
      POSTHOC_IDS.filter((id) => id !== "lifecycle-log-level-gating"),
    );
  });

  it.each<Kind>(["stdio", "http"])("no-id-echo: error-id-echo fails on %s", async (kind) => {
    // On stdio the null-id reply never resolves the request (it times
    // out) but the line is still recorded; on HTTP it is the body. The
    // discover first warms the process up so the short timeout on the
    // bogus call measures the reply, not the spawn.
    const results = await scanAfter(kind, ["no-id-echo"], async (client) => {
      await fire(client, "server/discover");
      await fire(client, "bogus/method", undefined, { timeout: SHORT_TIMEOUT });
    });
    const r = results["error-id-echo"] as TestResult;
    expect(r.passed).toBe(false);
    expect(r.details).toMatch(
      /1 of 1 error response did not echo the request id; first: bogus\/method sent id 1001, reply carried null/,
    );
    // null is modelled as an omitted id, which the schema allows, so the wire check stays green.
    expectPassed(
      results,
      POSTHOC_IDS.filter((id) => id !== "error-id-echo"),
    );
  });

  it("retired-codes: error-retired-codes fails (stdio)", async () => {
    const results = await scanAfter("stdio", ["retired-codes"], (client) =>
      fire(client, "tools/call", { name: "fail", arguments: {} }),
    );
    const r = results["error-retired-codes"] as TestResult;
    expect(r.passed).toBe(false);
    expect(r.details).toMatch(
      /1 of 1 error response use a retired code; first: -32042 \(URL elicitation required.*\) on tools\/call/,
    );
    expectPassed(
      results,
      POSTHOC_IDS.filter((id) => id !== "error-retired-codes"),
    );
  });

  it("no-result-type: schema-result-type and schema-wire-valid fail (http)", async () => {
    const results = await scanAfter("http", ["no-result-type"], async (client) => {
      await fire(client, "server/discover");
      await fire(client, "tools/list");
    });
    const rt = results["schema-result-type"] as TestResult;
    expect(rt.passed).toBe(false);
    expect(rt.details).toMatch(
      /2 of 2 results lack a valid resultType; first: server\/discover \(resultType undefined\)/,
    );
    const wire = results["schema-wire-valid"] as TestResult;
    expect(wire.passed).toBe(false);
    expect(wire.details).toMatch(
      /2 of 2 server messages violate the 2026-07-28 schema \(2 distinct violations\): server\/discover: DiscoverResult at \/result: must have required property 'resultType'/,
    );
    expectPassed(
      results,
      POSTHOC_IDS.filter((id) => id !== "schema-result-type" && id !== "schema-wire-valid"),
    );
  });

  it("input-required-on-list: schema-no-input-required-on-lists fails (stdio)", async () => {
    const results = await scanAfter("stdio", ["input-required-on-list"], (client) => fire(client, "tools/list"));
    const r = results["schema-no-input-required-on-lists"] as TestResult;
    expect(r.passed).toBe(false);
    expect(r.details).toMatch(
      /input_required returned for tools\/list, which is not an MRTR method \(1 of 1 input_required result\)/,
    );
    // The list result has neither inputRequests nor requestState, so the shape check is red too (as it should be).
    expect(results["schema-input-required-shape"]?.passed).toBe(false);
    expectPassed(results, [
      "transport-no-server-requests",
      "lifecycle-log-level-gating",
      "error-id-echo",
      "error-retired-codes",
    ]);
  });

  it("input-required-empty: schema-input-required-shape fails (http)", async () => {
    const results = await scanAfter("http", ["input-required-empty"], (client) =>
      fire(client, "tools/call", { name: "needs_input", arguments: {} }),
    );
    const r = results["schema-input-required-shape"] as TestResult;
    expect(r.passed).toBe(false);
    expect(r.details).toMatch(
      /1 of 1 input_required result violates the MRTR server requirements; first \(tools\/call\): neither inputRequests nor requestState present/,
    );
    // tools/call is an MRTR method, so the placement check is unaffected.
    expectPassed(results, ["schema-no-input-required-on-lists", "schema-result-type", "error-id-echo"]);
  });

  it("input-request-bad-method: schema-input-required-shape fails (stdio)", async () => {
    const results = await scanAfter("stdio", ["input-request-bad-method"], (client) =>
      fire(client, "tools/call", { name: "needs_input", arguments: {} }),
    );
    const r = results["schema-input-required-shape"] as TestResult;
    expect(r.passed).toBe(false);
    expect(r.details).toMatch(
      /first \(tools\/call\): inputRequests\.user_name\.method "foo\/bar" is not one of elicitation\/create, sampling\/createMessage, roots\/list/,
    );
    expectPassed(results, ["schema-no-input-required-on-lists", "schema-result-type", "error-id-echo"]);
  });

  it("ignore-client-capabilities: schema-input-required-shape fails when the server requests an undeclared capability", async () => {
    // The suite declares only `elicitation`; under the knob needs_sampling
    // skips its -32021 gate and returns a sampling/createMessage input
    // request the client never said it could serve (mrtr server req. 6).
    const results = await scanAfter("http", ["ignore-client-capabilities"], (client) =>
      fire(client, "tools/call", { name: "needs_sampling", arguments: {} }),
    );
    const r = results["schema-input-required-shape"] as TestResult;
    expect(r.passed).toBe(false);
    expect(r.details).toMatch(
      /1 of 1 input_required result violates the MRTR server requirements; first \(tools\/call\): server requested sampling\/createMessage although the client declared only elicitation/,
    );
    // The result is otherwise well-formed: placement, resultType and the wire schema are all green.
    expectPassed(results, ["schema-no-input-required-on-lists", "schema-result-type", "schema-wire-valid"]);
  });

  it("no-caching: schema-wire-valid groups repeated violations and overflows distinct ones to a warning (http)", async () => {
    // Not one of the eight's own knobs; it shows the wire check does more
    // than repeat schema-result-type, that identical violations collapse
    // into one "xN" entry, and that the distinct ones beyond the inline
    // three go to a warning. Combined with no-result-type every result is
    // wrong, so each of the nine methods called forms its own group.
    const http = await startHttpFixture({ breaks: ["no-caching", "no-result-type"] });
    const transport = createHttpTransport({ url: http.url });
    try {
      const ctx = makeContext(transport);
      for (let i = 0; i < 3; i++) await fire(ctx.client, "server/discover");
      await fire(ctx.client, "tools/list");
      await fire(ctx.client, "tools/call", { name: "echo", arguments: { message: "hi" } });
      await fire(ctx.client, "prompts/list");
      await fire(ctx.client, "prompts/get", { name: "simple" });
      await fire(ctx.client, "resources/list");
      await fire(ctx.client, "resources/read", { uri: "test://static-text" });
      await fire(ctx.client, "resources/templates/list");
      await fire(ctx.client, "completion/complete", {
        ref: { type: "ref/prompt", name: "greet" },
        argument: { name: "name", value: "A" },
      });
      await runPostHoc(ctx);
      const wire = ctx.harness.tests.find((t) => t.id === "schema-wire-valid") as TestResult;
      expect(wire.passed).toBe(false);
      // Eleven messages, nine distinct (method, first error) groups; the three discovers collapse into one.
      expect(wire.details).toMatch(
        /^11 of 11 server messages violate the 2026-07-28 schema \(9 distinct violations\): server\/discover x3: DiscoverResult at \/result: must have required property '\w+' \(\+\d more\) \| tools\/list: /,
      );
      expect(wire.details.split(" | ")).toHaveLength(3);
      expect(wire.details).not.toMatch(/server\/discover.*server\/discover/);
      // Five more groups in the warning, one beyond it; the message count is what is left after the inline groups.
      const warning = ctx.harness.warnings.find((w) => w.startsWith("schema-wire-valid: 6 more message(s)"));
      expect(warning, ctx.harness.warnings.join("\n")).toBeDefined();
      expect(warning?.split(" | ")).toHaveLength(5);
      expect(warning).toMatch(/\(and 1 more distinct violation\(s\)\)$/);
      expect(warning).toMatch(/prompts\/get: /);
      expect(ctx.harness.tests.find((t) => t.id === "schema-result-type")?.passed).toBe(false);
    } finally {
      await http.stop();
    }
  });
});

describe("2026-07-28 post-hoc tests: error-id-echo and schema-wire-valid on transport-level rejections", () => {
  /** Whatever the request, answer 401 with the body an SDK bearer-auth middleware or an API gateway writes. */
  const unauthorized = (_req: IncomingMessage, res: ServerResponse) =>
    sendJson(
      res,
      401,
      { error: "invalid_token", error_description: "The access token expired" },
      {
        "WWW-Authenticate": 'Bearer resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource"',
      },
    );

  it("a non-JSON-RPC 401 body is not an id-echo offender and not a schema violation (noted once)", async () => {
    const { results } = await scanStub(unauthorized, async (client) => {
      await fire(client, "server/discover");
      await fire(client, "tools/list");
    });
    const echo = results["error-id-echo"] as TestResult;
    expect(echo.passed, echo.details).toBe(true);
    expect(echo.details).toBe(
      "no error responses to id-bearing requests recorded (exempt: 2 non-JSON-RPC error bodies not counted)",
    );
    const wire = results["schema-wire-valid"] as TestResult;
    expect(wire.passed, wire.details).toBe(true);
    expect(wire.details).toBe(
      "no server messages to validate (2 non-JSON-RPC bodies on HTTP error responses not validated (HTTP 401 x2))",
    );
    expectPassed(results, [...POSTHOC_IDS]);
  });

  it("a JSON-RPC null-id error on a 401/403 is exempt from error-id-echo (the id was never read)", async () => {
    const guard = (_req: IncomingMessage, res: ServerResponse) =>
      sendJson(res, 403, { jsonrpc: "2.0", id: null, error: { code: -32000, message: "Forbidden: bad origin" } });
    const { results } = await scanStub(guard, (client) => fire(client, "server/discover"));
    const echo = results["error-id-echo"] as TestResult;
    expect(echo.passed, echo.details).toBe(true);
    expect(echo.details).toBe(
      "no error responses to id-bearing requests recorded (exempt: 1 without an id on transport-level rejections (HTTP 401/403/413/415/429))",
    );
    expectPassed(results, [...POSTHOC_IDS]);
  });

  it("a 429 JSON-RPC error whose id is present but retyped is an offender: the exemption covers absent ids only", async () => {
    // The id was read (it is there, as a string) and then retyped; that is
    // the id-echo violation, whatever the status. Before this the whole
    // reply was exempt as a transport-level rejection.
    const { results } = await scanRecording("http", (recorder) => {
      recorder.recordSent({ id: 1000, method: "server/discover", params: {}, meta: undefined });
      recorder.recordReceived(
        { jsonrpc: "2.0", id: "1000", error: { code: -32000, message: "Too Many Requests" } },
        { statusCode: 429 },
      );
    });
    const echo = results["error-id-echo"] as TestResult;
    expect(echo.passed).toBe(false);
    expect(echo.details).toBe(
      '1 of 1 error response did not echo the request id; first: server/discover sent id 1000, reply carried "1000"',
    );
  });

  it("a JSON-RPC null-id error at HTTP 400 answering a well-formed request is NOT exempt (400 is an intermediary status, not an auth gate's)", async () => {
    const { results } = await scanRecording("http", (recorder) => {
      recorder.recordSent({ id: 1000, method: "server/discover", params: {}, meta: undefined });
      recorder.recordReceived(
        { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } },
        { statusCode: 400 },
      );
    });
    const echo = results["error-id-echo"] as TestResult;
    expect(echo.passed).toBe(false);
    expect(echo.details).toBe(
      "1 of 1 error response did not echo the request id; first: server/discover sent id 1000, reply carried null",
    );
  });

  it("a null-id -32600 at HTTP 200 answering a well-formed request FAILS error-id-echo (the code exempts nothing)", async () => {
    const strict = (_req: IncomingMessage, res: ServerResponse) =>
      sendJson(res, 200, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid Request: _meta missing" },
      });
    const { results } = await scanStub(strict, (client) => fire(client, "server/discover", {}, { meta: false }));
    const echo = results["error-id-echo"] as TestResult;
    expect(echo.passed).toBe(false);
    expect(echo.details).toBe(
      "1 of 1 error response did not echo the request id; first: server/discover sent id 1000, reply carried null",
    );
  });

  it.each([
    -32700, -32600,
  ])("a null-id %d on stdio answering a well-formed request FAILS error-id-echo", async (code) => {
    const { results } = await scanRecording("stdio", (recorder) => {
      recorder.recordSent({ id: 1000, method: "server/discover", params: {}, meta: undefined });
      recorder.recordReceived({ jsonrpc: "2.0", id: null, error: { code, message: "cannot read" } });
    });
    const echo = results["error-id-echo"] as TestResult;
    expect(echo.passed).toBe(false);
    expect(echo.details).toBe(
      "1 of 1 error response did not echo the request id; first: server/discover sent id 1000, reply carried null",
    );
    // A null id is modelled as omitted, which the schema allows: the wire check does not double-report it.
    expect(results["schema-wire-valid"]?.passed, results["schema-wire-valid"]?.details).toBe(true);
  });

  it("a null-id error answering a raw probe stays exempt", async () => {
    const { results } = await scanRecording("http", (recorder) => {
      recorder.recordSent({ id: undefined, method: "", params: undefined, meta: undefined, raw: "{not json" });
      recorder.recordReceived(
        { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
        { statusCode: 400 },
      );
    });
    const echo = results["error-id-echo"] as TestResult;
    expect(echo.passed, echo.details).toBe(true);
    expect(echo.details).toBe(
      "no error responses to id-bearing requests recorded (exempt: 1 answering raw probes or client notifications)",
    );
  });

  it("intermediary bodies on a 400 or 5xx are noted, not schema violations, and a GCP-style {error:{code}} is not a JSON-RPC error", async () => {
    // streamable-http#server-validation: an intermediary MUST answer a
    // header-validation failure with an HTTP error such as 400 but need
    // not produce a JSON-RPC error; a gateway's 502 body is whatever the
    // gateway writes. The suite sends header-mutated requests through
    // rpc(), so these land on id-bearing requests.
    const { results } = await scanRecording("http", (recorder) => {
      recorder.recordSent({ id: 1000, method: "server/discover", params: {}, meta: undefined });
      recorder.recordReceived({ error: "Bad Request" }, { statusCode: 400 });
      recorder.recordSent({ id: 1001, method: "server/discover", params: {}, meta: undefined });
      recorder.recordReceived({ message: "Bad Gateway" }, { statusCode: 502 });
      recorder.recordSent({ id: 1002, method: "tools/list", params: {}, meta: undefined });
      recorder.recordReceived(
        { error: { code: 400, message: "Missing required header", status: "INVALID_ARGUMENT" } },
        { statusCode: 400 },
      );
    });
    const wire = results["schema-wire-valid"] as TestResult;
    expect(wire.passed, wire.details).toBe(true);
    expect(wire.details).toBe(
      "no server messages to validate (3 non-JSON-RPC bodies on HTTP error responses not validated (HTTP 400 x2, HTTP 502 x1))",
    );
    const echo = results["error-id-echo"] as TestResult;
    expect(echo.passed, echo.details).toBe(true);
    expect(echo.details).toBe(
      "no error responses to id-bearing requests recorded (exempt: 2 non-JSON-RPC error bodies not counted)",
    );
    expectPassed(results, [...POSTHOC_IDS]);
  });

  it("a non-JSON-RPC body at HTTP 200 is the server's own answer and still fails schema-wire-valid", async () => {
    const { results } = await scanRecording("http", (recorder) => {
      recorder.recordSent({ id: 1000, method: "server/discover", params: {}, meta: undefined });
      recorder.recordReceived({ ok: true }, { statusCode: 200 });
    });
    const wire = results["schema-wire-valid"] as TestResult;
    expect(wire.passed).toBe(false);
    expect(wire.details).toMatch(/^1 of 1 server message violate the 2026-07-28 schema/);
  });
});

describe("2026-07-28 post-hoc tests: timeline attribution of a reply to a client notification", () => {
  /**
   * stdio-cancellation writes notifications/cancelled and, without
   * waiting (a notification has no reply), server/discover. A server
   * that wrongly answers the notification has that null-id error land
   * AFTER the discover was sent -- the naive owner is the discover.
   */
  const notificationAnswered = (recorder: Recorder) => {
    recorder.recordSent({
      id: undefined,
      method: "notifications/cancelled",
      params: { requestId: 987654321 },
      meta: undefined,
    });
    recorder.recordSent({ id: 1040, method: "server/discover", params: {}, meta: undefined });
    recorder.recordReceived({ jsonrpc: "2.0", id: null, error: { code: -32601, message: "unknown request" } });
    recorder.recordReceived({ jsonrpc: "2.0", id: 1040, result: DISCOVER_RESULT });
  };

  it("re-attributes the stray reply to the notification when the request also got its own id-matched reply", async () => {
    const { results } = await scanRecording("stdio", notificationAnswered);
    const echo = results["error-id-echo"] as TestResult;
    expect(echo.passed, echo.details).toBe(true);
    expect(echo.details).toBe(
      "no error responses to id-bearing requests recorded (exempt: 1 answering raw probes or client notifications)",
    );
    expectPassed(results, POSTHOC_IDS);
  });

  it("keeps the request as owner when it never received an id-matched reply (the stray IS its answer)", async () => {
    const { results } = await scanRecording("stdio", (recorder) => {
      recorder.recordSent({ id: undefined, method: "notifications/cancelled", params: {}, meta: undefined });
      recorder.recordSent({ id: 1040, method: "server/discover", params: {}, meta: undefined });
      recorder.recordReceived({ jsonrpc: "2.0", id: null, error: { code: -32601, message: "Method not found" } });
    });
    const echo = results["error-id-echo"] as TestResult;
    expect(echo.passed).toBe(false);
    expect(echo.details).toBe(
      "1 of 1 error response did not echo the request id; first: server/discover sent id 1040, reply carried null",
    );
  });
});

describe("2026-07-28 post-hoc tests: timeline attribution when id-bearing requests overlap", () => {
  const discover = (id: number) => ({ jsonrpc: "2.0", id, result: DISCOVER_RESULT });
  const nullIdError = { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };

  it("blames the unanswered request the stray overlapped, not the later one that got its own reply (scripted)", async () => {
    // Three requests in flight; the server answers the second with
    // id: null. The stray arrives before the third's reply, so the pop
    // lands it on 1003, which is then answered by id: 1002 is the one
    // request that never was.
    const { results } = await scanRecording("stdio", (recorder) => {
      recorder.recordSent({ id: 1001, method: "server/discover", params: {}, meta: undefined });
      recorder.recordSent({ id: 1002, method: "server/discover", params: {}, meta: undefined });
      recorder.recordSent({ id: 1003, method: "server/discover", params: {}, meta: undefined });
      recorder.recordReceived(nullIdError);
      recorder.recordReceived(discover(1001));
      recorder.recordReceived(discover(1003));
    });
    const echo = results["error-id-echo"] as TestResult;
    expect(echo.passed).toBe(false);
    expect(echo.details).toBe(
      "1 of 1 error response did not echo the request id; first: server/discover sent id 1002, reply carried null",
    );
  });

  it("does not reach past an unanswered request to an older notification (the id-less fallback is bounded)", async () => {
    const { results } = await scanRecording("stdio", (recorder) => {
      recorder.recordSent({ id: undefined, method: "notifications/cancelled", params: {}, meta: undefined });
      recorder.recordSent({ id: 1001, method: "server/discover", params: {}, meta: undefined });
      recorder.recordSent({ id: 1002, method: "server/discover", params: {}, meta: undefined });
      recorder.recordReceived(nullIdError);
      recorder.recordReceived(discover(1002));
    });
    const echo = results["error-id-echo"] as TestResult;
    expect(echo.passed).toBe(false);
    expect(echo.details).toBe(
      "1 of 1 error response did not echo the request id; first: server/discover sent id 1001, reply carried null",
    );
  });

  it("still prefers a notification sent AFTER the unanswered request (the more recent send wins)", async () => {
    const { results } = await scanRecording("stdio", (recorder) => {
      recorder.recordSent({ id: 1001, method: "server/discover", params: {}, meta: undefined });
      recorder.recordSent({ id: undefined, method: "notifications/cancelled", params: {}, meta: undefined });
      recorder.recordSent({ id: 1002, method: "server/discover", params: {}, meta: undefined });
      recorder.recordReceived(nullIdError);
      recorder.recordReceived(discover(1002));
    });
    const echo = results["error-id-echo"] as TestResult;
    expect(echo.passed, echo.details).toBe(true);
    expect(echo.details).toBe(
      "no error responses to id-bearing requests recorded (exempt: 1 answering raw probes or client notifications)",
    );
  });

  it("over real HTTP in the suite's own order (a notify, then three concurrent discovers): the null-id reply to 1002 fails error-id-echo", async () => {
    // transport-notification-202 sends a notification (202, empty body),
    // then transport-concurrent fires three discovers at once. The stub
    // answers 1002 with id: null straight away and the other two after
    // it, so the stray arrives while 1003 is still pending. Before the
    // bounded re-attribution the stray was moved to the notification and
    // the check PASSED.
    const pending: { id: number; res: ServerResponse }[] = [];
    const overlap = (_req: IncomingMessage, res: ServerResponse, body: string) => {
      const m = JSON.parse(body) as { id?: number };
      if (m.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      if (m.id === 1000) {
        sendJson(res, 200, discover(1000));
        return;
      }
      pending.push({ id: m.id, res });
      if (pending.length < 3) return;
      for (const p of pending) {
        if (p.id === 1002) sendJson(p.res, 200, nullIdError);
        else setTimeout(() => sendJson(p.res, 200, discover(p.id)), p.id === 1001 ? 80 : 160);
      }
    };
    const { results } = await scanStub(overlap, async (client) => {
      await fire(client, "server/discover");
      await client.notify("notifications/cancelled", { requestId: 999999 });
      await Promise.all([0, 1, 2].map(() => fire(client, "server/discover")));
    });
    const echo = results["error-id-echo"] as TestResult;
    expect(echo.passed).toBe(false);
    expect(echo.details).toBe(
      "1 of 1 error response did not echo the request id; first: server/discover sent id 1002, reply carried null",
    );
  });
});

describe("2026-07-28 post-hoc tests: the cancel a stdio stream's close() writes is recorded", () => {
  let tempFiles: string[] = [];
  afterEach(() => {
    for (const f of tempFiles) rmSync(f, { force: true });
    tempFiles = [];
  });

  /**
   * A stdio child that answers server/discover, never acknowledges
   * subscriptions/listen, and (wrongly) answers notifications/cancelled
   * with a null-id error -- the reply the timeline must attribute to the
   * cancel, not to the listen request it names.
   */
  function cancelAnsweringChild(): string {
    const script = [
      'const rl = require("node:readline").createInterface({ input: process.stdin });',
      'const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");',
      `const discover = ${JSON.stringify(DISCOVER_RESULT)};`,
      'rl.on("line", (line) => {',
      "  let msg;",
      "  try { msg = JSON.parse(line); } catch { return; }",
      '  if (msg.method === "server/discover") send({ jsonrpc: "2.0", id: msg.id, result: discover });',
      '  if (msg.method === "notifications/cancelled") send({ jsonrpc: "2.0", id: null, error: { code: -32602, message: "unknown request " + msg.params.requestId } });',
      "});",
      "setTimeout(() => {}, 30000);",
    ].join("\n");
    const path = join(tmpdir(), `mcp-compliance-posthoc-cancel-${process.pid}-${Date.now()}-${Math.random()}.cjs`);
    writeFileSync(path, script, "utf8");
    tempFiles.push(path);
    return path;
  }

  it("attributes the reply to notifications/cancelled to that notification, not to the stream's request", async () => {
    const transport = createStdioTransport({ command: process.execPath, args: [cancelAnsweringChild()] });
    try {
      const ctx = makeContext(transport);
      await fire(ctx.client, "server/discover");
      const stream = await ctx.client.stream("subscriptions/listen", { notifications: {} }, { timeout: 300 });
      for await (const _ of stream.messages) {
        // never acknowledged: the timer ends the stream
      }
      await stream.close(); // writes notifications/cancelled { requestId: 1001 }
      await vi.waitFor(() => expect(ctx.recorder.received).toHaveLength(2), { timeout: 5000, interval: 10 });
      // The transport's own cancel is logged as a sent entry, in order.
      expect(ctx.recorder.sent.map((s) => [s.method, s.id])).toEqual([
        ["server/discover", 1000],
        ["subscriptions/listen", 1001],
        ["notifications/cancelled", undefined],
      ]);
      expect(ctx.recorder.sent[2]?.params).toEqual({ requestId: 1001 });
      await runPostHoc(ctx);
      const results = collect(ctx);
      const echo = results["error-id-echo"] as TestResult;
      expect(echo.passed, echo.details).toBe(true);
      expect(echo.details).toBe(
        "no error responses to id-bearing requests recorded (exempt: 1 answering raw probes or client notifications)",
      );
    } finally {
      await transport.close();
    }
  });
});

describe("2026-07-28 post-hoc tests: schema-input-required-shape rules", () => {
  const inputRequired = (inputRequests: Record<string, unknown>) => (recorder: Recorder) => {
    recorder.recordSent({ id: 1000, method: "tools/call", params: { name: "t", arguments: {} }, meta: undefined });
    recorder.recordReceived({
      jsonrpc: "2.0",
      id: 1000,
      result: { resultType: "input_required", inputRequests, requestState: "s1" },
    });
  };

  it("accepts roots/list without params when the client declared roots (ListRootsRequest.params is optional)", async () => {
    const { results } = await scanRecording("http", inputRequired({ r: { method: "roots/list" } }), {
      clientCapabilities: { elicitation: {}, roots: {} },
    });
    const r = results["schema-input-required-shape"] as TestResult;
    expect(r.passed, r.details).toBe(true);
    expect(r.details).toBe(
      "1 input_required result observed, every one well-formed (inputRequests/requestState present, methods allowed and declared by the client [elicitation, roots], params present where required, elicitation modes within the declared [form])",
    );
  });

  it("flags elicitation/create in url mode when the client declared elicitation: {} (form only)", async () => {
    // client/elicitation#capabilities: an empty object is the
    // backwards-compatible form-only declaration, and servers MUST NOT
    // elicit in a mode the client did not declare. The suite declares
    // exactly {} .
    const { results } = await scanRecording(
      "http",
      inputRequired({
        e: {
          method: "elicitation/create",
          params: { mode: "url", message: "Sign in", url: "https://example.com/auth", elicitationId: "e-1" },
        },
      }),
    );
    const r = results["schema-input-required-shape"] as TestResult;
    expect(r.passed).toBe(false);
    expect(r.details).toBe(
      '1 of 1 input_required result violates the MRTR server requirements; first (tools/call): inputRequests.e.params.mode "url" is not an elicitation mode the client declared (form)',
    );
  });

  it("accepts url mode once the client declared elicitation: { form: {}, url: {} }", async () => {
    const { results } = await scanRecording(
      "stdio",
      inputRequired({
        e: {
          method: "elicitation/create",
          params: { mode: "url", message: "Sign in", url: "https://example.com/auth", elicitationId: "e-1" },
        },
      }),
      { clientCapabilities: { elicitation: { form: {}, url: {} } } },
    );
    const r = results["schema-input-required-shape"] as TestResult;
    expect(r.passed, r.details).toBe(true);
    expect(r.details).toMatch(/elicitation modes within the declared \[form, url\]\)$/);
  });

  it("treats an absent mode as form: accepted under elicitation: {}, flagged when the client declared url only", async () => {
    const formByDefault = inputRequired({
      e: { method: "elicitation/create", params: { message: "Your name?", requestedSchema: { type: "object" } } },
    });
    const accepted = await scanRecording("http", formByDefault);
    expect(accepted.results["schema-input-required-shape"]?.passed).toBe(true);
    const urlOnly = await scanRecording("http", formByDefault, { clientCapabilities: { elicitation: { url: {} } } });
    const r = urlOnly.results["schema-input-required-shape"] as TestResult;
    expect(r.passed).toBe(false);
    expect(r.details).toMatch(
      /inputRequests\.e\.params\.mode "form" is not an elicitation mode the client declared \(url\)$/,
    );
  });

  it("requires params for elicitation/create and sampling/createMessage", async () => {
    const { results } = await scanRecording("http", inputRequired({ e: { method: "elicitation/create" } }));
    const r = results["schema-input-required-shape"] as TestResult;
    expect(r.passed).toBe(false);
    expect(r.details).toBe(
      "1 of 1 input_required result violates the MRTR server requirements; first (tools/call): inputRequests.e.params is not an object (required for elicitation/create)",
    );
  });

  it("fails roots/list when the client declared only elicitation, naming what was declared", async () => {
    const { results } = await scanRecording("stdio", inputRequired({ r: { method: "roots/list" } }));
    const r = results["schema-input-required-shape"] as TestResult;
    expect(r.passed).toBe(false);
    expect(r.details).toBe(
      "1 of 1 input_required result violates the MRTR server requirements; first (tools/call): server requested roots/list although the client declared only elicitation",
    );
  });

  it("names 'no capabilities' when the client declared none", async () => {
    const { results } = await scanRecording(
      "http",
      inputRequired({ e: { method: "elicitation/create", params: { mode: "form", message: "?" } } }),
      { clientCapabilities: {} },
    );
    const r = results["schema-input-required-shape"] as TestResult;
    expect(r.passed).toBe(false);
    expect(r.details).toMatch(/server requested elicitation\/create although the client declared no capabilities$/);
  });
});

describe("2026-07-28 post-hoc tests: schema-result-type value set", () => {
  const withResultTypes = (types: [string, unknown][]) => (recorder: Recorder) => {
    let id = 1000;
    for (const [method, resultType] of types) {
      const rid = id++;
      recorder.recordSent({ id: rid, method, params: {}, meta: undefined });
      const base = method === "tools/call" ? { content: [{ type: "text", text: "x" }] } : {};
      recorder.recordReceived({ jsonrpc: "2.0", id: rid, result: { ...base, resultType } });
    }
  };

  it("fails a resultType outside complete/input_required when no extension is advertised", async () => {
    const { results, warnings } = await scanRecording(
      "http",
      withResultTypes([
        ["server/discover", "complete"],
        ["tools/list", "ok"],
        ["tools/call", "done"],
      ]),
    );
    const r = results["schema-result-type"] as TestResult;
    expect(r.passed).toBe(false);
    expect(r.details).toBe(
      '2 of 3 results lack a valid resultType; first: tools/list (resultType "ok" is neither complete nor input_required and no extension is advertised)',
    );
    expect(warnings.filter((w) => w.startsWith("schema-result-type"))).toEqual([]);
  });

  it("still fails a missing or non-string resultType", async () => {
    const { results } = await scanRecording("stdio", withResultTypes([["tools/list", 7]]));
    const r = results["schema-result-type"] as TestResult;
    expect(r.passed).toBe(false);
    expect(r.details).toBe("1 of 1 result lacks a valid resultType; first: tools/list (resultType 7)");
  });

  it("accepts an extension value with a warning naming it when the server advertises extensions", async () => {
    const { results, warnings } = await scanRecording(
      "http",
      withResultTypes([
        ["server/discover", "complete"],
        ["tools/call", "task"],
        ["tools/call", "task"],
      ]),
      { state: { capabilities: { tools: {}, extensions: { "io.modelcontextprotocol/tasks": {} } } } },
    );
    const r = results["schema-result-type"] as TestResult;
    expect(r.passed, r.details).toBe(true);
    expect(r.details).toBe(
      '3 results scanned; every resultType is complete, input_required, or an extension value ("task"; see warning)',
    );
    expect(warnings.filter((w) => w.startsWith("schema-result-type"))).toEqual([
      'schema-result-type: resultType "task" on tools/call is not a core value; accepted because the server advertises extensions (io.modelcontextprotocol/tasks) -- verify one of them defines it.',
    ]);
  });

  it("an empty extensions object advertises nothing", async () => {
    const { results } = await scanRecording("http", withResultTypes([["tools/list", "ok"]]), {
      state: { capabilities: { extensions: {} } },
    });
    expect(results["schema-result-type"]?.passed).toBe(false);
  });
});

describe("2026-07-28 post-hoc tests: no retries, one id table", () => {
  const NOTHING = "no JSON-RPC messages were received from the server during the run, so there is nothing to scan";
  /** Under --retries 3 the harness would sleep 1+2+3 s per failing test; a deterministic scan must not. */
  const RETRIES = 3;

  it("fails all eight on an empty recorder at once under --retries 3 (a scan cannot change on a retry)", async () => {
    const started = Date.now();
    const { results } = await scanRecording("http", () => {}, { retries: RETRIES });
    expect(Date.now() - started).toBeLessThan(2000);
    for (const id of POSTHOC_IDS) {
      const r = results[id] as TestResult;
      expect(r.passed, id).toBe(false);
      expect(r.details, id).toBe(NOTHING);
    }
  });

  it("takes no retries on a populated recording either", async () => {
    const started = Date.now();
    const { results } = await scanRecording(
      "stdio",
      (recorder) => {
        recorder.recordSent({ id: 1000, method: "server/discover", params: {}, meta: undefined });
        recorder.recordReceived({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "no id for you" } });
      },
      { retries: RETRIES },
    );
    expect(Date.now() - started).toBeLessThan(2000);
    expect(results["error-id-echo"]?.passed).toBe(false);
    expect(results["schema-result-type"]?.passed, "an unrelated check still passes").toBe(true);
  });

  it("the exported table is the catalog's eight post-hoc ids, each a known definition", () => {
    const definitions = getTestDefinitionMap(MODERN_SPEC_VERSION);
    for (const id of POSTHOC_IDS) expect(definitions.has(id), id).toBe(true);
    expect(new Set(POSTHOC_IDS).size).toBe(8);
    // collect() asserts on every scan that exactly these ids ran, in this
    // order, on the empty and the populated path alike.
  });
});
