import { describe, expect, it } from "vitest";
import { computeGrade, computeScore } from "../grader.js";
import { nothingMeasuredNote } from "../reporter.js";
import type { ComplianceReport, TestResult } from "../types.js";

describe("computeGrade", () => {
  it("returns A for 90+", () => {
    expect(computeGrade(90)).toBe("A");
    expect(computeGrade(100)).toBe("A");
  });
  it("returns B for 75-89", () => {
    expect(computeGrade(75)).toBe("B");
    expect(computeGrade(89)).toBe("B");
  });
  it("returns C for 60-74", () => {
    expect(computeGrade(60)).toBe("C");
    expect(computeGrade(74)).toBe("C");
  });
  it("returns D for 40-59", () => {
    expect(computeGrade(40)).toBe("D");
    expect(computeGrade(59)).toBe("D");
  });
  it("returns F for below 40", () => {
    expect(computeGrade(0)).toBe("F");
    expect(computeGrade(39)).toBe("F");
  });
});

describe("computeScore", () => {
  function makeTest(passed: boolean, required: boolean, category = "transport"): TestResult {
    return {
      id: `test-${Math.random()}`,
      name: "Test",
      category: category as TestResult["category"],
      passed,
      required,
      details: "",
      durationMs: 10,
    };
  }

  it("returns 100% when all tests pass", () => {
    const tests = [makeTest(true, true), makeTest(true, true), makeTest(true, false)];
    const result = computeScore(tests);
    expect(result.score).toBe(100);
    expect(result.grade).toBe("A");
    expect(result.overall).toBe("pass");
  });

  it("returns fail when required tests fail", () => {
    const tests = [makeTest(false, true), makeTest(true, false)];
    const result = computeScore(tests);
    expect(result.overall).toBe("fail");
  });

  it("returns partial when all required pass but some optional fail", () => {
    const tests = [makeTest(true, true), makeTest(false, false)];
    const result = computeScore(tests);
    expect(result.overall).toBe("partial");
  });

  it("computes categories correctly", () => {
    const tests = [
      makeTest(true, true, "transport"),
      makeTest(false, false, "transport"),
      makeTest(true, true, "lifecycle"),
    ];
    const result = computeScore(tests);
    expect(result.categories.transport).toEqual({ passed: 1, total: 2, skipped: 0 });
    expect(result.categories.lifecycle).toEqual({ passed: 1, total: 1, skipped: 0 });
  });

  it("handles all required tests failing", () => {
    const tests = [makeTest(false, true), makeTest(false, true), makeTest(false, false)];
    const result = computeScore(tests);
    expect(result.score).toBe(0);
    expect(result.grade).toBe("F");
    expect(result.overall).toBe("fail");
    expect(result.summary.requiredPassed).toBe(0);
  });

  it("handles no optional tests", () => {
    const tests = [makeTest(true, true), makeTest(true, true)];
    const result = computeScore(tests);
    expect(result.score).toBe(100);
    expect(result.overall).toBe("pass");
  });

  it("handles no required tests (optional renormalized to 100%)", () => {
    const tests = [makeTest(true, false), makeTest(false, false)];
    const result = computeScore(tests);
    // With no required tests, optional is scored against 100%, not 30% +
    // a "free" 70. 1/2 optional passing = 50%.
    expect(result.score).toBe(50);
    expect(result.overall).toBe("partial");
  });

  it("handles no optional tests (required renormalized to 100%)", () => {
    const tests = [makeTest(true, true), makeTest(false, true)];
    const result = computeScore(tests);
    // With no optional tests, required is scored against 100%, not 70% +
    // a "free" 30. 1/2 required passing = 50%, and a required failure
    // still drops overall to "fail".
    expect(result.score).toBe(50);
    expect(result.overall).toBe("fail");
  });

  it("handles empty test array (nothing to attest = fail)", () => {
    const result = computeScore([]);
    // Previously awarded 100/A/pass for free. An empty run is "no data",
    // not "passed" — score 0, grade F, overall fail.
    expect(result.score).toBe(0);
    expect(result.grade).toBe("F");
    expect(result.overall).toBe("fail");
    expect(result.summary.total).toBe(0);
    expect(result.summary.skipped).toBe(0);
  });
});

/**
 * Skips are checks that measured nothing. They are recorded as passes so
 * they do not read as failures, which is exactly why they need counting
 * separately: without it a gated server whose whole auth suite skipped is
 * indistinguishable from one that satisfied every check. The score leaves
 * them out of both its numerator and its denominator.
 */
describe("computeScore — skipped checks", () => {
  function makeTest(passed: boolean, required: boolean, category = "transport"): TestResult {
    return {
      id: `test-${Math.random()}`,
      name: "Test",
      category: category as TestResult["category"],
      passed,
      required,
      details: "",
      durationMs: 10,
    };
  }

  function makeSkip(required: boolean, category = "transport"): TestResult {
    return { ...makeTest(true, required, category), skipped: true, details: "Skipped: no --auth provided" };
  }

  /** The pre-change score: the same tests with the flag stripped, so every skip scores as a pass. */
  function scoreCountingSkipsAsPasses(tests: TestResult[]): number {
    return computeScore(tests.map(({ skipped: _s, ...t }) => t)).score;
  }

  /** nothingMeasuredNote reads only the test list and summary of a report. */
  function noteFor(tests: TestResult[]): string | null {
    return nothingMeasuredNote({ summary: computeScore(tests).summary, tests } as unknown as ComplianceReport);
  }

  it("counts skips in summary.skipped and per category, while leaving them inside passed", () => {
    const tests = [
      makeTest(true, true, "transport"),
      makeSkip(false, "security"),
      makeSkip(false, "security"),
      makeTest(false, false, "security"),
    ];
    const result = computeScore(tests);
    expect(result.summary.skipped).toBe(2);
    // The pass total is unchanged: a skip is still not a failure.
    expect(result.summary).toEqual({
      total: 4,
      passed: 3,
      failed: 1,
      required: 1,
      requiredPassed: 1,
      skipped: 2,
    });
    expect(result.categories.security).toEqual({ passed: 2, total: 3, skipped: 2 });
    expect(result.categories.transport).toEqual({ passed: 1, total: 1, skipped: 0 });
  });

  it("leaves a skip in the required bucket out of the score", () => {
    // Measured required: 1 pass, 1 fail -> 1/2; optional 1/1.
    // 0.5 * 70 + 1 * 30 = 65. Scored as a pass the skip made it 2/3 -> 77.
    const tests = [makeTest(true, true), makeTest(false, true), makeSkip(true), makeTest(true, false)];
    const result = computeScore(tests);
    expect(result.score).toBe(65);
    expect(result.grade).toBe("C");
    expect(scoreCountingSkipsAsPasses(tests)).toBe(77);
    // Counts and overall keep their meaning: the skip is a required pass.
    expect(result.summary).toEqual({ total: 4, passed: 3, failed: 1, required: 3, requiredPassed: 2, skipped: 1 });
    expect(result.overall).toBe("fail");
  });

  it("leaves a skip in the optional bucket out of the score", () => {
    // Required 1/1 -> 70; measured optional: 1 pass, 1 fail -> 1/2 -> 15:
    // 85. Scored as passes the two skips made optional 3/4 -> 92.5 -> 93.
    const tests = [
      makeTest(true, true),
      makeTest(true, false),
      makeTest(false, false),
      makeSkip(false),
      makeSkip(false),
    ];
    const result = computeScore(tests);
    expect(result.score).toBe(85);
    expect(result.grade).toBe("B");
    expect(scoreCountingSkipsAsPasses(tests)).toBe(93);
    expect(result.summary).toEqual({ total: 5, passed: 4, failed: 1, required: 1, requiredPassed: 1, skipped: 2 });
    expect(result.overall).toBe("partial");
  });

  it("renormalises to the required bucket when every optional test skipped", () => {
    // Measured optional is empty, so required carries the whole score:
    // 1/2 * 100 = 50. Scored as passes the skips gave optional 2/2 -> 65.
    const tests = [makeTest(true, true), makeTest(false, true), makeSkip(false), makeSkip(false)];
    const result = computeScore(tests);
    expect(result.score).toBe(50);
    expect(result.grade).toBe("D");
    expect(scoreCountingSkipsAsPasses(tests)).toBe(65);
    expect(noteFor(tests)).toBeNull();
  });

  it("renormalises to the optional bucket when every required test skipped", () => {
    // Measured required is empty, so optional carries the whole score:
    // 1/3 * 100 = 33. Scored as a pass the skip gave required 1/1 -> 80.
    const tests = [makeSkip(true), makeTest(true, false), makeTest(false, false), makeTest(false, false)];
    const result = computeScore(tests);
    expect(result.score).toBe(33);
    expect(result.grade).toBe("F");
    expect(scoreCountingSkipsAsPasses(tests)).toBe(80);
    expect(result.overall).toBe("partial");
    expect(noteFor(tests)).toBeNull();
  });

  it("scores 0 / F when every test that ran skipped, and says in words that nothing was measured", () => {
    const tests = [makeSkip(true, "security"), makeSkip(false, "security"), makeSkip(false, "tools")];
    const result = computeScore(tests);
    // Nothing measured: nothing to attest, the same score and grade as an
    // empty run. Scored as passes the skips made this 100 / A.
    expect(result.score).toBe(0);
    expect(result.grade).toBe("F");
    expect(scoreCountingSkipsAsPasses(tests)).toBe(100);
    // overall keeps its meaning (it is about failures): nothing failed.
    expect(result.overall).toBe("pass");
    expect(result.summary).toEqual({ total: 3, passed: 3, failed: 0, required: 1, requiredPassed: 1, skipped: 3 });
    expect(result.categories.security).toEqual({ passed: 2, total: 2, skipped: 2 });

    // The plain wording the terminal, GitHub, markdown, HTML and SARIF
    // reports and the MCP test tool print for such a run, naming the count.
    expect(noteFor(tests)).toBe(
      "No test measured anything -- all 3 that ran were skipped, and skips are left out of the score",
    );
    const one = [makeSkip(false)];
    expect(computeScore(one).score).toBe(0);
    expect(computeScore(one).grade).toBe("F");
    expect(noteFor(one)).toBe(
      "No test measured anything -- all 1 that ran was skipped, and skips are left out of the score",
    );
  });

  it("says nothing of the kind when anything was measured, or on an empty run (which says 'No tests ran')", () => {
    expect(noteFor([makeSkip(true), makeTest(false, false)])).toBeNull();
    expect(noteFor([makeSkip(true), makeTest(true, false)])).toBeNull();
    expect(noteFor([makeTest(true, true)])).toBeNull();
    expect(noteFor([])).toBeNull();
  });

  it("the drop is weight x F x S / (N x (N - S)) per pool, so a run whose required checks all pass can lose a grade", () => {
    // The CHANGELOG / README / rubric example: 20 required passes; 50
    // optional checks, 15 passing, 15 failing, 20 skipped. Optional drops
    // 30 x 15 x 20 / (50 x 30) = 6 points: 91 (A) -> 85 (B).
    const run = (
      reqPass: number,
      reqFail: number,
      reqSkip: number,
      optPass: number,
      optFail: number,
      optSkip: number,
    ) => [
      ...Array.from({ length: reqPass }, () => makeTest(true, true)),
      ...Array.from({ length: reqFail }, () => makeTest(false, true)),
      ...Array.from({ length: reqSkip }, () => makeSkip(true)),
      ...Array.from({ length: optPass }, () => makeTest(true, false)),
      ...Array.from({ length: optFail }, () => makeTest(false, false)),
      ...Array.from({ length: optSkip }, () => makeSkip(false)),
    ];
    const example = run(20, 0, 0, 15, 15, 20);
    expect(scoreCountingSkipsAsPasses(example)).toBe(91);
    expect(computeScore(example.map(({ skipped: _s, ...t }) => t)).grade).toBe("A");
    expect([computeScore(example).score, computeScore(example).grade]).toEqual([85, "B"]);
    expect(computeScore(example).overall).toBe("partial");

    // The formula against the grader, while both pools keep a measured
    // check: each score is rounded, so the two can differ by under 1.
    const drop = (p: number, f: number, s: number, weight: number) => (weight * f * s) / ((p + f + s) * (p + f));
    const pools: [number, number, number][] = [
      [15, 15, 20],
      [1, 1, 1],
      [3, 7, 11],
      [9, 1, 0],
      [9, 0, 4],
      [2, 5, 16],
    ];
    for (const [rp, rf, rs] of pools) {
      for (const [op, of, os] of pools) {
        const tests = run(rp, rf, rs, op, of, os);
        const moved = scoreCountingSkipsAsPasses(tests) - computeScore(tests).score;
        const expected = drop(rp, rf, rs, 70) + drop(op, of, os, 30);
        expect(Math.abs(moved - expected), JSON.stringify({ rp, rf, rs, op, of, os })).toBeLessThan(1);
        // No failures or no skips in either pool: no move at all.
        if (rf * rs + of * os === 0) expect(moved).toBe(0);
      }
    }
  });

  it("does not move a score without skips (pinned: same as when skips scored as passes)", () => {
    // Required 2/3 -> 46.67, optional 1/3 -> 10: 56.67 -> 57.
    const tests = [
      makeTest(true, true),
      makeTest(true, true),
      makeTest(false, true),
      makeTest(true, false),
      makeTest(false, false),
      makeTest(false, false),
    ];
    const result = computeScore(tests);
    expect(result.score).toBe(57);
    expect(result.grade).toBe("D");
    expect(result.score).toBe(scoreCountingSkipsAsPasses(tests));
    expect(result.summary.skipped).toBe(0);
    expect(noteFor(tests)).toBeNull();
  });

  it("the flag moves only the score: the same tests flagged and unflagged differ in score and nothing else", () => {
    const flagged = [makeTest(true, true), makeSkip(true), makeSkip(false), makeTest(false, false)];
    const unflagged = flagged.map(({ skipped: _skipped, ...t }) => t);
    const withFlags = computeScore(flagged);
    const withoutFlags = computeScore(unflagged);

    // Measured: required 1/1 -> 70, optional 0/1 -> 0: 70 / C.
    expect(withFlags.score).toBe(70);
    expect(withFlags.grade).toBe("C");
    // Unflagged, the skips are ordinary passes: 2/2 * 70 + 1/2 * 30 = 85 / B.
    expect(withoutFlags.score).toBe(85);
    expect(withoutFlags.grade).toBe("B");
    expect(withFlags.overall).toBe(withoutFlags.overall);
    const { skipped: flaggedSkips, ...flaggedCounts } = withFlags.summary;
    const { skipped: unflaggedSkips, ...unflaggedCounts } = withoutFlags.summary;
    expect(flaggedCounts).toEqual(unflaggedCounts);
    expect(flaggedSkips).toBe(2);
    expect(unflaggedSkips).toBe(0);
  });

  it("turning a pass into a skip never raises the score (every run of up to 4 tests)", () => {
    const kinds: [passed: boolean, required: boolean][] = [
      [true, true],
      [false, true],
      [true, false],
      [false, false],
    ];
    let runs: [boolean, boolean][][] = [[]];
    let checked = 0;
    for (let n = 1; n <= 4; n++) {
      runs = runs.flatMap((run) => kinds.map((k) => [...run, k]));
      for (const run of runs) {
        const tests = run.map(([passed, required]) => makeTest(passed, required));
        const base = computeScore(tests).score;
        tests.forEach((t, i) => {
          if (!t.passed) return;
          const withSkip = tests.map((x, j) => (j === i ? { ...x, skipped: true } : x));
          expect(computeScore(withSkip).score, JSON.stringify({ run, skipped: i })).toBeLessThanOrEqual(base);
          checked++;
        });
      }
    }
    // 4^n runs of n tests, half of each run's tests passes on average:
    // sum over n = 1..4 of 4^n * n / 2.
    expect(checked).toBe(2 + 16 + 96 + 512);
  });

  it("a failure is never a skip, however its details are worded", () => {
    // The 2025-11-25 suite reports several failures as "Skipped: …";
    // those must keep counting as failures, in the score too.
    const failedSkip: TestResult = {
      ...makeTest(false, true, "tools"),
      details: "Skipped: tools/list failed",
      skipped: true,
    };
    const result = computeScore([failedSkip]);
    expect(result.summary.failed).toBe(1);
    expect(result.summary.skipped).toBe(0);
    expect(result.categories.tools).toEqual({ passed: 0, total: 1, skipped: 0 });
    // Measured and failed: 0 / F / fail, not "nothing measured".
    expect(result.score).toBe(0);
    expect(result.overall).toBe("fail");
    expect(noteFor([failedSkip])).toBeNull();
    // Next to a required pass it is still half the required bucket.
    expect(computeScore([failedSkip, makeTest(true, true)]).score).toBe(50);
  });

  it("a report from an older tool (no flags anywhere) reports zero skips", () => {
    const result = computeScore([makeTest(true, true), makeTest(true, false)]);
    expect(result.summary.skipped).toBe(0);
    expect(result.score).toBe(100);
  });
});
