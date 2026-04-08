# @yawlabs/mcp-compliance

[![npm version](https://img.shields.io/npm/v/@yawlabs/mcp-compliance)](https://www.npmjs.com/package/@yawlabs/mcp-compliance)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![GitHub stars](https://img.shields.io/github/stars/YawLabs/mcp-compliance)](https://github.com/YawLabs/mcp-compliance/stargazers)
[![CI](https://github.com/YawLabs/mcp-compliance/actions/workflows/ci.yml/badge.svg)](https://github.com/YawLabs/mcp-compliance/actions/workflows/ci.yml)

**Test any MCP server for spec compliance.** 43-test suite covering transport, lifecycle, tools, resources, prompts, error handling, and schema validation against the [MCP specification](https://modelcontextprotocol.io/specification/2025-11-25). CLI, MCP server, and programmatic API.

Built and maintained by [Yaw Labs](https://yaw.sh).

## Why this tool?

MCP servers are multiplying fast — but most ship without compliance testing. Broken transport handling, missing error codes, malformed schemas, and silent capability violations are common. Hand-rolling test scripts is tedious and incomplete.

This tool solves that:

- **48 tests across 7 categories** — transport, lifecycle, tools, resources, prompts, error handling, and schema validation. No gaps.
- **Capability-driven** — tests adapt to what the server declares. If it says it supports tools, tool tests become required. No false failures for features the server doesn't claim.
- **Graded scoring** — A-F letter grade with a weighted score (required tests 70%, optional 30%). One number to communicate compliance.
- **CI-ready** — `--strict` mode exits with code 1 on required test failures. Drop it into any pipeline.
- **Spec-referenced** — every test links to the exact section of the MCP specification it validates. No ambiguity about what's being tested or why.
- **Three interfaces** — CLI for humans, MCP server for AI assistants, programmatic API for integration.
- **Published specification** — the [testing methodology](./MCP_COMPLIANCE_SPEC.md) and [rule catalog](./mcp-compliance-rules.json) are open (CC BY 4.0) so anyone can implement compatible tooling.

## Quick start

**Run against any MCP server:**

```bash
npx @yawlabs/mcp-compliance test https://my-server.com/mcp
```

**Or install globally:**

```bash
npm install -g @yawlabs/mcp-compliance
mcp-compliance test https://my-server.com/mcp
```

That's it. You'll get a colored terminal report with a letter grade (A-F), per-test pass/fail, and a compliance score.

## CLI usage

```bash
# Terminal output with colors and grade
mcp-compliance test https://my-server.com/mcp

# JSON output (for scripting)
mcp-compliance test https://my-server.com/mcp --format json

# SARIF output (for GitHub Code Scanning)
mcp-compliance test https://my-server.com/mcp --format sarif > compliance.sarif

# Strict mode — exits with code 1 on required test failure (for CI)
mcp-compliance test https://my-server.com/mcp --strict

# With authentication
mcp-compliance test https://my-server.com/mcp --auth "Bearer tok123"

# Custom headers (repeatable)
mcp-compliance test https://my-server.com/mcp -H "Authorization: Bearer tok123" -H "X-Api-Key: abc"

# Custom timeout (default: 15000ms)
mcp-compliance test https://my-server.com/mcp --timeout 30000

# Retry failed tests
mcp-compliance test https://my-server.com/mcp --retries 2

# Only run specific categories or test IDs
mcp-compliance test https://my-server.com/mcp --only transport,lifecycle
mcp-compliance test https://my-server.com/mcp --only lifecycle-init,tools-list

# Skip specific categories or test IDs
mcp-compliance test https://my-server.com/mcp --skip prompts,resources

# Verbose mode — print each test result as it runs
mcp-compliance test https://my-server.com/mcp --verbose
```

### Options

| Option | Description |
|--------|-------------|
| `--format <format>` | Output format: `terminal`, `json`, or `sarif` (default: `terminal`) |
| `--strict` | Exit with code 1 on any required test failure (for CI) |
| `-H, --header <header>` | Add header to all requests, format `"Key: Value"` (repeatable) |
| `--auth <token>` | Shorthand for `-H "Authorization: <token>"` |
| `--timeout <ms>` | Request timeout in milliseconds (default: `15000`) |
| `--retries <n>` | Number of retries for failed tests (default: `0`) |
| `--only <items>` | Only run tests matching these categories or test IDs (comma-separated) |
| `--skip <items>` | Skip tests matching these categories or test IDs (comma-separated) |
| `--verbose` | Print each test result as it runs |

### Get badge markdown

```bash
mcp-compliance badge https://my-server.com/mcp
```

Outputs the markdown embed for a compliance badge hosted at [mcp.hosting](https://mcp.hosting).

## What the 48 tests check

<details>
<summary><strong>Transport (7 tests)</strong></summary>

- **transport-post** — Server accepts HTTP POST requests (required)
- **transport-content-type** — Responds with application/json or text/event-stream (required)
- **transport-notification-202** — Notifications return 202 Accepted
- **transport-session-id** — Enforces MCP-Session-Id after initialization
- **transport-get** — GET returns SSE stream or 405
- **transport-delete** — DELETE accepted or returns 405
- **transport-batch-reject** — Rejects JSON-RPC batch requests (required)

</details>

<details>
<summary><strong>Lifecycle (10 tests)</strong></summary>

- **lifecycle-init** — Initialize handshake succeeds (required)
- **lifecycle-proto-version** — Returns valid YYYY-MM-DD protocol version (required)
- **lifecycle-server-info** — Includes serverInfo with name
- **lifecycle-capabilities** — Returns capabilities object (required)
- **lifecycle-jsonrpc** — Response is valid JSON-RPC 2.0 (required)
- **lifecycle-ping** — Responds to ping method (required)
- **lifecycle-instructions** — Instructions field is valid string if present
- **lifecycle-id-match** — Response ID matches request ID (required)
- **lifecycle-logging** — logging/setLevel accepted (required if logging capability declared)
- **lifecycle-completions** — completion/complete accepted (required if completions capability declared)

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
<summary><strong>Error Handling (8 tests)</strong></summary>

- **error-unknown-method** — Returns JSON-RPC error for unknown method (required)
- **error-method-code** — Uses correct -32601 error code
- **error-invalid-jsonrpc** — Handles malformed JSON-RPC (required)
- **error-invalid-json** — Handles invalid JSON body
- **error-missing-params** — Returns error for tools/call without name
- **error-parse-code** — Returns -32700 for invalid JSON
- **error-invalid-request-code** — Returns -32600 for invalid request
- **tools-call-unknown** — Returns error for nonexistent tool name

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

- **mcp_compliance_test** — Run the full 43-test suite against a URL. Supports auth, custom headers, timeout, retries, and category/test filtering. Returns grade, score, and detailed results.
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
```

## Specification

The compliance testing methodology is published as an open specification:

- **[MCP Compliance Testing Specification](./MCP_COMPLIANCE_SPEC.md)** — test execution model, scoring algorithm, all 43 test rules with pass/fail criteria (CC BY 4.0)
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
