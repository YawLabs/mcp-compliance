import { rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createModernClient, describeResponse, errorOf, type ModernClient } from "../modern/client.js";
import { createRecorder, type Recorder } from "../recorder.js";
import { createHttpTransport } from "../transport/http.js";
import type { Transport } from "../transport/index.js";
import { createStdioTransport, type StdioTransport } from "../transport/stdio.js";

/**
 * ModernClient over the real transports: an in-file node:http stub whose
 * reply each test sets, and scripted stdio children. The client's own
 * contract is what these pin -- what it records, and the text its
 * response helpers put into test details.
 */

interface StubReply {
  status: number;
  contentType: string;
  body: string;
}

let server: Server;
let serverUrl: string;
let reply: (body: string) => StubReply = () => ({ status: 500, contentType: "text/plain", body: "no reply set" });

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const { status, contentType, body } = reply(Buffer.concat(chunks).toString("utf8"));
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

let openTransports: StdioTransport[] = [];
let tempFiles: string[] = [];

afterEach(async () => {
  await Promise.all(openTransports.map((t) => t.close()));
  openTransports = [];
  for (const f of tempFiles) rmSync(f, { force: true });
  tempFiles = [];
});

/** How the modern suite builds its client: every received message goes to the recorder. */
function clientOver(transport: Transport): { client: ModernClient; recorder: Recorder } {
  const recorder = createRecorder();
  transport.onMessage((m, meta) => recorder.recordReceived(m, meta));
  let id = 1000;
  const client = createModernClient({
    transport,
    recorder,
    nextId: () => id++,
    timeout: 5000,
    protocolVersion: "2026-07-28",
    clientCapabilities: { elicitation: {} },
    clientInfo: { name: "client-test", version: "0.0.0" },
  });
  return { client, recorder };
}

/**
 * A scripted stdio server, written to a temp file (a multi-line `-e`
 * script through cmd.exe is unreliable on Windows). `onLine` is the body
 * of the per-line handler: it sees `msg` (the parsed line) and `send(obj)`.
 */
function scriptedChild(onLine: string): StdioTransport {
  const script = [
    'const rl = require("node:readline").createInterface({ input: process.stdin });',
    'const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");',
    'rl.on("line", (line) => {',
    "  let msg;",
    "  try { msg = JSON.parse(line); } catch { return; }",
    onLine,
    "});",
    "setTimeout(() => {}, 30000);",
  ].join("\n");
  const scriptPath = join(tmpdir(), `mcp-compliance-client-${process.pid}-${Date.now()}-${Math.random()}.cjs`);
  writeFileSync(scriptPath, script, "utf8");
  tempFiles.push(scriptPath);
  const t = createStdioTransport({ command: process.execPath, args: [scriptPath] });
  openTransports.push(t);
  return t;
}

describe("ModernClient.raw(): the reply to a raw probe reaches the recorder", () => {
  // Raw probes bypass the transport's parser, so raw() records the reply
  // itself, and the post-hoc checks that do not exempt raw probes
  // (error-retired-codes) only ever see what it recorded.

  it("an SSE reply whose JSON the server split across several data: lines is recorded whole, after the event before it", async () => {
    const progress = {
      jsonrpc: "2.0",
      method: "notifications/message",
      params: { level: "info", data: "parsing request" },
    };
    const parseError = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };
    // An SSE writer that encodes a newline-bearing payload the way the SSE
    // spec says to: one data: line per line of the pretty-printed JSON.
    const pretty = JSON.stringify(parseError, null, 2).split("\n");
    expect(pretty.length).toBeGreaterThan(1);
    const sse = [
      `event: message\ndata: ${JSON.stringify(progress)}\n\n`,
      `event: message\n${pretty.map((line) => `data: ${line}`).join("\n")}\n\n`,
    ].join("");
    let probeBody = "";
    reply = (body) => {
      probeBody = body;
      return { status: 400, contentType: "text/event-stream", body: sse };
    };
    const { client, recorder } = clientOver(createHttpTransport({ url: serverUrl }));
    const res = await client.raw("{not json", { method: "server/discover" });
    expect(probeBody).toBe("{not json");
    expect(res.statusCode).toBe(400);
    expect(res.body).toBe(sse);
    expect(recorder.sent).toMatchObject([{ id: undefined, method: "server/discover", raw: "{not json" }]);
    expect(recorder.received.map((r) => ({ message: r.message, statusCode: r.statusCode }))).toEqual([
      { message: progress, statusCode: 400 },
      { message: parseError, statusCode: 400 },
    ]);
  });
});

describe("describeResponse: transport-neutral detail text", () => {
  // Every caller appends the HTTP status itself (" (HTTP 502)" on HTTP,
  // nothing on stdio), so the summary must not carry one: on stdio the
  // status is the synthetic 200, and on HTTP it would be printed twice.

  it("an HTTP gateway's HTML 502 on server/discover is a non-JSON-RPC body, with no status of its own", async () => {
    reply = () => ({ status: 502, contentType: "text/html", body: "<html><body>502 Bad Gateway</body></html>" });
    const { client } = clientOver(createHttpTransport({ url: serverUrl }));
    const res = await client.rpc("server/discover", {});
    expect(res.statusCode).toBe(502);
    expect(describeResponse(res)).toBe("non-JSON-RPC body");
  });

  it("a stdio server answering server/discover with result: null names no HTTP status (stdio has none)", async () => {
    const t = scriptedChild(
      '  if (msg.method === "server/discover") send({ jsonrpc: "2.0", id: msg.id, result: null });',
    );
    const { client } = clientOver(t);
    const res = await client.rpc("server/discover", {});
    expect(res.body).toEqual({ jsonrpc: "2.0", id: 1000, result: null });
    // rpc() reports stdio as a synthetic 200 ...
    expect(res.statusCode).toBe(200);
    // ... which the summary must not present as an HTTP answer.
    expect(describeResponse(res)).toBe("non-JSON-RPC body");
  });

  it("names a JSON-RPC error by code and message, and a result object as 'result'", () => {
    const base = { requestId: 1, statusCode: 200, headers: {}, messages: [] };
    expect(
      describeResponse({
        ...base,
        body: { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } },
      }),
    ).toBe("JSON-RPC error -32601 (Method not found)");
    expect(describeResponse({ ...base, body: { jsonrpc: "2.0", id: 1, error: { code: -32603, message: "" } } })).toBe(
      "JSON-RPC error -32603",
    );
    expect(describeResponse({ ...base, body: { jsonrpc: "2.0", id: 1, result: { resultType: "complete" } } })).toBe(
      "result",
    );
  });
});

describe("errorOf: a malformed error object never passes for a well-formed one", () => {
  it("a server answering an unknown method with a string code and a non-string message", async () => {
    // JSON-RPC requires an integer code and a string message. "-32601" as
    // a string must not count as -32601, or error-method-code would pass a
    // server that sends the wrong type.
    reply = (body) => {
      const { id } = JSON.parse(body) as { id: number };
      return {
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ jsonrpc: "2.0", id, error: { code: "-32601", message: { text: "no such method" } } }),
      };
    };
    const { client } = clientOver(createHttpTransport({ url: serverUrl }));
    const res = await client.rpc("compliance/nonexistent-method", {});
    const err = errorOf(res.body);
    expect(err).toBeDefined();
    expect(err?.code).toBeNaN();
    expect(err?.code).not.toBe(-32601);
    expect(err?.message).toBe("");
    expect(describeResponse(res)).toBe("JSON-RPC error NaN");
  });

  it("an empty error object is still an error, with code NaN and an empty message", () => {
    expect(errorOf({ jsonrpc: "2.0", id: 1, error: {} })).toEqual({ code: Number.NaN, message: "", data: undefined });
  });

  it("a well-formed error passes through with its data; a missing or non-object error is no error", () => {
    expect(errorOf({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "bad", data: { field: "x" } } })).toEqual({
      code: -32602,
      message: "bad",
      data: { field: "x" },
    });
    expect(errorOf({ jsonrpc: "2.0", id: 1, error: "boom" })).toBeUndefined();
    expect(errorOf({ jsonrpc: "2.0", id: 1, result: {} })).toBeUndefined();
    expect(errorOf(null)).toBeUndefined();
    expect(errorOf("error")).toBeUndefined();
  });
});
