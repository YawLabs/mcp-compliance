# Top MCP servers — compliance results

Generated 2026-04-13T06:05:23.308Z. 7 servers tested.

| Server | Package | Grade | Score | Passed | Failed | Required | Notes |
|---|---|---|---|---|---|---|---|
| Filesystem | `@modelcontextprotocol/server-filesystem` | A | 99 | 44/45 | 1 | 10/10 | Reference — read/write files under a sandbox root |
| Memory | `@modelcontextprotocol/server-memory` | A | 100 | 45/45 | 0 | 10/10 | Reference — knowledge-graph-style memory |
| Sequential Thinking | `@modelcontextprotocol/server-sequential-thinking` | A | 100 | 45/45 | 0 | 10/10 | Reference — structured reasoning steps |
| Puppeteer | `@modelcontextprotocol/server-puppeteer` | A | 99 | 49/50 | 1 | 12/12 | Reference — browser automation (slow boot: downloads chrome) |
| Everything | `@modelcontextprotocol/server-everything` | A | 98 | 53/55 | 2 | 17/17 | Reference — demo server exercising all capabilities |
| GitHub | `@modelcontextprotocol/server-github` | skipped |  | — |  | — | GitHub repo/issue/PR ops (needs PAT) |
| Slack | `@modelcontextprotocol/server-slack` | skipped |  | — |  | — | Slack channel/message ops (needs bot token) |
