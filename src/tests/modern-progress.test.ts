import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { ComplianceReport, TransportTarget } from "../types.js";
import { resultOf, runModern } from "./helpers/modern-fixture.js";

/**
 * The 2026-07-28 lifecycle-progress-token (src/suites/modern/lifecycle.ts)
 * reads a failed call the way the 2025-11-25 check does (runner.ts): a
 * server error on the tools/call carrying `_meta.progressToken` is blamed
 * on the token only once it is reproduced -- the same call without the
 * token, sent right after, is served, and the call carrying it, resent,
 * fails again. Before, the check could not fail on a server error at all:
 * any answer to the call passed as "no notifications/progress observed
 * (optional)", a server that fails every request carrying a progress token
 * included. A connection closed, or a stdio child that exits, on the call
 * carrying the token is read the same way (a drop is a refusal only next to
 * a served twin), and the child is restarted after each exit. A 429 on any
 * call is resent once; a gate's answer or no answer on any of the calls
 * measured nothing (a skip, never a scored pass). Conformant servers keep
 * their verdicts: the SDK v2 reference server over HTTP and stdio is pinned
 * at the end (the modern fixture's three progress notifications are pinned
 * in modern-lifecycle.test.ts).
 */

const PROGRESS = "lifecycle-progress-token";
const TOKEN = "compliance-progress-1";
const NONE = "no notifications/progress observed (optional)";
/** The tail of the failure once the token is blamed. */
const BLAMED =
  "while the same call without it, sent in between, was served -- the server failed the request because of its progress token (basic/patterns/progress lets a server ignore the token and send no notifications, not fail the request)";

/** "PASS: ..." / "FAIL: ..." with " (skipped)" when the pass measured nothing. */
function verdictOf(report: ComplianceReport, id: string): string {
  const t = resultOf(report, id);
  return `${t.passed ? "PASS" : "FAIL"}${t.skipped ? " (skipped)" : ""}: ${t.details}`;
}

// ---------------------------------------------------------------------------
// A 2026-07-28 HTTP server whose answer to tools/call is a knob
// ---------------------------------------------------------------------------

/**
 * How tools/call is answered: served by default.
 * - `own-error-with-token`: -32602 on HTTP 200, only when the call carries a progressToken;
 * - `500-with-token`: -32603 on HTTP 500, only then;
 * - `bare-403-with-token`: a bare 403 (no WWW-Authenticate), only then (a WAF that blocks the key);
 * - `500-always`: -32603 on HTTP 500 whatever the call carries;
 * - `cold`: the first tools/call, whatever it carries, answers -32603 on HTTP 200 (a backend warming up);
 * - `cold-then-hang`: `cold`, and the third call (the resent one) is never answered;
 * - 429 / 401: a rate limiter's 429, or an auth gate's 401 with a Bearer challenge, on the call carrying the token;
 * - `hang-with-token` / `drop-with-token`: the call carrying the token is never answered / its connection is closed;
 * - `429-once-then-reject-token`: the first tools/call is answered 429 (a limiter), and every call carrying the token -32602;
 * - `reject-token-429-twin`: -32602 on every call carrying the token, and 429 on every call without it;
 * - `reject-token-429-twin-once`: -32602 on every call carrying the token, and 429 on the second tools/call only;
 * - `reject-token-hang-twin`: -32602 on every call carrying the token, and the call without it never answered;
 * - `reject-token-429-resend`: -32602 on the first call, the second (without the token) served, 429 from the third on.
 */
type CallMode =
  | "serve"
  | "own-error-with-token"
  | "500-with-token"
  | "bare-403-with-token"
  | "500-always"
  | "cold"
  | "cold-then-hang"
  | 429
  | 401
  | "hang-with-token"
  | "drop-with-token"
  | "429-once-then-reject-token"
  | "reject-token-429-twin"
  | "reject-token-429-twin-once"
  | "reject-token-hang-twin"
  | "reject-token-429-resend";

interface StubOptions {
  call?: CallMode;
  /** notifications/progress params streamed (SSE) ahead of the result of a served call carrying a token. */
  progress?: Array<Record<string, unknown>>;
}

async function startStub(opts: StubOptions): Promise<{ url: string; calls: unknown[]; close(): Promise<void> }> {
  /** The progressToken each tools/call carried (undefined for none), in order. */
  const calls: unknown[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let text = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      text += chunk;
    });
    req.on("end", () => {
      let msg: Record<string, any> = {};
      try {
        msg = JSON.parse(text);
      } catch {}
      if (msg.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "Content-Type": "application/json", ...headers });
        res.end(JSON.stringify(body));
      };
      const result = (r: Record<string, unknown>) => json(200, { jsonrpc: "2.0", id: msg.id, result: r });
      const rpcError = (status: number, code: number, message: string, headers?: Record<string, string>) =>
        json(status, { jsonrpc: "2.0", id: msg.id, error: { code, message } }, headers);
      switch (msg.method) {
        case "server/discover":
          return result({
            resultType: "complete",
            supportedVersions: ["2026-07-28"],
            capabilities: { tools: {} },
            ttlMs: 0,
            cacheScope: "public",
            _meta: { "io.modelcontextprotocol/serverInfo": { name: "progress-stub", version: "0" } },
          });
        case "tools/list":
          return result({
            resultType: "complete",
            tools: [{ name: "count", description: "Counts to two", inputSchema: { type: "object" } }],
            ttlMs: 0,
            cacheScope: "public",
          });
        case "tools/call": {
          const token = msg.params?._meta?.progressToken;
          calls.push(token);
          const carries = token !== undefined;
          const n = calls.length;
          const throttle = () => {
            res.writeHead(429, { "Content-Type": "text/plain", "Retry-After": "0" });
            res.end("Too Many Requests");
          };
          const rejectToken = () => rpcError(200, -32602, "Invalid params: unrecognized key 'progressToken' in _meta");
          switch (opts.call) {
            case "own-error-with-token":
              if (carries) return rpcError(200, -32602, "Invalid params: unrecognized key 'progressToken' in _meta");
              break;
            case "500-with-token":
              if (carries) return rpcError(500, -32603, "Internal error");
              break;
            case "bare-403-with-token":
              if (carries) return rpcError(403, -32000, "Forbidden");
              break;
            case "500-always":
              return rpcError(500, -32603, "Internal error");
            case "cold":
              if (calls.length === 1) return rpcError(200, -32603, "backend warming up, retry");
              break;
            case "cold-then-hang":
              if (calls.length === 1) return rpcError(200, -32603, "backend warming up, retry");
              if (calls.length === 3) return;
              break;
            case 429:
              if (carries) {
                res.writeHead(429, { "Content-Type": "text/plain", "Retry-After": "0" });
                res.end("Too Many Requests");
                return;
              }
              break;
            case 401:
              if (carries) {
                return rpcError(401, -32001, "Unauthorized", {
                  "WWW-Authenticate": 'Bearer error="invalid_token"',
                });
              }
              break;
            case "hang-with-token":
              if (carries) return;
              break;
            case "drop-with-token":
              if (carries) return req.socket.destroy();
              break;
            case "429-once-then-reject-token":
              if (n === 1) return throttle();
              if (carries) return rejectToken();
              break;
            case "reject-token-429-twin":
              if (carries) return rejectToken();
              return throttle();
            case "reject-token-429-twin-once":
              if (n === 2) return throttle();
              if (carries) return rejectToken();
              break;
            case "reject-token-hang-twin":
              if (carries) return rejectToken();
              return;
            case "reject-token-429-resend":
              if (n >= 3) return throttle();
              if (carries) return rejectToken();
              break;
          }
          const answer = {
            jsonrpc: "2.0",
            id: msg.id,
            result: { resultType: "complete", content: [{ type: "text", text: "2" }] },
          };
          if (carries && opts.progress) {
            const frames = [
              ...opts.progress.map((params) => ({ jsonrpc: "2.0", method: "notifications/progress", params })),
              answer,
            ];
            res.writeHead(200, { "Content-Type": "text/event-stream" });
            res.end(frames.map((m) => `event: message\ndata: ${JSON.stringify(m)}\n\n`).join(""));
            return;
          }
          return json(200, answer);
        }
      }
      return rpcError(404, -32601, `Method not found: ${String(msg.method)}`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** One `--only lifecycle-progress-token` run against a stub: the verdict, the tokens the calls carried, the warnings. */
async function runStub(
  opts: StubOptions,
  runOpts: { timeout?: number } = {},
): Promise<{ verdict: string; calls: unknown[]; warnings: string[] }> {
  const stub = await startStub(opts);
  try {
    const report = await runModern(stub.url, { only: [PROGRESS], ...runOpts });
    return { verdict: verdictOf(report, PROGRESS), calls: [...stub.calls], warnings: report.warnings };
  } finally {
    await stub.close();
  }
}

describe("2026-07-28 lifecycle-progress-token over HTTP: a server error is blamed on the token only once reproduced", () => {
  it("a JSON-RPC error only on the call carrying the token FAILS: the same call without it was served, and the resent call failed again", async () => {
    // Before: PASS "tools/call count returned JSON-RPC error -32602 (Invalid
    // params: ...); no notifications/progress observed (optional)", one call.
    const { verdict, calls } = await runStub({ call: "own-error-with-token" });
    expect(verdict).toBe(
      `FAIL: tools/call count carrying _meta.progressToken returned JSON-RPC error -32602 (Invalid params: unrecognized key 'progressToken' in _meta) (HTTP 200), and JSON-RPC error -32602 (Invalid params: unrecognized key 'progressToken' in _meta) (HTTP 200) when it was resent, ${BLAMED}`,
    );
    // The call with the token, the same call without it, then the call with
    // the token once more: the failure is reproduced before it is blamed.
    expect(calls).toEqual([TOKEN, undefined, TOKEN]);
  }, 20_000);

  it("an HTTP 500, or a bare 403, only on the call carrying the token FAILS the same way", async () => {
    // Before: PASS "tools/call count returned JSON-RPC error -32603 (Internal
    // error); ..." and "... returned JSON-RPC error -32000 (Forbidden); ...".
    const on500 = await runStub({ call: "500-with-token" });
    expect(on500.verdict).toBe(
      `FAIL: tools/call count carrying _meta.progressToken returned JSON-RPC error -32603 (Internal error) (HTTP 500), and JSON-RPC error -32603 (Internal error) (HTTP 500) when it was resent, ${BLAMED}`,
    );
    expect(on500.calls).toEqual([TOKEN, undefined, TOKEN]);
    // A 403 without a Bearer challenge is no auth gate: the call without the
    // token, with the same headers, got past whatever answered it.
    const on403 = await runStub({ call: "bare-403-with-token" });
    expect(on403.verdict).toBe(
      `FAIL: tools/call count carrying _meta.progressToken returned JSON-RPC error -32000 (Forbidden) (HTTP 403), and JSON-RPC error -32000 (Forbidden) (HTTP 403) when it was resent, ${BLAMED}`,
    );
    expect(on403.calls).toEqual([TOKEN, undefined, TOKEN]);
  }, 30_000);

  it("a tool whose first call fails whatever it carries (a cold backend) passes on the resent call", async () => {
    // Before: PASS "tools/call count returned JSON-RPC error -32603 (backend
    // warming up, retry); no notifications/progress observed (optional)", one call.
    const { verdict, calls } = await runStub({ call: "cold" });
    expect(verdict).toBe(
      `PASS: tools/call count succeeded when resent: it first returned JSON-RPC error -32603 (backend warming up, retry) (HTTP 200), then the same call without the token and the resent one were served; ${NONE}`,
    );
    expect(calls).toEqual([TOKEN, undefined, TOKEN]);
  }, 20_000);

  it("the resent call's progress is judged like the first's", async () => {
    // Before: PASS "tools/call count returned JSON-RPC error -32603 (...); no
    // notifications/progress observed (optional)" for both: the first call
    // failed before any progress, and nothing else was sent.
    const foreign = await runStub({ call: "cold", progress: [{ progressToken: "someone-else", progress: 1 }] });
    expect(foreign.verdict).toBe(
      `FAIL: notifications/progress carries token "someone-else", expected "${TOKEN}" (tools/call count succeeded when resent)`,
    );
    const echoed = await runStub({ call: "cold", progress: [{ progressToken: TOKEN, progress: 1, total: 1 }] });
    expect(echoed.verdict).toBe(`PASS: 1 notifications/progress echoed token "${TOKEN}" with increasing progress (1)`);
  }, 30_000);

  it("a failure the server's own answer to the call without the token shares stays an observation", async () => {
    // Before: PASS "tools/call count returned JSON-RPC error -32603 (Internal
    // error); no notifications/progress observed (optional)", one call.
    const always = await runStub({ call: "500-always" });
    expect(always.verdict).toBe(
      `PASS: tools/call count returned JSON-RPC error -32603 (Internal error) (HTTP 500), and the same call without the token was not served either (JSON-RPC error -32603 (Internal error) (HTTP 500)), so the progress token is not what failed it; ${NONE}`,
    );
    expect(always.calls).toEqual([TOKEN, undefined]);
  }, 30_000);

  it("a rate limiter's 429 is resent once: throttled again, or an auth gate's 401, measured nothing -- a skip, not a scored pass", async () => {
    // Before: PASS "tools/call count answered HTTP 429 (rate limiting); ..."
    // and PASS "tools/call count answered HTTP 401 (an auth gate); ...", both
    // scored, and the 429 never resent.
    const throttled = await runStub({ call: 429 });
    expect(throttled.verdict).toBe(
      `PASS (skipped): tools/call count with progressToken answered HTTP 429, then after 0ms HTTP 429 (rate limiting); not evaluable: it was answered before the server read the request, so it proves nothing about the progress token; ${NONE}`,
    );
    expect(throttled.calls).toEqual([TOKEN, TOKEN]);
    const gated = await runStub({ call: 401 });
    expect(gated.verdict).toBe(
      `PASS (skipped): tools/call count with progressToken answered HTTP 401 (an auth gate); not evaluable: it was answered before the server read the request, so it proves nothing about the progress token; ${NONE}`,
    );
    expect(gated.calls).toEqual([TOKEN]);
  }, 30_000);

  it("a 429 on the first call that hid a server failing every token: the resend reaches it, and the token is blamed (before: PASS)", async () => {
    // Before: PASS "tools/call count answered HTTP 429 (rate limiting); ...",
    // one call, though every call carrying the token that reached the server
    // failed.
    const { verdict, calls } = await runStub({ call: "429-once-then-reject-token" });
    expect(verdict).toBe(
      `FAIL: tools/call count carrying _meta.progressToken returned JSON-RPC error -32602 (Invalid params: unrecognized key 'progressToken' in _meta) (HTTP 429, then after 0ms HTTP 200), and JSON-RPC error -32602 (Invalid params: unrecognized key 'progressToken' in _meta) (HTTP 200) when it was resent, ${BLAMED}`,
    );
    expect(calls).toEqual([TOKEN, TOKEN, undefined, TOKEN]);
  }, 20_000);

  it("a gate's answer, or none, on the call without the token clears nothing: a skip (before: a scored pass)", async () => {
    // Before: PASS "... and the same call without the token was not served
    // either (HTTP 429 with no JSON-RPC response), so the progress token is
    // not what failed it; ..." and PASS "... got no response within 1500ms,
    // so the progress token is not what failed it; ...".
    const rejected =
      "returned JSON-RPC error -32602 (Invalid params: unrecognized key 'progressToken' in _meta) (HTTP 200)";
    const unclear =
      "so no answer of the server's own tells whether the progress token is what failed it (not evaluable)";
    const limited = await runStub({ call: "reject-token-429-twin" });
    expect(limited.verdict).toBe(
      `PASS (skipped): tools/call count ${rejected}, but the same call without the token answered HTTP 429, then after 0ms HTTP 429 (rate limiting), ${unclear}; ${NONE}`,
    );
    expect(limited.calls).toEqual([TOKEN, undefined, undefined]);
    const hung = await runStub({ call: "reject-token-hang-twin" }, { timeout: 1500 });
    expect(hung.verdict).toBe(
      `PASS (skipped): tools/call count ${rejected}, but the same call without the token got no response within 1500ms, ${unclear}; ${NONE}`,
    );
    expect(hung.calls).toEqual([TOKEN, undefined]);
    // A 429 once on the call without the token: resent, served, and the token blamed.
    const once = await runStub({ call: "reject-token-429-twin-once" });
    expect(once.verdict).toBe(
      `FAIL: tools/call count carrying _meta.progressToken ${rejected}, and JSON-RPC error -32602 (Invalid params: unrecognized key 'progressToken' in _meta) (HTTP 200) when it was resent, ${BLAMED}`,
    );
    expect(once.calls).toEqual([TOKEN, undefined, undefined, TOKEN]);
  }, 30_000);

  it("a gate's answer, or none, on the resent call reproduces nothing: a skip (before: a scored pass)", async () => {
    // Before: PASS "... but resent, the call carrying it answered HTTP 429
    // (rate limiting), so the failure was not reproduced; ..." and PASS "...
    // got no response within 1500ms, so the failure was not reproduced; ...".
    const limited = await runStub({ call: "reject-token-429-resend" });
    expect(limited.verdict).toBe(
      `PASS (skipped): tools/call count returned JSON-RPC error -32602 (Invalid params: unrecognized key 'progressToken' in _meta) (HTTP 200); the same call without the token was served, but resent, the call carrying it answered HTTP 429, then after 0ms HTTP 429 (rate limiting), so the failure could not be reproduced (not evaluable); ${NONE}`,
    );
    expect(limited.calls).toEqual([TOKEN, undefined, TOKEN, TOKEN]);
    const flaky = await runStub({ call: "cold-then-hang" }, { timeout: 1500 });
    expect(flaky.verdict).toBe(
      `PASS (skipped): tools/call count returned JSON-RPC error -32603 (backend warming up, retry) (HTTP 200); the same call without the token was served, but resent, the call carrying it got no response within 1500ms, so the failure could not be reproduced (not evaluable); ${NONE}`,
    );
    expect(flaky.calls).toEqual([TOKEN, undefined, TOKEN]);
  }, 30_000);

  it("a call nothing answers measured nothing: a skip, and no other call is sent", async () => {
    // Before: FAIL "tools/call count with progressToken: no response (...)".
    const hung = await runStub({ call: "hang-with-token" }, { timeout: 1500 });
    expect(hung.verdict).toBe(
      `PASS (skipped): tools/call count with progressToken got no response within 1500ms; ${NONE}`,
    );
    expect(hung.calls).toEqual([TOKEN]);
  }, 30_000);

  it("a connection closed on every call carrying the token, next to the same call served without it, FAILS (before: a skip)", async () => {
    // Before: PASS (skipped) "tools/call count with progressToken got no
    // response (connection closed: ...); ...", and the call without the
    // token was never sent.
    const dropped = await runStub({ call: "drop-with-token" });
    expect(dropped.verdict).toMatch(
      /^FAIL: tools\/call count carrying _meta\.progressToken got no response \(connection closed: [^)]+\), and got no response \(connection closed: [^)]+\) when it was resent, while the same call without it, sent in between, was served -- the server failed the request because of its progress token /,
    );
    expect(dropped.calls).toEqual([TOKEN, undefined, TOKEN]);
  }, 30_000);

  it("a caller's abort while the call is pending is rethrown at once, never graded", async () => {
    const stub = await startStub({ call: "hang-with-token" });
    const controller = new AbortController();
    const reason = new Error("client went away");
    const graded: string[] = [];
    try {
      const started = Date.now();
      const run = runModern(stub.url, {
        only: [PROGRESS],
        timeout: 10_000,
        signal: controller.signal,
        onTestComplete: (t) => graded.push(`${t.id}: ${t.details}`),
      });
      setTimeout(() => controller.abort(reason), 400);
      await expect(run).rejects.toBe(reason);
      expect(Date.now() - started).toBeLessThan(5000);
      // The abort reached the harness as the check's error, not as a verdict
      // on the server: nothing reads "no response" or a pass.
      expect(graded).toEqual([`${PROGRESS}: Error: client went away`]);
      expect(stub.calls).toEqual([TOKEN]);
    } finally {
      await stub.close();
    }
  }, 20_000);
});

// ---------------------------------------------------------------------------
// The same readings over stdio: a minimal 2026-07-28 stdio server
// ---------------------------------------------------------------------------

/**
 * A 2026-07-28 stdio server declaring tools with one no-argument `count`
 * tool. PROGRESS_MODE picks how tools/call is answered: served (default),
 * -32602 only when the call carries a progressToken (`error-with-token`),
 * -32603 on the first call whatever it carries (`cold`), -32603 always
 * (`error-always`), exit 3 with a line on stderr when the call carries
 * a token (`exit-with-token`), -32603 on the first call and exit 3 on a
 * later one carrying a token (`cold-then-exit`), or exit 3 on a tools/call
 * of an unknown tool (`exit-on-unknown-tool`, which tools-call-unknown
 * sends). A server/discover without `_meta` protocolVersion is rejected
 * with -32602, so lifecycle-meta-required passes on a live process.
 * PROGRESS_LOG names a file each tools/call appends the token it carried
 * to ("-" for none).
 */
const STDIO_SERVER_SRC = `"use strict";
const fs = require("node:fs");
const readline = require("node:readline");
const mode = process.env.PROGRESS_MODE || "serve";
let calls = 0;
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg || msg.id === undefined) return;
  const result = (r) => out({ jsonrpc: "2.0", id: msg.id, result: Object.assign({ resultType: "complete" }, r) });
  const error = (code, message) => out({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
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
    if (process.env.PROGRESS_LOG) fs.appendFileSync(process.env.PROGRESS_LOG, (token === undefined ? "-" : String(token)) + "\\n");
    if (mode === "error-with-token" && token !== undefined) return error(-32602, "Invalid params: unrecognized key 'progressToken'");
    if (mode === "cold" && calls === 1) return error(-32603, "backend warming up, retry");
    if (mode === "error-always") return error(-32603, "Internal error");
    if ((mode === "exit-with-token" || (mode === "cold-then-exit" && calls > 1)) && token !== undefined) {
      fs.writeSync(2, "Error: cannot handle a progress token\\n");
      process.exit(3);
    }
    if (mode === "cold-then-exit" && calls === 1) return error(-32603, "backend warming up, retry");
    if (mode === "exit-on-unknown-tool" && msg.params && msg.params.name === "__nonexistent_tool_compliance_test__") {
      process.exit(3);
    }
    return result({ content: [{ type: "text", text: "2" }] });
  }
  error(-32601, "Method not found: " + msg.method);
});
process.stdin.on("end", () => process.exit(0));
`;

const stdio = { dir: "", script: "" };

beforeAll(() => {
  stdio.dir = mkdtempSync(join(tmpdir(), "mcp-compliance-progress-"));
  stdio.script = join(stdio.dir, "progress-server.cjs");
  writeFileSync(stdio.script, STDIO_SERVER_SRC);
});

afterAll(() => {
  rmSync(stdio.dir, { recursive: true, force: true });
});

let logSeq = 0;

/** One `--only lifecycle-progress-token` run (or `only`) against the stdio server in `mode`: the verdict, the tokens the calls carried, the warnings, the report. */
async function runStdio(
  mode: string,
  only: string[] = [PROGRESS],
): Promise<{ verdict: string; calls: string[]; warnings: string[]; report: ComplianceReport }> {
  const log = join(stdio.dir, `calls-${++logSeq}.log`);
  writeFileSync(log, "");
  const target: TransportTarget = {
    type: "stdio",
    command: process.execPath,
    args: [stdio.script],
    env: { PROGRESS_MODE: mode, PROGRESS_LOG: log },
  };
  const report = await runModern(target, { only });
  const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
  return { verdict: verdictOf(report, PROGRESS), calls, warnings: report.warnings, report };
}

describe("2026-07-28 lifecycle-progress-token over stdio", () => {
  it("a JSON-RPC error only on the call carrying the token FAILS once reproduced", async () => {
    // Before: PASS "tools/call count returned JSON-RPC error -32602 (Invalid
    // params: ...); no notifications/progress observed (optional)".
    const { verdict, calls } = await runStdio("error-with-token");
    expect(verdict).toBe(
      `FAIL: tools/call count carrying _meta.progressToken returned JSON-RPC error -32602 (Invalid params: unrecognized key 'progressToken'), and JSON-RPC error -32602 (Invalid params: unrecognized key 'progressToken') when it was resent, ${BLAMED}`,
    );
    expect(calls).toEqual([TOKEN, "-", TOKEN]);
  }, 30_000);

  it("a cold first call passes on the resent call; a failure shared by the call without the token is an observation", async () => {
    const cold = await runStdio("cold");
    expect(cold.verdict).toBe(
      `PASS: tools/call count succeeded when resent: it first returned JSON-RPC error -32603 (backend warming up, retry), then the same call without the token and the resent one were served; ${NONE}`,
    );
    expect(cold.calls).toEqual([TOKEN, "-", TOKEN]);
    const always = await runStdio("error-always");
    expect(always.verdict).toBe(
      `PASS: tools/call count returned JSON-RPC error -32603 (Internal error), and the same call without the token was not served either (JSON-RPC error -32603 (Internal error)), so the progress token is not what failed it; ${NONE}`,
    );
    expect(always.calls).toEqual([TOKEN, "-"]);
  }, 40_000);

  const EXITED = "made the server exit (exit code 3: Error: cannot handle a progress token)";
  const restarted = (cause: string) =>
    `${PROGRESS}: the server exited on tools/call count ${cause} and was restarted with a fresh server/discover, so the tests after it ran against the new instance.`;

  it("a child that exits on every call carrying the token, while the same call without it is served, FAILS, and is restarted each time (before: a skip, left dead)", async () => {
    // Before: PASS (skipped) "tools/call count with progressToken got no
    // response (connection closed: server crashed with exit code 3 ...)",
    // and a warning that the tests after it ran against the exited process.
    const { verdict, calls, warnings, report } = await runStdio("exit-with-token", [
      PROGRESS,
      "lifecycle-meta-required",
    ]);
    expect(verdict).toBe(
      `FAIL: tools/call count carrying _meta.progressToken ${EXITED}, and ${EXITED} when it was resent, ${BLAMED}`,
    );
    // The call without the token and the resent call each reached a new instance.
    expect(calls).toEqual([TOKEN, "-", TOKEN]);
    // Both exits restarted the child (the two identical warnings collapse into one).
    expect(warnings.filter((w) => w.startsWith(`${PROGRESS}:`))).toEqual([restarted("carrying _meta.progressToken")]);
    // The check after it measures a live process. Before: "server/discover
    // without _meta: no response (stdio transport: server crashed ...)".
    expect(verdictOf(report, "lifecycle-meta-required")).toMatch(
      /^PASS: server\/discover without _meta: rejected with -32602/,
    );
  }, 60_000);

  it("a cold first call, then an exit on the resent call carrying the token: the failure is reproduced (before: PASS 'not reproduced')", async () => {
    // Before: PASS "tools/call count returned JSON-RPC error -32603 (...); the
    // same call without the token was served, but resent, the call carrying
    // it got no response (connection closed: server crashed ...), so the
    // failure was not reproduced; ...", with no warning.
    const { verdict, calls, warnings } = await runStdio("cold-then-exit");
    expect(verdict).toBe(
      `FAIL: tools/call count carrying _meta.progressToken returned JSON-RPC error -32603 (backend warming up, retry), and ${EXITED} when it was resent, ${BLAMED}`,
    );
    expect(calls).toEqual([TOKEN, "-", TOKEN]);
    expect(warnings.filter((w) => w.startsWith(`${PROGRESS}:`))).toEqual([restarted("carrying _meta.progressToken")]);
  }, 60_000);

  it("a child already gone before the call measured nothing: a skip, and no warning blames the progress token's call", async () => {
    // tools-call-unknown's tools/call kills the child, and that check
    // restarts nothing. Before: a warning that "the server exited on
    // tools/call count, which carried _meta.progressToken (exit code 3 ...)".
    const { verdict, calls, warnings, report } = await runStdio("exit-on-unknown-tool", [
      "tools-list",
      "tools-call-unknown",
      PROGRESS,
    ]);
    expect(resultOf(report, "tools-call-unknown").passed).toBe(false);
    expect(verdict).toMatch(
      /^PASS \(skipped\): tools\/call count with progressToken got no response \(connection closed: /,
    );
    // Only tools-call-unknown's call reached a process; the progress call found none.
    expect(calls).toEqual(["-"]);
    expect(warnings.filter((w) => w.startsWith(`${PROGRESS}:`))).toEqual([]);
  }, 60_000);

  it("a served call passes as before, after exactly one call", async () => {
    const { verdict, calls, warnings } = await runStdio("serve");
    expect(verdict).toBe(`PASS: tools/call count succeeded; ${NONE}`);
    expect(calls).toEqual([TOKEN]);
    expect(warnings.filter((w) => w.startsWith(`${PROGRESS}:`))).toEqual([]);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Conformant servers keep their verdicts: the SDK v2 reference server
// ---------------------------------------------------------------------------

const SDK2_STDIO_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "sdk2-stdio-server.mjs");

describe("2026-07-28 lifecycle-progress-token against SDK v2 (a server that ignores the token)", () => {
  it("over HTTP: the call is served and passes after one call, as before", async () => {
    // Mounted as integration-sdk2.test.ts mounts it, with the same echo tool.
    const handler = createMcpHandler(
      () => {
        const mcp = new McpServer({ name: "sdk2-progress", version: "2.0.0" });
        mcp.registerTool(
          "echo",
          {
            description: "Echoes back the input",
            inputSchema: z.object({ message: z.string().optional() }),
          },
          async ({ message }) => ({ content: [{ type: "text" as const, text: String(message ?? "no message") }] }),
        );
        return mcp;
      },
      { legacy: "stateless" },
    );
    const mcpHandler = toNodeHandler(handler);
    const validateHost = localhostHostValidation();
    const validateOrigin = localhostOriginValidation();
    const server = createServer(async (req, res) => {
      if (!validateHost(req, res) || !validateOrigin(req, res)) return;
      await mcpHandler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const report = await runModern(`http://127.0.0.1:${port}/mcp`, { only: [PROGRESS] });
      expect(verdictOf(report, PROGRESS)).toBe(`PASS: tools/call echo succeeded; ${NONE}`);
      expect(report.warnings.filter((w) => w.startsWith(`${PROGRESS}:`))).toEqual([]);
    } finally {
      await handler.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);

  it("over stdio (serveStdio): the same pass", async () => {
    const report = await runModern(
      { type: "stdio", command: process.execPath, args: [SDK2_STDIO_FIXTURE], env: {} },
      { only: [PROGRESS], startupTimeout: 15_000 },
    );
    expect(verdictOf(report, PROGRESS)).toBe(`PASS: tools/call echo succeeded; ${NONE}`);
    expect(report.warnings.filter((w) => w.startsWith(`${PROGRESS}:`))).toEqual([]);
  }, 30_000);
});
