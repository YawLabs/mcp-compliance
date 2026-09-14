import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MODERN_TEST_DEFINITIONS } from "../definitions/index.js";
import { runComplianceSuite } from "../runner.js";
import { AUTO_DETECT_NOTE_PREFIX, MODERN_SPEC_VERSION } from "../spec.js";
import type { ComplianceReport, TransportTarget } from "../types.js";
import {
  type HttpFixture,
  MODERN_FIXTURE,
  resultOf,
  startHttpFixture,
  stdioFixture,
} from "./helpers/modern-fixture.js";

/**
 * The modern analogue of integration.test.ts: one full `auto` run of the
 * 2026-07-28 suite against the hand-rolled modern fixture, over HTTP and
 * over stdio, checked for the properties a leaderboard depends on --
 * schema-valid report, deterministic output, exact counts, no false
 * failures. Per-check behaviour (and every knob that makes a check fail)
 * lives in the modern-*.test.ts files; this file is the end-to-end shape.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const reportSchema = JSON.parse(readFileSync(resolve(__dirname, "../../schemas/report.v1.json"), "utf8"));
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
const validateReport = ajv.compile(reportSchema);

/**
 * Optional checks every HTTP run on plain loopback fails regardless of the
 * server. (security-rate-limiting is not one: a quiet burst passes with a
 * warning in this catalog, asserted in the warnings below.)
 */
const LOCALHOST_INHERENT = ["security-auth-required", "security-tls-required"];

const FIXTURE_TOOLS = [
  "echo",
  "add",
  "content_types",
  "progress",
  "logger",
  "needs_input",
  "needs_sampling",
  "regional",
  "fail",
  "trigger_tools_changed",
  "trigger_prompts_changed",
];

/**
 * Details are compared modulo the per-run noise the suite itself
 * introduces: durations, and the `compliance-str-N` string id (a
 * module-level counter in lifecycle.ts, so it advances across runs that
 * share one process -- the CLI always sees 1).
 */
function stableDetails(details: string): string {
  return details.replace(/\b\d+(\.\d+)?\s?ms\b/g, "<ms>").replace(/compliance-str-\d+/g, "compliance-str-<n>");
}

function stripVolatile(report: ComplianceReport) {
  return {
    ...report,
    timestamp: "FIXED",
    tests: report.tests.map((t) => ({ ...t, durationMs: 0, details: stableDetails(t.details) })),
  };
}

interface Expected {
  kind: "http" | "stdio";
  count: number;
  optionalFailures: string[];
  overall: "pass" | "partial";
}

const EXPECTED: Expected[] = [
  { kind: "http", count: 99, optionalFailures: LOCALHOST_INHERENT, overall: "partial" },
  { kind: "stdio", count: 75, optionalFailures: [], overall: "pass" },
];

for (const ex of EXPECTED) {
  describe(`integration -- full auto run of the 2026-07-28 suite over ${ex.kind}`, () => {
    let http: HttpFixture | undefined;
    let target: string | TransportTarget;
    let report: ComplianceReport;
    let second: ComplianceReport;

    beforeAll(async () => {
      if (ex.kind === "http") {
        http = await startHttpFixture();
        target = http.target;
      } else {
        target = stdioFixture().target;
      }
      // Default specVersion (auto), test-friendly timeouts. Sequential on
      // purpose: the fixture fans list_changed triggers out to every open
      // listen stream, so two concurrent runs could see each other's pushes.
      report = await runComplianceSuite(target, { timeout: 5000, startupTimeout: 10_000 });
      second = await runComplianceSuite(target, { timeout: 5000, startupTimeout: 10_000 });
    }, 120_000);

    afterAll(async () => {
      await http?.stop();
    });

    it("auto-detects 2026-07-28 and stamps the resolved version", () => {
      expect(report.specVersion).toBe(MODERN_SPEC_VERSION);
      expect(report.serverInfo.protocolVersion).toBe(MODERN_SPEC_VERSION);
      expect(report.url).toBe(ex.kind === "http" ? http?.target : `stdio:${process.execPath} ${MODERN_FIXTURE}`);
    });

    it("validates against schemas/report.v1.json", () => {
      const ok = validateReport(report);
      if (!ok) {
        throw new Error(
          `Modern report does not match report.v1 schema:\n${JSON.stringify(validateReport.errors, null, 2)}`,
        );
      }
      expect(ok).toBe(true);
    });

    it(`runs ${ex.count} tests: every catalog id that applies to ${ex.kind}, each once`, () => {
      expect(report.tests).toHaveLength(ex.count);
      const ids = report.tests.map((t) => t.id);
      expect(new Set(ids).size).toBe(ids.length);
      const applicable = MODERN_TEST_DEFINITIONS.filter((d) => !d.transports || d.transports.includes(ex.kind)).map(
        (d) => d.id,
      );
      expect([...ids].sort()).toEqual([...applicable].sort());
      // Every id resolves to its definition's metadata and the modern spec base.
      for (const t of report.tests) {
        const def = MODERN_TEST_DEFINITIONS.find((d) => d.id === t.id);
        expect(def, t.id).toBeDefined();
        expect(t.name).toBe(def?.name);
        expect(t.category).toBe(def?.category);
        expect(t.specRef).toBe(`https://modelcontextprotocol.io/specification/2026-07-28/${def?.specRef}`);
      }
    });

    it("passes every required test", () => {
      const requiredFails = report.tests.filter((t) => t.required && !t.passed).map((t) => `${t.id}: ${t.details}`);
      expect(requiredFails).toEqual([]);
      // Capability-gated tests became required because the fixture declares
      // tools, resources, prompts and completions.
      for (const id of ["tools-list", "resources-read", "prompts-get", "lifecycle-completions"]) {
        expect(resultOf(report, id).required, id).toBe(true);
      }
    });

    it(`fails exactly ${ex.optionalFailures.length} optional test(s): the localhost-inherent ones`, () => {
      const failing = report.tests.filter((t) => !t.passed);
      expect(failing.map((t) => t.id).sort(), failing.map((t) => `${t.id}: ${t.details}`).join("\n")).toEqual(
        [...ex.optionalFailures].sort(),
      );
      expect(report.overall).toBe(ex.overall);
      expect(report.grade).toBe("A");
      expect(report.score).toBe(ex.kind === "http" ? 99 : 100);
      expect(report.summary).toEqual({
        total: ex.count,
        passed: ex.count - ex.optionalFailures.length,
        failed: ex.optionalFailures.length,
        required: report.tests.filter((t) => t.required).length,
        requiredPassed: report.tests.filter((t) => t.required).length,
      });
    });

    it("takes serverInfo, capabilities and instructions from server/discover", () => {
      expect(report.serverInfo.name).toBe("modern-fixture");
      expect(report.serverInfo.version).toBe("0.0.1");
      expect(Object.keys(report.serverInfo.capabilities ?? {})).toEqual([
        "tools",
        "resources",
        "prompts",
        "completions",
      ]);
      expect(resultOf(report, "lifecycle-instructions").details).toMatch(/^Instructions: /);
    });

    it("lists the fixture's 11 tools, 2 resources and 2 prompts", () => {
      expect(report.toolCount).toBe(11);
      expect(report.toolNames).toEqual(FIXTURE_TOOLS);
      expect(report.resourceCount).toBe(2);
      expect(report.resourceNames).toEqual(["static-text", "static-binary"]);
      expect(report.promptCount).toBe(2);
      expect(report.promptNames).toEqual(["simple", "greet"]);
    });

    it("warns with the auto-detect note (once, first) and nothing is duplicated", () => {
      expect(report.warnings[0]).toBe(
        `${AUTO_DETECT_NOTE_PREFIX}2026-07-28 (server/discover -> supportedVersions [2026-07-28]). Pin with --spec-version to override.`,
      );
      expect(report.warnings.filter((w) => w.startsWith(AUTO_DETECT_NOTE_PREFIX))).toHaveLength(1);
      expect(new Set(report.warnings).size).toBe(report.warnings.length);
      expect(report.warnings.some((w) => w.includes("unreachable"))).toBe(false);
      expect(report.warnings.some((w) => w.startsWith("Server is dual-era"))).toBe(false);
      // The fixture's only lint: descriptions it deliberately omits, plus the
      // oversized-input observation (it accepts a 1 MB argument) and, over
      // HTTP, the quiet rate-limit burst.
      const expected: unknown[] = [
        'Template "template" missing description',
        'Resource "static-text" missing description',
        'Resource "static-binary" missing description',
        "security-oversized-input: the server completed a tools/call carrying a 1 MB string argument (echo.message) instead of rejecting it; enforce a request body limit (413) or maxLength in inputSchema.",
      ];
      if (ex.kind === "http") expected.push(expect.stringMatching(/^security-rate-limiting: /));
      expect(report.warnings.slice(1).sort()).toEqual(expect.arrayContaining(expected));
      expect(report.warnings.slice(1)).toHaveLength(expected.length);
    });

    it("the informational probes describe the fixture as modern-only", () => {
      expect(resultOf(report, "lifecycle-dual-era").details).toMatch(
        /^modern-only: initialize rejected with -32601.*message names supported versions/,
      );
      expect(resultOf(report, "lifecycle-progress-token").details).toMatch(/^3 notifications\/progress echoed token/);
      expect(resultOf(report, "lifecycle-subscriptions-listen").details).toMatch(/^Acknowledged subscription/);
    });

    it("runs the late lifecycle block before the security module and the post-hoc checks last", () => {
      // The security rate-limit burst can leave an intermediary answering
      // 429 for a while; the claim-less _meta probes and the legacy
      // initialize probe must have run by then. Post-hoc scans the recorder
      // after everything.
      const order = report.tests.map((t) => t.id);
      const firstSecurity = order.findIndex((id) => id.startsWith("security-"));
      expect(firstSecurity).toBeGreaterThan(0);
      for (const id of [
        "lifecycle-completions",
        "lifecycle-progress-token",
        "lifecycle-meta-required",
        "lifecycle-meta-protocol-version-required",
        "lifecycle-dual-era",
      ]) {
        expect(order.indexOf(id), id).toBeLessThan(firstSecurity);
      }
      const posthoc = order.indexOf("schema-wire-valid");
      expect(posthoc).toBeGreaterThan(order.lastIndexOf("security-rate-limiting"));
    });

    it("is deterministic across two runs (modulo timings and the string-id counter)", () => {
      const a = stripVolatile(report);
      const b = stripVolatile(second);
      expect(b.grade).toBe(a.grade);
      expect(b.score).toBe(a.score);
      expect(b.overall).toBe(a.overall);
      expect(b.summary).toEqual(a.summary);
      expect(b.categories).toEqual(a.categories);
      expect(b.tests.map((t) => [t.id, t.passed])).toEqual(a.tests.map((t) => [t.id, t.passed]));
      // Stronger than the legacy determinism test: the details are stable too.
      expect(b.tests.map((t) => [t.id, t.details])).toEqual(a.tests.map((t) => [t.id, t.details]));
      expect(b.warnings).toEqual(a.warnings);
      expect(b.serverInfo).toEqual(a.serverInfo);
      expect(b.toolNames).toEqual(a.toolNames);
      expect(b.resourceNames).toEqual(a.resourceNames);
      expect(b.promptNames).toEqual(a.promptNames);
    });
  });
}
