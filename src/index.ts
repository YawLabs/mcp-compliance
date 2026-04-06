import { Command } from 'commander';
import chalk from 'chalk';
import { createRequire } from 'node:module';
import { runComplianceSuite } from './runner.js';
import { formatTerminal, formatJson } from './reporter.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

function parseHeaderArg(value: string, prev: Record<string, string>): Record<string, string> {
  const idx = value.indexOf(':');
  if (idx === -1) {
    throw new Error(`Invalid header format: "${value}" (expected "Key: Value")`);
  }
  const key = value.slice(0, idx).trim();
  const val = value.slice(idx + 1).trim();
  prev[key] = val;
  return prev;
}

const program = new Command();

program
  .name('mcp-compliance')
  .description('Test MCP servers for spec compliance')
  .version(version);

program
  .command('test')
  .description('Run the full compliance test suite against an MCP server')
  .argument('<url>', 'MCP server URL to test')
  .option('--format <format>', 'Output format: terminal or json', 'terminal')
  .option('--strict', 'Exit with code 1 on any required test failure (for CI)')
  .option('-H, --header <header>', 'Add header to all requests (format: "Key: Value", repeatable)', parseHeaderArg, {})
  .option('--auth <token>', 'Shorthand for -H "Authorization: <token>"')
  .action(async (url: string, opts: { format: string; strict?: boolean; header: Record<string, string>; auth?: string }) => {
    try {
      const headers = { ...opts.header };
      if (opts.auth) headers['Authorization'] = opts.auth;

      if (opts.format === 'terminal') {
        console.log(chalk.dim(`\nTesting ${url}...\n`));
      }

      const report = await runComplianceSuite(url, { headers });

      if (opts.format === 'json') {
        console.log(formatJson(report));
      } else {
        console.log(formatTerminal(report));
      }

      if (opts.strict && report.overall === 'fail') {
        process.exit(1);
      }
    } catch (err: any) {
      if (opts.format === 'json') {
        console.error(JSON.stringify({ error: err.message }));
      } else {
        console.error(chalk.red(`\nError: ${err.message}\n`));
      }
      process.exit(1);
    }
  });

program
  .command('badge')
  .description('Run tests and output just the badge markdown embed code')
  .argument('<url>', 'MCP server URL to test')
  .option('-H, --header <header>', 'Add header to all requests (format: "Key: Value", repeatable)', parseHeaderArg, {})
  .option('--auth <token>', 'Shorthand for -H "Authorization: <token>"')
  .action(async (url: string, opts: { header: Record<string, string>; auth?: string }) => {
    try {
      const headers = { ...opts.header };
      if (opts.auth) headers['Authorization'] = opts.auth;

      console.log(chalk.dim(`\nTesting ${url}...\n`));

      const report = await runComplianceSuite(url, { headers });

      console.log(`Grade: ${report.grade} (${report.score}%)\n`);
      console.log(report.badge.markdown);
      console.log('');
    } catch (err: any) {
      console.error(chalk.red(`\nError: ${err.message}\n`));
      process.exit(1);
    }
  });

program.parse();
