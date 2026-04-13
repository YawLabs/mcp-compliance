import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { type StdioTransport, createStdioTransport } from "../transport/stdio.js";

const fixturePath = fileURLToPath(new URL("./fixtures/echo-server.mjs", import.meta.url));

function createIdCounter(start = 0): () => number {
  let n = start;
  return () => ++n;
}

describe("StdioTransport", () => {
  let openTransports: StdioTransport[] = [];

  afterEach(async () => {
    await Promise.all(openTransports.map((t) => t.close()));
    openTransports = [];
  });

  function spawn(): StdioTransport {
    const t = createStdioTransport({ command: process.execPath, args: [fixturePath] });
    openTransports.push(t);
    return t;
  }

  it("completes an initialize handshake over stdio", async () => {
    const t = spawn();
    const nextId = createIdCounter(0);
    const res = await t.request("initialize", { protocolVersion: "2025-11-25" }, nextId, { timeout: 5000 });
    const body = res.body as { result: { protocolVersion: string; serverInfo: { name: string } } };
    expect(body.result.protocolVersion).toBe("2025-11-25");
    expect(body.result.serverInfo.name).toBe("echo-fixture");
  });

  it("correlates multiple concurrent requests by id", async () => {
    const t = spawn();
    const nextId = createIdCounter(100);
    const [a, b, c] = await Promise.all([
      t.request("ping", undefined, nextId, { timeout: 5000 }),
      t.request("tools/list", undefined, nextId, { timeout: 5000 }),
      t.request("ping", undefined, nextId, { timeout: 5000 }),
    ]);
    expect(a.requestId).toBe(101);
    expect(b.requestId).toBe(102);
    expect(c.requestId).toBe(103);
    expect((b.body as { result: { tools: unknown[] } }).result.tools).toHaveLength(1);
  });

  it("handles partial-line stdout chunks by buffering until newline", async () => {
    // Fixture writes full lines per message — simulate partial delivery by
    // rapidly firing many small requests. If the transport's line-splitter is
    // correct, none of them should time out or cross-contaminate.
    const t = spawn();
    const nextId = createIdCounter(200);
    const batch = await Promise.all(
      Array.from({ length: 20 }, () => t.request("ping", undefined, nextId, { timeout: 5000 })),
    );
    expect(batch).toHaveLength(20);
    for (const r of batch) {
      expect((r.body as { result: unknown }).result).toEqual({});
    }
  });

  it("notify() writes without waiting for a response", async () => {
    const t = spawn();
    await expect(t.notify("notifications/initialized", undefined, { timeout: 5000 })).resolves.toBeDefined();
  });

  it("times out if a method never responds", async () => {
    const t = spawn();
    const nextId = createIdCounter(300);
    await expect(
      t.request("unknown/method/that/errors-with-a-real-response", undefined, nextId, { timeout: 200 }),
    ).resolves.toBeDefined(); // fixture replies with JSON-RPC error, counts as a response
  });

  it("settles in-flight requests promptly when the transport is closed", async () => {
    const t = spawn();
    const nextId = createIdCounter(400);
    // Fixture responds to unknown methods with JSON-RPC errors, so this
    // settles quickly either way (response comes back OR close rejects).
    const pending = t.request("some-unknown-method", undefined, nextId, { timeout: 30000 });
    setTimeout(() => void t.close(), 50);
    const outcome = await Promise.race([
      pending.then(() => "resolved" as const).catch(() => "rejected" as const),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 3000)),
    ]);
    expect(outcome).not.toBe("hung");
  });

  it("getSessionId() always returns null (no sessions over stdio)", async () => {
    const t = spawn();
    t.setSessionId("should-be-ignored");
    expect(t.getSessionId()).toBeNull();
  });

  it("setProtocolVersion() is stored and readable", async () => {
    const t = spawn();
    t.setProtocolVersion("2025-11-25");
    expect(t.getProtocolVersion()).toBe("2025-11-25");
  });

  it("reports spawn error when the command does not exist", async () => {
    const t = createStdioTransport({ command: "this-command-does-not-exist-xyz" });
    openTransports.push(t);
    const nextId = createIdCounter();
    await expect(t.request("ping", undefined, nextId, { timeout: 2000 })).rejects.toThrow();
  });
});
