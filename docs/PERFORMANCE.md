# Performance: why the suite is sequential (today) and what parallelization would cost

## Where time goes today

Run `mcp-compliance benchmark` against a fast stdio fixture: the whole 88-test suite completes in ~3 seconds. Rough breakdown:

| Phase | Cost | Notes |
|---|---|---|
| Transport spawn / TCP handshake | 50–150 ms | Once per run |
| Lifecycle handshake (initialize + notifications/initialized) | ~50 ms | Sequential — can't parallelize; must happen first |
| Main test loop (82 independent tests × ~25 ms each) | ~2000 ms | **This is the bulk of the runtime** |
| Cleanup / close | 50–200 ms | Sequential for correctness |

**Takeaway:** the ~2 s of main-loop work is what parallel execution would address. Cut it to ~500 ms if we ran 4 tests in flight simultaneously. For a CI job that already takes minutes, the savings are noise. For a human dev loop (watch mode), it's the difference between "snappy" and "there's noticeable latency."

## Why we haven't parallelized yet

Four design hazards, any one of which can silently corrupt results:

1. **Session state mutation.** `lifecycle-init` stores the `Mcp-Session-Id` returned by the server, and subsequent tests inject it. If init hasn't finished when `tools/list` fires, `tools/list` goes out with a null session and fails. The test runner currently avoids this by serializing — you can't race something that doesn't start until the prior await resolves. Parallel execution needs an explicit phase barrier.

2. **Capability detection.** `hasTools` / `hasResources` / `hasPrompts` are read by later tests to decide whether to skip. They're set during init, but a naive `Promise.all` over "all post-init tests" might capture the closure before init's side effects land. TDZ-looking errors would result. We already fixed this once (hoisting the `const` declarations before the tests that read them); parallelization reintroduces similar ordering hazards in ways that only surface under load.

3. **Caches.** `cachedToolsList` is populated by `tools-list` and reused by `tools-call` / `tools-schema` / `security-command-injection` (etc). Under parallel execution, two of those tests could race before the cache fills, each making their own `tools/list` round-trip. Correct, but defeats the optimization. Worse: if the server returns slightly different `tools` arrays on consecutive calls (some do — they sort by most-recently-used), the tests see inconsistent data.

4. **Stdio server assumptions.** The MCP spec allows concurrent in-flight requests on a single session, but not every server implements it correctly. We've seen reference servers (and several third-party ones) that assume single-threaded access and deadlock when multiple `tools/call` fire simultaneously. A compliance tool that triggers server bugs to run faster is a compliance tool that doesn't get used.

## The design sketch (for v1.0+)

When we take this on, the shape is:

1. **Add a `parallelSafe: boolean` flag to `TestDefinition`**. Default `false`. Tests that demonstrably don't touch cached state or require ordering get `true`. Audit per-test.

2. **Split the runner into three phases:**
   - **Setup** (sequential): preflight, initialize, notifications/initialized, cache population
   - **Parallel** (`Promise.all` with pool of N): all `parallelSafe: true` tests
   - **Sequential** (in order): everything else, same as today

3. **Add a `--concurrency N` flag** (default 1, matching today's behavior). Raising it opts into the parallel phase.

4. **Instrument with tracing**: if a test relies on a cache that wasn't populated, it should fail fast with a clear "ordering violation" message — not silently make its own round-trip.

5. **Document known-incompatible servers** as a table in `docs/PERFORMANCE.md`. Expect ~10% of servers to fail under concurrency because they don't handle it; users who hit that keep `--concurrency 1`.

## Until then

- Use `--watch` for dev-loop speed — re-runs are fast because the child process stays warm between edits.
- Use `--only <category>` to test just the section you're working on.
- `mcp-compliance benchmark --concurrency 4` gives you pure pressure/throughput numbers without worrying about compliance semantics.
- For CI, the full suite at 3 s is already faster than most test suites — probably not worth optimizing first.

Tracking issue: [YawLabs/mcp-compliance#TBD](https://github.com/YawLabs/mcp-compliance/issues).
