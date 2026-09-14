# @yawlabs/mcp-compliance

[![npm version](https://img.shields.io/npm/v/@yawlabs/mcp-compliance)](https://www.npmjs.com/package/@yawlabs/mcp-compliance)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![GitHub stars](https://img.shields.io/github/stars/YawLabs/mcp-compliance)](https://github.com/YawLabs/mcp-compliance/stargazers)
[![Follow @TokenLimitNews on X](https://img.shields.io/badge/follow-%40TokenLimitNews-000000?logo=x&logoColor=white)](https://x.com/TokenLimitNews)

**Test any MCP server for spec compliance.** Two test suites — 88 tests for MCP [2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25) and 103 tests for MCP [2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28) — covering transport, lifecycle, tools, resources, prompts, error handling, schema validation, and security. The tool probes the server and grades the newest spec revision it speaks, or you pin one with `--spec-version`. Works against **HTTP endpoints** (`https://my-server.com/mcp`) and **stdio servers** (`npx @modelcontextprotocol/server-filesystem /tmp`) alike. CLI, MCP server, and programmatic API.

Built and maintained by [Yaw Labs](https://yaw.sh).

[![Add to Yaw MCP](https://yaw.sh/yaw-mcp-button.svg)](https://yaw.sh/mcp/install?name=mcp-compliance&command=npx&args=-y%2C%40yawlabs%2Fmcp-compliance&description=Test%20any%20MCP%20server%20against%20the%20spec%20%282025-11-25%20or%202026-07-28%29%20with%20letter-grade%20scoring&source=https%3A%2F%2Fgithub.com%2FYawLabs%2Fmcp-compliance)

One click adds this to your local Yaw MCP config so it's available in every Yaw Terminal session. Or install manually below.

## Why this tool?

MCP servers are multiplying fast — but most ship without compliance testing. Broken transport handling, missing error codes, malformed schemas, and silent capability violations are common. Hand-rolling test scripts is tedious and incomplete.

This tool solves that:

- **Two spec revisions, one tool** — 88 tests for MCP 2025-11-25 (the `initialize` + session era) and 103 tests for MCP 2026-07-28 (stateless, per-request `_meta`, `server/discover`, caching hints, MRTR). Both cover the same 8 categories: transport, lifecycle, tools, resources, prompts, error handling, schema validation, and security. HTTP-specific tests (CORS, TLS, header validation, rate limiting) are gated out on stdio: the 2025-11-25 suite runs 85 tests on HTTP and ~75 on stdio, the 2026-07-28 suite 99 and 75.
- **Auto-detected revision** — one `server/discover` probe tells the tool which era the server speaks; dual-era servers are graded against 2026-07-28 with a warning. Pin either revision with `--spec-version`. See [Spec version](#spec-version).
- **Capability-driven** — tests adapt to what the server declares. If it says it supports tools, tool tests become required. No false failures for features the server doesn't claim.
- **Graded scoring** — A-F letter grade with a weighted score (required tests 70%, optional 30%). One number to communicate compliance.
- **CI-ready** — `--strict` mode exits with code 1 on required test failures. Drop it into any pipeline.
- **Spec-referenced** — every test links to the exact section of the MCP specification it validates. No ambiguity about what's being tested or why.
- **Three interfaces** — CLI for humans, MCP server for AI assistants, programmatic API for integration.
- **Published methodology** — the [testing methodology](./COMPLIANCE_RUBRIC.md) and [rule catalog](./mcp-compliance-rules.json) are open (CC BY 4.0) so anyone can build compatible tooling or fork the rules.

## Quick start

**Remote HTTP server:**

```bash
npx @yawlabs/mcp-compliance@latest test https://my-server.com/mcp
```

**Local stdio server** (the vast majority of MCP servers on npm):

```bash
# Pass the command directly, Inspector-style
npx @yawlabs/mcp-compliance@latest test npx @modelcontextprotocol/server-filesystem /tmp

# Or a local build
npx @yawlabs/mcp-compliance@latest test node ./dist/server.js

# With env vars
npx @yawlabs/mcp-compliance@latest test -E GITHUB_TOKEN=$GITHUB_TOKEN -- npx @modelcontextprotocol/server-github
```

**Install globally:**

```bash
npm install -g @yawlabs/mcp-compliance
mcp-compliance test https://my-server.com/mcp
```

That's it. You'll get a colored terminal report with a letter grade (A-F), per-test pass/fail, and a compliance score.

## CLI usage

### HTTP targets

```bash
# Terminal output with colors and grade
mcp-compliance test https://my-server.com/mcp

# JSON / SARIF for scripting + GitHub Code Scanning
mcp-compliance test https://my-server.com/mcp --format json
mcp-compliance test https://my-server.com/mcp --format sarif > compliance.sarif

# Strict mode for CI — exits 1 on required-test failure
mcp-compliance test https://my-server.com/mcp --strict

# Auth (shorthand or full header)
mcp-compliance test https://my-server.com/mcp --auth "Bearer tok123"
mcp-compliance test https://my-server.com/mcp -H "X-Api-Key: abc"

# Focus the run
mcp-compliance test https://my-server.com/mcp --only transport,lifecycle
mcp-compliance test https://my-server.com/mcp --skip prompts,resources
mcp-compliance test https://my-server.com/mcp --verbose
```

### stdio targets

Pass the command and its args as positional arguments (MCP Inspector-style). Use `--` to disambiguate when the target needs flags that collide with ours.

```bash
# npm-distributed stdio servers
mcp-compliance test npx -y @modelcontextprotocol/server-filesystem /tmp
mcp-compliance test uvx mcp-server-git

# Local build
mcp-compliance test node ./dist/server.js

# With env vars (repeatable -E, or --env-file)
mcp-compliance test -E API_KEY=secret -E REGION=us-east-1 -- npx my-server
mcp-compliance test --env-file .env -- node ./server.js

# Set working directory
mcp-compliance test --cwd ./services/mcp -- node ./dist/server.js

# Target uses a flag that collides with ours — use `--` to separate
mcp-compliance test --verbose -- node ./server.js --verbose
```

On Windows, `npx` and other `.cmd` shims are handled automatically by spawning through the shell.

### Spec version

The tool ships one test catalog per MCP specification revision it supports — **2025-11-25** (88 tests: `initialize` handshake, sessions, `ping`) and **2026-07-28** (103 tests: stateless, per-request `_meta`, `server/discover`, caching hints, MRTR). A run grades exactly one revision, chosen by `--spec-version`:

```bash
# auto (default): probe the server, grade the newest revision it speaks
mcp-compliance test https://my-server.com/mcp

# pin a revision — no probe, the named catalog runs regardless of what the server answers
mcp-compliance test https://my-server.com/mcp --spec-version 2026-07-28
mcp-compliance test https://my-server.com/mcp --spec-version 2025-11-25

# --list never connects, so name the catalog you want to preview (defaults to 2025-11-25)
mcp-compliance test --list --spec-version 2026-07-28 --transport stdio
```

How `auto` decides, following the spec's own rules for dual-era clients: the tool sends one conformant 2026-07-28 `server/discover` (on HTTP it doubles as the preflight connectivity check, so detection costs no extra round-trip; on stdio it is the first exchange and shares `--startup-timeout`). A `DiscoverResult`, or a JSON-RPC error with a modern code (`-32020`, `-32021`, `-32022`), selects **2026-07-28**. Anything else — `-32601`, `-32000`, a 400 "not initialized", a 404, an HTML page, or no reply within the timeout — selects **2025-11-25**. The fallback is deliberately not keyed to a single error code; a legacy server that ignores unknown methods is still classified correctly, just after the timeout. An unreachable server is graded as 2025-11-25 so every test fails visibly.

A server that answers both eras (the default for servers built on the official SDK 2.0) is graded as **2026-07-28**, and the report carries a warning naming the other era and how to pin it. To grade its legacy side too, run again with `--spec-version 2025-11-25`. The report's `specVersion` is always the **resolved** revision, never `auto`.

Two things to know when you rely on `auto` in CI:

- **The grade can move without a config change.** The day your server upgrades to an SDK that speaks 2026-07-28, `auto` switches suites: different test ids, different required set, a new baseline. Pin `--spec-version` (or `"specVersion"` in the config file) if you want the suite to change only when you say so.
- **`diff` refuses to compare reports from different revisions** (ids are only comparable within one catalog) and tells you which `--spec-version` to pin. SARIF uploads are tracked per revision (`automationDetails.id` is `mcp-compliance/<specVersion>/`), so a switch opens a fresh set of alerts rather than closing the old ones silently.

`--only` / `--skip` values are matched against the catalog that was resolved; a value that matches nothing in it (say `lifecycle-init` on a 2026-07-28 run) is reported as a warning instead of silently producing an empty run.

### Options

| Option | Applies to | Description |
|--------|-----------|-------------|
| `--spec-version <v>` | both | MCP spec revision to grade: `auto` (probe the server, newest wins), `2025-11-25`, or `2026-07-28` (default: `auto`, or `specVersion` in config). See [Spec version](#spec-version) |
| `--format <format>` | both | Output format: `terminal`, `json`, `sarif`, `github`, `markdown`, or `html` (default: `terminal`) |
| `--config <path>` | both | Load defaults from a config file (default: `mcp-compliance.config.json` in cwd) |
| `--output <file>` | both | Write a local SVG badge to the given path after the run |
| `--list` | both | Print test IDs that would run given current filters, then exit (no connection; pair with `--spec-version` to pick the catalog, default `2025-11-25`) |
| `--transport <kind>` | both | Filter by `http` or `stdio` (only used with `--list` when no target is provided) |
| `--strict` | both | Exit with code 1 on any required test failure (for CI) |
| `--min-grade <grade>` | both | Exit with code 1 if grade is below this threshold (`A`–`F`) |
| `-H, --header <h>` | HTTP | Add header to all requests, format `"Key: Value"` (repeatable) |
| `--auth <token>` | HTTP | Shorthand for `-H "Authorization: <token>"` |
| `-E, --env <var>` | stdio | Set env var for stdio command, format `"KEY=VALUE"` (repeatable) |
| `--env-file <path>` | stdio | Load env vars from a file (one `KEY=VALUE` per line) |
| `--cwd <dir>` | stdio | Working directory for the stdio command |
| `--timeout <ms>` | both | Per-request timeout in milliseconds after the initial exchange (default: `15000`) |
| `--startup-timeout <ms>` | both | Deadline for the first exchange — the `initialize` handshake or the `server/discover` probe (default: `max(--timeout, 60000)`; covers cold `npx` cache fetches before a stdio server starts) |
| `--preflight-timeout <ms>` | HTTP | Preflight connectivity check timeout (HTTP only; the preflight request is also the spec-version probe) |
| `--retries <n>` | both | Number of retries for failed tests (default: `0`) |
| `--only <items>` | both | Only run tests matching these categories or test IDs (comma-separated) |
| `--skip <items>` | both | Skip tests matching these categories or test IDs (comma-separated) |
| `--concurrency <n>` | both | Max parallel-safe tests in flight (default: `1`; raising reduces wall time but can perturb timing-sensitive servers) |
| `--verbose` | both | Print each test result as it runs (also forwards stdio stderr) |

### CI integration

**GitHub Action** (drop into any `.github/workflows/*.yml`):

```yaml
- uses: YawLabs/mcp-compliance@v0
  with:
    target: 'node ./dist/server.js'   # or a URL like https://my-server.com/mcp
    format: github                     # ::error / ::warning annotations on the PR
    strict: 'true'                     # exit non-zero if any required test fails
    min-grade: 'A'                     # also exit if grade slips
    spec-version: auto                 # or pin 2025-11-25 / 2026-07-28; the resolved value is the `spec-version` output
```

**Manual CLI invocation:**

```bash
# GitHub Actions: emits ::error / ::warning annotations inline on the PR
mcp-compliance test https://my-server.com/mcp --format github --strict

# Slack/Linear/PR comment: drop the body straight into a comment
mcp-compliance test https://my-server.com/mcp --format markdown > report.md

# HTML report (self-contained, share anywhere — issue comments, S3, GitHub Pages)
mcp-compliance test https://my-server.com/mcp --format html > report.html

# Block release if grade slips below B
mcp-compliance test https://my-server.com/mcp --min-grade B

# Preview which tests will run before connecting (handy for --only/--skip authoring)
mcp-compliance test --list --transport stdio --skip security --spec-version 2026-07-28

# Diff two runs — exit 1 if anything that was passing is now failing.
# Both reports must grade the same spec revision; pin --spec-version on both runs
# so a server upgrade cannot flip the suite under the baseline.
mcp-compliance test https://my-server.com/mcp --format json --spec-version 2026-07-28 > current.json
mcp-compliance diff baseline.json current.json

# Watch mode for stdio dev loop — re-runs on file changes in cwd
mcp-compliance test --watch -- node ./dist/server.js

# Latency benchmark
mcp-compliance benchmark -- node ./dist/server.js -r 200 -c 4
```

**Docker:**

```bash
docker run --rm ghcr.io/yawlabs/mcp-compliance test https://my-server.com/mcp
```

### Scaffold a config

```bash
mcp-compliance init
```

Interactive prompts walk you through transport (http/stdio), command/url, env vars, timeout, and strict mode — then write a `mcp-compliance.config.json` you can commit.

### Config file

Check in a `mcp-compliance.config.json` so CI and your dev loop can run `mcp-compliance test` with no arguments. Supported locations (searched in order): `mcp-compliance.config.json`, `.mcp-compliancerc.json`, `.mcp-compliancerc`, and the `"mcp-compliance"` field of `package.json`. Pass `--config <path>` to load an explicit file.

**HTTP:**

```json
{
  "target": {
    "type": "http",
    "url": "https://my-server.com/mcp",
    "headers": { "Authorization": "Bearer tok123" }
  },
  "timeout": 20000,
  "specVersion": "2026-07-28",
  "strict": true
}
```

**stdio:**

```json
{
  "target": {
    "type": "stdio",
    "command": "node",
    "args": ["./dist/server.js"],
    "env": { "LOG_LEVEL": "error" }
  },
  "skip": ["security"],
  "strict": true
}
```

Precedence: CLI flags > config file > defaults. Any field can be overridden on the command line. `specVersion` accepts `auto`, `2025-11-25` or `2026-07-28` and is new in 0.18 — a config that sets it is rejected as an unknown key by older tool versions, so pin `@yawlabs/mcp-compliance@^0.18` wherever that config is consumed.

### Local SVG badge

Write a local SVG reflecting the real grade and commit it to your repo:

```bash
mcp-compliance test https://my-server.com/mcp --output badge.svg
mcp-compliance test node ./dist/server.js --output badge.svg
```

Then embed it in your README:

```markdown
![MCP Compliance](./badge.svg)
```

## What the 88 tests check (2025-11-25)

The 2025-11-25 catalog grades the `initialize` + session era. It is what `--spec-version auto` selects for every server that does not answer a modern `server/discover`.

<details>
<summary><strong>Transport (16 tests)</strong></summary>

HTTP-only (13):
- **transport-post** — Server accepts HTTP POST requests (required)
- **transport-content-type** — Responds with application/json or text/event-stream (required)
- **transport-notification-202** — Notifications return exactly 202 Accepted
- **transport-content-type-reject** — Rejects non-JSON request Content-Type
- **transport-session-id** — Enforces MCP-Session-Id after initialization
- **transport-session-invalid** — Returns 404 for unknown session ID
- **transport-get** — GET returns SSE stream or 405
- **transport-delete** — DELETE accepted or returns 405
- **transport-batch-reject** — Rejects JSON-RPC batch requests (required)
- **transport-content-type-init** — Initialize response has valid content type
- **transport-get-stream** — GET with session returns SSE or 405
- **transport-concurrent** — Handles concurrent requests
- **transport-sse-event-field** — SSE responses include required event: message field

stdio-only (3):
- **stdio-framing** — Newline-delimited JSON framing (required)
- **stdio-unicode** — UTF-8 unicode roundtrip preserves non-ASCII payloads
- **stdio-unknown-method-recovers** — Returns -32601 for unknown methods and keeps serving

</details>

<details>
<summary><strong>Lifecycle (21 tests)</strong></summary>

- **lifecycle-init** — Initialize handshake succeeds (required)
- **lifecycle-proto-version** — Returns valid YYYY-MM-DD protocol version (required)
- **lifecycle-server-info** — Includes serverInfo with name
- **lifecycle-capabilities** — Returns capabilities object (required)
- **lifecycle-jsonrpc** — Response is valid JSON-RPC 2.0 (required)
- **lifecycle-ping** — Responds to ping method (required)
- **lifecycle-instructions** — Instructions field is valid string if present
- **lifecycle-id-match** — Response ID matches request ID (required)
- **lifecycle-string-id** — Supports string request IDs (JSON-RPC 2.0)
- **lifecycle-version-negotiate** — Handles unknown protocol version gracefully
- **lifecycle-reinit-reject** — Rejects second initialize request
- **lifecycle-logging** — logging/setLevel accepted (required if logging capability declared)
- **lifecycle-completions** — completion/complete accepted (required if completions capability declared)
- **lifecycle-cancellation** — Handles cancellation notifications
- **lifecycle-progress** — Handles progress notifications gracefully
- **lifecycle-list-changed** — Accepts listChanged notifications for declared capabilities
- **lifecycle-progress-token** — Supports progress tokens in requests via SSE
- **lifecycle-sampling-capability** — Advisory check for server-side use of the client sampling capability
- **lifecycle-roots-capability** — Advisory check for server-side use of the client roots capability
- **lifecycle-elicitation-capability** — Advisory check for the 2025-11-25 client elicitation capability
- **lifecycle-meta-tolerance** — Server ignores unknown `_meta` fields on incoming requests

</details>

<details>
<summary><strong>Tools (4 tests)</strong></summary>

- **tools-list** — tools/list returns valid array (required if tools capability declared)
- **tools-call** — tools/call responds with correct format
- **tools-pagination** — tools/list supports cursor-based pagination
- **tools-content-types** — Tool content items have valid types

</details>

<details>
<summary><strong>Resources (5 tests)</strong></summary>

- **resources-list** — resources/list returns valid array (required if resources capability declared)
- **resources-read** — resources/read returns content items
- **resources-templates** — resources/templates/list works or returns method-not-found
- **resources-pagination** — resources/list supports cursor-based pagination
- **resources-subscribe** — Resource subscribe/unsubscribe (required if subscribe capability declared)

</details>

<details>
<summary><strong>Prompts (3 tests)</strong></summary>

- **prompts-list** — prompts/list returns valid array (required if prompts capability declared)
- **prompts-get** — prompts/get returns valid messages
- **prompts-pagination** — prompts/list supports cursor-based pagination

</details>

<details>
<summary><strong>Error Handling (10 tests)</strong></summary>

- **error-unknown-method** — Returns JSON-RPC error for unknown method (required)
- **error-method-code** — Uses correct -32601 error code
- **error-invalid-jsonrpc** — Handles malformed JSON-RPC (required)
- **error-invalid-json** — Handles invalid JSON body
- **error-missing-params** — Returns error for tools/call without name
- **error-parse-code** — Returns -32700 for invalid JSON
- **error-invalid-request-code** — Returns -32600 for invalid request
- **tools-call-unknown** — Returns error for nonexistent tool name
- **error-capability-gated** — Rejects methods for undeclared capabilities
- **error-invalid-cursor** — Handles invalid pagination cursor gracefully

</details>

<details>
<summary><strong>Schema Validation (6 tests)</strong></summary>

- **tools-schema** — All tools have valid name and inputSchema (required if tools capability declared)
- **tools-annotations** — Tool annotations are valid if present
- **tools-title-field** — Tools include title field (2025-11-25)
- **tools-output-schema** — Tools with outputSchema are valid (2025-11-25)
- **prompts-schema** — Prompts have valid name field (required if prompts capability declared)
- **resources-schema** — Resources have valid uri and name (required if resources capability declared)

</details>

<details>
<summary><strong>Security (23 tests)</strong></summary>

- **security-auth-required** — Rejects unauthenticated requests
- **security-www-authenticate** — 401 responses include WWW-Authenticate header
- **security-auth-malformed** — Rejects malformed auth credentials
- **security-tls-required** — Enforces HTTPS/TLS
- **security-session-entropy** — Session IDs are high-entropy
- **security-session-not-auth** — Session ID does not bypass auth
- **security-oauth-metadata** — Protected Resource Metadata endpoint exists (RFC 9728)
- **security-token-in-uri** — Rejects auth tokens in query string
- **security-cors-headers** — CORS headers are restrictive
- **security-origin-validation** — Validates Origin header for DNS rebinding protection
- **security-command-injection** — Resists command injection in tool params
- **security-sql-injection** — Resists SQL injection in tool params
- **security-path-traversal** — Resists path traversal in tool params
- **security-ssrf-internal** — Resists SSRF to internal networks
- **security-oversized-input** — Handles oversized inputs gracefully
- **security-extra-params** — Rejects or ignores extra tool params
- **security-tool-schema-defined** — All tools define inputSchema
- **security-tool-rug-pull** — Tool definitions are stable across calls
- **security-tool-description-poisoning** — Tool descriptions free of injection patterns
- **security-tool-cross-reference** — Tools do not reference other tools by name
- **security-error-no-stacktrace** — Error responses do not leak stack traces
- **security-error-no-internal-ip** — Error responses do not leak internal IPs
- **security-rate-limiting** — Rate limiting is enforced

</details>

## What the 103 tests check (2026-07-28)

The 2026-07-28 catalog grades the stateless, per-request `_meta` era: `server/discover` instead of `initialize`, no sessions, caching hints on every cacheable result, `resultType` on every result, MRTR `input_required` results instead of server-initiated requests, and `-32602` for missing resources. Ids shared with the 2025-11-25 list are semantically identical checks; a check whose pass criteria changed carries a new id, so `diff` refuses to compare reports across revisions. Post-hoc tests scan a recording of every message the server sent during the run.

<details>
<summary><strong>Transport (20 tests)</strong></summary>

HTTP-only (15):
- **transport-post** — HTTP POST accepted (required)
- **transport-content-type** — Responds with JSON or SSE (required)
- **transport-content-type-reject** — Rejects non-JSON request Content-Type
- **transport-batch-reject** — Rejects JSON-RPC batch requests (required)
- **transport-notification-202** — Notification returns 202 Accepted
- **transport-concurrent** — Handles concurrent requests
- **transport-get-removed** — GET returns 405
- **transport-delete-removed** — DELETE returns 405
- **transport-session-ignored** — Ignores Mcp-Session-Id
- **transport-header-version-required** — Rejects missing MCP-Protocol-Version header (required)
- **transport-header-version-mismatch** — Rejects header/_meta version mismatch (required)
- **transport-header-method-required** — Rejects missing Mcp-Method header (required)
- **transport-header-method-mismatch** — Rejects Mcp-Method/body mismatch (required)
- **transport-header-name-mismatch** — Rejects Mcp-Name/body mismatch
- **transport-header-case-insensitive** — Header names are case-insensitive

Both transports (1, post-hoc):
- **transport-no-server-requests** — No server-initiated requests on any stream (required)

stdio-only (4):
- **stdio-framing** — Newline-delimited JSON framing
- **stdio-unicode** — UTF-8 unicode roundtrip
- **stdio-unknown-method-recovers** — Recovers after unknown method
- **stdio-cancellation** — Ignores cancellation of unknown request

</details>

<details>
<summary><strong>Lifecycle (22 tests)</strong></summary>

- **lifecycle-discover** — server/discover returns DiscoverResult (required)
- **lifecycle-discover-versions** — supportedVersions are well-formed (required)
- **lifecycle-discover-caching** — server/discover carries caching hints (required)
- **lifecycle-jsonrpc** — Response is valid JSON-RPC 2.0 (required)
- **lifecycle-id-match** — Response id matches request id (required)
- **lifecycle-string-id** — Supports string request ids
- **lifecycle-capabilities** — Returns capabilities object (required)
- **lifecycle-server-info** — Includes serverInfo in _meta
- **lifecycle-instructions** — Instructions field is valid
- **lifecycle-meta-required** — Rejects request without _meta (required)
- **lifecycle-meta-protocol-version-required** — Rejects _meta without protocolVersion (required)
- **lifecycle-meta-client-capabilities-required** — Rejects _meta without clientCapabilities (required)
- **lifecycle-meta-client-info-optional** — Serves _meta without clientInfo (required)
- **lifecycle-version-unsupported** — Rejects unsupported protocol version (required)
- **lifecycle-removed-methods** — Removed legacy methods are rejected
- **lifecycle-dual-era** — Legacy initialize probe (informational)
- **lifecycle-capability-handlers-match** — Capability declarations match handlers
- **lifecycle-subscriptions-listen** — subscriptions/listen acknowledges first
- **lifecycle-log-level-gating** — No log notifications without logLevel (required)
- **lifecycle-meta-tolerance** — Tolerates unknown _meta keys
- **lifecycle-completions** — completion/complete accepted (required if completions capability declared)
- **lifecycle-progress-token** — Progress notifications echo the token

</details>

<details>
<summary><strong>Tools (6 tests)</strong></summary>

- **tools-list** — tools/list returns valid response (required if tools capability declared)
- **tools-list-caching** — tools/list carries caching hints (required if tools capability declared)
- **tools-list-deterministic-order** — tools/list order is deterministic
- **tools-call** — tools/call responds correctly (required if tools capability declared)
- **tools-content-types** — Tool content items have valid types (required if tools capability declared)
- **tools-pagination** — tools/list supports pagination

</details>

<details>
<summary><strong>Resources (8 tests)</strong></summary>

- **resources-list** — resources/list returns valid response (required if resources capability declared)
- **resources-list-caching** — resources/list carries caching hints (required if resources capability declared)
- **resources-read** — resources/read returns content (required if resources capability declared)
- **resources-read-caching** — resources/read carries caching hints (required if resources capability declared)
- **resources-not-found** — Nonexistent resource returns -32602 (required if resources capability declared)
- **resources-templates** — resources/templates/list returns valid response
- **resources-templates-caching** — resources/templates/list carries caching hints
- **resources-pagination** — resources/list supports pagination

</details>

<details>
<summary><strong>Prompts (4 tests)</strong></summary>

- **prompts-list** — prompts/list returns valid response (required if prompts capability declared)
- **prompts-list-caching** — prompts/list carries caching hints (required if prompts capability declared)
- **prompts-get** — prompts/get returns valid messages (required if prompts capability declared)
- **prompts-pagination** — prompts/list supports pagination

</details>

<details>
<summary><strong>Error Handling (12 tests)</strong></summary>

- **error-unknown-method** — Unknown method returns JSON-RPC error (required)
- **error-method-code** — Unknown method uses -32601 (required)
- **error-invalid-jsonrpc** — Handles malformed JSON-RPC
- **error-invalid-json** — Handles invalid JSON body
- **error-parse-code** — Returns -32700 for invalid JSON
- **error-invalid-request-code** — Returns -32600 for invalid request
- **error-missing-params** — tools/call without name returns error
- **tools-call-unknown** — Unknown tool name returns error
- **error-capability-gated** — Rejects methods for undeclared capabilities
- **error-invalid-cursor** — Handles invalid pagination cursor
- **error-id-echo** — Error responses echo the request id
- **error-retired-codes** — No retired error codes

</details>

<details>
<summary><strong>Schema Validation (10 tests)</strong></summary>

- **tools-schema** — All tools have name and inputSchema
- **tools-annotations** — Tool annotations are valid
- **tools-title-field** — Tools include title field
- **tools-output-schema** — Tools with outputSchema are valid
- **prompts-schema** — Prompts have name field
- **resources-schema** — Resources have uri and name
- **schema-result-type** — Every result carries resultType (required)
- **schema-no-input-required-on-lists** — input_required only on MRTR methods (required)
- **schema-input-required-shape** — InputRequiredResult is well-formed
- **schema-wire-valid** — Messages validate against the 2026-07-28 schema

</details>

<details>
<summary><strong>Security (21 tests)</strong></summary>

- **security-auth-required** — Rejects unauthenticated requests
- **security-www-authenticate** — 401 responses include WWW-Authenticate
- **security-auth-malformed** — Rejects malformed auth credentials
- **security-tls-required** — Enforces HTTPS/TLS
- **security-oauth-metadata** — Protected Resource Metadata endpoint exists
- **security-token-in-uri** — Rejects auth tokens in query string
- **security-cors-headers** — CORS headers are restrictive
- **security-origin-validation** — Validates Origin header
- **security-command-injection** — Resists command injection in tool params
- **security-sql-injection** — Resists SQL injection in tool params
- **security-path-traversal** — Resists path traversal in tool params
- **security-ssrf-internal** — Resists SSRF to internal networks
- **security-oversized-input** — Handles oversized inputs gracefully
- **security-extra-params** — Rejects or ignores extra tool params
- **security-tool-schema-defined** — All tools define inputSchema
- **security-tool-rug-pull** — Tool definitions are stable across calls
- **security-tool-description-poisoning** — Tool descriptions free of injection patterns
- **security-tool-cross-reference** — Tools do not reference other tools by name
- **security-error-no-stacktrace** — Error responses do not leak stack traces
- **security-error-no-internal-ip** — Error responses do not leak internal IPs
- **security-rate-limiting** — Rate limiting is enforced

</details>

## Grading

| Grade | Score  |
|-------|--------|
| A     | 90-100 |
| B     | 75-89  |
| C     | 60-74  |
| D     | 40-59  |
| F     | 0-39   |

Required tests are worth 70% of the score, optional tests 30%. See the [full scoring algorithm](./COMPLIANCE_RUBRIC.md#2-scoring-algorithm) in the methodology doc.

## CI integration

```yaml
# GitHub Actions example
- name: MCP Compliance Check
  run: npx @yawlabs/mcp-compliance@latest test ${{ env.MCP_SERVER_URL }} --strict
```

```yaml
# With JSON output for parsing
- name: MCP Compliance Check
  run: |
    npx @yawlabs/mcp-compliance@latest test ${{ env.MCP_SERVER_URL }} --format json > compliance.json
    cat compliance.json | jq '.grade'
```

```yaml
# With retries for flaky network conditions
- name: MCP Compliance Check
  run: npx @yawlabs/mcp-compliance@latest test ${{ env.MCP_SERVER_URL }} --strict --retries 2 --timeout 30000
```

```yaml
# SARIF output for GitHub Code Scanning
- name: MCP Compliance Check
  run: npx @yawlabs/mcp-compliance@latest test ${{ env.MCP_SERVER_URL }} --format sarif > compliance.sarif
- name: Upload SARIF
  uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: compliance.sarif
```

## MCP server (for Claude Code, Cursor, etc.)

This package also exposes an MCP server with 2 tools that can be used from Claude Code, Cursor, or any MCP client.

### Setup

**Claude Code (one-liner):**

```bash
claude mcp add mcp-compliance -- npx -y @yawlabs/mcp-compliance@latest mcp
```

**Or create `.mcp.json` in your project root:**

macOS / Linux / WSL:

```json
{
  "mcpServers": {
    "mcp-compliance": {
      "command": "npx",
      "args": ["-y", "@yawlabs/mcp-compliance@latest", "mcp"]
    }
  }
}
```

Windows:

```json
{
  "mcpServers": {
    "mcp-compliance": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@yawlabs/mcp-compliance@latest", "mcp"]
    }
  }
}
```

> **Tip:** This file is safe to commit — it contains no secrets.

Restart your MCP client and approve the server when prompted.

### Tools

- **mcp_compliance_test** — Run the full compliance suite against an HTTP MCP endpoint (URL). Supports auth, custom headers, timeout, retries, category/test filtering, and `specVersion` (`auto` | `2025-11-25` | `2026-07-28`, default `auto`). Returns grade, score, the resolved `specVersion`, and detailed results. stdio targets are CLI-only.
- **mcp_compliance_explain** — Explain what a specific test ID checks and why it matters, with a link to the spec section. Ids are per catalog: pass `specVersion` to read one catalog, or omit it to search both (a shared id is explained once per suite, and an id that only exists in the other suite is pointed out).

All tools have [MCP tool annotations](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#annotations) (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) so MCP clients can skip confirmation dialogs for safe operations.

## Programmatic usage

```typescript
import { runComplianceSuite } from '@yawlabs/mcp-compliance';

const report = await runComplianceSuite('https://my-server.com/mcp');
console.log(`Grade: ${report.grade} (${report.score}%)`);

// With options
const report2 = await runComplianceSuite('https://my-server.com/mcp', {
  headers: { 'Authorization': 'Bearer tok123' },
  timeout: 30000,
  retries: 1,
  only: ['transport', 'lifecycle'],
  specVersion: '2026-07-28', // 'auto' (default) | '2025-11-25' | '2026-07-28'
});
console.log(report2.specVersion); // always the resolved revision, never 'auto'

// Per-revision catalogs and helpers
import { getTestDefinitions, specBaseFor, SUPPORTED_SPEC_VERSIONS } from '@yawlabs/mcp-compliance';
getTestDefinitions('2026-07-28'); // 103 TestDefinitions; TEST_DEFINITIONS stays the 2025-11-25 list
specBaseFor(report2.specVersion); // base URL for that revision's spec links

// Live progress for streaming UIs (e.g. server-sent-events to a browser)
await runComplianceSuite('https://my-server.com/mcp', {
  onTestComplete: (result) => {
    // result has the full TestResult: id, name, category, required,
    // passed, details, durationMs, specRef. Push it to your client.
    sendToClient(result);
  },
});
```

## Report schema

The JSON output of the test suite is a stable, versioned contract. Every report includes a `schemaVersion` field at the top level. The full JSON Schema lives at [`schemas/report.v1.json`](./schemas/report.v1.json) and is shipped with the npm package.

```jsonc
{
  "schemaVersion": "1",        // bumped on breaking changes to the report shape
  "specVersion": "2026-07-28", // MCP spec revision the run graded — the RESOLVED value ("2025-11-25" or "2026-07-28"), never "auto"
  "toolVersion": "0.18.0",     // mcp-compliance version that produced the report
  "url": "...",
  "timestamp": "...",
  "grade": "A",
  "score": 92.5,
  "tests": [ ... ],            // ids are only meaningful together with specVersion
  // ...
}
```

Consumer guidance:

- Pin against `schemaVersion`. Reject reports with an unknown version rather than guessing at the shape.
- Check `report.specVersion` before interpreting `tests`. Since 0.18 **one tool version produces reports for either revision**, so a dashboard that keyed on `toolVersion` alone will see `2025-11-25` and `2026-07-28` reports from the same version; test ids, the required set and `serverInfo.protocolVersion` all belong to the revision named there. Treat an unknown `specVersion` the way you treat an unknown `schemaVersion`: reject, do not guess.
- The schema validates with any Draft 2020-12 validator (e.g. `ajv`). It is strict (`additionalProperties: false`), so a new field means a new schema version.
- Renames, removals, or type changes bump `schemaVersion`; the report shape is otherwise stable within a major version.
- Two runs against the same server produce equivalent grade, score, and per-test pass/fail (modulo timings/timestamps) — provided they resolve to the same `specVersion`. Under `auto` that is a property of the server, so pin `--spec-version` where determinism across deploys matters.

## Methodology & docs

The testing methodology is published openly so the grading is auditable:

- **[Testing methodology](./COMPLIANCE_RUBRIC.md)** — test execution model per spec revision, scoring algorithm, all 88 + 103 test rules with pass/fail criteria (CC BY 4.0)
- **[Machine-readable rule catalog](./mcp-compliance-rules.json)** — every rule tagged with the spec revision it applies to, for programmatic consumption (kept in lock-step with the code by `src/tests/catalog-parity.test.ts`)
- **[Why `mcp-compliance`](./docs/WHY.md)** — the problem, existing alternatives, what this tool does differently
- **[Fixing common failures](./docs/FIXES.md)** — recipes for the most frequent test failures with code snippets, for both revisions
- **[Spec version policy](./docs/SPEC_VERSION_MIGRATION.md)** — one tool version, several spec catalogs: how `auto` decides, how to pin, what changes when your server upgrades
- **[Performance deep-dive](./docs/PERFORMANCE.md)** — why the suite is sequential and what parallel execution would cost
- **[Spec PR drafts](./docs/spec-prs/)** — our proposed MCP spec clarifications for ambiguous cases we've hit

The methodology is not an authoritative conformance standard — it's one tool's choices, published so they can be inspected, adopted, or forked. The official MCP specification ([2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25), [2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28)) defines what servers must do; this document describes how `@yawlabs/mcp-compliance` verifies it.

## Requirements

- Node.js 20+

## Contributing

```bash
git clone https://github.com/YawLabs/mcp-compliance.git
cd mcp-compliance
npm install
npm run build
npm test
```

**Development commands:**

| Command | Description |
|---------|-------------|
| `npm run build` | Compile with tsup |
| `npm run dev` | Watch mode |
| `npm test` | Run tests (vitest) |
| `npm run lint` | Check with Biome |
| `npm run lint:fix` | Auto-fix with Biome |
| `npm run typecheck` | TypeScript type checking |
| `npm run test:ci` | Build + test (CI-safe) |

## Links

- [MCP Specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25)
- [MCP Specification 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28)
- [Testing methodology](./COMPLIANCE_RUBRIC.md)
- [Yaw Labs](https://yaw.sh)

## License

MIT — see [LICENSE](./LICENSE).
