# Vendored MCP wire schemas

JSON Schema (draft 2020-12) copies of the MCP specification's `schema.json`,
one per spec revision the tool tests. They are imported by
`src/modern/schema-validator.ts` and bundled into `dist/` by tsup, so the
published package never reads them from disk at runtime.

Keep each file **content-identical** to its upstream source: the only
difference is formatting (upstream ships CRLF + 4-space indent; this repo's
`.gitattributes` forces LF and Biome reformats to 2-space), so
`biome format` applied to the upstream file must reproduce ours exactly.
Compatibility fixes (see the `JSONValue` patch in `schema-validator.ts`) are
applied in memory at load time, never to the file.

| File | Spec revision | Upstream path | Source commit |
|---|---|---|---|
| `mcp-2026-07-28.schema.json` | 2026-07-28 | `schema/2026-07-28/schema.json` | `aa8ce049f089f92618340190d4ece141f663310d` (modelcontextprotocol/modelcontextprotocol, 2026-09-08) |

To refresh a file:

```bash
git -C <spec-checkout> log -1 --format=%H   # record this in the table above
cp <spec-checkout>/schema/2026-07-28/schema.json src/schemas/mcp-2026-07-28.schema.json
node scripts/lint.mjs check --write src/schemas/mcp-2026-07-28.schema.json
npx vitest run src/tests/schema-validator.test.ts
```

The validator test suite pins the in-memory patch to the shape of the
upstream `JSONValue` definition; if a refresh changes that shape the suite
fails loudly rather than letting the patch silently stop applying.

Not to be confused with the top-level `schemas/` directory, which holds this
tool's own report schema (`report.v1.json`) and IS published as a package
export.
