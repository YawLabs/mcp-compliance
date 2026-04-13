# @yawlabs/mcp-compliance

[![npm version](https://img.shields.io/npm/v/@yawlabs/mcp-compliance)](https://www.npmjs.com/package/@yawlabs/mcp-compliance)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![GitHub stars](https://img.shields.io/github/stars/YawLabs/mcp-compliance)](https://github.com/YawLabs/mcp-compliance/stargazers)
[![CI](https://github.com/YawLabs/mcp-compliance/actions/workflows/ci.yml/badge.svg)](https://github.com/YawLabs/mcp-compliance/actions/workflows/ci.yml)

**Test any MCP server for spec compliance.** 85-test suite covering transport, lifecycle, tools, resources, prompts, error handling, schema validation, and security against the [MCP specification](https://modelcontextprotocol.io/specification/2025-11-25). Works against **HTTP endpoints** (`https://my-server.com/mcp`) and **stdio servers** (`npx @modelcontextprotocol/server-filesystem /tmp`) alike. CLI, MCP server, and programmatic API.

Built and maintained by [Yaw Labs](https://yaw.sh).

## Why this tool?

MCP servers are multiplying fast — but most ship without compliance testing. Broken transport handling, missing error codes, malformed schemas, and silent capability violations are common. Hand-rolling test scripts is tedious and incomplete.

This tool solves that:

- **84 tests across 8 categories** — transport, lifecycle, tools, resources, prompts, error handling, schema validation, and security. No gaps. (HTTP runs all 81 transport-applicable tests; stdio runs ~70 — HTTP-specific tests like CORS, TLS, session headers, and rate limiting are gated out.)
- **Capability-driven** — tests adapt to what the server declares. If it says it supports tools, tool tests become required. No false failures for features the server doesn't claim.
- **Graded scoring** — A-F letter grade with a weighted score (required tests 70%, optional 30%). One number to communicate compliance.
- **CI-ready** — `--strict` mode exits with code 1 on required test failures. Drop it into any pipeline.
- **Spec-referenced** — every test links to the exact section of the MCP specification it validates. No ambiguity about what's being tested or why.
- **Three interfaces** — CLI for humans, MCP server for AI assistants, programmatic API for integration.
- **Published specification** — the [testing methodology](./MCP_COMPLIANCE_SPEC.md) and [rule catalog](./mcp-compliance-rules.json) are open (CC BY 4.0) so anyone can implement compatible tooling.

## Quick start

**Remote HTTP server:**

```bash
npx @yawlabs/mcp-compliance test https://my-server.com/mcp
```

**Local stdio server** (the vast majority of MCP servers on npm):

```bash
# Pass the command directly, Inspector-style
npx @yawlabs/mcp-compliance test npx @modelcontextprotocol/server-filesystem /tmp

# Or a local build
npx @yawlabs/mcp-compliance test node ./dist/server.js

# With env vars
npx @yawlabs/mcp-compliance test -E GITHUB_TOKEN=$GITHUB_TOKEN -- npx @modelcontextprotocol/server-github
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

### Options

| Option | Applies to | Description |
|--------|-----------|-------------|
| `--format <format>` | both | Output format: `terminal`, `json`, `sarif`, `github`, or `markdown` (default: `terminal`) |
| `--config <path>` | both | Load defaults from a config file (default: `mcp-compliance.config.json` in cwd) |
| `--output <file>` | both | Write a local SVG badge to the given path after the run |
| `--list` | both | Print test IDs that would run given current filters, then exit (no connection) |
| `--transport <kind>` | both | Filter by `http` or `stdio` (only used with `--list` when no target is provided) |
| `--strict` | both | Exit with code 1 on any required test failure (for CI) |
| `--min-grade <grade>` | both | Exit with code 1 if grade is below this threshold (`A`–`F`) |
| `-H, --header <h>` | HTTP | Add header to all requests, format `"Key: Value"` (repeatable) |
| `--auth <token>` | HTTP | Shorthand for `-H "Authorization: <token>"` |
| `-E, --env <var>` | stdio | Set env var for stdio command, format `"KEY=VALUE"` (repeatable) |
| `--env-file <path>` | stdio | Load env vars from a file (one `KEY=VALUE` per line) |
| `--cwd <dir>` | stdio | Working directory for the stdio command |
| `--timeout <ms>` | both | Request timeout in milliseconds (default: `15000`) |
| `--preflight-timeout <ms>` | HTTP | Preflight connectivity check timeout (HTTP only) |
| `--retries <n>` | both | Number of retries for failed tests (default: `0`) |
| `--only <items>` | both | Only run tests matching these categories or test IDs (comma-separated) |
| `--skip <items>` | both | Skip tests matching these categories or test IDs (comma-separated) |
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
mcp-compliance test --list --transport stdio --skip security

# Diff two runs — exit 1 if anything that was passing is now failing
mcp-compliance test https://my-server.com/mcp --format json > current.json
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

Precedence: CLI flags > config file > defaults. Any field can be overridden on the command line.

### Publish a shareable badge (HTTP only)

```bash
mcp-compliance badge https://my-server.com/mcp
```

Runs the compliance suite, publishes the report to [mcp.hosting](https://mcp.hosting), and prints the markdown embed for your README. The badge image reflects the real grade (A–F) and links to the full report.

| Option | Description |
|--------|-------------|
| `-H, --header <header>` | Add header to all requests, format `"Key: Value"` (repeatable) |
| `--auth <token>` | Shorthand for `-H "Authorization: <token>"` |
| `--timeout <ms>` | Request timeout in milliseconds (default: `15000`) |
| `--no-publish` | Skip publishing; print a local badge markdown only |
| `--output <file>` | Also write a local SVG badge to the given path |

Reports are kept for 90 days from last submission; resubmitting the same URL overwrites the previous report. Auth headers are stripped client-side before upload. Private/loopback URLs (`localhost`, `127.0.0.1`, `192.168.*`, etc.) trigger an interactive confirmation before publishing, and are rejected by the server in any case.

A delete token is returned at publish time and stored at `~/.mcp-compliance/tokens.json` (mode `0600`). Use it to take a report down:

```bash
mcp-compliance unpublish https://my-server.com/mcp
```

### Local SVG badge (any transport)

Stdio servers can't be published (no public URL to key on), but you can commit a local SVG reflecting the real grade:

```bash
mcp-compliance test node ./dist/server.js --output badge.svg
mcp-compliance badge npx -y @modelcontextprotocol/server-filesystem /tmp --output badge.svg
```

Then embed it in your README:

```markdown
![MCP Compliance](./badge.svg)
```

The `test` command never publishes — use it for CI, debugging, and local iteration. `badge` is the only command that publishes to mcp.hosting.

## What the 84 tests check

<details>
<summary><strong>Transport (13 tests)</strong></summary>

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

</details>

<details>
<summary><strong>Lifecycle (17 tests)</strong></summary>

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

## Grading

| Grade | Score  |
|-------|--------|
| A     | 90-100 |
| B     | 75-89  |
| C     | 60-74  |
| D     | 40-59  |
| F     | 0-39   |

Required tests are worth 70% of the score, optional tests 30%. See the [full scoring algorithm](./MCP_COMPLIANCE_SPEC.md#2-scoring-algorithm) in the specification.

## CI integration

```yaml
# GitHub Actions example
- name: MCP Compliance Check
  run: npx @yawlabs/mcp-compliance test ${{ env.MCP_SERVER_URL }} --strict
```

```yaml
# With JSON output for parsing
- name: MCP Compliance Check
  run: |
    npx @yawlabs/mcp-compliance test ${{ env.MCP_SERVER_URL }} --format json > compliance.json
    cat compliance.json | jq '.grade'
```

```yaml
# With retries for flaky network conditions
- name: MCP Compliance Check
  run: npx @yawlabs/mcp-compliance test ${{ env.MCP_SERVER_URL }} --strict --retries 2 --timeout 30000
```

```yaml
# SARIF output for GitHub Code Scanning
- name: MCP Compliance Check
  run: npx @yawlabs/mcp-compliance test ${{ env.MCP_SERVER_URL }} --format sarif > compliance.sarif
- name: Upload SARIF
  uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: compliance.sarif
```

## MCP server (for Claude Code, Cursor, etc.)

This package also exposes an MCP server with 3 tools that can be used from Claude Code, Cursor, or any MCP client.

### Setup

**Claude Code (one-liner):**

```bash
claude mcp add mcp-compliance -- npx -y @yawlabs/mcp-compliance mcp
```

**Or create `.mcp.json` in your project root:**

macOS / Linux / WSL:

```json
{
  "mcpServers": {
    "mcp-compliance": {
      "command": "npx",
      "args": ["-y", "@yawlabs/mcp-compliance", "mcp"]
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
      "args": ["/c", "npx", "-y", "@yawlabs/mcp-compliance", "mcp"]
    }
  }
}
```

> **Tip:** This file is safe to commit — it contains no secrets.

Restart your MCP client and approve the server when prompted.

### Tools

- **mcp_compliance_test** — Run the full 85-test suite against a URL or stdio command. Supports auth, custom headers, env vars, timeout, retries, and category/test filtering. Returns grade, score, and detailed results.
- **mcp_compliance_badge** — Get the badge markdown/HTML for a server. Supports auth and custom headers.
- **mcp_compliance_explain** — Explain what a specific test ID checks and why it matters.

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
});

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
  "specVersion": "2025-11-25", // MCP spec version tested against
  "toolVersion": "0.10.0",     // mcp-compliance version that produced the report
  "url": "...",
  "timestamp": "...",
  "grade": "A",
  "score": 92.5,
  "tests": [ ... ],
  // ...
}
```

Consumer guidance:

- Pin against `schemaVersion`. Reject reports with an unknown version rather than guessing at the shape.
- The schema validates with any Draft 2020-12 validator (e.g. `ajv`).
- Within a major version, additions are non-breaking. Renames, removals, or type changes bump the version.
- Two runs against the same server produce equivalent grade, score, and per-test pass/fail (modulo timings/timestamps).

## Specification

The compliance testing methodology is published as an open specification:

- **[MCP Compliance Testing Specification](./MCP_COMPLIANCE_SPEC.md)** — test execution model, scoring algorithm, all 84 test rules with pass/fail criteria (CC BY 4.0)
- **[Machine-readable rule catalog](./mcp-compliance-rules.json)** — JSON Schema-compliant catalog for programmatic consumption

These are complementary to (not competing with) the [official MCP specification](https://modelcontextprotocol.io/specification/2025-11-25). The MCP spec defines what servers must do; this spec defines how to verify compliance.

## Requirements

- Node.js 18+

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

- [mcp.hosting](https://mcp.hosting) — Hosted MCP server infrastructure
- [MCP Specification](https://modelcontextprotocol.io/specification/2025-11-25)
- [MCP Compliance Testing Spec](./MCP_COMPLIANCE_SPEC.md)
- [Yaw Labs](https://yaw.sh)

## License

MIT — see [LICENSE](./LICENSE).
