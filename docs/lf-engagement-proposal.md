# Proposal: Contributing `@yawlabs/mcp-compliance` to the LF MCP Governance

_Draft for internal review by Jeff before submission. Target delivery: Linux Foundation MCP working group, late April / early May 2026._

---

## One-paragraph summary

The Model Context Protocol joined the Linux Foundation on 2026-04-09, moving governance from Anthropic-primary to a vendor-neutral consortium model. One thing the LF-governed MCP ecosystem does not yet have is a shared, auditable methodology for testing server spec compliance. YawLabs developed `@yawlabs/mcp-compliance` — 88 tests across 8 categories, letter-grade A-F, machine-readable rule catalog, CC BY 4.0 — specifically to fill that gap. We propose contributing the methodology, the tooling, and the rule catalog to the Linux Foundation as an LF-governed project, co-maintained with the broader MCP community. We retain no commercial claim to the compliance work itself. Our aim is to ensure every MCP server in the ecosystem can be graded against a common, transparent, forkable standard.

---

## Background

### The MCP ecosystem's trust problem

MCP servers ship tool descriptions and resource content directly into LLM context. The prompt-injection surface area is real. The lifecycle correctness surface is real. The transport correctness surface is real. Yet there is no standard way to test any given MCP server against the 2025-11-25 specification and produce a comparable grade. Users installing an MCP server from npm have no mechanical way to know whether it correctly implements the spec.

The practical consequence: the ecosystem has been operating on trust-by-vibes. Every tool vendor hand-rolls its own compliance story. Users adopt servers based on popularity rather than verifiable correctness.

### What `@yawlabs/mcp-compliance` provides

Over the past three months at YawLabs, we built and shipped:

- **88 tests across 8 categories** (transport, lifecycle, tools, resources, prompts, errors, schema, security)
- **Capability-driven execution** — tests gate on what the server declares it supports
- **Transport-gated execution** — stdio tests only run against stdio servers, Streamable HTTP tests only run against HTTP servers
- **Scoring algorithm** — weighted by required vs. optional, reproducible grade computation
- **Letter-grade mapping** (A+ through F) with published thresholds
- **Machine-readable rule catalog** — `mcp-compliance-rules.json` consumable by any other tool
- **CC BY 4.0 methodology** — entire specification published under an open license
- **Reference implementation** — open-source npm package, runs locally or hosted, 30-second test duration

The tool is already functional. Every hosted MCP server on mcp.hosting is graded automatically. The methodology doc is [`COMPLIANCE_RUBRIC.md`](../COMPLIANCE_RUBRIC.md).

### What's missing — community ownership

What we cannot provide as a single-vendor project:

- **Neutral governance.** A YawLabs-maintained methodology is, at minimum, optically a vendor artifact. Even with CC BY 4.0 licensing and open contribution, the perception is "one company decides what's compliant."
- **Ecosystem-wide buy-in.** Maintainers of major MCP servers and clients will adopt compliance badges only if the methodology has industry-backed governance, not single-vendor endorsement.
- **Long-term neutrality commitment.** If YawLabs pivots products, is acquired, or changes priorities, a YawLabs-hosted methodology could drift or be deprecated. LF-hosted projects have governance guarantees that outlast any single contributor company.

For MCP to be a durable industry-standard protocol with ecosystem-wide trust mechanisms, compliance methodology needs ecosystem ownership.

---

## What we're proposing to contribute

### Assets

1. **Methodology specification** — the full rubric document (`COMPLIANCE_RUBRIC.md`), CC BY 4.0
2. **Machine-readable rule catalog** — `mcp-compliance-rules.json` (88 rules, structured, versioned)
3. **Reference implementation tooling** — `@yawlabs/mcp-compliance` npm package, currently Apache 2.0 or MIT (flexible — will relicense to match LF project norms)
4. **Test data + fixtures** — conformance test fixtures used to validate the test harness itself
5. **Historical test results** — grades from 50+ public MCP servers tested to date, anonymized and aggregated for ecosystem analysis
6. **Domain assets** — compliance.mcp-protocol.io or similar, if LF wants a canonical hosted tester

### Governance proposal

We propose contributing as an **LF-incubated project** within the broader MCP governance, with:

- **Initial maintainers:** YawLabs (as founding contributor) + 2-3 additional maintainers drawn from existing MCP ecosystem participants (Anthropic MCP team members, popular MCP server authors, MCP client implementers — specific names to be proposed by the LF working group)
- **Technical Steering Committee model** — shared governance, no single-company control
- **Transparent decision process** — all methodology changes require RFC + public review period
- **Neutral domain / repository** — transferred from YawLabs to LF-managed infrastructure

### What YawLabs keeps

- **Nothing** in the compliance methodology or tooling. Full contribution.
- **Commercial products built on top** — mcp.hosting's dashboard UI for running compliance, vend.sh's integration with compliance-gated checkout, etc. These are separate from the methodology itself and remain YawLabs commercial products.
- **Rights of a normal contributor** — we participate like any other company, bring PRs, subject to TSC decision-making

### What changes for YawLabs' commercial work

Effectively nothing. We continue to:
- Run compliance tests on hosted MCP servers
- Display grades in mcp.hosting's catalog
- Use the LF-hosted methodology as our source of truth (same as every other ecosystem tool)

What changes is that the methodology is owned by the community, not us.

---

## Why this is the right time

Three timing factors converge:

1. **MCP just donated to LF** (2026-04-09). The governance-transition window is a natural time to introduce complementary open-governed ecosystem projects. Later in LF-MCP's lifecycle, introducing new projects requires more formal process.

2. **Ecosystem is young enough that a canonical standard can still be set.** 6 months from now, several competing compliance testing approaches will exist in the wild. Today, `@yawlabs/mcp-compliance` has no real competitor. Establishing it as the LF-hosted standard now coordinates the ecosystem around one methodology before fragmentation.

3. **YawLabs is ready to contribute.** The methodology is mature (88 tests, 3 months of real-world refinement across 50+ servers). The tooling is production-quality. We're not contributing vaporware; we're contributing something that works today.

---

## What we ask from the working group

1. **An initial conversation** — 30-60 minute call with LF-MCP working group leadership to discuss whether this contribution fits the governance roadmap
2. **Feedback on scope and terms** — which parts of our contribution are valuable, which parts need restructuring, what governance shape the working group prefers
3. **A path to incubation** — if the working group agrees the contribution fits, what's the formal proposal/incubation process look like
4. **Co-maintainer recruitment** — help us identify 2-3 additional initial maintainers from the MCP ecosystem

We expect the initial conversation + alignment takes 4-8 weeks. Assuming green light, the actual contribution + governance transition is another 4-8 weeks.

---

## What we do if the working group declines

Gracefully accept. Continue maintaining `@yawlabs/mcp-compliance` as a YawLabs OSS project under CC BY 4.0. The methodology remains open. Any other ecosystem participant can fork and propose their own LF-governed version at any time. The attempt itself is worthwhile signaling even if unsuccessful.

---

## Precedents

This pattern — company contributes key project to Linux Foundation governance — has worked well:

- **OpenTelemetry**: initially driven by HoneyComb, Lightstep, and others; became LF/CNCF project. Now industry-standard.
- **CNCF projects generally** — Kubernetes donated by Google, Envoy by Lyft, Jaeger by Uber, Vitess by YouTube, many others
- **Open Container Initiative** — Docker contributed key artifacts to LF governance to establish industry standards

The expected outcome in each case: the contributing company loses single-vendor control but gains ecosystem adoption and long-term trust, while the industry gains a stable standard.

We believe MCP compliance testing is in the same category. Worth contributing.

---

## Contact

- Primary: Jeff Yaw, YawLabs founder — `jeff@yaw.sh`
- Project: `@yawlabs/mcp-compliance` — [github.com/YawLabs/mcp-compliance](https://github.com/YawLabs/mcp-compliance)
- Methodology doc: [`COMPLIANCE_RUBRIC.md`](https://github.com/YawLabs/mcp-compliance/blob/main/COMPLIANCE_RUBRIC.md)
- Machine-readable catalog: [`mcp-compliance-rules.json`](https://github.com/YawLabs/mcp-compliance/blob/main/mcp-compliance-rules.json)

---

## Template email for outreach

Subject: **Proposal: Contributing mcp-compliance methodology to LF-MCP governance**

Hi [LF-MCP working group chair / Anthropic MCP team contact / etc.],

Congrats on the LF donation — timely and important move for the ecosystem.

At YawLabs we've been developing `@yawlabs/mcp-compliance` — an 88-test, A-F letter-graded compliance methodology for MCP servers against the 2025-11-25 spec. It's running in production, CC BY 4.0, machine-readable catalog included. We'd like to propose contributing it to Linux Foundation governance as an LF-hosted project.

Detailed proposal attached. Would love a 30-60 minute call to discuss fit, governance shape, and whether this is the kind of contribution the working group wants to incubate.

Happy to adjust any terms. Our goal is ecosystem-owned compliance methodology, not YawLabs-branded compliance methodology.

When's a good time?

Jeff Yaw
Founder, YawLabs
jeff@yaw.sh

---

## Internal notes for Jeff (delete before submission)

- The phrasing "we retain no commercial claim to the compliance work itself" is important. Working group members will ask about this.
- If asked about YawLabs' motivation: honest answer is "MCP compliance needs to be ecosystem-owned, not YawLabs-owned, for long-term durability. We benefit when MCP is a healthy protocol; single-vendor methodology hurts MCP health."
- Expect pushback on "why should LF adopt YawLabs' methodology specifically vs. design their own?" Answer: speed (ours is ready now, industry can move) + optionality (LF can deprecate/replace if it doesn't work out; low lock-in)
- Don't oversell. Working group will be skeptical of founder-led proposals that try too hard.
- The contribution includes deprecating your own commercial incentive around compliance as a product feature. Be ready for "what's the catch" questions. Answer honestly: "mcp.hosting benefits when MCP is credible; making compliance credible is worth more than owning compliance."
