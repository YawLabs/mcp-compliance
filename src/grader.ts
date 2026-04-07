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

  // Required tests worth 70%, optional worth 30%
  const requiredScore = requiredTests.length > 0 ? (requiredPassed / requiredTests.length) * 70 : 70;
  const optionalTests = tests.filter((t) => !t.required);
  const optionalPassed = optionalTests.filter((t) => t.passed).length;
  const optionalScore = optionalTests.length > 0 ? (optionalPassed / optionalTests.length) * 30 : 30;
  const score = Math.round(requiredScore + optionalScore);

  const overall = requiredPassed === requiredTests.length ? (passed === total ? "pass" : "partial") : "fail";

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
