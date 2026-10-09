import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifyTransportError } from "../suites/modern/security.js";
import type { ComplianceReport } from "../types.js";
import { type HttpFixture, startHttpFixture } from "./helpers/modern-fixture.js";

/**
 * The CLI on a REAL oam, compared with the same CLI on Node.
 *
 * launcher.test.ts poses as oam by preloading `process.versions.oam`, which
 * proves the launcher's decisions but never runs a line of the CLI on oam. The
 * HTTP path is where oam changes under this tool: `import { request } from
 * "undici"` in src/transport/http.ts and src/runner.ts is oam's built-in shim
 * on oam, not node_modules/undici (oam docs/node-divergences.md), and oam
 * 0.18.0 reworked that shim (caller's headers only, body undecoded, the
 * rejection carries the socket error's code itself) and http.request (no
 * default accept / user-agent / accept-encoding). A verdict that depends on
 * any of that would differ between the runtimes without a unit test noticing.
 *
 * Opt-in by availability, like yaw-mcp's oam-runtime-contract.test.ts: it runs
 * only where an oam at or above the launcher's OAM_MIN is found (OAM_BIN, else
 * PATH) and dist/ is built. Otherwise it skips -- there is no runtime to check,
 * and a below-floor oam is one the launcher never runs the CLI on.
 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI = join(ROOT, "dist", "index.js");
const PROBE = join(ROOT, "src", "tests", "fixtures", "undici-error-probe.mjs");

/** OAM_MIN from the launcher source, so this gate cannot drift from it. */
function readFloor(): number[] {
  const source = readFileSync(join(ROOT, "bin", "mcp-compliance.mjs"), "utf-8");
  const m = /const OAM_MIN = \[\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\]/.exec(source);
  if (!m) throw new Error("could not read OAM_MIN from bin/mcp-compliance.mjs");
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function versionOf(bin: string): number[] | null {
  try {
    const out = execFileSync(bin, ["--version"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      windowsHide: true,
    });
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(out);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  } catch {
    return null;
  }
}

function atLeast(v: number[], min: number[]): boolean {
  for (let i = 0; i < min.length; i++) {
    if (v[i] > min[i]) return true;
    if (v[i] < min[i]) return false;
  }
  return true;
}

/** The first oam at or above the floor: OAM_BIN, then PATH. */
function findOam(floor: number[]): { bin: string; version: string } | null {
  const exe = process.platform === "win32" ? "oam.exe" : "oam";
  const candidates = [
    ...(process.env.OAM_BIN ? [process.env.OAM_BIN] : []),
    ...(process.env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((dir) => join(dir, exe)),
  ];
  for (const bin of candidates) {
    if (!existsSync(bin)) continue;
    const version = versionOf(bin);
    if (version && atLeast(version, floor)) return { bin, version: version.join(".") };
  }
  return null;
}

const OAM = existsSync(CLI) ? findOam(readFloor()) : null;

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[]): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      stdout += d;
    });
    child.stderr.setEncoding("utf8").on("data", (d: string) => {
      stderr += d;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** `[cmd, args]` that run `script` with `args` on the named runtime. */
function on(runtime: "node" | "oam", script: string, args: string[]): [string, string[]] {
  return runtime === "node"
    ? [process.execPath, [script, ...args]]
    : [(OAM as { bin: string }).bin, ["run", script, "--", ...args]];
}

/** id -> PASS / FAIL / SKIP: the verdicts, without durations, ports or wording. */
function verdicts(report: ComplianceReport): Record<string, string> {
  return Object.fromEntries(
    report.tests.map((t) => [t.id, t.passed ? (t.skipped ? "SKIP" : "PASS") : "FAIL"] as [string, string]),
  );
}

describe.skipIf(OAM === null)(`the CLI on a real oam (${OAM ? `oam ${OAM.version}` : "no usable oam"})`, () => {
  let fixture: HttpFixture;

  beforeAll(async () => {
    fixture = await startHttpFixture();
  });

  afterAll(async () => {
    await fixture?.stop();
  });

  it("grades the HTTP modern fixture exactly as Node does", { timeout: 300_000 }, async () => {
    const args = ["test", fixture.url, "--spec-version", "2026-07-28", "--format", "json", "--timeout", "5000"];
    const reports: Partial<Record<"node" | "oam", ComplianceReport>> = {};
    // One runtime at a time: the security checks include a request burst, and
    // two concurrent runs against one fixture would measure each other.
    for (const runtime of ["node", "oam"] as const) {
      const r = await run(...on(runtime, CLI, args));
      expect(r.code, `${runtime} exited ${r.code}: ${r.stderr.slice(-2000)}`).toBe(0);
      reports[runtime] = JSON.parse(r.stdout) as ComplianceReport;
    }
    const node = reports.node as ComplianceReport;
    const oam = reports.oam as ComplianceReport;

    // The comparison is only meaningful against a server both runs reached.
    expect(
      node.warnings.some((w) => /unreachable/.test(w)),
      node.warnings.join("\n"),
    ).toBe(false);
    expect(oam.specVersion).toBe(node.specVersion);

    const onNode = verdicts(node);
    const onOam = verdicts(oam);
    const differing = [...new Set([...Object.keys(onNode), ...Object.keys(onOam)])]
      .filter((id) => onNode[id] !== onOam[id])
      .map((id) => {
        const detail = (r: ComplianceReport) => r.tests.find((t) => t.id === id)?.details ?? "(not run)";
        return `${id}: node ${onNode[id] ?? "absent"} (${detail(node)}) / oam ${onOam[id] ?? "absent"} (${detail(oam)})`;
      });
    expect(differing, differing.join("\n")).toEqual([]);
    expect(oam.score).toBe(node.score);
    expect(oam.grade).toBe(node.grade);
  });

  it("rejects undici requests in a shape classifyTransportError reads the same way", async () => {
    // A refused connection, a dropped one and a timed-out one, each read off
    // the rejection by the SAME function the security checks use. Up to oam
    // 0.17.1 the shim's rejection wrapped a cause that had a name but no code,
    // so a drop read as "other" there.
    const expected = { refused: "connect", dropped: "dropped", timeout: "timeout" };
    for (const runtime of ["node", "oam"] as const) {
      const r = await run(...on(runtime, PROBE, []));
      expect(r.code, `${runtime}: ${r.stderr}`).toBe(0);
      const seen = JSON.parse(r.stdout) as Record<
        string,
        { code: string | null; name: string | null; message: string }
      >;
      for (const [kind, want] of Object.entries(expected)) {
        const e = seen[kind];
        const err = Object.assign(new Error(e.message), { code: e.code ?? undefined, name: e.name ?? "Error" });
        expect(classifyTransportError(err), `${runtime} ${kind}: ${JSON.stringify(e)}`).toBe(want);
      }
    }
  });
});
