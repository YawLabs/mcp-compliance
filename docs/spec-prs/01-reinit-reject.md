# Clarify handling of duplicate `initialize` requests

## Problem

The current spec (`basic/lifecycle`) says the `initialize` method SHOULD be the first message in a session. It does not say what a server MUST do if a second `initialize` arrives on an already-initialized session.

Different implementations do different things:
- TypeScript SDK's `Server` class throws on re-init
- Python SDK ignores re-init silently
- `@modelcontextprotocol/server-filesystem` accepts re-init and resets state

Compliance tooling can't decide whether this is a pass or fail. The ambiguity also creates real interop risk — a client that sends an initialize twice (e.g., after a reconnect) will see radically different behavior depending on server implementation.

## Proposed wording change

Add to `basic/lifecycle#initialization`:

> After the initialization phase completes successfully, the server **MUST** reject subsequent `initialize` requests on the same session with a JSON-RPC error (code `-32600`, message "Already initialized"). The server **MUST NOT** reset session state in response to a duplicate `initialize`. If a client needs to re-initialize, it **MUST** create a new session (HTTP: new `Mcp-Session-Id`; stdio: new child process).

## Rationale

- Prevents accidental state resets on client bugs.
- Makes session lifecycle deterministic — once initialized, a session stays initialized until closed.
- Matches the behavior of the most-widely-used SDK (TypeScript), so adoption cost is low.
- Makes compliance tooling unambiguous — one rule applies everywhere.

## Backwards-compat considerations

Servers that currently accept re-init (like `server-filesystem`) would need a patch release. No known clients depend on re-init behavior, so this is a server-only change.
