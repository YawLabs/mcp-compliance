import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runComplianceSuite } from "../runner.js";

/**
 * The 2025-11-25 checks that send a request carrying one defect -- a
 * text/plain body (transport-content-type-reject), a batch
 * (transport-batch-reject), an initialize requesting an unknown protocol
 * version (lifecycle-version-negotiate), an unknown method
 * (error-unknown-method) -- and pass on a rejection. They used to credit
 * any rejection, whoever gave it: a gateway answering 401 to every request
 * earned four passes (the review's 401-everything gateway scored D/57 with
 * 43 passes). A rejection now counts only when it is attributable to the
 * defect, read the way lifecycle-reinit-reject reads the duplicate
 * initialize, and lifecycle-version-negotiate reads a missing answer the way
 * security-extra-params does instead of passing it as "Connection rejected
 * for unknown version (acceptable)".
 */

type Answer =
  | 400
  | 415
  | 401
  | "bearer-403"
  | "host-403"
  | "bare-403"
  | 429
  | "429-once"
  | 503
  | "rpc-503"
  | "own-500"
  | "custom-500"
  | "host-worded-403"
  | "drop"
  | "hang"
  | "not-http";

type Probe = "textPlain" | "batch" | "init" | "future" | "unknown" | "ping" | "other";

interface StubOptions {
  /**
   * A gate in front of the server: answers every request that does not
   * carry `Bearer <token>` (every request, when no token is set) and whose
   * JSON-RPC method is not in `exempt`.
   */
  gate?: Answer;
  token?: string;
  exempt?: string[];
  /** The handshake (an initialize requesting 2025-11-25): served by default. */
  init?: Answer;
  /** A POST with Content-Type text/plain: 415 by default. */
  textPlain?: Answer;
  /** A JSON array body: 400 with an id-null -32600 by default; "rpc-200" answers that error on 200, "process" answers each element. */
  batch?: Answer | "rpc-200" | "process";
  /** An initialize requesting 2099-01-01: negotiated down to 2025-11-25 by default; "rpc-200" answers -32602 on 200. */
  future?: Answer | "rpc-200";
  /** nonexistent/method: -32601 on 200 by default; "rpc-404" answers it on 404. */
  unknown?: Answer | "rpc-404";
  /** A ping: served by default. */
  ping?: Answer;
  /** Called when the initialize requesting 2099-01-01 arrives, before it is answered. */
  onFuture?: () => void;
}

/**
 * A stateless 2025-11-25 HTTP server whose answer to each of the four
 * probes (and to the handshake and a ping, the probes' conformant twins) is
 * a knob, behind an optional gate. Records which probe every POST was.
 */
async function startStub(opts: StubOptions): Promise<{ url: string; hits: Probe[]; stop(): Promise<void> }> {
  const hits: Probe[] = [];
  const throttledOnce = new Set<Probe>();
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let msg: unknown;
      try {
        msg = JSON.parse(text);
      } catch {}
      const one = (Array.isArray(msg) ? {} : (msg ?? {})) as {
        id?: unknown;
        method?: string;
        params?: { protocolVersion?: string };
      };
      const textPlain = String(req.headers["content-type"] ?? "").startsWith("text/plain");
      const probe: Probe = textPlain
        ? "textPlain"
        : Array.isArray(msg)
          ? "batch"
          : one.method === "initialize"
            ? one.params?.protocolVersion === "2099-01-01"
              ? "future"
              : "init"
            : one.method === "nonexistent/method"
              ? "unknown"
              : one.method === "ping"
                ? "ping"
                : "other";
      hits.push(probe);
      const send = (status: number, body: string, headers: Record<string, string>) => {
        res.writeHead(status, headers);
        res.end(body);
      };
      const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
        send(status, JSON.stringify(body), { "content-type": "application/json", ...headers });
      const rpcError = (status: number, code: number, message: string, headers?: Record<string, string>) =>
        json(status, { jsonrpc: "2.0", id: one.id ?? null, error: { code, message } }, headers);
      const reply = (result: unknown) => json(200, { jsonrpc: "2.0", id: one.id, result });
      /** Answer with `answer`; false when it is a "429-once" already spent (answer as the server would). */
      const answerWith = (answer: Answer): boolean => {
        switch (answer) {
          case 400:
            rpcError(400, -32600, "Bad Request");
            return true;
          case 415:
            rpcError(415, -32600, "Unsupported Media Type: expected application/json");
            return true;
          case 401:
            rpcError(401, -32001, "Unauthorized", { "www-authenticate": 'Bearer realm="mcp"' });
            return true;
          case "bearer-403":
            rpcError(403, -32001, "Forbidden", { "www-authenticate": 'Bearer error="insufficient_scope"' });
            return true;
          case "host-403":
            rpcError(403, -32000, "Invalid Host: mcp.internal.example");
            return true;
          case "bare-403":
            rpcError(403, -32000, "Forbidden");
            return true;
          case "429-once":
            if (throttledOnce.has(probe)) return false;
            throttledOnce.add(probe);
            send(429, "Too Many Requests", { "content-type": "text/plain", "retry-after": "0" });
            return true;
          case 429:
            send(429, "Too Many Requests", { "content-type": "text/plain", "retry-after": "0" });
            return true;
          case 503:
            send(503, "Service Unavailable", { "content-type": "text/plain" });
            return true;
          case "rpc-503":
            rpcError(503, -32603, "Backend unavailable");
            return true;
          case "own-500":
            // The server's own JSON-RPC rejection of the probe's defect, on
            // an HTTP 500 (a framework that maps every JSON-RPC error to 500).
            if (probe === "batch") rpcError(500, -32600, "Invalid Request: batch requests are not supported");
            else if (probe === "future") {
              rpcError(500, -32602, "Unsupported protocol version: 2099-01-01 (supported: 2025-11-25)");
            } else if (probe === "unknown") rpcError(500, -32601, "Method not found: nonexistent/method");
            else rpcError(500, -32600, "Invalid Request: expected application/json");
            return true;
          case "custom-500":
            rpcError(500, -32000, "Request rejected");
            return true;
          case "host-worded-403":
            // A refusal of the defect whose message happens to name the host
            // or origin (a CSRF guard, a per-host batch policy).
            if (probe === "textPlain") {
              rpcError(403, -32000, "text/plain bodies are refused to block cross-origin (CSRF) requests");
            } else if (probe === "batch") rpcError(403, -32600, "Batch requests are not accepted by this host");
            else if (probe === "future")
              rpcError(403, -32602, "Protocol version 2099-01-01 is not served on this host");
            else rpcError(403, -32601, "Method nonexistent/method is not available on this host");
            return true;
          case "drop":
            req.socket.destroy();
            return true;
          case "hang":
            return true;
          case "not-http":
            req.socket.end("NOT-HTTP garbage\r\n\r\n");
            return true;
        }
      };
      const authed = opts.token !== undefined && req.headers.authorization === `Bearer ${opts.token}`;
      if (opts.gate !== undefined && !authed && !(opts.exempt ?? []).includes(one.method ?? "")) {
        if (answerWith(opts.gate)) return;
      }
      // Each probe falls back to the conformant server's answer, a spent
      // "429-once" included.
      switch (probe) {
        case "textPlain":
          if (opts.textPlain !== undefined && answerWith(opts.textPlain)) return;
          return answerWith(415);
        case "batch": {
          const batch = opts.batch;
          if (batch === "rpc-200") return rpcError(200, -32600, "Invalid Request: batches are not supported");
          if (batch === "process") {
            return json(
              200,
              (msg as Array<{ id: unknown }>).map((m) => ({ jsonrpc: "2.0", id: m.id, result: {} })),
            );
          }
          if (batch !== undefined && answerWith(batch)) return;
          return answerWith(400);
        }
        case "init":
          if (opts.init !== undefined && answerWith(opts.init)) return;
          break;
        case "future": {
          opts.onFuture?.();
          const future = opts.future;
          if (future === "rpc-200") return rpcError(200, -32602, "Unsupported protocol version: 2099-01-01");
          if (future !== undefined && answerWith(future)) return;
          break;
        }
        case "unknown": {
          const unknown = opts.unknown;
          if (unknown === "rpc-404") return rpcError(404, -32601, "Method not found");
          if (unknown !== undefined && answerWith(unknown)) return;
          return rpcError(200, -32601, "Method not found");
        }
        case "ping":
          if (opts.ping !== undefined && answerWith(opts.ping)) return;
          return reply({});
      }
      if (one.id === undefined) return send(202, "", {});
      if (one.method === "initialize") {
        return reply({
          protocolVersion: "2025-11-25",
          capabilities: {},
          serverInfo: { name: "attribution-stub", version: "1" },
        });
      }
      if (one.method === "ping") return reply({});
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

const CT = "transport-content-type-reject";
const BATCH = "transport-batch-reject";
const VERSION = "lifecycle-version-negotiate";
const UNKNOWN = "error-unknown-method";

async function verdicts(
  stubOpts: StubOptions,
  runOpts: { only: string[]; headers?: Record<string, string>; timeout?: number } = {
    only: [CT, BATCH, VERSION, UNKNOWN],
  },
): Promise<{ byId: Record<string, string>; hits: Probe[]; warnings: string[] }> {
  const stub = await startStub(stubOpts);
  try {
    const report = await runComplianceSuite(stub.url, {
      timeout: runOpts.timeout ?? 3000,
      specVersion: "2025-11-25",
      only: runOpts.only,
      ...(runOpts.headers ? { headers: runOpts.headers } : {}),
    });
    return {
      byId: Object.fromEntries(report.tests.map((t) => [t.id, `${t.passed ? "PASS" : "FAIL"}: ${t.details}`])),
      hits: [...stub.hits],
      warnings: report.warnings,
    };
  } finally {
    await stub.stop();
  }
}

describe("legacy negative probes: a server that genuinely rejects the defect keeps its PASS", () => {
  it("415 / 400 on text/plain, 400 or a JSON-RPC -32600 on the batch, a version offered back or a -32602 / 400, -32601 on 200 or 404", async () => {
    const plain = await verdicts({});
    expect(plain.byId).toEqual({
      [CT]: "PASS: HTTP 415 (incorrect Content-Type rejected)",
      [BATCH]: "PASS: HTTP 400 (batch rejected)",
      [VERSION]: "PASS: Server negotiated down to 2025-11-25 (correct)",
      [UNKNOWN]: "PASS: Error code: -32601 (correct: Method not found) — Method not found",
    });
    // A server that answers the probes itself is sent no twin.
    expect(plain.hits.filter((h) => h === "ping")).toEqual([]);

    const other = await verdicts({ textPlain: 400, batch: "rpc-200", future: "rpc-200", unknown: "rpc-404" });
    expect(other.byId).toEqual({
      [CT]: "PASS: HTTP 400 (incorrect Content-Type rejected)",
      [BATCH]: "PASS: JSON-RPC error: -32600 — Invalid Request: batches are not supported",
      [VERSION]: "PASS: Server rejected unknown version with error: -32602 — Unsupported protocol version: 2099-01-01",
      [UNKNOWN]: "PASS: Error code: -32601 (correct: Method not found) — Method not found",
    });

    const status400 = await verdicts({ future: 400 }, { only: [VERSION] });
    expect(status400.byId[VERSION]).toBe("PASS: Server rejected unknown version with error: -32600 — Bad Request");
  }, 30_000);

  it("a server that accepts the defect still fails as before", async () => {
    const accepted = await verdicts({ textPlain: undefined, batch: "process" }, { only: [BATCH] });
    expect(accepted.byId[BATCH]).toBe("FAIL: Server processed batch request (MCP forbids batch)");
  }, 30_000);
});

describe("legacy negative probes: a gate that answers every request is not the server rejecting the defect", () => {
  it("a 401 on every request (no --auth): each fails as not evaluable (before: four passes)", async () => {
    // Before: PASS "HTTP 401 (incorrect Content-Type rejected)", PASS "HTTP
    // 401 (batch rejected)", PASS "Server rejected unknown version with
    // error: -32001 — Unauthorized", PASS "Error code: -32001 (expected
    // -32601) — Unauthorized".
    const { byId } = await verdicts({ gate: 401 });
    expect(byId).toEqual({
      [CT]: "FAIL: HTTP 401, JSON-RPC error -32001 on the text/plain POST -- not evaluable: an auth gate answered before the server read the request (pass --auth)",
      [BATCH]:
        "FAIL: HTTP 401, JSON-RPC error -32001 on the batch -- not evaluable: an auth gate answered before the server read the request (pass --auth)",
      [VERSION]:
        "FAIL: HTTP 401, JSON-RPC error -32001 on the initialize requesting protocol version 2099-01-01 -- not evaluable: the initialize handshake was not served either (HTTP 401, JSON-RPC error -32001), so this rejection proves nothing about the unknown version (see lifecycle-init)",
      [UNKNOWN]:
        "FAIL: HTTP 401, JSON-RPC error -32001 on nonexistent/method -- not evaluable: the initialize handshake was not served either (HTTP 401, JSON-RPC error -32001), so this rejection proves nothing about the unknown method (see lifecycle-init)",
    });
  }, 30_000);

  it("--auth with a credential the gate refuses: the 401 names the credential, not the defect", async () => {
    const { byId } = await verdicts(
      { gate: 401, token: "right" },
      {
        only: [CT, BATCH],
        headers: { Authorization: "Bearer wrong" },
      },
    );
    expect(byId).toEqual({
      [CT]: "FAIL: HTTP 401, JSON-RPC error -32001 on the text/plain POST -- not evaluable: an auth gate answered before the server read the request (credential rejected -- check --auth)",
      [BATCH]:
        "FAIL: HTTP 401, JSON-RPC error -32001 on the batch -- not evaluable: an auth gate answered before the server read the request (credential rejected -- check --auth)",
    });
  }, 30_000);

  it("the same gate with the credential it accepts: the server behind it is measured as usual", async () => {
    const { byId } = await verdicts(
      { gate: 401, token: "right" },
      {
        only: [CT, BATCH, VERSION, UNKNOWN],
        headers: { Authorization: "Bearer right" },
      },
    );
    expect(byId).toEqual({
      [CT]: "PASS: HTTP 415 (incorrect Content-Type rejected)",
      [BATCH]: "PASS: HTTP 400 (batch rejected)",
      [VERSION]: "PASS: Server negotiated down to 2025-11-25 (correct)",
      [UNKNOWN]: "PASS: Error code: -32601 (correct: Method not found) — Method not found",
    });
  }, 30_000);

  it("a Host guard's 403 on every request: not evaluable, quoting the guard (before: four passes)", async () => {
    const { byId, hits } = await verdicts({ gate: "host-403" });
    // The pre-initialization checks asked their twin, the same ping sent on
    // its own as application/json, once: it drew the same 403, so the
    // guard's wording stands. The handshake is the twin of the other two.
    expect(hits.filter((h) => h === "ping")).toEqual(["ping"]);
    expect(byId).toEqual({
      [CT]: 'FAIL: HTTP 403, JSON-RPC error -32000 on the text/plain POST ("Invalid Host: mcp.internal.example") -- not evaluable: the message names Host/Origin validation, which refuses a request whatever it carries',
      [BATCH]:
        'FAIL: HTTP 403, JSON-RPC error -32000 on the batch ("Invalid Host: mcp.internal.example") -- not evaluable: the message names Host/Origin validation, which refuses a request whatever it carries',
      [VERSION]:
        "FAIL: HTTP 403, JSON-RPC error -32000 on the initialize requesting protocol version 2099-01-01 -- not evaluable: the initialize handshake was not served either (HTTP 403, JSON-RPC error -32000), so this rejection proves nothing about the unknown version (see lifecycle-init)",
      [UNKNOWN]:
        "FAIL: HTTP 403, JSON-RPC error -32000 on nonexistent/method -- not evaluable: the initialize handshake was not served either (HTTP 403, JSON-RPC error -32000), so this rejection proves nothing about the unknown method (see lifecycle-init)",
    });
  }, 30_000);

  it("a bare 403 on every request: the conformant twin drew it too, so it is not attributable to the defect", async () => {
    // The pre-initialization checks compare with the same ping sent on its
    // own as application/json; it is sent once, and only because the probes
    // drew a bare 403.
    const { byId, hits } = await verdicts({ gate: "bare-403" });
    expect(byId).toEqual({
      [CT]: "FAIL: HTTP 403, JSON-RPC error -32000 on the text/plain POST -- not evaluable: the same ping sent on its own as application/json was refused (HTTP 403, JSON-RPC error -32000) too, so the 403 is not attributable to the Content-Type (see security-auth-required)",
      [BATCH]:
        "FAIL: HTTP 403, JSON-RPC error -32000 on the batch -- not evaluable: the same ping sent on its own as application/json was refused (HTTP 403, JSON-RPC error -32000) too, so the 403 is not attributable to the batch (see security-auth-required)",
      [VERSION]:
        "FAIL: HTTP 403, JSON-RPC error -32000 on the initialize requesting protocol version 2099-01-01 -- not evaluable: the initialize handshake was not served either (HTTP 403, JSON-RPC error -32000), so this rejection proves nothing about the unknown version (see lifecycle-init)",
      [UNKNOWN]:
        "FAIL: HTTP 403, JSON-RPC error -32000 on nonexistent/method -- not evaluable: the initialize handshake was not served either (HTTP 403, JSON-RPC error -32000), so this rejection proves nothing about the unknown method (see lifecycle-init)",
    });
    expect(hits.filter((h) => h === "ping")).toEqual(["ping"]);
  }, 30_000);

  it("a rate limiter's 429 on every request, resent once: not evaluable (before: two passes)", async () => {
    const { byId, hits } = await verdicts({ gate: 429 }, { only: [CT, BATCH] });
    expect(byId).toEqual({
      [CT]: "FAIL: HTTP 429, then after 0ms HTTP 429 on the text/plain POST -- not evaluable: a rate limiter answered before the server read the request, so the Content-Type was never looked at",
      [BATCH]:
        "FAIL: HTTP 429, then after 0ms HTTP 429 on the batch -- not evaluable: a rate limiter answered before the server read the request, so the batch was never looked at",
    });
    expect(hits.filter((h) => h === "textPlain" || h === "batch")).toEqual([
      "textPlain",
      "textPlain",
      "batch",
      "batch",
    ]);
  }, 30_000);

  it("a gateway with no backend (503 on every request): no rejection of the defect", async () => {
    const { byId } = await verdicts({ gate: 503 }, { only: [CT, BATCH] });
    expect(byId).toEqual({
      // Before: FAIL "HTTP 503" (the verdict stands; the details now say why).
      [CT]: "FAIL: HTTP 503 on the text/plain POST -- the server failed on the request rather than refusing it (a broken server, or a gateway with no backend), which is no rejection of the Content-Type",
      [BATCH]:
        "FAIL: HTTP 503 on the batch -- the server failed on the request rather than refusing it (a broken server, or a gateway with no backend), which is no rejection of the batch",
    });
  }, 30_000);
});

describe("legacy negative probes: the answer to the probe alone, next to a served handshake", () => {
  it("a 429 on the probe once: resent after Retry-After, and the second answer decides", async () => {
    // Before: PASS "HTTP 429 (incorrect Content-Type rejected)" / "(batch
    // rejected)", and FAIL "No protocolVersion or error in response" /
    // "No JSON-RPC error returned for unknown method" on the limiter's
    // text/plain 429.
    const { byId, hits } = await verdicts({
      textPlain: "429-once",
      batch: "429-once",
      future: "429-once",
      unknown: "429-once",
    });
    expect(byId).toEqual({
      [CT]: "PASS: HTTP 415 (incorrect Content-Type rejected)",
      [BATCH]: "PASS: HTTP 400 (batch rejected)",
      [VERSION]: "PASS: Server negotiated down to 2025-11-25 (correct)",
      [UNKNOWN]: "PASS: Error code: -32601 (correct: Method not found) — Method not found",
    });
    for (const probe of ["textPlain", "batch", "future", "unknown"] as const) {
      expect(
        hits.filter((h) => h === probe),
        probe,
      ).toHaveLength(2);
    }
  }, 30_000);

  it("a 401, or a 403 carrying a Bearer challenge, on the probe alone is still a gate, not a rejection of the defect", async () => {
    // The handshake was served, so the precondition holds, but an auth
    // refusal is about the credential: it never looked at the version or the
    // method (a gateway can let initialize through and gate the rest).
    const auth = await verdicts({ future: 401, unknown: 401 }, { only: [VERSION, UNKNOWN] });
    expect(auth.byId).toEqual({
      [VERSION]:
        "FAIL: HTTP 401, JSON-RPC error -32001 on the initialize requesting protocol version 2099-01-01 -- not evaluable: an auth gate answered before the server read the request (pass --auth)",
      [UNKNOWN]:
        "FAIL: HTTP 401, JSON-RPC error -32001 on nonexistent/method -- not evaluable: an auth gate answered before the server read the request (pass --auth)",
    });
    const bearer = await verdicts({ future: "bearer-403", unknown: "bearer-403" }, { only: [VERSION, UNKNOWN] });
    expect(bearer.byId).toEqual({
      [VERSION]:
        "FAIL: HTTP 403, JSON-RPC error -32001 on the initialize requesting protocol version 2099-01-01 -- not evaluable: an auth gate answered before the server read the request (pass --auth)",
      [UNKNOWN]:
        "FAIL: HTTP 403, JSON-RPC error -32001 on nonexistent/method -- not evaluable: an auth gate answered before the server read the request (pass --auth)",
    });
  }, 30_000);

  it("a 5xx without the server's own rejection of the defect fails: -32603, a server-defined code, or no JSON-RPC error", async () => {
    // A gateway with no backend (-32603 "Backend unavailable"), or a server
    // failing with its own -32000: no rejection of the defect. (The
    // JSON-RPC error body used to earn three passes.)
    const internal = await verdicts(
      { batch: "rpc-503", future: "rpc-503", unknown: "rpc-503" },
      { only: [BATCH, VERSION, UNKNOWN] },
    );
    expect(internal.byId).toEqual({
      [BATCH]:
        "FAIL: HTTP 503, JSON-RPC error -32603 on the batch -- the server failed on the request rather than refusing it (a broken server, or a gateway with no backend), which is no rejection of the batch",
      [VERSION]:
        "FAIL: HTTP 503, JSON-RPC error -32603 on the initialize requesting protocol version 2099-01-01 -- the server failed on the request rather than refusing it (a broken server, or a gateway with no backend), which is no rejection of the unknown version",
      [UNKNOWN]:
        "FAIL: HTTP 503, JSON-RPC error -32603 on nonexistent/method -- the server failed on the request rather than refusing it (a broken server, or a gateway with no backend), which is no rejection of the unknown method",
    });
    const custom = await verdicts(
      { batch: "custom-500", future: "custom-500", unknown: "custom-500" },
      { only: [BATCH, VERSION, UNKNOWN] },
    );
    expect(custom.byId).toEqual({
      [BATCH]:
        "FAIL: HTTP 500, JSON-RPC error -32000 on the batch -- the server failed on the request rather than refusing it (a broken server, or a gateway with no backend), which is no rejection of the batch",
      [VERSION]:
        "FAIL: HTTP 500, JSON-RPC error -32000 on the initialize requesting protocol version 2099-01-01 -- the server failed on the request rather than refusing it (a broken server, or a gateway with no backend), which is no rejection of the unknown version",
      [UNKNOWN]:
        "FAIL: HTTP 500, JSON-RPC error -32000 on nonexistent/method -- the server failed on the request rather than refusing it (a broken server, or a gateway with no backend), which is no rejection of the unknown method",
    });
    for (const w of [...internal.warnings, ...custom.warnings])
      expect(w).not.toMatch(/a rejected request is a client error/);
  }, 30_000);

  it("a 5xx carrying the server's own rejection of the defect keeps its PASS, with a warning about the status", async () => {
    // -32600 on the batch, -32602 naming the version, -32601 on the unknown
    // method: the server read the request and rejected the defect, which a
    // gateway with no backend cannot do. 2025-11-25 fixes no HTTP status for
    // a JSON-RPC error response, so these pass (as they did before the
    // attribution rule, and as 2026-07-28 credits them). transport-content-
    // type-reject credits only a 4xx, as it always has and as 2026-07-28
    // does, so its 5xx still fails.
    const { byId, warnings } = await verdicts({
      textPlain: "own-500",
      batch: "own-500",
      future: "own-500",
      unknown: "own-500",
    });
    expect(byId).toEqual({
      [CT]: "FAIL: HTTP 500, JSON-RPC error -32600 on the text/plain POST -- the server failed on the request rather than refusing it (a broken server, or a gateway with no backend), which is no rejection of the Content-Type",
      [BATCH]: "PASS: JSON-RPC error: -32600 — Invalid Request: batch requests are not supported",
      [VERSION]:
        "PASS: Server rejected unknown version with error: -32602 — Unsupported protocol version: 2099-01-01 (supported: 2025-11-25)",
      [UNKNOWN]: "PASS: Error code: -32601 (correct: Method not found) — Method not found: nonexistent/method",
    });
    expect(
      warnings.filter((w) => /^(transport-batch-reject|lifecycle-version-negotiate|error-unknown-method):/.test(w)),
    ).toEqual([
      "transport-batch-reject: the server answered the batch with its own JSON-RPC error -32600 on HTTP 500; a rejected request is a client error, so a 4xx status is expected (a 5xx tells clients and gateways the server failed).",
      "lifecycle-version-negotiate: the server answered the unknown version with its own JSON-RPC error -32602 on HTTP 500; a rejected request is a client error, so a 4xx status is expected (a 5xx tells clients and gateways the server failed).",
      "error-unknown-method: the server answered the unknown method with its own JSON-RPC error -32601 on HTTP 500; a rejected request is a client error, so a 4xx status is expected (a 5xx tells clients and gateways the server failed).",
    ]);
  }, 30_000);

  it("a bare 403 on the probe alone, next to a served twin, is credited as the rejection it is", async () => {
    // A WAF refusing the text/plain body, the batch, the unknown method: the
    // conformant twin was served, so the defect drew the 403.
    const { byId, hits } = await verdicts({
      textPlain: "bare-403",
      batch: "bare-403",
      future: "bare-403",
      unknown: "bare-403",
    });
    expect(byId).toEqual({
      [CT]: "PASS: HTTP 403 (incorrect Content-Type rejected)",
      [BATCH]: "PASS: HTTP 403 (batch rejected)",
      [VERSION]: "PASS: Server rejected unknown version with error: -32000 — Forbidden",
      [UNKNOWN]: "PASS: Error code: -32000 (expected -32601) — Forbidden",
    });
    // One pre-initialization twin (shared by the two transport checks) and
    // one ping next to the unknown method; the version's twin is the
    // handshake itself.
    expect(hits.filter((h) => h === "ping")).toEqual(["ping", "ping"]);
  }, 30_000);

  it("a gateway that lets initialize through and refuses every other method: error-unknown-method no longer credits it", async () => {
    // Before: PASS "Error code: -32001 (expected -32601) — Unauthorized" and
    // "Error code: -32000 (expected -32601) — Forbidden", although the
    // server never saw the unknown method.
    const auth = await verdicts({ gate: 401, exempt: ["initialize"] }, { only: [VERSION, UNKNOWN] });
    expect(auth.byId).toEqual({
      [VERSION]: "PASS: Server negotiated down to 2025-11-25 (correct)",
      [UNKNOWN]:
        "FAIL: HTTP 401, JSON-RPC error -32001 on nonexistent/method -- not evaluable: an auth gate answered before the server read the request (pass --auth)",
    });
    const bare = await verdicts({ gate: "bare-403", exempt: ["initialize"] }, { only: [UNKNOWN] });
    expect(bare.byId[UNKNOWN]).toBe(
      "FAIL: HTTP 403, JSON-RPC error -32000 on nonexistent/method -- not evaluable: the same request for ping was refused (HTTP 403, JSON-RPC error -32000) too, so the 403 is not attributable to the unknown method (see security-auth-required)",
    );
  }, 30_000);
});

describe("legacy negative probes: a 403 whose message names the host or origin is read from the twin, not from its wording", () => {
  it("next to a served twin it is the defect's: credited (before: not evaluable, the twin never asked)", async () => {
    // The same request without the defect, with the same Host and Origin,
    // was served in the same run: the 403 cannot be a guard refusing every
    // request, whatever its message says. Before: FAIL "... -- not
    // evaluable: the message names Host/Origin validation, which refuses a
    // request whatever it carries" on all four.
    const { byId, hits } = await verdicts({
      textPlain: "host-worded-403",
      batch: "host-worded-403",
      future: "host-worded-403",
      unknown: "host-worded-403",
    });
    expect(byId).toEqual({
      [CT]: "PASS: HTTP 403 (incorrect Content-Type rejected)",
      [BATCH]: "PASS: HTTP 403 (batch rejected)",
      [VERSION]:
        "PASS: Server rejected unknown version with error: -32602 — Protocol version 2099-01-01 is not served on this host",
      [UNKNOWN]:
        "PASS: Error code: -32601 (correct: Method not found) — Method nonexistent/method is not available on this host",
    });
    // One pre-initialization twin (shared by the two transport checks) and
    // one ping next to the unknown method; the version's twin is the
    // handshake itself.
    expect(hits.filter((h) => h === "ping")).toEqual(["ping", "ping"]);
  }, 30_000);

  it("a twin that drew a different status: credited too", async () => {
    const { byId } = await verdicts(
      { textPlain: "host-worded-403", batch: "host-worded-403", ping: 400 },
      { only: [CT, BATCH] },
    );
    expect(byId).toEqual({
      [CT]: "PASS: HTTP 403 (incorrect Content-Type rejected)",
      [BATCH]: "PASS: HTTP 403 (batch rejected)",
    });
  }, 30_000);

  it("a twin that got no answer: not attributable, naming the twin rather than the wording", async () => {
    const { byId } = await verdicts({ textPlain: "host-worded-403", ping: "drop" }, { only: [CT] });
    expect(byId[CT]).toBe(
      "FAIL: HTTP 403, JSON-RPC error -32000 on the text/plain POST -- not evaluable: the same ping sent on its own as application/json got no response (connection closed: other side closed) too, so the 403 is not attributable to the Content-Type (see security-auth-required)",
    );
  }, 30_000);

  it("a twin that drew the same 403: the guard's wording stands, after the handshake too", async () => {
    // A Host guard in front of every method but initialize: the handshake was
    // served, and the ping next to the unknown method drew the guard's 403.
    const { byId, hits } = await verdicts({ gate: "host-403", exempt: ["initialize"] }, { only: [VERSION, UNKNOWN] });
    expect(byId).toEqual({
      [VERSION]: "PASS: Server negotiated down to 2025-11-25 (correct)",
      [UNKNOWN]:
        'FAIL: HTTP 403, JSON-RPC error -32000 on nonexistent/method ("Invalid Host: mcp.internal.example") -- not evaluable: the message names Host/Origin validation, which refuses a request whatever it carries',
    });
    expect(hits.filter((h) => h === "ping")).toEqual(["ping"]);
  }, 30_000);
});

describe("legacy negative probes: a twin that never reached the server credits no 403", () => {
  // The same 403s as above, next to a ping the server never answered itself:
  // a rate limiter's 429 still a 429 after one resend, a gateway's 503 with
  // no backend, or an auth gate's 401. Before: any twin status other than
  // 403 credited the 403, so all three passed on the guard's refusal.
  const worded = { textPlain: "host-worded-403", batch: "host-worded-403", unknown: "host-worded-403" } as const;
  const notReached = (twinName: string, twin: string, defect: string) =>
    `not evaluable: ${twinName} ${twin} too, so the 403 is not attributable to ${defect} (see security-auth-required)`;
  const PRE_INIT = "the same ping sent on its own as application/json";
  const PING = "the same request for ping";

  it("a ping still throttled after its one resend: not attributable (before: three passes)", async () => {
    const { byId, hits } = await verdicts({ ...worded, ping: 429 }, { only: [CT, BATCH, UNKNOWN] });
    const twin = "was not served (HTTP 429, then after 0ms HTTP 429)";
    expect(byId).toEqual({
      [CT]: `FAIL: HTTP 403, JSON-RPC error -32000 on the text/plain POST -- ${notReached(PRE_INIT, twin, "the Content-Type")}`,
      [BATCH]: `FAIL: HTTP 403, JSON-RPC error -32600 on the batch -- ${notReached(PRE_INIT, twin, "the batch")}`,
      [UNKNOWN]: `FAIL: HTTP 403, JSON-RPC error -32601 on nonexistent/method -- ${notReached(PING, twin, "the unknown method")}`,
    });
    // The pre-initialization twin (shared by the two transport checks) and
    // the ping next to the unknown method, each sent and resent once.
    expect(hits.filter((h) => h === "ping")).toEqual(["ping", "ping", "ping", "ping"]);
  }, 30_000);

  it("a ping answered 503 (a gateway with no backend) or 401 (an auth gate): not attributable (before: passes)", async () => {
    const down = await verdicts({ ...worded, ping: 503 }, { only: [CT, UNKNOWN] });
    expect(down.byId).toEqual({
      [CT]: `FAIL: HTTP 403, JSON-RPC error -32000 on the text/plain POST -- ${notReached(PRE_INIT, "was not served (HTTP 503)", "the Content-Type")}`,
      [UNKNOWN]: `FAIL: HTTP 403, JSON-RPC error -32601 on nonexistent/method -- ${notReached(PING, "was not served (HTTP 503)", "the unknown method")}`,
    });
    const gated = await verdicts({ ...worded, ping: 401 }, { only: [BATCH] });
    expect(gated.byId[BATCH]).toBe(
      `FAIL: HTTP 403, JSON-RPC error -32600 on the batch -- ${notReached(PRE_INIT, "was refused (HTTP 401, JSON-RPC error -32001)", "the batch")}`,
    );
  }, 30_000);

  it("a ping served when resent after one 429 credits the 403 as before", async () => {
    const { byId } = await verdicts({ ...worded, ping: "429-once" }, { only: [CT, BATCH] });
    expect(byId).toEqual({
      [CT]: "PASS: HTTP 403 (incorrect Content-Type rejected)",
      [BATCH]: "PASS: HTTP 403 (batch rejected)",
    });
  }, 30_000);
});

describe("legacy negative probes after a handshake the server did not serve", () => {
  it("a server that rejects the handshake and the probe alike: not evaluable (before: two passes)", async () => {
    const { byId } = await verdicts({ init: 400, future: 400, unknown: 400 }, { only: [VERSION, UNKNOWN] });
    expect(byId).toEqual({
      [VERSION]:
        "FAIL: HTTP 400, JSON-RPC error -32600 on the initialize requesting protocol version 2099-01-01 -- not evaluable: the initialize handshake was not served either (HTTP 400, JSON-RPC error -32600), so this rejection proves nothing about the unknown version (see lifecycle-init)",
      [UNKNOWN]:
        "FAIL: HTTP 400, JSON-RPC error -32600 on nonexistent/method -- not evaluable: the initialize handshake was not served either (HTTP 400, JSON-RPC error -32600), so this rejection proves nothing about the unknown method (see lifecycle-init)",
    });
  }, 30_000);

  it("a rejection with a status the handshake did not draw is still the server's, and a version offered back is judged on its own", async () => {
    const { byId } = await verdicts({ init: 400, future: "rpc-200" }, { only: [VERSION, UNKNOWN] });
    expect(byId).toEqual({
      [VERSION]: "PASS: Server rejected unknown version with error: -32602 — Unsupported protocol version: 2099-01-01",
      [UNKNOWN]: "PASS: Error code: -32601 (correct: Method not found) — Method not found",
    });
    const offered = await verdicts({ init: 400 }, { only: [VERSION] });
    expect(offered.byId[VERSION]).toBe("PASS: Server negotiated down to 2025-11-25 (correct)");
  }, 30_000);
});

describe("legacy lifecycle-version-negotiate: a probe that got no answer is read, not credited", () => {
  // Before: every case below PASSED "Connection rejected for unknown version
  // (acceptable)" -- the bare catch credited any transport error.
  it("a connection dropped on the probe, next to the served handshake, is the rejection", async () => {
    const { byId } = await verdicts({ future: "drop" }, { only: [VERSION] });
    expect(byId[VERSION]).toBe(
      "PASS: Connection closed without a response (other side closed) (unknown version rejected)",
    );
  }, 30_000);

  it("a server that dropped the handshake too pins nothing on the version", async () => {
    const { byId } = await verdicts({ init: "drop", future: "drop" }, { only: [VERSION] });
    expect(byId[VERSION]).toBe(
      "FAIL: server unreachable: the initialize requesting protocol version 2099-01-01 got no response (connection closed: other side closed)",
    );
  }, 30_000);

  it("a probe nothing answers is 'server unreachable'", async () => {
    const { byId } = await verdicts({ future: "hang" }, { only: [VERSION], timeout: 800 });
    expect(byId[VERSION]).toBe(
      "FAIL: server unreachable: the initialize requesting protocol version 2099-01-01 got no response within 800ms",
    );
  }, 30_000);

  it("bytes that are not an HTTP response fail as no usable response", async () => {
    const { byId } = await verdicts({ future: "not-http" }, { only: [VERSION] });
    expect(byId[VERSION]).toMatch(
      /^FAIL: no usable response to the initialize requesting protocol version 2099-01-01: /,
    );
  }, 30_000);

  it("nothing listening at the address is 'server unreachable'", async () => {
    const stub = await startStub({});
    const dead = stub.url;
    await stub.stop();
    const report = await runComplianceSuite(dead, { timeout: 800, specVersion: "2025-11-25", only: [VERSION] });
    const t = report.tests.find((x) => x.id === VERSION);
    expect(t?.passed).toBe(false);
    expect(t?.details).toMatch(
      /^server unreachable: the initialize requesting protocol version 2099-01-01 got no response \(connection failed: connect ECONNREFUSED 127\.0\.0\.1:\d+\)$/,
    );
  }, 30_000);

  it("an abort while the probe waits is rethrown, not graded as a rejection", async () => {
    const controller = new AbortController();
    const reason = new Error("client went away");
    const passed: string[] = [];
    const stub = await startStub({ future: "hang", onFuture: () => setTimeout(() => controller.abort(reason), 50) });
    try {
      const started = Date.now();
      await expect(
        runComplianceSuite(stub.url, {
          timeout: 10_000,
          specVersion: "2025-11-25",
          only: [VERSION, "lifecycle-ping"],
          signal: controller.signal,
          onTestComplete: (t) => {
            if (t.passed) passed.push(t.id);
          },
        }),
      ).rejects.toBe(reason);
      expect(Date.now() - started).toBeLessThan(5000);
      expect(passed).toEqual([]);
    } finally {
      await stub.stop();
    }
  }, 20_000);
});

/**
 * A 2025-11-25 stdio server for lifecycle-version-negotiate: "negotiate"
 * answers the unknown version with its own; "exit-on-future" exits with code
 * 6 on the initialize requesting 2099-01-01; "hang-on-future" never answers
 * it; "exit-on-init" exits with code 4 on the first initialize (the child is
 * gone before the probe); "reject-all" answers initialize -32602 and every
 * other request -32002 "Server not initialized"; "exit-on-reinit" negotiates
 * any version on its first initialize and exits with code 3 on any second
 * one, whatever version it requests.
 */
const VERSION_STDIO_SERVER = `
import { createInterface } from "node:readline";
const mode = process.argv[2];
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const rl = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
let initialized = false;
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  const error = (code, message) => send({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
  if (msg.method === "initialize") {
    const future = msg.params?.protocolVersion === "2099-01-01";
    if (mode === "exit-on-reinit" && initialized) {
      process.stderr.write("fatal: already initialized\\n");
      process.exit(3);
    }
    initialized = true;
    if (mode === "exit-on-init") process.exit(4);
    if (mode === "reject-all") return error(-32602, "Unsupported client");
    if (future && mode === "exit-on-future") process.exit(6);
    if (future && mode === "hang-on-future") return;
    return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "stdio-version", version: "1" } } });
  }
  if (mode === "reject-all") return error(-32002, "Server not initialized");
  if (msg.method === "ping") return send({ jsonrpc: "2.0", id: msg.id, result: {} });
  error(-32601, "Method not found");
});
rl.on("close", () => process.exit(0));
`;

describe("legacy lifecycle-version-negotiate and error-unknown-method over stdio", () => {
  let dir: string;
  let script: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "mcp-legacy-attribution-"));
    script = join(dir, "server.mjs");
    writeFileSync(script, VERSION_STDIO_SERVER);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function overStdio(mode: string, only: string[], timeout = 5000) {
    const report = await runComplianceSuite(
      { type: "stdio", command: process.execPath, args: [script, mode] },
      { timeout, startupTimeout: 5000, specVersion: "2025-11-25", only },
    );
    return {
      byId: Object.fromEntries(report.tests.map((t) => [t.id, `${t.passed ? "PASS" : "FAIL"}: ${t.details}`])),
      warnings: report.warnings,
    };
  }

  it("a server that offers its own version, and answers an unknown method -32601, keeps its PASSes", async () => {
    const { byId } = await overStdio("negotiate", [VERSION, UNKNOWN]);
    expect(byId).toEqual({
      [VERSION]: "PASS: Server negotiated down to 2025-11-25 (correct)",
      [UNKNOWN]: "PASS: Error code: -32601 (correct: Method not found) — Method not found",
    });
  }, 30_000);

  it("a child that exits on the probe died on it: it fails, and is restarted so the tests after it measure the server", async () => {
    // Before: PASS "Connection rejected for unknown version (acceptable)",
    // and lifecycle-ping FAILED against the dead child. Over stdio the
    // probe is a second initialize on the live session, so the details
    // blame that, not the version.
    const { byId, warnings } = await overStdio("exit-on-future", [VERSION, "lifecycle-ping"]);
    expect(byId[VERSION]).toMatch(
      /^FAIL: server died on a second initialize \(requesting protocol version 2099-01-01\) on the live session, so the exit is not pinned on the version: .*exit code 6/,
    );
    expect(byId["lifecycle-ping"]).toBe("PASS: Ping responded successfully");
    expect(warnings.filter((w) => w.startsWith(VERSION))).toEqual([
      "lifecycle-version-negotiate: the server exited on a second initialize (requesting protocol version 2099-01-01) and was restarted with a fresh initialize handshake, so the tests after it ran against the new instance.",
    ]);
  }, 60_000);

  it("a child that exits on any second initialize: the report blames the second initialize, not the version it requested", async () => {
    // This server negotiates an unknown version correctly on a first
    // initialize; it dies on the repeat. The failure stands (a request that
    // kills the server is a crash, not a refusal: an HTTP drop leaves the
    // server running), but the details no longer claim the version killed
    // it. Before this fix: "server died on the initialize requesting
    // protocol version 2099-01-01: ...".
    const { byId, warnings } = await overStdio("exit-on-reinit", [VERSION, "lifecycle-ping", UNKNOWN]);
    expect(byId[VERSION]).toMatch(
      /^FAIL: server died on a second initialize \(requesting protocol version 2099-01-01\) on the live session, so the exit is not pinned on the version: .*exit code 3/,
    );
    expect(byId[VERSION]).not.toMatch(/died on the initialize requesting/);
    expect(byId["lifecycle-ping"]).toBe("PASS: Ping responded successfully");
    expect(byId[UNKNOWN]).toBe("PASS: Error code: -32601 (correct: Method not found) — Method not found");
    expect(warnings.filter((w) => w.startsWith(VERSION))).toEqual([
      "lifecycle-version-negotiate: the server exited on a second initialize (requesting protocol version 2099-01-01) and was restarted with a fresh initialize handshake, so the tests after it ran against the new instance.",
    ]);
  }, 60_000);

  it("a child already gone before the probe is 'server unreachable', and is not restarted", async () => {
    const { byId, warnings } = await overStdio("exit-on-init", [VERSION]);
    expect(byId[VERSION]).toMatch(
      /^FAIL: server unreachable: the initialize requesting protocol version 2099-01-01 got no response \(connection closed: .*exit code 4/,
    );
    expect(warnings.filter((w) => w.startsWith(VERSION))).toEqual([]);
  }, 30_000);

  it("a probe the child never answers is 'server unreachable'", async () => {
    const { byId } = await overStdio("hang-on-future", [VERSION], 1500);
    expect(byId[VERSION]).toMatch(
      /^FAIL: server unreachable: the initialize requesting protocol version 2099-01-01 got no response within 1500ms$/,
    );
  }, 30_000);

  it("a server that rejects the handshake too: its rejections prove nothing (before: two passes)", async () => {
    const { byId } = await overStdio("reject-all", [VERSION, UNKNOWN]);
    expect(byId).toEqual({
      [VERSION]:
        "FAIL: JSON-RPC error -32602 on the initialize requesting protocol version 2099-01-01 -- not evaluable: the initialize handshake was not served either (JSON-RPC error -32602), so this rejection proves nothing about the unknown version (see lifecycle-init)",
      [UNKNOWN]:
        "FAIL: JSON-RPC error -32002 on nonexistent/method -- not evaluable: the initialize handshake was not served either (JSON-RPC error -32602), so this rejection proves nothing about the unknown method (see lifecycle-init)",
    });
  }, 30_000);
});
