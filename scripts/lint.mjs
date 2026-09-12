#!/usr/bin/env node
/**
 * Run biome against a binary that works on this host, at the version this repo
 * actually installs.
 *
 * Everywhere except Windows ARM64 this is a thin passthrough to the platform
 * binary npm installed. It exists because SOME biome releases ship a native
 * `@biomejs/cli-win32-arm64` build that crashes instead of running. Measured
 * on a Windows 11 ARM64 host: 2.5.4 exits 139 on every CHECK-shaped run (it answers --version fine)
 * (`npm run lint`, the `.bin/biome` shim, `npx biome`, and the .exe invoked
 * directly), while 2.4.16 and 2.5.13 run correctly there and report real
 * findings. The defect is per-RELEASE, not a permanent property of the
 * architecture -- earlier and later versions are healthy, and a future bump
 * may be too.
 *
 * That is what makes it dangerous in a release gate: a crash and a clean pass
 * both look like "the linter printed no findings", and which version you get
 * is whatever the lockfile pins. So on this host the script defaults to the
 * x64 build OF THE SAME VERSION, which runs correctly under Windows' x64
 * emulation and gives an authoritative result. `YAWLABS_BIOME_NATIVE=1` uses
 * the native arm64 binary instead, which is the right call once the installed
 * version is known good there.
 *
 * What is NOT wrong, so nobody re-diagnoses it from this file: `npm run` is
 * not implicated (a plain node script through the same wrapper exits 0), and
 * no invocation path "silently skips files" -- a healthy binary reports the
 * full checked-file count through npx, the shim and the direct .exe alike. A
 * broken binary crashes loudly; a working one works.
 *
 * Why this is a script and not a devDependency: npm refuses to install
 * `@biomejs/cli-win32-x64` on an arm64 host (EBADPLATFORM), which is precisely
 * the situation we are working around, so it cannot be declared normally. The
 * install below passes `--force` for that reason and `--no-save` so the
 * workaround never leaks into package.json.
 *
 * Why it matters here specifically: this repo has no CI. Its GitHub Actions
 * workflows were removed in fe1185a (#62), there is no .github/workflows
 * directory, and Actions is disabled on the repository, so there is no runner
 * to arbitrate formatting later. Whatever this script reports is the ONLY lint
 * signal that exists before `release.sh` publishes to npm from the workstation.
 *
 * Escape hatches, in case the platform assumption ages badly:
 *   YAWLABS_BIOME_BIN=<path>   use exactly this binary, skip all detection
 *   YAWLABS_BIOME_NATIVE=1     force the normal platform binary on any host
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";
const exe = isWindows ? ".exe" : "";

/**
 * Every spawn below is bounded, because `npm run lint` runs UNATTENDED as
 * release.sh step 1 -- an unbounded child there turns a WEDGED release rather
 * than a failed one, with no output to say why. This repo already made that
 * call once for the same caller: vitest.config.ts bounds every test with
 * `testTimeout: 30000` on exactly this reasoning.
 *
 * Deliberately generous -- these convert an infinite hang into a reported
 * failure, they are not performance budgets. For scale, biome checks this repo
 * in well under a second.
 */
const PROBE_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const LINT_TIMEOUT_MS = 10 * 60_000;

/**
 * The biome version to provision: the one this repo actually INSTALLS, read
 * from package-lock.json, falling back to the installed package's own
 * package.json.
 *
 * It deliberately does NOT come from biome.json's `$schema`. That URL pins the
 * version whose SCHEMA the config is validated against -- an authoring aid for
 * editors -- and nothing keeps it in step with the binary npm resolves out of
 * the `^x.y.z` range in devDependencies. Those two drift apart the moment a
 * minor bump lands, and that gap was this script's bug: with `$schema` at
 * 2.4.16 and the lockfile at 2.5.2, the emulated binary linted with a version
 * the repo does not use, so a green gate said nothing about the version `npm
 * ci` installs. In a sibling repo the same mismatch turned a release-blocking
 * crash into a false pass and hid three real findings.
 *
 * The lockfile is the first source because it is the version `npm ci` will
 * install even when node_modules is absent or stale; the installed package is
 * the fallback for a checkout without a lockfile.
 */
function installedBiomeVersion() {
  const lockPath = join(repoRoot, "package-lock.json");
  if (existsSync(lockPath)) {
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    const locked = lock?.packages?.["node_modules/@biomejs/biome"]?.version;
    if (typeof locked === "string" && locked) return locked;
  }

  const installedPkg = join(repoRoot, "node_modules", "@biomejs", "biome", "package.json");
  if (existsSync(installedPkg)) {
    const version = JSON.parse(readFileSync(installedPkg, "utf8")).version;
    if (typeof version === "string" && version) return version;
  }

  throw new Error(
    "Could not determine which biome version this repo installs.\n" +
      'package-lock.json has no packages["node_modules/@biomejs/biome"].version entry, and\n' +
      "node_modules/@biomejs/biome is not installed either. Run `npm ci` (or `npm install`),\n" +
      "or set YAWLABS_BIOME_BIN=<path to a working biome> to skip version detection entirely.",
  );
}

/** The platform binary npm installed for THIS host, or null when absent. */
function nativeBinary() {
  const pkg = `@biomejs/cli-${process.platform}-${process.arch}`;
  const direct = join(repoRoot, "node_modules", ...pkg.split("/"), `biome${exe}`);
  if (existsSync(direct)) return direct;
  // musl and other suffixed variants (cli-linux-x64-musl) don't match the plain
  // name above; fall back to the shim npm links, which is correct everywhere the
  // native binary is not itself broken.
  const shim = join(repoRoot, "node_modules", ".bin", isWindows ? "biome.cmd" : "biome");
  return existsSync(shim) ? shim : null;
}

/**
 * Resolve npm's own CLI entry point so the install below can be spawned through
 * `node` with NO shell.
 *
 * Both halves of that matter on Windows. `npm` on PATH is `npm.cmd`, and
 * spawning a `.cmd` with `shell: false` throws EINVAL on Node 22 -- but turning
 * the shell ON makes cmd.exe re-split the argv on whitespace, so a repo path
 * containing a space arrives as two arguments and the second is read as a
 * package name. (Measured: `--prefix "C:\a b\c"` becomes
 * `["--prefix","C:a","bc"]`.) Spawning node with npm-cli.js sidesteps both.
 */
function npmCliPath() {
  const candidates = [
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/**
 * Provision (once per version) and return the emulated x64 binary. Installs
 * into node_modules/.cache, which is already gitignored via node_modules/ and
 * is wiped by `npm ci` -- the next run simply re-installs it.
 *
 * The version is part of the DIRECTORY NAME, not just the install argument.
 * Keying the cache on presence alone would silently reuse a stale binary after
 * a biome bump -- reintroducing the very drift that sourcing the version from
 * the lockfile exists to close, since the repo would install one version while
 * the checking was done by another. A version-stamped path also means an install
 * interrupted midway leaves a directory that the NEXT bump abandons rather than
 * trusts; the explicit re-verify below covers the same-version case.
 */
function emulatedX64Binary(version) {
  const prefix = join(repoRoot, "node_modules", ".cache", `biome-x64-${version}`);
  const bin = join(prefix, "node_modules", "@biomejs", "cli-win32-x64", "biome.exe");

  // Presence is not validity: an install killed partway through leaves a
  // truncated .exe that would otherwise be cached forever. Confirm the binary
  // actually runs and reports the version we asked for before trusting it.
  if (existsSync(bin)) {
    // Bounded: a corrupt-but-executable binary, or one stalled inside the x64
    // emulation layer, would otherwise hang every lint invocation forever. A
    // timeout leaves `status` null, which fails the check below and routes into
    // the discard path -- the right answer for a binary that cannot answer
    // `--version` in 30 seconds.
    const probe = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: PROBE_TIMEOUT_MS });
    if (probe.status === 0 && String(probe.stdout).includes(version)) return bin;
    // DISCARD the tree rather than reinstalling over it. `npm i` treats an
    // already-present package as satisfied -- even with --force -- so installing
    // on top of a truncated binary is a silent no-op that leaves the corruption
    // in place and re-runs npm on every subsequent invocation. Measured: a
    // 7-byte biome.exe survived the reinstall and lint kept failing.
    //
    // Bounded on purpose: `prefix` is a version-stamped directory this script
    // created under the repo's own node_modules/.cache, never a user-supplied
    // or shared path.
    console.error(`[lint] cached biome at ${bin} is unusable or not ${version}; discarding and re-provisioning`);
    rmSync(prefix, { recursive: true, force: true });
  }

  const npmCli = npmCliPath();
  if (!npmCli) {
    throw new Error(
      "Could not locate npm-cli.js next to this node install, so the x64 biome cannot be\n" +
        "provisioned without a shell (see npmCliPath). Set YAWLABS_BIOME_BIN=<path to a\n" +
        "working biome> instead.",
    );
  }

  console.error(`[lint] provisioning biome ${version} (x64, run under emulation) -- the win32-arm64 build of some releases crashes on this host`);
  const install = spawnSync(
    process.execPath,
    [npmCli, "i", "--no-save", "--force", "--prefix", prefix, `@biomejs/cli-win32-x64@${version}`],
    { stdio: "inherit", shell: false, timeout: INSTALL_TIMEOUT_MS },
  );
  if (install.status !== 0 || !existsSync(bin)) {
    // Distinguish the two failures: a registry stall and a genuine install
    // error need different responses, and "npm exited null" says neither.
    const why =
      install.error && install.error.code === "ETIMEDOUT"
        ? `npm did not finish within ${INSTALL_TIMEOUT_MS / 1000}s and was killed`
        : `npm exited ${install.status}`;
    throw new Error(
      `Failed to provision @biomejs/cli-win32-x64@${version} (${why}).\n` +
        "This repo has no CI, so there is no other lint signal. Fix the install, or set\n" +
        "YAWLABS_BIOME_BIN=<path to a working biome> to point this script at one.",
    );
  }
  return bin;
}

function resolveBinary() {
  if (process.env.YAWLABS_BIOME_BIN) return process.env.YAWLABS_BIOME_BIN;

  // Windows ARM64 defaults to the emulated x64 build of the SAME version:
  // whether the native build of the installed version is one of the crashing
  // ones is not knowable without running it, and "ran and crashed" is
  // indistinguishable from "ran and found nothing" to a release gate.
  const preferEmulated = isWindows && process.arch === "arm64" && process.env.YAWLABS_BIOME_NATIVE !== "1";
  if (preferEmulated) return emulatedX64Binary(installedBiomeVersion());

  const native = nativeBinary();
  if (!native) {
    throw new Error("No biome binary found in node_modules -- run `npm install` first.");
  }
  return native;
}

let binary;
try {
  binary = resolveBinary();
} catch (err) {
  console.error(`[lint] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

// Exit with biome's own status so `npm run lint` stays a usable gate, and so a
// non-zero result is a real finding rather than this wrapper's opinion.
//
// `shell` is enabled ONLY for a .cmd/.bat target: spawning one with shell:false
// throws EINVAL on Node 22 (the `.bin/biome.cmd` shim fallback, and any
// YAWLABS_BIOME_BIN pointing at a batch file). Everything else -- including
// every normal .exe path -- stays shell-free so arguments are passed verbatim.
const needsShell = /\.(cmd|bat)$/i.test(binary);
const run = spawnSync(binary, process.argv.slice(2), { stdio: "inherit", shell: needsShell, timeout: LINT_TIMEOUT_MS });
// Checked BEFORE the generic error and crash branches: a timeout kill sets
// `signal` to SIGTERM, which the crash check below would otherwise report as
// the known native-binary crash -- the wrong diagnosis entirely.
if (run.error && run.error.code === "ETIMEDOUT") {
  console.error(
    `[lint] biome did not finish within ${LINT_TIMEOUT_MS / 60_000} minutes and was killed (${binary}). ` +
      "That is far past a normal run, so treat it as a hung binary rather than a slow one.",
  );
  process.exit(1);
}
if (run.error) {
  console.error(`[lint] could not execute ${binary}: ${run.error.message}`);
  process.exit(1);
}
// A native crash surfaces differently by platform: POSIX reports a signal,
// while Windows reports an NTSTATUS as the exit CODE and leaves signal null
// (measured: the arm64 biome access violation is status 3221225477 / 0xC0000005,
// signal null). Checking only `signal` meant this diagnostic could never fire on
// the one host it was written for.
const crashed = run.signal !== null || (run.status ?? 0) >= 0xc0000000;
if (crashed) {
  const how = run.signal ? `killed by ${run.signal}` : `crashed with 0x${(run.status >>> 0).toString(16)}`;
  console.error(
    `[lint] biome ${how} (${binary}).\n` +
      "On Windows ARM64 the native build of some biome releases crashes exactly like this;\n" +
      "this script normally routes around it by running the x64 build of the same version,\n" +
      "so check the YAWLABS_BIOME_BIN / YAWLABS_BIOME_NATIVE overrides.",
  );
  process.exit(1);
}
process.exit(run.status ?? 1);
