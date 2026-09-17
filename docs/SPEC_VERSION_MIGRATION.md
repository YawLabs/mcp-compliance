# Spec version policy

`mcp-compliance` ships **one test catalog per MCP specification revision it supports** and picks the catalog per run. This document explains which revisions are supported, how a run decides which one to grade, how to pin, what changes for you when your server upgrades, and how we add the next revision.

Before 0.19 the tool tested exactly one spec version per release, and testing two versions meant running two tool versions. That policy is gone: one tool version now grades either revision, and the report says which one it graded.

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

1. Send one **conformant 2026-07-28 `server/discover`** -- full `_meta`, and on HTTP the `MCP-Protocol-Version` and `Mcp-Method` headers. On HTTP this request *is* the preflight connectivity check, so detection adds no round-trip and is bounded by `--preflight-timeout`; a preflight that times out (as opposed to a refused connection or DNS failure) is re-sent once within `--startup-timeout` before the run defaults to 2025-11-25, so a modern server on a cold start is graded in its real era. On stdio it is the first exchange and is bounded by `--startup-timeout`; in terminal mode a dim status line names the wait after ~2 s.
2. Classify the reply:
   - a `DiscoverResult` (`supportedVersions` array) -> **2026-07-28**
   - a JSON-RPC error with a modern-only code (`-32020` HeaderMismatch, `-32021` MissingRequiredClientCapability, `-32022` UnsupportedProtocolVersion) -> **2026-07-28**
   - an HTTP 401/403 without a modern error body -> **2025-11-25**, but the note says the era could not be determined and the report's first warning says the grade is not meaningful. Without an `Authorization` header, a 401 or a 403 carrying a `WWW-Authenticate: Bearer` challenge reads `authentication required -- pass --auth`; with one, a 401 or a 403 whose Bearer challenge carries an `error` parameter reads `credential rejected -- check --auth` (the warning names the reason from that error); any other 403 reads `forbidden -- Host/Origin validation, a gateway, or missing credentials` (no header) or `... or token permissions` (header), and its warning quotes the body's JSON-RPC error message when there is one and points at Host/Origin validation (a tunnel or proxy hostname) and any gateway first
   - **anything else** -> **2025-11-25**: `-32601`, `-32000`, a 400 "not initialized", a 404 from an HTTP+SSE server, an HTML page, a connection failure, or **no reply within the budget**.

The fallback is deliberately not keyed to a single error code. A legacy server that answers unknown pre-init methods with `-32601` and one that ignores them entirely are both classified as 2025-11-25; the second one just takes the startup timeout to get there. A legacy stdio server whose dispatcher *exits* on the unknown method is classified the same way, but the report says so (`Server exited (code N) after the 2026-07-28 era probe (server/discover); last stderr: ...`), suggests pinning `--spec-version 2025-11-25` to skip the probe, and grades a freshly spawned instance rather than the dead one. When the fresh instance exits at startup as well, before answering `initialize`, the probe was not the cause: the warning says the server exits at startup regardless of the probe, quotes its stderr, and points at the command, its arguments and its environment instead of the pin. `benchmark` re-spawns a probe-killed child the same way.

The reason is stamped into the report header (`auto-detected from server/discover: supportedVersions [2026-07-28]`, `... JSON-RPC error -32601, legacy`, `... no response, legacy`) and into `warnings` as `Spec version auto-detected as <v> (server/discover -> <reason>). Pin with --spec-version to override.`

The detection probe's `DiscoverResult` is reused as the modern suite's discover response (serverInfo, capabilities, supportedVersions), so a 2026-07-28 run does not repeat the request.

### Dual-era servers

A server that answers both `server/discover` and `initialize` -- the default for servers built on `@modelcontextprotocol/server` 2.0 -- is graded as **2026-07-28**. The report carries a warning naming the other era and how to pin it: `Server is dual-era (also advertises 2025-11-25)` when `supportedVersions` lists the legacy revision, or `Server is dual-era (also serves the legacy initialize handshake)` when only the `lifecycle-dual-era` probe was served an `InitializeResult` -- the SDK 2.0 case, since it advertises only modern versions yet still serves `initialize`. Nothing in the 2026-07-28 run exercises the legacy path except that informational probe, whose details read `dual-era: initialize answered with protocolVersion 2025-11-25 on a fresh process; ...` on stdio (a dual-era stdio server pins its era per process, so the probe opens a second one) or `modern-only: initialize rejected with -32022; data.supported names supported versions` for a modern-only server. To grade the legacy side, run again with `--spec-version 2025-11-25`.

A server that serves `initialize` while *rejecting* the conformant `server/discover` is not dual-era but **legacy-only**, and a run that graded it as 2026-07-28 says so: `lifecycle-dual-era` reads `legacy-only: initialize answered with protocolVersion 2025-11-25 ... but server/discover was rejected`, and the warning is `Server is legacy-only (served the 2025-11-25 initialize handshake but rejected server/discover); this run graded 2026-07-28, so most of its tests are not evaluable. Re-run with --spec-version 2025-11-25 (or auto) to grade the era it speaks.`

### Unreachable servers

If the server cannot be reached at all, `auto` resolves to 2025-11-25 and the run proceeds so that every test that needs the server fails (the previous behaviour, preserved; the warning names the connection error, or the two timeouts that elapsed).

### Pinning

`--spec-version 2025-11-25` or `--spec-version 2026-07-28` skips the probe and runs the named catalog regardless of what the server would have answered. A modern-only server graded as 2025-11-25 fails `lifecycle-init` (whose details now quote the server's answer: `Initialize answered with JSON-RPC error -32601: Method not found: initialize. This server speaks MCP 2026-07-28 ... (HTTP 404)`) and most of what follows; a legacy-only server graded as 2026-07-28 fails `lifecycle-discover` and, as **not evaluable**, the six `_meta` / standard-header rejection tests -- a server that rejects the conformant request proves nothing by also rejecting a malformed one, so those required tests are failed rather than credited. Both pins are useful: they answer "does this server still speak the old revision" and "is it ready for the new one". On HTTP the preflight is still a modern `server/discover`, so a pinned run whose server answered in the other era carries a warning (`Server answered the 2026-07-28 server/discover probe with a DiscoverResult (supportedVersions [...]); this run is pinned to 2025-11-25. Re-run with --spec-version 2026-07-28 (or auto) to grade it`). It needs an era signal: a `DiscoverResult`, a JSON-RPC body or an HTTP 4xx; a 401/403, a 5xx or a non-JSON-RPC page never triggers it. A dual-era server whose `supportedVersions` lists the pinned 2025-11-25 gets `Server is dual-era (server/discover advertised supportedVersions [2026-07-28, 2025-11-25]); this run grades its 2025-11-25 side.` instead, with no re-pin advice, since that pin is a legitimate way to grade its legacy side.

`--list` never connects, so `auto` cannot probe there: it prints every catalog in its own section (with the filter warnings a live run would give, per catalog), and `--spec-version <date>` previews just that one.

## What flips when your server upgrades

Under `auto`, the revision is a property of the **server**, not of your configuration. The day your server moves to an SDK that implements 2026-07-28, the same CI job:

- runs a different catalog (103 tests instead of 88, 24 required by default instead of 12, a different set of ids);
- can produce a different grade -- the modern MUSTs (caching hints, `resultType`, `_meta` validation, header validation, `-32602` for missing resources) are new failures for a server that only bolted on `server/discover`;
- reports a different `specVersion`, which affects `diff` and SARIF (below);
- gets a warning in the report saying detection picked 2026-07-28 and how to pin.

If you want the suite to change only when you say so, pin `--spec-version` (or `"specVersion"` in `mcp-compliance.config.json`, or `spec-version:` in the Action). Pinning 2025-11-25 keeps today's suite byte-for-byte; switching the pin to 2026-07-28 is then a deliberate change with its own PR.

Pinning to `2025-11-25` is also the right move for a server that must keep serving legacy clients: the modern suite's `lifecycle-dual-era` rule only reports that the legacy side exists, it does not grade it.

## `diff`, SARIF, and the Action

- **`diff` refuses to compare reports from different spec revisions.** Ids are only comparable within one catalog (a reused id covers the same feature, but its criteria and required flag may differ; a check whose verdict flipped has a new id), so comparing across revisions would silently misreport renamed checks as regressions or fixes. The error names both versions and tells you to pin `--spec-version <baseline's>` on the current run. In a CI job that stores a baseline and diffs each run, pin the same revision on both sides.
- **SARIF uploads are tracked per revision.** The SARIF run carries `automationDetails.id = "mcp-compliance/<specVersion>/"`, so GitHub Code Scanning treats the two suites as separate analyses: a switch opens a fresh set of alerts for the new revision instead of closing every 2025-11-25 alert as "fixed".
- **The GitHub Action** takes `spec-version` (default `auto`) and exposes the resolved value as the `spec-version` output. The action runs the suite more than once (SARIF, JSON, visible output); it resolves the revision from the JSON pass and pins the others to it so one flaky probe cannot make the passes disagree.
- **`benchmark`** is spec-aware too: on 2026-07-28 it sends one unmeasured `server/discover` warm-up (under `auto` the detection probe is that warm-up; a pinned run sends it explicitly, so a stdio child's boot never lands in the first timed sample) and then measures `server/discover` (there is no `ping`); on 2025-11-25 it warms up with `initialize` and measures `ping`. Under `auto` on stdio the era probe and the warm-up are bounded by `--startup-timeout` (the same flag and default as `test`), a child the probe killed is re-spawned before the samples, and the probe-exit warning is printed with the results (`BenchmarkResult.warnings` in JSON).

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
4. Write the catalog first. Reuse an id when the check covers the same feature and the same server behaviour keeps the same verdict; the wording, the exact criteria and the required flag may still differ per revision, and the docs must not claim otherwise. A check whose verdict on the same behaviour flips gets a new id. Ids are what `diff`, SARIF, `--only`/`--skip` and `explain` key on.
5. Implement the suite against a hand-rolled fixture server with negative knobs (`src/tests/fixtures/`), so every new check is seen to fail before it is trusted to pass.
6. Update the docs listed in the table above. `catalog-parity.test.ts` and `types.test.ts` are red until rules.json, the rubric, and the README all carry the new catalog.
7. Bump the methodology version in `COMPLIANCE_RUBRIC.md` / `mcp-compliance-rules.json` per its semver policy (a new catalog is minor; a catalog-schema change is major).
8. Release as a minor `0.x.0` with the behaviour change called out in the changelog: under `auto`, servers that speak the new revision switch suites on upgrade.

Previous tool versions stay on npm; a pinned `npx @yawlabs/mcp-compliance@0.17` keeps grading 2025-11-25 only, exactly as it did.
