import type { Grade, TestResult } from "./types.js";

export function computeGrade(score: number): Grade {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 40) return "D";
  return "F";
}

export function computeScore(tests: TestResult[]): {
  score: number;
  grade: Grade;
  overall: "pass" | "partial" | "fail";
  summary: {
    total: number;
    passed: number;
    failed: number;
    required: number;
    requiredPassed: number;
  };
  categories: Record<string, { passed: number; total: number }>;
} {
  const total = tests.length;
  const passed = tests.filter((t) => t.passed).length;
  const failed = total - passed;

  const requiredTests = tests.filter((t) => t.required);
  const requiredPassed = requiredTests.filter((t) => t.passed).length;
  const optionalTests = tests.filter((t) => !t.required);
  const optionalPassed = optionalTests.filter((t) => t.passed).length;

  // Weighting: required tests are 70% of the score, optional 30%. When one
  // bucket is empty we renormalize to the other — giving "free" credit for
  // an empty bucket (the previous behavior) would inflate the score in
  // edge cases like `--only` filters that exclude all required tests, or
  // capability-gated suites where all remaining tests are optional.
  let score: number;
  if (total === 0) {
    // No tests ran. Not a pass — there is nothing to attest.
    score = 0;
  } else if (requiredTests.length === 0) {
    score = Math.round((optionalPassed / optionalTests.length) * 100);
  } else if (optionalTests.length === 0) {
    score = Math.round((requiredPassed / requiredTests.length) * 100);
  } else {
    score = Math.round((requiredPassed / requiredTests.length) * 70 + (optionalPassed / optionalTests.length) * 30);
  }

  let overall: "pass" | "partial" | "fail";
  if (total === 0) {
    overall = "fail";
  } else if (requiredPassed < requiredTests.length) {
    overall = "fail";
  } else if (passed === total) {
    overall = "pass";
  } else {
    overall = "partial";
  }

  const categories: Record<string, { passed: number; total: number }> = {};
  for (const t of tests) {
    if (!categories[t.category]) categories[t.category] = { passed: 0, total: 0 };
    categories[t.category].total++;
    if (t.passed) categories[t.category].passed++;
  }

  return {
    score,
    grade: computeGrade(score),
    overall,
    summary: { total, passed, failed, required: requiredTests.length, requiredPassed },
    categories,
  };
}
