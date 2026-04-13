# Fixing common compliance failures

Recipes for the most frequent test failures, grouped by category. Every recipe names the test ID so you can cross-reference with the [compliance spec](../MCP_COMPLIANCE_SPEC.md) and the `--only <test-id>` flag.

Code samples use the official MCP TypeScript SDK where applicable and vanilla HTTP / stdio where not.

---

## Transport

### `transport-post` — HTTP POST accepted

**Failure:** `HTTP 401 (auth required — pass --auth)` or `HTTP 404`.

**Fix:** Your server is reachable but rejecting the probe. If auth is required, pass `--auth 'Bearer <token>'` to the CLI. If the URL is wrong, check the path — most MCP servers serve at `/mcp` or `/` specifically.

### `transport-content-type` — Responds with JSON or SSE

**Failure:** `Content-Type: text/html` or `application/xml`.

**Fix:** set the response Content-Type explicitly for JSON-RPC responses:

```ts
res.setHeader('Content-Type', 'application/json');
```

…or for streaming:

```ts
res.setHeader('Content-Type', 'text/event-stream');
```

Never fall through to your HTTP framework's default (which is often `text/html`).

### `transport-notification-202` — Notifications return 202

**Failure:** server returned `200` with an empty body for a notification (message without `id`).

**Fix:**

```ts
const isNotification = msg.id === undefined;
if (isNotification) {
  res.statusCode = 202;
  res.end();        // no body
  return;
}
```

Per spec: notifications MUST return exactly `202 Accepted`.

### `transport-session-id` — Enforces MCP-Session-Id after init

**Failure:** server accepted a request missing the session header without returning `400`.

**Fix:** after your server issues a session ID (in `Mcp-Session-Id` response header on initialize), reject subsequent requests that don't include it:

```ts
const sid = req.headers['mcp-session-id'];
if (!sid || !sessions.has(sid)) {
  res.writeHead(sid ? 404 : 400);
  res.end();
  return;
}
```

### `transport-session-invalid` — Returns 404 for unknown session ID

**Failure:** server returned `400` for a fabricated session ID instead of `404`.

**Fix:** distinguish the two: missing → `400`, unknown → `404`. Same spec rule, two error codes.

### `transport-batch-reject` — Rejects JSON-RPC batch requests

**Failure:** server processed a batch array.

**Fix:** MCP explicitly forbids JSON-RPC batching. Detect arrays early and reject:

```ts
const body = JSON.parse(rawBody);
if (Array.isArray(body)) {
  res.writeHead(400, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32600, message: 'Batch requests not supported' }, id: null }));
  return;
}
```

### `transport-content-type-reject` — Rejects non-JSON request Content-Type

**Failure:** server accepted `text/plain` body.

**Fix:** validate the incoming Content-Type:

```ts
if (!req.headers['content-type']?.includes('application/json')) {
  res.writeHead(415, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Content-Type must be application/json' }));
  return;
}
```

### `transport-sse-event-field` — SSE responses include `event: message`

**Failure:** SSE stream emitted `data:` lines without `event: message` prefix.

**Fix:**

```ts
// WRONG
res.write(`data: ${JSON.stringify(msg)}\n\n`);

// RIGHT
res.write(`event: message\ndata: ${JSON.stringify(msg)}\n\n`);
```

Per spec: JSON-RPC messages in SSE streams MUST be tagged with `event: message`.

---

## Lifecycle

### `lifecycle-init` — Initialize handshake (required)

**Failure:** `No result in response` or `result missing protocolVersion`.

**Fix:** Return a proper result object for initialize:

```ts
{
  jsonrpc: '2.0',
  id: msg.id,
  result: {
    protocolVersion: '2025-11-25',
    capabilities: { /* your capabilities */ },
    serverInfo: { name: 'my-server', version: '1.0.0' }
  }
}
```

### `lifecycle-proto-version` — Returns valid protocol version

**Failure:** `Version: invalid` or `Version: latest`.

**Fix:** protocolVersion must be an exact date string, `YYYY-MM-DD`, matching one of the published MCP spec versions. Don't use keywords like `"latest"` or `"current"`.

### `lifecycle-jsonrpc` — Response is valid JSON-RPC 2.0 (required)

**Failure:** `Missing jsonrpc field` or `id missing`.

**Fix:** every response must include:
- `jsonrpc: "2.0"` (literal string)
- `id` (same type as the request's id)
- Exactly one of `result` OR `error`, never both, never neither

### `lifecycle-id-match` — Response ID matches request ID (required)

**Failure:** `Request id=1001, response id=1002`.

**Fix:** preserve the request's `id` exactly in your response. Don't generate a new one.

### `lifecycle-reinit-reject` — Rejects second initialize request

**Failure:** server accepted a second initialize on the same session.

**Fix (optional/advisory):** the spec doesn't explicitly mandate rejection, but strict servers enforce it:

```ts
if (session.initialized) {
  return { jsonrpc: '2.0', id: msg.id, error: { code: -32600, message: 'Already initialized' } };
}
```

---

## Tools

### `tools-list` — tools/list returns valid response (required)

**Failure:** `No tools field in result`.

**Fix:** return `{ tools: [...] }` even when you have zero tools:

```ts
return { jsonrpc: '2.0', id: msg.id, result: { tools: [] } };
```

### `tools-schema` — All tools have valid inputSchema (required when tools declared)

**Failure:** `Tool "foo" missing type: object wrapper`.

**Fix:** every tool's inputSchema must be a JSON Schema object with `type: "object"` at the root:

```ts
{
  name: 'my_tool',
  description: '...',
  inputSchema: {
    type: 'object',                 // required
    properties: { message: { type: 'string' } },
    required: ['message'],
  }
}
```

### `tools-content-types` — Tool content items have valid types

**Failure:** `Unknown content type: markdown`.

**Fix:** content type must be one of: `text`, `image`, `audio`, `resource`, `resource_link`. For markdown, use `text` with the markdown string inside.

---

## Error handling

### `error-unknown-method` — Returns JSON-RPC error for unknown method (required)

**Failure:** server returned a result for an unknown method.

**Fix:**

```ts
const handler = handlers[msg.method];
if (!handler) {
  return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } };
}
```

### `error-method-code` — Uses correct JSON-RPC error code for unknown method

**Failure:** server returned error but with wrong code (e.g., `-32600` instead of `-32601`).

**Fix:** memorize the canonical JSON-RPC codes:
- `-32700` Parse error (invalid JSON)
- `-32600` Invalid Request (valid JSON, invalid JSON-RPC structure)
- `-32601` Method not found
- `-32602` Invalid params
- `-32603` Internal error

### `error-invalid-jsonrpc` — Handles malformed JSON-RPC (required)

**Failure:** server crashed or returned 200 on a message missing `method`.

**Fix:** validate the message shape before dispatching:

```ts
if (typeof msg.jsonrpc !== 'string' || typeof msg.method !== 'string') {
  return { jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
}
```

---

## Schema validation

### `schema-tools-required-fields` — All tools have name and inputSchema (required)

**Failure:** `Tool at index 2 missing name field`.

**Fix:** every entry in your tools list needs at minimum `name: string` and `inputSchema: {...}`. These aren't optional per spec.

---

## Security

### `security-auth-required` — Rejects unauthenticated requests (HTTP only)

**Failure:** server accepted requests without an Authorization header.

**Fix:** if you're running on the public internet, require auth:

```ts
const auth = req.headers.authorization;
if (!auth?.startsWith('Bearer ')) {
  res.writeHead(401, { 'WWW-Authenticate': 'Bearer' });
  res.end();
  return;
}
// validate the token
```

Skip this for stdio servers (no external caller) or tightly-scoped internal HTTP servers.

### `security-rate-limiting` — Rate limiting is enforced (HTTP only)

**Failure:** server processed 50 rapid requests without throttling.

**Fix:** add per-IP or per-session limits. With Express + `express-rate-limit`:

```ts
import rateLimit from 'express-rate-limit';
app.use('/mcp', rateLimit({ windowMs: 60_000, max: 100 }));
```

Tune windows to your workload.

### `security-command-injection` — Resists command injection

**Failure:** your tool echoed `&& echo pwned` in its output without apparent rejection.

**Fix:** never pass tool arguments to shell commands. Two rules:

1. Use `execFile()` or `spawn()` with an array of args, never `exec()` with a concatenated string.

```ts
// WRONG
exec(`convert ${userPath} output.png`);

// RIGHT
execFile('convert', [userPath, 'output.png']);
```

2. Validate inputs against an allowlist before using them. If a parameter is supposed to be a filename, reject strings with `&`, `|`, `;`, backticks, or `$()`.

If the test is a false positive (your server DID block the payload but the error message echoed it back), check that your error responses start with something like `"Access denied"` or `"Permission denied"` — the heuristic recognizes those as defense signals.

### `security-path-traversal` — Resists path traversal

**Failure:** `../../etc/passwd` in a tool param caused file content to return.

**Fix:** always resolve paths against an allowed root and reject results outside:

```ts
import { resolve, relative } from 'node:path';
const ROOT = '/var/data';
const resolved = resolve(ROOT, userPath);
if (relative(ROOT, resolved).startsWith('..')) {
  throw new Error('Access denied - path outside allowed directories');
}
```

### `security-ssrf-internal` — Resists SSRF to internal networks

**Failure:** a tool accepted `http://169.254.169.254/` (AWS metadata) and returned internal data.

**Fix:** resolve hostnames and reject private IP ranges before fetching:

```ts
import { resolveDns } from 'node:dns/promises';
const addrs = await resolveDns.resolve(hostname);
const isPrivate = (ip) => /^(10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(ip);
if (addrs.some(isPrivate)) throw new Error('URL resolves to private network');
```

### `security-tool-schema-defined` — All tools define inputSchema

**Failure:** a tool missing inputSchema.

**Fix:** same as `tools-schema`. No exceptions — even a zero-argument tool needs `inputSchema: { type: "object" }`.

### `security-tool-description-poisoning` — Tool descriptions free of injection patterns

**Failure:** a tool description contains SQL keywords or shell payloads.

**Fix:** this almost always means the description was accidentally populated from user-supplied data (a DB field, a README fetched from a URL). Hardcode descriptions or derive them from trusted sources.

### `security-tool-cross-reference` — Tools do not reference other tools by name

**Failure:** `Tool "read_file" description references "read_text_file"`.

**Fix (advisory):** avoid naming other tools in description strings — an LLM may get confused about which tool to use. If you have multiple related tools, explain their relationship in server-level `instructions` field, not inside individual tool descriptions.

### `security-rate-limiting` — Rate limiting

See above. Don't skip even for stdio — limit tool calls per session to avoid runaway LLM behavior.

---

## Stdio-specific

### `stdio-framing` — Newline-delimited JSON framing (required)

**Failure:** `3/5 rapid pings failed — framing likely broken`.

**Fix:** emit exactly one JSON message per line on stdout, terminated by `\n`. Never split a message across lines, never merge messages onto one line. With Node's `process.stdout`:

```ts
process.stdout.write(JSON.stringify(msg) + '\n');
```

Not `console.log`, which pretty-prints and may split.

### `stdio-unicode` — UTF-8 unicode roundtrip

**Failure:** tool output corrupted non-ASCII characters.

**Fix:** don't override Node's default stdout encoding (UTF-8). On Windows specifically, check `chcp` isn't set to a non-UTF-8 code page if you're spawning child processes.

### `stdio-unknown-method-recovers` — Recovers after unknown method

**Failure:** server crashed or disconnected after receiving an unknown method.

**Fix:** per-method dispatch should go through a try/catch that emits JSON-RPC errors without tearing down the session:

```ts
try {
  const result = await handlers[msg.method]?.(msg.params);
  if (!result) throw { code: -32601, message: 'Method not found' };
  send({ jsonrpc: '2.0', id: msg.id, result });
} catch (err) {
  send({ jsonrpc: '2.0', id: msg.id, error: err.code ? err : { code: -32603, message: err.message } });
}
// loop continues; next line gets read
```

---

## Stuck after applying a fix?

1. Re-run with `--verbose` to see each test as it runs.
2. Use `--only <test-id>` to iterate on one test at a time.
3. Compare before/after with `mcp-compliance diff baseline.json current.json`.
4. File an issue on [YawLabs/mcp-compliance](https://github.com/YawLabs/mcp-compliance/issues) if the test output doesn't clearly point at the fix. We treat opaque error messages as bugs in this tool.
