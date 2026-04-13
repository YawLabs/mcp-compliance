# mcp.hosting integration spec

This document specifies the consumer-side contract that **mcp.hosting** implements against the `mcp-compliance` engine. It defines URL surfaces, data flow, edge cases, and quality bars for Phase 2 work.

The producer side (this repo) owns:

- The `ComplianceReport` JSON shape — see [`schemas/report.v1.json`](../schemas/report.v1.json).
- `runComplianceSuite()` — the engine, with the `onTestComplete(result)` callback for live streaming.
- The `--format json` CLI output, byte-stable across runs (modulo timestamps and `durationMs`).

The consumer side (mcp.hosting) owns everything described below.

---

## URL surfaces

The mcp.hosting brand is the platform; every compliance feature lives under it. The three new surfaces:

| Path | Purpose | Cache strategy |
|---|---|---|
| `GET  /compliance` | "Test your server" landing + form | static, 1h CDN |
| `POST /compliance/test` | Kick off a test run, return a job ID | no-cache |
| `GET  /compliance/jobs/<jobId>/stream` | Live SSE stream of test results | no-cache |
| `GET  /compliance/ext/<hash>` | Public report page for a tested server | edge-cache 5m, invalidate on re-test |
| `GET  /api/compliance/ext/<hash>/badge` | SVG badge | edge-cache 1h, invalidate on re-test |
| `GET  /api/compliance/ext/<hash>/report.json` | Raw JSON report (for tooling) | edge-cache 5m |
| `GET  /compliance/leaderboard` | Public ranking by grade | edge-cache 1m |
| `GET  /compliance/tests/<test-id>` | Per-test explainer (81 pages) | static, 1h CDN |

The `<hash>` is the 24-char SHA-256 prefix of the server URL — already implemented in [`src/badge.ts:8`](../src/badge.ts).

---

## Data flow: a test run

```
┌────────────┐  POST /compliance/test       ┌─────────────────┐
│   Browser  │ ────────────────────────────▶│ mcp.hosting API │
│   or CLI   │  { url, auth?, transport }   └────────┬────────┘
└────────────┘                                       │
       ▲                                             ▼
       │  SSE stream                       ┌──────────────────┐
       │  per-test results                 │   Test runner    │
       │                                   │   (Node worker)  │
       │                                   └────────┬─────────┘
       │                                            │
       │                                            ▼
       │                                   ┌──────────────────┐
       │                                   │ runComplianceSuite│
       │                                   │ ({ onTestComplete}│
       │                                   └────────┬─────────┘
       │                                            │
       │  GET /compliance/ext/<hash>                ▼
       │ ◀──────────────────────────────── store full report
       │                                   in DB keyed by hash
       │                                   + index in leaderboard
```

### POST /compliance/test

Request:

```json
{
  "url": "https://example.com/mcp",
  "auth": "Bearer …",          // optional, header value or shorthand
  "transport": "http",          // "http" | "stdio"; stdio rejected from public web UI
  "publish": true              // false = test for me but don't list publicly
}
```

Response:

```json
{ "jobId": "01J9X…", "streamUrl": "/compliance/jobs/01J9X…/stream" }
```

Behavior:

- Reject `stdio` transport from the public web UI (security: arbitrary command execution). Stdio runs only via the CLI on user machines.
- Rate-limit to 5 concurrent jobs per IP; queue beyond that.
- Validate `url` is `http(s)://`; reject internal-IP ranges via the same patterns used in [`src/runner.ts:51-59`](../src/runner.ts).
- Hash the URL with the same scheme as `urlHash()` in [`src/badge.ts:8`](../src/badge.ts) so the resulting `<hash>` matches CLI-generated badge URLs.

### GET /compliance/jobs/<jobId>/stream

SSE stream. Events:

```
event: test
data: { "id": "transport-post", "name": "...", "category": "transport", "passed": true, "required": true, "details": "HTTP 200", "durationMs": 42, "specRef": "..." }

event: test
data: { ... }

event: complete
data: { "hash": "abc123…", "reportUrl": "/compliance/ext/abc123…", "grade": "A", "score": 92.5 }

event: error
data: { "message": "Server unreachable" }
```

Implementation: spawn `runComplianceSuite()` on a worker, pipe `onTestComplete` callbacks into the SSE response. The full report (final return value) is stored in the DB before the `complete` event fires.

---

## Storage model

Postgres tables (or equivalent):

```sql
CREATE TABLE compliance_reports (
  hash           TEXT PRIMARY KEY,           -- 24-char URL hash
  url            TEXT NOT NULL,              -- the tested URL
  schema_version TEXT NOT NULL,              -- pin against; reject unknown
  spec_version   TEXT NOT NULL,
  tool_version   TEXT NOT NULL,
  report         JSONB NOT NULL,             -- the full ComplianceReport
  grade          CHAR(1) NOT NULL,           -- denormalized for index
  score          NUMERIC(5,2) NOT NULL,      -- denormalized for index
  tested_at      TIMESTAMPTZ NOT NULL,
  published      BOOLEAN NOT NULL DEFAULT TRUE,
  owner_verified BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON compliance_reports (grade, score DESC) WHERE published;
CREATE INDEX ON compliance_reports (tested_at DESC) WHERE published;

CREATE TABLE compliance_jobs (
  id          TEXT PRIMARY KEY,             -- ULID
  url         TEXT NOT NULL,
  hash        TEXT NOT NULL,
  status      TEXT NOT NULL,                -- queued | running | complete | error
  started_at  TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  error       TEXT
);
```

Validate every `report` blob against `schemas/report.v1.json` on insert. Reject inserts where `schemaVersion` is unknown — never guess at the shape.

---

## Badge API

`GET /api/compliance/ext/<hash>/badge` → SVG.

Color-coded by grade:

| Grade | Color (hex) | Label |
|---|---|---|
| A | `#3fb950` (green) | A — MCP Compliant |
| B | `#7cba2c` (lime) | B — MCP Compliant |
| C | `#d29922` (yellow) | C — MCP Partial |
| D | `#db6d28` (orange) | D — MCP Partial |
| F | `#f85149` (red) | F — Not Compliant |

Constraints:

- Size ≤ 2 KB.
- `<title>` element: `MCP Compliance: Grade <X> (<score>%)` for screen readers.
- shields.io-compatible width/height so it lines up next to other badges in a README.
- `Cache-Control: public, max-age=3600, s-maxage=3600`. Invalidate on re-test.
- If hash unknown: 404 SVG with neutral "untested" badge (do **not** 500).

---

## Report page (`/compliance/ext/<hash>`)

Server-rendered, mobile-first, social-share-optimized.

Required sections (in order):

1. **Hero**: server URL (truncated), grade letter (large), score, tested-at date, "Re-test" button.
2. **Verdict**: `pass | partial | fail` with one-sentence summary.
3. **Category breakdown**: bar per category with `passed/total`. Click → filter the test list.
4. **Test list**: every test, grouped by category. Each row: status icon, name, details, link to spec, link to per-test explainer page.
5. **Server info**: protocol version, name, version, capabilities, tool/resource/prompt counts.
6. **Embed your badge**: copy-paste markdown + HTML snippets.
7. **Footer**: "Tested with mcp-compliance v<toolVersion> against MCP spec <specVersion>. Not affiliated with Anthropic."

Open Graph metadata:

```html
<meta property="og:title" content="MCP Compliance: Grade A (92%) — example.com">
<meta property="og:image" content="https://mcp.hosting/api/compliance/ext/<hash>/og.png">
<meta property="og:description" content="75/81 tests passed. Tested 2026-04-12.">
```

The `og.png` is generated from the badge + summary at request time (or pre-generated on report insert).

---

## Per-test explainer pages (`/compliance/tests/<test-id>`)

81 pages, one per test. Content seeded from `TEST_DEFINITIONS` in [`src/types.ts`](../src/types.ts) and the `explain` MCP tool output.

Each page:

- **What it tests** — `description` from `TestDefinition`.
- **Why it matters** — written content (not auto-generated).
- **Spec reference** — deep link to the relevant spec section using `SPEC_BASE` + `specRef`.
- **Common failure modes** — written content.
- **How to fix** — `recommendation` from `TestDefinition`, expanded.
- **Servers that pass / fail this test** — auto-populated from the leaderboard data.

This is the SEO engine. Each page targets a niche search term; together they form the authority moat. No stub pages — every page must have real "Why it matters" and "Common failure modes" content before launch.

---

## Leaderboard (`/compliance/leaderboard`)

Default view: top 50 by grade then score, descending.

Filters:

- Grade (`A` / `B` / `C` / `D` / `F`)
- Transport (`http` only — stdio servers can't be publicly tested)
- Spec version (e.g. `2025-11-25`)
- Category — show only servers that pass all of `tools`, `security`, etc.
- Tested within (24h / 7d / 30d / all)

Sidebar: "Recently tested" (10 most recent, regardless of grade).

### Owner verification & delisting

Server owners can claim or delist their entry via:

- **DNS TXT challenge**: `_mcp-compliance.<host>` containing a token issued by mcp.hosting.
- **Email-from-domain**: send a request from any `@<host>` address.

Verified owners get:

- A "verified" badge on their leaderboard entry.
- The ability to delist or hide their server.
- Email notifications when their grade changes.

Unverified entries can be delisted on request (lower friction; just email support).

### Auto-retest

Verified entries are auto-retested monthly. If the grade drops, the owner is emailed. Public leaderboard always shows the most recent result.

---

## Router integration (`mcp.hosting` smart-routing MCP)

When the smart-routing MCP discovers or proxies a target server:

1. Look up the target's compliance grade by hashing its URL.
2. If found, surface in discovery output: `{ url, name, grade: "A", score: 92.5, testedAt: "..." }`.
3. If not found, optionally trigger a background test (rate-limited).
4. Optional admin setting: `minGrade: "B"` — refuse to route to servers below threshold.

This is what makes the grade actually matter — servers with bad grades become invisible to a default `mcp.hosting` install.

---

## Quality gates for Phase 2

Before launch:

- [ ] Badge renders correctly in GitHub README markdown preview (mobile + desktop).
- [ ] Report page loads in <1s on cold cache, <200ms warm.
- [ ] All 81 explainer pages have populated "Why it matters" and "Common failure modes" sections — no stubs.
- [ ] Leaderboard has ≥20 seeded entries from `modelcontextprotocol/servers` and top community servers.
- [ ] Open Graph image renders correctly when shared on Twitter/Slack/Discord.
- [ ] Re-testing a server invalidates the badge and report cache within 30s.
- [ ] DNS TXT verification flow works end-to-end.
- [ ] Router integration shows grades in discovery output for at least one default-routed server.
- [ ] `schemas/report.v1.json` is fetched and validated on every insert; bad reports rejected with a clear error.

Cross-cutting:

- [ ] `https://mcp.hosting/schemas/compliance/report.v1.json` resolves to the schema (matches the `$id`).
- [ ] mcpcompliance.io / .net / .sh redirect 301 to `https://mcp.hosting/compliance`.
- [ ] Footer on every compliance page includes "Not affiliated with Anthropic. Model Context Protocol is developed by Anthropic."

---

## Versioning & forward-compat

- mcp.hosting pins against `schemaVersion: "1"`. When this repo bumps to `"2"`, mcp.hosting:
  1. Continues serving v1 reports from existing storage.
  2. Stands up a v2 ingestion path against the new schema.
  3. Migrates or dual-writes during transition; never silently mixes shapes.
- `toolVersion` is informational, never branched on.
- `specVersion` drives the displayed "tested against" string; old reports stay valid for their version with a "regrade against latest" CTA.

---

## Open questions for Jeff

1. Where does the test-runner worker live? Same Node process as the API, or a separate queue (e.g. Cloudflare Workers + Durable Objects, or BullMQ on a node)?
2. Owner verification: DNS TXT only, or also support a `.well-known/mcp-compliance-owner` file?
3. Should re-test be public-callable (anyone can trigger), or rate-limited per-IP, or owner-only after verification?
4. Open Graph image: pre-generate on insert (storage cost, fast serve) or render-on-request (cheaper storage, slower first hit)?
5. Per-test explainer content: who writes it? (81 pages × ~300 words = ~24k words. Could be AI-drafted then human-edited, or fully ghostwritten.)

These don't block Phase 2 design but should be settled before implementation starts.
