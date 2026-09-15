import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runComplianceSuite } from "../runner.js";
import { MODERN_SPEC_VERSION } from "../spec.js";
import {
  acknowledgmentProblem,
  acknowledgmentSurplus,
  evaluateProgress,
  listenFilterFor,
  supportedVersionsNamedIn,
  unsupportedVersionDataProblems,
} from "../suites/modern/lifecycle.js";
import type { ComplianceReport, TestResult, TransportTarget } from "../types.js";
import {
  type HttpFixture,
  LEGACY_ECHO_FIXTURE,
  passedIds,
  resultOf,
  runModern,
  startHttpFixture,
  stdioFixture,
} from "./helpers/modern-fixture.js";

/**
 * The 2026-07-28 lifecycle tests (src/suites/modern/lifecycle.ts), driven
 * through the real runner against the modern fixture over stdio AND HTTP.
 * Every id passes on the clean fixture; then, knob by knob, the fixture is
 * broken and the test that guards that rule is shown to go red. A check
 * that has never been seen failing is a hypothesis. Branches the fixture
 * has no knob for are driven by a node:http stub at the bottom.
 */

/**
 * Report order. The two claim-less _meta probes run LATE (after the
 * feature lists, right before the initialize probe): on a dual-era stdio
 * server they would otherwise re-select the era of the whole process.
 */
const IDS = [
  "lifecycle-discover",
  "lifecycle-discover-versions",
  "lifecycle-discover-caching",
  "lifecycle-jsonrpc",
  "lifecycle-id-match",
  "lifecycle-string-id",
  "lifecycle-capabilities",
  "lifecycle-server-info",
  "lifecycle-instructions",
  "lifecycle-meta-client-capabilities-required",
  "lifecycle-meta-client-info-optional",
  "lifecycle-version-unsupported",
  "lifecycle-removed-methods",
  "lifecycle-capability-handlers-match",
  "lifecycle-subscriptions-listen",
  "lifecycle-meta-tolerance",
  "lifecycle-completions",
  "lifecycle-progress-token",
  "lifecycle-meta-required",
  "lifecycle-meta-protocol-version-required",
  "lifecycle-dual-era",
];

const META_REJECTION_IDS = [
  "lifecycle-meta-required",
  "lifecycle-meta-protocol-version-required",
  "lifecycle-meta-client-capabilities-required",
];

type Kind = "stdio" | "http";
const KINDS: Kind[] = ["stdio", "http"];

const allPass = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, "pass"]));

/** One suite run against a fixture started with `breaks`, filtered to `ids`. */
async function runBroken(
  kind: Kind,
  breaks: string[],
  ids: string[],
  extra: Parameters<typeof runModern>[1] = {},
): Promise<ComplianceReport> {
  if (kind === "stdio") return runModern(stdioFixture({ breaks }).target, { only: ids, ...extra });
  const http = await startHttpFixture({ breaks });
  try {
    return await runModern(http.target, { only: ids, ...extra });
  } finally {
    await http.stop();
  }
}

function expectFailed(report: ComplianceReport, id: string, details?: RegExp) {
  const r = resultOf(report, id);
  expect(r.passed, `${id} should FAIL but passed: ${r.details}`).toBe(false);
  if (details) expect(r.details).toMatch(details);
  return r;
}

function expectPassed(report: ComplianceReport, id: string) {
  const r = resultOf(report, id);
  expect(r.passed, `${id} should pass: ${r.details}`).toBe(true);
  return r;
}

const lifecycleWarnings = (report: ComplianceReport) => report.warnings.filter((w) => w.startsWith("lifecycle-"));

for (const kind of KINDS) {
  describe(`modern lifecycle over ${kind}`, () => {
    let http: HttpFixture | undefined;
    let target: string | TransportTarget;

    beforeAll(async () => {
      if (kind === "http") {
        http = await startHttpFixture();
        target = http.target;
      } else {
        target = stdioFixture().target;
      }
    });

    afterAll(async () => {
      await http?.stop();
    });

    it("passes every lifecycle test on the clean fixture, in catalog order with the claim-less probes late", async () => {
      const report = await runModern(target, { only: IDS });
      expect(passedIds(report, IDS)).toEqual(allPass(IDS));
      expect(report.tests.map((t) => t.id)).toEqual(IDS);
      expect(lifecycleWarnings(report)).toEqual([]);
      expect(report.serverInfo.name).toBe("modern-fixture");
      expect(report.serverInfo.version).toBe("0.0.1");
      expect(report.serverInfo.protocolVersion).toBe("2026-07-28");
      expect(Object.keys(report.serverInfo.capabilities ?? {})).toEqual([
        "tools",
        "resources",
        "prompts",
        "completions",
      ]);
      // The initialize probe is informational: modern-only, and the fixture
      // names its version in the message (it sends no data.supported). On
      // stdio the probe went to a fresh child, and says so.
      expect(resultOf(report, "lifecycle-dual-era").details).toBe(
        kind === "http"
          ? "modern-only: initialize rejected with -32601 (HTTP 404); message names supported versions"
          : "modern-only: initialize rejected with -32601 on a fresh process; message names supported versions",
      );
      expect(resultOf(report, "lifecycle-subscriptions-listen").details).toMatch(/^Acknowledged subscription/);
      expect(resultOf(report, "lifecycle-removed-methods").details).toMatch(/^ping -32601/);
      // A lifecycle-only run still measures the server: the feature lists
      // are fetched on demand, so progress and completions probe real
      // tools / prompts instead of skipping.
      expect(resultOf(report, "lifecycle-progress-token").details).toMatch(
        /^3 notifications\/progress echoed token "compliance-progress-1" with increasing progress \(1, 2, 3\)$/,
      );
      expect(resultOf(report, "lifecycle-completions").details).toBe(
        'Returned 2 completion(s) for prompt "greet" argument "name"',
      );
      // The late claim-less probes drew the code the spec requires, cleanly.
      expect(resultOf(report, "lifecycle-meta-required").details).toBe(
        `server/discover without _meta: rejected with -32602${kind === "http" ? " (HTTP 400)" : ""}`,
      );
    });

    it("--only lifecycle (the category) exercises the same real probes", async () => {
      const report = await runModern(target, { only: ["lifecycle"] });
      // The category also owns the post-hoc log-level check (posthoc.ts).
      expect(report.tests.map((t) => t.id)).toEqual([...IDS, "lifecycle-log-level-gating"]);
      expect(passedIds(report, IDS)).toEqual(allPass(IDS));
      expect(resultOf(report, "lifecycle-progress-token").details).toMatch(/^3 notifications\/progress echoed token/);
      expect(resultOf(report, "lifecycle-completions").details).toMatch(
        /^Returned 2 completion\(s\) for prompt "greet"/,
      );
      // The lists were fetched once for the run and published to the report.
      expect(report.toolCount).toBe(11);
      expect(report.promptCount).toBe(2);
    });

    it("no-discover: every test that reads the DiscoverResult fails, and no rejection is attributable", async () => {
      const report = await runBroken(kind, ["no-discover"], IDS);
      expectFailed(report, "lifecycle-discover", /JSON-RPC error -32601/);
      expectFailed(report, "lifecycle-discover-versions");
      expectFailed(report, "lifecycle-discover-caching");
      expectFailed(report, "lifecycle-capabilities");
      expectFailed(report, "lifecycle-server-info");
      expectFailed(report, "lifecycle-instructions");
      expectFailed(report, "lifecycle-capability-handlers-match", /capability declarations unknown/);
      // A well-formed error envelope is still valid JSON-RPC with the id echoed.
      expectPassed(report, "lifecycle-jsonrpc");
      expectPassed(report, "lifecycle-id-match");
      // The server rejects the CONFORMANT discover with -32601 too, so a
      // rejection of the malformed variants proves nothing: not evaluable.
      const status = kind === "http" ? " (HTTP 404)" : "";
      for (const id of META_REJECTION_IDS) {
        expectFailed(
          report,
          id,
          new RegExp(
            `^server/discover without _meta[a-zA-Z ]*: not evaluable: the conformant server/discover was itself rejected with -32601${status.replace(/[()]/g, "\\$&")}, so this rejection proves nothing about the injected defect$`,
          ),
        );
      }
      expect(lifecycleWarnings(report).filter((w) => w.startsWith("lifecycle-meta-"))).toEqual([]);
      // No capabilities -> completions is gated out of the report entirely.
      expect(report.tests.some((t) => t.id === "lifecycle-completions")).toBe(false);
      expect(report.serverInfo.protocolVersion).toBeNull();
    });

    it("discover-missing-versions: discover and versions fail", async () => {
      const report = await runBroken(
        kind,
        ["discover-missing-versions"],
        ["lifecycle-discover", "lifecycle-discover-versions", "lifecycle-version-unsupported"],
      );
      expectFailed(report, "lifecycle-discover", /supportedVersions is undefined/);
      expectFailed(report, "lifecycle-discover-versions", /missing or empty/);
      // Subset check is skipped when the discover list is unknown; -32022 itself is still right.
      expectPassed(report, "lifecycle-version-unsupported");
    });

    it("no-caching / bad-caching: discover-caching fails", async () => {
      const missing = await runBroken(kind, ["no-caching"], ["lifecycle-discover-caching"]);
      expectFailed(missing, "lifecycle-discover-caching", /ttlMs missing.*cacheScope missing/);
      const bad = await runBroken(kind, ["bad-caching"], ["lifecycle-discover-caching"]);
      expectFailed(bad, "lifecycle-discover-caching", /ttlMs -1.*cacheScope "shared"/);
    });

    it("no-server-info: server-info fails and the report has no name", async () => {
      const report = await runBroken(kind, ["no-server-info"], ["lifecycle-server-info", "lifecycle-discover"]);
      expectFailed(report, "lifecycle-server-info", /No _meta\["io.modelcontextprotocol\/serverInfo"\]/);
      expectPassed(report, "lifecycle-discover");
      expect(report.serverInfo.name).toBeNull();
    });

    it("accept-missing-meta: the three _meta rejection tests fail on a served result", async () => {
      const ids = [...META_REJECTION_IDS, "lifecycle-meta-client-info-optional"];
      const report = await runBroken(kind, ["accept-missing-meta"], ids);
      expectFailed(report, "lifecycle-meta-required", /server returned a result/);
      expectFailed(report, "lifecycle-meta-protocol-version-required", /server returned a result/);
      expectFailed(report, "lifecycle-meta-client-capabilities-required", /server returned a result/);
      // Leniency does not break the optional-clientInfo rule.
      expectPassed(report, "lifecycle-meta-client-info-optional");
    });

    it("meta-error-wrong-code: a -32600 rejection of the malformed _meta passes each rejection test with a warning", async () => {
      const report = await runBroken(kind, ["meta-error-wrong-code"], META_REJECTION_IDS);
      const status = kind === "http" ? " (HTTP 400)" : "";
      expect(expectPassed(report, "lifecycle-meta-required").details).toBe(
        `server/discover without _meta: rejected with -32600${status}, expected -32602 (see warning)`,
      );
      expect(expectPassed(report, "lifecycle-meta-protocol-version-required").details).toBe(
        `server/discover without _meta protocolVersion: rejected with -32600${status}, expected -32602 (see warning)`,
      );
      expect(expectPassed(report, "lifecycle-meta-client-capabilities-required").details).toBe(
        `server/discover without _meta clientCapabilities: rejected with -32600${status}, expected -32602 (see warning)`,
      );
      // Report order: the clientCapabilities probe runs early, the two claim-less probes late.
      expect(lifecycleWarnings(report)).toEqual([
        'lifecycle-meta-client-capabilities-required: server/discover without _meta clientCapabilities was rejected with -32600 (Invalid Request: params._meta["io.modelcontextprotocol/cl...) (expected -32602)',
        "lifecycle-meta-required: server/discover without _meta was rejected with -32600 (Invalid Request: params._meta is required) (expected -32602)",
        'lifecycle-meta-protocol-version-required: server/discover without _meta protocolVersion was rejected with -32600 (Invalid Request: params._meta["io.modelcontextprotocol/pr...) (expected -32602)',
      ]);
    });

    it("accept-any-version: version-unsupported fails when the unsupported version is served", async () => {
      const report = await runBroken(
        kind,
        ["accept-any-version"],
        ["lifecycle-discover", "lifecycle-version-unsupported"],
      );
      expectPassed(report, "lifecycle-discover");
      expect(expectFailed(report, "lifecycle-version-unsupported").details).toBe(
        `server/discover declaring protocol version 1999-01-01 was served (result)${kind === "http" ? " (HTTP 200)" : ""}; expected -32022`,
      );
    });

    it("boolean-capability: capabilities fails, and the boolean reads as undeclared instead of crashing a gate", async () => {
      const report = await runBroken(
        kind,
        ["boolean-capability"],
        [
          "lifecycle-discover",
          "lifecycle-capabilities",
          "lifecycle-capability-handlers-match",
          "lifecycle-progress-token",
          "tools-list",
        ],
      );
      // The envelope is still an object, so discover itself passes.
      expectPassed(report, "lifecycle-discover");
      expect(expectFailed(report, "lifecycle-capabilities").details).toBe(
        "Declared capabilities must be objects: tools is boolean",
      );
      // `tools: true` declares nothing: the tool-gated tests skip or drop out...
      expect(expectPassed(report, "lifecycle-progress-token").details).toBe("skipped: server declares no tools");
      expect(report.tests.some((t) => t.id === "tools-list")).toBe(false);
      // ...and the fixture still serves tools/list, which the handlers check sees as undeclared-but-served.
      expectFailed(
        report,
        "lifecycle-capability-handlers-match",
        /^tools: not declared but tools\/list returned a result/,
      );
    });

    it("completion-rejects-argument / completion-no-values: completions fails on a listed prompt argument", async () => {
      const source = 'prompt "greet" argument "name"';
      const rejected = await runBroken(kind, ["completion-rejects-argument"], ["lifecycle-completions"]);
      // InvalidParams is acceptable only for the placeholder probe, never for a real listed argument.
      const r = expectFailed(rejected, "lifecycle-completions");
      expect(r.details).toBe(
        `completion/complete for ${source}: JSON-RPC error -32602 (Invalid params: cannot complete argument "name")${kind === "http" ? " (HTTP 400)" : ""}`,
      );
      expect(r.required).toBe(true);
      const noValues = await runBroken(kind, ["completion-no-values"], ["lifecycle-completions"]);
      expect(expectFailed(noValues, "lifecycle-completions").details).toBe(
        `completion/complete for ${source}: result has no completion.values array`,
      );
    });

    it("prompts-list-error: completions still completes the listed template variable", async () => {
      // --only: prompts-list is filtered out, yet a real template argument is measured, so no list verdict is needed.
      const report = await runBroken(kind, ["prompts-list-error"], ["lifecycle-completions"]);
      expect(expectPassed(report, "lifecycle-completions").details).toBe(
        'Returned 0 completion(s) for resource template "test://template/{id}/data" variable "id"',
      );
    });

    it("prompts-list-error + templates-list-error: completions reports the failed lists instead of probing a placeholder", async () => {
      const breaks = ["prompts-list-error", "templates-list-error"];
      const prompts = "prompts/list failed (JSON-RPC error -32603 (Internal error: prompt store unavailable))";
      const templates =
        "resources/templates/list failed (JSON-RPC error -32603 (Internal error: resource template store unavailable))";
      const what = "no prompt or template argument to complete";
      // Neither owning list test in the run: nothing else names the broken lists.
      const alone = await runBroken(kind, breaks, ["lifecycle-completions"]);
      expect(expectFailed(alone, "lifecycle-completions").details).toBe(`${prompts} and ${templates}; ${what}`);
      // prompts-list reports its own failure; the filtered-out templates list is still named here.
      const withPrompts = await runBroken(kind, breaks, ["prompts-list", "lifecycle-completions"]);
      expectFailed(withPrompts, "prompts-list");
      expect(expectFailed(withPrompts, "lifecycle-completions").details).toBe(`${templates}; ${what}`);
      // Both owning tests in the run: each failure is reported once, there.
      const both = await runBroken(kind, breaks, ["prompts-list", "resources-templates", "lifecycle-completions"]);
      expectFailed(both, "prompts-list");
      expectFailed(both, "resources-templates");
      expect(expectPassed(both, "lifecycle-completions").details).toBe(
        `skipped: prompts/list and resources/templates/list failed, ${what} (see prompts-list, resources-templates)`,
      );
    });

    it("wrong-version-error / version-error-no-data: version-unsupported fails", async () => {
      const wrongCode = await runBroken(kind, ["wrong-version-error"], ["lifecycle-version-unsupported"]);
      expectFailed(wrongCode, "lifecycle-version-unsupported", /rejected with -32602.*expected -32022/);
      const noData = await runBroken(kind, ["version-error-no-data"], ["lifecycle-version-unsupported"]);
      expectFailed(
        noData,
        "lifecycle-version-unsupported",
        /data\.supported missing or empty.*data\.requested missing/,
      );
    });

    it("removed-methods-served: removed-methods fails when a legacy method returns a result", async () => {
      const report = await runBroken(kind, ["removed-methods-served"], ["lifecycle-removed-methods"]);
      expectFailed(
        report,
        "lifecycle-removed-methods",
        /ping: served \(result\).*logging\/setLevel: served.*resources\/subscribe: served/,
      );
    });

    it("capabilities-mismatch: an undeclared prompts/list that succeeds fails the handlers check", async () => {
      const report = await runBroken(
        kind,
        ["capabilities-mismatch"],
        ["lifecycle-capability-handlers-match", "lifecycle-subscriptions-listen"],
      );
      expectFailed(
        report,
        "lifecycle-capability-handlers-match",
        /prompts: not declared but prompts\/list returned a result/,
      );
      // tools.listChanged is still advertised, so the listen stream is still acknowledged.
      expectPassed(report, "lifecycle-subscriptions-listen");
    });

    it("no-listen-ack / listen-untagged: subscriptions-listen fails", async () => {
      const noAck = await runBroken(kind, ["no-listen-ack"], ["lifecycle-subscriptions-listen"]);
      expectFailed(noAck, "lifecycle-subscriptions-listen", /First frame .* was notifications\/tools\/list_changed/);
      const untagged = await runBroken(kind, ["listen-untagged"], ["lifecycle-subscriptions-listen"]);
      expectFailed(
        untagged,
        "lifecycle-subscriptions-listen",
        /subscriptionId undefined does not equal the listen request id/,
      );
    });

    it("wrong-id-type: a numeric id echoed as a string fails id-match and the envelope check", async () => {
      // On stdio a retyped id never resolves the pending request, so the
      // check fails by timeout; keep the budget short to keep the file fast.
      const report = await runBroken(kind, ["wrong-id-type"], ["lifecycle-id-match", "lifecycle-jsonrpc"], {
        timeout: 1500,
        startupTimeout: 1500,
      });
      expectFailed(
        report,
        "lifecycle-id-match",
        kind === "http" ? /\(string\): MISMATCH/ : /no response matched request id/,
      );
      expectFailed(report, "lifecycle-jsonrpc", kind === "http" ? /does not echo request id/ : /no response/);
    });

    it("initialize-ok: the dual-era probe reports a served legacy handshake and the suite warns", async () => {
      const report = await runBroken(kind, ["initialize-ok"], ["lifecycle-dual-era", "lifecycle-discover-versions"]);
      expect(expectPassed(report, "lifecycle-dual-era").details).toBe(
        `dual-era: initialize answered with protocolVersion 2025-11-25${kind === "stdio" ? " on a fresh process" : ""}; legacy handshake served alongside 2026-07-28`,
      );
      expectPassed(report, "lifecycle-discover-versions");
      expect(report.warnings.some((w) => w.startsWith("Server is dual-era"))).toBe(true);
    });

    it("initialize-vague: a rejection that names no version passes with a warning", async () => {
      const report = await runBroken(kind, ["initialize-vague"], ["lifecycle-dual-era"]);
      expect(expectPassed(report, "lifecycle-dual-era").details).toMatch(
        /^modern-only: initialize rejected with -32601.*\(see warning\)$/,
      );
      expect(lifecycleWarnings(report)).toEqual([
        expect.stringMatching(
          /^lifecycle-dual-era: initialize rejected with -32601 but neither the message nor data\.supported names a supported protocol version \(spec SHOULD\)/,
        ),
      ]);
    });
  });
}

describe("modern lifecycle over http only", () => {
  it("unknown-method-200: removed methods answered -32601 on HTTP 200 pass with a warning", async () => {
    const report = await runBroken("http", ["unknown-method-200"], ["lifecycle-removed-methods"]);
    expect(expectPassed(report, "lifecycle-removed-methods").details).toMatch(/^ping -32601\/200, .*\(see warnings\)$/);
    expect(lifecycleWarnings(report)).toEqual([
      "lifecycle-removed-methods: ping answered -32601 with HTTP 200 (expected 404)",
      "lifecycle-removed-methods: logging/setLevel answered -32601 with HTTP 200 (expected 404)",
      "lifecycle-removed-methods: resources/subscribe answered -32601 with HTTP 200 (expected 404)",
    ]);
  });

  it("http status codes are reported on the rejection tests", async () => {
    const http = await startHttpFixture();
    try {
      const report = await runModern(http.target, {
        only: ["lifecycle-meta-required", "lifecycle-version-unsupported", "lifecycle-removed-methods"],
      });
      expect(resultOf(report, "lifecycle-meta-required").details).toBe(
        "server/discover without _meta: rejected with -32602 (HTTP 400)",
      );
      expect(resultOf(report, "lifecycle-version-unsupported").details).toMatch(
        /^-32022 \(HTTP 400\); data\.supported \[2026-07-28\]/,
      );
      expect(resultOf(report, "lifecycle-removed-methods").details).toBe(
        "ping -32601/404, logging/setLevel -32601/404, resources/subscribe -32601/404",
      );
    } finally {
      await http.stop();
    }
  });
});

describe("a legacy-only server pinned to 2026-07-28 (echo fixture over stdio)", () => {
  const target: TransportTarget = { type: "stdio", command: process.execPath, args: [LEGACY_ECHO_FIXTURE] };

  it("fails the _meta rejection tests as not evaluable instead of crediting its blanket -32601", async () => {
    const report = await runModern(target, { only: ["lifecycle-discover", ...META_REJECTION_IDS] });
    expectFailed(report, "lifecycle-discover", /JSON-RPC error -32601/);
    for (const id of META_REJECTION_IDS) {
      expectFailed(
        report,
        id,
        /: not evaluable: the conformant server\/discover was itself rejected with -32601, so this rejection proves nothing about the injected defect$/,
      );
    }
    // No "rejected with -32601 (expected -32602)" warning either: nothing was credited.
    expect(lifecycleWarnings(report)).toEqual([]);
    expect(report.summary.requiredPassed).toBe(0);
  });

  it("fails subscriptions-listen as not evaluable too, instead of crediting the blanket rejection", async () => {
    const report = await runModern(target, {
      only: ["lifecycle-discover", "lifecycle-removed-methods", "lifecycle-subscriptions-listen"],
    });
    // A legacy server serves ping: a real "served" failure, whatever the discover state.
    expectFailed(report, "lifecycle-removed-methods", /^ping: served \(result\)/);
    expectFailed(
      report,
      "lifecycle-subscriptions-listen",
      /^subscriptions\/listen rejected with -32601; not evaluable: the conformant server\/discover was itself rejected with -32601/,
    );
    // Nothing was credited, so no "rejected with X (expected -32601)" warnings either.
    expect(lifecycleWarnings(report)).toEqual([]);
  });

  it("reports the served initialize as legacy-only, not dual-era, and warns accordingly", async () => {
    const report = await runModern(target, { only: ["lifecycle-discover", "lifecycle-dual-era"] });
    expectFailed(report, "lifecycle-discover", /JSON-RPC error -32601/);
    expect(expectPassed(report, "lifecycle-dual-era").details).toBe(
      "legacy-only: initialize answered with protocolVersion 2025-11-25 on a fresh process but server/discover was rejected; only the legacy handshake is served (see warning)",
    );
    expect(report.warnings.some((w) => w.startsWith("Server is dual-era"))).toBe(false);
    expect(report.warnings).toContain(
      "Server is legacy-only (served the 2025-11-25 initialize handshake but rejected server/discover); this run graded 2026-07-28, so most of its tests are not evaluable. Re-run with --spec-version 2025-11-25 (or auto) to grade the era it speaks.",
    );
  });
});

// ---------------------------------------------------------------------------
// Stub servers for the branches the fixture has no knob for
// ---------------------------------------------------------------------------

type StubReply = { status: number; body: unknown } | { sse: unknown[] };
type StubRoute = (method: string, msg: Record<string, any>) => StubReply;

/** A minimal 2026-07-28 HTTP server: `route` answers each POST by method. */
async function startModernStub(route: StubRoute): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let text = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      text += chunk;
    });
    req.on("end", () => {
      let msg: Record<string, any> = {};
      try {
        msg = JSON.parse(text);
      } catch {}
      if (msg.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const reply = route(String(msg.method), msg);
      if ("sse" in reply) {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        for (const frame of reply.sse) res.write(`event: message\ndata: ${JSON.stringify(frame)}\n\n`);
        // Held open until the client closes, like a real listen stream.
        req.on("close", () => res.end());
        return;
      }
      res.writeHead(reply.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
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

const SUB = "io.modelcontextprotocol/subscriptionId";

/** `capabilities` is untyped so a stub can serve a malformed one. */
function discoverReply(id: unknown, capabilities: unknown): StubReply {
  return {
    status: 200,
    body: {
      jsonrpc: "2.0",
      id,
      result: {
        resultType: "complete",
        supportedVersions: ["2026-07-28"],
        capabilities,
        ttlMs: 0,
        cacheScope: "public",
        _meta: { "io.modelcontextprotocol/serverInfo": { name: "stub", version: "0" } },
      },
    },
  };
}

const notFound = (id: unknown, method: string): StubReply => ({
  status: 404,
  body: { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } },
});

describe("lifecycle-subscriptions-listen: an acknowledgment that honours more than was requested", () => {
  it("passes with a warning naming the surplus entries", async () => {
    const stub = await startModernStub((method, msg) => {
      if (method === "server/discover") return discoverReply(msg.id, { tools: { listChanged: true } });
      if (method === "subscriptions/listen") {
        return {
          sse: [
            {
              jsonrpc: "2.0",
              method: "notifications/subscriptions/acknowledged",
              params: {
                _meta: { [SUB]: msg.id },
                notifications: { toolsListChanged: true, promptsListChanged: true, resourceSubscriptions: ["x://y"] },
              },
            },
          ],
        };
      }
      return notFound(msg.id, method);
    });
    try {
      const report = await runModern(stub.url, { only: ["lifecycle-subscriptions-listen"] });
      const r = expectPassed(report, "lifecycle-subscriptions-listen");
      expect(r.details).toMatch(/^Acknowledged subscription \d+ first; honoured .* \(see warning\)$/);
      expect(lifecycleWarnings(report)).toEqual([
        'lifecycle-subscriptions-listen: acknowledgment honours promptsListChanged: true (not requested), resourceSubscriptions "x://y" (not requested); the listen request did not ask for that, so the server may send notifications outside the requested filter',
      ]);
    } finally {
      await stub.close();
    }
  });
});

describe("lifecycle-dual-era: where a rejected initialize names the supported versions", () => {
  const rejectInitialize = (error: Record<string, unknown>) =>
    startModernStub((method, msg) => {
      if (method === "server/discover") return discoverReply(msg.id, {});
      if (method === "initialize") return { status: 400, body: { jsonrpc: "2.0", id: msg.id, error } };
      return notFound(msg.id, method);
    });

  it("a message that only echoes the requested 2025-11-25 names nothing: warning", async () => {
    const stub = await rejectInitialize({ code: -32022, message: "Unsupported protocol version: 2025-11-25" });
    try {
      const report = await runModern(stub.url, { only: ["lifecycle-dual-era"] });
      expect(expectPassed(report, "lifecycle-dual-era").details).toBe(
        "modern-only: initialize rejected with -32022 (HTTP 400) (see warning)",
      );
      expect(lifecycleWarnings(report)).toEqual([
        'lifecycle-dual-era: initialize rejected with -32022 but neither the message nor data.supported names a supported protocol version (spec SHOULD): "Unsupported protocol version: 2025-11-25"',
      ]);
    } finally {
      await stub.close();
    }
  });

  it("the spec's own UnsupportedProtocolVersionError shape (dateless message, data.supported) satisfies the SHOULD", async () => {
    const stub = await rejectInitialize({
      code: -32022,
      message: "Unsupported protocol version",
      data: { supported: ["2026-07-28"], requested: "2025-11-25" },
    });
    try {
      const report = await runModern(stub.url, { only: ["lifecycle-dual-era"] });
      expect(expectPassed(report, "lifecycle-dual-era").details).toBe(
        "modern-only: initialize rejected with -32022 (HTTP 400); data.supported names supported versions",
      );
      expect(lifecycleWarnings(report)).toEqual([]);
    } finally {
      await stub.close();
    }
  });
});

describe("supportedVersionsNamedIn (the lifecycle-dual-era SHOULD)", () => {
  it("credits data.supported, a message date other than the requested one, or both", () => {
    expect(supportedVersionsNamedIn({ message: "Unsupported protocol version: 2025-11-25" })).toBeNull();
    expect(supportedVersionsNamedIn({ message: "initialize is not supported" })).toBeNull();
    expect(supportedVersionsNamedIn({ message: "nope", data: { supported: [] } })).toBeNull();
    expect(supportedVersionsNamedIn({ message: "nope", data: { supported: [20260728] } })).toBeNull();
    expect(supportedVersionsNamedIn({ message: "nope", data: { supported: "2026-07-28" } })).toBeNull();
    expect(supportedVersionsNamedIn({ message: "This server speaks MCP 2026-07-28" })).toBe(
      "message names supported versions",
    );
    expect(supportedVersionsNamedIn({ message: "nope", data: { supported: ["2026-07-28"] } })).toBe(
      "data.supported names supported versions",
    );
    expect(
      supportedVersionsNamedIn({
        message: "Unsupported 2025-11-25; use 2026-07-28",
        data: { supported: ["2026-07-28"] },
      }),
    ).toBe("message and data.supported name supported versions");
    // The version the probe requested is configurable; a message naming only it still names nothing.
    expect(supportedVersionsNamedIn({ message: "not 2030-01-01" }, "2030-01-01")).toBeNull();
  });
});

describe("evaluateProgress (the rule lifecycle-progress-token applies to observed notifications)", () => {
  const note = (progressToken: unknown, progress: unknown) => ({
    jsonrpc: "2.0",
    method: "notifications/progress",
    params: { progressToken, progress, total: 3 },
  });

  it("accepts an empty observation and a strictly increasing echoed sequence", () => {
    expect(evaluateProgress("tok", [])).toEqual({ ok: true, values: [] });
    expect(evaluateProgress("tok", [note("tok", 0.5), note("tok", 1), note("tok", 3)])).toEqual({
      ok: true,
      values: [0.5, 1, 3],
    });
    expect(evaluateProgress(7, [note(7, 1)])).toEqual({ ok: true, values: [1] });
  });

  it("rejects a foreign token, a retyped token, a non-numeric progress and a non-increasing value", () => {
    expect(evaluateProgress("tok", [note("other", 1)]).problem).toMatch(/carries token "other", expected "tok"/);
    expect(evaluateProgress(7, [note("7", 1)]).problem).toMatch(/carries token "7", expected 7/);
    expect(evaluateProgress("tok", [note("tok", "1")]).problem).toMatch(/progress "1" is not a number/);
    expect(evaluateProgress("tok", [note("tok", 1), note("tok", 1)]).problem).toBe(
      "progress did not increase (1 -> 1)",
    );
    expect(evaluateProgress("tok", [note("tok", 2), note("tok", 1)]).problem).toBe(
      "progress did not increase (2 -> 1)",
    );
    expect(evaluateProgress("tok", [{ jsonrpc: "2.0", method: "notifications/progress" }]).problem).toMatch(
      /without a params object/,
    );
  });
});

describe("unsupportedVersionDataProblems (lifecycle-version-unsupported data rules)", () => {
  const KNOWN = ["2026-07-28", "2025-11-25"];

  it("accepts a subset of the discover list with the requested version echoed", () => {
    expect(
      unsupportedVersionDataProblems({ supported: ["2026-07-28"], requested: "1999-01-01" }, "1999-01-01", KNOWN),
    ).toEqual([]);
    expect(unsupportedVersionDataProblems({ supported: KNOWN, requested: "1999-01-01" }, "1999-01-01", KNOWN)).toEqual(
      [],
    );
    // Discover list unknown (discover failed): only the shape is checked.
    expect(
      unsupportedVersionDataProblems({ supported: ["2030-01-01"], requested: "1999-01-01" }, "1999-01-01", []),
    ).toEqual([]);
  });

  it("rejects a superset, a non-string entry, an empty or missing list and a wrong requested echo", () => {
    expect(
      unsupportedVersionDataProblems(
        { supported: ["2026-07-28", "2030-01-01"], requested: "1999-01-01" },
        "1999-01-01",
        KNOWN,
      ),
    ).toEqual([
      "data.supported [2026-07-28, 2030-01-01] is not a subset of supportedVersions [2026-07-28, 2025-11-25]: 2030-01-01",
    ]);
    expect(
      unsupportedVersionDataProblems({ supported: [20260728], requested: "1999-01-01" }, "1999-01-01", KNOWN),
    ).toEqual(["data.supported [20260728] is not a subset of supportedVersions [2026-07-28, 2025-11-25]: 20260728"]);
    expect(unsupportedVersionDataProblems({ supported: [], requested: "1999-01-01" }, "1999-01-01", KNOWN)).toEqual([
      "data.supported missing or empty",
    ]);
    expect(unsupportedVersionDataProblems(undefined, "1999-01-01", KNOWN)).toEqual([
      "data.supported missing or empty",
      'data.requested missing (expected "1999-01-01")',
    ]);
    expect(
      unsupportedVersionDataProblems({ supported: ["2026-07-28"], requested: "2026-07-28" }, "1999-01-01", KNOWN),
    ).toEqual(['data.requested "2026-07-28" (expected "1999-01-01")']);
  });
});

describe("acknowledgmentProblem (the first frame lifecycle-subscriptions-listen accepts)", () => {
  const ack = (subscriptionId: unknown, notifications: unknown = {}) => ({
    jsonrpc: "2.0",
    method: "notifications/subscriptions/acknowledged",
    params: { _meta: { [SUB]: subscriptionId }, notifications },
  });

  it("accepts an ack whose subscriptionId equals the request id with the same JSON type", () => {
    expect(acknowledgmentProblem(ack(1001, { toolsListChanged: true }), 1001)).toBeUndefined();
    expect(acknowledgmentProblem(ack("listen-1"), "listen-1")).toBeUndefined();
  });

  it("rejects another notification first, a retyped or missing subscriptionId, and a missing filter", () => {
    expect(acknowledgmentProblem({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }, 1001)).toMatch(
      /^First frame .* was notifications\/tools\/list_changed/,
    );
    expect(acknowledgmentProblem(ack("1001"), 1001)).toBe(
      'Acknowledgment _meta subscriptionId "1001" does not equal the listen request id 1001',
    );
    expect(acknowledgmentProblem(ack(1002), 1001)).toMatch(
      /subscriptionId 1002 does not equal the listen request id 1001/,
    );
    expect(acknowledgmentProblem({ jsonrpc: "2.0", method: "notifications/subscriptions/acknowledged" }, 1001)).toMatch(
      /subscriptionId undefined does not equal/,
    );
    const noFilter = {
      jsonrpc: "2.0",
      method: "notifications/subscriptions/acknowledged",
      params: { _meta: { [SUB]: 1001 } },
    };
    expect(acknowledgmentProblem(noFilter, 1001)).toBe(
      "Acknowledgment has no notifications object naming the honoured filter",
    );
    expect(acknowledgmentProblem(ack(1001, ["toolsListChanged"]), 1001)).toMatch(/no notifications object/);
  });
});

describe("acknowledgmentSurplus (what an ack honours beyond the requested filter)", () => {
  const requested = { toolsListChanged: true, resourceSubscriptions: ["a://b"] };

  it("is empty for a subset, an equal set, and explicit false", () => {
    expect(acknowledgmentSurplus({}, requested)).toEqual([]);
    expect(acknowledgmentSurplus({ toolsListChanged: true }, requested)).toEqual([]);
    expect(acknowledgmentSurplus({ toolsListChanged: true, resourceSubscriptions: ["a://b"] }, requested)).toEqual([]);
    expect(acknowledgmentSurplus({ toolsListChanged: false, promptsListChanged: false }, requested)).toEqual([]);
    expect(acknowledgmentSurplus({ resourceSubscriptions: [] }, requested)).toEqual([]);
  });

  it("names a true boolean, a URI, or a mistyped value the request did not include", () => {
    expect(
      acknowledgmentSurplus(
        { toolsListChanged: true, promptsListChanged: true, resourceSubscriptions: ["a://b", "x://y"] },
        requested,
      ),
    ).toEqual(["promptsListChanged: true (not requested)", 'resourceSubscriptions "x://y" (not requested)']);
    expect(acknowledgmentSurplus({ toolsListChanged: "yes", bogus: 1 }, requested)).toEqual([
      'toolsListChanged: "yes" (expected a boolean)',
      "bogus: 1 (expected a boolean)",
    ]);
    expect(acknowledgmentSurplus({ resourceSubscriptions: "a://b" }, requested)).toEqual([
      'resourceSubscriptions "a://b" (expected an array of URIs)',
    ]);
    // Nothing requested at all: any true is surplus.
    expect(acknowledgmentSurplus({ resourcesListChanged: true }, {})).toEqual([
      "resourcesListChanged: true (not requested)",
    ]);
  });
});

describe("listenFilterFor (what lifecycle-subscriptions-listen requests)", () => {
  it("requests every advertised listChanged and counts resources.subscribe as advertised", () => {
    expect(listenFilterFor({})).toEqual({ filter: {}, advertised: [] });
    expect(listenFilterFor({ tools: {}, prompts: { listChanged: false }, resources: { listChanged: "yes" } })).toEqual({
      filter: {},
      advertised: [],
    });
    expect(
      listenFilterFor({
        tools: { listChanged: true },
        prompts: { listChanged: true },
        resources: { listChanged: true, subscribe: true },
      }),
    ).toEqual({
      filter: { toolsListChanged: true, promptsListChanged: true, resourcesListChanged: true },
      advertised: ["tools.listChanged", "prompts.listChanged", "resources.listChanged", "resources.subscribe"],
    });
    expect(listenFilterFor({ resources: { subscribe: true } })).toEqual({
      filter: {},
      advertised: ["resources.subscribe"],
    });
    // A boolean where an object is expected never counts as advertising anything.
    expect(listenFilterFor({ tools: true })).toEqual({ filter: {}, advertised: [] });
  });
});

// ---------------------------------------------------------------------------
// Attribution of rejections: transport-level statuses and the security burst
// ---------------------------------------------------------------------------

/** The conformant answer to a claim-less discover: -32602 on 400. */
const invalidParams = (id: unknown, what: string): StubReply => ({
  status: 400,
  body: { jsonrpc: "2.0", id, error: { code: -32602, message: `Invalid params: ${what}` } },
});

const hasProtocolVersionClaim = (msg: Record<string, any>) =>
  typeof msg.params?._meta?.["io.modelcontextprotocol/protocolVersion"] === "string";

/**
 * A conformant modern stub: full-envelope discover served, claim-less
 * discover -32602, initialize -32601 naming the version, everything else
 * -32601. `gate` may intercept a request first (an intermediary).
 */
function conformantRoute(gate?: (method: string, msg: Record<string, any>) => StubReply | undefined): StubRoute {
  return (method, msg) => {
    const intercepted = gate?.(method, msg);
    if (intercepted) return intercepted;
    if (method === "server/discover") {
      if (!hasProtocolVersionClaim(msg)) return invalidParams(msg.id, "_meta protocolVersion required");
      return discoverReply(msg.id, {});
    }
    if (method === "initialize") {
      return {
        status: 404,
        body: {
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: "Method not found: initialize. This server speaks MCP 2026-07-28" },
        },
      };
    }
    return notFound(msg.id, method);
  };
}

describe("rejections answered by a transport-level gate are not evaluable", () => {
  it("a bare 429 on the claim-less discover fails lifecycle-meta-required instead of passing as a rejection", async () => {
    // A rate limiter that happens to trip on the malformed request.
    const stub = await startModernStub(
      conformantRoute((method, msg) =>
        method === "server/discover" && msg.params?._meta === undefined
          ? { status: 429, body: "rate limited" }
          : undefined,
      ),
    );
    try {
      const report = await runModern(stub.url, {
        only: ["lifecycle-discover", "lifecycle-meta-required", "lifecycle-meta-protocol-version-required"],
      });
      expectPassed(report, "lifecycle-discover");
      expectFailed(
        report,
        "lifecycle-meta-required",
        /^server\/discover without _meta: not evaluable: HTTP 429 is a transport-level rejection \(rate limiting answered before the JSON-RPC layer read the request\), so it proves nothing about the injected defect$/,
      );
      // The gate did not touch the other probe: still a clean -32602.
      expect(expectPassed(report, "lifecycle-meta-protocol-version-required").details).toBe(
        "server/discover without _meta protocolVersion: rejected with -32602 (HTTP 400)",
      );
      // Not credited, so no "rejected with HTTP 429 but no JSON-RPC error body" warning.
      expect(lifecycleWarnings(report)).toEqual([]);
    } finally {
      await stub.close();
    }
  });

  it("the late lifecycle block runs before the security burst, so a gateway that rate-limits the burst cannot feed it 429s", async () => {
    // An intermediary that answers 429 for two seconds once more than 20
    // requests land within 100 ms -- exactly what security-rate-limiting's
    // burst of 50 concurrent discovers trips.
    let recent: number[] = [];
    let limitedUntil = 0;
    const stub = await startModernStub(
      conformantRoute(() => {
        const now = Date.now();
        if (now < limitedUntil) return { status: 429, body: "rate limited" };
        recent = recent.filter((t) => now - t < 100);
        recent.push(now);
        if (recent.length > 20) {
          limitedUntil = now + 2000;
          return { status: 429, body: "rate limited" };
        }
        return undefined;
      }),
    );
    try {
      const report = await runModern(stub.url, {
        only: [
          "lifecycle-discover",
          "lifecycle-meta-required",
          "lifecycle-meta-protocol-version-required",
          "lifecycle-dual-era",
          "security-rate-limiting",
        ],
      });
      // The burst itself saw the limiter.
      expect(expectPassed(report, "security-rate-limiting").details).toMatch(/429/);
      // The probes ran before it: clean verdicts, no 429 anywhere near them.
      expect(expectPassed(report, "lifecycle-meta-required").details).toBe(
        "server/discover without _meta: rejected with -32602 (HTTP 400)",
      );
      expect(expectPassed(report, "lifecycle-meta-protocol-version-required").details).toBe(
        "server/discover without _meta protocolVersion: rejected with -32602 (HTTP 400)",
      );
      expect(expectPassed(report, "lifecycle-dual-era").details).toBe(
        "modern-only: initialize rejected with -32601 (HTTP 404); message names supported versions",
      );
      expect(lifecycleWarnings(report)).toEqual([]);
      const order = report.tests.map((t) => t.id);
      expect(order.indexOf("lifecycle-dual-era")).toBeLessThan(order.indexOf("security-rate-limiting"));
    } finally {
      await stub.close();
    }
  });

  it("a bare 429 on the legacy initialize leaves the era undetermined rather than 'modern-only'", async () => {
    const stub = await startModernStub(
      conformantRoute((method) => (method === "initialize" ? { status: 429, body: "rate limited" } : undefined)),
    );
    try {
      const report = await runModern(stub.url, { only: ["lifecycle-dual-era"] });
      expect(expectPassed(report, "lifecycle-dual-era").details).toBe(
        "era undetermined: initialize answered HTTP 429, a transport-level rejection (see warning)",
      );
      expect(lifecycleWarnings(report)).toEqual([
        expect.stringMatching(/^lifecycle-dual-era: legacy initialize was answered HTTP 429; not evaluable: HTTP 429/),
      ]);
    } finally {
      await stub.close();
    }
  });
});

describe("a server that rejects everything (SDK v1 'Server not initialized') over HTTP", () => {
  it("fails removed-methods and subscriptions-listen as not evaluable", async () => {
    const stub = await startModernStub((_method, msg) => ({
      status: 400,
      body: { jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "Bad Request: Server not initialized" } },
    }));
    try {
      const report = await runModern(stub.url, {
        only: ["lifecycle-discover", "lifecycle-removed-methods", "lifecycle-subscriptions-listen"],
      });
      const reason =
        "not evaluable: the conformant server/discover was itself rejected with -32000 (HTTP 400), so this rejection proves nothing about the injected defect";
      expect(expectFailed(report, "lifecycle-removed-methods").details).toBe(
        `ping -32000, logging/setLevel -32000, resources/subscribe -32000 rejected; ${reason}`,
      );
      expect(expectFailed(report, "lifecycle-subscriptions-listen").details).toBe(
        `subscriptions/listen rejected with -32000 (HTTP 400); ${reason}`,
      );
      expect(lifecycleWarnings(report)).toEqual([]);
    } finally {
      await stub.close();
    }
  });
});

describe("the HTTP status rule on the rejection tests (a JSON-RPC error must come with HTTP 400)", () => {
  it("-32602 on HTTP 200 fails both claim-less _meta probes instead of passing as a rejection", async () => {
    const stub = await startModernStub(
      conformantRoute((method, msg) =>
        method === "server/discover" && !hasProtocolVersionClaim(msg)
          ? {
              status: 200,
              body: { jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "Invalid params: _meta required" } },
            }
          : undefined,
      ),
    );
    try {
      const report = await runModern(stub.url, {
        only: ["lifecycle-discover", "lifecycle-meta-required", "lifecycle-meta-protocol-version-required"],
      });
      expectPassed(report, "lifecycle-discover");
      expect(expectFailed(report, "lifecycle-meta-required").details).toBe(
        "server/discover without _meta: JSON-RPC error -32602 with HTTP 200 (expected 400)",
      );
      expect(expectFailed(report, "lifecycle-meta-protocol-version-required").details).toBe(
        "server/discover without _meta protocolVersion: JSON-RPC error -32602 with HTTP 200 (expected 400)",
      );
      expect(lifecycleWarnings(report)).toEqual([]);
    } finally {
      await stub.close();
    }
  });

  it("a correct -32022 on HTTP 200 fails version-unsupported", async () => {
    const stub = await startModernStub(
      conformantRoute((method, msg) =>
        method === "server/discover" && msg.params?._meta?.["io.modelcontextprotocol/protocolVersion"] === "1999-01-01"
          ? {
              status: 200,
              body: {
                jsonrpc: "2.0",
                id: msg.id,
                error: {
                  code: -32022,
                  message: "Unsupported protocol version: 1999-01-01",
                  data: { supported: ["2026-07-28"], requested: "1999-01-01" },
                },
              },
            }
          : undefined,
      ),
    );
    try {
      const report = await runModern(stub.url, { only: ["lifecycle-discover", "lifecycle-version-unsupported"] });
      expectPassed(report, "lifecycle-discover");
      // The data is right (a subset of the discover list, requested echoed): only the status is wrong.
      expect(expectFailed(report, "lifecycle-version-unsupported").details).toBe(
        "-32022 returned but HTTP 200 (expected 400)",
      );
    } finally {
      await stub.close();
    }
  });
});

describe("lifecycle-capabilities: a capabilities value that is not an object", () => {
  // An array is the value a bare `typeof === "object"` guard lets through, and
  // one holding a declaration is what a client that walks it would misread.
  for (const [label, capabilities, type] of [
    ["a string", "x", "string"],
    ["an array holding a declaration", [{ tools: {}, completions: {} }], "an array"],
  ] as const) {
    it(`${label}: fails discover and capabilities, stores no declaration, and gates every capability as undeclared`, async () => {
      const stub = await startModernStub((method, msg) => {
        if (method === "server/discover") return discoverReply(msg.id, capabilities);
        return notFound(msg.id, method);
      });
      try {
        const report = await runModern(stub.url, {
          only: [
            "lifecycle-discover",
            "lifecycle-capabilities",
            "lifecycle-capability-handlers-match",
            "lifecycle-progress-token",
            "lifecycle-completions",
          ],
        });
        expect(expectFailed(report, "lifecycle-discover").details).toBe(
          `DiscoverResult invalid: capabilities is ${type}, expected an object`,
        );
        expect(expectFailed(report, "lifecycle-capabilities").details).toBe(
          `capabilities is ${type}, expected an object`,
        );
        // The malformed value is not kept as the declaration: the report (and the
        // terminal's "Capabilities:" line, which walks its keys) carries none.
        expect(report.serverInfo.capabilities).toEqual({});
        expect(expectPassed(report, "lifecycle-capability-handlers-match").details).toBe(
          "tools: undeclared, tools/list -> -32601; resources: undeclared, resources/list -> -32601; prompts: undeclared, prompts/list -> -32601",
        );
        expect(expectPassed(report, "lifecycle-progress-token").details).toBe("skipped: server declares no tools");
        expect(report.tests.some((t) => t.id === "lifecycle-completions")).toBe(false);
      } finally {
        await stub.close();
      }
    });
  }
});

describe("lifecycle-completions: the placeholder probe when no prompt or template argument is listed", () => {
  const PLACEHOLDER = 'probe prompt "__test__" (no prompt or template argument listed)';

  /** Declares only completions, so there is no prompts or templates list to take an argument from. */
  const completionsOnly = (complete: (msg: Record<string, any>) => StubReply) => {
    const sent: Array<{ method: string; params: unknown }> = [];
    const started = startModernStub((method, msg) => {
      sent.push({ method, params: msg.params });
      if (method === "server/discover") return discoverReply(msg.id, { completions: {} });
      if (method === "completion/complete") return complete(msg);
      return notFound(msg.id, method);
    });
    return { sent, started };
  };

  it("passes on InvalidParams for the placeholder ref", async () => {
    const { sent, started } = completionsOnly((msg) => invalidParams(msg.id, "unknown prompt __test__"));
    const stub = await started;
    try {
      const report = await runModern(stub.url, { only: ["lifecycle-completions"] });
      const r = expectPassed(report, "lifecycle-completions");
      expect(r.details).toBe(`InvalidParams for ${PLACEHOLDER} (acceptable)`);
      expect(r.required).toBe(true);
      // Nothing was listed first (prompts and resources are undeclared), and the probe used the placeholder ref.
      expect(sent.map((s) => s.method).filter((m) => m !== "server/discover")).toEqual(["completion/complete"]);
      expect(sent.find((s) => s.method === "completion/complete")?.params).toMatchObject({
        ref: { type: "ref/prompt", name: "__test__" },
        argument: { name: "test", value: "" },
      });
    } finally {
      await stub.close();
    }
  });

  it("fails on any other error for the placeholder ref", async () => {
    const { started } = completionsOnly((msg) => notFound(msg.id, "completion/complete"));
    const stub = await started;
    try {
      const report = await runModern(stub.url, { only: ["lifecycle-completions"] });
      expect(expectFailed(report, "lifecycle-completions").details).toBe(
        `completion/complete for ${PLACEHOLDER}: JSON-RPC error -32601 (Method not found: completion/complete) (HTTP 404)`,
      );
    } finally {
      await stub.close();
    }
  });
});

describe("lifecycle-completions: a declared list the probe draws from failed", () => {
  const PLACEHOLDER = 'probe prompt "__test__" (no prompt or template argument listed)';
  const WHAT = "no prompt or template argument to complete";

  const boom = (id: unknown): StubReply => ({
    status: 200,
    body: { jsonrpc: "2.0", id, error: { code: -32603, message: "boom" } },
  });
  const listReply = (id: unknown, key: string, items: unknown[]): StubReply => ({
    status: 200,
    body: { jsonrpc: "2.0", id, result: { resultType: "complete", [key]: items, ttlMs: 0, cacheScope: "public" } },
  });

  /**
   * Declares `capabilities` plus completions; `lists` answers methods by
   * name (the list calls, optionally completion/complete); an unanswered
   * completion/complete draws the -32602 on 400 a server gives a ref it
   * does not know (what the placeholder probe accepts); anything else -32601.
   */
  const completionsStub = (
    capabilities: Record<string, unknown>,
    lists: Record<string, (msg: Record<string, any>) => StubReply>,
  ) => {
    const sent: Array<{ method: string; params: unknown }> = [];
    const started = startModernStub((method, msg) => {
      sent.push({ method, params: msg.params });
      if (method === "server/discover") return discoverReply(msg.id, { ...capabilities, completions: {} });
      const list = lists[method];
      if (list) return list(msg);
      if (method === "completion/complete") return invalidParams(msg.id, "unknown ref");
      return notFound(msg.id, method);
    });
    return { sent, started };
  };
  const methodsSent = (sent: Array<{ method: string }>) =>
    sent.map((s) => s.method).filter((m) => m !== "server/discover");

  it("prompts/list fails: FAIL with the reason when prompts-list is filtered out, skip-pass pointing at it when it runs", async () => {
    // The reviewer's repro: pre-fix this graded A on the placeholder's -32602.
    const { sent, started } = completionsStub({ prompts: {} }, { "prompts/list": (msg) => boom(msg.id) });
    const stub = await started;
    try {
      const alone = await runModern(stub.url, { only: ["lifecycle-completions"] });
      expect(expectFailed(alone, "lifecycle-completions").details).toBe(
        `prompts/list failed (JSON-RPC error -32603 (boom)); ${WHAT}`,
      );
      expect(alone.grade).toBe("F");
      // The placeholder is never sent: its -32602 would say nothing about the arguments the server really lists.
      expect(methodsSent(sent)).toEqual(["prompts/list"]);

      sent.length = 0;
      const withList = await runModern(stub.url, { only: ["prompts-list", "lifecycle-completions"] });
      expect(expectFailed(withList, "prompts-list").details).toMatch(/^prompts\/list returned .*-32603/);
      expect(expectPassed(withList, "lifecycle-completions").details).toBe(
        `skipped: prompts/list failed, ${WHAT} (see prompts-list)`,
      );
      expect(methodsSent(sent).filter((m) => m === "completion/complete")).toEqual([]);
    } finally {
      await stub.close();
    }
  });

  it("prompts/list fails but a template is listed: the template variable is completed", async () => {
    const { sent, started } = completionsStub(
      { prompts: {}, resources: {} },
      {
        "prompts/list": (msg) => boom(msg.id),
        "resources/templates/list": (msg) =>
          listReply(msg.id, "resourceTemplates", [{ uriTemplate: "file:///{path}", name: "files" }]),
        "completion/complete": (msg) => ({
          status: 200,
          body: { jsonrpc: "2.0", id: msg.id, result: { resultType: "complete", completion: { values: ["a.txt"] } } },
        }),
      },
    );
    const stub = await started;
    try {
      const report = await runModern(stub.url, { only: ["lifecycle-completions"] });
      expect(expectPassed(report, "lifecycle-completions").details).toBe(
        'Returned 1 completion(s) for resource template "file:///{path}" variable "path"',
      );
      expect(sent.find((s) => s.method === "completion/complete")?.params).toMatchObject({
        ref: { type: "ref/resource", uri: "file:///{path}" },
        argument: { name: "path", value: "" },
      });
    } finally {
      await stub.close();
    }
  });

  it("resources/templates/list fails: FAIL with the reason; answered -32601 (not supported) it keeps the placeholder", async () => {
    const failing = completionsStub({ resources: {} }, { "resources/templates/list": (msg) => boom(msg.id) });
    const stub = await failing.started;
    try {
      const report = await runModern(stub.url, { only: ["lifecycle-completions"] });
      expect(expectFailed(report, "lifecycle-completions").details).toBe(
        `resources/templates/list failed (JSON-RPC error -32603 (boom)); ${WHAT}`,
      );
      expect(methodsSent(failing.sent)).toEqual(["resources/templates/list"]);
    } finally {
      await stub.close();
    }

    // -32601 is what resources-templates accepts as "not supported": no templates, nothing broken.
    const unsupported = completionsStub({ resources: {} }, {});
    const stub2 = await unsupported.started;
    try {
      const report = await runModern(stub2.url, { only: ["resources-templates", "lifecycle-completions"] });
      expect(expectPassed(report, "resources-templates").details).toBe("Method not supported (acceptable): -32601");
      expect(expectPassed(report, "lifecycle-completions").details).toBe(
        `InvalidParams for ${PLACEHOLDER} (acceptable)`,
      );
      expect(methodsSent(unsupported.sent)).toEqual(["resources/templates/list", "completion/complete"]);
    } finally {
      await stub2.close();
    }
  });

  it("a declared prompts list that is genuinely empty keeps the placeholder probe", async () => {
    const { sent, started } = completionsStub(
      { prompts: {} },
      { "prompts/list": (msg) => listReply(msg.id, "prompts", []) },
    );
    const stub = await started;
    try {
      const report = await runModern(stub.url, { only: ["lifecycle-completions"] });
      expect(expectPassed(report, "lifecycle-completions").details).toBe(
        `InvalidParams for ${PLACEHOLDER} (acceptable)`,
      );
      expect(methodsSent(sent)).toEqual(["prompts/list", "completion/complete"]);
    } finally {
      await stub.close();
    }
  });
});

describe("a legacy-only server pinned to 2026-07-28 over HTTP (initialize served, discover -32601)", () => {
  it("reports legacy-only, not dual-era, and warns to re-pin", async () => {
    const stub = await startModernStub((method, msg) => {
      if (method === "initialize") {
        return {
          status: 200,
          body: {
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              protocolVersion: "2025-11-25",
              capabilities: {},
              serverInfo: { name: "legacy-stub", version: "1" },
            },
          },
        };
      }
      return notFound(msg.id, method);
    });
    try {
      const report = await runModern(stub.url, { only: ["lifecycle-discover", "lifecycle-dual-era"] });
      expectFailed(report, "lifecycle-discover", /JSON-RPC error -32601/);
      expect(expectPassed(report, "lifecycle-dual-era").details).toBe(
        "legacy-only: initialize answered with protocolVersion 2025-11-25 but server/discover was rejected; only the legacy handshake is served (see warning)",
      );
      expect(report.warnings.some((w) => w.startsWith("Server is dual-era"))).toBe(false);
      expect(report.warnings.some((w) => w.startsWith("Server is legacy-only (served the 2025-11-25 initialize"))).toBe(
        true,
      );
    } finally {
      await stub.close();
    }
  });
});

describe("lifecycle-dual-era on an unreachable server", () => {
  it("names the connection error instead of claiming a timeout", async () => {
    // A port nothing listens on: bind one, read it back, release it.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const report = await runModern(`http://127.0.0.1:${port}/mcp`, {
      only: ["lifecycle-discover", "lifecycle-dual-era"],
    });
    expectFailed(report, "lifecycle-discover", /^server\/discover got no response \(/);
    const dual = expectPassed(report, "lifecycle-dual-era");
    expect(dual.details).toMatch(
      /^legacy initialize got no response \(.*ECONNREFUSED.*\); era undetermined \(see warning\)$/,
    );
    expect(dual.details).not.toMatch(/within \d+ms/);
    expect(lifecycleWarnings(report)).toEqual([
      expect.stringMatching(/^lifecycle-dual-era: legacy initialize got no response \(.*ECONNREFUSED/),
    ]);
  });
});

describe("--only lifecycle: lists obtained by capability-handlers-match are reused", () => {
  it("sends tools/list once for handlers-match + progress-token", async () => {
    const sent: string[] = [];
    const stub = await startModernStub((method, msg) => {
      sent.push(method);
      if (method === "server/discover") return discoverReply(msg.id, { tools: {} });
      if (method === "tools/list") {
        return {
          status: 200,
          body: {
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              resultType: "complete",
              tools: [{ name: "noop", inputSchema: { type: "object" } }],
              ttlMs: 0,
              cacheScope: "public",
            },
          },
        };
      }
      if (method === "tools/call") {
        return {
          status: 200,
          body: {
            jsonrpc: "2.0",
            id: msg.id,
            result: { resultType: "complete", content: [{ type: "text", text: "ok" }] },
          },
        };
      }
      return notFound(msg.id, method);
    });
    try {
      const report = await runModern(stub.url, {
        only: ["lifecycle-capability-handlers-match", "lifecycle-progress-token"],
      });
      expect(expectPassed(report, "lifecycle-capability-handlers-match").details).toMatch(/^tools: declared, 1 listed/);
      expect(expectPassed(report, "lifecycle-progress-token").details).toMatch(/^tools\/call noop succeeded/);
      expect(sent.filter((m) => m === "tools/list")).toHaveLength(1);
      expect(report.toolNames).toEqual(["noop"]);
    } finally {
      await stub.close();
    }
  });
});

// ---------------------------------------------------------------------------
// The fresh-process initialize probe on stdio: exits, timeouts, aborts
// ---------------------------------------------------------------------------

/**
 * A minimal 2026-07-28 stdio server whose behaviour on `initialize` is
 * chosen by MINI_INITIALIZE (reject | silent | exit) and that, given
 * MINI_LOCK, allows one instance at a time (a lock file it never
 * releases: the second instance exits 1 at startup, like a server that
 * takes an exclusive port or database). Written to a temp dir per file.
 */
const MINI_SERVER_SRC = `"use strict";
const fs = require("node:fs");
const readline = require("node:readline");
const lock = process.env.MINI_LOCK;
if (lock) {
  try {
    fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
  } catch {
    fs.writeSync(2, "Error: already running (lock file held by another instance)\\n");
    process.exit(1);
  }
}
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg || msg.id === undefined) return;
  if (msg.method === "server/discover") {
    out({ jsonrpc: "2.0", id: msg.id, result: { resultType: "complete", supportedVersions: ["2026-07-28"],
      capabilities: {}, ttlMs: 0, cacheScope: "public",
      _meta: { "io.modelcontextprotocol/serverInfo": { name: "mini-server", version: "0" } } } });
    return;
  }
  if (msg.method === "initialize") {
    const mode = process.env.MINI_INITIALIZE || "reject";
    if (mode === "silent") return;
    if (mode === "exit") {
      fs.writeSync(2, "Error: initialize is not supported by this server\\n");
      process.exit(3);
    }
    out({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found: initialize. This server speaks MCP 2026-07-28" } });
    return;
  }
  out({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found: " + msg.method } });
});
process.stdin.on("end", () => process.exit(0));
`;

describe("lifecycle-dual-era: fresh-process initialize on stdio", () => {
  let dir: string;
  let script: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "mcp-compliance-mini-"));
    script = join(dir, "mini-server.cjs");
    writeFileSync(script, MINI_SERVER_SRC);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const target = (env: Record<string, string>): TransportTarget => ({
    type: "stdio",
    command: process.execPath,
    args: [script],
    env,
  });

  it("a server that exits on the request fails, naming the exit and that an idle instance stays up", async () => {
    const report = await runModern(target({ MINI_INITIALIZE: "exit" }), { only: ["lifecycle-dual-era"] });
    expect(expectFailed(report, "lifecycle-dual-era").details).toBe(
      "Server exited after a legacy initialize request on a fresh process (exit code 3: Error: initialize is not supported by this server); an instance spawned with no input stays up, so the request is what it exits on",
    );
    expect(lifecycleWarnings(report)).toEqual([]);
  }, 20_000);

  it("a single-instance server (second instance exits at startup) passes with the era undetermined and a warning", async () => {
    const report = await runModern(target({ MINI_LOCK: join(dir, "instance.lock") }), {
      only: ["lifecycle-discover", "lifecycle-dual-era"],
    });
    // The suite's own process holds the lock and answered discover.
    expectPassed(report, "lifecycle-discover");
    const exit = "exit code 1: Error: already running (lock file held by another instance)";
    expect(expectPassed(report, "lifecycle-dual-era").details).toBe(
      `era undetermined: a second instance exits at startup alongside the suite's process (${exit}), so the legacy initialize could not be probed (see warning)`,
    );
    expect(lifecycleWarnings(report)).toEqual([
      `lifecycle-dual-era: a fresh instance exited (${exit}) before answering the legacy initialize, and one spawned with no input exited too (${exit}); a server that allows one instance at a time cannot be probed alongside the suite's own process, so its era is undetermined`,
    ]);
  }, 20_000);

  it("a server that ignores initialize is given the per-request budget, not the startup budget", async () => {
    const report = await runModern(target({ MINI_INITIALIZE: "silent" }), {
      only: ["lifecycle-dual-era"],
      timeout: 1500,
      startupTimeout: 10_000,
    });
    const dual = expectPassed(report, "lifecycle-dual-era");
    const m =
      /^No response to legacy initialize on a fresh process within (\d+)ms; era undetermined \(see warning\)$/.exec(
        dual.details,
      );
    expect(m, dual.details).not.toBeNull();
    const budget = Number(m?.[1]);
    // The per-request timeout, stretched at most to 3x the setup discover
    // latency (a cold node start), never the 10 s startup budget.
    expect(budget).toBeGreaterThanOrEqual(1500);
    expect(budget).toBeLessThan(10_000);
    expect(dual.durationMs).toBeLessThan(8000);
    // The warning names the budget in full instead of a clipped transport message.
    expect(lifecycleWarnings(report)).toEqual([
      `lifecycle-dual-era: legacy initialize got no response within ${budget}ms on a fresh process; a modern-only server SHOULD reject it with an error naming its supported versions`,
    ]);
  }, 20_000);

  it("an abort during the fresh-process probe is not recorded as a pass", async () => {
    const controller = new AbortController();
    const completed: TestResult[] = [];
    const started = Date.now();
    const run = runComplianceSuite(target({ MINI_INITIALIZE: "silent" }), {
      specVersion: MODERN_SPEC_VERSION,
      only: ["lifecycle-dual-era"],
      timeout: 5000,
      startupTimeout: 10_000,
      signal: controller.signal,
      onTestComplete: (r) => completed.push(r),
    });
    // Past the setup discover (a cold node start), inside the initialize wait.
    setTimeout(() => controller.abort(new Error("user abort")), 1500);
    await expect(run).rejects.toThrow("user abort");
    expect(Date.now() - started).toBeLessThan(5000);
    const dual = completed.filter((r) => r.id === "lifecycle-dual-era");
    for (const r of dual) {
      expect(r.passed, r.details).toBe(false);
      expect(r.details).not.toMatch(/No response to legacy initialize/);
    }
  }, 20_000);
});
