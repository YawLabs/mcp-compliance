# MCP Compliance Testing Specification

**Version:** 1.0.0-draft
**Date:** 2026-04-07
**MCP Spec Compatibility:** [2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25)
**License:** [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
**Maintained by:** [Yaw Labs / mcp-compliance](https://github.com/YawLabs/mcp-compliance)
**Reference implementation:** `@yawlabs/mcp-compliance` v0.3.0+

---

## What Is This?

This document defines a **testing methodology** for verifying MCP (Model Context Protocol) server compliance. It does not redefine the protocol itself. The [MCP specification](https://modelcontextprotocol.io/specification/2025-11-25) defines what servers MUST do; this specification defines **how to verify** that they do it.

This specification is tool-agnostic. Any compliance testing tool can implement these rules. The reference implementation is [`@yawlabs/mcp-compliance`](https://github.com/YawLabs/mcp-compliance), but conformance to this specification is not limited to any single tool.

**Scope:**

- **81 compliance test rules** across 8 categories, each with a defined severity (required or optional)
- **Scoring algorithm** that weights required vs. optional tests and produces a numerical score
- **Grading methodology** that maps scores to letter grades (A through F)
- **Capability-driven test execution model** that dynamically adjusts test requirements based on server-declared capabilities
- **Machine-readable rule catalog** (`mcp-compliance-rules.json`) for tooling integration

**Companion specification:** [MCP Protocol Specification (2025-11-25)](https://modelcontextprotocol.io/specification/2025-11-25)

---

## Table of Contents

- [1. Testing Methodology](#1-testing-methodology)
  - [1.1 Test Execution Model](#11-test-execution-model)
  - [1.2 Capability-Driven Execution](#12-capability-driven-execution)
  - [1.3 Retry Behavior](#13-retry-behavior)
  - [1.4 Test Filtering](#14-test-filtering)
- [2. Scoring Algorithm](#2-scoring-algorithm)
  - [2.1 Weight Distribution](#21-weight-distribution)
  - [2.2 Grade Thresholds](#22-grade-thresholds)
  - [2.3 Overall Status](#23-overall-status)
- [3. Test Rules](#3-test-rules)
  - [3.1 transport -- HTTP Transport Validation (10 tests)](#31-transport----http-transport-validation-7-tests)
  - [3.2 lifecycle -- Protocol Lifecycle (12 tests)](#32-lifecycle----protocol-lifecycle-10-tests)
  - [3.3 tools -- Tool Operations (4 tests)](#33-tools----tool-operations-4-tests)
  - [3.4 resources -- Resource Operations (5 tests)](#34-resources----resource-operations-5-tests)
  - [3.5 prompts -- Prompt Operations (3 tests)](#35-prompts----prompt-operations-3-tests)
  - [3.6 errors -- Error Handling (8 tests)](#36-errors----error-handling-8-tests)
  - [3.7 schema -- Schema Validation (6 tests)](#37-schema----schema-validation-6-tests)
  - [3.8 security -- Security Validation (21 tests)](#38-security----security-validation-21-tests)
- [4. Rule Catalog (Machine-Readable)](#4-rule-catalog-machine-readable)
- [5. Implementing This Specification](#5-implementing-this-specification)
- [6. Contributing](#6-contributing)

---

## 1. Testing Methodology

### 1.1 Test Execution Model

Tests execute sequentially in a defined order. The ordering is significant because later tests depend on state established by earlier tests.

**Execution phases:**

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

Test requirements are not fully static. Some tests become **required** based on the capabilities the server declares in its `initialize` response. The mapping is:

| Server capability | Tests that become required |
|---|---|
| `tools` | `tools-list`, `tools-schema` |
| `resources` | `resources-list`, `resources-schema` |
| `prompts` | `prompts-list`, `prompts-schema` |
| `logging` | `lifecycle-logging` |
| `completions` | `lifecycle-completions` |
| `resources.subscribe` | `resources-subscribe` |

**Rules for capability-driven tests:**

- If a server declares a capability, the corresponding tests become **required** and are expected to pass.
- If a server does not declare a capability, the corresponding tests either **auto-pass** (for tests that check for the capability before executing) or are **skipped** (for tests gated behind capability checks).
- Tests for undeclared capabilities that still run are treated as **optional**.

### 1.3 Retry Behavior

Implementations SHOULD support configurable retry behavior:

- **Retry count** is configurable (default: 0, meaning no retries).
- **Backoff** is linear: 1 second after the first failure, 2 seconds after the second, 3 seconds after the third, and so on.
- On retry, only the **test function** re-executes. Session state and prior test results are preserved.
- If **any attempt passes**, the test is marked as passed.
- The reported `durationMs` covers the entire span from first attempt to final result.

### 1.4 Test Filtering

Implementations SHOULD support filtering tests by category name or individual test ID:

- **Include list** (`only`): If provided, only tests whose category or ID appears in the list will run.
- **Exclude list** (`skip`): If provided, tests whose category or ID appears in the list will be skipped.
- Filtering **does not change test requirements**. A required test that is filtered out simply does not appear in results -- it does not count as failed.

---

## 2. Scoring Algorithm

### 2.1 Weight Distribution

Tests are divided into two pools: **required** (70% of total score) and **optional** (30% of total score).

```
Score = (requiredPassed / totalRequired) * 70
      + (optionalPassed / totalOptional) * 30
```

**Edge cases:**
- If there are **no required tests** in the result set (e.g., all were filtered out), the required component receives **full credit** (70 points).
- If there are **no optional tests** in the result set, the optional component receives **full credit** (30 points).
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

## 3. Test Rules

Each test rule is documented with the following fields:

- **Category**: The test category (`transport`, `lifecycle`, `tools`, `resources`, `prompts`, `errors`, `schema`).
- **Default required**: Whether the test is required by default. Some tests become required dynamically based on server capabilities (see [section 1.2](#12-capability-driven-execution)).
- **Spec reference**: The section of the MCP specification that this test validates. All references are relative to `https://modelcontextprotocol.io/specification/2025-11-25/`.
- **Description**: What the test verifies and why.
- **Pass criteria**: The exact conditions under which the test is marked as passed.
- **Fail criteria**: The conditions under which the test is marked as failed.

---

### 3.1 transport -- HTTP Transport Validation (10 tests)

Transport tests run **before** the MCP initialization handshake. They validate that the server's HTTP endpoint behaves correctly at the transport layer. These tests send raw HTTP requests with minimal JSON-RPC payloads.

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

### 3.2 lifecycle -- Protocol Lifecycle (12 tests)

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
- **Default required:** Yes (when `resources` capability is declared)
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
- **Default required:** Yes (when `prompts` capability is declared)
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

### 3.6 errors -- Error Handling (8 tests)

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

### 3.8 security -- Security Validation (21 tests)

Security tests verify authentication enforcement, input validation, tool integrity, information disclosure, and rate limiting. These tests run after all functional tests and require an established MCP session.

**Sub-categories:**

- **Auth & Transport** (8 tests) -- Verifies authentication is required and properly enforced, TLS is required, session IDs are high-entropy, OAuth metadata exists, and CORS is restrictive.
- **Input Validation** (6 tests) -- Tests tools for command injection, SQL injection, path traversal, SSRF, oversized input handling, and extra parameter handling. Input validation tests are capability-gated on `tools`.
- **Tool Integrity** (4 tests) -- Checks that all tools define schemas, tool definitions are stable across calls (rug-pull detection), descriptions are free of prompt injection patterns, and tools don't cross-reference each other.
- **Information Disclosure** (3 tests) -- Verifies error responses don't leak stack traces, internal IP addresses, or sensitive data. Also tests rate limiting enforcement.

All security tests are **optional** by default (severity: warning). They do not affect the overall pass/fail determination for protocol compliance but significantly impact the security posture score.

#### `security-auth-required` -- Rejects unauthenticated requests

- **Default required:** No
- **Spec reference:** [basic/authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- **Description:** Sends a request without an Authorization header and verifies the server returns HTTP 401 or 403.
- **Pass criteria:** HTTP 401 or 403 for unauthenticated request.
- **Fail criteria:** Server accepts unauthenticated request, or no auth is configured (no `--auth` provided).
- **Prerequisites:** Requires `--auth` to be passed so the test can strip it and verify rejection.

#### `security-auth-malformed` -- Rejects malformed auth credentials

- **Default required:** No
- **Spec reference:** [basic/authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- **Description:** Sends a request with a garbage Authorization header value and verifies the server rejects it.
- **Pass criteria:** HTTP 401 or 403 for malformed auth token.
- **Fail criteria:** Server accepts malformed auth token.

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

#### `security-command-injection` -- Resists command injection in tool params

- **Default required:** No
- **Capability-gated:** tools
- **Spec reference:** [server/tools#calling-tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#calling-tools)
- **Description:** Sends OS command injection payloads (`;`, `$()`, `` ` ` ``, `|`, `&&`) in tool string parameters. Checks output for evidence of command execution.
- **Pass criteria:** Tool output does not contain command execution indicators (uid, file listings, etc.).
- **Fail criteria:** Tool output matches command execution patterns.

#### `security-sql-injection` -- Resists SQL injection in tool params

- **Default required:** No
- **Capability-gated:** tools
- **Spec reference:** [server/tools#calling-tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#calling-tools)
- **Description:** Sends SQL injection payloads (`' OR 1=1 --`, `'; DROP TABLE`, `UNION SELECT`) in tool string parameters. Checks output for database errors.
- **Pass criteria:** Tool output does not contain SQL error messages or database metadata.
- **Fail criteria:** Tool output contains SQL syntax errors, table names, or database metadata.

#### `security-path-traversal` -- Resists path traversal in tool params

- **Default required:** No
- **Capability-gated:** tools
- **Spec reference:** [server/tools#calling-tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#calling-tools)
- **Description:** Sends path traversal payloads (`../../etc/passwd`, `..\\..\\windows\\system.ini`) in tool string parameters.
- **Pass criteria:** Tool output does not contain sensitive file contents (e.g., `/etc/passwd`, `[boot loader]`).
- **Fail criteria:** Tool output matches sensitive file content patterns.

#### `security-ssrf-internal` -- Resists SSRF to internal networks

- **Default required:** No
- **Capability-gated:** tools
- **Spec reference:** [server/tools#calling-tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#calling-tools)
- **Description:** For tools with URL-like parameters, submits internal IP addresses (169.254.169.254, 127.0.0.1) and cloud metadata endpoints.
- **Pass criteria:** Tool output does not contain cloud metadata (ami-id, instance-id, security-credentials).
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

## 4. Rule Catalog (Machine-Readable)

The file `mcp-compliance-rules.json` provides a machine-readable catalog of all 81 test rules. It is the canonical source for rule metadata and is intended for tooling integration (IDEs, CI pipelines, dashboards).

**Schema:**

```json
{
  "specVersion": "1.0.0-draft",
  "mcpVersion": "2025-11-25",
  "rules": [
    {
      "id": "transport-post",
      "name": "HTTP POST accepted",
      "category": "transport",
      "required": true,
      "specRef": "basic/transports#streamable-http",
      "description": "Verifies the server accepts HTTP POST requests..."
    }
  ]
}
```

Each rule object contains:

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique test identifier (e.g., `transport-post`). |
| `name` | string | Human-readable test name. |
| `category` | string | One of: `transport`, `lifecycle`, `tools`, `resources`, `prompts`, `errors`, `schema`. |
| `required` | boolean | Default required status. May be overridden at runtime by capability-driven logic. |
| `specRef` | string | Relative path to the relevant MCP spec section (base: `https://modelcontextprotocol.io/specification/2025-11-25/`). |
| `description` | string | Detailed description of what the test verifies. |

---

## 5. Implementing This Specification

This section provides guidance for anyone building a tool that implements the MCP Compliance Testing Specification.

### Test Ordering

Test ordering is not arbitrary. Implementations MUST respect the following constraints:

1. **Transport tests run first**, before the initialization handshake. They validate raw HTTP behavior.
2. **The initialization handshake** (`initialize` + `notifications/initialized`) runs after transport tests. All subsequent tests depend on the session state it establishes.
3. **Lifecycle tests** run immediately after initialization to validate the handshake result.
4. **Capability-gated tests** (tools, resources, prompts) run after lifecycle tests, since they depend on the capabilities object from the init response.
5. **Post-initialization transport tests** (`transport-notification-202`, `transport-session-id`) run after the init handshake, since they require session state.
6. **Error tests** can run at any point after initialization (they do not depend on capability-gated state).
7. **Schema tests** run after their corresponding list operations (they validate cached list data).

### Session State Management

Implementations MUST track:

- The `MCP-Session-Id` header value (if issued by the server during initialization) and include it on all subsequent requests.
- The negotiated `protocolVersion` for protocol-version-aware behavior.
- Cached results from list operations (`tools/list`, `resources/list`, `prompts/list`) to avoid redundant requests during schema validation.

### Capability-Driven Requirement Changes

Implementations MUST dynamically adjust test requirements after initialization:

- Read the `capabilities` object from the `initialize` response.
- Upgrade tests from optional to required per the mapping in [section 1.2](#12-capability-driven-execution).
- This means the `required` field in `mcp-compliance-rules.json` is a **default** that can be overridden at runtime.

### Result Reporting

Implementations SHOULD produce a result for each test containing at minimum:

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

This specification follows [Semantic Versioning](https://semver.org/):

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

Changes to this specification are proposed via pull request to the [mcp-compliance repository](https://github.com/YawLabs/mcp-compliance). All changes should update both this document and the `mcp-compliance-rules.json` catalog in the same PR.

---

*This specification is licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). You are free to share and adapt this material for any purpose, including commercially, provided you give appropriate credit.*
