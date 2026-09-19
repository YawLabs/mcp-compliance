import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MODERN_SPEC_VERSION } from "../spec.js";
import type { ComplianceReport, TransportTarget } from "../types.js";
import { resultOf, runModern } from "./helpers/modern-fixture.js";

/**
 * Review round 82, lifecycle track (src/suites/modern/lifecycle.ts):
 *
 * - lifecycle-progress-token cleared the token whenever the same call without
 *   it was not served, whatever it failed with. A tool whose required
 *   arguments the empty call lacks answers -32602 without the token, so a
 *   server that exits (or drops the connection, or answers -32603) on every
 *   call carrying the token passed "the progress token is not what failed
 *   it". The call without the token now clears it only when it failed the
 *   same way (the same JSON-RPC error code); otherwise the call carrying the
 *   token is resent, and failing the same way again, the token is blamed.
 * - Valid progress notifications settled the check before the call's own
 *   failure was read, so a server that sends one progress frame and then
 *   fails every call carrying the token passed.
 * - The setup server/discover was not resent after a 429, so every
 *   lifecycle-discover* check, the capability gates and notEvaluable read the
 *   429 while lifecycle-jsonrpc alone resent it and passed.
 * - lifecycle-subscriptions-listen read a server's own -32601 on a 5xx as
 *   "not evaluable ... proves nothing" when a subscription capability is
 *   advertised, hiding the server refusing a method it advertises.
 *
 * Each group pins the conformant-server verdicts that must not move.
 */

const PROGRESS = "lifecycle-progress-token";
const LISTEN = "lifecycle-subscriptions-listen";
const TOKEN = "compliance-progress-1";
const NONE = "no notifications/progress observed (optional)";
const ONE_PROGRESS = `1 notifications/progress echoed token "${TOKEN}" with increasing progress (1)`;
/**
 * The failure once the token is blamed next to a served call without it.
 * Before (review 82a): "... carrying _meta.progressToken <answer>, and
 * <answer> when it was resent, while the same call without it, sent in
 * between, was served -- the server failed the request because of its
 * progress token (basic/patterns/progress lets ...)", past the budget.
 */
const blamedAgain = (answer: string) =>
  `FAIL: tools/call count with _meta.progressToken: ${answer}, and again when resent; without it: served -- so the token is what failed it`;
const BLAMED_UNLIKE = " -- so the token is what failed it";

/** "PASS: ..." / "FAIL: ..." with " (skipped)" when the pass measured nothing. */
function verdictOf(report: ComplianceReport, id: string): string {
  const t = resultOf(report, id);
  return `${t.passed ? "PASS" : "FAIL"}${t.skipped ? " (skipped)" : ""}: ${t.details}`;
}

function expectBudget(report: ComplianceReport, id: string): void {
  const details = resultOf(report, id).details;
  expect(details, id).toMatch(/^[\x20-\x7e]+$/);
  expect(details.length, id).toBeLessThanOrEqual(220);
}

// ---------------------------------------------------------------------------
// A 2026-07-28 HTTP server whose answer to each request is a knob
// ---------------------------------------------------------------------------

type Reply =
  | { status: number; body: unknown; headers?: Record<string, string> }
  | { sse: unknown[] }
  | { status: number; text: string; headers?: Record<string, string> }
  | "hang"
  | "drop";

interface Seen {
  /** Every POST's method, in order. */
  methods: string[];
  /** The progressToken each tools/call carried (undefined for none), in order. */
  tokens: unknown[];
}

interface StubOptions {
  /** What server/discover declares (tools only by default). */
  capabilities?: Record<string, unknown>;
  /** The one listed tool requires an argument `q` that the check's empty call lacks. */
  requiredArgs?: boolean;
  /** Answers a request itself, or undefined for the conformant answer. */
  route?: (msg: Record<string, any>, seen: Seen) => Reply | undefined;
}

const count = (seen: Seen, method: string) => seen.methods.filter((m) => m === method).length;

async function startStub(opts: StubOptions = {}): Promise<{ url: string; seen: Seen; close(): Promise<void> }> {
  const seen: Seen = { methods: [], tokens: [] };
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
      seen.methods.push(String(msg.method));
      if (msg.method === "tools/call") seen.tokens.push(msg.params?._meta?.progressToken);
      const rpcError = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
      const reply =
        opts.route?.(msg, seen) ??
        ((): Reply => {
          switch (msg.method) {
            case "server/discover":
              return {
                status: 200,
                body: {
                  jsonrpc: "2.0",
                  id: msg.id,
                  result: {
                    resultType: "complete",
                    supportedVersions: [MODERN_SPEC_VERSION],
                    capabilities: opts.capabilities ?? { tools: {} },
                    ttlMs: 0,
                    cacheScope: "public",
                    _meta: { "io.modelcontextprotocol/serverInfo": { name: "r82-stub", version: "0" } },
                  },
                },
              };
            case "tools/list":
              return {
                status: 200,
                body: {
                  jsonrpc: "2.0",
                  id: msg.id,
                  result: {
                    resultType: "complete",
                    tools: [
                      {
                        name: "count",
                        description: "Counts to two",
                        inputSchema: opts.requiredArgs
                          ? { type: "object", properties: { q: { type: "string" } }, required: ["q"] }
                          : { type: "object" },
                      },
                    ],
                    ttlMs: 0,
                    cacheScope: "public",
                  },
                },
              };
            case "tools/call":
              if (opts.requiredArgs && typeof msg.params?.arguments?.q !== "string") {
                return { status: 400, body: rpcError(-32602, "Invalid params: q is required") };
              }
              return {
                status: 200,
                body: {
                  jsonrpc: "2.0",
                  id: msg.id,
                  result: { resultType: "complete", content: [{ type: "text", text: "2" }] },
                },
              };
          }
          return { status: 404, body: rpcError(-32601, `Method not found: ${String(msg.method)}`) };
        })();
      if (reply === "hang") return;
      if (reply === "drop") {
        req.socket.destroy();
        return;
      }
      if ("sse" in reply) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(reply.sse.map((m) => `event: message\ndata: ${JSON.stringify(m)}\n\n`).join(""));
        return;
      }
      if ("text" in reply) {
        res.writeHead(reply.status, { "Content-Type": "text/plain", ...reply.headers });
        res.end(reply.text);
        return;
      }
      res.writeHead(reply.status, { "Content-Type": "application/json", ...reply.headers });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function runStub(
  opts: StubOptions,
  only: string[],
  runOpts: { timeout?: number } = {},
): Promise<{ report: ComplianceReport; seen: Seen }> {
  const stub = await startStub(opts);
  try {
    const report = await runModern(stub.url, { only, ...runOpts });
    return { report, seen: { methods: [...stub.seen.methods], tokens: [...stub.seen.tokens] } };
  } finally {
    await stub.close();
  }
}

const progressFrame = (progress: number) => ({
  jsonrpc: "2.0",
  method: "notifications/progress",
  params: { progressToken: TOKEN, progress },
});
const carries = (msg: Record<string, any>) =>
  msg.method === "tools/call" && msg.params?._meta?.progressToken !== undefined;

// ---------------------------------------------------------------------------
// A 2026-07-28 stdio server, one tool, MODE picks how a call carrying the token is answered
// ---------------------------------------------------------------------------

/**
 * MODE, for a tools/call carrying a progressToken: `exit` (exit 3 with a
 * line on stderr), `internal` (-32603), `progress-exit` (one valid
 * notifications/progress, then exit 3 20 ms later), `progress-internal` (one
 * valid notification, then -32603), `cold-internal` (-32603 on the first
 * such call only), `exit-then-internal` (exit 3 on the first, -32603 on
 * later ones). Anything else, or a call without the token, is answered as
 * usual: -32602 when REQUIRED_ARGS=1 and the call lacks `q`, else a result.
 * CALLS_LOG names a file each tools/call appends its token to ("-" for
 * none); it also counts the calls carrying the token across restarts.
 */
const STDIO_SERVER_SRC = `"use strict";
const fs = require("node:fs");
const readline = require("node:readline");
const mode = process.env.MODE || "serve";
const requiredArgs = process.env.REQUIRED_ARGS === "1";
const log = process.env.CALLS_LOG;
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
      _meta: { "io.modelcontextprotocol/serverInfo": { name: "r82-stdio", version: "0" } } });
  }
  if (msg.method === "tools/list") {
    const inputSchema = requiredArgs ? { type: "object", properties: { q: { type: "string" } }, required: ["q"] } : { type: "object" };
    return result({ tools: [{ name: "count", description: "Counts to two", inputSchema }], ttlMs: 0, cacheScope: "public" });
  }
  if (msg.method === "tools/call") {
    const token = msg.params && msg.params._meta ? msg.params._meta.progressToken : undefined;
    fs.appendFileSync(log, (token === undefined ? "-" : String(token)) + "\\n");
    const nth = fs.readFileSync(log, "utf8").split("\\n").filter((l) => l && l !== "-").length;
    const crash = () => { fs.writeSync(2, "TypeError: progress reporter crashed\\n"); process.exit(3); };
    const progress = () => out({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: 1 } });
    if (token !== undefined) {
      if (mode === "exit") return crash();
      if (mode === "internal") return error(-32603, "Internal error");
      if (mode === "progress-exit") { progress(); setTimeout(crash, 20); return; }
      if (mode === "progress-internal") { progress(); return error(-32603, "Internal error"); }
      if (mode === "cold-internal" && nth === 1) return error(-32603, "backend warming up, retry");
      if (mode === "exit-then-internal") return nth === 1 ? crash() : error(-32603, "Internal error");
    }
    const args = (msg.params && msg.params.arguments) || {};
    if (requiredArgs && typeof args.q !== "string") return error(-32602, "Invalid params: q is required");
    return result({ content: [{ type: "text", text: "2" }] });
  }
  error(-32601, "Method not found: " + msg.method);
});
process.stdin.on("end", () => process.exit(0));
`;

const stdio = { dir: "", script: "" };

beforeAll(() => {
  stdio.dir = mkdtempSync(join(tmpdir(), "mcp-compliance-r82-lifecycle-"));
  stdio.script = join(stdio.dir, "r82-server.cjs");
  writeFileSync(stdio.script, STDIO_SERVER_SRC);
});

afterAll(() => {
  rmSync(stdio.dir, { recursive: true, force: true });
});

let logSeq = 0;

async function runStdio(
  mode: string,
  opts: { requiredArgs?: boolean; only?: string[] } = {},
): Promise<{ report: ComplianceReport; verdict: string; calls: string[]; warnings: string[] }> {
  const log = join(stdio.dir, `calls-${++logSeq}.log`);
  writeFileSync(log, "");
  const target: TransportTarget = {
    type: "stdio",
    command: process.execPath,
    args: [stdio.script],
    env: { MODE: mode, REQUIRED_ARGS: opts.requiredArgs ? "1" : "0", CALLS_LOG: log },
  };
  const report = await runModern(target, { only: opts.only ?? [PROGRESS] });
  const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
  return {
    report,
    verdict: verdictOf(report, PROGRESS),
    calls,
    warnings: report.warnings.filter((w) => w.startsWith(`${PROGRESS}:`)),
  };
}

const EXITED = "server exited (exit code 3: TypeError: progress reporter crashed)";
const Q_REQUIRED = "JSON-RPC error -32602 (Invalid params: q is required)";
const restarted = (cause: string) =>
  `${PROGRESS}: the server exited on tools/call count ${cause} and was restarted with a fresh server/discover, so the tests after it ran against the new instance.`;

// ---------------------------------------------------------------------------
// Item 3: a call without the token that fails differently clears nothing
// ---------------------------------------------------------------------------

describe("r82 lifecycle-progress-token: the call without the token clears it only when it failed the same way", () => {
  it("stdio: an exit on every call carrying the token, next to a -32602 for the missing argument without it, FAILS (before: PASS)", async () => {
    // Before: PASS "tools/call count made the server exit (...), and the same
    // call without the token was not served either (JSON-RPC error -32602
    // (Invalid params: q is required)), so the progress token is not what
    // failed it; ...", after two calls.
    const { report, verdict, calls, warnings } = await runStdio("exit", {
      requiredArgs: true,
      only: [PROGRESS, "lifecycle-meta-required"],
    });
    // The exit without its stderr, so the answer without the token is whole
    // (before: "server exited (exit code 3: TypeError: progress re...").
    expect(verdict).toBe(
      `FAIL: tools/call count with _meta.progressToken: server exited, and again when resent; without it: ${Q_REQUIRED}${BLAMED_UNLIKE}`,
    );
    expectBudget(report, PROGRESS);
    // The call carrying the token, the call without it, the call carrying it resent.
    expect(calls).toEqual([TOKEN, "-", TOKEN]);
    expect(warnings).toEqual([restarted("carrying _meta.progressToken")]);
    // Both exits were restarted: the check after it measures a live process.
    expect(verdictOf(report, "lifecycle-meta-required")).toMatch(/^PASS: server\/discover without _meta: rejected/);
  }, 60_000);

  it("stdio: -32603 on every call carrying the token next to -32602 without it FAILS once reproduced (before: PASS)", async () => {
    // Before: PASS "... returned JSON-RPC error -32603 (Internal error), and
    // the same call without the token was not served either (JSON-RPC error
    // -32602 ...), so the progress token is not what failed it; ...".
    const { report, verdict, calls } = await runStdio("internal", { requiredArgs: true });
    expect(verdict).toBe(
      `FAIL: tools/call count with _meta.progressToken: JSON-RPC error -32603 (Internal error), and again when resent; without it: ${Q_REQUIRED}${BLAMED_UNLIKE}`,
    );
    expectBudget(report, PROGRESS);
    expect(calls).toEqual([TOKEN, "-", TOKEN]);
  }, 30_000);

  it("HTTP: a connection closed on every call carrying the token, next to a 400 -32602 without it, FAILS (before: PASS)", async () => {
    const { report, seen } = await runStub(
      { requiredArgs: true, route: (msg) => (carries(msg) ? "drop" : undefined) },
      [PROGRESS],
    );
    const verdict = verdictOf(report, PROGRESS);
    expect(verdict).toMatch(
      /^FAIL: tools\/call count with _meta\.progressToken: no response \(connection closed: .*\), and again when resent; without it: JSON-RPC error -32602 \(HTTP 400\) -- so the token is what failed it$/,
    );
    expectBudget(report, PROGRESS);
    expect(seen.tokens).toEqual([TOKEN, undefined, TOKEN]);
  }, 30_000);

  it("a cold first call carrying the token, then the call carrying it answered as the call without it was: PASS, not the token", async () => {
    // First -32603 (warming up), without the token -32602 for the missing
    // argument, and resent with the token -32602 too: the token changed nothing.
    const { report, verdict, calls } = await runStdio("cold-internal", { requiredArgs: true });
    expect(verdict).toBe(
      `PASS: tools/call count with _meta.progressToken: JSON-RPC error -32603; resent: JSON-RPC error -32602, as without it, so the token is not what failed it; ${NONE}`,
    );
    expect(resultOf(report, PROGRESS).skipped).toBeUndefined();
    expectBudget(report, PROGRESS);
    expect(calls).toEqual([TOKEN, "-", TOKEN]);
  }, 30_000);

  it("a resent call that neither repeats the first failure nor matches the call without the token reproduced nothing: a skip", async () => {
    // Exit, then -32602 without the token, then -32603 with it.
    const { report, verdict, calls } = await runStdio("exit-then-internal", { requiredArgs: true });
    expect(verdict).toBe(
      `PASS (skipped): tools/call count with _meta.progressToken: server exited; without it: JSON-RPC error -32602; resent: JSON-RPC error -32603; no failure reproduced (not evaluable); ${NONE}`,
    );
    expectBudget(report, PROGRESS);
    expect(calls).toEqual([TOKEN, "-", TOKEN]);
  }, 60_000);

  it("HTTP: served when resent after an unlike failure without the token: PASS naming both", async () => {
    // First -32603 with the token, 400 -32602 without it, then served with it.
    const { report, seen } = await runStub(
      {
        requiredArgs: true,
        route: (msg, s) => {
          if (!carries(msg)) return undefined;
          if (s.tokens.length === 1) {
            return { status: 200, body: { jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "cold" } } };
          }
          return {
            status: 200,
            body: { jsonrpc: "2.0", id: msg.id, result: { resultType: "complete", content: [] } },
          };
        },
      },
      [PROGRESS],
    );
    expect(verdictOf(report, PROGRESS)).toBe(
      `PASS: tools/call count succeeded when resent with _meta.progressToken (first: JSON-RPC error -32603 (cold) (HTTP 200); without it: JSON-RPC error -32602 (HTTP 400)); ${NONE}`,
    );
    expectBudget(report, PROGRESS);
    expect(seen.tokens).toEqual([TOKEN, undefined, TOKEN]);
  }, 30_000);

  it("pins: the same JSON-RPC code with and without the token stays a passing observation after two calls, whatever the HTTP status", async () => {
    // A server that answers a call carrying a progress token on an SSE stream
    // reports the missing argument on a 200; without the token, on a plain 400.
    const sse = await runStub(
      {
        requiredArgs: true,
        route: (msg) =>
          carries(msg)
            ? {
                sse: [
                  { jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "Invalid params: q is required" } },
                ],
              }
            : undefined,
      },
      [PROGRESS],
    );
    // Before: 253 characters, both answers with their message.
    expect(verdictOf(sse.report, PROGRESS)).toBe(
      `PASS: tools/call count with _meta.progressToken: JSON-RPC error -32602 (HTTP 200); without it: JSON-RPC error -32602 (HTTP 400), so the token is not what failed it; ${NONE}`,
    );
    expectBudget(sse.report, PROGRESS);
    expect(sse.seen.tokens).toEqual([TOKEN, undefined]);
    // The same over stdio, where both calls answer the missing argument alike.
    const same = await runStdio("serve", { requiredArgs: true });
    expect(same.verdict).toBe(
      `PASS: tools/call count with _meta.progressToken: JSON-RPC error -32602; without it: ${Q_REQUIRED}, so the token is not what failed it; ${NONE}`,
    );
    expectBudget(same.report, PROGRESS);
    expect(same.calls).toEqual([TOKEN, "-"]);
  }, 40_000);
});

// ---------------------------------------------------------------------------
// Item 4: valid progress notifications no longer hide a failure on the same call
// ---------------------------------------------------------------------------

describe("r82 lifecycle-progress-token: valid progress settles the check only on a call the server did not fail", () => {
  it("stdio: one progress frame, then an exit on every call carrying the token, FAILS once reproduced (before: PASS after one call)", async () => {
    // Before: PASS "1 notifications/progress echoed token ... (1)", one call,
    // and a restart warning next to it.
    const { report, verdict, calls, warnings } = await runStdio("progress-exit");
    expect(verdict).toBe(blamedAgain(EXITED));
    expectBudget(report, PROGRESS);
    expect(calls).toEqual([TOKEN, "-", TOKEN]);
    expect(warnings).toEqual([restarted("carrying _meta.progressToken")]);
    expect(resultOf(report, PROGRESS).passed).toBe(false);
  }, 60_000);

  it("stdio: one progress frame, then -32603 on every call carrying the token, FAILS once reproduced (before: PASS)", async () => {
    const { report, verdict, calls } = await runStdio("progress-internal");
    expect(verdict).toBe(blamedAgain("JSON-RPC error -32603 (Internal error)"));
    expectBudget(report, PROGRESS);
    expect(calls).toEqual([TOKEN, "-", TOKEN]);
  }, 30_000);

  it("HTTP: a progress frame and then -32603 on the SSE stream of every call carrying the token FAILS (before: PASS)", async () => {
    const { report, seen } = await runStub(
      {
        route: (msg) =>
          carries(msg)
            ? {
                sse: [
                  progressFrame(1),
                  { jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "Internal error" } },
                ],
              }
            : undefined,
      },
      [PROGRESS],
    );
    expect(verdictOf(report, PROGRESS)).toBe(blamedAgain("JSON-RPC error -32603 (Internal error) (HTTP 200)"));
    expectBudget(report, PROGRESS);
    expect(seen.tokens).toEqual([TOKEN, undefined, TOKEN]);
  }, 30_000);

  it("stdio: progress, then an exit, next to a -32602 without the token, FAILS through the unlike-twin resend", async () => {
    const { report, verdict, calls } = await runStdio("progress-exit", { requiredArgs: true });
    expect(verdict).toBe(
      `FAIL: tools/call count with _meta.progressToken: server exited, and again when resent; without it: ${Q_REQUIRED}${BLAMED_UNLIKE}`,
    );
    expectBudget(report, PROGRESS);
    expect(calls).toEqual([TOKEN, "-", TOKEN]);
  }, 60_000);

  it("a failure the call without the token shares keeps its passing observation, now naming the progress observed", async () => {
    // Before: PASS "1 notifications/progress echoed token ... (1)" after one
    // call; then (review 82a) the same pass at 323 characters, the progress
    // note in full next to both answers. The note is compact next to a
    // failure, and the longer answer gives way to its brief form.
    const { report, seen } = await runStub(
      {
        route: (msg) => {
          if (msg.method !== "tools/call") return undefined;
          const error = { jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "Internal error" } };
          return carries(msg) ? { sse: [progressFrame(1), error] } : { status: 200, body: error };
        },
      },
      [PROGRESS],
    );
    expect(verdictOf(report, PROGRESS)).toBe(
      "PASS: tools/call count with _meta.progressToken: JSON-RPC error -32603 (HTTP 200); without it: JSON-RPC error -32603 (Internal error) (HTTP 200), so the token is not what failed it; 1 valid notifications/progress observed",
    );
    expectBudget(report, PROGRESS);
    expect(seen.tokens).toEqual([TOKEN, undefined]);
  }, 30_000);

  it("pins: a served call with valid progress passes after exactly one call; a foreign token still fails at once", async () => {
    const served = await runStub(
      {
        route: (msg) =>
          carries(msg)
            ? {
                sse: [
                  progressFrame(1),
                  { jsonrpc: "2.0", id: msg.id, result: { resultType: "complete", content: [] } },
                ],
              }
            : undefined,
      },
      [PROGRESS],
    );
    expect(verdictOf(served.report, PROGRESS)).toBe(`PASS: ${ONE_PROGRESS}`);
    expect(served.seen.tokens).toEqual([TOKEN]);
    const foreign = await runStub(
      {
        route: (msg) =>
          carries(msg)
            ? {
                sse: [
                  { jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: "x", progress: 1 } },
                  { jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "Internal error" } },
                ],
              }
            : undefined,
      },
      [PROGRESS],
    );
    expect(verdictOf(foreign.report, PROGRESS)).toBe(
      `FAIL: notifications/progress carries token "x", expected "${TOKEN}" (tools/call count returned JSON-RPC error -32603 (Internal error) (HTTP 200))`,
    );
    expect(foreign.seen.tokens).toEqual([TOKEN]);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Item 6: the setup server/discover is resent once after a 429, for every reader
// ---------------------------------------------------------------------------

describe("r82 setup server/discover: a 429 is resent once, and every reader judges the answer it settled on", () => {
  const SETUP_READERS = [
    "lifecycle-discover",
    "lifecycle-jsonrpc",
    "lifecycle-capabilities",
    "error-unknown-method",
    PROGRESS,
  ];
  /** The pinned run's preflight is the first server/discover, the setup exchange the second. */
  const throttleSetup = (answers: Array<"429" | "hang">) => (msg: Record<string, any>, seen: Seen) => {
    if (msg.method !== "server/discover") return undefined;
    const answer = answers[count(seen, "server/discover") - 2];
    if (answer === "429") {
      return { status: 429, text: "Too Many Requests", headers: { "Retry-After": "0" } } as Reply;
    }
    return answer;
  };

  it("throttled once: lifecycle-discover, the capability gates and notEvaluable read the resent answer (before: FAIL HTTP 429)", async () => {
    // Before: lifecycle-discover FAIL "server/discover answered non-JSON-RPC
    // body (HTTP 429)", error-unknown-method FAIL "not evaluable: the
    // conformant server/discover was itself rejected with no JSON-RPC error
    // code (HTTP 429) ...", lifecycle-progress-token PASS (skipped) "server
    // declares no tools" -- next to lifecycle-jsonrpc PASS "... resent once
    // after HTTP 429".
    const { report, seen } = await runStub({ route: throttleSetup(["429"]) }, SETUP_READERS);
    expect(Object.fromEntries(SETUP_READERS.map((id) => [id, verdictOf(report, id)]))).toEqual({
      "lifecycle-discover": `PASS: supportedVersions [${MODERN_SPEC_VERSION}], capabilities: tools (HTTP 200)`,
      "lifecycle-jsonrpc": "PASS: Valid JSON-RPC 2.0 response (id 1002 echoed, result; resent once after HTTP 429)",
      "lifecycle-capabilities": "PASS: Capabilities: tools",
      "error-unknown-method": "PASS: JSON-RPC error -32601 on HTTP 404, id echoed",
      [PROGRESS]: `PASS: tools/call count succeeded; ${NONE}`,
    });
    // The preflight, the throttled setup discover and its one resend: no
    // other check resends it.
    expect(count(seen, "server/discover")).toBe(3);
  }, 30_000);

  it("throttled again on the resend: every reader names both answers, and lifecycle-jsonrpc is still not evaluable", async () => {
    const { report, seen } = await runStub({ route: throttleSetup(["429", "429"]) }, [
      "lifecycle-discover",
      "lifecycle-jsonrpc",
      "error-unknown-method",
    ]);
    const twice = "HTTP 429, then after 0ms HTTP 429";
    expect(verdictOf(report, "lifecycle-discover")).toBe(`FAIL: server/discover answered non-JSON-RPC body (${twice})`);
    expect(verdictOf(report, "lifecycle-jsonrpc")).toBe(
      `FAIL: server/discover answered no JSON-RPC error body (${twice}); not evaluable: a rate limiter answered before the server read the request, so it proves nothing about the server's JSON-RPC envelope`,
    );
    expect(verdictOf(report, "error-unknown-method")).toMatch(
      /^FAIL: .*not evaluable: the conformant server\/discover was itself rejected with no JSON-RPC error code \(HTTP 429\)/,
    );
    expect(count(seen, "server/discover")).toBe(3);
  }, 30_000);

  it("a resend that gets no answer: server unreachable, for lifecycle-discover as for lifecycle-jsonrpc", async () => {
    const { report } = await runStub(
      { route: throttleSetup(["429", "hang"]) },
      ["lifecycle-discover", "lifecycle-jsonrpc"],
      { timeout: 1000 },
    );
    for (const id of ["lifecycle-discover", "lifecycle-jsonrpc"]) {
      expect(verdictOf(report, id), id).toMatch(
        /^FAIL: server unreachable: server\/discover answered HTTP 429, and its resend got no response \(\S/,
      );
      expectBudget(report, id);
    }
  }, 30_000);

  it("pins: a server that is not throttled is sent the preflight and the setup discover only", async () => {
    const { report, seen } = await runStub({}, SETUP_READERS);
    expect(verdictOf(report, "lifecycle-discover")).toBe(
      `PASS: supportedVersions [${MODERN_SPEC_VERSION}], capabilities: tools (HTTP 200)`,
    );
    expect(verdictOf(report, "lifecycle-jsonrpc")).toBe("PASS: Valid JSON-RPC 2.0 response (id 1001 echoed, result)");
    expect(count(seen, "server/discover")).toBe(2);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Item 20: a server's own -32601 on a 5xx, with a subscription capability advertised
// ---------------------------------------------------------------------------

describe("r82 lifecycle-subscriptions-listen: an advertised listen refused with the server's own -32601 on a 5xx", () => {
  const listenWarnings = (report: ComplianceReport) => report.warnings.filter((w) => w.startsWith(`${LISTEN}:`));
  const listenAnswer = (reply: (id: unknown) => Reply) => (msg: Record<string, any>) =>
    msg.method === "subscriptions/listen" ? reply(msg.id) : undefined;
  const rpc = (status: number, code: number, message: string) => (id: unknown) =>
    ({ status, body: { jsonrpc: "2.0", id, error: { code, message } } }) as Reply;
  const advertised = { tools: { listChanged: true } };

  it("fails as the server refusing a method it advertises, with no credited-status warning (before: 'not evaluable ... proves nothing')", async () => {
    // Before: FAIL "subscriptions/listen rejected with -32601 (HTTP 500); not
    // evaluable: a 5xx is a server failure or a gateway with no backend, so it
    // proves nothing about subscriptions/listen".
    const { report, seen } = await runStub(
      { capabilities: advertised, route: listenAnswer(rpc(500, -32601, "Method not found")) },
      [LISTEN],
    );
    expect(verdictOf(report, LISTEN)).toBe(
      "FAIL: subscriptions/listen rejected with -32601 (HTTP 500) although tools.listChanged advertised",
    );
    expect(listenWarnings(report)).toEqual([]);
    // No conformant twin is asked: a 5xx is not a 403.
    expect(count(seen, "server/discover")).toBe(2);
  }, 30_000);

  it("the same after one 429, resent", async () => {
    let listens = 0;
    const { report } = await runStub(
      {
        capabilities: advertised,
        route: listenAnswer((id) =>
          ++listens === 1
            ? { status: 429, text: "Too Many Requests", headers: { "Retry-After": "0" } }
            : rpc(500, -32601, "Method not found")(id),
        ),
      },
      [LISTEN],
    );
    expect(verdictOf(report, LISTEN)).toBe(
      "FAIL: subscriptions/listen rejected with -32601 (HTTP 429, then after 0ms HTTP 500) although tools.listChanged advertised",
    );
  }, 30_000);

  it("pins: a 5xx without -32601 fails as the server failing when advertised; a -32601 on a 5xx is credited with a warning when nothing is", async () => {
    // The gate reads a 5xx without the check's own code as the server failing
    // on the request (no "not evaluable"); with something advertised the
    // check has no own code, so the reason names none.
    const failed =
      "the server failed on the request rather than rejecting it (a broken server, or a gateway with no backend)";
    const internal = await runStub(
      { capabilities: advertised, route: listenAnswer(rpc(503, -32603, "Backend unavailable")) },
      [LISTEN],
    );
    expect(verdictOf(internal.report, LISTEN)).toBe(
      `FAIL: subscriptions/listen rejected with -32603 (HTTP 503); ${failed}`,
    );
    const bare = await runStub(
      { capabilities: advertised, route: listenAnswer(() => ({ status: 502, text: "Bad Gateway" })) },
      [LISTEN],
    );
    expect(verdictOf(bare.report, LISTEN)).toBe(`FAIL: subscriptions/listen rejected (HTTP 502); ${failed}`);
    const unadvertised = await runStub({ route: listenAnswer(rpc(500, -32601, "Method not found")) }, [LISTEN]);
    expect(verdictOf(unadvertised.report, LISTEN)).toBe(
      "PASS: nothing subscription-related advertised; subscriptions/listen rejected with -32601 (HTTP 500)",
    );
    expect(listenWarnings(unadvertised.report)).toEqual([
      `${LISTEN}: the server answered subscriptions/listen with its own JSON-RPC error -32601 on HTTP 500; a rejected request is a client error, so a 4xx status is expected (a 5xx tells clients and gateways the server failed)`,
    ]);
  }, 40_000);
});
