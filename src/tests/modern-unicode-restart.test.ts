import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runComplianceSuite } from "../runner.js";
import { MODERN_SPEC_VERSION } from "../spec.js";
import type { ComplianceReport, TransportTarget } from "../types.js";
import { MODERN_FIXTURE, resultOf, runModern } from "./helpers/modern-fixture.js";

/**
 * The 2026-07-28 stdio-unicode check against a stdio child that exits on
 * its CJK/emoji probe -- a server that logs its input to a legacy code page
 * console, or decodes stdin with a codec that throws. The check fails as
 * the child dying on the probe, and the child is replaced before the check
 * returns (security.ts's restartStdioServer, the policy the security checks
 * and the 2025-11-25 stdio-unicode follow), with a warning naming the
 * check, so every later check measures the new instance instead of failing
 * on a dead one. Before: the child stayed dead, and stdio-unknown-method-
 * recovers, stdio-cancellation, the late lifecycle block and every security
 * check that sends a request failed against it under diagnoses of their own.
 *
 * The killers are real servers -- the SDK v2 stdio fixture, the modern
 * fixture, and a hand-rolled child with no tools (so the probe rides the
 * server/discover envelope) -- with a preload (`node --import data:...`)
 * that exits the process with code 3 on the first stdin byte outside ASCII.
 * Only stdio-unicode sends one. The preload runs in every instance the
 * suite spawns, so a replacement dies on the same probe too.
 */

const SDK2_STDIO_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "sdk2-stdio-server.mjs");

/** Exits (code 3) on the first stdin byte outside ASCII, before the server reads the line. */
const EXIT_ON_NON_ASCII = [
  'process.stdin.on("data", (c) => {',
  '  const b = typeof c === "string" ? Buffer.from(c, "utf8") : c;',
  "  if (b.some((x) => x > 0x7f)) process.exit(3);",
  "});",
].join("\n");

/**
 * Exits on the stdin line carrying `marker`, before the server reads it
 * (the preload's listener runs first).
 */
function exitOnMarker(marker: string): string {
  return [
    `const marker = ${JSON.stringify(marker)};`,
    'let tail = "";',
    'process.stdin.on("data", (c) => {',
    '  const s = tail + c.toString("utf8");',
    "  if (s.includes(marker)) process.exit(3);",
    "  tail = s.slice(-marker.length);",
    "});",
  ].join("\n");
}

function target(server: string, preload?: string): TransportTarget {
  const args = preload ? ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, server] : [server];
  return { type: "stdio", command: process.execPath, args };
}

const STDIO_IDS = ["stdio-framing", "stdio-unicode", "stdio-unknown-method-recovers", "stdio-cancellation"];

const failing = (report: ComplianceReport) => report.tests.filter((t) => !t.passed).map((t) => t.id);

const unicodeWarnings = (report: ComplianceReport) => report.warnings.filter((w) => w.startsWith("stdio-unicode"));

const restartWarnings = (report: ComplianceReport) => report.warnings.filter((w) => w.includes("restarted"));

const restartWarning = (cause: string) =>
  `stdio-unicode: the server exited on ${cause} and was restarted with a fresh server/discover, so the tests after it ran against the new instance.`;

const TOOL_PROBE = "tools/call echo with a CJK/emoji argument";
const ENVELOPE_PROBE = "server/discover with a CJK/emoji clientInfo name";

/** The two stdio checks after stdio-unicode, passing on a live process. */
const RECOVERS = "unknown method -> JSON-RPC error -32601; server/discover answered afterwards on the same process";
const CANCELLATION =
  "notifications/cancelled for unknown id 987654321 drew no reply; server/discover answered afterwards";

describe("2026-07-28 stdio-unicode: a child that exits on the probe is restarted", () => {
  it("SDK v2 (dual-era), full auto run: only stdio-unicode fails, every later check measures the new instance", async () => {
    const report = await runComplianceSuite(target(SDK2_STDIO_FIXTURE, EXIT_ON_NON_ASCII), {
      timeout: 5000,
      startupTimeout: 15_000,
    });
    expect(report.specVersion).toBe(MODERN_SPEC_VERSION);
    expect(report.serverInfo.name).toBe("sdk2-stdio-server");
    // Before: the child stayed dead, so the two stdio checks after it, the
    // late lifecycle block and the security checks failed against it.
    expect(failing(report)).toEqual(["stdio-unicode"]);
    expect(resultOf(report, "stdio-unicode").details).toBe(`${TOOL_PROBE} got no reply (server exited (code 3))`);
    expect(resultOf(report, "stdio-unknown-method-recovers").details).toBe(RECOVERS);
    expect(resultOf(report, "stdio-cancellation").details).toBe(CANCELLATION);
    // The replacement is pinned modern before the late block's claim-less
    // probes reach it: they draw -32602 from the modern instance.
    for (const id of ["lifecycle-meta-required", "lifecycle-meta-protocol-version-required"]) {
      expect(resultOf(report, id).details, id).toMatch(/-32602/);
    }
    // Both of rug-pull's lists come from the replacement: the one read at
    // the restart, before any tools/call, and one after a tools/call.
    expect(resultOf(report, "security-tool-rug-pull").details).toBe(
      "1 tool(s) consistent across 2 calls to the server restarted after stdio-unicode (before and after a tools/call)",
    );
    expect(unicodeWarnings(report)).toEqual([restartWarning(TOOL_PROBE)]);
    expect(restartWarnings(report)).toEqual([restartWarning(TOOL_PROBE)]);
    expect(report.grade).toBe("A");
  }, 120_000);

  it("the modern fixture: the later stdio checks and the security checks pass on the replacement", async () => {
    const report = await runModern(target(MODERN_FIXTURE, EXIT_ON_NON_ASCII), {
      only: [...STDIO_IDS, "security"],
    });
    expect(failing(report)).toEqual(["stdio-unicode"]);
    expect(resultOf(report, "stdio-unicode").details).toBe(`${TOOL_PROBE} got no reply (server exited (code 3))`);
    expect(resultOf(report, "stdio-framing").passed).toBe(true);
    expect(resultOf(report, "stdio-unknown-method-recovers").details).toBe(RECOVERS);
    expect(resultOf(report, "stdio-cancellation").details).toBe(CANCELLATION);
    // Before: "server unreachable: ..." against the dead process.
    expect(resultOf(report, "security-extra-params").details).toBe(
      "Server processed request (extra params likely ignored)",
    );
    expect(resultOf(report, "security-tool-rug-pull").details).toBe(
      "11 tool(s) consistent across 2 calls to the server restarted after stdio-unicode (before and after a tools/call)",
    );
    expect(restartWarnings(report)).toEqual([restartWarning(TOOL_PROBE)]);
  }, 90_000);

  it("--retries 1: a retry that kills the replacement restarts it again, so the checks after it measure a live server", async () => {
    const report = await runModern(target(MODERN_FIXTURE, EXIT_ON_NON_ASCII), {
      only: [...STDIO_IDS, "security-extra-params"],
      retries: 1,
    });
    // Both attempts killed a live process, the last one included.
    expect(resultOf(report, "stdio-unicode").details).toBe(`${TOOL_PROBE} got no reply (server exited (code 3))`);
    expect(failing(report)).toEqual(["stdio-unicode"]);
    expect(resultOf(report, "stdio-unknown-method-recovers").details).toBe(RECOVERS);
    expect(resultOf(report, "security-extra-params").details).toBe(
      "Server processed request (extra params likely ignored)",
    );
    // One warning however many attempts restarted it (identical warnings
    // collapse), and none saying the process was left dead.
    expect(unicodeWarnings(report)).toEqual([restartWarning(TOOL_PROBE)]);
    expect(report.warnings.filter((w) => /not restarted|exited process/.test(w))).toEqual([]);
  }, 90_000);

  it("a server already gone before the probe is unreachable there, and not restarted", async () => {
    // tools-call-unknown's tools/call kills the process, and that check
    // restarts nothing: stdio-unicode finds it gone. Before: "tools/call
    // echo with a CJK/emoji argument got no reply (server exited (code
    // 3))", a crash on the probe that the probe never caused.
    const report = await runModern(target(MODERN_FIXTURE, exitOnMarker("__nonexistent_tool_compliance_test__")), {
      only: ["tools-list", "tools-call-unknown", "stdio-unicode", "stdio-unknown-method-recovers"],
    });
    expect(resultOf(report, "tools-call-unknown").passed).toBe(false);
    expect(resultOf(report, "stdio-unicode").details).toMatch(
      new RegExp(
        `^server unreachable: ${TOOL_PROBE.replace(/\//g, "\\/")} got no response \\(connection closed: .*exit code 3`,
      ),
    );
    expect(resultOf(report, "stdio-unicode").details).toMatch(/^[\x20-\x7e]+$/);
    expect(resultOf(report, "stdio-unknown-method-recovers").details).toBe(
      "unknown method drew no response (server exited (code 3))",
    );
    expect(restartWarnings(report)).toEqual([]);
  }, 60_000);

  it("a server that exits on every tools/call: stdio-unicode and each security check after it restart it in turn", async () => {
    // Before: stdio-unicode left the child dead, so both security checks
    // were "server unreachable" against it and no warning said why.
    const report = await runModern(target(MODERN_FIXTURE, exitOnMarker('"method":"tools/call"')), {
      only: ["stdio-unicode", "security-oversized-input", "security-extra-params"],
    });
    expect(resultOf(report, "stdio-unicode").details).toBe(`${TOOL_PROBE} got no reply (server exited (code 3))`);
    // Each found a live process -- the replacement the check before it
    // started -- and killed it.
    expect(resultOf(report, "security-oversized-input").details).toMatch(
      /^server died on a 1 MB echo\.message: .*exit code 3/,
    );
    expect(resultOf(report, "security-extra-params").details).toMatch(
      /^server died on unknown tool arguments \(tools\/call echo\): .*exit code 3/,
    );
    const warned = restartWarnings(report);
    expect(warned.map((w) => w.slice(0, w.indexOf(":")))).toEqual([
      "stdio-unicode",
      "security-oversized-input",
      "security-extra-params",
    ]);
    expect(warned[0]).toBe(restartWarning(TOOL_PROBE));
  }, 60_000);

  it("a conformant server is never restarted: the probe round-trips and no warning mentions a restart", async () => {
    const report = await runModern(target(MODERN_FIXTURE), { only: [...STDIO_IDS, "security-tool-rug-pull"] });
    expect(failing(report)).toEqual([]);
    expect(resultOf(report, "stdio-unicode").details).toBe(
      "tools/call echo reproduced the CJK/emoji probe byte-for-byte",
    );
    // No replacement: rug-pull compares the cached list with a second one, as before.
    expect(resultOf(report, "security-tool-rug-pull").details).toBe("11 tool(s) consistent across 2 calls");
    expect(restartWarnings(report)).toEqual([]);
  }, 60_000);
});

/**
 * A stdio server with no tools capability, so stdio-unicode's probe rides
 * the server/discover envelope: it answers server/discover with a
 * DiscoverResult and every other request -32601, never answers a
 * notification, and, with EXIT set, exits with code 3 on any stdin line
 * carrying a non-ASCII character.
 */
const NO_TOOLS_SERVER = `
import { createInterface } from "node:readline";
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const discover = {
  resultType: "complete",
  supportedVersions: [${JSON.stringify(MODERN_SPEC_VERSION)}],
  capabilities: {},
  serverInfo: { name: "no-tools-stdio", version: "1.0.0" },
  ttlMs: 1000,
  cacheScope: "public",
};
const rl = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
rl.on("line", (line) => {
  if (process.env.EXIT && /[^\\x00-\\x7f]/.test(line)) process.exit(3);
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return;
  if (msg.method === "server/discover") return send({ jsonrpc: "2.0", id: msg.id, result: discover });
  send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
});
rl.on("close", () => process.exit(0));
`;

describe("2026-07-28 stdio-unicode: a child that exits on the envelope probe is restarted", () => {
  let dir: string;
  let script: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "mcp-modern-unicode-"));
    script = join(dir, "server.mjs");
    writeFileSync(script, NO_TOOLS_SERVER);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (env: Record<string, string>) =>
    runModern({ type: "stdio", command: process.execPath, args: [script], env }, { only: STDIO_IDS });

  it("the discover carrying the probe kills it: stdio-unicode fails, the two checks after it pass on the replacement", async () => {
    const report = await run({ EXIT: "1" });
    expect(resultOf(report, "stdio-unicode").details).toBe(`${ENVELOPE_PROBE} got no reply (server exited (code 3))`);
    expect(failing(report)).toEqual(["stdio-unicode"]);
    // Before: "unknown method drew no response (server exited (code 3))"
    // and "could not write notifications/cancelled (...)".
    expect(resultOf(report, "stdio-unknown-method-recovers").details).toBe(RECOVERS);
    expect(resultOf(report, "stdio-cancellation").details).toBe(CANCELLATION);
    expect(unicodeWarnings(report)).toEqual([restartWarning(ENVELOPE_PROBE)]);
  }, 60_000);

  it("the same server without the crash passes all four and is never restarted", async () => {
    const report = await run({});
    expect(failing(report)).toEqual([]);
    expect(resultOf(report, "stdio-unicode").details).toBe(
      "envelope round-trip verified: server/discover accepted a request whose clientInfo name carries CJK/emoji (no echo path to compare byte-for-byte)",
    );
    expect(restartWarnings(report)).toEqual([]);
  }, 60_000);
});
