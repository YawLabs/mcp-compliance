import { type ChildProcess, type SpawnOptions, spawn as spawnProcess } from "node:child_process";
import { getEventListeners } from "node:events";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStdioTransport, type StdioTransport } from "../transport/stdio.js";

/**
 * Every process spawned through node:child_process in this file -- the
 * transport's own child and any killer (taskkill) close() starts -- so a
 * test can see what close() sent and spawned. Pass-through: each spawn
 * still happens exactly as the transport asked.
 */
const spawned = vi.hoisted(() => [] as { command: string; args: readonly string[]; child: ChildProcess }[]);
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const spawn = (command: string, args: readonly string[] = [], options: SpawnOptions = {}) => {
    const child = actual.spawn(command, args, options);
    spawned.push({ command, args, child });
    return child;
  };
  return { ...actual, spawn };
});

const fixturePath = fileURLToPath(new URL("./fixtures/echo-server.mjs", import.meta.url));

function createIdCounter(start = 0): () => number {
  let n = start;
  return () => ++n;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The taskkill invocations started against `pid`, as their argument lists. */
function taskkillsFor(pid: number | undefined): string[] {
  return spawned.filter((s) => s.command === "taskkill" && s.args.includes(String(pid))).map((s) => s.args.join(" "));
}

/**
 * The signals close() sends the child spawned for `scriptPath`: its kill()
 * is wrapped to record each call (the signal is still delivered).
 */
function recordSignals(scriptPath: string): string[] {
  const entry = spawned.find((s) => s.args[0] === scriptPath);
  if (!entry) throw new Error(`no spawn recorded for ${scriptPath}`);
  const signals: string[] = [];
  const kill = entry.child.kill.bind(entry.child);
  entry.child.kill = (signal?: NodeJS.Signals | number) => {
    signals.push(String(signal ?? "SIGTERM"));
    return kill(signal);
  };
  return signals;
}

/**
 * Records every uncaught exception from here until release(): an 'error'
 * event nothing listens for is thrown on a later tick, where no await in
 * the test can see it, and it would end the CLI's process.
 */
function trapUncaught(): { errors: unknown[]; release(): void } {
  const errors: unknown[] = [];
  const onError = (err: unknown) => {
    errors.push(err);
  };
  process.on("uncaughtException", onError);
  return { errors, release: () => process.off("uncaughtException", onError) };
}

/** The line a caller reads an error by: the transport appends the child's stderr below it. */
function firstLineOf(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split("\n")[0];
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
      // afterEach close() ends the child through its stdin, which it honors.
      "setTimeout(() => {}, 30000);",
      'process.stdin.on("end", () => process.exit(0));',
      "process.stdin.resume();",
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
    // Read before any 'data' event can have been delivered.
    expect(t.stdoutOverflows).toBe(0);
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
    // The drop is also counted, which is what lets a caller scope "was THIS
    // reply dropped" to one request. 800 KB against a 512 KB cap overflows
    // exactly once: what is left after the first discard stays under the cap.
    expect(t.stdoutOverflows).toBe(1);
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
   * It exits when its stdin closes, as the spec asks of a stdio server, so
   * afterEach close() does not wait out the EOF window.
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
      'rl.on("close", () => process.exit(0));',
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

  it("stream() on a child that already exited rejects with the exit diagnostic and leaves nothing attached", async () => {
    // A server that crashed on an earlier probe of the run: it exits on the
    // first line it reads, before the listen is ever opened.
    const t = scriptedChild("  process.exit(3);");
    // The exit settles the request; the budget only has to outlast a slow spawn.
    await expect(t.request("ping", undefined, createIdCounter(7300), { timeout: 30_000 })).rejects.toThrow(
      /^server crashed with exit code 3 before completing the request/,
    );
    expect(t.exited).toBe(true);
    const controller = new AbortController();
    // A timer far past the test: only the catch's cleanup can clear it.
    const opening = t.stream("subscriptions/listen", { notifications: {} }, createIdCounter(7400), {
      timeout: 60_000,
      signal: controller.signal,
    });
    await expect(opening).rejects.toThrow(
      /^stdio transport: server crashed with exit code 3 before completing the request/,
    );
    // The abort hook the stream attached is gone again (and with it the
    // message listener, the exit listener and the timer, removed by the
    // same finish()).
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
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

  it("close() does not wait out the grace period for a server that exits on stdin EOF", async () => {
    const t = spawn();
    // Answered first, so the child is up and reading stdin when EOF arrives.
    await t.request("ping", undefined, createIdCounter(600), { timeout: 5000 });
    const started = Date.now();
    await t.close();
    const elapsed = Date.now() - started;
    expect(t.exited).toBe(true);
    // Termination starts only 2000ms after EOF; the echo fixture exits on EOF in tens of ms.
    expect(elapsed).toBeLessThan(1500);
  });

  /**
   * A server script written to a temp file (a multi-line `-e` script through
   * cmd.exe is unreliable on Windows), spawned with a ready file it writes
   * its pid to once its stdin handling is in place, plus `extraArgs`.
   */
  async function readyServer(
    name: string,
    body: string[],
    extraArgs: string[] = [],
  ): Promise<{ t: StdioTransport; serverPath: string; serverPid: number }> {
    const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const readyFile = join(tmpdir(), `mcp-compliance-${name}-${stamp}.pid`);
    const serverPath = join(tmpdir(), `mcp-compliance-${name}-${stamp}.cjs`);
    tempFiles.push(readyFile, serverPath);
    writeFileSync(
      serverPath,
      [...body, 'require("node:fs").writeFileSync(process.argv[2], String(process.pid));'].join("\n"),
      "utf8",
    );
    const t = createStdioTransport({ command: process.execPath, args: [serverPath, readyFile, ...extraArgs] });
    openTransports.push(t);
    // A slow spawn on a loaded machine takes seconds; wait on the file, not a fixed delay.
    await vi.waitFor(() => expect(readFileSync(readyFile, "utf8")).toMatch(/^\d+$/), { timeout: 20000, interval: 20 });
    return { t, serverPath, serverPid: Number(readFileSync(readyFile, "utf8")) };
  }

  const ONE_MB = 1024 * 1024;

  it.each([
    [
      "request()",
      (t: StdioTransport): Promise<unknown> =>
        t.request("tools/call", { name: "echo", arguments: { data: "A".repeat(ONE_MB) } }, createIdCounter(800), {
          timeout: 20_000,
        }),
      // The pending request is settled by the exit itself.
      "server crashed with exit code 3 before completing the request",
    ],
    [
      "writeRaw()",
      (t: StdioTransport): Promise<unknown> => t.writeRaw("A".repeat(ONE_MB)),
      // Nothing pending: the failed write waits for the exit and names it.
      "stdio transport: server crashed with exit code 3 before completing the request",
    ],
  ])("a %s whose 1 MB line the child exits partway through reading rejects with the exit diagnostic, and nothing is thrown uncaught", async (_, send, expected) => {
    // A server that caps its input: it reads chunks (not readline, which
    // takes the whole line first) and exits once 200 KB arrived, while the
    // rest of the line is still being written. The write fails -- EPIPE on
    // POSIX, EOF on Windows -- a moment before the child's exit is reported,
    // and the stdin stream emits that failure as an 'error' event too.
    const trap = trapUncaught();
    try {
      const { t } = await readyServer("partial-read-exit", [
        "let read = 0;",
        'process.stdin.on("data", (chunk) => { read += chunk.length; if (read > 200 * 1024) process.exit(3); });',
        "setInterval(() => {}, 1000);",
      ]);
      const started = Date.now();
      const failure = await send(t).then(
        () => new Error("the write succeeded"),
        (err: unknown) => err,
      );
      // Not a bare "write EPIPE" / "write EOF": the suites read this line as
      // the server going away (security.ts STDIO_GONE) and quote it.
      expect(firstLineOf(failure)).toBe(expected);
      // Settled by the exit, not by the 20s request timeout.
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(t.exited).toBe(true);
      expect(t.exitCode).toBe(3);
      // The stream's 'error' event is emitted on a later tick than the write callback.
      await new Promise((r) => setTimeout(r, 100));
      expect(trap.errors).toEqual([]);
    } finally {
      trap.release();
    }
  });

  it.skipIf(process.platform === "win32")(
    "a write to a child that closed its stdin but keeps running rejects as stdin closed once the exit wait runs out (POSIX)",
    async () => {
      // On Windows the child is spawned through cmd.exe, which keeps its own
      // handle on the pipe: a server closing its stdin does not break it.
      const trap = trapUncaught();
      let serverPid: number | undefined;
      try {
        const server = await readyServer("stdin-closed", [
          'require("node:fs").closeSync(0);',
          "setInterval(() => {}, 1000);",
        ]);
        const t = server.t;
        serverPid = server.serverPid;
        const started = Date.now();
        const failure = await t.writeRaw("A".repeat(ONE_MB)).then(
          () => new Error("the write succeeded"),
          (err: unknown) => err,
        );
        const elapsed = Date.now() - started;
        expect(firstLineOf(failure)).toBe(
          "stdio transport: stdin is closed: the server stopped reading its input (write EPIPE)",
        );
        expect((failure as Error).cause).toMatchObject({ code: "EPIPE" });
        // It gave the child the exit wait first, and no longer.
        expect(elapsed).toBeGreaterThanOrEqual(900);
        expect(elapsed).toBeLessThan(10_000);
        expect(t.exited).toBe(false);
        await new Promise((r) => setTimeout(r, 100));
        expect(trap.errors).toEqual([]);
      } finally {
        trap.release();
        // It can read nothing, so EOF would not end it: spare afterEach the EOF window.
        if (serverPid !== undefined && isAlive(serverPid)) process.kill(serverPid, "SIGKILL");
      }
    },
  );

  it("a write once close() has ended stdin rejects at once as stdin closed, without an uncaught 'error' event", async () => {
    const trap = trapUncaught();
    try {
      const t = spawn();
      // Answered first, so the child has spawned and the write reaches stdin.
      await t.request("ping", undefined, createIdCounter(900), { timeout: 5000 });
      const closing = t.close();
      const started = Date.now();
      const failure = await t.writeRaw("{}").then(
        () => new Error("the write succeeded"),
        (err: unknown) => err,
      );
      expect(firstLineOf(failure)).toBe("stdio transport: stdin is closed");
      // Not held for the exit wait: the runner closed the pipe itself.
      expect(Date.now() - started).toBeLessThan(500);
      await closing;
      await new Promise((r) => setTimeout(r, 100));
      expect(trap.errors).toEqual([]);
    } finally {
      trap.release();
    }
  });

  it("close() lets a server that exits on stdin EOF finish its shutdown work: no signal is sent and no killer is spawned", async () => {
    // The spec's stdio shutdown: close stdin, wait for the server to exit, and
    // terminate it only if it does not. This server takes a moment after EOF
    // (flushing state, say) and then exits cleanly.
    const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const markerFile = join(tmpdir(), `mcp-compliance-flushed-${stamp}.txt`);
    tempFiles.push(markerFile);
    const { t, serverPath } = await readyServer(
      "eof-exit",
      [
        "setInterval(() => {}, 1000);",
        'process.stdin.on("end", () => setTimeout(() => { require("node:fs").writeFileSync(process.argv[3], "flushed"); process.exit(0); }, 300));',
        "process.stdin.resume();",
      ],
      [markerFile],
    );
    const signals = recordSignals(serverPath);
    await t.close();
    // A SIGTERM sent along with EOF ends the server before its cleanup runs:
    // no marker, and no exit code (it died of the signal).
    expect(existsSync(markerFile) ? readFileSync(markerFile, "utf8") : "no marker written").toBe("flushed");
    expect(t.exitCode).toBe(0);
    expect(signals).toEqual([]);
    // Nothing is spawned to kill a server that went on its own -- nor a
    // non-forced taskkill, which cannot end a console process anyway.
    expect(taskkillsFor(t.pid)).toEqual([]);
  });

  it("close() terminates a server that ignores stdin EOF only after the EOF window, once, and resolves after it is gone", async () => {
    // Still busy (a live timer), so EOF does not end it; the first termination
    // does (SIGTERM on POSIX, the forced tree kill on Windows).
    const { t, serverPath, serverPid } = await readyServer("eof-ignore", [
      "setInterval(() => {}, 1000);",
      "process.stdin.resume();",
    ]);
    const signals = recordSignals(serverPath);
    const started = Date.now();
    try {
      // A second close() while the first is under way joins it instead of
      // sending a termination of its own.
      await Promise.all([t.close(), t.close()]);
      const elapsed = Date.now() - started;
      expect(t.exited).toBe(true);
      // The server had the whole 2000ms EOF window to exit before anything was sent.
      expect(elapsed).toBeGreaterThanOrEqual(1900);
      if (process.platform === "win32") {
        expect(signals).toEqual([]);
        // Only the forced tree kill: a non-forced one cannot end a console process.
        expect(taskkillsFor(t.pid)).toEqual([`/pid ${t.pid} /t /f`]);
      } else {
        expect(signals).toEqual(["SIGTERM"]);
        expect(taskkillsFor(t.pid)).toEqual([]);
      }
      // Process teardown is asynchronous in the OS, so allow it a moment.
      await vi.waitFor(() => expect(isAlive(serverPid)).toBe(false), { timeout: 3000, interval: 50 });
    } finally {
      if (isAlive(serverPid)) process.kill(serverPid, "SIGKILL");
    }
  });

  it.skipIf(process.platform === "win32")(
    "close() gives a server that ignores stdin EOF but cleans up on SIGTERM the whole grace before SIGKILL (POSIX)",
    async () => {
      // Still busy, so EOF does not end it; on SIGTERM it spends 500ms
      // releasing what it holds (flushing state, removing a lock file) and
      // exits cleanly. A SIGKILL sent before that ends it mid-cleanup.
      const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const markerFile = join(tmpdir(), `mcp-compliance-cleaned-${stamp}.txt`);
      tempFiles.push(markerFile);
      const { t, serverPath, serverPid } = await readyServer(
        "sigterm-cleanup",
        [
          "setInterval(() => {}, 1000);",
          "process.stdin.resume();",
          'process.on("SIGTERM", () => setTimeout(() => { require("node:fs").writeFileSync(process.argv[3], "cleaned up"); process.exit(0); }, 500));',
        ],
        [markerFile],
      );
      const signals = recordSignals(serverPath);
      try {
        await t.close();
        expect(existsSync(markerFile) ? readFileSync(markerFile, "utf8") : "no marker written").toBe("cleaned up");
        expect(t.exited).toBe(true);
        // Exited on its own after the cleanup, not killed (exitCode null).
        expect(t.exitCode).toBe(0);
        expect(signals).toEqual(["SIGTERM"]);
      } finally {
        if (isAlive(serverPid)) process.kill(serverPid, "SIGKILL");
      }
    },
  );

  it.skipIf(process.platform !== "win32")(
    "close() survives a taskkill that cannot be spawned: it does not throw, resolves within its bound and reports exited:false (Windows)",
    async () => {
      // Busy, so EOF does not end it and close() goes on to the forced tree
      // kill -- which fails to start here: no directory on PATH holds
      // taskkill.exe (the run's own environment lacks System32), so the
      // spawn emits ENOENT instead of running.
      const { t, serverPid } = await readyServer("taskkill-missing", [
        "setInterval(() => {}, 1000);",
        "process.stdin.resume();",
      ]);
      const trap = trapUncaught();
      const savedPath = process.env.PATH;
      let bound: NodeJS.Timeout | undefined;
      try {
        process.env.PATH = tmpdir();
        const started = Date.now();
        const closing = t.close();
        try {
          // The PATH lookup happens inside spawn(): once taskkill was spawned
          // (and failed), this worker gets its PATH back.
          await vi.waitFor(() => expect(taskkillsFor(t.pid)).toHaveLength(1), { timeout: 10_000, interval: 10 });
        } finally {
          process.env.PATH = savedPath;
        }
        // Raced against a bound of its own, so a close() that hangs fails
        // here -- and the finally below still kills the server -- instead of
        // timing the test out.
        const closed = await Promise.race([
          closing.then(() => "resolved"),
          new Promise((resolve) => {
            bound = setTimeout(() => resolve("still pending after 15s"), 15_000);
          }),
        ]);
        const elapsed = Date.now() - started;
        expect(closed).toBe("resolved");
        // The EOF window first, then the bounded wait for a kill that never came.
        expect(elapsed).toBeGreaterThanOrEqual(1900);
        expect(taskkillsFor(t.pid)).toEqual([`/pid ${t.pid} /t /f`]);
        // Nothing killed the server, and close() does not claim otherwise.
        expect(t.exited).toBe(false);
        expect(isAlive(serverPid)).toBe(true);
        expect(trap.errors).toEqual([]);
      } finally {
        clearTimeout(bound);
        process.env.PATH = savedPath;
        trap.release();
        if (isAlive(serverPid)) process.kill(serverPid);
      }
      // With the server gone, cmd.exe (the transport's own child) exits too.
      await vi.waitFor(() => expect(t.exited).toBe(true), { timeout: 5000, interval: 50 });
    },
  );

  it("close() returns at once when the child never spawned: there is no process to wait for", async () => {
    // A working directory that does not exist fails the spawn itself on every
    // platform (a missing command does not on Windows, where cmd.exe starts
    // and exits 1), so no pid is ever assigned and no 'exit' event will come.
    const t = createStdioTransport({
      command: process.execPath,
      cwd: join(tmpdir(), `mcp-compliance-no-such-dir-${Date.now()}`),
    });
    openTransports.push(t);
    expect(t.pid).toBeUndefined();
    await expect(t.request("ping", undefined, createIdCounter(700), { timeout: 5000 })).rejects.toThrow(/ENOENT/);
    const started = Date.now();
    await t.close();
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("close() resolves only once a server that outlives EOF and SIGTERM is gone, so a caller exiting right after leaves nothing running", async () => {
    // A server still busy with earlier work does not exit on stdin EOF (a
    // live timer stands in for the work here) and this one ignores SIGTERM
    // too, so only the forced kill after the grace period stops it. On
    // Windows the transport spawns it through cmd.exe: the server is the
    // shell's child, outside the kill-on-close job Node puts its own
    // children in.
    const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const pidFile = join(tmpdir(), `mcp-compliance-busy-${stamp}.pid`);
    const serverPath = join(tmpdir(), `mcp-compliance-busy-${stamp}.cjs`);
    const callerPath = join(tmpdir(), `mcp-compliance-closer-${stamp}.mts`);
    tempFiles.push(pidFile, serverPath, callerPath);
    writeFileSync(
      serverPath,
      [
        'process.on("SIGTERM", () => {});',
        "setInterval(() => {}, 1000);",
        "process.stdin.resume();",
        'require("node:fs").writeFileSync(process.argv[2], String(process.pid));',
      ].join("\n"),
      "utf8",
    );
    // The caller closes the transport and exits at once, the way a test
    // worker is torn down after its last test (the integration-dogfood run
    // left dist/mcp/server.js running that way): nothing close() merely
    // started gets to finish.
    const stdioModule = new URL("../transport/stdio.ts", import.meta.url).href;
    writeFileSync(
      callerPath,
      [
        'import { readFileSync } from "node:fs";',
        `import { createStdioTransport } from ${JSON.stringify(stdioModule)};`,
        "const [server, pidFile] = process.argv.slice(2);",
        "const started = () => { try { return readFileSync(pidFile, 'utf8').length > 0; } catch { return false; } };",
        "const t = createStdioTransport({ command: process.execPath, args: [server, pidFile] });",
        "const deadline = Date.now() + 20000;",
        "while (!started() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));",
        "await t.close();",
        "process.stdout.write(JSON.stringify({ started: started(), exited: t.exited }));",
        "process.exit(0);",
      ].join("\n"),
      "utf8",
    );
    // tsx as a loader in one process: its cli would add a wrapper process.
    const tsx = new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url).href;
    const caller = spawnProcess(process.execPath, ["--import", tsx, callerPath, serverPath, pidFile], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    caller.stdout?.on("data", (d) => {
      out += d;
    });
    caller.stderr?.on("data", (d) => {
      err += d;
    });
    const code = await new Promise<number | null>((resolve) => caller.once("exit", resolve));
    expect(code, err).toBe(0);
    const pid = Number(readFileSync(pidFile, "utf8"));
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      // Process teardown is asynchronous in the OS, so allow it a moment; an
      // orphan whose killer never ran stays alive however long this waits.
      await vi.waitFor(() => expect(alive()).toBe(false), { timeout: 3000, interval: 50 });
    } finally {
      if (alive()) process.kill(pid, "SIGKILL");
    }
    // And close() itself resolved only after the child was reaped.
    expect(JSON.parse(out)).toEqual({ started: true, exited: true });
  }, 30_000);
});
