# Specify stdio behavior on malformed lines

**Status:** draft, ready for submission
**Target:** `modelcontextprotocol/specification`
**Related:** [04-error-on-batch.md](./04-error-on-batch.md) (both constrain server response to malformed input)

## Problem

`basic/transports#stdio` defines line-delimited JSON framing on stdin/stdout but doesn't specify what servers should do when they receive input that isn't a valid JSON-RPC 2.0 message. Observed variance in the wild, in order of frequency:

- **Some servers silently drop the line** and continue reading. (Most JSON-RPC frameworks default to this.)
- **Some emit `-32700 Parse error`** with `id: null` and continue.
- **Some crash or exit** when their parser throws an unhandled exception.
- **Some emit startup banners to stdout** (before receiving any input), producing bytes that a client's line-parser correctly rejects as invalid JSON — cascading into a false failure.

Each of these is "fine" in isolation; together, clients can't write a coherent handler for "bad input from server" because the behavior varies.

## Proposed wording change

Add to `basic/transports#stdio`:

> A stdio server **MUST NOT** terminate the process upon receiving an unparseable line on stdin. Recommended behavior, in order of preference:
>
> 1. **Invalid UTF-8 or invalid JSON:** the server **SHOULD** silently ignore the line (emit no response). The server **MUST** continue reading subsequent lines.
> 2. **Valid JSON but not a valid JSON-RPC 2.0 message** (missing `jsonrpc`, missing `method`, or the message is neither a request nor a notification per the JSON-RPC spec): the server **SHOULD** respond with a JSON-RPC error message using `id: null`, code `-32600` ("Invalid Request"), and then continue.
> 3. **Valid JSON-RPC 2.0 message with unknown method:** servers MUST respond with error code `-32601` ("Method not found") on the request's `id` and continue. (This rule already exists in `basic/errors`; repeated here for completeness.)
>
> Non-JSON output on stdout is **prohibited**. Servers **MUST** write all diagnostic output (startup banners, log messages, progress indicators, colored status) to stderr. Clients are entitled to treat non-JSON bytes on stdout as a server bug.

## Rationale

- Turns three undefined corners into three well-defined protocol requirements.
- The third rule (non-JSON on stdout prohibited) catches a common class of bug where a server prints "Ready on port 3000\n" to stdout before first accepting a request, breaking clients that strictly parse line-framed JSON.
- Aligns the response codes with the JSON-RPC 2.0 spec's existing conventions.
- Gives compliance tooling three concrete failure signals instead of a guess.

## Backwards-compat migration

**Server-side impact:**

- Servers that terminate on parse errors need a try/catch around parsing. One-line fix.
- Servers printing to stdout on startup (we've seen this in ~10% of third-party MCP servers) need to switch those prints to stderr. One-line fix per print.
- Servers that already silently drop invalid lines or respond with `-32600` are already compliant.

**Client-side impact:** None. This defines existing best practice; clients that already tolerate the variance keep working.

**Rollout plan:**
1. Ship clarification as a MUST (non-termination) + SHOULDs (specific error codes) + MUST (no stdout banners) in one release.
2. Compliance tooling's `stdio-framing` test already catches (3) via probing rapid pings; it will naturally surface servers that break the rule.

## Submit the PR

```bash
gh repo fork modelcontextprotocol/specification --clone
cd specification
git checkout -b yawlabs/stdio-malformed-line-behavior

# Edit basic/transports.mdx (or whatever the stdio transport page is called).

git add docs/specification/basic/transports.mdx
git commit -m "Specify stdio server behavior on malformed input lines"
git push origin yawlabs/stdio-malformed-line-behavior

gh pr create \
  --title "Specify stdio server behavior on malformed input lines" \
  --body-file ../mcp-compliance/docs/spec-prs/03-stdio-malformed-line.md \
  --base main
```
