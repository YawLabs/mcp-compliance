# @yawlabs/mcp-compliance Testing Methodology

**Version:** 2.0.0
**Date:** 2026-09-14
**MCP Spec Compatibility:** [2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25) and [2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28)
**License:** [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
**Maintained by:** [Yaw Labs / mcp-compliance](https://github.com/YawLabs/mcp-compliance)
**Implementation:** `@yawlabs/mcp-compliance` v0.19.0+

---

## What Is This?

This document describes the **testing methodology** used by `@yawlabs/mcp-compliance` to verify MCP (Model Context Protocol) server compliance. It is not the MCP specification and does not redefine the protocol itself — the MCP specification ([2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25), [2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28)) defines what servers MUST do. This document records how one tool chooses to verify those requirements, and publishes the choices (rule IDs, severities, scoring weights, grade thresholds) so the grading is auditable rather than a black box.

The methodology is published openly (CC BY 4.0) so other tools can adopt, fork, or diverge from it. It is not an authoritative conformance standard.

**Scope:**

- **Two rule catalogs, one per MCP specification revision:** 88 rules for 2025-11-25 (section 3) and 103 rules for 2026-07-28 (section 3b), both across the same 8 categories, each rule with a defined severity (required or optional). One run grades exactly one revision; the tool picks it by probing the server (`--spec-version auto`) or takes it from an explicit `--spec-version`.
- **Scoring algorithm** that weights required vs. optional tests and produces a numerical score
- **Grading methodology** that maps scores to letter grades (A through F)
- **Capability-driven test execution model** that dynamically adjusts test requirements based on server-declared capabilities
- **Transport-gated test execution** — stdio-specific tests run only when testing a stdio server; HTTP tests run only for Streamable HTTP servers
- **Machine-readable rule catalog** (`mcp-compliance-rules.json`) for tooling integration, with every rule tagged by the revision it applies to

**Companion specifications:** [MCP Protocol Specification (2025-11-25)](https://modelcontextprotocol.io/specification/2025-11-25) and [MCP Protocol Specification (2026-07-28)](https://modelcontextprotocol.io/specification/2026-07-28)

## Related Yaw Labs tools

Yaw Labs also maintains [`mcp-config-lint`](https://github.com/YawLabs/ctxlint) — static analysis for MCP client config files (`.cursor/mcp.json`, `.vscode/mcp.json`, `.mcp.json`, etc.). It targets the `2025-11-25` MCP spec and ships its own machine-readable rule catalog. Running both covers both sides of the deployment: lint configs pre-deploy, test servers post-deploy.

---

## Table of Contents

- [1. Testing Methodology](#1-testing-methodology)
  - [1.1 Test Execution Model](#11-test-execution-model)
  - [1.2 Capability-Driven Execution](#12-capability-driven-execution)
  - [1.3 Retry Behavior](#13-retry-behavior)
  - [1.4 Test Filtering](#14-test-filtering)
  - [1.5 Execution Model per Spec Revision](#15-execution-model-per-spec-revision)
- [2. Scoring Algorithm](#2-scoring-algorithm)
  - [2.1 Weight Distribution](#21-weight-distribution)
  - [2.2 Grade Thresholds](#22-grade-thresholds)
  - [2.3 Overall Status](#23-overall-status)
- [3. Test Rules -- 2025-11-25](#3-test-rules----2025-11-25)
  - [3.1 transport -- Transport Validation (16 tests)](#31-transport----transport-validation-16-tests)
  - [3.2 lifecycle -- Protocol Lifecycle (21 tests)](#32-lifecycle----protocol-lifecycle-21-tests)
  - [3.3 tools -- Tool Operations (4 tests)](#33-tools----tool-operations-4-tests)
  - [3.4 resources -- Resource Operations (5 tests)](#34-resources----resource-operations-5-tests)
  - [3.5 prompts -- Prompt Operations (3 tests)](#35-prompts----prompt-operations-3-tests)
  - [3.6 errors -- Error Handling (10 tests)](#36-errors----error-handling-10-tests)
  - [3.7 schema -- Schema Validation (6 tests)](#37-schema----schema-validation-6-tests)
  - [3.8 security -- Security Validation (23 tests)](#38-security----security-validation-23-tests)
- [3b. Test Rules -- 2026-07-28](#3b-test-rules----2026-07-28)
  - [3b.1 transport -- Transport Validation (20 tests)](#3b1-transport----transport-validation-20-tests)
  - [3b.2 lifecycle -- Protocol Lifecycle (22 tests)](#3b2-lifecycle----protocol-lifecycle-22-tests)
  - [3b.3 tools -- Tool Operations (6 tests)](#3b3-tools----tool-operations-6-tests)
  - [3b.4 resources -- Resource Operations (8 tests)](#3b4-resources----resource-operations-8-tests)
  - [3b.5 prompts -- Prompt Operations (4 tests)](#3b5-prompts----prompt-operations-4-tests)
  - [3b.6 errors -- Error Handling (12 tests)](#3b6-errors----error-handling-12-tests)
  - [3b.7 schema -- Schema Validation (10 tests)](#3b7-schema----schema-validation-10-tests)
  - [3b.8 security -- Security Validation (21 tests)](#3b8-security----security-validation-21-tests)
- [4. Rule Catalog (Machine-Readable)](#4-rule-catalog-machine-readable)
- [5. Adopting This Methodology](#5-adopting-this-methodology)
- [6. Contributing](#6-contributing)

---

## 1. Testing Methodology

### 1.1 Test Execution Model

Tests execute sequentially in a defined order. The ordering is significant because later tests depend on state established by earlier tests. Tests flagged `parallelSafe` in the catalog may run concurrently when the caller raises `--concurrency`; everything else stays sequential.

The phases below describe the **2025-11-25** suite, whose spine is the `initialize` handshake. The 2026-07-28 suite has no handshake and no session; its execution model is described in [section 1.5](#15-execution-model-per-spec-revision).

**Execution phases (2025-11-25):**

1. **Transport** (pre-initialization) -- Raw HTTP-level validation against the server endpoint. No MCP session exists yet. These tests send minimal JSON-RPC payloads (e.g., `ping`) to verify basic transport behavior.

2. **Lifecycle** (initialization) -- The test harness performs the `initialize` handshake, sends the `notifications/initialized` notification, and then validates the server's response structure, protocol version negotiation, capabilities declaration, and post-init behaviors (ping, logging, completions).

3. **Tools** -- Only runs if the server declares `tools` capability. Lists tools, calls the first tool, tests pagination, and validates content types.

4. **Resources** -- Only runs if the server declares `resources` capability. Lists resources, reads the first resource, tests templates, pagination, and subscriptions.

5. **Prompts** -- Only runs if the server declares `prompts` capability. Lists prompts, gets the first prompt, and tests pagination.

6. **Errors** -- Sends deliberately malformed or invalid requests to verify error handling. Always runs (error handling is a baseline requirement).

7. **Schema** -- Validates the structural correctness of tool, resource, and prompt definitions returned by list operations. Runs after the corresponding list operations.

8. **Security** -- Tests authentication enforcement, input validation (command injection, SQL injection, path traversal, SSRF), tool integrity (rug-pull detection, description poisoning), information disclosure, and rate limiting. Runs after all functional tests. Input validation tests are capability-gated on `tools`.

**Session state** is tracked across tests. After the `initialize` handshake:
- `MCP-Session-Id` (if issued by the server) is included on all subsequent requests.
- The negotiated `protocolVersion` is tracked for protocol-version-dependent behavior.
- The `initialized` notification is sent once, immediately after a successful `initialize` response.

### 1.2 Capability-Driven Execution

Test requirements are not fully static. Some tests become **required** based on the capabilities the server declares -- in its `initialize` response (2025-11-25) or in its `server/discover` result (2026-07-28). The mapping is:

| Server capability | 2025-11-25 tests that become required | 2026-07-28 tests that become required |
|---|---|---|
| `tools` | `tools-list`, `tools-schema` | `tools-list`, `tools-list-caching`, `tools-call`, `tools-content-types` |
| `resources` | `resources-list`, `resources-schema` | `resources-list`, `resources-list-caching`, `resources-read`, `resources-read-caching`, `resources-not-found` |
| `prompts` | `prompts-list`, `prompts-schema` | `prompts-list`, `prompts-list-caching`, `prompts-get` |
| `logging` | `lifecycle-logging` | -- (`logging/setLevel` was removed; log level is per-request `_meta`) |
| `completions` | `lifecycle-completions` | `lifecycle-completions` |
| `resources.subscribe` | `resources-subscribe` | -- (`resources/subscribe` was removed; see `lifecycle-subscriptions-listen`) |

In the 2026-07-28 catalog every rule in the `tools`, `resources` and `prompts` categories, plus the tool-gated `errors`, `schema` and `security` rules, is **absent from the report** when the server does not declare the capability (the catalog's `capabilityGated` field names the gate). Rules listed in the right-hand column are `required: false` in the catalog and flip to required at runtime when the capability is declared; the remaining gated rules stay optional.

**Rules for capability-driven tests:**

- If a server declares a capability, the corresponding tests become **required** and are expected to pass.
- If a server does not declare a capability, the corresponding tests either **auto-pass** (for tests that check for the capability before executing) or are **skipped** (for tests gated behind capability checks).
- Tests for undeclared capabilities that still run are treated as **optional**.

### 1.3 Retry Behavior

The reference tool supports configurable retry behavior:

- **Retry count** is configurable (default: 0, meaning no retries).
- **Backoff** is linear: 1 second after the first failure, 2 seconds after the second, 3 seconds after the third, and so on.
- On retry, only the **test function** re-executes. Session state and prior test results are preserved.
- If **any attempt passes**, the test is marked as passed.
- The reported `durationMs` covers the entire span from first attempt to final result.

### 1.4 Test Filtering

Tests can be filtered by category name or individual test ID:

- **Include list** (`only`): If provided, only tests whose category or ID appears in the list will run.
- **Exclude list** (`skip`): If provided, tests whose category or ID appears in the list will be skipped.
- Filtering **does not change test requirements**. A required test that is filtered out simply does not appear in results -- it does not count as failed.
- Filter values are matched against the catalog of the revision being graded. A value that matches no id or category in that catalog is reported as a warning (ids from the other revision, such as `lifecycle-init` on a 2026-07-28 run, are the usual cause) rather than silently producing an empty run; the terminal report then says "No tests ran" instead of "All tests passed". An `--only` value whose every match is gated off the target transport (an HTTP-only id on a stdio target) is warned about the same way, naming the `--list --transport` command that shows the ids that apply.
- In the 2026-07-28 suite a filtered run still measures the server: the `tools/list`, `resources/list`, `prompts/list` and `resources/templates/list` results that a filtered-out feature test would have cached are fetched once on demand by whichever rule needs them, so `--only security`, `--only schema` or `--only lifecycle` exercise the real checks instead of skip-passing. A rule skip-passes when the server does not declare the capability. When the list call itself failed, the definition checks (`tools-schema`, `tools-annotations`, `tools-title-field`, `tools-output-schema`, `prompts-schema`, `resources-schema`), `lifecycle-progress-token` and `transport-header-name-mismatch` skip-pass pointing at the `-list` rule when it is in the run (it reports the failure once), and fail with the recorded reason when it was filtered out, so `--only schema` cannot grade A over a broken list; the security rules skip-pass with a pointer to `tools-list`.

### 1.5 Execution Model per Spec Revision

One run grades exactly one specification revision; the report's `specVersion` names it. The two revisions have different connection models, so each has its own catalog and its own suite:

| | 2025-11-25 (legacy) | 2026-07-28 (modern) |
|---|---|---|
| Connection setup | `initialize` request + `notifications/initialized`; server may mint `Mcp-Session-Id` | None. Every request is independent and carries `params._meta` with `io.modelcontextprotocol/protocolVersion` and `io.modelcontextprotocol/clientCapabilities` (plus `clientInfo`); on HTTP the `MCP-Protocol-Version`, `Mcp-Method` and, where applicable, `Mcp-Name` headers mirror the body |
| Where capabilities come from | `initialize` result | `server/discover` result (`supportedVersions`, `capabilities`, `_meta` serverInfo, caching hints) |
| Session state tracked by the tool | `Mcp-Session-Id`, negotiated `protocolVersion` | None; the suite never sends a session header |
| Removed in the newer revision | -- | `initialize`, `ping`, `logging/setLevel`, `resources/subscribe`, HTTP GET stream and DELETE; expected to draw `-32601` / HTTP 404 |
| Post-hoc rules | none | A Recorder captures every server message (JSON bodies, SSE frames, stdio lines); eight rules scan the recording after all other tests have drained (`transport-no-server-requests`, `lifecycle-log-level-gating`, `error-id-echo`, `error-retired-codes`, `schema-result-type`, `schema-no-input-required-on-lists`, `schema-input-required-shape`, `schema-wire-valid`) |
| Rule count | 88 | 103 |

**Revision selection (`--spec-version`):**

- `auto` (the default) follows the spec's own rules for dual-era clients. The tool sends one conformant modern `server/discover` (on HTTP it doubles as the preflight connectivity check, so detection costs no extra round-trip and is bounded by the preflight timeout -- a preflight that times out is re-probed once within the startup timeout before the run defaults to 2025-11-25; on stdio it is the first exchange and is bounded by the startup timeout). A `DiscoverResult`, or a JSON-RPC error with a modern code (`-32020`, `-32021`, `-32022`), selects 2026-07-28. **Anything else** -- `-32601`, `-32000`, a 400 "not initialized", a 404, HTML, or no reply within the timeout -- selects 2025-11-25; a 401/403 with no modern error body also selects 2025-11-25 but the note says the era could not be determined (pass `--auth`). The fallback is deliberately not keyed to one error code. An unreachable server is graded as 2025-11-25 so every test that needs the server fails; the modern post-hoc scans fail too when nothing was received, rather than passing over an empty recording. A legacy stdio server that exits on the probe is reported (exit code, stderr tail, the `--spec-version 2025-11-25` hint) and the legacy suite runs against a fresh instance; when that fresh instance exits at startup as well, before answering `initialize`, the warning says the server exits at startup regardless of the probe and points at the command, its arguments and its environment instead of the pin. `benchmark` re-spawns a probe-killed child the same way.
- An HTTP server that answers the probe or preflight with 401/403 while no `Authorization` header was configured gets a first-position warning that it requires authentication, that the grade is not meaningful, and to re-run with `--auth`.
- A server that answers both eras (the SDK 2.0 default) is graded as 2026-07-28; the report carries a warning naming the other era and how to pin it (keyed on `supportedVersions` listing 2025-11-25 **or** the `lifecycle-dual-era` probe being served an `InitializeResult` while `server/discover` was served). A server whose `initialize` is served while the conformant `server/discover` is rejected is legacy-only, and the warning says so and names `--spec-version 2025-11-25` (or `auto`).
- `2025-11-25` or `2026-07-28` pins the catalog without probing. On HTTP the preflight still is a modern `server/discover`, so a pinned run whose server answered in the other era with an era signal (a `DiscoverResult`, a JSON-RPC body, or an HTTP 4xx; not a 5xx or a non-JSON-RPC page) gets a warning saying so; a dual-era server whose `supportedVersions` lists the pinned revision is told the run grades that side, without re-pin advice. A preflight that timed out but whose server answered later requests has its "unreachable" warning downgraded to a slow-cold-start note. The report always stamps the **resolved** revision, never `auto`.

**Modern-suite execution order:** the setup `server/discover` and the discover-result lifecycle rules, the early `_meta` probes (`lifecycle-meta-client-capabilities-required`, `lifecycle-meta-client-info-optional`, the unsupported-version probe), the removed-method probes, `lifecycle-capability-handlers-match`, `lifecycle-subscriptions-listen` and `lifecycle-meta-tolerance`; then the capability-gated tools / resources / prompts rules; then the transport rules, including the header probes (each a `server/discover` with one deliberate defect); then errors, schema and the stdio-only rules; then the late lifecycle block -- `lifecycle-completions`, `lifecycle-progress-token`, the two claim-less `_meta` probes (`lifecycle-meta-required`, `lifecycle-meta-protocol-version-required`, which on a dual-era stdio server would otherwise re-select the era before the process is pinned modern; a `--only` run on stdio that sent no pinning request sends the first declared list, else `ping`, first) and the informational `lifecycle-dual-era` probe (sent to a fresh process on stdio, because a dual-era server selects its era per process and the suite's own process is already modern); then security, whose 50-request rate-limit burst comes after every probe a tripped rate limiter could answer with 429; and finally the post-hoc scans over the recording. On HTTP a 401, 403, 413, 415 or 429 answer to a negative probe is a transport-level rejection and fails the probe as not evaluable rather than being credited.

---

## 2. Scoring Algorithm

### 2.1 Weight Distribution

Tests are divided into two pools: **required** (70% of total score) and **optional** (30% of total score).

```
Score = (requiredPassed / totalRequired) * 70
      + (optionalPassed / totalOptional) * 30
```

**Edge cases:**
- If there are **no required tests** in the result set (e.g., all were filtered out), the score is **renormalised** to the optional pool: `Score = (optionalPassed / totalOptional) * 100`.
- If there are **no optional tests** in the result set, the score is renormalised to the required pool: `Score = (requiredPassed / totalRequired) * 100`.
- If **no tests ran at all**, the score is **0** and the overall status is `fail` -- there is nothing to attest. (Earlier versions of this document gave an empty pool "full credit"; the implementation has renormalised since 0.13.2 because free credit inflated `--only` runs and capability-gated suites whose remaining tests were all optional.)
- The final score is **rounded to the nearest integer**.

### 2.2 Grade Thresholds

| Grade | Score Range | Interpretation |
|-------|------------|----------------|
| **A** | 90 -- 100 | Excellent compliance. All or nearly all tests pass. |
| **B** | 75 -- 89 | Good compliance. Most tests pass; minor gaps. |
| **C** | 60 -- 74 | Fair compliance. Core functionality works; notable gaps. |
| **D** | 40 -- 59 | Poor compliance. Significant issues. |
| **F** | 0 -- 39 | Failing. Major compliance failures. |

### 2.3 Overall Status

The overall status is a tri-state summary distinct from the numerical score:

| Status | Condition |
|--------|-----------|
| `pass` | All tests passed (required and optional). |
| `partial` | All **required** tests passed, but one or more **optional** tests failed. |
| `fail` | One or more **required** tests failed. |

---

## 3. Test Rules -- 2025-11-25

This section is the **2025-11-25** catalog (`TEST_DEFINITIONS` in `src/types.ts`, 88 rules). The 2026-07-28 catalog is in [section 3b](#3b-test-rules----2026-07-28). Each test rule is documented with the following fields:

- **Category**: The test category (`transport`, `lifecycle`, `tools`, `resources`, `prompts`, `errors`, `schema`, `security`).
- **Default required**: Whether the test is required by default. Some tests become required dynamically based on server capabilities (see [section 1.2](#12-capability-driven-execution)).
- **Spec reference**: The section of the MCP specification that this test validates. In this section all references are relative to `https://modelcontextprotocol.io/specification/2025-11-25/`.
- **Description**: What the test verifies and why.
- **Pass criteria**: The exact conditions under which the test is marked as passed.
- **Fail criteria**: The conditions under which the test is marked as failed.

---

### 3.1 transport -- Transport Validation (16 tests)

Transport tests run **before** the MCP initialization handshake. They validate that the server's transport endpoint behaves correctly at the wire level, before any MCP session state exists.

Two MCP transports are covered:

- **Streamable HTTP** (13 tests) — Tests an HTTP endpoint with raw `undici` requests. Applies to servers addressed by URL.
- **stdio** (3 tests) — Tests the framing and encoding of a child-process stdio server. Applies to servers launched by command. Identified by rules whose ID begins with `stdio-` and whose catalog entry includes `"transports": ["stdio"]`.

Only tests for the transport under test run; transport-gated rules that do not apply are **skipped** and do not count toward pass or fail. For a Streamable HTTP server, the three `stdio-*` tests are skipped; for a stdio server, the thirteen HTTP transport tests are skipped. Post-initialization transport tests (`transport-notification-202`, `transport-session-id`, `transport-session-invalid`, `transport-sse-event-field`) run after the initialize handshake completes, because they require session state.

---

#### `transport-post` -- HTTP POST Accepted

- **Category:** transport
- **Default required:** Yes
- **Spec reference:** [basic/transports#streamable-http](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#streamable-http)
- **Description:** Verifies the server accepts HTTP POST requests on its MCP endpoint. This is the most fundamental transport requirement: the Streamable HTTP transport uses POST for all client-to-server JSON-RPC messages.
- **Pass criteria:** Server returns HTTP 2xx for a POST request containing a JSON-RPC `ping` message.
- **Fail criteria:** Server returns a non-2xx status code. A note is appended if the status is 401 or 403 (authentication required).

---

#### `transport-content-type` -- Responds with JSON or SSE

- **Category:** transport
- **Default required:** Yes
- **Spec reference:** [basic/transports#streamable-http](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#streamable-http)
- **Description:** Validates that the server responds with one of the two content types permitted by the Streamable HTTP transport.
- **Pass criteria:** The `Content-Type` response header contains `application/json` or `text/event-stream`.
- **Fail criteria:** The `Content-Type` header contains neither of the expected values.

---

#### `transport-get` -- GET Returns SSE Stream or 405

- **Category:** transport
- **Default required:** No
- **Spec reference:** [basic/transports#streamable-http](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#streamable-http)
- **Description:** Tests the GET endpoint, which servers MAY use for server-initiated messages via SSE. Servers that do not support GET SHOULD return 405 Method Not Allowed.
- **Pass criteria:** Server returns HTTP 405, `text/event-stream` content type, or any 2xx status.
- **Fail criteria:** Server returns an error status other than 405 without an SSE content type.

---

#### `transport-delete` -- DELETE Accepted or Returns 405

- **Category:** transport
- **Default required:** No
- **Spec reference:** [basic/transports#streamable-http](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#streamable-http)
- **Description:** Tests the DELETE endpoint, which is used for session termination. Servers that do not support session termination via DELETE SHOULD return 405.
- **Pass criteria:** Server returns HTTP 405, any 2xx, 400, or 404. (400 and 404 are acceptable because there may be no active session.)
- **Fail criteria:** Server returns an error status other than 405, 400, or 404.

---

#### `transport-batch-reject` -- Rejects JSON-RPC Batch Requests

- **Category:** transport
- **Default required:** Yes
- **Spec reference:** [basic/transports#streamable-http](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#streamable-http)
- **Description:** MCP explicitly forbids JSON-RPC batch requests (arrays of messages). This test sends a batch array and verifies the server rejects it.
- **Pass criteria:** Server returns HTTP 4xx status **or** a JSON-RPC error response (non-array body with `error` field).
- **Fail criteria:** Server processes the batch and returns an array response, or returns a 2xx status without an error.

---

#### `transport-notification-202` -- Notification Returns 202 Accepted

- **Category:** transport
- **Default required:** No
- **Spec reference:** [basic/transports#streamable-http](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#streamable-http)
- **Description:** Per the MCP spec, servers MUST return HTTP 202 Accepted (with no body) for JSON-RPC notifications (messages without an `id` field). This test runs **post-initialization** because some servers require session state to accept notifications.
- **Pass criteria:** Server returns HTTP 202 or any 2xx status. (202 is correct per spec; other 2xx codes are accepted leniently.)
- **Fail criteria:** Server returns a non-2xx status.

---

#### `transport-session-id` -- Enforces MCP-Session-Id After Init

- **Category:** transport
- **Default required:** No
- **Spec reference:** [basic/transports#streamable-http](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#streamable-http)
- **Description:** If the server issued an `MCP-Session-Id` header during initialization, subsequent requests without that header SHOULD be rejected with HTTP 400. This test runs **post-initialization**.
- **Pass criteria:** Server returns HTTP 400 when the `MCP-Session-Id` header is omitted from a request (after the server issued one during init). **Auto-pass** if the server did not issue a session ID.
- **Fail criteria:** Server returns 2xx when the session ID header is missing (and the server had previously issued one).

#### `transport-content-type-init` -- Initialize Response Has Valid Content Type

- **Category:** transport
- **Default required:** No
- **Spec reference:** [basic/transports#streamable-http](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#streamable-http)
- **Description:** Validates that the initialize response uses `application/json` or `text/event-stream` content type.
- **Pass criteria:** Content-Type includes `application/json` or `text/event-stream`.
- **Fail criteria:** Content-Type is neither `application/json` nor `text/event-stream`.

#### `transport-get-stream` -- GET with Session Returns SSE or 405

- **Category:** transport
- **Default required:** No
- **Spec reference:** [basic/transports#streamable-http](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#streamable-http)
- **Description:** Tests the GET endpoint with an active session ID for server-initiated messages. After initialization, the server should either return an SSE stream or 405.
- **Pass criteria:** Returns `text/event-stream` or HTTP 405.
- **Fail criteria:** Returns other status or content type.

#### `transport-concurrent` -- Handles Concurrent Requests

- **Category:** transport
- **Default required:** No
- **Spec reference:** [basic/transports#streamable-http](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#streamable-http)
- **Description:** Sends multiple JSON-RPC requests in parallel and verifies the server responds to all with correct matching IDs.
- **Pass criteria:** All concurrent requests receive responses with correct matching IDs.
- **Fail criteria:** Any response has a mismatched ID or non-2xx status.

---

#### `transport-session-invalid` -- Returns 404 for Unknown Session ID

- **Category:** transport
- **Default required:** No
- **Spec reference:** [basic/transports#streamable-http](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#streamable-http)
- **Description:** Sends a request with a fabricated `MCP-Session-Id` and verifies the server returns HTTP 404. Per spec, servers managing sessions MUST return 404 for unrecognized session IDs; 400 is reserved for the case of a missing session ID.
- **Pass criteria:** HTTP 404 for a request that carries a syntactically valid but unrecognized `MCP-Session-Id`. **Auto-pass** if the server does not issue session IDs.
- **Fail criteria:** Server returns 2xx, 400, or any non-404 status for the fabricated session ID.

---

#### `transport-content-type-reject` -- Rejects Non-JSON Request Content-Type

- **Category:** transport
- **Default required:** No
- **Spec reference:** [basic/transports#streamable-http](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#streamable-http)
- **Description:** Sends a POST with `Content-Type: text/plain` (and a JSON body) and verifies the server rejects it. The Streamable HTTP transport requires JSON request bodies; servers that accept other content types expand their attack surface.
- **Pass criteria:** Server returns HTTP 4xx (ideally 415 Unsupported Media Type or 400 Bad Request).
- **Fail criteria:** Server returns 2xx, attempts to parse the body, or returns 5xx.

---

#### `transport-sse-event-field` -- SSE Responses Include `event: message`

- **Category:** transport
- **Default required:** No
- **Spec reference:** [basic/transports#streamable-http](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#streamable-http)
- **Description:** When the client sends `Accept: text/event-stream`, the server may respond with an SSE stream. Per spec, each SSE frame carrying a JSON-RPC message MUST be prefixed with an `event: message` line before its `data:` line. This runs **post-initialization** because some servers only emit SSE after an active session exists.
- **Pass criteria:** Every SSE frame that carries a JSON-RPC payload includes an `event: message` line preceding its `data:` line. **Auto-pass** if the server responds with `application/json` (no SSE emitted).
- **Fail criteria:** Any SSE frame with a `data:` line has no preceding `event: message` line.

---

#### `stdio-framing` -- Newline-Delimited JSON Framing

- **Category:** transport
- **Default required:** Yes (stdio transport only)
- **Spec reference:** [basic/transports#stdio](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#stdio)
- **Transports:** `stdio`
- **Description:** Fires several JSON-RPC requests in rapid succession against a stdio server and verifies each response is emitted as a single line on stdout terminated by `\n`. The stdio transport defines one JSON message per line; merging messages, splitting a message across lines, or omitting the trailing newline breaks framing for conforming clients.
- **Pass criteria:** Every response arrives as exactly one line (newline-terminated) with a single parseable JSON value.
- **Fail criteria:** Any response is split across lines, merged with another response, or missing the trailing newline.

---

#### `stdio-unicode` -- UTF-8 Unicode Roundtrip

- **Category:** transport
- **Default required:** No (stdio transport only)
- **Spec reference:** [basic/transports#stdio](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#stdio)
- **Transports:** `stdio`
- **Description:** Sends a request containing non-ASCII characters (CJK + emoji) in its parameters and verifies the response preserves the characters byte-for-byte. Catches encoding mistakes that surface most often on Windows stdio — platform-default code pages, `latin-1` decoding, or byte-swapped UTF-16.
- **Pass criteria:** The response echoes the non-ASCII payload unchanged when the stream is read as UTF-8.
- **Fail criteria:** The payload comes back mojibake, mangled, or replaced with `?` substitution characters.

---

#### `stdio-unknown-method-recovers` -- Recovers After Unknown Method

- **Category:** transport
- **Default required:** No (stdio transport only)
- **Spec reference:** [basic/transports#stdio](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#stdio)
- **Transports:** `stdio`
- **Description:** Sends an unknown method, then immediately sends a valid `ping`. Verifies the server returns a JSON-RPC `-32601` error for the unknown method and continues serving the follow-up request without exiting or closing its stdio streams. A stdio server that exits on unknown methods is effectively unusable from a persistent client.
- **Pass criteria:** The unknown-method request receives a JSON-RPC error, and the subsequent `ping` receives a valid result.
- **Fail criteria:** The process exits, closes stdout, or fails to respond to the follow-up `ping`.

---

### 3.2 lifecycle -- Protocol Lifecycle (21 tests)

Lifecycle tests validate the MCP initialization handshake and post-initialization protocol behavior. The test harness first performs the `initialize` request and sends the `notifications/initialized` notification, then validates the response fields and tests post-init operations.

---

#### `lifecycle-init` -- Initialize Handshake

- **Category:** lifecycle
- **Default required:** Yes
- **Spec reference:** [basic/lifecycle#initialization](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#initialization)
- **Description:** Tests the core initialization handshake. The client sends an `initialize` request with `protocolVersion`, `capabilities`, and `clientInfo`. The server must respond with a `result` containing `protocolVersion`.
- **Pass criteria:** The initialize response contains a `result` object with a `protocolVersion` field.
- **Fail criteria:** The initialize request fails, returns no `result`, or the `result` is missing `protocolVersion`.

---

#### `lifecycle-proto-version` -- Returns Valid Protocol Version

- **Category:** lifecycle
- **Default required:** Yes
- **Spec reference:** [basic/lifecycle#version-negotiation](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#version-negotiation)
- **Description:** Validates the format of the negotiated protocol version. The MCP spec requires protocol versions to follow the `YYYY-MM-DD` date format.
- **Pass criteria:** `protocolVersion` matches the regex `^\d{4}-\d{2}-\d{2}$`. A warning is emitted if the version is valid but not `2025-11-25` (the latest).
- **Fail criteria:** `protocolVersion` is missing or does not match the `YYYY-MM-DD` format.

---

#### `lifecycle-server-info` -- Includes serverInfo

- **Category:** lifecycle
- **Default required:** No
- **Spec reference:** [basic/lifecycle#initialization](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#initialization)
- **Description:** Checks that the server includes a `serverInfo` object in its initialize response. While the MCP spec defines this as part of the response structure, this test treats it as optional since some servers may omit it.
- **Pass criteria:** `serverInfo` object exists and contains a `name` field.
- **Fail criteria:** `serverInfo` is missing or does not contain `name`.

---

#### `lifecycle-capabilities` -- Returns Capabilities Object

- **Category:** lifecycle
- **Default required:** Yes
- **Spec reference:** [basic/lifecycle#capability-negotiation](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#capability-negotiation)
- **Description:** Verifies the server returns a `capabilities` object in its initialize response. An empty object (`{}`) is valid -- it means the server declares no optional capabilities.
- **Pass criteria:** `capabilities` is present and is an object (including empty objects).
- **Fail criteria:** `capabilities` is missing, `null`, or not an object.

---

#### `lifecycle-jsonrpc` -- Response Is Valid JSON-RPC 2.0

- **Category:** lifecycle
- **Default required:** Yes
- **Spec reference:** [basic](https://modelcontextprotocol.io/specification/2025-11-25/basic)
- **Description:** Validates that the initialize response conforms to JSON-RPC 2.0 message structure. All MCP messages must be valid JSON-RPC 2.0.
- **Pass criteria:** Response has `jsonrpc` equal to `"2.0"`, an `id` field, and either a `result` or `error` field.
- **Fail criteria:** Any of the three required JSON-RPC 2.0 fields is missing.

---

#### `lifecycle-ping` -- Responds to Ping

- **Category:** lifecycle
- **Default required:** Yes
- **Spec reference:** [basic/utilities#ping](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities#ping)
- **Description:** Tests that the server responds to the `ping` method. Ping is a required utility method used for keepalive and connectivity checks.
- **Pass criteria:** The `ping` response contains a `result` (any value, including an empty object).
- **Fail criteria:** The response contains an `error` or has no `result`.

---

#### `lifecycle-instructions` -- Instructions Field Is Valid

- **Category:** lifecycle
- **Default required:** No
- **Spec reference:** [basic/lifecycle#initialization](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#initialization)
- **Description:** If the server includes an `instructions` field in the initialize response, this test validates that it is a string. The `instructions` field is optional and provides guidance for how the client should interact with the server.
- **Pass criteria:** `instructions` is absent (field is optional) **or** `instructions` is a string.
- **Fail criteria:** `instructions` is present but is not a string.

---

#### `lifecycle-id-match` -- Response ID Matches Request ID

- **Category:** lifecycle
- **Default required:** Yes
- **Spec reference:** [basic](https://modelcontextprotocol.io/specification/2025-11-25/basic)
- **Description:** A fundamental JSON-RPC 2.0 requirement: the response `id` must match the request `id`. This test sends a `ping` and verifies the IDs match.
- **Pass criteria:** Response `id` is strictly equal (`===`) to the request `id`.
- **Fail criteria:** Response `id` does not match the request `id`, or `id` is missing from the response.

---

#### `lifecycle-logging` -- logging/setLevel Accepted

- **Category:** lifecycle
- **Default required:** No (becomes **required** if server declares `logging` capability)
- **Spec reference:** [server/utilities#logging](https://modelcontextprotocol.io/specification/2025-11-25/server/utilities#logging)
- **Description:** If the server declares the `logging` capability, it must support the `logging/setLevel` method. This test sends a `logging/setLevel` request with level `"info"`.
- **Pass criteria:** The request succeeds without error. **Auto-pass** if the server does not declare `logging` capability.
- **Fail criteria:** The server returns a JSON-RPC error.

---

#### `lifecycle-completions` -- completion/complete Accepted

- **Category:** lifecycle
- **Default required:** No (becomes **required** if server declares `completions` capability)
- **Spec reference:** [server/utilities#completion](https://modelcontextprotocol.io/specification/2025-11-25/server/utilities#completion)
- **Description:** If the server declares the `completions` capability, it must support the `completion/complete` method. This test sends a completion request with a test prompt reference.
- **Pass criteria:** The request returns a `result`, or returns error code `-32602` (InvalidParams), which is acceptable since the test prompt reference does not exist. **Auto-pass** if the server does not declare `completions` capability.
- **Fail criteria:** The server returns any other error.

#### `lifecycle-cancellation` -- Handles Cancellation Notifications

- **Category:** lifecycle
- **Default required:** No
- **Spec reference:** [basic/utilities#cancellation](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities#cancellation)
- **Description:** Tests that the server accepts `notifications/cancelled` without error. Servers should gracefully handle cancellation of unknown or completed requests.
- **Pass criteria:** Server accepts the cancellation notification (2xx response).
- **Fail criteria:** Server returns an error for the cancellation notification.

#### `lifecycle-progress` -- Accepts Progress Notifications

- **Category:** lifecycle
- **Default required:** No
- **Spec reference:** [basic/utilities#progress](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities#progress)
- **Description:** Tests that the server accepts `notifications/progress` without error. Servers should handle progress notifications for request tracking.
- **Pass criteria:** Server accepts the progress notification (2xx response).
- **Fail criteria:** Server returns an error for the progress notification.

---

#### `lifecycle-string-id` -- Supports String Request IDs

- **Category:** lifecycle
- **Default required:** No
- **Spec reference:** [basic](https://modelcontextprotocol.io/specification/2025-11-25/basic)
- **Description:** Sends a request with a string `id` (for example `"abc-123"`) instead of a number. JSON-RPC 2.0 permits both string and number IDs; the server MUST echo the exact value with its original type.
- **Pass criteria:** The response `id` is strictly equal to the request `id` and remains a string.
- **Fail criteria:** The response `id` is missing, has a different value, or has been coerced to a number.

---

#### `lifecycle-version-negotiate` -- Handles Unknown Protocol Version

- **Category:** lifecycle
- **Default required:** No
- **Spec reference:** [basic/lifecycle#version-negotiation](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#version-negotiation)
- **Description:** Sends an `initialize` request with a future `protocolVersion` (for example `"2099-01-01"`) and verifies the server negotiates down to a supported version or returns an error. Silently accepting unknown versions invites undefined behavior on both sides.
- **Pass criteria:** The server either returns a supported `protocolVersion` it understands or returns a JSON-RPC error.
- **Fail criteria:** The server echoes the unknown version back as if it supported it.

---

#### `lifecycle-reinit-reject` -- Rejects Second Initialize Request

- **Category:** lifecycle
- **Default required:** No
- **Spec reference:** [basic/lifecycle#initialization](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#initialization)
- **Description:** Sends a second `initialize` request within an already-initialized session. Per spec, the client MUST NOT send `initialize` more than once per session; the server SHOULD reject the duplicate rather than reset its state.
- **Pass criteria:** Server returns a JSON-RPC error or HTTP 4xx for the second `initialize`.
- **Fail criteria:** Server accepts the duplicate `initialize` and returns a 2xx result (session state may now be inconsistent).

---

#### `lifecycle-list-changed` -- Accepts listChanged Notifications

- **Category:** lifecycle
- **Default required:** No
- **Spec reference:** [basic/lifecycle#capability-negotiation](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#capability-negotiation)
- **Description:** Sends `notifications/tools/list_changed`, `notifications/resources/list_changed`, and `notifications/prompts/list_changed` for each declared capability, and verifies the server accepts each one without error. These notifications signal that cached list data may be stale.
- **Pass criteria:** Server accepts every applicable `list_changed` notification (2xx response, no JSON-RPC error).
- **Fail criteria:** Server returns an error or rejects a `list_changed` notification for a capability it declared.

---

#### `lifecycle-progress-token` -- Supports Progress Tokens in Requests

- **Category:** lifecycle
- **Default required:** No
- **Spec reference:** [basic/utilities#progress](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities#progress)
- **Description:** Sends a `tools/call` request with `_meta.progressToken` set and observes whether the server emits `notifications/progress` events carrying that token. Progress support is optional but strongly recommended for long-running tool invocations. **Auto-pass** if the server does not declare `tools` capability.
- **Pass criteria:** Server either emits at least one progress notification that references the supplied `progressToken`, or completes the request normally and ignores the token without error.
- **Fail criteria:** Server returns an error specifically because of the `_meta.progressToken` field.

---

#### `lifecycle-sampling-capability` -- Sampling Capability Shape

- **Category:** lifecycle
- **Default required:** No
- **Spec reference:** [client/sampling](https://modelcontextprotocol.io/specification/2025-11-25/client/sampling)
- **Description:** `sampling` is a *client* capability — the client offers LLM access to the server. This test performs a shape check: the server's `initialize` response MUST NOT declare `sampling` in its own `capabilities` object (servers are consumers of sampling, not providers). A dedicated round-trip exercise requires a client-side sampling handler and is out of scope for this methodology.
- **Pass criteria:** The server's `capabilities` object does not include a `sampling` key.
- **Fail criteria:** The server declares a `sampling` capability on its own side (shape error).

---

#### `lifecycle-roots-capability` -- Roots Capability Shape

- **Category:** lifecycle
- **Default required:** No
- **Spec reference:** [client/roots](https://modelcontextprotocol.io/specification/2025-11-25/client/roots)
- **Description:** `roots` is a *client* capability indicating the client exposes filesystem roots to the server. This test performs a shape check: the server's `initialize` response MUST NOT declare `roots` as its own capability. If a server ever sends `roots/list` requests, it must first confirm the connected client declared `roots` — this test does not exercise that flow, it only validates the declared shape.
- **Pass criteria:** The server's `capabilities` object does not include a `roots` key.
- **Fail criteria:** The server declares a `roots` capability on its own side.

---

#### `lifecycle-elicitation-capability` -- Elicitation Capability Shape

- **Category:** lifecycle
- **Default required:** No
- **Spec reference:** [client/elicitation](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation)
- **Description:** `elicitation` (asking the user for structured input mid-operation) is a *client* capability introduced in MCP spec version `2025-11-25`. The server's `initialize` response MUST NOT declare `elicitation` as its own capability. Servers that issue `elicitation/create` requests must first verify the client advertised the capability — this test validates only the declared shape.
- **Pass criteria:** The server's `capabilities` object does not include an `elicitation` key.
- **Fail criteria:** The server declares an `elicitation` capability on its own side.

---

#### `lifecycle-meta-tolerance` -- Tolerates `_meta` Field on Requests

- **Category:** lifecycle
- **Default required:** No
- **Spec reference:** [basic/utilities#_meta](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities#_meta)
- **Description:** Sends a `ping` with `params._meta = { extra: "value" }` and verifies the server does not error. The 2025-11-25 spec reserves `_meta` for protocol and forward-compatible extension metadata on any request; servers MUST ignore unknown `_meta` keys rather than reject the request.
- **Pass criteria:** Server returns a normal result for the `ping` regardless of the `_meta` content.
- **Fail criteria:** Server returns a JSON-RPC error that cites the `_meta` field as the cause.

---

### 3.3 tools -- Tool Operations (4 tests)

Tool tests only run if the server declares the `tools` capability. They validate tool listing, invocation, pagination, and content type conformance.

---

#### `tools-list` -- tools/list Returns Valid Response

- **Category:** tools
- **Default required:** No (becomes **required** if server declares `tools` capability)
- **Spec reference:** [server/tools#listing-tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#listing-tools)
- **Description:** Calls `tools/list` and validates the response structure. The response must contain an array of tool objects.
- **Pass criteria:** `result.tools` is an array.
- **Fail criteria:** `result.tools` is missing or not an array.

---

#### `tools-call` -- tools/call Responds Correctly

- **Category:** tools
- **Default required:** No
- **Spec reference:** [server/tools#calling-tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#calling-tools)
- **Description:** Calls the first tool with empty arguments and verifies the response format. Only runs if the server has at least one tool. Errors are acceptable since the tool may require specific arguments.
- **Pass criteria:** Response contains `result.content` as an array, **or** the server returns any JSON-RPC error (errors are acceptable -- the tool may require arguments).
- **Fail criteria:** Response has neither a `content` array nor a JSON-RPC error.

---

#### `tools-pagination` -- tools/list Supports Pagination

- **Category:** tools
- **Default required:** No
- **Spec reference:** [server/tools#listing-tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#listing-tools)
- **Description:** Tests cursor-based pagination on `tools/list`. If the response includes a `nextCursor`, the test fetches the next page and validates it.
- **Pass criteria:** `nextCursor` is absent (single page) **or** `nextCursor` is a string and the next page returns a valid `tools` array.
- **Fail criteria:** `nextCursor` is present but not a string, or the next page fails to return a `tools` array.

---

#### `tools-content-types` -- Tool Content Items Have Valid Types

- **Category:** tools
- **Default required:** No
- **Spec reference:** [server/tools#calling-tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#calling-tools)
- **Description:** Validates that content items returned by `tools/call` have a recognized `type` field. Only runs if the server has at least one tool.
- **Pass criteria:** All content items have `type` in `[text, image, audio, resource, resource_link]`, **or** the tool returns an error (content types not applicable).
- **Fail criteria:** Any content item has an unknown or missing `type`.

---

### 3.4 resources -- Resource Operations (5 tests)

Resource tests only run if the server declares the `resources` capability. They validate resource listing, reading, templates, pagination, and subscriptions.

---

#### `resources-list` -- resources/list Returns Valid Response

- **Category:** resources
- **Default required:** No (becomes **required** if server declares `resources` capability)
- **Spec reference:** [server/resources#listing-resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources#listing-resources)
- **Description:** Calls `resources/list` and validates the response structure.
- **Pass criteria:** `result.resources` is an array.
- **Fail criteria:** `result.resources` is missing or not an array.

---

#### `resources-read` -- resources/read Returns Content

- **Category:** resources
- **Default required:** No
- **Spec reference:** [server/resources#reading-resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources#reading-resources)
- **Description:** Reads the first resource and validates the response structure. Only runs if the server has at least one resource.
- **Pass criteria:** Response contains a `contents` array where each item has a `uri` field and at least one of `text` or `blob`.
- **Fail criteria:** `contents` is missing or not an array, or any content item is missing `uri` or both `text` and `blob`.

---

#### `resources-templates` -- resources/templates/list Returns Valid Response

- **Category:** resources
- **Default required:** No
- **Spec reference:** [server/resources#resource-templates](https://modelcontextprotocol.io/specification/2025-11-25/server/resources#resource-templates)
- **Description:** Tests the resource templates endpoint. Resource templates are optional, so `-32601` (Method not found) is an acceptable response.
- **Pass criteria:** Response contains a `resourceTemplates` array where each item has `uriTemplate` and `name`, **or** the server returns error code `-32601` (Method not supported).
- **Fail criteria:** Any other error, or the response has an invalid structure (missing `uriTemplate` or `name` on template items).

---

#### `resources-pagination` -- resources/list Supports Pagination

- **Category:** resources
- **Default required:** No
- **Spec reference:** [server/resources#listing-resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources#listing-resources)
- **Description:** Tests cursor-based pagination on `resources/list`. Same pattern as `tools-pagination`.
- **Pass criteria:** `nextCursor` is absent (single page) **or** `nextCursor` is a string and the next page returns a valid `resources` array.
- **Fail criteria:** `nextCursor` is present but not a string, or the next page fails to return a `resources` array.

---

#### `resources-subscribe` -- Resource Subscribe/Unsubscribe

- **Category:** resources
- **Default required:** No (becomes **required** if server declares `resources.subscribe` capability)
- **Spec reference:** [server/resources#subscriptions](https://modelcontextprotocol.io/specification/2025-11-25/server/resources#subscriptions)
- **Description:** If the server declares `resources.subscribe` capability and has at least one resource, this test subscribes to and then unsubscribes from the first resource.
- **Pass criteria:** Both `resources/subscribe` and `resources/unsubscribe` succeed without error.
- **Fail criteria:** Either request returns a JSON-RPC error.

---

### 3.5 prompts -- Prompt Operations (3 tests)

Prompt tests only run if the server declares the `prompts` capability. They validate prompt listing, retrieval, and pagination.

---

#### `prompts-list` -- prompts/list Returns Valid Response

- **Category:** prompts
- **Default required:** No (becomes **required** if server declares `prompts` capability)
- **Spec reference:** [server/prompts#listing-prompts](https://modelcontextprotocol.io/specification/2025-11-25/server/prompts#listing-prompts)
- **Description:** Calls `prompts/list` and validates the response structure.
- **Pass criteria:** `result.prompts` is an array.
- **Fail criteria:** `result.prompts` is missing or not an array.

---

#### `prompts-get` -- prompts/get Returns Valid Messages

- **Category:** prompts
- **Default required:** No
- **Spec reference:** [server/prompts#getting-a-prompt](https://modelcontextprotocol.io/specification/2025-11-25/server/prompts#getting-a-prompt)
- **Description:** Gets the first prompt and validates the response structure. Only runs if the server has at least one prompt. Errors are acceptable since the prompt may require arguments.
- **Pass criteria:** Response contains a `messages` array where each message has a valid `role` (`user` or `assistant`) and `content` field, **or** the server returns an error (prompt may require arguments).
- **Fail criteria:** `messages` array is missing, or any message has an invalid `role` or missing `content`.

---

#### `prompts-pagination` -- prompts/list Supports Pagination

- **Category:** prompts
- **Default required:** No
- **Spec reference:** [server/prompts#listing-prompts](https://modelcontextprotocol.io/specification/2025-11-25/server/prompts#listing-prompts)
- **Description:** Tests cursor-based pagination on `prompts/list`. Same pattern as `tools-pagination`.
- **Pass criteria:** `nextCursor` is absent (single page) **or** `nextCursor` is a string and the next page returns a valid `prompts` array.
- **Fail criteria:** `nextCursor` is present but not a string, or the next page fails to return a `prompts` array.

---

### 3.6 errors -- Error Handling (10 tests)

Error handling tests validate that the server correctly rejects invalid requests. These tests always run regardless of declared capabilities, because error handling is a baseline requirement for all MCP servers.

---

#### `error-unknown-method` -- Returns JSON-RPC Error for Unknown Method

- **Category:** errors
- **Default required:** Yes
- **Spec reference:** [basic](https://modelcontextprotocol.io/specification/2025-11-25/basic)
- **Description:** Sends a request with a nonexistent method name and verifies the server returns a JSON-RPC error.
- **Pass criteria:** Response contains an `error` field (any JSON-RPC error).
- **Fail criteria:** Response does not contain an `error` field.

---

#### `error-method-code` -- Uses Correct Error Code for Unknown Method

- **Category:** errors
- **Default required:** No
- **Spec reference:** [basic](https://modelcontextprotocol.io/specification/2025-11-25/basic)
- **Description:** Checks that the server uses the correct JSON-RPC 2.0 error code for unknown methods. The JSON-RPC 2.0 specification requires `-32601` (Method not found).
- **Pass criteria:** `error.code` is exactly `-32601`.
- **Fail criteria:** `error.code` is any other value, or no error is returned.

---

#### `error-invalid-jsonrpc` -- Handles Malformed JSON-RPC

- **Category:** errors
- **Default required:** Yes
- **Spec reference:** [basic](https://modelcontextprotocol.io/specification/2025-11-25/basic)
- **Description:** Sends a malformed JSON-RPC message (a JSON object missing required `jsonrpc`, `id`, and `method` fields) and verifies the server rejects it.
- **Pass criteria:** Server returns a JSON-RPC error response **or** HTTP 4xx status.
- **Fail criteria:** Server returns neither a JSON-RPC error nor an HTTP 4xx status.

---

#### `error-invalid-json` -- Handles Invalid JSON Body

- **Category:** errors
- **Default required:** No
- **Spec reference:** [basic](https://modelcontextprotocol.io/specification/2025-11-25/basic)
- **Description:** Sends a body that is not valid JSON and verifies the server returns a parse error.
- **Pass criteria:** Server returns a JSON-RPC error response **or** HTTP 4xx status.
- **Fail criteria:** Server returns neither a JSON-RPC error nor an HTTP 4xx status.

---

#### `error-missing-params` -- Returns Error for tools/call Without Name

- **Category:** errors
- **Default required:** No
- **Spec reference:** [server/tools#error-handling](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#error-handling)
- **Description:** Calls `tools/call` with an empty params object (missing the required `name` field) and verifies the server returns an error.
- **Pass criteria:** Server returns a JSON-RPC error **or** a result with `isError: true`.
- **Fail criteria:** Server returns no error.

---

#### `error-parse-code` -- Returns -32700 for Invalid JSON

- **Category:** errors
- **Default required:** No
- **Spec reference:** [basic](https://modelcontextprotocol.io/specification/2025-11-25/basic)
- **Description:** Validates that the server returns the specific JSON-RPC 2.0 error code `-32700` (Parse error) when it receives invalid JSON. This is stricter than `error-invalid-json`, which accepts any error.
- **Pass criteria:** Response contains a JSON-RPC error with `code` exactly equal to `-32700`.
- **Fail criteria:** Error code is not `-32700`, no JSON-RPC error is returned, or only an HTTP error status is returned without a JSON-RPC error body.

---

#### `error-invalid-request-code` -- Returns -32600 for Invalid Request

- **Category:** errors
- **Default required:** No
- **Spec reference:** [basic](https://modelcontextprotocol.io/specification/2025-11-25/basic)
- **Description:** Validates that the server returns the specific JSON-RPC 2.0 error code `-32600` (Invalid Request) when it receives a JSON-RPC message missing required fields (valid JSON, but not a valid JSON-RPC request).
- **Pass criteria:** Response contains a JSON-RPC error with `code` exactly equal to `-32600`.
- **Fail criteria:** Error code is not `-32600`, no JSON-RPC error is returned, or only an HTTP error status is returned without a JSON-RPC error body.

---

#### `tools-call-unknown` -- Returns Error for Unknown Tool Name

- **Category:** errors
- **Default required:** No
- **Spec reference:** [server/tools#error-handling](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#error-handling)
- **Description:** Calls `tools/call` with a nonexistent tool name and verifies the server returns an error. Only runs if the server declares `tools` capability.
- **Pass criteria:** Server returns a JSON-RPC error **or** a result with `isError: true`.
- **Fail criteria:** Server returns no error for the nonexistent tool.

---

#### `error-capability-gated` -- Rejects Methods for Undeclared Capabilities

- **Category:** errors
- **Default required:** No
- **Spec reference:** [basic/lifecycle#capability-negotiation](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#capability-negotiation)
- **Description:** Calls list methods (`tools/list`, `resources/list`, `prompts/list`) for capabilities the server did **not** declare in its `initialize` response and verifies each receives an error. Servers that silently handle methods for undeclared capabilities mislead clients about their available surface.
- **Pass criteria:** For every list method whose capability was not declared, the server returns a JSON-RPC error (preferably `-32601` Method not found).
- **Fail criteria:** The server returns a successful result for a list method whose capability it did not declare.

---

#### `error-invalid-cursor` -- Handles Invalid Pagination Cursor Gracefully

- **Category:** errors
- **Default required:** No
- **Spec reference:** [basic](https://modelcontextprotocol.io/specification/2025-11-25/basic)
- **Description:** Sends a garbage `cursor` value to a list method that supports pagination and verifies the server handles it gracefully — either returning a JSON-RPC error or treating the invalid cursor as a request for the first page. Returning a 5xx or crashing the session indicates unvalidated cursor input.
- **Pass criteria:** Server returns a JSON-RPC error **or** a valid first-page list response.
- **Fail criteria:** Server returns 5xx, crashes the session, or returns a malformed body.

---

### 3.7 schema -- Schema Validation (6 tests)

Schema validation tests examine the structural correctness of the data returned by list operations (`tools/list`, `prompts/list`, `resources/list`). These tests run after their corresponding list operations have populated the cached data.

---

#### `tools-schema` -- All Tools Have Name and inputSchema

- **Category:** schema
- **Default required:** No (becomes **required** if server declares `tools` capability)
- **Spec reference:** [server/tools#data-types](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#data-types)
- **Description:** Validates every tool returned by `tools/list`. Each tool must have a valid `name` and an `inputSchema` that is a JSON Schema object with `type: "object"`.
- **Pass criteria:** Every tool has:
  - A `name` that is 1--128 characters, matching `[A-Za-z0-9_.\-]+`
  - An `inputSchema` that is a non-null object with `type` equal to `"object"`
- **Fail criteria:** Any tool is missing `name`, has an invalid name format, is missing `inputSchema`, or has an `inputSchema` that is not an object or whose `type` is not `"object"`.
- **Warnings:** Emitted for tools missing a `description` field (does not cause failure).

---

#### `tools-annotations` -- Tool Annotations Are Valid

- **Category:** schema
- **Default required:** No
- **Spec reference:** [server/tools#annotations](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#annotations)
- **Description:** If any tools include the optional `annotations` object, validates the types of annotation fields.
- **Pass criteria:** For every tool with `annotations`:
  - `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` are booleans (if present)
  - `title` is a string (if present)
  - **Auto-pass** if no tools have annotations.
- **Fail criteria:** Any annotation field has the wrong type.

---

#### `tools-title-field` -- Tools Include Title Field

- **Category:** schema
- **Default required:** No
- **Spec reference:** [server/tools#data-types](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#data-types)
- **Description:** Checks if tools include the optional `title` field for human-readable display names (added in spec version 2025-11-25). Reports how many tools include it.
- **Pass criteria:** `title` is absent on all tools **or** `title` is a valid string on every tool that includes it.
- **Fail criteria:** `title` is present on a tool but is not a string.

---

#### `tools-output-schema` -- Tools with outputSchema Are Valid

- **Category:** schema
- **Default required:** No
- **Spec reference:** [server/tools#structured-content](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#structured-content)
- **Description:** If any tools declare an `outputSchema` for structured output, validates that it is a valid JSON Schema object.
- **Pass criteria:** `outputSchema` is absent **or** is a non-null object with `type` equal to `"object"`.
- **Fail criteria:** `outputSchema` is present but is not an object, is null, or has `type` other than `"object"`.

---

#### `prompts-schema` -- Prompts Have Name Field

- **Category:** schema
- **Default required:** No (becomes **required** if server declares `prompts` capability)
- **Spec reference:** [server/prompts#data-types](https://modelcontextprotocol.io/specification/2025-11-25/server/prompts#data-types)
- **Description:** Validates every prompt returned by `prompts/list`. Each prompt must have a `name`, and any `arguments` array must contain items with `name` fields.
- **Pass criteria:** Every prompt has a `name` field, and if `arguments` is present, it is an array where each item has a `name`.
- **Fail criteria:** Any prompt is missing `name`, `arguments` is present but not an array, or any argument item is missing `name`.
- **Warnings:** Emitted for prompts missing a `description` field (does not cause failure).

---

#### `resources-schema` -- Resources Have URI and Name

- **Category:** schema
- **Default required:** No (becomes **required** if server declares `resources` capability)
- **Spec reference:** [server/resources#data-types](https://modelcontextprotocol.io/specification/2025-11-25/server/resources#data-types)
- **Description:** Validates every resource returned by `resources/list`. Each resource must have a parseable URI and a `name` field.
- **Pass criteria:** Every resource has a `uri` that is parseable as a URL and a `name` field.
- **Fail criteria:** Any resource is missing `uri`, has an unparseable URI, or is missing `name`.
- **Warnings:** Emitted for resources missing `description` or `mimeType` fields (does not cause failure).

### 3.8 security -- Security Validation (23 tests)

Security tests verify authentication enforcement, input validation, tool integrity, information disclosure, and rate limiting. These tests run after all functional tests and require an established MCP session.

**Sub-categories:**

- **Auth & Transport** (10 tests) -- Verifies authentication is required and properly enforced, 401 responses carry `WWW-Authenticate`, TLS is required, session IDs are high-entropy, session IDs don't bypass auth, OAuth metadata exists, tokens never appear in query strings, CORS is restrictive, and the Origin header is validated to prevent DNS rebinding.
- **Input Validation** (6 tests) -- Tests tools for command injection, SQL injection, path traversal, SSRF, oversized input handling, and extra parameter handling. Input validation tests are capability-gated on `tools`.
- **Tool Integrity** (4 tests) -- Checks that all tools define schemas, tool definitions are stable across calls (rug-pull detection), descriptions are free of prompt injection patterns, and tools don't cross-reference each other.
- **Information Disclosure & Rate Limiting** (3 tests) -- Verifies error responses don't leak stack traces or internal IPs, and that rate limiting is enforced under burst traffic.

All security tests are **optional** by default (severity: warning). They do not affect the overall pass/fail determination for protocol compliance but significantly impact the security posture score.

#### `security-auth-required` -- Rejects unauthenticated requests

- **Default required:** No
- **Spec reference:** [basic/authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- **Description:** Sends a request without an Authorization header and verifies the server returns HTTP 401 or 403.
- **Pass criteria:** HTTP 401 or 403 for an unauthenticated request. With `--auth` the test re-sends a request without its Authorization header; without `--auth` the unauthenticated preflight stands in for the probe, and a 401/403 there passes (the details suggest `--auth` to run the authenticated suite and the remaining auth tests).
- **Fail criteria:** Server accepts an unauthenticated request (without `--auth`: the unauthenticated preflight was served).
- **Prerequisites:** None; `--auth` lets the test strip a working credential and verify the rejection directly.

#### `security-auth-malformed` -- Rejects malformed auth credentials

- **Default required:** No
- **Spec reference:** [basic/authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- **Description:** Sends a request with a garbage Authorization header value and verifies the server rejects it.
- **Pass criteria:** HTTP 401 or 403 for malformed auth token.
- **Fail criteria:** Server accepts malformed auth token.

#### `security-www-authenticate` -- 401 responses include `WWW-Authenticate` header

- **Default required:** No
- **Spec reference:** [basic/authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- **Description:** Triggers a 401 response (by sending no Authorization header) and checks that the response includes a `WWW-Authenticate` header indicating the required auth scheme. RFC 9110 requires 401 responses to carry this header; MCP inherits that requirement via the Streamable HTTP transport.
- **Pass criteria:** 401 responses include a `WWW-Authenticate` header (e.g., `WWW-Authenticate: Bearer realm="mcp"`). **Auto-pass** if the server does not require auth.
- **Fail criteria:** The server returns 401 without a `WWW-Authenticate` header.

#### `security-tls-required` -- Enforces HTTPS/TLS

- **Default required:** No
- **Spec reference:** [basic/authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- **Description:** If the server URL uses HTTPS, attempts a plaintext HTTP connection and verifies it is rejected or redirected.
- **Pass criteria:** HTTP connection rejected, redirected (301/302/308), or returns 4xx.
- **Fail criteria:** Server accepts plaintext HTTP connections alongside HTTPS.

#### `security-session-entropy` -- Session IDs are high-entropy

- **Default required:** No
- **Spec reference:** [basic/transports#streamable-http](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#streamable-http)
- **Description:** Analyzes the MCP-Session-Id for length (≥16 chars), non-sequential patterns, and character diversity (≥8 unique chars).
- **Pass criteria:** Session ID is ≥16 chars, non-numeric, with ≥8 unique characters. Auto-passes if server does not issue session IDs.
- **Fail criteria:** Session ID is too short, purely numeric, or has low character diversity.

#### `security-session-not-auth` -- Session ID does not bypass auth

- **Default required:** No
- **Spec reference:** [basic/transports#streamable-http](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#streamable-http)
- **Description:** Sends a request with a valid MCP-Session-Id but no Authorization header. Per spec, servers MUST NOT use sessions for authentication.
- **Pass criteria:** HTTP 401 or 403 when session ID is sent without auth.
- **Fail criteria:** Server accepts request with session ID but no auth token.

#### `security-oauth-metadata` -- OAuth metadata endpoint exists

- **Default required:** No
- **Spec reference:** [basic/authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- **Description:** Fetches `/.well-known/oauth-authorization-server` and validates it returns JSON with `issuer` and `token_endpoint` fields.
- **Pass criteria:** Endpoint returns valid OAuth metadata JSON. Auto-passes if server does not require auth.
- **Fail criteria:** Endpoint missing, returns non-JSON, or lacks required fields.

#### `security-token-in-uri` -- Rejects auth tokens in query string

- **Default required:** No
- **Spec reference:** [basic/authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- **Description:** Extracts the token from the Authorization header and places it in the URL query string as `access_token`. Verifies the server rejects it.
- **Pass criteria:** HTTP 401 or 403 when token is in query string.
- **Fail criteria:** Server accepts token from query string (spec: MUST NOT transmit credentials in URIs).

#### `security-cors-headers` -- CORS headers are restrictive

- **Default required:** No
- **Spec reference:** [basic/transports#streamable-http](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#streamable-http)
- **Description:** Sends an OPTIONS request with `Origin: https://evil.example.com` and checks the CORS response headers.
- **Pass criteria:** No CORS headers, or Access-Control-Allow-Origin is a specific origin (not `*` or reflected).
- **Fail criteria:** Access-Control-Allow-Origin is `*` or reflects arbitrary origins.

#### `security-origin-validation` -- Validates `Origin` header on requests

- **Default required:** No
- **Spec reference:** [basic/transports#streamable-http](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#streamable-http)
- **Description:** Sends a request with a suspicious `Origin` header (for example `https://evil-rebinding-attack.example.com`) and verifies the server rejects it. Per spec, servers MUST validate the `Origin` header to prevent DNS rebinding attacks, where a local server is accessed from a malicious web page after a DNS swap.
- **Pass criteria:** Server rejects the request with HTTP 403 (or otherwise refuses to process the body) when the `Origin` is not on its allowlist.
- **Fail criteria:** Server processes the request and returns a 2xx result despite the untrusted origin.

#### `security-command-injection` -- Resists command injection in tool params

- **Default required:** No
- **Capability-gated:** tools
- **Spec reference:** [server/tools#calling-tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#calling-tools)
- **Description:** Sends OS command injection payloads (`;`, `$()`, `` ` ` ``, `|`, `&&`) in tool string parameters. Checks output for evidence of command execution.
- **Pass criteria:** Tool output does not contain command execution indicators (uid, file listings, etc.) once the payload itself is removed from it. Output that only reflects the payload back (an echo tool) is benign.
- **Fail criteria:** Tool output matches command execution patterns.

#### `security-sql-injection` -- Resists SQL injection in tool params

- **Default required:** No
- **Capability-gated:** tools
- **Spec reference:** [server/tools#calling-tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#calling-tools)
- **Description:** Sends SQL injection payloads (`' OR 1=1 --`, `'; DROP TABLE`, `UNION SELECT`) in tool string parameters. Checks output for database errors.
- **Pass criteria:** Tool output does not contain SQL error messages or database metadata once the payload itself is removed from it. Output that only reflects the payload back (an echo tool) is benign.
- **Fail criteria:** Tool output contains SQL syntax errors, table names, or database metadata.

#### `security-path-traversal` -- Resists path traversal in tool params

- **Default required:** No
- **Capability-gated:** tools
- **Spec reference:** [server/tools#calling-tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#calling-tools)
- **Description:** Sends path traversal payloads (`../../etc/passwd`, `..\\..\\windows\\system.ini`) in tool string parameters.
- **Pass criteria:** Tool output does not contain sensitive file contents (e.g., `/etc/passwd`, `[boot loader]`) once the payload itself is removed from it. Output that only reflects the payload back (an echo tool) is benign.
- **Fail criteria:** Tool output matches sensitive file content patterns.

#### `security-ssrf-internal` -- Resists SSRF to internal networks

- **Default required:** No
- **Capability-gated:** tools
- **Spec reference:** [server/tools#calling-tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#calling-tools)
- **Description:** For tools with URL-like parameters, submits internal IP addresses (169.254.169.254, 127.0.0.1) and cloud metadata endpoints.
- **Pass criteria:** Tool output does not contain cloud metadata (ami-id, instance-id, security-credentials) once the payload itself is removed from it. Output that only reflects the payload back (an echo tool) is benign.
- **Fail criteria:** Tool output contains internal network or cloud metadata responses.

#### `security-oversized-input` -- Handles oversized inputs gracefully

- **Default required:** No
- **Spec reference:** [server/tools#calling-tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#calling-tools)
- **Description:** Sends a 1MB+ payload in a tools/call request. Verifies the server rejects it or handles it without crashing.
- **Pass criteria:** HTTP 413, any 4xx error, or server handles the request without timeout.
- **Fail criteria:** Server times out or crashes.

#### `security-extra-params` -- Rejects or ignores extra tool params

- **Default required:** No
- **Capability-gated:** tools
- **Spec reference:** [server/tools#calling-tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#calling-tools)
- **Description:** Calls a tool with unexpected additional parameters (`__injected_param__`, `__proto__`). Verifies the server handles them safely.
- **Pass criteria:** Server rejects with error or silently ignores extra parameters.
- **Fail criteria:** Server crashes or exhibits unexpected behavior from prototype pollution.

#### `security-tool-schema-defined` -- All tools define inputSchema

- **Default required:** No
- **Capability-gated:** tools
- **Spec reference:** [server/tools#data-types](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#data-types)
- **Description:** Verifies all tools have an `inputSchema` with `type: "object"`. Tools without schemas cannot have their inputs validated.
- **Pass criteria:** All tools have `inputSchema` with `type: "object"`.
- **Fail criteria:** Any tool is missing `inputSchema` or has the wrong type.

#### `security-tool-rug-pull` -- Tool definitions are stable across calls

- **Default required:** No
- **Capability-gated:** tools
- **Spec reference:** [server/tools#listing-tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#listing-tools)
- **Description:** Calls `tools/list` twice and compares results. Tool definitions should not change silently within a session.
- **Pass criteria:** Tool count, names, and descriptions are identical across both calls.
- **Fail criteria:** Any difference in tool count, names, or descriptions (possible rug-pull attack).

#### `security-tool-description-poisoning` -- Tool descriptions free of injection patterns

- **Default required:** No
- **Capability-gated:** tools
- **Spec reference:** [server/tools#data-types](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#data-types)
- **Description:** Scans tool names, descriptions, and parameter descriptions for prompt injection patterns: "ignore previous", "override", "system prompt", hidden Unicode (U+200B, U+200C, U+200D, U+FEFF), and Base64-encoded payloads.
- **Pass criteria:** No suspicious patterns found.
- **Fail criteria:** Any tool contains injection patterns, hidden characters, or Base64 payloads.

#### `security-tool-cross-reference` -- Tools do not reference other tools by name

- **Default required:** No
- **Capability-gated:** tools
- **Spec reference:** [server/tools#data-types](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#data-types)
- **Description:** Checks that no tool's description contains the name of another tool. Cross-references can manipulate LLM tool selection.
- **Pass criteria:** No tool description contains another tool's name.
- **Fail criteria:** A tool description references another tool by name.

#### `security-error-no-stacktrace` -- Error responses do not leak stack traces

- **Default required:** No
- **Spec reference:** [basic](https://modelcontextprotocol.io/specification/2025-11-25/basic)
- **Description:** Triggers error conditions (invalid JSON, unknown methods, unknown tools) and inspects responses for stack traces, file paths, database connection strings, and other implementation details.
- **Pass criteria:** No stack traces, file paths, connection strings, or credential references in error responses.
- **Fail criteria:** Error response matches known stack trace patterns (Node.js `at ... ()`, Python `Traceback`, Go `.go:`, etc.).

#### `security-error-no-internal-ip` -- Error responses do not leak internal IPs

- **Default required:** No
- **Spec reference:** [basic](https://modelcontextprotocol.io/specification/2025-11-25/basic)
- **Description:** Triggers errors and inspects response bodies for private IP addresses (10.x, 172.16-31.x, 192.168.x, 127.x).
- **Pass criteria:** No private IP addresses found in error responses.
- **Fail criteria:** Error response contains a private IP address.

#### `security-rate-limiting` -- Rate limiting is enforced

- **Default required:** No
- **Spec reference:** [basic/transports#streamable-http](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#streamable-http)
- **Description:** Sends 50 rapid concurrent requests and checks for HTTP 429 responses. Production servers should implement rate limiting.
- **Pass criteria:** At least one HTTP 429 response during the burst.
- **Fail criteria:** All 50 requests accepted without rate limiting, or server crashes (>50% 5xx errors).

---

## 3b. Test Rules -- 2026-07-28

The 2026-07-28 catalog (`MODERN_TEST_DEFINITIONS` in `src/definitions/2026-07-28.ts`) has 103 rules in the same 8 categories. Spec references are relative to `https://modelcontextprotocol.io/specification/2026-07-28/`. Ids are only comparable within one catalog: an id shared with section 3 covers the same feature, but its wording, pass criteria and required flag may differ between the eras (`stdio-framing` and `error-invalid-jsonrpc` are optional here and required in section 3, `error-method-code` the reverse); a check whose verdict on the same server behaviour flipped carries a new id (for example `lifecycle-discover` replaces `lifecycle-init`, `transport-get-removed` replaces `transport-get`, `resources-not-found` is new because `-32002` is now a failure). `Default required` is the catalog default; rules marked capability-gated become required at runtime when the server declares the capability (see [section 1.2](#12-capability-driven-execution)).

Counts: transport 20 (16 HTTP + 4 stdio), lifecycle 22, tools 6, resources 8, prompts 4, errors 12, schema 10, security 21. Required by default: 24. Runs on HTTP: 99 (28 HTTP-only + 71 both); on stdio: 75 (4 stdio-only + 71 both).

---

### 3b.1 transport -- Transport Validation (20 tests)

Transport tests for 2026-07-28 send a **conformant `server/discover`** (standard headers plus `_meta`) rather than `ping`, so the only defect in each probe is the one under test. There is no session and no initialization handshake: every request is independent, so nothing here is "pre-init" or "post-init". 15 rules are HTTP-only (`transports: ["http"]`), 4 are stdio-only, and `transport-no-server-requests` is a post-hoc scan of the recording that runs on both transports (the design counts it with the HTTP group, hence "16 HTTP + 4 stdio"). The standard-header rejection rules are **attributable**: a 400 is credited only when the conformant `server/discover` was served, so a server that rejects everything (a legacy-only server pinned to this catalog) fails them as "not evaluable" instead of passing, and so does a transport-level status (401, 403, 413, 415 or 429 from an auth gate, size limit, media-type gate or rate limiter answering before the JSON-RPC layer).

---

#### `transport-post` -- HTTP POST accepted

- **Category:** transport
- **Default required:** Yes
- **Transports:** http
- **Spec reference:** [basic/transports/streamable-http#sending-messages](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#sending-messages)
- **Description:** POSTs a conformant server/discover request (standard headers plus _meta) to the MCP endpoint and verifies a 2xx status. The server MUST provide a single endpoint that supports POST and every client message MUST be its own POST; this is the baseline every other HTTP test builds on.
- **Pass criteria:** HTTP 2xx for a POST carrying a conformant server/discover request (standard headers plus _meta).
- **Fail criteria:** Any non-2xx status; 401/403 is annotated as authentication required.

---

#### `transport-content-type` -- Responds with JSON or SSE

- **Category:** transport
- **Default required:** Yes
- **Transports:** http
- **Spec reference:** [basic/transports/streamable-http#sending-messages](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#sending-messages)
- **Description:** Checks the Content-Type of the server/discover response. For a JSON-RPC request the server MUST return either application/json (a single object) or text/event-stream (a request-scoped SSE stream); nothing else is valid.
- **Pass criteria:** The Content-Type of the server/discover response contains application/json or text/event-stream.
- **Fail criteria:** Any other Content-Type, or none.

---

#### `transport-content-type-reject` -- Rejects non-JSON request Content-Type

- **Category:** transport
- **Default required:** No
- **Transports:** http
- **Spec reference:** [basic/transports/streamable-http#sending-messages](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#sending-messages)
- **Description:** Sends an otherwise valid server/discover (correct headers and _meta) with Content-Type: text/plain and expects a 4xx status. The POST body MUST be a single JSON-RPC message; a server that parses text/plain as JSON is trusting a content type it never checked.
- **Pass criteria:** HTTP 4xx (415 or 400 expected) for an otherwise valid server/discover sent with Content-Type: text/plain.
- **Fail criteria:** The text/plain body is parsed and answered with a 2xx status.

---

#### `transport-batch-reject` -- Rejects JSON-RPC batch requests

- **Category:** transport
- **Default required:** Yes
- **Transports:** http
- **Spec reference:** [basic/transports/streamable-http#sending-messages](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#sending-messages)
- **Description:** POSTs a JSON array containing two valid server/discover requests and expects a 4xx status or a JSON-RPC error. The POST body MUST be a single JSON-RPC request or notification; batches were dropped in 2025-06-18 and remain unsupported.
- **Pass criteria:** A JSON array of two valid server/discover requests draws HTTP 4xx or a JSON-RPC error body.
- **Fail criteria:** A 2xx status without a JSON-RPC error, or an array response.

---

#### `transport-notification-202` -- Notification returns 202 Accepted

- **Category:** transport
- **Default required:** No
- **Transports:** http
- **Spec reference:** [basic/transports/streamable-http#sending-messages](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#sending-messages)
- **Description:** POSTs a notifications/cancelled notification (no id) for an unknown request and expects HTTP 202 Accepted with an empty body. If the server accepts a notification it MUST return exactly 202; if it cannot accept it, it MUST return an HTTP error status. 202 passes, a 4xx refusal passes with a warning (this revision defines no client notifications over HTTP), and 200, 204 or 5xx fail.
- **Pass criteria:** HTTP 202 for a POSTed notifications/cancelled; a 4xx refusal also passes but is reported as a warning.
- **Fail criteria:** HTTP 200, 204, or any 5xx.

---

#### `transport-concurrent` -- Handles concurrent requests

- **Category:** transport
- **Default required:** No
- **Transports:** http
- **Spec reference:** [basic/transports/streamable-http#sending-messages](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#sending-messages)
- **Description:** Fires three server/discover requests in parallel over separate POSTs and verifies every response arrives with its own matching id. Each message is its own HTTP POST with no shared session, so a stateless server must serve overlapping requests without cross-talk.
- **Pass criteria:** Three parallel server/discover POSTs each return a 2xx response whose id matches the request that produced it.
- **Fail criteria:** Any response missing, non-2xx, or carrying the id of a different request.

---

#### `transport-get-removed` -- GET returns 405

- **Category:** transport
- **Default required:** No
- **Transports:** http
- **Spec reference:** [basic/transports/streamable-http#earlier-streamable-http-revisions](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#earlier-streamable-http-revisions)
- **Description:** Sends HTTP GET to the MCP endpoint. The standalone GET SSE stream was removed in 2026-07-28 (subscriptions/listen replaces it) and a server on this revision SHOULD answer legacy GET traffic with 405 Method Not Allowed. 405 passes, another 4xx passes with a warning, and a text/event-stream response fails.
- **Pass criteria:** HTTP 405 for GET on the MCP endpoint; another 4xx passes with a warning.
- **Fail criteria:** A text/event-stream response, any 2xx, or any 5xx.

---

#### `transport-delete-removed` -- DELETE returns 405

- **Category:** transport
- **Default required:** No
- **Transports:** http
- **Spec reference:** [basic/transports/streamable-http#earlier-streamable-http-revisions](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#earlier-streamable-http-revisions)
- **Description:** Sends HTTP DELETE to the MCP endpoint. Sessions and their DELETE termination were removed in 2026-07-28, so a server on this revision SHOULD answer with 405 Method Not Allowed. 405 passes, another 4xx passes with a warning, and 2xx or 5xx fail.
- **Pass criteria:** HTTP 405 for DELETE on the MCP endpoint; another 4xx passes with a warning.
- **Fail criteria:** Any 2xx or 5xx status.

---

#### `transport-session-ignored` -- Ignores Mcp-Session-Id

- **Category:** transport
- **Default required:** No
- **Transports:** http
- **Spec reference:** [basic/transports/streamable-http#earlier-streamable-http-revisions](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#earlier-streamable-http-revisions)
- **Description:** Sends a valid server/discover carrying a fabricated Mcp-Session-Id header and expects a normal result with no Mcp-Session-Id on the response. Protocol-level sessions are gone: a server SHOULD ignore the header and never mint or echo session ids. A 404 or 400 keyed to the bogus session, or a minted id, fails.
- **Pass criteria:** A valid server/discover carrying a fabricated Mcp-Session-Id header returns a normal result with no Mcp-Session-Id header on the response.
- **Fail criteria:** HTTP 404 or 400 keyed to the unknown session, or a minted or echoed Mcp-Session-Id response header.

---

#### `transport-header-version-required` -- Rejects missing MCP-Protocol-Version header

- **Category:** transport
- **Default required:** Yes
- **Transports:** http
- **Spec reference:** [basic/transports/streamable-http#protocol-version-header](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#protocol-version-header)
- **Description:** Sends a server/discover whose body is complete but whose MCP-Protocol-Version header is omitted. Every POST MUST carry the header, and a server that does not serve pre-2025-06-18 clients MUST reject its absence with HTTP 400 and a -32020 HeaderMismatch error. 400 is the hard requirement; a missing or different error code is reported as a warning. A 400 is credited only when the conformant server/discover was served; a server that rejects everything fails this test as not evaluable, as does a transport-level answer (401, 403, 413, 415 or 429 from an auth gate, size limit, media-type gate or rate limiter).
- **Pass criteria:** HTTP 400 for a complete server/discover body sent without the MCP-Protocol-Version header, credited only when the conformant server/discover was served and the answer is not a transport-level status (a server that rejects everything, or a 401/403/413/415/429 from an auth gate, size limit, media-type gate or rate limiter, fails as not evaluable); a body without error code -32020 is reported as a warning.
- **Fail criteria:** Any status other than 400, or a 400 or transport-level status (401, 403, 413, 415, 429) from a server whose conformant server/discover was itself rejected or unanswered.

---

#### `transport-header-version-mismatch` -- Rejects header/_meta version mismatch

- **Category:** transport
- **Default required:** Yes
- **Transports:** http
- **Spec reference:** [basic/transports/streamable-http#protocol-version-header](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#protocol-version-header)
- **Description:** Sends MCP-Protocol-Version: 2026-07-28 with _meta protocolVersion 1999-01-01. The header value MUST match the _meta field, and on a mismatch the server MUST respond 400 Bad Request with a -32020 HeaderMismatch error; both the status and the code are checked here. The 400 is credited only when the conformant server/discover was served and the answer is not a transport-level status (401, 403, 413, 415 or 429).
- **Pass criteria:** HTTP 400 and a JSON-RPC error with code -32020 when the header says 2026-07-28 and _meta says 1999-01-01, credited only when the conformant server/discover was served and the answer is not a transport-level status (a server that rejects everything, or a 401/403/413/415/429 from an auth gate, size limit, media-type gate or rate limiter, fails as not evaluable).
- **Fail criteria:** A status other than 400, an error code other than -32020, a result, or a 400 from a server whose conformant server/discover was itself rejected.

---

#### `transport-header-method-required` -- Rejects missing Mcp-Method header

- **Category:** transport
- **Default required:** Yes
- **Transports:** http
- **Spec reference:** [basic/transports/streamable-http#server-validation](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#server-validation)
- **Description:** Sends a valid server/discover body without the Mcp-Method header. Mcp-Method is REQUIRED on every request; a missing standard header is a validation failure and the server MUST answer HTTP 400 with a -32020 HeaderMismatch error. 400 is the hard requirement; the -32020 code is checked as a warning because an intermediary may reject with a bare 400. A 400 is credited only when the conformant server/discover was served; a server that rejects everything fails this test as not evaluable, as does a transport-level answer (401, 403, 413, 415 or 429 from an auth gate, size limit, media-type gate or rate limiter).
- **Pass criteria:** HTTP 400 for a valid server/discover body sent without the Mcp-Method header, credited only when the conformant server/discover was served and the answer is not a transport-level status (a server that rejects everything, or a 401/403/413/415/429 from an auth gate, size limit, media-type gate or rate limiter, fails as not evaluable); a missing or different error code is reported as a warning.
- **Fail criteria:** Any status other than 400, or a 400 from a server whose conformant server/discover was itself rejected or unanswered.

---

#### `transport-header-method-mismatch` -- Rejects Mcp-Method/body mismatch

- **Category:** transport
- **Default required:** Yes
- **Transports:** http
- **Spec reference:** [basic/transports/streamable-http#server-validation](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#server-validation)
- **Description:** Sends a server/discover body with Mcp-Method: tools/list. A header that does not match the corresponding body value MUST be rejected with HTTP 400 and a -32020 HeaderMismatch error, because a gateway routing on the header and a server executing on the body would otherwise disagree. 400 is required; -32020 is a warning. A 400 is credited only when the conformant server/discover was served; a server that rejects everything fails this test as not evaluable, as does a transport-level answer (401, 403, 413, 415 or 429 from an auth gate, size limit, media-type gate or rate limiter).
- **Pass criteria:** HTTP 400 when Mcp-Method: tools/list is sent on a server/discover body, credited only when the conformant server/discover was served and the answer is not a transport-level status (a server that rejects everything, or a 401/403/413/415/429 from an auth gate, size limit, media-type gate or rate limiter, fails as not evaluable); a missing -32020 code is reported as a warning.
- **Fail criteria:** Any status other than 400 (the request was routed on one value and executed on another), or a 400 from a server whose conformant server/discover was itself rejected.

---

#### `transport-header-name-mismatch` -- Rejects Mcp-Name/body mismatch

- **Category:** transport
- **Default required:** No
- **Transports:** http
- **Spec reference:** [basic/transports/streamable-http#server-validation](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#server-validation)
- **Description:** Sends a resources/read of the first listed resource (else a prompts/get of the first prompt without required arguments) whose Mcp-Name header names a different resource or prompt than the body. Mcp-Name is REQUIRED on tools/call, resources/read and prompts/get and MUST match params.uri or params.name after Base64 sentinel decoding, so the server MUST answer 400 + -32020; the 400 is credited only when the conformant server/discover was served and the answer is not a transport-level status (401, 403, 413, 415 or 429). The resource and prompt lists are fetched on demand when the feature tests did not run; skipped when the server declares neither capability or nothing listed can be read by name alone; when the list calls failed it skips pointing at the -list tests if they are in the run, and fails with the recorded reasons when they are not.
- **Pass criteria:** HTTP 400 for a resources/read of the first listed resource (else a prompts/get of the first prompt without required arguments) whose Mcp-Name header names a different object than the body, credited only when the conformant server/discover was served and the answer is not a transport-level status (a server that rejects everything, or a 401/403/413/415/429 from an auth gate, size limit, media-type gate or rate limiter, fails as not evaluable); a missing -32020 code is reported as a warning. The lists are fetched on demand; skipped when the server declares neither resources nor prompts or nothing listed is readable by name alone, and skipped pointing at the -list rules when every declared list call failed and those rules are in the run.
- **Fail criteria:** Any status other than 400, a 400 from a server whose conformant server/discover was itself rejected, or every declared list call failed while the -list rules were filtered out of the run (the recorded reasons are named).

---

#### `transport-header-case-insensitive` -- Header names are case-insensitive

- **Category:** transport
- **Default required:** No
- **Transports:** http
- **Spec reference:** [basic/transports/streamable-http#case-sensitivity](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#case-sensitivity)
- **Description:** Sends a valid server/discover with the standard headers spelled in lowercase (mcp-protocol-version, mcp-method) and expects a normal result. Header names are case-insensitive per RFC 9110 and servers MUST compare them that way; only values are case-sensitive. A 400 HeaderMismatch here means the server matches on exact spelling.
- **Pass criteria:** A valid server/discover whose standard headers are spelled in lowercase (mcp-protocol-version, mcp-method) returns a normal result.
- **Fail criteria:** HTTP 400 or any other rejection attributable to header spelling.

---

#### `transport-no-server-requests` -- No server-initiated requests on any stream

- **Category:** transport
- **Default required:** Yes
- **Spec reference:** [basic/transports#messages](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports#messages)
- **Description:** Post-hoc scan of every message the server sent during the run (JSON bodies, SSE frames, stdio lines) for a frame carrying both method and id, i.e. a server-to-client JSON-RPC request. No such direction exists in 2026-07-28: sampling, elicitation and roots MUST travel inside an InputRequiredResult (MRTR), and the server MUST NOT send independent requests on a response stream or to stdout.
- **Pass criteria:** No recorded server message on any response stream or on stdout carries both method and id.
- **Fail criteria:** At least one server-to-client JSON-RPC request was observed during the run. Also fails when no server message was received during the run (an unreachable server): the scan then has nothing to attest.

---

#### `stdio-framing` -- Newline-delimited JSON framing

- **Category:** transport
- **Default required:** No
- **Transports:** stdio
- **Spec reference:** [basic/transports/stdio#receiving-messages](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio#receiving-messages)
- **Description:** Writes five server/discover requests to stdin in rapid succession and expects five responses, each a single line of JSON terminated by a newline. Messages are newline-delimited and MUST NOT contain embedded newlines, and the server MUST NOT write anything to stdout that is not a valid MCP message.
- **Pass criteria:** Five rapid server/discover requests each receive a response on its own newline-terminated line of JSON.
- **Fail criteria:** Any of the five is unanswered, split across lines, or interleaved with non-JSON output on stdout.

---

#### `stdio-unicode` -- UTF-8 unicode roundtrip

- **Category:** transport
- **Default required:** No
- **Transports:** stdio
- **Spec reference:** [basic/transports#messages](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports#messages)
- **Description:** Calls a tool with CJK and emoji characters in its string arguments -- a tool named echo, else the first tool with a string property named message, text, input or query, else the first tool (tools/list is fetched on demand) -- and passes when the reply reproduces them byte-for-byte, or reproduces every non-ASCII piece of the probe somewhere in the reply (a tool that tokenizes its input). Fails on evidence of mangling: U+FFFD replacement characters, a Latin-1 mis-decode, the non-ASCII characters replaced by '?', the non-ASCII characters stripped (the probe's Latin-1 word or its ASCII skeleton present with neither the CJK word nor the emoji anywhere in the reply), or a -32700 parse error. A tool that merely does not echo its input proves nothing, so the verdict then rests on a server/discover whose clientInfo name carries the same characters: the server parsing and answering it is the round-trip verified, and rejecting or mangling it fails. JSON-RPC messages MUST be UTF-8 encoded on every transport; this catches latin-1 or platform-default decoding of stdin.
- **Pass criteria:** The chosen tool (one named echo, else the first with a string property named message/text/input/query, else the first tool; tools/list fetched on demand) reproduces the CJK/emoji probe byte-for-byte, or reproduces every non-ASCII piece of it somewhere in the reply (a tokenizing tool); or, when the tool merely does not echo its input, a server/discover whose clientInfo name carries the probe is answered with a result.
- **Fail criteria:** The tool reply or the discover reply shows mangling (U+FFFD, a Latin-1 mis-decode, the non-ASCII characters replaced by '?', or the probe's first word present with neither the CJK word nor the emoji anywhere in the reply), the tool call draws -32700, or the discover carrying the probe in clientInfo is rejected or answered with a non-JSON-RPC reply.

---

#### `stdio-unknown-method-recovers` -- Recovers after unknown method

- **Category:** transport
- **Default required:** No
- **Transports:** stdio
- **Spec reference:** [basic/transports/stdio#receiving-messages](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio#receiving-messages)
- **Description:** Sends a bogus method with a full modern _meta, then a valid server/discover immediately after. The unknown method should draw a JSON-RPC error (-32601 expected) and the server must keep serving: the discover that follows must succeed on the same process.
- **Pass criteria:** The bogus method draws a JSON-RPC error (-32601 expected) and the server/discover sent immediately after succeeds on the same process.
- **Fail criteria:** The process exits, stops answering, or the follow-up server/discover fails.

---

#### `stdio-cancellation` -- Ignores cancellation of unknown request

- **Category:** transport
- **Default required:** No
- **Transports:** stdio
- **Spec reference:** [basic/transports/stdio#cancellation](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio#cancellation)
- **Description:** Writes a notifications/cancelled referencing a request id that was never issued, then a server/discover. On stdio notifications/cancelled is the only cancellation signal and servers MAY ignore one for an unknown or completed request; the discover that follows must still be answered and nothing may be emitted in reply to the notification.
- **Pass criteria:** A notifications/cancelled for an unknown requestId produces no reply and the server/discover sent after it is answered normally.
- **Fail criteria:** Any message emitted in reply to the notification, the follow-up server/discover is unanswered, or the process exits.

---

### 3b.2 lifecycle -- Protocol Lifecycle (22 tests)

Lifecycle in 2026-07-28 is `server/discover` plus the per-request `_meta` envelope. The suite validates the discover result (versions, capabilities, caching hints, serverInfo), then sends deliberately incomplete envelopes (no `_meta`, no `protocolVersion`, no `clientCapabilities`, no `clientInfo`, an unsupported version) and checks the server rejects exactly the ones the spec says it must; like the header rules, a rejection is credited only when the conformant discover was served and is not a transport-level status. The late block -- `lifecycle-completions`, `lifecycle-progress-token`, the two claim-less probes (`lifecycle-meta-required`, `lifecycle-meta-protocol-version-required`) and `lifecycle-dual-era` -- runs after the feature and stdio tests and before the security tests: a dual-era stdio server that has not yet been pinned modern treats a claim-less message as a legacy opening (a `--only` run on stdio sends a pinning request first), and the security rate-limit burst would otherwise leave an intermediary answering these probes with 429. Three rules are post-hoc scans of the recording (`lifecycle-log-level-gating`) or informational probes (`lifecycle-dual-era`, which on stdio goes to a fresh process and tells a single-instance server apart from one that exits on `initialize`; `lifecycle-removed-methods`).

---

#### `lifecycle-discover` -- server/discover returns DiscoverResult

- **Category:** lifecycle
- **Default required:** Yes
- **Spec reference:** [server/discover#response](https://modelcontextprotocol.io/specification/2026-07-28/server/discover#response)
- **Description:** Sends server/discover with a conformant _meta and expects a result carrying a supportedVersions array and a capabilities object. Servers MUST implement server/discover; it replaces the initialize handshake and is the first response the suite trusts.
- **Pass criteria:** server/discover with a conformant _meta returns a result carrying a supportedVersions array and a capabilities object.
- **Fail criteria:** A JSON-RPC error, no response, or a result missing either field.

---

#### `lifecycle-discover-versions` -- supportedVersions are well-formed

- **Category:** lifecycle
- **Default required:** Yes
- **Spec reference:** [server/discover#discoverresult](https://modelcontextprotocol.io/specification/2026-07-28/server/discover#discoverresult)
- **Description:** Validates supportedVersions on the discover result: non-empty, every entry a YYYY-MM-DD string. Warns when 2026-07-28 itself is absent, since the run grades that revision and the server just answered a request declaring it.
- **Pass criteria:** supportedVersions is non-empty and every entry is a YYYY-MM-DD string; the absence of 2026-07-28 is reported as a warning.
- **Fail criteria:** An empty array, or any entry that is not a date-shaped string.

---

#### `lifecycle-discover-caching` -- server/discover carries caching hints

- **Category:** lifecycle
- **Default required:** Yes
- **Spec reference:** [server/utilities/caching#cacheable-results](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching#cacheable-results)
- **Description:** Checks that the discover result carries ttlMs (an integer >= 0) and cacheScope ('public' or 'private'). Servers MUST include both caching hints on every complete server/discover result; a negative or missing ttlMs or an unknown scope fails.
- **Pass criteria:** The server/discover result carries ttlMs as an integer >= 0 and cacheScope equal to public or private.
- **Fail criteria:** Either field missing, ttlMs negative or non-integer, or an unknown cacheScope value.

---

#### `lifecycle-jsonrpc` -- Response is valid JSON-RPC 2.0

- **Category:** lifecycle
- **Default required:** Yes
- **Spec reference:** [basic/index#result-responses](https://modelcontextprotocol.io/specification/2026-07-28/basic/index#result-responses)
- **Description:** Validates the discover response envelope: jsonrpc is exactly '2.0', the id is echoed, and exactly one of result (an object) or error is present. All MCP messages MUST follow JSON-RPC 2.0 and a result response MUST include a result field.
- **Pass criteria:** The server/discover response has jsonrpc exactly '2.0', the request id echoed, and exactly one of result (an object) or error.
- **Fail criteria:** A missing or wrong jsonrpc field, a missing id, both or neither of result/error, or a non-object result.

---

#### `lifecycle-id-match` -- Response id matches request id

- **Category:** lifecycle
- **Default required:** Yes
- **Spec reference:** [basic/index#result-responses](https://modelcontextprotocol.io/specification/2026-07-28/basic/index#result-responses)
- **Description:** Verifies the id on the discover response equals the id the suite sent. Result and error responses MUST include the same id as the request they answer; the suite issues numeric ids from 1000 upward so a stale or fabricated id is easy to spot.
- **Pass criteria:** The id on the server/discover response equals the id the suite sent.
- **Fail criteria:** A different, missing, or null id.

---

#### `lifecycle-string-id` -- Supports string request ids

- **Category:** lifecycle
- **Default required:** No
- **Spec reference:** [basic/index#requests](https://modelcontextprotocol.io/specification/2026-07-28/basic/index#requests)
- **Description:** Sends server/discover with a string id and expects the response to echo it byte-for-byte as a string, on HTTP and stdio alike. Requests MUST carry a string or integer id and the server MUST return the same one; coercing '42' to 42 or dropping the id fails.
- **Pass criteria:** A server/discover sent with a string id is answered with the identical string id.
- **Fail criteria:** The id is coerced to a number, replaced, or dropped.

---

#### `lifecycle-capabilities` -- Returns capabilities object

- **Category:** lifecycle
- **Default required:** Yes
- **Spec reference:** [server/discover#discoverresult](https://modelcontextprotocol.io/specification/2026-07-28/server/discover#discoverresult)
- **Description:** Checks that the discover result has a capabilities object and that each declared feature (tools, resources, prompts, completions, logging, experimental, extensions) is itself an object. An empty {} is valid; a capability declared as true or a string is not, because sub-features such as listChanged live inside it.
- **Pass criteria:** The server/discover result has a capabilities object and every declared feature is itself an object (an empty {} is valid).
- **Fail criteria:** capabilities missing or not an object, or a feature declared as a boolean, string, or other non-object.

---

#### `lifecycle-server-info` -- Includes serverInfo in _meta

- **Category:** lifecycle
- **Default required:** No
- **Spec reference:** [server/discover#discoverresult](https://modelcontextprotocol.io/specification/2026-07-28/server/discover#discoverresult)
- **Description:** Looks for result._meta['io.modelcontextprotocol/serverInfo'] on the discover result and checks it carries string name and version fields. Servers SHOULD include serverInfo on every result so a client can identify them without connection state; the report's serverInfo comes from here.
- **Pass criteria:** result._meta['io.modelcontextprotocol/serverInfo'] on the server/discover result carries string name and version fields.
- **Fail criteria:** serverInfo absent from _meta, or name or version missing or not strings.

---

#### `lifecycle-instructions` -- Instructions field is valid

- **Category:** lifecycle
- **Default required:** No
- **Spec reference:** [server/discover#discoverresult](https://modelcontextprotocol.io/specification/2026-07-28/server/discover#discoverresult)
- **Description:** If the discover result includes instructions, verifies it is a string. Instructions are optional natural-language guidance for the model on how to use the server; absence passes and any other type fails.
- **Pass criteria:** instructions is absent from the server/discover result, or present as a string.
- **Fail criteria:** instructions is present with a non-string type.

---

#### `lifecycle-meta-required` -- Rejects request without _meta

- **Category:** lifecycle
- **Default required:** Yes
- **Spec reference:** [basic/index#meta](https://modelcontextprotocol.io/specification/2026-07-28/basic/index#meta)
- **Description:** Sends server/discover with params carrying no _meta at all (on HTTP the headers are still correct). protocolVersion and clientCapabilities are required on every request, so the request is malformed and the server MUST reject it with -32602 Invalid params; on HTTP the status MUST be 400. A rejection with a different code is reported as a warning; a result fails, because the server is inferring version and capabilities from nowhere. Runs late, after the feature tests and before the security tests: a dual-era stdio server that is still deciding its era treats a claim-less message as a legacy opening, and by then a modern request has pinned the process (a --only run that skipped the feature tests sends one first on stdio -- the first declared list, else ping); the security rate-limit burst comes afterwards so an intermediary it trips cannot answer this probe. Not evaluable -- and failed -- when the conformant server/discover was itself rejected, since the rejection then proves nothing about the missing _meta, and likewise when the answer is a transport-level status (401, 403, 413, 415 or 429: an auth gate, size limit, media-type gate or rate limiter answering before the JSON-RPC layer read the request).
- **Pass criteria:** A server/discover with no params._meta draws a JSON-RPC error (HTTP 400 on HTTP), credited only when the conformant server/discover was served and the answer is not a transport-level status (a server that rejects everything, or a 401/403/413/415/429 from an auth gate, size limit, media-type gate or rate limiter, fails as not evaluable); code -32602 is expected and any other code is reported as a warning. Runs after the feature tests and before the security tests, so a dual-era stdio server is already pinned modern (a --only run on stdio sends the first declared list, else ping, first) and the rate-limit burst cannot have tripped an intermediary.
- **Fail criteria:** A result is returned, on HTTP the error arrives with a status other than 400, the conformant server/discover was itself rejected or unanswered, or the answer is a transport-level status (401, 403, 413, 415, 429) -- the last two not evaluable.

---

#### `lifecycle-meta-protocol-version-required` -- Rejects _meta without protocolVersion

- **Category:** lifecycle
- **Default required:** Yes
- **Spec reference:** [basic/index#meta](https://modelcontextprotocol.io/specification/2026-07-28/basic/index#meta)
- **Description:** Sends server/discover whose _meta carries clientCapabilities and clientInfo but no protocolVersion (on HTTP the MCP-Protocol-Version header is present and correct). The field is required, so the server MUST answer -32602 Invalid params and, on HTTP, status 400. A rejection with another code (-32020 is the common one) passes with a warning; a result fails. Runs late, after the feature tests and before the security tests, for the same reasons as lifecycle-meta-required. Not evaluable -- and failed -- when the conformant server/discover was itself rejected, or when the answer is a transport-level status (401, 403, 413, 415 or 429).
- **Pass criteria:** A _meta without protocolVersion draws a JSON-RPC error (HTTP 400 on HTTP), credited only when the conformant server/discover was served and the answer is not a transport-level status (a server that rejects everything, or a 401/403/413/415/429 from an auth gate, size limit, media-type gate or rate limiter, fails as not evaluable); -32602 is expected and another code (typically -32020) is reported as a warning. Runs after the feature tests and before the security tests.
- **Fail criteria:** A result is returned, on HTTP the error arrives with a status other than 400, the conformant server/discover was itself rejected or unanswered, or the answer is a transport-level status (401, 403, 413, 415, 429) -- the last two not evaluable.

---

#### `lifecycle-meta-client-capabilities-required` -- Rejects _meta without clientCapabilities

- **Category:** lifecycle
- **Default required:** Yes
- **Spec reference:** [basic/index#meta](https://modelcontextprotocol.io/specification/2026-07-28/basic/index#meta)
- **Description:** Sends server/discover whose _meta has protocolVersion and clientInfo but no clientCapabilities. Capabilities are per-request input the server MUST NOT infer from prior requests, so the field is required even when empty; the server MUST answer -32602 (HTTP 400). Serving the request as if {} had been sent fails. Not evaluable -- and failed -- when the conformant server/discover was itself rejected, since the rejection then proves nothing about the missing field. A transport-level status (401, 403, 413, 415 or 429) is not evaluable either.
- **Pass criteria:** A _meta without clientCapabilities draws a JSON-RPC error (HTTP 400 on HTTP), credited only when the conformant server/discover was served and the answer is not a transport-level status (a server that rejects everything, or a 401/403/413/415/429 from an auth gate, size limit, media-type gate or rate limiter, fails as not evaluable); -32602 is expected and another code is reported as a warning.
- **Fail criteria:** The request is served as if {} had been sent, on HTTP the error arrives with a status other than 400, the conformant server/discover was itself rejected or unanswered, or the answer is a transport-level status (401, 403, 413, 415, 429) -- the last two not evaluable.

---

#### `lifecycle-meta-client-info-optional` -- Serves _meta without clientInfo

- **Category:** lifecycle
- **Default required:** Yes
- **Spec reference:** [basic/index#meta](https://modelcontextprotocol.io/specification/2026-07-28/basic/index#meta)
- **Description:** Sends server/discover whose _meta has the two required fields but omits clientInfo, and expects a normal result. clientInfo is a SHOULD for clients, not a requirement; a server that rejects its absence blocks conformant clients that are configured not to identify themselves.
- **Pass criteria:** A server/discover whose _meta omits clientInfo returns a normal result.
- **Fail criteria:** A JSON-RPC error or non-2xx status caused by the missing clientInfo.

---

#### `lifecycle-version-unsupported` -- Rejects unsupported protocol version

- **Category:** lifecycle
- **Default required:** Yes
- **Spec reference:** [basic/versioning#protocol-version-negotiation](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning#protocol-version-negotiation)
- **Description:** Sends server/discover declaring protocol version 1999-01-01 in _meta (and in the header on HTTP). A version the server does not implement MUST be answered with UnsupportedProtocolVersionError (-32022) whose data.supported lists the server's versions and data.requested echoes '1999-01-01'; on HTTP the status MUST be 400. data.supported must be non-empty and a subset of the discover result's supportedVersions.
- **Pass criteria:** Protocol version 1999-01-01 draws code -32022 with data.supported non-empty and a subset of the discover supportedVersions, data.requested equal to '1999-01-01', and HTTP 400 on HTTP.
- **Fail criteria:** A result, a different error code, an empty or malformed data.supported, a wrong data.requested, or on HTTP a status other than 400.

---

#### `lifecycle-removed-methods` -- Removed legacy methods are rejected

- **Category:** lifecycle
- **Default required:** No
- **Spec reference:** [changelog#major-changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog#major-changes)
- **Description:** Sends ping, logging/setLevel and resources/subscribe with a full modern _meta. All three were removed in 2026-07-28 (there is no keepalive RPC, log level is per-request _meta, subscriptions/listen replaces resources/subscribe), so each should draw a JSON-RPC error. -32601 Method not found (with HTTP 404 on HTTP) is expected; another error code passes with a warning and a result fails. A rejection is credited only when the conformant server/discover was served; a server that rejects everything fails this test as not evaluable.
- **Pass criteria:** ping, logging/setLevel and resources/subscribe each draw a JSON-RPC error (or a bare HTTP 4xx), credited only when the conformant server/discover was served; -32601 (HTTP 404 on HTTP) is expected and another code or status is reported as a warning.
- **Fail criteria:** Any of the three methods returns a result, gets no response, or draws neither a result nor an error; or all three are rejected by a server whose conformant server/discover was itself rejected or unanswered (not evaluable).

---

#### `lifecycle-dual-era` -- Legacy initialize probe (informational)

- **Category:** lifecycle
- **Default required:** No
- **Spec reference:** [basic/versioning#backward-compatibility-with-initialization-based-versions](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning#backward-compatibility-with-initialization-based-versions)
- **Description:** Sends a legacy initialize request (2025-11-25 shape, no modern _meta, legacy headers on HTTP) and reports which era the server speaks: a result alongside a served server/discover means dual-era; a result while server/discover was rejected or unanswered means legacy-only (the run graded the era the server does not speak, and a warning says so); an error means modern-only. All of those pass; the test is informational. No response (a timeout, named with its budget, or a connection error, named as such) and a transport-level status (401, 403, 413, 415 or 429) pass with a warning as era undetermined. On stdio the probe goes to a fresh process, because a dual-era server selects its era from how the client opens and the suite's own process is already modern; it waits the per-request timeout (stretched to three times the setup server/discover latency for a slow starter, never beyond --startup-timeout). If that fresh process exits unanswered, a second instance is started with no input at all: one that exits too shows a server that allows one instance at a time (a lock file, a fixed port) and cannot be probed alongside the suite's own process -- era undetermined, with the exit code and stderr in a warning; one that stays up shows the request is what the server exits on, the only failure of this test. A modern-only server SHOULD name its supported versions in the error -- in data.supported (the UnsupportedProtocolVersionError shape) or in the message -- and one that names none (a message that only echoes the rejected 2025-11-25 does not count) draws a warning. Runs after the feature tests and before the security tests.
- **Pass criteria:** On every classified outcome: a result to the legacy initialize (sent to a fresh process on stdio) is reported as dual-era when server/discover was served and as legacy-only (with a warning) when it was not, an error as modern-only; an error that names no supported version -- neither in data.supported nor as a date other than the requested 2025-11-25 in the message -- is reported as a warning. No response (a timeout within the probe budget, or a connection error), a transport-level status (401, 403, 413, 415, 429), and a stdio fresh process that exits alongside a second instance that exits at startup too (a single-instance server) pass with a warning as era undetermined.
- **Fail criteria:** Only when a stdio server exits after the legacy initialize request while a second instance spawned with no input stays up (the request is what it exits on).

---

#### `lifecycle-capability-handlers-match` -- Capability declarations match handlers

- **Category:** lifecycle
- **Default required:** No
- **Spec reference:** [server/discover#discoverresult](https://modelcontextprotocol.io/specification/2026-07-28/server/discover#discoverresult)
- **Description:** For each of tools, resources and prompts: when the capability is declared, the corresponding list method must return a result (servers that declare a capability MUST respond to its list request); when it is not declared, the list method must return a JSON-RPC error, -32601 expected. A declared capability whose list fails, or an undeclared one whose list succeeds, fails.
- **Pass criteria:** For each of tools, resources and prompts: a declared capability's list method returns a result and an undeclared capability's list method returns a JSON-RPC error (-32601 expected).
- **Fail criteria:** A declared capability whose list method errors, or an undeclared capability whose list method returns a result.

---

#### `lifecycle-subscriptions-listen` -- subscriptions/listen acknowledges first

- **Category:** lifecycle
- **Default required:** No
- **Spec reference:** [basic/patterns/subscriptions#acknowledgment](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions#acknowledgment)
- **Description:** When any listChanged or subscribe capability is declared, opens a subscriptions/listen stream requesting the matching notification types and reads the first frame. It MUST be notifications/subscriptions/acknowledged carrying _meta['io.modelcontextprotocol/subscriptionId'] equal to the listen request's id and a notifications object naming the subset the server honours; no other notification may precede it. When nothing is advertised, either the acknowledgment or -32601 passes -- the rejection credited only when the conformant server/discover was served; a server that rejects everything fails this test as not evaluable. An acknowledgment that honours a notification type or URI the request did not include passes with a warning: the server may send notifications outside the requested filter.
- **Pass criteria:** With a listChanged or subscribe capability declared, the first frame on a subscriptions/listen stream is notifications/subscriptions/acknowledged carrying _meta subscriptionId equal to the request id and a notifications object; an acknowledgment that honours a type or URI the request did not include passes with a warning. With nothing advertised, either that acknowledgment or -32601 passes, the rejection credited only when the conformant server/discover was served.
- **Fail criteria:** Any other frame first, a subscriptionId that differs from the request id, a missing notifications object, an error other than -32601 when nothing is advertised, a rejection from a server whose conformant server/discover was itself rejected (not evaluable), no acknowledgment within the listen timeout, or a stdio server that exits before acknowledging.

---

#### `lifecycle-log-level-gating` -- No log notifications without logLevel

- **Category:** lifecycle
- **Default required:** Yes
- **Spec reference:** [server/utilities/logging#per-request-log-level](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/logging#per-request-log-level)
- **Description:** Post-hoc scan of the recording: every notifications/message the server sent is traced to the request it arrived with, and that request must have carried _meta['io.modelcontextprotocol/logLevel']. The server MUST NOT emit notifications/message for a request that did not set a log level; a log frame on a request that never opted in, or on a subscriptions/listen stream, fails.
- **Pass criteria:** Every recorded notifications/message arrived on the response to a request that carried _meta['io.modelcontextprotocol/logLevel'].
- **Fail criteria:** A notifications/message on a request that set no logLevel, or on a subscriptions/listen stream. Also fails when no server message was received during the run (an unreachable server): the scan then has nothing to attest.

---

#### `lifecycle-meta-tolerance` -- Tolerates unknown _meta keys

- **Category:** lifecycle
- **Default required:** No
- **Spec reference:** [basic/index#meta](https://modelcontextprotocol.io/specification/2026-07-28/basic/index#meta)
- **Description:** Sends server/discover with an extra vendor-prefixed key (com.example.compliance/probe) alongside the required _meta fields and expects a normal result. _meta is an open namespace for third-party and extension metadata, so a server must not reject a request for keys it does not recognise.
- **Pass criteria:** A server/discover carrying an extra vendor-prefixed _meta key returns a normal result.
- **Fail criteria:** A JSON-RPC error or rejection attributable to the unknown key.

---

#### `lifecycle-completions` -- completion/complete accepted

- **Category:** lifecycle
- **Default required:** No (required at runtime when `completions` is declared)
- **Spec reference:** [server/utilities/completion#requesting-completions](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/completion#requesting-completions)
- **Description:** If the server declares the completions capability, sends completion/complete for the first listed prompt argument, else the first resource-template variable (prompts/list and resources/templates/list are fetched on demand; a listed template is still used when prompts/list failed), else a placeholder ref where -32602 is acceptable, and expects a result with a completion.values array (empty is fine). When nothing is listed because a declared prompts/list or resources/templates/list failed (-32601 from resources/templates/list counts as no templates), the placeholder is not sent: the test skip-passes pointing at prompts-list / resources-templates when that test is in the run, and fails with the recorded reason when the run filtered it out. Servers that declare the capability must serve the method; skipped when the capability is absent.
- **Pass criteria:** When the completions capability is declared, completion/complete for the first listed prompt argument (else the first resource-template variable, still used when prompts/list failed; prompts/list and resources/templates/list are fetched on demand) returns a result with a completion.values array (empty allowed); with nothing listed a placeholder ref is probed, where -32602 also passes. Skipped when the capability is absent, and skipped pointing at prompts-list / resources-templates when a declared list the probe draws from failed and that rule is in the run.
- **Fail criteria:** A JSON-RPC error (other than -32602 for the placeholder probe), a result without completion.values as an array, or a declared prompts/list or resources/templates/list failed (not a -32601 from resources/templates/list) with no argument listed while its owning rule was filtered out of the run (the recorded reason is named).

---

#### `lifecycle-progress-token` -- Progress notifications echo the token

- **Category:** lifecycle
- **Default required:** No
- **Spec reference:** [basic/patterns/progress#progress-flow](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/progress#progress-flow)
- **Description:** Calls the first tool without required arguments (preferring one whose name or description mentions progress, else the first listed tool) with _meta.progressToken set and reads the whole response; tools/list is fetched on demand when the tools tests did not run, and the test is skipped when the server declares no tools; when tools/list failed it skips pointing at tools-list if that test is in the run, and fails with the recorded reason when it is not. Progress is optional, so a call with no notifications/progress passes; but any progress notification that does arrive MUST carry the same token and its progress value MUST increase with each notification. A foreign token or a non-increasing value fails.
- **Pass criteria:** tools/call of the first tool without required arguments (tools/list fetched on demand) with _meta.progressToken completes, and every notifications/progress observed for it carries the same token with a strictly increasing progress value (no notifications at all also passes). Skipped when the server declares no tools, and skipped pointing at tools-list when tools/list failed and that rule is in the run.
- **Fail criteria:** A progress notification carrying a foreign token, a non-numeric or non-increasing progress value, no response to the call, or tools/list failed while tools-list was filtered out of the run (the recorded reason is named).

---

### 3b.3 tools -- Tool Operations (6 tests)

Only present in the report when the discover result declares the `tools` capability; every rule is then required at runtime except `tools-list-deterministic-order` and `tools-pagination`. `tools/call` may now answer with an MRTR `input_required` result instead of content. The feature tests do not check `resultType: 'complete'` themselves; the post-hoc `schema-result-type` scan does, over every result.

---

#### `tools-list` -- tools/list returns valid response

- **Category:** tools
- **Default required:** No (required at runtime when `tools` is declared)
- **Spec reference:** [server/tools#listing-tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#listing-tools)
- **Description:** Calls tools/list and validates the result has a tools array of tool objects. Servers that declare the tools capability MUST respond to tools/list with the set of tools available to the caller; required at runtime when the capability is declared.
- **Pass criteria:** tools/list returns a result with a tools array whose entries are objects (empty allowed).
- **Fail criteria:** A JSON-RPC error, or a result without a tools array of objects.

---

#### `tools-list-caching` -- tools/list carries caching hints

- **Category:** tools
- **Default required:** No (required at runtime when `tools` is declared)
- **Spec reference:** [server/utilities/caching#cacheable-results](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching#cacheable-results)
- **Description:** Checks that the tools/list result carries ttlMs (an integer >= 0) and cacheScope ('public' or 'private'). Servers MUST include both hints on complete tools/list results; they let clients skip re-fetching and improve prompt-cache hit rates. Required at runtime when the tools capability is declared. Reuses the response the -list test obtained; a list call that got no response (a timeout, a connection error) is not repeated.
- **Pass criteria:** The tools/list result carries ttlMs as an integer >= 0 and cacheScope equal to public or private.
- **Fail criteria:** Either hint missing or invalid, or the tools/list call got no response (reported once; not re-sent).

---

#### `tools-list-deterministic-order` -- tools/list order is deterministic

- **Category:** tools
- **Default required:** No (required at runtime when `tools` is declared)
- **Spec reference:** [server/tools#capabilities](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#capabilities)
- **Description:** Calls tools/list three times and compares the order of tool names. Servers SHOULD return tools in a deterministic order when the underlying set has not changed; a shuffled order defeats client caching and LLM prompt caching. tools/list is fetched on demand when tools-list did not run; when that call failed, skipped pointing at tools-list if that test is in the run, and failed with the recorded reason (--only tools-list-deterministic-order, or --skip tools-list) when it is not. A server that lists no tools passes trivially (an empty order is deterministic).
- **Pass criteria:** Three consecutive tools/list calls return the tool names in the same order. When tools/list failed the rule skips (as passed) pointing at tools-list if that rule is in the run.
- **Fail criteria:** The order differs between any two of the three calls. Also fails when tools/list failed while tools-list was filtered out of the run (the recorded reason is named).

---

#### `tools-call` -- tools/call responds correctly

- **Category:** tools
- **Default required:** No (required at runtime when `tools` is declared)
- **Spec reference:** [server/tools#calling-tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#calling-tools)
- **Description:** Calls the first tool whose inputSchema declares no required properties (else the first tool) with empty arguments and validates the result shape: a content array whose items each carry a type (isError: true with content also passes), or resultType 'input_required' (an MRTR InputRequiredResult) with inputRequests entries of the { method, params } shape and/or a string requestState. A JSON-RPC error passes -- -32602 (or -32600) as the expected answer for a tool that needs arguments, any other code noted as a protocol error in the details. resultType 'complete' is not checked here; schema-result-type scans every result post-hoc. tools/list is fetched on demand when tools-list did not run; when that call failed, skipped pointing at tools-list if that test is in the run, and failed with the recorded reason (--only tools-call, or --skip tools-list) when it is not. A server that lists no tools skips. Required at runtime when the tools capability is declared.
- **Pass criteria:** Calling the first tool without required properties (else the first tool) with empty arguments returns a content array whose items each carry a type (isError: true included), an input_required result with well-formed inputRequests and/or a string requestState, or a JSON-RPC error (-32602/-32600 as the expected answer for a tool that needs arguments; any other code is noted as a protocol error). resultType 'complete' is left to schema-result-type. Skipped when the server lists no tools. When tools/list failed the rule skips (as passed) pointing at tools-list if that rule is in the run.
- **Fail criteria:** No result object, a non-input_required result without a content array, a content item without a type, or an input_required result with neither field or a malformed inputRequests entry. Also fails when tools/list failed while tools-list was filtered out of the run (the recorded reason is named).

---

#### `tools-content-types` -- Tool content items have valid types

- **Category:** tools
- **Default required:** No (required at runtime when `tools` is declared)
- **Spec reference:** [server/tools#tool-result](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#tool-result)
- **Description:** Validates that every item in a tools/call content array has a type of text, image, audio, resource or resource_link. These are the only content types defined for tool results; a typo or missing type breaks client rendering. tools/list is fetched on demand when tools-list did not run; when that call failed, skipped pointing at tools-list if that test is in the run, and failed with the recorded reason (--only tools-content-types, or --skip tools-list) when it is not. A server that lists no tools skips. Required at runtime when the tools capability is declared.
- **Pass criteria:** Every item in the tools/call content array has a type of text, image, audio, resource, or resource_link. Skipped when the server lists no tools. When tools/list failed the rule skips (as passed) pointing at tools-list if that rule is in the run.
- **Fail criteria:** Any content item with a missing or unrecognised type. Also fails when tools/list failed while tools-list was filtered out of the run (the recorded reason is named).

---

#### `tools-pagination` -- tools/list supports pagination

- **Category:** tools
- **Default required:** No (required at runtime when `tools` is declared)
- **Spec reference:** [server/utilities/pagination#response-format](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/pagination#response-format)
- **Description:** Reads tools/list and, when nextCursor is present, verifies it is a string and that passing it back as cursor returns another valid page. Cursors are opaque and clients MUST NOT assume a page size, so the server decides when to paginate; a list with no nextCursor passes.
- **Pass criteria:** No nextCursor on tools/list, or a string nextCursor that yields another valid page when passed back as cursor.
- **Fail criteria:** A non-string nextCursor, or a follow-up page that errors or is malformed.

---

### 3b.4 resources -- Resource Operations (8 tests)

Only present when the `resources` capability is declared. New in this revision: caching hints on every cacheable result, and `resources-not-found`, which fails the retired `-32002` code (any code other than `-32602` passes with a warning).

---

#### `resources-list` -- resources/list returns valid response

- **Category:** resources
- **Default required:** No (required at runtime when `resources` is declared)
- **Spec reference:** [server/resources#listing-resources](https://modelcontextprotocol.io/specification/2026-07-28/server/resources#listing-resources)
- **Description:** Calls resources/list and validates the result has a resources array of objects. Servers that declare the resources capability MUST respond to resources/list; required at runtime when the capability is declared.
- **Pass criteria:** resources/list returns a result with a resources array whose entries are objects (empty allowed).
- **Fail criteria:** A JSON-RPC error, or a result without a resources array of objects.

---

#### `resources-list-caching` -- resources/list carries caching hints

- **Category:** resources
- **Default required:** No (required at runtime when `resources` is declared)
- **Spec reference:** [server/utilities/caching#cacheable-results](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching#cacheable-results)
- **Description:** Checks ttlMs (an integer >= 0) and cacheScope ('public' or 'private') on the resources/list result. Both caching hints are a MUST on every complete resources/list result. Required at runtime when the resources capability is declared. Reuses the response the -list test obtained; a list call that got no response (a timeout, a connection error) is not repeated.
- **Pass criteria:** The resources/list result carries ttlMs as an integer >= 0 and cacheScope equal to public or private.
- **Fail criteria:** Either hint missing or invalid, or the resources/list call got no response (reported once; not re-sent).

---

#### `resources-read` -- resources/read returns content

- **Category:** resources
- **Default required:** No (required at runtime when `resources` is declared)
- **Spec reference:** [server/resources#reading-resources](https://modelcontextprotocol.io/specification/2026-07-28/server/resources#reading-resources)
- **Description:** Reads the first listed resource that has a uri and validates the result: a contents array whose items carry uri and either text or blob, or resultType 'input_required' with a valid InputRequiredResult (inputRequests entries of the { method, params } shape and/or a string requestState). A JSON-RPC error for a resource the server itself listed fails, and an empty contents array passes with a warning. resultType 'complete' is not checked here; schema-result-type scans every result post-hoc. resources/list is fetched on demand when resources-list did not run; when that call failed, skipped pointing at resources-list if that test is in the run, and failed with the recorded reason (--only resources-read, or --skip resources-list) when it is not. A server that lists no resource with a uri skips. Required at runtime when the resources capability is declared.
- **Pass criteria:** Reading the first listed resource that has a uri returns a contents array whose items carry uri and text or blob, or an input_required result with a valid InputRequiredResult shape; an empty contents array passes with a warning. resultType 'complete' is left to schema-result-type. Skipped when the server lists no resource with a uri. When resources/list failed the rule skips (as passed) pointing at resources-list if that rule is in the run.
- **Fail criteria:** A JSON-RPC error, no result object, no contents array, a contents item missing uri or both text and blob, or a malformed input_required result. Also fails when resources/list failed while resources-list was filtered out of the run (the recorded reason is named).

---

#### `resources-read-caching` -- resources/read carries caching hints

- **Category:** resources
- **Default required:** No (required at runtime when `resources` is declared)
- **Spec reference:** [server/utilities/caching#cacheable-results](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching#cacheable-results)
- **Description:** Checks ttlMs (an integer >= 0) and cacheScope on the resources/read result. resources/read is a cacheable operation and MUST carry both hints on complete results; input_required interim results carry none and are exempt. resources/list is fetched on demand when resources-list did not run; when that call failed, skipped pointing at resources-list if that test is in the run, and failed with the recorded reason (--only resources-read-caching, or --skip resources-list) when it is not. A server that lists no resource with a uri skips. Required at runtime when the resources capability is declared.
- **Pass criteria:** The complete resources/read result carries ttlMs as an integer >= 0 and cacheScope equal to public or private; input_required interim results are exempt. Skipped when the server lists no resource with a uri. When resources/list failed the rule skips (as passed) pointing at resources-list if that rule is in the run.
- **Fail criteria:** Either hint missing or invalid on a complete result. Also fails when resources/list failed while resources-list was filtered out of the run (the recorded reason is named).

---

#### `resources-not-found` -- Nonexistent resource returns -32602

- **Category:** resources
- **Default required:** No (required at runtime when `resources` is declared)
- **Spec reference:** [server/resources#error-handling](https://modelcontextprotocol.io/specification/2026-07-28/server/resources#error-handling)
- **Description:** Reads a URI that does not exist and expects a JSON-RPC error. Servers MUST return -32602 Invalid params for a missing resource and MUST NOT return an empty contents array: a result of any shape fails, and so does the retired -32002 code, which implementations of this revision MUST NOT emit. Any other error code passes with a warning naming the expected -32602 (-32603 is tolerated because a resolver that throws on the unknown test:// scheme may conformantly answer an internal error). data.uri naming the missing resource is a SHOULD, reported as a warning when absent. Required at runtime when the resources capability is declared.
- **Pass criteria:** Reading a nonexistent URI draws a JSON-RPC error: -32602 passes cleanly, and any other code except -32002 (for example -32603 from a resolver that throws on the unknown scheme) passes with a warning naming the expected -32602; a missing data.uri is reported as a warning.
- **Fail criteria:** A result of any shape (including an empty contents array or input_required), or the retired code -32002.

---

#### `resources-templates` -- resources/templates/list returns valid response

- **Category:** resources
- **Default required:** No (required at runtime when `resources` is declared)
- **Spec reference:** [server/resources#resource-templates](https://modelcontextprotocol.io/specification/2026-07-28/server/resources#resource-templates)
- **Description:** Calls resources/templates/list and validates the result has a resourceTemplates array whose entries carry uriTemplate and name. Templates are optional, so -32601 Method not found passes; a malformed result does not.
- **Pass criteria:** resources/templates/list returns a resourceTemplates array whose entries carry uriTemplate and name, or a -32601 Method not found error.
- **Fail criteria:** A malformed result, or an error other than -32601.

---

#### `resources-templates-caching` -- resources/templates/list carries caching hints

- **Category:** resources
- **Default required:** No (required at runtime when `resources` is declared)
- **Spec reference:** [server/utilities/caching#cacheable-results](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching#cacheable-results)
- **Description:** When resources/templates/list succeeds, checks that the result carries ttlMs (an integer >= 0) and cacheScope. The method is on the list of operations that MUST carry caching hints; skipped when the server does not implement templates. Reuses the response the -list test obtained; a list call that got no response (a timeout, a connection error) is not repeated.
- **Pass criteria:** When resources/templates/list succeeds, its result carries ttlMs as an integer >= 0 and cacheScope equal to public or private; skipped when the method is not implemented.
- **Fail criteria:** Either hint missing or invalid on a successful result, or the resources/templates/list call got no response (reported once; not re-sent).

---

#### `resources-pagination` -- resources/list supports pagination

- **Category:** resources
- **Default required:** No (required at runtime when `resources` is declared)
- **Spec reference:** [server/utilities/pagination#response-format](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/pagination#response-format)
- **Description:** Reads resources/list and, when nextCursor is present, verifies it is a string and that passing it back as cursor returns another valid page. Clients MUST treat cursors as opaque tokens and MUST NOT assume a page size; a list with no nextCursor passes.
- **Pass criteria:** No nextCursor on resources/list, or a string nextCursor that yields another valid page when passed back as cursor.
- **Fail criteria:** A non-string nextCursor, or a follow-up page that errors or is malformed.

---

### 3b.5 prompts -- Prompt Operations (4 tests)

Only present when the `prompts` capability is declared.

---

#### `prompts-list` -- prompts/list returns valid response

- **Category:** prompts
- **Default required:** No (required at runtime when `prompts` is declared)
- **Spec reference:** [server/prompts#listing-prompts](https://modelcontextprotocol.io/specification/2026-07-28/server/prompts#listing-prompts)
- **Description:** Calls prompts/list and validates the result has a prompts array of objects. Servers that declare the prompts capability must serve prompts/list; required at runtime when the capability is declared.
- **Pass criteria:** prompts/list returns a result with a prompts array whose entries are objects (empty allowed).
- **Fail criteria:** A JSON-RPC error, or a result without a prompts array of objects.

---

#### `prompts-list-caching` -- prompts/list carries caching hints

- **Category:** prompts
- **Default required:** No (required at runtime when `prompts` is declared)
- **Spec reference:** [server/utilities/caching#cacheable-results](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching#cacheable-results)
- **Description:** Checks ttlMs (an integer >= 0) and cacheScope ('public' or 'private') on the prompts/list result. Both hints are a MUST on every complete prompts/list result. Required at runtime when the prompts capability is declared. Reuses the response the -list test obtained; a list call that got no response (a timeout, a connection error) is not repeated.
- **Pass criteria:** The prompts/list result carries ttlMs as an integer >= 0 and cacheScope equal to public or private.
- **Fail criteria:** Either hint missing or invalid, or the prompts/list call got no response (reported once; not re-sent).

---

#### `prompts-get` -- prompts/get returns valid messages

- **Category:** prompts
- **Default required:** No (required at runtime when `prompts` is declared)
- **Spec reference:** [server/prompts#getting-a-prompt](https://modelcontextprotocol.io/specification/2026-07-28/server/prompts#getting-a-prompt)
- **Description:** Gets the first listed prompt with no required arguments (else the first prompt, with each required argument filled by the placeholder 'test') and validates the result: a messages array whose items have a role of user or assistant and a content object, or resultType 'input_required' with a valid InputRequiredResult (inputRequests entries of the { method, params } shape and/or a string requestState). A -32602 (or -32600) error for a prompt that rejects the arguments also passes; any other JSON-RPC error fails. resultType 'complete' is not checked here; schema-result-type scans every result post-hoc. prompts/list is fetched on demand when prompts-list did not run; when that call failed, skipped pointing at prompts-list if that test is in the run, and failed with the recorded reason (--only prompts-get, or --skip prompts-list) when it is not. A server that lists no prompts skips. Required at runtime when the prompts capability is declared.
- **Pass criteria:** Getting the first prompt without required arguments (else the first prompt, its required arguments filled with the placeholder 'test') returns a messages array whose items have role user or assistant and a content object, an input_required result with a valid InputRequiredResult shape, or a -32602/-32600 error. resultType 'complete' is left to schema-result-type. Skipped when the server lists no prompts. When prompts/list failed the rule skips (as passed) pointing at prompts-list if that rule is in the run.
- **Fail criteria:** A JSON-RPC error other than -32602/-32600, no result object, a missing or malformed messages array, or a malformed input_required result. Also fails when prompts/list failed while prompts-list was filtered out of the run (the recorded reason is named).

---

#### `prompts-pagination` -- prompts/list supports pagination

- **Category:** prompts
- **Default required:** No (required at runtime when `prompts` is declared)
- **Spec reference:** [server/utilities/pagination#response-format](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/pagination#response-format)
- **Description:** Reads prompts/list and, when nextCursor is present, verifies it is a string and that passing it back as cursor returns another valid page. Cursors are opaque and page size is the server's choice; a list with no nextCursor passes.
- **Pass criteria:** No nextCursor on prompts/list, or a string nextCursor that yields another valid page when passed back as cursor.
- **Fail criteria:** A non-string nextCursor, or a follow-up page that errors or is malformed.

---

### 3b.6 errors -- Error Handling (12 tests)

Error tests send conformant envelopes so the error under test comes from the server's own dispatch, not from `_meta` validation. `error-unknown-method` now expects HTTP 404 on the JSON-RPC error. Two rules are post-hoc scans of every JSON-RPC error recorded during the run; a body that is not a jsonrpc 2.0 error (an auth gate's `{"error":"invalid_token"}` on 401, a gateway's `{"error":{"code":400,...}}`) is not counted.

---

#### `error-unknown-method` -- Unknown method returns JSON-RPC error

- **Category:** errors
- **Default required:** Yes
- **Spec reference:** [basic/transports/streamable-http#protocol-version-header](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#protocol-version-header)
- **Description:** Sends a method name that does not exist (compliance/nonexistent) with a full modern _meta and expects a JSON-RPC error response echoing the request id. On HTTP the server MUST respond 404 Not Found together with the JSON-RPC error body, so a 404 + error passes, an error carried on a 200 passes with a warning on the status, and a result fails.
- **Pass criteria:** A JSON-RPC error echoing the request id; on HTTP a 404 status passes cleanly and an error carried on 200 passes with a warning.
- **Fail criteria:** A result, no response, or an error that does not echo the request id.

---

#### `error-method-code` -- Unknown method uses -32601

- **Category:** errors
- **Default required:** Yes
- **Spec reference:** [basic/index#error-codes](https://modelcontextprotocol.io/specification/2026-07-28/basic/index#error-codes)
- **Description:** Checks that the error returned for the unknown method carries exactly code -32601 (Method not found). MCP uses the standard JSON-RPC 2.0 codes for protocol failures and a server MUST use defined codes only with their specified meanings; -32600, -32000 or an application code here fail.
- **Pass criteria:** The unknown-method error carries exactly code -32601.
- **Fail criteria:** Any other code (-32600, -32000, or an application code).

---

#### `error-invalid-jsonrpc` -- Handles malformed JSON-RPC

- **Category:** errors
- **Default required:** No
- **Transports:** http
- **Spec reference:** [basic/index#requests](https://modelcontextprotocol.io/specification/2026-07-28/basic/index#requests)
- **Description:** POSTs a JSON object that is not a valid JSON-RPC request (no method, no id) with otherwise correct headers and expects a JSON-RPC error or a 4xx status. Requests MUST carry jsonrpc, method and a string or integer id; a 5xx or a result fails.
- **Pass criteria:** A JSON object with no method and no id draws a JSON-RPC error or an HTTP 4xx status.
- **Fail criteria:** A result, a 5xx status, or no response.

---

#### `error-invalid-json` -- Handles invalid JSON body

- **Category:** errors
- **Default required:** No
- **Transports:** http
- **Spec reference:** [basic/index#error-codes](https://modelcontextprotocol.io/specification/2026-07-28/basic/index#error-codes)
- **Description:** POSTs a body that is not JSON ('{not json') with the standard headers and expects a parse error (-32700) or a 4xx status. A 5xx, a hang, or an HTML error page fails.
- **Pass criteria:** The body '{not json' draws a -32700 error or an HTTP 4xx status.
- **Fail criteria:** A 5xx status, a hang, or an HTML error page.

---

#### `error-parse-code` -- Returns -32700 for invalid JSON

- **Category:** errors
- **Default required:** No
- **Transports:** http
- **Spec reference:** [basic/index#error-codes](https://modelcontextprotocol.io/specification/2026-07-28/basic/index#error-codes)
- **Description:** Checks that the response to the invalid-JSON body carries exactly code -32700 (Parse error), the JSON-RPC 2.0 code MCP reuses for unparsable input. A bare 400 with no JSON-RPC body passes with a warning; a different error code fails.
- **Pass criteria:** The invalid-JSON response carries exactly code -32700; a bare 400 with no JSON-RPC body passes with a warning.
- **Fail criteria:** A JSON-RPC error with a code other than -32700.

---

#### `error-invalid-request-code` -- Returns -32600 for invalid request

- **Category:** errors
- **Default required:** No
- **Transports:** http
- **Spec reference:** [basic/index#error-codes](https://modelcontextprotocol.io/specification/2026-07-28/basic/index#error-codes)
- **Description:** Checks that the malformed-envelope response carries exactly code -32600 (Invalid Request). A bare 400 without a JSON-RPC body passes with a warning; -32601 or -32602 for a message that has no method at all fails.
- **Pass criteria:** The malformed-envelope response carries exactly code -32600; a bare 400 with no JSON-RPC body passes with a warning.
- **Fail criteria:** A JSON-RPC error with a code other than -32600 (for example -32601 or -32602).

---

#### `error-missing-params` -- tools/call without name returns error

- **Category:** errors
- **Default required:** No (required at runtime when `tools` is declared)
- **Spec reference:** [server/tools#error-handling](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#error-handling)
- **Description:** Calls tools/call with params carrying only _meta (no name) and expects a JSON-RPC error, -32602 Invalid params expected. A request that fails the CallToolRequest schema is a protocol error and must not produce a result. Skipped when the server declares no tools.
- **Pass criteria:** tools/call with params carrying only _meta (no name) draws a JSON-RPC error (-32602 expected). Skipped when the server declares no tools.
- **Fail criteria:** A result is returned.

---

#### `tools-call-unknown` -- Unknown tool name returns error

- **Category:** errors
- **Default required:** No (required at runtime when `tools` is declared)
- **Spec reference:** [server/tools#error-handling](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#error-handling)
- **Description:** Calls tools/call with a tool name the server did not list and expects a JSON-RPC error (-32602 expected) or a result with isError: true. An unknown tool is a protocol error the model cannot fix; a successful result with empty content fails. Skipped when the server declares no tools.
- **Pass criteria:** tools/call with a name the server did not list draws a JSON-RPC error (-32602 expected) or a result with isError: true. Skipped when the server declares no tools.
- **Fail criteria:** A successful result without isError: true.

---

#### `error-capability-gated` -- Rejects methods for undeclared capabilities

- **Category:** errors
- **Default required:** No
- **Spec reference:** [server/discover#discoverresult](https://modelcontextprotocol.io/specification/2026-07-28/server/discover#discoverresult)
- **Description:** Calls the list method (tools/list, resources/list, prompts/list) for every capability the discover result did NOT declare and expects a JSON-RPC error, -32601 expected. Capabilities are the contract for which methods exist; serving an undeclared one means clients cannot trust the discover result. Skipped when every capability is declared.
- **Pass criteria:** Every list method for a capability the discover result did not declare draws a JSON-RPC error (-32601 expected). Skipped when every capability is declared.
- **Fail criteria:** A list method for an undeclared capability returns a result.

---

#### `error-invalid-cursor` -- Handles invalid pagination cursor

- **Category:** errors
- **Default required:** No
- **Spec reference:** [server/utilities/pagination#error-handling](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/pagination#error-handling)
- **Description:** Sends a garbage cursor to the first list method the server supports and expects either a JSON-RPC error (-32602 expected, which is what the pagination page says an invalid cursor SHOULD produce) or a valid first page. A 5xx, a crash, or a malformed result fails.
- **Pass criteria:** A garbage cursor on the first supported list method draws a JSON-RPC error (-32602 expected) or a valid first page.
- **Fail criteria:** A 5xx status, a crash, or a malformed result.

---

#### `error-id-echo` -- Error responses echo the request id

- **Category:** errors
- **Default required:** No
- **Spec reference:** [basic/index#error-responses](https://modelcontextprotocol.io/specification/2026-07-28/basic/index#error-responses)
- **Description:** Post-hoc scan of every JSON-RPC error response (a jsonrpc 2.0 message whose error object carries a numeric code; a gateway's {"error":"..."} or {"error":{"code":400,...}} body is not one) the server sent during the run: each one answering a request whose id was readable MUST carry that same id. A reply that echoes no id is attributed by timeline: to the most recent request sent before it that never received its own reply, or to a client notification or raw probe sent more recently than that. Exempt: replies to the suite's raw malformed-body probes and to client notifications (there is no id to echo), and a reply WITHOUT an id on a transport-level rejection answered before the JSON-RPC layer read the request (HTTP 401/403/413/415/429). A present but wrong id -- retyped, or another request's -- fails whatever the status, and a null or missing id on the reply to a well-formed request fails whatever the error code, -32600 and -32700 included.
- **Pass criteria:** Every recorded JSON-RPC error response (jsonrpc 2.0 with an error object carrying a numeric code) that answers an id-bearing request carries that same id; an id-less reply is attributed by timeline to the nearest earlier request that never got its own reply, or to a more recent client notification or raw probe. Exempt: replies to the suite's raw probes and client notifications, and replies without an id on HTTP 401/403/413/415/429 transport-level rejections; non-JSON-RPC error bodies (a gateway's {"error":...}) are not counted.
- **Fail criteria:** A JSON-RPC error with a null or missing id in reply to a well-formed request, whatever the error code (-32600 and -32700 included), or a present but wrong id whatever the HTTP status. Also fails when no server message was received during the run (an unreachable server): the scan then has nothing to attest.

---

#### `error-retired-codes` -- No retired error codes

- **Category:** errors
- **Default required:** No
- **Spec reference:** [basic/index#error-codes](https://modelcontextprotocol.io/specification/2026-07-28/basic/index#error-codes)
- **Description:** Post-hoc scan of every error the server sent for the codes retired in 2026-07-28: -32002 (resource not found, replaced by -32602) and -32042 (URL elicitation required, replaced by MRTR). Implementations of this revision MUST NOT emit either; any occurrence fails.
- **Pass criteria:** No recorded JSON-RPC error carries code -32002 or -32042.
- **Fail criteria:** Any occurrence of either code. Also fails when no server message was received during the run (an unreachable server): the scan then has nothing to attest.

---

### 3b.7 schema -- Schema Validation (10 tests)

Definition checks (`tools-schema`, `tools-annotations`, `tools-title-field`, `tools-output-schema`, `prompts-schema`, `resources-schema`) validate the list results -- cached by the feature tests, or fetched once on demand when those did not run (`--only schema`) -- and are capability-gated. When a list call failed they skip pointing at the `-list` rule if it is in the run, and fail with the recorded reason when it was filtered out, so `--only schema` cannot grade A over a broken list. The four post-hoc rules scan every server message the Recorder captured: `resultType` on every result (`complete` or `input_required`, or an extension value only when an `extensions` capability is advertised), `input_required` only on MRTR methods, well-formed `InputRequiredResult`s whose methods the client declared support for, and full validation against the vendored 2026-07-28 JSON schema.

---

#### `tools-schema` -- All tools have name and inputSchema

- **Category:** schema
- **Default required:** No (required at runtime when `tools` is declared)
- **Spec reference:** [server/tools#tool](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#tool)
- **Description:** Validates every listed tool has a name (1-128 characters of [A-Za-z0-9_.-], the SHOULD-level naming rule) and an inputSchema that is a JSON Schema object with type 'object'. inputSchema MUST be a valid JSON Schema object, not null. The list is fetched on demand when the corresponding feature tests did not run (--only schema); when that list call failed, skipped pointing at the -list test that reports it if that test is in the run, and failed with the recorded reason (--only schema, or --skip on the -list test) when it is not.
- **Pass criteria:** Every listed tool has a name matching [A-Za-z0-9_.-]{1,128} and an inputSchema object with type 'object'. The list is fetched on demand under --only. When tools/list failed the rule skips (as passed) pointing at tools-list if that rule is in the run, and fails with the recorded reason when it was filtered out (--only schema).
- **Fail criteria:** Any tool with a missing or malformed name, or an inputSchema that is absent, null, or not type 'object'.

---

#### `tools-annotations` -- Tool annotations are valid

- **Category:** schema
- **Default required:** No (required at runtime when `tools` is declared)
- **Spec reference:** [server/tools#tool](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#tool)
- **Description:** If a tool carries annotations, validates that readOnlyHint, destructiveHint, idempotentHint and openWorldHint are booleans when present and that title, when present, is a string. Clients MUST treat annotations as untrusted hints, so a wrong type is a definition bug rather than a security control. The list is fetched on demand when the corresponding feature tests did not run (--only schema); when that list call failed, skipped pointing at the -list test that reports it if that test is in the run, and failed with the recorded reason (--only schema, or --skip on the -list test) when it is not.
- **Pass criteria:** On every tool that carries annotations, readOnlyHint, destructiveHint, idempotentHint and openWorldHint are booleans when present and title is a string when present. The list is fetched on demand under --only. When tools/list failed the rule skips (as passed) pointing at tools-list if that rule is in the run, and fails with the recorded reason when it was filtered out (--only schema).
- **Fail criteria:** Any annotation hint with a non-boolean value, or a non-string annotations.title.

---

#### `tools-title-field` -- Tools include title field

- **Category:** schema
- **Default required:** No (required at runtime when `tools` is declared)
- **Spec reference:** [server/tools#tool](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#tool)
- **Description:** Checks whether listed tools carry the optional title field, the human-readable display name clients prefer over name. A title that is present must be a string; tools without one are listed in the details but do not fail. The list is fetched on demand when the corresponding feature tests did not run (--only schema); when that list call failed, skipped pointing at the -list test that reports it if that test is in the run, and failed with the recorded reason (--only schema, or --skip on the -list test) when it is not.
- **Pass criteria:** Every listed tool that has a title has a string one; tools without a title are named in the details but still pass. The list is fetched on demand under --only. When tools/list failed the rule skips (as passed) pointing at tools-list if that rule is in the run, and fails with the recorded reason when it was filtered out (--only schema).
- **Fail criteria:** Any tool whose title is present but not a string.

---

#### `tools-output-schema` -- Tools with outputSchema are valid

- **Category:** schema
- **Default required:** No (required at runtime when `tools` is declared)
- **Spec reference:** [server/tools#output-schema](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#output-schema)
- **Description:** For tools that declare outputSchema, validates it is a JSON Schema object (a non-null object; type, $ref or a composition keyword may describe any JSON value). Unlike 2025-11-25 the root is no longer restricted to type 'object': array, string and other roots are valid because structuredContent may be any JSON value. The list is fetched on demand when the corresponding feature tests did not run (--only schema); when that list call failed, skipped pointing at the -list test that reports it if that test is in the run, and failed with the recorded reason (--only schema, or --skip on the -list test) when it is not.
- **Pass criteria:** Every declared outputSchema is a non-null JSON Schema object; any root type is accepted. The list is fetched on demand under --only. When tools/list failed the rule skips (as passed) pointing at tools-list if that rule is in the run, and fails with the recorded reason when it was filtered out (--only schema).
- **Fail criteria:** An outputSchema that is null, not an object, or otherwise not a JSON Schema object.

---

#### `prompts-schema` -- Prompts have name field

- **Category:** schema
- **Default required:** No (required at runtime when `prompts` is declared)
- **Spec reference:** [server/prompts#prompt](https://modelcontextprotocol.io/specification/2026-07-28/server/prompts#prompt)
- **Description:** Validates every listed prompt has a string name and that each entry in an arguments array has a name. Prompt arguments are matched by name in prompts/get and completion/complete, so a nameless argument is unreachable. The list is fetched on demand when the corresponding feature tests did not run (--only schema); when that list call failed, skipped pointing at the -list test that reports it if that test is in the run, and failed with the recorded reason (--only schema, or --skip on the -list test) when it is not.
- **Pass criteria:** Every listed prompt has a string name and every entry in its arguments array has a name. The list is fetched on demand under --only. When prompts/list failed the rule skips (as passed) pointing at prompts-list if that rule is in the run, and fails with the recorded reason when it was filtered out (--only schema).
- **Fail criteria:** A prompt without a string name, or an argument without a name.

---

#### `resources-schema` -- Resources have uri and name

- **Category:** schema
- **Default required:** No (required at runtime when `resources` is declared)
- **Spec reference:** [server/resources#resource](https://modelcontextprotocol.io/specification/2026-07-28/server/resources#resource)
- **Description:** Validates every listed resource has a parseable URI and a string name. Custom URI schemes MUST conform to RFC 3986; an unparseable uri cannot be passed back to resources/read. The list is fetched on demand when the corresponding feature tests did not run (--only schema); when that list call failed, skipped pointing at the -list test that reports it if that test is in the run, and failed with the recorded reason (--only schema, or --skip on the -list test) when it is not.
- **Pass criteria:** Every listed resource has a parseable absolute URI and a string name. The list is fetched on demand under --only. When resources/list failed the rule skips (as passed) pointing at resources-list if that rule is in the run, and fails with the recorded reason when it was filtered out (--only schema).
- **Fail criteria:** An unparseable uri, or a missing or non-string name.

---

#### `schema-result-type` -- Every result carries resultType

- **Category:** schema
- **Default required:** Yes
- **Spec reference:** [basic/index#result-responses](https://modelcontextprotocol.io/specification/2026-07-28/basic/index#result-responses)
- **Description:** Post-hoc scan of every JSON-RPC result the server sent during the run: each result MUST include a string resultType that is 'complete' or 'input_required'. Any other value passes, with a warning naming it, only when server/discover advertised an extensions capability that could define it; without one it fails, since a resultType the client does not recognize MUST be treated as invalid. A result with no resultType is what a 2025-11-25 server returns and fails here (the reply to the suite's own legacy initialize probe is exempt).
- **Pass criteria:** Every recorded JSON-RPC result (the reply to the suite's legacy initialize probe exempt) carries resultType 'complete' or 'input_required'; another string value passes with a warning only when server/discover advertised a non-empty extensions capability.
- **Fail criteria:** A result with no string resultType, or a value other than complete/input_required while no extension is advertised. Also fails when no server message was received during the run (an unreachable server): the scan then has nothing to attest.

---

#### `schema-no-input-required-on-lists` -- input_required only on MRTR methods

- **Category:** schema
- **Default required:** Yes
- **Spec reference:** [basic/patterns/mrtr#supported-requests](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr#supported-requests)
- **Description:** Post-hoc scan of every result with resultType 'input_required', traced back to the request that produced it. Servers MAY return an InputRequiredResult only for tools/call, prompts/get and resources/read and MUST NOT on any other request; an input_required result on server/discover, a list method, completion/complete or subscriptions/listen fails.
- **Pass criteria:** Every recorded input_required result answers tools/call, prompts/get, or resources/read.
- **Fail criteria:** An input_required result on server/discover, a list method, completion/complete, subscriptions/listen, or any other method. Also fails when no server message was received during the run (an unreachable server): the scan then has nothing to attest.

---

#### `schema-input-required-shape` -- InputRequiredResult is well-formed

- **Category:** schema
- **Default required:** No
- **Spec reference:** [basic/patterns/mrtr#server-requirements-basic-workflow](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr#server-requirements-basic-workflow)
- **Description:** Post-hoc, opportunistic check of every input_required result observed against the MRTR server requirements: it MUST include at least one of inputRequests or requestState; each inputRequests value must be an object whose method is elicitation/create, sampling/createMessage or roots/list, with a params object for elicitation/create and sampling/createMessage (ListRootsRequest.params is optional); the client capability each method needs (elicitation, sampling, roots) MUST have been declared by the client -- this suite declares only elicitation, so a sampling/createMessage or roots/list input request fails; an elicitation/create's params.mode (form when absent) must be a mode the client's elicitation declaration covers -- this suite declares elicitation: {}, which is form only, so a url-mode request fails; requestState, when present, must be a string. Passes vacuously when no input_required result was seen.
- **Pass criteria:** Every observed input_required result has inputRequests and/or requestState; each inputRequests value is an object whose method is elicitation/create, sampling/createMessage or roots/list and whose client capability the suite declared (elicitation only), with a params object for elicitation/create and sampling/createMessage; an elicitation/create's params.mode (form when absent) is a mode the declared elicitation capability covers (the suite's elicitation: {} is form only); requestState is a string when present. Passes vacuously when none was observed.
- **Fail criteria:** An input_required result missing both fields, an entry with an unknown method, a method whose client capability was not declared (sampling/createMessage, roots/list), an elicitation mode the client did not declare (url under elicitation: {}), a missing params object where required, or a non-string requestState. Also fails when no server message was received during the run (an unreachable server): the scan then has nothing to attest.

---

#### `schema-wire-valid` -- Messages validate against the 2026-07-28 schema

- **Category:** schema
- **Default required:** No
- **Spec reference:** [basic/index#schema](https://modelcontextprotocol.io/specification/2026-07-28/basic/index#schema)
- **Description:** Post-hoc validation of every recorded server message against the vendored 2026-07-28 JSON schema, dispatching by method for notifications, by resultType plus the originating request's method for results, and by error code for errors. Replies to the suite's raw malformed-body probes and to its legacy initialize probe are skipped, an error's id: null is treated as omitted (error-id-echo judges whether null was earned), and a non-JSON-RPC body on any HTTP 4xx or 5xx (an auth gate's 401, a header-validating intermediary's 400, a gateway's 502) is noted, not validated -- at 2xx the same body is the server's own answer and is. The TypeScript schema is the source of truth for every message; the details list the distinct violations, grouped by originating method and first schema error with a count, and overflow the rest to a warning.
- **Pass criteria:** Every recorded server message validates against the vendored 2026-07-28 JSON schema for its message type; replies to raw probes and to the legacy initialize are skipped, an error's id: null is treated as omitted, and a non-JSON-RPC body on any HTTP 4xx or 5xx (an auth gate, a header-validating intermediary, a gateway) is noted rather than validated.
- **Fail criteria:** Any other message that fails schema validation, including a non-JSON-RPC body served at 2xx (the details list the distinct violations grouped by originating method and first schema error, with counts; the overflow goes to a warning). Also fails when no server message was received during the run (an unreachable server): the scan then has nothing to attest.

---

### 3b.8 security -- Security Validation (21 tests)

Same coverage as 2025-11-25 minus the two session-id rules (there are no sessions). Auth and transport-security probes use a conformant `server/discover` with modern headers so credentials are the only variable; `security-auth-required`, `security-www-authenticate` and `security-oauth-metadata` probe with or without `--auth`, and only `security-auth-malformed` and `security-token-in-uri` need a credential. The four injection rules share **one** target, chosen from the safest annotation tier that has a string argument -- `readOnlyHint: true`, then `destructiveHint: false`, then unannotated tools (destructive by the spec default), then `destructiveHint: true` -- with free-form arguments before enum/const/pattern ones, the other required arguments filled with schema-honouring placeholders, and `x-mcp-header` parameters mirrored into `Mcp-Param-*` headers so the request stays valid; passed-over and live-probed tools are named in warnings, and a run in which no payload reached the tool passes as inconclusive with a warning. `security-rate-limiting` passes a quiet burst with a warning on either path and skips a burst that auth rejected. Tool-dependent rules fetch `tools/list` on demand, so `--only security` measures the server. All rules stay optional (severity `warning`); the leak scans and the rate-limit burst fail as 'server unreachable' when nothing answered.

---

#### `security-auth-required` -- Rejects unauthenticated requests

- **Category:** security
- **Default required:** No
- **Transports:** http
- **Spec reference:** [basic/authorization#token-handling](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization#token-handling)
- **Description:** Sends a fully conformant server/discover with the Authorization header removed and expects HTTP 401 (403 also passes). Servers acting as OAuth 2.1 resource servers MUST answer missing or invalid tokens with 401. The probe is sent with or without --auth: a 401 passes either way (without --auth the details suggest passing it to exercise the rest of the auth tests), and a 2xx fails as an accepted unauthenticated request.
- **Pass criteria:** A conformant server/discover with the Authorization header removed draws HTTP 401 or 403 (probed with or without --auth), or the connection is refused.
- **Fail criteria:** Any other status: the server accepted an unauthenticated request (the details say when no --auth was provided).

---

#### `security-www-authenticate` -- 401 responses include WWW-Authenticate

- **Category:** security
- **Default required:** No
- **Transports:** http
- **Spec reference:** [basic/authorization/authorization-server-discovery#protected-resource-metadata-discovery-requirements](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery#protected-resource-metadata-discovery-requirements)
- **Description:** When the unauthenticated server/discover yields 401 (with or without --auth), checks for a WWW-Authenticate header. Servers MUST implement one of two discovery mechanisms, and the header form (Bearer resource_metadata="...") is the one clients try first; a 401 with no challenge leaves the client unable to locate the authorization server, and a challenge without resource_metadata, or whose resource_metadata is not an absolute http(s) URL (RFC 9728 section 5.1), passes with a warning. Skipped when no 401 was observed.
- **Pass criteria:** The 401 observed on the unauthenticated server/discover carries a WWW-Authenticate header (a challenge without resource_metadata, or whose resource_metadata is not an absolute http(s) URL, passes with a warning). Skipped when no 401 was observed (a 403 or a served request).
- **Fail criteria:** A 401 with no WWW-Authenticate header.

---

#### `security-auth-malformed` -- Rejects malformed auth credentials

- **Category:** security
- **Default required:** No
- **Transports:** http
- **Spec reference:** [basic/authorization#token-handling](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization#token-handling)
- **Description:** Sends two conformant server/discover requests in place of the configured credential: Authorization: Bearer aW52YWxpZC10b2tlbg, a well-formed token no authorization server issued, which MUST draw HTTP 401 (403 also passes); and a value outside the RFC 6750 b64token grammar, a malformed authorization request that the spec's error table lets a server answer with 400 Bad Request as well as 401 or 403. Servers MUST validate access tokens, including their audience. A server that accepts either credential fails, and so does one answering the well-formed invalid token with anything but 401/403; the details name both outcomes. Requires --auth: without a credential the server accepts, rejecting invalid ones proves nothing.
- **Pass criteria:** In place of the configured credential, Authorization: Bearer aW52YWxpZC10b2tlbg (well-formed, unissued) draws HTTP 401 or 403 and a value outside the RFC 6750 b64token grammar draws 400, 401 or 403 (a refused connection also passes). Requires --auth; skipped otherwise.
- **Fail criteria:** Either credential is accepted (2xx), the well-formed invalid token draws a status other than 401/403, or the malformed credential draws a status other than 400/401/403.

---

#### `security-tls-required` -- Enforces HTTPS/TLS

- **Category:** security
- **Default required:** No
- **Transports:** http
- **Spec reference:** [basic/authorization/security-considerations#communication-security](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations#communication-security)
- **Description:** If the server URL is https, sends the same modern server/discover over plain http to the same host and expects a refusal or a redirect to https. Communication security follows OAuth 2.1: a bearer token on a plaintext connection is exposed to every intermediary. An http target fails outright (production servers should not be reachable in the clear).
- **Pass criteria:** For an https target, the same server/discover over plain http to the same host is refused or redirected to https.
- **Fail criteria:** A result over plaintext, or an http target (fails outright).

---

#### `security-oauth-metadata` -- Protected Resource Metadata endpoint exists

- **Category:** security
- **Default required:** No
- **Transports:** http
- **Spec reference:** [basic/authorization/authorization-server-discovery#authorization-server-location](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery#authorization-server-location)
- **Description:** Locates RFC 9728 Protected Resource Metadata the way clients must: when the WWW-Authenticate challenge on the unauthenticated server/discover carries resource_metadata, that URL is fetched and nothing else -- clients MUST use it, so an advertised URL that is unreachable, non-200, non-JSON, missing resource or authorization_servers, or not an absolute http(s) URL fails outright (the details say when a valid document exists at a well-known location the challenge could point at). Only without a challenge URL are the well-known locations tried in spec order: /.well-known/oauth-protected-resource followed by the endpoint path, then the root; a legacy /.well-known/oauth-authorization-server hit then passes with a warning. Validates a JSON document with resource and a non-empty authorization_servers array, and warns when resource is not the MCP endpoint URL in canonical form (RFC 9728 section 3.3). MCP servers MUST implement one of the two discovery mechanisms and the document MUST name at least one authorization server. Runs without --auth when the unauthenticated request drew 401/403; skipped when the server requires no auth; fails as 'server unreachable' when that request got no answer at all.
- **Pass criteria:** When the WWW-Authenticate challenge carries resource_metadata, that absolute URL (and only it) returns JSON with resource and a non-empty authorization_servers array; without one, /.well-known/oauth-protected-resource followed by the endpoint path, then the root, does, or a legacy /.well-known/oauth-authorization-server document exists (passes with a warning). A resource that is not the MCP endpoint in canonical form passes with a warning. Runs without --auth when the unauthenticated request drew 401/403; skipped when the server requires no auth.
- **Fail criteria:** An advertised resource_metadata URL that is not absolute http(s), unreachable, non-200, non-JSON, or lacks resource or a non-empty authorization_servers (a valid well-known document does not rescue it; the details name it); without a challenge URL, no candidate serves the document and no legacy metadata exists, a served document is malformed, or every candidate is unreachable; or the unauthenticated server/discover got no answer at all (server unreachable).

---

#### `security-token-in-uri` -- Rejects auth tokens in query string

- **Category:** security
- **Default required:** No
- **Transports:** http
- **Spec reference:** [basic/authorization#token-requirements](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization#token-requirements)
- **Description:** Sends a conformant server/discover with the Authorization header removed and the configured token placed in the URL query string (?access_token=...) and expects HTTP 401. Access tokens MUST NOT be included in the URI query string; a server that accepts them there teaches clients to leak tokens into logs and Referer headers. Requires --auth.
- **Pass criteria:** A server/discover with the token moved from the Authorization header to the ?access_token= query parameter draws HTTP 401 or 403, a non-2xx status, or a JSON-RPC error. Requires --auth.
- **Fail criteria:** A 2xx result or non-error body (the query-string token was honoured).

---

#### `security-cors-headers` -- CORS headers are restrictive

- **Category:** security
- **Default required:** No
- **Transports:** http
- **Spec reference:** [basic/transports/streamable-http#security-%26-endpoint](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#security-%26-endpoint)
- **Description:** Sends a conformant server/discover with an Origin header from a plausible web app and inspects Access-Control-Allow-Origin on the response. A wildcard (*) on an endpoint that accepts bearer credentials lets any page drive the server from a browser; specific origins, or no CORS headers at all, pass.
- **Pass criteria:** Access-Control-Allow-Origin on the OPTIONS preflight and on the server/discover response is absent or names a specific origin.
- **Fail criteria:** Access-Control-Allow-Origin: * is returned, or the foreign Origin is reflected back.

---

#### `security-origin-validation` -- Validates Origin header

- **Category:** security
- **Default required:** No
- **Transports:** http
- **Spec reference:** [basic/transports/streamable-http#security-%26-endpoint](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#security-%26-endpoint)
- **Description:** Sends a fully valid server/discover (correct headers and _meta) with Origin: https://evil-rebinding-attack.example.com so that the origin is the only defect, and expects HTTP 403. Servers MUST validate Origin on all incoming connections and MUST respond 403 Forbidden when it is present and invalid; that is the DNS-rebinding defence for locally bound servers.
- **Pass criteria:** A fully valid server/discover with Origin: https://evil-rebinding-attack.example.com draws HTTP 403 (401 or another 4xx/5xx also counts as rejected).
- **Fail criteria:** A 2xx status (the origin was not validated), or a 1xx/3xx status.

---

#### `security-command-injection` -- Resists command injection in tool params

- **Category:** security
- **Default required:** No (required at runtime when `tools` is declared)
- **Spec reference:** [server/tools#security-considerations](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#security-considerations)
- **Description:** Calls one tool with OS command-injection payloads ('; cat /etc/passwd', '$(whoami)', backticks) in one string argument. Tools with a string argument are tiered by annotation -- readOnlyHint true, then destructiveHint false, then unannotated, then destructiveHint true -- and only the safest non-empty tier is searched, because the spec defaults destructiveHint to true: a tool that says nothing may write, so it is a last resort. Passed-over tools are named in a warning (destructive and unannotated separately), and when the probed tool is unannotated or destructive a warning says it was hit with live payloads. Within the tier a free-form string argument is chosen over an enum/const/pattern one, which no payload can satisfy. The tool's other required arguments are filled with placeholders that honour the schema (const/enum/default/examples, the first non-null type, minimum, minItems, minLength/format, nested required) so the payload reaches the handler (also warned), and x-mcp-header parameters are mirrored into Mcp-Param-* headers so the request stays valid. Results are inspected for evidence of execution (passwd lines, id output, directory listings) and the details count what came back: rejected (isError or rejection wording -- the only outcome counted as a defence), returned without evidence of execution, and never reached the tool (a JSON-RPC or transport error). When no payload reached the tool at all the test passes as inconclusive with a warning. Servers MUST validate all tool inputs; a tool that echoes the payload back unexecuted passes. Skipped when the server declares or lists no tools; tools/list is fetched on demand under --only security, and when that call failed the test skips pointing at tools-list if that test is in the run, and fails with the recorded reason when it is not.
- **Pass criteria:** No result from the single target -- a tool with a string argument from the safest annotation tier (readOnlyHint true, then destructiveHint false, then unannotated, then destructiveHint true; the spec defaults destructiveHint to true), a free-form argument before an enum/const/pattern one, other required arguments filled with schema-honouring placeholders -- shows evidence of executing an injected shell payload (passwd lines, id output, directory listings) without rejection wording or isError; the details count rejected, benign and never-reached payloads, and a run where no payload reached the tool passes as inconclusive with a warning. Skipped when the server declares or lists no tools. When tools/list failed the rule skips (as passed) pointing at tools-list if that rule is in the run.
- **Fail criteria:** Any result containing evidence of execution that is not also a rejection. Also fails when tools/list failed while tools-list was filtered out of the run (the recorded reason is named).

---

#### `security-sql-injection` -- Resists SQL injection in tool params

- **Category:** security
- **Default required:** No (required at runtime when `tools` is declared)
- **Spec reference:** [server/tools#security-considerations](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#security-considerations)
- **Description:** Calls the same single target as security-command-injection with SQL-injection payloads (' OR 1=1 --, UNION SELECT, stacked statements), other required arguments filled with schema-honouring placeholders and x-mcp-header parameters mirrored into headers, and inspects results for database error text or unexpected row dumps. The details count rejected, benign and never-reached outcomes; only rejections count as a defence, and a run in which no payload reached the tool passes as inconclusive with a warning. Servers MUST validate all tool inputs and sanitise tool outputs. Skipped when the server declares or lists no tools; tools/list is fetched on demand under --only security, and when that call failed the test skips pointing at tools-list if that test is in the run, and fails with the recorded reason when it is not.
- **Pass criteria:** No result from the same single target contains database error text or unexpected row dumps for the SQL payloads without rejection wording or isError; all never-reached passes as inconclusive with a warning. Skipped when the server declares or lists no tools. When tools/list failed the rule skips (as passed) pointing at tools-list if that rule is in the run.
- **Fail criteria:** Any result containing database error text or dumped rows that is not also a rejection. Also fails when tools/list failed while tools-list was filtered out of the run (the recorded reason is named).

---

#### `security-path-traversal` -- Resists path traversal in tool params

- **Category:** security
- **Default required:** No (required at runtime when `tools` is declared)
- **Spec reference:** [server/tools#security-considerations](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#security-considerations)
- **Description:** Calls one tool with path-traversal payloads (../../etc/passwd, ..\\..\\windows\\system.ini, URL-encoded variants) in one string argument, preferring an argument whose name suggests a path (path, file, dir, folder; then url, uri, href, endpoint, host) searched across the tools of the safest annotation tier only (readOnlyHint true first; see security-command-injection) -- a non-read-only tool's path argument is never chosen while a read-only tool has any string argument, since the spec defaults destructiveHint to true -- otherwise the shared injection target. Other required arguments are filled with schema-honouring placeholders and x-mcp-header parameters mirrored. Inspects results for file contents outside the tool's scope and counts rejected, benign and never-reached outcomes (all never-reached passes as inconclusive with a warning). Servers MUST validate inputs and, for file:// resources, MUST sanitise paths to prevent directory traversal. Skipped when the server declares or lists no tools; tools/list is fetched on demand under --only security, and when that call failed the test skips pointing at tools-list if that test is in the run, and fails with the recorded reason when it is not.
- **Pass criteria:** No result from the target (a path-named string argument when one exists in the safest annotation tier, else a URL-named one, else the shared injection target) contains file contents from outside the tool's scope for the traversal payloads without rejection wording or isError; all never-reached passes as inconclusive with a warning. Skipped when the server declares or lists no tools. When tools/list failed the rule skips (as passed) pointing at tools-list if that rule is in the run.
- **Fail criteria:** Any result containing out-of-scope file contents that is not also a rejection. Also fails when tools/list failed while tools-list was filtered out of the run (the recorded reason is named).

---

#### `security-ssrf-internal` -- Resists SSRF to internal networks

- **Category:** security
- **Default required:** No (required at runtime when `tools` is declared)
- **Spec reference:** [server/tools#security-considerations](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#security-considerations)
- **Description:** Submits internal targets (the 169.254.169.254 metadata service, 127.0.0.1, [::1], 10.0.0.1) to one string argument, preferring one whose name suggests a URL (url, uri, href, endpoint, host, link; then path, file, dir) searched across the tools of the safest annotation tier only (readOnlyHint true first; see security-command-injection); when no such argument exists the shared injection target is used, so the details always name the tool.argument probed. Other required arguments are filled with schema-honouring placeholders and x-mcp-header parameters mirrored. Inspects results for cloud-metadata or internal-service responses and counts rejected, benign and never-reached outcomes (all never-reached passes as inconclusive with a warning). Servers MUST validate all tool inputs; fetching internal addresses on a caller's behalf is server-side request forgery. Skipped when the server declares or lists no tools; tools/list is fetched on demand under --only security, and when that call failed the test skips pointing at tools-list if that test is in the run, and fails with the recorded reason when it is not.
- **Pass criteria:** No result from the target (a URL-named string argument when one exists in the safest annotation tier, else a path-named one, else the shared injection target) contains cloud-metadata or internal-service content for the internal targets without rejection wording or isError; all never-reached passes as inconclusive with a warning. Skipped when the server declares or lists no tools. When tools/list failed the rule skips (as passed) pointing at tools-list if that rule is in the run.
- **Fail criteria:** Any result containing metadata or internal-service content that is not also a rejection. Also fails when tools/list failed while tools-list was filtered out of the run (the recorded reason is named).

---

#### `security-oversized-input` -- Handles oversized inputs gracefully

- **Category:** security
- **Default required:** No (required at runtime when `tools` is declared)
- **Spec reference:** [server/tools#security-considerations](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#security-considerations)
- **Description:** Calls a tool with a string argument of roughly 1 MB in the first string argument that is not header-mirrored (an x-mcp-header value would also travel in an Mcp-Param-* header and measure the header limit instead of the body; such an argument is used only when no other exists, and the details say so; a tool with no string argument at all gets the value as 'data'), far beyond what any reasonable tool needs, and expects a prompt rejection: HTTP 413 or another 4xx on HTTP, or a JSON-RPC error on either transport. A completed result passes with a warning (the server survived), while a 5xx, a timeout or a broken stdio frame fails. Skipped when the server declares or lists no tools; tools/list is fetched on demand under --only security, and when that call failed the test skips pointing at tools-list if that test is in the run, and fails with the recorded reason when it is not.
- **Pass criteria:** A roughly 1 MB string in the first string argument that is not header-mirrored (a mirrored one only when no other exists, noted in the details) draws HTTP 413 or another 4xx on HTTP, or a JSON-RPC error on either transport; a completed result passes with a warning, and so does a reply that overflowed the runner's stdio line buffer. Skipped when the server declares or lists no tools. When tools/list failed the rule skips (as passed) pointing at tools-list if that rule is in the run.
- **Fail criteria:** A 5xx status, a timeout, a broken stdio frame, or a stdio child that dies. Also fails when tools/list failed while tools-list was filtered out of the run (the recorded reason is named).

---

#### `security-extra-params` -- Rejects or ignores extra tool params

- **Category:** security
- **Default required:** No (required at runtime when `tools` is declared)
- **Spec reference:** [server/tools#security-considerations](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#security-considerations)
- **Description:** Calls the first tool with arguments that include properties its inputSchema does not define and verifies the server either rejects them (-32602) or ignores them, without a 5xx or a crash (a dropped connection, or a stdio child that exits). A call that merely times out is inconclusive and passes with a warning. Servers MUST validate tool inputs; unknown properties reaching internal functions are a classic parameter-injection vector. Skipped when the server declares or lists no tools; tools/list is fetched on demand under --only security, and when that call failed the test skips pointing at tools-list if that test is in the run, and fails with the recorded reason when it is not.
- **Pass criteria:** Arguments with properties the first tool's inputSchema does not define are rejected with a JSON-RPC error or ignored with a normal result; a call that times out passes with a warning (inconclusive). Skipped when the server declares or lists no tools. When tools/list failed the rule skips (as passed) pointing at tools-list if that rule is in the run.
- **Fail criteria:** A 5xx status, a malformed response, a stdio child that exits, or a dropped connection. Also fails when tools/list failed while tools-list was filtered out of the run (the recorded reason is named).

---

#### `security-tool-schema-defined` -- All tools define inputSchema

- **Category:** security
- **Default required:** No (required at runtime when `tools` is declared)
- **Spec reference:** [server/tools#tool](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#tool)
- **Description:** Verifies every listed tool has an inputSchema with type 'object'. inputSchema MUST be a valid JSON Schema object; a tool without one cannot have its arguments validated, so anything the model sends reaches the handler unchecked. Skipped when the server declares or lists no tools; tools/list is fetched on demand under --only security, and when that call failed the test skips pointing at tools-list if that test is in the run, and fails with the recorded reason when it is not.
- **Pass criteria:** Every listed tool has an inputSchema with type 'object'. Skipped when the server declares or lists no tools. When tools/list failed the rule skips (as passed) pointing at tools-list if that rule is in the run.
- **Fail criteria:** Any tool without such an inputSchema. Also fails when tools/list failed while tools-list was filtered out of the run (the recorded reason is named).

---

#### `security-tool-rug-pull` -- Tool definitions are stable across calls

- **Category:** security
- **Default required:** No (required at runtime when `tools` is declared)
- **Spec reference:** [server/tools#capabilities](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#capabilities)
- **Description:** Calls tools/list twice and compares the definitions (name, description, inputSchema, annotations). The set MUST NOT vary per-connection or as a side effect of other requests, and silently changing a definition between calls is the rug-pull pattern behind tool poisoning; a legitimate change is announced with notifications/tools/list_changed on a subscriptions/listen stream. Skipped when the server declares no tools; tools/list is fetched on demand under --only security, and when that call failed the test skips pointing at tools-list if that test is in the run, and fails with the recorded reason when it is not.
- **Pass criteria:** Two tools/list calls return identical definitions (name, description, inputSchema, annotations). Skipped when the server declares no tools. When tools/list failed the rule skips (as passed) pointing at tools-list if that rule is in the run.
- **Fail criteria:** Any definition differs between the two calls. Also fails when tools/list failed while tools-list was filtered out of the run (the recorded reason is named).

---

#### `security-tool-description-poisoning` -- Tool descriptions free of injection patterns

- **Category:** security
- **Default required:** No (required at runtime when `tools` is declared)
- **Spec reference:** [server/tools#security-considerations](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#security-considerations)
- **Description:** Scans tool names, descriptions and parameter descriptions for prompt-injection patterns ('ignore previous instructions', 'system prompt', hidden Unicode such as zero-width and bidi controls, long Base64 runs). Tool text is rendered into the model context, so an injection here reaches every user of the server. Skipped when the server declares or lists no tools; tools/list is fetched on demand under --only security, and when that call failed the test skips pointing at tools-list if that test is in the run, and fails with the recorded reason when it is not.
- **Pass criteria:** No tool name, title, description, or parameter description matches a prompt-injection pattern (instruction overrides, hidden Unicode, long Base64 runs in prose). Skipped when the server declares or lists no tools. When tools/list failed the rule skips (as passed) pointing at tools-list if that rule is in the run.
- **Fail criteria:** Any match (the tool and pattern are named in the details). Also fails when tools/list failed while tools-list was filtered out of the run (the recorded reason is named).

---

#### `security-tool-cross-reference` -- Tools do not reference other tools by name

- **Category:** security
- **Default required:** No (required at runtime when `tools` is declared)
- **Spec reference:** [server/tools#security-considerations](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#security-considerations)
- **Description:** Checks that no tool description mentions another tool's name. Cross-references let a description steer the model's tool selection and chain calls the user never asked for; a description should describe only the tool it belongs to. Skipped when the server declares no tools; tools/list is fetched on demand under --only security, and when that call failed the test skips pointing at tools-list if that test is in the run, and fails with the recorded reason when it is not.
- **Pass criteria:** No tool description mentions another listed tool's name. Skipped when the server declares no tools. When tools/list failed the rule skips (as passed) pointing at tools-list if that rule is in the run.
- **Fail criteria:** Any cross-reference found (named in the details). Also fails when tools/list failed while tools-list was filtered out of the run (the recorded reason is named).

---

#### `security-error-no-stacktrace` -- Error responses do not leak stack traces

- **Category:** security
- **Default required:** No
- **Spec reference:** [basic/index#error-responses](https://modelcontextprotocol.io/specification/2026-07-28/basic/index#error-responses)
- **Description:** Triggers a range of failures (unknown method, malformed _meta, missing params, unknown tool, garbage cursor, and on HTTP an unparsable body) with conformant envelopes so the errors come from the server's own handlers rather than the transport layer, then scans every distinct error response the run received -- once each -- for stack traces, file paths (Unix and Windows, including the JSON-escaped form; a letter and a colon followed by a JSON escape, such as ERROR: before an escaped newline, is not a drive), module names, framework internals and database connection strings. One leak repeated across responses is reported once with a repeat count. Fails as 'server unreachable' when no probe was answered and the run recorded no server message. Error responses MAY carry data, but internals in it map the server for an attacker.
- **Pass criteria:** No distinct error response (each scanned once) contains a stack trace, a file path (Unix, or Windows raw or JSON-escaped -- a letter and colon before a JSON escape such as an escaped newline is not a drive), a module name, a framework internal or a database connection string that is not an echo of the request; a leak repeated across responses is reported once with a count.
- **Fail criteria:** Any such leak found, or none of the failure probes was answered and the run recorded no server message (server unreachable).

---

#### `security-error-no-internal-ip` -- Error responses do not leak internal IPs

- **Category:** security
- **Default required:** No
- **Spec reference:** [basic/index#error-responses](https://modelcontextprotocol.io/specification/2026-07-28/basic/index#error-responses)
- **Description:** Scans the same error responses for private and link-local IPv4 ranges (10.x, 172.16-31.x, 192.168.x, 127.x, 169.254.x), IPv6 loopback (::1, [::1]:port, ::1:port -- not a public address that merely ends in ::1), link-local and unique-local addresses, and internal hostnames (lowercase *.internal, *.local, *.corp, *.lan, *.intranet as the last label, with hostname context: two or more labels before the suffix, or a preceding //, @, getaddrinfo, ENOTFOUND or EAI_AGAIN, or a :port -- so ctx.internal, settings.local.json and api.corp-services.example.com are not flagged). Fails as 'server unreachable' when nothing was received. Request bodies carry the full modern _meta so the errors originate from deeper layers such as upstream connectors, which is where addressing leaks.
- **Pass criteria:** No distinct error response contains a private or link-local IPv4 address (10.x, 172.16-31.x, 192.168.x, 127.x, 169.254.x), an IPv6 loopback (::1, [::1]:port, ::1:port), link-local or unique-local address, or an internal hostname (lowercase *.internal, *.local, *.corp, *.lan, *.intranet as the last label, with two or more labels before it or a preceding //, @, getaddrinfo, ENOTFOUND, EAI_AGAIN, or a :port) that is not an echo of the request.
- **Fail criteria:** Any such address or hostname found, or none of the failure probes was answered and the run recorded no server message (server unreachable).

---

#### `security-rate-limiting` -- Rate limiting is enforced

- **Category:** security
- **Default required:** No
- **Transports:** http
- **Spec reference:** [server/tools#security-considerations](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#security-considerations)
- **Description:** Sends a burst of 50 rapid tools/call requests to the first tool annotated readOnlyHint true that declares no required arguments and checks whether the server answers any of them with HTTP 429 Too Many Requests; the details name the method bursted and, for a tool, how many times it was invoked. Servers MUST rate limit tool invocations and SHOULD rate limit log and progress traffic; a 429 passes, and a burst where most responses are 5xx fails (the server should throttle, not fall over). A burst that draws no 429 passes with a warning on either path -- 50 requests cannot prove the absence of a limiter -- so annotating a tool readOnlyHint never lowers the grade. When no such tool exists, server/discover is bursted instead and the warning says tool invocations could not be exercised. Inconclusive cases are reported as such: every request rejected by auth (401/403) skips with a hint to pass --auth (or to check the credential when --auth was given), and no response at all fails as 'server unreachable'.
- **Pass criteria:** At least one HTTP 429 among 50 rapid tools/call requests to the first readOnlyHint tool that declares no required arguments (tools/list fetched on demand), or among 50 rapid server/discover requests when no such tool exists. A burst that draws no 429 passes with a warning on either path; one where every response is 401/403 is skipped as unmeasurable (pass --auth).
- **Fail criteria:** More than 25 of the 50 responses are 5xx (whichever method was bursted), or none of the 50 requests got a response (server unreachable).

---

## 4. Rule Catalog (Machine-Readable)

The file `mcp-compliance-rules.json` provides a machine-readable catalog of all 191 test rules: 88 for MCP 2025-11-25 and 103 for MCP 2026-07-28. It is the canonical source for rule metadata and is intended for tooling integration (IDEs, CI pipelines, dashboards). A test in `src/tests/catalog-parity.test.ts` keeps it in lock-step with the code's catalogs (`TEST_DEFINITIONS`, `MODERN_TEST_DEFINITIONS`) and with the `####` rule headings in sections 3 and 3b.

**Schema (methodology 2.0.0):**

```json
{
  "specVersion": "2.0.0",
  "specDate": "2026-09-14",
  "mcpSpecCompatibility": ["2025-11-25", "2026-07-28"],
  "categories": [ { "id": "transport", "name": "Transport Validation", "description": "...", "scope": "..." } ],
  "rules": [
    {
      "id": "transport-post",
      "name": "HTTP POST accepted",
      "category": "transport",
      "specVersion": "2026-07-28",
      "severity": "error",
      "defaultRequired": true,
      "capabilityGated": null,
      "specRef": "basic/transports/streamable-http#sending-messages",
      "description": "POSTs a conformant server/discover request...",
      "passCriteria": "HTTP 2xx for a POST carrying a conformant server/discover request...",
      "failCriteria": "Any non-2xx status; 401/403 is annotated as authentication required.",
      "transports": ["http"]
    }
  ]
}
```

Top-level fields: `specVersion` is the **methodology** version (semver, see [section 6](#6-contributing)) -- not an MCP date; `specDate` is the date of that methodology version; `mcpSpecCompatibility` lists the MCP specification revisions the catalog covers (a single string before 2.0.0, an array from 2.0.0 on -- the type change is why 2.0.0 is a major bump); `categories` describes the 8 categories with era-neutral scope text.

Each rule object contains:

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Test identifier (e.g., `transport-post`). Unique **within one `specVersion`**; an id that appears under both revisions covers the same feature, but its description, pass/fail criteria and `defaultRequired` may differ between them, so compare rules only within one `specVersion`. |
| `name` | string | Human-readable test name. |
| `category` | string | One of: `transport`, `lifecycle`, `tools`, `resources`, `prompts`, `errors`, `schema`, `security`. |
| `specVersion` | string | The MCP specification revision the rule applies to: `"2025-11-25"` or `"2026-07-28"`. Filter on this field first; a report's `specVersion` tells you which block its test ids belong to. (Added in 2.0.0.) |
| `severity` | string | `error` (default-required rules) or `warning` (default-optional rules). Determines how the rule contributes to the overall pass/fail status. |
| `defaultRequired` | boolean | Default required status. May be overridden at runtime by capability-driven logic. |
| `capabilityGated` | string \| null | If non-null, the server capability (`"tools"`, `"resources"`, `"prompts"`, `"completions"`, and for 2025-11-25 also `"logging"` / `"resources.subscribe"`) that activates this rule. Gated rules only run when the capability is declared. |
| `specRef` | string | Relative path to the relevant MCP spec section. The base is `https://modelcontextprotocol.io/specification/<specVersion>/` -- the same relative path can resolve to different pages in the two revisions, which is why each rule carries its own `specVersion`. |
| `description` | string | Detailed description of what the test verifies. |
| `passCriteria` | string | Exact conditions under which the test is marked as passed. |
| `failCriteria` | string | Exact conditions under which the test is marked as failed. |
| `transports` | array \| undefined | If present, the only transports (`["http"]` or `["stdio"]`) this rule runs on. **If absent, the rule runs on both transports.** (Earlier text said an absent field meant HTTP-only; the implementation has always run un-tagged rules on stdio as well, except that the 2025-11-25 suite additionally skips the whole `transport` category and a runner-side list of HTTP-specific ids on stdio -- those ids are now tagged `["http"]` in the 2026-07-28 block, where the catalog is the only gate.) |

---

## 5. Adopting This Methodology

This section provides guidance for anyone building a tool that adopts the methodology described here. Subsections marked (2025-11-25) describe the legacy suite; the modern-suite notes follow.

### Revision Selection

An adopting tool must decide which catalog a run grades **before** the first graded request, and must record the decision in the report. The reference tool's `auto` mode is the spec's own dual-era client algorithm (section 1.5): one modern `server/discover`, modern on a `DiscoverResult` or a modern error code, legacy on anything else including silence. Two properties matter for compatibility:

- The fallback is **not** keyed to a single error code. A tool that only recognises `-32601` will misclassify a legacy server that ignores unknown pre-init methods (it never answers) or one that returns `-32000`.
- The probe **is** a conformant modern request (headers plus `_meta`), so a modern server cannot mistake it for a malformed legacy one and answer `-32602` / `-32020`. Those codes are then meaningful: `-32020`/`-32021`/`-32022` are modern-only and select 2026-07-28.

### Test Ordering (2025-11-25)

Test ordering is not arbitrary; the reference tool runs tests in this order:

1. **Transport tests run first**, before the initialization handshake. They validate raw HTTP behavior.
2. **The initialization handshake** (`initialize` + `notifications/initialized`) runs after transport tests. All subsequent tests depend on the session state it establishes.
3. **Lifecycle tests** run immediately after initialization to validate the handshake result.
4. **Capability-gated tests** (tools, resources, prompts) run after lifecycle tests, since they depend on the capabilities object from the init response.
5. **Post-initialization transport tests** (`transport-notification-202`, `transport-session-id`) run after the init handshake, since they require session state.
6. **Error tests** can run at any point after initialization (they do not depend on capability-gated state).
7. **Schema tests** run after their corresponding list operations (they validate cached list data).

### Session State Management (2025-11-25)

The reference tool tracks:

- The `MCP-Session-Id` header value (if issued by the server during initialization) and include it on all subsequent requests.
- The negotiated `protocolVersion` for protocol-version-aware behavior.
- Cached results from list operations (`tools/list`, `resources/list`, `prompts/list`) to avoid redundant requests during schema validation.

### Modern Servers (2026-07-28)

There is no session and no handshake, so the notes above collapse to the following:

- **Every request is self-describing.** Build `params._meta` with `io.modelcontextprotocol/protocolVersion`, `io.modelcontextprotocol/clientCapabilities` and `io.modelcontextprotocol/clientInfo` on every request, and on HTTP mirror the body into `MCP-Protocol-Version`, `Mcp-Method` and (for `tools/call`, `resources/read`, `prompts/get`) `Mcp-Name`. The reference tool builds the envelope runner-side so individual rules can omit or corrupt exactly one part of it; a tool that lets its transport inject the envelope cannot express the `_meta` and header rejection rules.
- **Never send `Mcp-Session-Id`.** `transport-session-ignored` sends one deliberately and expects it to be ignored; the tool itself must not carry session state between requests.
- **`server/discover` is the capability source** and the detection probe at once. Cache its result (versions, capabilities, `_meta` serverInfo, instructions) and derive the capability-gated set from it, exactly as the legacy suite derives it from the `initialize` result. The reference tool reuses the detection probe's `DiscoverResult` so detection costs no extra request.
- **Record everything the server sends.** Eight rules are post-hoc scans (section 1.5). To reproduce them a tool must capture every server message -- JSON bodies, every SSE frame of every stream, every stdout line -- together with the request that produced it, because `lifecycle-log-level-gating` and `schema-no-input-required-on-lists` are judgements about a response *relative to its request*.
- **Warnings are part of the contract.** Several modern rules pass with a warning where the spec's SHOULD is unmet or an intermediary could be responsible (a bare 400 without `-32020`, a `-32020` where `-32602` was expected, a 4xx refusal of a notification). A conforming adopter reports the same verdict and surfaces the warning; downgrading those to failures changes grades.
- **Streams are per request.** `subscriptions/listen` is a long-lived response (SSE on HTTP, tagged frames on stdio); `lifecycle-subscriptions-listen` reads only the first frame and then closes it. Progress and log notifications arrive on the response stream of the request that asked for them, never on a separate GET stream.
- **Dual-era servers are graded once.** A server that also answers `initialize` is still graded against 2026-07-28 under `auto`; the legacy behaviour is a warning plus the informational `lifecycle-dual-era` rule. Grade the legacy side with an explicit `--spec-version 2025-11-25` run. A server that serves `initialize` but rejects the conformant `server/discover` is legacy-only, not dual-era, and should be reported as such.

### Capability-Driven Requirement Changes

The reference tool dynamically adjusts test requirements after the capability source has been read:

- Read the `capabilities` object from the `initialize` response (2025-11-25) or the `server/discover` result (2026-07-28).
- Upgrade tests from optional to required per the mapping in [section 1.2](#12-capability-driven-execution).
- This means the `required` field in `mcp-compliance-rules.json` is a **default** that can be overridden at runtime.

### Result Reporting

Each test result produced by the reference tool contains at minimum:

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Test identifier. |
| `name` | string | Human-readable name. |
| `category` | string | Test category. |
| `passed` | boolean | Whether the test passed. |
| `required` | boolean | Whether the test was required (after capability-driven adjustments). |
| `details` | string | Human-readable explanation of the result. |
| `durationMs` | number | Time taken in milliseconds. |
| `specRef` | string | Full URL to the relevant MCP spec section. |

---

## 6. Contributing

### Versioning

This document follows [Semantic Versioning](https://semver.org/):

- **Patch** (e.g., 1.0.1): Clarifications, typo fixes, and documentation improvements that do not change test behavior.
- **Minor** (e.g., 1.1.0): New test rules, new categories, or new optional fields in the rule catalog. Existing tests are not removed or have their pass/fail logic changed.
- **Major** (e.g., 2.0.0): Breaking changes to existing test rules (changed pass/fail logic), removed rules, scoring algorithm changes, or changes to the rule catalog schema.

### Adding New Rules

All new rules must include:

1. A unique `id` following the `category-name` naming convention.
2. A clear `name` (human-readable, concise).
3. A `category` from the established list, or a new category if justified.
4. A `required` default with rationale.
5. A `specRef` pointing to the relevant MCP specification section.
6. A `description` explaining what the test verifies and why.
7. Explicit **pass criteria** and **fail criteria** with no ambiguity.

### Process

Changes to this methodology are proposed via pull request to the [mcp-compliance repository](https://github.com/YawLabs/mcp-compliance). All changes should update both this document and the `mcp-compliance-rules.json` catalog in the same PR.

---

*This document is licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). You are free to share and adapt this material for any purpose, including commercially, provided you give appropriate credit.*
