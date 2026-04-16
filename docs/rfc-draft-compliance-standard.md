# RFC-0001: MCP Server Compliance Testing Methodology

_Draft for MCP Working Group at Linux Foundation_
_Author: Jeff Yaw, YawLabs_
_Date: 2026-04-16_
_Status: Draft_
_Proposed disposition: Incubation as LF-hosted project; co-maintained by YawLabs + MCP Working Group-selected co-maintainers_

---

## Abstract

This RFC proposes a standardized methodology for testing Model Context Protocol (MCP) server implementations against the published specification. It defines 88 test rules across 8 categories, a reproducible scoring algorithm, and a letter-grade mapping (A+ through F) that produces comparable grades across any MCP server regardless of transport, capabilities, or implementation language. The methodology is published under Creative Commons Attribution 4.0 International, backed by a reference implementation, and proposed for Linux Foundation incubation as ecosystem-owned infrastructure.

## Status of this document

This is a **draft RFC** prepared by YawLabs (`@yawlabs/mcp-compliance` project maintainers) for submission to the Linux Foundation MCP Working Group. The author proposes that this work, in its current form, be accepted as the initial methodology for LF-governed MCP compliance testing, with governance transferred from YawLabs to an LF-hosted project with a Technical Steering Committee drawn from broader ecosystem participants.

This document may be freely distributed and forked under CC BY 4.0. Feedback is welcomed via GitHub Issues at [github.com/YawLabs/mcp-compliance](https://github.com/YawLabs/mcp-compliance) or email to `jeff@yaw.sh`.

## 1. Introduction

### 1.1 Motivation

The Model Context Protocol joined the Linux Foundation on 2026-04-09, formalizing its role as industry infrastructure for AI agent tooling. The protocol specification is versioned (`2025-11-25` at time of writing) and stable. MCP server implementations are proliferating rapidly across multiple languages, transports, and capability profiles.

The ecosystem lacks a standardized, openly-licensed, community-governed method of testing MCP server compliance with the specification. Consequences:

- End users installing MCP servers (via `npx`, `uvx`, or `pip install`) have no mechanical way to verify spec conformance before trust is extended
- Server authors have no shared bar against which to measure their own implementations
- Client implementations have no stable set of fixtures against which to exercise edge cases
- Security-sensitive portions of the protocol (prompt injection via tool descriptions, lifecycle correctness, transport framing) receive no systematic testing attention

A common methodology with transparent scoring is the mechanism used in adjacent ecosystems to raise implementation quality without mandating specific implementations: SSL Labs for TLS, the HTML5 conformance test suite for browsers, the axe accessibility scanner for web applications. None of these are protocol standards; all are methodologies for testing adherence to protocol standards.

This RFC proposes the same pattern for MCP.

### 1.2 Non-goals

This RFC does not:

- Propose changes to the MCP specification itself (that's the specification working group's domain)
- Define new protocol behavior (tests only observe existing protocol behavior)
- Certify servers in any legally-binding sense (grades are advisory, not certifications)
- Mandate adoption by any implementation (voluntary tool, adopted if useful)

### 1.3 Terminology

- **MCP**: Model Context Protocol, as specified at https://modelcontextprotocol.io/specification/2025-11-25
- **Server**: an MCP server implementation (any language, any transport)
- **Client**: an MCP client implementation (e.g., Claude Desktop, Cursor, Claude Code, VS Code)
- **Rule**: a single testable assertion about server behavior, identified by a stable rule ID
- **Category**: a grouping of related rules (transport, lifecycle, tools, resources, prompts, errors, schema, security)
- **Required**: a rule that tests a MUST-level requirement from the spec
- **Optional**: a rule that tests a SHOULD-level requirement or a MUST-level requirement that is conditional on capability declaration
- **Capability-driven execution**: tests only run for features the server declares support for via `initialize` response
- **Transport-gated execution**: tests only run for transports the server actually uses (stdio vs. HTTP)

## 2. Methodology

### 2.1 Testing framework

The framework runs all applicable tests against a candidate MCP server instance, collects results, applies weighting, and produces a score in [0, 100] that maps to a letter grade. Tests are organized by category and by severity.

Key design decisions:

- **Capability-driven execution** — a server that declares it does not implement resources (by omitting the `resources` capability in its `initialize` response) is not penalized for failing resource tests. Those tests are simply skipped.
- **Transport-gated execution** — a stdio-only server is not tested against HTTP-specific rules (session ID handling, Origin header enforcement, etc.). HTTP-only servers are not tested against stdio-specific rules (JSON-RPC framing, pipe buffer semantics).
- **Deterministic replay** — tests are designed so that running them twice against the same server version produces the same result. Flaky tests are bugs in the framework, not features.
- **Reproducible scoring** — given the same set of passing and failing rules, the score is computed identically regardless of order of execution.

### 2.2 Rule categories and counts

| Category | Rule count | Scope |
|---|---|---|
| Transport | 16 | Framing, headers, session identifiers, origin checks |
| Lifecycle | 21 | `initialize` / `initialized` exchange, capability negotiation, shutdown, reconnect |
| Tools | 4 | `tools/list`, `tools/call`, list-changed notifications |
| Resources | 5 | Resource discovery, URI templates, subscribe/unsubscribe |
| Prompts | 3 | Prompt listing, argument completion, retrieval |
| Errors | 10 | JSON-RPC error codes, malformed request handling |
| Schema | 6 | Input schema validation for tools, resources, prompts |
| Security | 23 | Prompt injection, tool description safety, URI scheme restrictions |
| **Total** | **88** | — |

Security is the largest category deliberately: half the value of a compliance layer is covering the surfaces an attacker would exploit. Tool descriptions and resource content ship directly into LLM context — that is exactly the injection surface with highest impact.

### 2.3 Severity levels

Each rule has one of two severity levels:

- **Required** — failing this rule indicates non-conformance with a spec MUST requirement (unconditional, applicable to all servers of the relevant category)
- **Optional** — failing this rule indicates non-conformance with a spec SHOULD, or with a conditional MUST that depends on capability declaration

Severity is recorded in the machine-readable rule catalog and is not changed lightly — changing a rule's severity requires an RFC amendment (see §5).

### 2.4 Scoring algorithm

Score computation:

```
Score = 100 × (
    (W_req × P_req + W_opt × P_opt) / (W_req × N_req + W_opt × N_opt)
)

where:
    W_req = 4 (weight for required tests)
    W_opt = 1 (weight for optional tests)
    P_req = sum of passing required tests (weighted 1 each before category weighting)
    P_opt = sum of passing optional tests
    N_req = sum of applicable required tests
    N_opt = sum of applicable optional tests
```

Applicability is determined by capability-driven and transport-gated execution. A test that did not run because the server didn't declare its relevant capability is counted as neither passing nor failing — it's excluded from N_req and N_opt.

### 2.5 Grade mapping

| Score range | Grade |
|---|---|
| ≥ 97.0 | A+ |
| ≥ 93.0 | A |
| ≥ 90.0 | A− |
| ≥ 87.0 | B+ |
| ≥ 83.0 | B |
| ≥ 80.0 | B− |
| ≥ 77.0 | C+ |
| ≥ 73.0 | C |
| ≥ 70.0 | C− |
| ≥ 60.0 | D |
| < 60.0 | F |

Additionally, any server failing ANY required test receives at most a grade of **C**, regardless of total score. This prevents a server from achieving a high grade while failing hard-MUST requirements.

### 2.6 Capability-driven execution — detail

When the framework connects to a server, it sends the standard `initialize` request and records the server's capabilities response. Only tests relevant to those capabilities run.

Example: a server declaring only `{ "tools": {} }` capability will run:

- All transport tests (always applicable)
- All lifecycle tests (always applicable)
- All tools tests (capability declared)
- Zero resources tests (not declared)
- Zero prompts tests (not declared)
- All errors tests (always applicable)
- Schema tests relevant to tools only
- Security tests relevant to transport + tools + errors (resources/prompts security tests skipped)

Result: the server is graded on what it claims to implement, not on everything in the spec. A server that correctly implements only tools can legitimately achieve an A+.

### 2.7 Transport-gated execution — detail

Transport-specific tests only run against the transport the server actually uses. Detected via:

- stdio: server launched as subprocess with stdin/stdout JSON-RPC
- Streamable HTTP: URL endpoint supports POST with chunked Transfer-Encoding and SSE response framing

Tests specific to stdio (framing via newlines, process lifecycle coupling) don't run against HTTP servers. Tests specific to HTTP (Origin header enforcement, session ID in `mcp-session-id` header, JSON-RPC batching semantics) don't run against stdio servers.

### 2.8 Machine-readable rule catalog

Every rule is described in a machine-readable JSON document (`mcp-compliance-rules.json`) with:

```json
{
  "id": "transport-01",
  "category": "transport",
  "severity": "required",
  "title": "Valid JSON-RPC framing over stdio",
  "description": "The server MUST emit valid JSON-RPC 2.0 messages framed by newlines over stdout.",
  "spec_reference": "https://modelcontextprotocol.io/specification/2025-11-25#stdio",
  "transport_scope": ["stdio"],
  "capability_requirement": null,
  "weight": 1
}
```

This document is the single source of truth. Changes to rule count, severity, weight, or category require an RFC amendment and a version bump to the catalog.

## 3. Reference implementation

`@yawlabs/mcp-compliance` is the reference implementation. It:

- Implements all 88 rules defined in this RFC
- Reads the machine-readable catalog at runtime (so that independent implementations following this RFC produce identical grades for the same server)
- Is published under Apache 2.0 or MIT (flexible for LF project norms)
- Ships with a test harness, CLI, hosted-service adapter (for the mcp.hosting/compliance hosted tester), and a CI-integration wrapper

The reference implementation is available at https://github.com/YawLabs/mcp-compliance. The methodology is verifiable: anyone can build an independent implementation from this RFC and the rule catalog, and it should produce identical grades.

## 4. Governance proposal

If this RFC is accepted by the LF MCP Working Group:

1. **Project hosting** transfers from YawLabs to LF infrastructure (Linux Foundation-managed GitHub org, mailing list, RFC repository)
2. **Technical Steering Committee** formed with:
   - 1 representative from YawLabs (founding contributor, initial maintainer capacity)
   - 2-3 additional maintainers drawn from broader MCP ecosystem (Anthropic MCP team members, major MCP server authors, major MCP client implementers)
   - Selection process determined by LF MCP Working Group leadership
3. **Methodology amendments** via RFC process — all changes to rule count, severity, weight, or category require:
   - Written RFC proposing the change
   - Minimum 14-day public comment period
   - TSC majority approval
   - Version bump to published catalog
4. **New rule proposals** via the same RFC process
5. **Breaking changes** (those that would change pre-existing grades) receive higher scrutiny — proposed only alongside spec revisions they address
6. **Reference implementation maintenance** continues under TSC direction, with LF infrastructure and governance

## 5. Discussion / commentary

### 5.1 Why 88 rules and not more (or fewer)?

88 is the current count; not load-bearing. The count grows as the spec evolves and as real-world bugs surface new observable behavior worth testing. Adding rules requires RFC process; there is no target count.

The TSC should resist both "add every possible test" (diminishing returns, test-suite maintenance explosion) and "minimize tests" (loses coverage). 88 is approximately the right scale for the 2025-11-25 spec.

### 5.2 Why letter grades instead of pass/fail?

Binary pass/fail misses gradations. A server that fails 2 optional lifecycle tests but passes everything else is substantially different from a server that fails 2 required security tests. Letter grades communicate "how compliant" rather than "compliant or not." Users making adoption decisions benefit from the gradation.

Grade thresholds are published and auditable — users who disagree with the thresholds can recompute against their own preferred mapping using the published scoring algorithm.

### 5.3 Why require signed commits and SLSA provenance on the reference implementation?

Pricing data, compliance data, and security-adjacent infrastructure all share a property: downstream tools trust them without re-verifying. A compromised test suite could quietly mark unsafe servers as safe. Supply-chain hardening of the reference implementation is load-bearing for the methodology's credibility.

See the `SECURITY.md` and `THREAT_MODEL.md` in the reference implementation repository for specifics.

### 5.4 Why CC BY 4.0 licensing?

CC BY 4.0 permits commercial use, adaptation, and redistribution with attribution. It encourages forks, competing test implementations, and adoption by any downstream tool. The goal is ecosystem coordination, not single-source control — CC BY 4.0 operationalizes that goal.

Alternative considered: public domain (CC0). Rejected because attribution in an ecosystem context helps users trace methodology provenance when grade disputes arise.

### 5.5 Relationship to other MCP testing efforts

At time of writing, no other community-governed compliance testing methodology exists for MCP. Individual MCP server maintainers run their own test suites; this is unrelated to ecosystem-wide compliance testing. If another methodology emerges, this RFC does not prohibit its existence — the ecosystem can support multiple complementary methodologies, and users can grade against whichever they prefer.

The machine-readable rule catalog (§2.8) is designed so that alternative methodologies can reuse individual rules (citing rule IDs) even if they disagree with the scoring algorithm or grade thresholds. Rule IDs are stable identifiers intended for cross-methodology reference.

### 5.6 What about server implementations in languages the reference implementation doesn't cover?

The reference implementation is a Node.js tool that exercises MCP servers via their exposed transport (stdio subprocess invocation or HTTP request). It does not inspect the server's source code. This means the methodology is language-agnostic — a Python MCP server, a Rust MCP server, a Go MCP server all receive the same tests and same grades based on observable protocol behavior.

This is deliberate. Testing against observable behavior rather than source code makes the methodology applicable to every server in the ecosystem regardless of implementation choice.

### 5.7 How often should the methodology be updated?

Quarterly cadence is recommended but not mandatory. Triggers for updates:

- Spec revisions (e.g., when the MCP spec is revised to 2026-XX-XX, tests may need adjustment)
- New observable bug classes discovered in the wild
- TSC decisions on severity re-classification
- Community RFCs accepted via the RFC process

Between scheduled updates, security-critical rule additions or corrections may be applied via emergency RFC.

## 6. Backwards compatibility

This is the initial RFC. No backwards compatibility concerns.

For future RFC amendments that change grades:

- **Rule additions** that tighten compliance (adding new tests) may cause previously-A-graded servers to receive lower grades on the new version. This is expected behavior. Version number of the methodology catalog is published with every grade, so historical grades remain interpretable.
- **Rule removals** or severity downgrades may cause previously-F-graded servers to pass on the new version. Same principle — the grade is contextualized by methodology version.

## 7. Security considerations

The methodology tests security-relevant behavior of MCP servers. It does not execute untrusted server code in a privileged context — tests operate at the protocol level. However:

- Running a compliance test against a server does cause the server to execute tool calls (with fixture arguments designed to exercise validation, not to trigger real actions)
- Operators of hosted testing infrastructure (like mcp.hosting/compliance) must take care to isolate test runs from production systems
- Testing a malicious MCP server in a privileged context is dangerous — the methodology framework does not and cannot substitute for standard process isolation and least-privilege configuration

## 8. Open questions

Items the TSC should decide during incubation:

1. Methodology version cadence — quarterly, or on spec revision, or ad-hoc?
2. Governance model for rule disputes (server authors claiming false-positive failures)
3. Process for handling confidential security-relevant rule additions (full disclosure? embargo period?)
4. Relationship to MCP specification working group — informal vs. formal liaison
5. Certification authority question — should passing an A grade imply any legal or contractual representation? (recommended: no; methodology is advisory)

## 9. Acknowledgments

This RFC draws on:

- The MCP specification and working group, particularly the 2025-11-25 revision
- SSL Labs grading methodology (conceptual precedent for letter-grade conformance testing)
- W3C accessibility conformance evaluation methodology (ACT Rules)
- OpenTelemetry semantic conventions (precedent for ecosystem-owned testing infrastructure)
- OpenTelemetry GenAI conventions working group

Early implementers of MCP servers across the ecosystem provided the real-world bug surface that informed 88-rule coverage. We are grateful for their public work.

## 10. References

- MCP Specification (2025-11-25): https://modelcontextprotocol.io/specification/2025-11-25
- `@yawlabs/mcp-compliance` reference implementation: https://github.com/YawLabs/mcp-compliance
- Machine-readable rule catalog: https://github.com/YawLabs/mcp-compliance/blob/main/mcp-compliance-rules.json
- Full methodology document: https://github.com/YawLabs/mcp-compliance/blob/main/COMPLIANCE_RUBRIC.md

---

## Contact

For feedback on this RFC:

- GitHub Issues: https://github.com/YawLabs/mcp-compliance/issues
- Email: `jeff@yaw.sh`
- LF MCP Working Group mailing list: TBD after LF engagement begins

Feedback welcome prior to formal RFC submission — particularly from:
- Members of the LF MCP Working Group
- Maintainers of popular MCP servers + clients
- Operators of hosted MCP infrastructure
- Security researchers working on AI agent security
