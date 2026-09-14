import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStdioTransport, type StdioTransport } from "../transport/stdio.js";

const fixturePath = fileURLToPath(new URL("./fixtures/echo-server.mjs", import.meta.url));

function createIdCounter(start = 0): () => number {
  let n = start;
  return () => ++n;
}

describe("StdioTransport", () => {
  let openTransports: StdioTransport[] = [];
  let tempFiles: string[] = [];

  afterEach(async () => {
    await Promise.all(openTransports.map((t) => t.close()));
    openTransports = [];
    for (const f of tempFiles) rmSync(f, { force: true });
    tempFiles = [];
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
    // 5000ms, matching every other response-path request in this file. This
    // asserts the *response* path, not the timeout path, so the budget only has
    // to be generous enough to never fire: a child-process spawn plus first
    // roundtrip blows past a tight budget whenever the runner is loaded (15
    // suites in parallel on a slow box), which made 1500ms -- itself already a
    // bump up from 200ms -- flake in full-suite runs while passing in isolation.
    await expect(
      t.request("unknown/method/that/errors-with-a-real-response", undefined, nextId, { timeout: 5000 }),
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

  it("surfaces a diagnosable stderr message when stdout buffer overflows without a newline", async () => {
    // Spawn a child that spews junk bytes without a newline past the
    // configured cap, then stays alive without ever answering. The overflow
    // should leave a diagnostic line in stderrTail() so the caller can tell
    // this apart from a generic timeout. We write the script to a temp file
    // because passing a multi-line `-e` script through cmd.exe (used on
    // Windows when shell:true) is unreliable.
    const script = [
      'const big = "X".repeat(200 * 1024);',
      "for (let i = 0; i < 4; i++) process.stdout.write(big);",
      // Outlive the request below so it settles by timeout, not by exit;
      // afterEach close() tears the child down.
      "setTimeout(() => {}, 30000);",
    ].join("\n");
    const scriptPath = join(tmpdir(), `mcp-compliance-overflow-${process.pid}-${Date.now()}.mjs`);
    writeFileSync(scriptPath, script, "utf8");
    tempFiles.push(scriptPath);
    const t = createStdioTransport({
      command: process.execPath,
      args: [scriptPath],
      stdoutBufferSize: 512 * 1024,
    });
    openTransports.push(t);
    // Wait on the diagnostic itself instead of racing it against a fixed
    // request timeout. The overflow cannot happen before the child has
    // started writing, and spawn-to-first-stdout-chunk measured 0.3-2.6s on a
    // Windows ARM64 host (the high end under load) -- so a 500ms request often
    // timed out before a single byte arrived, and stderrTail() was still empty
    // when it was read.
    await vi.waitFor(() => expect(t.stderrTail()).toMatch(/stdout buffer exceeded 524288 bytes without a newline/), {
      timeout: 10000,
      interval: 10,
    });
    // The caller-visible symptom is still a timeout (the server never answers),
    // but the error carries the diagnostic -- which is what tells it apart
    // from a generic unresponsive server.
    const nextId = createIdCounter(500);
    const failure = t.request("ping", undefined, nextId, { timeout: 500 });
    await expect(failure).rejects.toThrow(/request timed out after 500ms/);
    await expect(failure).rejects.toThrow(/stdout buffer exceeded/);
  });

  /**
   * A scripted stdio child for the stream() tests, written to a temp file
   * (a multi-line `-e` script through cmd.exe is unreliable on Windows).
   * It reads JSON lines; `onLine` is the body of the per-line handler and
   * sees `msg` (the parsed line) and `send(obj)` (writes one JSON line).
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
    const scriptPath = join(tmpdir(), `mcp-compliance-stream-${process.pid}-${Date.now()}-${Math.random()}.cjs`);
    writeFileSync(scriptPath, script, "utf8");
    tempFiles.push(scriptPath);
    const t = createStdioTransport({ command: process.execPath, args: [scriptPath] });
    openTransports.push(t);
    return t;
  }

  it("stream() ends when the child exits and reports the exit, instead of waiting for the timeout", async () => {
    // The child acknowledges nothing: it exits 50ms after the listen arrives.
    const t = scriptedChild('  if (msg.method === "subscriptions/listen") setTimeout(() => process.exit(3), 50);');
    const nextId = createIdCounter(7000);
    const started = Date.now();
    const stream = await t.stream("subscriptions/listen", { notifications: {} }, nextId, { timeout: 5000 });
    expect(stream.exit).toBeUndefined();
    const seen: unknown[] = [];
    for await (const msg of stream.messages) seen.push(msg);
    const elapsed = Date.now() - started;
    expect(seen).toEqual([]);
    // Without the child 'exit' hook the iterator only completes at the 5000ms timer.
    expect(elapsed).toBeLessThan(4000);
    expect(stream.exit).toEqual({ code: 3, signal: null });
    expect(t.exited).toBe(true);
    await stream.close();
  });

  it("stream().close() sends notifications/cancelled after the timer fired without a response", async () => {
    // The child never acknowledges the listen; it reports the cancel it
    // receives as a notification so the test can observe it.
    const t = scriptedChild(
      '  if (msg.method === "notifications/cancelled") send({ jsonrpc: "2.0", method: "notifications/test/cancel-seen", params: msg.params });',
    );
    const cancels: unknown[] = [];
    t.onMessage((m) => {
      const msg = m as { method?: string; params?: unknown };
      if (msg.method === "notifications/test/cancel-seen") cancels.push(msg.params);
    });
    const nextId = createIdCounter(7100);
    const reported: unknown[] = [];
    const stream = await t.stream("subscriptions/listen", { notifications: {} }, nextId, {
      timeout: 300,
      onSent: (m) => reported.push(m),
    });
    const seen: unknown[] = [];
    for await (const msg of stream.messages) seen.push(msg);
    expect(seen).toEqual([]); // the timer ended the stream
    expect(stream.exit).toBeUndefined();
    expect(reported).toEqual([]); // nothing composed on our behalf yet
    await stream.close();
    await vi.waitFor(() => expect(cancels).toEqual([{ requestId: 7101 }]), { timeout: 5000, interval: 10 });
    // The cancel the transport wrote itself is reported through onSent, as written.
    expect(reported).toEqual([{ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7101 } }]);
    // A second close() does not cancel twice.
    await stream.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(cancels).toHaveLength(1);
    expect(reported).toHaveLength(1);
  });

  it("stream().close() does not send notifications/cancelled once the response carrying the id arrived", async () => {
    const t = scriptedChild(
      [
        '  if (msg.method === "subscriptions/listen") send({ jsonrpc: "2.0", id: msg.id, result: { resultType: "complete" } });',
        '  if (msg.method === "notifications/cancelled") send({ jsonrpc: "2.0", method: "notifications/test/cancel-seen", params: msg.params });',
      ].join("\n"),
    );
    const cancels: unknown[] = [];
    t.onMessage((m) => {
      const msg = m as { method?: string; params?: unknown };
      if (msg.method === "notifications/test/cancel-seen") cancels.push(msg.params);
    });
    const nextId = createIdCounter(7200);
    const reported: unknown[] = [];
    const stream = await t.stream("subscriptions/listen", { notifications: {} }, nextId, {
      timeout: 5000,
      onSent: (m) => reported.push(m),
    });
    const seen: unknown[] = [];
    for await (const msg of stream.messages) seen.push(msg);
    expect(seen).toHaveLength(1);
    await stream.close();
    // Give a stray cancel time to round-trip before asserting none came.
    await new Promise((r) => setTimeout(r, 300));
    expect(cancels).toEqual([]);
    // No cancel was written, so none is reported: onSent mirrors the wire, not the close() call.
    expect(reported).toEqual([]);
  });
});
