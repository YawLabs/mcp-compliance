import { describe, expect, it } from "vitest";
import { getTestDefinitionMap } from "../definitions/index.js";
import { createHarness } from "../harness.js";
import { createModernClient, type ModernClient } from "../modern/client.js";
import { createRecorder } from "../recorder.js";
import { MODERN_SPEC_VERSION, specBaseFor } from "../spec.js";
import { createModernState, type ModernState, type ModernSuiteContext } from "../suites/modern/context.js";
import { runPostHoc } from "../suites/modern/posthoc.js";
import { createHttpTransport } from "../transport/http.js";
import type { Transport } from "../transport/index.js";
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
 */

const POSTHOC_IDS = [
  "transport-no-server-requests",
  "lifecycle-log-level-gating",
  "error-id-echo",
  "error-retired-codes",
  "schema-result-type",
  "schema-no-input-required-on-lists",
  "schema-input-required-shape",
  "schema-wire-valid",
];
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

function makeContext(transport: Transport): ModernSuiteContext {
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
    displayUrl: transport.kind === "http" ? "http://fixture" : "stdio://modern-fixture",
    detection: undefined,
    hasAuth: false,
    state: { ...EMPTY_STATE },
  };
}

type Kind = "stdio" | "http";

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
    const out: Record<string, TestResult> = {};
    for (const r of ctx.harness.tests) out[r.id] = r;
    for (const id of POSTHOC_IDS) {
      if (!out[id]) throw new Error(`${id} did not run`);
    }
    return out;
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

function expectPassed(results: Record<string, TestResult>, ids: string[]) {
  for (const id of ids) {
    const r = results[id] as TestResult;
    expect(r.passed, `${id}: ${r.details}`).toBe(true);
  }
}

describe("2026-07-28 post-hoc tests: the real suite over the clean fixture", () => {
  it("all eight pass over stdio (full suite, no --only)", async () => {
    const report = await runModern(stdioFixture().target);
    expect(passedIds(report, POSTHOC_IDS)).toEqual(ALL_PASS);
  });

  it("all eight pass over HTTP (full suite, no --only)", async () => {
    const http = await startHttpFixture();
    try {
      const report = await runModern(http.url);
      expect(passedIds(report, POSTHOC_IDS)).toEqual(ALL_PASS);
    } finally {
      await http.stop();
    }
  });

  it("all eight pass with a note when nothing else ran (--only the post-hoc ids)", async () => {
    const report = await runModern(stdioFixture().target, { only: POSTHOC_IDS });
    expect(passedIds(report, POSTHOC_IDS)).toEqual(ALL_PASS);
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
      /^(no results recorded|1 result scanned; every one carries a string resultType)/,
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
      /2 of 2 results lack a string resultType; first: server\/discover \(resultType undefined\)/,
    );
    const wire = results["schema-wire-valid"] as TestResult;
    expect(wire.passed).toBe(false);
    expect(wire.details).toMatch(
      /2 of 2 server messages violate the 2026-07-28 schema: server\/discover: DiscoverResult at \/result: must have required property 'resultType'/,
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
      /1 of 1 input_required result malformed; first \(tools\/call\): neither inputRequests nor requestState present/,
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

  it("no-caching: schema-wire-valid alone catches a missing CacheableResult field (http)", async () => {
    // Not one of the eight's own knobs; it shows the wire check does more
    // than repeat schema-result-type, and that the overflow goes to a warning.
    const http = await startHttpFixture({ breaks: ["no-caching"] });
    const transport = createHttpTransport({ url: http.url });
    try {
      const ctx = makeContext(transport);
      for (let i = 0; i < 9; i++) await fire(ctx.client, "server/discover");
      await runPostHoc(ctx);
      const wire = ctx.harness.tests.find((t) => t.id === "schema-wire-valid") as TestResult;
      expect(wire.passed).toBe(false);
      // ajv reports the two missing CacheableResult fields in its own order; one is inline, the other is the "+1 more".
      expect(wire.details).toMatch(
        /^9 of 9 server messages violate the 2026-07-28 schema: server\/discover: DiscoverResult at \/result: must have required property '(ttlMs|cacheScope)' \(\+1 more\)/,
      );
      // Three inline, five in the warning, one more counted.
      expect(wire.details.split(" | ")).toHaveLength(3);
      const warning = ctx.harness.warnings.find((w) => w.startsWith("schema-wire-valid: 6 more message(s)"));
      expect(warning, ctx.harness.warnings.join("\n")).toBeDefined();
      expect(warning).toMatch(/\(and 1 more\)$/);
      expect(ctx.harness.tests.find((t) => t.id === "schema-result-type")?.passed).toBe(true);
    } finally {
      await http.stop();
    }
  });
});
