import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createModernClient } from "../modern/client.js";
import { createRecorder } from "../recorder.js";
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

  it("omitUserHeaders drops a configured user header for one request", async () => {
    // Regression for the auth-stripping false-pass: sessionHeaders()
    // re-injects every configured user header (e.g. Authorization) on
    // every request, so leaving it out of `headers` is NOT enough — the
    // request still carries auth. omitUserHeaders must genuinely remove it.
    responder = () => ({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }),
    });
    const t = createHttpTransport({ url: serverUrl, headers: { Authorization: "Bearer secret" } });
    t.setSessionId("sess-omit");
    await t.request("ping", undefined, () => 1, { timeout: 5000, omitUserHeaders: ["authorization"] });
    const captured = lastRequest;
    expect(captured).not.toBeNull();
    // The stripped request reaches the server with NO Authorization...
    expect(captured?.headers.authorization).toBeUndefined();
    // ...but unrelated session headers still flow through.
    expect(captured?.headers["mcp-session-id"]).toBe("sess-omit");
  });

  it("omitUserHeaders matches the user header name case-insensitively", async () => {
    // The user may have configured a lowercase `authorization`; the test
    // omits `"authorization"`. Stripping must be case-insensitive or the
    // header survives and the unauthenticated probe false-passes.
    const t = createHttpTransport({ url: serverUrl, headers: { authorization: "Bearer secret" } });
    await t.request("ping", undefined, () => 1, { timeout: 5000, omitUserHeaders: ["Authorization"] });
    const captured = lastRequest;
    expect(captured).not.toBeNull();
    expect(captured?.headers.authorization).toBeUndefined();
  });

  it("extraHeaders replaces an omitted user header (malformed-auth path)", async () => {
    // The malformed-auth test omits the valid Authorization, then supplies
    // a garbage one via extraHeaders. The server must see ONLY the garbage
    // value, never the configured-valid one.
    const t = createHttpTransport({ url: serverUrl, headers: { Authorization: "Bearer valid-token" } });
    await t.request("ping", undefined, () => 1, {
      timeout: 5000,
      headers: { Authorization: "Bearer GARBAGE" },
      omitUserHeaders: ["authorization"],
    });
    const captured = lastRequest;
    expect(captured).not.toBeNull();
    expect(captured?.headers.authorization).toBe("Bearer GARBAGE");
  });

  it("without omitUserHeaders the configured auth header is still sent (no regression)", async () => {
    // Guards the default path: the fix must not strip auth from ordinary
    // requests. This is the behavior the suite relies on for every
    // authenticated request that is NOT an auth-stripping probe.
    const t = createHttpTransport({ url: serverUrl, headers: { Authorization: "Bearer keep-me" } });
    await t.request("ping", undefined, () => 1, { timeout: 5000 });
    const captured = lastRequest;
    expect(captured).not.toBeNull();
    expect(captured?.headers.authorization).toBe("Bearer keep-me");
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

/**
 * Make the next request hang unanswered, so only an abort can end it;
 * returns the function that restores the default handler. When the
 * client aborts, its socket closes and Node tears the response down
 * (`req`'s own 'close' fires once the body is consumed, so it cannot be
 * the trigger); a safety timer ends a response no abort reached.
 */
function hangNextRequest(): () => void {
  const origListeners = server.listeners("request");
  server.removeAllListeners("request");
  server.once("request", (req, res) => {
    req.resume();
    const timer = setTimeout(() => res.destroy(), 8000);
    res.on("close", () => clearTimeout(timer));
  });
  return () => {
    server.removeAllListeners("request");
    for (const l of origListeners) server.on("request", l as (...args: unknown[]) => void);
  };
}

describe("HttpTransport raw probes honour an abort signal", () => {
  // The raw probes (malformed body, content type, batch, GET/DELETE) used
  // to accept no signal at all, so an aborted run still waited out the
  // full per-request timeout on whichever of them was in flight.

  it("rawPost rejects on the caller's signal while the request is in flight, long before the timeout", async () => {
    const restore = hangNextRequest();
    try {
      const t = createHttpTransport({ url: serverUrl });
      const controller = new AbortController();
      const started = Date.now();
      const pending = t.rawPost("{}", {}, 10000, undefined, controller.signal);
      setTimeout(() => controller.abort(new Error("run aborted by the user")), 50);
      await expect(pending).rejects.toThrow(/run aborted by the user/);
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      restore();
    }
  });

  it("rawRequest rejects at once on an already-aborted signal instead of sending the request", async () => {
    const t = createHttpTransport({ url: serverUrl });
    lastRequest = null;
    await expect(
      t.rawRequest("GET", undefined, {}, 10000, undefined, AbortSignal.abort(new Error("aborted before send"))),
    ).rejects.toThrow(/aborted before send/);
    expect(lastRequest).toBeNull();
  });

  it("ModernClient.raw() forwards the client's default signal (RunOptions.signal) to rawPost", async () => {
    const restore = hangNextRequest();
    try {
      const transport = createHttpTransport({ url: serverUrl });
      const controller = new AbortController();
      let id = 1000;
      const client = createModernClient({
        transport,
        recorder: createRecorder(),
        nextId: () => id++,
        timeout: 10000,
        protocolVersion: "2026-07-28",
        clientCapabilities: { elicitation: {} },
        clientInfo: { name: "test", version: "0" },
        signal: controller.signal,
      });
      const started = Date.now();
      const pending = client.raw("{this is not valid json", { method: "server/discover" });
      setTimeout(() => controller.abort(new Error("run aborted by the user")), 50);
      await expect(pending).rejects.toThrow(/run aborted by the user/);
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      restore();
    }
  });
});

/**
 * Answer the next request with 200 text/event-stream, write `frames` (one
 * SSE event each), then hold the response open without another byte --
 * the way a server holds a subscriptions/listen it has nothing more to
 * say on. `closed` resolves once the connection is gone (the client tore
 * it down); a safety timer ends a response nothing else reached.
 */
function holdNextStream(frames: unknown[] = []): { restore: () => void; closed: Promise<void> } {
  const origListeners = server.listeners("request");
  server.removeAllListeners("request");
  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  server.once("request", (req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      for (const frame of frames) res.write(`event: message\ndata: ${JSON.stringify(frame)}\n\n`);
    });
    const timer = setTimeout(() => res.destroy(), 8000);
    res.on("close", () => {
      clearTimeout(timer);
      resolveClosed();
    });
  });
  return {
    restore: () => {
      server.removeAllListeners("request");
      for (const l of origListeners) server.on("request", l as (...args: unknown[]) => void);
    },
    closed,
  };
}

/** How iterating a stream's messages ended within the guard budget. */
interface Drained {
  outcome: "ended" | "threw" | "still open";
  seen: unknown[];
  error?: unknown;
}

/**
 * Iterate `messages` to the end, but give up after `budgetMs`: a stream
 * whose end regressed must fail the assertion on `outcome`, not hang the
 * file until the server's safety timer.
 */
async function drain(messages: AsyncIterable<unknown>, budgetMs = 4000): Promise<Drained> {
  const seen: unknown[] = [];
  const run = (async (): Promise<Drained> => {
    try {
      for await (const m of messages) seen.push(m);
      return { outcome: "ended", seen };
    } catch (error) {
      return { outcome: "threw", seen, error };
    }
  })();
  let guard: ReturnType<typeof setTimeout> | undefined;
  const giveUp = new Promise<Drained>((resolve) => {
    guard = setTimeout(() => resolve({ outcome: "still open", seen }), budgetMs);
  });
  try {
    return await Promise.race([run, giveUp]);
  } finally {
    clearTimeout(guard);
  }
}

/**
 * "settled" when `promise` settles within `budgetMs`, else "still open".
 * Bounds the wait on holdNextStream's `closed` (and on close() itself): a
 * client that stopped tearing the connection down must fail the assertion,
 * not pass late when the stub's own 8s safety timer destroys the response.
 */
async function settlesWithin(promise: Promise<unknown>, budgetMs: number): Promise<"settled" | "still open"> {
  let guard: ReturnType<typeof setTimeout> | undefined;
  const giveUp = new Promise<"still open">((resolve) => {
    guard = setTimeout(() => resolve("still open"), budgetMs);
  });
  try {
    return await Promise.race([
      promise.then(
        () => "settled" as const,
        () => "settled" as const,
      ),
      giveUp,
    ]);
  } finally {
    clearTimeout(guard);
  }
}

describe("HttpTransport stream(): the timer, close() and an upstream abort end a held-open stream", () => {
  // Nothing else bounds an HTTP stream: undici's own headers/body timeouts
  // are minutes, so a subscriptions/listen the server never writes to
  // would stall the run without the whole-stream timer.
  const ack = { jsonrpc: "2.0", method: "notifications/subscriptions/acknowledged", params: {} };

  it("a stream the server holds open without a frame ends quietly at the timeout, with no messages", async () => {
    const { restore, closed } = holdNextStream();
    try {
      const t = createHttpTransport({ url: serverUrl });
      const started = Date.now();
      const stream = await t.stream("subscriptions/listen", { notifications: {} }, () => 500, { timeout: 300 });
      expect(stream.statusCode).toBe(200);
      expect(stream.requestId).toBe(500);
      const drained = await drain(stream.messages);
      const elapsed = Date.now() - started;
      // Our own abort is the normal end of a held-open stream: not an error.
      expect(drained.error).toBeUndefined();
      expect(drained.outcome).toBe("ended");
      expect(drained.seen).toEqual([]);
      // It was the 300ms timer that ended it: not an early end of the body,
      // and not a timer firing late (a loaded machine stretches 300ms, it
      // does not make it 10x).
      expect(elapsed).toBeGreaterThanOrEqual(250);
      expect(elapsed).toBeLessThan(2000);
      // And the client tore the connection down: the server sees it close
      // at once, not when its own safety timer gives up on the response.
      expect(await settlesWithin(closed, 1000)).toBe("settled");
      await stream.close();
    } finally {
      restore();
    }
  });

  it("frames already on the wire are delivered (and emitted to listeners) before the timeout ends the stream", async () => {
    const { restore, closed } = holdNextStream([ack]);
    try {
      const t = createHttpTransport({ url: serverUrl });
      const heard: { message: unknown; statusCode?: number }[] = [];
      t.onMessage((message, meta) => heard.push({ message, statusCode: meta.statusCode }));
      const started = Date.now();
      const stream = await t.stream("subscriptions/listen", { notifications: {} }, () => 501, { timeout: 300 });
      const drained = await drain(stream.messages);
      const elapsed = Date.now() - started;
      expect(drained.error).toBeUndefined();
      expect(drained.outcome).toBe("ended");
      expect(drained.seen).toEqual([ack]);
      expect(heard).toEqual([{ message: ack, statusCode: 200 }]);
      // A delivered frame does not stop the timer: it still ends the stream
      // at 300ms and tears the connection down.
      expect(elapsed).toBeGreaterThanOrEqual(250);
      expect(elapsed).toBeLessThan(2000);
      expect(await settlesWithin(closed, 1000)).toBe("settled");
    } finally {
      restore();
    }
  });

  it("response headers that never arrive reject stream() with 'stream timed out after Nms'", async () => {
    const restore = hangNextRequest();
    try {
      const t = createHttpTransport({ url: serverUrl });
      const outcome = await Promise.race([
        t
          .stream("subscriptions/listen", { notifications: {} }, () => 502, { timeout: 300 })
          .then(
            () => "resolved",
            (err: unknown) => (err instanceof Error ? err.message : String(err)),
          ),
        new Promise<string>((resolve) => setTimeout(() => resolve("still pending"), 4000)),
      ]);
      expect(outcome).toMatch(/stream timed out after 300ms/);
    } finally {
      restore();
    }
  });

  it("close() ends a held-open stream long before its timeout, after the frames already delivered", async () => {
    const { restore, closed } = holdNextStream([ack]);
    try {
      const t = createHttpTransport({ url: serverUrl });
      const stream = await t.stream("subscriptions/listen", { notifications: {} }, () => 503, { timeout: 10000 });
      const iterator = stream.messages[Symbol.asyncIterator]();
      const first = await iterator.next();
      expect(first).toEqual({ done: false, value: ack });
      // close() itself returns promptly (it does not wait on a body the
      // server never ends) ...
      expect(await settlesWithin(stream.close(), 1000)).toBe("settled");
      const drained = await drain({ [Symbol.asyncIterator]: () => iterator }, 1000);
      expect(drained.error).toBeUndefined();
      expect(drained.outcome).toBe("ended");
      expect(drained.seen).toEqual([]);
      // ... and tore the connection down, rather than leaving it to the
      // stub's safety timer.
      expect(await settlesWithin(closed, 1000)).toBe("settled");
    } finally {
      restore();
    }
  });

  it("an upstream abort mid-stream ends the iteration quietly, long before the timeout", async () => {
    const { restore, closed } = holdNextStream();
    try {
      const t = createHttpTransport({ url: serverUrl });
      const controller = new AbortController();
      const stream = await t.stream("subscriptions/listen", { notifications: {} }, () => 504, {
        timeout: 10000,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(new Error("run aborted by the user")), 50);
      const drained = await drain(stream.messages);
      expect(drained.error).toBeUndefined();
      expect(drained.outcome).toBe("ended");
      expect(drained.seen).toEqual([]);
      expect(await settlesWithin(closed, 1000)).toBe("settled");
    } finally {
      restore();
    }
  });

  it("an already-aborted upstream signal rejects stream() with its reason instead of sending the request", async () => {
    responder = () => ({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", id: 505, result: {} }),
    });
    const t = createHttpTransport({ url: serverUrl });
    lastRequest = null;
    await expect(
      t.stream("subscriptions/listen", { notifications: {} }, () => 505, {
        timeout: 1000,
        signal: AbortSignal.abort(new Error("aborted before send")),
      }),
    ).rejects.toThrow(/aborted before send/);
    expect(lastRequest).toBeNull();
  });
});
