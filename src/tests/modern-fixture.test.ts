import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { request } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Proves the 2026-07-28 FIXTURE itself (src/tests/fixtures/modern-server.mjs
 * and legacy-silent-server.mjs), not the compliance runner: raw JSON lines
 * over stdio, raw undici over HTTP. The modern suite's tests are coded
 * against the behaviour pinned here, so every assertion is a contract line.
 */

const MODERN_FIXTURE = fileURLToPath(new URL("./fixtures/modern-server.mjs", import.meta.url));
const LEGACY_SILENT_FIXTURE = fileURLToPath(new URL("./fixtures/legacy-silent-server.mjs", import.meta.url));

const MODERN = "2026-07-28";
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CAPS = "io.modelcontextprotocol/clientCapabilities";
const META_INFO = "io.modelcontextprotocol/clientInfo";
const META_LOG = "io.modelcontextprotocol/logLevel";
const META_SERVER = "io.modelcontextprotocol/serverInfo";
const META_SUB = "io.modelcontextprotocol/subscriptionId";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const b64 = (s: string) => `=?base64?${Buffer.from(s, "utf8").toString("base64")}?=`;

function meta(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    [META_VERSION]: MODERN,
    [META_CAPS]: { elicitation: {} },
    [META_INFO]: { name: "fixture-test", version: "0.0.0" },
    ...overrides,
  };
}

let nextId = 1;
function req(method: string, params: Record<string, unknown> = {}, id: string | number = nextId++) {
  return { jsonrpc: "2.0", id, method, params: { ...params, _meta: params._meta ?? meta() } };
}

// ---------------------------------------------------------------------------
// stdio helper
// ---------------------------------------------------------------------------

interface StdioFixture {
  child: ChildProcess;
  send(obj: unknown): void;
  sendRaw(line: string): void;
  /** First buffered message matching `pred`, else wait for one. */
  next(pred: (m: any) => boolean, timeoutMs?: number): Promise<any>;
  /** True when nothing arrived within `ms`. */
  silentFor(ms: number): Promise<boolean>;
  close(): void;
}

function spawnStdio(fixture: string, env: Record<string, string> = {}): StdioFixture {
  const child = spawn(process.execPath, [fixture], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  const inbox: unknown[] = [];
  const waiters: Array<() => void> = [];
  let buf = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buf += chunk;
    let idx: number;
    // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic line splitter
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        inbox.push(JSON.parse(line));
      } catch {
        // banners are not our problem here
      }
    }
    for (const w of waiters.splice(0)) w();
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => process.stderr.write(`[fixture stderr] ${chunk}`));
  return {
    child,
    send(obj) {
      child.stdin?.write(`${JSON.stringify(obj)}\n`);
    },
    sendRaw(line) {
      child.stdin?.write(`${line}\n`);
    },
    async next(pred, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const idx = inbox.findIndex(pred);
        if (idx !== -1) return inbox.splice(idx, 1)[0];
        const remaining = deadline - Date.now();
        if (remaining <= 0)
          throw new Error(`stdio: no matching message within ${timeoutMs}ms; inbox=${JSON.stringify(inbox)}`);
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, remaining);
          waiters.push(() => {
            clearTimeout(t);
            resolve();
          });
        });
      }
    },
    async silentFor(ms) {
      await sleep(ms);
      return inbox.length === 0;
    },
    close() {
      try {
        child.stdin?.end();
      } catch {}
      child.kill();
    },
  };
}

/** Send a request over stdio and wait for the response with the same id. */
async function stdioRpc(f: StdioFixture, method: string, params: Record<string, unknown> = {}, id?: string | number) {
  const r = req(method, params, id);
  f.send(r);
  return f.next((m) => m.id === r.id && ("result" in m || "error" in m));
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

interface HttpFixture {
  child: ChildProcess;
  port: number;
  url: string;
  base: string;
  close(): void;
}

async function spawnHttp(env: Record<string, string> = {}): Promise<HttpFixture> {
  const child = spawn(process.execPath, [MODERN_FIXTURE, "--http"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => process.stderr.write(`[fixture stderr] ${chunk}`));
  const port = await new Promise<number>((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("fixture did not print MODERN_FIXTURE_PORT")), 10_000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buf += chunk;
      const m = /MODERN_FIXTURE_PORT=(\d+)/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`fixture exited early with code ${code}`));
    });
  });
  const base = `http://127.0.0.1:${port}`;
  return {
    child,
    port,
    url: `${base}/mcp`,
    base,
    close() {
      try {
        child.stdin?.end();
      } catch {}
      child.kill();
    },
  };
}

interface HttpReply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  /** Parsed JSON body, or the LAST SSE message (the response) for event streams. */
  json: any;
  /** Every JSON message in wire order (one for JSON bodies, all frames for SSE). */
  messages: any[];
}

function parseSse(text: string): any[] {
  const out: any[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("\n");
    if (!data) continue;
    try {
      out.push(JSON.parse(data));
    } catch {}
  }
  return out;
}

/** Conformant standard headers for a body; pass `headers` to override or (with null) drop one. */
function standardHeaders(body: any, overrides: Record<string, string | null> = {}): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": MODERN,
  };
  if (body && typeof body === "object" && !Array.isArray(body) && typeof body.method === "string") {
    h["Mcp-Method"] = body.method;
    const p = body.params ?? {};
    if ((body.method === "tools/call" || body.method === "prompts/get") && typeof p.name === "string")
      h["Mcp-Name"] = p.name;
    if (body.method === "resources/read" && typeof p.uri === "string") h["Mcp-Name"] = p.uri;
    if (body.method === "tools/call" && p.name === "regional" && typeof p.arguments?.region === "string") {
      h["Mcp-Param-Region"] = p.arguments.region;
    }
  }
  for (const [k, v] of Object.entries(overrides)) {
    for (const existing of Object.keys(h)) if (existing.toLowerCase() === k.toLowerCase()) delete h[existing];
    if (v !== null) h[k] = v;
  }
  return h;
}

async function post(url: string, body: unknown, overrides: Record<string, string | null> = {}): Promise<HttpReply> {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const res = await request(url, {
    method: "POST",
    headers: standardHeaders(typeof body === "string" ? undefined : body, overrides),
    body: text,
    signal: AbortSignal.timeout(5000),
  });
  const out = await res.body.text();
  const ct = String(res.headers["content-type"] ?? "");
  let messages: any[] = [];
  if (ct.includes("text/event-stream")) messages = parseSse(out);
  else if (out) {
    try {
      messages = [JSON.parse(out)];
    } catch {}
  }
  return { status: res.statusCode, headers: res.headers, text: out, json: messages[messages.length - 1], messages };
}

async function raw(url: string, method: "GET" | "DELETE" | "OPTIONS", headers: Record<string, string> = {}) {
  const res = await request(url, { method, headers, signal: AbortSignal.timeout(5000) });
  const text = await res.body.text();
  return { status: res.statusCode, headers: res.headers, text };
}

interface Stream {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  nextFrame(timeoutMs?: number): Promise<any>;
  close(): void;
}

/** Open a held-open SSE response (subscriptions/listen) and read frames incrementally. */
async function openStream(url: string, body: any, overrides: Record<string, string | null> = {}): Promise<Stream> {
  const controller = new AbortController();
  const res = await request(url, {
    method: "POST",
    headers: standardHeaders(body, overrides),
    body: JSON.stringify(body),
    signal: controller.signal,
  });
  const frames: any[] = [];
  const waiters: Array<() => void> = [];
  let ended = false;
  let cursor = 0;
  (async () => {
    let pending = "";
    try {
      for await (const chunk of res.body) {
        pending += Buffer.from(chunk as Uint8Array).toString("utf8");
        let idx: number;
        // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic block splitter
        while ((idx = pending.indexOf("\n\n")) !== -1) {
          const block = pending.slice(0, idx);
          pending = pending.slice(idx + 2);
          frames.push(...parseSse(`${block}\n\n`));
        }
        for (const w of waiters.splice(0)) w();
      }
    } catch {
      // aborted by close()
    } finally {
      ended = true;
      for (const w of waiters.splice(0)) w();
    }
  })();
  return {
    status: res.statusCode,
    headers: res.headers,
    async nextFrame(timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (cursor < frames.length) return frames[cursor++];
        if (ended) throw new Error("stream ended");
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`stream: no frame within ${timeoutMs}ms`);
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, remaining);
          waiters.push(() => {
            clearTimeout(t);
            resolve();
          });
        });
      }
    },
    close() {
      controller.abort();
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP: default (conformant) behaviour
// ---------------------------------------------------------------------------

describe("modern fixture over HTTP", () => {
  let f: HttpFixture;
  beforeAll(async () => {
    f = await spawnHttp();
  });
  afterAll(() => f.close());

  it("server/discover returns the contract shape", async () => {
    const r = await post(f.url, req("server/discover"));
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toContain("application/json");
    expect(r.headers["mcp-session-id"]).toBeUndefined();
    const result = r.json.result;
    expect(result.supportedVersions).toEqual([MODERN]);
    expect(result.capabilities).toEqual({
      tools: { listChanged: true },
      resources: { listChanged: true, subscribe: true },
      prompts: { listChanged: true },
      completions: {},
    });
    expect(result.instructions).toBe("Fixture server for mcp-compliance tests.");
    expect(result.ttlMs).toBe(60000);
    expect(result.cacheScope).toBe("public");
    expect(result.resultType).toBe("complete");
    expect(result._meta[META_SERVER]).toEqual({ name: "modern-fixture", version: "0.0.1" });
  });

  it("echoes string ids byte-for-byte", async () => {
    const r = await post(f.url, req("server/discover", {}, "discover-abc"));
    expect(r.json.id).toBe("discover-abc");
  });

  it("rejects a missing _meta / protocolVersion / clientCapabilities with -32602 and HTTP 400", async () => {
    const noMeta = await post(f.url, { jsonrpc: "2.0", id: 1, method: "server/discover", params: {} });
    expect(noMeta.status).toBe(400);
    expect(noMeta.json.error.code).toBe(-32602);
    expect(noMeta.json.id).toBe(1);

    const noVersion = await post(f.url, req("server/discover", { _meta: { [META_CAPS]: {} } }));
    expect(noVersion.status).toBe(400);
    expect(noVersion.json.error.code).toBe(-32602);

    const noCaps = await post(f.url, req("server/discover", { _meta: { [META_VERSION]: MODERN } }));
    expect(noCaps.status).toBe(400);
    expect(noCaps.json.error.code).toBe(-32602);
  });

  it("serves a request whose _meta lacks clientInfo", async () => {
    const r = await post(f.url, req("server/discover", { _meta: { [META_VERSION]: MODERN, [META_CAPS]: {} } }));
    expect(r.status).toBe(200);
    expect(r.json.result.supportedVersions).toEqual([MODERN]);
  });

  it("rejects an unsupported protocol version with -32022, data, and HTTP 400", async () => {
    const r = await post(f.url, req("server/discover", { _meta: meta({ [META_VERSION]: "1999-01-01" }) }), {
      "MCP-Protocol-Version": "1999-01-01",
    });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe(-32022);
    expect(r.json.error.data).toEqual({ supported: [MODERN], requested: "1999-01-01" });
  });

  it("rejects a header/_meta version mismatch with -32020, which beats -32022", async () => {
    const r = await post(f.url, req("server/discover", { _meta: meta({ [META_VERSION]: "1999-01-01" }) }));
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe(-32020);
  });

  it("rejects a missing MCP-Protocol-Version header with 400 + -32020", async () => {
    const r = await post(f.url, req("server/discover"), { "MCP-Protocol-Version": null });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe(-32020);
  });

  it("rejects a missing or mismatched Mcp-Method header with 400 + -32020", async () => {
    const missing = await post(f.url, req("server/discover"), { "Mcp-Method": null });
    expect(missing.status).toBe(400);
    expect(missing.json.error.code).toBe(-32020);

    const wrong = await post(f.url, req("server/discover"), { "Mcp-Method": "tools/list" });
    expect(wrong.status).toBe(400);
    expect(wrong.json.error.code).toBe(-32020);

    // Header VALUES are case-sensitive.
    const upper = await post(f.url, req("server/discover"), { "Mcp-Method": "SERVER/DISCOVER" });
    expect(upper.status).toBe(400);
    expect(upper.json.error.code).toBe(-32020);
  });

  it("accepts a lower-cased header NAME", async () => {
    const r = await post(f.url, req("server/discover"), { "Mcp-Method": null, "mcp-method": "server/discover" });
    expect(r.status).toBe(200);
    expect(r.json.result.supportedVersions).toEqual([MODERN]);
  });

  it("decodes the Mcp-Name base64 sentinel and rejects a wrong, missing, or malformed Mcp-Name", async () => {
    const call = req("tools/call", { name: "echo", arguments: { message: "hi" } });
    const encoded = await post(f.url, call, { "Mcp-Name": b64("echo") });
    expect(encoded.status).toBe(200);
    expect(encoded.json.result.content[0].text).toBe("hi");

    const padded = await post(f.url, call, { "Mcp-Name": "  echo  " });
    expect(padded.status).toBe(200);

    const wrong = await post(f.url, call, { "Mcp-Name": "add" });
    expect(wrong.status).toBe(400);
    expect(wrong.json.error.code).toBe(-32020);

    const missing = await post(f.url, call, { "Mcp-Name": null });
    expect(missing.status).toBe(400);
    expect(missing.json.error.code).toBe(-32020);

    const badBase64 = await post(f.url, call, { "Mcp-Name": "=?base64?ZWNobw?=" });
    expect(badBase64.status).toBe(400);
    expect(badBase64.json.error.code).toBe(-32020);

    const wrongUri = await post(f.url, req("resources/read", { uri: "test://static-text" }), {
      "Mcp-Name": "test://other",
    });
    expect(wrongUri.status).toBe(400);
    expect(wrongUri.json.error.code).toBe(-32020);
  });

  it("enforces Mcp-Param-Region on the regional tool", async () => {
    const call = req("tools/call", { name: "regional", arguments: { region: "eu-west1", query: "select 1" } });
    const ok = await post(f.url, call);
    expect(ok.status).toBe(200);
    expect(ok.json.result.content[0].text).toBe("eu-west1:select 1");

    const encoded = await post(f.url, call, { "Mcp-Param-Region": b64("eu-west1") });
    expect(encoded.status).toBe(200);

    const mismatch = await post(f.url, call, { "Mcp-Param-Region": "us-east1" });
    expect(mismatch.status).toBe(400);
    expect(mismatch.json.error.code).toBe(-32020);

    const missing = await post(f.url, call, { "Mcp-Param-Region": null });
    expect(missing.status).toBe(400);
    expect(missing.json.error.code).toBe(-32020);

    // A value the header cannot carry in plain ASCII round-trips through the sentinel.
    const unicode = req("tools/call", { name: "regional", arguments: { region: "zone 世界", query: "q" } });
    const roundTrip = await post(f.url, unicode, { "Mcp-Param-Region": b64("zone 世界") });
    expect(roundTrip.status).toBe(200);
    expect(roundTrip.json.result.content[0].text).toBe("zone 世界:q");
  });

  it("answers unknown and removed methods with 404 + -32601", async () => {
    const unknown = await post(f.url, req("no/such/method"));
    expect(unknown.status).toBe(404);
    expect(unknown.json.error.code).toBe(-32601);
    for (const method of ["ping", "logging/setLevel", "resources/subscribe", "resources/unsubscribe"]) {
      const r = await post(f.url, req(method));
      expect(r.status, method).toBe(404);
      expect(r.json.error.code, method).toBe(-32601);
    }
  });

  it("rejects initialize with -32601 naming the supported version, even without headers or _meta", async () => {
    const legacy = { jsonrpc: "2.0", id: 7, method: "initialize", params: { protocolVersion: "2025-11-25" } };
    const r = await post(f.url, legacy, { "MCP-Protocol-Version": null, "Mcp-Method": null });
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe(-32601);
    expect(r.json.error.message).toContain(MODERN);
    expect(r.json.error.message).toBe(
      "Method not found: initialize. This server speaks MCP 2026-07-28 (no initialize handshake).",
    );
  });

  it("answers GET and DELETE with 405 Allow: POST", async () => {
    const get = await raw(f.url, "GET", { Accept: "text/event-stream" });
    expect(get.status).toBe(405);
    expect(get.headers.allow).toBe("POST");
    const del = await raw(f.url, "DELETE", {});
    expect(del.status).toBe(405);
    expect(del.headers.allow).toBe("POST");
  });

  it("validates Origin: allowed origins get CORS on OPTIONS, foreign origins get 403", async () => {
    const ok = await raw(f.url, "OPTIONS", { Origin: f.base, "Access-Control-Request-Method": "POST" });
    expect(ok.status).toBe(204);
    expect(ok.headers["access-control-allow-origin"]).toBe(f.base);

    const evil = await raw(f.url, "OPTIONS", { Origin: "https://evil.example.com" });
    expect(evil.status).toBe(403);
    expect(evil.headers["access-control-allow-origin"]).toBeUndefined();

    const evilPost = await post(f.url, req("server/discover"), { Origin: "https://evil.example.com" });
    expect(evilPost.status).toBe(403);

    const nullOrigin = await post(f.url, req("server/discover"), { Origin: "null" });
    expect(nullOrigin.status).toBe(200);
  });

  it("rejects bad content types, invalid JSON, batches, and invalid framing", async () => {
    const plain = await post(f.url, JSON.stringify(req("server/discover")), {
      "Content-Type": "text/plain",
      "Mcp-Method": "server/discover",
    });
    expect(plain.status).toBe(415);

    const invalid = await post(f.url, "{not json", { "Mcp-Method": "server/discover" });
    expect(invalid.status).toBe(400);
    expect(invalid.json.error.code).toBe(-32700);
    expect(invalid.json.id).toBeNull();

    const batch = await post(f.url, [req("server/discover"), req("server/discover")], {
      "Mcp-Method": "server/discover",
    });
    expect(batch.status).toBe(400);
    expect(batch.json.error.code).toBe(-32600);

    const noVersion = await post(f.url, { id: 3, method: "server/discover", params: { _meta: meta() } });
    expect(noVersion.status).toBe(400);
    expect(noVersion.json.error.code).toBe(-32600);
    expect(noVersion.json.id).toBe(3);
  });

  it("accepts notifications with 202 and no body", async () => {
    const r = await post(f.url, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 12345 } });
    expect(r.status).toBe(202);
    expect(r.text).toBe("");
  });

  it("ignores Mcp-Session-Id and never mints one", async () => {
    const r = await post(f.url, req("server/discover"), { "Mcp-Session-Id": "bogus-session" });
    expect(r.status).toBe(200);
    expect(r.headers["mcp-session-id"]).toBeUndefined();
  });

  it("tools/list is stable, cacheable, and every tool is fully described", async () => {
    const lists = await Promise.all([1, 2, 3].map(() => post(f.url, req("tools/list"))));
    const names = lists.map((r) => r.json.result.tools.map((t: any) => t.name));
    expect(names[0]).toEqual([
      "echo",
      "add",
      "content_types",
      "progress",
      "logger",
      "needs_input",
      "needs_sampling",
      "regional",
      "fail",
      "trigger_tools_changed",
      "trigger_prompts_changed",
    ]);
    expect(names[1]).toEqual(names[0]);
    expect(names[2]).toEqual(names[0]);
    const result = lists[0].json.result;
    expect(result.ttlMs).toBe(60000);
    expect(result.cacheScope).toBe("public");
    expect(result.resultType).toBe("complete");
    expect(result.nextCursor).toBeUndefined();
    for (const tool of result.tools) {
      expect(typeof tool.description, tool.name).toBe("string");
      expect(typeof tool.title, tool.name).toBe("string");
      expect(tool.inputSchema.type, tool.name).toBe("object");
      expect(tool.inputSchema.properties, tool.name).toBeDefined();
      expect(tool.annotations, tool.name).toBeDefined();
      if (tool.name === "fail") expect(tool.annotations).toEqual({ destructiveHint: false, idempotentHint: true });
      else expect(tool.annotations.readOnlyHint).toBe(true);
    }
    const byName = new Map<string, any>(result.tools.map((t: any) => [t.name, t]));
    expect(byName.get("add").outputSchema).toEqual({ type: "integer" });
    expect(byName.get("regional").inputSchema.properties.region["x-mcp-header"]).toBe("Region");

    const page2 = await post(f.url, req("tools/list", { cursor: "page2" }));
    expect(page2.json.result.tools).toEqual([]);
    const badCursor = await post(f.url, req("tools/list", { cursor: "nope" }));
    expect(badCursor.status).toBe(200);
    expect(badCursor.json.error.code).toBe(-32602);
  });

  it("simple tools: echo (unicode intact), add (structuredContent), content_types, fail, unknown tool", async () => {
    const echo = await post(f.url, req("tools/call", { name: "echo", arguments: { message: "héllo 世界 \u{1f600}" } }));
    expect(echo.json.result.content[0].text).toBe("héllo 世界 \u{1f600}");
    expect(echo.json.result.resultType).toBe("complete");
    expect(echo.json.result.ttlMs).toBeUndefined();

    const add = await post(f.url, req("tools/call", { name: "add", arguments: { a: 1, b: 2 } }));
    expect(add.json.result.structuredContent).toBe(3);
    expect(add.json.result.content[0].text).toBe("3");

    const types = await post(f.url, req("tools/call", { name: "content_types", arguments: {} }));
    const kinds = types.json.result.content.map((c: any) => c.type);
    expect(kinds).toEqual(["text", "image", "audio", "resource", "resource_link"]);
    expect(types.json.result.content[1].mimeType).toBe("image/png");
    expect(types.json.result.content[2].mimeType).toBe("audio/wav");
    expect(types.json.result.content[3].resource).toEqual({
      uri: "test://static-text",
      mimeType: "text/plain",
      text: "hello",
    });
    expect(types.json.result.content[4]).toEqual({
      type: "resource_link",
      uri: "test://static-text",
      name: "static text",
    });

    const fail = await post(f.url, req("tools/call", { name: "fail", arguments: {} }));
    expect(fail.status).toBe(200);
    expect(fail.json.result.isError).toBe(true);
    expect(fail.json.result.content[0].text).toBe("boom");

    const unknown = await post(f.url, req("tools/call", { name: "nope", arguments: {} }));
    expect(unknown.status).toBe(200);
    expect(unknown.json.error.code).toBe(-32602);
    expect(unknown.json.error.message).toBe("Unknown tool: nope");
  });

  it("needs_input: MRTR round trip, tampered state, and the capability gate", async () => {
    const first = await post(f.url, req("tools/call", { name: "needs_input", arguments: {} }));
    expect(first.status).toBe(200);
    expect(first.json.result.resultType).toBe("input_required");
    expect(first.json.result.requestState).toBe("state-1");
    const ask = first.json.result.inputRequests.user_name;
    expect(ask.method).toBe("elicitation/create");
    expect(ask.params.mode).toBe("form");
    expect(ask.params.requestedSchema.required).toEqual(["name"]);

    const retry = await post(
      f.url,
      req("tools/call", {
        name: "needs_input",
        arguments: {},
        requestState: "state-1",
        inputResponses: { user_name: { action: "accept", content: { name: "Alice" } } },
      }),
    );
    expect(retry.json.result.resultType).toBe("complete");
    expect(retry.json.result.content[0].text).toBe("Hello, Alice");

    const tampered = await post(
      f.url,
      req("tools/call", {
        name: "needs_input",
        arguments: {},
        requestState: "state-1-TAMPERED",
        inputResponses: { user_name: { action: "accept", content: { name: "Mallory" } } },
      }),
    );
    expect(tampered.status).toBe(200);
    expect(tampered.json.error.code).toBe(-32602);

    const again = await post(f.url, req("tools/call", { name: "needs_input", arguments: {}, requestState: "state-1" }));
    expect(again.json.result.resultType).toBe("input_required");

    const noCap = await post(
      f.url,
      req("tools/call", { name: "needs_input", arguments: {}, _meta: meta({ [META_CAPS]: {} }) }),
    );
    expect(noCap.status).toBe(400);
    expect(noCap.json.error.code).toBe(-32021);
    expect(noCap.json.error.data).toEqual({ requiredCapabilities: { elicitation: {} } });
  });

  it("needs_sampling: -32021 without the sampling capability, otherwise a sampling round trip", async () => {
    const noCap = await post(f.url, req("tools/call", { name: "needs_sampling", arguments: {} }));
    expect(noCap.status).toBe(400);
    expect(noCap.json.error.code).toBe(-32021);
    expect(noCap.json.error.data).toEqual({ requiredCapabilities: { sampling: {} } });

    const withCap = meta({ [META_CAPS]: { sampling: {} } });
    const first = await post(f.url, req("tools/call", { name: "needs_sampling", arguments: {}, _meta: withCap }));
    expect(first.json.result.resultType).toBe("input_required");
    const [key, ask] = Object.entries<any>(first.json.result.inputRequests)[0];
    expect(ask.method).toBe("sampling/createMessage");
    expect(ask.params.maxTokens).toBe(10);

    const retry = await post(
      f.url,
      req("tools/call", {
        name: "needs_sampling",
        arguments: {},
        _meta: withCap,
        inputResponses: {
          [key]: { role: "assistant", content: { type: "text", text: "hello" }, model: "test", stopReason: "endTurn" },
        },
      }),
    );
    expect(retry.json.result.resultType).toBe("complete");
    expect(retry.json.result.content[0].text).toBe("hello");
  });

  it("progress: three progress notifications on an SSE stream, then the result", async () => {
    const r = await post(
      f.url,
      req("tools/call", { name: "progress", arguments: {}, _meta: meta({ progressToken: "p-1" }) }),
    );
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toContain("text/event-stream");
    expect(r.messages).toHaveLength(4);
    const progress = r.messages.slice(0, 3);
    expect(progress.map((m) => m.method)).toEqual([
      "notifications/progress",
      "notifications/progress",
      "notifications/progress",
    ]);
    expect(progress.map((m) => m.params.progress)).toEqual([1, 2, 3]);
    for (const m of progress) {
      expect(m.params.progressToken).toBe("p-1");
      expect(m.params.total).toBe(3);
      expect(m.id).toBeUndefined();
    }
    expect(r.json.result.content[0].text).toBe("done");

    const plain = await post(f.url, req("tools/call", { name: "progress", arguments: {} }));
    expect(plain.headers["content-type"]).toContain("application/json");
    expect(plain.messages).toHaveLength(1);
  });

  it("logger: logs only when the request carries a logLevel", async () => {
    const silent = await post(f.url, req("tools/call", { name: "logger", arguments: {} }));
    expect(silent.headers["content-type"]).toContain("application/json");
    expect(silent.messages.map((m) => m.method)).toEqual([undefined]);
    expect(silent.json.result.content[0].text).toBe("logged");

    const loud = await post(
      f.url,
      req("tools/call", { name: "logger", arguments: {}, _meta: meta({ [META_LOG]: "info" }) }),
    );
    expect(loud.headers["content-type"]).toContain("text/event-stream");
    expect(loud.messages).toHaveLength(2);
    expect(loud.messages[0].method).toBe("notifications/message");
    expect(loud.messages[0].params).toEqual({ level: "info", data: "hello" });
    expect(loud.json.result.content[0].text).toBe("logged");
  });

  it("subscriptions/listen: ack first with the subscription id, filter honoured, notifications tagged", async () => {
    const listen = req(
      "subscriptions/listen",
      { notifications: { toolsListChanged: true, resourceSubscriptions: ["test://static-text", "test://nope"] } },
      "sub-1",
    );
    const stream = await openStream(f.url, listen);
    expect(stream.status).toBe(200);
    expect(String(stream.headers["content-type"])).toContain("text/event-stream");
    const ack = await stream.nextFrame();
    expect(ack.method).toBe("notifications/subscriptions/acknowledged");
    expect(ack.id).toBeUndefined();
    expect(ack.params._meta[META_SUB]).toBe("sub-1");
    expect(ack.params.notifications).toEqual({ toolsListChanged: true, resourceSubscriptions: ["test://static-text"] });

    // A prompts change was not requested: it must not arrive. The tools
    // change that follows it must be the very next frame.
    const prompts = await post(f.url, req("tools/call", { name: "trigger_prompts_changed", arguments: {} }));
    expect(prompts.json.result.content[0].text).toBe("triggered");
    const tools = await post(f.url, req("tools/call", { name: "trigger_tools_changed", arguments: {} }));
    expect(tools.json.result.content[0].text).toBe("triggered");
    const changed = await stream.nextFrame();
    expect(changed.method).toBe("notifications/tools/list_changed");
    expect(changed.params._meta[META_SUB]).toBe("sub-1");
    stream.close();

    // Closing the stream is the cancellation: a later trigger reaches nobody and nothing crashes.
    await sleep(50);
    const after = await post(f.url, req("tools/call", { name: "trigger_tools_changed", arguments: {} }));
    expect(after.status).toBe(200);
  });

  it("subscriptions/listen without a filter object is -32602", async () => {
    const r = await post(f.url, req("subscriptions/listen", {}));
    expect(r.status).toBe(200);
    expect(r.json.error.code).toBe(-32602);
  });

  it("resources: list, templates, read text/binary/template, not-found -32602 with data.uri", async () => {
    const list = await post(f.url, req("resources/list"));
    expect(list.json.result.resources.map((r: any) => r.uri)).toEqual(["test://static-text", "test://static-binary"]);
    expect(list.json.result.ttlMs).toBe(60000);

    const templates = await post(f.url, req("resources/templates/list"));
    expect(templates.json.result.resourceTemplates).toEqual([
      { uriTemplate: "test://template/{id}/data", name: "template" },
    ]);
    expect(templates.json.result.cacheScope).toBe("public");

    const text = await post(f.url, req("resources/read", { uri: "test://static-text" }));
    expect(text.json.result.contents).toEqual([{ uri: "test://static-text", mimeType: "text/plain", text: "hello" }]);
    expect(text.json.result.ttlMs).toBe(60000);

    const binary = await post(f.url, req("resources/read", { uri: "test://static-binary" }));
    expect(binary.json.result.contents[0].blob).toBe("AAEC");

    const template = await post(f.url, req("resources/read", { uri: "test://template/42/data" }));
    expect(template.json.result.contents[0].text).toBe("data for 42");

    const missing = await post(f.url, req("resources/read", { uri: "test://missing" }));
    expect(missing.status).toBe(200);
    expect(missing.json.error.code).toBe(-32602);
    expect(missing.json.error.message).toBe("Resource not found");
    expect(missing.json.error.data).toEqual({ uri: "test://missing" });
  });

  it("prompts and completions", async () => {
    const list = await post(f.url, req("prompts/list"));
    expect(list.json.result.prompts.map((p: any) => p.name)).toEqual(["simple", "greet"]);
    expect(list.json.result.prompts[1].arguments).toEqual([{ name: "name", required: true }]);
    expect(list.json.result.cacheScope).toBe("public");

    const simple = await post(f.url, req("prompts/get", { name: "simple" }));
    expect(simple.json.result.messages).toEqual([{ role: "user", content: { type: "text", text: "Hi" } }]);
    expect(simple.json.result.ttlMs).toBeUndefined();

    const greet = await post(f.url, req("prompts/get", { name: "greet", arguments: { name: "Bob" } }));
    expect(greet.json.result.messages[0].content.text).toBe("Hello Bob");

    const noName = await post(f.url, req("prompts/get", { name: "greet" }));
    expect(noName.json.error.code).toBe(-32602);
    const unknown = await post(f.url, req("prompts/get", { name: "nope" }));
    expect(unknown.json.error.code).toBe(-32602);

    const complete = await post(
      f.url,
      req("completion/complete", { ref: { type: "ref/prompt", name: "greet" }, argument: { name: "name", value: "" } }),
    );
    expect(complete.json.result.completion).toEqual({ values: ["Alice", "Bob"], hasMore: false });
    const other = await post(
      f.url,
      req("completion/complete", { ref: { type: "ref/prompt", name: "simple" }, argument: { name: "x", value: "" } }),
    );
    expect(other.json.result.completion.values).toEqual([]);
  });

  it("error bodies stay short: no stack traces, no internal IPs", async () => {
    const r = await post(f.url, req("tools/call", { name: "nope", arguments: {} }));
    expect(r.text).not.toMatch(/\bat .*\(.*:\d+:\d+\)/);
    expect(r.text).not.toMatch(/\b10\.0\.0\.\d+\b/);
  });
});

// ---------------------------------------------------------------------------
// HTTP: break knobs flip exactly the behaviour they name
// ---------------------------------------------------------------------------

describe("modern fixture break knobs over HTTP", () => {
  const spawned: HttpFixture[] = [];
  async function knob(name: string): Promise<HttpFixture> {
    const f = await spawnHttp({ MODERN_FIXTURE_BREAK: name });
    spawned.push(f);
    return f;
  }
  afterAll(() => {
    for (const f of spawned) f.close();
  });

  it("rejects an unknown knob at startup", async () => {
    await expect(spawnHttp({ MODERN_FIXTURE_BREAK: "no-such-knob" })).rejects.toThrow(/exited early with code 2/);
  });

  it("no-caching drops ttlMs/cacheScope", async () => {
    const f = await knob("no-caching");
    const r = await post(f.url, req("server/discover"));
    expect(r.json.result.ttlMs).toBeUndefined();
    expect(r.json.result.cacheScope).toBeUndefined();
    expect(r.json.result.resultType).toBe("complete");
  });

  it("slow-discover holds only server/discover, for about 1500ms", async () => {
    const f = await knob("slow-discover");
    const started = Date.now();
    const discover = post(f.url, req("server/discover")).then((r) => ({ r, ms: Date.now() - started }));
    const list = await post(f.url, req("tools/list"));
    const listMs = Date.now() - started;
    const { r, ms } = await discover;
    expect(r.status).toBe(200);
    expect(r.json.result.supportedVersions).toEqual([MODERN]);
    expect(ms).toBeGreaterThanOrEqual(1400);
    // A request sent after it is not queued behind the sleep.
    expect(list.json.result.tools).toHaveLength(11);
    expect(listMs).toBeLessThan(ms);
  });

  it("require-client-info rejects a request whose _meta omits the optional clientInfo", async () => {
    const f = await knob("require-client-info");
    const without = await post(f.url, req("server/discover", { _meta: { [META_VERSION]: MODERN, [META_CAPS]: {} } }));
    expect(without.status).toBe(400);
    expect(without.json.error).toEqual({
      code: -32602,
      message: `Invalid params: params._meta["${META_INFO}"] must be an object`,
    });
    const full = await post(f.url, req("server/discover"));
    expect(full.status).toBe(200);
    expect(full.json.result.supportedVersions).toEqual([MODERN]);
  });

  it("reject-unknown-meta rejects a vendor _meta key with -32602 and still serves every reserved key", async () => {
    const f = await knob("reject-unknown-meta");
    const vendor = await post(f.url, req("server/discover", { _meta: meta({ "com.example.compliance/probe": "x" }) }));
    expect(vendor.status).toBe(400);
    expect(vendor.json.error).toEqual({
      code: -32602,
      message: 'Invalid params: params._meta["com.example.compliance/probe"] is not a recognised key',
    });
    const reserved = await post(
      f.url,
      req("server/discover", {
        _meta: meta({
          progressToken: "p-1",
          traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
          tracestate: "vendor=1",
          baggage: "k=v",
          [META_LOG]: "info",
        }),
      }),
    );
    expect(reserved.status).toBe(200);
    expect(reserved.json.result.supportedVersions).toEqual([MODERN]);
  });

  it("meta-error-wrong-code answers a malformed _meta with -32600 instead of -32602, still on HTTP 400", async () => {
    const f = await knob("meta-error-wrong-code");
    const r = await post(f.url, { jsonrpc: "2.0", id: 1, method: "server/discover", params: {} });
    expect(r.status).toBe(400);
    expect(r.json.error).toEqual({ code: -32600, message: "Invalid Request: params._meta is required" });
    expect(r.json.id).toBe(1);
  });

  it("accept-any-version serves a request declaring a version the server does not implement", async () => {
    const f = await knob("accept-any-version");
    const r = await post(f.url, req("server/discover", { _meta: meta({ [META_VERSION]: "1999-01-01" }) }), {
      "MCP-Protocol-Version": "1999-01-01",
    });
    expect(r.status).toBe(200);
    expect(r.json.error).toBeUndefined();
    expect(r.json.result.supportedVersions).toEqual([MODERN]);
  });

  it("boolean-capability declares tools as true instead of an object, and still serves tools/list", async () => {
    const f = await knob("boolean-capability");
    const r = await post(f.url, req("server/discover"));
    expect(r.json.result.capabilities).toEqual({
      tools: true,
      resources: { listChanged: true, subscribe: true },
      prompts: { listChanged: true },
      completions: {},
    });
    const list = await post(f.url, req("tools/list"));
    expect(list.json.result.tools).toHaveLength(11);
  });

  it("prompts-list-error fails prompts/list with -32603 on HTTP 500; prompts stay declared and the template list is served", async () => {
    const f = await knob("prompts-list-error");
    const r = await post(f.url, req("prompts/list"));
    expect(r.status).toBe(500);
    expect(r.json.error).toEqual({ code: -32603, message: "Internal error: prompt store unavailable" });
    const discover = await post(f.url, req("server/discover"));
    expect(discover.json.result.capabilities.prompts).toEqual({ listChanged: true });
    const templates = await post(f.url, req("resources/templates/list"));
    expect(templates.status).toBe(200);
    expect(templates.json.result.resourceTemplates).toHaveLength(1);
  });

  it("templates-list-error fails resources/templates/list with -32603 on HTTP 500; resources and prompts are served", async () => {
    const f = await knob("templates-list-error");
    const r = await post(f.url, req("resources/templates/list"));
    expect(r.status).toBe(500);
    expect(r.json.error).toEqual({ code: -32603, message: "Internal error: resource template store unavailable" });
    const resources = await post(f.url, req("resources/list"));
    expect(resources.json.result.resources).toHaveLength(2);
    const prompts = await post(f.url, req("prompts/list"));
    expect(prompts.status).toBe(200);
    expect(prompts.json.result.prompts).toHaveLength(2);
  });

  const completeGreet = () =>
    req("completion/complete", { ref: { type: "ref/prompt", name: "greet" }, argument: { name: "name", value: "" } });

  it("completion-rejects-argument answers completion/complete for a listed argument with -32602 on HTTP 400", async () => {
    const f = await knob("completion-rejects-argument");
    const r = await post(f.url, completeGreet());
    expect(r.status).toBe(400);
    expect(r.json.error).toEqual({ code: -32602, message: 'Invalid params: cannot complete argument "name"' });
  });

  it("completion-no-values answers completion/complete with a completion that has no values array", async () => {
    const f = await knob("completion-no-values");
    const r = await post(f.url, completeGreet());
    expect(r.status).toBe(200);
    expect(r.json.result.completion).toEqual({});
  });

  it("listen-silent opens the listen stream (200, SSE) and never writes a frame, not even the ack", async () => {
    const f = await knob("listen-silent");
    const stream = await openStream(f.url, req("subscriptions/listen", { notifications: { toolsListChanged: true } }));
    try {
      expect(stream.status).toBe(200);
      expect(String(stream.headers["content-type"])).toContain("text/event-stream");
      await expect(stream.nextFrame(750)).rejects.toThrow("stream: no frame within 750ms");
    } finally {
      stream.close();
    }
  });

  it("string-id-coerced answers a string id as Number(id) (null when not numeric); numeric ids are untouched", async () => {
    const f = await knob("string-id-coerced");
    const named = await post(f.url, req("server/discover", {}, "discover-abc"));
    expect(named.status).toBe(200);
    expect(named.text).toContain('"id":null');
    expect(named.json.result.supportedVersions).toEqual([MODERN]);
    const digits = await post(f.url, req("server/discover", {}, "42"));
    expect(digits.json.id).toBe(42);
    // Error responses carry the coerced id too.
    const unknown = await post(f.url, req("no/such/method", {}, "m-1"));
    expect(unknown.json.error.code).toBe(-32601);
    expect(unknown.json.id).toBeNull();
    const numeric = await post(f.url, req("server/discover", {}, 7));
    expect(numeric.json.id).toBe(7);
  });

  it("no-result-type drops resultType", async () => {
    const f = await knob("no-result-type");
    const r = await post(f.url, req("tools/list"));
    expect(r.json.result.resultType).toBeUndefined();
    expect(r.json.result.ttlMs).toBe(60000);
  });

  it("accept-header-mismatch serves a request whose Mcp-Method disagrees with the body", async () => {
    const f = await knob("accept-header-mismatch");
    const r = await post(f.url, req("server/discover"), { "Mcp-Method": "tools/list", "MCP-Protocol-Version": null });
    expect(r.status).toBe(200);
    expect(r.json.result.supportedVersions).toEqual([MODERN]);
  });

  it("unknown-method-200 answers -32601 with HTTP 200", async () => {
    const f = await knob("unknown-method-200");
    const r = await post(f.url, req("no/such/method"));
    expect(r.status).toBe(200);
    expect(r.json.error.code).toBe(-32601);
  });

  it("log-without-level emits notifications/message without a logLevel", async () => {
    const f = await knob("log-without-level");
    const r = await post(f.url, req("tools/call", { name: "logger", arguments: {} }));
    expect(r.headers["content-type"]).toContain("text/event-stream");
    expect(r.messages[0].method).toBe("notifications/message");
  });

  it("no-listen-ack starts the stream with a list_changed notification instead of the ack", async () => {
    const f = await knob("no-listen-ack");
    const stream = await openStream(f.url, req("subscriptions/listen", { notifications: { toolsListChanged: true } }));
    const first = await stream.nextFrame();
    expect(first.method).toBe("notifications/tools/list_changed");
    stream.close();
  });

  it("initialize-ok answers the legacy handshake and advertises both eras", async () => {
    const f = await knob("initialize-ok");
    const legacy = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "legacy", version: "1" } },
    };
    const init = await post(f.url, legacy, { "MCP-Protocol-Version": null, "Mcp-Method": null });
    expect(init.status).toBe(200);
    expect(init.json.result.protocolVersion).toBe("2025-11-25");
    expect(init.json.result.serverInfo).toEqual({ name: "modern-fixture", version: "0.0.1" });
    expect(init.json.result.capabilities.tools).toBeDefined();

    const initialized = await post(
      f.url,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { "MCP-Protocol-Version": null },
    );
    expect(initialized.status).toBe(202);

    const discover = await post(f.url, req("server/discover"));
    expect(discover.json.result.supportedVersions).toEqual([MODERN, "2025-11-25"]);
  });

  it("initialize-vague rejects initialize without naming a version", async () => {
    const f = await knob("initialize-vague");
    const r = await post(
      f.url,
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { "MCP-Protocol-Version": null },
    );
    expect(r.json.error.code).toBe(-32601);
    expect(r.json.error.message).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("get-sse and delete-ok resurrect the legacy endpoints", async () => {
    const f = await knob("get-sse,delete-ok");
    const get = await raw(f.url, "GET", { Accept: "text/event-stream" });
    expect(get.status).toBe(200);
    expect(String(get.headers["content-type"])).toContain("text/event-stream");
    const del = await raw(f.url, "DELETE", {});
    expect(del.status).toBe(200);
  });

  it("wrong-version-error / stacktrace-errors change the unsupported-version reply", async () => {
    const f = await knob("wrong-version-error,stacktrace-errors");
    const r = await post(f.url, req("server/discover", { _meta: meta({ [META_VERSION]: "1999-01-01" }) }), {
      "MCP-Protocol-Version": "1999-01-01",
    });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe(-32602);
    expect(r.json.error.data).toBeUndefined();
    expect(r.json.error.message).toContain("at Object.<anonymous>");
  });

  it("MODERN_FIXTURE_AUTH gates the endpoint with 401 + WWW-Authenticate and serves the metadata document", async () => {
    const f = await spawnHttp({ MODERN_FIXTURE_AUTH: "s3cret" });
    spawned.push(f);
    const anon = await post(f.url, req("server/discover"));
    expect(anon.status).toBe(401);
    expect(anon.headers["www-authenticate"]).toBe(
      `Bearer resource_metadata="${f.base}/.well-known/oauth-protected-resource"`,
    );
    const malformed = await post(f.url, req("server/discover"), { Authorization: "Bearer" });
    expect(malformed.status).toBe(401);
    const basic = await post(f.url, req("server/discover"), { Authorization: "Basic abc" });
    expect(basic.status).toBe(401);
    const wrong = await post(f.url, req("server/discover"), { Authorization: "Bearer nope" });
    expect(wrong.status).toBe(401);
    const ok = await post(f.url, req("server/discover"), { Authorization: "Bearer s3cret" });
    expect(ok.status).toBe(200);

    const doc = await request(`${f.base}/.well-known/oauth-protected-resource`, { signal: AbortSignal.timeout(5000) });
    expect(doc.statusCode).toBe(200);
    expect(await doc.body.json()).toEqual({ resource: f.url, authorization_servers: [`${f.base}/as`] });
  });
});

// ---------------------------------------------------------------------------
// stdio
// ---------------------------------------------------------------------------

describe("modern fixture over stdio", () => {
  let f: StdioFixture;
  beforeAll(() => {
    f = spawnStdio(MODERN_FIXTURE);
  });
  afterAll(() => f.close());

  it("server/discover works and needs no headers", async () => {
    const r = await stdioRpc(f, "server/discover");
    expect(r.result.supportedVersions).toEqual([MODERN]);
    expect(r.result.ttlMs).toBe(60000);
    expect(r.result.resultType).toBe("complete");
    expect(r.result._meta[META_SERVER].name).toBe("modern-fixture");
  });

  it("validates _meta and the protocol version", async () => {
    f.send({ jsonrpc: "2.0", id: "m1", method: "server/discover", params: {} });
    const noMeta = await f.next((m) => m.id === "m1");
    expect(noMeta.error.code).toBe(-32602);

    const bad = await stdioRpc(f, "server/discover", { _meta: meta({ [META_VERSION]: "1999-01-01" }) });
    expect(bad.error.code).toBe(-32022);
    expect(bad.error.data).toEqual({ supported: [MODERN], requested: "1999-01-01" });
  });

  it("answers unknown methods, removed methods and initialize with -32601", async () => {
    const unknown = await stdioRpc(f, "no/such/method");
    expect(unknown.error.code).toBe(-32601);
    const ping = await stdioRpc(f, "ping");
    expect(ping.error.code).toBe(-32601);
    f.send({ jsonrpc: "2.0", id: "init", method: "initialize", params: { protocolVersion: "2025-11-25" } });
    const init = await f.next((m) => m.id === "init");
    expect(init.error.code).toBe(-32601);
    expect(init.error.message).toContain(MODERN);
  });

  it("answers invalid JSON with -32700 and invalid framing with -32600", async () => {
    f.sendRaw("{not json");
    const parse = await f.next((m) => m.error?.code === -32700);
    expect(parse.id).toBeNull();
    f.send({ id: "fr", method: "server/discover" });
    const framing = await f.next((m) => m.id === "fr");
    expect(framing.error.code).toBe(-32600);
  });

  it("runs the needs_input round trip", async () => {
    const first = await stdioRpc(f, "tools/call", { name: "needs_input", arguments: {} });
    expect(first.result.resultType).toBe("input_required");
    expect(first.result.requestState).toBe("state-1");
    const retry = await stdioRpc(f, "tools/call", {
      name: "needs_input",
      arguments: {},
      requestState: "state-1",
      inputResponses: { user_name: { action: "accept", content: { name: "Zed" } } },
    });
    expect(retry.result.content[0].text).toBe("Hello, Zed");
    const noCap = await stdioRpc(f, "tools/call", {
      name: "needs_input",
      arguments: {},
      _meta: meta({ [META_CAPS]: {} }),
    });
    expect(noCap.error.code).toBe(-32021);
  });

  it("progress writes three notifications before the result", async () => {
    const r = req("tools/call", { name: "progress", arguments: {}, _meta: meta({ progressToken: 99 }) });
    f.send(r);
    const seen: any[] = [];
    for (let i = 0; i < 3; i++) seen.push(await f.next((m) => m.method === "notifications/progress"));
    expect(seen.map((m) => m.params.progress)).toEqual([1, 2, 3]);
    expect(seen.every((m) => m.params.progressToken === 99)).toBe(true);
    const done = await f.next((m) => m.id === r.id);
    expect(done.result.content[0].text).toBe("done");
  });

  it("listen: ack, tagged notification, cancel -> graceful closure response", async () => {
    const listen = req("subscriptions/listen", { notifications: { toolsListChanged: true } }, "sub-stdio");
    f.send(listen);
    const ack = await f.next((m) => m.method === "notifications/subscriptions/acknowledged");
    expect(ack.params._meta[META_SUB]).toBe("sub-stdio");
    expect(ack.params.notifications).toEqual({ toolsListChanged: true });

    const trigger = await stdioRpc(f, "tools/call", { name: "trigger_tools_changed", arguments: {} });
    expect(trigger.result.content[0].text).toBe("triggered");
    const changed = await f.next((m) => m.method === "notifications/tools/list_changed");
    expect(changed.params._meta[META_SUB]).toBe("sub-stdio");

    f.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "sub-stdio" } });
    const closed = await f.next((m) => m.id === "sub-stdio");
    expect(closed.result.resultType).toBe("complete");
    expect(closed.result._meta[META_SUB]).toBe("sub-stdio");
    expect(closed.result._meta[META_SERVER].name).toBe("modern-fixture");

    // Cancelling an unknown request id is harmless.
    f.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "nobody" } });
    const still = await stdioRpc(f, "server/discover");
    expect(still.result.supportedVersions).toEqual([MODERN]);
  });

  it("knobs apply over stdio too (no-result-type, no-server-info)", async () => {
    const k = spawnStdio(MODERN_FIXTURE, { MODERN_FIXTURE_BREAK: "no-result-type,no-server-info" });
    try {
      const r = await stdioRpc(k, "server/discover");
      expect(r.result.supportedVersions).toEqual([MODERN]);
      expect(r.result.resultType).toBeUndefined();
      expect(r.result._meta).toBeUndefined();
    } finally {
      k.close();
    }
  });
});

// ---------------------------------------------------------------------------
// legacy-silent-server
// ---------------------------------------------------------------------------

describe("legacy-silent-server fixture", () => {
  let f: StdioFixture;
  beforeAll(() => {
    f = spawnStdio(LEGACY_SILENT_FIXTURE);
  });
  afterAll(() => f.close());

  it("never answers server/discover but answers initialize, then behaves like echo-server", async () => {
    f.send(req("server/discover", {}, "probe"));
    expect(await f.silentFor(500)).toBe(true);

    f.send({
      jsonrpc: "2.0",
      id: "init",
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    });
    const init = await f.next((m) => m.id === "init");
    expect(init.result.protocolVersion).toBe("2025-11-25");
    expect(init.result.serverInfo.name).toBe("legacy-silent-fixture");
    f.send({ jsonrpc: "2.0", method: "notifications/initialized" });

    f.send({ jsonrpc: "2.0", id: "ping", method: "ping" });
    const ping = await f.next((m) => m.id === "ping");
    expect(ping.result).toEqual({});

    f.send({
      jsonrpc: "2.0",
      id: "call",
      method: "tools/call",
      params: { name: "echo", arguments: { message: "yo" } },
    });
    const call = await f.next((m) => m.id === "call");
    expect(call.result.content[0].text).toBe("yo");

    // The pre-init discover stays unanswered even after the handshake.
    expect(await f.silentFor(200)).toBe(true);
  });
});
