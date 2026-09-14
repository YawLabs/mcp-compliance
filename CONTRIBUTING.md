# Contributing

Thanks for your interest in contributing! This guide covers the workflow for both human contributors and AI coding agents.

## Quick Start

```bash
# 1. Fork this repo on GitHub, then clone your fork
git clone https://github.com/<your-username>/<repo-name>.git
cd <repo-name>

# 2. Install dependencies
npm install

# 3. Create a branch
git checkout -b your-branch-name

# 4. Make your changes, then verify everything passes
npm run lint:fix
npm run build
npm test
```

## Submitting a Pull Request

1. **One PR per change.** Keep PRs focused — a bug fix, a new feature, or a refactor, not all three.
2. **Branch from `main`** (or `master` if that's the default branch).
3. **Run `npm run lint:fix`** before committing — this repo has no hosted CI, so the local lint/typecheck/test gate in `release.sh` is the only one and reviewers will ask for a clean run.
4. **Run `npm test`** and confirm all tests pass.
5. **Write a clear PR title and description** — explain *what* changed and *why*.
6. **All PRs require approval** from a maintainer before merging.

## Development Workflow

| Command | What it does |
|---------|-------------|
| `npm install` | Install dependencies |
| `npm run build` | Compile TypeScript |
| `npm run dev` | Run in development mode |
| `npm test` | Run the test suite |
| `npm run lint` | Check for lint errors |
| `npm run lint:fix` | Auto-fix lint and formatting |

## Code Style

- TypeScript, strict mode
- Formatting and linting are enforced by the project's linter — run `lint:fix` and let the tooling handle it
- No unnecessary abstractions — keep code simple and direct
- Add tests for new functionality

## Report schema discipline

The JSON output of `runComplianceSuite()` is a **stable, versioned contract** consumed by downstream renderers (Yaw MCP, third-party dashboards). Every report carries a top-level `schemaVersion` field, defined by `REPORT_SCHEMA_VERSION` in `src/types.ts`, and is described by `schemas/report.v1.json`.

The schema is **strict**: every object in `report.v1.json` (the report, `summary`, `serverInfo`, `badge`, each `TestResult`) is `additionalProperties: false`, and `category` is a closed enum. So there is no "additive, non-breaking" change to the report shape — a consumer validating against the shipped schema rejects a report that carries a field the schema does not list. When changing the `ComplianceReport` type:

- **Adding a field, adding a category, renaming, removing, or changing the type of an existing field** (all breaking under a strict schema): bump `REPORT_SCHEMA_VERSION` to `"2"`, create `schemas/report.v2.json`, and keep `schemas/report.v1.json` for downstream consumers still on v1. Emit v1 or v2 for every run — never pick the schema version per run based on something the server controls (such as the detected spec revision).
- **Changing the *value* of an existing free-form field** (a new `specVersion` string, a new warning text) is fine within v1. That is how 2026-07-28 support shipped without a schema bump: `specVersion` is a free string and both catalogs use the same 8 categories.
- **Anything that affects determinism** (new non-deterministic field, new warning that includes a timestamp/duration/random ID): the integration test `produces deterministic output` will catch this. Don't bypass it — fix the root cause.

The test suite enforces this:

- `src/tests/schema.test.ts` validates a hand-crafted sample against the schema.
- `src/tests/integration.test.ts` validates a real CLI run against the schema.
- Drift between `ComplianceReport` and `report.v1.json` fails the suite.

## Test catalog discipline

Each spec revision has one catalog (`TEST_DEFINITIONS` in `src/types.ts` for 2025-11-25, `MODERN_TEST_DEFINITIONS` in `src/definitions/2026-07-28.ts` for 2026-07-28) and three hand-maintained mirrors: the README's "What the N tests check (<revision>)" section, `COMPLIANCE_RUBRIC.md` (section 3 / 3b), and `mcp-compliance-rules.json` (rules tagged by `specVersion`). When you add, rename, re-categorise, or flip the `required` default of a test, update all three in the same PR — `src/tests/types.test.ts` and `src/tests/catalog-parity.test.ts` are red until you do. Reuse an id across revisions only when the check is semantically identical; a check whose pass criteria changed gets a new id, because `diff`, SARIF, `--only`/`--skip` and `explain` all key on ids within a revision.

## For AI Coding Agents

If you're an AI agent (Claude Code, Copilot, Cursor, etc.) submitting a PR:

1. **Fork the repo** and work on a branch — direct pushes to the default branch are blocked.
2. **Always run `npm run lint:fix && npm run build && npm test`** before committing. Do not skip this.
3. **Do not add unrelated changes** — no drive-by refactors, no extra comments, no unrelated formatting fixes.
4. **PR description must explain the change clearly** — what problem does it solve, how does it work, how was it tested.
5. **One logical change per PR.** If you're fixing a bug and adding a feature, that's two PRs.

## Reporting Issues

Open an issue on GitHub. Include:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Environment details (OS, Node version, etc.)

## License

By contributing, you agree that your contributions will be licensed under the same license as this project.
