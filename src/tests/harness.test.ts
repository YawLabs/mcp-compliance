import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type HarnessOptions, isSkipOutcome, readsAsSkip, type TestOutcome } from "../harness.js";
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

  it("a skip is recorded without retrying: it is a pass, and the precondition will not appear on attempt two", async () => {
    vi.useFakeTimers();
    const h = harnessWith(defs, { retries: 2 });
    const body = scripted([{ passed: true, details: "Skipped: no --auth provided" }]);
    await h.check("flaky", body.fn);
    expect(body.calls()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.tests.map((t) => [t.passed, t.skipped])).toEqual([[true, true]]);
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

/**
 * The harness is the only place a TestResult is built, so it is the only
 * place that can tell a reader a check measured nothing. The suites
 * already mark such a check in its details and return `passed: true` (a
 * skip is not a failure); the harness turns those markers into a flag the
 * reporters and the grader can read, without every call site having to
 * be touched.
 */
describe("harness skip detection", () => {
  const defs = definitions(def("probe"), def("other"));

  async function record(outcome: TestOutcome, id = "probe"): Promise<TestResult> {
    const h = harnessWith(defs);
    await h.check(id, async () => outcome);
    return h.tests[0];
  }

  it("a pass whose details lead with `Skipped:` is flagged, on both harness signatures", async () => {
    const r = await record({ passed: true, details: "Skipped: no --auth provided" });
    expect(r.skipped).toBe(true);
    expect(r.passed).toBe(true);

    const h = harnessWith(defs);
    await h.test("probe", "Probe", "security", false, "basic", async () => ({
      passed: true,
      details: "Skipped: not evaluable (see security-auth-required)",
    }));
    expect(h.tests.map((t) => [t.passed, t.skipped])).toEqual([[true, true]]);
  });

  /**
   * Every passing details string in both suites (src/runner.ts and
   * src/suites/modern/*.ts) that marks a check whose subject was absent,
   * verbatim, with template values filled in. A suite that rewords one
   * of these away from the three markers stops being flagged; this list
   * is where that shows up.
   */
  const SUITE_SKIPS = [
    // 2025-11-25 (src/runner.ts)
    "Server does not declare logging capability (skipped)",
    "Server does not declare completions capability (skipped)",
    "No capabilities declared — listChanged notifications not applicable",
    "Server did not issue session ID (test not applicable)",
    "No session ID — server-initiated messages not applicable",
    "Server responded with JSON (not SSE) — event field check not applicable",
    "SSE response empty or no data fields — check not applicable",
    "Tool returned error (content types not applicable): code -32603",
    "No tools available for progress token test (skipped)",
    "No list methods available to test (skipped)",
    // The auth siblings' not-evaluable skip, the 2026-07-28 AUTH_NOT_EVALUABLE wording too.
    "Skipped: HTTP 403 without a Bearer challenge, not attributable to authentication (see security-auth-required)",
    "Skipped: the configured credential was refused too (the credentialed ping drew HTTP 401), so rejecting invalid tokens cannot be told from rejecting everything (check the configured credential)",
    "Skipped: the configured credential was refused too (the credentialed ping drew HTTP 401), so refusing it in the query string proves nothing (check the configured credential)",
    "Skipped: HTTP 403 without a Bearer challenge on the endpoint and on every well-known metadata location, not attributable to authentication (see security-auth-required)",
    "Skipped: the error probes are raw HTTP requests, which a stdio target cannot receive, so no error response was scanned",
    "Skipped: the error probe is a raw HTTP request, which a stdio target cannot receive, so no error response was scanned",
    "Skipped: server declares no tools, so there is no tool call to carry the unicode probe",
    "Skipped: no --auth provided",
    "HTTP 403 (WWW-Authenticate not applicable for 403)",
    "Server does not issue session IDs (skipped)",
    "Skipped: server does not issue session IDs",
    "Skipped: could not extract token from auth header",
    "No tools with URL parameters found (skipped)",
    "No tools available to test (skipped)",
    "Skipped: tools/list not available",
    "Fewer than 2 tools — cross-reference check not applicable",
    // 2026-07-28 (src/suites/modern)
    "skipped: no tools list available, no tools list to validate",
    "skipped: tools/list failed, no tools list to validate (see tools-list)",
    "Skipped: raw-body probe is HTTP-only",
    "not applicable: resources/templates/list returned -32601 Method not found; no complete result to check caching hints on",
    "resources/templates/list: not applicable (input_required interim results carry no caching hints)",
    "skipped: server lists no tools",
    "echo: tool returned error (content types not applicable): -32603 boom",
    "echo: input_required result (content types not applicable)",
    "skipped: server lists no resources with a uri",
    "skipped: server lists no prompts",
    "skipped: server declares no tools",
    "skipped: no listed tool has a name",
    "not applicable on stdio (no HTTP auth)",
    "Skipped: server declares no tools",
    "HTTP 200 -- not a 401 response (skipped)",
    "Skipped: needs a valid credential to compare against (pass --auth)",
    "Skipped: server does not require auth (unauthenticated server/discover answered HTTP 200)",
    "Skipped: needs a valid credential to place in the URI (pass --auth)",
    "Skipped: all 20 rapid server/discover requests were rejected by auth (HTTP 401) before reaching a handler, so rate limiting could not be measured; pass --auth",
    "Fewer than 2 tools -- cross-reference check not applicable",
    "skipped: server declares no resources or prompts",
  ];

  /**
   * Passing details from the same suites that are verdicts -- the server
   * was observed doing something -- including the ones that mention a
   * skip or an absence without being one.
   */
  const SUITE_VERDICTS = [
    "HTTP 200",
    "HTTP 401 (unauthenticated request rejected)",
    "HTTP 403 (unauthenticated request rejected)",
    "Server does not require auth (no --auth provided and server accepted unauthenticated requests)",
    'WWW-Authenticate: Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
    "No instructions field (optional)",
    "No tools have title field (optional)",
    "No CORS headers returned (server-to-server only, acceptable)",
    "HTTP 405 (server does not support server-initiated messages)",
    "Method not supported (acceptable): -32601",
    "3 tool(s) scanned — no injection patterns found",
    "12 server messages validated against the 2026-07-28 schema; no violations (3 skipped: raw-probe replies, non-objects, legacy initialize)",
    // Vacuous, but worded without a marker: the suites flag these with an
    // explicit `skipped: true`, so the markers must not be what catches them.
    "No tools to validate",
    "No content items to validate",
    "No tools with string parameters to test",
    "No resources to validate",
    "No prompts to validate",
  ];

  it("flags every skip the two suites write, whichever of the three markers it uses", async () => {
    for (const details of SUITE_SKIPS) {
      expect(readsAsSkip(details), details).toBe(true);
      expect((await record({ passed: true, details })).skipped, details).toBe(true);
    }
  });

  it("flags no verdict, including one that mentions a skip mid-sentence", async () => {
    for (const details of SUITE_VERDICTS) {
      expect(readsAsSkip(details), details).toBe(false);
      const r = await record({ passed: true, details });
      expect(Object.hasOwn(r, "skipped"), details).toBe(false);
    }
  });

  it("an ordinary pass carries no flag at all, so its shape is unchanged", async () => {
    const r = await record({ passed: true, details: "HTTP 200" });
    expect(Object.keys(r)).toEqual([
      "id",
      "name",
      "category",
      "required",
      "passed",
      "details",
      "durationMs",
      "specRef",
    ]);
  });

  it("a failure is never flagged, even when its details say `Skipped:`", async () => {
    // src/runner.ts reports several genuine failures that way
    // ("Skipped: tools/list failed"); they must stay failures.
    for (const details of ["Skipped: tools/list failed", "HTTP 500 (skipped)", "not applicable on stdio (x)"]) {
      const r = await record({ passed: false, details });
      expect(r.passed, details).toBe(false);
      expect(Object.hasOwn(r, "skipped"), details).toBe(false);
    }
  });

  it("an explicit skipped flag on the outcome wins over the details markers, in both directions", async () => {
    const worded = await record({ passed: true, details: "No tools to validate", skipped: true });
    expect(worded.skipped).toBe(true);

    const notReally = await record({ passed: true, details: "Skipped: ...", skipped: false });
    expect(Object.hasOwn(notReally, "skipped")).toBe(false);
  });

  it("an explicit flag cannot turn a failure into a skip", async () => {
    const r = await record({ passed: false, details: "HTTP 500", skipped: true });
    expect(r.passed).toBe(false);
    expect(Object.hasOwn(r, "skipped")).toBe(false);
  });

  it("isSkipOutcome is the one rule: explicit flag first, then the markers, never on a failure", () => {
    expect(isSkipOutcome({ passed: true, details: "Skipped: no --auth provided" })).toBe(true);
    expect(isSkipOutcome({ passed: true, details: "HTTP 200" })).toBe(false);
    expect(isSkipOutcome({ passed: false, details: "Skipped: tools/list failed" })).toBe(false);
    expect(isSkipOutcome({ passed: true, details: "anything", skipped: true })).toBe(true);
    expect(isSkipOutcome({ passed: true, details: "Skipped: ...", skipped: false })).toBe(false);
  });

  it("a thrown body is a failure, never a skip", async () => {
    const h = harnessWith(defs);
    await h.check("probe", async () => {
      throw new Error("Skipped: boom");
    });
    expect(h.tests.map((t) => [t.passed, Object.hasOwn(t, "skipped"), t.details])).toEqual([
      [false, false, "Error: Skipped: boom"],
    ]);
  });

  it("onTestComplete receives the flag, so a live consumer can tell a skip from a pass", async () => {
    const seen: Array<[string, boolean, boolean | undefined]> = [];
    const h = harnessWith(defs, { onTestComplete: (r) => seen.push([r.id, r.passed, r.skipped]) });
    await h.check("probe", async () => ({ passed: true, details: "Skipped: no --auth provided" }));
    await h.check("other", async () => ({ passed: true, details: "HTTP 200" }));
    expect(seen).toEqual([
      ["probe", true, true],
      ["other", true, undefined],
    ]);
  });

  it("the retry loop keeps the flag from the attempt it recorded", async () => {
    // A check that fails, is retried, and then skips: the recorded result
    // is the skip, flag and all.
    vi.useFakeTimers();
    try {
      const h = harnessWith(defs, { retries: 1 });
      let calls = 0;
      const done = h.check("probe", async () => {
        calls++;
        return calls === 1
          ? { passed: false, details: "HTTP 503" }
          : { passed: true, details: "Skipped: no --auth provided" };
      });
      await vi.advanceTimersByTimeAsync(1000);
      await done;
      expect(h.tests.map((t) => [t.passed, t.skipped, t.details])).toEqual([
        [true, true, "Skipped: no --auth provided"],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
