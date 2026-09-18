import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dedupAndCapWarnings, MAX_WARNINGS } from "../harness.js";
import { registerTools } from "../mcp/tools.js";
import type { ComplianceReport, TestResult } from "../types.js";
import { type HttpFixture, startHttpFixture } from "./helpers/modern-fixture.js";

/**
 * Skip display on the surfaces that sit outside the report formatters:
 * the CLI's --verbose progress, the MCP test tool, and `diff`, each driven
 * end to end against the modern fixture over HTTP with no --auth. That is
 * a clean server whose credential-dependent security checks measure
 * nothing, so the run carries real skips worded by the real suite.
 *
 * Every expectation is derived from the flags on the report the same run
 * produced, never from a hard-coded count: which checks skip is the
 * suites' business, and showing each one as a skip is this file's.
 *
 * index.ts calls `program.parse()` at module load, so the CLI runs under
 * tsx as a child process, as in cli-spec-version.test.ts.
 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const ENTRY = join(ROOT, "src", "index.ts");

type Run = { stdout: string; stderr: string; code: number | null };

function cli(args: string[]): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX, ENTRY, ...args], {
      cwd: ROOT,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

/** The real mcp_compliance_test handler, captured off a stub McpServer (runner not mocked). */
function testToolHandler(): ToolHandler {
  const handlers: Record<string, ToolHandler> = {};
  const server = {
    tool: vi.fn((name: string, _d: string, _s: unknown, _a: unknown, handler: ToolHandler) => {
      handlers[name] = handler;
    }),
  } as unknown as McpServer;
  registerTools(server);
  return handlers.mcp_compliance_test;
}

/** The one-word status every per-test line must show: a skip is not a pass. */
function label(t: TestResult): "PASS" | "FAIL" | "SKIP" {
  if (!t.passed) return "FAIL";
  return t.skipped === true ? "SKIP" : "PASS";
}

const skipsOf = (r: ComplianceReport) => r.tests.filter((t) => t.passed && t.skipped === true);

describe("skip display outside the report formatters, end to end", () => {
  let fixture: HttpFixture;
  let workDir: string;
  let verbose: Run;
  let verboseReport: ComplianceReport;
  let tool: Awaited<ReturnType<ToolHandler>>;
  let diffTerminal: Run;
  let diffJson: Run;

  beforeAll(async () => {
    fixture = await startHttpFixture();
    workDir = mkdtempSync(join(tmpdir(), "mcp-compliance-surface-"));
    // Sequential against the one fixture: the security suite's rate-limit
    // burst from one run must not land in the other's measurements.
    verbose = await cli([
      "test",
      "--format",
      "json",
      "--verbose",
      "--spec-version",
      "2026-07-28",
      "--only",
      "security",
      "--timeout",
      "5000",
      fixture.url,
    ]);
    verboseReport = JSON.parse(verbose.stdout) as ComplianceReport;
    tool = await testToolHandler()({ url: fixture.url, specVersion: "2026-07-28", only: ["security"], timeout: 5000 });

    // diff: the same run as the current report, against a baseline in
    // which every check it skipped had passed on evidence instead. The
    // baseline still records skips (summary.skipped 0), as every report
    // this tool writes does.
    const baseline: ComplianceReport = {
      ...verboseReport,
      summary: { ...verboseReport.summary, skipped: 0 },
      tests: verboseReport.tests.map(({ skipped, ...t }) => (skipped ? { ...t, details: "HTTP 401 (observed)" } : t)),
    };
    const baselinePath = join(workDir, "baseline.json");
    const currentPath = join(workDir, "current.json");
    writeFileSync(baselinePath, JSON.stringify(baseline));
    writeFileSync(currentPath, verbose.stdout);
    [diffTerminal, diffJson] = await Promise.all([
      cli(["diff", baselinePath, currentPath]),
      cli(["diff", "--format", "json", baselinePath, currentPath]),
    ]);
  }, 240_000);

  afterAll(async () => {
    await fixture?.stop();
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it("the run has real skips to show (otherwise nothing below proves anything)", () => {
    expect(verbose.code, verbose.stderr).toBe(0);
    expect(skipsOf(verboseReport).length).toBeGreaterThan(0);
    expect(skipsOf(verboseReport).length).toBe(verboseReport.summary.skipped);
  });

  it("--verbose prints SKIP for every flagged skip, never PASS", () => {
    for (const t of skipsOf(verboseReport)) {
      expect(verbose.stderr, t.id).toContain(`  SKIP ${t.id} — ${t.details}\n`);
      expect(verbose.stderr, t.id).not.toContain(`  PASS ${t.id} — `);
    }
  });

  it("--verbose prints one line per result, and a non-skip keeps its old PASS/FAIL line byte for byte (pinned)", () => {
    const lines = verbose.stderr.split("\n").filter((l) => /^ {2}(PASS|FAIL|SKIP) /.test(l));
    expect(lines).toHaveLength(verboseReport.tests.length);
    const plain = verboseReport.tests.filter((t) => label(t) !== "SKIP");
    expect(plain.some((t) => t.passed)).toBe(true);
    expect(plain.some((t) => !t.passed)).toBe(true);
    for (const t of plain) expect(lines, t.id).toContain(`  ${label(t)} ${t.id} — ${t.details}`);
    // stdout stays the JSON report alone.
    expect(verbose.stdout.trimStart().startsWith("{")).toBe(true);
  });

  /** The MCP test tool's text, and the full report it carries. */
  function toolOutput(): { lines: string[]; full: ComplianceReport } {
    expect(tool.isError).toBeUndefined();
    const full = JSON.parse(tool.content[1].text.replace(/^\s*Full report:\n/, "")) as ComplianceReport;
    return { lines: tool.content[0].text.split("\n"), full };
  }
  const toolLine = (t: TestResult, status: string) =>
    `${status} ${t.name}${t.required ? " (required)" : ""} — ${t.details}`;

  it("the MCP test tool counts the skips on its Tests line and marks each one SKIP, never PASS", () => {
    const { lines, full } = toolOutput();
    const skipped = skipsOf(full);
    expect(skipped.length).toBeGreaterThan(0);
    const { passed, total, requiredPassed, required } = full.summary;
    expect(lines).toContain(
      `Tests: ${passed}/${total} passed, ${skipped.length} skipped (${requiredPassed}/${required} required)`,
    );
    for (const t of skipped) {
      expect(lines, t.id).toContain(toolLine(t, "SKIP"));
      expect(lines, t.id).not.toContain(toolLine(t, "PASS"));
    }
  });

  it("the MCP test tool prints every non-skip result exactly as before (pinned)", () => {
    const { lines, full } = toolOutput();
    const plain = full.tests.filter((t) => label(t) !== "SKIP");
    expect(plain.length).toBeGreaterThan(0);
    for (const t of plain) expect(lines, t.id).toContain(toolLine(t, t.passed ? "PASS" : "FAIL"));
  });

  it("diff reports each check that started skipping, in the terminal and JSON formats, and does not gate on it", () => {
    const ids = skipsOf(verboseReport).map((t) => t.id);
    expect(diffTerminal.code, diffTerminal.stderr).toBe(0);
    expect(diffTerminal.stdout).toContain(`Newly skipped (${ids.length}):`);
    for (const id of ids) expect(diffTerminal.stdout, id).toMatch(new RegExp(`^ {2}- ${id}( \\[required\\])?: `, "m"));
    expect(diffTerminal.stdout).not.toContain("Regressions");
    expect(diffTerminal.stdout).not.toContain("No changes between baseline and current.");

    expect(diffJson.code, diffJson.stderr).toBe(0);
    const summary = JSON.parse(diffJson.stdout) as {
      newlySkipped: Array<{ id: string; baselineStatus: string; currentStatus: string }>;
      regressions: unknown[];
      fixes: unknown[];
    };
    expect(summary.newlySkipped.map((e) => e.id)).toEqual(ids);
    for (const e of summary.newlySkipped) expect([e.baselineStatus, e.currentStatus]).toEqual(["pass", "skip"]);
    expect(summary.regressions).toEqual([]);
    expect(summary.fixes).toEqual([]);
  });
});

describe("schemas/report.v1.json warnings description", () => {
  const schema = JSON.parse(readFileSync(join(ROOT, "schemas", "report.v1.json"), "utf8")) as {
    properties: { warnings: { description: string } };
  };
  const description = schema.properties.warnings.description;

  it("states the cap the harness applies (MAX_WARNINGS), not a stale number", () => {
    expect(description).toContain(`capped at ${MAX_WARNINGS} entries`);
    expect(description).not.toMatch(/\b100\b/);
  });

  it("quotes the truncation sentinel the harness actually appends", () => {
    const capped = dedupAndCapWarnings(
      Array.from({ length: MAX_WARNINGS + 2 }, (_, i) => `w${i}`),
      MAX_WARNINGS,
    );
    expect(capped).toHaveLength(MAX_WARNINGS + 1);
    expect(capped.at(-1)).toBe("... and 2 more warning(s) suppressed");
    expect(description).toContain('"... and N more warning(s) suppressed"');
  });
});
