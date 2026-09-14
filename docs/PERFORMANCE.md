# Performance: why the suite is sequential (today) and what parallelization would cost

## Where time goes today

Run `mcp-compliance benchmark` against a fast stdio fixture: the whole 88-test 2025-11-25 suite completes in ~3 seconds. Rough breakdown:

| Phase | Cost | Notes |
|---|---|---|
| Transport spawn / TCP handshake | 50–150 ms | Once per run |
| Spec-version detection (`--spec-version auto`) | 0–1 round-trip | One modern `server/discover`. On HTTP it **is** the preflight request, so it costs nothing extra; on stdio it is the first exchange and its reply seeds the modern suite, so a modern server pays nothing extra either. A legacy stdio server that ignores unknown methods pays the startup timeout once (terminal mode prints a status line after ~2 s so it does not look like a hang). An HTTP server whose first reply misses the preflight timeout pays one re-probe bounded by the startup timeout; a server that accepts and never answers therefore costs preflight + startup timeout (10 s + 60 s at defaults) before the legacy suite starts, and that suite then bounds its `initialize` by the per-request timeout rather than a third startup-sized wait (skipping `notifications/initialized` when `initialize` got no reply), so the first test is reached after 10 s + 60 s + 15 s at defaults. Pinning `--spec-version` skips all of it. |
| Lifecycle handshake (initialize + notifications/initialized) | ~50 ms | 2025-11-25 only. Sequential — can't parallelize; must happen first |
| Main test loop (82 independent tests × ~25 ms each) | ~2000 ms | **This is the bulk of the runtime** |
| Cleanup / close | 50–200 ms | Sequential for correctness |

**Takeaway:** the ~2 s of main-loop work is what parallel execution would address. Cut it to ~500 ms if we ran 4 tests in flight simultaneously. For a CI job that already takes minutes, the savings are noise. For a human dev loop (watch mode), it's the difference between "snappy" and "there's noticeable latency."

### The 2026-07-28 suite is stateless

The 103-test 2026-07-28 suite has no handshake, no session id and no negotiated version to carry between requests: every request is self-describing (`params._meta` + mirrored headers), so hazards 1 and 2 below do not exist there. It still runs sequentially by default, for three reasons that do survive the era change: the list caches (hazard 3), the server-side concurrency assumption (hazard 4), and the post-hoc rules -- `transport-no-server-requests`, `lifecycle-log-level-gating`, `error-id-echo`, `error-retired-codes` and the four `schema-*` scans run over a Recorder of every message the server sent, and they need every other test to have drained first. Only four modern tests are marked `parallelSafe` today (`lifecycle-string-id`, `lifecycle-server-info`, `lifecycle-instructions`, `lifecycle-meta-tolerance`); more of the discover-result and envelope-rejection tests are candidates once we have concurrency data from real servers. The `security-rate-limiting` burst (50 requests, sent to a read-only no-argument tool when there is one, else `server/discover`; it runs after every other live probe so a limiter it trips cannot answer them) is the same size as the legacy suite's, the header/`_meta` rejection probes are one round-trip each, and the four injection tests probe **one** (tool, argument) target -- 5 + 3 + 3 + 4 = 15 `tools/call`s regardless of how many tools the server lists, the same scope as the legacy suite, so the injection cost does not grow with the tool count. Two costs are modern-only: on stdio the `lifecycle-dual-era` probe spawns a second child so a dual-era server's era selection is measured on a fresh process (one extra process boot; its `initialize` waits the per-request timeout, stretched to three times the setup `server/discover` latency for a slow starter and capped by the startup timeout, and only when that child exits unanswered is a third, idle instance watched for a few seconds to tell a single-instance server from one that exits on the request), and a `--only` run that skips the feature tests fetches the lists it needs once on demand (one extra `tools/list` / `resources/list` / `prompts/list` each; on stdio a `--only` run of the claim-less `_meta` probes sends one such list, or a `ping`, to pin the process first). Expect the modern suite's wall time to sit in the same few-second range against a comparable fixture; it has not been benchmarked separately yet.

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
