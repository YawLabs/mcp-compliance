import { type Server, createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHttpTransport } from "../transport/http.js";

interface CapturedRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

let server: Server;
let serverUrl: string;
let lastRequest: CapturedRequest | null = null;
let responder: (req: CapturedRequest) => { status: number; contentType: string; body: string } = () => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }),
});

function createIdCounter(start = 0): () => number {
  let n = start;
  return () => ++n;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const captured: CapturedRequest = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      lastRequest = captured;
      const { status, contentType, body } = responder(captured);
      res.writeHead(status, { "content-type": contentType });
      res.end(body);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") serverUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

describe("HttpTransport", () => {
  it("sends JSON-RPC with Content-Type and Accept headers", async () => {
    const t = createHttpTransport({ url: serverUrl });
    const nextId = createIdCounter(100);
    await t.request("ping", undefined, nextId, { timeout: 5000 });
    expect(lastRequest?.method).toBe("POST");
    expect(lastRequest?.headers["content-type"]).toContain("application/json");
    expect(lastRequest?.headers.accept).toContain("text/event-stream");
    const sent = JSON.parse(lastRequest?.body ?? "{}");
    expect(sent).toMatchObject({ jsonrpc: "2.0", id: 101, method: "ping", params: {} });
  });

  it("parses a plain JSON response", async () => {
    responder = () => ({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", id: 200, result: { v: 42 } }),
    });
    const t = createHttpTransport({ url: serverUrl });
    const res = await t.request("test", undefined, () => 200, { timeout: 5000 });
    expect(res.body).toMatchObject({ jsonrpc: "2.0", id: 200, result: { v: 42 } });
    expect(res.requestId).toBe(200);
    expect(res.statusCode).toBe(200);
  });

  it("parses a text/event-stream response", async () => {
    responder = () => ({
      status: 200,
      contentType: "text/event-stream",
      body: `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 300, result: { sse: true } })}\n\n`,
    });
    const t = createHttpTransport({ url: serverUrl });
    const res = await t.request("test", undefined, () => 300, { timeout: 5000 });
    expect(res.body).toMatchObject({ jsonrpc: "2.0", id: 300, result: { sse: true } });
  });

  it("injects session headers after setSessionId and setProtocolVersion", async () => {
    responder = () => ({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", id: 400, result: {} }),
    });
    const t = createHttpTransport({ url: serverUrl });
    t.setSessionId("sess-abc");
    t.setProtocolVersion("2025-11-25");
    await t.request("x", undefined, () => 400, { timeout: 5000 });
    expect(lastRequest?.headers["mcp-session-id"]).toBe("sess-abc");
    expect(lastRequest?.headers["mcp-protocol-version"]).toBe("2025-11-25");
  });

  it("merges user headers with session headers", async () => {
    const t = createHttpTransport({ url: serverUrl, headers: { Authorization: "Bearer tok" } });
    t.setSessionId("sess-xyz");
    await t.request("y", undefined, () => 1, { timeout: 5000 });
    expect(lastRequest?.headers.authorization).toBe("Bearer tok");
    expect(lastRequest?.headers["mcp-session-id"]).toBe("sess-xyz");
  });

  it("notify() sends a JSON-RPC notification without id", async () => {
    const t = createHttpTransport({ url: serverUrl });
    await t.notify("notifications/initialized", undefined, { timeout: 5000 });
    const sent = JSON.parse(lastRequest?.body ?? "{}");
    expect(sent).toMatchObject({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(sent.id).toBeUndefined();
  });

  it("rawPost returns raw text body and status", async () => {
    responder = () => ({
      status: 418,
      contentType: "text/plain",
      body: "i am a teapot",
    });
    const t = createHttpTransport({ url: serverUrl });
    const raw = await t.rawPost("hello", {}, 5000);
    expect(raw.statusCode).toBe(418);
    expect(raw.body).toBe("i am a teapot");
  });

  it("returns { _raw } when JSON response is unparseable", async () => {
    responder = () => ({
      status: 200,
      contentType: "application/json",
      body: "not valid json {",
    });
    const t = createHttpTransport({ url: serverUrl });
    const res = await t.request("boom", undefined, () => 1, { timeout: 5000 });
    expect(res.body).toMatchObject({ _raw: "not valid json {" });
  });

  it("close() resolves without error (HTTP has no resources to release)", async () => {
    const t = createHttpTransport({ url: serverUrl });
    await expect(t.close()).resolves.toBeUndefined();
  });

  it("preserves multi-value response headers (undici returns them as string[])", async () => {
    // Regression: normalizeHeaders used to silently drop string[] headers.
    // Multi-value headers like Set-Cookie and WWW-Authenticate must reach
    // the runner so security tests can assert on them.
    responder = () => ({
      status: 401,
      contentType: "application/json",
      body: "{}",
    });
    // Hook in a one-shot responder that writes raw multi-value headers.
    const origListeners = server.listeners("request");
    server.removeAllListeners("request");
    server.once("request", (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        res.writeHead(401, {
          "content-type": "application/json",
          "www-authenticate": ['Bearer realm="mcp"', 'Basic realm="legacy"'],
          "set-cookie": ["a=1; Path=/", "b=2; Path=/"],
        });
        res.end("{}");
      });
    });

    const t = createHttpTransport({ url: serverUrl });
    const raw = await t.rawPost("{}", {}, 5000);
    expect(raw.statusCode).toBe(401);
    expect(raw.headers["www-authenticate"]).toContain("Bearer");
    expect(raw.headers["www-authenticate"]).toContain("Basic");
    expect(raw.headers["set-cookie"]).toContain("a=1");
    expect(raw.headers["set-cookie"]).toContain("b=2");

    // Restore default responder.
    for (const l of origListeners) server.on("request", l as (...args: unknown[]) => void);
  });
});
