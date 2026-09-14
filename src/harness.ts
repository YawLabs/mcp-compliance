import type { TransportKind } from "./transport/index.js";
import type { TestDefinition, TestResult } from "./types.js";

/**
 * The per-run test harness shared by every suite: filtering (`only` /
 * `skip` / transport), the parallel pool, retries, abort handling, the
 * result + warning collectors, and the warning dedup/cap. Suites only
 * supply test bodies.
 */

export interface HarnessOptions {
  /** Definitions of every test the suite may run, keyed by id. */
  definitions: ReadonlyMap<string, TestDefinition>;
  /** Absolute spec base URL; `specRef` values are joined onto it. */
  specBase: string;
  transportKind: TransportKind;
  /**
   * Decides whether a test applies to the active transport. Defaults to
   * honoring `TestDefinition.transports` (omitted = all transports).
   */
  supportsTransport?: (def: TestDefinition | undefined, kind: TransportKind) => boolean;
  only?: string[];
  skip?: string[];
  retries?: number;
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (testId: string, passed: boolean, details: string) => void;
  onTestComplete?: (result: TestResult) => void;
}

export interface TestOutcome {
  passed: boolean;
  details: string;
}

export interface CheckOptions {
  /**
   * Overrides the definition's `required` flag. Capability-gated tests
   * pass the live capability so a server without e.g. tools is not
   * penalised for a tools test.
   */
  required?: boolean;
  /**
   * Overrides the run-wide `retries` for this one check. A post-hoc scan
   * of a finished recording passes 0: its verdict cannot change on a
   * retry, so the harness would only sleep between identical failures.
   */
  retries?: number;
}

export interface Harness {
  readonly tests: TestResult[];
  readonly warnings: string[];
  /**
   * Legacy signature: name/category/required/specRef supplied at the
   * call site (the 2025-11-25 suite declares them inline).
   */
  test(
    id: string,
    name: string,
    category: TestResult["category"],
    required: boolean,
    specRef: string,
    fn: () => Promise<TestOutcome>,
  ): Promise<void>;
  /**
   * Definition-driven signature: everything but the body comes from the
   * definitions map. Throws on an unknown id so a suite cannot run a
   * test its catalog does not describe.
   */
  check(id: string, fn: () => Promise<TestOutcome>, opts?: CheckOptions): Promise<void>;
  /** Whether a test would run under the active filters. */
  shouldRun(id: string, category: string): boolean;
  /** Barrier against in-flight parallel tests. */
  drainPool(): Promise<void>;
  /**
   * Dedup + cap the warnings in place. Call once, after the final
   * drainPool(), so warnings pushed by parallel tests are included.
   */
  finalizeWarnings(): void;
}

/** Max warnings kept in a report; the rest collapse into a sentinel. */
export const MAX_WARNINGS = 50;

/**
 * Dedupe and cap a list of warnings, preserving insertion order and
 * appending a truncation sentinel when capped. Extracted so the cap
 * semantics can be unit-tested without spinning up a suite run.
 *
 * @internal Exported for testing.
 */
export function dedupAndCapWarnings(warnings: readonly string[], max: number): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const w of warnings) {
    if (seen.has(w)) continue;
    seen.add(w);
    deduped.push(w);
  }
  if (deduped.length > max) {
    const truncated = deduped.length - max;
    return [...deduped.slice(0, max), `... and ${truncated} more warning(s) suppressed`];
  }
  return deduped;
}

/** Default transport predicate: honor `TestDefinition.transports`. */
export function supportsTransportByDefinition(def: TestDefinition | undefined, kind: TransportKind): boolean {
  if (!def) return true;
  if (def.transports) return def.transports.includes(kind);
  return true;
}

export function createHarness(opts: HarnessOptions): Harness {
  const tests: TestResult[] = [];
  const warnings: string[] = [];
  const retries = opts.retries || 0;
  const supports = opts.supportsTransport ?? supportsTransportByDefinition;

  function shouldRun(id: string, category: string): boolean {
    const def = opts.definitions.get(id);
    if (!supports(def, opts.transportKind)) return false;
    if (opts.only && opts.only.length > 0) {
      return opts.only.includes(category) || opts.only.includes(id);
    }
    if (opts.skip && opts.skip.length > 0) {
      return !opts.skip.includes(category) && !opts.skip.includes(id);
    }
    return true;
  }

  // Parallel execution pool. Tests marked `parallelSafe: true` in their
  // definition are queued here up to `concurrency` at a time. Sequential
  // tests call `drainPool()` first to barrier against any pending
  // parallel work, so order-dependent state stays consistent.
  const concurrency = Math.max(1, opts.concurrency ?? 1);
  const inFlight = new Set<Promise<void>>();

  async function drainPool(): Promise<void> {
    while (inFlight.size > 0) {
      await Promise.race(inFlight);
    }
  }

  async function runTestFn(
    id: string,
    name: string,
    category: TestResult["category"],
    required: boolean,
    specRef: string,
    fn: () => Promise<TestOutcome>,
    attempts: number,
  ): Promise<void> {
    const start = Date.now();
    let lastResult: TestOutcome = { passed: false, details: "" };

    for (let attempt = 0; attempt <= attempts; attempt++) {
      try {
        lastResult = await fn();
        if (lastResult.passed) break;
        if (attempt < attempts) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        lastResult = { passed: false, details: `Error: ${message}` };
        if (attempt < attempts) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }

    const result: TestResult = {
      id,
      name,
      category,
      required,
      passed: lastResult.passed,
      details: lastResult.details,
      durationMs: Date.now() - start,
      specRef: `${opts.specBase}/${specRef}`,
    };
    tests.push(result);
    opts.onProgress?.(id, lastResult.passed, lastResult.details);
    opts.onTestComplete?.(result);
  }

  async function run(
    id: string,
    name: string,
    category: TestResult["category"],
    required: boolean,
    specRef: string,
    fn: () => Promise<TestOutcome>,
    attempts: number,
  ): Promise<void> {
    // Abort gate: if the caller's signal has fired, drop any pending
    // parallel work and propagate the reason. We check at the top of
    // every test() call so the first awaited test after abort returns
    // immediately rather than waiting on the rest of the suite.
    if (opts.signal?.aborted) {
      if (inFlight.size > 0) await drainPool().catch(() => {});
      throw opts.signal.reason ?? new Error("Aborted");
    }

    if (!shouldRun(id, category)) return;

    const def = opts.definitions.get(id);
    const eligible = concurrency > 1 && def?.parallelSafe === true;

    if (!eligible) {
      // Sequential path: barrier against any in-flight parallel tests
      // first, then execute synchronously.
      if (inFlight.size > 0) await drainPool();
      await runTestFn(id, name, category, required, specRef, fn, attempts);
      return;
    }

    // Parallel path: wait for a slot, then launch without awaiting.
    while (inFlight.size >= concurrency) await Promise.race(inFlight);
    const p = runTestFn(id, name, category, required, specRef, fn, attempts).finally(() => {
      inFlight.delete(p);
    });
    inFlight.add(p);
  }

  function test(
    id: string,
    name: string,
    category: TestResult["category"],
    required: boolean,
    specRef: string,
    fn: () => Promise<TestOutcome>,
  ): Promise<void> {
    return run(id, name, category, required, specRef, fn, retries);
  }

  async function check(id: string, fn: () => Promise<TestOutcome>, checkOpts: CheckOptions = {}): Promise<void> {
    const def = opts.definitions.get(id);
    if (!def) throw new Error(`Unknown test id "${id}" (not in the suite's definitions)`);
    return run(
      id,
      def.name,
      def.category,
      checkOpts.required ?? def.required,
      def.specRef,
      fn,
      Math.max(0, checkOpts.retries ?? retries),
    );
  }

  return {
    tests,
    warnings,
    test,
    check,
    shouldRun,
    drainPool,
    finalizeWarnings() {
      const capped = dedupAndCapWarnings(warnings, MAX_WARNINGS);
      warnings.length = 0;
      warnings.push(...capped);
    },
  };
}
