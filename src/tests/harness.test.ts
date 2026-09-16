import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type HarnessOptions, type TestOutcome } from "../harness.js";
import type { TestDefinition, TestResult } from "../types.js";

/**
 * The shared per-run harness on its own: the parallel pool behind
 * --concurrency and the retry loop behind --retries. Both suites hand
 * their bodies to it, so these are the mechanics a report's test list,
 * order and verdicts rest on. The bodies here are deferreds the test
 * resolves step by step, so what is in flight at each point is observed
 * directly rather than inferred from timings.
 */

const SPEC_BASE = "https://modelcontextprotocol.io/specification/2025-11-25";

function def(id: string, extra: Partial<TestDefinition> = {}): TestDefinition {
  return {
    id,
    name: `Test ${id}`,
    category: "tools",
    required: false,
    specRef: `server/tools#${id}`,
    description: "",
    recommendation: "",
    ...extra,
  };
}

function definitions(...defs: TestDefinition[]): ReadonlyMap<string, TestDefinition> {
  return new Map(defs.map((d) => [d.id, d]));
}

function harnessWith(defs: ReadonlyMap<string, TestDefinition>, extra: Partial<HarnessOptions> = {}) {
  return createHarness({ definitions: defs, specBase: SPEC_BASE, transportKind: "http", ...extra });
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Let every pending promise continuation run. The pool is promise-only (no
 * timers without retries), so a macrotask turn settles everything that can
 * settle; two turns absorb a continuation that schedules another.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 2; i++) await new Promise<void>((r) => setImmediate(r));
}

/** Bodies gated on per-id deferreds, recording start order and peak concurrency. */
function gatedBodies(ids: string[]) {
  const gates = new Map(ids.map((id) => [id, deferred()]));
  const started: string[] = [];
  let running = 0;
  let peak = 0;
  const body = (id: string) => async (): Promise<TestOutcome> => {
    started.push(id);
    running++;
    peak = Math.max(peak, running);
    await gates.get(id)?.promise;
    running--;
    return { passed: true, details: `${id} done` };
  };
  return {
    body,
    started,
    peak: () => peak,
    release: (id: string) => gates.get(id)?.resolve(),
  };
}

describe("harness parallel pool (--concurrency)", () => {
  const P = ["p1", "p2", "p3", "p4"];
  const defs = definitions(...P.map((id) => def(id, { parallelSafe: true })), def("s1"));

  it("runs parallelSafe tests up to `concurrency` at once, and a sequential test waits for the pool to drain", async () => {
    const completed: string[] = [];
    const h = harnessWith(defs, { concurrency: 2, onTestComplete: (r) => completed.push(r.id) });
    const g = gatedBodies([...P, "s1"]);
    let suiteDone = false;
    // The suite's own shape: one awaited check() after another.
    const suite = (async () => {
      for (const id of P) await h.check(id, g.body(id));
      await h.check("s1", g.body("s1"));
      await h.drainPool();
      suiteDone = true;
    })();

    await settle();
    // Two slots: p1 and p2 launched, and check("p3") is waiting for a slot.
    expect(g.started).toEqual(["p1", "p2"]);

    g.release("p2");
    await settle();
    // p2's slot went to p3; p1 still holds the other.
    expect(g.started).toEqual(["p1", "p2", "p3"]);
    expect(completed).toEqual(["p2"]);

    g.release("p1");
    await settle();
    expect(g.started).toEqual(["p1", "p2", "p3", "p4"]);

    // s1 is not parallelSafe: it is a barrier and must not start while p3
    // or p4 is still in flight.
    g.release("p3");
    await settle();
    expect(g.started).toEqual(["p1", "p2", "p3", "p4"]);
    expect(completed).toEqual(["p2", "p1", "p3"]);

    g.release("p4");
    await settle();
    expect(g.started).toEqual(["p1", "p2", "p3", "p4", "s1"]);
    expect(suiteDone).toBe(false);

    g.release("s1");
    await suite;
    expect(g.peak()).toBe(2);

    // Every result is recorded exactly once, in completion order, with the
    // definition's metadata.
    expect(h.tests.map((t) => t.id)).toEqual(["p2", "p1", "p3", "p4", "s1"]);
    expect(completed).toEqual(["p2", "p1", "p3", "p4", "s1"]);
    expect(h.tests.find((t) => t.id === "p3")).toEqual<TestResult>({
      id: "p3",
      name: "Test p3",
      category: "tools",
      required: false,
      passed: true,
      details: "p3 done",
      durationMs: expect.any(Number),
      specRef: `${SPEC_BASE}/server/tools#p3`,
    });
  });

  it("with the default concurrency of 1, parallelSafe tests run strictly one at a time", async () => {
    const h = harnessWith(defs);
    const g = gatedBodies(P);
    const suite = (async () => {
      for (const id of P) await h.check(id, g.body(id));
    })();
    await settle();
    expect(g.started).toEqual(["p1"]);
    for (const id of P) {
      g.release(id);
      await settle();
    }
    await suite;
    expect(g.peak()).toBe(1);
    expect(h.tests.map((t) => t.id)).toEqual(P);
  });

  it("an abort waits for the in-flight parallel tests to finish recording, then rejects with the signal's reason", async () => {
    const controller = new AbortController();
    const reason = new Error("client disconnected");
    const h = harnessWith(defs, { concurrency: 4, signal: controller.signal });
    const g = gatedBodies(["p1", "p2", "p3"]);
    await h.check("p1", g.body("p1"));
    await h.check("p2", g.body("p2"));
    await settle();
    expect(g.started).toEqual(["p1", "p2"]);

    controller.abort(reason);
    let outcome: unknown = "pending";
    const next = h.check("p3", g.body("p3")).then(
      () => {
        outcome = "resolved";
      },
      (err: unknown) => {
        outcome = err;
      },
    );

    await settle();
    // The gate does not throw past work that is still writing results.
    expect(outcome).toBe("pending");
    g.release("p1");
    await settle();
    expect(outcome).toBe("pending");
    g.release("p2");
    await next;

    expect(outcome).toBe(reason);
    // p3 never started; p1 and p2 are both in the results.
    expect(g.started).toEqual(["p1", "p2"]);
    expect(h.tests.map((t) => t.id)).toEqual(["p1", "p2"]);
  });
});

describe("harness retries (--retries)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const defs = definitions(def("flaky"), def("overridden"));

  /** A body that answers `outcomes` in turn (an Error is thrown) and counts its calls. */
  function scripted(outcomes: Array<TestOutcome | Error>) {
    let calls = 0;
    const fn = async (): Promise<TestOutcome> => {
      const next = outcomes[Math.min(calls, outcomes.length - 1)];
      calls++;
      if (next instanceof Error) throw next;
      return next;
    };
    return { fn, calls: () => calls };
  }

  it("a failing attempt is retried after a 1s backoff, and the later pass is what the report records", async () => {
    vi.useFakeTimers();
    const progress: Array<[string, boolean, string]> = [];
    const h = harnessWith(defs, {
      retries: 1,
      onProgress: (id, passed, details) => progress.push([id, passed, details]),
    });
    const body = scripted([
      { passed: false, details: "HTTP 503" },
      { passed: true, details: "HTTP 200" },
    ]);
    const done = h.check("flaky", body.fn);

    await vi.advanceTimersByTimeAsync(999);
    expect(body.calls()).toBe(1);
    expect(h.tests).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await done;

    expect(body.calls()).toBe(2);
    expect(h.tests.map((t) => [t.id, t.passed, t.details])).toEqual([["flaky", true, "HTTP 200"]]);
    expect(h.tests[0].durationMs).toBeGreaterThanOrEqual(1000);
    // One progress line per test, not per attempt.
    expect(progress).toEqual([["flaky", true, "HTTP 200"]]);
  });

  it("a passing first attempt is recorded at once: no retry, no backoff timer", async () => {
    vi.useFakeTimers();
    const h = harnessWith(defs, { retries: 2 });
    const body = scripted([{ passed: true, details: "HTTP 200" }]);
    await h.check("flaky", body.fn);
    expect(body.calls()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.tests.map((t) => [t.passed, t.details, t.durationMs])).toEqual([[true, "HTTP 200", 0]]);
  });

  it("a thrown attempt is retried the same way, and the backoff grows by 1s per attempt", async () => {
    vi.useFakeTimers();
    const h = harnessWith(defs, { retries: 2 });
    const body = scripted([
      new Error("socket hang up"),
      { passed: false, details: "HTTP 502" },
      { passed: true, details: "ok" },
    ]);
    const done = h.check("flaky", body.fn);

    await vi.advanceTimersByTimeAsync(1000);
    expect(body.calls()).toBe(2);
    // The second backoff is 2s, not another 1s.
    await vi.advanceTimersByTimeAsync(1999);
    expect(body.calls()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    await done;

    expect(body.calls()).toBe(3);
    expect(h.tests.map((t) => [t.passed, t.details])).toEqual([[true, "ok"]]);
  });

  it("when every attempt fails, the last attempt's details are recorded (a throw as 'Error: <message>')", async () => {
    vi.useFakeTimers();
    const h = harnessWith(defs, { retries: 1 });
    const body = scripted([{ passed: false, details: "HTTP 503" }, new Error("connect ECONNREFUSED")]);
    const done = h.check("flaky", body.fn);
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(body.calls()).toBe(2);
    expect(h.tests.map((t) => [t.passed, t.details])).toEqual([[false, "Error: connect ECONNREFUSED"]]);
  });

  it("check() inherits the run-wide retries; a per-check retries override replaces them", async () => {
    vi.useFakeTimers();
    const h = harnessWith(defs, { retries: 1 });
    const inherited = scripted([{ passed: false, details: "nope" }]);
    const inheritedDone = h.check("flaky", inherited.fn);
    await vi.advanceTimersByTimeAsync(1000);
    await inheritedDone;
    expect(inherited.calls()).toBe(2);

    const overridden = scripted([{ passed: false, details: "nope" }]);
    await h.check("overridden", overridden.fn, { retries: 0 });
    // No retry and no backoff timer left behind.
    expect(overridden.calls()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.tests.map((t) => [t.id, t.passed])).toEqual([
      ["flaky", false],
      ["overridden", false],
    ]);
  });

  it("the legacy test() signature uses the run-wide retries too", async () => {
    vi.useFakeTimers();
    const h = harnessWith(defs, { retries: 1 });
    const body = scripted([
      { passed: false, details: "first" },
      { passed: true, details: "second" },
    ]);
    const done = h.test("flaky", "Flaky", "tools", true, "server/tools", body.fn);
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(body.calls()).toBe(2);
    expect(h.tests.map((t) => [t.id, t.required, t.passed, t.details])).toEqual([["flaky", true, true, "second"]]);
  });
});
