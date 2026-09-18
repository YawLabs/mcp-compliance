import type { StdioTransport } from "../../transport/stdio.js";
import type { ModernSuiteContext } from "./context.js";
import { classifyTransportError } from "./security.js";

/**
 * Whether a stdio child that has just ANSWERED a check's request is still
 * serving: the one question stdio-unicode's probe and
 * lifecycle-progress-token's calls ask before they judge the answer. A
 * child can answer and then exit (a logger that chokes on the non-ASCII
 * line it just echoed, a progress timer that throws after the reply), or
 * answer and then stop reading its input or answering (a reader thread that
 * died on the same line). Left unnoticed, either one is blamed on whatever
 * the suite sends next -- another call of the same check, or the next
 * check.
 *
 * The probe is one plain server/discover: a request any live 2026-07-28
 * server answers at once (the setup and stdio-framing have just shown this
 * process answering discovers). On a healthy server it is one quick round
 * trip and no wait. It gets the per-request timeout like any request, so a
 * server that answers every request within --timeout is never read as
 * hung, and a child that exits at any point before its answer is read as
 * exited (the transport fails the pending request the moment the child's
 * exit is reported), not as silent. Only a child that is still running and
 * silent for the whole per-request budget is "unresponsive".
 *
 * A child that exits a moment after the probe is answered is seen only by a
 * wait: `exitsWithin`, EXIT_GRACE_MS, which the callers spend only where
 * they accept its cost (stdio-unicode once, after its last answered probe;
 * lifecycle-progress-token after a call the server failed, never after a
 * served one).
 */

/**
 * How long a caller waits for a stdio child to exit after it answered, before
 * the liveness server/discover: the 2025-11-25 stdio-unicode's
 * UNICODE_EXIT_GRACE_MS (runner.ts), so the two suites see the same window.
 */
export const EXIT_GRACE_MS = 250;

/** How often that wait looks at the child: the transport reports the exit as a flag. */
const EXIT_POLL_MS = 10;

/** What the liveness server/discover found. */
export type Liveness =
  /** Answered (a result or an error: either way the process is serving), or not stdio. */
  | { state: "alive" }
  /** The child is gone; `err` is the probe's transport error (none when the exit was seen before it was sent). */
  | { state: "exited"; err: unknown }
  /**
   * The child is still running but the probe got no answer: none within
   * `budgetMs` (the per-request timeout), or its stdin refused the write
   * (the server stopped reading its input). `err` is the probe's transport
   * error.
   */
  | { state: "unresponsive"; err: unknown; budgetMs: number };

/** Whether the suite's stdio child has exited (false over HTTP). */
function childExited(ctx: ModernSuiteContext): boolean {
  return ctx.kind === "stdio" && (ctx.transport as Partial<StdioTransport>).exited === true;
}

/**
 * stdio only: whether the child exits within `ms` -- true as soon as it has
 * (at once when it already had), false when the time runs out first, and
 * false at once over HTTP, where there is no child and nothing is waited
 * for. Polled, since the transport reports the exit as a flag. A caller's
 * abort rejects at once with its reason.
 */
export async function exitsWithin(ctx: ModernSuiteContext, ms: number): Promise<boolean> {
  if (ctx.kind !== "stdio") return false;
  const deadline = Date.now() + ms;
  while (!childExited(ctx)) {
    if (ctx.signal?.aborted) throw ctx.signal.reason ?? new Error("Aborted");
    const left = deadline - Date.now();
    if (left <= 0) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(EXIT_POLL_MS, left)));
  }
  return true;
}

/**
 * stdio only: send one plain server/discover (budget: the per-request
 * timeout) and read what came back. Any answer is "alive"; a failure with
 * the child gone is "exited"; any other failure is "unresponsive". Over HTTP
 * there is no child to lose, so nothing is sent and the answer is "alive". A
 * caller's abort is rethrown.
 *
 * The caller probes only a child that was alive when its request was sent
 * (one already gone did not die on that request), and reads the exit
 * status (StdioTransport.exited / exitCode) before anything replaces
 * ctx.transport.
 */
export async function checkLiveness(ctx: ModernSuiteContext): Promise<Liveness> {
  if (ctx.kind !== "stdio") return { state: "alive" };
  if (childExited(ctx)) return { state: "exited", err: undefined };
  const budgetMs = ctx.timeout;
  try {
    await ctx.client.rpc("server/discover", undefined, { timeout: budgetMs });
    return { state: "alive" };
  } catch (err: unknown) {
    if (ctx.signal?.aborted) throw err;
    if (childExited(ctx)) return { state: "exited", err };
    return { state: "unresponsive", err, budgetMs };
  }
}

/**
 * Why an unresponsive child counts as one, ASCII and one line: "no reply to
 * server/discover within <timeout>ms", else "server/discover failed: <the
 * transport's first line, without its 'stdio transport: ' prefix, at most
 * 80 characters>" (a stdin that refused the write).
 */
export function unresponsiveReason(live: Extract<Liveness, { state: "unresponsive" }>): string {
  if (classifyTransportError(live.err) === "timeout") return `no reply to server/discover within ${live.budgetMs}ms`;
  const message = live.err instanceof Error ? live.err.message : String(live.err);
  const first = (message.split("\n")[0] ?? "")
    .replace(/^stdio transport:\s*/, "")
    .replace(/[^\x20-\x7e]/g, "?")
    .trim();
  return `server/discover failed: ${first.length > 80 ? `${first.slice(0, 77)}...` : first}`;
}

/**
 * The warning for a child that stopped answering right after `cause` (the
 * request of `check` that it answered) was answered. The child is not
 * replaced: it is still running, and a slow answer is not an exit. The
 * warning names the request, so the checks after it that time out on the
 * same hang are not read as failures of their own.
 */
export function warnUnresponsive(
  ctx: ModernSuiteContext,
  check: string,
  cause: string,
  live: Extract<Liveness, { state: "unresponsive" }>,
): void {
  ctx.harness.warnings.push(
    `${check}: the server stopped answering right after ${cause} was answered (${unresponsiveReason(live)}); it was not restarted, so the tests after it may fail on the same hang.`,
  );
}
