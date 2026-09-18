import chalk from "chalk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatProgressLine, statusLabel } from "../reporter.js";
import type { TestResult } from "../types.js";

/**
 * The --verbose progress line (src/index.ts prints one per finished test).
 * It used to be built from onProgress's `passed`, on which a skip is a
 * pass, so a check that measured nothing printed PASS.
 */
describe("formatProgressLine", () => {
  let level: typeof chalk.level;
  beforeEach(() => {
    level = chalk.level;
    chalk.level = 1;
  });
  afterEach(() => {
    chalk.level = level;
  });

  const base: TestResult = {
    id: "security-www-authenticate",
    name: "WWW-Authenticate on 401",
    category: "security",
    passed: true,
    required: false,
    details: "HTTP 200 -- not a 401 response (skipped)",
    durationMs: 1,
  };

  it("prints a skip as SKIP in the report's skip colour (yellow)", () => {
    expect(formatProgressLine({ ...base, skipped: true })).toBe(
      `  ${chalk.yellow("SKIP")} security-www-authenticate — HTTP 200 -- not a 401 response (skipped)`,
    );
  });

  it("prints a pass and a failure exactly as the CLI did before skips were tracked (pinned)", () => {
    // The old line, verbatim: `  ${passed ? green PASS : red FAIL} ${testId} — ${details}`.
    const old = (testId: string, passed: boolean, details: string) =>
      `  ${passed ? chalk.green("PASS") : chalk.red("FAIL")} ${testId} — ${details}`;
    const pass = { ...base, details: "WWW-Authenticate: Bearer" };
    expect(formatProgressLine(pass)).toBe(old(pass.id, true, pass.details));
    const fail = { ...base, passed: false, details: "HTTP 401 without WWW-Authenticate" };
    expect(formatProgressLine(fail)).toBe(old(fail.id, false, fail.details));
    // A failure is FAIL whatever it carries.
    expect(formatProgressLine({ ...fail, skipped: true })).toBe(old(fail.id, false, fail.details));
  });

  it("statusLabel: FAIL on any failure, SKIP only on a flagged pass, PASS otherwise", () => {
    expect(statusLabel({ passed: false })).toBe("FAIL");
    expect(statusLabel({ passed: false, skipped: true })).toBe("FAIL");
    expect(statusLabel({ passed: true, skipped: true })).toBe("SKIP");
    expect(statusLabel({ passed: true, skipped: false })).toBe("PASS");
    expect(statusLabel({ passed: true })).toBe("PASS");
  });
});
