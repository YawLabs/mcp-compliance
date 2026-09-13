# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Pre-1.0 releases follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
loosely — breaking changes can still land in a minor bump, but we'll call them
out explicitly here.

## [Unreleased]

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
