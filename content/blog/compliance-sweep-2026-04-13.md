---
title: "We ran compliance tests against every Anthropic-official npm MCP server. Here's what we found."
date: 2026-04-13
author: Yaw Labs
tags: [mcp, compliance, ecosystem]
---

**tl;dr — 5 out of 5 tested reference MCP servers pass the compliance suite at grade A (98–100%).** Zero required-test failures across the lot. Single failures were all on an advisory check (tool descriptions mentioning other tools by name). The reference implementations are solid; the question this opens is whether the community long tail is similarly clean.

## What we tested

Every `@modelcontextprotocol/server-*` package that's actually published on npm:

| Server | Package | Grade | Score | Passed | Failed | Required |
|---|---|---|---|---|---|---|
| Filesystem | `@modelcontextprotocol/server-filesystem` | A | 99 | 44/45 | 1 | 10/10 |
| Memory | `@modelcontextprotocol/server-memory` | A | 100 | 45/45 | 0 | 10/10 |
| Sequential Thinking | `@modelcontextprotocol/server-sequential-thinking` | A | 100 | 45/45 | 0 | 10/10 |
| Puppeteer | `@modelcontextprotocol/server-puppeteer` | A | 99 | 49/50 | 1 | 12/12 |
| Everything | `@modelcontextprotocol/server-everything` | A | 98 | 53/55 | 2 | 17/17 |

All ran locally over stdio via `npx -y`. Full sweep completes in ~30 seconds (most of that is puppeteer downloading Chrome on first run).

## What we *couldn't* test (from npm)

Four commonly-cited "official" servers aren't actually on npm: `server-git`, `server-fetch`, `server-time`, `server-sqlite`. They live on PyPI and ship via `uvx`. Our CLI is Node-only, so they show up as `404 Not Found` from the npm registry. That's a gap — there's a non-trivial split in the reference ecosystem where server language choice dictates the installation surface, and compliance tooling has to support both.

Two others need credentials we don't keep in CI: `server-github` (needs a Personal Access Token), `server-slack` (needs a bot token + team ID). These were cleanly skipped with `status: "skipped-missing-env"` rather than silently passing.

## What the single failures actually are

Every failure in this sweep is the same optional check: `security-tool-cross-reference`. This test flags tool descriptions that mention other tools by name. The `read_file` tool in `server-filesystem`, for instance, says "use `read_text_file` for text files" — the test catches this because LLM agents have a habit of getting confused when tools reference each other in their descriptions. The `everything` server triggers it in two places because it's a demo server intentionally exercising the edge case.

None of these are bugs. They're advisory at most. We've drafted a spec clarification PR proposing to formalize the advisory (`docs/spec-prs/05-tool-cross-reference.md` in the repo) because today it's ambiguous whether this is a SHOULD or just a style choice.

**Takeaway**: the reference MCP servers are compliant at the letter-of-the-spec level. Zero required-test failures. The ecosystem isn't rotten — the core is in good shape.

## What we didn't test: the community long tail

npm has dozens of third-party MCP servers: connectors for Postgres, Notion, Linear, Figma, Jira, and plenty of specialized vertical tools. We haven't tested any of them. This is the actual interesting question: when a developer adopts a random MCP server from npm, what's the odds it passes? We suspect much worse than 100%, but we don't have the data yet.

Two ways to close that gap:

1. **Submit your own server**: run the CLI, get a badge on your README.
   ```bash
   npx @yawlabs/mcp-compliance badge <your-url>
   ```
2. **Publish results for a server you use**: point the CLI at it, share the report. The public leaderboard at `mcp.hosting/explore/compliance` will aggregate these.

## How we ran this

One command (from [the `mcp-compliance` repo](https://github.com/YawLabs/mcp-compliance)):

```bash
node --import tsx scripts/run-top-servers.ts
```

The script lives at [`scripts/run-top-servers.ts`](https://github.com/YawLabs/mcp-compliance/blob/master/scripts/run-top-servers.ts). It's a curated list — not an npm-registry crawler — because we want to be deliberate about what we're running and blocking on credentials/setup for every server. Adding a server is a 5-line PR. Anyone can run this; it doesn't touch any network resources beyond `npm install` for each server and the server's own behavior.

Raw data is in [`data/top-servers-results.json`](https://github.com/YawLabs/mcp-compliance/blob/master/data/top-servers-results.json) and a human-readable table at [`data/top-servers-results.md`](https://github.com/YawLabs/mcp-compliance/blob/master/data/top-servers-results.md). Both are committed to the repo and update when the script is rerun.

## What comes next

- **Quarterly reruns**. The MCP spec evolves (2025-11-25 → eventually 2026-something), reference servers get updates. This isn't a one-time benchmark.
- **uvx / PyPI transport**. Today the CLI spawns Node commands. Adding uvx support unlocks the Python half of the reference ecosystem without changing the test suite itself.
- **Community leaderboard**. The backend at [mcp.hosting](https://mcp.hosting) has the data model; the dashboard `/explore/compliance` route is next.
- **Spec PRs**. We've drafted clarifications for 5 ambiguous corners the test suite had to guess at. They're at [`docs/spec-prs/`](https://github.com/YawLabs/mcp-compliance/tree/master/docs/spec-prs) in the repo. Eventually, those go upstream.

The compliance suite itself is at [88 tests across 8 categories](https://github.com/YawLabs/mcp-compliance) (MIT-licensed). It runs locally, on CI, or against the hosted badge service. If you ship an MCP server on npm, running it takes 30 seconds and tells you exactly where you stand against the spec.
