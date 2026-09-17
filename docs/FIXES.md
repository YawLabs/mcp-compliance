# Fixing common compliance failures

Recipes for the most frequent test failures, grouped by category. Every recipe names the test ID so you can cross-reference with the [testing methodology](../COMPLIANCE_RUBRIC.md) and the `--only <test-id>` flag.

Code samples use the official MCP TypeScript SDK where applicable and vanilla HTTP / stdio where not.

The tool grades one spec revision per run (`report.specVersion`; see [the spec version policy](./SPEC_VERSION_MIGRATION.md)). The recipes up to [Stdio-specific](#stdio-specific) are written for the **2025-11-25** suite; ids that also exist in the 2026-07-28 catalog (`tools-schema`, `security-*`, `stdio-*`, `error-method-code`, ...) are the same check in both eras, so those recipes apply to both. Failures unique to the **2026-07-28** suite -- `server/discover`, `_meta`, header validation, caching hints, `resultType`, MRTR -- are in [2026-07-28 failures](#2026-07-28-failures).

---

## Transport

### `transport-post` — HTTP POST accepted

**Failure:** `HTTP 401 (auth required — pass --auth)` or `HTTP 404`.

**Fix:** Your server is reachable but rejecting the probe. If auth is required, pass `--auth 'Bearer <token>'` to the CLI. If the URL is wrong, check the path — most MCP servers serve at `/mcp` or `/` specifically. A 403 annotated `forbidden` (`Host/Origin validation, a gateway, or ...`) carried no `WWW-Authenticate: Bearer` challenge (with `--auth`, none with an `error` parameter), so it is most likely not about credentials: the SDK's Host validation refuses a tunnel or proxy hostname it was not configured to allow, and Origin validation or a gateway answers 403 too. The report's first warning quotes the server's error message when the body has one.

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

### `tools-schema` — All tools have name and inputSchema (second failure mode)

**Failure:** `Tool at index 2 missing name field`.

**Fix:** every entry in your tools list needs at minimum `name: string` and `inputSchema: {...}`. These aren't optional per spec. (The `type: "object"` wrapper failure of the same rule is covered under [Tools](#tools-schema--all-tools-have-valid-inputschema-required-when-tools-declared).)

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

On 2025-11-25 without `--auth`, the unauthenticated preflight stands in for the probe: a 401, or a 403 carrying a `WWW-Authenticate: Bearer` challenge, passes (`HTTP 401 (unauthenticated preflight rejected; pass --auth ...)`), and so does a 401 on the unauthenticated `initialize` when a gateway refused the preflight with a bare 403; a bare 403 fails as not evaluable (it may be Host/Origin validation or a gateway) -- answer a missing token with 401 and `WWW-Authenticate: Bearer`, and if the details quote `Invalid Host`, add the hostname you tested through to the server's allowed hosts. The report's first warning says the grade is not meaningful until you re-run with `--auth <token>` -- most of the suite never got past your auth gate.

On 2026-07-28 the probe is sent with or without `--auth`: a 401, or a 403 with a `WWW-Authenticate: Bearer` challenge, passes either way. A 403 without a challenge -- what Origin validation, the SDK's Host validation (`Invalid Host: ...`) and gateways answer -- passes only with `--auth` when your credentialed request was served, and otherwise fails as `not evaluable`; answer a missing token with 401 and a Bearer challenge, and if the details quote `Invalid Host`, add the hostname you tested through to the server's allowed hosts. The sibling `security-auth-malformed` sends two credentials in place of yours -- a well-formed token no authorization server issued (`Bearer aW52YWxpZC10b2tlbg`), which MUST draw 401, and a value outside the RFC 6750 `b64token` grammar, for which the spec's error table allows `400 Bad Request` as well as 401 -- so a strict bearer parser that answers 400 for garbage is no longer marked as "accepted". And `security-oauth-metadata` treats the `resource_metadata` URL in your `WWW-Authenticate` challenge as authoritative: clients MUST use it, so when you advertise one it is the only URL fetched, and an advertised URL that is relative, unreachable, non-200, non-JSON or missing `resource` / `authorization_servers` fails even if a valid document sits at a well-known location (the details name that location -- the fix is then one header). Only without a challenge URL does it try `/.well-known/oauth-protected-resource<endpoint path>`, then the root.

### `security-rate-limiting` — Rate limiting is enforced (HTTP only)

**Failure:** server processed 50 rapid requests without throttling.

**Fix:** add per-IP or per-session limits. With Express + `express-rate-limit`:

```ts
import rateLimit from 'express-rate-limit';
app.use('/mcp', rateLimit({ windowMs: 60_000, max: 100 }));
```

Tune windows to your workload. The 2025-11-25 suite bursts `ping`; the 2026-07-28 suite bursts `tools/call` against your first `readOnlyHint: true` tool that needs no arguments (the spec's MUST is on tool invocations) -- 50 real invocations of that tool, named in the details -- and only falls back to `server/discover` when you expose no such tool. On both paths a burst that draws no 429 passes with a warning rather than failing (50 requests cannot prove there is no limiter, and annotating a tool read-only should not cost you grade), so read the warning: it is the one place the report says your tool calls went unthrottled. A limiter scoped to `tools/call` answers the modern check even though it leaves discovery open. A burst your auth gate rejected (every answer 401/403) is skipped with a `--auth` hint, since nothing reached a handler.

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

Both suites remove the payload itself from the tool output before looking for evidence, so a tool that merely echoes its input is not a failure. If the test still fails and your server DID block the payload, check that your error responses carry `isError: true` or start with something like `"Access denied"` or `"Permission denied"` — the heuristic recognizes those as defense signals.

On 2026-07-28 the four injection tests share **one** target, taken from the safest annotation tier that has a string argument: `readOnlyHint: true`, then `destructiveHint: false`, then tools with no such annotation, then `destructiveHint: true`. The spec defaults `destructiveHint` to true, so an unannotated tool counts as one that may write: a read-only tool always wins whatever its argument names, the report names every unannotated and destructive tool it passed over, and when nothing safer exists it warns that the chosen tool was hit with live payloads -- run those against a disposable dataset, or annotate your read-only tools with `readOnlyHint: true` so they are the ones probed. Within the tier a free-form string argument beats an enum/const/pattern one. The tool's other required arguments are filled with placeholders that honour the schema (`const`, `enum`, `default`, `minimum`, `minItems`, nested `required`, `format`) so the payload actually reaches the handler, and the details count what came back: `Tested 5 payload(s) against lookup.q: 0 rejected, 5 returned without evidence of execution, 0 never reached the tool`. Only rejections (isError or rejection wording) count as a defence; an echo is benign, and a `-32602` for a payload that never reached the tool is neither. When no payload reached the tool at all the details end `-- inconclusive (see warning)`: check that the placeholder arguments satisfy your schema.

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

**Fix:** don't override Node's default stdout encoding (UTF-8). On Windows specifically, check `chcp` isn't set to a non-UTF-8 code page if you're spawning child processes. On 2026-07-28 the failure names the evidence: U+FFFD replacement characters, a Latin-1 mis-decode, the non-ASCII characters replaced by `?` (a legacy code page's encoder), or the CJK/emoji characters dropped. A tool that splits its input into tokens passes as long as every non-ASCII piece comes back somewhere in the reply.

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

## 2026-07-28 failures

Everything below is specific to the 2026-07-28 suite. The shape that ties these together: there is **no session and no handshake**. Every request is self-describing (`params._meta` carries the protocol version and client capabilities; on HTTP the standard headers mirror the body), `server/discover` is how a client learns what you serve, and every result says what kind of result it is. Most first-run failures on a freshly upgraded server come from one of three places: the `_meta` envelope is not validated, results are missing the new required fields (`resultType`, `ttlMs`, `cacheScope`), or legacy handlers (`ping`, `logging/setLevel`, `resources/subscribe`) are still registered.

If you use the official SDK 2.0 (`@modelcontextprotocol/server`), all of the below is handled by the framework; these recipes are for hand-rolled servers and for SDK 1.x servers that added `server/discover` by hand. Two SDK 2.0.0 behaviours are worth knowing before you read your first report:

- **HTTP:** `createMcpHandler` serves a modern request (full `_meta`) that omits the `MCP-Protocol-Version` header with a 200 `DiscoverResult`, in both `legacy: 'stateless'` and `legacy: 'reject'` (a missing `Mcp-Method` is rejected 400/-32020 as expected). The spec says every POST MUST carry the header and a server that does not serve pre-2025-06-18 clients MUST reject its absence, so `transport-header-version-required` (required) **fails on SDK 2.0 servers by design** -- the suite grades the spec, not the SDK. Expect exactly that one required failure (plus the two localhost-inherent optional ones, no auth and no TLS, and a `security-rate-limiting` warning for the unthrottled burst) on an otherwise clean SDK 2.0 HTTP server.
- **stdio:** `serveStdio` with the default `legacy: 'serve'` pins the *process* to an era from the first message it can classify -- and it classifies ANY message without a `_meta` protocolVersion claim as a legacy opening, not just `initialize`. The suite therefore runs its two claim-less `_meta` probes (`lifecycle-meta-required`, `lifecycle-meta-protocol-version-required`) late, after its own modern `tools/list` has pinned the process modern (a `--only` run that skipped the feature tests sends the first declared list, else `ping`, first), and sends the `lifecycle-dual-era` `initialize` to a **fresh** process; on a default SDK 2.0 stdio server all three now pass cleanly (`rejected with -32602`, `dual-era: initialize answered with protocolVersion 2025-11-25 on a fresh process`). The interop hazard is real for other clients, though: a modern client that sends one malformed request to such a server before any pinning request loses the modern era for the process lifetime. `legacy: 'reject'` never selects the legacy era; a claim-less request before the process is pinned modern draws `-32022` there, and `-32602` afterwards.

### `lifecycle-discover` — server/discover returns DiscoverResult (required)

**Failure:** `-32601 Method not found` (the run also auto-detected as 2025-11-25 unless you pinned), or a result without `supportedVersions` / `capabilities`.

**Fix:** implement `server/discover`. It must work with no prior request and is the first thing every modern client sends:

```ts
handlers['server/discover'] = () => ({
  resultType: 'complete',
  supportedVersions: ['2026-07-28'],
  capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} },
  instructions: 'Optional guidance for the model.',
  ttlMs: 3_600_000,
  cacheScope: 'public',
  _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'my-server', version: '1.0.0' } },
});
```

`supportedVersions` is a list of date strings (`lifecycle-discover-versions`); list every revision you implement, e.g. `['2026-07-28', '2025-11-25']` for a dual-era server. `serverInfo` lives in `_meta`, not at the top level (`lifecycle-server-info`).

### `lifecycle-meta-required`, `lifecycle-meta-protocol-version-required`, `lifecycle-meta-client-capabilities-required` — Rejects malformed `_meta` (required)

**Failure:** `server returned a result (expected JSON-RPC error -32602)` -- the server served a request that had no `_meta`, or a `_meta` missing `protocolVersion` or `clientCapabilities`. A different failure shape, `not evaluable: the conformant server/discover was itself rejected with -32601, so this rejection proves nothing about the injected defect`, means the server rejects *everything* (typically a legacy-only server pinned to 2026-07-28): fix `lifecycle-discover` first, these three follow. `not evaluable: HTTP 429 is a transport-level rejection (rate limiting answered before the JSON-RPC layer read the request)` -- or the same for 401, 403, 413 or 415 -- means something in front of your handler answered: an auth gate (pass `--auth`), a body-size or media-type limit, or a rate limiter; the probe never reached the `_meta` validation it targets.

**Fix:** validate the envelope on **every** request, `server/discover` included, before dispatch. Both keys are required; `clientInfo` is optional (`lifecycle-meta-client-info-optional` fails you if you reject its absence). Do not default the missing fields and do not fill `protocolVersion` in from the HTTP header:

```ts
const META = 'io.modelcontextprotocol/';
function validateMeta(msg) {
  const meta = msg.params?._meta;
  if (!meta || typeof meta !== 'object') return 'missing _meta';
  if (typeof meta[`${META}protocolVersion`] !== 'string') return 'missing protocolVersion';
  if (!meta[`${META}clientCapabilities`] || typeof meta[`${META}clientCapabilities`] !== 'object') return 'missing clientCapabilities';
  return null;
}
// ...
const problem = validateMeta(msg);
if (problem) {
  return reply(400, { jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `Invalid params: ${problem}` } });
}
```

`-32602` is the expected code; `-32020` passes with a warning. On HTTP the status must be 400. Unknown `_meta` keys must be tolerated (`lifecycle-meta-tolerance`) -- validate the reserved keys you read, never `additionalProperties: false`.

### `lifecycle-version-unsupported` — Rejects unsupported protocol version (required)

**Failure:** `expected -32022, got -32602` / `data.supported missing` / `HTTP 200`.

**Fix:** after the envelope is well-formed, check the version against your list and answer with the dedicated error, including `data.supported` (identical to what `server/discover` advertises) and `data.requested`:

```ts
const SUPPORTED = ['2026-07-28'];
const requested = meta[`${META}protocolVersion`];
if (!SUPPORTED.includes(requested)) {
  return reply(400, {
    jsonrpc: '2.0', id: msg.id,
    error: { code: -32022, message: 'Unsupported protocol version', data: { supported: SUPPORTED, requested } },
  });
}
```

Order matters on HTTP: check the header/`_meta` mismatch first (next recipe), then the version, so a mismatch is reported as `-32020` and an unknown version as `-32022`.

### `transport-header-version-required`, `transport-header-version-mismatch`, `transport-header-method-required`, `transport-header-method-mismatch`, `transport-header-name-mismatch` — Rejects missing or mismatched standard headers (HTTP; required except `-name-`)

**Failure:** `HTTP 200, result (expected HTTP 400)` -- the server ran a request whose `MCP-Protocol-Version` or `Mcp-Method` header was missing, or disagreed with the body. As with the `_meta` rules, a 400 is credited only when the conformant `server/discover` was served; a server that answers every request with 400 fails these as `not evaluable`, and so does a 401/403/413/415/429 from a gate in front of the server.

**Fix:** every POST carries `MCP-Protocol-Version` (must equal `_meta` protocolVersion) and `Mcp-Method` (must equal the body's `method`); `tools/call`, `resources/read` and `prompts/get` also carry `Mcp-Name` (must equal `params.name` / `params.uri`, after Base64-sentinel decoding). Validate before dispatch and reject with 400 + `-32020`:

```ts
function decodeHeaderValue(v) {
  const m = /^=\?base64\?(.*)\?=$/.exec(v);
  return m ? Buffer.from(m[1], 'base64').toString('utf8') : v;
}
const h = (name) => req.headers[name.toLowerCase()]; // Node lowercases header names; compare values exactly
const mismatch = (what) =>
  reply(400, { jsonrpc: '2.0', id: msg.id, error: { code: -32020, message: `Header mismatch: ${what}` } });

if (!h('MCP-Protocol-Version')) return mismatch('MCP-Protocol-Version missing');
if (h('MCP-Protocol-Version') !== meta[`${META}protocolVersion`]) return mismatch('MCP-Protocol-Version');
if (!h('Mcp-Method')) return mismatch('Mcp-Method missing');
if (h('Mcp-Method') !== msg.method) return mismatch('Mcp-Method');
const named = { 'tools/call': 'name', 'prompts/get': 'name', 'resources/read': 'uri' }[msg.method];
if (named && decodeHeaderValue(h('Mcp-Name') ?? '') !== msg.params?.[named]) return mismatch('Mcp-Name');
```

Read headers through your framework's case-insensitive accessor; `transport-header-case-insensitive` sends them in lowercase and expects a normal result. The legacy "no header means 2025-03-26" fallback applies only to requests whose body carries no modern `_meta` -- which is exactly the cell `@modelcontextprotocol/server` 2.0.0 gets wrong (see the SDK note at the top of this section): it serves the header-less modern request as 2026-07-28, so it fails `transport-header-version-required` until the SDK adds the check.

### `lifecycle-discover-caching`, `tools-list-caching`, `resources-list-caching`, `resources-read-caching`, `prompts-list-caching`, `resources-templates-caching` — Caching hints (required when the capability is declared)

**Failure:** `ttlMs missing` / `cacheScope "none" is not public|private` / `ttlMs -1`.

**Fix:** every *complete* result of `server/discover`, `tools/list`, `resources/list`, `resources/templates/list`, `resources/read` and `prompts/list` carries both hints. `ttlMs` is an integer `>= 0` (`0` means "always re-fetch"; use it for volatile data rather than omitting the field), `cacheScope` is `'public'` or `'private'`:

```ts
const CACHE = { ttlMs: 300_000, cacheScope: 'public' };
handlers['tools/list'] = () => ({ resultType: 'complete', tools, ...CACHE });
handlers['resources/read'] = ({ uri }) => ({ resultType: 'complete', contents: read(uri), ttlMs: 0, cacheScope: 'private' });
```

Use `'private'` whenever the list or content depends on who is asking, and keep the same scope on every page of one list. `input_required` interim results carry no hints.

### `schema-result-type` — Every result carries resultType (required)

**Failure:** `3 result(s) without resultType: tools/list, tools/call, prompts/get`.

**Fix:** add `resultType: 'complete'` to every successful result, including empty ones. `'input_required'` is reserved for `InputRequiredResult` (next recipe). A result without `resultType` is what a 2025-11-25 server returns, which is exactly what this rule catches:

```ts
function complete(result) { return { resultType: 'complete', ...result }; }
handlers['prompts/list'] = () => complete({ prompts, ...CACHE });
```

### `transport-no-server-requests`, `schema-no-input-required-on-lists`, `schema-input-required-shape` — MRTR instead of server-initiated requests

**Failure:** `server-to-client request observed: sampling/createMessage (id 7)` or `input_required result on tools/list`.

**Fix:** 2026-07-28 has no server-to-client requests. Sampling, elicitation and roots travel *inside* the result of the request that needs them, and only for `tools/call`, `prompts/get` and `resources/read`:

```ts
// WRONG (2025-11-25): push a request onto the response stream and wait
// RIGHT: return an InputRequiredResult and finish when the client retries
handlers['tools/call'] = ({ name, arguments: args, inputResponses, requestState }) => {
  if (name === 'ask' && !inputResponses?.answer) {
    return {
      resultType: 'input_required',
      inputRequests: { answer: { method: 'elicitation/create', params: { mode: 'form', message: 'Which one?', requestedSchema: { type: 'object', properties: { choice: { type: 'string' } } } } } },
      requestState: 'opaque-token-you-can-verify',
    };
  }
  // the retry carries the client's answers in params.inputResponses (keyed like inputRequests)
  // and echoes params.requestState verbatim
  return { resultType: 'complete', content: [{ type: 'text', text: `you chose ${inputResponses.answer.content?.choice}` }] };
};
```

Only request capabilities the client declared in its `clientCapabilities` -- and for `elicitation/create`, only a `mode` the client's `elicitation` declaration covers (`elicitation: {}` means form only, so a `mode: 'url'` request fails `schema-input-required-shape`) -- and treat `requestState` as attacker-controlled on the retry (HMAC or AEAD it if it influences authorization).

### `lifecycle-removed-methods`, `error-unknown-method` — Removed methods and 404 (required for unknown methods)

**Failure:** `ping returned a result` / `logging/setLevel returned a result` / `unknown method: HTTP 200` (passes with a warning).

**Fix:** `ping`, `logging/setLevel`, `resources/subscribe` and `resources/unsubscribe` do not exist in 2026-07-28. Drop the handlers from the modern code path and let them fall through to `-32601`, and on HTTP answer unknown methods with status **404** together with the JSON-RPC error -- the body is what lets a modern client tell your 404 from a legacy HTTP+SSE server that has no MCP endpoint:

```ts
const handler = handlers[msg.method];
if (!handler) {
  return reply(404, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
}
```

A dual-era server keeps the legacy handlers behind the `initialize` session only.

### `resources-not-found`, `error-retired-codes` — Nonexistent resource returns -32602

**Failure:** `expected -32602, got -32002 (retired)` or `empty contents for a nonexistent uri`.

**Fix:** `-32002` was retired (so was `-32042`); a missing resource is `-32602 Invalid params`, and `contents: []` is never the answer for a URI you cannot resolve:

```ts
handlers['resources/read'] = ({ uri }) => {
  const r = store.get(uri);
  if (!r) throw { code: -32602, message: 'Resource not found', data: { uri } };
  return { resultType: 'complete', contents: [{ uri, mimeType: r.mimeType, text: r.text }], ...CACHE };
};
```

`data.uri` is a SHOULD; omitting it passes with a warning. So does any code other than `-32602` and `-32002` (a resolver that throws `-32603` on the unknown `test://` scheme, say): `nonexistent URI -> JSON-RPC error -32603 (expected -32602; see warnings)` is a pass with a warning, not a failure. Grep your codebase for `-32002` and `-32042`.

### `lifecycle-subscriptions-listen` — subscriptions/listen acknowledges first

**Failure:** `first frame was notifications/tools/list_changed, expected notifications/subscriptions/acknowledged` or `subscriptionId "abc" != request id 1042`.

**Fix:** if you declare any `listChanged` or `subscribe` capability, implement `subscriptions/listen` as a long-lived response (an SSE stream on HTTP; frames tagged with the subscription id on stdio). The **first** frame is the acknowledgment, its subscription id is the listen request's own id, and `notifications` names the subset you honour:

```ts
// HTTP: res is a text/event-stream response kept open until the client closes it
res.write(`event: message\ndata: ${JSON.stringify({
  jsonrpc: '2.0',
  method: 'notifications/subscriptions/acknowledged',
  params: {
    _meta: { 'io.modelcontextprotocol/subscriptionId': msg.id },
    notifications: { 'notifications/tools/list_changed': {} },
  },
})}\n\n`);
subscribers.add(res); // later list_changed notifications go here, never on a request's response stream
```

If you advertise nothing, `-32601` for `subscriptions/listen` is fine. The standalone HTTP GET stream is gone; answer GET with 405 (`transport-get-removed`).

### `lifecycle-log-level-gating` — No log notifications without logLevel (required)

**Failure:** `notifications/message on tools/call (id 1010) which set no logLevel`.

**Fix:** there is no `logging/setLevel` and no global level. Log notifications are per request: emit `notifications/message` only on the response stream of a request whose `_meta` carried `io.modelcontextprotocol/logLevel`, and only at or above that level. Remove any default level left over from `logging/setLevel`:

```ts
const level = msg.params?._meta?.['io.modelcontextprotocol/logLevel']; // undefined = the client did not opt in
const log = (lvl, data) => { if (level && rank(lvl) >= rank(level)) stream.notify('notifications/message', { level: lvl, data }); };
```

Never send `notifications/message` on a `subscriptions/listen` stream.

### `lifecycle-dual-era` — Legacy initialize probe (informational)

**Not a failure** (the only way to fail it is a stdio server that exits on the request; no response, a 401/403/413/415/429, and a single-instance server pass with a warning), but three things it surfaces:

- A **modern-only** server SHOULD name its supported versions in the error it returns to `initialize`, either in `data.supported` (the `-32022` UnsupportedProtocolVersionError shape, which is canonical) or in the message. A bare `-32601`, or a message that only echoes the version the client asked for (`Unsupported protocol version: 2025-11-25`) with no `data.supported`, draws the warning `initialize rejected with -32601 but neither the message nor data.supported names a supported protocol version (spec SHOULD)`. Legacy clients have no fall-forward mechanism, so that error is the only diagnostic they will ever see:

  ```ts
  handlers['initialize'] = undefined;
  if (msg.method === 'initialize') {
    return reply(400, {
      jsonrpc: '2.0', id: msg.id,
      error: { code: -32022, message: 'This server speaks MCP 2026-07-28 only; initialize is not supported', data: { supported: ['2026-07-28'], requested: msg.params?.protocolVersion } },
    });
  }
  ```

  The details then read `modern-only: initialize rejected with -32022; message and data.supported name supported versions`.

- A **dual-era** server (answers `initialize` too) is graded as 2026-07-28 under `--spec-version auto`, with a warning -- fired when `supportedVersions` lists 2025-11-25 *or* when this probe is served an `InitializeResult`, which is how an SDK 2.0 server (modern-only `supportedVersions`, `initialize` still served) gets it. On stdio the probe opens a **fresh process**, because a dual-era server selects its era from how the client opens and the suite's own process is already pinned modern; the details say so (`dual-era: initialize answered with protocolVersion 2025-11-25 on a fresh process; legacy handshake served alongside 2026-07-28`). Its legacy side is not graded in that run; use `--spec-version 2025-11-25` for that. If the modern side was an afterthought, expect the caching-hint, `resultType` and `_meta` recipes above to be the first failures.

- A **legacy-only** server (answers `initialize` but rejects the conformant `server/discover`) reads `legacy-only: initialize answered with protocolVersion 2025-11-25 ... but server/discover was rejected`, and the report warns that most of the 2026-07-28 run was not evaluable. Grade it with `--spec-version 2025-11-25` (or `auto`), or implement `server/discover` first.

On stdio, if the fresh process exits without answering, the suite starts another instance with no input: when that one exits too, your server allows one instance at a time (a lock file, a fixed port) and the probe reports `era undetermined` with both exits in a warning; only when the idle instance stays up is the exit blamed on `initialize` (`Server exited after a legacy initialize request on a fresh process (exit code 3: ...); an instance spawned with no input stays up, so the request is what it exits on`). The fresh process waits `--timeout`, stretched to three times the setup `server/discover` latency for a slow starter and capped by `--startup-timeout`.

---

## Stuck after applying a fix?

1. Re-run with `--verbose` to see each test as it runs.
2. Use `--only <test-id>` to iterate on one test at a time. On 2026-07-28 the tools/resources/prompts lists a filtered-out test would have cached are fetched on demand, so a single test still measures the server; if the report says `No tests ran -- check --only/--skip`, the warning says whether the id belongs to the other catalog or only applies to the other transport (`--list --spec-version <date> --transport <kind>` shows the valid ones). With `--only`, a check whose list call failed names the recorded reason (`tools/list failed (...)`) instead of pointing at a `-list` test that did not run.
3. Compare before/after with `mcp-compliance diff baseline.json current.json`.
4. File an issue on [YawLabs/mcp-compliance](https://github.com/YawLabs/mcp-compliance/issues) if the test output doesn't clearly point at the fix. We treat opaque error messages as bugs in this tool.
