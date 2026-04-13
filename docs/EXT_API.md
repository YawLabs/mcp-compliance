# mcp.hosting external compliance API

Public, unauthenticated HTTP API for submitting and retrieving compliance reports keyed by URL hash. Used by the `mcp-compliance badge <url>` flow but also callable directly for custom integrations.

## Concepts

- **URL hash** — `sha256(url).slice(0, 24)` (96 bits). The canonical key for any externally-tested MCP server. Compute it with `urlHash()` from `@yawlabs/mcp-compliance`, or with any SHA-256 implementation. The API also accepts legacy 12-char hashes from v0.9.0 publishes.
- **Delete token** — returned once at submit time; required to remove a previously-submitted report. Stored client-side at `~/.mcp-compliance/tokens.json` (mode 0600) by the CLI. Never logged or rendered server-side.
- **Retention** — 90 days from last submission. Resubmitting the same URL resets the clock.

## Base URL

`https://mcp.hosting`

## Endpoints

### `POST /api/compliance/ext`

Submit a compliance report.

**Request:**
```http
POST /api/compliance/ext HTTP/1.1
Content-Type: application/json
Content-Length: <body length, max 256 KB>

{
  "schemaVersion": "1",
  "url": "https://my-server.example/mcp",
  "specVersion": "2025-11-25",
  "toolVersion": "0.10.1",
  "timestamp": "2026-04-13T01:23:45.000Z",
  "grade": "A",
  "score": 95,
  "overall": "pass",
  "tests": [ /* array of TestResult */ ],
  "summary": { "total": 85, "passed": 80, "failed": 5, "required": 12, "requiredPassed": 12 },
  "categories": { /* per-category counts */ },
  "warnings": [],
  "serverInfo": { "name": "...", "version": "...", "protocolVersion": "2025-11-25", "capabilities": {} },
  "toolCount": 0, "toolNames": [], "resourceCount": 0, "resourceNames": [], "promptCount": 0, "promptNames": []
}
```

The full report shape is defined by [`schemas/report.v1.json`](../schemas/report.v1.json) shipped with the npm package.

**Validation:**
- `url` required, must be HTTP/HTTPS
- `grade` ∈ `["A", "B", "C", "D", "F"]`
- `score` 0–100 integer
- `tests` must be an array
- Body ≤ 256 KB serialized
- URL must NOT resolve to private IP (`127.0.0.1`, RFC1918, link-local, IPv6 ULA, AWS metadata) — 403 with `error: 'Backend resolves to a private IP address'`
- Auth headers (`headers`, `auth`) are stripped server-side regardless of what the client sends; do not include them in your submission

**Rate limit:** 10 submissions / IP / hour. Returns `429` with `Retry-After` header on exhaustion.

**Response 200:**
```json
{
  "hash": "a1b2c3d4e5f6a1b2c3d4e5f6",
  "reportUrl": "https://mcp.hosting/compliance/ext/a1b2c3d4e5f6a1b2c3d4e5f6",
  "badgeUrl":  "https://mcp.hosting/api/compliance/ext/a1b2c3d4e5f6a1b2c3d4e5f6/badge",
  "deleteToken": "<48-char base64url>"
}
```

**Errors:**

| Code | Reason |
|---|---|
| `400` | Malformed body, missing required fields, invalid grade/score |
| `403` | URL resolves to private IP (SSRF protection) |
| `413` | Body exceeds 256 KB |
| `429` | Rate-limited (`Retry-After` header set) |

### `GET /api/compliance/ext/:hash`

Retrieve a previously-submitted report as JSON.

`:hash` accepts 12 or 24 lowercase hex chars.

**Response 200:** the original report body (same shape as the POST input).
**404:** no report found for that hash.

### `GET /api/compliance/ext/:hash/badge`

Retrieve the SVG badge for a hash.

- `Content-Type: image/svg+xml`
- `Cache-Control: public, max-age=300`
- Always returns a valid SVG. Unknown hash → renders an "untested" badge in gray.

### `DELETE /api/compliance/ext/:hash`

Remove a previously-submitted report.

**Request:**
```http
DELETE /api/compliance/ext/<hash> HTTP/1.1
Authorization: Bearer <delete-token>
```

**Rate limit:** 5 / IP / hour (defends against token-enumeration).

**Responses:**
- `204 No Content` on success
- `401` if `Authorization` header missing
- `403` if token doesn't match (`crypto.timingSafeEqual` comparison)
- `404` if hash doesn't exist
- `429` if rate-limited

## Operational notes

- **Hashing:** the server computes its own hash from the submitted URL. Client-supplied hashes are ignored. You cannot squat someone else's URL by sending a colliding hash; collisions in the 96-bit space are vanishingly rare anyway.
- **Trust:** reports are self-submitted and stored as-is. The badge reflects what the submitter claimed, not what an independent party verified. Display accordingly if you build a public dashboard on top of this API.
- **Idempotency:** resubmitting the same URL overwrites the previous report and **issues a new `deleteToken`**. The old token is invalidated. Save the latest one.
- **Metrics:** Prometheus counters at `/metrics` track submit volume by grade, SSRF rejects, rate-limit hits, and delete outcomes. See [`mcp-hosting/src/api/metrics.ts`](https://github.com/YawLabs/mcp-hosting/blob/main/src/api/metrics.ts).

## Example: publish from curl

```bash
# 1. Build a report (or use mcp-compliance test --format json)
report=$(mcp-compliance test https://my-server.example/mcp --format json)

# 2. POST it
response=$(curl -sS -XPOST https://mcp.hosting/api/compliance/ext \
  -H 'Content-Type: application/json' \
  --data "$report")

# 3. Save the delete token
echo "$response" | jq -r '.deleteToken' > .mcp-delete-token

# 4. Embed the badge in your README
echo "$response" | jq -r '.badgeUrl'
```

## Example: unpublish from curl

```bash
hash=$(echo -n "https://my-server.example/mcp" | sha256sum | cut -c1-24)
curl -XDELETE "https://mcp.hosting/api/compliance/ext/$hash" \
  -H "Authorization: Bearer $(cat .mcp-delete-token)"
```

(Or just use `mcp-compliance unpublish https://my-server.example/mcp` which does both for you.)
