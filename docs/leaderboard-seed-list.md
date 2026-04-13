# Leaderboard seed list

Target: ≥20 publicly-testable MCP servers tested before public launch so the leaderboard at `mcp.hosting/compliance/leaderboard` looks alive on day one.

**Sources of truth:**
- [`modelcontextprotocol/servers`](https://github.com/modelcontextprotocol/servers) — Anthropic's reference server collection.
- Anthropic's [docs/example-servers](https://docs.anthropic.com/en/docs/claude-code/mcp) catalog.
- npm: search `@modelcontextprotocol/server-*` and `mcp-server-*` for community packages.
- The various `awesome-mcp-servers` lists on GitHub (cross-reference for download counts).
- Major SaaS vendors who've shipped first-party MCP servers (Linear, GitHub, Sentry, Cloudflare, etc).

## How to seed

These are mostly **stdio servers**, so the public web UI can't test them (stdio rejected for security — see integration spec). The seed run uses the CLI on a Yaw Labs machine:

```bash
mcp-compliance test --transport stdio --command "npx @modelcontextprotocol/server-filesystem /tmp" --format json --output reports/server-filesystem.json
```

Then ingest each `report.json` into the mcp.hosting Postgres via a small admin endpoint (one-shot script, not a public API).

For HTTP servers (the second table), the public web UI works directly.

## Stdio servers — Anthropic reference (modelcontextprotocol/servers)

| Server | npm package | Notes |
|---|---|---|
| Filesystem | `@modelcontextprotocol/server-filesystem` | high download count; canonical example |
| Git | `@modelcontextprotocol/server-git` | python wrapper |
| GitHub | `@modelcontextprotocol/server-github` | requires GITHUB_PERSONAL_ACCESS_TOKEN |
| GitLab | `@modelcontextprotocol/server-gitlab` | requires GITLAB_PERSONAL_ACCESS_TOKEN |
| Google Drive | `@modelcontextprotocol/server-gdrive` | OAuth flow; harder to seed |
| Postgres | `@modelcontextprotocol/server-postgres` | needs a DB URL |
| Sqlite | `@modelcontextprotocol/server-sqlite` | self-contained, easy seed |
| Slack | `@modelcontextprotocol/server-slack` | requires bot token |
| Memory | `@modelcontextprotocol/server-memory` | self-contained, easy seed |
| Puppeteer | `@modelcontextprotocol/server-puppeteer` | self-contained, easy seed |
| Brave Search | `@modelcontextprotocol/server-brave-search` | requires API key |
| Sentry | `@modelcontextprotocol/server-sentry` | requires sentry token |
| Sequential Thinking | `@modelcontextprotocol/server-sequentialthinking` | self-contained |
| EverArt | `@modelcontextprotocol/server-everart` | requires API key |
| Fetch | `@modelcontextprotocol/server-fetch` | python; self-contained |
| Time | `@modelcontextprotocol/server-time` | self-contained, trivial seed |

Of these, the **easy seed-day-one set** (no auth required) is: Filesystem, Sqlite, Memory, Puppeteer, Sequential Thinking, Fetch, Time, Git. That's 8 free hits.

For auth-required servers, set up Yaw Labs–scoped tokens (read-only where possible) and run them once.

## Stdio servers — community / vendor

| Server | Source | Auth |
|---|---|---|
| Linear | `@linear/mcp-server` (or vendor-published) | OAuth |
| GitHub Enterprise | community fork of `server-github` | PAT |
| Notion | vendor or community | OAuth |
| Stripe | community | API key |
| Supabase | vendor | API key |
| Cloudflare | vendor | API token |
| AWS S3 | community `mcp-server-aws-s3` | AWS creds |
| Obsidian | community `mcp-server-obsidian` | local file path |
| Apple Notes | community `mcp-server-apple-notes` | macOS-only |
| Spotify | community `mcp-server-spotify` | OAuth |
| Tailscale | `@yawlabs/tailscale-mcp` (this org!) | API key — already on hand |
| LemonSqueezy | `@yawlabs/lemonsqueezy-mcp` (this org!) | API key — already on hand |
| npmjs | `@yawlabs/npmjs-mcp` (this org!) | npm token — already on hand |

The three Yaw Labs–owned servers should be seeded first; they're authoritative dogfood and we already have the credentials. Their reports also get to be the first "real-world" examples on the leaderboard.

## HTTP servers (testable via public web UI)

These are remote MCP servers reachable over Streamable HTTP. The public web UI at `mcp.hosting/compliance` can test them directly without needing a CLI run.

| Server | URL pattern | Notes |
|---|---|---|
| `mcp.hosting` smart-routing MCP | `https://mcp.hosting/<config-id>` | dogfood — the host platform tests itself |
| Cloudflare's `mcp-server-cloudflare` HTTP variant | TBD | check vendor docs |
| Vercel's MCP gateway | TBD | recently announced |
| OpenAI's hosted MCPs (if any) | TBD | speculative |
| Replit's MCP integration | TBD | speculative |

The HTTP server set is sparse today because most public MCPs are still stdio. **This is fine** — it's a competitive moat. As more remote MCPs ship, the leaderboard becomes the natural place they get evaluated.

## Pre-launch courtesy contact

Before listing publicly, email each server owner:

> Hi — Yaw Labs is launching a public MCP server compliance leaderboard at mcp.hosting/compliance. We're including [server-name] in the seed set; here's the report we generated: [link]. If you'd like to opt out, claim ownership for the verified badge, or fix anything before we go public, just reply. We're holding launch for [N] days.

Tone: courteous, low-pressure, no "you must respond." A `Reply-To: support+compliance@yaw.sh` for tracking.

Owners who reply with fixes get re-tested before launch (free QA for them, fresh data for us).

## Day-of-launch state

The leaderboard at first paint should show:

- **≥20 entries total** (mix of A, B, C grades — pure As look fake).
- **≥3 verified entries** (the Yaw Labs ones via DNS TXT) so the verified flow is demonstrably working.
- **≥1 entry per category passing 100%** (proves the test categories are achievable).
- **A "recently tested" sidebar** with at least 5 entries timestamped within the last 24h.

If we can't hit those marks, delay launch. An empty leaderboard is worse than a delayed launch.

## Owner outreach tracking

| Server | Contact | Sent | Replied | Outcome |
|---|---|---|---|---|
| (to fill in during seeding run) | | | | |
