import { describe, expect, it } from "vitest";
import { computeGrade, computeScore } from "../grader.js";
import type { TestResult } from "../types.js";

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
 * indistinguishable from one that satisfied every check.
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

  it("does NOT move the score, grade or overall: the denominator is deliberately unchanged", () => {
    // Pinned so a later change to the score math is a conscious decision
    // and not a side effect of surfacing the flag. Same tests, one run
    // flagging its skips and one not: identical verdicts.
    const flagged = [makeTest(true, true), makeSkip(true), makeSkip(false), makeTest(false, false)];
    const unflagged = flagged.map(({ skipped: _skipped, ...t }) => t);
    const withFlags = computeScore(flagged);
    const withoutFlags = computeScore(unflagged);

    expect(withFlags.score).toBe(withoutFlags.score);
    expect(withFlags.grade).toBe(withoutFlags.grade);
    expect(withFlags.overall).toBe(withoutFlags.overall);
    // 2/2 required * 70 + 1/2 optional * 30 = 85, skips counted as passes.
    expect(withFlags.score).toBe(85);
    expect(withFlags.summary.passed).toBe(3);
    expect(withFlags.summary.skipped).toBe(2);
    expect(withoutFlags.summary.skipped).toBe(0);
  });

  it("a failure is never a skip, however its details are worded", () => {
    // The 2025-11-25 suite reports several failures as "Skipped: …";
    // those must keep counting as failures.
    const failedSkip: TestResult = {
      ...makeTest(false, true, "tools"),
      details: "Skipped: tools/list failed",
      skipped: true,
    };
    const result = computeScore([failedSkip]);
    expect(result.summary.failed).toBe(1);
    expect(result.summary.skipped).toBe(0);
    expect(result.categories.tools).toEqual({ passed: 0, total: 1, skipped: 0 });
  });

  it("a report from an older tool (no flags anywhere) reports zero skips", () => {
    const result = computeScore([makeTest(true, true), makeTest(true, false)]);
    expect(result.summary.skipped).toBe(0);
    expect(result.score).toBe(100);
  });
});
