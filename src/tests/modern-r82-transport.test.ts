import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { MODERN_SPEC_VERSION } from "../spec.js";
import { runModern } from "./helpers/modern-fixture.js";

/**
 * transport-batch-reject (required) and transport-content-type-reject read a
 * rejection as the server's own only when the conformant setup
 * server/discover was served, as every other 2026-07-28 check that credits a
 * rejection does (notEvaluable); a server whose setup discover was already
 * refused is not sent another one to compare a bare 403 with; and a probe
 * that got no answer -- the resend after a 429 included -- is "server
 * unreachable", not a bare transport error.
 */

type Kind = "discover" | "batch" | "textPlain" | "other";

/** How the stub answers one request: `id` is the request's (null for a batch). */
type Reply = (id: unknown, res: ServerResponse, req: IncomingMessage) => void;

const send =
  (status: number, body: string, headers: Record<string, string> = {}): Reply =>
  (_id, res) => {
    res.writeHead(status, headers);
    res.end(body);
  };
const rpcError =
  (status: number, code: number, message: string, headers: Record<string, string> = {}): Reply =>
  (id, res) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }));
  };
const served: Reply = (id, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: {
        resultType: "complete",
        supportedVersions: [MODERN_SPEC_VERSION],
        capabilities: { tools: {} },
        ttlMs: 0,
        cacheScope: "public",
      },
    }),
  );
};
/** A rate limiter's 429 with Retry-After: 0, so the probe is resent at once. */
const throttle = send(429, "Too Many Requests", { "content-type": "text/plain", "retry-after": "0" });
/** The connection is closed without an answer. */
const drop: Reply = (_id, _res, req) => req.socket.destroy();
/** Never answered. */
const hang: Reply = () => {};

/**
 * A stateless HTTP server answering each kind of request with its reply (a
 * list answers the Nth request of that kind with its Nth entry, the last
 * repeating); `all` answers every POST whose kind has no reply of its own.
 * Records the kind of every POST.
 */
async function startStub(
  replies: Partial<Record<Kind, Reply | Reply[]>> & { all?: Reply } = {},
): Promise<{ url: string; hits: Kind[]; stop(): Promise<void> }> {
  const hits: Kind[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let msg: unknown;
      try {
        msg = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        msg = undefined;
      }
      const one = (msg && typeof msg === "object" && !Array.isArray(msg) ? msg : {}) as {
        id?: unknown;
        method?: string;
      };
      const kind: Kind = String(req.headers["content-type"] ?? "").startsWith("text/plain")
        ? "textPlain"
        : Array.isArray(msg)
          ? "batch"
          : one.method === "server/discover"
            ? "discover"
            : "other";
      const nth = hits.filter((h) => h === kind).length;
      hits.push(kind);
      const own = replies[kind];
      const reply = Array.isArray(own) ? own[Math.min(nth, own.length - 1)] : own;
      if (reply) return reply(one.id, res, req);
      if (replies.all) return replies.all(one.id, res, req);
      if (kind === "discover") return served(one.id, res, req);
      if (kind === "batch") return rpcError(400, -32600, "Invalid Request: batches are not supported")(null, res, req);
      if (kind === "textPlain")
        return send(415, "Unsupported Media Type", { "content-type": "text/plain" })(null, res, req);
      if (one.id === undefined) return send(202, "")(null, res, req);
      return rpcError(404, -32601, "Method not found")(one.id, res, req);
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

const BATCH = "transport-batch-reject";
const CT = "transport-content-type-reject";
const BOTH = [BATCH, CT];

async function verdicts(
  replies: Parameters<typeof startStub>[0],
  opts: { only?: string[]; timeout?: number } = {},
): Promise<{ byId: Record<string, string>; hits: Kind[]; warnings: string[] }> {
  const stub = await startStub(replies);
  try {
    const report = await runModern(stub.url, { timeout: opts.timeout ?? 3000, only: opts.only ?? BOTH });
    for (const t of report.tests) {
      expect(t.details, t.id).toMatch(/^[\x20-\x7e]+$/);
      expect(t.details.length, t.id).toBeLessThanOrEqual(220);
    }
    return {
      byId: Object.fromEntries(report.tests.map((t) => [t.id, `${t.passed ? "PASS" : "FAIL"}: ${t.details}`])),
      hits: [...stub.hits],
      warnings: report.warnings.filter((w) => w.startsWith("transport-")),
    };
  } finally {
    await stub.stop();
  }
}

const count = (hits: Kind[], kind: Kind) => hits.filter((h) => h === kind).length;

/** The not-evaluable reason for a server whose conformant setup discover was rejected. */
const rejected = (code: string, status: number, about: string) =>
  `not evaluable: the conformant server/discover was itself rejected with ${code} (HTTP ${status}), so this rejection proves nothing about ${about}`;

describe("transport-batch-reject / -content-type-reject: a server that rejected the conformant server/discover too", () => {
  it("an SDK v1 server answering every POST 400 -32000: not evaluable (before: two passes, one required)", async () => {
    // Before: PASS "HTTP 400 (batch rejected)" and PASS "HTTP 400 (text/plain rejected)".
    const { byId } = await verdicts({ all: rpcError(400, -32000, "Bad Request: Server not initialized") });
    expect(byId).toEqual({
      [BATCH]: `FAIL: HTTP 400, JSON-RPC error -32000 on the batch; ${rejected("-32000", 400, "the batch")}`,
      [CT]: `FAIL: HTTP 400, JSON-RPC error -32000 on the text/plain POST; ${rejected("-32000", 400, "the Content-Type")}`,
    });
  }, 30_000);

  it("a proxy with no route answering every POST 404 text/html: not evaluable (before: two passes)", async () => {
    // Before: PASS "HTTP 404 (batch rejected)" and PASS "HTTP 404 (text/plain rejected)".
    const { byId } = await verdicts({
      all: send(404, "<html><body>404 Not Found</body></html>", { "content-type": "text/html" }),
    });
    expect(byId).toEqual({
      [BATCH]: `FAIL: HTTP 404 on the batch; ${rejected("no JSON-RPC error code", 404, "the batch")}`,
      [CT]: `FAIL: HTTP 404 on the text/plain POST; ${rejected("no JSON-RPC error code", 404, "the Content-Type")}`,
    });
  }, 30_000);

  it("a gateway answering every POST HTTP 200 with a -32001 body: not evaluable (before: the batch passed)", async () => {
    // Before: PASS "HTTP 200, JSON-RPC error -32001 (batch rejected)", and
    // FAIL "HTTP 200: server accepted Content-Type text/plain" -- it accepted
    // nothing.
    const { byId } = await verdicts({ all: rpcError(200, -32001, "Unauthorized") });
    expect(byId).toEqual({
      [BATCH]: `FAIL: HTTP 200, JSON-RPC error -32001 on the batch; ${rejected("-32001", 200, "the batch")}`,
      [CT]: `FAIL: HTTP 200, JSON-RPC error -32001 on the text/plain POST; ${rejected("-32001", 200, "the Content-Type")}`,
    });
  }, 30_000);

  it("a legacy server pinned to 2026-07-28 (its own -32601 on server/discover): its 400 and 415 prove nothing either", async () => {
    // Before: PASS "HTTP 400 (batch rejected)" and PASS "HTTP 415 (text/plain rejected)".
    const { byId } = await verdicts({ discover: rpcError(400, -32601, "Method not found: server/discover") });
    expect(byId).toEqual({
      [BATCH]: `FAIL: HTTP 400, JSON-RPC error -32600 on the batch; ${rejected("-32601", 400, "the batch")}`,
      [CT]: `FAIL: HTTP 415 on the text/plain POST; ${rejected("-32601", 400, "the Content-Type")}`,
    });
  }, 30_000);

  it("its own -32600 on a 5xx is not credited, and no warning says it was (before: PASS with a 'credited' warning)", async () => {
    // A framework that maps every JSON-RPC error to HTTP 500, legacy-only.
    const { byId, warnings } = await verdicts(
      {
        discover: rpcError(500, -32601, "Method not found"),
        batch: rpcError(500, -32600, "Invalid Request: batches are not supported"),
      },
      { only: [BATCH] },
    );
    expect(byId[BATCH]).toBe(
      `FAIL: HTTP 500, JSON-RPC error -32600 on the batch; ${rejected("-32601", 500, "the batch")}`,
    );
    expect(warnings).toEqual([]);
  }, 30_000);

  it("an auth gate on every request, server/discover included, is still named as the gate (unchanged)", async () => {
    const gate = rpcError(401, -32001, "Unauthorized", { "www-authenticate": 'Bearer realm="mcp"' });
    const { byId } = await verdicts({ all: gate });
    const auth = (about: string) =>
      `not evaluable: an auth gate answered before the server read the request (pass --auth), so it proves nothing about ${about}`;
    expect(byId).toEqual({
      [BATCH]: `FAIL: HTTP 401, JSON-RPC error -32001 on the batch; ${auth("the batch")}`,
      [CT]: `FAIL: HTTP 401, JSON-RPC error -32001 on the text/plain POST; ${auth("the Content-Type")}`,
    });
  }, 30_000);
});

describe("transport-batch-reject / -content-type-reject: a conformant server keeps its verdicts", () => {
  it("its own 400 and 415: PASS, no twin, no warning", async () => {
    const { byId, hits, warnings } = await verdicts({});
    expect(byId).toEqual({
      [BATCH]: "PASS: HTTP 400 (batch rejected)",
      [CT]: "PASS: HTTP 415 (text/plain rejected)",
    });
    // The preflight and the setup discover only.
    expect(count(hits, "discover")).toBe(2);
    expect(warnings).toEqual([]);
  }, 30_000);

  it("its own JSON-RPC error on HTTP 200: the batch still passes, the text/plain POST still fails as accepted", async () => {
    const { byId } = await verdicts({
      batch: rpcError(200, -32600, "Invalid Request"),
      textPlain: rpcError(200, -32700, "Parse error"),
    });
    expect(byId).toEqual({
      [BATCH]: "PASS: HTTP 200, JSON-RPC error -32600 (batch rejected)",
      [CT]: "FAIL: HTTP 200: server accepted Content-Type text/plain",
    });
  }, 30_000);

  it("a batch answered as a batch still fails as processed", async () => {
    const { byId } = await verdicts(
      {
        batch: send(200, JSON.stringify([{ jsonrpc: "2.0", id: 1, result: {} }]), {
          "content-type": "application/json",
        }),
      },
      { only: [BATCH] },
    );
    expect(byId[BATCH]).toBe("FAIL: HTTP 200: server processed the batch (1 replies)");
  }, 30_000);

  it("its own -32600 on a 5xx next to a served discover: still credited, with the warning", async () => {
    const { byId, warnings } = await verdicts(
      { batch: rpcError(500, -32600, "Invalid Request: batches are not supported") },
      { only: [BATCH] },
    );
    expect(byId[BATCH]).toBe("PASS: HTTP 500, JSON-RPC error -32600 (batch rejected)");
    expect(warnings).toEqual([
      "transport-batch-reject: the server answered a batch with its own JSON-RPC error -32600 on HTTP 500; a rejected request is a client error, so a 4xx status is expected (a 5xx tells clients and gateways the server failed)",
    ]);
  }, 30_000);
});

describe("transport-batch-reject / -content-type-reject: the twin a bare 403 is read against", () => {
  it("a Host guard refusing every request: the setup discover's refusal is the twin, no further server/discover is sent", async () => {
    // Before: the same two verdicts, and a fresh server/discover sent per
    // check to learn what the setup discover already showed (4 in all).
    const { byId, hits } = await verdicts({ all: rpcError(403, -32000, "Invalid Host: mcp.internal.example") });
    const guard = (about: string) =>
      `not evaluable: its message ("Invalid Host: mcp.internal.example") names Host/Origin validation, which refuses a request whatever it carries, so it proves nothing about ${about}`;
    expect(byId).toEqual({
      // Within 220 characters the probe's JSON-RPC code gives way to the reason.
      [BATCH]: `FAIL: HTTP 403 on the batch; ${guard("the batch")}`,
      [CT]: `FAIL: HTTP 403 on the text/plain POST; ${guard("the Content-Type")}`,
    });
    expect(count(hits, "discover")).toBe(2);
  }, 30_000);

  it("a bare 403 on every request: not evaluable, and no further server/discover is sent", async () => {
    const { byId, hits } = await verdicts({ all: rpcError(403, -32000, "Forbidden") });
    const twin = (about: string) =>
      `not evaluable: a conformant server/discover was refused (HTTP 403, JSON-RPC error -32000) too, so the 403 proves nothing about ${about} (see security-auth-required)`;
    expect(byId).toEqual({
      [BATCH]: `FAIL: HTTP 403, JSON-RPC error -32000 on the batch; ${twin("the batch")}`,
      // Within 220 characters the probe's JSON-RPC code gives way to the reason.
      [CT]: `FAIL: HTTP 403 on the text/plain POST; ${twin("the Content-Type")}`,
    });
    expect(count(hits, "discover")).toBe(2);
  }, 30_000);

  it("next to a served setup discover a fresh twin is still sent, and a served twin credits the 403", async () => {
    const forbidden = rpcError(403, -32000, "Forbidden");
    const { byId, hits } = await verdicts({ batch: forbidden, textPlain: forbidden });
    expect(byId).toEqual({
      [BATCH]: "PASS: HTTP 403 (batch rejected)",
      [CT]: "PASS: HTTP 403 (text/plain rejected)",
    });
    expect(count(hits, "discover")).toBe(4);
  }, 30_000);
});

describe("transport-batch-reject / -content-type-reject: a probe that got no answer", () => {
  it("a 429 whose resend is dropped: 'server unreachable', naming the 429 (before: 'Error: other side closed')", async () => {
    const { byId, hits } = await verdicts({ batch: [throttle, drop], textPlain: [throttle, drop] });
    expect(byId).toEqual({
      [BATCH]:
        "FAIL: server unreachable: the batch answered HTTP 429, and its resend got no response (connection closed: other side closed)",
      [CT]: "FAIL: server unreachable: the text/plain POST answered HTTP 429, and its resend got no response (connection closed: other side closed)",
    });
    expect(count(hits, "batch")).toBe(2);
    expect(count(hits, "textPlain")).toBe(2);
  }, 30_000);

  it("a 429 whose resend times out: 'server unreachable' within the timeout (before: 'Error: The operation was aborted due to timeout')", async () => {
    const { byId } = await verdicts({ batch: [throttle, hang], textPlain: [throttle, hang] }, { timeout: 1000 });
    expect(byId).toEqual({
      [BATCH]: "FAIL: server unreachable: the batch answered HTTP 429, and its resend got no response within 1000ms",
      [CT]: "FAIL: server unreachable: the text/plain POST answered HTTP 429, and its resend got no response within 1000ms",
    });
  }, 30_000);

  it("a probe dropped on the first send: 'server unreachable' (before: 'Error: other side closed')", async () => {
    const { byId, hits } = await verdicts({ batch: drop, textPlain: drop });
    expect(byId).toEqual({
      [BATCH]: "FAIL: server unreachable: the batch got no response (connection closed: other side closed)",
      [CT]: "FAIL: server unreachable: the text/plain POST got no response (connection closed: other side closed)",
    });
    // Nothing to resend: no 429 was seen.
    expect(count(hits, "batch")).toBe(1);
  }, 30_000);

  it("a caller's abort while the resend waits is rethrown at once, not recorded as a verdict", async () => {
    const controller = new AbortController();
    const abortReason = new Error("client went away");
    const onResend: Reply = () => setTimeout(() => controller.abort(abortReason), 50);
    const stub = await startStub({ batch: [throttle, onResend] });
    try {
      const started = Date.now();
      await expect(runModern(stub.url, { timeout: 10_000, only: [BATCH], signal: controller.signal })).rejects.toBe(
        abortReason,
      );
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      await stub.stop();
    }
  }, 30_000);
});
