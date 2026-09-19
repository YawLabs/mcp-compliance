import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ComplianceReport, TransportTarget } from "../types.js";
import { resultOf, runModern } from "./helpers/modern-fixture.js";

/**
 * 2026-07-28 lifecycle-progress-token over stdio after review 82 (item 5):
 * a child that ANSWERS a call and exits right after it. Before, only a
 * call that got no answer was checked for an exit, so such a child either
 * passed the check that killed it and was left dead for every later check
 * (no warning), or -- when the exit landed after the next call was written
 * -- that next call (the one without the token, or the resend) was recorded
 * as the exit's cause and blamed in the details and the warning, although
 * it never reached the process. Now every answered call is followed by one
 * server/discover (checkLiveness, liveness.ts), and a call the server
 * failed by a bounded wait for the child's exit before it (EXIT_GRACE_MS,
 * 250 ms): a child found gone makes that call a dropped one, charged to it
 * ("server exited (after answering it, ...)"), and is replaced before the
 * next call; a child that stops answering is named in a warning.
 *
 * Review 82a: a child that exits a few ms AFTER answering a failure (5 or
 * 30 ms, an async crash) outran the one server/discover, so the exit still
 * landed on the call without the token, on the resend, or on the next
 * check; the bounded wait after a failure answer now catches it. A served
 * call pays no wait (a healthy server pays nothing), so a child that serves
 * the call and exits a moment later is still not seen by this check.
 */

const PROGRESS = "lifecycle-progress-token";
const TOKEN = "compliance-progress-1";
const NONE = "no notifications/progress observed (optional)";
const AFTER_ANSWER = "server exited (after answering it, exit code 3: Error: progress timer fired after the reply)";
/** The failure once the token is blamed, the resent call answering as the first did. */
const blamedAgain = (answer: string) =>
  `FAIL: tools/call count with _meta.progressToken: ${answer}, and again when resent; without it: served -- so the token is what failed it`;
const restarted = (cause: string) =>
  `${PROGRESS}: the server exited on tools/call count ${cause} and was restarted with a fresh server/discover, so the tests after it ran against the new instance.`;

/** "PASS: ..." / "FAIL: ..." with " (skipped)" when the pass measured nothing. */
function verdictOf(report: ComplianceReport, id: string): string {
  const t = resultOf(report, id);
  return `${t.passed ? "PASS" : "FAIL"}${t.skipped ? " (skipped)" : ""}: ${t.details}`;
}

/**
 * A 2026-07-28 stdio server declaring tools with one no-argument `count`
 * tool. PROGRESS_MODE picks how tools/call is answered: served (default);
 * served, then exit 3 right after the reply is written, when the call
 * carries a progressToken (`answer-then-exit-with-token`); -32603 then exit 3
 * the same way, only with a token (`error-then-exit-with-token`); -32603 then
 * exit 3 on each process's first tools/call whatever it carries
 * (`cold-exit-any`); served, then silent for good while still running,
 * with a token (`wedge-after-token`). With EXIT_DELAY_MS set, an exit
 * after an answer comes that many ms after the reply is written (an async
 * crash) instead of right after it. A server/discover without `_meta`
 * protocolVersion is rejected with -32602, so lifecycle-meta-required
 * passes on a live process. PROGRESS_LOG names a file each tools/call
 * appends the token it carried to ("-" for none), with the process id.
 */
const STDIO_SERVER_SRC = `"use strict";
const fs = require("node:fs");
const readline = require("node:readline");
const mode = process.env.PROGRESS_MODE || "serve";
let calls = 0;
let wedged = false;
const crash = () => { fs.writeSync(2, "Error: progress timer fired after the reply\\n"); process.exit(3); };
const delay = Number(process.env.EXIT_DELAY_MS || 0);
const exitNow = delay > 0 ? () => setTimeout(crash, delay) : crash;
const out = (m, after) => { if (!wedged) process.stdout.write(JSON.stringify(m) + "\\n", after); };
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg || msg.id === undefined) return;
  const result = (r, after) => out({ jsonrpc: "2.0", id: msg.id, result: Object.assign({ resultType: "complete" }, r) }, after);
  const error = (code, message, after) => out({ jsonrpc: "2.0", id: msg.id, error: { code, message } }, after);
  if (msg.method === "server/discover") {
    const claim = msg.params && msg.params._meta && msg.params._meta["io.modelcontextprotocol/protocolVersion"];
    if (!claim) return error(-32602, "Invalid params: _meta protocolVersion is required");
    return result({ supportedVersions: ["2026-07-28"], capabilities: { tools: {} }, ttlMs: 0, cacheScope: "public",
      _meta: { "io.modelcontextprotocol/serverInfo": { name: "progress-stdio", version: "0" } } });
  }
  if (msg.method === "tools/list") {
    return result({ tools: [{ name: "count", description: "Counts to two", inputSchema: { type: "object" } }],
      ttlMs: 0, cacheScope: "public" });
  }
  if (msg.method === "tools/call") {
    calls++;
    const meta = msg.params && msg.params._meta;
    const token = meta ? meta.progressToken : undefined;
    if (process.env.PROGRESS_LOG) fs.appendFileSync(process.env.PROGRESS_LOG, (token === undefined ? "-" : String(token)) + " " + process.pid + "\\n");
    const served = { content: [{ type: "text", text: "2" }] };
    if (mode === "answer-then-exit-with-token" && token !== undefined) return result(served, exitNow);
    if (mode === "error-then-exit-with-token" && token !== undefined) return error(-32603, "Internal error", exitNow);
    if (mode === "cold-exit-any" && calls === 1) return error(-32603, "backend thread died", exitNow);
    if (mode === "wedge-after-token" && token !== undefined) { result(served); wedged = true; return; }
    return result(served);
  }
  error(-32601, "Method not found: " + msg.method);
});
process.stdin.on("end", () => process.exit(0));
`;

const stdio = { dir: "", script: "" };

beforeAll(() => {
  stdio.dir = mkdtempSync(join(tmpdir(), "mcp-r82-progress-"));
  stdio.script = join(stdio.dir, "progress-server.cjs");
  writeFileSync(stdio.script, STDIO_SERVER_SRC);
});

afterAll(() => {
  rmSync(stdio.dir, { recursive: true, force: true });
});

let logSeq = 0;

/**
 * One run against the stdio server in `mode`: the verdict, the tokens the
 * calls carried, the process each call reached, the warnings, the report.
 */
async function run(mode: string, only: string[] = [PROGRESS], opts: { exitDelayMs?: number; timeout?: number } = {}) {
  const log = join(stdio.dir, `calls-${++logSeq}.log`);
  writeFileSync(log, "");
  const target: TransportTarget = {
    type: "stdio",
    command: process.execPath,
    args: [stdio.script],
    env: { PROGRESS_MODE: mode, PROGRESS_LOG: log, EXIT_DELAY_MS: String(opts.exitDelayMs ?? 0) },
  };
  const report = await runModern(target, { only, ...(opts.timeout ? { timeout: opts.timeout } : {}) });
  const details = resultOf(report, PROGRESS).details;
  expect(details, details).toMatch(/^[\x20-\x7e]+$/);
  expect(details.length, details).toBeLessThanOrEqual(220);
  const lines = readFileSync(log, "utf8").split("\n").filter(Boolean);
  const calls = lines.map((l) => l.split(" ")[0]);
  const pids = lines.map((l) => l.split(" ")[1]);
  const progressWarnings = report.warnings.filter((w) => w.startsWith(`${PROGRESS}:`));
  return { verdict: verdictOf(report, PROGRESS), calls, pids, progressWarnings, report };
}

describe("2026-07-28 lifecycle-progress-token over stdio: a child that exits right after answering", () => {
  it("a served call carrying the token, then an exit: the exit is charged to that call, reproduced, and the child restarted (before: PASS, left dead)", async () => {
    // Before: PASS "tools/call count succeeded; no notifications/progress
    // observed (optional)", no warning, and lifecycle-meta-required FAILED
    // "no response (server crashed with exit code 3 ...)".
    const { verdict, calls, pids, progressWarnings, report } = await run("answer-then-exit-with-token", [
      PROGRESS,
      "lifecycle-meta-required",
    ]);
    expect(verdict).toBe(blamedAgain(AFTER_ANSWER));
    expect(calls).toEqual([TOKEN, "-", TOKEN]);
    // The call without the token reached the replacement, and the resent call the same process.
    expect(pids[1]).not.toBe(pids[0]);
    expect(pids[2]).toBe(pids[1]);
    // Only the calls carrying the token are blamed (the identical warnings collapse).
    expect(progressWarnings).toEqual([restarted("carrying _meta.progressToken")]);
    expect(verdictOf(report, "lifecycle-meta-required")).toMatch(
      /^PASS: server\/discover without _meta: rejected with -32602/,
    );
  }, 60_000);

  it("an error on the call carrying the token, then an exit: never charged to the call without it (before: blamed on it, or on a resend that never arrived)", async () => {
    const { verdict, calls, progressWarnings } = await run("error-then-exit-with-token");
    expect(verdict).toBe(blamedAgain(AFTER_ANSWER));
    expect(calls).toEqual([TOKEN, "-", TOKEN]);
    expect(progressWarnings).toEqual([restarted("carrying _meta.progressToken")]);
    expect(progressWarnings.join("\n")).not.toContain("without _meta.progressToken");
  }, 60_000);

  it("a process that fails and exits on its first call whatever it carries: not evaluable, never blamed on the token (before: sometimes FAIL)", async () => {
    const { verdict, calls, pids, progressWarnings } = await run("cold-exit-any");
    // Each call killed the process it reached, and each is charged with its own exit.
    expect(verdict).toBe(
      `PASS (skipped): tools/call count with _meta.progressToken: server exited; without it: server exited -- not evaluable; ${NONE}`,
    );
    expect(calls).toEqual([TOKEN, "-"]);
    expect(pids[1]).not.toBe(pids[0]);
    expect(progressWarnings).toEqual([
      restarted("carrying _meta.progressToken"),
      restarted("without _meta.progressToken"),
    ]);
  }, 60_000);
});

describe("2026-07-28 lifecycle-progress-token over stdio: a child that exits a few ms after answering a failure (review 82a)", () => {
  for (const exitDelayMs of [5, 30]) {
    it(`an error on the call carrying the token, then an exit ${exitDelayMs} ms later: charged to that call, and the call without the token reaches a new process (before: it reached the dying one)`, async () => {
      // Before: the follow-up server/discover was answered before the exit,
      // so the call without the token was written to the dying process (the
      // same pid) and the resend, or the next check, took the exit.
      const { verdict, calls, pids, progressWarnings, report } = await run(
        "error-then-exit-with-token",
        [PROGRESS, "lifecycle-meta-required"],
        { exitDelayMs },
      );
      expect(verdict).toBe(blamedAgain(AFTER_ANSWER));
      expect(calls).toEqual([TOKEN, "-", TOKEN]);
      expect(pids[1]).not.toBe(pids[0]);
      expect(pids[2]).toBe(pids[1]);
      expect(progressWarnings).toEqual([restarted("carrying _meta.progressToken")]);
      expect(verdictOf(report, "lifecycle-meta-required")).toMatch(
        /^PASS: server\/discover without _meta: rejected with -32602/,
      );
    }, 60_000);

    it(`a process that fails its first call whatever it carries and exits ${exitDelayMs} ms later: never blamed on the token (before: a FAIL or a pass on a dying process)`, async () => {
      const { verdict, calls, pids, progressWarnings } = await run("cold-exit-any", [PROGRESS], { exitDelayMs });
      expect(verdict).toBe(
        `PASS (skipped): tools/call count with _meta.progressToken: server exited; without it: server exited -- not evaluable; ${NONE}`,
      );
      expect(calls).toEqual([TOKEN, "-"]);
      expect(pids[1]).not.toBe(pids[0]);
      expect(progressWarnings).toEqual([
        restarted("carrying _meta.progressToken"),
        restarted("without _meta.progressToken"),
      ]);
    }, 60_000);
  }
});

describe("2026-07-28 lifecycle-progress-token over stdio: a child that stops answering after the call", () => {
  it("the served call stands, and a warning names it (before: nothing said why the checks after it hang)", async () => {
    const { verdict, calls, progressWarnings, report } = await run("wedge-after-token", [PROGRESS], {
      timeout: 2000,
    });
    expect(verdict).toBe(`PASS: tools/call count succeeded; ${NONE}`);
    expect(calls).toEqual([TOKEN]);
    expect(progressWarnings).toEqual([
      `${PROGRESS}: the server stopped answering right after tools/call count carrying _meta.progressToken was answered (no reply to server/discover within 2000ms); it was not restarted, so the tests after it may fail on the same hang.`,
    ]);
    // Silent for the whole per-request budget (review 82a: a slow server is
    // no hang, so the follow-up discover gets --timeout like any request).
    expect(resultOf(report, PROGRESS).durationMs).toBeGreaterThanOrEqual(1900);
  }, 60_000);
});

describe("2026-07-28 lifecycle-progress-token over stdio: a healthy server keeps its verdict", () => {
  it("a served call passes after exactly one call, with no warning", async () => {
    const { verdict, calls, pids, progressWarnings, report } = await run("serve", [
      PROGRESS,
      "lifecycle-meta-required",
    ]);
    expect(verdict).toBe(`PASS: tools/call count succeeded; ${NONE}`);
    expect(calls).toEqual([TOKEN]);
    expect(pids).toHaveLength(1);
    expect(progressWarnings).toEqual([]);
    expect(report.warnings.filter((w) => /restarted|stopped answering/.test(w))).toEqual([]);
    // No wait: the served call is followed by one server/discover and nothing else.
    expect(resultOf(report, PROGRESS).durationMs).toBeLessThan(1000);
    expect(verdictOf(report, "lifecycle-meta-required")).toMatch(/^PASS: /);
  }, 30_000);
});
