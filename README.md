# @yawlabs/mcp-compliance

CLI tool and MCP server that tests MCP servers for spec compliance. Runs a 24-test suite covering transport, lifecycle, tools, resources, prompts, error handling, and schema validation against the [MCP specification](https://modelcontextprotocol.io/specification/2025-11-25).

## Install

```bash
npm install -g @yawlabs/mcp-compliance
```

Or run directly with npx:

```bash
npx @yawlabs/mcp-compliance test https://my-server.com/mcp
```

## CLI Usage

### Run compliance tests

```bash
# Terminal output with colors and grade
mcp-compliance test https://my-server.com/mcp

# JSON output (for scripting)
mcp-compliance test https://my-server.com/mcp --format json

# Strict mode — exits with code 1 on required test failure (for CI)
mcp-compliance test https://my-server.com/mcp --strict

# With authentication
mcp-compliance test https://my-server.com/mcp --auth "Bearer tok123"

# Custom headers (repeatable)
mcp-compliance test https://my-server.com/mcp -H "Authorization: Bearer tok123" -H "X-Api-Key: abc"
```

### Options

| Option | Description |
|--------|-------------|
| `--format <format>` | Output format: `terminal` or `json` (default: `terminal`) |
| `--strict` | Exit with code 1 on any required test failure (for CI) |
| `-H, --header <header>` | Add header to all requests, format `"Key: Value"` (repeatable) |
| `--auth <token>` | Shorthand for `-H "Authorization: <token>"` |

### Get badge markdown

```bash
mcp-compliance badge https://my-server.com/mcp
```

Outputs the markdown embed for a compliance badge hosted at [mcp.hosting](https://mcp.hosting).

## What the 24 tests check

### Transport (2 tests)
- **transport-post** — Server accepts HTTP POST requests (required)
- **transport-content-type** — Responds with application/json or text/event-stream (required)

### Lifecycle (6 tests)
- **lifecycle-init** — Initialize handshake succeeds (required)
- **lifecycle-proto-version** — Returns valid YYYY-MM-DD protocol version (required)
- **lifecycle-server-info** — Includes serverInfo with name
- **lifecycle-capabilities** — Returns capabilities object (required)
- **lifecycle-jsonrpc** — Response is valid JSON-RPC 2.0 (required)
- **lifecycle-ping** — Responds to ping method (required)

### Tools (3 tests)
- **tools-list** — tools/list returns valid array (required if tools capability declared)
- **tools-call** — tools/call responds with correct format
- **tools-call-unknown** — Returns error for nonexistent tool name

### Resources (4 tests)
- **resources-list** — resources/list returns valid array (required if resources capability declared)
- **resources-read** — resources/read returns content items
- **resources-templates** — resources/templates/list works or returns method-not-found
- **resources-schema** — Resources have valid uri and name (required if resources capability declared)

### Prompts (3 tests)
- **prompts-list** — prompts/list returns valid array (required if prompts capability declared)
- **prompts-schema** — Prompts have name field (required if prompts capability declared)
- **prompts-get** — prompts/get returns valid messages

### Error Handling (4 tests)
- **error-unknown-method** — Returns JSON-RPC error for unknown method (required)
- **error-method-code** — Uses correct -32601 error code
- **error-invalid-jsonrpc** — Handles malformed JSON-RPC (required)
- **error-invalid-json** — Handles invalid JSON body
- **error-missing-params** — Returns error for tools/call without name

### Schema Validation (2 tests)
- **tools-schema** — All tools have valid name and inputSchema (required if tools capability declared)
- **prompts-schema** — Prompts have valid name field (required if prompts capability declared)

## Grading

| Grade | Score  |
|-------|--------|
| A     | 90-100 |
| B     | 75-89  |
| C     | 60-74  |
| D     | 40-59  |
| F     | 0-39   |

Required tests are worth 70% of the score, optional tests 30%.

## CI Integration

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

## MCP Server (for Claude Code)

This package also exposes an MCP server with 3 tools that can be used from Claude Code or any MCP client.

### Setup

Add to your Claude Code MCP config:

```json
{
  "mcpServers": {
    "mcp-compliance": {
      "command": "npx",
      "args": ["-y", "@yawlabs/mcp-compliance"],
      "env": {},
      "args_extra": ["mcp"]
    }
  }
}
```

Or run the MCP server directly:

```json
{
  "mcpServers": {
    "mcp-compliance": {
      "command": "node",
      "args": ["path/to/node_modules/@yawlabs/mcp-compliance/dist/mcp/server.js"]
    }
  }
}
```

### Tools

- **mcp_compliance_test** — Run the full 24-test suite against a URL. Returns grade, score, and detailed results.
- **mcp_compliance_badge** — Get the badge markdown/HTML for a server.
- **mcp_compliance_explain** — Explain what a specific test ID checks and why it matters.

## Programmatic Usage

```typescript
import { runComplianceSuite } from '@yawlabs/mcp-compliance';

const report = await runComplianceSuite('https://my-server.com/mcp');
console.log(`Grade: ${report.grade} (${report.score}%)`);
```

## Links

- [mcp.hosting](https://mcp.hosting) — Hosted MCP server infrastructure
- [MCP Specification](https://modelcontextprotocol.io/specification/2025-11-25)
- [Yaw Labs](https://yaw.sh)

## License

MIT
