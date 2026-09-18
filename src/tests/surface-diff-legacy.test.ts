import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readsAsSkip } from "../harness.js";
import type { ComplianceReport } from "../types.js";

/**
 * `diff` against a baseline the released tool (v0.18.x) wrote. Such a
 * report has no skip data at all -- no `summary.skipped`, no per-category
 * `skipped`, no `TestResult.skipped` -- but its skips carry the same
 * wording ("... (skipped)", "Skipped: ...", "... not applicable") the
 * harness reads to flag the current run. So a check that skipped then and
 * still skips is no change; only a skip the current tool flags without
 * such wording can surface as "newly skipped" against it.
 *
 * The baseline is the same real run with the skip data stripped, i.e.
 * the shape v0.18.2 writes. Expectations derive from that run's own flags
 * and wording, never from a hard-coded list of checks.
 *
 * index.ts calls `program.parse()` at module load, so the CLI runs under
 * tsx as a child process, as in cli-spec-version.test.ts.
 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const ENTRY = join(ROOT, "src", "index.ts");
const ECHO_SERVER = fileURLToPath(new URL("./fixtures/echo-server.mjs", import.meta.url));

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

/** The report as v0.18.2 writes it: the same results with every piece of skip data removed. */
function asV0182(report: ComplianceReport): ComplianceReport {
  const { skipped: _count, ...summary } = report.summary;
  const categories = Object.fromEntries(
    Object.entries(report.categories).map(([name, { skipped: _s, ...c }]) => [name, c]),
  ) as ComplianceReport["categories"];
  return { ...report, summary, categories, tests: report.tests.map(({ skipped: _s, ...t }) => t) };
}

describe("diff against a baseline from a tool that predates skip tracking, end to end", () => {
  let workDir: string;
  let run: Run;
  let current: ComplianceReport;
  let diffTerminal: Run;
  let diffJson: Run;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), "mcp-compliance-surface-legacy-diff-"));
    run = await cli([
      "test",
      "--format",
      "json",
      "--spec-version",
      "2025-11-25",
      "--timeout",
      "5000",
      process.execPath,
      ECHO_SERVER,
    ]);
    current = JSON.parse(run.stdout) as ComplianceReport;
    const baselinePath = join(workDir, "baseline-v0182-shape.json");
    const currentPath = join(workDir, "current.json");
    writeFileSync(baselinePath, JSON.stringify(asV0182(current), null, 2));
    writeFileSync(currentPath, run.stdout);
    [diffTerminal, diffJson] = await Promise.all([
      cli(["diff", baselinePath, currentPath]),
      cli(["diff", "--format", "json", baselinePath, currentPath]),
    ]);
  }, 240_000);

  afterAll(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  const skipsOf = (r: ComplianceReport) => r.tests.filter((t) => t.passed && t.skipped === true);
  /** Skips the old tool could only have written as plain passes: the one case a diff may still list. */
  const unmarkedSkipIds = () =>
    skipsOf(current)
      .filter((t) => !readsAsSkip(t.details))
      .map((t) => t.id);

  it("the run has marker-worded skips (otherwise nothing below proves anything)", () => {
    expect(run.code, run.stderr).toBe(0);
    expect(current.summary.skipped).toBe(skipsOf(current).length);
    expect(skipsOf(current).filter((t) => readsAsSkip(t.details)).length).toBeGreaterThan(0);
    expect(asV0182(current).summary).not.toHaveProperty("skipped");
  });

  it("a check that skipped in the baseline and still skips is not listed; the diff does not gate", () => {
    const expected = unmarkedSkipIds();
    expect(diffTerminal.code, diffTerminal.stderr).toBe(0);
    if (expected.length === 0) {
      expect(diffTerminal.stdout).toContain("No changes between baseline and current.");
      expect(diffTerminal.stdout).not.toContain("Newly skipped");
    } else {
      expect(diffTerminal.stdout).toContain(`Newly skipped (${expected.length}):`);
    }
    for (const t of skipsOf(current).filter((r) => readsAsSkip(r.details))) {
      expect(diffTerminal.stdout, t.id).not.toContain(`- ${t.id}`);
    }
  });

  it("the JSON diff agrees: reads the baseline's worded skips as skips and lists nothing else", () => {
    expect(diffJson.code, diffJson.stderr).toBe(0);
    const summary = JSON.parse(diffJson.stdout) as Record<string, unknown> & {
      newlySkipped: Array<{ id: string }>;
      recordsSkips: { baseline: boolean; current: boolean };
    };
    expect(summary.recordsSkips).toEqual({ baseline: false, current: true });
    expect(summary.newlySkipped.map((e) => e.id)).toEqual(unmarkedSkipIds());
    for (const list of ["regressions", "fixes", "newFailures", "newPasses", "removed", "noLongerSkipped"]) {
      expect(summary[list], list).toEqual([]);
    }
  });
});
