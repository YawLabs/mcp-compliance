import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthMetadataRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runComplianceSuite } from "../runner.js";

/**
 * Five 2025-11-25 checks brought to the reading their 2026-07-28 twins (or
 * the suite's own negative probes) already give:
 *
 * - security-cors-headers passed "OPTIONS request failed (no CORS,
 *   acceptable)" on ANY transport error, a server nothing answered included,
 *   and read only the preflight: it now reads the preflight and a ping
 *   carrying the same Origin, as the 2026-07-28 check reads its OPTIONS and
 *   POST probes;
 * - stdio-unicode never detected a mangled reply (it failed only when the
 *   tool call got no answer), and skipped a server with no tool to call;
 * - security-oauth-metadata fetched only the root well-known locations and
 *   ignored the challenge's resource_metadata URL;
 * - lifecycle-progress-token could never fail;
 * - lifecycle-reinit-reject failed a Host/Origin-worded 403 on the duplicate
 *   next to the served handshake, and every 5xx, the server's own -32600
 *   included, where the other negative probes credit both.
 */

type Report = Awaited<ReturnType<typeof runComplianceSuite>>;

/** "PASS: ..." / "FAIL: ..." with " (skipped)" when the pass measured nothing. */
function verdictsOf(report: Report): Record<string, string> {
  return Object.fromEntries(
    report.tests.map((t) => [t.id, `${t.passed ? "PASS" : "FAIL"}${t.skipped ? " (skipped)" : ""}: ${t.details}`]),
  );
}

// ---------------------------------------------------------------------------
// A 2025-11-25 HTTP server whose answer to each check's probe is a knob.
// ---------------------------------------------------------------------------

interface Hit {
  http: string;
  url: string;
  method?: string;
  authorization?: string;
  progressToken?: unknown;
  tool?: unknown;
  origin?: string;
}

interface HttpStubOptions {
  /** How the OPTIONS preflight is answered: a 204 with no CORS headers by default. */
  preflight?: "drop" | "hang" | "wildcard" | "reflect" | "restricted";
  /**
   * How a POST carrying an Origin header (security-cors-headers' second
   * probe) is answered: like any other POST by default; closed without an
   * answer, never answered, or answered with a wildcard grant or the Origin
   * reflected with Access-Control-Allow-Credentials.
   */
  originPost?: "drop" | "hang" | "wildcard" | "reflect-credentials";
  /** Every request, the handshake included, closed without an answer. */
  dropAll?: boolean;
  /**
   * How a second initialize is answered: like the first by default. The
   * server's own -32600 on HTTP 500, a -32603 on HTTP 500, an edge's bare
   * HTML 502, the Host guard's 403 "Invalid Host: ...", a rate limiter's
   * 429 every time, or an expired credential's 401.
   */
  reinit?: "own-500" | "other-500" | "html-502" | "host-403" | 429 | 401;
  /** A request without `Authorization: Bearer <token>` is answered 401 with `challenge`. */
  token?: string;
  /** The 401's WWW-Authenticate: `Bearer realm="mcp"` by default. */
  challenge?: string;
  /** The unauthenticated ping is never answered. */
  unauthPing?: "hang";
  /** GET <path> answered 200 with the JSON body; every other GET 404. */
  wellKnown?: Record<string, unknown>;
  /** tools/list's tools: one no-argument `count` tool by default. */
  tools?: unknown[];
  /**
   * The notifications/progress params a tools/call carrying a progressToken
   * streams ahead of its result ("no-params" sends one without params).
   */
  progress?: Array<Record<string, unknown> | "no-params">;
  /**
   * How a tools/call is answered: a result by default. A -32602 (on HTTP
   * 200) or a -32603 on HTTP 500 only when it carries a progressToken, a
   * -32603 on HTTP 500 always, a rate limiter's 429 or a gate's 401 on the
   * call carrying the token, or no answer to it. "cold": the first
   * tools/call, whatever it carries, answers -32603 on HTTP 200 (a backend
   * warming up), and every call after it is served.
   */
  progressCall?: "own-error-with-token" | "500-with-token" | "500-always" | 429 | 401 | "hang" | "cold";
}

async function startHttpStub(opts: HttpStubOptions): Promise<{ url: string; hits: Hit[]; stop(): Promise<void> }> {
  const hits: Hit[] = [];
  let initializes = 0;
  let toolCalls = 0;
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let msg: { id?: unknown; method?: string; params?: Record<string, any> } = {};
      try {
        msg = JSON.parse(text);
      } catch {}
      hits.push({
        http: req.method ?? "?",
        url: req.url ?? "",
        method: msg.method,
        authorization: req.headers.authorization,
        progressToken: msg.params?._meta?.progressToken,
        tool: msg.params?.name,
        origin: req.headers.origin,
      });
      if (opts.dropAll) return req.socket.destroy();
      /** Headers a POST carrying an Origin is answered with (originPost). */
      let grant: Record<string, string> = {};
      if (req.method === "POST" && req.headers.origin !== undefined) {
        switch (opts.originPost) {
          case "drop":
            return req.socket.destroy();
          case "hang":
            return;
          case "wildcard":
            grant = { "access-control-allow-origin": "*" };
            break;
          case "reflect-credentials":
            grant = {
              "access-control-allow-origin": String(req.headers.origin),
              "access-control-allow-credentials": "true",
            };
            break;
        }
      }
      const send = (status: number, body: string, headers: Record<string, string>) => {
        res.writeHead(status, { ...headers, ...grant });
        res.end(body);
      };
      const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
        send(status, JSON.stringify(body), { "content-type": "application/json", ...headers });
      const rpcError = (status: number, code: number, message: string, headers?: Record<string, string>) =>
        json(status, { jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } }, headers);
      const result = (r: unknown) => json(200, { jsonrpc: "2.0", id: msg.id, result: r });
      if (req.method === "OPTIONS") {
        switch (opts.preflight) {
          case "drop":
            return req.socket.destroy();
          case "hang":
            return;
          case "wildcard":
            return send(204, "", { "access-control-allow-origin": "*" });
          case "reflect":
            return send(204, "", { "access-control-allow-origin": String(req.headers.origin) });
          case "restricted":
            return send(204, "", { "access-control-allow-origin": "https://app.example.com" });
        }
        return send(204, "", {});
      }
      if (req.method === "GET") {
        const path = new URL(req.url ?? "/", "http://stub").pathname;
        const doc = opts.wellKnown?.[path];
        if (doc !== undefined) return json(200, doc);
        return json(404, { error: "not found" });
      }
      if (opts.token && req.headers.authorization !== `Bearer ${opts.token}`) {
        if (msg.method === "ping" && opts.unauthPing === "hang") return;
        return rpcError(401, -32001, "Unauthorized", {
          "www-authenticate": opts.challenge ?? 'Bearer realm="mcp"',
        });
      }
      if (msg.id === undefined) return send(202, "", {});
      const token = msg.params?._meta?.progressToken;
      switch (msg.method) {
        case "initialize":
          initializes++;
          if (initializes > 1) {
            switch (opts.reinit) {
              case "own-500":
                return rpcError(500, -32600, "Invalid Request: Server already initialized");
              case "other-500":
                return rpcError(500, -32603, "Internal error");
              case "html-502":
                return send(502, "<h1>502 Bad Gateway</h1>", { "content-type": "text/html" });
              case "host-403":
                return rpcError(403, -32000, "Invalid Host: mcp.internal.example");
              case 429:
                return send(429, "Too Many Requests", { "content-type": "text/plain", "retry-after": "0" });
              case 401:
                return rpcError(401, -32001, "Unauthorized", { "www-authenticate": 'Bearer error="invalid_token"' });
            }
          }
          return result({
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "small-gaps-stub", version: "1" },
          });
        case "ping":
          return result({});
        case "tools/list":
          return result({
            tools: opts.tools ?? [{ name: "count", description: "Counts to two", inputSchema: { type: "object" } }],
          });
        case "tools/call": {
          toolCalls++;
          switch (opts.progressCall) {
            case "cold":
              if (toolCalls === 1) return rpcError(200, -32603, "backend warming up, retry");
              break;
            case "hang":
              if (token !== undefined) return;
              break;
            case 429:
              if (token !== undefined) {
                return send(429, "Too Many Requests", { "content-type": "text/plain", "retry-after": "0" });
              }
              break;
            case 401:
              if (token !== undefined) {
                return rpcError(401, -32001, "Unauthorized", { "www-authenticate": 'Bearer error="invalid_token"' });
              }
              break;
            case "own-error-with-token":
              if (token !== undefined) return rpcError(200, -32602, "Invalid params: unrecognized key '_meta'");
              break;
            case "500-with-token":
              if (token !== undefined) return rpcError(500, -32603, "Internal error");
              break;
            case "500-always":
              return rpcError(500, -32603, "Internal error");
          }
          const answer = { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "2" }] } };
          if (token !== undefined && opts.progress) {
            const events = opts.progress.map((p) =>
              p === "no-params"
                ? { jsonrpc: "2.0", method: "notifications/progress" }
                : { jsonrpc: "2.0", method: "notifications/progress", params: p },
            );
            const body = [...events, answer].map((m) => `event: message\ndata: ${JSON.stringify(m)}\n\n`).join("");
            return send(200, body, { "content-type": "text/event-stream" });
          }
          return json(200, answer);
        }
      }
      return rpcError(200, -32601, "Method not found");
    });
  });
  const url = await new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(`http://127.0.0.1:${addr && typeof addr === "object" ? addr.port : 0}/mcp`);
    });
  });
  return {
    url,
    hits,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function runStub(
  stubOpts: HttpStubOptions,
  only: string[],
  runOpts: { timeout?: number; headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<{ byId: Record<string, string>; hits: Hit[]; warnings: string[]; url: string }> {
  const stub = await startHttpStub(stubOpts);
  try {
    const report = await runComplianceSuite(stub.url, {
      timeout: runOpts.timeout ?? 3000,
      specVersion: "2025-11-25",
      only,
      ...(runOpts.headers ? { headers: runOpts.headers } : {}),
      ...(runOpts.signal ? { signal: runOpts.signal } : {}),
    });
    return { byId: verdictsOf(report), hits: [...stub.hits], warnings: report.warnings, url: stub.url };
  } finally {
    await stub.stop();
  }
}

// ---------------------------------------------------------------------------
// security-cors-headers
// ---------------------------------------------------------------------------

describe("legacy security-cors-headers reads both CORS probes, and one that got no answer, as the 2026-07-28 check does", () => {
  const CORS = "security-cors-headers";
  const ORIGIN = "https://evil.example.com";
  const BOTH = "the OPTIONS preflight and the ping carrying the foreign Origin";

  it("a preflight never answered is no verdict on its own: the ping carrying the Origin is read (2026-07-28 passes it too)", async () => {
    // e957b07: PASS "OPTIONS request failed (no CORS, acceptable)".
    // Then: FAIL "server unreachable: the OPTIONS preflight got no response
    // within 1500ms" -- next to a served handshake and ping, for a server
    // that simply has no OPTIONS handler (MCP requires none).
    const { byId, hits } = await runStub({ preflight: "hang" }, [CORS], { timeout: 1500 });
    expect(byId[CORS]).toBe(
      "PASS: No CORS headers returned (OPTIONS failed, POST HTTP 200; server-to-server only, acceptable)",
    );
    // The second probe: a ping, the handshake's request, carrying the Origin.
    const withOrigin = hits.filter((h) => h.origin !== undefined);
    expect(withOrigin.map((h) => `${h.http} ${h.method ?? ""}`.trim())).toEqual(["OPTIONS", "POST ping"]);
    expect(withOrigin.every((h) => h.origin === ORIGIN)).toBe(true);
  }, 20_000);

  it("a preflight closed without an answer next to a served ping is read the same way", async () => {
    // e957b07: PASS "OPTIONS request failed (no CORS, acceptable)"; then
    // PASS "Connection closed without a response (...) on the OPTIONS
    // preflight; the initialize handshake ... was served (...)".
    const { byId } = await runStub({ preflight: "drop" }, [CORS]);
    expect(byId[CORS]).toBe(
      "PASS: No CORS headers returned (OPTIONS failed, POST HTTP 200; server-to-server only, acceptable)",
    );
  }, 20_000);

  it("a grant on the POST carrying the Origin FAILS even when the preflight carries none", async () => {
    // e957b07 and then: PASS "No CORS headers returned (server-to-server
    // only, acceptable)" -- only the preflight's headers were read.
    const wildcard = await runStub({ originPost: "wildcard" }, [CORS]);
    expect(wildcard.byId[CORS]).toBe(
      'FAIL: Access-Control-Allow-Origin is "*" (wildcard) on POST -- allows cross-origin credential theft',
    );
    const reflected = await runStub({ preflight: "hang", originPost: "reflect-credentials" }, [CORS], {
      timeout: 1500,
    });
    expect(reflected.byId[CORS]).toBe(
      "FAIL: Server reflects arbitrary Origin in CORS with Allow-Credentials on POST -- effectively wildcard",
    );
  }, 30_000);

  it("neither probe answered, the handshake served: a drop on both is cross-origin access refused, a timeout is 'server unreachable'", async () => {
    // e957b07: PASS "OPTIONS request failed (no CORS, acceptable)" for both.
    const dropped = await runStub({ preflight: "drop", originPost: "drop" }, [CORS]);
    expect(dropped.byId[CORS]).toBe(
      `PASS: Connection closed without a response on ${BOTH}; the initialize handshake, sent without an Origin, was served (cross-origin requests refused, no CORS headers to check)`,
    );
    const hung = await runStub({ preflight: "hang", originPost: "hang" }, [CORS], { timeout: 1500 });
    expect(hung.byId[CORS]).toBe(
      `FAIL: server unreachable: ${BOTH} got no response within 1500ms, so there are no CORS headers to check`,
    );
  }, 30_000);

  it("a server that closes every connection, the handshake's included, is 'server unreachable'", async () => {
    // e957b07: PASS "OPTIONS request failed (no CORS, acceptable)".
    const { byId } = await runStub({ dropAll: true }, [CORS], { timeout: 1500 });
    expect(byId[CORS]).toMatch(
      /^FAIL: server unreachable: the OPTIONS preflight (and the ping carrying the foreign Origin )?got no response \(connection closed: [^)]+\)(; the ping carrying the foreign Origin got no response \(connection closed: [^)]+\))?, so there are no CORS headers to check$/,
    );
  }, 20_000);

  it("nothing listening (a refused connection) is 'server unreachable'", async () => {
    // e957b07: PASS "OPTIONS request failed (no CORS, acceptable)".
    const closed = createServer();
    const port = await new Promise<number>((resolve) => {
      closed.listen(0, "127.0.0.1", () => {
        const addr = closed.address();
        resolve(addr && typeof addr === "object" ? addr.port : 0);
      });
    });
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const report = await runComplianceSuite(`http://127.0.0.1:${port}/mcp`, {
      timeout: 1500,
      specVersion: "2025-11-25",
      only: [CORS],
    });
    expect(verdictsOf(report)[CORS]).toMatch(
      new RegExp(
        `^FAIL: server unreachable: ${BOTH} got no response \\(connection failed: [^)]*ECONNREFUSED[^)]*\\), so there are no CORS headers to check$`,
      ),
    );
  }, 20_000);

  it("an abort while either probe waits is rethrown at once, not after its timeout", async () => {
    const reason = new Error("client went away");
    const hangs: HttpStubOptions[] = [{ preflight: "hang" }, { originPost: "hang" }];
    for (const opts of hangs) {
      const controller = new AbortController();
      const stub = await startHttpStub(opts);
      try {
        const started = Date.now();
        const run = runComplianceSuite(stub.url, {
          timeout: 10_000,
          specVersion: "2025-11-25",
          only: [CORS],
          signal: controller.signal,
        });
        // The handshake is served at once; the probe then hangs.
        setTimeout(() => controller.abort(reason), 300);
        await expect(run, JSON.stringify(opts)).rejects.toBe(reason);
        expect(Date.now() - started, JSON.stringify(opts)).toBeLessThan(4000);
      } finally {
        await stub.stop();
      }
    }
  }, 30_000);

  it("a preflight that is answered keeps its verdict; the details now name both probes", async () => {
    const verdict = async (preflight?: HttpStubOptions["preflight"]) =>
      (await runStub(preflight ? { preflight } : {}, [CORS])).byId[CORS];
    expect(await verdict()).toBe(
      "PASS: No CORS headers returned (OPTIONS HTTP 204, POST HTTP 200; server-to-server only, acceptable)",
    );
    expect(await verdict("wildcard")).toBe(
      'FAIL: Access-Control-Allow-Origin is "*" (wildcard) on OPTIONS -- allows cross-origin credential theft',
    );
    expect(await verdict("reflect")).toBe(
      "FAIL: Server reflects arbitrary Origin in CORS on OPTIONS -- effectively wildcard",
    );
    expect(await verdict("restricted")).toBe(
      "PASS: CORS restricted to: https://app.example.com (OPTIONS HTTP 204 ACAO=https://app.example.com, POST HTTP 200)",
    );
  }, 30_000);
});

// ---------------------------------------------------------------------------
// lifecycle-reinit-reject
// ---------------------------------------------------------------------------

describe("legacy lifecycle-reinit-reject reads the duplicate as the other negative probes read theirs", () => {
  const REINIT = "lifecycle-reinit-reject";

  it("the server's own -32600 on a 5xx is its rejection of the duplicate: credited, with a warning about the status", async () => {
    // Before: FAIL "HTTP 500, JSON-RPC error -32600 on the second
    // initialize -- not evaluable: a server error (or a gateway with no
    // backend) is a failure, not a rejection of the duplicate".
    const { byId, warnings } = await runStub({ reinit: "own-500" }, [REINIT]);
    expect(byId[REINIT]).toBe(
      "PASS: Re-initialization rejected with error: -32600 — Invalid Request: Server already initialized",
    );
    expect(warnings.filter((w) => w.startsWith(REINIT))).toEqual([
      "lifecycle-reinit-reject: the server rejected the duplicate initialize with JSON-RPC error -32600 on HTTP 500; credited, but a rejected request is a client error, so a 4xx status is expected (a 5xx tells clients and gateways the server failed).",
    ]);
  }, 20_000);

  it("a Host/Origin-worded 403 on the duplicate is decided by the served handshake: the duplicate's", async () => {
    // Before: FAIL 'HTTP 403, JSON-RPC error -32000 on the second initialize
    // ("Invalid Host: mcp.internal.example") -- not evaluable: the message
    // names Host/Origin validation, which refuses a request whatever it
    // carries' -- although the handshake, sent with the same Host, was served.
    const { byId } = await runStub({ reinit: "host-403" }, [REINIT]);
    expect(byId[REINIT]).toBe(
      "PASS: Re-initialization rejected with error: -32000 — Invalid Host: mcp.internal.example",
    );
  }, 20_000);

  it("a 5xx without the server's own code, and a repeated 429, still fail, in the wording the other probes use", async () => {
    const failed =
      "the server failed on the request rather than refusing it (a broken server, or a gateway with no backend), which is no rejection of the duplicate initialize";
    expect((await runStub({ reinit: "other-500" }, [REINIT])).byId[REINIT]).toBe(
      `FAIL: HTTP 500, JSON-RPC error -32603 on the second initialize -- ${failed}`,
    );
    expect((await runStub({ reinit: "html-502" }, [REINIT])).byId[REINIT]).toBe(
      `FAIL: HTTP 502 on the second initialize -- ${failed}`,
    );
    expect((await runStub({ reinit: 429 }, [REINIT])).byId[REINIT]).toBe(
      "FAIL: HTTP 429, then after 0ms HTTP 429 on the second initialize -- not evaluable: a rate limiter answered before the server read the request, so the duplicate initialize was never looked at",
    );
  }, 30_000);

  it("pins: an auth gate's 401 is not evaluable, and the server's own 4xx or a served duplicate read as before", async () => {
    expect((await runStub({ reinit: 401 }, [REINIT], { headers: { Authorization: "Bearer t" } })).byId[REINIT]).toBe(
      "FAIL: HTTP 401, JSON-RPC error -32001 on the second initialize -- not evaluable: an auth gate answered before the server read the request (credential rejected -- check --auth)",
    );
    expect((await runStub({}, [REINIT])).byId[REINIT]).toBe(
      "FAIL: Server accepted second initialize (HTTP 200) — should reject duplicate initialization",
    );
  }, 30_000);
});

// ---------------------------------------------------------------------------
// lifecycle-progress-token
// ---------------------------------------------------------------------------

describe("legacy lifecycle-progress-token judges the progress it receives, and a server that fails on the token", () => {
  const PROGRESS = "lifecycle-progress-token";
  const ONLY = ["tools-list", PROGRESS];
  const TOKEN = "compliance-progress-test";
  const calls = (hits: Hit[]) => hits.filter((h) => h.method === "tools/call");

  it("notifications/progress under another token FAILS (MUST reference the request's token)", async () => {
    // Before: PASS "Server sent progress notifications via SSE with progressToken".
    const { byId } = await runStub({ progress: [{ progressToken: "someone-else", progress: 1 }] }, ONLY);
    expect(byId[PROGRESS]).toBe(
      `FAIL: notifications/progress carries token "someone-else", expected "${TOKEN}" (tools/call count succeeded)`,
    );
  }, 20_000);

  it("progress that does not increase, is not a number, or has no params FAILS", async () => {
    // Before: PASS "Server sent progress notifications via SSE with progressToken", three times.
    const decreasing = await runStub(
      {
        progress: [
          { progressToken: TOKEN, progress: 2 },
          { progressToken: TOKEN, progress: 1 },
        ],
      },
      ONLY,
    );
    expect(decreasing.byId[PROGRESS]).toBe("FAIL: progress did not increase (2 -> 1) (tools/call count succeeded)");
    const text = await runStub({ progress: [{ progressToken: TOKEN, progress: "half" }] }, ONLY);
    expect(text.byId[PROGRESS]).toBe(
      'FAIL: notifications/progress progress "half" is not a number (tools/call count succeeded)',
    );
    const bare = await runStub({ progress: ["no-params"] }, ONLY);
    expect(bare.byId[PROGRESS]).toBe(
      "FAIL: notifications/progress without a params object (tools/call count succeeded)",
    );
  }, 30_000);

  it("progress under the request's token, increasing, passes and says what it saw", async () => {
    // Before: PASS "Server sent progress notifications via SSE with progressToken".
    const { byId } = await runStub(
      {
        progress: [
          { progressToken: TOKEN, progress: 0.5, total: 1 },
          { progressToken: TOKEN, progress: 1, total: 1 },
        ],
      },
      ONLY,
    );
    expect(byId[PROGRESS]).toBe(
      `PASS: 2 notifications/progress echoed token "${TOKEN}" with increasing progress (0.5, 1)`,
    );
  }, 20_000);

  it("a server error only on the call carrying the token FAILS: the same call without it was served, and the resent call failed again", async () => {
    // Before: PASS "HTTP 500 — tools/call with progressToken was not served
    // (no progress events observed — optional)" and PASS "Server accepted
    // request with progressToken (no progress events observed — optional)"
    // -- a server that fails every request carrying a progressToken.
    const tail =
      "when it was resent, while the same call without it, sent in between, was served -- the server failed the request because of its progress token (basic/utilities#progress lets a receiver ignore the token and send no notifications, not fail the request)";
    const on500 = await runStub({ progressCall: "500-with-token" }, ONLY);
    expect(on500.byId[PROGRESS]).toBe(
      `FAIL: HTTP 500, JSON-RPC error -32603 on tools/call count carrying _meta.progressToken, and HTTP 500, JSON-RPC error -32603 ${tail}`,
    );
    // The call with the token, the same call without it, then the call with
    // the token once more: the failure is reproduced before it is blamed.
    expect(calls(on500.hits).map((h) => h.progressToken)).toEqual([TOKEN, undefined, TOKEN]);
    const invalid = await runStub({ progressCall: "own-error-with-token" }, ONLY);
    expect(invalid.byId[PROGRESS]).toBe(
      `FAIL: HTTP 200, JSON-RPC error -32602 on tools/call count carrying _meta.progressToken, and HTTP 200, JSON-RPC error -32602 ${tail}`,
    );
  }, 30_000);

  it("a tool whose first call fails whatever it carries (a cold backend) is not blamed on the token", async () => {
    // e957b07: PASS "Server accepted request with progressToken (no progress
    // events observed — optional)", one call. Then: FAIL "HTTP 200, JSON-RPC
    // error -32603 on tools/call count carrying _meta.progressToken, while
    // the same call without it was served -- the server failed the request
    // because of its progress token (...)" -- the twin, sent second, was
    // served only because the backend had warmed up.
    const { byId, hits } = await runStub({ progressCall: "cold" }, ONLY);
    expect(byId[PROGRESS]).toBe(
      "PASS: Server accepted request with progressToken when it was resent: tools/call count first answered HTTP 200, JSON-RPC error -32603, then the same call without the token and the resent one were served (no progress events observed -- optional)",
    );
    expect(calls(hits).map((h) => h.progressToken)).toEqual([TOKEN, undefined, TOKEN]);
  }, 20_000);

  it("the resent call's progress is judged like the first's", async () => {
    // e957b07: PASS "Server accepted request with progressToken (no progress
    // events observed — optional)" for both; the first call failed before
    // any progress, and nothing else was sent.
    const foreign = await runStub(
      { progressCall: "cold", progress: [{ progressToken: "someone-else", progress: 1 }] },
      ONLY,
    );
    expect(foreign.byId[PROGRESS]).toBe(
      `FAIL: notifications/progress carries token "someone-else", expected "${TOKEN}" (tools/call count succeeded)`,
    );
    const echoed = await runStub({ progressCall: "cold", progress: [{ progressToken: TOKEN, progress: 1 }] }, ONLY);
    expect(echoed.byId[PROGRESS]).toBe(
      `PASS: 1 notifications/progress echoed token "${TOKEN}" with increasing progress (1)`,
    );
  }, 30_000);

  it("a server error on the call with or without the token stays an observation (the twin is asked)", async () => {
    const { byId, hits } = await runStub({ progressCall: "500-always" }, ONLY);
    expect(byId[PROGRESS]).toBe(
      "PASS: HTTP 500 — tools/call with progressToken was not served (no progress events observed — optional)",
    );
    expect(calls(hits).map((h) => h.progressToken)).toEqual([TOKEN, undefined]);
  }, 20_000);

  it("a rate limiter's 429 or an auth gate's 401 on the call is no server error: an observation, no twin asked", async () => {
    const throttled = await runStub({ progressCall: 429 }, ONLY);
    expect(throttled.byId[PROGRESS]).toBe(
      "PASS: HTTP 429 — tools/call with progressToken was not served (no progress events observed — optional)",
    );
    expect(calls(throttled.hits)).toHaveLength(1);
    const gated = await runStub({ progressCall: 401 }, ONLY);
    expect(gated.byId[PROGRESS]).toBe(
      "PASS: HTTP 401 — tools/call with progressToken was not served (no progress events observed — optional)",
    );
    expect(calls(gated.hits)).toHaveLength(1);
  }, 30_000);

  it("the tool called is one without required arguments that advertises progress, as the 2026-07-28 check picks it", async () => {
    // Before: the first listed tool, called with {} although it requires
    // an argument; the progress-reporting tool was never called.
    const { byId, hits } = await runStub(
      {
        tools: [
          {
            name: "lookup",
            description: "Looks a key up",
            inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
          },
          { name: "reindex", description: "Rebuilds the index, reporting progress", inputSchema: { type: "object" } },
        ],
        progress: [{ progressToken: TOKEN, progress: 1 }],
      },
      ONLY,
    );
    expect(calls(hits).map((h) => h.tool)).toEqual(["reindex"]);
    expect(byId[PROGRESS]).toBe(`PASS: 1 notifications/progress echoed token "${TOKEN}" with increasing progress (1)`);
  }, 20_000);

  it("a call nothing answers still measured nothing (a skip), and a caller's abort is rethrown at once", async () => {
    const hung = await runStub({ progressCall: "hang" }, ONLY, { timeout: 1500 });
    expect(hung.byId[PROGRESS]).toBe(
      "PASS (skipped): tools/call with progressToken got no response within 1500ms (no progress events observed -- optional)",
    );
    const controller = new AbortController();
    const reason = new Error("client went away");
    const stub = await startHttpStub({ progressCall: "hang" });
    try {
      const started = Date.now();
      const run = runComplianceSuite(stub.url, {
        timeout: 10_000,
        specVersion: "2025-11-25",
        only: ONLY,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(reason), 400);
      await expect(run).rejects.toBe(reason);
      // Before: the call ignored the signal and waited out the 10 s timeout.
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      await stub.stop();
    }
  }, 30_000);
});

/**
 * An SDK v1 sessionful Streamable HTTP server with one no-argument tool,
 * `count`, that streams notifications/progress built by `progressFor` from
 * the token its call carried (nothing when it returns an empty list).
 */
async function startSdkProgressServer(
  progressFor: (token: string | number) => Array<{ progressToken: string | number; progress: number }>,
): Promise<{ url: string; stop(): Promise<void> }> {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const server: Server = createServer(async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const known = sessionId ? transports.get(sessionId) : undefined;
    if (known) {
      await known.handleRequest(req, res);
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(sessionId ? 404 : 405);
      res.end();
      return;
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    const mcp = new McpServer({ name: "sdk-progress", version: "1.0.0" });
    mcp.tool("count", "Counts to two", async (extra) => {
      const token = extra._meta?.progressToken;
      if (token !== undefined) {
        for (const params of progressFor(token)) {
          await extra.sendNotification({ method: "notifications/progress", params });
        }
      }
      return { content: [{ type: "text", text: "2" }] };
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
    if (transport.sessionId) transports.set(transport.sessionId, transport);
  });
  const url = await new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(`http://127.0.0.1:${addr && typeof addr === "object" ? addr.port : 0}/mcp`);
    });
  });
  return {
    url,
    stop: async () => {
      for (const t of transports.values()) await t.close().catch(() => {});
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}

describe("legacy lifecycle-progress-token against an SDK v1 server", () => {
  const PROGRESS = "lifecycle-progress-token";
  const run = async (progressFor: Parameters<typeof startSdkProgressServer>[0]) => {
    const sdk = await startSdkProgressServer(progressFor);
    try {
      const report = await runComplianceSuite(sdk.url, {
        timeout: 5000,
        specVersion: "2025-11-25",
        only: ["tools-list", "tools-call", PROGRESS],
      });
      return verdictsOf(report);
    } finally {
      await sdk.stop();
    }
  };

  it("a tool that streams its progress under the request's token passes, naming the values", async () => {
    const byId = await run((token) => [
      { progressToken: token, progress: 1 },
      { progressToken: token, progress: 2 },
    ]);
    expect(byId[PROGRESS]).toBe(
      'PASS: 2 notifications/progress echoed token "compliance-progress-test" with increasing progress (1, 2)',
    );
  }, 20_000);

  it("a tool that reports its progress under a token of its own FAILS (before: PASS)", async () => {
    const byId = await run(() => [{ progressToken: "job-17", progress: 1 }]);
    expect(byId[PROGRESS]).toBe(
      'FAIL: notifications/progress carries token "job-17", expected "compliance-progress-test" (tools/call count succeeded)',
    );
  }, 20_000);

  it("a tool that reports no progress keeps its pass", async () => {
    const byId = await run(() => []);
    expect(byId[PROGRESS]).toBe(
      "PASS: Server accepted request with progressToken (no progress events observed — optional)",
    );
    expect(byId["tools-call"]).toBe("PASS: Returned 1 content item(s)");
  }, 20_000);
});

// ---------------------------------------------------------------------------
// security-oauth-metadata
// ---------------------------------------------------------------------------

describe("legacy security-oauth-metadata looks for Protected Resource Metadata as a client must", () => {
  const OAUTH = "security-oauth-metadata";
  const AUTH = { Authorization: "Bearer tok-51c2" };
  const prmFor = (resource: string) => ({ resource, authorization_servers: ["https://auth.example.com"] });

  it("a document advertised by resource_metadata is found there; one the challenge does not name, on the endpoint's path, is found without it", async () => {
    const advertised = await lookupWithOrigin((origin) => ({
      challenge: `Bearer realm="mcp", resource_metadata="${origin}/meta/prm.json"`,
      wellKnown: { "/meta/prm.json": prmFor(`${origin}/mcp`) },
    }));
    // Before: FAIL "PRM endpoint returned HTTP 404 and no legacy OAuth metadata found".
    expect(advertised.byId[OAUTH]).toBe(
      `PASS: Protected Resource Metadata found at /meta/prm.json (via WWW-Authenticate): resource=${advertised.origin}/mcp, 1 auth server(s)`,
    );
    const onPath = await lookupWithOrigin((origin) => ({
      wellKnown: { "/.well-known/oauth-protected-resource/mcp": prmFor(`${origin}/mcp`) },
    }));
    // Before: FAIL "PRM endpoint returned HTTP 404 and no legacy OAuth metadata found".
    expect(onPath.byId[OAUTH]).toBe(
      `PASS: Protected Resource Metadata found at /.well-known/oauth-protected-resource/mcp: resource=${onPath.origin}/mcp, 1 auth server(s)`,
    );
    // Path first, then the root: a server with only the root document is read there.
    const atRoot = await lookupWithOrigin((origin) => ({
      wellKnown: { "/.well-known/oauth-protected-resource": prmFor(`${origin}/mcp`) },
    }));
    expect(atRoot.byId[OAUTH]).toBe(
      `PASS: Protected Resource Metadata found at /.well-known/oauth-protected-resource: resource=${atRoot.origin}/mcp, 1 auth server(s)`,
    );
    expect(atRoot.hits.filter((h) => h.http === "GET").map((h) => h.url)).toEqual([
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-protected-resource",
    ]);
  }, 30_000);

  it("an advertised URL that does not serve the document FAILS, even with a valid one at a well-known location", async () => {
    // Before: PASS "Protected Resource Metadata found: ..." from the root
    // document, which a client told to use the challenge URL never fetches.
    const { byId } = await lookupWithOrigin((origin) => ({
      challenge: `Bearer realm="mcp", resource_metadata="${origin}/meta/missing.json"`,
      wellKnown: { "/.well-known/oauth-protected-resource": prmFor(`${origin}/mcp`) },
    }));
    expect(byId[OAUTH]).toBe(
      "FAIL: WWW-Authenticate resource_metadata /meta/missing.json answered HTTP 404 -- clients MUST use the advertised URL, not the well-known fallback; valid document at /.well-known/oauth-protected-resource",
    );
    // Before: PASS from the root document too.
    const relative = await lookupWithOrigin((origin) => ({
      challenge: 'Bearer realm="mcp", resource_metadata="/.well-known/oauth-protected-resource"',
      wellKnown: { "/.well-known/oauth-protected-resource": prmFor(`${origin}/mcp`) },
    }));
    expect(relative.byId[OAUTH]).toBe(
      'FAIL: WWW-Authenticate resource_metadata "/.well-known/oauth-protected-resource" is not an absolute http(s) URL (RFC 9728 section 5.1) -- clients MUST use the advertised URL and cannot fetch this one',
    );
  }, 30_000);

  it("a document whose resource is not the endpoint passes with a warning; a malformed one FAILS", async () => {
    const other = await lookupWithOrigin(() => ({
      wellKnown: { "/.well-known/oauth-protected-resource/mcp": prmFor("https://api.example.com/other") },
    }));
    expect(other.byId[OAUTH]).toBe(
      "PASS: Protected Resource Metadata found at /.well-known/oauth-protected-resource/mcp: resource=https://api.example.com/other, 1 auth server(s) (resource does not match the endpoint, see warning)",
    );
    // Before: no warning (and the document was never found).
    expect(other.warnings.filter((w) => w.startsWith(OAUTH))).toEqual([
      `security-oauth-metadata: the Protected Resource Metadata at /.well-known/oauth-protected-resource/mcp names resource "https://api.example.com/other", which is not the MCP endpoint ${other.origin}/mcp in canonical form; RFC 9728 section 3.3 has clients discard metadata whose resource does not match the URL they used.`,
    ]);
    const malformed = await lookupWithOrigin((origin) => ({
      wellKnown: { "/.well-known/oauth-protected-resource/mcp": { resource: `${origin}/mcp` } },
    }));
    // Before: FAIL "PRM endpoint returned HTTP 404 and no legacy OAuth metadata found".
    expect(malformed.byId[OAUTH]).toBe(
      "FAIL: PRM document at /.well-known/oauth-protected-resource/mcp is missing the 'authorization_servers' array",
    );
  }, 30_000);

  it("no document anywhere names every location tried; a legacy authorization-server document passes with a warning", async () => {
    const none = await lookupWithOrigin(() => ({}));
    // Before: FAIL "PRM endpoint returned HTTP 404 and no legacy OAuth metadata found".
    expect(none.byId[OAUTH]).toBe(
      "FAIL: No Protected Resource Metadata (/.well-known/oauth-protected-resource/mcp -> HTTP 404; /.well-known/oauth-protected-resource -> HTTP 404) and no legacy OAuth metadata",
    );
    const legacy = await lookupWithOrigin(() => ({
      wellKnown: {
        "/.well-known/oauth-authorization-server": {
          issuer: "https://auth.example.com",
          token_endpoint: "https://auth.example.com/token",
        },
      },
    }));
    expect(legacy.byId[OAUTH]).toBe(
      "PASS: Legacy OAuth AS metadata found: issuer=https://auth.example.com (should migrate to PRM)",
    );
    expect(legacy.warnings).toContain(
      "Server uses legacy /.well-known/oauth-authorization-server instead of /.well-known/oauth-protected-resource (RFC 9728). Update to PRM for 2025-11-25 compliance.",
    );
  }, 30_000);

  it("an unauthenticated ping nothing answers is 'server unreachable'; the lookup is not guessed at", async () => {
    // Before: the check sent no such ping, and failed "PRM endpoint returned
    // HTTP 404 and no legacy OAuth metadata found".
    const { byId } = await runStub({ token: "tok-51c2", unauthPing: "hang" }, [OAUTH], {
      headers: AUTH,
      timeout: 1500,
    });
    expect(byId[OAUTH]).toBe("FAIL: server unreachable: the unauthenticated ping got no response within 1500ms");
  }, 20_000);

  it("the unauthenticated ping is the one security-auth-required sends: a run with both sends it once", async () => {
    const { byId, hits } = await lookupWithOrigin(() => ({}), ["security-auth-required", OAUTH]);
    expect(byId["security-auth-required"]).toBe("PASS: HTTP 401 (unauthenticated request rejected)");
    expect(hits.filter((h) => h.method === "ping" && h.authorization === undefined)).toHaveLength(1);
  }, 20_000);

  /** Run the lookup against a stub whose documents name its own origin. */
  async function lookupWithOrigin(
    stubOpts: (origin: string) => Omit<HttpStubOptions, "token">,
    only = [OAUTH],
  ): Promise<{ byId: Record<string, string>; hits: Hit[]; warnings: string[]; origin: string }> {
    // The origin is only known once the stub listens, so its options are
    // filled in after start (the stub reads them per request).
    const holder: HttpStubOptions = { token: "tok-51c2" };
    const stub = await startHttpStub(holder);
    const origin = new URL(stub.url).origin;
    Object.assign(holder, stubOpts(origin));
    try {
      const report = await runComplianceSuite(stub.url, {
        timeout: 3000,
        specVersion: "2025-11-25",
        only,
        headers: AUTH,
      });
      return { byId: verdictsOf(report), hits: [...stub.hits], warnings: report.warnings, origin };
    } finally {
      await stub.stop();
    }
  }
});

/**
 * The SDK v1's own OAuth resource-server deployment, as its docs set it up:
 * mcpAuthMetadataRouter publishes the Protected Resource Metadata at the
 * endpoint-path well-known location (and the authorization server's
 * metadata at the root), and requireBearerAuth answers a missing token 401
 * with a challenge naming that document in resource_metadata -- unless
 * `advertise` is false. Express is loaded untyped (no @types/express here).
 */
async function startSdkOAuthServer(advertise: boolean): Promise<{ url: string; stop(): Promise<void> }> {
  const require = createRequire(import.meta.url);
  const express = require("express") as () => any;
  const transports = new Map<string, StreamableHTTPServerTransport>();
  let app: any = null;
  const server: Server = createServer((req, res) => app(req, res));
  const url = await new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(`http://127.0.0.1:${addr && typeof addr === "object" ? addr.port : 0}/mcp`);
    });
  });
  const resourceServerUrl = new URL(url);
  app = express();
  app.use(
    mcpAuthMetadataRouter({
      oauthMetadata: {
        issuer: "https://auth.example.com/",
        authorization_endpoint: "https://auth.example.com/authorize",
        token_endpoint: "https://auth.example.com/token",
        response_types_supported: ["code"],
      },
      resourceServerUrl,
    }),
  );
  const verifier = {
    verifyAccessToken: async (token: string) => {
      if (token !== "sdk-good-token") throw new InvalidTokenError("Unknown token");
      return { token, clientId: "compliance", scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 3600 };
    },
  };
  app.all(
    "/mcp",
    requireBearerAuth({
      verifier,
      ...(advertise ? { resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl) } : {}),
    }),
    async (req: IncomingMessage, res: ServerResponse) => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      const known = sessionId ? transports.get(sessionId) : undefined;
      if (known) return known.handleRequest(req, res);
      if (req.method !== "POST") {
        res.writeHead(sessionId ? 404 : 405);
        res.end();
        return;
      }
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
      const mcp = new McpServer({ name: "sdk-oauth", version: "1.0.0" });
      mcp.tool("count", "Counts to two", async () => ({ content: [{ type: "text", text: "2" }] }));
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
      if (transport.sessionId) transports.set(transport.sessionId, transport);
    },
  );
  return {
    url,
    stop: async () => {
      for (const t of transports.values()) await t.close().catch(() => {});
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}

describe("legacy security-oauth-metadata against the SDK v1's own resource-server setup", () => {
  const OAUTH = "security-oauth-metadata";
  const run = async (advertise: boolean) => {
    const sdk = await startSdkOAuthServer(advertise);
    try {
      const report = await runComplianceSuite(sdk.url, {
        timeout: 5000,
        specVersion: "2025-11-25",
        only: ["security-auth-required", OAUTH],
        headers: { Authorization: "Bearer sdk-good-token" },
      });
      return { byId: verdictsOf(report), warnings: report.warnings, url: sdk.url };
    } finally {
      await sdk.stop();
    }
  };

  it("finds the document the SDK's challenge advertises (before: PASS on the legacy AS document, warning to migrate to PRM)", async () => {
    const { byId, warnings, url } = await run(true);
    expect(byId["security-auth-required"]).toBe("PASS: HTTP 401 (unauthenticated request rejected)");
    expect(byId[OAUTH]).toBe(
      `PASS: Protected Resource Metadata found at /.well-known/oauth-protected-resource/mcp (via WWW-Authenticate): resource=${url}, 1 auth server(s)`,
    );
    expect(warnings.filter((w) => w.includes("oauth"))).toEqual([]);
  }, 30_000);

  it("finds it on the endpoint's path when the challenge does not name it (before: the same legacy PASS)", async () => {
    const { byId, warnings, url } = await run(false);
    expect(byId[OAUTH]).toBe(
      `PASS: Protected Resource Metadata found at /.well-known/oauth-protected-resource/mcp: resource=${url}, 1 auth server(s)`,
    );
    expect(warnings.filter((w) => w.includes("oauth"))).toEqual([]);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// stdio-unicode
// ---------------------------------------------------------------------------

/**
 * A 2025-11-25 stdio server. TOOL: "echo" (echoes `message`), "silent" (one
 * `get_time` tool that ignores its arguments), "strict" (`get_time`
 * rejecting any argument with -32602), "empty" (tools declared, none
 * listed) or "none" (no tools capability). MODE: how the echo reply treats
 * the non-ASCII characters -- "latin1" (UTF-8 bytes decoded as Latin-1),
 * "fffd", "question", "strip", "tokenize" (the words joined by "|") --
 * "parse-error" (every tools/call answered -32700), "exit-on-unicode" (the
 * process exits with code 7 on any line carrying a non-ASCII character), or
 * "ping-meta-reject" (a ping carrying _meta answered -32602).
 */
const UNICODE_SERVER = `
import { createInterface } from "node:readline";
const tool = process.env.TOOL ?? "echo";
const mode = process.env.MODE ?? "";
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY }).on("line", (line) => {
  if (!line.trim()) return;
  if (mode === "exit-on-unicode" && /[^\\x00-\\x7f]/.test(line)) process.exit(7);
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return;
  const reply = (result) => send({ jsonrpc: "2.0", id: msg.id, result });
  const fail = (code, message) => send({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: "2025-11-25",
        capabilities: tool === "none" ? {} : { tools: {} },
        serverInfo: { name: "unicode-fixture", version: "1" },
      });
    case "ping":
      if (mode === "ping-meta-reject" && msg.params && msg.params._meta) return fail(-32602, "Invalid params: _meta");
      return reply({});
    case "tools/list":
      if (tool === "none") break;
      if (tool === "empty") return reply({ tools: [] });
      if (tool === "echo") {
        return reply({ tools: [{ name: "echo", description: "Echo a message", inputSchema: { type: "object", properties: { message: { type: "string" } } } }] });
      }
      return reply({ tools: [{ name: "get_time", description: "Returns the time", inputSchema: { type: "object", properties: {}, additionalProperties: tool !== "strict" } }] });
    case "tools/call": {
      if (tool === "none") break;
      if (mode === "parse-error") return fail(-32700, "Parse error");
      if (tool === "strict") return fail(-32602, "Invalid params: get_time takes no arguments");
      if (tool !== "echo") return reply({ content: [{ type: "text", text: "12:00" }] });
      const m = String((msg.params && msg.params.arguments && msg.params.arguments.message) ?? "");
      let text = m;
      if (mode === "latin1") text = Buffer.from(m, "utf8").toString("latin1");
      if (mode === "fffd") text = m.replace(/[^\\x00-\\x7f]/gu, "\\uFFFD");
      if (mode === "question") text = m.replace(/[^\\x00-\\x7f]/gu, "?");
      if (mode === "strip") text = m.replace(/[^\\x00-\\x7f]/gu, "");
      if (mode === "tokenize") text = m.split(" ").join("|");
      return reply({ content: [{ type: "text", text }] });
    }
  }
  fail(-32601, "Method not found");
});
`;

describe("legacy stdio-unicode judges the round trip as the 2026-07-28 check does", () => {
  const UNICODE = "stdio-unicode";
  let dir: string;
  let script: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "mcp-legacy-unicode-gaps-"));
    script = join(dir, "server.mjs");
    writeFileSync(script, UNICODE_SERVER);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function overStdio(env: Record<string, string>, only = ["tools-list", UNICODE]) {
    const report = await runComplianceSuite(
      { type: "stdio", command: process.execPath, args: [script], env },
      { timeout: 5000, startupTimeout: 10_000, specVersion: "2025-11-25", only },
    );
    return { byId: verdictsOf(report), warnings: report.warnings };
  }

  it("a reply that echoes the probe intact passes, byte-for-byte or piece by piece", async () => {
    // Before: PASS "Unicode string round-tripped through tool call", and
    // PASS "Tool echoed something, but not the exact probe — likely still
    // UTF-8-safe" for the tokenized reply.
    expect((await overStdio({ TOOL: "echo" })).byId[UNICODE]).toBe(
      "PASS: tools/call echo reproduced the CJK/emoji probe byte-for-byte",
    );
    expect((await overStdio({ TOOL: "echo", MODE: "tokenize" })).byId[UNICODE]).toBe(
      "PASS: tools/call echo reproduced every non-ASCII piece of the CJK/emoji probe (split across the reply, not byte-for-byte)",
    );
  }, 30_000);

  it("a mangled reply FAILS, naming the evidence (before: PASS 'Tool echoed something ... likely still UTF-8-safe')", async () => {
    expect((await overStdio({ TOOL: "echo", MODE: "latin1" })).byId[UNICODE]).toMatch(
      /^FAIL: tools\/call echo mangled the CJK\/emoji probe: the reply carries the probe decoded as Latin-1 \(h\\u00c3\\u00a9llo\) \(got ".*"\)$/,
    );
    expect((await overStdio({ TOOL: "echo", MODE: "fffd" })).byId[UNICODE]).toBe(
      'FAIL: tools/call echo mangled the CJK/emoji probe: the reply carries U+FFFD replacement characters (got "h?llo ?? ?")',
    );
    expect((await overStdio({ TOOL: "echo", MODE: "question" })).byId[UNICODE]).toBe(
      `FAIL: tools/call echo mangled the CJK/emoji probe: the reply carries the probe with its non-ASCII characters replaced by '?' (got "h?llo ?? ?")`,
    );
    expect((await overStdio({ TOOL: "echo", MODE: "strip" })).byId[UNICODE]).toBe(
      'FAIL: tools/call echo mangled the CJK/emoji probe: the reply carries the probe with its CJK/emoji characters dropped (got "hllo ")',
    );
    expect((await overStdio({ TOOL: "echo", MODE: "parse-error" })).byId[UNICODE]).toBe(
      "FAIL: tools/call echo with a CJK/emoji argument -> -32700 parse error",
    );
  }, 60_000);

  it("a tool that does not echo leaves the verdict to a ping carrying the probe in _meta", async () => {
    // Before: PASS "Tool echoed something, but not the exact probe — likely
    // still UTF-8-safe" -- whatever the server did with the characters.
    expect((await overStdio({ TOOL: "silent" })).byId[UNICODE]).toBe(
      "PASS: tools/call get_time did not echo the probe; envelope round-trip verified: ping answered a request whose _meta carries CJK/emoji (no echo path to compare byte-for-byte)",
    );
    expect((await overStdio({ TOOL: "strict" })).byId[UNICODE]).toBe(
      "PASS: tools/call get_time rejected the probe (JSON-RPC error -32602); envelope round-trip verified: ping answered a request whose _meta carries CJK/emoji (no echo path to compare byte-for-byte)",
    );
    expect((await overStdio({ TOOL: "silent", MODE: "ping-meta-reject" })).byId[UNICODE]).toBe(
      "FAIL: tools/call get_time did not echo the probe; ping with a CJK/emoji _meta value -> JSON-RPC error -32602",
    );
  }, 60_000);

  it("with no tool to call the ping decides alone (before: skipped, no unicode sent)", async () => {
    // Before: PASS (skipped) "Skipped: server declares no tools, so there is
    // no tool call to carry the unicode probe" and PASS (skipped) "tools/list
    // returned successfully (no tools to probe with unicode)".
    const envelope =
      "PASS: envelope round-trip verified: ping answered a request whose _meta carries CJK/emoji (no echo path to compare byte-for-byte)";
    expect((await overStdio({ TOOL: "none" }, [UNICODE])).byId[UNICODE]).toBe(envelope);
    expect((await overStdio({ TOOL: "empty" })).byId[UNICODE]).toBe(envelope);
    expect((await overStdio({ TOOL: "none", MODE: "ping-meta-reject" }, [UNICODE])).byId[UNICODE]).toBe(
      "FAIL: ping with a CJK/emoji _meta value -> JSON-RPC error -32602",
    );
  }, 60_000);

  it("a filtered run without tools-list still reads the list and calls the echo tool", async () => {
    // Before: PASS (skipped) "tools/list returned successfully (no tools to probe with unicode)".
    expect((await overStdio({ TOOL: "echo" }, [UNICODE])).byId[UNICODE]).toBe(
      "PASS: tools/call echo reproduced the CJK/emoji probe byte-for-byte",
    );
  }, 30_000);

  it("a child that exits on the probe FAILS in one line and is restarted, so the check after it measures the server", async () => {
    // Before: FAIL "tools/call threw — stdio transport: ..." with the
    // child's stderr appended, and stdio-unknown-method-recovers failed too,
    // against the dead child.
    const { byId, warnings } = await overStdio({ TOOL: "echo", MODE: "exit-on-unicode" }, [
      "tools-list",
      UNICODE,
      "stdio-unknown-method-recovers",
    ]);
    expect(byId[UNICODE]).toBe("FAIL: tools/call echo with a CJK/emoji argument got no reply (server exited (code 7))");
    expect(byId["stdio-unknown-method-recovers"]).toBe(
      "PASS: Unknown method returned JSON-RPC error; subsequent ping succeeded",
    );
    expect(warnings.filter((w) => w.startsWith(UNICODE))).toEqual([
      "stdio-unicode: the server exited on tools/call echo with a CJK/emoji argument and was restarted with a fresh initialize handshake, so the tests after it ran against the new instance.",
    ]);
    // The same through the ping, when there is no tool to call.
    const bare = await overStdio({ TOOL: "none", MODE: "exit-on-unicode" }, [UNICODE, "stdio-unknown-method-recovers"]);
    expect(bare.byId[UNICODE]).toBe("FAIL: ping with a CJK/emoji _meta value got no reply (server exited (code 7))");
    expect(bare.byId["stdio-unknown-method-recovers"]).toBe(
      "PASS: Unknown method returned JSON-RPC error; subsequent ping succeeded",
    );
    expect(bare.warnings.filter((w) => w.startsWith(UNICODE))).toEqual([
      "stdio-unicode: the server exited on ping with a CJK/emoji _meta value and was restarted with a fresh initialize handshake, so the tests after it ran against the new instance.",
    ]);
  }, 60_000);
});

describe("legacy stdio-unicode against the official SDKs' stdio servers with a tool that does not echo", () => {
  const UNICODE = "stdio-unicode";
  let dir: string;
  const require = createRequire(import.meta.url);
  /** The ESM build of a package entry require.resolve finds (its CJS build otherwise). */
  const esm = (specifier: string) =>
    pathToFileURL(
      require
        .resolve(specifier)
        .replace(/([\\/])cjs([\\/])/, "$1esm$2")
        .replace(/\.cjs$/, ".mjs"),
    ).href;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "mcp-legacy-unicode-sdk-"));
    writeFileSync(
      join(dir, "sdk1.mjs"),
      [
        `import { McpServer } from ${JSON.stringify(esm("@modelcontextprotocol/sdk/server/mcp.js"))};`,
        `import { StdioServerTransport } from ${JSON.stringify(esm("@modelcontextprotocol/sdk/server/stdio.js"))};`,
        'const mcp = new McpServer({ name: "sdk1-stdio-clock", version: "1.0.0" });',
        'mcp.tool("get_time", "Returns the time", async () => ({ content: [{ type: "text", text: "12:00" }] }));',
        "await mcp.connect(new StdioServerTransport());",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "sdk2.mjs"),
      [
        `import { McpServer } from ${JSON.stringify(esm("@modelcontextprotocol/server"))};`,
        `import { serveStdio } from ${JSON.stringify(esm("@modelcontextprotocol/server/stdio"))};`,
        "serveStdio(() => {",
        '  const mcp = new McpServer({ name: "sdk2-stdio-clock", version: "2.0.0" });',
        '  mcp.registerTool("get_time", { description: "Returns the time" }, async () => ({ content: [{ type: "text", text: "12:00" }] }));',
        "  return mcp;",
        '}, { legacy: "serve" });',
      ].join("\n"),
    );
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const run = async (file: string) => {
    const report = await runComplianceSuite(
      { type: "stdio", command: process.execPath, args: [join(dir, file)] },
      {
        timeout: 5000,
        startupTimeout: 15_000,
        specVersion: "2025-11-25",
        only: ["tools-list", UNICODE, "stdio-unknown-method-recovers"],
      },
    );
    return verdictsOf(report);
  };

  it("SDK v1: the SDK answers the ping carrying the probe in _meta, so the envelope round-trip passes", async () => {
    // Before: PASS "Tool echoed something, but not the exact probe — likely still UTF-8-safe".
    const byId = await run("sdk1.mjs");
    expect(byId[UNICODE]).toBe(
      "PASS: tools/call get_time did not echo the probe; envelope round-trip verified: ping answered a request whose _meta carries CJK/emoji (no echo path to compare byte-for-byte)",
    );
    expect(byId["stdio-unknown-method-recovers"]).toMatch(/^PASS: /);
  }, 60_000);

  it("SDK v2 (legacy: serve): the same", async () => {
    // Before: PASS "Tool echoed something, but not the exact probe — likely still UTF-8-safe".
    const byId = await run("sdk2.mjs");
    expect(byId[UNICODE]).toBe(
      "PASS: tools/call get_time did not echo the probe; envelope round-trip verified: ping answered a request whose _meta carries CJK/emoji (no echo path to compare byte-for-byte)",
    );
    expect(byId["stdio-unknown-method-recovers"]).toMatch(/^PASS: /);
  }, 60_000);
});
