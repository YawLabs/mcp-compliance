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
3. **Run `npm run lint:fix`** before committing — CI will reject formatting issues.
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

The JSON output of `runComplianceSuite()` is a **stable, versioned contract** consumed by downstream renderers (mcp.hosting, third-party dashboards). Every report carries a top-level `schemaVersion` field, defined by `REPORT_SCHEMA_VERSION` in `src/types.ts`, and is described by `schemas/report.v1.json`.

When changing the `ComplianceReport` type:

- **Adding a field** (non-breaking): update both `src/types.ts` and `schemas/report.v1.json` in the same PR. No version bump needed.
- **Renaming, removing, or changing the type of an existing field** (breaking): bump `REPORT_SCHEMA_VERSION` to `"2"`, create `schemas/report.v2.json`, and keep `schemas/report.v1.json` for downstream consumers still on v1.
- **Anything that affects determinism** (new non-deterministic field, new warning that includes a timestamp/duration/random ID): the integration test `produces deterministic output` will catch this. Don't bypass it — fix the root cause.

The CI suite enforces this:

- `src/tests/schema.test.ts` validates a hand-crafted sample against the schema.
- `src/tests/integration.test.ts` validates a real CLI run against the schema.
- Drift between `ComplianceReport` and `report.v1.json` will fail CI.

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
