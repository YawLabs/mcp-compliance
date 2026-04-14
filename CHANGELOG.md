# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Pre-1.0 releases follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
loosely — breaking changes can still land in a minor bump, but we'll call them
out explicitly here.

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
