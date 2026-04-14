# Anthropic MCP team — outreach draft

**Status:** Draft. Send only after Phase 2 launch (the leaderboard and report pages must be live and populated; otherwise this looks like vapor).

**To:** the MCP team at Anthropic. Best contact path is the `mcp@anthropic.com` alias if it exists, otherwise via a known contributor on `modelcontextprotocol/modelcontextprotocol` GitHub. As a fallback, opening a courteous discussion on `modelcontextprotocol/modelcontextprotocol` Discussions also works and has the side benefit of being public ecosystem signal.

**From:** Jeff Yaw, Yaw Labs.

**Subject options (pick one):**
- `Heads up: launching a third-party MCP conformance grader (mcp.hosting/compliance)`
- `Third-party conformance grader for MCP — quick flag before launch`
- `mcp.hosting/compliance — third-party tester for the 2025-11-25 spec`

---

## Body

> Hi MCP team,
>
> Quick heads up rather than an ask: Yaw Labs is launching a third-party conformance grader for the MCP 2025-11-25 spec at **mcp.hosting/compliance**. It runs an 85-test suite covering transport, lifecycle, tools, resources, prompts, error handling, schema, and security; produces a graded report (A through F); and emits an embeddable badge.
>
> The engine is open source as `@yawlabs/mcp-compliance` (MIT). We've also published our test methodology as a separate document at [link to COMPLIANCE_RUBRIC.md] so the grading is auditable rather than a black box — it's explicitly framed as our tool's choices, not an authoritative conformance standard.
>
> A few things worth flagging:
>
> 1. **Positioning.** This is unambiguously third-party — every page footers "Not affiliated with Anthropic. Model Context Protocol is developed by Anthropic." We're not claiming authority over the spec; we're a SSL Labs / html5test–style grader. If there's a trademark policy for "MCP" / "Model Context Protocol" we should be following, please point us at it and we'll align.
>
> 2. **Why a flag now.** If you're planning an official conformance suite, we'd rather know before our launch post drops than be surprised after. We're happy to coordinate, hand off naming, narrow scope, or just stay out of your way — whichever is most helpful. The third-party tester pattern (SSL Labs, html5test, Lighthouse) has historically been useful to spec maintainers because external graders create peer pressure to conform; that's the energy we're aiming for, not competing with anything you build.
>
> 3. **What we're seeding with.** Day-one leaderboard includes the servers in `modelcontextprotocol/servers` plus ~20 prominent community servers. We've reached out individually to authors of the most-graded servers with their reports first; nobody is being publicly listed without a heads-up.
>
> 4. **Open source the test corpus.** The 88 test definitions, their spec references, and the JSON Schema for the report shape all live in the public repo. If anything is misaligned with the spec's intent, please file an issue or PR — we'd rather correct than be wrong.
>
> Happy to demo, walk through the test corpus, or sit on this if there's a reason. Ping back at jeff@yaw.sh or here.
>
> — Jeff
> Yaw Labs
> https://yaw.sh

---

## Notes for sending

- **Tone.** Friendly, not deferential. Third-party graders are a normal ecosystem feature; we're flagging out of courtesy, not asking permission.
- **What to include as attachments / links.**
  - Direct link to a sample report (A-grade and a D-grade both, so they can see the format).
  - Link to the GitHub repo.
  - Link to COMPLIANCE_RUBRIC.md (the testing methodology doc).
  - Link to mcp.hosting/compliance/leaderboard once it has ≥20 entries.
- **What NOT to do.**
  - Don't ask for endorsement.
  - Don't ask them to link to us.
  - Don't promise we won't change scoring; we will, and that's fine.
  - Don't bundle this with any other ask (mcp.hosting routing, future products, partnerships). One topic, one email.
- **If they say "please don't use the MCP name in your domain":** the .com isn't ours anyway (squatter at dnc.com), and we already own mcpcompliance.io/.net/.sh as 301s to mcp.hosting/compliance. Reasonable response is to drop the redirect and lean on mcp.hosting branding. The grader still works; the SEO play just gets weaker.
- **If they say "we're shipping our own conformance suite":** the right response is "great, here's our test corpus as a contribution if useful" — do not posture as competition. Differentiation pivots to leaderboard + UX + badges (the SSL Labs moat, not the spec moat).
- **If silence:** assume tacit OK and proceed with launch. Don't re-ping for at least two weeks.

## Send timing

- After the report page renders cleanly (Phase 2b done).
- After the badge API is live (Phase 2a done).
- After the leaderboard has ≥20 seeded entries (Phase 3 seeding done).
- **Before** the public launch post on HN / Twitter / etc. — give Anthropic a 48-hour head start.
