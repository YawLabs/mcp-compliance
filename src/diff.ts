import { computeScore } from "./grader.js";
import { readsAsSkip } from "./harness.js";
import type { ComplianceReport, TestResult } from "./types.js";

/**
 * What one check recorded in one report. A skip (`passed: true` with
 * `skipped: true`: the check measured nothing) is its own status here,
 * not a pass.
 *
 * A report from a tool that predates the flag carries none, so its skips
 * are read the way the harness flags the current run: from the markers
 * the suites write into details (`readsAsSkip`). A skip it worded as a
 * plain pass ("No tools to validate") still reads as a pass; `formatDiff`
 * says so where that can matter.
 */
export type DiffStatus = "pass" | "fail" | "skip";

function statusOf(t: TestResult, recordsSkips: boolean): DiffStatus {
  if (!t.passed) return "fail";
  if (recordsSkips) return t.skipped === true ? "skip" : "pass";
  return readsAsSkip(t.details ?? "") ? "skip" : "pass";
}

export interface DiffEntry {
  id: string;
  name: string;
  category: string;
  required: boolean;
  /**
   * - "regression": was passing or skipped, now failing.
   * - "fix": was failing, now passing.
   * - "newFail" / "newPass": test added since baseline.
   * - "newlySkipped": now a skip (measured nothing) where the baseline
   *   passed, failed or did not run the test. Neither a regression nor a
   *   fix: the check no longer tells either way.
   * - "noLongerSkipped": was a skip, now passing. Not a fix: the baseline
   *   did not fail.
   * - "removed": in the baseline only.
   */
  kind: "regression" | "fix" | "newFail" | "newPass" | "removed" | "newlySkipped" | "noLongerSkipped";
  baselineDetails?: string;
  currentDetails?: string;
  /** The baseline result's status; absent when the baseline did not run the test. */
  baselineStatus?: DiffStatus;
  /** The current result's status; absent when the current run did not run the test. */
  currentStatus?: DiffStatus;
}

/**
 * The score and grade a report recorded, kept when they differ from the
 * ones the diff computed from its results (see DiffSummary.recordedScores).
 */
export interface RecordedScore {
  score: number;
  grade: string;
  /**
   * True when scoring the report's skips as passes reproduces what it
   * recorded: the report was scored by mcp-compliance 0.19.0 or earlier,
   * which counted a skip as a pass in both the numerator and the
   * denominator. False means some other difference (a hand-edited score,
   * a report from another tool or another algorithm).
   */
  skipsAsPasses: boolean;
}

export interface DiffSummary {
  /**
   * The MCP spec revision both reports were graded against, or null
   * when neither report records one. Every tool version has stamped
   * `specVersion` (a required field of report.v1.json), so only a
   * hand-edited or foreign JSON file lacks it.
   */
  specVersion: string | null;
  /**
   * Both sides' grade and score are computed here from each report's
   * results with this version's scoring (skips left out; a report
   * without skip data has its skips read from their wording, as for the
   * per-test statuses), not copied from the files. Otherwise a baseline
   * scored with skips as passes (0.19.0 and earlier) would show a grade
   * drop next to "No changes". What a report recorded, when it differs,
   * is in `recordedScores`.
   */
  baselineGrade: string;
  currentGrade: string;
  baselineScore: number;
  currentScore: number;
  /**
   * Each report's recorded score and grade when they differ from the
   * computed ones above; null when they agree (every report this
   * version writes agrees with itself). `formatDiff` prints a note for
   * each one that differs.
   */
  recordedScores: { baseline: RecordedScore | null; current: RecordedScore | null };
  regressions: DiffEntry[];
  fixes: DiffEntry[];
  newFailures: DiffEntry[];
  newPasses: DiffEntry[];
  removed: DiffEntry[];
  /** See DiffEntry "newlySkipped". Never counted by `hasRegressions`. */
  newlySkipped: DiffEntry[];
  /** See DiffEntry "noLongerSkipped". */
  noLongerSkipped: DiffEntry[];
  /**
   * Whether each report records skips at all. A report written before
   * `TestResult.skipped` existed has its skips read from the markers in
   * its details (see `DiffStatus`), so a check it skipped under a plain
   * pass's wording shows up as "newly skipped" against a newer report
   * even if it skipped then too; `formatDiff` says so.
   */
  recordsSkips: { baseline: boolean; current: boolean };
}

/** Every report this tool writes carries `summary.skipped`; an older one carries no skip data at all. */
function recordsSkips(report: ComplianceReport): boolean {
  return typeof report.summary?.skipped === "number" || report.tests.some((t) => t.skipped !== undefined);
}

/**
 * A report's score and grade under this version's scoring, computed from
 * its results: each test is a skip exactly when the diff reads it as one
 * (`statusOf`), so the score and the per-test statuses agree. Plus what
 * the report itself recorded, when that differs.
 */
function scoreOf(
  report: ComplianceReport,
  records: boolean,
): { score: number; grade: string; recorded: RecordedScore | null } {
  const tests = report.tests.map((t) => {
    const { skipped: _skipped, ...rest } = t;
    return statusOf(t, records) === "skip" ? { ...rest, skipped: true } : rest;
  });
  const { score, grade } = computeScore(tests);
  // A file with no score of its own (hand-written or foreign) has nothing to report as recorded.
  if (typeof report.score !== "number" || (report.score === score && report.grade === grade)) {
    return { score, grade, recorded: null };
  }
  // How 0.19.0 and earlier scored: every skip a pass.
  const asPasses = computeScore(report.tests.map(({ skipped: _skipped, ...t }) => t));
  return {
    score,
    grade,
    recorded: {
      score: report.score,
      grade: report.grade,
      skipsAsPasses: asPasses.score === report.score && asPasses.grade === report.grade,
    },
  };
}

/**
 * Diff two compliance reports. Pure function — no I/O. The CLI loads
 * both files and renders the result.
 *
 * Throws if the two reports were produced against incompatible spec
 * versions. Test ids are only comparable within one spec catalog, so
 * diffing across revisions would silently mis-classify renamed or
 * repurposed test IDs as regressions/fixes. One tool version grades
 * both revisions, so the fix is to pin `--spec-version` on the run
 * whose report drifted — typically an `auto` run against a server that
 * upgraded to a newer spec since the baseline was taken.
 */
export function diffReports(baseline: ComplianceReport, current: ComplianceReport): DiffSummary {
  if (baseline.specVersion && current.specVersion && baseline.specVersion !== current.specVersion) {
    throw new Error(
      `Spec version mismatch: baseline is ${baseline.specVersion}, current is ${current.specVersion}. ` +
        "Test ids are only comparable within one spec revision. " +
        `Re-run the current report with --spec-version ${baseline.specVersion} to keep diffing against this baseline, ` +
        `or take a new baseline with --spec-version ${current.specVersion}.`,
    );
  }

  const baseById = new Map<string, TestResult>(baseline.tests.map((t) => [t.id, t]));
  const curById = new Map<string, TestResult>(current.tests.map((t) => [t.id, t]));
  const records = { baseline: recordsSkips(baseline), current: recordsSkips(current) };

  const regressions: DiffEntry[] = [];
  const fixes: DiffEntry[] = [];
  const newFailures: DiffEntry[] = [];
  const newPasses: DiffEntry[] = [];
  const removed: DiffEntry[] = [];
  const newlySkipped: DiffEntry[] = [];
  const noLongerSkipped: DiffEntry[] = [];

  for (const [id, cur] of curById) {
    const base = baseById.get(id);
    const currentStatus = statusOf(cur, records.current);
    if (!base) {
      const kind = currentStatus === "skip" ? "newlySkipped" : currentStatus === "pass" ? "newPass" : "newFail";
      const entry: DiffEntry = {
        id,
        name: cur.name,
        category: cur.category,
        required: cur.required,
        kind,
        currentDetails: cur.details,
        currentStatus,
      };
      (kind === "newlySkipped" ? newlySkipped : kind === "newPass" ? newPasses : newFailures).push(entry);
      continue;
    }
    const baselineStatus = statusOf(base, records.baseline);
    if (baselineStatus === currentStatus) continue;
    // A current failure is a regression whatever the baseline was (a
    // skip that now fails is a new failure the gate must see). A current
    // skip is neither a regression nor a fix: it measured nothing, so a
    // failing check that starts skipping has not been fixed.
    let kind: DiffEntry["kind"];
    let list: DiffEntry[];
    if (currentStatus === "fail") [kind, list] = ["regression", regressions];
    else if (currentStatus === "skip") [kind, list] = ["newlySkipped", newlySkipped];
    else if (baselineStatus === "fail") [kind, list] = ["fix", fixes];
    else [kind, list] = ["noLongerSkipped", noLongerSkipped];
    list.push({
      id,
      name: cur.name,
      category: cur.category,
      required: cur.required,
      kind,
      baselineDetails: base.details,
      currentDetails: cur.details,
      baselineStatus,
      currentStatus,
    });
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
        baselineStatus: statusOf(base, records.baseline),
      });
    }
  }

  const baselineScored = scoreOf(baseline, records.baseline);
  const currentScored = scoreOf(current, records.current);

  return {
    specVersion: current.specVersion || baseline.specVersion || null,
    baselineGrade: baselineScored.grade,
    currentGrade: currentScored.grade,
    baselineScore: baselineScored.score,
    currentScore: currentScored.score,
    recordedScores: { baseline: baselineScored.recorded, current: currentScored.recorded },
    regressions,
    fixes,
    newFailures,
    newPasses,
    removed,
    newlySkipped,
    noLongerSkipped,
    recordsSkips: records,
  };
}

export function formatDiff(summary: DiffSummary): string {
  const lines: string[] = [];
  let arrow = "→";
  if (summary.currentScore > summary.baselineScore) arrow = "↑";
  else if (summary.currentScore < summary.baselineScore) arrow = "↓";
  if (summary.specVersion) lines.push(`Spec version: ${summary.specVersion}`);
  lines.push(
    `Grade ${summary.baselineGrade} (${summary.baselineScore}%) ${arrow} ${summary.currentGrade} (${summary.currentScore}%)`,
  );
  // The grade line scores both reports from their results (see
  // DiffSummary); say so wherever a file recorded something else, so the
  // grade in the file and the grade here cannot silently disagree.
  const recordedNotes: string[] = [];
  for (const side of ["baseline", "current"] as const) {
    const recorded = summary.recordedScores?.[side];
    if (!recorded) continue;
    const records = `The ${side} report records ${recorded.grade} (${recorded.score}%)`;
    recordedNotes.push(
      recorded.skipsAsPasses
        ? `${records}: mcp-compliance 0.19.0 and earlier counted skips as passes.`
        : `${records}, which its results do not give under this version's scoring.`,
    );
    if (!summary.recordsSkips[side]) {
      recordedNotes.push(`The ${side} report predates skip tracking, so its skips are read from their wording.`);
    }
  }
  if (recordedNotes.length > 0) {
    lines.push(
      "Note: both grades are computed here from the reports' results, as this version scores them (skips left out).",
    );
    for (const note of recordedNotes) lines.push(`  ${note}`);
  }
  lines.push("");

  /**
   * An entry with a skip on either side always prints both sides, each
   * tagged with what it was, so a skip never reads as a pass. An entry
   * without one prints exactly as it did before skips were tracked.
   */
  function details(e: DiffEntry) {
    const involvesSkip = e.baselineStatus === "skip" || e.currentStatus === "skip";
    if (!involvesSkip) {
      if (e.baselineDetails && e.currentDetails && e.baselineDetails !== e.currentDetails) {
        lines.push(`      was: ${e.baselineDetails}`);
        lines.push(`      now: ${e.currentDetails}`);
      } else if (e.currentDetails) {
        lines.push(`      ${e.currentDetails}`);
      } else if (e.baselineDetails) {
        lines.push(`      ${e.baselineDetails}`);
      }
      return;
    }
    const tag = (status: DiffStatus | undefined) =>
      status === "skip" ? " (skipped)" : status === "fail" ? " (failed)" : status === "pass" ? " (passed)" : "";
    if (e.baselineStatus === undefined) lines.push("      was: not in the baseline");
    else lines.push(`      was${tag(e.baselineStatus)}: ${e.baselineDetails ?? ""}`);
    if (e.currentStatus !== undefined) lines.push(`      now${tag(e.currentStatus)}: ${e.currentDetails ?? ""}`);
  }

  function section(label: string, entries: DiffEntry[], notes: string[] = []) {
    if (!entries.length) return;
    lines.push(`${label} (${entries.length}):`);
    for (const note of notes) lines.push(`  ${note}`);
    for (const e of entries) {
      const req = e.required ? " [required]" : "";
      lines.push(`  - ${e.id}${req}: ${e.name}`);
      details(e);
    }
    lines.push("");
  }

  section("Regressions", summary.regressions);
  section("Fixes", summary.fixes);
  section("New failures", summary.newFailures);
  section("New passes", summary.newPasses);
  // A report written before skips were tracked has its skips read from
  // their wording (see DiffStatus). One it worded as a plain pass still
  // reads as a pass, so against such a report a pass<->skip transition
  // may be an artefact; say so.
  const baselineUntracked =
    !summary.recordsSkips.baseline && summary.newlySkipped.some((e) => e.baselineStatus === "pass");
  section("Newly skipped", summary.newlySkipped, [
    "Measured nothing in the current run; left out of its score, and neither regressions nor fixes.",
    ...(baselineUntracked
      ? [
          "Note: the baseline report predates skip tracking, so its skips are read from their wording; a check it skipped without saying so reads as a pass there, and some of these may have been skipped then too.",
        ]
      : []),
  ]);
  section("No longer skipped", summary.noLongerSkipped, [
    "Measured something in the current run after skipping in the baseline; not counted as fixes.",
    ...(summary.recordsSkips.current
      ? []
      : [
          "Note: the current report predates skip tracking, so its skips are read from their wording; a check it skipped without saying so reads as a pass there, and some of these may still be skipped.",
        ]),
  ]);
  section("Removed tests", summary.removed);

  if (
    summary.regressions.length +
      summary.fixes.length +
      summary.newFailures.length +
      summary.newPasses.length +
      summary.newlySkipped.length +
      summary.noLongerSkipped.length +
      summary.removed.length ===
    0
  ) {
    lines.push("No changes between baseline and current.");
  }

  return lines.join("\n");
}

/**
 * Whether the current report regressed: a check that passed or skipped
 * in the baseline now fails, or a new required check fails. A check that
 * starts or stops skipping is reported but never gates.
 */
export function hasRegressions(summary: DiffSummary): boolean {
  return summary.regressions.length > 0 || summary.newFailures.some((e) => e.required);
}
