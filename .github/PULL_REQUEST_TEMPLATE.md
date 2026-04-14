## Summary

<!-- What does this PR do, and why? One to three bullets. -->

## Type of change

- [ ] Bug fix (non-breaking)
- [ ] New feature (non-breaking)
- [ ] Breaking change (requires a major version bump)
- [ ] New compliance test
- [ ] Documentation / tooling only

## Compliance test changes (if applicable)

- [ ] Added or modified a test ID — `stable test IDs are part of the 1.0 API contract; breaking ones is a major bump`
- [ ] Linked the relevant MCP spec (or RFC) section for the new/changed test
- [ ] Updated `TEST_DEFINITIONS` in `src/types.ts`
- [ ] Ran the integration suite against a real reference server

## Checklist

- [ ] `npm run lint:fix` and `npm run typecheck` pass
- [ ] `npm test` passes (all 178+ tests)
- [ ] Updated `CHANGELOG.md` under `[Unreleased]` if user-visible
- [ ] Updated README / docs if behavior changed

## Notes for reviewers

<!-- Anything non-obvious: tricky edge cases, why you chose approach A over B, etc. -->
