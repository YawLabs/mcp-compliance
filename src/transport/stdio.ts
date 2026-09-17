import { type ChildProcess, spawn } from "node:child_process";
import type {
  JsonRpcId,
  MessageListener,
  Transport,
  TransportNotifyResult,
  TransportResponse,
  TransportStream,
} from "./index.js";

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
  /**
   * How many times stdout outgrew `stdoutBufferSize` without a newline and
   * the buffered line was discarded (each time also leaves a "stdout buffer
   * exceeded" line in stderrTail()). Monotonic for the transport's life:
   * compare the value before and after a request to learn whether output
   * produced during THAT request was dropped. stderrTail() cannot say --
   * it is a rolling buffer that still holds the marker of an earlier drop,
   * and the child can write the same text to its own stderr.
   */
  readonly stdoutOverflows: number;
  /** Whether the child has exited. */
  readonly exited: boolean;
  /** Exit code once the child has exited, null otherwise. */
  readonly exitCode: number | null;
  /**
   * Write one raw line to the child's stdin, bypassing JSON-RPC framing.
   * Lets the malformed-message error tests (invalid JSON, invalid
   * JSON-RPC) run over stdio the way they run over HTTP.
   */
  writeRaw(line: string): Promise<void>;
}

interface PendingRequest {
  resolve: (res: TransportResponse) => void;
  reject: (err: Error) => void;
  id: JsonRpcId;
  timer: NodeJS.Timeout;
}

// Turn an exit code/signal into a message that points at the likely cause
// instead of a bare "code 0" (which normally means success and misleads
// users). The common failure mode — a one-shot CLI passed where a
// long-running MCP stdio server was expected — exits cleanly with code 0
// after doing its one-shot work, so call that out explicitly.
function exitDiagnostic(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal) return `server terminated by signal ${signal} before completing the request`;
  if (code === 0) {
    return "server exited cleanly (code 0) before completing the request. This usually means the command is a one-shot CLI, not a long-running MCP stdio server. If the server needs a subcommand to start (e.g. `serve`, `mcp`, `start`), include it in the command.";
  }
  return `server crashed with exit code ${code} before completing the request`;
}

/**
 * How long close() waits, after closing the child's stdin, for the server to
 * exit on its own before it terminates it. The spec's stdio shutdown
 * (basic/transports/stdio, "Shutdown") is: close the input stream, wait for
 * the server to exit, and only "if the server does not exit within a
 * reasonable time" terminate it forcibly; servers SHOULD exit "promptly" on
 * EOF, "the primary graceful-shutdown signal and the only portable one". The
 * spec puts no number on either, so this is the reference TypeScript SDK
 * client's wait (StdioClientTransport.close()): time for a server to flush
 * and release what it holds, short enough that a run against a server that
 * ignores EOF does not stall noticeably. A server that does exit on EOF ends
 * the wait the moment it goes.
 */
const EOF_WINDOW_MS = 2000;
/** POSIX: how long a server that ignored EOF gets to exit on SIGTERM before SIGKILL (the SDK client's second wait). */
const SIGTERM_GRACE_MS = 2000;
/** The last, bounded wait for the forced kill to be carried out and the child reaped, in case the kill itself hangs. */
const KILL_WAIT_MS = 5000;

/** Resolves true when `promise` settles within `ms`, false when the bound runs out first. */
function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    void promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
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
  const pending = new Map<JsonRpcId, PendingRequest>();
  const listeners = new Set<MessageListener>();
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let stdoutOverflows = 0;
  /** The shutdown close() started, so a second close() joins it. */
  let closing: Promise<void> | null = null;

  function emit(message: unknown) {
    for (const l of listeners) {
      try {
        l(message, {});
      } catch {
        // A listener must never break the transport.
      }
    }
  }

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
      rejectAllPending(new Error(exitDiagnostic(code, signal)));
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
    // attempt — and the next newline starts a fresh line. Warn to
    // stderr so a server silently eating its own response (1MB+ of
    // un-newlined output before the real JSON reply) is diagnosable
    // rather than manifesting only as a request timeout.
    if (stdoutBuffer.length > stdoutBufferSize) {
      stdoutOverflows++;
      stderrBuffer += `[mcp-compliance] stdout buffer exceeded ${stdoutBufferSize} bytes without a newline; discarding buffered data\n`;
      if (stderrBuffer.length > stderrBufferSize) {
        stderrBuffer = stderrBuffer.slice(stderrBuffer.length - stderrBufferSize);
      }
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
    // Every parsed message — notifications included — is fanned out to
    // onMessage listeners, so held-open streams and the modern suite's
    // recorder see them. Only responses are matched to pending requests.
    emit(parsed);
    const msg = parsed as { id?: number | string; jsonrpc?: string };
    if ((typeof msg.id === "number" || typeof msg.id === "string") && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(msg.id);
      p.resolve({ body: parsed, requestId: msg.id });
    }
    // Ids are matched by value AND type (a Map key): a server that
    // answers a numeric id with the same digits as a string is not
    // echoing the id, and its reply times out here as it should.
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
      throw new Error(annotateWithStderr(`stdio transport: ${exitDiagnostic(exitCode, null)}`));
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

  /**
   * The spec's stdio shutdown order: close stdin, wait EOF_WINDOW_MS for the
   * server to exit, and only then terminate it. Nothing is signalled or
   * spawned at EOF time: a SIGTERM sent along with EOF ends a server that
   * would have exited cleanly before its shutdown work runs.
   */
  async function shutDown(): Promise<void> {
    const childExit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try {
      child.stdin?.end();
    } catch {}
    // No pid: the spawn itself failed (ENOENT, EACCES), so there is no
    // process to wait for or kill.
    if (child.pid === undefined) {
      rejectAllPending(new Error("stdio transport: closed"));
      return;
    }
    const pid = String(child.pid);
    if (!(await within(childExit, EOF_WINDOW_MS))) {
      if (isWindows) {
        // Windows has no SIGTERM step: a non-forced taskkill asks a process to
        // close its windows, which a console process has none of (taskkill
        // exits 128, "can only be terminated forcefully"), so it could never
        // end the server -- only leave a taskkill running. Go straight to the
        // forced kill of the whole tree: the child is spawned via a shell
        // (shell:true, for .cmd/.bat shims like npx), so child.kill() would
        // only reach cmd.exe and orphan the real server (the node/npx
        // grandchild); `taskkill /t` walks the tree.
        //
        // Wait for the forced kill to be carried out and the child to be
        // reaped, not merely for taskkill to be spawned. Node puts its direct
        // children (cmd.exe, taskkill) in a kill-on-close job object that the
        // shell's own children are outside of, so a caller that exits right
        // after close() resolves -- a test worker torn down after its last
        // test -- takes taskkill and cmd.exe down with it before the kill is
        // carried out, and the real server (the grandchild), still busy and
        // so not gone on EOF, is left running as an orphan.
        const forcedTreeKill = new Promise<void>((resolve) => {
          try {
            const killer = spawn("taskkill", ["/pid", pid, "/t", "/f"], { stdio: "ignore" });
            killer.once("exit", () => resolve());
            killer.once("error", () => resolve());
          } catch {
            resolve();
          }
        });
        await within(Promise.all([forcedTreeKill, childExit]), KILL_WAIT_MS);
      } else {
        // POSIX spawns with shell:false, so the child is the server itself:
        // SIGTERM, then SIGKILL for one that ignores that too.
        try {
          child.kill("SIGTERM");
        } catch {}
        if (!(await within(childExit, SIGTERM_GRACE_MS))) {
          try {
            child.kill("SIGKILL");
          } catch {}
          await within(childExit, KILL_WAIT_MS);
        }
      }
    }
    rejectAllPending(new Error("stdio transport: closed"));
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
    get stdoutOverflows() {
      return stdoutOverflows;
    },
    async request(method, params, nextId, init): Promise<TransportResponse> {
      const id = nextId();
      const body = JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} });
      return new Promise<TransportResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          detach();
          reject(
            new Error(
              annotateWithStderr(`stdio transport: request timed out after ${init.timeout}ms (method=${method})`),
            ),
          );
        }, init.timeout);
        const onAbort = () => {
          clearTimeout(timer);
          pending.delete(id);
          const reason = init.signal?.reason;
          reject(reason instanceof Error ? reason : new Error("stdio transport: request aborted"));
        };
        const detach = () => init.signal?.removeEventListener("abort", onAbort);
        if (init.signal) {
          if (init.signal.aborted) {
            onAbort();
            return;
          }
          init.signal.addEventListener("abort", onAbort, { once: true });
        }
        pending.set(id, {
          resolve: (res) => {
            detach();
            resolve(res);
          },
          reject: (err) => {
            detach();
            reject(err);
          },
          id,
          timer,
        });
        writeLine(body).catch((err: Error) => {
          clearTimeout(timer);
          pending.delete(id);
          detach();
          reject(err);
        });
      });
    },
    async notify(method, params, _init): Promise<TransportNotifyResult> {
      const body = JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
      await writeLine(body);
      return {};
    },
    async stream(method, params, nextId, init): Promise<TransportStream> {
      const id: JsonRpcId = nextId();
      const body = JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} });
      // Every message the child writes while the stream is open is
      // delivered; the caller filters by subscriptionId / progressToken.
      // The stream ends when the response carrying `id` arrives, when the
      // timeout elapses, when the child exits, or on close().
      const queue: unknown[] = [];
      let done = false;
      /** The response carrying `id` arrived: the server considers the request finished. */
      let answered = false;
      let exit: { code: number | null; signal: string | null } | undefined;
      let cancelSent = false;
      let wake: (() => void) | null = null;
      let timer: NodeJS.Timeout | null = null;
      let unsubscribe: () => void = () => {};
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        exit = { code, signal };
        finish();
      };
      const finish = () => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        unsubscribe();
        child.removeListener("exit", onExit);
        init.signal?.removeEventListener("abort", finish);
        wake?.();
      };
      unsubscribe = transport.onMessage((msg) => {
        if (done) return;
        queue.push(msg);
        const m = msg as { id?: unknown };
        const isResponse = m && typeof m === "object" && m.id === id;
        if (isResponse) answered = true;
        wake?.();
        if (isResponse) finish();
      });
      timer = setTimeout(finish, init.timeout);
      // A child that dies mid-stream ends the stream now, not at the
      // timeout; `exit` tells the caller why the iterator completed.
      child.once("exit", onExit);
      if (init.signal?.aborted) finish();
      else init.signal?.addEventListener("abort", finish, { once: true });
      try {
        await writeLine(body);
      } catch (err) {
        finish();
        throw err;
      }
      async function* iterate(): AsyncGenerator<unknown> {
        while (true) {
          if (queue.length > 0) {
            yield queue.shift();
            continue;
          }
          if (done) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = null;
        }
      }
      return {
        requestId: id,
        messages: iterate(),
        get exit() {
          return exit;
        },
        async close() {
          finish();
          // The spec's stdio teardown for a held-open request is a
          // client-side notifications/cancelled naming the request id.
          // The request is still live on the server whenever its response
          // has not arrived -- after the timer fired or an abort as much as
          // on an early close -- so the cancel keys on `answered`, not on
          // `done`. Nothing to cancel once the child is gone.
          if (cancelSent || answered || exited) return;
          cancelSent = true;
          const cancel = { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } };
          // Reported before the write so a recorder logs it ahead of any
          // reply the server (wrongly) sends to it.
          try {
            init.onSent?.(cancel);
          } catch {
            // A hook must never break the transport.
          }
          try {
            await writeLine(JSON.stringify(cancel));
          } catch {
            // child already gone
          }
        },
      };
    },
    onMessage(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    writeRaw(line) {
      return writeLine(line);
    },
    close() {
      if (exited) return Promise.resolve();
      // A close() while one is under way joins it: one EOF window, one
      // termination.
      closing ??= shutDown();
      return closing;
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
