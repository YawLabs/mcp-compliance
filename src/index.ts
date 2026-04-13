import { watch as fsWatch, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createInterface } from "node:readline/promises";
import chalk from "chalk";
import { Command, Option } from "commander";
import { renderBadgeSvg } from "./badge-svg.js";
import { formatBenchmark, runBenchmark } from "./benchmark.js";
import { type ComplianceConfig, loadConfig } from "./config.js";
import { diffReports, formatDiff, hasRegressions } from "./diff.js";
import { startServer } from "./mcp/server.js";
import { publishReport, unpublishReport } from "./publish.js";
import { formatGithub, formatHtml, formatJson, formatMarkdown, formatSarif, formatTerminal } from "./reporter.js";
import { previewTests, runComplianceSuite } from "./runner.js";
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
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") throw new Error(`--env-file: file not found: ${path}`);
    if (code === "EACCES") throw new Error(`--env-file: permission denied reading ${path}`);
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`--env-file: failed to read ${path}: ${message}`);
  }
  // Strip UTF-8 BOM if present
  if (contents.charCodeAt(0) === 0xfeff) contents = contents.slice(1);
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
    new Option("--format <format>", "Output format")
      .choices(["terminal", "json", "sarif", "github", "markdown", "html"])
      .default("terminal"),
  )
  .option("--config <path>", "Load options from a config file (default: mcp-compliance.config.json in cwd)")
  .option("--output <file>", "Write a local SVG badge to the given path after the run (works with any transport)")
  .option("--list", "Print the test IDs that would run given current filters, then exit (no connection)")
  .addOption(
    new Option(
      "--transport <kind>",
      "Filter tests by transport (only used with --list when no target is provided)",
    ).choices(["http", "stdio"]),
  )
  .option("--strict", "Exit with code 1 on any required test failure (for CI)")
  .addOption(
    new Option("--min-grade <grade>", "Exit with code 1 if grade is below this threshold").choices([
      "A",
      "B",
      "C",
      "D",
      "F",
    ]),
  )
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
  .option(
    "--timeout <ms>",
    "Request timeout in milliseconds (bump to 30000+ for stdio servers with slow startup)",
    "15000",
  )
  .option("--no-color", "Disable colored output (also honors NO_COLOR env var)")
  .option("--watch", "Re-run tests when files in the cwd change (stdio targets only)")
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
        list?: boolean;
        transport?: "http" | "stdio";
        color?: boolean;
        watch?: boolean;
        format: string;
        strict?: boolean;
        minGrade?: "A" | "B" | "C" | "D" | "F";
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
      // --no-color (and NO_COLOR env, handled by chalk natively)
      if (opts.color === false) chalk.level = 0;
      try {
        const config = loadConfig(opts.config);

        // --list short-circuits before connecting. Transport defaults to
        // http when not specified and no target is provided; if a target
        // is given we infer from it (URL → http, else stdio).
        if (opts.list) {
          let transportKind: "http" | "stdio" = opts.transport ?? "http";
          if (!opts.transport && (target || config?.target)) {
            const t = target ? (looksLikeUrl(target) ? "http" : "stdio") : config?.target?.type;
            if (t === "http" || t === "stdio") transportKind = t;
          }
          const defs = previewTests({
            transport: transportKind,
            only: opts.only ?? config?.only,
            skip: opts.skip ?? config?.skip,
          });
          for (const d of defs) {
            const req = d.required ? chalk.yellow("required") : chalk.dim("optional");
            console.log(`${chalk.bold(d.id.padEnd(38))} ${chalk.cyan(d.category.padEnd(10))} ${req}  ${d.name}`);
          }
          console.log(chalk.dim(`\n${defs.length} tests would run for transport=${transportKind}`));
          return;
        }

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

        const only = opts.only ?? config?.only;
        const skip = opts.skip ?? config?.skip;
        const verbose = opts.verbose ?? config?.verbose;
        const strict = opts.strict ?? config?.strict;

        async function runOnce() {
          if (opts.format === "terminal") {
            console.log(chalk.dim(`\nTesting ${describeTarget(transportTarget)}...\n`));
          }

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
          } else if (opts.format === "github") {
            console.log(formatGithub(report));
          } else if (opts.format === "markdown") {
            console.log(formatMarkdown(report));
          } else if (opts.format === "html") {
            console.log(formatHtml(report));
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
          return report;
        }

        // --watch: stay alive, re-run on filesystem changes in cwd.
        // Only meaningful for stdio (HTTP servers don't change because we
        // edited a local file). Cleanup on SIGINT.
        if (opts.watch) {
          if (transportTarget.type !== "stdio") {
            console.error(chalk.red("\nError: --watch only applies to stdio targets (HTTP servers are remote).\n"));
            process.exit(1);
          }
          await runOnce();
          let pending: NodeJS.Timeout | null = null;
          let running = false;
          const watcher = fsWatch(process.cwd(), { recursive: true }, (_event, filename) => {
            // Skip noise: dot-folders, node_modules, dist, lock files
            if (!filename) return;
            const f = String(filename).replace(/\\/g, "/");
            if (/(^|\/)(node_modules|\.git|dist|coverage|\.next|\.cache|\.turbo)(\/|$)/.test(f)) return;
            if (/\.(log|swp|tmp)$|~$/.test(f)) return;
            if (pending) clearTimeout(pending);
            pending = setTimeout(async () => {
              if (running) return;
              running = true;
              try {
                console.log(chalk.dim(`\n[watch] ${f} changed — re-running...\n`));
                await runOnce();
              } catch (err) {
                console.error(chalk.red(`[watch] ${err instanceof Error ? err.message : String(err)}`));
              } finally {
                running = false;
              }
            }, 500);
          });
          process.on("SIGINT", () => {
            watcher.close();
            console.log(chalk.dim("\n[watch] stopped"));
            process.exit(0);
          });
          // Block forever — watcher keeps event loop alive
          await new Promise(() => {});
          return;
        }

        const report = await runOnce();
        if (strict && report.overall === "fail") {
          process.exit(1);
        }

        if (opts.minGrade) {
          const order = ["F", "D", "C", "B", "A"];
          if (order.indexOf(report.grade) < order.indexOf(opts.minGrade)) {
            console.error(chalk.red(`Grade ${report.grade} is below threshold ${opts.minGrade}`));
            process.exit(1);
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (opts.format === "json" || opts.format === "sarif") {
          console.error(JSON.stringify({ error: message }));
        } else if (opts.format === "github") {
          console.error(`::error title=mcp-compliance::${message.replace(/[\r\n]/g, " ")}`);
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
  .option("--no-color", "Disable colored output (also honors NO_COLOR env var)")
  .action(
    async (
      target: string | undefined,
      extraArgs: string[],
      opts: {
        config?: string;
        color?: boolean;
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
      if (opts.color === false) chalk.level = 0;
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
        console.log(chalk.dim(`\nNo delete token found locally for ${url} — nothing to unpublish from this machine.`));
        console.log(
          chalk.dim(
            "(Delete tokens are stored locally at publish time. If you published from a different machine, run unpublish from there.)\n",
          ),
        );
        return; // exit 0 — this isn't a failure
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
  .command("benchmark")
  .description("Measure ping latency and throughput against an MCP server (URL or stdio command)")
  .argument("[target]", "Server URL or stdio command")
  .argument("[extraArgs...]", "Additional args for stdio command")
  .option("-r, --requests <n>", "Number of ping requests to send", "100")
  .option("-c, --concurrency <n>", "Concurrent in-flight requests", "1")
  .option("--timeout <ms>", "Per-request timeout in milliseconds", "15000")
  .option("--config <path>", "Load options from a config file")
  .option("--format <format>", "terminal or json", "terminal")
  .option("-H, --header <header>", "HTTP header (repeatable)", parseHeaderArg, {})
  .option("--auth <token>", 'Shorthand for -H "Authorization: <token>"')
  .option("-E, --env <var>", "Env var for stdio (repeatable)", parseEnvVar, {})
  .option("--env-file <path>", "Load env vars from file")
  .option("--cwd <dir>", "Working directory for stdio command")
  .action(
    async (
      target: string | undefined,
      extraArgs: string[],
      opts: {
        requests: string;
        concurrency: string;
        timeout: string;
        config?: string;
        format: string;
        header: Record<string, string>;
        auth?: string;
        env: Record<string, string>;
        envFile?: string;
        cwd?: string;
      },
    ) => {
      try {
        const config = loadConfig(opts.config);
        const t = resolveTarget(
          target,
          extraArgs,
          { header: opts.header, auth: opts.auth, env: opts.env, envFile: opts.envFile, cwd: opts.cwd },
          config,
        );
        const result = await runBenchmark(t, {
          requests: parsePositiveInt(opts.requests, "--requests", 1),
          concurrency: parsePositiveInt(opts.concurrency, "--concurrency", 1),
          timeout: parsePositiveInt(opts.timeout, "--timeout", 1),
        });
        if (opts.format === "json") {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(formatBenchmark(result));
        }
        if (result.failed > 0) process.exit(1);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nError: ${message}\n`));
        process.exit(1);
      }
    },
  );

program
  .command("diff")
  .description("Compare two compliance JSON reports; exit 1 if there are regressions")
  .argument("<baseline>", "Baseline report JSON file")
  .argument("<current>", "Current report JSON file")
  .option("--format <format>", "terminal or json", "terminal")
  .action((baselinePath: string, currentPath: string, opts: { format: string }) => {
    try {
      const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
      const current = JSON.parse(readFileSync(currentPath, "utf8"));
      const summary = diffReports(baseline, current);
      if (opts.format === "json") {
        console.log(JSON.stringify(summary, null, 2));
      } else {
        console.log(formatDiff(summary));
      }
      if (hasRegressions(summary)) process.exit(1);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`\nError: ${message}\n`));
      process.exit(1);
    }
  });

program
  .command("init")
  .description("Scaffold a mcp-compliance.config.json in the current directory")
  .option("--force", "Overwrite an existing config file without asking")
  .action(async (opts: { force?: boolean }) => {
    const { existsSync, writeFileSync: write } = await import("node:fs");
    const { join: joinPath } = await import("node:path");
    const out = joinPath(process.cwd(), "mcp-compliance.config.json");

    if (existsSync(out) && !opts.force) {
      console.error(chalk.red(`\nA config already exists at ${out}.`));
      console.error(chalk.dim("Re-run with --force to overwrite.\n"));
      process.exit(1);
    }

    if (!process.stdin.isTTY) {
      console.error(chalk.red("\nmcp-compliance init is interactive — run it from a terminal."));
      process.exit(1);
    }

    const rl = createInterface({ input: process.stdin, output: process.stderr });
    async function ask(q: string, fallback?: string): Promise<string> {
      const suffix = fallback ? chalk.dim(` [${fallback}]`) : "";
      const answer = (await rl.question(`${q}${suffix}: `)).trim();
      return answer || fallback || "";
    }

    try {
      console.log(chalk.bold("\nmcp-compliance config\n"));
      const kind = (await ask("Transport (http or stdio)", "stdio")).toLowerCase();
      if (kind !== "http" && kind !== "stdio") {
        console.error(chalk.red(`\nUnknown transport: ${kind}`));
        process.exit(1);
      }

      let target: object;
      if (kind === "http") {
        const url = await ask("Server URL");
        if (!url) {
          console.error(chalk.red("\nURL is required."));
          process.exit(1);
        }
        const auth = await ask("Authorization header value (optional, e.g. 'Bearer xxx')");
        target = auth ? { type: "http", url, headers: { Authorization: auth } } : { type: "http", url };
      } else {
        const command = await ask("Command", "node");
        if (!command) {
          console.error(chalk.red("\nCommand is required."));
          process.exit(1);
        }
        const argsStr = await ask("Args (space-separated)", "./dist/server.js");
        const args = argsStr ? argsStr.split(/\s+/).filter(Boolean) : [];
        const envStr = await ask("Env vars (KEY=VALUE space-separated, optional)");
        let env: Record<string, string> | undefined;
        if (envStr) {
          env = {};
          for (const pair of envStr.split(/\s+/)) {
            const idx = pair.indexOf("=");
            if (idx > 0) env[pair.slice(0, idx)] = pair.slice(idx + 1);
          }
        }
        const stdioTarget: { type: "stdio"; command: string; args: string[]; env?: Record<string, string> } = {
          type: "stdio",
          command,
          args,
        };
        if (env) stdioTarget.env = env;
        target = stdioTarget;
      }

      let timeout = 15000;
      for (let attempts = 0; attempts < 3; attempts++) {
        const timeoutStr = await ask("Request timeout (ms)", "15000");
        const parsed = Number.parseInt(timeoutStr, 10);
        if (Number.isFinite(parsed) && parsed > 0 && /^\d+$/.test(timeoutStr.trim())) {
          timeout = parsed;
          break;
        }
        console.error(chalk.yellow(`  "${timeoutStr}" is not a positive integer — try again.`));
        if (attempts === 2) {
          console.error(chalk.red("  Too many invalid attempts — keeping default 15000."));
        }
      }
      const strict = (await ask("Exit non-zero on required-test failures? (y/N)")).toLowerCase().startsWith("y");

      const config: Record<string, unknown> = { target, timeout };
      if (strict) config.strict = true;

      write(out, `${JSON.stringify(config, null, 2)}\n`, "utf8");
      console.log(chalk.green(`\nWrote ${out}\n`));
      console.log(chalk.dim("Run `mcp-compliance test` (no args) to use this config.\n"));
    } finally {
      rl.close();
    }
  });

program
  .command("mcp")
  .description("Start the MCP compliance server (stdio transport)")
  .action(async () => {
    await startServer();
  });

// No subcommand? Print help instead of silently exiting.
if (process.argv.length <= 2) {
  program.outputHelp();
  process.exit(0);
}

program.parse();
