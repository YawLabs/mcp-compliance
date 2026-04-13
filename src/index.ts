import { createRequire } from "node:module";
import { createInterface } from "node:readline/promises";
import chalk from "chalk";
import { Command, Option } from "commander";
import { startServer } from "./mcp/server.js";
import { publishReport, unpublishReport } from "./publish.js";
import { formatJson, formatSarif, formatTerminal } from "./reporter.js";
import { runComplianceSuite } from "./runner.js";
import { getTokenForUrl, deleteToken as removeStoredToken, saveToken } from "./token-store.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

function parseHeaderArg(value: string, prev: Record<string, string>): Record<string, string> {
  const idx = value.indexOf(":");
  if (idx === -1) {
    throw new Error(`Invalid header format: "${value}" (expected "Key: Value")`);
  }
  const key = value.slice(0, idx).trim();
  const val = value.slice(idx + 1).trim();
  prev[key] = val;
  return prev;
}

function parsePositiveInt(value: string, name: string, min = 0): number {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n < min) {
    throw new Error(`${name} must be an integer >= ${min}, got "${value}"`);
  }
  return n;
}

function parseList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function isPrivateHost(urlStr: string): boolean {
  let host: string;
  try {
    host = new URL(urlStr).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = v4.slice(1).map(Number);
    if (a === 10 || a === 127 || (a === 169 && b === 254)) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 0) return true;
  }
  if (host === "::1" || host === "[::1]") return true;
  if (host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) return true;
  return false;
}

async function promptYesNo(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(`${message} [y/N]: `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

const program = new Command();

program.name("mcp-compliance").description("Test MCP servers for spec compliance").version(version);

program
  .command("test")
  .description("Run the full compliance test suite against an MCP server")
  .argument("<url>", "MCP server URL to test")
  .addOption(
    new Option("--format <format>", "Output format").choices(["terminal", "json", "sarif"]).default("terminal"),
  )
  .option("--strict", "Exit with code 1 on any required test failure (for CI)")
  .option("-H, --header <header>", 'Add header to all requests (format: "Key: Value", repeatable)', parseHeaderArg, {})
  .option("--auth <token>", 'Shorthand for -H "Authorization: <token>"')
  .option("--timeout <ms>", "Request timeout in milliseconds", "15000")
  .option("--preflight-timeout <ms>", "Preflight connectivity check timeout in milliseconds")
  .option("--retries <n>", "Number of retries for failed tests", "0")
  .option(
    "--only <items>",
    'Only run matching categories or test IDs, comma-separated (e.g., "transport,lifecycle" or "transport-post,lifecycle-init")',
    parseList,
  )
  .option(
    "--skip <items>",
    'Skip matching categories or test IDs, comma-separated (e.g., "schema" or "tools-pagination")',
    parseList,
  )
  .option("--verbose", "Print each test result as it runs")
  .action(
    async (
      url: string,
      opts: {
        format: string;
        strict?: boolean;
        header: Record<string, string>;
        auth?: string;
        timeout: string;
        preflightTimeout?: string;
        retries: string;
        only?: string[];
        skip?: string[];
        verbose?: boolean;
      },
    ) => {
      try {
        const headers = { ...opts.header };
        if (opts.auth) headers.Authorization = opts.auth;

        if (opts.format === "terminal") {
          console.log(chalk.dim(`\nTesting ${url}...\n`));
        }

        const report = await runComplianceSuite(url, {
          headers,
          timeout: parsePositiveInt(opts.timeout, "--timeout", 1),
          preflightTimeout: opts.preflightTimeout
            ? parsePositiveInt(opts.preflightTimeout, "--preflight-timeout", 1)
            : undefined,
          retries: parsePositiveInt(opts.retries, "--retries"),
          only: opts.only,
          skip: opts.skip,
          onProgress: opts.verbose
            ? (testId, passed, details) => {
                const icon = passed ? chalk.green("PASS") : chalk.red("FAIL");
                console.log(`  ${icon} ${testId} — ${details}`);
              }
            : undefined,
        });

        if (opts.verbose && opts.format === "terminal") {
          console.log(""); // blank line after verbose output
        }

        if (opts.format === "json") {
          console.log(formatJson(report));
        } else if (opts.format === "sarif") {
          console.log(formatSarif(report));
        } else {
          console.log(formatTerminal(report));
        }

        if (opts.strict && report.overall === "fail") {
          process.exit(1);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (opts.format === "json" || opts.format === "sarif") {
          console.error(JSON.stringify({ error: message }));
        } else {
          console.error(chalk.red(`\nError: ${message}\n`));
        }
        process.exit(1);
      }
    },
  );

program
  .command("badge")
  .description("Run tests and publish a shareable compliance badge to mcp.hosting")
  .argument("<url>", "MCP server URL to test")
  .option("-H, --header <header>", 'Add header to all requests (format: "Key: Value", repeatable)', parseHeaderArg, {})
  .option("--auth <token>", 'Shorthand for -H "Authorization: <token>"')
  .option("--timeout <ms>", "Request timeout in milliseconds", "15000")
  .option("--no-publish", "Do not publish the report to mcp.hosting")
  .action(
    async (
      url: string,
      opts: {
        header: Record<string, string>;
        auth?: string;
        timeout: string;
        publish: boolean;
      },
    ) => {
      try {
        const headers = { ...opts.header };
        if (opts.auth) headers.Authorization = opts.auth;

        if (opts.publish && isPrivateHost(url)) {
          console.error(
            chalk.yellow(
              `\nWarning: ${url} looks like a private/internal address. Publishing will send the report (with the URL) to mcp.hosting.`,
            ),
          );
          const ok = await promptYesNo(chalk.yellow("Publish anyway?"));
          if (!ok) {
            console.error(chalk.dim("\nAborted. Re-run with --no-publish to skip publishing.\n"));
            process.exit(1);
          }
        }

        console.log(chalk.dim(`\nTesting ${url}...\n`));

        const report = await runComplianceSuite(url, {
          headers,
          timeout: parsePositiveInt(opts.timeout, "--timeout", 1),
        });

        let markdown = report.badge.markdown;

        if (opts.publish) {
          try {
            const res = await publishReport(report);
            saveToken(res.hash, {
              deleteToken: res.deleteToken,
              url,
              publishedAt: new Date().toISOString(),
            });
            markdown = `[![MCP Compliant](${res.badgeUrl})](${res.reportUrl})`;
            console.log(`Grade: ${report.grade} (${report.score}%)\n`);
            console.log(markdown);
            console.log(chalk.dim(`\nReport published: ${res.reportUrl}`));
            console.log(chalk.dim(`Remove with: mcp-compliance unpublish ${url}\n`));
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(chalk.yellow(`\nWarning: publish failed — ${message}`));
            console.error(chalk.dim("Falling back to local badge markdown.\n"));
            console.log(`Grade: ${report.grade} (${report.score}%)\n`);
            console.log(markdown);
            console.log("");
          }
        } else {
          console.log(`Grade: ${report.grade} (${report.score}%)\n`);
          console.log(markdown);
          console.log("");
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nError: ${message}\n`));
        process.exit(1);
      }
    },
  );

program
  .command("unpublish")
  .description("Remove a previously-published compliance report from mcp.hosting")
  .argument("<url>", "MCP server URL whose report should be removed")
  .action(async (url: string) => {
    try {
      const stored = getTokenForUrl(url);
      if (!stored) {
        console.error(chalk.red(`\nError: no delete token found for ${url}.`));
        console.error(
          chalk.dim(
            "Tokens are saved locally when you publish. If you published from another machine, you cannot unpublish from here.\n",
          ),
        );
        process.exit(1);
      }
      await unpublishReport(stored.hash, stored.entry.deleteToken);
      removeStoredToken(stored.hash);
      console.log(chalk.green(`\nRemoved report for ${url}.\n`));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`\nError: ${message}\n`));
      process.exit(1);
    }
  });

program
  .command("mcp")
  .description("Start the MCP compliance server (stdio transport)")
  .action(async () => {
    await startServer();
  });

program.parse();
