# Why `mcp-compliance`

## The problem

The Model Context Protocol is two years old, has an official specification, and a rapidly growing ecosystem of servers — hundreds on npm, PyPI, and uvx. But almost none of them are tested against the spec.

This leads to predictable failures:

- A server returns `400` instead of `-32601` for unknown methods. Clients that follow the spec silently stop working.
- An HTTP MCP server forgets to return `202 Accepted` for notifications and returns `200 OK` with an empty body. Clients hang waiting for a response that was never promised.
- Tool input schemas miss the `type: "object"` wrapper. Some clients handle it, others reject the tool.
- Session ID headers are missing, malformed, or collide between clients. Debugging is a nightmare.
- A server happily executes command injection in tool parameters because the author never thought to sanitize shell metacharacters.

These aren't obscure corner cases. They're the top failures we've seen running compliance tests against dozens of real MCP servers, including the official reference implementations.

## Why existing tools don't cover this

**Unit tests don't test the spec.** A server's own tests verify its own logic. They don't verify whether `-32601` comes back for unknown methods, whether notifications return `202`, whether JSON-RPC batching is correctly rejected, whether session IDs have enough entropy.

**MCP Inspector verifies one flow at a time.** It's a great manual debug tool. You drive a server interactively, see what it returns, eyeball whether it looks right. But it's a human-in-the-loop check, not a CI gate. Servers regress; inspectors don't catch regressions.

**The official spec has no reference test suite.** Anthropic published the protocol spec but not a conformance test battery. Implementers read the spec, write their server, and hope they got it right. There's no authoritative "you passed."

**Existing JSON-RPC test tools don't know MCP.** Generic JSON-RPC fuzzers don't know about `initialize` handshake semantics, capability negotiation, the Streamable HTTP transport's session model, MCP error code expectations, or the spec's rules for tool schemas.

## What `mcp-compliance` does

**88 tests across 8 categories, written against the published spec.** Every test cites the exact section of the spec it verifies. Every failure links to the spec reference. No ambiguity about what's being tested or why.

**Works against every transport.** HTTP and stdio servers alike. Point it at `https://my-server.com/mcp` or `node ./dist/server.js` or `npx -y @modelcontextprotocol/server-filesystem` — same suite, same grading, same output.

**Capability-gated.** If your server declares `tools`, the tools tests become required. If it doesn't, they're skipped. No penalty for not implementing optional features, no false passes for features the server claims but fails.

**Five output formats.** Terminal for humans, JSON for scripts, SARIF for GitHub Code Scanning, GitHub Actions annotations for PR inline comments, Markdown for issue/PR bodies, HTML for shareable dashboards.

**CI-native.** `--strict` exits non-zero on any required failure. `--min-grade A` exits non-zero if your grade slips. `diff` command compares runs. Official GitHub Action wraps the whole thing into 5 lines of YAML.

**Shareable badges.** `mcp-compliance badge <url>` publishes to [mcp.hosting](https://mcp.hosting) and gives you markdown for your README. Badges update live — whoever runs the test most recently, on any CI, any machine, updates the public badge.

**Graded scoring.** Not a binary pass/fail — an A–F grade weighted 70% on required tests, 30% on optional. One number that says "how compliant is this server" without reducing a 85-test result to a single bit.

## Who this is for

**MCP server authors** — know if your server is actually spec-compliant before users find out. Add the GitHub Action to your repo; get a badge on your README. The badge is a trust signal to potential users.

**Teams evaluating MCP servers to deploy** — run the suite against any candidate server. Compare grades. Spot the security issues before production.

**Client authors** — verify the assumptions you're making about server behavior. If your client assumes servers return `-32601` for unknown methods and 12% of servers actually return `400`, your client is broken. Know where the spec is aspirational vs actually followed.

**The MCP community** — a shared reference for "spec-compliant" that's not ambiguous. A way to point at a server and say "Grade F on session handling, don't use it yet" without writing a test script from scratch.

## Who maintains this

Built and maintained by [Yaw Labs](https://yaw.sh). The tool is MIT-licensed; the underlying [testing methodology](../COMPLIANCE_RUBRIC.md) is CC BY 4.0. Both are designed to be forkable and independently implementable — we want other vendors to publish compatible tooling, not lock the ecosystem into one implementation.

The companion mcp.hosting service hosts the public badge and report pages and is free for any MCP server author. Paid tiers around bulk/scheduled/private testing exist for organizations with larger ops needs; see [ENTERPRISE.md](./ENTERPRISE.md).

## What "spec compliance" actually buys you

Three things:

1. **Interoperability.** Spec-compliant servers work with spec-compliant clients without custom adapter code. This is the whole point of a protocol.
2. **Debuggability.** When something breaks, spec compliance narrows the search. If a client can't initialize against your server, you check `lifecycle-init` and `lifecycle-proto-version` first, not dive into your handshake code blind.
3. **Security.** MCP servers touch tools (filesystem, shell, databases, web APIs) that clients trust. A server that fails injection or path-traversal tests is a server that leaks its host — or worse, executes whatever an LLM hallucinates. Spec-level security checks catch obvious mistakes before they ship.

## What spec compliance doesn't buy you

- It doesn't mean your server's actual tool logic is correct. A compliant filesystem server still needs to read files correctly.
- It doesn't mean your server is fast. Compliance is correctness; use the `benchmark` command for performance.
- It doesn't replace security review for production deployment. Our security tests cover the obvious gaps (auth header required, rate limiting, injection resistance) but don't substitute for threat modeling.

The best analogue is a linter: passing lint doesn't prove your code is good, but failing lint strongly suggests it isn't.
