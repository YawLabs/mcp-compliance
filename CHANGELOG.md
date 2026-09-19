# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Pre-1.0 releases follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
loosely — breaking changes can still land in a minor bump, but we'll call them
out explicitly here.

## [Unreleased]

### Fixed
- **2026-07-28: the gaps 0.20.0 listed under "Not yet tightened" are closed.**
  The 2026-07-28 suite now asks whose answer a rejection is, as the
  2025-11-25 suite has since 0.20.0. These fixes leave the score math alone;
  verdicts on the checks below move.
  - `lifecycle-jsonrpc` and five error checks no longer credit a gateway's
    answer as the server's. Against a gateway that answers 401 with a JSON-RPC
    `-32001` "Unauthorized" body echoing the request id, `lifecycle-jsonrpc`
    passed on the gateway's envelope ("Valid JSON-RPC 2.0 response (id 1001
    echoed, error)"), and with `server/discover` let through,
    `error-unknown-method`, `error-invalid-jsonrpc`, `error-invalid-json`,
    `error-missing-params` (when tools are declared) and
    `error-capability-gated` passed on its `-32001`. They now fail as not
    evaluable on a 401, a 403 carrying a Bearer challenge, a 429 that is still
    a 429 after one resend, a 5xx without the check's own code (`-32601` for
    an unknown method and an undeclared capability, `-32600` for a malformed
    envelope, `-32700` for invalid JSON, `-32602` for a missing tool name), or
    a 403 without a Bearer challenge that a conformant `server/discover` sent
    next to the probe could not get past either (see the twin bullet below;
    the message is quoted when it names Host/Origin validation).
    `lifecycle-jsonrpc` has no conformant request left to compare with, so any
    403 on the setup `server/discover` is not evaluable there; its own codes
    are `-32600`, `-32601`, `-32602`, `-32020`, `-32021` and `-32022`. A 403
    without a Bearer challenge next to a served twin is still credited: a
    gateway that lets `server/discover` through and refuses everything else
    with a bare 403 cannot be told apart from the server refusing the probe.
  - A 5xx carrying the check's own code is credited, with a warning that a
    rejected request is a client error and a 4xx is expected.
    `error-invalid-jsonrpc` and `error-invalid-json` used to fail any 5xx; a
    `-32600` / `-32700` on a 5xx now passes. `error-unknown-method`'s `-32601`
    on a 5xx draws that warning, naming the 404 the spec requires, instead of
    the "spec requires 404" one; `error-missing-params`,
    `error-capability-gated` (one per method) and `lifecycle-jsonrpc` draw it
    too. A 5xx without the code now fails as not evaluable and says why, where
    it used to blame the probe ("HTTP 503 for a malformed envelope").
  - A rate limiter's 429 is resent once. `error-unknown-method` and
    `error-missing-params` no longer fail, and `error-invalid-jsonrpc` and
    `error-invalid-json` ("HTTP 429 without a JSON-RPC body (acceptable)") and
    `error-capability-gated` ("Undeclared method(s) rejected: ... (HTTP
    429)") no longer pass, on a 429 alone: the probe (and
    `lifecycle-jsonrpc`'s `server/discover`) is resent once after
    `Retry-After`, capped at 2 s, and the second answer decides.
  - A caller's abort during one of these probes is rethrown instead of graded
    as "No response to ...".
- **2026-07-28 `transport-batch-reject` (required) and
  `transport-content-type-reject` no longer pass on a gateway's answer.** They
  credited any 4xx, so a gateway's 401 with a `-32001` body passed both. They
  now read a rejection the way the 2025-11-25 checks do: a 429 is resent once,
  and a 401, a 403 carrying a Bearer challenge, a 429 again, a 5xx without
  the batch's own `-32600` (any 5xx for `text/plain`), or a 403 without a
  Bearer challenge the conformant `server/discover` could not get past either
  fails as not evaluable. A `-32600` on a 5xx is credited with a warning.
- **2026-07-28 `error-invalid-cursor` and `lifecycle-subscriptions-listen` no
  longer credit a gateway's `-32001`.** Both read a rejection through the same
  reader as the error checks, with one 429 resend and their own codes
  `-32602` and `-32601` credited on a 5xx with a warning (with a subscription
  capability advertised, no 5xx is credited). A `-32602` on a 5xx now passes
  `error-invalid-cursor` with a warning, where it failed for the status.
- **A 403 without a Bearer challenge is credited only next to a twin that
  reached the server (both suites).** The conformant request such a 403 is
  read against -- `server/discover` in 2026-07-28; the credentialed or
  pre-initialization `ping` in 2025-11-25 -- is resent once after
  `Retry-After` when it draws a 429, and credits the 403 only when it was
  served or drew a status the server itself chose: a 2xx, or a 4xx other than
  401, 403 or 429. In the 2025-11-25 suite any twin status other than 403
  used to credit it, so behind a WAF whose rate limiter, backend-less 503 or
  auth gate answered the twin, `transport-content-type-reject`,
  `transport-batch-reject`, `lifecycle-jsonrpc`, `error-unknown-method`,
  `error-invalid-jsonrpc`, `error-invalid-json`, `error-missing-params` and
  `error-capability-gated` passed on the WAF's refusal. They now fail as not
  evaluable, and the 2026-07-28 checks above read their twin the same way.
  The 2025-11-25 `security-auth-required`'s credentialed ping is resent once
  on a 429 too, so a twin throttled once and then served turns a
  not-evaluable bare 403 into a pass.
- **2026-07-28 `lifecycle-progress-token` fails a server that fails a request
  because of its progress token.** Any answer to the `tools/call` carrying
  `_meta.progressToken` used to pass as "no notifications/progress observed
  (optional)", a server that fails every request carrying a token included.
  The call failing on the server's side -- a JSON-RPC error, an HTTP status
  >= 400 other than a 429 or an auth gate's 401 / Bearer-challenge 403, a
  connection the server closed, or a stdio child that exits on it -- is now
  blamed on the token when the same call without it, sent right after, is
  served and the call carrying the token fails again when resent. A tool whose
  first call fails whatever it carries (a cold backend) passes on the resent
  call, whose progress notifications are judged like the first's, and a
  failure the call without the token shares stays an observation pass.
  - A 429 on any of its calls is resent once after `Retry-After`. A gate's
    answer (a 429 still a 429, a 401, a Bearer 403) on any call, a call
    without the token that gets no response, or a first or resent call
    nothing answers (a timeout, a connection never established, a stdio child
    already gone) measured nothing about the token, so it is a skip, left out
    of the score. Before, a call nothing answered failed ("no response"), a
    429 passed as "succeeded" and a 401's `-32001` as the server's own error.
  - On stdio a child that exits on one of its calls is restarted before the
    next, with a warning naming the call, so the checks after it
    (`lifecycle-meta-required` and the rest) measure a live process. A child
    an earlier check had already killed is left alone, with no warning
    blaming this check's call. A caller's abort is rethrown instead of graded.
- **2026-07-28 `stdio-unicode` restarts a stdio server that exits on its
  probe.** A server that crashed on the CJK/emoji `tools/call` or
  `server/discover` stayed dead, so every later check ran against the dead
  process and failed under its own name ("unknown method drew no response",
  "server unreachable", "Second tools/list call threw"). Like the security
  checks and the 2025-11-25 `stdio-unicode`, the check still fails as the
  crash, but it now replaces the process -- a new instance, a fresh
  `server/discover` and an era-pinning request -- on every attempt that kills
  it (`--retries` included), with a warning naming the check
  (`stdio-unicode: the server exited on ... and was restarted with a fresh
  server/discover, so the tests after it ran against the new instance.`).
  The checks after it measure the new instance, and `security-tool-rug-pull`
  compares two lists from it: on the official SDK v2 stdio server made to exit
  on non-ASCII input, `stdio-unicode` is now the run's only failure (grade A).
  When an earlier check had already killed the child, the check said its
  probe "got no reply (server exited (code N))"; it now fails as `server
  unreachable: ...`, as the security checks do, and does not restart it. Tool
  names in its details are made ASCII and clipped to 60 characters.
- **`stdio-unicode` (both suites) fails a child that answers the probe and
  exits right after it.** A plain request sent after each answered probe
  (`server/discover` in 2026-07-28, `ping` in 2025-11-25) finds the child
  gone; the check fails ("... was answered, but the server exited right
  after") and the child is restarted, so the checks after it measure a live
  server. Before, the check passed on the answer and every later check failed
  against the dead child. On the official SDK v2 stdio server made to exit
  right after answering, `stdio-unicode` is now the run's only failure (grade
  A).
- Conformant servers keep their results: the 2026-07-28 fixture (HTTP and
  stdio) and the official SDK v2 server (both HTTP serving modes and stdio)
  keep every verdict and detail of the checks above and draw no new warning.
- Not yet tightened: on 2026-07-28, `tools-call-unknown` still credits any
  JSON-RPC error, a gateway's `-32001` included, and
  `transport-notification-202`, `transport-get-removed` and
  `transport-delete-removed` still pass a gateway's 401 as a refusal with a
  warning.

## [0.20.0] — 2026-09-18

### Changed
- **A skipped check no longer counts in the score, so grades can move.** A
  check that measured nothing (`skipped: true`: no `--auth`, no tools
  declared, a check that does not apply on the transport, a refusal an
  earlier check could not attribute) used to score as a pass. It is now left
  out of both the numerator and the denominator: the 70% required / 30%
  optional weighting applies to the checks that measured something, and when
  every required or every optional check skipped, the other pool carries the
  whole score. A run in which every check skipped scores 0 (F), like a run in
  which none ran, and the terminal, markdown, HTML and GitHub `::notice`
  reports, the SARIF invocation properties (a `note` key) and the MCP
  `mcp_compliance_test` tool say so in words: "No test measured anything --
  all N that ran were skipped, and skips are left out of the score". The JSON
  report carries no prose; there `summary.skipped` equals `summary.total`.
  The skip caveats that said skips were "counted as passes in the score" now
  say they are "left out of the score".
  - How far a server moves depends on its failures and skips, not on whether
    it is "clean". On the reference servers no rounded score moved: the SDK
    v1 server's full 2025-11-25 run stays 96 (A) (95.7 unrounded, was 96.4),
    and the modern fixture's full 2026-07-28 run stays 99 (A) over HTTP and
    100 (A) over stdio. A run without skips does not move at all, nor does
    one without failures that measured anything. Otherwise the drop grows
    with the number of failures times the number of skips in a pool (in a
    pool of N checks with F failures and S skips, weight x F x S / (N x
    (N - S)) points, weight 70 or 30, while both pools have measured
    checks), so a server whose required checks all pass can still lose a
    grade: 15 of 50 optional checks failing and 20 skipped takes it from
    91 (A) to 85 (B).
  - A run where most checks measured nothing can drop several grades. With
    `--only security --auth` against an SDK v1 server behind the SDK's Host
    guard allowing only another hostname (every request draws a bare 403),
    2025-11-25 goes from 78 (B) to 29 (F), because 16 of its 18 passes
    measured nothing, and 2026-07-28 from 86 (B) to 40 (D), 16 of 18 as well.
  - Unchanged: `overall` ("fail" on a required failure or an empty run), so
    `--strict` exits as before, and a run in which every check skipped is
    `pass` with grade F; `summary.passed` / `failed` / `total` / `required` /
    `requiredPassed` / `skipped` and the per-category counts, where a skip
    still counts as passed (`passed + failed = total`); report schema v1,
    whose descriptions now say how the score treats skips. `--min-grade`
    gates, badges and dashboards keyed on grade or score see the move.
  - The terminal category bars (bar, colour and percentage) and the HTML
    category cards count what was measured, as the score does: with
    `--only security`, `Security 18/23` with 16 skips reads 29% under grade
    F 29%, not 78%. A category in which every check skipped reads `--` over
    an empty dim bar in the terminal and is grey, not green, in HTML. The
    `passed/total` ratio next to the bar still counts skips as passes.
  - `diff` scores both reports from their results as this version does,
    instead of copying each file's stored score onto the grade line. A
    report written by 0.19.0 or earlier scored skips as passes, so against
    such a baseline the grade line used to show a drop
    (`Grade B (78%) ↓ F (29%)`) above "No changes between baseline and
    current"; both sides now read the same, and a note under the grade line
    names the score the file recorded and why it differs. A baseline from before skip tracking
    (0.18.x) has its skips read from their wording, as for the per-check
    statuses. The diff JSON adds `recordedScores` (`{ baseline, current }`,
    each null when the file's score agrees with its results).
  - The methodology (`COMPLIANCE_RUBRIC.md`, and `specVersion` in
    `mcp-compliance-rules.json`) goes to 3.0.0: under its own versioning
    rules a scoring algorithm change is a major bump. 0.19.0 implements
    2.0.0; this release is the first to implement 3.0.0.
  - Grades can move, so this is a minor release rather than a patch.

### Fixed
- **The 2025-11-25 checks that 0.19.0 left untightened now read their answers
  honestly, most of them as the 2026-07-28 suite does.** These fixes leave
  the score math alone (the skip change is under Changed); verdicts on the
  checks below move.
  - `error-invalid-jsonrpc`, `error-invalid-json`, `error-missing-params` and
    `error-capability-gated` credited a gateway's JSON-RPC error body (a 401's
    `-32001` "Unauthorized") as the server's rejection, and `lifecycle-jsonrpc`
    passed the gateway's error envelope as the server's valid JSON-RPC: against
    a server that answers 401 to every request, a 2025-11-25 run passed all
    five. They now read an answer the way `transport-batch-reject`,
    `lifecycle-version-negotiate` and `error-unknown-method` have since 0.19.0:
    - A 401 or an auth-gate 403, or a 429, fails as not evaluable. The four
      error checks resend a 429 once after `Retry-After` first (capped at 2 s);
      `lifecycle-jsonrpc` reads the handshake's own answer.
    - Any other 403 counts only when the conformant twin was served or drew a
      different status; when the twin drew the same 403, or got no answer, the
      check fails as not evaluable, quoting the message when the twin drew the
      same 403 and the message names Host/Origin validation. The twin is a well-formed ping with the same headers (asked
      at most once for `error-capability-gated`'s three methods); for
      `lifecycle-jsonrpc` it is the same ping sent on its own as
      `application/json`. Each twin is sent only for such a 403.
    - A 5xx counts only when it carries the check's own JSON-RPC code:
      `-32600` for the malformed message, `-32700` for invalid JSON, `-32602`
      for `tools/call` without a name, `-32601` for an undeclared capability's
      method, and `-32600`/`-32601`/`-32602` for the `initialize` itself. That
      passes, with a warning that a rejected request should get a 4xx. Without
      it the error checks fail as the server failing on the request, and
      `lifecycle-jsonrpc` fails as not evaluable.
    - The four error checks also fail as not evaluable when the `initialize`
      handshake was not served and drew the same status (or no answer). In
      that case `error-capability-gated` withholds its verdict whatever the
      answers, as the 2026-07-28 rule does, because no capability declaration
      was seen; it still probes and lists each method's answer.
    - `error-invalid-jsonrpc` and `error-invalid-json` now honour the caller's
      abort instead of waiting out the request timeout.
  - `security-tool-rug-pull` over stdio compared the list cached from the first
    process with a fresh one after a restart, so a server whose tools change
    after use passed once an earlier check had crashed it, and a conformant
    server whose tool descriptions name the process failed as a rug-pull. Once
    the runner restarts a child after `tools-list` has read its list, it now
    reads the new process's `tools/list` before any `tools/call` reaches it,
    and the check compares that list with one read after a `tools/call` with no
    arguments, as the 2026-07-28 rule has since 0.19.0; the details name the
    check the restart followed. It skips, with a warning, when the new process
    leaves nothing to compare: its list before use was not read (the restart's
    warning now says why), or the `tools/call` killed it too, when the server
    is restarted again. A restart before `tools-list` ran
    (`lifecycle-version-negotiate`'s) is unchanged.
  - `security-cors-headers` passed "OPTIONS request failed (no CORS,
    acceptable)" on any transport error, a server nothing answered included.
    It now reads CORS the way the 2026-07-28 check does, on two probes carrying
    a foreign `Origin`: the OPTIONS preflight (capped at 5 s) and a `ping` sent
    as a POST with the handshake's headers and the run's timeout, since MCP does
    not require a server to handle OPTIONS. A wildcard or the reflected origin
    on either answer fails. Only when neither probe gets an HTTP answer is
    there nothing to inspect: connections the server closed on both pass as
    cross-origin requests refused next to the served `initialize` handshake,
    and anything else (a timeout, a refused connection) is `server
    unreachable`. A caller's abort is rethrown.
  - `stdio-unicode` never detected a mangled reply: it failed only when the
    tool call got no answer, and it skipped a server with no tool to call. It
    now judges the round trip as the 2026-07-28 check does. The tool is one
    named `echo`, else one with a `message`/`text`/`input`/`query` string
    argument, else the first (`tools/list` is read on demand). A byte-for-byte
    or piece-by-piece echo passes; U+FFFD, a Latin-1 mis-decode, `?`
    substitution, dropped CJK/emoji characters or a `-32700` fails. When the
    tool does not echo, or there is no tool, a `ping` whose `_meta` carries the
    probe decides: answered with a result, it passes as the envelope round-trip
    verified (the official SDK v1 and v2 stdio servers answer it). A child that
    exits on the probe fails in one line and is restarted, so
    `stdio-unknown-method-recovers` after it measures the server instead of
    the crash.
  - `security-oauth-metadata` fetched only the root well-known locations and
    ignored the challenge's `resource_metadata`. It now looks the document up
    as clients must, as the 2026-07-28 check does: the `resource_metadata` URL
    of the `WWW-Authenticate` challenge on the unauthenticated ping (the one
    `security-auth-required` sends, shared with it), and only that URL -- a
    relative, unreachable, non-200 or malformed one fails, naming any valid
    well-known document -- otherwise `/.well-known/oauth-protected-resource`
    followed by the endpoint path, then the root, then the legacy
    authorization-server document. A `resource` that is not the endpoint
    passes with a warning. The official SDK v1 deployment
    (`mcpAuthMetadataRouter` + `requireBearerAuth`), which serves the document
    at the path location, used to pass on its authorization-server document
    with a "migrate to PRM" warning. The not-evaluable skip for a guard's 403
    stays (it now requires every location to draw that 403), and so does the
    skip without `--auth`. An unauthenticated ping that gets no answer is
    `server unreachable`, except a connection closed next to the served
    credentialed handshake.
  - `lifecycle-progress-token` could never fail. It now judges the progress it
    receives as the 2026-07-28 check does: a `notifications/progress` under
    another token, without params, or with a progress value that is not a
    number or does not increase fails. It also fails when the call carrying
    the token draws a server error (a JSON-RPC error, or a status >= 400 other
    than a 429, a 401 or an auth-gate 403) that reproduces: the same call
    without the token, sent right after, is served, and the call carrying the
    token, resent after that, fails again. A tool whose first call fails
    whatever it carries (a cold backend) passes on the resend. The tool called
    is the first without required arguments, preferring one that mentions
    progress. A call nothing answers is still a skip, and a caller's abort is
    rethrown.
  - `lifecycle-reinit-reject` now reads the duplicate `initialize` as the other
    negative probes read theirs. A 5xx carrying the server's own `-32600`
    passes with a warning about the status, and a 403 whose message names
    Host/Origin validation counts as the server's rejection, since the
    handshake went out with the same Host and Origin and was served; before,
    both failed as not evaluable. Any other 5xx still fails, now as the server
    failing on the request; a 401, an auth-gate 403 and a repeated 429 are
    still not evaluable.
  - Not yet tightened: the 2025-11-25 `security-oauth-metadata` still skips
    without `--auth` (the 2026-07-28 check runs whenever the unauthenticated
    request drew a 401 or a Bearer 403). On 2026-07-28, `lifecycle-jsonrpc`
    passes a gateway's 401 error envelope as valid JSON-RPC; next to a served
    `server/discover`, `error-unknown-method`, `error-invalid-jsonrpc`,
    `error-invalid-json` and `error-capability-gated` credit a gate's `-32001`
    on a 401 as the server's rejection; `lifecycle-progress-token` does not
    fail a server error that only the progress token draws; and
    `stdio-unicode` does not restart a child that exits on the probe.

## [0.19.0] — 2026-09-18

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
- **Skipped checks are reported as skips.** A check that measured nothing (no
  `--auth`, no tools, not applicable on the transport, or a refusal an earlier
  check could not attribute) carries `skipped: true` next to `passed: true`;
  `summary.skipped` and a per-category `skipped` count them. The terminal
  report lists them under `SKIPPED CHECKS` (and says `No test failed -- N
  skipped` instead of "All tests passed"), markdown and HTML add a Skipped
  checks section (HTML also marks each one SKIP in its test table), the GitHub
  notice adds `N skipped`, and SARIF names them in the invocation properties
  (`testsSkipped`, `skippedTests`) rather than as results, so Code Scanning
  opens no alert for them. Each suite flags a pass that measured nothing, and
  a pass worded as a skip (`Skipped: ...`, `(skipped)`, `not applicable`) is
  read as one too; a failure is never flagged. Besides the worded skips, both
  suites flag empty tool, resource and prompt lists (`No tools to validate`),
  a tool result with no content (on 2025-11-25 only an empty content array;
  a malformed one passes there unflagged and `tools-call` fails it), no
  tool with a string argument to inject
  into, injection and `security-extra-params` runs that were inconclusive
  because nothing answered, `security-www-authenticate` with no 401 to read
  (a dropped connection included), and `error-capability-gated` when every
  capability is declared. On 2025-11-25 so are `lifecycle-progress-token`
  calls that got no answer, the `stdio-unicode` fallback
  that sent no unicode, and the error-leak scans over stdio, where their raw
  HTTP probes cannot reach the server. On 2026-07-28 so are the leak scans
  when no error response was received, `tools-list-deterministic-order` with
  fewer than two tools or a tool set that changed between calls, the post-hoc
  scans whose population was empty (`error-id-echo`, `error-retired-codes`,
  `schema-result-type`, `schema-no-input-required-on-lists`,
  `schema-input-required-shape`, `schema-wire-valid`; an empty recording
  still fails them), and `lifecycle-dual-era` when the probe drew no answer
  to read. A clean 2026-07-28 run therefore reports `error-capability-gated`
  and `schema-input-required-shape` as skips. Skips still count as passes
  in the score, so no grade moves; `schemas/report.v1.json` gains the three
  optional fields without a `schemaVersion` bump, so a consumer validating
  against a pre-0.19 copy of the schema (`additionalProperties: false`) must
  update it.

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
  The report `schemaVersion` is unchanged (`"1"`); the only schema change is
  the optional skip fields listed under Added.
- **Skips show up on every surface, not only in the report formats.**
  `--verbose` prints `SKIP` (not `PASS`) for a check that measured nothing.
  The MCP `mcp_compliance_test` tool adds `, N skipped` to its Tests line,
  follows it with a note that skipped tests count as passes in the score,
  and marks each skip `SKIP`. The markdown summary table notes each
  category's skips (`| Security | 3 (2 skipped) | 4 |`). A run without skips
  prints exactly as before on all three.
- **`diff` reports checks that start or stop skipping** under "Newly skipped"
  / "No longer skipped", in both terminal and JSON output. The diff JSON
  gains `newlySkipped`, `noLongerSkipped` and `recordsSkips` on the summary
  and `baselineStatus` / `currentStatus` on every entry; these fields are
  additive and always present, even when neither report has a skip, and
  every earlier field is unchanged. A failing check that starts skipping is
  no longer listed as a fix, and a new check that skips is no longer a new
  pass. Neither ever fails the diff; a skipped check that now fails is still
  a regression. A report written by an earlier version carries no skip data,
  so `diff` reads its skips from their wording (`(skipped)`, `Skipped: ...`,
  `not applicable`), the same markers the harness reads in the current run:
  a check that skipped then and still skips is not listed. Only a skip the
  older tool worded as a plain pass (such as "No tools to validate") can
  show up as newly skipped, and the output adds a note saying so. The
  terminal diff of two reports without skips prints exactly as before.
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
    a 401, or a 403 carrying a `WWW-Authenticate: Bearer` challenge, and no
    `Authorization` header was configured, the report's first warning (index 0,
    every format) says the server requires authentication, that the grade below
    is not meaningful, and to re-run with `--auth <token>`. The 2025-11-25
    `security-auth-required` now passes on a 401, or a 403 carrying that
    challenge, to the unauthenticated preflight (`HTTP 401 (unauthenticated
    preflight rejected; pass --auth ...)`) instead of claiming the server
    "accepted unauthenticated requests" next to `transport-post`'s 401. (A
    *bare* 403 there is read separately -- see the entry below.)
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
- **The report schema's `warnings` description said the list is capped at 100
  entries**; the cap is 50, plus one `... and N more warning(s) suppressed`
  entry, after exact duplicates are dropped.
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
    `server/discover` nor answers it with a 401/403 gate (a 429 is retried once
    after Retry-After, capped at 2 s, and counts only when the retry is served
    or refused with 401/403; a 413 or 415 on that small discover does not
    count), now fails naming the payload, with details that lead with
    `server may have crashed:` so the conclusion survives the 220-character
    limit; a drop the server outlives (a WAF or IPS, a keep-alive close, or a
    crash of one worker of a multi-process server such as a Node cluster, PM2
    or gunicorn, which a client cannot tell apart) counts as never reached, with
    a warning. The warning calls the follow-up's answer an auth gate only for a
    401, or a 403 carrying a `WWW-Authenticate: Bearer` challenge (with
    `--auth`, one with an `error` parameter), read as the era probe reads it;
    any other 403 is worded as a gate such as a WAF or IPS now blocking the
    client.
  - `security-extra-params` failed as "server may have crashed" when its
    `__proto__` payload's connection was dropped, even when the server kept
    serving (a WAF or IPS drops that prototype-pollution signature),
    contradicting the injection checks in the same report. A drop now reads the
    same way there: one the server outlives passes as inconclusive with a
    warning, and a connection refused before anything was sent is
    `server unreachable` instead of "connection dropped".
  - `security-oversized-input` passed every HTTP transport error as "Connection
    rejected (acceptable for oversized input)", including a server that crashed
    on the 1 MB body, one already unreachable, and one that answered the call
    with bytes that are not an HTTP response. A dropped connection now passes
    only when the server is still up afterwards (the same follow-up
    `server/discover`); otherwise it fails as a possible crash, a refused
    connection is `server unreachable`, and an unparseable answer fails as `no
    usable response to a 1 MB <tool>.<argument>`, as `security-extra-params`
    already reads it.
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
  - `error-id-echo` judged a server that answered a request twice -- its
    result, then an id-less error -- by frame order and earlier traffic: it
    exempted the stray as a reply to any client notification sent earlier in
    the run or as `received while no request was pending`, or blamed a
    `subscriptions/listen` stream the client had already closed. Every id-less
    reply is now attributed by one walk back that skips requests already
    answered, exchanges the client ended (a finished HTTP response, a closed
    stream, a cancelled request) and notifications a later answer rules out, so
    a notification owns a stray only while no later request was answered before
    it. A stray no send can still own is a second answer and fails, blamed on
    the most recent request; only a stray written before the suite sent any
    request is still exempt.
  - `lifecycle-meta-client-info-optional` blamed clientInfo for a blanket
    rejection or a rate limiter's 429; that is now reported as not evaluable.
  - Cancelling a run during `lifecycle-subscriptions-listen` recorded "No
    acknowledgment within Nms" instead of stopping.
- **A 401/403 on the era probe or preflight got the wrong auth advice.** The
  report's first warning (auto and pinned runs), the auto-detection note and
  `transport-post` now read the refusal from its status and `WWW-Authenticate`
  challenge. Without an Authorization header, only a 401 or a 403 carrying a
  Bearer challenge says authentication is required ("pass --auth"). With one,
  a 401 or a 403 whose Bearer challenge carries any `error` parameter says the
  credential was rejected ("credential rejected -- check --auth"), and the
  warning names the reason from that error (`invalid_token`,
  `insufficient_scope`, `invalid_request`). Any other 403 (the SDK's Host
  validation behind a tunnel hostname, Origin validation, a gateway) gets a
  neutral warning that quotes the body's JSON-RPC error message, points at
  Host/Origin validation or a gateway first, and without a header suggests
  `--auth` only if the server does require a credential; the note and
  `transport-post` say "forbidden -- Host/Origin validation, a gateway, or
  missing credentials" (or "... or token permissions" with a header). After a
  preflight timeout the warning names the status of the re-probe that answered.
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
    its own stderr. Only an overflow during that call counts now, and only
    while the child is still running: a child that wrote more than 1 MiB and
    then exited passed as "server survived" and now fails as died. It and
    `security-extra-params` no longer fail as "server died" when an earlier test
    had already killed the child; that is now `server unreachable`.
  - The reply to a raw-body probe (invalid JSON, invalid JSON-RPC, a batch)
    sent as SSE with its JSON split across several `data:` lines was dropped
    from the recording, so `error-retired-codes` could miss a retired code in
    it. It is now recorded, and `error-id-echo`, `schema-wire-valid` and the
    security error-sample scans see it too.
  - `stdio-unicode` reported a crash or hang on the CJK/emoji probe as a harness
    `Error:` carrying the server's multi-line stderr tail; it now fails with a
    one-line reason (`server exited (code N)`, or the timeout). `error-id-echo`
    notes a stray error reply that arrives before the suite sent any request as
    `received while no request was pending` instead of counting it as a reply
    to a raw probe or client notification.
  - A JSON-RPC error whose `code` was not an integer, or was missing, was
    reported as `JSON-RPC error NaN`. Details now name what the server sent:
    `JSON-RPC error with non-integer code "E_LIST"`, `JSON-RPC error with no
    code`, `rejected with no code`.
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
- **stdio `close()` killed servers before they could shut down on stdin EOF.**
  On POSIX it sent SIGTERM in the same tick it closed stdin, so a server that
  exits cleanly on EOF was killed before its cleanup ran. On Windows every close
  started a non-forced `taskkill /t` that cannot end a console process and could
  still be running after `close()` returned. `close()` now follows the spec's
  stdio shutdown order: close stdin, wait up to 2 s for the server to exit, then
  terminate it (POSIX: SIGTERM, then SIGKILL after 2 s more; Windows: a forced
  `taskkill /t /f` only). A server that exits on EOF is never signalled and
  `close()` returns as soon as it exits. Concurrent `close()` calls share one
  shutdown. A server that ignores EOF now takes about 2 s longer to close on
  POSIX (about 4 s in all if it also ignores SIGTERM).
- **A stdio server that stopped reading its input crashed the CLI.** A write to
  a child that had exited partway through reading a long request line (or had
  closed its stdin) raised an unhandled `write EOF` (Windows) or `write EPIPE`
  (POSIX) error on the child's stdin, and the run ended with a Node stack trace
  and no report. The failed write now fails only the request that made it: a
  request the exit interrupts gets the server's exit diagnostic (`server crashed
  with exit code N before completing the request`, with its stderr), a write
  with nothing pending waits up to 1 s for that exit and fails with the same
  diagnostic (or `stdin is closed: the server stopped reading its input` when
  the child keeps running), and a write after `close()` has ended stdin fails
  at once. A server that exits on the 1 MB line of `security-oversized-input`
  (2026-07-28) now fails it as `server died on a 1 MB <tool>.<argument>` on both
  platforms, and a raw pipe-write failure reads as the server going away on
  Windows (`EOF`) as it already did on POSIX (`EPIPE`).
- **The 2025-11-25 security checks now read a refusal the way the 2026-07-28
  ones do, and both eras read a bare 403 as what it is:**
  - `security-auth-required` (2025-11-25) passed any 401/403 on the
    unauthenticated request, including the bare 403 the SDK's Host validation
    sends a tunnel hostname, and passed a timeout or dropped connection as
    "Connection rejected (acceptable)". A bare 403 (no `WWW-Authenticate:
    Bearer` challenge) now passes only with `--auth` when the same ping carrying
    the credential is served, noting the spec expects 401; otherwise it fails as
    not evaluable, naming Host/Origin validation or a gateway (and `--auth` as
    the way to compare when no credential was configured). A
    timeout or refused connection fails as `server unreachable`, and a dropped
    connection passes only with `--auth` when the credentialed ping is served.
    Without `--auth`, a preflight that got no HTTP answer is no longer read as
    "server accepted unauthenticated requests": a ping is sent after the
    handshake and read the same way. With or without `--auth`, an answer that
    is neither a 401/403 nor a served request -- a 429 or another 4xx, a 5xx, a
    3xx, a 2xx without a JSON-RPC result -- is worded for what it was instead of
    "server accepted unauthenticated request" (the verdict stays a failure), and
    so are the same answers to `security-auth-malformed` and
    `security-session-not-auth`. Only a served request reads as accepted.
  - `security-auth-required` (2025-11-25) without `--auth`: a gateway that
    refuses the era probe with a bare 403, or lets it through to a server that
    answers it `-32601`, but answers every other unauthenticated request with
    401 and a Bearer challenge now passes on that 401 instead of failing as not
    evaluable or as accepting unauthenticated requests. "Accepted" is read only
    from a served preflight or `initialize`.
  - `security-oversized-input` (2025-11-25) passed any HTTP status >= 400, a
    rate limiter's 429 and an auth gate's 401/403 included, passed any status
    below 400 without reading the body, and passed every transport error except
    a timeout as "Connection rejected (acceptable for oversized input)". That
    included every stdio target, where the raw POST to an empty URL never left
    the client. It now goes through the transport on HTTP and stdio and follows
    the 2026-07-28 rules. A 5xx, or a 2xx without a JSON-RPC result or error,
    fails. A JSON-RPC error passes as a rejection and a completed result as
    survived, with the 2026-07-28 body-limit warning. A dropped connection
    passes only when a follow-up ping is served or refused with 401/403 (one
    429 retried), and otherwise fails as a possible crash. A refused connection
    is `server unreachable`, and unparseable bytes are `no usable response`. On
    stdio, a child that exits on the 1 MB line fails as died, and an over-long
    reply passes with a warning. A caller's abort now cancels the 1 MB request
    instead of waiting out its timeout.
  - `security-oversized-input` (2025-11-25) sends the 1 MB `tools/call` over
    stdio now, and a server that exits on it used to leave every later check
    running against a dead child: the required `stdio-framing` failed as
    "framing likely broken", `security-extra-params` passed the crash as
    "Request rejected (acceptable)", and the run went from pass to fail. The
    runner now restarts the child and redoes the handshake (a warning naming
    the check says so), so the crash is counted once, on the check that caused
    it. The same restart follows a child that exits on an injection payload,
    on `security-extra-params`' unknown arguments, or on the second
    `initialize` `lifecycle-version-negotiate` sends with an unknown version
    (see below). A
    child is restarted only when it died on the check's own request, so a
    server that dies on every `tools/call` is respawned once per check
    attempt that sends one (`--retries` repeats the attempt, and restarts it
    again). `security-extra-params` reports a stdio child that was already
    gone as `server unreachable`.
  - `security-oversized-input` (both eras): a 429 on the 1 MB call is resent
    once after `Retry-After` (capped at 2 s) and a second 429 is not evaluable;
    a 401, or a 403 an auth gate answers, is not evaluable; on 2025-11-25 a bare
    403 counts only next to a served `initialize`. A follow-up ping answered by
    its own id with a JSON-RPC error at any status below 500 but 429 now counts
    as the server being alive (a 5xx echoing the id may be a gateway's, and
    still counts as gone), and a drop in a run where nothing was ever answered
    reports `server unreachable` rather than a crash.
  - `security-auth-required` (2026-07-28): a 403 without a `WWW-Authenticate`
    Bearer challenge on the credential-less `server/discover` no longer passes
    as an authentication rejection -- Origin validation, the SDK's Host
    validation and gateways answer the same bare 403. It passes only with
    `--auth` when the credentialed `server/discover` got past the gate --
    served, or answered at HTTP 2xx even with a JSON-RPC error such as
    `-32021`, which is the application answering (the details note the spec
    expects 401) -- and otherwise fails as not evaluable, quoting the server's
    message and naming the credentialed request's status and JSON-RPC code. The
    same "got past the gate" reading decides whether a dropped connection on a
    credential-less (or foreign-Origin) probe counts as a refusal.
  - `security-auth-required` (both eras): when the 403 quotes Host or Origin
    validation (the SDK's `Invalid Host: ...`), or the credentialed request drew
    the same 403, the details now say to allow the hostname you tested through
    instead of suggesting `--auth`, and the 2026-07-28 details keep the whole
    hostname inside the 220-character limit. The 2025-11-25 auth probes skip
    with `Skipped: no --auth provided` instead of "server does not require
    auth", and with `--auth` they skip as `Skipped: HTTP 403 without a Bearer
    challenge, not attributable to authentication (see
    security-auth-required)` -- the 2026-07-28 wording, so both eras say the
    same thing about the same server -- rather than crediting a bare 403
    that `security-auth-required` refused to credit, also when `--only` /
    `--skip` leaves `security-auth-required` out of the run, since they read
    the same two pings.
- **The auth, Origin, injection and extra-params probes read a refusal, and a
  missing answer, the same way in both suites.** Follow-ups to the entry above,
  which had left the sibling checks behind (the exceptions still outstanding
  are listed at the end):
  - The six 2025-11-25 probes that still answered a transport error with
    `Connection rejected (acceptable)` -- `security-www-authenticate`,
    `security-auth-malformed`, `security-session-not-auth`,
    `security-token-in-uri`, `security-origin-validation`, and the
    re-initialization check -- passed a timeout, a refused connection, an
    unparseable answer and even a cancelled run as a rejection. Each now fails
    as `server unreachable` unless the comparison it relies on was served (the
    same request carrying the credential, or without the offending Origin), and
    a caller's abort is rethrown instead of graded.
  - `--auth` was detected by looking for the literal header keys
    `Authorization` and `authorization`, so `-H "AUTHORIZATION: Bearer ..."`
    made the whole auth suite behave as if no credential had been given. Header
    names are now matched case-insensitively in both suites.
  - Without `--auth`, a 401 on the preflight passed even when `initialize` was
    then served with no credential at all. A server that answers an
    unauthenticated `initialize` has accepted an unauthenticated request,
    whatever the preflight said, so that now fails as not requiring auth -- the
    reading a bare 403 already got.
  - 2026-07-28 `security-www-authenticate` passed *any* 403 as "not
    applicable", including the bare 403 `security-auth-required` refuses to
    attribute to authentication. It now reads a Bearer-challenged 403 as the
    refusal it is and skips as not evaluable on a bare one, like its
    2025-11-25 counterpart; `security-auth-malformed` takes the same skip, and
    so does `security-token-in-uri` when its query-string probe draws a 401/403
    (a query-string token the server accepts still fails).
    `security-oauth-metadata` no longer treats a bare 403 as proof the server
    is auth-protected: without `--auth` it skips, and with `--auth` it still
    checks the well-known locations and skips as not evaluable only when every
    one of them, and `/.well-known/oauth-authorization-server`, drew the
    endpoint's bare 403 (a Host guard or gateway refusing every path) instead
    of failing "No Protected Resource Metadata". The skip reads `Skipped: HTTP
    403 without a Bearer challenge, not attributable to authentication (see
    security-auth-required)` in both eras, so it stands on its own in a
    filtered run.
  - 2025-11-25 `security-oauth-metadata` failed `PRM endpoint returned HTTP
    403 and no legacy OAuth metadata found` behind a Host guard or gateway
    whose unattributable bare 403 also answered both well-known metadata
    locations; it now skips (`Skipped: HTTP 403 without a Bearer challenge on
    the endpoint and on every well-known metadata location, not attributable
    to authentication (see security-auth-required)`). A document found, a
    404, a 401 or any other status decides as before.
  - 2025-11-25 `security-token-in-uri` skipped as not evaluable before
    sending its probe, so a query-string token accepted behind an
    unattributable bare 403 was never tested. It now sends the probe first:
    a 2xx fails whatever else the run found, and only a 401/403 on the probe
    takes the not-evaluable skip, as on 2026-07-28.
  - `security-auth-malformed` and `security-token-in-uri` (both eras) skip
    instead of passing when the configured credential itself drew 401 (on
    2026-07-28 on the setup `server/discover`, on 2025-11-25 on the
    credentialed ping): a server that refuses every credential cannot show
    that it validates tokens. An invalid credential or query-string token the
    server accepts still fails.
  - 2026-07-28 `security-auth-required` called every non-401/403 answer an
    accepted unauthenticated request. Only a 2xx is; a 4xx that is not 401/403
    refused the request without asking for a credential, a 5xx failed on it,
    and a 3xx redirected it. Each is worded for what it is.
  - 2025-11-25 `security-www-authenticate` reads the challenge on a 403 that
    carries a Bearer challenge (`WWW-Authenticate: ... (HTTP 403)`) instead of
    calling it "not applicable", as its catalog entry already said.
  - The 2025-11-25 injection checks (`security-command-injection`,
    `-sql-injection`, `-path-traversal`, `-ssrf-internal`) counted every
    transport error as the server rejecting a payload, so a stdio server that
    exited on `$(whoami)` passed as having rejected it, and every check after it
    measured a dead child (the required `stdio-framing` failed as "framing
    likely broken"). A child that exits on a payload now fails the check naming
    the payload and is restarted with a fresh handshake, with a warning naming
    the check. On HTTP a connection closed on a payload is followed by a ping: a
    server gone after it fails as a possible crash, and one still up counts the
    payload as unanswered, with a warning. A timeout is unanswered, a server
    gone before a payload is `server unreachable`, a run with no answered
    payload passes as inconclusive with a warning, and a caller's abort is
    rethrown instead of recorded as a pass.
  - 2025-11-25 `security-extra-params` passed every HTTP transport error as
    "Request rejected (acceptable)" and an HTTP 500 from the `__proto__`
    payload as "extra params likely ignored". It now reads an answer, and a
    missing one, the way the 2026-07-28 check does: a 5xx, or an answer with
    neither result nor error, fails; a stdio child that exits on the unknown
    arguments fails as `server died` (not `server unreachable`) and is
    restarted; a dropped HTTP connection fails as a possible crash unless a
    follow-up ping is answered, when it passes as inconclusive with a warning,
    as a timeout does; a refused connection is `server unreachable`.
  - 2026-07-28 suite over stdio: a check whose own request kills the server
    -- an injection payload, `security-oversized-input`'s 1 MB argument,
    `security-extra-params`' unknown arguments -- still fails as `server
    died`, and the process is then restarted (a fresh `server/discover` plus
    one request that pins its era), with a warning naming the check. Before,
    every later check measured the dead process (`security-extra-params`
    `server unreachable`, `security-tool-rug-pull` "Second tools/list call
    threw"). The process is restarted every time a check's own request kills
    it, `--retries` included, so a retry never leaves the checks after it
    running against a dead process; a child already gone before the check's
    own request is not restarted. This matches the 2025-11-25 suite's
    restart.
  - 2026-07-28 suite over stdio: after a restart, `security-tool-rug-pull`
    compares two lists from the new process -- the one read at the restart,
    before any `tools/call`, and one read after a `tools/call` -- instead of
    the dead process's list against the new one's. Otherwise a server whose
    tools change after use would pass once an earlier check had crashed it,
    and a conformant server whose tool descriptions name the process would
    fail as a rug-pull. It skips, with a warning, when the new process leaves
    nothing to compare (its list before use was not read, or the `tools/call`
    between the lists killed it -- the server is then restarted again). The
    2025-11-25 `security-tool-rug-pull` still compares the list cached from
    the first process with a fresh one after a restart.
  - 2025-11-25 `security-error-no-stacktrace` and
    `security-error-no-internal-ip` passed on nothing over stdio, where their
    raw HTTP probes never reached the server (`0 error responses checked`,
    `No response to check (connection error)`); they are now skipped there.
    Over HTTP a probe nothing answers fails as `server unreachable` instead of
    passing on an empty scan, and a caller's abort is rethrown.
  - 2025-11-25 `stdio-unicode` failed a stdio server that declares no tools
    (`tools/list returned error`, the `-32601` it gives a list it never
    offered); it now skips, since no tool call can carry the probe.
  - `security-origin-validation` (both eras) credited any status >= 400. A 5xx
    now fails as the server failing on the request, a 429 is resent once after
    `Retry-After` and a second one is not evaluable, and a 401/403 that the same
    request without the Origin drew too (`initialize` on 2025-11-25, the setup
    `server/discover` on 2026-07-28), or that request got no answer, skips as
    not attributable to the Origin -- the SDK's Host guard and auth gates answer
    every request that way. Any other 4xx still passes.
  - `security-rate-limiting` (2025-11-25) no longer reports "No rate limiting
    detected" for a burst refused 401/403 on every ping (it fails as not
    evaluable, naming the auth gate, or `security-auth-required` for a 403 that
    is no auth refusal) or for one nothing answered (`server unreachable`). The
    2026-07-28 check words a burst of such 403s as Host/Origin validation or a
    gateway (see `security-auth-required`) rather than asking you to check the
    credential; it still skips.
  - 2025-11-25 `lifecycle-reinit-reject` credited any JSON-RPC error or status
    >= 400 on the duplicate `initialize`. It now fails as not evaluable when the
    first `initialize` was not served (the second is then no duplicate), and
    when a 401 or auth-gate 403, a 403 naming Host/Origin validation, a 429
    (resent once after `Retry-After`) or a 5xx answered in the server's place; a
    3xx fails as neither a rejection nor a served duplicate.
  - The 2025-11-25 `transport-content-type-reject`, `transport-batch-reject`,
    `lifecycle-version-negotiate` and `error-unknown-method` credited a
    gateway's refusal, its JSON-RPC error body included, as the server's
    rejection: a gateway answering 401 to every request earned all four. Each
    now fails as not evaluable when something in front of the server answered
    in its place: a 401 or auth-gate 403, or a 429 (resent once after
    `Retry-After`). A 5xx fails as no rejection unless it carries the server's
    own rejection of the defect (`-32600` on the batch, `-32600` or `-32602`
    on the unknown version, `-32601` on the unknown method), which passes with
    a warning that the status should be a 4xx; before, the last three passed a
    5xx carrying any JSON-RPC error, a `-32603` or a server-defined code
    included. Any other 403 counts only when the conformant twin was served or
    drew a different status, whatever its message says; when the twin drew the
    same 403 the check fails as not evaluable, quoting a message that names
    Host/Origin validation, and so it does when the twin got no answer. For
    the two transport checks, which run before the handshake, the twin is the
    same ping sent on its own as `application/json`; for
    `error-unknown-method` it is a ping with the same headers; each is sent
    only in that case. For `lifecycle-version-negotiate` it is the
    `initialize` handshake. `lifecycle-version-negotiate` and
    `error-unknown-method` also fail as not evaluable when the `initialize`
    handshake was not served and drew the same status (or no answer): a server
    that rejects everything proves nothing by rejecting the defect.
    `lifecycle-version-negotiate` no longer passes a request that got no
    answer as "Connection rejected for unknown version (acceptable)". A
    caller's abort is rethrown. A timeout, a refused connection or a stdio
    child already gone is `server unreachable`. A stdio child that exits on
    the probe fails as having died on a second `initialize` (over stdio the
    probe always is one, so the details do not blame the version) and is
    restarted. An HTTP connection closed without a response passes only next
    to the served handshake. Anything else fails as no usable response.
  - Not yet tightened: the 2025-11-25 `error-invalid-jsonrpc`,
    `error-invalid-json`, `error-missing-params` and `error-capability-gated`
    still credit a gateway's JSON-RPC error body (a 401's -32001
    "Unauthorized") as the server's error, and `lifecycle-jsonrpc` passes the
    gateway's error envelope as a valid JSON-RPC response. On 2025-11-25,
    `security-cors-headers` still passes any transport error on its OPTIONS
    request ("no CORS, acceptable"), `stdio-unicode` does not detect a mangled
    reply, and `security-tool-rug-pull` compares across processes after a
    stdio restart.

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
