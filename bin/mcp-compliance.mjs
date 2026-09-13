#!/usr/bin/env node
/**
 * Runtime launcher for @yawlabs/mcp-compliance.
 *
 * Prefers the newest usable oam runtime (https://oamjs.org) and falls back to
 * Node. It never runs the CLI on an oam older than the floor below. The CLI
 * itself (`dist/index.js`) is runtime-agnostic -- a pre-bundled ESM entry using
 * only `node:` builtins that oam implements -- so neither path changes behavior.
 *
 * WHY THE FALLBACK COSTS NOTHING
 * npm has already started Node to run this launcher, so falling back is a plain
 * `import()` of the CLI into THIS process: no extra spawn, no extra startup,
 * byte-identical to invoking dist/index.js directly. Finding the candidates is
 * stat-only, so a machine without oam never pays for a subprocess.
 *
 * WHAT THE OAM PATH COSTS
 * Reaching oam through an npm `bin` means Node boots first, every oam binary
 * found is asked for its version, and then oam boots to run the CLI -- so the
 * launcher is slower than either runtime alone. To skip it, point at oam
 * directly: `oam run <abs>/dist/index.js -- <args>`.
 *
 * WHICH OAM
 * OAM_BIN, when set and usable, is used as given. Otherwise every oam binary
 * discovery can see -- the installed locations, then PATH -- is asked for its
 * version, and the NEWEST one at or above the floor wins; a tie keeps search
 * order. Taking the first binary found instead let a stale copy early in the
 * search order hide a current one later: with oam 0.9.0 installed in ~/.oam/bin
 * and 0.15.2 on PATH, the launcher bound to 0.9.0 because installed locations
 * are searched first.
 *
 * Whenever the launcher goes looking for an oam, an OAM_BIN that does not exist,
 * is below the floor, or will not run is named on stderr -- whether or not a
 * usable oam turns up after it -- and discovery carries on. It used to end the
 * search: a typo in OAM_BIN meant Node, with no hint why. Discovered binaries
 * that were passed over, and any .cmd/.bat shim, are named only when NO usable
 * oam is found; when one is, the launcher uses it without listing what it
 * skipped.
 *
 * ALREADY RUNNING ON OAM
 * A host can resolve this package's `bin` and launch `oam run <this file>`
 * instead of `node <this file>` -- Yaw MCP does, and so does oam's sidecar
 * regression matrix. Spawning a discovered oam there cost one CLI two runtime
 * boots: measured on Windows, oam.exe with a NESTED oam.exe + conhost.exe
 * underneath it. When `process.versions.oam` clears the floor, the CLI is
 * imported into THIS process exactly as the Node fallback is -- no discovery,
 * no `oam --version` probe, no second oam. OAM_BIN is a discovery input, so it
 * is not consulted on that path: the host has already chosen which oam runs.
 * Nothing is lost by skipping the spawn, because there is no sandbox to apply
 * (see below) and the host oam has cleared the same floor a discovered one
 * would have to.
 *
 * A host oam BELOW the floor never runs the CLI. It used to, whenever discovery
 * found no usable oam -- none at all, or only one that was too old or would not
 * run. It now hands the CLI off to the newest usable oam, or to Node found on
 * PATH, or exits with an error when there is neither.
 *
 * That handoff PIPES stdio rather than inheriting it. Before 0.9.0 oam treated
 * `stdio: 'inherit'` as `'pipe'`, so an inherited handoff from such a host
 * connected the child to pipes nobody reads: measured with a real oam 0.8.2
 * host, the MCP handshake never answered. Piping the streams explicitly
 * completes it, to both oam and Node. The child's stdout is then a pipe rather
 * than the terminal, so TTY-dependent output (the terminal report's colors) is
 * off on that path. A Node host keeps `inherit`, which hands over the same fds
 * untouched.
 *
 * NO SANDBOX HERE -- DELIBERATELY
 * oam's `--permission` is real hardening, but this tool cannot use it. Its
 * entire job is to spawn an arbitrary MCP server command supplied by the caller
 * (src/transport/stdio.ts) or connect to an arbitrary target URL, so the
 * child-process and network grants would both have to be unrestricted, and it
 * reads caller-supplied config files off disk. Every grant would be wide open,
 * so `--permission` is not offered rather than shipped as security theatre.
 *
 * MINIMUM OAM VERSION
 * The latest oam release, 0.15.2 -- bump OAM_MIN when oam ships a newer one.
 * Only the current oam is used and verified; an older one is passed over. The
 * floor is not cosmetic, and this tool is the strongest case for it in the
 * whole @yawlabs/*-mcp set. Before 0.9.0, oam's `child_process` diverged from
 * Node in ways that corrupt a compliance harness specifically:
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
 * An older oam is not an error: under `auto` the launcher falls back to Node and
 * says so on stderr. For this tool a downgrade to Node is strictly the right
 * outcome.
 *
 * SELECTION
 *   MCP_COMPLIANCE_RUNTIME=auto   newest usable oam, else Node (default)
 *   MCP_COMPLIANCE_RUNTIME=oam    newest usable oam, else exit with an error
 *                                 (already running on oam at the floor satisfies it)
 *   MCP_COMPLIANCE_RUNTIME=node   Node: in THIS process on Node, handed off to
 *                                 Node on PATH when THIS process is oam
 *   OAM_BIN=/path/to/oam          use this oam when it is usable, before discovery
 * The value is case-insensitive; anything else behaves like `auto`.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { constants, homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The oam release this CLI is verified on. See MINIMUM OAM VERSION above. */
const OAM_MIN = [0, 15, 2];

/**
 * Bound on each `oam --version` probe. A healthy oam answers in milliseconds;
 * the bound only exists so a wedged binary on PATH cannot hang the launch.
 */
const VERSION_PROBE_TIMEOUT_MS = 5_000;

// Two forms, deliberately. `import()` on Windows REJECTS a bare `C:\...` path
// with ERR_UNSUPPORTED_ESM_URL_SCHEME (it reads `c:` as a protocol), so the
// in-process fallback must use the file:// URL. spawn() needs a real path.
const SERVER_URL = new URL("../dist/index.js", import.meta.url);
const SERVER_ENTRY = fileURLToPath(SERVER_URL);
const isWin = process.platform === "win32";
const exe = isWin ? "oam.exe" : "oam";

/** Identity for de-duplicating paths: resolved, and case-folded on Windows. */
function pathKey(p) {
  let key = p;
  try {
    key = realpathSync(p);
  } catch {
    // Unresolvable: fall back to the literal path.
  }
  return isWin ? key.toLowerCase() : key;
}

/**
 * Every oam binary discovery can see, in search order, de-duplicated. Stat-only,
 * never a subprocess.
 *
 * Installed locations come BEFORE PATH, so when two binaries report the same
 * version the installed copy wins the tie. Someone who develops oam itself
 * usually has oam/target/release on PATH, and a build directory is the wrong
 * thing to prefer at equal versions: cargo replaces the binary underneath
 * running processes. Both forms are checked on Windows: the installer defaults
 * to %LOCALAPPDATA%\oam\bin there, but oam's docs name ~/.oam/bin first and
 * OAM_INSTALL_DIR can pick either.
 *
 * PATH is resolved manually rather than by spawning `which`/`where`, which would
 * cost a subprocess on every launch just to find the candidates.
 *
 * Windows: `.exe` ONLY -- deliberately narrower than PATHEXT. Node refuses to
 * run a .cmd/.bat through execFile/spawn without `shell: true` (EINVAL, and for
 * spawn it throws SYNCHRONOUSLY rather than emitting 'error'), so walking the
 * full PATHEXT list would hand back a path this launcher cannot execute.
 * Discovery has to agree with execution. A skipped shim is still named on
 * stderr when no usable oam is found -- see findOamShim.
 */
function discoverOamPaths() {
  const installed = [join(homedir(), ".oam", "bin", exe)];
  if (isWin) {
    installed.unshift(join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "oam", "bin", exe));
  }
  const onPath = (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, exe));
  const seen = new Set();
  const found = [];
  for (const candidate of [...installed, ...onPath]) {
    if (!existsSync(candidate)) continue;
    const key = pathKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(candidate);
  }
  return found;
}

/**
 * Version text -> [major, minor, patch], or null when it holds no version.
 * A pre-release suffix (0.9.0-rc.1) truncates to its base version.
 *
 * Shared by the two places a version is read -- a discovered binary's
 * `oam --version` output ("oam 0.15.2") and the host's own
 * `process.versions.oam` ("0.15.2") -- so they cannot disagree about what a
 * version string means, or which floor it has to clear.
 */
function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** `oam --version` -> [major, minor, patch], or null when it cannot be read. */
function oamVersion(cmd) {
  try {
    const out = execFileSync(cmd, ["--version"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: VERSION_PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    return parseVersion(out);
  } catch {
    // Not executable, wrong arch, wedged, or deleted since the stat. Caller degrades.
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

/**
 * The newest candidate at or above the floor, or null. `candidates` is
 * `{ path, version }[]` in search order, `version` null when unreadable.
 * Strictly-greater replaces, so a tie keeps the earlier candidate.
 *
 * Pure on purpose, like runtimePlan: the choice is testable without binaries.
 */
function pickNewest(candidates) {
  let best = null;
  for (const candidate of candidates) {
    if (!atLeast(candidate.version, OAM_MIN)) continue;
    if (!best || !atLeast(best.version, candidate.version)) best = candidate;
  }
  return best;
}

/**
 * Where the CLI runs, decided BEFORE any discovery:
 *   "in-process"   import it into THIS process
 *   "discover"     choose an oam and spawn it, or fall back to Node
 *   "handoff-node" hand it off to Node on PATH: THIS process is an oam, and
 *                  Node was asked for
 *
 * `hostOam` is `process.versions.oam`: oam's own key, absent on Node. An oam
 * host whose version cannot be read is treated as below the floor -- it never
 * proved it is a supported oam. There is no sandbox input because this
 * launcher offers none (see NO SANDBOX HERE above), so nothing a spawn could
 * carry is lost by staying in-process. The floor is OAM_MIN itself, not a
 * parameter, so a host oam and a discovered one can never be held to different
 * minimums.
 *
 * Pure on purpose: every input is passed in, so the whole decision is testable
 * without booting a runtime.
 */
function runtimePlan({ mode, hostOam }) {
  const onOam = hostOam !== undefined;
  if (mode === "node") return onOam ? "handoff-node" : "in-process";
  return atLeast(parseVersion(hostOam ?? ""), OAM_MIN) ? "in-process" : "discover";
}

/**
 * Write a diagnostic to stderr synchronously, so a following process.exit
 * cannot truncate it.
 *
 * Not a bare writeSync: that call can short-write (it returns a byte count) and
 * on macOS it can throw EAGAIN, because Node makes a piped stderr non-blocking
 * there rather than blocking the write. Loop over the remaining bytes, and if
 * stderr turns out to be unusable give up quietly -- failing to print a
 * diagnostic is not worth crashing a stdio server over.
 */
async function errSync(message) {
  const { writeSync } = await import("node:fs");
  const buf = Buffer.from(message);
  let off = 0;
  for (let attempts = 0; off < buf.length && attempts < 1000; attempts++) {
    try {
      off += writeSync(2, buf, off, buf.length - off);
    } catch (err) {
      if (err?.code !== "EAGAIN") return;
      // Pipe is full and the reader has not drained yet -- retry.
    }
  }
}

/**
 * An oam-named .cmd/.bat on PATH: a real install in a shape this launcher
 * cannot spawn. Looked for only when no usable oam was found, and then reported
 * rather than ignored, because "no usable oam was found" alone reads as "install
 * oam" -- the one thing that will not help. When a usable oam IS found, a shim
 * beside it is not mentioned. Windows only; there is no such shim concept on
 * POSIX.
 */
function findOamShim() {
  if (!isWin) return null;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of [".cmd", ".bat"]) {
      const candidate = join(dir, `oam${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** A Node binary on PATH, or null. Stat-only; used only when THIS process is oam. */
function findNodeOnPath() {
  const name = isWin ? "node.exe" : "node";
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Why a candidate was passed over, for stderr. "Too old" and "could not be run"
 * are different causes with different remedies, so they never share wording:
 * `oamVersion` returns null for a binary that is not executable, is the wrong
 * architecture, was deleted since the stat, or printed no parseable version.
 */
function unusableReason(path, version, label = path) {
  const min = OAM_MIN.join(".");
  return version
    ? `${label} is oam ${version.join(".")}, older than ${min}`
    : `${label} could not be run, or did not report a version this launcher understands`;
}

/**
 * Choose the oam to spawn: a usable OAM_BIN, else the newest usable discovered
 * binary. Returns the choice (or null) plus stderr notes: `overrideNote` about
 * an unusable OAM_BIN, and `skipped` describing what was found and rejected
 * when nothing was usable.
 */
function chooseOam() {
  const override = process.env.OAM_BIN;
  let overrideNote = null;
  if (override) {
    if (!existsSync(override)) {
      overrideNote = `OAM_BIN=${override} does not exist`;
    } else {
      const version = oamVersion(override);
      if (atLeast(version, OAM_MIN)) return { chosen: { path: override, version }, overrideNote, skipped: [] };
      overrideNote = unusableReason(override, version, `OAM_BIN=${override}`);
    }
  }
  const overrideKey = override ? pathKey(override) : null;
  const candidates = discoverOamPaths()
    .filter((path) => pathKey(path) !== overrideKey)
    .map((path) => ({ path, version: oamVersion(path) }));
  const chosen = pickNewest(candidates);
  const skipped = chosen ? [] : candidates.map((c) => unusableReason(c.path, c.version));
  return { chosen, overrideNote, skipped };
}

/** Run the CLI in THIS process. The zero-overhead fallback. */
async function runInProcess() {
  // Point argv[1] at the CLI first, so the in-process path is indistinguishable
  // from having executed the file directly -- an entry-point guard
  // (`import.meta.url === pathToFileURL(process.argv[1]).href`) must read true.
  // The spawn path needs no equivalent -- there argv[1] is already the CLI.
  process.argv[1] = SERVER_ENTRY;
  await import(SERVER_URL.href);
}

// ONE reporter for every failed in-process fallback. runInProcess() is a bare
// import() that rejects when dist/index.js is missing, and at ESM top level an
// unhandled rejection is an uncaught exception -- replacing this launcher's
// diagnostic with a raw stack trace.
const fallbackFailed = (e) => {
  process.stderr.write(`mcp-compliance: fallback to Node failed (${e?.message ?? e})\n`);
  process.exitCode = 1;
};

/**
 * Spawn the CLI in a child runtime and mirror its lifetime.
 *
 * `onLaunchFailed(err)` runs when the child could not be started at all; it is
 * never called once the child is running, which would double-start the CLI on
 * the same stdio.
 */
async function launchChild(cmd, args, onLaunchFailed) {
  // THIS process being an oam means one below the floor, or any oam under
  // MCP_COMPLIANCE_RUNTIME=node (a supported oam host otherwise runs the CLI
  // in-process). An old oam's `stdio: 'inherit'` does not hand over the fds, so
  // pipe explicitly there; see ALREADY RUNNING ON OAM.
  const piped = process.versions.oam !== undefined;
  let child = null;
  try {
    child = spawn(cmd, args, {
      // inherit keeps the SAME fds, so a stdio MCP session is framed exactly as
      // it would be without the launcher, and the host's stdin-close still
      // reaches the server's shutdown path. Piping preserves both as well:
      // bytes are copied unchanged, and stdin's end propagates to the child.
      stdio: piped ? ["pipe", "pipe", "pipe"] : "inherit",
      env: process.env,
      windowsHide: true,
    });
  } catch (err) {
    // spawn() THROWS for some failures instead of emitting 'error', and the
    // 'error' listener is registered AFTER this call, so it can never observe
    // one -- an uncaught throw here kills the launcher with a raw stack trace
    // instead of falling back.
    await onLaunchFailed(err).catch(fallbackFailed);
    return;
  }

  // If the runtime cannot be executed at all (deleted between the version probe
  // and the spawn, wrong arch, permission), fall back rather than failing
  // outright. `spawned` guards against falling back AFTER the child has begun
  // running.
  //
  // Everything that assumes a live child waits for 'spawn'. A failed spawn
  // still emits 'close' (after 'error', with the negative errno as its code), so
  // an unguarded close handler would process.exit() out from under the fallback
  // onLaunchFailed has just started: measured on a posed oam host, the launcher
  // exited with the ENOENT errno and nothing ran. Piping and signal forwarding
  // wait too, so a child that never ran is never handed the host's stdin or its
  // signals; until 'spawn', process.stdin has no reader and stays paused.
  let spawned = false;
  child.on("spawn", () => {
    spawned = true;
    if (piped) {
      process.stdin.pipe(child.stdin);
      child.stdout.pipe(process.stdout);
      child.stderr.pipe(process.stderr);
    }
    forwardSignals();
  });
  child.on("error", (err) => {
    if (spawned) return;
    // Handle the rejection instead of discarding it: a failing in-process
    // fallback would otherwise escape as an unhandled rejection.
    onLaunchFailed(err).catch(fallbackFailed);
  });
  // A child that exits before reading everything closes its stdin; the
  // resulting EPIPE is not worth crashing over. Null when stdio is inherited.
  child.stdin?.on("error", () => {});

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
  function forwardSignals() {
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
  }

  // Piped: wait for 'close', so the child's last stdout bytes -- a JSON or
  // SARIF report, say -- are copied out before this process exits. Inherited:
  // 'exit' is enough, the fds were never ours to drain. Either way, only for a
  // child that actually ran -- see the 'spawn' handler above.
  child.on(piped ? "close" : "exit", (code, signal) => {
    if (!spawned) return;
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

/**
 * Hand the CLI to Node on PATH. Only reachable when THIS process is oam -- one
 * below the floor, or any oam under MCP_COMPLIANCE_RUNTIME=node -- so there is
 * no in-process option left.
 */
async function handOffToNode(reason) {
  const node = findNodeOnPath();
  if (!node) {
    // An empty reason means Node was asked for on an oam host that is itself
    // fine, so updating oam is not the remedy there.
    await errSync(
      reason
        ? `mcp-compliance: ${reason}, and no Node was found on PATH to run the CLI instead.\n` +
            `Run \`oam self-update\` to get oam ${OAM_MIN.join(".")} or newer, or launch this command with node.\n`
        : "mcp-compliance: MCP_COMPLIANCE_RUNTIME=node but no Node was found on PATH.\n" +
            "Put Node on PATH, launch this command with node, or unset MCP_COMPLIANCE_RUNTIME.\n",
    );
    process.exit(1);
  }
  if (reason) await errSync(`mcp-compliance: ${reason}; running on ${node} instead.\n`);
  await launchChild(node, [SERVER_ENTRY, ...process.argv.slice(2)], async (err) => {
    await errSync(`mcp-compliance: failed to launch Node at ${node} (${err?.message ?? err})\n`);
    process.exit(1);
  });
}

/**
 * No usable oam, under a mode that allows Node. `oamFailed` is true when a
 * usable oam WAS chosen but would not start: the caller has already said so on
 * stderr, and the handoff note must not then claim that none was found.
 */
async function fallBackToNode(hostOam, oamFailed = false) {
  if (hostOam === undefined) {
    await runInProcess();
    return;
  }
  const tooOld = `this process is oam ${hostOam}, older than ${OAM_MIN.join(".")}`;
  await handOffToNode(oamFailed ? tooOld : `${tooOld}, and no newer oam was found`);
}

const mode = (process.env.MCP_COMPLIANCE_RUNTIME ?? "auto").toLowerCase();
const hostOam = process.versions.oam;
const plan = runtimePlan({ mode, hostOam });

if (plan === "in-process") {
  await runInProcess();
} else if (plan === "handoff-node") {
  const belowFloor = !atLeast(parseVersion(hostOam), OAM_MIN);
  await handOffToNode(belowFloor ? `this process is oam ${hostOam}, older than ${OAM_MIN.join(".")}` : "");
} else {
  const { chosen, overrideNote, skipped } = chooseOam();

  if (chosen) {
    if (overrideNote) {
      await errSync(`mcp-compliance: ${overrideNote}; using ${chosen.path} (oam ${chosen.version.join(".")}).\n`);
    }
    // `--` separates oam's own flags from the script's argv. Everything after it
    // lands in process.argv for the CLI, so subcommands and flags survive the
    // hop unchanged.
    await launchChild(chosen.path, ["run", SERVER_ENTRY, "--", ...process.argv.slice(2)], async (err) => {
      if (mode === "oam") {
        await errSync(`mcp-compliance: failed to launch oam at ${chosen.path} (${err?.message ?? err})\n`);
        process.exit(1);
      }
      await errSync(
        `mcp-compliance: failed to launch oam at ${chosen.path} (${err?.message ?? err}); using Node instead.\n`,
      );
      await fallBackToNode(hostOam, true);
    });
  } else {
    const shim = findOamShim();
    const notes = [
      ...(overrideNote ? [overrideNote] : []),
      ...skipped,
      ...(shim
        ? [
            `found ${shim}, but Node cannot execute a .cmd/.bat directly -- install the native oam binary, or point OAM_BIN at one`,
          ]
        : []),
    ];
    if (mode === "oam") {
      // Explicitly demanded, so this is a real misconfiguration -- do not
      // silently do something else.
      await errSync(
        `mcp-compliance: MCP_COMPLIANCE_RUNTIME=oam but no usable oam (${OAM_MIN.join(".")} or newer) was found.\n` +
          notes.map((note) => `  ${note}\n`).join("") +
          "Install or update from https://oamjs.org, set OAM_BIN=/path/to/oam, or use MCP_COMPLIANCE_RUNTIME=node.\n",
      );
      process.exit(1);
    }
    // auto: falling back is correct, but silence is how someone never learns
    // their OAM_BIN is wrong, their oam is too old, or their install is a shape
    // this launcher skips.
    if (notes.length > 0) await errSync(`mcp-compliance: ${notes.join("; ")}; using Node instead.\n`);
    await fallBackToNode(hostOam).catch(fallbackFailed);
  }
}
