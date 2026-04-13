# Spec clarification PR drafts

Drafts for PRs we (Yaw Labs) intend to submit to [`modelcontextprotocol/specification`](https://github.com/modelcontextprotocol/specification). Each one captures an ambiguity we've hit while building `mcp-compliance` and proposes specific clarifying language.

These are **drafts** — final wording + actual PRs should be opened by whoever has the relationship with the MCP project maintainers.

| Draft | What it clarifies |
|---|---|
| [01-reinit-reject.md](./01-reinit-reject.md) | Whether servers MUST reject a second `initialize` on the same session |
| [02-meta-field-tolerance.md](./02-meta-field-tolerance.md) | Whether servers MUST accept unknown `_meta` keys on requests |
| [03-stdio-malformed-line.md](./03-stdio-malformed-line.md) | How stdio servers SHOULD handle malformed input lines |
| [04-error-on-batch.md](./04-error-on-batch.md) | What specific error code servers should return for JSON-RPC batch arrays |
| [05-tool-cross-reference.md](./05-tool-cross-reference.md) | Advisory: tool descriptions referencing other tools by name |

All drafts follow the same structure: **Problem**, **Proposed wording change**, **Rationale**, **Backwards-compat considerations**.
