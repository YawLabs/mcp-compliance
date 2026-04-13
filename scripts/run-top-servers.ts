#!/usr/bin/env -S node --import tsx
/**
 * Run the compliance suite against a curated list of published MCP servers.
 * Designed to be rerun periodically so the outputs stay fresh.
 *
 * Usage (from repo root):
 *   node --import tsx scripts/run-top-servers.ts            # run every server
 *   node --import tsx scripts/run-top-servers.ts fs git      # only ones matching
 *   MCP_BENCH_CONCURRENCY=4 node --import tsx scripts/run-top-servers.ts
 *
 * Output:
 *   data/top-servers-results.json  — one entry per server with grade/score/failed
 *   data/top-servers-results.md    — table for the blog post
 *
 * Servers that need API keys are skipped unless the relevant env vars are set.
 * Never runs any server that isn't on this allowlist — no curl-to-shell from
 * random npm packages.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runComplianceSuite } from "../src/runner.js";
import type { ComplianceReport, TransportTarget } from "../src/types.js";

interface ServerEntry {
  id: string;
  name: string;
  package: string;
  target: TransportTarget;
  /** Env vars that must be set for this server to work. */
  requires?: string[];
  /** Extra timeout for slow servers (e.g., ones that boot an LLM). */
  timeoutMs?: number;
  /** Human-readable summary of what the server does. */
  notes?: string;
}

// Curated list — published reference MCP servers from the official org plus
// notable community-distributed ones. Servers that need credentials (GitHub
// token, Slack webhook, etc.) declare `requires`. If the env var isn't set,
// that row is skipped with status: "skipped-missing-env".
const SERVERS: ServerEntry[] = [
  {
    id: "filesystem",
    name: "Filesystem",
    package: "@modelcontextprotocol/server-filesystem",
    target: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", tmpdir()],
    },
    notes: "Reference implementation — read/write files under a sandbox root",
  },
  {
    id: "git",
    name: "Git",
    package: "@modelcontextprotocol/server-git",
    target: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-git", "--repository", process.cwd()],
    },
    notes: "Reference implementation — git operations on a local repo",
  },
  {
    id: "fetch",
    name: "Fetch",
    package: "@modelcontextprotocol/server-fetch",
    target: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-fetch"],
    },
    notes: "Reference implementation — HTTP fetches with content extraction",
  },
  {
    id: "memory",
    name: "Memory",
    package: "@modelcontextprotocol/server-memory",
    target: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-memory"],
    },
    notes: "Reference implementation — knowledge-graph-style memory",
  },
  {
    id: "sequentialthinking",
    name: "Sequential Thinking",
    package: "@modelcontextprotocol/server-sequential-thinking",
    target: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    },
    notes: "Reference implementation — structured reasoning steps",
  },
  {
    id: "time",
    name: "Time",
    package: "@modelcontextprotocol/server-time",
    target: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-time"],
    },
    notes: "Reference implementation — time/zone conversions",
  },
  {
    id: "github",
    name: "GitHub",
    package: "@modelcontextprotocol/server-github",
    target: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: process.env.GITHUB_PERSONAL_ACCESS_TOKEN
        ? { GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_PERSONAL_ACCESS_TOKEN }
        : undefined,
    },
    requires: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
    notes: "GitHub repo/issue/PR operations (needs a PAT)",
  },
  {
    id: "slack",
    name: "Slack",
    package: "@modelcontextprotocol/server-slack",
    target: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-slack"],
      env: process.env.SLACK_BOT_TOKEN
        ? {
            SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
            SLACK_TEAM_ID: process.env.SLACK_TEAM_ID ?? "",
          }
        : undefined,
    },
    requires: ["SLACK_BOT_TOKEN", "SLACK_TEAM_ID"],
    notes: "Slack channel/message ops (needs a bot token)",
  },
  {
    id: "sqlite",
    name: "SQLite",
    package: "@modelcontextprotocol/server-sqlite",
    target: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-sqlite", "--db-path", join(tmpdir(), "mcp-compliance-probe.sqlite")],
    },
    notes: "SQLite database query/mutate",
  },
  {
    id: "puppeteer",
    name: "Puppeteer",
    package: "@modelcontextprotocol/server-puppeteer",
    target: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-puppeteer"],
    },
    timeoutMs: 60_000,
    notes: "Browser automation — slow boot (downloads chrome the first run)",
  },
];

interface Result {
  id: string;
  name: string;
  package: string;
  status: "ok" | "error" | "skipped-missing-env" | "skipped-by-filter";
  grade?: string;
  score?: number;
  passed?: number;
  failed?: number;
  total?: number;
  requiredPassed?: number;
  requiredTotal?: number;
  durationMs?: number;
  error?: string;
  notes?: string;
}

async function runOne(server: ServerEntry): Promise<Result> {
  const base: Result = { id: server.id, name: server.name, package: server.package, status: "ok", notes: server.notes };

  const missingEnv = (server.requires ?? []).filter((k) => !process.env[k]);
  if (missingEnv.length > 0) {
    return { ...base, status: "skipped-missing-env", error: `Missing env: ${missingEnv.join(", ")}` };
  }

  const startedAt = Date.now();
  try {
    const report: ComplianceReport = await runComplianceSuite(server.target, {
      timeout: server.timeoutMs ?? 30_000,
    });
    return {
      ...base,
      grade: report.grade,
      score: report.score,
      passed: report.summary.passed,
      failed: report.summary.failed,
      total: report.summary.total,
      requiredPassed: report.summary.requiredPassed,
      requiredTotal: report.summary.required,
      durationMs: Date.now() - startedAt,
    };
  } catch (err: unknown) {
    return {
      ...base,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
    };
  }
}

function filterServers(argv: string[]): ServerEntry[] {
  const patterns = argv.filter((a) => !a.startsWith("-"));
  if (patterns.length === 0) return SERVERS;
  return SERVERS.filter((s) => patterns.some((p) => s.id.includes(p) || s.name.toLowerCase().includes(p.toLowerCase())));
}

function toMarkdown(results: Result[]): string {
  const lines: string[] = [];
  lines.push("# Top MCP servers — compliance results");
  lines.push("");
  lines.push(`Generated ${new Date().toISOString()}. ${results.length} servers tested.`);
  lines.push("");
  lines.push("| Server | Package | Grade | Score | Passed | Failed | Required | Notes |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    const status =
      r.status === "ok"
        ? `${r.grade} (${r.score}%)`
        : r.status === "skipped-missing-env"
          ? "skipped (missing env)"
          : r.status === "error"
            ? "ERROR"
            : r.status;
    const required = r.requiredPassed != null ? `${r.requiredPassed}/${r.requiredTotal}` : "—";
    const passfail = r.passed != null ? `${r.passed}/${r.total}` : "—";
    lines.push(
      `| ${r.name} | \`${r.package}\` | ${status.split(" ")[0]} | ${r.score ?? ""} | ${passfail} | ${r.failed ?? ""} | ${required} | ${r.notes ?? ""} |`,
    );
  }
  lines.push("");
  const errored = results.filter((r) => r.status === "error");
  if (errored.length) {
    lines.push("## Errors");
    lines.push("");
    for (const r of errored) lines.push(`- **${r.name}** (\`${r.package}\`): ${r.error}`);
  }
  return lines.join("\n");
}

async function main() {
  const selected = filterServers(process.argv.slice(2));
  const concurrency = Math.max(1, Number(process.env.MCP_BENCH_CONCURRENCY ?? 1));

  console.error(`Running ${selected.length} server(s) with concurrency=${concurrency}\n`);

  const results: Result[] = [];
  // Sequential by default — many npx-wrapped servers download packages on
  // first run, so parallelism can thrash the network.
  for (const srv of selected) {
    console.error(`  [${srv.id}] ${srv.name}...`);
    const r = await runOne(srv);
    const status =
      r.status === "ok"
        ? `${r.grade} ${r.score}% ${r.passed}/${r.total}`
        : r.status === "skipped-missing-env"
          ? "skipped"
          : r.status;
    console.error(`  [${srv.id}] → ${status} (${r.durationMs ?? 0}ms)`);
    results.push(r);
  }

  const outDir = resolve(process.cwd(), "data");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "top-servers-results.json"), JSON.stringify(results, null, 2));
  writeFileSync(join(outDir, "top-servers-results.md"), toMarkdown(results));

  console.error(`\nWrote data/top-servers-results.{json,md}`);
  console.error(
    `Summary: ${results.filter((r) => r.status === "ok").length} ran, ${results.filter((r) => r.status === "skipped-missing-env").length} skipped, ${results.filter((r) => r.status === "error").length} errored`,
  );
  // Non-zero exit if any ran with failing required tests
  const hasRequiredFailures = results.some((r) => r.status === "ok" && (r.requiredPassed ?? 0) < (r.requiredTotal ?? 0));
  if (hasRequiredFailures) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
