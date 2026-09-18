import chalk from "chalk";
import { findTestDefinition } from "./definitions/index.js";
import { REASON_PREFIX } from "./detect.js";
import { AUTO_DETECT_NOTE_PREFIX, isSpecVersion, LEGACY_SPEC_VERSION, type SpecVersion, specBaseFor } from "./spec.js";
import type { ComplianceReport, Grade, TestResult } from "./types.js";

/**
 * The catalog a report's ids belong to. A report always stamps the
 * RESOLVED spec version, but a legacy report (older tool, or one written
 * before `specVersion` existed) may carry an unknown or missing value;
 * those ids are 2025-11-25 ids, so fall back to that catalog rather
 * than throw.
 */
function catalogVersionOf(report: ComplianceReport): SpecVersion {
  return isSpecVersion(report.specVersion) ? report.specVersion : LEGACY_SPEC_VERSION;
}

const CATEGORY_LABELS: Record<string, string> = {
  transport: "Transport",
  lifecycle: "Lifecycle",
  tools: "Tools",
  resources: "Resources",
  prompts: "Prompts",
  errors: "Error Handling",
  schema: "Schema Validation",
  security: "Security",
};

const CATEGORY_ORDER = ["transport", "lifecycle", "tools", "resources", "prompts", "errors", "schema", "security"];

/**
 * Separate the runner's auto-detection note from the real warnings. The
 * note says which spec revision `auto` picked and why; it belongs in the
 * header, not in a list of problems. Returns the note's explanation (the
 * part in parentheses) so the header can say e.g.
 * "2026-07-28 (auto-detected from server/discover: supportedVersions [..])".
 *
 * The runner's reasons all start with "server/discover -> "; that prefix
 * is folded into the label so the terminal line stays within 80 columns
 * for the common shapes (the pin hint lives in --help, not here). A
 * reason without the prefix (an older report) is shown verbatim.
 */
function splitSpecNote(report: ComplianceReport): { specNote: string | null; warnings: string[] } {
  const idx = report.warnings.findIndex((w) => w.startsWith(AUTO_DETECT_NOTE_PREFIX));
  if (idx === -1) return { specNote: null, warnings: report.warnings };
  const note = report.warnings[idx];
  const reason = /\((.*)\)\. Pin with/.exec(note)?.[1] ?? "";
  let specNote = "auto-detected";
  if (reason.startsWith(REASON_PREFIX)) {
    specNote = `auto-detected from server/discover: ${reason.slice(REASON_PREFIX.length)}`;
  } else if (reason) {
    specNote = `auto-detected: ${reason}`;
  }
  return {
    specNote,
    warnings: report.warnings.filter((_, i) => i !== idx),
  };
}

const GRADE_ART: Record<Grade, string[]> = {
  A: [" █████╗ ", "██╔══██╗", "███████║", "██╔══██║", "██║  ██║", "╚═╝  ╚═╝"],
  B: ["██████╗ ", "██╔══██╗", "██████╔╝", "██╔══██╗", "██████╔╝", "╚═════╝ "],
  C: [" ██████╗", "██╔════╝", "██║     ", "██║     ", "╚██████╗", " ╚═════╝"],
  D: ["██████╗ ", "██╔══██╗", "██║  ██║", "██║  ██║", "██████╔╝", "╚═════╝ "],
  F: ["███████╗", "██╔════╝", "█████╗  ", "██╔══╝  ", "██║     ", "╚═╝     "],
};

function gradeColor(grade: Grade): (s: string) => string {
  switch (grade) {
    case "A":
      return (s) => chalk.green.bold(s);
    case "B":
      return (s) => chalk.greenBright.bold(s);
    case "C":
      return (s) => chalk.yellow.bold(s);
    case "D":
      return (s) => chalk.rgb(255, 165, 0).bold(s);
    case "F":
      return (s) => chalk.red.bold(s);
  }
}

function overallColor(overall: string): string {
  switch (overall) {
    case "pass":
      return chalk.green.bold("PASS");
    case "partial":
      return chalk.yellow.bold("PARTIAL");
    case "fail":
      return chalk.red.bold("FAIL");
    default:
      return overall;
  }
}

function makeBar(passed: number, total: number, width = 24): { filled: string; rest: string } {
  if (total === 0) return { filled: "", rest: "─".repeat(width) };
  const n = Math.max(0, Math.min(width, Math.round((passed / total) * width)));
  return { filled: "█".repeat(n), rest: "░".repeat(width - n) };
}

/**
 * A category's measured counts: its passes and total without its skips,
 * the way the score counts them. `skips` is the category's skip count
 * read from the test list (see skippedTestsOf), so a report from an older
 * tool (no flags) reads exactly as its raw counts.
 */
function measuredOf(stats: { passed: number; total: number }, skips: number): { passed: number; total: number } {
  return { passed: Math.max(0, stats.passed - skips), total: Math.max(0, stats.total - skips) };
}

function barColor(passed: number, total: number): (s: string) => string {
  if (total === 0) return (s) => chalk.dim(s);
  const pct = passed / total;
  if (pct >= 1) return (s) => chalk.green(s);
  if (pct >= 0.85) return (s) => chalk.greenBright(s);
  if (pct >= 0.6) return (s) => chalk.yellow(s);
  return (s) => chalk.red(s);
}

function padRight(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function padLeft(s: string, n: number): string {
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

const RULE = "─".repeat(62);
const HEAVY_RULE = "═".repeat(62);

/**
 * Checks that measured nothing. A skip is recorded as `passed: true` (it
 * is not a failure), so without singling it out a reader cannot tell a
 * check the server satisfied from one that never ran -- which is exactly
 * how a gated server's whole auth suite could read as clean. Every
 * formatter names them; the score leaves them out, and the terminal,
 * markdown and HTML reports say so.
 *
 * Read from the test list rather than `summary.skipped`, so every count
 * and list in one report agrees, and a report from an older tool (no
 * flags, no count) reads as zero skips.
 */
export function skippedTestsOf(report: ComplianceReport): TestResult[] {
  return report.tests.filter((t) => t.passed && t.skipped === true);
}

/** The one-line caveat that goes with every list of skips. */
export const SKIP_CAVEAT = "measured nothing -- left out of the score above";

/**
 * Tests ran, but every one of them was a skip: the score leaves skips out,
 * so there was nothing to score and the run reads 0 / F with nothing
 * failed. The terminal, markdown, HTML and GitHub reports, the SARIF
 * invocation properties (`note`) and the MCP test tool say so in these
 * words (as an empty run says "No tests ran"), so the F cannot read as a
 * server that failed everything. The JSON report carries no prose: its
 * reader sees `summary.skipped === summary.total`. Null when anything
 * was measured, and on an empty run.
 */
export function nothingMeasuredNote(report: ComplianceReport): string | null {
  const skipped = skippedTestsOf(report).length;
  if (skipped === 0 || skipped < report.tests.length) return null;
  return `No test measured anything -- all ${skipped} that ran ${skipped === 1 ? "was" : "were"} skipped, and skips are left out of the score`;
}

/**
 * A result's one-word status: a skip is neither PASS nor FAIL. Every
 * per-test line uses it (the HTML tables, the --verbose progress lines,
 * the MCP test tool), so a skip never prints as a pass. A failure is
 * FAIL whatever flag it carries.
 */
export function statusLabel(t: Pick<TestResult, "passed" | "skipped">): "PASS" | "FAIL" | "SKIP" {
  if (!t.passed) return "FAIL";
  return t.skipped === true ? "SKIP" : "PASS";
}

/**
 * One `--verbose` progress line, printed as each test finishes: FAIL red,
 * SKIP yellow (the report's skip colour), PASS green. A result that is
 * not a skip prints exactly the line the CLI printed before SKIP existed.
 */
export function formatProgressLine(result: TestResult): string {
  const label = statusLabel(result);
  const icon = label === "FAIL" ? chalk.red(label) : label === "SKIP" ? chalk.yellow(label) : chalk.green(label);
  return `  ${icon} ${result.id} — ${result.details}`;
}

function statusClass(t: TestResult): string {
  if (!t.passed) return "fail";
  return t.skipped === true ? "skip" : "pass";
}

export function formatTerminal(report: ComplianceReport): string {
  const out: string[] = [];
  const color = gradeColor(report.grade);
  const art = GRADE_ART[report.grade];

  // Header
  out.push("");
  out.push(chalk.bold("  MCP COMPLIANCE REPORT"));
  out.push(chalk.dim(`  ${HEAVY_RULE}`));
  if (report.serverInfo.name) {
    const v = report.serverInfo.version ? ` v${report.serverInfo.version}` : "";
    const proto = report.serverInfo.protocolVersion ? `  (protocol ${report.serverInfo.protocolVersion})` : "";
    out.push(chalk.dim(`  Server:   ${report.serverInfo.name}${v}${proto}`));
  }
  out.push(chalk.dim(`  Target:   ${report.url}`));
  const { specNote, warnings } = splitSpecNote(report);
  out.push(chalk.dim(`  Spec:     ${report.specVersion}  ·  Tool v${report.toolVersion}  ·  ${report.timestamp}`));
  if (specNote) out.push(chalk.dim(`            ${specNote}`));
  out.push("");

  // Big grade block letter + side-by-side summary. "0/0 required" on an
  // empty run is nothing to attest, not a clean pass, so no check mark.
  const reqOk = report.summary.total > 0 && report.summary.requiredPassed === report.summary.required;
  const skipped = skippedTestsOf(report);
  // The pass total is not all evidence: any skip inside it measured
  // nothing, so the count rides next to "N failed" rather than hiding.
  const testNotes: string[] = [];
  if (report.summary.failed > 0) testNotes.push(chalk.red(`${report.summary.failed} failed`));
  if (skipped.length > 0) testNotes.push(chalk.yellow(`${skipped.length} skipped`));
  const testNote = testNotes.length > 0 ? chalk.dim("  (") + testNotes.join(chalk.dim(", ")) + chalk.dim(")") : "";
  const infoRows = [
    "",
    "",
    `${chalk.bold("GRADE")}   ${color(report.grade)}       ${chalk.bold(`${report.score}%`)}`,
    `${chalk.dim("Overall   ")}${overallColor(report.overall)}`,
    `${chalk.dim("Tests     ")}${chalk.green(String(report.summary.passed))}${chalk.dim("/")}${report.summary.total}${testNote}`,
    `${chalk.dim("Required  ")}${reqOk ? chalk.green(`${report.summary.requiredPassed}/${report.summary.required} ✓`) : chalk.red(`${report.summary.requiredPassed}/${report.summary.required}`)}`,
  ];
  for (let i = 0; i < 6; i++) {
    out.push(`       ${color(art[i])}     ${infoRows[i] || ""}`);
  }
  out.push("");

  // Category breakdown bars
  out.push(chalk.bold("  CATEGORY BREAKDOWN"));
  out.push(chalk.dim(`  ${RULE}`));
  const cats = CATEGORY_ORDER.filter((c) => report.categories[c] && report.categories[c].total > 0);
  const maxLabel = Math.max(...cats.map((c) => (CATEGORY_LABELS[c] || c).length));
  for (const cat of cats) {
    const stats = report.categories[cat];
    const label = CATEGORY_LABELS[cat] || cat;
    // A bar that reads 18/23 while 16 of the 18 measured nothing is the
    // headline version of the same false comfort, so annotate it -- and
    // since the score leaves skips out, so do the bar, its colour and the
    // percentage: 18/23 with 16 skips is 2 of 7 measured, 29%. The ratio
    // keeps the pass total. A category in which nothing was measured
    // prints "--" over an empty dim bar, not 100% in green.
    const skips = skipped.filter((t) => t.category === cat).length;
    const measured = measuredOf(stats, skips);
    const { filled, rest } = makeBar(measured.passed, measured.total, 24);
    const colorFn = barColor(measured.passed, measured.total);
    const pct = measured.total === 0 ? "--" : `${Math.round((measured.passed / measured.total) * 100)}%`;
    const ratio = `${stats.passed}/${stats.total}`;
    const skipNote = skips > 0 ? `  ${chalk.yellow(`${skips} skipped`)}` : "";
    out.push(
      `  ${padRight(label, maxLabel)}  ${colorFn(filled)}${chalk.dim(rest)}  ${padLeft(ratio, 7)}  ${padLeft(pct, 4)}${skipNote}`,
    );
  }
  out.push("");

  // Failed tests — full detail
  const catalog = catalogVersionOf(report);
  const failed = report.tests.filter((t) => !t.passed);
  const nothingMeasured = nothingMeasuredNote(report);
  if (report.summary.total === 0) {
    // Nothing ran: --only/--skip matched nothing in the resolved catalog,
    // or only tests gated off this transport (the runner's filter warning
    // below names the miss when it can). Grade F / FAIL is "nothing to
    // attest"; it must not read as a clean pass.
    out.push(
      `  ${chalk.yellow.bold(`! No tests ran -- check --only/--skip${warnings.length > 0 ? " (see warnings)" : ""}`)}`,
    );
    out.push("");
  } else if (nothingMeasured) {
    // Tests ran and every one skipped: grade F / 0% here is "nothing was
    // measured", not a server that failed everything.
    out.push(`  ${chalk.yellow.bold(`! ${nothingMeasured} (see SKIPPED CHECKS below)`)}`);
    out.push("");
  } else if (failed.length > 0) {
    out.push(chalk.bold.red(`  FAILED TESTS (${failed.length})`));
    out.push(chalk.dim(`  ${RULE}`));
    for (const t of failed) {
      const req = t.required ? chalk.red("required") : chalk.dim("optional");
      out.push(
        `  ${chalk.red("✗")} ${chalk.bold(t.name)}  ${chalk.dim(`[${t.id}]`)}  ${req}  ${chalk.dim(`${t.durationMs}ms`)}`,
      );
      out.push(`      ${t.details}`);
      const def = findTestDefinition(catalog, t.id);
      if (def?.recommendation) {
        out.push(`      ${chalk.cyan(`→ ${def.recommendation}`)}`);
      }
      if (t.specRef) {
        out.push(chalk.dim(`      spec: ${t.specRef}`));
      }
      out.push("");
    }
  } else if (skipped.length > 0) {
    // "All tests passed" would be a lie here: nothing failed, but some of
    // the passes are checks that never got to measure anything.
    out.push(
      `  ${chalk.green.bold("✓ No test failed")}${chalk.yellow.bold(` -- ${skipped.length} skipped, see below`)}`,
    );
    out.push("");
  } else {
    out.push(`  ${chalk.green.bold("✓ All tests passed")}`);
    out.push("");
  }

  // Skipped checks — named, so a reader sees which ones measured nothing
  // rather than having to trust that a pass total is all evidence.
  if (skipped.length > 0) {
    out.push(chalk.bold.yellow(`  SKIPPED CHECKS (${skipped.length})`));
    out.push(chalk.dim(`  ${RULE}`));
    out.push(chalk.dim(`  These ${SKIP_CAVEAT}.`));
    for (const t of skipped) {
      const req = t.required ? chalk.yellow("required") : chalk.dim("optional");
      out.push(`  ${chalk.yellow("-")} ${chalk.bold(t.name)}  ${chalk.dim(`[${t.id}]`)}  ${req}`);
      out.push(`      ${chalk.dim(t.details)}`);
    }
    out.push("");
  }

  // Warnings
  if (warnings.length > 0) {
    out.push(chalk.bold.yellow(`  WARNINGS (${warnings.length})`));
    out.push(chalk.dim(`  ${RULE}`));
    for (const w of warnings) {
      out.push(`  ${chalk.yellow("!")} ${w}`);
    }
    out.push("");
  }

  // Server context
  const caps = report.serverInfo.capabilities;
  const declared = Object.keys(caps).filter((k) => caps[k] !== undefined);
  const hasContext = declared.length > 0 || report.toolCount > 0 || report.resourceCount > 0 || report.promptCount > 0;
  if (hasContext) {
    out.push(chalk.bold("  SERVER CONTEXT"));
    out.push(chalk.dim(`  ${RULE}`));
    if (declared.length > 0) {
      out.push(chalk.dim(`  Capabilities:  ${declared.join(", ")}`));
    }
    if (report.toolCount > 0) {
      const more = report.toolCount > 10 ? ", ..." : "";
      out.push(chalk.dim(`  Tools (${report.toolCount}):      ${report.toolNames.slice(0, 10).join(", ")}${more}`));
    }
    if (report.resourceCount > 0) {
      const more = report.resourceCount > 10 ? ", ..." : "";
      out.push(
        chalk.dim(`  Resources (${report.resourceCount}):  ${report.resourceNames.slice(0, 10).join(", ")}${more}`),
      );
    }
    if (report.promptCount > 0) {
      const more = report.promptCount > 10 ? ", ..." : "";
      out.push(chalk.dim(`  Prompts (${report.promptCount}):    ${report.promptNames.slice(0, 10).join(", ")}${more}`));
    }
    out.push("");
  }

  // Badge
  out.push(chalk.dim("  Badge:    run with --output badge.svg for a local badge image."));
  out.push("");

  return out.join("\n");
}

export function formatJson(report: ComplianceReport): string {
  return JSON.stringify(report, null, 2);
}

/**
 * Format report as SARIF (Static Analysis Results Interchange Format) v2.1.0.
 * Compatible with GitHub Code Scanning and other SARIF viewers.
 *
 * `runs[0].automationDetails.id` carries the spec version so Code
 * Scanning tracks each spec suite as its own analysis category: a
 * server that moves from the 2025-11-25 suite to the 2026-07-28 suite
 * (auto-detection, or an SDK upgrade) opens a second alert history
 * instead of closing every 2025 alert and re-opening it under an id
 * whose pass criteria changed.
 */
export function formatSarif(report: ComplianceReport): string {
  const catalog = catalogVersionOf(report);
  const specBase = specBaseFor(catalog);
  const rules = report.tests.map((t) => {
    const def = findTestDefinition(catalog, t.id);
    return {
      id: t.id,
      name: t.name,
      shortDescription: { text: t.name },
      fullDescription: { text: def?.description || t.details },
      helpUri: t.specRef || `${specBase}/basic`,
      properties: {
        category: t.category,
        required: t.required,
      },
    };
  });

  const results = report.tests
    .filter((t) => !t.passed)
    .map((t) => {
      const def = findTestDefinition(catalog, t.id);
      return {
        ruleId: t.id,
        level: t.required ? "error" : "warning",
        message: {
          text: def?.recommendation ? `${t.details}. Fix: ${def.recommendation}` : t.details,
        },
        locations: [
          {
            physicalLocation: {
              artifactLocation: {
                uri: report.url,
              },
            },
          },
        ],
        properties: {
          category: t.category,
          durationMs: t.durationMs,
        },
      };
    });

  // Skips go in the invocation's property bag, NOT in `results`. SARIF's
  // own form for them is a result with kind "notApplicable", but GitHub
  // Code Scanning ignores `kind` and opens an alert for every result it
  // is given (github.com/orgs/community/discussions/65477), so that form
  // would raise one alert per skipped check on every upload. `results`
  // stays failures-only, exactly as before; the skips are named here.
  const skippedTests = skippedTestsOf(report).map((t) => ({ id: t.id, details: t.details }));
  // A run in which every check skipped reads grade F / score 0 with
  // nothing failed; the property bag says why, in the words the other
  // formats print. Absent otherwise, so other runs' SARIF is unchanged.
  const nothingMeasured = nothingMeasuredNote(report);

  const sarif = {
    $schema: "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "mcp-compliance",
            version: report.toolVersion,
            informationUri: "https://github.com/YawLabs/mcp-compliance",
            rules,
          },
        },
        // The trailing "/" follows GitHub's category convention: the id
        // is a prefix, so two uploads from the same workflow stay
        // separate analyses when their spec versions differ.
        automationDetails: {
          id: `mcp-compliance/${report.specVersion || catalog}/`,
        },
        results,
        invocations: [
          {
            executionSuccessful: report.overall !== "fail",
            properties: {
              grade: report.grade,
              score: report.score,
              overall: report.overall,
              specVersion: report.specVersion,
              serverUrl: report.url,
              serverName: report.serverInfo.name,
              serverVersion: report.serverInfo.version,
              protocolVersion: report.serverInfo.protocolVersion,
              testsPassed: report.summary.passed,
              testsTotal: report.summary.total,
              // How many of testsPassed measured nothing, and which.
              testsSkipped: skippedTests.length,
              skippedTests,
              ...(nothingMeasured ? { note: nothingMeasured } : {}),
            },
          },
        ],
      },
    ],
  };

  return JSON.stringify(sarif, null, 2);
}

/**
 * Encode a value for use in a GitHub Actions workflow command. Per the
 * GitHub docs, %, \r and \n must be URL-encoded so the runner doesn't
 * truncate or split the message.
 */
function ghEscape(s: string): string {
  return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/**
 * Emit GitHub Actions workflow commands so test failures appear inline
 * on PRs as annotations. Required failures become ::error, optional
 * become ::warning, every report warning becomes a ::warning titled
 * mcp-compliance (the dual-era, pinned-mismatch, unreachable and
 * "pass --auth" notes are otherwise invisible in CI), and a single
 * ::notice carries the grade summary plus the resolved spec version and,
 * under auto, how it was detected. An empty run says so instead of
 * reading as "Grade F, 0/0 passed".
 */
export function formatGithub(report: ComplianceReport): string {
  const lines: string[] = [];
  const { specNote, warnings } = splitSpecNote(report);
  for (const t of report.tests) {
    if (t.passed) continue;
    const level = t.required ? "error" : "warning";
    const title = ghEscape(t.id);
    const message = ghEscape(t.details || "(no details)");
    lines.push(`::${level} title=${title}::${message}`);
  }
  for (const w of warnings) {
    lines.push(`::warning title=mcp-compliance::${ghEscape(w)}`);
  }
  const summaryTitle = "MCP Compliance";
  const spec = `spec ${report.specVersion || catalogVersionOf(report)}${specNote ? ` (${specNote})` : ""}`;
  // Skips ride in the counts so a green CI line cannot hide a suite that
  // measured nothing. Omitted at zero, so a clean run reads as before.
  const skippedCount = skippedTestsOf(report).length;
  const skipNote = skippedCount > 0 ? `, ${skippedCount} skipped` : "";
  const nothingMeasured = nothingMeasuredNote(report);
  const summary =
    report.summary.total === 0
      ? `No tests ran -- check --only/--skip${warnings.length > 0 ? " (see warnings)" : ""}; ${spec}`
      : nothingMeasured
        ? `Grade ${report.grade} (${report.score}%) — ${nothingMeasured}; ${spec}`
        : `Grade ${report.grade} (${report.score}%) — ${report.summary.passed}/${report.summary.total} passed, ${report.summary.failed} failed${skipNote} (${report.summary.requiredPassed}/${report.summary.required} required); ${spec}`;
  lines.push(`::notice title=${ghEscape(summaryTitle)}::${ghEscape(summary)}`);
  return lines.join("\n");
}

/**
 * Format report as Markdown for PR comments / issue bodies.
 */
export function formatMarkdown(report: ComplianceReport): string {
  const lines: string[] = [];
  const gradeEmoji: Record<string, string> = { A: "🟢", B: "🔵", C: "🟡", D: "🟠", F: "🔴" };
  lines.push("# MCP Compliance Report");
  lines.push("");
  lines.push(
    `**Grade: ${gradeEmoji[report.grade] || ""} ${report.grade} (${report.score}%)** — ${report.overall.toUpperCase()}`,
  );
  lines.push("");
  const mdNothingMeasured = nothingMeasuredNote(report);
  if (mdNothingMeasured) {
    lines.push(`> **${mdNothingMeasured}.** See "Skipped checks" below.`);
    lines.push("");
  }
  const { specNote: mdSpecNote, warnings: mdWarnings } = splitSpecNote(report);
  lines.push(`- **Target:** \`${report.url}\``);
  lines.push(`- **Spec:** ${report.specVersion}${mdSpecNote ? ` (${mdSpecNote})` : ""}`);
  lines.push(`- **Tested:** ${report.timestamp}`);
  lines.push(`- **Tool:** v${report.toolVersion}`);
  if (report.serverInfo.name) {
    lines.push(
      `- **Server:** ${report.serverInfo.name}${report.serverInfo.version ? ` v${report.serverInfo.version}` : ""}`,
    );
  }
  lines.push("");

  lines.push("## Summary");
  lines.push("");
  lines.push("| Category | Passed | Total |");
  lines.push("|---|---:|---:|");
  const mdSkipped = skippedTestsOf(report);
  for (const cat of CATEGORY_ORDER) {
    const stats = report.categories[cat];
    if (!stats || stats.total === 0) continue;
    // A category's pass count includes its skips; say how many, as the
    // terminal bars and HTML cards do, so "Security 17 / 23" cannot read
    // as 17 checks the server satisfied.
    const skips = mdSkipped.filter((t) => t.category === cat).length;
    const passedCell = skips > 0 ? `${stats.passed} (${skips} skipped)` : `${stats.passed}`;
    lines.push(`| ${CATEGORY_LABELS[cat] || cat} | ${passedCell} | ${stats.total} |`);
  }
  lines.push(`| **Total** | **${report.summary.passed}** | **${report.summary.total}** |`);
  lines.push("");
  // The table is the part people read, so the caveat belongs under it and
  // not only next to the list further down.
  if (mdSkipped.length > 0) {
    lines.push(`_${mdSkipped.length} of those passes measured nothing -- see "Skipped checks" below._`);
    lines.push("");
  }

  const failed = report.tests.filter((t) => !t.passed);
  if (failed.length > 0) {
    lines.push(`## Failed tests (${failed.length})`);
    lines.push("");
    for (const t of failed) {
      const req = t.required ? " *(required)*" : "";
      lines.push(`- ❌ **${t.id}**${req} — ${t.details}`);
    }
    lines.push("");
  }

  // Skipped checks get their own section rather than disappearing into
  // the Passed column, with the caveat that the score leaves them out.
  if (mdSkipped.length > 0) {
    lines.push(`## Skipped checks (${mdSkipped.length})`);
    lines.push("");
    lines.push(`These ${SKIP_CAVEAT}.`);
    lines.push("");
    for (const t of mdSkipped) {
      const req = t.required ? " *(required)*" : "";
      lines.push(`- ⊘ **${t.id}**${req} — ${t.details}`);
    }
    lines.push("");
  }

  if (mdWarnings.length > 0) {
    lines.push("## Warnings");
    lines.push("");
    for (const w of mdWarnings) lines.push(`- ${w}`);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Self-contained HTML report. Single file, embedded CSS, no external
 * dependencies. Suitable for `--output report.html` and serving as a
 * static artifact (CI artifact upload, GitHub Pages, S3 static hosting).
 */
export function formatHtml(report: ComplianceReport): string {
  const { specNote: htmlSpecNote, warnings: htmlWarnings } = splitSpecNote(report);
  const gradeColors: Record<string, string> = {
    A: "#10b981",
    B: "#84cc16",
    C: "#eab308",
    D: "#f97316",
    F: "#ef4444",
  };
  const gradeColor = gradeColors[report.grade] || "#6b7280";

  function esc(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  const failed = report.tests.filter((t) => !t.passed);
  const htmlSkippedTests = skippedTestsOf(report);
  const htmlNothingMeasured = nothingMeasuredNote(report);
  const grouped = new Map<string, TestResult[]>();
  for (const cat of CATEGORY_ORDER) grouped.set(cat, []);
  for (const t of report.tests) grouped.get(t.category)?.push(t);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MCP Compliance — ${esc(report.url)} — Grade ${report.grade}</title>
<style>
  :root { color-scheme: light dark; }
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; background: #0b0f17; color: #e5e7eb; }
  @media (prefers-color-scheme: light) { body { background: #f9fafb; color: #111827; } .card { background: #fff !important; border-color: #e5e7eb !important; } .muted { color: #6b7280 !important; } }
  .container { max-width: 960px; margin: 0 auto; padding: 32px 24px; }
  header { text-align: center; margin-bottom: 32px; }
  h1 { font-size: 28px; margin: 0 0 4px; }
  .muted { color: #9ca3af; font-size: 13px; }
  .grade-card { background: #111827; border: 1px solid #1f2937; border-radius: 12px; padding: 32px; margin: 24px 0; text-align: center; }
  .grade-letter { font-size: 96px; font-weight: 700; line-height: 1; color: ${gradeColor}; margin: 0; }
  .grade-score { font-size: 24px; font-weight: 600; margin-top: 4px; }
  .grade-overall { display: inline-block; padding: 4px 12px; border-radius: 999px; font-size: 12px; font-weight: 600; text-transform: uppercase; margin-top: 12px; }
  .grade-overall.pass { background: #064e3b; color: #6ee7b7; }
  .grade-overall.partial { background: #78350f; color: #fcd34d; }
  .grade-overall.fail { background: #7f1d1d; color: #fca5a5; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin: 24px 0; }
  .cat-card { background: #111827; border: 1px solid #1f2937; border-radius: 8px; padding: 16px; text-align: center; }
  .cat-stat { font-size: 24px; font-weight: 700; }
  .cat-label { font-size: 12px; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.05em; margin-top: 4px; }
  .cat-stat.full { color: #10b981; }
  .cat-stat.partial { color: #eab308; }
  .cat-stat.empty { color: #ef4444; }
  .cat-stat.none { color: #9ca3af; }
  .card { background: #111827; border: 1px solid #1f2937; border-radius: 8px; padding: 20px; margin: 16px 0; }
  .card h2 { margin-top: 0; font-size: 16px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #1f2937; vertical-align: top; }
  th { font-weight: 600; color: #9ca3af; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
  td.status { white-space: nowrap; font-weight: 600; }
  td.status.pass { color: #10b981; }
  td.status.fail { color: #ef4444; }
  td.status.skip { color: #eab308; }
  td.id { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; color: #9ca3af; }
  .badge-tag { display: inline-block; background: #1f2937; color: #fcd34d; font-size: 10px; padding: 2px 6px; border-radius: 4px; text-transform: uppercase; letter-spacing: 0.05em; }
  .warn { background: #78350f; color: #fcd34d; padding: 12px 16px; border-radius: 8px; margin: 8px 0; font-size: 13px; }
  .badge-img { background: #fff; padding: 8px; border-radius: 6px; display: inline-block; margin-top: 8px; }
  code { background: #1f2937; padding: 1px 6px; border-radius: 4px; font-size: 12px; }
  details summary { cursor: pointer; padding: 8px 0; font-weight: 600; }
  footer { text-align: center; color: #6b7280; font-size: 12px; margin-top: 48px; }
  footer a { color: #60a5fa; text-decoration: none; }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>MCP Compliance Report</h1>
    <div class="muted">${esc(report.url)}</div>
    <div class="muted" style="margin-top:6px">Spec ${esc(report.specVersion)}${htmlSpecNote ? ` (${esc(htmlSpecNote)})` : ""} · Tool v${esc(report.toolVersion)} · ${new Date(report.timestamp).toLocaleString()}</div>
    ${report.serverInfo.name ? `<div class="muted">Server: ${esc(report.serverInfo.name)}${report.serverInfo.version ? ` v${esc(report.serverInfo.version)}` : ""}</div>` : ""}
  </header>

  <div class="grade-card">
    <div class="grade-letter">${esc(report.grade)}</div>
    <div class="grade-score">${report.score}%</div>
    <div class="grade-overall ${esc(report.overall)}">${esc(report.overall)}</div>
    <div class="muted" style="margin-top:12px">${report.summary.passed} / ${report.summary.total} tests passed · ${report.summary.requiredPassed} / ${report.summary.required} required${htmlSkippedTests.length > 0 ? ` · ${htmlSkippedTests.length} skipped` : ""}</div>${htmlNothingMeasured ? `\n    <div class="warn" style="margin-top:12px">${esc(htmlNothingMeasured)}.</div>` : ""}
  </div>

  <div class="grid">
    ${CATEGORY_ORDER.filter((c) => report.categories[c] && report.categories[c].total > 0)
      .map((c) => {
        const s = report.categories[c];
        const skips = htmlSkippedTests.filter((t) => t.category === c).length;
        // Coloured by what was measured, as the score is: skips are left
        // out, and a category that measured nothing is neutral, not green.
        const m = measuredOf(s, skips);
        const cls = m.total === 0 ? "none" : m.passed === m.total ? "full" : m.passed > 0 ? "partial" : "empty";
        const note = skips > 0 ? `<div class="cat-label">${skips} skipped</div>` : "";
        return `<div class="cat-card"><div class="cat-stat ${cls}">${s.passed}/${s.total}</div><div class="cat-label">${esc(CATEGORY_LABELS[c] || c)}</div>${note}</div>`;
      })
      .join("")}
  </div>

  ${htmlWarnings.length ? `<div class="card"><h2>Warnings (${htmlWarnings.length})</h2>${htmlWarnings.map((w) => `<div class="warn">${esc(w)}</div>`).join("")}</div>` : ""}

  ${
    failed.length
      ? `<div class="card"><h2>Failed tests (${failed.length})</h2>
    <table><thead><tr><th>Status</th><th>Test</th><th>Details</th></tr></thead><tbody>
    ${failed
      .map(
        (t) => `<tr>
      <td class="status fail">FAIL</td>
      <td><div>${esc(t.name)} ${t.required ? '<span class="badge-tag">Required</span>' : ""}</div><div class="id">${esc(t.id)}</div></td>
      <td>${esc(t.details)}${t.specRef ? ` <a href="${esc(t.specRef)}" class="muted">[spec]</a>` : ""}</td>
    </tr>`,
      )
      .join("")}
    </tbody></table></div>`
      : ""
  }

  ${
    htmlSkippedTests.length
      ? `<div class="card"><h2>Skipped checks (${htmlSkippedTests.length})</h2>
    <p class="muted">These ${esc(SKIP_CAVEAT)}.</p>
    <table><thead><tr><th>Status</th><th>Test</th><th>Details</th></tr></thead><tbody>
    ${htmlSkippedTests
      .map(
        (t) => `<tr>
      <td class="status skip">SKIP</td>
      <td><div>${esc(t.name)} ${t.required ? '<span class="badge-tag">Required</span>' : ""}</div><div class="id">${esc(t.id)}</div></td>
      <td>${esc(t.details)}</td>
    </tr>`,
      )
      .join("")}
    </tbody></table></div>`
      : ""
  }

  ${[...grouped.entries()]
    .filter(([, tests]) => tests.length > 0)
    .map(
      ([cat, tests]) => `<div class="card"><h2>${esc(CATEGORY_LABELS[cat] || cat)}</h2>
    <table><thead><tr><th>Status</th><th>Test</th><th>Details</th><th>Time</th></tr></thead><tbody>
    ${tests
      .map(
        (t) => `<tr>
      <td class="status ${statusClass(t)}">${statusLabel(t)}</td>
      <td><div>${esc(t.name)} ${t.required ? '<span class="badge-tag">Required</span>' : ""}</div><div class="id">${esc(t.id)}</div></td>
      <td>${esc(t.details)}${t.specRef ? ` <a href="${esc(t.specRef)}" class="muted">[spec]</a>` : ""}</td>
      <td class="muted">${t.durationMs}ms</td>
    </tr>`,
      )
      .join("")}
    </tbody></table></div>`,
    )
    .join("")}

  ${`<div class="card"><h2>Local badge</h2>
    <p class="muted">Use <code>--output badge.svg</code> to write a local badge image.</p></div>`}

  <footer>
    Generated by <a href="https://www.npmjs.com/package/@yawlabs/mcp-compliance">@yawlabs/mcp-compliance</a> v${esc(report.toolVersion)}
  </footer>
</div>
</body>
</html>`;
}
