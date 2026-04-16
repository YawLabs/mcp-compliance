# mcp-compliance

MCP server compliance testing tool. Tests any Streamable HTTP or stdio MCP server against the MCP specification (2025-11-25) with 88 tests across 8 categories (16 transport, 21 lifecycle, 4 tools, 5 resources, 3 prompts, 10 errors, 6 schema, 23 security).

## Architecture

- `src/index.ts` — CLI entry point (Commander.js). Subcommands: `test`, `badge`, `mcp`.
- `src/runner.ts` — Core test engine. Runs all 88 tests (transport-gated: HTTP tests skipped against stdio servers and vice-versa). Default is sequential; tests flagged `parallelSafe: true` in `TEST_DEFINITIONS` can run concurrently when `concurrency > 1` is passed to `runComplianceSuite()`. Exports `runComplianceSuite()`, `SPEC_VERSION`, `SPEC_BASE`, `TEST_DEFINITIONS`, `computeGrade()`, `computeScore()`, `generateBadge()`, `parseSSEResponse()`, `previewTests()`, and `urlHash()`. Includes preflight connectivity check.
- `src/types.ts` — TypeScript interfaces + `TEST_DEFINITIONS` array (all 88 test metadata).
- `src/grader.ts` — Scoring algorithm: required tests 70%, optional 30%. Grade thresholds: A>=90, B>=75, C>=60, D>=40, F<40.
- `src/reporter.ts` — Terminal (chalk), JSON, and SARIF formatters. SARIF includes server context in invocations.
- `src/badge.ts` — Badge URL generation via mcp.hosting.
- `src/mcp/server.ts` — MCP server entry point. Exports `createComplianceServer()` and `startServer()`.
- `src/mcp/tools.ts` — 3 MCP tools: test, badge, explain. All have annotations.

## Build

- **Bundler:** tsup with two entry configs (CLI with shebang, library with types).
- **Linter:** Biome (not ESLint).
- **Tests:** Vitest.
- **TypeScript:** Strict mode, ES2022 target, ESM.

## Key patterns

- Transport tests run pre-initialization using raw HTTP (undici).
- Lifecycle tests drive the MCP initialize handshake, then run post-init tests.
- Capability-gated tests (tools, resources, prompts) only run if the server declares the capability. Their `required` flag is dynamic.
- Security tests (23) run after all functional tests. Auth tests require `--auth`; input validation tests are gated on `tools` capability. All security tests are optional by default (severity: warning).
- Stdio transport tests (3) only run when testing a stdio server (spawned via command); HTTP transport tests (13) skip when the server is stdio. Rules with `transports: ["stdio"]` in the rule catalog are transport-gated.
- Request IDs use a counter starting at 1000 to avoid collision with hardcoded transport test IDs (99901-99904).
- SSE parsing handles multi-line `data:` fields per the SSE spec. Exported and unit-tested.
- Session state (MCP-Session-Id, protocol version) is tracked and injected into subsequent requests.
- Preflight connectivity check warns early if server is unreachable.
- Warnings array is deduplicated (exact-match) and capped at 50 entries after all tests drain. A sentinel `"... and N more warning(s) suppressed"` is appended when truncation occurs.
- `SPEC_VERSION` and `SPEC_BASE` are exported from runner.ts as the single source of truth.

## Release process

Run `./release.sh <version>` or trigger the Release GitHub Action with a version input. The script is idempotent — safe to re-run on failure.

## Commands

```bash
npm run build      # Compile with tsup
npm run dev        # Watch mode
npm test           # Run vitest
npm run lint       # Biome check
npm run lint:fix   # Biome auto-fix
npm run typecheck  # tsc --noEmit
npm run test:ci    # Build + test
```
