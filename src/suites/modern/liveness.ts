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
 * trip and no wait. Its budget is short -- LIVENESS_BUDGET_MS, never more
 * than the per-request timeout -- so a child that stopped answering costs
 * that, not a full --timeout on top of the hang every later request will
 * meet.
 *
 * It cannot see an exit that lands after the probe is answered; nothing
 * short of a fixed wait could, and a healthy server must not pay one.
 */

/** The most the liveness server/discover waits (capped at the per-request timeout). */
export const LIVENESS_BUDGET_MS = 2000;

/** What the liveness server/discover found. */
export type Liveness =
  /** Answered (a result or an error: either way the process is serving), or not stdio. */
  | { state: "alive" }
  /** The child is gone; `err` is the probe's transport error. */
  | { state: "exited"; err: unknown }
  /**
   * The child is still running but the probe got no answer: none within
   * `budgetMs`, or its stdin refused the write (the server stopped reading
   * its input). `err` is the probe's transport error.
   */
  | { state: "unresponsive"; err: unknown; budgetMs: number };

/** The liveness probe's budget: LIVENESS_BUDGET_MS, or the per-request timeout when that is shorter. */
export function livenessBudget(ctx: ModernSuiteContext): number {
  return Math.min(ctx.timeout, LIVENESS_BUDGET_MS);
}

/**
 * stdio only: send one plain server/discover (budget: livenessBudget) and
 * read what came back. Any answer is "alive"; a failure with the child gone
 * is "exited"; any other failure is "unresponsive". Over HTTP there is no
 * child to lose, so nothing is sent and the answer is "alive". A caller's
 * abort is rethrown.
 *
 * The caller probes only a child that was alive when its request was sent
 * (one already gone did not die on that request), and reads the exit
 * status (StdioTransport.exited / exitCode) before anything replaces
 * ctx.transport.
 */
export async function checkLiveness(ctx: ModernSuiteContext): Promise<Liveness> {
  if (ctx.kind !== "stdio") return { state: "alive" };
  const budgetMs = livenessBudget(ctx);
  try {
    await ctx.client.rpc("server/discover", undefined, { timeout: budgetMs });
    return { state: "alive" };
  } catch (err: unknown) {
    if (ctx.signal?.aborted) throw err;
    if ((ctx.transport as Partial<StdioTransport>).exited === true) return { state: "exited", err };
    return { state: "unresponsive", err, budgetMs };
  }
}

/**
 * Why an unresponsive child counts as one, ASCII and one line: "no reply to
 * server/discover within 2000ms", else "server/discover failed: <the
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
