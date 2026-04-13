# Clarify error response for JSON-RPC batch requests

## Problem

MCP forbids JSON-RPC 2.0 batch requests (arrays of message objects). `basic/transports#streamable-http` says servers "must not" process batches, but doesn't say what shape the rejection should take.

Observed variance:
- HTTP 400 with empty body
- HTTP 400 with JSON-RPC error `-32600` (Invalid Request)
- HTTP 415 (Unsupported Media Type)
- HTTP 200 with JSON-RPC error (contradicting MCP's own "400 on batch" suggestion)

Clients can't write a cohesive retry/error-handling path against this.

## Proposed wording change

Add to `basic/transports#streamable-http`:

> When a server receives a JSON body that parses as an array (indicating a JSON-RPC 2.0 batch request), it **MUST** respond with HTTP status `400 Bad Request` and a JSON-RPC error body:
>
> ```json
> { "jsonrpc": "2.0", "id": null, "error": { "code": -32600, "message": "Batch requests are not supported in MCP" } }
> ```
>
> The `id` field is `null` because a batch has no single id to correlate against. Clients **SHOULD** treat this response as fatal to the batch — retrying individual messages as separate requests is acceptable.

## Rationale

- One canonical rejection shape across the ecosystem.
- Uses the JSON-RPC code most semantically appropriate (`-32600 Invalid Request` — a batch is not a valid MCP request structure).
- `id: null` clarifies that no specific batch member can be blamed.

## Backwards-compat considerations

Servers currently returning alternative error shapes need a small change. Zero impact on clients that don't send batches (the common case).
