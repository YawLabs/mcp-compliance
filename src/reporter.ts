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
  security: "Security",
};

const CATEGORY_ORDER = ["transport", "lifecycle", "tools", "resources", "prompts", "errors", "schema", "security"];

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
  // For stdio targets the badge URL would always render "unknown" (no
  // public report), so suppress the markdown and point at --output instead.
  if (report.url.startsWith("stdio:")) {
    lines.push(
      chalk.dim("  Badge: stdio servers can't be published. Use `--output badge.svg` for a local badge image."),
    );
  } else {
    lines.push(chalk.dim("  Badge markdown:"));
    lines.push(`  ${report.badge.markdown}`);
  }
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
 * become ::warning, and a single ::notice carries the grade summary.
 */
export function formatGithub(report: ComplianceReport): string {
  const lines: string[] = [];
  for (const t of report.tests) {
    if (t.passed) continue;
    const level = t.required ? "error" : "warning";
    const title = ghEscape(t.id);
    const message = ghEscape(t.details || "(no details)");
    lines.push(`::${level} title=${title}::${message}`);
  }
  const summaryTitle = "MCP Compliance";
  const summary = `Grade ${report.grade} (${report.score}%) — ${report.summary.passed}/${report.summary.total} passed, ${report.summary.failed} failed (${report.summary.requiredPassed}/${report.summary.required} required)`;
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
  lines.push(`- **Target:** \`${report.url}\``);
  lines.push(`- **Spec:** ${report.specVersion}`);
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
  for (const cat of CATEGORY_ORDER) {
    const stats = report.categories[cat];
    if (!stats || stats.total === 0) continue;
    lines.push(`| ${CATEGORY_LABELS[cat] || cat} | ${stats.passed} | ${stats.total} |`);
  }
  lines.push(`| **Total** | **${report.summary.passed}** | **${report.summary.total}** |`);
  lines.push("");

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

  if (report.warnings.length > 0) {
    lines.push("## Warnings");
    lines.push("");
    for (const w of report.warnings) lines.push(`- ${w}`);
    lines.push("");
  }

  if (!report.url.startsWith("stdio:")) {
    lines.push("## Badge");
    lines.push("");
    lines.push("```markdown");
    lines.push(report.badge.markdown);
    lines.push("```");
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
  const grouped = new Map<string, TestResult[]>();
  for (const cat of CATEGORY_ORDER) grouped.set(cat, []);
  for (const t of report.tests) grouped.get(t.category)?.push(t);

  const isStdio = report.url.startsWith("stdio:");

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
  .card { background: #111827; border: 1px solid #1f2937; border-radius: 8px; padding: 20px; margin: 16px 0; }
  .card h2 { margin-top: 0; font-size: 16px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #1f2937; vertical-align: top; }
  th { font-weight: 600; color: #9ca3af; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
  td.status { white-space: nowrap; font-weight: 600; }
  td.status.pass { color: #10b981; }
  td.status.fail { color: #ef4444; }
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
    <div class="muted" style="margin-top:6px">Spec ${esc(report.specVersion)} · Tool v${esc(report.toolVersion)} · ${new Date(report.timestamp).toLocaleString()}</div>
    ${report.serverInfo.name ? `<div class="muted">Server: ${esc(report.serverInfo.name)}${report.serverInfo.version ? ` v${esc(report.serverInfo.version)}` : ""}</div>` : ""}
  </header>

  <div class="grade-card">
    <div class="grade-letter">${esc(report.grade)}</div>
    <div class="grade-score">${report.score}%</div>
    <div class="grade-overall ${esc(report.overall)}">${esc(report.overall)}</div>
    <div class="muted" style="margin-top:12px">${report.summary.passed} / ${report.summary.total} tests passed · ${report.summary.requiredPassed} / ${report.summary.required} required</div>
  </div>

  <div class="grid">
    ${CATEGORY_ORDER.filter((c) => report.categories[c] && report.categories[c].total > 0)
      .map((c) => {
        const s = report.categories[c];
        const cls = s.passed === s.total ? "full" : s.passed > 0 ? "partial" : "empty";
        return `<div class="cat-card"><div class="cat-stat ${cls}">${s.passed}/${s.total}</div><div class="cat-label">${esc(CATEGORY_LABELS[c] || c)}</div></div>`;
      })
      .join("")}
  </div>

  ${report.warnings.length ? `<div class="card"><h2>Warnings (${report.warnings.length})</h2>${report.warnings.map((w) => `<div class="warn">${esc(w)}</div>`).join("")}</div>` : ""}

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

  ${[...grouped.entries()]
    .filter(([, tests]) => tests.length > 0)
    .map(
      ([cat, tests]) => `<div class="card"><h2>${esc(CATEGORY_LABELS[cat] || cat)}</h2>
    <table><thead><tr><th>Status</th><th>Test</th><th>Details</th><th>Time</th></tr></thead><tbody>
    ${tests
      .map(
        (t) => `<tr>
      <td class="status ${t.passed ? "pass" : "fail"}">${t.passed ? "PASS" : "FAIL"}</td>
      <td><div>${esc(t.name)} ${t.required ? '<span class="badge-tag">Required</span>' : ""}</div><div class="id">${esc(t.id)}</div></td>
      <td>${esc(t.details)}${t.specRef ? ` <a href="${esc(t.specRef)}" class="muted">[spec]</a>` : ""}</td>
      <td class="muted">${t.durationMs}ms</td>
    </tr>`,
      )
      .join("")}
    </tbody></table></div>`,
    )
    .join("")}

  ${
    !isStdio
      ? `<div class="card"><h2>Embed badge</h2>
    <div class="badge-img"><img src="${esc(report.badge.imageUrl)}" alt="MCP Compliance"></div>
    <p class="muted" style="margin-top:12px">Markdown:</p>
    <code style="display:block; padding:8px; background:#0b0f17">${esc(report.badge.markdown)}</code></div>`
      : `<div class="card"><h2>Local badge</h2>
    <p class="muted">Stdio servers can't be published to mcp.hosting (no public URL). Use <code>--output badge.svg</code> to write a local badge image.</p></div>`
  }

  <footer>
    Generated by <a href="https://www.npmjs.com/package/@yawlabs/mcp-compliance">@yawlabs/mcp-compliance</a> v${esc(report.toolVersion)}
  </footer>
</div>
</body>
</html>`;
}
