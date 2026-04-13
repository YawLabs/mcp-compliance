# Require `_meta` tolerance on all requests

## Problem

The 2025-11-25 spec introduces `_meta` as an open-ended metadata field that can appear on any request or response. Examples in the spec cover `_meta.progressToken` (for progress tokens) and imply that protocol/transport metadata may be added in future.

What's unclear: **must servers tolerate unknown keys inside `_meta`?**

If a server uses strict JSON-Schema validation on requests and rejects unknown properties anywhere in the tree, it will reject `{"method": "ping", "params": {"_meta": {"my-client/trace": "abc"}}}` even though the client is doing nothing wrong.

This blocks:
- Client-side extensions (trace IDs, request-scoped feature flags, logging metadata)
- Forward-compat with future spec additions that add new `_meta` keys

## Proposed wording change

Add to `basic/utilities#_meta`:

> The `_meta` field is an open extension point. Receivers **MUST** accept and ignore keys within `_meta` that they do not recognize. Receivers **MUST NOT** return an error solely because `_meta` contains unknown keys.
>
> Implementations using JSON-Schema validation on incoming messages **SHOULD** declare `_meta` as `additionalProperties: true` (or omit the schema for `_meta` entirely).
>
> Keys within `_meta` that are defined by this specification (e.g., `progressToken`) retain their required shape; receivers that recognize such keys must validate them normally.

## Rationale

- Aligns with standard practice for extensible protocol fields (JSON-LD `@context`, HTTP `X-` headers historically, OpenAPI extensions).
- Zero cost to well-behaved servers.
- Unblocks a large class of client/tooling extensions without requiring protocol version bumps.

## Backwards-compat considerations

Servers doing strict schema validation on `_meta` would need to relax that one schema rule. No runtime behavior change for servers that already ignore unknown `_meta` keys (likely the majority).
