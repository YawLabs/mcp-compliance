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
  full validation against the vendored 2026-07-28 JSON schema. Ids shared with the
  2025-11-25 catalog are semantically identical checks; changed checks have new
  ids (`lifecycle-discover`, `transport-get-removed`, `resources-not-found`, ...).
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
  rejected as an unknown key by mcp-compliance < 0.18. Pin the tool version where
  such a config is consumed.
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
  skip-passes only when the capability is undeclared or the list call itself
  failed, and its details say which.
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
  matches 169.254.x and internal hostnames (`*.internal`, `*.local`, `*.corp`,
  `*.lan`, `*.intranet`), and `security-error-no-stacktrace` matches Windows
  paths in their JSON-escaped form (`C:\\Users\\svc\\app`), which every scanned
  sample is. Strictly wider detection; the 2025-11-25 catalog text is unchanged.
- **Injection tests probe one target (2026-07-28).** The four injection tests
  send their payloads to a single (tool, argument): the first tool with a string
  argument, `readOnlyHint` tools preferred, `destructiveHint` tools skipped while
  an alternative exists, other required arguments filled with schema-typed
  placeholders so the payload reaches the handler, and `x-mcp-header` arguments
  mirrored. The details count rejected / benign / never-reached payloads and
  claim "server defended" only when every payload was rejected.
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
    on well-formed requests; the status now decides, not the code.
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
    `WWW-Authenticate` challenge and probed root before path; it now follows the
    spec's order (challenge URL, path, root) and warns when `resource` is not the
    endpoint.
  - `security-rate-limiting` bursted `server/discover` while citing the
    tools/call MUST; it now bursts a read-only no-argument tool and passes with a
    warning when only discovery could be bursted.
  - `security-auth-required` asserted "server accepted unauthenticated requests"
    without probing when `--auth` was absent, contradicting the 401 in the same
    report; it, `security-www-authenticate` and `security-oauth-metadata` now
    probe with or without `--auth`.
  - `security-oversized-input` mirrored the 1 MB value into an `Mcp-Param-*`
    header when the first string argument was `x-mcp-header`, measuring the
    header limit instead of the body; `security-extra-params` reported a plain
    timeout as "server may have crashed"; the leak scan double-counted every
    probe response. All three corrected.
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
