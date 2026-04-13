# Require `_meta` tolerance on all requests

**Status:** draft, ready for submission
**Target:** `modelcontextprotocol/specification`
**Related:** none — this one stands alone

## Problem

The 2025-11-25 spec introduces `_meta` as an open-ended metadata field that can appear on any request or response. The spec gives a concrete example (`_meta.progressToken` for progress tokens) and implies that future spec additions may introduce new `_meta` keys.

What the spec doesn't say: **must servers tolerate unknown keys inside `_meta`?**

Consequence: a server using strict JSON-Schema validation on incoming requests rejects `{"method": "ping", "params": {"_meta": {"my-client/trace-id": "abc"}}}` as having an invalid `_meta` shape — even though the client is doing nothing the spec prohibits.

This blocks three real use cases:

- **Client-side extensions** — request-scoped trace IDs, feature flags, logging metadata. All standard in any distributed system.
- **Forward compatibility** — when MCP 2026-something adds a new `_meta` key, every strict server breaks on day one unless the spec already requires tolerance.
- **Cross-tool interop** — a compliance tool that embeds a probe key in `_meta` to avoid tripping request-logging isn't doing anything adversarial, but a strict server rejects it.

## Proposed wording change

Add to `basic/utilities#_meta` (or create a dedicated `basic/utilities/_meta` page if one doesn't exist):

> The `_meta` field is an open extension point. Receivers **MUST** accept and ignore keys within `_meta` that they do not recognize. Receivers **MUST NOT** return an error solely because `_meta` contains unknown keys.
>
> Implementations using JSON-Schema validation on incoming messages **SHOULD** declare `_meta` as `additionalProperties: true`, or omit a schema for `_meta` entirely.
>
> Keys within `_meta` that are defined by this specification (e.g., `progressToken`) retain their required shape and semantics; receivers that recognize such keys must validate and handle them normally.

## Rationale

- Aligns with standard practice for extensible protocol fields (JSON-LD `@context`, HTTP `X-` headers historically, OpenAPI `x-` extensions).
- Zero runtime cost to servers that already ignore unknown fields.
- Unblocks an entire class of client-side extensions and future spec additions without requiring protocol version bumps.
- Closes an ambiguity that compliance tooling has to guess at.

## Backwards-compat migration

**Server-side impact:** Servers doing strict schema validation on `_meta` need to relax that one rule. For most servers this is a one-line JSON Schema change (`additionalProperties: true` on the `_meta` object), or removing an overly-strict validator entirely.

**Client-side impact:** None. This strictly *allows* more client behavior, never restricts it.

**Rollout plan:**
1. Spec ships the rule as a MUST immediately — there's no legitimate reason for a server to reject unknown `_meta` keys.
2. A compliance test (`lifecycle-meta-tolerance` in `@yawlabs/mcp-compliance` as of v0.10.1) probes this with a benign `{_meta: {"mcp-compliance/probe": "1"}}` on ping. Servers that fail surface the problem on day one.

## Submit the PR

```bash
gh repo fork modelcontextprotocol/specification --clone
cd specification
git checkout -b yawlabs/require-meta-tolerance

# Apply wording from the "Proposed wording change" section above to the
# basic/utilities/_meta page (or add the page if it doesn't exist yet).

git add docs/specification/basic/utilities/_meta.mdx  # path may vary
git commit -m "Require receivers to ignore unknown _meta keys"
git push origin yawlabs/require-meta-tolerance

gh pr create \
  --title "Require receivers to ignore unknown _meta keys" \
  --body-file ../mcp-compliance/docs/spec-prs/02-meta-field-tolerance.md \
  --base main
```
