# Clarify error response for JSON-RPC batch requests

**Status:** draft, ready for submission
**Target:** `modelcontextprotocol/specification`
**Related:** [01-reinit-reject.md](./01-reinit-reject.md), [03-stdio-malformed-line.md](./03-stdio-malformed-line.md) (all three concern server response to invalid-request shapes)

## Problem

MCP forbids JSON-RPC 2.0 batch requests — arrays of message objects. `basic/transports#streamable-http` says servers "must not" process batches, but doesn't say what shape the rejection takes.

Observed variance in the wild:

- `HTTP 400` with an empty body
- `HTTP 400` with a JSON-RPC error body, error code `-32600` (Invalid Request)
- `HTTP 415` Unsupported Media Type
- `HTTP 200` with a JSON-RPC error body (contradicting MCP's own "not 200" guidance)
- A single response object echoed back, as if the server pulled the first batch member and processed it (most problematic — silently discards everything else)

Clients can't write a coherent batch-rejection handler against this. Worse, the last behavior (silent partial processing) means a client sending a batch to a misbehaving server gets a mostly-wrong result with no surface signal that batching was rejected.

## Proposed wording change

Add to `basic/transports#streamable-http` (and mirror the same text in `basic/transports#stdio` for stdio consistency):

> When a server receives a JSON body that parses as an array — indicating a JSON-RPC 2.0 batch request — it **MUST** reject the request with the following shape:
>
> **Over Streamable HTTP:** respond with HTTP status `400 Bad Request` and the body:
> ```json
> {
>   "jsonrpc": "2.0",
>   "id": null,
>   "error": {
>     "code": -32600,
>     "message": "Batch requests are not supported in MCP"
>   }
> }
> ```
>
> **Over stdio:** write the same JSON body on a single line to stdout. (Stdio has no HTTP status code; the JSON-RPC error is the entire signal.)
>
> The `id` field **MUST** be `null` — a batch has no single id to correlate against, and the JSON-RPC 2.0 spec reserves `null` exactly for this case. The server **MUST NOT** process any member of the batch and **MUST NOT** return multiple response messages as a batch.
>
> Clients **SHOULD** treat this response as fatal to the batch. Retrying individual messages as separate, non-batched requests is acceptable.

## Rationale

- One canonical rejection shape across the ecosystem.
- Uses `-32600 Invalid Request` — the JSON-RPC 2.0 error code most semantically appropriate, since a batch is not a valid MCP request structure.
- `id: null` follows the JSON-RPC 2.0 spec's own convention for errors where no specific id can be returned.
- Explicitly prohibits the silent-partial-processing variant — the worst interop failure mode.

## Backwards-compat migration

**Server-side impact:** Servers currently returning alternative error shapes need a small update in their batch-rejection path. Servers that don't implement batch rejection at all (just process the first element or crash) need a new guard: detect `Array.isArray(body)` early, emit the canonical error, don't proceed.

**Client-side impact:** None for clients not using batches. Clients that do send batches (shouldn't, per MCP spec) will see a more uniform rejection.

**Rollout plan:**
1. Ship as a MUST in the next spec release. Zero legitimate use case justifies any other rejection shape.
2. Compliance tooling's `transport-batch-reject` test already exercises this.

## Submit the PR

```bash
gh repo fork modelcontextprotocol/specification --clone
cd specification
git checkout -b yawlabs/canonical-batch-rejection

# Edit basic/transports.mdx — add both HTTP and stdio variants.

git add docs/specification/basic/transports.mdx
git commit -m "Canonicalize JSON-RPC batch rejection shape"
git push origin yawlabs/canonical-batch-rejection

gh pr create \
  --title "Canonicalize JSON-RPC batch rejection shape" \
  --body-file ../mcp-compliance/docs/spec-prs/04-error-on-batch.md \
  --base main
```
