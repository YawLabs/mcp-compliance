import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDefinitionMap } from "../definitions/index.js";
import { createHarness } from "../harness.js";
import { createModernClient, type RpcResponse } from "../modern/client.js";
import { createRecorder } from "../recorder.js";
import { MODERN_SPEC_VERSION, specBaseFor } from "../spec.js";
import { createModernState, type ModernSuiteContext } from "../suites/modern/context.js";
import { runTransport } from "../suites/modern/transport.js";
import { createHttpTransport } from "../transport/http.js";
import type { ComplianceReport } from "../types.js";
import {
  type HttpFixture,
  passedIds,
  resultOf,
  runModern,
  startHttpFixture,
  stdioFixture,
} from "./helpers/modern-fixture.js";

/**
 * The 2026-07-28 transport module (src/suites/modern/transport.ts): every
 * HTTP transport test passes on the clean fixture, is absent from a stdio
 * run (catalog-gated), and goes RED under the fixture knob that violates
 * the check it makes. Knob runs are grouped one fixture per knob.
 */

const TRANSPORT_IDS = [
  "transport-post",
  "transport-content-type",
  "transport-content-type-reject",
  "transport-batch-reject",
  "transport-notification-202",
  "transport-concurrent",
  "transport-get-removed",
  "transport-delete-removed",
  "transport-session-ignored",
  "transport-header-version-required",
  "transport-header-version-mismatch",
  "transport-header-method-required",
  "transport-header-method-mismatch",
  "transport-header-name-mismatch",
  "transport-header-case-insensitive",
];

const HEADER_REJECT_IDS = [
  "transport-header-version-required",
  "transport-header-version-mismatch",
  "transport-header-method-required",
  "transport-header-method-mismatch",
];

/**
 * The six "reject the malformed request" tests that are only evaluable
 * when the conformant discover was served (the three _meta probes live in
 * lifecycle.ts, the three standard-header probes here).
 */
const ATTRIBUTABLE_REJECTION_IDS = [
  "lifecycle-meta-required",
  "lifecycle-meta-protocol-version-required",
  "lifecycle-meta-client-capabilities-required",
  "transport-header-version-required",
  "transport-header-method-required",
  "transport-header-method-mismatch",
];

function allPass(ids: string[]): Record<string, string> {
  return Object.fromEntries(ids.map((id) => [id, "pass"]));
}

function transportWarnings(report: ComplianceReport): string[] {
  return transportWarningsOf(report.warnings);
}

function transportWarningsOf(warnings: string[]): string[] {
  return warnings.filter((w) => w.startsWith("transport-"));
}

// ---------------------------------------------------------------------------
// Clean fixture: every test passes over HTTP, none runs over stdio
// ---------------------------------------------------------------------------

describe("modern transport suite: clean fixture over HTTP", () => {
  let fixture: HttpFixture;
  let report: ComplianceReport;

  beforeAll(async () => {
    fixture = await startHttpFixture();
    // Only the transport ids: the feature module does not run, so the
    // name-mismatch test must fetch the resource list itself.
    report = await runModern(fixture.url, { only: TRANSPORT_IDS });
  });

  afterAll(async () => {
    await fixture.stop();
  });

  it("passes every transport test", () => {
    expect(passedIds(report, TRANSPORT_IDS)).toEqual(allPass(TRANSPORT_IDS));
  });

  it("emits no transport warnings on a conformant server", () => {
    expect(transportWarnings(report)).toEqual([]);
  });

  it("stamps the resolved spec version and required flags from the catalog", () => {
    expect(report.specVersion).toBe(MODERN_SPEC_VERSION);
    expect(resultOf(report, "transport-post").required).toBe(true);
    expect(resultOf(report, "transport-header-version-mismatch").required).toBe(true);
    expect(resultOf(report, "transport-get-removed").required).toBe(false);
    expect(resultOf(report, "transport-header-name-mismatch").required).toBe(false);
  });

  it("names the observed status in every details string, ASCII only", () => {
    for (const id of TRANSPORT_IDS) {
      const r = resultOf(report, id);
      expect(r.details, id).toMatch(/^[\x20-\x7e]+$/);
      expect(r.details.length, id).toBeLessThanOrEqual(220);
    }
    expect(resultOf(report, "transport-post").details).toBe("HTTP 200");
    expect(resultOf(report, "transport-content-type").details).toContain("application/json");
    expect(resultOf(report, "transport-content-type-reject").details).toContain("HTTP 415");
    expect(resultOf(report, "transport-batch-reject").details).toContain("HTTP 400");
    expect(resultOf(report, "transport-notification-202").details).toBe("HTTP 202 Accepted");
    expect(resultOf(report, "transport-get-removed").details).toBe("HTTP 405 Method Not Allowed");
    expect(resultOf(report, "transport-delete-removed").details).toBe("HTTP 405 Method Not Allowed");
    for (const id of HEADER_REJECT_IDS) {
      expect(resultOf(report, id).details, id).toBe("HTTP 400, JSON-RPC error -32020 HeaderMismatch");
    }
  });

  it("name-mismatch fetches the resource list on demand and reads a real resource", () => {
    expect(resultOf(report, "transport-header-name-mismatch").details).toBe(
      "resources/read with Mcp-Name: wrong-name -> HTTP 400, JSON-RPC error -32020 HeaderMismatch",
    );
    // The on-demand fetch is published like the feature module's would be.
    expect(report.resourceCount).toBe(2);
  });

  it("--only transport (the category) reads a real resource too", async () => {
    const byCategory = await runModern(fixture.url, { only: ["transport"] });
    expect(resultOf(byCategory, "transport-header-name-mismatch").details).toBe(
      "resources/read with Mcp-Name: wrong-name -> HTTP 400, JSON-RPC error -32020 HeaderMismatch",
    );
    expect(passedIds(byCategory, TRANSPORT_IDS)).toEqual(allPass(TRANSPORT_IDS));
  });
});

describe("modern transport suite: stdio run", () => {
  it("runs none of the HTTP-only transport tests and completes", async () => {
    const report = await runModern(stdioFixture().target, { only: TRANSPORT_IDS });
    expect(report.specVersion).toBe(MODERN_SPEC_VERSION);
    const ran = report.tests.filter((t) => TRANSPORT_IDS.includes(t.id)).map((t) => t.id);
    expect(ran).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Knob runs: each check goes red under the fixture defect it exists for
// ---------------------------------------------------------------------------

async function runWithBreaks(breaks: string[], only: string[], auth?: string): Promise<ComplianceReport> {
  const fixture = await startHttpFixture({ breaks, auth });
  try {
    return await runModern(fixture.url, { only });
  } finally {
    await fixture.stop();
  }
}

function failed(report: ComplianceReport, id: string): string {
  const r = resultOf(report, id);
  expect(r.passed, `${id} should FAIL, details: ${r.details}`).toBe(false);
  return r.details;
}

describe("modern transport suite: knob runs", () => {
  it("accept-header-mismatch: every standard-header rejection test fails", async () => {
    const report = await runWithBreaks(["accept-header-mismatch"], HEADER_REJECT_IDS);
    // Missing / mismatched headers are simply served: HTTP 200 with a result.
    for (const id of [
      "transport-header-version-required",
      "transport-header-method-required",
      "transport-header-method-mismatch",
    ]) {
      expect(failed(report, id), id).toBe("HTTP 200, result (expected HTTP 400)");
    }
    // The header/_meta mismatch reached version negotiation instead of
    // header validation: still 400, but -32022 where -32020 is required.
    expect(failed(report, "transport-header-version-mismatch")).toBe(
      "HTTP 400 but error code -32022 (expected -32020 HeaderMismatch)",
    );
  });

  it("header-error-wrong-code: 400 with -32602 passes the SHOULD tests with a warning, fails version-mismatch", async () => {
    const report = await runWithBreaks(["header-error-wrong-code"], HEADER_REJECT_IDS);
    expect(
      passedIds(report, [
        "transport-header-version-required",
        "transport-header-method-required",
        "transport-header-method-mismatch",
      ]),
    ).toEqual(
      allPass([
        "transport-header-version-required",
        "transport-header-method-required",
        "transport-header-method-mismatch",
      ]),
    );
    for (const id of [
      "transport-header-version-required",
      "transport-header-method-required",
      "transport-header-method-mismatch",
    ]) {
      expect(resultOf(report, id).details, id).toContain("error code -32602");
      expect(
        report.warnings.some((w) => w.startsWith(`${id}:`) && w.includes("-32602")),
        `warning for ${id}`,
      ).toBe(true);
    }
    expect(failed(report, "transport-header-version-mismatch")).toContain("error code -32602");
  });

  it("header-error-200: a HeaderMismatch body on HTTP 200 fails every standard-header rejection test", async () => {
    const report = await runWithBreaks(["header-error-200"], HEADER_REJECT_IDS);
    for (const id of HEADER_REJECT_IDS) {
      const details = failed(report, id);
      expect(details, id).toContain("HTTP 200");
      expect(details, id).toContain("-32020");
    }
    expect(transportWarnings(report)).toEqual([]);
  });

  it("get-sse: a legacy GET stream fails transport-get-removed", async () => {
    const report = await runWithBreaks(["get-sse"], ["transport-get-removed"]);
    expect(failed(report, "transport-get-removed")).toContain("text/event-stream");
  });

  it("delete-ok: DELETE answered 200 fails transport-delete-removed", async () => {
    const report = await runWithBreaks(["delete-ok"], ["transport-delete-removed"]);
    expect(failed(report, "transport-delete-removed")).toContain("HTTP 200");
  });

  it("mint-session: rejecting the bogus session and minting an id fails transport-session-ignored", async () => {
    const report = await runWithBreaks(["mint-session"], ["transport-session-ignored", "transport-post"]);
    expect(failed(report, "transport-session-ignored")).toContain("HTTP 404");
    // Only the session test sends the header; the plain discover is untouched.
    expect(passedIds(report, ["transport-post"])).toEqual(allPass(["transport-post"]));
  });

  it("batch-ok: a processed batch fails transport-batch-reject", async () => {
    const report = await runWithBreaks(["batch-ok"], ["transport-batch-reject"]);
    expect(failed(report, "transport-batch-reject")).toContain("processed the batch (2 replies)");
  });

  it("any-content-type: accepting text/plain fails transport-content-type-reject", async () => {
    const report = await runWithBreaks(["any-content-type"], ["transport-content-type-reject"]);
    expect(failed(report, "transport-content-type-reject")).toContain("accepted Content-Type text/plain");
  });

  it("notification-200: a 200 for a notification fails transport-notification-202", async () => {
    const report = await runWithBreaks(["notification-200"], ["transport-notification-202"]);
    expect(failed(report, "transport-notification-202")).toContain("HTTP 200");
    expect(transportWarnings(report)).toEqual([]);
  });

  it("wrong-id-type: string-echoed numeric ids fail transport-concurrent", async () => {
    const report = await runWithBreaks(["wrong-id-type"], ["transport-concurrent"]);
    expect(failed(report, "transport-concurrent")).toContain("(mismatch)");
  });

  it("MODERN_FIXTURE_AUTH with a wrong credential: transport-post says the credential was rejected", async () => {
    const fixture = await startHttpFixture({ auth: "secret-token" });
    try {
      const report = await runModern(
        { type: "http", url: fixture.url, headers: { Authorization: "Bearer WRONG" } },
        { only: ["transport-post"] },
      );
      expect(failed(report, "transport-post")).toBe("HTTP 401 (credential rejected -- check --auth)");
    } finally {
      await fixture.stop();
    }
  });

  it("MODERN_FIXTURE_AUTH without --auth: transport-post fails with the --auth hint", async () => {
    const report = await runWithBreaks([], ["transport-post", "transport-header-case-insensitive"], "secret-token");
    expect(failed(report, "transport-post")).toBe("HTTP 401 (auth required -- pass --auth)");
    // No knob makes the fixture match header names case-sensitively (Node
    // lowercases them); the 401 proves the check can at least go red.
    expect(failed(report, "transport-header-case-insensitive")).toContain("HTTP 401");
  });
});

// ---------------------------------------------------------------------------
// transport-header-name-mismatch: driven with a hand-built context so the
// resource / prompt / skip branches are pinned without the feature module
// ---------------------------------------------------------------------------

interface DirectRun {
  ctx: ModernSuiteContext;
  /** Runs runTransport(ctx) and returns the single test named by `only[0]`. */
  run(): Promise<{ passed: boolean; details: string; warnings: string[] }>;
  /** Every result the run produced, by id. */
  all(): Promise<Record<string, { passed: boolean; details: string }>>;
  warnings(): string[];
}

interface DirectOptions {
  only?: string[];
  timeout?: number;
}

/**
 * A served setup discover, as the lifecycle module would have recorded it:
 * the header rejection tests credit a 400 only when this is in hand.
 */
const SYNTHETIC_DISCOVER: RpcResponse = {
  body: {
    jsonrpc: "2.0",
    id: 0,
    result: { resultType: "complete", supportedVersions: [MODERN_SPEC_VERSION], capabilities: {} },
  },
  requestId: 0,
  statusCode: 200,
  headers: {},
  messages: [],
};

function directContext(url: string, state: Partial<ModernSuiteContext["state"]>, opts: DirectOptions = {}): DirectRun {
  const only = opts.only ?? ["transport-header-name-mismatch"];
  const timeout = opts.timeout ?? 5000;
  const transport = createHttpTransport({ url });
  const recorder = createRecorder();
  let id = 5000;
  const harness = createHarness({
    definitions: getTestDefinitionMap(MODERN_SPEC_VERSION),
    specBase: specBaseFor(MODERN_SPEC_VERSION),
    transportKind: "http",
    only,
  });
  const client = createModernClient({
    transport,
    recorder,
    nextId: () => id++,
    timeout,
    protocolVersion: MODERN_SPEC_VERSION,
    clientCapabilities: { elicitation: {} },
    clientInfo: { name: "mcp-compliance-test", version: "0.0.0" },
  });
  const ctx: ModernSuiteContext = {
    harness,
    client,
    recorder,
    transport,
    kind: "http",
    timeout,
    startupTimeout: 10000,
    backendUrl: url,
    userHeaders: {},
    displayUrl: url,
    detection: undefined,
    hasAuth: false,
    state: {
      ...createModernState(),
      discover: SYNTHETIC_DISCOVER,
      supportedVersions: [MODERN_SPEC_VERSION],
      capabilities: { resources: {}, prompts: {} },
      ...state,
    },
  };
  let ran = false;
  async function ensureRan() {
    if (ran) return;
    ran = true;
    await runTransport(ctx);
  }
  return {
    ctx,
    async run() {
      await ensureRan();
      const r = harness.tests.find((t) => t.id === only[0]);
      if (!r) throw new Error(`${only[0]} did not run`);
      return { passed: r.passed, details: r.details, warnings: [...harness.warnings] };
    },
    async all() {
      await ensureRan();
      return Object.fromEntries(harness.tests.map((t) => [t.id, { passed: t.passed, details: t.details }]));
    },
    warnings: () => [...harness.warnings],
  };
}

// ---------------------------------------------------------------------------
// Stub servers for the branches the fixture has no knob for
// ---------------------------------------------------------------------------

type StubHandler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

async function startStub(handle: StubHandler): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => handle(req, res, body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A minimal, schema-shaped DiscoverResult echoing the request id. */
function discoverResult(body: string): string {
  let id: unknown = null;
  try {
    id = JSON.parse(body).id ?? null;
  } catch {}
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: {
      resultType: "complete",
      supportedVersions: [MODERN_SPEC_VERSION],
      capabilities: {},
      ttlMs: 0,
      cacheScope: "public",
    },
  });
}

function isNotification(body: string): boolean {
  try {
    const msg = JSON.parse(body);
    return msg && typeof msg === "object" && !Array.isArray(msg) && msg.id === undefined;
  } catch {
    return false;
  }
}

const RESOURCES = [{ uri: "test://static-text", name: "static-text", mimeType: "text/plain" }];
const PROMPTS = [
  { name: "greet", arguments: [{ name: "name", required: true }] },
  { name: "simple", description: "no arguments" },
];

describe("transport-header-name-mismatch: direct context", () => {
  let clean: HttpFixture;

  beforeAll(async () => {
    clean = await startHttpFixture();
  });

  afterAll(async () => {
    await clean.stop();
  });

  it("reads the first listed resource with a wrong Mcp-Name and expects 400 + -32020", async () => {
    const r = await directContext(clean.url, { resources: RESOURCES, resourceNames: ["static-text"] }).run();
    expect(r.details).toBe(
      "resources/read with Mcp-Name: wrong-name -> HTTP 400, JSON-RPC error -32020 HeaderMismatch",
    );
    expect(r.passed).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it("falls back to a prompt with no required arguments when no resource is listed", async () => {
    // An EMPTY resource list (listed nothing) -- a null one would be fetched.
    const r = await directContext(clean.url, {
      resources: [],
      prompts: PROMPTS,
      promptNames: ["greet", "simple"],
    }).run();
    expect(r.details).toBe("prompts/get with Mcp-Name: wrong-name -> HTTP 400, JSON-RPC error -32020 HeaderMismatch");
    expect(r.passed).toBe(true);
  });

  it("fetches a list that nothing cached yet, once, instead of skipping", async () => {
    // Neither list cached (a --only transport run): resources/list is
    // fetched on demand and the first resource is read.
    const run = directContext(clean.url, { resources: null, prompts: null });
    const r = await run.run();
    expect(r.details).toBe(
      "resources/read with Mcp-Name: wrong-name -> HTTP 400, JSON-RPC error -32020 HeaderMismatch",
    );
    expect(run.ctx.state.resources).toHaveLength(2);
    expect(run.ctx.state.resourceNames).toEqual(["static-text", "static-binary"]);
    expect(run.ctx.recorder.sent.filter((s) => s.method === "resources/list")).toHaveLength(1);
    // prompts/list was never needed.
    expect(run.ctx.recorder.sent.some((s) => s.method === "prompts/list")).toBe(false);
  });

  it("skip-passes naming why: undeclared capabilities, failed lists, or nothing readable by name", async () => {
    const undeclared = await directContext(clean.url, { capabilities: {} }).run();
    expect(undeclared).toMatchObject({ passed: true, details: "skipped: server declares no resources or prompts" });
    // Both lists were asked for earlier and failed: no re-fetch. When the
    // -list tests that report those failures are in the run, an honest skip
    // pointing at them ...
    const failedState = {
      resources: null,
      prompts: null,
      listAttempts: new Set<"resources" | "prompts">(["resources", "prompts"]),
      listFailures: { resources: "JSON-RPC error -32603 (boom)", prompts: "no result object (HTTP 500)" },
    };
    const reported = await directContext(clean.url, failedState, {
      only: ["transport-header-name-mismatch", "resources-list", "prompts-list"],
    }).run();
    expect(reported).toMatchObject({
      passed: true,
      details:
        "skipped: resources/list and prompts/list failed, no resource or prompt to read by name (see resources-list, prompts-list)",
    });
    // ... and when they are not (a --only transport run), a failure that
    // carries the recorded reasons, since nothing else in the report would.
    const unreported = await directContext(clean.url, failedState).run();
    expect(unreported).toMatchObject({
      passed: false,
      details:
        "resources/list failed (JSON-RPC error -32603 (boom)) and prompts/list failed (no result object (HTTP 500)); no resource or prompt to read by name",
    });
    const nothingReadable = await directContext(clean.url, {
      resources: [],
      prompts: [{ name: "greet", arguments: [{ name: "name", required: true }] }],
    }).run();
    expect(nothingReadable).toMatchObject({
      passed: true,
      details: "skipped: no listed resource has a uri and no listed prompt is callable without arguments",
    });
  });

  it("one failed list is not hidden behind the other listing nothing readable by name", async () => {
    // resources/list failed while prompts/list worked but lists only
    // prompts that need an argument. Before the fix this skip-passed with
    // "no listed resource has a uri and no listed prompt is callable
    // without arguments" -- naming neither the failure nor the list, so a
    // --only transport run graded a broken resources/list A.
    const resourcesFailed = {
      resources: null,
      prompts: [{ name: "greet", arguments: [{ name: "name", required: true }] }],
      listAttempts: new Set<"resources" | "prompts">(["resources"]),
      listFailures: { resources: "JSON-RPC error -32603 (boom)" },
    };
    const unreported = directContext(clean.url, resourcesFailed);
    expect(await unreported.run()).toMatchObject({
      passed: false,
      details: "resources/list failed (JSON-RPC error -32603 (boom)); no resource or prompt to read by name",
    });
    // Asked for once and failed: not asked again.
    expect(unreported.ctx.recorder.sent.map((s) => s.method)).toEqual([]);
    expect(
      await directContext(clean.url, resourcesFailed, {
        only: ["transport-header-name-mismatch", "resources-list"],
      }).run(),
    ).toMatchObject({
      passed: true,
      details: "skipped: resources/list failed, no resource or prompt to read by name (see resources-list)",
    });
    // The mirror: resources listed nothing, prompts/list failed.
    const promptsFailed = {
      resources: [],
      prompts: null,
      listAttempts: new Set<"resources" | "prompts">(["prompts"]),
      listFailures: { prompts: "no result object (HTTP 500)" },
    };
    expect(await directContext(clean.url, promptsFailed).run()).toMatchObject({
      passed: false,
      details: "prompts/list failed (no result object (HTTP 500)); no resource or prompt to read by name",
    });
    expect(
      await directContext(clean.url, promptsFailed, { only: ["transport-header-name-mismatch", "prompts-list"] }).run(),
    ).toMatchObject({
      passed: true,
      details: "skipped: prompts/list failed, no resource or prompt to read by name (see prompts-list)",
    });
  });

  it("accept-header-mismatch: a served read with the wrong Mcp-Name fails", async () => {
    const broken = await startHttpFixture({ breaks: ["accept-header-mismatch"] });
    try {
      const r = await directContext(broken.url, { resources: RESOURCES }).run();
      expect(r.passed).toBe(false);
      expect(r.details).toContain("resources/read with Mcp-Name: wrong-name -> HTTP 200, result (expected HTTP 400)");
      const viaPrompt = await directContext(broken.url, { resources: [], prompts: PROMPTS }).run();
      expect(viaPrompt.passed).toBe(false);
      expect(viaPrompt.details).toContain("prompts/get with Mcp-Name: wrong-name -> HTTP 200, result");
    } finally {
      await broken.stop();
    }
  });

  it("header-error-wrong-code: 400 with -32602 passes with a warning", async () => {
    const broken = await startHttpFixture({ breaks: ["header-error-wrong-code"] });
    try {
      const r = await directContext(broken.url, { resources: RESOURCES }).run();
      expect(r.passed).toBe(true);
      expect(r.details).toContain("HTTP 400 with error code -32602");
      expect(r.warnings.some((w) => w.startsWith("transport-header-name-mismatch:") && w.includes("-32602"))).toBe(
        true,
      );
    } finally {
      await broken.stop();
    }
  });

  it("header-error-200: a HeaderMismatch body on HTTP 200 fails", async () => {
    const broken = await startHttpFixture({ breaks: ["header-error-200"] });
    try {
      const r = await directContext(broken.url, { resources: RESOURCES }).run();
      expect(r.passed).toBe(false);
      expect(r.details).toContain("HTTP 200, JSON-RPC error -32020");
    } finally {
      await broken.stop();
    }
  });
});

describe("modern transport suite: stub servers for knob-less branches", () => {
  it("a server that rejects everything (SDK v1 'Server not initialized') fails every rejection test as not evaluable", async () => {
    // The 2026-07-28 catalog pinned against a 2025-era server: the
    // conformant discover draws the same 400 / -32000 as every malformed
    // variant, so none of the six rejections can be credited to the
    // injected defect. Before the attribution guard all six PASSED here.
    const stub = await startStub((_req, res, body) => {
      let id: unknown = null;
      try {
        id = JSON.parse(body).id ?? null;
      } catch {}
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "Bad Request: Server not initialized" } }),
      );
    });
    try {
      const report = await runModern(stub.url, {
        only: ["lifecycle-discover", "transport-post", "transport-concurrent", ...ATTRIBUTABLE_REJECTION_IDS],
      });
      expect(failed(report, "lifecycle-discover")).toBe(
        "server/discover answered JSON-RPC error -32000 (Bad Request: Server not initialized) (HTTP 400)",
      );
      // The baseline POST and the concurrent POSTs are plain failures: they
      // are the conformant requests, so there is no defect to attribute.
      expect(failed(report, "transport-post")).toBe(
        "HTTP 400, JSON-RPC error -32000 (Bad Request: Server not initialized)",
      );
      expect(failed(report, "transport-concurrent")).toMatch(/^id=\d+: HTTP 400; id=\d+: HTTP 400; id=\d+: HTTP 400$/);
      const reason =
        "not evaluable: the conformant server/discover was itself rejected with -32000 (HTTP 400), so this rejection proves nothing about the injected defect";
      for (const id of ATTRIBUTABLE_REJECTION_IDS) {
        const details = failed(report, id);
        expect(details, id).toContain(reason);
        expect(resultOf(report, id).required, id).toBe(true);
      }
      expect(report.summary.requiredPassed).toBe(0);
      // Nothing was credited, so no "rejected with -32000 (expected ...)" warnings either.
      expect(report.warnings.filter((w) => /^(lifecycle|transport)-/.test(w))).toEqual([]);
    } finally {
      await stub.close();
    }
  });

  it("a header-less request answered by a rate limiter (bare 429) is not evaluable, not 'the wrong status'", async () => {
    // The gateway drops requests without MCP-Protocol-Version on the floor
    // with a bare 429 (and would do the same to a burst); the server behind
    // it never saw the malformed request, so nothing about its header
    // validation was measured.
    const stub = await startStub((req, res, body) => {
      if (req.headers["mcp-protocol-version"] === undefined) {
        res.writeHead(429, { "Content-Type": "text/plain" });
        res.end("rate limited");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(discoverResult(body));
    });
    try {
      const r = await directContext(stub.url, {}, { only: ["transport-header-version-required"] }).run();
      expect(r).toMatchObject({
        passed: false,
        details:
          "not evaluable: HTTP 429 is a transport-level rejection (rate limiting answered before the JSON-RPC layer read the request), so it proves nothing about the injected defect",
      });
      expect(r.warnings).toEqual([]);
    } finally {
      await stub.close();
    }
  });

  /**
   * The four standard-header probes against one stub, each defect drawing
   * the `status` it maps to; every other POST is served. `body` carries the
   * version mismatch in `_meta`, the only defect that is not a header.
   */
  async function headerRejectionStub(status: (defect: "version" | "method") => number) {
    return startStub((req, res, body) => {
      const reject = (code: number) => {
        // No JSON-RPC body at all: what an intermediary answers.
        res.writeHead(code, { "Content-Type": "text/plain" });
        res.end("rejected");
      };
      if (req.headers["mcp-protocol-version"] === undefined) return reject(status("version"));
      if (req.headers["mcp-method"] !== "server/discover") return reject(status("method"));
      if (body.includes("1999-01-01")) return reject(status("version"));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(discoverResult(body));
    });
  }

  it("a bare HTTP 400 passes the SHOULD header tests with a warning and still fails version-mismatch", async () => {
    // streamable-http lets an intermediary reject a request with a status
    // alone, so a 400 with no -32020 is a rejection the tool cannot
    // diagnose: a warning on the three SHOULD tests, but version-mismatch
    // requires the code (basic/index #protocol-version-header) and fails.
    const stub = await headerRejectionStub(() => 400);
    try {
      const run = directContext(stub.url, {}, { only: HEADER_REJECT_IDS });
      const all = await run.all();
      const tolerated = {
        passed: true,
        details: "HTTP 400 with no JSON-RPC error body (expected -32020; reported as a warning)",
      };
      expect(all).toEqual({
        "transport-header-version-required": tolerated,
        "transport-header-method-required": tolerated,
        "transport-header-method-mismatch": tolerated,
        "transport-header-version-mismatch": {
          passed: false,
          details: "HTTP 400 but no JSON-RPC error body (expected -32020 HeaderMismatch)",
        },
      });
      expect(run.warnings()).toEqual(
        [
          "transport-header-version-required",
          "transport-header-method-required",
          "transport-header-method-mismatch",
        ].map(
          (id) =>
            `${id}: server rejected the request with HTTP 400 but no JSON-RPC error body instead of -32020 HeaderMismatch (SHOULD).`,
        ),
      );
    } finally {
      await stub.close();
    }
  });

  it("a rejection that is not HTTP 400 fails every standard-header test naming the status", async () => {
    // 400 is the hard requirement, so a 500 from a handler that crashed on
    // the missing header, or a gateway's 404 / 422, is not a rejection the
    // suite credits -- and not a transport-level status either (those are
    // not evaluable, see the 429 case above).
    const stub = await headerRejectionStub((defect) => (defect === "version" ? 500 : 404));
    try {
      const run = directContext(stub.url, {}, { only: HEADER_REJECT_IDS });
      const all = await run.all();
      const failsWith = (status: number) => ({
        passed: false,
        details: `HTTP ${status}, non-JSON-RPC body (expected HTTP 400)`,
      });
      expect(all).toEqual({
        "transport-header-version-required": failsWith(500),
        "transport-header-version-mismatch": failsWith(500),
        "transport-header-method-required": failsWith(404),
        "transport-header-method-mismatch": failsWith(404),
      });
      expect(run.warnings()).toEqual([]);
    } finally {
      await stub.close();
    }
  });

  it("transport-session-ignored fails when the server serves the result but mints Mcp-Session-Id", async () => {
    const stub = await startStub((_req, res, body) => {
      res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "minted-1" });
      res.end(discoverResult(body));
    });
    try {
      const r = await directContext(stub.url, {}, { only: ["transport-session-ignored"] }).run();
      expect(r.passed).toBe(false);
      expect(r.details).toBe("result served but the response carries Mcp-Session-Id: minted-1 (sessions were removed)");
    } finally {
      await stub.close();
    }
  });

  it("4xx refusals pass with a warning: notification 400, GET 404, DELETE 404", async () => {
    const stub = await startStub((req, res, body) => {
      if (req.method !== "POST") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("not here");
        return;
      }
      if (isNotification(body)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "no notifications" } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(discoverResult(body));
    });
    try {
      const ids = ["transport-notification-202", "transport-get-removed", "transport-delete-removed"];
      const run = directContext(stub.url, {}, { only: ids });
      const all = await run.all();
      expect(all["transport-notification-202"]).toEqual({
        passed: true,
        details: "HTTP 400 (notification refused; permitted, reported as a warning)",
      });
      expect(all["transport-get-removed"]).toEqual({
        passed: true,
        details: "HTTP 404 (GET refused; 405 expected, reported as a warning)",
      });
      expect(all["transport-delete-removed"]).toEqual({
        passed: true,
        details: "HTTP 404 (DELETE refused; 405 expected, reported as a warning)",
      });
      const warnings = run.warnings();
      for (const id of ids)
        expect(
          warnings.some((w) => w.startsWith(`${id}:`)),
          `warning for ${id}`,
        ).toBe(true);
    } finally {
      await stub.close();
    }
  });

  it("transport-get-removed fails when a legacy GET stream is held open past the timeout", async () => {
    const stub = await startStub((req, res, body) => {
      if (req.method === "GET") {
        // Never ends: the legacy standalone SSE stream.
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(": open\n\n");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(discoverResult(body));
    });
    try {
      const r = await directContext(stub.url, {}, { only: ["transport-get-removed"], timeout: 1000 }).run();
      expect(r.passed).toBe(false);
      expect(r.details).toMatch(/^GET did not complete within 1000ms \(.*\); a held-open SSE stream fails$/);
    } finally {
      await stub.close();
    }
  });

  it("transport-batch-reject accepts a JSON-RPC error on 200 and fails a 200 without one", async () => {
    let mode: "error" | "silent" | "array-of-one-error" = "error";
    const rejection = { jsonrpc: "2.0", id: null, error: { code: -32600, message: "no batches" } };
    const stub = await startStub((_req, res, body) => {
      if (body.trimStart().startsWith("[")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          mode === "error"
            ? JSON.stringify(rejection)
            : mode === "array-of-one-error"
              ? JSON.stringify([rejection])
              : JSON.stringify({ jsonrpc: "2.0", id: null, result: { resultType: "complete" } }),
        );
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(discoverResult(body));
    });
    try {
      const withError = await directContext(stub.url, {}, { only: ["transport-batch-reject"] }).run();
      expect(withError).toMatchObject({ passed: true, details: "HTTP 200, JSON-RPC error -32600 (batch rejected)" });
      mode = "silent";
      const without = await directContext(stub.url, {}, { only: ["transport-batch-reject"] }).run();
      expect(without).toMatchObject({
        passed: false,
        details: "HTTP 200 without a JSON-RPC error (expected 4xx or error)",
      });
      // An array reply is the processed-batch shape (JSON-RPC 2.0 answers a
      // rejected batch with a single Response object), even when its one
      // element is an error. The text/event-stream twin is in the next test.
      mode = "array-of-one-error";
      const arrayOfOne = await directContext(stub.url, {}, { only: ["transport-batch-reject"] }).run();
      expect(arrayOfOne).toMatchObject({ passed: false, details: "HTTP 200: server processed the batch (1 replies)" });
    } finally {
      await stub.close();
    }
  });

  it("transport-batch-reject reads a text/event-stream answer by its JSON-RPC responses", async () => {
    const frame = (msg: unknown) => `event: message\ndata: ${JSON.stringify(msg)}\n\n`;
    const rejection = frame({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "no batches" } });
    const progress = frame({
      jsonrpc: "2.0",
      method: "notifications/message",
      params: { level: "info", data: "reading the body" },
    });
    const responses = [99903, 99904].map((id) => ({
      jsonrpc: "2.0",
      id,
      result: { resultType: "complete", supportedVersions: [MODERN_SPEC_VERSION], capabilities: {} },
    }));
    const bodies: Record<string, string> = {
      "one error frame": rejection,
      // The stream MAY carry notifications before the response; before the
      // fix this counted as "processed the batch (2 replies)".
      "a notification, then the error": progress + rejection,
      // Before the fix these three read "server processed the batch (0 replies)".
      "only a priming comment": ": primed\n\n",
      "an empty stream": "",
      "a data frame that is not JSON": "data: not json\n\n",
      // Before the fix: "HTTP 200 without a JSON-RPC error (expected 4xx or error)".
      "only a notification": progress,
      // Parsed JSON that is not an object is not a response either (and must not crash the check).
      "JSON frames that are not objects": "data: null\n\ndata: 42\n\n",
      "a response per element": responses.map(frame).join(""),
      // A JSON-RPC batch answered as one array frame: processed, not "1 non-response message".
      "the batch array in one frame": frame(responses),
      // The same one-element array that fails over application/json (the
      // previous test): an array frame is the processed-batch shape
      // whatever its element says. Before the fix the frame was flattened
      // and this passed as "JSON-RPC error -32600 (batch rejected)".
      "a one-element array frame holding the error": frame([
        { jsonrpc: "2.0", id: 99903, error: { code: -32600, message: "batch element rejected" } },
      ]),
      // Its elements are counted whatever else the stream carries, loose
      // responses included.
      "a notification, then a one-element array frame": progress + frame([responses[0]]),
      "a loose response, then a one-element array frame": frame(responses[0]) + frame([responses[1]]),
    };
    let mode = "";
    const stub = await startStub((_req, res, body) => {
      if (body.trimStart().startsWith("[")) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(bodies[mode]);
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(discoverResult(body));
    });
    try {
      const outcomes: Record<string, { passed: boolean; details: string }> = {};
      for (const name of Object.keys(bodies)) {
        mode = name;
        const { passed, details } = await directContext(stub.url, {}, { only: ["transport-batch-reject"] }).run();
        outcomes[name] = { passed, details };
      }
      const rejected = { passed: true, details: "HTTP 200, JSON-RPC error -32600 (batch rejected)" };
      const nothing = {
        passed: false,
        details: "HTTP 200 text/event-stream with no JSON-RPC message; expected 4xx or a JSON-RPC error",
      };
      const processed = { passed: false, details: "HTTP 200: server processed the batch (2 replies)" };
      expect(outcomes).toEqual({
        "one error frame": rejected,
        "a notification, then the error": rejected,
        "only a priming comment": nothing,
        "an empty stream": nothing,
        "a data frame that is not JSON": nothing,
        "only a notification": {
          passed: false,
          details:
            "HTTP 200 text/event-stream with 1 message(s) but no JSON-RPC response; expected 4xx or a JSON-RPC error",
        },
        "JSON frames that are not objects": {
          passed: false,
          details:
            "HTTP 200 text/event-stream with 2 message(s) but no JSON-RPC response; expected 4xx or a JSON-RPC error",
        },
        "a response per element": processed,
        "the batch array in one frame": processed,
        "a one-element array frame holding the error": {
          passed: false,
          details: "HTTP 200: server processed the batch (1 replies)",
        },
        "a notification, then a one-element array frame": {
          passed: false,
          details: "HTTP 200: server processed the batch (1 replies)",
        },
        "a loose response, then a one-element array frame": processed,
      });
    } finally {
      await stub.close();
    }
  });

  it("transport-content-type fails on a text/html response", async () => {
    const stub = await startStub((_req, res, body) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(discoverResult(body));
    });
    try {
      const r = await directContext(stub.url, {}, { only: ["transport-content-type"] }).run();
      expect(r).toMatchObject({ passed: false, details: "HTTP 200, Content-Type: text/html; charset=utf-8" });
    } finally {
      await stub.close();
    }
  });

  it("transport-content-type accepts a text/event-stream answer, and the result checks read it", async () => {
    // An SSE-default server: every request answered with a one-frame
    // request-scoped stream. Content-Type is the only thing that differs
    // from the clean fixture's application/json.
    const stub = await startStub((_req, res, body) => {
      if (isNotification(body)) {
        res.writeHead(202).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(`event: message\ndata: ${discoverResult(body)}\n\n`);
    });
    try {
      const ids = ["transport-post", "transport-content-type", "transport-concurrent", "transport-session-ignored"];
      expect(await directContext(stub.url, {}, { only: ids }).all()).toEqual({
        "transport-post": { passed: true, details: "HTTP 200" },
        "transport-content-type": { passed: true, details: "HTTP 200, Content-Type: text/event-stream" },
        "transport-concurrent": { passed: true, details: "3 concurrent requests answered with matching ids" },
        "transport-session-ignored": { passed: true, details: "HTTP 200 result, no Mcp-Session-Id on the response" },
      });
    } finally {
      await stub.close();
    }
  });

  it("a server failing with 5xx fails each method / status test naming the status", async () => {
    // Down behind its proxy: POSTs draw 503 with a JSON-RPC error whose
    // message is long and not ASCII, GET and DELETE a bare 500.
    const message = "upstream connect error or disconnect/reset before headers — reset reason: connection failure";
    const stub = await startStub((req, res, body) => {
      if (req.method !== "POST") {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("internal error");
        return;
      }
      if (isNotification(body)) {
        res.writeHead(503, { "Content-Type": "text/plain" });
        res.end("unavailable");
        return;
      }
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(body).id, error: { code: -32603, message } }));
    });
    try {
      const ids = [
        "transport-post",
        "transport-notification-202",
        "transport-concurrent",
        "transport-get-removed",
        "transport-delete-removed",
        "transport-session-ignored",
      ];
      const run = directContext(stub.url, {}, { only: ids });
      expect(await run.all()).toEqual({
        // The server's message, clipped to 80 ASCII characters.
        "transport-post": {
          passed: false,
          details:
            "HTTP 503, JSON-RPC error -32603 (upstream connect error or disconnect/reset before headers ? reset reason: con...)",
        },
        "transport-notification-202": { passed: false, details: "HTTP 503 (expected 202 Accepted)" },
        "transport-concurrent": {
          passed: false,
          details: "id=5001: HTTP 503; id=5002: HTTP 503; id=5003: HTTP 503",
        },
        "transport-get-removed": { passed: false, details: "HTTP 500, Content-Type: text/plain (expected 405)" },
        "transport-delete-removed": { passed: false, details: "HTTP 500 (expected 405)" },
        "transport-session-ignored": { passed: false, details: "HTTP 503, JSON-RPC error -32603 (expected a result)" },
      });
      expect(transportWarningsOf(run.warnings())).toEqual([]);
    } finally {
      await stub.close();
    }
  });

  it("a 2xx without a result fails the checks that need one; a JSON 200 for GET is not a refusal", async () => {
    const stub = await startStub((req, res, body) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.method !== "POST") {
        res.end("{}");
        return;
      }
      res.end(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(body).id, error: { code: -32000, message: "nope" } }));
    });
    try {
      const ids = ["transport-concurrent", "transport-get-removed", "transport-session-ignored"];
      const run = directContext(stub.url, {}, { only: ids });
      expect(await run.all()).toEqual({
        "transport-concurrent": {
          passed: false,
          details: "id=5000: JSON-RPC error -32000; id=5001: JSON-RPC error -32000; id=5002: JSON-RPC error -32000",
        },
        "transport-get-removed": { passed: false, details: "HTTP 200, Content-Type: application/json (expected 405)" },
        "transport-session-ignored": { passed: false, details: "HTTP 200, JSON-RPC error -32000 (expected a result)" },
      });
      expect(transportWarningsOf(run.warnings())).toEqual([]);
    } finally {
      await stub.close();
    }
  });

  it("--only transport-header-name-mismatch fails on a broken resources/list even when prompts/list works", async () => {
    // End to end through the runner, the input the direct-context test
    // above models: resources/list errors, prompts/list lists only a prompt
    // that needs an argument. Before the fix this run graded A / 100.
    const stub = await startStub((_req, res, body) => {
      if (isNotification(body)) {
        res.writeHead(202).end();
        return;
      }
      const msg = JSON.parse(body);
      const reply = (payload: Record<string, unknown>) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...payload }));
      };
      if (msg.method === "server/discover") {
        return reply({
          result: {
            resultType: "complete",
            supportedVersions: [MODERN_SPEC_VERSION],
            capabilities: { resources: {}, prompts: {} },
            ttlMs: 0,
            cacheScope: "public",
          },
        });
      }
      if (msg.method === "resources/list") return reply({ error: { code: -32603, message: "boom" } });
      if (msg.method === "prompts/list") {
        return reply({
          result: {
            resultType: "complete",
            prompts: [{ name: "greet", description: "d", arguments: [{ name: "name", required: true }] }],
            ttlMs: 0,
            cacheScope: "public",
          },
        });
      }
      return reply({ error: { code: -32601, message: "Method not found" } });
    });
    try {
      const report = await runModern(stub.url, { only: ["transport-header-name-mismatch"] });
      expect(failed(report, "transport-header-name-mismatch")).toBe(
        "resources/list failed (JSON-RPC error -32603 (boom)); no resource or prompt to read by name",
      );
      expect(report.score).toBeLessThan(100);
      // With resources-list in the run, that test carries the failure instead.
      const withList = await runModern(stub.url, { only: ["resources-list", "transport-header-name-mismatch"] });
      expect(failed(withList, "resources-list")).toBe("resources/list returned JSON-RPC error -32603 (boom)");
      expect(resultOf(withList, "transport-header-name-mismatch")).toMatchObject({
        passed: true,
        details: "skipped: resources/list failed, no resource or prompt to read by name (see resources-list)",
      });
    } finally {
      await stub.close();
    }
  });

  it("transport-header-case-insensitive fails on a -32020 for lowercase header names", async () => {
    const stub = await startStub((req, res, body) => {
      // Node lowercases req.headers, so emulate a case-sensitive server by
      // looking at the raw header names as sent.
      const raw = req.rawHeaders.filter((_, i) => i % 2 === 0);
      if (!raw.includes("Mcp-Method")) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32020, message: "Mcp-Method missing" } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(discoverResult(body));
    });
    try {
      const r = await directContext(stub.url, {}, { only: ["transport-header-case-insensitive"] }).run();
      expect(r).toMatchObject({
        passed: false,
        details: "HTTP 400, -32020 HeaderMismatch: header names matched case-sensitively",
      });
    } finally {
      await stub.close();
    }
  });
});
