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
 * included. A call nothing answers measured nothing (a skip) where it used
 * to fail. Conformant servers keep their verdicts: the SDK v2 reference
 * server over HTTP and stdio is pinned at the end (the modern fixture's
 * three progress notifications are pinned in modern-lifecycle.test.ts).
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
 * - `hang-with-token` / `drop-with-token`: the call carrying the token is never answered / its connection is closed.
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
  | "drop-with-token";

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

  it("a failure the call without the token shares, or the resent call does not repeat, stays an observation", async () => {
    // Before: PASS "tools/call count returned JSON-RPC error -32603 (Internal
    // error); no notifications/progress observed (optional)", one call.
    const always = await runStub({ call: "500-always" });
    expect(always.verdict).toBe(
      `PASS: tools/call count returned JSON-RPC error -32603 (Internal error) (HTTP 500), and the same call without the token was not served either (JSON-RPC error -32603 (Internal error) (HTTP 500)), so the progress token is not what failed it; ${NONE}`,
    );
    expect(always.calls).toEqual([TOKEN, undefined]);
    const flaky = await runStub({ call: "cold-then-hang" }, { timeout: 1500 });
    expect(flaky.verdict).toBe(
      `PASS: tools/call count returned JSON-RPC error -32603 (backend warming up, retry) (HTTP 200); the same call without the token was served, but resent, the call carrying it got no response within 1500ms, so the failure was not reproduced; ${NONE}`,
    );
    expect(flaky.calls).toEqual([TOKEN, undefined, TOKEN]);
  }, 30_000);

  it("a rate limiter's 429 or an auth gate's 401 on the call is no server error: an observation, and nothing more is sent", async () => {
    // Before: PASS "tools/call count succeeded; ..." for the 429's text body,
    // and "tools/call count returned JSON-RPC error -32001 (Unauthorized); ...".
    const throttled = await runStub({ call: 429 });
    expect(throttled.verdict).toBe(`PASS: tools/call count answered HTTP 429 (rate limiting); ${NONE}`);
    expect(throttled.calls).toEqual([TOKEN]);
    const gated = await runStub({ call: 401 });
    expect(gated.verdict).toBe(`PASS: tools/call count answered HTTP 401 (an auth gate); ${NONE}`);
    expect(gated.calls).toEqual([TOKEN]);
  }, 30_000);

  it("a call nothing answers, or whose connection is closed, measured nothing: a skip, and no other call is sent", async () => {
    // Before: FAIL "tools/call count with progressToken: no response (...)".
    const hung = await runStub({ call: "hang-with-token" }, { timeout: 1500 });
    expect(hung.verdict).toBe(
      `PASS (skipped): tools/call count with progressToken got no response within 1500ms; ${NONE}`,
    );
    expect(hung.calls).toEqual([TOKEN]);
    const dropped = await runStub({ call: "drop-with-token" });
    expect(dropped.verdict).toMatch(
      /^PASS \(skipped\): tools\/call count with progressToken got no response \(connection closed: .+\); no notifications\/progress observed \(optional\)$/,
    );
    expect(dropped.calls).toEqual([TOKEN]);
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
 * (`error-always`), or exit 3 with a line on stderr when the call carries
 * a token (`exit-with-token`). PROGRESS_LOG names a file each tools/call
 * appends the token it carried to ("-" for none).
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
    if (mode === "exit-with-token" && token !== undefined) {
      fs.writeSync(2, "Error: cannot handle a progress token\\n");
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

/** One `--only lifecycle-progress-token` run against the stdio server in `mode`: the verdict, the tokens the calls carried, the warnings. */
async function runStdio(mode: string): Promise<{ verdict: string; calls: string[]; warnings: string[] }> {
  const log = join(stdio.dir, `calls-${++logSeq}.log`);
  writeFileSync(log, "");
  const target: TransportTarget = {
    type: "stdio",
    command: process.execPath,
    args: [stdio.script],
    env: { PROGRESS_MODE: mode, PROGRESS_LOG: log },
  };
  const report = await runModern(target, { only: [PROGRESS] });
  const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
  return { verdict: verdictOf(report, PROGRESS), calls, warnings: report.warnings };
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

  it("a child that exits on the call measured nothing about the token: a skip, with a warning naming the exit", async () => {
    // Before: FAIL "tools/call count with progressToken: no response (stdio
    // transport: server crashed with exit code 3 ...)", and no warning.
    const { verdict, calls, warnings } = await runStdio("exit-with-token");
    expect(verdict).toBe(
      `PASS (skipped): tools/call count with progressToken got no response (connection closed: server crashed with exit code 3 before completing the request); ${NONE}`,
    );
    expect(calls).toEqual([TOKEN]);
    expect(warnings.filter((w) => w.startsWith(`${PROGRESS}:`))).toEqual([
      `${PROGRESS}: the server exited on tools/call count, which carried _meta.progressToken (exit code 3: Error: cannot handle a progress token); the tests after it ran against the exited process.`,
    ]);
  }, 30_000);

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
