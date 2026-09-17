# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Pre-1.0 releases follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
loosely — breaking changes can still land in a minor bump, but we'll call them
out explicitly here.

## [Unreleased]

### Added
- **MCP 2026-07-28 support (#63).** A second test catalog, `MODERN_TEST_DEFINITIONS`
  (103 tests in the same 8 categories: 20 transport, 22 lifecycle, 6 tools, 8
  resources, 4 prompts, 12 errors, 10 schema, 21 security), and a stateless suite
  for the per-request-`_meta` era: `server/discover` instead of `initialize`,
  `_meta` and standard-header validation (`-32602`, `-32020`, `-32022`), caching
  hints (`ttlMs` / `cacheScope`) on every cacheable result, `resultType` on every
  result, `-32602` for missing resources, `subscriptions/listen` acknowledgment,
  per-request log-level gating, MRTR `input_required` results, and rejection of
  the removed `ping` / `logging/setLevel` / `resources/subscribe` methods. Eight
  post-hoc tests scan a recording of every message the server sent, including a
  full validation against the vendored 2026-07-28 JSON schema. An id shared with
  the 2025-11-25 catalog covers the same feature, but its criteria and required
  flag may differ between the catalogs (`stdio-framing` and
  `error-invalid-jsonrpc` are optional in 2026-07-28, `error-method-code` is
  required), so ids are comparable only within one catalog; checks whose verdict
  flipped have new ids (`lifecycle-discover`, `transport-get-removed`,
  `resources-not-found`, ...).
- **`--spec-version auto|2025-11-25|2026-07-28`** on `test` and `benchmark`, a
  `specVersion` key in the config file, a `specVersion` input on the
  `mcp_compliance_test` MCP tool (and an optional one on `mcp_compliance_explain`,
  which otherwise searches both catalogs), and a `spec-version` input + output on
  the GitHub Action. `--list --spec-version` previews either catalog offline.
- **Library API:** `SUPPORTED_SPEC_VERSIONS`, `SpecVersion`, `specBaseFor()`,
  `getTestDefinitions(version)`, `findTestDefinition()`, `MODERN_TEST_DEFINITIONS`,
  `detectSpecVersion()` / `classifyDiscoverResponse()`, and `RunOptions.specVersion`
  / `PreviewOptions.specVersion`. `TEST_DEFINITIONS` is unchanged (the 2025-11-25
  list). `SPEC_VERSION` and `SPEC_BASE` keep their 2025-11-25 values and are
  deprecated in favour of `report.specVersion` + `specBaseFor()`.
- **`benchmark` is spec-aware.** It measures `server/discover` on 2026-07-28 (there
  is no `ping`) and `initialize` + `ping` on 2025-11-25; the result names the
  `specVersion` and `method` measured.
- **Methodology 2.0.0.** `COMPLIANCE_RUBRIC.md` gains an execution model per spec
  revision (section 1.5), a 2026-07-28 rules section (3b), and modern-server
  adoption notes; `mcp-compliance-rules.json` tags every rule with `specVersion`
  and carries both catalogs (`mcpSpecCompatibility` is now an array, which is the
  catalog-schema change that makes this a major bump). A new
  `src/tests/catalog-parity.test.ts` keeps both files and the README in lock-step
  with the code's catalogs.
- **`RunOptions.onStatus` and a pre-test status line.** The runner reports what it
  is waiting on before the first test: the stdio era probe still unanswered after
  2 s (`Probing spec era (server/discover, up to 60s). A 2025-11-25 server that
  ignores unknown methods takes the whole startup timeout; --spec-version
  2025-11-25 skips the probe.`) and an HTTP preflight timeout being re-probed. The
  CLI prints these dimmed on stderr in terminal mode only; `json`, `sarif`,
  `github`, `markdown` and `html` output is untouched.
- **Pinned runs say when the server speaks the other era.** On HTTP the preflight
  is still a modern `server/discover`, so `--spec-version 2025-11-25` against a
  modern-only server (or `2026-07-28` against a legacy one) now carries `Server
  answered the 2026-07-28 server/discover probe with a DiscoverResult
  (supportedVersions [...]); this run is pinned to 2025-11-25. Re-run with
  --spec-version 2026-07-28 (or auto) to grade it.` A 401/403 never triggers it.
  `lifecycle-init` also quotes the server's JSON-RPC error instead of the bare
  "No result in response".
- **`DetectionResult.responded` / `eraUndetermined`** and the exported
  `REASON_PREFIX` (`server/discover -> `) on every detection reason; a 401/403
  on the probe reads `HTTP 401 (authentication required -- pass --auth); era not
  determinable, using 2025-11-25` instead of claiming the server is legacy.

### Changed
- **`--spec-version` defaults to `auto`, which changes what existing users get.**
  Every run now starts with one conformant 2026-07-28 `server/discover` (on HTTP
  it is the preflight request, so no extra round-trip; on stdio it is the first
  exchange). A `DiscoverResult` or a modern error code selects the 2026-07-28
  suite; anything else — including no reply within the startup timeout — selects
  2025-11-25, so servers that exist today are graded exactly as before. The
  behaviour change is for servers that later upgrade to an SDK speaking
  2026-07-28: on the next run the same CI config switches suites (103 tests, 24
  required by default, different ids, a warning in the report saying so) and the
  grade can move. Pin `--spec-version 2025-11-25` to keep today's suite
  byte-for-byte. Dual-era servers are graded as 2026-07-28 with a warning naming
  the other era.
- **`report.specVersion` is now a run-time value, not a tool-version constant.**
  One tool version emits `"2025-11-25"` or `"2026-07-28"` (always the resolved
  revision, never `"auto"`); consumers must read it before interpreting test ids.
  The report schema is unchanged (`schemaVersion: "1"`).
- **`diff` error text.** On a `specVersion` mismatch the message now names both
  versions and tells you to re-run with `--spec-version <baseline's>` or take a
  new baseline; the old advice to downgrade the tool no longer applies. The diff
  summary and output name the spec version.
- **SARIF runs carry `automationDetails.id = "mcp-compliance/<specVersion>/"`**
  so GitHub Code Scanning tracks the two suites as separate analyses instead of
  closing every 2025-11-25 alert when a server switches revisions.
- **`ajv` and `ajv-formats` are runtime dependencies** (previously dev-only): the
  2026-07-28 suite validates recorded server messages against the spec schema.
- **Config forward-compatibility:** a config file that sets `specVersion` is
  rejected as an unknown key by mcp-compliance < 0.19 (0.18.x included). Pin
  `@yawlabs/mcp-compliance@^0.19` where such a config is consumed.
- `--only` / `--skip` values that match no test id or category in the resolved
  catalog now produce a warning naming the miss (and the `--list --spec-version`
  command to see valid ids) instead of silently running an empty or partial suite
  and grading it F. An empty filtered run prints `No tests ran -- check
  --only/--skip (see warnings)` instead of `All tests passed`, and the `--only`
  help example uses ids that exist in both catalogs.
- **`--only` runs measure instead of skipping (2026-07-28).** The `tools/list`,
  `resources/list`, `prompts/list` and `resources/templates/list` results that a
  filtered-out feature test would have cached are fetched once on demand by
  whichever test needs them, so `--only security`, `--only schema`, `--only
  lifecycle` and `--only transport` exercise the real checks (ten security tests,
  the six definition checks, `lifecycle-progress-token`, `lifecycle-completions`
  and `transport-header-name-mismatch` used to skip-pass and grade A). A test
  skip-passes when the capability is undeclared; when the list call itself failed
  it skip-passes pointing at the `-list` test if that test is in the run, and
  fails with the recorded reason when it was filtered out.
- **`--preflight-timeout` bounds the HTTP era probe; `--startup-timeout` bounds
  the stdio one.** Under `auto` a preflight that times out (as opposed to a
  refused connection) is re-probed once within `--startup-timeout` before the run
  defaults to 2025-11-25, so a modern server on a cold start is graded in its
  real era instead of as unreachable. Against a server that accepts and never
  answers, `auto` now spends preflight + startup timeout before the legacy suite
  starts. Both help strings say which probe they bound.
- **Detection reasons fit the terminal header.** `auto-detected from
  server/discover: supportedVersions [2026-07-28]` / `JSON-RPC error -32601,
  legacy` / `no response, legacy` replace the sentence-long notes; the JSON
  warning keeps the `Spec version auto-detected as <v> (...)` shape.
- **Leak patterns widened (both suites).** `security-error-no-internal-ip` now
  matches 169.254.x, IPv6 loopback in its usual forms (`::1`, `[::1]:5432`,
  `::1:5432`; not a public address such as `2001:db8::1`) and internal
  hostnames (lowercase `*.internal`, `*.local`, `*.corp`, `*.lan`,
  `*.intranet` as the last label, with hostname context: two or more labels
  before the suffix, or a preceding `//`, `@`, `getaddrinfo`/`ENOTFOUND`, or
  a `:port` -- so `ctx.internal`, `settings.local.json` and
  `api.corp-services.example.com` are not flagged), and
  `security-error-no-stacktrace` matches Windows paths with any drive-letter
  case in their JSON-escaped form (`C:\\Users\\svc\\app`), which every scanned
  sample is, without mistaking `ERROR:` before an escaped newline for a drive.
  The 2025-11-25 catalog text is unchanged. A leak repeated across responses is
  reported once with a repeat count.
- **Injection tests probe one target (2026-07-28).** The four injection tests
  send their payloads to a single (tool, argument) from the safest annotation
  tier that has a string argument -- `readOnlyHint: true`, then
  `destructiveHint: false`, then unannotated tools (the spec defaults
  `destructiveHint` to true), then `destructiveHint: true` -- with free-form
  arguments before enum/const/pattern ones, other required arguments filled with
  schema-honouring placeholders so the payload reaches the handler, and
  `x-mcp-header` arguments mirrored. The details count rejected / benign /
  never-reached payloads, claim "server defended" only when every payload was
  rejected, and say "inconclusive" (with a warning) when none reached the tool.
- npm and MCP Registry listing metadata: bugs URL, core keywords, and server.json title/repository/websiteUrl
- `release.sh` writes a `## [x.y.z]` changelog entry for every release — promoting `[Unreleased]` when it has content, otherwise generating one from the commit subjects since the previous tag — keeps the Keep-a-Changelog link references current when the file has them, and takes the GitHub release notes from that entry instead of from `git log` subjects. Before this, the script never touched CHANGELOG.md at all: a release got an entry only if someone wrote one by hand (0.18.0 below is backfilled), and every GitHub release page showed raw commit subjects.

### Fixed
- **False verdicts in the 2026-07-28 suite, found by an adversarial review of the
  branch before release:**
  - The two claim-less `_meta` probes ran early and flipped the reference SDK's
    stdio server (`serveStdio`, default `legacy: 'serve'`) to the legacy era
    mid-run, failing 14 downstream checks; they now run after the suite's own
    modern requests have pinned the process, and SDK 2.0 stdio grades A.
  - The six `_meta` / standard-header rejection tests credited *any* rejection,
    so a legacy-only server pinned to 2026-07-28 passed six required tests it has
    no implementation for; they now fail as `not evaluable` when the conformant
    `server/discover` was itself rejected.
  - `lifecycle-dual-era` labelled a dual-era SDK 2.0 stdio server "modern-only"
    (the probe hit the already-pinned process) and credited an error message that
    only echoed the requested version; on stdio the probe now goes to a fresh
    process, and the SHOULD is satisfied by `data.supported` or a message naming
    a version other than the requested one. The dual-era warning also fires for
    SDK 2.0 servers, which serve `initialize` without advertising 2025-11-25.
  - `error-id-echo` and `schema-wire-valid` failed a server whose auth gate or
    proxy answers 401/403/413/415/429 with a non-JSON-RPC body (the official
    SDK's `requireBearerAuth` writes `{"error":"invalid_token"}`), and
    `error-id-echo` exempted every null-id `-32600`/`-32700` reply by code even
    on well-formed requests; the status now decides, not the code. A body that
    is not `jsonrpc: "2.0"` is not a JSON-RPC error at all (a gateway's
    `{"error":{"code":400,...}}` is not counted), a non-JSON-RPC body on any
    HTTP 4xx/5xx is noted rather than schema-validated, and only an id-less reply
    is exempt on a transport-level status -- a present but wrong id fails.
  - `schema-result-type` accepted any string; it now requires `complete` or
    `input_required` unless an `extensions` capability is advertised (then other
    values pass with a warning naming them). `schema-input-required-shape`
    demanded `params` on `roots/list` (optional in the schema) and never
    enforced the client-capability MUST NOT; it now does both.
  - `stdio-unicode` failed any server whose picked tool does not echo its input;
    it now fails only on evidence of mangling and otherwise falls back to the
    discover envelope round-trip, preferring a tool with a `message`/`text`/
    `input`/`query` argument.
  - `security-auth-malformed` failed a server that answers RFC 6750's
    `invalid_request` 400 to a syntactically invalid credential; it now pins the
    401 with a well-formed invalid token and accepts 400/401/403 for garbage.
  - `security-oauth-metadata` never fetched the `resource_metadata` URL from the
    `WWW-Authenticate` challenge and probed root before path; it now fetches the
    advertised URL and only it (clients MUST use it, so an unreachable, non-200,
    malformed or relative one fails, naming any valid well-known document), tries
    path then root only without a challenge URL, and warns when `resource` is
    not the endpoint.
  - `security-rate-limiting` bursted `server/discover` while citing the
    tools/call MUST; it now bursts a read-only no-argument tool when there is one
    (see the second pass below for how a quiet burst is graded).
  - `security-auth-required` asserted "server accepted unauthenticated requests"
    without probing when `--auth` was absent, contradicting the 401 in the same
    report; it, `security-www-authenticate` and `security-oauth-metadata` now
    probe with or without `--auth`.
  - `security-oversized-input` mirrored the 1 MB value into an `Mcp-Param-*`
    header when the first string argument was `x-mcp-header`, measuring the
    header limit instead of the body; `security-extra-params` reported a plain
    timeout as "server may have crashed"; the leak scan double-counted every
    probe response. All three corrected.
- **A second review pass changed what several reports say:**
  - **`--format github` (the Action's default) now carries the warnings and the
    spec version.** Every report warning becomes a
    `::warning title=mcp-compliance::` annotation (the dual-era, pinned-mismatch,
    unreachable and "pass --auth" notes were invisible in CI), the `::notice`
    summary ends with `; spec <version>` plus how `auto` detected it, and an
    empty run's notice reads `No tests ran -- check --only/--skip` instead of
    `Grade F (0%) -- 0/0 passed`.
  - **Auth-gated server run without `--auth`.** When the probe or preflight draws
    401/403 and no `Authorization` header was configured, the report's first
    warning (index 0, every format) says the server requires authentication,
    that the grade below is not meaningful, and to re-run with `--auth <token>`.
    The 2025-11-25 `security-auth-required` now passes on that 401/403 (`HTTP 401
    (unauthenticated preflight rejected; pass --auth ...)`) instead of claiming
    the server "accepted unauthenticated requests" next to `transport-post`'s
    401.
  - **Injection targets follow the spec's annotation defaults.** The 2026-07-28
    suite treated an unannotated tool as safe and could send path-traversal
    payloads into a write tool; the spec defaults `destructiveHint` to true, so a
    read-only tool now always wins, unannotated tools are a last resort named in
    a warning, placeholders honour the argument schema, and an all-unreached run
    is reported as inconclusive. The 2025-11-25 injection tests no longer fail a
    tool that merely echoes the payload back; they fail only on evidence of
    execution.
  - **`security-rate-limiting` grades a quiet burst the same on both paths
    (2026-07-28).** 50 `tools/call`s to a read-only tool that draw no 429 now pass
    with a warning naming the tool and the 50 invocations, as the
    `server/discover` fallback already did, so annotating a tool `readOnlyHint`
    no longer lowers the grade. A burst that auth rejected (every answer 401/403)
    is skipped with a `--auth` hint instead of passing as "server declares no
    tools", and a burst that got no response fails as `server unreachable`. The
    2025-11-25 check is unchanged.
  - **`benchmark` under `auto` on stdio re-spawns the child the era probe
    killed**, so the samples no longer all fail against a dead process. The probe
    and the unmeasured warm-up are bounded by `--startup-timeout` (new on
    `benchmark`, default `max(--timeout, 60000)`) instead of the per-request
    timeout, terminal mode prints the same "Probing spec era" status line as
    `test`, and `BenchmarkResult.warnings` carries the probe-exit warning. On
    both commands a server that also exits at startup on the fresh instance is
    told it exits at startup regardless of the probe (with its stderr) instead of
    being told to pin `--spec-version`.
  - **Probe ordering and attribution (2026-07-28).** The late lifecycle block
    (`lifecycle-completions`, `lifecycle-progress-token`, the two claim-less
    `_meta` probes and `lifecycle-dual-era`) now runs before the security tests,
    so a gateway that rate-limits the 50-request burst cannot answer those probes
    with 429; a 401/403/413/415/429 answer to any `_meta` or standard-header
    rejection probe now fails it as `not evaluable` instead of being credited,
    and `lifecycle-removed-methods` / `lifecycle-subscriptions-listen` no longer
    credit rejections from a server that rejects everything. Under `--only` on
    stdio the claim-less probes send a pinning request first, so their verdict
    matches the full run. `lifecycle-dual-era` no longer fails a single-instance
    stdio server (an idle second instance tells "exits at startup" from "exits on
    `initialize`"), reports a server that serves `initialize` but rejects
    `server/discover` as `legacy-only` rather than dual-era (with a matching
    run warning), waits `--timeout` (stretched for a slow starter) rather than
    `--startup-timeout` on its fresh process, and names a connection error as
    such rather than "no response within Nms".
  - Smaller: the pinned-run mismatch warning fires only on a real era signal
    (not a 5xx or an HTML page) and a dual-era server whose `supportedVersions`
    lists the pinned 2025-11-25 is told `this run grades its 2025-11-25 side` instead of being sent to the other
    pin; a pinned run's "unreachable" warning is downgraded once later requests
    are answered; `--only schema` fails over a broken list instead of grading A,
    and `-list-caching` no longer re-sends a list that timed out; an `--only`
    value gated off the target transport is warned about, and `--list` pads long
    2026-07-28 ids and prints the filter warnings per catalog; `stdio-unicode`
    fails a reply whose non-ASCII was replaced by `?` and passes a tool that
    tokenizes its input; `schema-input-required-shape` fails a url-mode
    elicitation the client did not declare; `mcp_compliance_explain` says only
    the wording differs for a shared id whose required flag and category match;
    `lifecycle-init` on a crashed stdio server quotes the stderr cause instead of
    stack frames; `RunOptions.signal` now also aborts the HTTP preflight and the
    raw transport probes; and a hung HTTP server costs preflight + startup
    timeout + per-request timeout before the first test, not three startup
    timeouts.
- **`auto` graded a dead child.** A legacy stdio server whose dispatcher exits on
  the unknown `server/discover` was classified correctly but the 2025-11-25 suite
  then ran against the exited process and failed everything as "Initialize
  request failed". The run now warns (`Server exited (code 1) after the
  2026-07-28 era probe (server/discover); last stderr: ...`, with the
  `--spec-version 2025-11-25` hint) and spawns a fresh instance.
- **The unreachable-server warning claimed "all tests will fail"** while ~30
  optional skip-passes (and, under a modern pin, four required post-hoc scans)
  passed vacuously. The wording is now "every test that needs the server will
  fail", and the eight modern post-hoc scans fail outright when no server
  message was received.
- **`benchmark --spec-version 2026-07-28` on stdio folded the child's boot into
  the first measured sample** (max latency two orders of magnitude off versus an
  `auto` run). A pinned modern run now sends one unmeasured `server/discover`
  warm-up first, as the legacy path always did with `initialize`.
- **stdio `stream()` did not end when the child exited** (it waited the full
  timeout and `lifecycle-subscriptions-listen` reported "No acknowledgment"
  instead of "server exited"), and `close()` skipped `notifications/cancelled`
  once the timer had fired. Both fixed; `TransportStream.exit` exposes the exit.
- **`Mcp-Param-*` mirroring only walked top-level `inputSchema.properties`;** it
  now follows nested `properties` chains as the spec allows.
- **`lifecycle-subscriptions-listen` accepted an acknowledgment honouring more
  than was requested** (a filter-ignoring server); a surplus now passes with a
  warning.
- **`security-token-in-uri` never put the token in the URI.** The probe went through
  the transport, which ignores the URL it is handed and re-injects the configured
  `Authorization` header, so every authenticated server answered an ordinary
  authenticated `ping` with 200 and the test reported a false "accepted auth token
  in query string" failure. It now POSTs to `?access_token=<token>` with no
  `Authorization` header.
- **`lifecycle-progress-token` always skipped.** It ran among the lifecycle tests,
  before `tools/list` had populated the tool names, so it always took the "No
  tools available" branch. It now runs after the tools section and calls a real
  tool.
- **Config `format` accepted only `terminal`, `json`, `sarif`** (#67) and rejected
  `github`, `markdown` and `html`, which the CLI accepts. The config loader now
  takes every CLI format.
- **`benchmark` counted JSON-RPC error replies as successful requests**, so a
  server answering `-32601` to every probe reported error-path latency with
  `failed: 0`. Error bodies are now failures.
- **A failed list call made its consumers pass in a filtered run.** When
  `tools/list`, `resources/list` or `prompts/list` failed, `tools-call`,
  `tools-content-types`, `tools-list-deterministic-order`, `resources-read`,
  `resources-read-caching`, `prompts-get` and the ten tool-based security tests
  skip-passed, so `--only tools-call` against a server whose `tools/list` returns
  `-32603` graded A / 100. `lifecycle-completions` did the same with a failed
  `prompts/list` or `resources/templates/list`: it fell back to the placeholder
  probe and passed on `-32602`. They now follow the rule the schema checks
  already used: skipped with a pointer when the owning `-list` test is in the run
  (it fails on its own), failed with the recorded reason ("tools/list failed
  (JSON-RPC error -32603 ...); no tool to call") when it is not. A declared but
  empty list, an undeclared capability, or `-32601` from
  `resources/templates/list` still behaves as before, and a listed template is
  still completed when only `prompts/list` failed.
- **`benchmark` against a sessionful 2025-11-25 HTTP server failed every
  ping** (the SDK v1 `StreamableHTTPServerTransport` with a `sessionIdGenerator`
  answered `400 Server not initialized`, and the command exited 1): the warm-up
  `initialize` discarded the `Mcp-Session-Id` and negotiated
  `MCP-Protocol-Version`. It now carries both into the timed pings, as `test`
  does.
- **A negotiated `protocolVersion` that is not a valid header value broke every
  later request** (`test` and `benchmark` on 2025-11-25 HTTP servers): undici
  refused the `MCP-Protocol-Version` header client-side ("invalid
  mcp-protocol-version header"). Such a value is no longer carried as a header;
  `lifecycle-proto-version` still reports it.
- **`security-tool-description-poisoning` missed bidi control characters**
  (U+202A-U+202E, U+2066-U+2069, the "Trojan Source" overrides) although its
  description promised them; only the zero-width characters were matched. Both
  catalogs now flag them.
- **False verdicts found by a coverage pass over the 2026-07-28 suite:**
  - The errors checks credited any rejection, so a server that rejects every
    request (`400 -32000 Server not initialized`, or `-32601` for everything)
    passed the required `error-unknown-method` and `error-method-code`, plus
    `error-invalid-jsonrpc`, `error-invalid-json` and `error-capability-gated`.
    They now fail as not evaluable when the conformant `server/discover` was
    itself rejected, as the lifecycle and header checks already did.
  - `lifecycle-meta-required`, `-protocol-version-required` and
    `-client-capabilities-required` passed (with a warning) when the malformed
    probe drew a plain-text 404, 422 or 500. Only a bare HTTP 400 still passes
    with a warning; any other status without a JSON-RPC error body fails.
  - `resources-not-found` passed with a warning on `-32603`, `-32601` or any
    other code for a missing resource. The spec requires `-32602`; other codes
    now fail.
  - `security-auth-required`, `security-www-authenticate`,
    `security-token-in-uri`, `security-cors-headers` and
    `security-origin-validation` passed as "connection rejected" against a
    server that timed out or refused the connection. That is now
    `server unreachable`; a connection closed without an answer still counts as
    a refusal only when the same request with the credential (or without the
    Origin) was served.
  - The injection checks passed as inconclusive when the server died on every
    payload. A stdio child that exits on a payload, or an HTTP connection
    dropped on a payload after which the server neither serves
    `server/discover` nor answers it with a 401/403/413/415/429 gate, now fails
    naming the payload; a drop the server outlives (a WAF or IPS, a keep-alive
    close) counts as never reached, with a warning.
  - `security-tls-required` passed any 3xx redirect without reading `Location`;
    a redirect must now resolve to a single https URL.
  - `security-token-in-uri` failed a server that answered the query-string
    token with a JSON-RPC error framed as SSE, as if it had accepted the token.
  - `security-tool-cross-reference` failed on one-letter or common-word tool
    names (`a`, `get`, `search`) appearing in ordinary prose. Plain-word names
    now count only in code-like context (backticks, quotes, a call, "the X
    tool").
  - `transport-batch-reject` reported "server processed the batch (0 replies)"
    for an SSE answer with no data frames and failed an SSE answer whose error
    frame followed a notification. Only JSON-RPC responses on the stream count
    now. An SSE data frame holding an array now fails as a processed batch, as
    the same array over `application/json` does.
  - `error-id-echo` exempted a double-answered request's stray id-less error
    whenever any client notification had been sent earlier in the run; a
    notification now owns a stray only while no later request was answered
    before it.
  - `lifecycle-meta-client-info-optional` blamed clientInfo for a blanket
    rejection or a rate limiter's 429; that is now reported as not evaluable.
  - Cancelling a run during `lifecycle-subscriptions-listen` recorded "No
    acknowledgment within Nms" instead of stopping.
- **A rejected `--auth` credential got advice to pass `--auth`.** A 401/403 on
  the era probe or preflight with an Authorization header configured now gets a
  first-position warning (auto and pinned runs) that the grade is not
  meaningful. It says the credential was rejected for a 401, or a 403 with a
  `WWW-Authenticate: Bearer error="insufficient_scope"` challenge, and the
  auto-detection note and `transport-post` then say "credential rejected --
  check --auth". Any other 403 (the SDK's Host validation behind a tunnel
  hostname, Origin validation, a gateway) gets a neutral warning pointing at
  Host/Origin validation or a gateway, and the note and `transport-post` say
  "forbidden -- no insufficient_scope challenge". After a preflight timeout the
  warning names the status of the re-probe that answered.
- **False verdicts and misleading details found by a final coverage pass over
  the 2026-07-28 suite:**
  - `lifecycle-removed-methods` credited any bare HTTP 4xx and any
    401/403/413/415/429. streamable-http requires 404 with `-32601` for a
    method the server does not implement, so only a bare 404 still passes with a
    warning; any other bare status (400, 405, 500) fails naming it, and a
    transport-level status, with or without a JSON-RPC body, fails as not
    evaluable.
  - `lifecycle-meta-tolerance` blamed the unknown `_meta` key for a blanket
    rejection or a transport-level gate; that is now reported as not evaluable,
    as `lifecycle-meta-client-info-optional` already was.
  - `transport-header-name-mismatch` skip-passed when one of `resources/list`
    and `prompts/list` failed and the other listed nothing readable by name
    (graded A under `--only`); it now names the failed list, and fails when that
    `-list` test is filtered out of the run.
  - `security-auth-malformed` passed as "connection rejected" when a bad
    credential got no answer. A timeout, a refused connection, or a dropped
    connection when the credentialed `server/discover` was not served is now
    `server unreachable`, as for the other negative auth probes, and cancelling
    the run during its probes no longer records it as passed.
  - `security-oversized-input` (stdio) passed a timed-out 1 MB call as
    "survived" when an earlier reply in the run had overflowed the runner's
    stdio line buffer, or when the server printed the runner's drop marker on
    its own stderr. Only an overflow during that call counts now.
  - The reply to a raw-body probe (invalid JSON, invalid JSON-RPC, a batch)
    sent as SSE with its JSON split across several `data:` lines was dropped
    from the recording, so `error-retired-codes` could miss a retired code in
    it. It is now recorded, and `error-id-echo`, `schema-wire-valid` and the
    security error-sample scans see it too.
  - `stdio-unicode` reported a crash or hang on the CJK/emoji probe as a harness
    `Error:` carrying the server's multi-line stderr tail; it now fails with a
    one-line reason (`server exited (code N)`, or the timeout). `error-id-echo`
    notes a stray error reply that arrives while no request is pending as
    `received while no request was pending` instead of counting it as a reply
    to a raw probe or client notification.
  - The "non-JSON-RPC body" detail printed the HTTP status twice
    (`server/discover answered HTTP 404, non-JSON-RPC body (HTTP 404)`) and
    claimed `HTTP 200` on stdio; it now reads `server/discover answered
    non-JSON-RPC body (HTTP 404)`.
  - Under `auto`, a server that missed both the preflight and the era re-probe
    but answered `initialize` got a warning blaming only a slow cold start; it
    now says the era was not detected, that the run defaulted to 2025-11-25, and
    that `--spec-version 2025-11-25` skips the re-probe.
- **`lifecycle-progress-token` (2025-11-25) never reached the tool on SDK
  servers.** It sent `Accept: text/event-stream` alone, so Streamable HTTP
  servers built on the official SDK answered 406 and the test reported `HTTP
  406 — request with progressToken accepted`. It now sends both media types,
  and a non-2xx answer says the `tools/call` was not served.
- **stdio `close()` returned before the forced process-tree kill ran.** On
  Windows a caller that exits right after closing (a test worker, a script)
  took `taskkill` down with it and left a busy server that ignores stdin
  closing running. `close()` now waits up to 5 s for the kill to finish and the
  child to exit, and a transport whose spawn failed closes at once.

## [0.18.2] — 2026-09-15

### Security
- **`undici` is now `^8.9.0` (was `^8.7.0`) and `@modelcontextprotocol/sdk` is now `^1.30.0` (was `^1.29.0`); `npm audit` goes from 10 findings (5 high) to 0.** Both are runtime dependencies that tsup leaves external, and nothing in the advisory set is bundled: the published `dist/` imports the SDK and `undici` as bare specifiers and carries no `fast-uri`, `hono`, `@hono/node-server`, `qs` or `ip-address` code, so a consumer's copies come from their own install, and a fresh install of 0.18.1 already resolves every advised runtime package to a patched version. What the new `undici` floor changes is that an existing install or consumer lockfile can no longer sit on 8.7.x–8.8.x, the range the five undici advisories cover (one high, in cache-directive parsing); this package only calls undici's `request` and never touches the cache interceptor, so exposure there was low. The SDK floor is sibling consistency, since 1.30.0 keeps the same transitive ranges apart from widening `@hono/node-server` to allow 2.x. The lockfile moves `undici` 8.7.0 → 8.10.2, `fast-uri` 3.1.2 → 3.1.7, `hono` 4.12.25 → 4.13.7, `@hono/node-server` 1.19.14 → 2.1.1, `ip-address` 10.2.0 → 10.7.0 (with `express-rate-limit` 8.5.2 → 8.7.0 above it), `qs` 6.15.2 → 6.16.0, `postcss` 8.5.16 → 8.5.28 (with `nanoid` 3.3.12 → 3.3.19 under it) and `vitest` 4.1.10 → 4.1.11. Of the SDK's transitives only `fast-uri` (via `ajv`) is loaded at run time; `hono`, `@hono/node-server`, `qs` and `ip-address` back the SDK's HTTP server transport, which only the integration tests import. `postcss` and `vitest` are dev toolchain only.

## [0.18.1] — 2026-09-14

### Changed
- npm and MCP Registry listing metadata: bugs URL, core keywords, and server.json title/repository/websiteUrl
- `release.sh` writes a `## [x.y.z]` changelog entry for every release — promoting `[Unreleased]` when it has content, otherwise generating one from the commit subjects since the previous tag — keeps the Keep-a-Changelog link references current when the file has them, and takes the GitHub release notes from that entry instead of from `git log` subjects. Before this, the script never touched CHANGELOG.md at all: a release got an entry only if someone wrote one by hand (0.18.0 below is backfilled), and every GitHub release page showed raw commit subjects.

## [0.18.0] — 2026-09-13

No runtime changes; the published package behaves exactly as 0.17.4.

### Changed
- `release.sh` waits for npm to actually serve the new version before the MCP Registry step. `npm publish` returns as soon as the registry accepts the tarball, but the version is not yet readable from npm's CDN-backed read path, and the MCP Registry validates a release by reading it — so a registry publish that ran straight after `npm publish` could fail with `version '<x>' was not found (status: 404)` and need a second run. The wait polls with `curl` the exact percent-encoded URL the registry's npm validator requests (`npm view` caches metadata for five minutes and could outlast the condition), warns rather than fails at its cap so `mcp-publisher` still reports its own precise error, and is tunable: `NPM_WAIT_TIMEOUT_S` (default 300) sets the cap and `SKIP_NPM_WAIT=1` bypasses it (#73).
- README: the X follow badge moved from the top of the page to the bottom, so the description leads on npm and GitHub (#74).

## [0.17.4] — 2026-09-13

### Fixed
- **The launcher always uses the newest oam, and the minimum is now the latest release, 0.15.2** (up from 0.9.0). It used to take the FIRST oam binary it found and only then check its version, so a stale copy in an earlier location hid a current one: with oam 0.9.0 in `~/.oam/bin` and 0.15.2 on `PATH`, it ran 0.9.0. Every oam binary it can see is now asked for its version, and the newest at or above 0.15.2 wins; on a tie the installed copy still wins over `PATH`.
- **An oam host older than the floor no longer runs the CLI itself.** When a host ran `oam run bin/mcp-compliance.mjs` on an old oam and discovery found no usable oam, the CLI ran on that old oam — the runtime whose `child_process` bugs this floor exists to keep out of a compliance harness. When a newer oam WAS found, the handoff inherited stdio, which an oam before 0.9.0 does not honor, so the MCP handshake never answered (measured on a real oam 0.8.2 host). An old host now hands off with piped stdio to the newest usable oam, or to Node on `PATH`, or exits with an error when there is neither.
- **A bad `OAM_BIN` is reported instead of silently ignored.** A path that does not exist, an oam below the floor, or a binary that will not run is named on stderr, and discovery carries on instead of dropping straight to Node.
- **`MCP_COMPLIANCE_RUNTIME=node` now always means Node.** Launched under `oam run`, it hands off to Node on `PATH` rather than staying on oam.
- Each `oam --version` probe is bounded at 5s, so a wedged binary on `PATH` cannot hang the launch.

## [0.17.3] — 2026-09-12

### Fixed
- **The launcher no longer spawns a nested oam when it is already running on oam.** A host that resolves this package's `bin` and launches `oam run bin/mcp-compliance.mjs` — Yaw MCP does, and so does oam's sidecar regression matrix — got a second runtime boot, because the launcher discovered and spawned oam without asking what it was already running on (measured on Windows: `oam.exe` with a nested `oam.exe` + `conhost.exe` underneath). When `process.versions.oam` clears the same 0.9.0 floor a discovered binary must, the CLI is now imported into the current process. Nothing is lost, since this launcher applies no sandbox; a host oam below the floor keeps the discovery path.

## [0.17.1] — 2026-08-23

### Fixed
- **The launcher no longer dies with a raw stack trace when `spawn` fails.** Node throws synchronously rather than emitting `error` for some unexecutable targets — notably a `.cmd`/`.bat` on Windows — and the `error` listener is registered *after* the `spawn` call, so it could never observe that throw. Both failure modes now route through one handler.
- **Windows `PATH` discovery accepts `oam.exe` only**, instead of walking every `PATHEXT` entry and returning an `oam.cmd` Node cannot execute. A skipped shim is still **named** in the diagnostic, so an npm-style install no longer reports as "no oam binary was found".
- **A failing in-process fallback no longer escapes as an unhandled rejection.** `void runInProcess()` discarded the promise, replacing the launcher's own diagnostic with a raw stack trace.
- **Diagnostics that precede `process.exit` are written synchronously.** stderr is async for TTYs and pipes on Windows, so the exit could truncate them. They route through one helper that also handles short writes and macOS `EAGAIN` on a non-blocking piped stderr.
- Removed a literal backspace byte (`U+0008`) from the runtime-discovery comment, which made git treat the file as binary so its diff could not be reviewed.
- **An oam that cannot be *run* is no longer reported as an *outdated* one.** The version probe returns null for several distinct causes — not executable, wrong architecture, a shim Node refuses, deleted since the stat, unparseable `--version` output — and every one produced "older than oam 0.9.0 … run `oam self-update`", pointing at the single cause it definitely was not. The two cases now carry separate wording and remedies, and the outdated message reports the version actually detected.
- **Windows: the launcher no longer hard-kills the server on the first Ctrl-C.** There are no POSIX signals on Windows — `child.kill(sig)` ignores the name and calls `TerminateProcess`, an immediate hard kill (verified: a child with a `SIGTERM` handler never runs it and dies with `code=null`). The launcher forwarded anyway, on the stated assumption that this was a "no-op on Windows", so it aborted the graceful shutdown the console's own Ctrl-C had just started and skipped the server's `process.on("exit")` cleanup. The console already delivers the event to the whole process group, so on Windows the launcher now forwards nothing.
- **A wedged server no longer leaves the launcher hanging.** Forwarding was gated on `child.killed`, which records only that `kill()` was *called* — never that the child is gone — so every signal after the first was swallowed and there was no escape hatch. Escalation is now armed by a timer on the first signal: one press is enough, and a child still alive after a 2s grace window is killed. Using a timer rather than counting signals also stops the ordinary supervisor sequence (`SIGINT` then `SIGTERM` milliseconds apart) from being misread as impatience.

## [0.16.1] — 2026-06-11

- **Breaking: removed the hosted badge/publish feature.** `mcp.hosting` (the
  hosted report/badge service) is retired, so the `badge` and `unpublish`
  commands, the `--publish` flow, the `mcp_compliance_badge` MCP tool, and the
  GitHub Action's `publish` input / `report-url` output are gone. Reports are
  now pure-local — use `mcp-compliance test --output badge.svg` for a local SVG
  badge. The report `badge` block is retained but always empty (deprecated; to
  be removed in schema v2).
- Repointed the report schema `$id` and the package homepage off `mcp.hosting`.

## [0.14.1] — 2026-04-19

- **Fix: bare invocation double-started the stdio server.** 0.14.0 added a
  bare-invocation path in `src/index.ts` that boots the MCP server when no
  subcommand is given, but `src/mcp/server.ts` still carried a legacy
  self-bootstrap block meant for `node dist/mcp/server.js`. Under tsup
  bundling, `import.meta.url` in `server.ts` gets rewritten to the bundle
  (`dist/index.js`), so `isInvokedDirectly()` returned true and a *second*
  server instance attached to the same stdin/stdout — two readers racing
  the same JSON-RPC stream, responses duplicated, initialize handshake
  corrupted. External symptom: `npx -y @yawlabs/mcp-compliance` graded
  servers as F when pointed at itself via the catalog. Fix: `isInvokedDirectly()`
  now additionally verifies the module's own basename is `mcp/server.{js,ts}`,
  so the self-bootstrap fires only for the standalone `dist/mcp/server.js`
  entry (used by the dogfood integration test) and `tsx src/mcp/server.ts`
  during dev — never from inside the CLI bundle.

## [0.14.0] — 2026-04-19

- **Bare invocation now starts the MCP server.** `npx -y @yawlabs/mcp-compliance`
  (no args) previously printed a help screen and exited — surprising for the
  most common install shape where the user adds the package via `claude mcp
  add`, an MCP catalog entry, or hand-copying the package name from npm and
  expects an MCP server. Now it boots the stdio MCP server directly. The `mcp`
  subcommand still works as an alias. Explicit CLI subcommands (`test`,
  `badge`, `benchmark`, `diff`, `init`, `unpublish`, `help`, `--help`,
  `--version`) are unchanged.
  - Behavior change: if you had a script running bare `mcp-compliance`
    expecting the help screen, switch to `mcp-compliance help` or
    `mcp-compliance --help`.

## [0.13.3] — 2026-04-16

- **Cross-platform stdio fix:** when a stdio target arrives as a single
  whitespace-containing string (e.g. `mcp-compliance test "node dist/index.js
  serve"`), auto-split it into command + argv. Previously worked on Windows
  (spawn goes through `cmd.exe` which word-splits) but failed on Linux/macOS
  with `ENOENT` because `shell: false` looks up the entire string as a literal
  executable name. This is what caused the `compliance-badge.yml` workflow to
  grade servers as `F` in CI. Reject quoted one-string forms rather than
  silently mis-parsing shell quoting. New `splitStdioTarget()` helper exported
  from `./stdio-split.js` and covered by unit tests.

## [0.13.0] — 2026-04-13

Catalog + spec sync to the shipped 88-test implementation, plus ops
scaffolding for the repo.

- **Spec `v1.1.0`** (`COMPLIANCE_RUBRIC.md` + `mcp-compliance-rules.json`):
  synced the published catalog to the shipped **88-test** implementation
  (was 81 in the catalog, already 88 in `TEST_DEFINITIONS`); added stdio
  transport coverage and 2025-11-25 capability coverage to the spec prose.
  Renamed `mcpSpecVersion` → `mcpSpecCompatibility` to align with
  `ctxlint`'s catalog and with both specs' prose headers. Value unchanged
  (`2025-11-25`). Consumers reading the old key should move to the new one.
- `COMPLIANCE_RUBRIC.md` now has a "Related specifications" section
  cross-referencing `mcp-config-lint` (ctxlint). Runtime-vs-static split is
  documented so consumers know which spec covers which problem.
- **Ops scaffolding:** introduced this `CHANGELOG.md`, `.github/dependabot.yml`
  (weekly grouped npm / github-actions / docker updates),
  `.github/workflows/nightly.yml` (daily sweep against reference servers,
  uploads artifacts, auto-files a deduplicated issue on regression), and
  `.github/ISSUE_TEMPLATE/*` + `.github/PULL_REQUEST_TEMPLATE.md`.
- **Count reconciliation:** fixed stale 81/84/85 references in README, docs,
  content, and three user-facing `src/` strings (MCP tool description, jsdoc,
  integration test name) so all copy agrees with the shipped 88.
- Ignored `.claude/` (local Claude Code settings, per-user state).
- No runtime behavior changes vs 0.12.2. The test runner, grading, and
  report schema are byte-identical.

## [0.12.2] — 2026-04-13

- Expose `schemas/*.json` via the package exports map so library consumers
  can resolve the report JSON schema without reaching into `node_modules`.
- Docker workflow triggers on Release workflow completion instead of tag
  push, avoiding a race with npm publish.
- Add `.gitattributes` to force LF line endings (fixes Windows CI).

## [0.12.1] — 2026-04-13

- `AbortSignal` support in `RunOptions` so callers can cancel a running
  suite.
- Lazy badge HTML generation to keep the default import surface small.

## [0.12.0] — 2026-04-13

- Parallel execution infrastructure for runs across many servers.
- Reference-server sweep data committed under `data/` for the blog post and
  leaderboard seed.

## [0.11.0] — 2026-04-13

- New capability tests for sampling, roots, and elicitation.
- Phase 2 producer affordances: export `urlHash`, add the integration spec
  document.
- Docs: spec version migration policy and external API reference.
- Phase 1 polish: schema discipline doc, deterministic warnings, fill in
  missing test metadata.

## [0.10.1] — 2026-04-13

- Add `lifecycle-meta-tolerance` test (84 → 85 tests).

## [0.10.0] — 2026-04-12

- Ship as a GitHub Action (`action.yml`).
- Additional report formats: HTML, diff, benchmark.
- Watch mode for iterative development.
- Docker image.
- Broad hardening pass on transport and timeouts.

## [0.9.2] — 2026-04-13

- Gate four more HTTP-auth tests for stdio transport (they do not apply).
- Tighten injection heuristics to reduce false positives.
- CI: cross-platform matrix (Windows + macOS), skip docs-only changes.

## [0.9.1] — 2026-04-13

- stdio gating fixes, transport hardening, UX polish.

## [0.9.0] — 2026-04-13

- **stdio transport support** — test any MCP server, not just HTTP.
- CI-friendly formats; new `--list`, `--min-grade`, and `init` flags.
- Drop the stdio preflight (redundant once the transport is live).
- Publish badges to mcp.hosting by default with `--no-publish` escape.
- Add `SECURITY.md` with vulnerability disclosure policy.
- Add `CONTRIBUTING.md` with contributor and AI-agent guidelines.
- Drop Node 18 from CI matrix (EOL, incompatible with undici/vitest).
- `--provenance` on `npm publish` for supply-chain security.

## [0.8.1] — 2026-04-11

- Configurable preflight timeout.
- Bump warnings cap to 50 entries to prevent report bloat.
- Type fixes; add timeout tests.

## [0.8.0] — 2026-04-10

- **81 tests** (up from 78).
- New spec coverage: `lifecycle-list-changed`, `lifecycle-progress-token`,
  `security-www-authenticate` (RFC 9110 `WWW-Authenticate` header on 401).
- Fix all dev dependency vulnerabilities (vite, hono, @hono/node-server).
- Bump GitHub Actions to v5 for Node.js 24 compatibility.

## [0.7.0] — 2026-04-10

- **78 tests** (up from 69). Bug fixes, spec compliance improvements, new
  coverage.
- Fix `parseSSEResponse()` returning the last JSON-RPC response instead of
  the first (prevents result loss in multi-event SSE streams).
- Remove unsafe `as string` casts on content-type headers.
- `--format` validates via Commander `.choices()` so typos error instead of
  silent fallback.
- Add range validation to MCP tool `timeout`/`retries`.
- OAuth metadata test now checks `/.well-known/oauth-protected-resource`
  per 2025-11-25, with a legacy fallback plus warning.
- `transport-notification-202` now fails on non-202 2xx responses.
- Rename `lifecycle-progress` and clarify it tests server resilience, not
  the spec-defined server→client progress flow.
- New transport tests: `transport-session-invalid` (404 for unknown
  session), `transport-content-type-reject`, `transport-sse-event-field`.
- New lifecycle tests: `lifecycle-string-id`, `lifecycle-version-negotiate`,
  `lifecycle-reinit-reject`.
- New error-path tests: `error-capability-gated`, `error-invalid-cursor`.
- New security test: `security-origin-validation` (DNS rebinding).
- Add `./mcp/server` export to `package.json` for library consumers.

## [0.6.0] — 2026-04-09

- Add **21 security tests** (48 → 69 total): auth, injection, and integrity
  checks.

## [0.5.0] — 2026-04-08

- Maintenance release. See the Git history for the full diff from 0.4.0.

## [0.4.0] — 2026-04-08

- Compliance spec documentation.
- SARIF output.
- Fix recommendations in the report.
- **96 tests.** (Subsequent releases consolidated duplicates down to 81.)
- Release automation (`release.sh`).

## [0.3.0] — 2026-04-07

- Tool annotations.
- MCP options passthrough to the inner client.
- Biome linter replaces ESLint.
- Initial CI pipeline.
- README overhaul.

## [0.2.1] — 2026-04-06

- Extract shared MCP tool registration, remove duplication between CLI and
  MCP server entry points.

## [0.2.0] — 2026-04-06

- 43 tests.
- Bump to MCP SDK 1.29.
- New CLI options.
- Bug fixes.

## [0.1.2] — 2026-04-06

- SSE parsing.
- Session and protocol-version header handling.
- Auth support.
- Test deduplication.

## [0.1.1] — 2026-04-06

- Initial release: MCP compliance tester CLI and MCP server.

[0.14.1]: https://github.com/YawLabs/mcp-compliance/releases/tag/v0.14.1
[0.14.0]: https://github.com/YawLabs/mcp-compliance/releases/tag/v0.14.0
[0.13.0]: https://github.com/YawLabs/mcp-compliance/releases/tag/v0.13.0
[0.12.2]: https://github.com/YawLabs/mcp-compliance/releases/tag/v0.12.2
[0.12.1]: https://github.com/YawLabs/mcp-compliance/releases/tag/v0.12.1
[0.12.0]: https://github.com/YawLabs/mcp-compliance/releases/tag/v0.12.0
[0.11.0]: https://github.com/YawLabs/mcp-compliance/releases/tag/v0.11.0
[0.10.1]: https://github.com/YawLabs/mcp-compliance/releases/tag/v0.10.1
[0.10.0]: https://github.com/YawLabs/mcp-compliance/releases/tag/v0.10.0
[0.9.2]: https://github.com/YawLabs/mcp-compliance/releases/tag/v0.9.2
[0.9.1]: https://github.com/YawLabs/mcp-compliance/releases/tag/v0.9.1
[0.9.0]: https://github.com/YawLabs/mcp-compliance/releases/tag/v0.9.0
[0.8.1]: https://github.com/YawLabs/mcp-compliance/releases/tag/v0.8.1
[0.8.0]: https://github.com/YawLabs/mcp-compliance/releases/tag/v0.8.0
[0.7.0]: https://github.com/YawLabs/mcp-compliance/releases/tag/v0.7.0
[0.6.0]: https://github.com/YawLabs/mcp-compliance/releases/tag/v0.6.0
[0.5.0]: https://github.com/YawLabs/mcp-compliance/releases/tag/v0.5.0
[0.4.0]: https://github.com/YawLabs/mcp-compliance/releases/tag/v0.4.0
[0.3.0]: https://github.com/YawLabs/mcp-compliance/releases/tag/v0.3.0
[0.2.1]: https://github.com/YawLabs/mcp-compliance/releases/tag/v0.2.1
[0.2.0]: https://github.com/YawLabs/mcp-compliance/releases/tag/v0.2.0
[0.1.2]: https://github.com/YawLabs/mcp-compliance/releases/tag/v0.1.2
[0.1.1]: https://github.com/YawLabs/mcp-compliance/releases/tag/v0.1.1
