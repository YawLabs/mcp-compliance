import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDefinitionMap } from "../definitions/index.js";
import { createHarness } from "../harness.js";
import { createModernClient } from "../modern/client.js";
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

/** Feature/lifecycle ids whose bodies fill ctx.state so name-mismatch can pick a real resource. */
const STATE_FILLERS = ["lifecycle-discover", "resources-list", "prompts-list"];

function allPass(ids: string[]): Record<string, string> {
  return Object.fromEntries(ids.map((id) => [id, "pass"]));
}

function transportWarnings(report: ComplianceReport): string[] {
  return report.warnings.filter((w) => w.startsWith("transport-"));
}

// ---------------------------------------------------------------------------
// Clean fixture: every test passes over HTTP, none runs over stdio
// ---------------------------------------------------------------------------

describe("modern transport suite: clean fixture over HTTP", () => {
  let fixture: HttpFixture;
  let report: ComplianceReport;

  beforeAll(async () => {
    fixture = await startHttpFixture();
    report = await runModern(fixture.url, { only: [...TRANSPORT_IDS, ...STATE_FILLERS] });
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

  it("name-mismatch reads a real resource when the feature module filled the state, else skip-passes", () => {
    // Until the feature module lands, ctx.state.resources is null and the
    // test skip-passes; once it fills the list the real probe runs. Both
    // shapes are asserted explicitly in the direct-context block below.
    expect(resultOf(report, "transport-header-name-mismatch").details).toMatch(
      /^(resources\/read with Mcp-Name: wrong-name -> HTTP 400, JSON-RPC error -32020 HeaderMismatch|skipped: no name-carrying read-only method available)$/,
    );
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
      discover: null,
      supportedVersions: [MODERN_SPEC_VERSION],
      capabilities: { resources: {}, prompts: {} },
      serverInfo: { name: null, version: null },
      instructions: null,
      tools: null,
      toolNames: [],
      resources: null,
      resourceNames: [],
      resourceTemplates: null,
      prompts: null,
      promptNames: [],
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
    const r = await directContext(clean.url, {
      resources: null,
      prompts: PROMPTS,
      promptNames: ["greet", "simple"],
    }).run();
    expect(r.details).toBe("prompts/get with Mcp-Name: wrong-name -> HTTP 400, JSON-RPC error -32020 HeaderMismatch");
    expect(r.passed).toBe(true);
  });

  it("skip-passes when neither list is available", async () => {
    const r = await directContext(clean.url, {
      resources: null,
      prompts: [{ name: "greet", arguments: [{ name: "name", required: true }] }],
    }).run();
    expect(r).toMatchObject({ passed: true, details: "skipped: no name-carrying read-only method available" });
    const empty = await directContext(clean.url, { resources: [], prompts: [] }).run();
    expect(empty).toMatchObject({ passed: true, details: "skipped: no name-carrying read-only method available" });
  });

  it("accept-header-mismatch: a served read with the wrong Mcp-Name fails", async () => {
    const broken = await startHttpFixture({ breaks: ["accept-header-mismatch"] });
    try {
      const r = await directContext(broken.url, { resources: RESOURCES }).run();
      expect(r.passed).toBe(false);
      expect(r.details).toContain("resources/read with Mcp-Name: wrong-name -> HTTP 200, result (expected HTTP 400)");
      const viaPrompt = await directContext(broken.url, { prompts: PROMPTS }).run();
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
    let mode: "error" | "silent" = "error";
    const stub = await startStub((_req, res, body) => {
      if (body.trimStart().startsWith("[")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          mode === "error"
            ? JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "no batches" } })
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
