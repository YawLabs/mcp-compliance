import { Command } from 'commander';
import chalk from 'chalk';
import { createRequire } from 'node:module';
import { runComplianceSuite } from './runner.js';
import { formatTerminal, formatJson } from './reporter.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools } from './mcp/tools.js';

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

function parseList(value: string): string[] {
  return value.split(',').map(s => s.trim()).filter(Boolean);
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
  .option('--timeout <ms>', 'Request timeout in milliseconds', '15000')
  .option('--retries <n>', 'Number of retries for failed tests', '0')
  .option('--only <items>', 'Only run tests matching these categories or test IDs (comma-separated)', parseList)
  .option('--skip <items>', 'Skip tests matching these categories or test IDs (comma-separated)', parseList)
  .option('--verbose', 'Print each test result as it runs')
  .action(async (url: string, opts: {
    format: string;
    strict?: boolean;
    header: Record<string, string>;
    auth?: string;
    timeout: string;
    retries: string;
    only?: string[];
    skip?: string[];
    verbose?: boolean;
  }) => {
    try {
      const headers = { ...opts.header };
      if (opts.auth) headers['Authorization'] = opts.auth;

      if (opts.format === 'terminal') {
        console.log(chalk.dim(`\nTesting ${url}...\n`));
      }

      const report = await runComplianceSuite(url, {
        headers,
        timeout: parseInt(opts.timeout, 10) || 15000,
        retries: parseInt(opts.retries, 10) || 0,
        only: opts.only,
        skip: opts.skip,
        onProgress: opts.verbose ? (testId, passed, details) => {
          const icon = passed ? chalk.green('PASS') : chalk.red('FAIL');
          console.log(`  ${icon} ${testId} — ${details}`);
        } : undefined,
      });

      if (opts.verbose && opts.format === 'terminal') {
        console.log(''); // blank line after verbose output
      }

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
  .option('--timeout <ms>', 'Request timeout in milliseconds', '15000')
  .action(async (url: string, opts: { header: Record<string, string>; auth?: string; timeout: string }) => {
    try {
      const headers = { ...opts.header };
      if (opts.auth) headers['Authorization'] = opts.auth;

      console.log(chalk.dim(`\nTesting ${url}...\n`));

      const report = await runComplianceSuite(url, {
        headers,
        timeout: parseInt(opts.timeout, 10) || 15000,
      });

      console.log(`Grade: ${report.grade} (${report.score}%)\n`);
      console.log(report.badge.markdown);
      console.log('');
    } catch (err: any) {
      console.error(chalk.red(`\nError: ${err.message}\n`));
      process.exit(1);
    }
  });

program
  .command('mcp')
  .description('Start the MCP compliance server (stdio transport)')
  .action(async () => {
    const server = new McpServer({ name: 'mcp-compliance', version });
    registerTools(server);
    const transport = new StdioServerTransport();
    await server.connect(transport);
  });

program.parse();
