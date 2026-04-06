import { Command } from 'commander';
import chalk from 'chalk';
import { runComplianceSuite } from './runner.js';
import { formatTerminal, formatJson } from './reporter.js';

const program = new Command();

program
  .name('mcp-compliance')
  .description('Test MCP servers for spec compliance')
  .version('0.1.0');

program
  .command('test')
  .description('Run the full compliance test suite against an MCP server')
  .argument('<url>', 'MCP server URL to test')
  .option('--format <format>', 'Output format: terminal or json', 'terminal')
  .option('--strict', 'Exit with code 1 on any required test failure (for CI)')
  .action(async (url: string, opts: { format: string; strict?: boolean }) => {
    try {
      if (opts.format === 'terminal') {
        console.log(chalk.dim(`\nTesting ${url}...\n`));
      }

      const report = await runComplianceSuite(url);

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
  .action(async (url: string) => {
    try {
      console.log(chalk.dim(`\nTesting ${url}...\n`));

      const report = await runComplianceSuite(url);

      console.log(`Grade: ${report.grade} (${report.score}%)\n`);
      console.log(report.badge.markdown);
      console.log('');
    } catch (err: any) {
      console.error(chalk.red(`\nError: ${err.message}\n`));
      process.exit(1);
    }
  });

program.parse();
