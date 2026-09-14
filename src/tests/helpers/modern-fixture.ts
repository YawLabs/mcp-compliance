import { type ChildProcess, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type RunOptions, runComplianceSuite } from "../../runner.js";
import { MODERN_SPEC_VERSION } from "../../spec.js";
import type { ComplianceReport, TransportTarget } from "../../types.js";

/**
 * Shared helpers for the 2026-07-28 suite tests: start the modern fixture
 * server (stdio or HTTP, optionally with break knobs), run the modern
 * suite against it, and pick results out of the report.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
export const MODERN_FIXTURE = join(FIXTURES, "modern-server.mjs");
export const LEGACY_SILENT_FIXTURE = join(FIXTURES, "legacy-silent-server.mjs");
export const LEGACY_ECHO_FIXTURE = join(FIXTURES, "echo-server.mjs");

export interface FixtureOptions {
  /** Comma-joined into MODERN_FIXTURE_BREAK. */
  breaks?: string[];
  /** Sets MODERN_FIXTURE_AUTH (HTTP bearer token). */
  auth?: string;
  env?: Record<string, string>;
}

export interface StdioFixture {
  kind: "stdio";
  target: TransportTarget;
  stop(): Promise<void>;
}

export interface HttpFixture {
  kind: "http";
  /** The MCP endpoint URL. */
  url: string;
  /** `http://127.0.0.1:<port>` */
  base: string;
  port: number;
  target: string;
  child: ChildProcess;
  stop(): Promise<void>;
}

function fixtureEnv(opts: FixtureOptions): Record<string, string> {
  const env: Record<string, string> = { ...opts.env };
  if (opts.breaks?.length) env.MODERN_FIXTURE_BREAK = opts.breaks.join(",");
  if (opts.auth) env.MODERN_FIXTURE_AUTH = opts.auth;
  return env;
}

/**
 * A stdio target for the modern fixture. The runner spawns the process
 * itself, so this only describes it; `stop()` is a no-op kept for
 * symmetry with the HTTP helper.
 */
export function stdioFixture(opts: FixtureOptions = {}): StdioFixture {
  return {
    kind: "stdio",
    target: { type: "stdio", command: process.execPath, args: [MODERN_FIXTURE], env: fixtureEnv(opts) },
    async stop() {},
  };
}

/** Start the modern fixture over HTTP on a random port. Always `await stop()` in afterAll. */
export async function startHttpFixture(opts: FixtureOptions = {}): Promise<HttpFixture> {
  const child = spawn(process.execPath, [MODERN_FIXTURE, "--http"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...fixtureEnv(opts) },
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => process.stderr.write(`[modern-fixture] ${chunk}`));
  const port = await new Promise<number>((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("modern fixture did not print MODERN_FIXTURE_PORT")), 10_000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buf += chunk;
      const m = /MODERN_FIXTURE_PORT=(\d+)/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`modern fixture exited early with code ${code}`));
    });
  });
  const base = `http://127.0.0.1:${port}`;
  return {
    kind: "http",
    url: `${base}/mcp`,
    base,
    port,
    target: `${base}/mcp`,
    child,
    async stop() {
      if (child.exitCode !== null) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 2000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        try {
          child.stdin?.end();
        } catch {}
        child.kill();
      });
    },
  };
}

/** Run the 2026-07-28 suite with short, test-friendly timeouts. */
export function runModern(
  target: string | TransportTarget,
  options: Omit<RunOptions, "specVersion"> = {},
): Promise<ComplianceReport> {
  return runComplianceSuite(target, {
    timeout: 5000,
    startupTimeout: 10000,
    ...options,
    specVersion: MODERN_SPEC_VERSION,
  });
}

/** Result lookup that fails loudly when a test did not run. */
export function resultOf(report: ComplianceReport, id: string) {
  const r = report.tests.find((t) => t.id === id);
  if (!r) throw new Error(`test "${id}" not in report (ran: ${report.tests.map((t) => t.id).join(", ")})`);
  return r;
}

/** `passed` for every id, with the failing details in the assertion message. */
export function passedIds(report: ComplianceReport, ids: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of ids) {
    const r = resultOf(report, id);
    out[id] = r.passed ? "pass" : `FAIL: ${r.details}`;
  }
  return out;
}
