#!/usr/bin/env node
/**
 * Runtime launcher for @yawlabs/mcp-compliance.
 *
 * Prefers the oam runtime (https://oamjs.org) and falls back to the Node
 * process already running this file. The CLI itself (`dist/index.js`) is
 * runtime-agnostic -- a pre-bundled ESM entry using only `node:` builtins that
 * oam implements -- so neither path changes behavior.
 *
 * WHY THE FALLBACK COSTS NOTHING
 * npm has already started Node to run this launcher, so falling back is a plain
 * `import()` of the CLI into THIS process: no extra spawn, no extra startup,
 * byte-identical to invoking dist/index.js directly. Discovery is stat-only --
 * never a subprocess -- so the miss case stays sub-millisecond.
 *
 * WHAT THE OAM PATH COSTS
 * Reaching oam through an npm `bin` means Node boots first and oam boots second,
 * so the launcher is slower than either runtime alone. To skip it, point at oam
 * directly: `oam run <abs>/dist/index.js -- <args>`.
 *
 * NO SANDBOX HERE -- DELIBERATELY
 * oam 0.9.0's `--permission` is real hardening, but this tool cannot use it.
 * Its entire job is to spawn an arbitrary MCP server command supplied by the
 * caller (src/transport/stdio.ts) or connect to an arbitrary target URL, so the
 * child-process and network grants would both have to be unrestricted, and it
 * reads caller-supplied config files off disk. Every grant would be wide open,
 * so `--permission` is not offered rather than shipped as security theatre.
 *
 * MINIMUM OAM VERSION
 * 0.9.0, and this tool is the strongest case for the floor in the whole
 * @yawlabs/*-mcp set. Below it, oam's `child_process` diverged from Node in ways
 * that corrupt a compliance harness specifically:
 *
 *   - `stdio` was ignored entirely: `'inherit'` and `'ignore'` both behaved as
 *     `'pipe'`. A stdio MCP transport is nothing BUT its stdio wiring, so a run
 *     under an older oam measures the runtime's bug, not the server's compliance.
 *   - `execFile` ran its arguments through a SHELL. This suite deliberately
 *     sends OS-command-injection payloads (`; cat /etc/passwd`, `$(whoami)`,
 *     backtick-id) to assert the server under test does NOT execute them. If the
 *     HARNESS's own runtime re-splits and executes those payloads first, the
 *     result is a false verdict on the exact property being tested -- in the
 *     dangerous direction, because the harness would attribute its own execution
 *     to the server.
 *   - `spawnSync` truncated at `maxBuffer` while reporting success, so a large
 *     tools/list response could be silently cut and still look like a pass.
 *
 * An older oam is not an error: the launcher falls back to Node and says so on
 * stderr. Pinning the floor here is what makes that fallback automatic, and for
 * this tool a silent downgrade to Node is strictly the right outcome.
 *
 * SELECTION
 *   MCP_COMPLIANCE_RUNTIME=oam    require oam; fail loudly if it is missing
 *   MCP_COMPLIANCE_RUNTIME=node   never use oam
 *   MCP_COMPLIANCE_RUNTIME=auto   prefer oam, silently fall back (default)
 *   OAM_BIN=/path/to/oam          explicit binary, checked before any discovery
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { constants, homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Oldest oam whose `child_process` matches Node. See MINIMUM OAM VERSION above. */
const OAM_MIN = [0, 9, 0];

// Two forms, deliberately. `import()` on Windows REJECTS a bare `C:\...` path
// with ERR_UNSUPPORTED_ESM_URL_SCHEME (it reads `c:` as a protocol), so the
// in-process fallback must use the file:// URL. spawn() needs a real path.
const SERVER_URL = new URL("../dist/index.js", import.meta.url);
const SERVER_ENTRY = fileURLToPath(SERVER_URL);
const isWin = process.platform === "win32";
const exe = isWin ? "oam.exe" : "oam";

/** Locate an oam binary, or null. Every branch is a stat, never a subprocess. */
function findOam() {
  // 1. Explicit override wins and is never second-guessed.
  const override = process.env.OAM_BIN;
  if (override) return existsSync(override) ? override : null;

  // 2. Installed locations, BEFORE PATH. Someone who develops oam itself usually
  //    has oam/target/release on PATH, and a build directory is the wrong thing
  //    for a user-facing launcher to bind to: cargo replaces the binary
  //    underneath running processes, and the dev build is not the release the
  //    user installed. OAM_BIN remains the way to point at a dev build.
  const installed = [join(homedir(), ".oam", "bin", exe)];
  if (isWin) {
    installed.unshift(join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "oam", "bin", exe));
  }
  for (const candidate of installed) {
    if (existsSync(candidate)) return candidate;
  }

  // 3. PATH, resolved manually rather than by spawning `which`/`where`, which
  //    would cost a subprocess on every launch just to decide whether to spawn.
  const pathExt = isWin ? (process.env.PATHEXT ?? ".EXE").split(";").filter(Boolean) : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of isWin ? pathExt : [""]) {
      const candidate = join(dir, isWin ? `oam${ext.toLowerCase()}` : "oam");
      if (existsSync(candidate)) return candidate;
    }
  }

  return null;
}

/**
 * `oam --version` -> [major, minor, patch], or null when it cannot be read.
 * A pre-release suffix (0.9.0-rc.1) truncates to its base version.
 */
function oamVersion(cmd) {
  try {
    const out = execFileSync(cmd, ["--version"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(out);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  } catch {
    // Not executable, wrong arch, or deleted since the stat. Caller degrades.
    return null;
  }
}

/** True when `v` is at least `min`, comparing major/minor/patch in order. */
function atLeast(v, min) {
  if (!v) return false;
  for (let i = 0; i < min.length; i++) {
    if (v[i] > min[i]) return true;
    if (v[i] < min[i]) return false;
  }
  return true;
}

/** Run the CLI in THIS process. The zero-overhead fallback. */
async function runInProcess() {
  // Point argv[1] at the CLI first, so the in-process path is indistinguishable
  // from having executed the file directly -- an entry-point guard
  // (`import.meta.url === pathToFileURL(process.argv[1]).href`) must read true.
  process.argv[1] = SERVER_ENTRY;
  await import(SERVER_URL.href);
}

const mode = (process.env.MCP_COMPLIANCE_RUNTIME ?? "auto").toLowerCase();

if (mode === "node") {
  await runInProcess();
} else {
  const oam = findOam();

  if (!oam) {
    if (mode === "oam") {
      // Explicitly demanded, so this is a real misconfiguration -- do not
      // silently do something else. writeSync because stderr is async for
      // TTYs/pipes on Windows and process.exit truncates pending writes.
      const { writeSync } = await import("node:fs");
      writeSync(
        2,
        "mcp-compliance: MCP_COMPLIANCE_RUNTIME=oam but no oam binary was found.\n" +
          "Install from https://oamjs.org, set OAM_BIN=/path/to/oam, or use MCP_COMPLIANCE_RUNTIME=node.\n",
      );
      process.exit(1);
    }
    await runInProcess();
  } else if (!atLeast(oamVersion(oam), OAM_MIN)) {
    // Discovery itself stays stat-only; this is the first subprocess, and it
    // runs only once we have already decided to spawn oam anyway. Measured 26ms
    // median (n=12, windows-arm64), paid once per invocation.
    const min = OAM_MIN.join(".");
    if (mode === "oam") {
      const { writeSync } = await import("node:fs");
      writeSync(
        2,
        `mcp-compliance: MCP_COMPLIANCE_RUNTIME=oam but ${oam} is older than oam ${min}.\n` +
          `Run \`oam self-update\`, or use MCP_COMPLIANCE_RUNTIME=node.\n`,
      );
      process.exit(1);
    }
    // auto: an old oam is a reason to prefer Node, not to fail. Say so -- for
    // this tool especially, a silent downgrade would let someone publish a
    // compliance grade produced under a runtime that corrupts the measurement.
    process.stderr.write(`mcp-compliance: oam at ${oam} is older than ${min}; using Node instead.\n`);
    await runInProcess();
  } else {
    // `--` separates oam's own flags from the script's argv. Everything after it
    // lands in process.argv for the CLI, so subcommands and flags survive the
    // hop unchanged.
    const child = spawn(oam, ["run", SERVER_ENTRY, "--", ...process.argv.slice(2)], {
      // inherit keeps the SAME fds, so a stdio MCP session under test is framed
      // exactly as it would be without the launcher.
      stdio: "inherit",
      env: process.env,
      windowsHide: true,
    });

    // If oam cannot be executed at all (deleted between the stat and the spawn,
    // wrong arch, permission), fall back rather than failing outright.
    // `spawned` guards against falling back AFTER the child has begun running.
    let spawned = false;
    child.on("spawn", () => {
      spawned = true;
    });
    child.on("error", (err) => {
      if (spawned) return;
      if (mode === "oam") {
        process.stderr.write(`mcp-compliance: failed to launch oam (${err.message})\n`);
        process.exit(1);
      }
      void runInProcess();
    });

    // Forward termination so the server's own shutdown path runs in the child
    // rather than the child being orphaned.
    //
    // Registering ANY handler for these suppresses Node's default
    // terminate-on-signal, so the parent's exit has to be arranged explicitly.
    // `child.killed` only records that kill() was CALLED, never that the child
    // is gone, so gating on it swallows every signal after the first and wedges
    // the launcher with no escape hatch.
    //
    // Escalation is driven by a TIMER, not by counting signals. Counting is
    // ambiguous: a supervisor routinely sends SIGINT then SIGTERM milliseconds
    // apart, and a terminal Ctrl-C reaches the whole process group, so reading
    // "a second signal" as impatience hard-kills a child that is already
    // shutting down cleanly. A timer makes the count irrelevant -- ONE press is
    // enough, and a wedged child dies on schedule. setTimeout is monotonic, so
    // a wall-clock step cannot mis-gate the window either.
    //
    // POSIX vs Windows, and why we do NOT forward on Windows.
    // On POSIX child.kill(sig) delivers a real, catchable signal, so forwarding
    // is what lets the child run its shutdown. On Windows there are no POSIX
    // signals: child.kill IGNORES the name and calls TerminateProcess -- an
    // immediate hard kill (verified: a child with a SIGTERM handler never runs
    // it and dies with code=null, signal=SIGTERM). Forwarding there ABORTS the
    // graceful shutdown the console's own Ctrl-C just started, skipping the
    // child's process.on("exit") cleanup. The console has already notified the
    // child, so on Windows the timer below is the only kill we issue.
    const ESCALATE_AFTER_MS = 2000;
    let escalation = null;
    for (const sig of ["SIGINT", "SIGTERM"]) {
      process.on(sig, () => {
        // No try/catch: kill() on an already-exited child returns false, it does
        // not throw. It throws only for a signal the platform does not know,
        // which SIGINT/SIGTERM/SIGKILL never are.
        if (!isWin) child.kill(sig);
        if (escalation) return; // already counting down; further signals are noise
        escalation = setTimeout(() => {
          // Still here after its grace window. Stop waiting on it.
          child.kill("SIGKILL");
          process.exit(128 + (constants.signals[sig] ?? 15));
        }, ESCALATE_AFTER_MS);
      });
    }

    child.on("exit", (code, signal) => {
      if (escalation) clearTimeout(escalation);
      // Mirror the child's fate: a signal death becomes 128+n so callers see a
      // conventional shell exit status rather than a bare 0. This tool's exit
      // code is its verdict, so passing it through unchanged is load-bearing.
      if (signal) {
        process.exit(128 + (constants.signals[signal] ?? 15));
      }
      process.exit(code ?? 0);
    });
  }
}
