# Enterprise tier — draft

Status: **draft for internal review**. Not published. Pricing and limits are placeholders pending market validation.

## Positioning

The free `mcp-compliance` CLI + free mcp.hosting badge/report pages are the funnel. They're genuinely free and always will be — MIT license, no telemetry by default, no feature gates.

The enterprise tier is for organizations with one of three needs the free tier doesn't cover:

1. **Continuous compliance across a fleet of MCP servers** — not one server tested ad-hoc, but 10–100 servers tested on a schedule with aggregated dashboards.
2. **Private/air-gapped compliance testing** — can't upload reports to a public mcp.hosting endpoint because the servers under test are internal, or the compliance evidence itself is sensitive.
3. **Compliance as procurement** — buying team needs to demand a passing grade from a vendor before deployment, and wants the evidence in a form their auditors accept (signed reports, SBOM integration, SOC 2 evidence).

Everything else — a solo dev testing their stdio server, a small team adding a GitHub badge, an open-source project linking to mcp.hosting — is free and stays free.

## Tier structure

### Free (the world)

- Unlimited CLI use, any target, any frequency
- Public badge + report hosted at `mcp.hosting/compliance/ext/<hash>`
- 90-day retention (resubmit resets)
- GitHub Action, Docker image, all output formats
- Apache-style community support via GitHub issues
- Rate limits: 10 submits/IP/hour, 5 deletes/IP/hour, 100 reads/IP/minute

### Pro — $39/mo/user or $399/yr

Target: individual contributors, small teams, indie MCP server authors.

- Everything free, plus:
- **Trend tracking** — last N=90 runs per URL retained, graded over time with regression detection
- **Email/Slack notifications** when a badge's grade drops
- **Private badges** — reports not listed on the public leaderboard, badge URL only shared with you
- **Badge customization** — label text, colors, logo
- **Scheduled testing** — daily/hourly runs of your registered URLs with report retention
- **Higher rate limits** — 100/hour submit, 50/hour delete
- **Priority GitHub issue response** (1-business-day SLA)

### Team — $149/mo for up to 10 seats

Target: product teams running 5–20 MCP servers in aggregate.

- Everything Pro, plus:
- **Organization dashboard** at `mcp.hosting/org/<name>` — aggregated grades across all registered servers
- **SSO (Google Workspace, Microsoft Entra)** for dashboard access
- **Custom domain** for private badges
- **Webhook delivery** on grade changes (configurable per-server)
- **GitHub/GitLab check** — reports posted as PR checks without using the public GitHub Action
- **Compliance evidence export** — signed JSON bundle suitable for SOC 2 / ISO 27001 audit packages

### Enterprise — custom pricing (est. $24k/yr floor)

Target: companies deploying MCP servers to customers or regulated industries.

- Everything Team, plus:
- **Self-hosted** — deploy mcp.hosting's backend on your infrastructure (Kubernetes/Docker Compose bundle); your reports never leave your network
- **Custom retention policies** (7 years for regulated data; 90 days for general)
- **Advanced RBAC** — per-team-per-server access control
- **Custom test suite** — add organization-specific compliance rules on top of the spec (e.g., "all tool responses must include a correlation ID")
- **SBOM/provenance integration** — ties compliance scores to specific container image digests and npm package versions in your SBOM
- **SLA** — 99.9% uptime for hosted, 4-business-hour response for incidents
- **Dedicated support channel** (Slack Connect or shared Teams)
- **Quarterly spec-update briefings** — advance notice when the MCP spec version bumps and what will change in your compliance score

## What we explicitly do NOT gate

- **No charging for the core test suite.** Even enterprise users run the same 88 tests the free tier runs.
- **No rate-limiting the CLI itself.** The binary is MIT; you can run it in a for-loop if you want.
- **No ads on public report pages.** The free tier is the funnel; user experience stays clean.
- **No per-report-submission fees.** Scale of submissions alone doesn't gate — you'd need one of the specific feature needs (private, scheduled, aggregated) to justify paying.

## Revenue model notes

- Pro conversion expected at ~5% of active free users — mostly authors who want the badge + trend tracking.
- Team conversion from Pro at ~15–25% once an organization has 3+ servers.
- Enterprise deal-size driven by self-host + audit evidence needs; typical buyer is a security or platform team at a Series B+ company building LLM apps.
- Don't try to monetize OSS MCP server authors. They're the growth flywheel; keep them subsidized.

## Open questions before shipping

- [ ] Pricing validation: $39 feels cheap for Pro, $149 feels cheap for Team. Worth interviewing 10 prospective users before locking.
- [ ] Self-hosting packaging: Helm chart? Docker Compose? CLI installer with Postgres/Redis? User preference unclear.
- [ ] Compliance evidence format: JSON with detached signature (PGP)? Or an opinionated bundle?
- [ ] Legal review: SOC 2 / ISO claims are commitments. Need to decide if we're actually doing these audits or just interoperating with orgs that have them.
- [ ] Free-tier limits: current 10 submits/hour is conservative. Could tighten to 3/hour for abuse-prone flows and loosen on authenticated tiers. Needs monitoring data first.
