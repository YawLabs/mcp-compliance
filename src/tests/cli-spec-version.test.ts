import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runComplianceSuite } from "../runner.js";
import { LEGACY_SILENT_FIXTURE, MODERN_FIXTURE, stdioFixture } from "./helpers/modern-fixture.js";

/**
 * `--spec-version` on the CLI. index.ts calls `program.parse()` at module
 * load, so it cannot be imported by a test; instead the real entry point
 * runs under tsx as a child process. `--list` never connects, which makes
 * it the cheapest end-to-end probe of the flag: the printed catalog IS
 * the resolved spec version.
 *
 * Every invocation is launched concurrently in beforeAll — a tsx start is
 * a few seconds of CPU on a contended box, and the cases are independent.
 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const ENTRY = join(ROOT, "src", "index.ts");

type Run = { stdout: string; stderr: string; code: number | null };

function cli(args: string[]): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX, ENTRY, ...args], {
      cwd: ROOT,
      // NO_COLOR keeps chalk off even where --no-color is not passed.
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}

/** One printed catalog row: `<id> <category> <required|optional> <name>`. */
const ROW =
  /^[a-z]+-[a-z0-9-]+\s+(transport|lifecycle|tools|resources|prompts|errors|schema|security)\s+(required|optional)\s{2}/;

function rows(out: string): string[] {
  return out.split(/\r?\n/).filter((line) => ROW.test(line));
}

function ids(out: string): string[] {
  return rows(out).map((line) => line.split(/\s+/)[0]);
}

describe("mcp-compliance test --list --spec-version", () => {
  let workDir: string;
  let modern: Run;
  let legacy: Run;
  let omitted: Run;
  let modernStdio: Run;
  let fromConfig: Run;
  let invalid: Run;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), "mcp-compliance-cli-"));
    const configPath = join(workDir, "pinned.json");
    writeFileSync(configPath, JSON.stringify({ specVersion: "2026-07-28" }));
    [modern, legacy, omitted, modernStdio, fromConfig, invalid] = await Promise.all([
      cli(["test", "--list", "--no-color", "--spec-version", "2026-07-28"]),
      cli(["test", "--list", "--no-color", "--spec-version", "2025-11-25"]),
      cli(["test", "--list", "--no-color"]),
      cli(["test", "--list", "--no-color", "--spec-version", "2026-07-28", "--transport", "stdio"]),
      cli(["test", "--list", "--no-color", "--config", configPath]),
      cli(["test", "--list", "--no-color", "--spec-version", "1999-01-01"]),
    ]);
  }, 180_000);

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("--spec-version 2026-07-28 lists the 99 HTTP tests of the 2026-07-28 catalog only", () => {
    expect(modern.code, modern.stderr).toBe(0);
    const listed = ids(modern.stdout);
    expect(listed).toHaveLength(99);
    expect(listed).toContain("lifecycle-discover");
    expect(listed).toContain("transport-header-method-required");
    expect(listed).not.toContain("lifecycle-init");
    expect(modern.stdout).toContain("99 tests would run for transport=http spec=2026-07-28");
    expect(modern.stdout).not.toContain("catalog (");
  });

  it("--spec-version 2025-11-25 lists the 85 HTTP tests of the 2025-11-25 catalog only", () => {
    expect(legacy.code, legacy.stderr).toBe(0);
    const listed = ids(legacy.stdout);
    expect(listed).toHaveLength(85);
    expect(listed).toContain("lifecycle-init");
    expect(listed).toContain("lifecycle-ping");
    expect(listed).not.toContain("lifecycle-discover");
    expect(legacy.stdout).toContain("85 tests would run for transport=http spec=2025-11-25");
  });

  it("omitted (auto) prints both catalogs in labelled sections and a footer naming both", () => {
    expect(omitted.code, omitted.stderr).toBe(0);
    const out = omitted.stdout;
    expect(out).toContain("MCP 2025-11-25 catalog (85 tests)");
    expect(out).toContain("MCP 2026-07-28 catalog (99 tests)");
    expect(out.indexOf("MCP 2025-11-25 catalog")).toBeLessThan(out.indexOf("MCP 2026-07-28 catalog"));
    expect(rows(out)).toHaveLength(85 + 99);
    // Each section holds its own catalog: legacy-only ids before the 2026
    // heading, modern-only ids after it.
    const split = out.indexOf("MCP 2026-07-28 catalog");
    expect(ids(out.slice(0, split))).toContain("lifecycle-init");
    expect(ids(out.slice(0, split))).not.toContain("lifecycle-discover");
    expect(ids(out.slice(split))).toContain("lifecycle-discover");
    expect(ids(out.slice(split))).not.toContain("lifecycle-init");
    expect(out).toContain("85 (2025-11-25) or 99 (2026-07-28) tests would run for transport=http");
    expect(out).toContain("--spec-version auto");
  });

  it("--transport stdio narrows the 2026-07-28 catalog to its 75 stdio tests", () => {
    expect(modernStdio.code, modernStdio.stderr).toBe(0);
    const listed = ids(modernStdio.stdout);
    expect(listed).toHaveLength(75);
    expect(listed).toContain("stdio-cancellation");
    expect(listed).not.toContain("transport-header-method-required");
    expect(modernStdio.stdout).toContain("75 tests would run for transport=stdio spec=2026-07-28");
  });

  it("falls back to `specVersion` from the config file when the flag is omitted", () => {
    expect(fromConfig.code, fromConfig.stderr).toBe(0);
    expect(ids(fromConfig.stdout)).toHaveLength(99);
    expect(fromConfig.stdout).toContain("spec=2026-07-28");
    expect(fromConfig.stdout).not.toContain("MCP 2025-11-25 catalog");
  });

  it("rejects a version the tool does not ship and names the accepted choices", () => {
    expect(invalid.code).not.toBe(0);
    expect(invalid.stderr).toContain("--spec-version");
    expect(invalid.stderr).toContain("1999-01-01");
    expect(invalid.stderr).toMatch(/auto, 2025-11-25, 2026-07-28/);
  });
});

describe("mcp-compliance benchmark --spec-version", () => {
  it("--format json reports the resolved specVersion and the probe method", async () => {
    // A stdio target through the CLI positional: `node <fixture>`.
    const run = await cli([
      "benchmark",
      "--format",
      "json",
      "-r",
      "3",
      "--spec-version",
      "2026-07-28",
      "node",
      MODERN_FIXTURE,
    ]);
    expect(run.code, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout) as { specVersion: string; method: string; failed: number; requests: number };
    expect(result.specVersion).toBe("2026-07-28");
    expect(result.method).toBe("server/discover");
    expect(result.requests).toBe(3);
    expect(result.failed).toBe(0);
  }, 120_000);

  it("exits 1 and prints the first failure when the pinned era's probe is rejected", async () => {
    const run = await cli(["benchmark", "-r", "2", "--spec-version", "2025-11-25", "node", MODERN_FIXTURE]);
    expect(run.code).toBe(1);
    expect(run.stdout).toContain("spec 2025-11-25, probe method ping");
    expect(run.stdout).toContain("0 succeeded");
    expect(run.stdout).toMatch(/first failure: JSON-RPC error -32\d{3}/);
  }, 120_000);
});

describe("mcp-compliance test: terminal-mode diagnostics", () => {
  let help: Run;
  let emptyRun: Run;
  let silentRun: Run;
  let silentJsonRun: Run;

  beforeAll(async () => {
    [help, emptyRun, silentRun, silentJsonRun] = await Promise.all([
      cli(["test", "--help"]),
      // The old --only help example: lifecycle-init is a 2025-11-25 id and
      // the modern fixture auto-detects as 2026-07-28, so nothing matches.
      cli(["test", "--no-color", "--only", "lifecycle-init", "--startup-timeout", "10000", "node", MODERN_FIXTURE]),
      // A silent legacy server costs the whole startup timeout on the era
      // probe; terminal mode says so on stderr ~2s in.
      cli([
        "test",
        "--no-color",
        "--only",
        "lifecycle-init",
        "--startup-timeout",
        "3000",
        "node",
        LEGACY_SILENT_FIXTURE,
      ]),
      // Machine-readable output must stay clean: no status line at all.
      cli([
        "test",
        "--format",
        "json",
        "--only",
        "lifecycle-init",
        "--startup-timeout",
        "3000",
        "node",
        LEGACY_SILENT_FIXTURE,
      ]),
    ]);
  }, 180_000);

  it("--help: the --only example uses ids present in both catalogs, and the timeout flags say what they bound", () => {
    expect(help.code, help.stderr).toBe(0);
    expect(help.stdout).toContain("transport-post,lifecycle-jsonrpc");
    expect(help.stdout).not.toContain("transport-post,lifecycle-init");
    const flat = help.stdout.replace(/\s+/g, " ");
    expect(flat).toContain("--preflight-timeout <ms> HTTP only: deadline for the preflight server/discover request");
    expect(flat).toContain("re-probes once within --startup-timeout");
    expect(flat).toContain(
      "--startup-timeout <ms> Budget for the server's first reply: the stdio era probe under auto",
    );
  });

  it("an empty filtered run prints 'No tests ran', not 'All tests passed'", () => {
    expect(emptyRun.code, emptyRun.stderr).toBe(0);
    expect(emptyRun.stdout).toContain("No tests ran -- check --only/--skip (see warnings)");
    expect(emptyRun.stdout).not.toContain("All tests passed");
    expect(emptyRun.stdout).toContain(
      'Filter value(s) "lifecycle-init" match no test id or category in the 2026-07-28 catalog',
    );
  });

  it("terminal mode prints the era-probe status line to stderr while a silent legacy server is probed", () => {
    expect(silentRun.code, silentRun.stderr).toBe(0);
    expect(silentRun.stderr).toContain(
      "Probing spec era (server/discover, up to 3s). A 2025-11-25 server that ignores unknown methods takes the whole startup timeout; --spec-version 2025-11-25 skips the probe.",
    );
    expect(silentRun.stdout).not.toContain("Probing spec era");
    expect(silentRun.stdout).toContain("auto-detected from server/discover: no response, legacy");
  });

  it("--format json: no status line on either stream; stdout is the report alone", () => {
    expect(silentJsonRun.code, silentJsonRun.stderr).toBe(0);
    expect(silentJsonRun.stderr).not.toContain("Probing spec era");
    const report = JSON.parse(silentJsonRun.stdout) as { specVersion: string; warnings: string[] };
    expect(report.specVersion).toBe("2025-11-25");
    expect(report.warnings).toContain(
      "Spec version auto-detected as 2025-11-25 (server/discover -> no response, legacy). Pin with --spec-version to override.",
    );
  });
});

describe("runComplianceSuite specVersion option (what the CLI passes through)", () => {
  it("a pinned version is graded as-is, not auto-detected", async () => {
    // The modern fixture would auto-detect as 2026-07-28; pinning the
    // legacy spec must run the legacy catalog against it regardless.
    const report = await runComplianceSuite(stdioFixture().target, {
      specVersion: "2025-11-25",
      only: ["lifecycle-init"],
      timeout: 5000,
      startupTimeout: 10000,
    });
    expect(report.specVersion).toBe("2025-11-25");
    expect(report.tests.map((t) => t.id)).toEqual(["lifecycle-init"]);
    expect(report.warnings.some((w) => w.includes("auto-detected"))).toBe(false);
  });
});
