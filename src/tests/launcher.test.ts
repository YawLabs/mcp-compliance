import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const LAUNCHER = fileURLToPath(new URL("../../bin/mcp-compliance.mjs", import.meta.url));
const DIST_BIN = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
const PACKAGE_VERSION = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8")).version;

type Plan = "in-process" | "discover" | "handoff-node";
type RuntimePlan = (ctx: { mode: string; hostOam: string | undefined }) => Plan;
type Candidate = { path: string; version: number[] | null };
type PickNewest = (candidates: Candidate[]) => Candidate | null;

/** Pull named declarations out of the launcher source, loudly. */
function extract(patterns: RegExp[]): string {
  const source = readFileSync(LAUNCHER, "utf-8");
  return patterns
    .map((pattern) => {
      const match = source.match(pattern);
      if (!match)
        throw new Error(`could not extract ${pattern} from bin/mcp-compliance.mjs -- renamed or reformatted?`);
      return match[0];
    })
    .join("\n");
}

const OAM_MIN_DECL = /const OAM_MIN = \[[^\]]*\];/;
const ATLEAST_DECL = /function atLeast\(v, min\) \{[\s\S]*?\n\}/;

/**
 * Evaluate the REAL `runtimePlan` source, together with the declarations it
 * closes over, without importing the launcher.
 *
 * Why not import it: the launcher's module body resolves a runtime at import
 * time and either spawns oam or imports the CLI, so importing it from a test
 * would start an MCP server on the test runner's stdio. Making it importable
 * would mean gating that body behind an entry-point check -- a behaviour change
 * to a shipped runtime artifact whose failure mode (the guard reads false under
 * an npm shim, and the launcher silently does nothing) is worse than the gap
 * this closes. This is the same idiom tailscale-mcp's launcher test uses.
 *
 * Extracting the text exercises the shipped logic rather than a copy that can
 * drift, and a failed extraction is a loud assertion, not a silent skip.
 */
function loadRuntimePlan(): RuntimePlan {
  const pieces = extract([
    OAM_MIN_DECL,
    /function parseVersion\(text\) \{[\s\S]*?\n\}/,
    ATLEAST_DECL,
    /function runtimePlan\(\{ mode, hostOam \}\) \{[\s\S]*?\n\}/,
  ]);
  return new Function(`${pieces}\nreturn runtimePlan;`)() as RuntimePlan;
}

function loadPickNewest(): { pickNewest: PickNewest; floor: number[] } {
  const pieces = extract([OAM_MIN_DECL, ATLEAST_DECL, /function pickNewest\(candidates\) \{[\s\S]*?\n\}/]);
  return new Function(`${pieces}\nreturn { pickNewest, floor: OAM_MIN };`)() as {
    pickNewest: PickNewest;
    floor: number[];
  };
}

describe("launcher runtimePlan()", () => {
  const runtimePlan = loadRuntimePlan();

  it("runs in-process when already hosted on an oam at or above the floor", () => {
    // The bug this exists for: a host that launches `oam run bin/mcp-compliance.mjs`
    // got a SECOND oam, because the launcher discovered and spawned one without
    // asking what it was already running on. `auto` and `oam` both have to take
    // the shortcut -- `oam` demands oam, and the host already is one.
    //
    // 0.15.2 pins the floor as inclusive (it IS the supported release), and
    // 0.100.0 pins a numeric compare: it sorts BEFORE 0.15.2 as a string, so a
    // compare over the raw text would treat a newer oam as too old.
    for (const mode of ["auto", "oam"]) {
      for (const hostOam of ["0.15.2", "0.16.0", "0.100.0", "1.0.0", "0.16.0-dev"]) {
        expect(runtimePlan({ mode, hostOam }), `mode=${mode} hostOam=${hostOam}`).toBe("in-process");
      }
    }
  });

  it("never runs in-process on a host oam below the floor", () => {
    // Below the floor the host must hand off. Running there was the bug: for
    // this tool the floor is the child_process fidelity a compliance harness
    // depends on (see MINIMUM OAM VERSION in the launcher), and anything older
    // than the latest release is not what the CLI is verified on.
    for (const mode of ["auto", "oam"]) {
      for (const hostOam of ["0.15.1", "0.9.0", "0.8.2", "0.0.1"]) {
        expect(runtimePlan({ mode, hostOam }), `mode=${mode} hostOam=${hostOam}`).toBe("discover");
      }
    }
  });

  it("discovers as before on Node, where process.versions has no oam key", () => {
    // An unreadable value must not count as "new enough" either: that would
    // skip discovery on a host that never proved it is a supported oam.
    for (const mode of ["auto", "oam"]) {
      for (const hostOam of [undefined, "", "dev"]) {
        expect(runtimePlan({ mode, hostOam }), `mode=${mode} hostOam=${hostOam}`).toBe("discover");
      }
    }
  });

  it("runs MCP_COMPLIANCE_RUNTIME=node on Node: in-process on a Node host, handed off from any oam host", () => {
    expect(runtimePlan({ mode: "node", hostOam: undefined })).toBe("in-process");
    for (const hostOam of ["0.8.2", "0.15.2", "1.0.0", "dev"]) {
      expect(runtimePlan({ mode: "node", hostOam }), `hostOam=${hostOam}`).toBe("handoff-node");
    }
  });
});

describe("launcher pickNewest()", () => {
  const { pickNewest, floor } = loadPickNewest();
  const at = (path: string, version: number[] | null): Candidate => ({ path, version });

  it("pins the floor to the latest oam release", () => {
    expect(floor).toEqual([0, 15, 2]);
  });

  it("takes the newest usable oam, not the first one found", () => {
    // The bug: discovery stopped at the first binary that existed, so an older
    // copy in an earlier location (the installed dir is searched before PATH)
    // hid a newer one later.
    const chosen = pickNewest([at("installed", [0, 15, 2]), at("path-a", [0, 16, 0]), at("path-b", [0, 15, 9])]);
    expect(chosen?.path).toBe("path-a");
  });

  it("compares numerically and keeps search order on a tie", () => {
    expect(pickNewest([at("a", [0, 16, 0]), at("b", [0, 100, 0])])?.path).toBe("b");
    expect(pickNewest([at("first", [0, 15, 2]), at("second", [0, 15, 2])])?.path).toBe("first");
  });

  it("skips binaries below the floor or with no readable version", () => {
    expect(pickNewest([at("old", [0, 9, 0]), at("broken", null), at("good", [0, 15, 2])])?.path).toBe("good");
    expect(pickNewest([at("old", [0, 15, 1]), at("broken", null)])).toBeNull();
    expect(pickNewest([])).toBeNull();
  });
});

type LauncherRun = { stdout: string; stderr: string; code: number | null };

/**
 * Run the REAL bin under Node, optionally posing as oam by preloading a
 * `process.versions.oam` key, and return what it wrote.
 *
 * The unit tests above prove the decision; these prove the launcher WIRES it
 * -- that the call site actually reads `process.versions.oam` -- which no
 * amount of testing `runtimePlan` in isolation can. A real oam cannot be
 * assumed on every box this suite runs on, and the preload changes exactly the
 * one fact the launcher branches on.
 *
 * OAM_BIN is pinned to the Node binary running this test, which makes the two
 * outcomes unmistakable without a real oam. In-process, `--version` reaches
 * dist/index.js and commander prints the package version with exit 0. On the
 * discovery path, the pinned Node answers `--version` with v2x.y.z, which
 * clears the floor, so it is chosen and the launcher spawns `node run <entry>
 * -- --version` -- which has no `run` subcommand, prints no version and exits
 * non-zero. A usable OAM_BIN is taken before discovery runs, so a real oam on
 * the developer's box is never reached either.
 *
 * Env is a whitelist so an MCP_COMPLIANCE_* var exported by the developer's
 * shell cannot change what is being asserted.
 */
function runLauncher(
  hostOam: string | undefined,
  extraEnv: Record<string, string> = {},
  extraPreload = "",
): Promise<LauncherRun> {
  // Every run also reports, at exit, what the LAUNCHER process's argv[1] ended
  // up as. runInProcess points it at dist/index.js; a handoff leaves it on the
  // launcher. That is the only way to tell "ran in-process" from "handed off to
  // a child that printed the same version".
  const exitMarker = `import { writeSync } from "node:fs"; process.on("exit", () => { try { writeSync(2, "LAUNCHER_ARGV1=" + process.argv[1] + "\\n"); } catch {} });`;
  const posing =
    hostOam === undefined
      ? ""
      : `Object.defineProperty(process.versions, "oam", { value: ${JSON.stringify(hostOam)}, enumerable: true });`;
  const preload = ["--import", `data:text/javascript,${encodeURIComponent(`${exitMarker}${posing}${extraPreload}`)}`];
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [...preload, LAUNCHER, "--version"], {
      env: { PATH: process.env.PATH ?? "", OAM_BIN: process.execPath, ...extraEnv },
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
    // `close` rather than `exit`, so both pipes have drained before asserting.
    child.on("close", (code) => resolvePromise({ stdout, stderr, code }));
  });
}

// The in-process path imports dist/index.js, so these need a build. The
// regular `npm test` does not build, so skip rather than fail in that case,
// matching integration-dogfood.test.ts; release.sh always builds before
// `npm test`, so they run for real there.
const hasBuild = existsSync(DIST_BIN);
const maybeDescribe = hasBuild ? describe : describe.skip;

// Each case boots one to three Node processes. A single in-process launch was
// measured at ~14s on a contended Windows box (a bare `node dist/index.js
// --version` at ~5s), and a 45s budget for two launches timed out, so the
// three-process cases need far more than the 30s default.
const TIMEOUT_MS = 90_000;

const servedInProcess = (run: LauncherRun) =>
  run.code === 0 && run.stdout.trim() === PACKAGE_VERSION && /LAUNCHER_ARGV1=.*dist[\\/]index\.js/.test(run.stderr);
// A spawned child failing, not the launcher diagnosing: every launcher
// message starts with `mcp-compliance: `.
const spawnedAndFailed = (run: LauncherRun) => run.code !== 0 && !/^mcp-compliance: /m.test(run.stderr);
// Served by a child the launcher handed off to: the version still prints, but
// the launcher's own argv[1] was never pointed at dist/index.js.
const handedOff = (run: LauncherRun) =>
  run.code === 0 && run.stdout.trim() === PACKAGE_VERSION && /LAUNCHER_ARGV1=.*mcp-compliance\.mjs/.test(run.stderr);

maybeDescribe("launcher on an oam host", () => {
  it(
    "control: on plain Node the launcher still discovers and spawns",
    async () => {
      // Without this, the in-process case below would also pass for a launcher
      // that ALWAYS runs in-process and never uses oam at all.
      const run = await runLauncher(undefined);
      expect(servedInProcess(run), `expected a spawn, got ${JSON.stringify(run)}`).toBe(false);
      expect(spawnedAndFailed(run), JSON.stringify(run)).toBe(true);
    },
    TIMEOUT_MS,
  );

  // One launch per case, so each gets the whole budget rather than sharing it.
  const envs: Record<string, string>[] = [{}, { MCP_COMPLIANCE_RUNTIME: "oam" }];
  for (const extraEnv of envs) {
    it(
      `runs in-process instead of spawning a nested oam (env ${JSON.stringify(extraEnv)})`,
      async () => {
        const run = await runLauncher("0.15.2", extraEnv);
        expect(servedInProcess(run), `${JSON.stringify(extraEnv)} -> ${JSON.stringify(run)}`).toBe(true);
      },
      TIMEOUT_MS,
    );
  }

  it(
    "still discovers when the host oam is below the floor",
    async () => {
      const run = await runLauncher("0.15.1");
      expect(servedInProcess(run), `a below-floor host must not shortcut, got ${JSON.stringify(run)}`).toBe(false);
      expect(spawnedAndFailed(run), JSON.stringify(run)).toBe(true);
    },
    TIMEOUT_MS,
  );
});

maybeDescribe("launcher with no usable oam", () => {
  /**
   * An environment with no oam anywhere: HOME and LOCALAPPDATA point at an
   * empty directory, so the installed locations are empty, and PATH holds only
   * the directory of the Node running this test. Keeps a real oam on the
   * developer's box out of reach.
   */
  function isolated(extra: Record<string, string> = {}): Record<string, string> {
    const empty = mkdtempSync(join(tmpdir(), "mcp-compliance-launcher-home-"));
    return {
      PATH: dirname(process.execPath),
      USERPROFILE: empty,
      HOME: empty,
      LOCALAPPDATA: empty,
      ...extra,
    };
  }

  it(
    "names an OAM_BIN that does not exist instead of falling back silently",
    async () => {
      const run = await runLauncher(undefined, isolated({ OAM_BIN: join(tmpdir(), "no-such-dir", "oam.exe") }));
      expect(servedInProcess(run), JSON.stringify(run)).toBe(true);
      expect(run.stderr).toMatch(/^mcp-compliance: OAM_BIN=.*does not exist; using Node instead\.$/m);
    },
    TIMEOUT_MS,
  );

  it(
    "hands a below-floor oam host off to Node rather than running on it",
    async () => {
      const run = await runLauncher("0.9.0", isolated({ OAM_BIN: join(tmpdir(), "no-such-dir", "oam.exe") }));
      expect(handedOff(run), JSON.stringify(run)).toBe(true);
      expect(run.stderr).toMatch(
        /this process is oam 0\.9\.0, older than 0\.15\.2, and no newer oam was found; running on .*node/,
      );
    },
    TIMEOUT_MS,
  );

  it(
    "refuses to run on a below-floor oam host when there is no Node either",
    async () => {
      const noNode = mkdtempSync(join(tmpdir(), "mcp-compliance-launcher-nopath-"));
      const run = await runLauncher("0.9.0", isolated({ PATH: noNode, OAM_BIN: join(noNode, "oam.exe") }));
      expect(run.code, JSON.stringify(run)).toBe(1);
      expect(run.stdout.trim(), "nothing may run").toBe("");
      expect(run.stderr).toMatch(/older than 0\.15\.2, .*no Node was found on PATH/);
      expect(run.stderr).toMatch(/oam self-update/);
    },
    TIMEOUT_MS,
  );

  it(
    "hands MCP_COMPLIANCE_RUNTIME=node off to Node even on a supported oam host",
    async () => {
      const run = await runLauncher("0.15.2", isolated({ MCP_COMPLIANCE_RUNTIME: "node" }));
      expect(handedOff(run), JSON.stringify(run)).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    "names MCP_COMPLIANCE_RUNTIME=node, not an oam update, when that handoff finds no Node",
    async () => {
      const noNode = mkdtempSync(join(tmpdir(), "mcp-compliance-launcher-nopath-"));
      const run = await runLauncher("0.15.2", isolated({ PATH: noNode, MCP_COMPLIANCE_RUNTIME: "NODE" }));
      expect(run.code, JSON.stringify(run)).toBe(1);
      expect(run.stdout.trim(), "nothing may run").toBe("");
      expect(run.stderr).toMatch(/^mcp-compliance: MCP_COMPLIANCE_RUNTIME=node but no Node was found on PATH\.$/m);
      expect(run.stderr).not.toMatch(/self-update/);
    },
    TIMEOUT_MS,
  );

  it(
    "still falls back when the chosen oam fails to spawn on an oam host",
    async () => {
      // The chosen binary passed its --version probe and then could not be
      // spawned (deleted or replaced in between). A failed spawn emits 'error'
      // and then 'close' with the negative errno, and on an oam host the launcher
      // waits for 'close' -- so an unguarded close handler exited the launcher
      // mid-fallback and nothing ran. The preload makes the FIRST spawn target a
      // path that does not exist; the Node fallback spawns normally.
      const failFirstSpawn = [
        'import childProcess from "node:child_process";',
        'import { syncBuiltinESMExports } from "node:module";',
        "const realSpawn = childProcess.spawn;",
        "let failed = false;",
        "childProcess.spawn = function (cmd, args, opts) {",
        "  if (failed) return realSpawn.call(this, cmd, args, opts);",
        "  failed = true;",
        '  return realSpawn.call(this, cmd + ".does-not-exist", args, opts);',
        "};",
        "syncBuiltinESMExports();",
      ].join("\n");
      const run = await runLauncher("0.9.0", isolated({ OAM_BIN: process.execPath }), failFirstSpawn);
      expect(handedOff(run), `the Node fallback must still run: ${JSON.stringify(run)}`).toBe(true);
      expect(run.stderr).toMatch(/^mcp-compliance: failed to launch oam at .*; using Node instead\.$/m);
      // A newer oam WAS found -- it just would not start -- so the handoff note
      // must not claim otherwise.
      expect(run.stderr).not.toMatch(/no newer oam was found/);
      expect(run.stderr).toMatch(/this process is oam 0\.9\.0, older than 0\.15\.2; running on .*node/);
    },
    TIMEOUT_MS,
  );
});
