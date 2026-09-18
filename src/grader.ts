import type { Grade, TestResult } from "./types.js";

export function computeGrade(score: number): Grade {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 40) return "D";
  return "F";
}

/**
 * A check that measured nothing. Skips are `passed: true` (they are not
 * failures), so they stay in `summary.passed`, `summary.total` and the
 * per-category counts, with `summary.skipped` and each category's
 * `skipped` saying how many of those passes they are. The score leaves
 * them out entirely -- see computeScore. A failure is never a skip,
 * whatever flag it carries.
 */
function isSkip(t: TestResult): boolean {
  return t.passed && t.skipped === true;
}

/**
 * Score, grade, overall verdict and counts for one run.
 *
 * The score is computed over MEASURED tests only: a skip (see isSkip) is
 * left out of both the numerator and the denominator, because a check
 * that measured nothing is evidence of neither compliance nor its
 * absence. Counting skips as passes made a run where most checks could
 * not be evaluated (no `--auth`, no tools, a refusal an earlier check
 * could not attribute) read as mostly compliant.
 *
 * Weighting: measured required tests are 70% of the score, measured
 * optional tests 30%. When one measured bucket is empty the other is
 * renormalised to 100% rather than awarding the empty one for free
 * (`--only` filters that exclude every required test, capability-gated
 * suites where everything left is optional, or a bucket whose every test
 * skipped). When nothing was measured at all -- no test ran, or every
 * test that ran was skipped -- the score is 0 and the grade F: there is
 * nothing to attest.
 *
 * Leaving a pass out never raises the score: it lowers or keeps its
 * bucket's ratio, and a bucket it empties was at 100%, so the
 * renormalised score is no higher than the weighted one.
 *
 * Everything else keeps its meaning: `overall` is "fail" on any required
 * failure (or an empty run), "pass" when every test passed, "partial"
 * otherwise; `summary.passed` / `failed` / `total` / `required` /
 * `requiredPassed` count skips as passes (so passed + failed = total), and
 * `summary.skipped` / each category's `skipped` count them.
 */
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
    skipped: number;
  };
  categories: Record<string, { passed: number; total: number; skipped: number }>;
} {
  const total = tests.length;
  const passed = tests.filter((t) => t.passed).length;
  const failed = total - passed;
  const skipped = tests.filter(isSkip).length;

  const requiredTests = tests.filter((t) => t.required);
  const requiredPassed = requiredTests.filter((t) => t.passed).length;

  // The score's buckets: measured tests only.
  const measured = tests.filter((t) => !isSkip(t));
  const measuredRequired = measured.filter((t) => t.required);
  const measuredRequiredPassed = measuredRequired.filter((t) => t.passed).length;
  const measuredOptional = measured.filter((t) => !t.required);
  const measuredOptionalPassed = measuredOptional.filter((t) => t.passed).length;

  let score: number;
  if (measured.length === 0) {
    // No test ran, or every test that ran was skipped. Not a pass --
    // there is nothing to attest.
    score = 0;
  } else if (measuredRequired.length === 0) {
    score = Math.round((measuredOptionalPassed / measuredOptional.length) * 100);
  } else if (measuredOptional.length === 0) {
    score = Math.round((measuredRequiredPassed / measuredRequired.length) * 100);
  } else {
    score = Math.round(
      (measuredRequiredPassed / measuredRequired.length) * 70 + (measuredOptionalPassed / measuredOptional.length) * 30,
    );
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

  const categories: Record<string, { passed: number; total: number; skipped: number }> = {};
  for (const t of tests) {
    if (!categories[t.category]) categories[t.category] = { passed: 0, total: 0, skipped: 0 };
    categories[t.category].total++;
    if (t.passed) categories[t.category].passed++;
    if (isSkip(t)) categories[t.category].skipped++;
  }

  return {
    score,
    grade: computeGrade(score),
    overall,
    summary: { total, passed, failed, required: requiredTests.length, requiredPassed, skipped },
    categories,
  };
}
