# Spec version migration

`mcp-compliance` tests against a single MCP specification version per release. This document explains how that mapping works, what happens when a new MCP spec version is published, and how to upgrade.

## Current

- `mcp-compliance@0.10.x` tests against MCP spec **2025-11-25**
- Constant exported from the runner: `SPEC_VERSION = "2025-11-25"`
- Every report includes `specVersion` so consumers can verify which version was checked

## When a new MCP spec drops

The MCP project releases new spec versions periodically (the next is 2026-XX-XX, date TBD). Each release may add capabilities, change handshake semantics, deprecate methods, or tighten error codes. Our policy:

| Change in MCP spec | Our response | Released as |
|---|---|---|
| New optional capability (e.g. a new `tools/foo` method) | Add new optional tests; existing tests unchanged | Minor (`0.x.0`) |
| New required behavior (initialize handshake change, new error code) | Add required tests; bump `SPEC_VERSION` | Major-ish (`0.x.0` until we hit `1.0`, then `x.0.0`) |
| Removal/renaming of an existing method | Mark old tests as deprecated for one release, then remove | Minor → Major across two releases |
| Tightening of an existing rule (was SHOULD, now MUST) | Promote test from `required: false` to `required: true` | Minor (`0.x.0`) — flag as breaking in CHANGELOG |

We **do not** support testing against multiple spec versions in a single CLI invocation. To test the same server against two spec versions, run two CLI invocations with two different `mcp-compliance` versions:

```bash
npx @yawlabs/mcp-compliance@0.10 test https://my-server.com/mcp   # tests against 2025-11-25
npx @yawlabs/mcp-compliance@0.11 test https://my-server.com/mcp   # tests against 2026-XX-XX (hypothetical)
```

## Consumer guidance

If you embed the badge in your README, the badge **always reflects the latest published version of mcp-compliance**, not a pinned spec version. To pin the badge to a specific spec version, request a static badge file via `--output badge.svg` from a pinned CLI version and commit it.

If you read the JSON report programmatically:

- Always check `report.specVersion`. Reject reports with an unknown spec version, don't guess.
- The shape of a report is stable within a major `mcp-compliance` version; check `report.schemaVersion` (currently `"1"`).
- `tests` array contents change between spec versions — new IDs appear, old ones may disappear. Use IDs as opaque keys.

## Internal: how we manage version bumps

When the MCP project announces a new spec version:

1. Open a tracking issue on `YawLabs/mcp-compliance`
2. Read the spec diff
3. Add new tests for new capabilities (optional first — easier to get into a release)
4. Update `SPEC_VERSION` constant in `src/runner.ts`
5. Update `MCP_COMPLIANCE_SPEC.md` with new test rules
6. Bump version (minor unless the diff includes new MUSTs that affect existing servers)
7. Cut a release; update README to mention the new version
8. The previous CLI version stays available on npm forever; pinned consumers keep working
