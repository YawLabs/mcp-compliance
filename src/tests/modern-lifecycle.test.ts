import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acknowledgmentProblem,
  evaluateProgress,
  listenFilterFor,
  unsupportedVersionDataProblems,
} from "../suites/modern/lifecycle.js";
import type { ComplianceReport, TransportTarget } from "../types.js";
import {
  type HttpFixture,
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
 * that has never been seen failing is a hypothesis.
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
  "lifecycle-meta-required",
  "lifecycle-meta-protocol-version-required",
  "lifecycle-meta-client-capabilities-required",
  "lifecycle-meta-client-info-optional",
  "lifecycle-version-unsupported",
  "lifecycle-removed-methods",
  "lifecycle-capability-handlers-match",
  "lifecycle-subscriptions-listen",
  "lifecycle-meta-tolerance",
  "lifecycle-completions",
  "lifecycle-progress-token",
  "lifecycle-dual-era",
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

    it("passes every lifecycle test on the clean fixture", async () => {
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
      // The initialize probe is informational: modern-only, and the fixture names its version.
      expect(resultOf(report, "lifecycle-dual-era").details).toMatch(/^modern-only: initialize rejected with -32601/);
      expect(resultOf(report, "lifecycle-subscriptions-listen").details).toMatch(/^Acknowledged subscription/);
      expect(resultOf(report, "lifecycle-removed-methods").details).toMatch(/^ping -32601/);
      // Feature lists are not filled by a lifecycle-only run: the progress test skips honestly.
      expect(resultOf(report, "lifecycle-progress-token").details).toMatch(/^skipped: no tools available/);
    });

    it("no-discover: every test that reads the DiscoverResult fails", async () => {
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
      const ids = [
        "lifecycle-meta-required",
        "lifecycle-meta-protocol-version-required",
        "lifecycle-meta-client-capabilities-required",
        "lifecycle-meta-client-info-optional",
      ];
      const report = await runBroken(kind, ["accept-missing-meta"], ids);
      expectFailed(report, "lifecycle-meta-required", /server returned a result/);
      expectFailed(report, "lifecycle-meta-protocol-version-required", /server returned a result/);
      expectFailed(report, "lifecycle-meta-client-capabilities-required", /server returned a result/);
      // Leniency does not break the optional-clientInfo rule.
      expectPassed(report, "lifecycle-meta-client-info-optional");
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

    it("initialize-ok: the dual-era probe reports a served legacy handshake", async () => {
      const report = await runBroken(kind, ["initialize-ok"], ["lifecycle-dual-era", "lifecycle-discover-versions"]);
      expect(expectPassed(report, "lifecycle-dual-era").details).toMatch(
        /^dual-era: initialize answered with protocolVersion 2025-11-25/,
      );
      expectPassed(report, "lifecycle-discover-versions");
      expect(report.warnings.some((w) => w.startsWith("Server is dual-era"))).toBe(true);
    });

    it("initialize-vague: a rejection that names no version passes with a warning", async () => {
      const report = await runBroken(kind, ["initialize-vague"], ["lifecycle-dual-era"]);
      expect(expectPassed(report, "lifecycle-dual-era").details).toMatch(
        /^modern-only: initialize rejected with -32601.*\(see warning\)/,
      );
      expect(lifecycleWarnings(report)).toEqual([
        expect.stringMatching(
          /^lifecycle-dual-era: initialize rejected with -32601 but the message names no supported protocol version/,
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
  const SUB = "io.modelcontextprotocol/subscriptionId";
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
