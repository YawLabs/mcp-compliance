# Spec version policy

`mcp-compliance` ships **one test catalog per MCP specification revision it supports** and picks the catalog per run. This document explains which revisions are supported, how a run decides which one to grade, how to pin, what changes for you when your server upgrades, and how we add the next revision.

Before 0.18 the tool tested exactly one spec version per release, and testing two versions meant running two tool versions. That policy is gone: one tool version now grades either revision, and the report says which one it graded.

## Current

| Spec revision | Catalog | Tests | Era |
|---|---|---|---|
| **2025-11-25** | `TEST_DEFINITIONS` (`src/types.ts`) | 88 | legacy: `initialize` handshake, `Mcp-Session-Id`, `ping`, `logging/setLevel`, `resources/subscribe`, HTTP GET stream |
| **2026-07-28** | `MODERN_TEST_DEFINITIONS` (`src/definitions/2026-07-28.ts`) | 103 | modern: stateless, every request carries `params._meta` (protocol version + client capabilities), `server/discover` replaces `initialize`, `subscriptions/listen` replaces the GET stream, caching hints and `resultType` on results, MRTR instead of server-initiated requests |

- `SUPPORTED_SPEC_VERSIONS` (exported from the runner) is `["2025-11-25", "2026-07-28"]`.
- `getTestDefinitions(version)` returns the catalog for a revision; `specBaseFor(version)` returns the base URL for its spec links.
- `SPEC_VERSION` and `SPEC_BASE` are still exported for back-compat. They keep their 2025-11-25 values and are **deprecated**: they name the fallback revision, not "the" revision. Read `report.specVersion` instead.
- Every report includes `specVersion` -- the revision the run **actually graded**, never `auto`.

Both catalogs use the same 8 categories, so the report schema (`schemaVersion: "1"`) is unchanged.

## How a run picks its revision

`--spec-version auto|2025-11-25|2026-07-28` on `test` and `benchmark`, `specVersion` in the config file, `specVersion` on the `mcp_compliance_test` MCP tool, and the `spec-version` input of the GitHub Action all take the same three values. The default everywhere is `auto`.

### `auto`

`auto` implements the spec's own algorithm for dual-era clients ([versioning: backward compatibility](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning#backward-compatibility-with-initialization-based-versions)):

1. Send one **conformant 2026-07-28 `server/discover`** -- full `_meta`, and on HTTP the `MCP-Protocol-Version` and `Mcp-Method` headers. On HTTP this request *is* the preflight connectivity check, so detection adds no round-trip; on stdio it is the first exchange and shares `--startup-timeout`.
2. Classify the reply:
   - a `DiscoverResult` (`supportedVersions` array) -> **2026-07-28**
   - a JSON-RPC error with a modern-only code (`-32020` HeaderMismatch, `-32021` MissingRequiredClientCapability, `-32022` UnsupportedProtocolVersion) -> **2026-07-28**
   - **anything else** -> **2025-11-25**: `-32601`, `-32000`, a 400 "not initialized", a 404 from an HTTP+SSE server, an HTML page, a connection failure, or **no reply within the timeout**.

The fallback is deliberately not keyed to a single error code. A legacy server that answers unknown pre-init methods with `-32601` and one that ignores them entirely are both classified as 2025-11-25; the second one just takes the startup timeout to get there.

The detection probe's `DiscoverResult` is reused as the modern suite's discover response (serverInfo, capabilities, supportedVersions), so a 2026-07-28 run does not repeat the request.

### Dual-era servers

A server that answers both `server/discover` and `initialize` -- the default for servers built on `@modelcontextprotocol/server` 2.0 -- is graded as **2026-07-28**. The report carries a warning naming the other era and how to pin it. Nothing in the 2026-07-28 run exercises the legacy path except the informational `lifecycle-dual-era` probe; to grade the legacy side, run again with `--spec-version 2025-11-25`.

### Unreachable servers

If the server cannot be reached at all, `auto` resolves to 2025-11-25 and the run proceeds so that every test fails visibly (the previous behaviour, preserved).

### Pinning

`--spec-version 2025-11-25` or `--spec-version 2026-07-28` skips the probe and runs the named catalog regardless of what the server would have answered. A modern-only server graded as 2025-11-25 fails `lifecycle-init` and most of what follows; a legacy-only server graded as 2026-07-28 fails `lifecycle-discover`. Both are useful: they answer "does this server still speak the old revision" and "is it ready for the new one".

`--list` never connects, so `auto` is meaningless there; it previews the 2025-11-25 catalog unless `--spec-version` names the other one.

## What flips when your server upgrades

Under `auto`, the revision is a property of the **server**, not of your configuration. The day your server moves to an SDK that implements 2026-07-28, the same CI job:

- runs a different catalog (103 tests instead of 88, 24 required by default instead of 12, a different set of ids);
- can produce a different grade -- the modern MUSTs (caching hints, `resultType`, `_meta` validation, header validation, `-32602` for missing resources) are new failures for a server that only bolted on `server/discover`;
- reports a different `specVersion`, which affects `diff` and SARIF (below);
- gets a warning in the report saying detection picked 2026-07-28 and how to pin.

If you want the suite to change only when you say so, pin `--spec-version` (or `"specVersion"` in `mcp-compliance.config.json`, or `spec-version:` in the Action). Pinning 2025-11-25 keeps today's suite byte-for-byte; switching the pin to 2026-07-28 is then a deliberate change with its own PR.

Pinning to `2025-11-25` is also the right move for a server that must keep serving legacy clients: the modern suite's `lifecycle-dual-era` rule only reports that the legacy side exists, it does not grade it.

## `diff`, SARIF, and the Action

- **`diff` refuses to compare reports from different spec revisions.** Ids are only comparable within one catalog (a reused id means the same check; a changed check has a new id), so comparing across revisions would silently misreport renamed checks as regressions or fixes. The error names both versions and tells you to pin `--spec-version <baseline's>` on the current run. In a CI job that stores a baseline and diffs each run, pin the same revision on both sides.
- **SARIF uploads are tracked per revision.** The SARIF run carries `automationDetails.id = "mcp-compliance/<specVersion>/"`, so GitHub Code Scanning treats the two suites as separate analyses: a switch opens a fresh set of alerts for the new revision instead of closing every 2025-11-25 alert as "fixed".
- **The GitHub Action** takes `spec-version` (default `auto`) and exposes the resolved value as the `spec-version` output. The action runs the suite more than once (SARIF, JSON, visible output); it resolves the revision from the JSON pass and pins the others to it so one flaky probe cannot make the passes disagree.
- **`benchmark`** is spec-aware too: it warms up and probes with `server/discover` on 2026-07-28 (there is no `ping`), and with `initialize` + `ping` on 2025-11-25.

## Consumer guidance

If you read the JSON report programmatically:

- **Check `report.specVersion` first.** One tool version now emits reports for either revision, so `toolVersion` no longer implies the catalog. Test ids, the required set, and `serverInfo.protocolVersion` all belong to the revision named there. Reject an unknown `specVersion` the way you reject an unknown `schemaVersion`.
- `serverInfo.protocolVersion` means "the revision the suite used". For 2025-11-25 that is the version negotiated by `initialize`; for 2026-07-28 it is the resolved revision, with `serverInfo.name` / `version` / `capabilities` taken from `server/discover`. Do not infer "the handshake succeeded" from it being non-null.
- The report shape is stable within `schemaVersion` (currently `"1"`), and the schema is strict (`additionalProperties: false`): a new field means a new schema version, so you can validate with the shipped `schemas/report.v1.json` and rely on unknown fields failing rather than sneaking in.
- Use test ids as opaque keys **scoped by `specVersion`**. `mcp-compliance-rules.json` tags every rule with its `specVersion`; look ids up there with the pair, not the id alone.
- If you embed a badge, `--output badge.svg` reflects whatever revision the run resolved to. Pin `--spec-version` if the badge must not change meaning when the server upgrades.

## How we add the next revision

The revision-specific parts of the tool are isolated so that a new spec release is an additive change:

| Concern | Where it lives |
|---|---|
| Supported versions, era classification, spec base URLs | `src/spec.ts` |
| Detection | `src/detect.ts` (`classifyDiscoverResponse`, `detectSpecVersion`) |
| Catalogs | `src/types.ts` (2025-11-25), `src/definitions/2026-07-28.ts`, `src/definitions/index.ts` (`getTestDefinitions`) |
| Suites | legacy body in `src/runner.ts`; modern in `src/suites/modern/*` on `src/harness.ts` |
| Wire envelope for the modern era | `src/modern/meta.ts`, `src/modern/headers.ts`, `src/modern/client.ts` |
| Recording + post-hoc checks | `src/recorder.ts`, `src/suites/modern/posthoc.ts`, `src/modern/schema-validator.ts` + vendored `src/schemas/mcp-<version>.schema.json` |
| Published methodology | `COMPLIANCE_RUBRIC.md` (one rules section per revision), `mcp-compliance-rules.json` (`specVersion` per rule), README ("What the N tests check (<revision>)" per revision) |
| Guards | `src/tests/types.test.ts` (counts per catalog, README parity per section), `src/tests/catalog-parity.test.ts` (rules.json + rubric vs catalogs) |

When the MCP project publishes a new revision:

1. Open a tracking issue on `YawLabs/mcp-compliance`; vendor the spec docs and `schema.json` for reference.
2. Decide the era. A revision that keeps the previous connection model (like 2025-11-25 relative to 2025-06-18) extends an existing catalog; one that changes it (like 2026-07-28) gets its own catalog and suite.
3. Add the version to `SUPPORTED_SPEC_VERSIONS`; the detector must have a positive signal for it (for the modern era, `supportedVersions` on `server/discover` already carries it).
4. Write the catalog first. Reuse an id **only** when the check is semantically identical in both revisions; a check whose pass criteria change gets a new id. Ids are what `diff`, SARIF, `--only`/`--skip` and `explain` key on.
5. Implement the suite against a hand-rolled fixture server with negative knobs (`src/tests/fixtures/`), so every new check is seen to fail before it is trusted to pass.
6. Update the docs listed in the table above. `catalog-parity.test.ts` and `types.test.ts` are red until rules.json, the rubric, and the README all carry the new catalog.
7. Bump the methodology version in `COMPLIANCE_RUBRIC.md` / `mcp-compliance-rules.json` per its semver policy (a new catalog is minor; a catalog-schema change is major).
8. Release as a minor `0.x.0` with the behaviour change called out in the changelog: under `auto`, servers that speak the new revision switch suites on upgrade.

Previous tool versions stay on npm; a pinned `npx @yawlabs/mcp-compliance@0.17` keeps grading 2025-11-25 only, exactly as it did.
