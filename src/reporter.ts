import chalk from "chalk";
import { SPEC_BASE } from "./runner.js";
import { TEST_DEFINITIONS } from "./types.js";
import type { ComplianceReport, Grade, TestResult } from "./types.js";

const CATEGORY_LABELS: Record<string, string> = {
  transport: "Transport",
  lifecycle: "Lifecycle",
  tools: "Tools",
  resources: "Resources",
  prompts: "Prompts",
  errors: "Error Handling",
  schema: "Schema Validation",
};

const CATEGORY_ORDER = ["transport", "lifecycle", "tools", "resources", "prompts", "errors", "schema"];

function gradeColor(grade: Grade): string {
  switch (grade) {
    case "A":
      return chalk.green.bold(grade);
    case "B":
      return chalk.greenBright.bold(grade);
    case "C":
      return chalk.yellow.bold(grade);
    case "D":
      return chalk.rgb(255, 165, 0).bold(grade);
    case "F":
      return chalk.red.bold(grade);
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

function testLine(t: TestResult): string {
  const icon = t.passed ? chalk.green("  PASS") : chalk.red("  FAIL");
  const req = t.required ? chalk.dim(" (required)") : "";
  const dur = chalk.dim(` ${t.durationMs}ms`);
  let line = `${icon}  ${t.name}${req}${dur}\n${chalk.dim(`         ${t.details}`)}`;
  if (!t.passed) {
    const def = TEST_DEFINITIONS.find((d) => d.id === t.id);
    if (def?.recommendation) {
      line += `\n${chalk.cyan(`         Fix: ${def.recommendation}`)}`;
    }
  }
  return line;
}

export function formatTerminal(report: ComplianceReport): string {
  const lines: string[] = [];

  lines.push("");
  lines.push(chalk.bold("MCP Compliance Report"));
  lines.push(chalk.dim(`Spec: ${report.specVersion}  |  Tool: v${report.toolVersion}  |  ${report.timestamp}`));
  lines.push(chalk.dim(`URL: ${report.url}`));

  if (report.serverInfo.name) {
    lines.push(
      chalk.dim(
        `Server: ${report.serverInfo.name} v${report.serverInfo.version || "?"} (protocol ${report.serverInfo.protocolVersion || "?"})`,
      ),
    );
  }

  lines.push("");
  lines.push(
    `  Grade: ${gradeColor(report.grade)}  Score: ${chalk.bold(String(report.score))}%  Overall: ${overallColor(report.overall)}`,
  );
  lines.push(
    `  Tests: ${chalk.green(String(report.summary.passed))} passed / ${chalk.red(String(report.summary.failed))} failed / ${report.summary.total} total`,
  );
  lines.push(`  Required: ${report.summary.requiredPassed}/${report.summary.required} passed`);

  // Group tests by category
  const grouped: Record<string, TestResult[]> = {};
  for (const t of report.tests) {
    if (!grouped[t.category]) grouped[t.category] = [];
    grouped[t.category].push(t);
  }

  for (const cat of CATEGORY_ORDER) {
    const catTests = grouped[cat];
    if (!catTests || catTests.length === 0) continue;
    const catStats = report.categories[cat];
    const label = CATEGORY_LABELS[cat] || cat;
    const catColor = catStats && catStats.passed === catStats.total ? chalk.green : chalk.yellow;

    lines.push("");
    lines.push(catColor(`  ${label} (${catStats?.passed || 0}/${catStats?.total || 0})`));

    for (const t of catTests) {
      lines.push(testLine(t));
    }
  }

  // Capabilities summary
  const caps = report.serverInfo.capabilities;
  const declared = Object.keys(caps).filter((k) => caps[k] !== undefined);
  if (declared.length > 0) {
    lines.push("");
    lines.push(chalk.dim(`  Capabilities: ${declared.join(", ")}`));
  }

  if (report.toolCount > 0) {
    lines.push(
      chalk.dim(
        `  Tools (${report.toolCount}): ${report.toolNames.slice(0, 10).join(", ")}${report.toolCount > 10 ? "..." : ""}`,
      ),
    );
  }
  if (report.resourceCount > 0) {
    lines.push(
      chalk.dim(
        `  Resources (${report.resourceCount}): ${report.resourceNames.slice(0, 10).join(", ")}${report.resourceCount > 10 ? "..." : ""}`,
      ),
    );
  }
  if (report.promptCount > 0) {
    lines.push(
      chalk.dim(
        `  Prompts (${report.promptCount}): ${report.promptNames.slice(0, 10).join(", ")}${report.promptCount > 10 ? "..." : ""}`,
      ),
    );
  }

  // Warnings
  if (report.warnings.length > 0) {
    lines.push("");
    lines.push(chalk.yellow(`  Warnings (${report.warnings.length}):`));
    for (const w of report.warnings) {
      lines.push(chalk.yellow(`    - ${w}`));
    }
  }

  lines.push("");
  lines.push(chalk.dim("  Badge markdown:"));
  lines.push(`  ${report.badge.markdown}`);
  lines.push("");

  return lines.join("\n");
}

export function formatJson(report: ComplianceReport): string {
  return JSON.stringify(report, null, 2);
}

/**
 * Format report as SARIF (Static Analysis Results Interchange Format) v2.1.0.
 * Compatible with GitHub Code Scanning and other SARIF viewers.
 */
export function formatSarif(report: ComplianceReport): string {
  const rules = report.tests.map((t) => {
    const def = TEST_DEFINITIONS.find((d) => d.id === t.id);
    return {
      id: t.id,
      name: t.name,
      shortDescription: { text: t.name },
      fullDescription: { text: def?.description || t.details },
      helpUri: t.specRef || `${SPEC_BASE}/basic`,
      properties: {
        category: t.category,
        required: t.required,
      },
    };
  });

  const results = report.tests
    .filter((t) => !t.passed)
    .map((t) => {
      const def = TEST_DEFINITIONS.find((d) => d.id === t.id);
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
                uriBaseId: "MCP_SERVER",
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
            },
          },
        ],
      },
    ],
  };

  return JSON.stringify(sarif, null, 2);
}
