import type { ComplianceReport, TestResult } from "./types.js";

export interface DiffEntry {
  id: string;
  name: string;
  category: string;
  required: boolean;
  /** "regression" = was passing, now failing; "fix" = inverse; "newFail" / "newPass" = test added since baseline. */
  kind: "regression" | "fix" | "newFail" | "newPass" | "removed";
  baselineDetails?: string;
  currentDetails?: string;
}

export interface DiffSummary {
  baselineGrade: string;
  currentGrade: string;
  baselineScore: number;
  currentScore: number;
  regressions: DiffEntry[];
  fixes: DiffEntry[];
  newFailures: DiffEntry[];
  newPasses: DiffEntry[];
  removed: DiffEntry[];
}

/**
 * Diff two compliance reports. Pure function — no I/O. The CLI loads
 * both files and renders the result.
 */
export function diffReports(baseline: ComplianceReport, current: ComplianceReport): DiffSummary {
  const baseById = new Map<string, TestResult>(baseline.tests.map((t) => [t.id, t]));
  const curById = new Map<string, TestResult>(current.tests.map((t) => [t.id, t]));

  const regressions: DiffEntry[] = [];
  const fixes: DiffEntry[] = [];
  const newFailures: DiffEntry[] = [];
  const newPasses: DiffEntry[] = [];
  const removed: DiffEntry[] = [];

  for (const [id, cur] of curById) {
    const base = baseById.get(id);
    if (!base) {
      const entry: DiffEntry = {
        id,
        name: cur.name,
        category: cur.category,
        required: cur.required,
        kind: cur.passed ? "newPass" : "newFail",
        currentDetails: cur.details,
      };
      (cur.passed ? newPasses : newFailures).push(entry);
      continue;
    }
    if (base.passed !== cur.passed) {
      const entry: DiffEntry = {
        id,
        name: cur.name,
        category: cur.category,
        required: cur.required,
        kind: cur.passed ? "fix" : "regression",
        baselineDetails: base.details,
        currentDetails: cur.details,
      };
      (cur.passed ? fixes : regressions).push(entry);
    }
  }
  for (const [id, base] of baseById) {
    if (!curById.has(id)) {
      removed.push({
        id,
        name: base.name,
        category: base.category,
        required: base.required,
        kind: "removed",
        baselineDetails: base.details,
      });
    }
  }

  return {
    baselineGrade: baseline.grade,
    currentGrade: current.grade,
    baselineScore: baseline.score,
    currentScore: current.score,
    regressions,
    fixes,
    newFailures,
    newPasses,
    removed,
  };
}

export function formatDiff(summary: DiffSummary): string {
  const lines: string[] = [];
  const arrow = summary.baselineGrade === summary.currentGrade ? "→" : "→";
  lines.push(
    `Grade ${summary.baselineGrade} (${summary.baselineScore}%) ${arrow} ${summary.currentGrade} (${summary.currentScore}%)`,
  );
  lines.push("");

  function section(label: string, entries: DiffEntry[]) {
    if (!entries.length) return;
    lines.push(`${label} (${entries.length}):`);
    for (const e of entries) {
      const req = e.required ? " [required]" : "";
      lines.push(`  - ${e.id}${req}: ${e.name}`);
      if (e.baselineDetails && e.currentDetails && e.baselineDetails !== e.currentDetails) {
        lines.push(`      was: ${e.baselineDetails}`);
        lines.push(`      now: ${e.currentDetails}`);
      } else if (e.currentDetails) {
        lines.push(`      ${e.currentDetails}`);
      } else if (e.baselineDetails) {
        lines.push(`      ${e.baselineDetails}`);
      }
    }
    lines.push("");
  }

  section("Regressions", summary.regressions);
  section("Fixes", summary.fixes);
  section("New failures", summary.newFailures);
  section("New passes", summary.newPasses);
  section("Removed tests", summary.removed);

  if (
    summary.regressions.length +
      summary.fixes.length +
      summary.newFailures.length +
      summary.newPasses.length +
      summary.removed.length ===
    0
  ) {
    lines.push("No changes between baseline and current.");
  }

  return lines.join("\n");
}

export function hasRegressions(summary: DiffSummary): boolean {
  return summary.regressions.length > 0 || summary.newFailures.some((e) => e.required);
}
