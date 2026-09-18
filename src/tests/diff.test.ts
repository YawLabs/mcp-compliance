import { describe, expect, it } from "vitest";
import { type DiffEntry, type DiffSummary, diffReports, formatDiff, hasRegressions } from "../diff.js";
import { computeScore } from "../grader.js";
import { readsAsSkip } from "../harness.js";
import type { ComplianceReport, TestResult } from "../types.js";

function stubReport(over: Partial<ComplianceReport> = {}): ComplianceReport {
  return {
    schemaVersion: "1.0.0",
    specVersion: "2025-11-25",
    toolVersion: "0.0.0-test",
    url: "http://example.com/mcp",
    timestamp: "2025-01-01T00:00:00.000Z",
    score: 100,
    grade: "A",
    overall: "pass",
    summary: { total: 0, passed: 0, failed: 0, required: 0, requiredPassed: 0 },
    categories: {},
    tests: [],
    warnings: [],
    serverInfo: { protocolVersion: "2025-11-25", name: "test", version: "1.0.0", capabilities: {} },
    toolCount: 0,
    toolNames: [],
    resourceCount: 0,
    resourceNames: [],
    promptCount: 0,
    promptNames: [],
    badge: {
      imageUrl: "https://mcp.hosting/x",
      reportUrl: "https://mcp.hosting/r",
      markdown: "",
      html: "",
    },
    ...over,
  };
}

describe("diffReports — spec version guard", () => {
  it("throws on mismatched specVersion between baseline and current", () => {
    const baseline = stubReport({ specVersion: "2025-06-18" });
    const current = stubReport({ specVersion: "2025-11-25" });
    expect(() => diffReports(baseline, current)).toThrow(/Spec version mismatch/);
  });

  // The case a CI job hits the day its server upgrades: the stored
  // baseline is 2025-11-25, `auto` now resolves to 2026-07-28. One tool
  // version grades both, so the remedy is to pin the run, not to change
  // tool versions.
  it("names both versions and suggests pinning --spec-version to the baseline's", () => {
    const baseline = stubReport({ specVersion: "2025-11-25" });
    const current = stubReport({ specVersion: "2026-07-28" });
    let message = "";
    try {
      diffReports(baseline, current);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/Spec version mismatch: baseline is 2025-11-25, current is 2026-07-28/);
    expect(message).toContain("--spec-version 2025-11-25");
    expect(message).toContain("--spec-version 2026-07-28");
    expect(message).not.toMatch(/downgrade the tool/);
  });

  it("records the shared specVersion on the summary and prints it", () => {
    const summary = diffReports(stubReport({ specVersion: "2026-07-28" }), stubReport({ specVersion: "2026-07-28" }));
    expect(summary.specVersion).toBe("2026-07-28");
    expect(formatDiff(summary)).toContain("Spec version: 2026-07-28");
  });

  it("falls back to whichever side records a specVersion, else null", () => {
    const baseOnly = diffReports(stubReport({ specVersion: "2025-11-25" }), stubReport({ specVersion: undefined }));
    expect(baseOnly.specVersion).toBe("2025-11-25");
    const neither = diffReports(stubReport({ specVersion: undefined }), stubReport({ specVersion: undefined }));
    expect(neither.specVersion).toBeNull();
    expect(formatDiff(neither)).not.toContain("Spec version:");
  });

  it("allows matching specVersion to diff normally", () => {
    const baseline = stubReport({
      tests: [
        {
          id: "t1",
          name: "t1",
          category: "transport",
          required: true,
          passed: true,
          details: "ok",
          durationMs: 1,
          specRef: "x",
        },
      ],
    });
    const current = stubReport({
      tests: [
        {
          id: "t1",
          name: "t1",
          category: "transport",
          required: true,
          passed: false,
          details: "broke",
          durationMs: 1,
          specRef: "x",
        },
      ],
    });
    const summary = diffReports(baseline, current);
    expect(summary.regressions).toHaveLength(1);
    expect(summary.regressions[0].id).toBe("t1");
    expect(hasRegressions(summary)).toBe(true);
  });

  it("tolerates missing specVersion on either side (legacy reports)", () => {
    const baseline = stubReport({ specVersion: undefined as unknown as string });
    const current = stubReport();
    expect(() => diffReports(baseline, current)).not.toThrow();
  });
});

/**
 * A skip is `passed: true` with `skipped: true`: the check measured
 * nothing. Diffing on `passed` alone made a check that started (or
 * stopped) skipping invisible -- `passed` is equal on both sides -- and
 * listed a failing check that started skipping as a "fix".
 */
describe("diffReports / formatDiff — skipped checks", () => {
  type Status = "pass" | "fail" | "skip";
  function result(id: string, status: Status, details: string, required = false): TestResult {
    return {
      id,
      name: `name of ${id}`,
      category: "security",
      required,
      passed: status !== "fail",
      ...(status === "skip" ? { skipped: true } : {}),
      details,
      durationMs: 1,
      specRef: "x",
    };
  }
  /** A report as this tool writes it: summary and categories carry the skip counts. */
  function reportOf(tests: TestResult[]): ComplianceReport {
    const s = computeScore(tests);
    return stubReport({ score: s.score, grade: s.grade, summary: s.summary, categories: s.categories, tests });
  }
  /** The same report as a tool that predates the flag would have written it. */
  function unflagged(report: ComplianceReport): ComplianceReport {
    const { skipped: _count, ...summary } = report.summary;
    return { ...report, summary, tests: report.tests.map(({ skipped: _s, ...t }) => t) };
  }
  const SKIP = "Skipped: not evaluable (see security-auth-required)";
  /** A vacuous pass worded with no skip marker; the current tool flags it explicitly. */
  const UNMARKED = "No tools to validate";
  const BASELINE_NOTE =
    "Note: the baseline report predates skip tracking, so its skips are read from their wording; a check it skipped without saying so reads as a pass there, and some of these may have been skipped then too.";
  const CURRENT_NOTE =
    "Note: the current report predates skip tracking, so its skips are read from their wording; a check it skipped without saying so reads as a pass there, and some of these may still be skipped.";
  const idsOf = (entries: DiffEntry[]) => entries.map((e) => e.id);
  const kindsOf = (s: DiffSummary) => ({
    regressions: idsOf(s.regressions),
    fixes: idsOf(s.fixes),
    newFailures: idsOf(s.newFailures),
    newPasses: idsOf(s.newPasses),
    newlySkipped: idsOf(s.newlySkipped ?? []),
    noLongerSkipped: idsOf(s.noLongerSkipped ?? []),
    removed: idsOf(s.removed),
  });
  const NONE = {
    regressions: [],
    fixes: [],
    newFailures: [],
    newPasses: [],
    newlySkipped: [],
    noLongerSkipped: [],
    removed: [],
  };

  it("pass -> skip is reported as newly skipped, not a regression, and does not gate", () => {
    const summary = diffReports(
      reportOf([result("a", "pass", "HTTP 401 (unauthenticated request rejected)", true)]),
      reportOf([result("a", "skip", SKIP, true)]),
    );
    expect(kindsOf(summary)).toEqual({ ...NONE, newlySkipped: ["a"] });
    expect(summary.newlySkipped[0]).toMatchObject({
      kind: "newlySkipped",
      baselineStatus: "pass",
      currentStatus: "skip",
    });
    expect(hasRegressions(summary)).toBe(false);
    const out = formatDiff(summary);
    expect(out).toContain(
      [
        "Newly skipped (1):",
        "  Measured nothing in the current run; left out of its score, and neither regressions nor fixes.",
        "  - a [required]: name of a",
        "      was (passed): HTTP 401 (unauthenticated request rejected)",
        `      now (skipped): ${SKIP}`,
      ].join("\n"),
    );
    expect(out).not.toContain("No changes between baseline and current.");
  });

  it("skip -> pass is reported as no longer skipped, not a fix", () => {
    const summary = diffReports(reportOf([result("a", "skip", SKIP)]), reportOf([result("a", "pass", "HTTP 401")]));
    expect(kindsOf(summary)).toEqual({ ...NONE, noLongerSkipped: ["a"] });
    expect(summary.noLongerSkipped[0]).toMatchObject({ baselineStatus: "skip", currentStatus: "pass" });
    expect(hasRegressions(summary)).toBe(false);
    expect(formatDiff(summary)).toContain(
      [
        "No longer skipped (1):",
        "  Measured something in the current run after skipping in the baseline; not counted as fixes.",
        "  - a: name of a",
        `      was (skipped): ${SKIP}`,
        "      now (passed): HTTP 401",
      ].join("\n"),
    );
  });

  it("fail -> skip is newly skipped, not a fix: the check stopped failing by measuring nothing", () => {
    const summary = diffReports(
      reportOf([result("a", "fail", "HTTP 200 (accepted)")]),
      reportOf([result("a", "skip", SKIP)]),
    );
    expect(kindsOf(summary)).toEqual({ ...NONE, newlySkipped: ["a"] });
    const out = formatDiff(summary);
    expect(out).toContain(["      was (failed): HTTP 200 (accepted)", `      now (skipped): ${SKIP}`].join("\n"));
    expect(out).not.toContain("Fixes");
  });

  it("skip -> fail is still a regression, and still gates, with the skip named", () => {
    const summary = diffReports(
      reportOf([result("a", "skip", SKIP)]),
      reportOf([result("a", "fail", "HTTP 200 (accepted)")]),
    );
    expect(kindsOf(summary)).toEqual({ ...NONE, regressions: ["a"] });
    expect(summary.regressions[0]).toMatchObject({ baselineStatus: "skip", currentStatus: "fail" });
    expect(hasRegressions(summary)).toBe(true);
    expect(formatDiff(summary)).toContain(
      [
        "Regressions (1):",
        "  - a: name of a",
        `      was (skipped): ${SKIP}`,
        "      now (failed): HTTP 200 (accepted)",
      ].join("\n"),
    );
  });

  it("a new test that skips is newly skipped, not a new pass", () => {
    const summary = diffReports(reportOf([]), reportOf([result("a", "skip", SKIP, true)]));
    expect(kindsOf(summary)).toEqual({ ...NONE, newlySkipped: ["a"] });
    expect(hasRegressions(summary)).toBe(false);
    expect(formatDiff(summary)).toContain(
      ["  - a [required]: name of a", "      was: not in the baseline", `      now (skipped): ${SKIP}`].join("\n"),
    );
  });

  it("a removed test that skipped says so", () => {
    const summary = diffReports(reportOf([result("a", "skip", SKIP)]), reportOf([]));
    expect(kindsOf(summary)).toEqual({ ...NONE, removed: ["a"] });
    expect(formatDiff(summary)).toContain(
      ["Removed tests (1):", "  - a: name of a", `      was (skipped): ${SKIP}`].join("\n"),
    );
  });

  it("skip -> skip is no change", () => {
    const summary = diffReports(
      reportOf([result("a", "skip", SKIP)]),
      reportOf([result("a", "skip", "Skipped: no --auth provided")]),
    );
    expect(kindsOf(summary)).toEqual(NONE);
    expect(formatDiff(summary)).toContain("No changes between baseline and current.");
  });

  it("the JSON the CLI prints (the summary object) carries both lists and every entry's status", () => {
    const summary = diffReports(
      reportOf([result("a", "pass", "ok"), result("b", "skip", SKIP)]),
      reportOf([result("a", "skip", SKIP), result("b", "pass", "ok")]),
    );
    const parsed = JSON.parse(JSON.stringify(summary, null, 2));
    expect(parsed.newlySkipped).toEqual([
      {
        id: "a",
        name: "name of a",
        category: "security",
        required: false,
        kind: "newlySkipped",
        baselineDetails: "ok",
        currentDetails: SKIP,
        baselineStatus: "pass",
        currentStatus: "skip",
      },
    ]);
    expect(parsed.noLongerSkipped.map((e: DiffEntry) => [e.id, e.kind, e.baselineStatus, e.currentStatus])).toEqual([
      ["b", "noLongerSkipped", "skip", "pass"],
    ]);
    expect(parsed.recordsSkips).toEqual({ baseline: true, current: true });
  });

  it("a report without the flag reads a skip worded as a plain pass as a pass; against such a baseline the output says so", () => {
    // The current tool flags this vacuous pass explicitly (skipped: true);
    // the older tool wrote the same words with no flag and no marker.
    const current = reportOf([result("a", "skip", UNMARKED)]);
    const summary = diffReports(unflagged(current), current);
    expect(summary.recordsSkips).toEqual({ baseline: false, current: true });
    expect(kindsOf(summary)).toEqual({ ...NONE, newlySkipped: ["a"] });
    expect(formatDiff(summary)).toContain(
      [
        "Newly skipped (1):",
        "  Measured nothing in the current run; left out of its score, and neither regressions nor fixes.",
        `  ${BASELINE_NOTE}`,
        "  - a: name of a",
        `      was (passed): ${UNMARKED}`,
        `      now (skipped): ${UNMARKED}`,
      ].join("\n"),
    );
    // The mirror case: a current report without the flag.
    const reversed = diffReports(current, unflagged(current));
    expect(kindsOf(reversed)).toEqual({ ...NONE, noLongerSkipped: ["a"] });
    expect(formatDiff(reversed)).toContain(`  ${CURRENT_NOTE}`);
    // Both sides unflagged: nothing to report, exactly as before.
    const old = diffReports(unflagged(current), unflagged(current));
    expect(kindsOf(old)).toEqual(NONE);
    expect(old.recordsSkips).toEqual({ baseline: false, current: false });
    // A baseline that records skips gets no note.
    expect(formatDiff(diffReports(reportOf([result("a", "pass", "ok")]), current))).not.toContain("Note:");
  });

  /**
   * A baseline written by the released tool (v0.18.x) carries no skip
   * flag, but its skips carry the same wording the harness reads to flag
   * the current run. Reading only the flag listed every one of them as
   * "newly skipped" -- "was (passed): ... (skipped)" -- when nothing had
   * changed. These wordings are verbatim from v0.18.2's src/runner.ts.
   */
  const V0182_SKIPS: Array<[string, string]> = [
    ["lifecycle-logging", "Server does not declare logging capability (skipped)"],
    ["security-auth-required", "Skipped: server does not require auth"],
    ["security-tool-cross-reference", "Fewer than 2 tools — cross-reference check not applicable"],
    ["security-www-authenticate", "HTTP 403 (WWW-Authenticate not applicable for 403)"],
  ];

  it("against a baseline from a tool without the flag, a skip it worded as one and that still skips is no change", () => {
    for (const [, details] of V0182_SKIPS) expect(readsAsSkip(details), details).toBe(true);
    const current = reportOf([
      ...V0182_SKIPS.map(([id, details]) => result(id, "skip", details)),
      result("lifecycle-init", "pass", "Protocol 2025-11-25", true),
      result("tools-list", "fail", "HTTP 500", true),
    ]);
    const summary = diffReports(unflagged(current), current);
    expect(summary.recordsSkips).toEqual({ baseline: false, current: true });
    expect(kindsOf(summary)).toEqual(NONE);
    expect(hasRegressions(summary)).toBe(false);
    expect(formatDiff(summary)).toBe(
      [
        "Spec version: 2025-11-25",
        `Grade ${current.grade} (${current.score}%) → ${current.grade} (${current.score}%)`,
        "",
        "No changes between baseline and current.",
      ].join("\n"),
    );
    // The mirror case: a current report without the flag, against one with it.
    expect(kindsOf(diffReports(current, unflagged(current)))).toEqual(NONE);
  });

  it("against a baseline without the flag, a check leaving or entering a marker-worded skip is reported like any skip", () => {
    const baseline = unflagged(
      reportOf([
        result("now-passes", "skip", "Server does not declare logging capability (skipped)"),
        result("now-fails", "skip", "Skipped: server does not require auth"),
        result("now-skips", "pass", "HTTP 401 (unauthenticated request rejected)"),
        // A failure is never read as a skip, however it is worded: the
        // 2025-11-25 suite's "Skipped: tools/list failed" is a failure.
        result("was-failing", "fail", "Skipped: tools/list failed"),
      ]),
    );
    const current = reportOf([
      result("now-passes", "pass", "logging/setLevel accepted"),
      result("now-fails", "fail", "HTTP 200 (accepted without credentials)"),
      result("now-skips", "skip", "Skipped: server does not require auth"),
      result("was-failing", "pass", "3 tools with valid schemas"),
    ]);
    const summary = diffReports(baseline, current);
    expect(kindsOf(summary)).toEqual({
      ...NONE,
      regressions: ["now-fails"],
      fixes: ["was-failing"],
      newlySkipped: ["now-skips"],
      noLongerSkipped: ["now-passes"],
    });
    expect(summary.noLongerSkipped[0]).toMatchObject({ baselineStatus: "skip", currentStatus: "pass" });
    expect(summary.regressions[0]).toMatchObject({ baselineStatus: "skip", currentStatus: "fail" });
    expect(summary.fixes[0]).toMatchObject({ baselineStatus: "fail", currentStatus: "pass" });
    expect(hasRegressions(summary)).toBe(true);
    const out = formatDiff(summary);
    expect(out).toContain(
      [
        "Regressions (1):",
        "  - now-fails: name of now-fails",
        "      was (skipped): Skipped: server does not require auth",
        "      now (failed): HTTP 200 (accepted without credentials)",
      ].join("\n"),
    );
    expect(out).toContain(
      [
        "No longer skipped (1):",
        "  Measured something in the current run after skipping in the baseline; not counted as fixes.",
        "  - now-passes: name of now-passes",
        "      was (skipped): Server does not declare logging capability (skipped)",
        "      now (passed): logging/setLevel accepted",
      ].join("\n"),
    );
    // The baseline worded "now-skips" as a plain pass, which may have
    // been vacuous: the hedge stays for that one.
    expect(out).toContain(
      [
        "Newly skipped (1):",
        "  Measured nothing in the current run; left out of its score, and neither regressions nor fixes.",
        `  ${BASELINE_NOTE}`,
        "  - now-skips: name of now-skips",
      ].join("\n"),
    );
  });

  it("two reports that both predate the flag: a marker-worded skip that stays is no change, one that ends is no longer skipped", () => {
    const summary = diffReports(
      unflagged(
        reportOf([
          result("stays", "skip", "Skipped: server does not issue session IDs"),
          result("ends", "skip", "Skipped: server does not require auth"),
        ]),
      ),
      unflagged(
        reportOf([
          result("stays", "skip", "Server does not issue session IDs (skipped)"),
          result("ends", "pass", "HTTP 401 (unauthenticated request rejected)"),
        ]),
      ),
    );
    expect(summary.recordsSkips).toEqual({ baseline: false, current: false });
    expect(kindsOf(summary)).toEqual({ ...NONE, noLongerSkipped: ["ends"] });
    expect(hasRegressions(summary)).toBe(false);
    expect(formatDiff(summary)).toContain(
      [
        "No longer skipped (1):",
        "  Measured something in the current run after skipping in the baseline; not counted as fixes.",
        `  ${CURRENT_NOTE}`,
        "  - ends: name of ends",
        "      was (skipped): Skipped: server does not require auth",
        "      now (passed): HTTP 401 (unauthenticated request rejected)",
      ].join("\n"),
    );
  });

  /**
   * Decision pinned: the diff JSON always carries the skip fields --
   * `newlySkipped`, `noLongerSkipped`, `recordsSkips`, and each entry's
   * `baselineStatus` / `currentStatus` -- even when neither report has a
   * skip. They are additive (every earlier field is unchanged), the
   * report JSON likewise always carries `summary.skipped`, and a consumer
   * can read `newlySkipped.length` without guarding for a missing key.
   * Only the terminal diff is byte-identical to the pre-skip output for a
   * no-skip diff (pinned below).
   */
  it("the JSON for two reports without any skip data keeps every earlier field and adds the skip fields (pinned)", () => {
    const base = unflagged(
      reportOf([result("lifecycle-init", "pass", "Protocol 2025-11-25", true), result("ping", "pass", "ok")]),
    );
    const cur = unflagged(reportOf([result("lifecycle-init", "fail", "HTTP 500", true), result("ping", "pass", "ok")]));
    const summary = diffReports(base, cur);
    expect(hasRegressions(summary)).toBe(true);
    expect(JSON.parse(JSON.stringify(summary, null, 2))).toEqual({
      specVersion: "2025-11-25",
      baselineGrade: base.grade,
      currentGrade: cur.grade,
      baselineScore: base.score,
      currentScore: cur.score,
      // Both reports were scored as this version scores: nothing to note.
      recordedScores: { baseline: null, current: null },
      regressions: [
        {
          id: "lifecycle-init",
          name: "name of lifecycle-init",
          category: "security",
          required: true,
          kind: "regression",
          baselineDetails: "Protocol 2025-11-25",
          currentDetails: "HTTP 500",
          baselineStatus: "pass",
          currentStatus: "fail",
        },
      ],
      fixes: [],
      newFailures: [],
      newPasses: [],
      removed: [],
      newlySkipped: [],
      noLongerSkipped: [],
      recordsSkips: { baseline: false, current: false },
    });
  });

  it("a diff with no skip on either side prints exactly what it printed before skips were tracked (pinned)", () => {
    const baseline = reportOf([
      result("reg", "pass", "HTTP 200", true),
      result("fix", "fail", "HTTP 500"),
      result("same", "pass", "ok"),
      result("gone", "fail", "HTTP 404"),
      result("flip", "pass", "same text"),
    ]);
    const current = reportOf([
      result("reg", "fail", "HTTP 500", true),
      result("fix", "pass", "HTTP 200"),
      result("same", "pass", "ok"),
      result("newf", "fail", "boom", true),
      result("newp", "pass", "fine"),
      result("flip", "fail", "same text"),
    ]);
    // Required 1/1 -> 70, optional 2/4 -> 15: 85 (B); required 0/2,
    // optional 3/4 -> 22.5: 23 (F).
    expect([baseline.score, baseline.grade, current.score, current.grade]).toEqual([85, "B", 23, "F"]);
    const summary = diffReports(baseline, current);
    expect(summary.recordedScores).toEqual({ baseline: null, current: null });
    expect(kindsOf(summary)).toEqual({
      ...NONE,
      regressions: ["reg", "flip"],
      fixes: ["fix"],
      newFailures: ["newf"],
      newPasses: ["newp"],
      removed: ["gone"],
    });
    expect(summary.regressions[0]).toMatchObject({
      id: "reg",
      kind: "regression",
      baselineDetails: "HTTP 200",
      currentDetails: "HTTP 500",
    });
    expect(hasRegressions(summary)).toBe(true);
    expect(formatDiff(summary)).toBe(
      [
        "Spec version: 2025-11-25",
        "Grade B (85%) ↓ F (23%)",
        "",
        "Regressions (2):",
        "  - reg [required]: name of reg",
        "      was: HTTP 200",
        "      now: HTTP 500",
        "  - flip: name of flip",
        "      same text",
        "",
        "Fixes (1):",
        "  - fix: name of fix",
        "      was: HTTP 500",
        "      now: HTTP 200",
        "",
        "New failures (1):",
        "  - newf [required]: name of newf",
        "      boom",
        "",
        "New passes (1):",
        "  - newp: name of newp",
        "      fine",
        "",
        "Removed tests (1):",
        "  - gone: name of gone",
        "      HTTP 404",
        "",
      ].join("\n"),
    );
    expect(formatDiff(diffReports(baseline, baseline))).toBe(
      [
        "Spec version: 2025-11-25",
        `Grade ${baseline.grade} (${baseline.score}%) → ${baseline.grade} (${baseline.score}%)`,
        "",
        "No changes between baseline and current.",
      ].join("\n"),
    );
  });

  /**
   * The score leaves skips out; 0.19.0 and earlier scored them as passes.
   * Copying each file's stored score onto the grade line put a baseline
   * scored the old way next to a current report scored the new way: a
   * two-grade "drop" above "No changes". Both sides are now scored from
   * their results, and a file that recorded something else is named.
   */
  describe("the grade line scores both reports the same way", () => {
    const NOTE_HEAD =
      "Note: both grades are computed here from the reports' results, as this version scores them (skips left out).";
    /** Scored as 0.19.0 scored: every skip a pass. */
    const asV0190 = (report: ComplianceReport): ComplianceReport => {
      const old = computeScore(report.tests.map(({ skipped: _s, ...t }) => t));
      return { ...report, score: old.score, grade: old.grade, toolVersion: "0.19.0" };
    };
    /**
     * The shape of the Host-guarded --only security run: 23 optional
     * checks, 16 skips, 2 measured passes, 5 failures.
     */
    const hostGuardedTests = (): TestResult[] => [
      ...Array.from({ length: 16 }, (_, i) => result(`s${i}`, "skip", "Skipped: no --auth provided")),
      result("p0", "pass", "ok"),
      result("p1", "pass", "ok"),
      ...Array.from({ length: 5 }, (_, i) => result(`f${i}`, "fail", "bad")),
    ];

    it("a baseline scored by 0.19.0 with the same results: no grade move, and a note naming what the file recorded", () => {
      const current = reportOf(hostGuardedTests());
      const baseline = asV0190(current);
      // The two files disagree only in how they scored the skips.
      expect([current.score, current.grade]).toEqual([29, "F"]);
      expect([baseline.score, baseline.grade]).toEqual([78, "B"]);

      const summary = diffReports(baseline, current);
      expect([summary.baselineGrade, summary.baselineScore]).toEqual(["F", 29]);
      expect([summary.currentGrade, summary.currentScore]).toEqual(["F", 29]);
      expect(summary.recordedScores).toEqual({
        baseline: { score: 78, grade: "B", skipsAsPasses: true },
        current: null,
      });
      expect(kindsOf(summary)).toEqual(NONE);
      expect(hasRegressions(summary)).toBe(false);
      expect(formatDiff(summary)).toBe(
        [
          "Spec version: 2025-11-25",
          "Grade F (29%) → F (29%)",
          NOTE_HEAD,
          "  The baseline report records B (78%): mcp-compliance 0.19.0 and earlier counted skips as passes.",
          "",
          "No changes between baseline and current.",
        ].join("\n"),
      );
    });

    it("a real change between two reports scored by 0.19.0 moves the measured score, and both files are named", () => {
      // One measured pass now fails. Stored: 18/23 = 78 (B) -> 17/23 = 74
      // (C); measured: 2/7 = 29 -> 1/7 = 14, both F.
      const baseline = asV0190(reportOf(hostGuardedTests()));
      const current = asV0190(
        reportOf(hostGuardedTests().map((t) => (t.id === "p1" ? result("p1", "fail", "bad") : t))),
      );
      expect([baseline.score, current.score]).toEqual([78, 74]);
      const summary = diffReports(baseline, current);
      expect(kindsOf(summary)).toEqual({ ...NONE, regressions: ["p1"] });
      const out = formatDiff(summary);
      expect(out.split("\n").slice(0, 5)).toEqual([
        "Spec version: 2025-11-25",
        "Grade F (29%) ↓ F (14%)",
        NOTE_HEAD,
        "  The baseline report records B (78%): mcp-compliance 0.19.0 and earlier counted skips as passes.",
        "  The current report records C (74%): mcp-compliance 0.19.0 and earlier counted skips as passes.",
      ]);
    });

    it("a baseline from before skip tracking (0.18.x) is scored from its skip wording, and the note says so", () => {
      const current = reportOf(hostGuardedTests());
      const baseline = asV0190(unflagged(current));
      const summary = diffReports(baseline, current);
      expect(summary.recordsSkips).toEqual({ baseline: false, current: true });
      // "Skipped: ..." reads as a skip, so both sides measure the same 7.
      expect([summary.baselineGrade, summary.baselineScore]).toEqual(["F", 29]);
      expect(summary.recordedScores.baseline).toEqual({ score: 78, grade: "B", skipsAsPasses: true });
      expect(kindsOf(summary)).toEqual(NONE);
      expect(formatDiff(summary)).toContain(
        [
          "Grade F (29%) → F (29%)",
          NOTE_HEAD,
          "  The baseline report records B (78%): mcp-compliance 0.19.0 and earlier counted skips as passes.",
          "  The baseline report predates skip tracking, so its skips are read from their wording.",
          "",
        ].join("\n"),
      );
    });

    it("a stored score its results do not give for another reason (a hand-edited file) is scored from the results and named", () => {
      const baseline = reportOf([result("a", "pass", "ok", true), result("b", "fail", "bad")]);
      const summary = diffReports({ ...baseline, score: 95, grade: "A" }, baseline);
      expect([summary.baselineGrade, summary.baselineScore]).toEqual([baseline.grade, baseline.score]);
      expect(summary.recordedScores).toEqual({
        baseline: { score: 95, grade: "A", skipsAsPasses: false },
        current: null,
      });
      expect(formatDiff(summary)).toContain(
        [
          `Grade ${baseline.grade} (${baseline.score}%) → ${baseline.grade} (${baseline.score}%)`,
          NOTE_HEAD,
          "  The baseline report records A (95%), which its results do not give under this version's scoring.",
          "",
        ].join("\n"),
      );
    });

    it("a report this version wrote is never noted: its stored score is the one computed from its results", () => {
      const withSkips = reportOf(hostGuardedTests());
      const summary = diffReports(withSkips, withSkips);
      expect(summary.recordedScores).toEqual({ baseline: null, current: null });
      expect([summary.baselineScore, summary.currentScore]).toEqual([withSkips.score, withSkips.score]);
      expect(formatDiff(summary)).not.toContain("Note:");
    });
  });
});
