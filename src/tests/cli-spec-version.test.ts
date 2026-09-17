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
  let autoOverConfig: Run;
  let invalid: Run;
  let wrongCatalog: Run;
  let gatedOnly: Run;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), "mcp-compliance-cli-"));
    const configPath = join(workDir, "pinned.json");
    writeFileSync(configPath, JSON.stringify({ specVersion: "2026-07-28" }));
    [modern, legacy, omitted, modernStdio, fromConfig, autoOverConfig, invalid, wrongCatalog, gatedOnly] =
      await Promise.all([
        cli(["test", "--list", "--no-color", "--spec-version", "2026-07-28"]),
        cli(["test", "--list", "--no-color", "--spec-version", "2025-11-25"]),
        cli(["test", "--list", "--no-color"]),
        cli(["test", "--list", "--no-color", "--spec-version", "2026-07-28", "--transport", "stdio"]),
        cli(["test", "--list", "--no-color", "--config", configPath]),
        // The documented one-off auto run in a repo whose config pins a revision.
        cli(["test", "--list", "--no-color", "--config", configPath, "--spec-version", "auto"]),
        cli(["test", "--list", "--no-color", "--spec-version", "1999-01-01"]),
        // A 2025-11-25 id under auto: matches one catalog, not the other.
        cli(["test", "--list", "--no-color", "--only", "lifecycle-init"]),
        // A valid HTTP-only id on a stdio target.
        cli([
          "test",
          "--list",
          "--no-color",
          "--spec-version",
          "2025-11-25",
          "--transport",
          "stdio",
          "--only",
          "transport-post",
        ]),
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

  it("an explicit --spec-version auto beats a `specVersion` pin in the config file", () => {
    // Same config as above (pinned to 2026-07-28); the flag must win, so
    // both catalogs print, exactly as with no config at all.
    expect(autoOverConfig.code, autoOverConfig.stderr).toBe(0);
    expect(autoOverConfig.stdout).toContain("MCP 2025-11-25 catalog (85 tests)");
    expect(autoOverConfig.stdout).toContain("MCP 2026-07-28 catalog (99 tests)");
    expect(rows(autoOverConfig.stdout)).toHaveLength(85 + 99);
    expect(autoOverConfig.stdout).not.toContain("spec=2026-07-28");
  });

  it("rejects a version the tool does not ship and names the accepted choices", () => {
    expect(invalid.code).not.toBe(0);
    expect(invalid.stderr).toContain("--spec-version");
    expect(invalid.stderr).toContain("1999-01-01");
    expect(invalid.stderr).toMatch(/auto, 2025-11-25, 2026-07-28/);
  });

  it("pads the id column to the longest printed id, so the 40+ character 2026-07-28 ids do not shift their row", () => {
    // Every row's category token must start at the same column.
    const listed = rows(modern.stdout);
    const longest = Math.max(...listed.map((line) => line.split(/\s+/)[0].length));
    expect(longest).toBeGreaterThan(38);
    const categoryColumn = new Set(
      listed.map((line) => line.search(/\s(transport|lifecycle|tools|resources|prompts|errors|schema|security)\s/)),
    );
    expect([...categoryColumn]).toEqual([longest]);
    // Both catalogs under auto share one width too.
    const both = rows(omitted.stdout);
    const widths = new Set(
      both.map((line) => line.search(/\s(transport|lifecycle|tools|resources|prompts|errors|schema|security)\s/)),
    );
    expect(widths.size).toBe(1);
  });

  it("--only with an id from the other catalog prints the live run's filter-miss warning under that catalog", () => {
    expect(wrongCatalog.code, wrongCatalog.stderr).toBe(0);
    const out = wrongCatalog.stdout;
    const split = out.indexOf("MCP 2026-07-28 catalog");
    expect(ids(out.slice(0, split))).toEqual(["lifecycle-init"]);
    expect(ids(out.slice(split))).toEqual([]);
    expect(out.slice(0, split)).not.toContain("match no test id");
    expect(out.slice(split)).toContain(
      '! Filter value(s) "lifecycle-init" match no test id or category in the 2026-07-28 catalog; run --list --spec-version 2026-07-28 to see valid ids.',
    );
  });

  it("--only with an id gated off the listed transport says so instead of a bare '0 tests would run'", () => {
    expect(gatedOnly.code, gatedOnly.stderr).toBe(0);
    expect(ids(gatedOnly.stdout)).toEqual([]);
    expect(gatedOnly.stdout).toContain(
      '! Filter value(s) "transport-post" match only tests that do not apply to a stdio target (http-only), so they select nothing here; run --list --transport stdio --spec-version 2025-11-25 to see the ids that apply.',
    );
    expect(gatedOnly.stdout).toContain("0 tests would run for transport=stdio spec=2025-11-25");
  });
});

describe("mcp-compliance benchmark --spec-version", () => {
  it("--help documents --startup-timeout with the runner's default", async () => {
    const help = await cli(["benchmark", "--help"]);
    expect(help.code, help.stderr).toBe(0);
    const flat = help.stdout.replace(/\s+/g, " ");
    expect(flat).toContain("--startup-timeout <ms> Budget for the server's first reply: the era probe under auto");
    expect(flat).toContain("default: max(--timeout, 60000)");
  }, 120_000);

  it("terminal mode prints the era-probe status line to stderr while a silent legacy server is probed", async () => {
    const run = await cli(["benchmark", "-r", "1", "--startup-timeout", "3000", "node", LEGACY_SILENT_FIXTURE]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toContain(
      "Probing spec era (server/discover, up to 3s). A 2025-11-25 server that ignores unknown methods takes the whole startup timeout; --spec-version 2025-11-25 skips the probe.",
    );
    expect(run.stdout).not.toContain("Probing spec era");
    expect(run.stdout).toContain("spec 2025-11-25, probe method ping");
  }, 120_000);

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

describe("mcp-compliance benchmark: `specVersion` and `startupTimeout` from the config file", () => {
  // benchmark reads both keys only when the flag is omitted, and a flag
  // beats the config value. Each pair is chosen so the wrong source gives
  // a visibly different run: the modern fixture auto-detects 2026-07-28,
  // so a config pin of 2025-11-25 must turn the probe into ping; the era
  // probe's status line names the startup budget it is waiting out.
  let workDir: string;
  let specFromConfig: Run;
  let specFlagOverConfig: Run;
  let startupFromConfig: Run;
  let startupFlagOverConfig: Run;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), "mcp-compliance-bench-cfg-"));
    const legacyPin = join(workDir, "legacy-pin.json");
    writeFileSync(legacyPin, JSON.stringify({ specVersion: "2025-11-25" }));
    const startup3500 = join(workDir, "startup-3500.json");
    writeFileSync(startup3500, JSON.stringify({ startupTimeout: 3500 }));
    const startup4000 = join(workDir, "startup-4000.json");
    writeFileSync(startup4000, JSON.stringify({ startupTimeout: 4000 }));
    [specFromConfig, specFlagOverConfig, startupFromConfig, startupFlagOverConfig] = await Promise.all([
      cli(["benchmark", "--format", "json", "-r", "2", "--config", legacyPin, "node", MODERN_FIXTURE]),
      cli([
        "benchmark",
        "--format",
        "json",
        "-r",
        "2",
        "--config",
        legacyPin,
        "--spec-version",
        "2026-07-28",
        "node",
        MODERN_FIXTURE,
      ]),
      cli(["benchmark", "-r", "1", "--config", startup3500, "node", LEGACY_SILENT_FIXTURE]),
      cli([
        "benchmark",
        "-r",
        "1",
        "--config",
        startup4000,
        "--startup-timeout",
        "3000",
        "node",
        LEGACY_SILENT_FIXTURE,
      ]),
    ]);
  }, 180_000);

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("`specVersion` from the config pins the measured probe when the flag is omitted", () => {
    // Pinned 2025-11-25 against a modern-only server: every ping is
    // rejected, so exit 1 -- but the JSON still says what was measured.
    expect(specFromConfig.code, specFromConfig.stderr).toBe(1);
    const result = JSON.parse(specFromConfig.stdout) as { specVersion: string; method: string; failed: number };
    expect(result.specVersion).toBe("2025-11-25");
    expect(result.method).toBe("ping");
    expect(result.failed).toBe(2);
  });

  it("--spec-version beats the config's `specVersion`", () => {
    expect(specFlagOverConfig.code, specFlagOverConfig.stderr).toBe(0);
    const result = JSON.parse(specFlagOverConfig.stdout) as { specVersion: string; method: string; failed: number };
    expect(result.specVersion).toBe("2026-07-28");
    expect(result.method).toBe("server/discover");
    expect(result.failed).toBe(0);
  });

  it("`startupTimeout` from the config bounds the era probe when the flag is omitted", () => {
    // Without it the budget would be max(--timeout, 60000) and the line would say "up to 60s".
    expect(startupFromConfig.code, startupFromConfig.stderr).toBe(0);
    expect(startupFromConfig.stderr).toContain("Probing spec era (server/discover, up to 3.5s).");
    expect(startupFromConfig.stdout).toContain("spec 2025-11-25, probe method ping");
  });

  it("--startup-timeout beats the config's `startupTimeout`", () => {
    expect(startupFlagOverConfig.code, startupFlagOverConfig.stderr).toBe(0);
    expect(startupFlagOverConfig.stderr).toContain("Probing spec era (server/discover, up to 3s).");
    expect(startupFlagOverConfig.stderr).not.toContain("up to 4s");
  });
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
