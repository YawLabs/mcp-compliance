# Clarify handling of duplicate `initialize` requests

**Status:** draft, ready for submission
**Target:** `modelcontextprotocol/specification`
**Related:** [04-error-on-batch.md](./04-error-on-batch.md) (both concern request-level validation)

## Problem

The current spec (`basic/lifecycle#initialization`) says the `initialize` method SHOULD be the first message in a session. It does not say what a server MUST do if a second `initialize` arrives on an already-initialized session.

Different implementations make different choices today:

- TypeScript SDK's `Server` class throws on re-init (rejects the request).
- Python SDK ignores re-init silently (accepts; does nothing).
- `@modelcontextprotocol/server-filesystem` accepts re-init and resets session state.

This creates three concrete interop problems:

1. **Compliance tooling ambiguity.** A test suite can't decide whether "accepts duplicate initialize" is a pass, a fail, or a skip without guessing at intent.
2. **Client-side reconnect bugs.** A client that sends `initialize` twice (for example, after a transient disconnect it didn't notice finished) sees wildly different outcomes across servers: some work, some reset its tool list silently, some throw.
3. **Surprise state resets.** The silent-reset behavior is the worst outcome — the session "still works" but its declared capabilities may have changed, and nothing in the protocol surfaces that to the client.

## Proposed wording change

Add to `basic/lifecycle#initialization`:

> After the initialization phase completes successfully, the server **MUST** reject subsequent `initialize` requests on the same session with a JSON-RPC error (code `-32600`, message `"Already initialized"`). The server **MUST NOT** reset session state in response to a duplicate `initialize`.
>
> If a client needs to re-initialize, it **MUST** create a new session: over Streamable HTTP, by dropping the current `Mcp-Session-Id` and letting the server issue a new one; over stdio, by terminating the child process and spawning a new one.

## Rationale

- Prevents accidental state resets caused by client bugs that would otherwise be invisible.
- Makes session lifecycle deterministic: once initialized, a session stays initialized until it's explicitly closed.
- Matches the behavior of the most-widely-used SDK (TypeScript), so migration cost is low.
- Gives compliance tooling an unambiguous rule instead of a guess.

## Backwards-compat migration

**Server-side impact:** Servers currently accepting re-init (notably `@modelcontextprotocol/server-filesystem` as of this writing) need a patch release to start rejecting. The rejection is a single additional guard in the `initialize` handler — no complex state migration.

**Client-side impact:** Clients that send `initialize` twice *on purpose* need to switch to opening a new session instead. No known clients do this.

**Rollout plan:**
1. Spec ships the clarification as a SHOULD for one release cycle, paired with an advisory test in compliance tooling that warns but doesn't fail.
2. Next spec release promotes SHOULD → MUST.
3. Reference implementations ship the rejection before the MUST lands, so they're already compliant when the tightening takes effect.

## Submit the PR

When ready to submit (from a clone of `modelcontextprotocol/specification`):

```bash
# Fork and clone
gh repo fork modelcontextprotocol/specification --clone
cd specification

# Create branch
git checkout -b yawlabs/clarify-reinit-reject

# Edit the spec doc (typically docs/specification/basic/lifecycle.mdx or similar)
# Apply the wording change from the "Proposed wording change" section above.

# Commit + push
git add docs/specification/basic/lifecycle.mdx
git commit -m "Clarify: servers MUST reject duplicate initialize on the same session"
git push origin yawlabs/clarify-reinit-reject

# Open PR using the body from this file
gh pr create \
  --title "Clarify: servers MUST reject duplicate initialize on the same session" \
  --body-file ../mcp-compliance/docs/spec-prs/01-reinit-reject.md \
  --base main
```
