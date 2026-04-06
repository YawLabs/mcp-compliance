import chalk from 'chalk';
import type { ComplianceReport, TestResult, Grade } from './types.js';

const CATEGORY_LABELS: Record<string, string> = {
  transport: 'Transport',
  lifecycle: 'Lifecycle',
  tools: 'Tools',
  resources: 'Resources',
  prompts: 'Prompts',
  errors: 'Error Handling',
  schema: 'Schema Validation',
};

const CATEGORY_ORDER = ['transport', 'lifecycle', 'tools', 'resources', 'prompts', 'errors', 'schema'];

function gradeColor(grade: Grade): string {
  switch (grade) {
    case 'A': return chalk.green.bold(grade);
    case 'B': return chalk.greenBright.bold(grade);
    case 'C': return chalk.yellow.bold(grade);
    case 'D': return chalk.rgb(255, 165, 0).bold(grade);
    case 'F': return chalk.red.bold(grade);
  }
}

function overallColor(overall: string): string {
  switch (overall) {
    case 'pass': return chalk.green.bold('PASS');
    case 'partial': return chalk.yellow.bold('PARTIAL');
    case 'fail': return chalk.red.bold('FAIL');
    default: return overall;
  }
}

function testLine(t: TestResult): string {
  const icon = t.passed ? chalk.green('  PASS') : chalk.red('  FAIL');
  const req = t.required ? chalk.dim(' (required)') : '';
  const dur = chalk.dim(` ${t.durationMs}ms`);
  return `${icon}  ${t.name}${req}${dur}\n${chalk.dim(`         ${t.details}`)}`;
}

export function formatTerminal(report: ComplianceReport): string {
  const lines: string[] = [];

  lines.push('');
  lines.push(chalk.bold('MCP Compliance Report'));
  lines.push(chalk.dim(`Spec: ${report.specVersion}  |  ${report.timestamp}`));
  lines.push(chalk.dim(`URL: ${report.url}`));

  if (report.serverInfo.name) {
    lines.push(chalk.dim(`Server: ${report.serverInfo.name} v${report.serverInfo.version || '?'} (protocol ${report.serverInfo.protocolVersion || '?'})`));
  }

  lines.push('');
  lines.push(`  Grade: ${gradeColor(report.grade)}  Score: ${chalk.bold(String(report.score))}%  Overall: ${overallColor(report.overall)}`);
  lines.push(`  Tests: ${chalk.green(String(report.summary.passed))} passed / ${chalk.red(String(report.summary.failed))} failed / ${report.summary.total} total`);
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

    lines.push('');
    lines.push(catColor(`  ${label} (${catStats?.passed || 0}/${catStats?.total || 0})`));

    for (const t of catTests) {
      lines.push(testLine(t));
    }
  }

  if (report.toolCount > 0) {
    lines.push('');
    lines.push(chalk.dim(`  Tools (${report.toolCount}): ${report.toolNames.slice(0, 10).join(', ')}${report.toolCount > 10 ? '...' : ''}`));
  }
  if (report.resourceCount > 0) {
    lines.push(chalk.dim(`  Resources: ${report.resourceCount}`));
  }
  if (report.promptCount > 0) {
    lines.push(chalk.dim(`  Prompts: ${report.promptCount}`));
  }

  lines.push('');
  lines.push(chalk.dim('  Badge markdown:'));
  lines.push(`  ${report.badge.markdown}`);
  lines.push('');

  return lines.join('\n');
}

export function formatJson(report: ComplianceReport): string {
  return JSON.stringify(report, null, 2);
}
