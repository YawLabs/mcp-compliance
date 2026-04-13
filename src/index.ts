import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createInterface } from "node:readline/promises";
import chalk from "chalk";
import { Command, Option } from "commander";
import { renderBadgeSvg } from "./badge-svg.js";
import { type ComplianceConfig, loadConfig } from "./config.js";
import { startServer } from "./mcp/server.js";
import { publishReport, unpublishReport } from "./publish.js";
import { formatJson, formatSarif, formatTerminal } from "./reporter.js";
import { runComplianceSuite } from "./runner.js";
import { getTokenForUrl, deleteToken as removeStoredToken, saveToken } from "./token-store.js";
import type { TransportTarget } from "./types.js";

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

function parseEnvVar(value: string, prev: Record<string, string>): Record<string, string> {
  const idx = value.indexOf("=");
  if (idx === -1) throw new Error(`Invalid env var: "${value}" (expected "KEY=VALUE")`);
  const key = value.slice(0, idx);
  const val = value.slice(idx + 1);
  if (!key) throw new Error(`Invalid env var: "${value}" (empty key)`);
  prev[key] = val;
  return prev;
}

function readEnvFile(path: string): Record<string, string> {
  const contents = readFileSync(path, "utf8");
  const out: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let val = trimmed.slice(idx + 1).trim();
    // Strip surrounding quotes, single or double
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key) out[key] = val;
  }
  return out;
}

function looksLikeUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

/**
 * Build a TransportTarget from a positional argument and optional
 * trailing args. URLs dispatch to HTTP; anything else is treated as a
 * stdio command. Extra args become the command's argv.
 */
function buildTarget(
  positional: string,
  extraArgs: string[],
  opts: {
    header?: Record<string, string>;
    auth?: string;
    env?: Record<string, string>;
    envFile?: string;
    cwd?: string;
    verbose?: boolean;
  },
): TransportTarget {
  if (looksLikeUrl(positional)) {
    const headers = { ...(opts.header ?? {}) };
    if (opts.auth) headers.Authorization = opts.auth;
    return { type: "http", url: positional, headers };
  }
  const env: Record<string, string> = {
    ...(opts.envFile ? readEnvFile(opts.envFile) : {}),
    ...(opts.env ?? {}),
  };
  return {
    type: "stdio",
    command: positional,
    args: extraArgs,
    env: Object.keys(env).length ? env : undefined,
    cwd: opts.cwd,
    verbose: opts.verbose,
  };
}

function describeTarget(t: TransportTarget): string {
  if (t.type === "http") return t.url;
  return `stdio:${t.command}${t.args?.length ? ` ${t.args.join(" ")}` : ""}`;
}

/**
 * Resolve the target: CLI positional wins, then config file, then error.
 * Loads the config only if needed (so the error message can point users
 * at both options).
 */
function resolveTarget(
  cliTarget: string | undefined,
  cliExtraArgs: string[],
  cliOpts: {
    header?: Record<string, string>;
    auth?: string;
    env?: Record<string, string>;
    envFile?: string;
    cwd?: string;
    verbose?: boolean;
  },
  config: ComplianceConfig | null,
): TransportTarget {
  if (cliTarget) return buildTarget(cliTarget, cliExtraArgs, cliOpts);
  if (config?.target) return config.target;
  throw new Error("No target specified. Pass a URL or command, or add 'target' to mcp-compliance.config.json.");
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
  .description("Run the full compliance test suite against an MCP server (URL or stdio command)")
  .argument(
    "[target]",
    "Server URL, or command to spawn as a stdio server (optional when a config file defines 'target')",
  )
  .argument("[extraArgs...]", "Additional args passed to the stdio command")
  .addOption(
    new Option("--format <format>", "Output format").choices(["terminal", "json", "sarif"]).default("terminal"),
  )
  .option("--config <path>", "Load options from a config file (default: mcp-compliance.config.json in cwd)")
  .option("--output <file>", "Write a local SVG badge to the given path after the run (works with any transport)")
  .option("--strict", "Exit with code 1 on any required test failure (for CI)")
  .option(
    "-H, --header <header>",
    'Add header to all requests (format: "Key: Value", repeatable; HTTP only)',
    parseHeaderArg,
    {},
  )
  .option("--auth <token>", 'Shorthand for -H "Authorization: <token>" (HTTP only)')
  .option("-E, --env <var>", 'Set env var for stdio command ("KEY=VALUE", repeatable)', parseEnvVar, {})
  .option("--env-file <path>", "Load env vars from file (KEY=VALUE per line, stdio only)")
  .option("--cwd <dir>", "Working directory for stdio command")
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
  .option("--verbose", "Print each test result as it runs (also forwards stdio stderr)")
  .action(
    async (
      target: string | undefined,
      extraArgs: string[],
      opts: {
        config?: string;
        output?: string;
        format: string;
        strict?: boolean;
        header: Record<string, string>;
        auth?: string;
        env: Record<string, string>;
        envFile?: string;
        cwd?: string;
        timeout: string;
        preflightTimeout?: string;
        retries: string;
        only?: string[];
        skip?: string[];
        verbose?: boolean;
      },
    ) => {
      try {
        const config = loadConfig(opts.config);

        const transportTarget = resolveTarget(
          target,
          extraArgs,
          {
            header: opts.header,
            auth: opts.auth,
            env: opts.env,
            envFile: opts.envFile,
            cwd: opts.cwd,
            verbose: opts.verbose,
          },
          config,
        );

        if (opts.format === "terminal") {
          console.log(chalk.dim(`\nTesting ${describeTarget(transportTarget)}...\n`));
        }

        const only = opts.only ?? config?.only;
        const skip = opts.skip ?? config?.skip;
        const verbose = opts.verbose ?? config?.verbose;

        const report = await runComplianceSuite(transportTarget, {
          timeout: parsePositiveInt(opts.timeout, "--timeout", 1),
          preflightTimeout: opts.preflightTimeout
            ? parsePositiveInt(opts.preflightTimeout, "--preflight-timeout", 1)
            : config?.preflightTimeout,
          retries: parsePositiveInt(opts.retries, "--retries"),
          only,
          skip,
          onProgress: verbose
            ? (testId, passed, details) => {
                const icon = passed ? chalk.green("PASS") : chalk.red("FAIL");
                console.log(`  ${icon} ${testId} — ${details}`);
              }
            : undefined,
        });

        if (verbose && opts.format === "terminal") {
          console.log(""); // blank line after verbose output
        }

        if (opts.format === "json") {
          console.log(formatJson(report));
        } else if (opts.format === "sarif") {
          console.log(formatSarif(report));
        } else {
          console.log(formatTerminal(report));
        }

        if (opts.output) {
          const svg = renderBadgeSvg({ grade: report.grade, score: report.score, timestamp: report.timestamp });
          writeFileSync(opts.output, svg, "utf8");
          if (opts.format === "terminal") {
            console.log(chalk.dim(`\nBadge SVG written to ${opts.output}`));
          }
        }

        const strict = opts.strict ?? config?.strict;
        if (strict && report.overall === "fail") {
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
  .description("Run tests and publish a shareable compliance badge to mcp.hosting (HTTP targets only)")
  .argument(
    "[target]",
    "Server URL, or command to spawn as a stdio server (optional when a config file defines 'target')",
  )
  .argument("[extraArgs...]", "Additional args passed to the stdio command")
  .option("--config <path>", "Load options from a config file")
  .option(
    "-H, --header <header>",
    'Add header to all requests (format: "Key: Value", repeatable; HTTP only)',
    parseHeaderArg,
    {},
  )
  .option("--auth <token>", 'Shorthand for -H "Authorization: <token>" (HTTP only)')
  .option("-E, --env <var>", 'Set env var for stdio command ("KEY=VALUE", repeatable)', parseEnvVar, {})
  .option("--env-file <path>", "Load env vars from file (stdio only)")
  .option("--cwd <dir>", "Working directory for stdio command")
  .option("--timeout <ms>", "Request timeout in milliseconds", "15000")
  .option("--no-publish", "Do not publish the report to mcp.hosting")
  .option("--output <file>", "Write a local SVG badge to the given path (works for any transport)")
  .action(
    async (
      target: string | undefined,
      extraArgs: string[],
      opts: {
        config?: string;
        header: Record<string, string>;
        auth?: string;
        env: Record<string, string>;
        envFile?: string;
        cwd?: string;
        timeout: string;
        publish: boolean;
        output?: string;
      },
    ) => {
      try {
        const config = loadConfig(opts.config);
        const transportTarget = resolveTarget(
          target,
          extraArgs,
          {
            header: opts.header,
            auth: opts.auth,
            env: opts.env,
            envFile: opts.envFile,
            cwd: opts.cwd,
          },
          config,
        );

        // Stdio targets cannot be published — no public URL to key on.
        const shouldPublish = opts.publish && transportTarget.type === "http";

        if (shouldPublish && transportTarget.type === "http" && isPrivateHost(transportTarget.url)) {
          console.error(
            chalk.yellow(
              `\nWarning: ${transportTarget.url} looks like a private/internal address. Publishing will send the report (with the URL) to mcp.hosting.`,
            ),
          );
          const ok = await promptYesNo(chalk.yellow("Publish anyway?"));
          if (!ok) {
            console.error(chalk.dim("\nAborted. Re-run with --no-publish to skip publishing.\n"));
            process.exit(1);
          }
        }

        console.log(chalk.dim(`\nTesting ${describeTarget(transportTarget)}...\n`));

        const report = await runComplianceSuite(transportTarget, {
          timeout: parsePositiveInt(opts.timeout, "--timeout", 1),
        });

        let markdown = report.badge.markdown;

        if (shouldPublish && transportTarget.type === "http") {
          try {
            const res = await publishReport(report);
            saveToken(res.hash, {
              deleteToken: res.deleteToken,
              url: transportTarget.url,
              publishedAt: new Date().toISOString(),
            });
            markdown = `[![MCP Compliant](${res.badgeUrl})](${res.reportUrl})`;
            console.log(`Grade: ${report.grade} (${report.score}%)\n`);
            console.log(markdown);
            console.log(chalk.dim(`\nReport published: ${res.reportUrl}`));
            console.log(chalk.dim(`Remove with: mcp-compliance unpublish ${transportTarget.url}\n`));
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
          if (transportTarget.type === "stdio") {
            if (!opts.output) {
              console.log(
                chalk.dim(
                  "Stdio servers cannot be published. Pass --output <file.svg> to write a local badge image for your README.",
                ),
              );
            }
          } else {
            console.log(markdown);
          }
          console.log("");
        }

        if (opts.output) {
          const svg = renderBadgeSvg({ grade: report.grade, score: report.score, timestamp: report.timestamp });
          writeFileSync(opts.output, svg, "utf8");
          console.log(chalk.dim(`Badge SVG written to ${opts.output}\n`));
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
