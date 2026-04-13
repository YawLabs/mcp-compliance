import { type ChildProcess, spawn } from "node:child_process";
import type { Transport, TransportNotifyResult, TransportResponse } from "./index.js";

export interface StdioTransportOptions {
  command: string;
  args?: string[];
  /** Extra env vars merged on top of process.env. */
  env?: Record<string, string>;
  cwd?: string;
  /** Forward child stderr to our stderr. Default: capture only (stderrTail). */
  verbose?: boolean;
  /** Rolling stderr buffer size in bytes. Default 64KB. */
  stderrBufferSize?: number;
  /**
   * Hard cap on un-newline-terminated stdout buffer in bytes. A
   * misbehaving server that spews one giant line without a trailing
   * newline would otherwise grow this unbounded. Default 1MB.
   */
  stdoutBufferSize?: number;
}

export interface StdioTransport extends Transport {
  readonly kind: "stdio";
  readonly command: string;
  readonly args: readonly string[];
  readonly pid: number | undefined;
  /** Last N bytes of stderr as a string, for debugging failures. */
  stderrTail(): string;
  /** Whether the child has exited. */
  readonly exited: boolean;
  /** Exit code once the child has exited, null otherwise. */
  readonly exitCode: number | null;
}

interface PendingRequest {
  resolve: (res: TransportResponse) => void;
  reject: (err: Error) => void;
  id: number;
  timer: NodeJS.Timeout;
}

export function createStdioTransport(opts: StdioTransportOptions): StdioTransport {
  const { command, args = [], env, cwd, verbose = false } = opts;
  const stderrBufferSize = opts.stderrBufferSize ?? 64 * 1024;
  const stdoutBufferSize = opts.stdoutBufferSize ?? 1024 * 1024;

  const isWindows = process.platform === "win32";
  const child: ChildProcess = spawn(command, args, {
    env: env ? { ...process.env, ...env } : process.env,
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    // Windows .cmd/.bat shims (npx, npm) need shell:true to launch.
    shell: isWindows,
  });

  let protocolVersion: string | null = null;
  let exited = false;
  let exitCode: number | null = null;
  let spawnError: Error | null = null;
  let spawned = false;
  const pending = new Map<number, PendingRequest>();
  let stdoutBuffer = "";
  let stderrBuffer = "";

  // Wait for the 'spawn' event before accepting writes. Without this,
  // request() called immediately after createStdioTransport() would
  // race the spawn — pending requests would queue but spawn errors
  // could fire AFTER the timer was set, leaving the request hung.
  const spawnReady = new Promise<void>((resolve, reject) => {
    child.once("spawn", () => {
      spawned = true;
      resolve();
    });
    child.once("error", (err) => {
      // If spawn never fires (binary not found, EACCES, etc.) the
      // 'error' event surfaces here. Reject so first request fails fast.
      if (!spawned) reject(err);
    });
  });
  // Swallow unhandled rejection — request() awaits this promise itself.
  spawnReady.catch(() => {});

  child.on("error", (err) => {
    spawnError = err;
    rejectAllPending(err);
  });

  child.on("exit", (code, signal) => {
    exited = true;
    exitCode = code;
    if (pending.size > 0) {
      const reason = signal ? `child exited (signal ${signal})` : `child exited with code ${code}`;
      rejectAllPending(new Error(reason));
    }
  });

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let idx: number;
    // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic line splitter
    while ((idx = stdoutBuffer.indexOf("\n")) !== -1) {
      const line = stdoutBuffer.slice(0, idx);
      stdoutBuffer = stdoutBuffer.slice(idx + 1);
      handleLine(line);
    }
    // Hard cap: if a single line never terminates, drop the buffer to
    // keep memory bounded. The dropped bytes are gone — no parsing
    // attempt — and the next newline starts a fresh line.
    if (stdoutBuffer.length > stdoutBufferSize) {
      stdoutBuffer = "";
    }
  });

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    if (verbose) process.stderr.write(chunk);
    stderrBuffer += chunk;
    if (stderrBuffer.length > stderrBufferSize) {
      stderrBuffer = stderrBuffer.slice(stderrBuffer.length - stderrBufferSize);
    }
  });

  function handleLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Ignore lines that aren't valid JSON — some servers emit banners
      // before they're ready, and we don't want to crash the transport.
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const msg = parsed as { id?: number | string; jsonrpc?: string };
    if (typeof msg.id === "number" && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(msg.id);
      p.resolve({ body: parsed, requestId: msg.id });
    }
    // Notifications (no id) and unmatched ids are dropped.
  }

  function rejectAllPending(err: Error) {
    const annotated = err.message.includes("child stderr") ? err : new Error(annotateWithStderr(err.message));
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(annotated);
    }
    pending.clear();
  }

  function annotateWithStderr(message: string): string {
    const tail = stderrBuffer.trim();
    if (!tail) return message;
    // Include up to the last 800 chars of stderr to keep error messages
    // bounded while still useful for debugging.
    const snippet = tail.length > 800 ? `…${tail.slice(-800)}` : tail;
    return `${message}\n  child stderr:\n    ${snippet.replace(/\n/g, "\n    ")}`;
  }

  async function writeLine(line: string): Promise<void> {
    // Wait for the child to actually spawn before the first write.
    // Subsequent writes resolve immediately (spawnReady is already settled).
    if (!spawned && !spawnError) {
      try {
        await spawnReady;
      } catch (err) {
        throw new Error(
          annotateWithStderr(`stdio transport: spawn failed — ${err instanceof Error ? err.message : String(err)}`),
        );
      }
    }
    if (exited) {
      throw new Error(annotateWithStderr(`stdio transport: child has exited (code ${exitCode})`));
    }
    if (spawnError) throw new Error(annotateWithStderr(`stdio transport: spawn failed — ${spawnError.message}`));
    const stdin = child.stdin;
    if (!stdin || stdin.destroyed) throw new Error(annotateWithStderr("stdio transport: stdin is closed"));
    // The write callback fires when the data is flushed to the OS pipe.
    // For sequential request() callers (await-pattern), this naturally
    // serializes — each request waits for its own write to flush before
    // the next is issued. For concurrent callers (e.g., benchmark with
    // --concurrency > 1), Node's internal buffer absorbs the writes; we
    // accept slightly higher memory under burst load rather than
    // building a queue.
    return new Promise<void>((resolve, reject) => {
      stdin.write(`${line}\n`, "utf8", (err) => (err ? reject(err) : resolve()));
    });
  }

  const transport: StdioTransport = {
    kind: "stdio",
    command,
    args,
    get pid() {
      return child.pid;
    },
    get exited() {
      return exited;
    },
    get exitCode() {
      return exitCode;
    },
    stderrTail() {
      return stderrBuffer;
    },
    async request(method, params, nextId, init): Promise<TransportResponse> {
      const id = nextId();
      const body = JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} });
      return new Promise<TransportResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(
            new Error(
              annotateWithStderr(`stdio transport: request timed out after ${init.timeout}ms (method=${method})`),
            ),
          );
        }, init.timeout);
        pending.set(id, { resolve, reject, id, timer });
        writeLine(body).catch((err: Error) => {
          clearTimeout(timer);
          pending.delete(id);
          reject(err);
        });
      });
    },
    async notify(method, params, _init): Promise<TransportNotifyResult> {
      const body = JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
      await writeLine(body);
      return {};
    },
    async close() {
      if (exited) return;
      // Signal EOF via stdin close; many stdio servers exit cleanly on this.
      try {
        child.stdin?.end();
      } catch {}
      // Grace period, then force-kill.
      const gracePeriodMs = 2000;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {}
          resolve();
        }, gracePeriodMs);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        try {
          child.kill(isWindows ? undefined : "SIGTERM");
        } catch {}
      });
      rejectAllPending(new Error("stdio transport: closed"));
    },
    setSessionId(_id) {
      // stdio has no session concept; no-op.
    },
    setProtocolVersion(v) {
      protocolVersion = v;
    },
    getSessionId() {
      return null;
    },
    getProtocolVersion() {
      return protocolVersion;
    },
  };

  return transport;
}
