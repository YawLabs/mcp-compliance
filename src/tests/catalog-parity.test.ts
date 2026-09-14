import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MODERN_TEST_DEFINITIONS } from "../definitions/index.js";
import {
  LEGACY_SPEC_VERSION,
  MODERN_SPEC_VERSION,
  type SpecVersion,
  SUPPORTED_SPEC_VERSIONS,
  specBaseFor,
} from "../spec.js";
import { TEST_DEFINITIONS, type TestDefinition } from "../types.js";

// ─────────────────────────────────────────────────────────────────────
// Parity guard for the two hand-maintained mirrors of the test catalogs:
//
//   mcp-compliance-rules.json  -- machine-readable rule catalog (CC BY 4.0)
//   COMPLIANCE_RUBRIC.md       -- the published methodology, one `#### `id``
//                                 block per rule (section 3 = 2025-11-25,
//                                 section 3b = 2026-07-28)
//
// Neither file is generated or shipped in the npm package, so nothing else
// notices when a test is added, renamed, re-categorised or flipped between
// required and optional without the docs following. Before this guard the
// catalog sat at 81 rules while the code had 88, and `error-method-code`
// carried a different name in rules.json for two releases. The checks are
// per spec version because ids are only comparable within one catalog.
// ─────────────────────────────────────────────────────────────────────

interface CatalogRule {
  id: string;
  name: string;
  category: string;
  specVersion: string;
  severity: "error" | "warning";
  defaultRequired: boolean;
  capabilityGated: string | null;
  specRef: string;
  description: string;
  passCriteria: string;
  failCriteria: string;
  transports?: string[];
}

interface RuleCatalog {
  specVersion: string;
  specDate: string;
  mcpSpecCompatibility: string[];
  categories: Array<{ id: string; name: string; description: string; scope: string }>;
  rules: CatalogRule[];
}

function repoFile(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");
}

const catalog: RuleCatalog = JSON.parse(repoFile("mcp-compliance-rules.json"));
const rubric = repoFile("COMPLIANCE_RUBRIC.md");

const CATALOGS: Array<{
  version: SpecVersion;
  defs: TestDefinition[];
  /** Heading that opens this catalog's rubric section. */
  rubricStart: string;
  /** Heading that opens the NEXT top-level section (exclusive end). */
  rubricEnd: string;
}> = [
  {
    version: LEGACY_SPEC_VERSION,
    defs: TEST_DEFINITIONS,
    rubricStart: "\n## 3. Test Rules",
    rubricEnd: "\n## 3b. Test Rules",
  },
  {
    version: MODERN_SPEC_VERSION,
    defs: MODERN_TEST_DEFINITIONS,
    rubricStart: "\n## 3b. Test Rules",
    rubricEnd: "\n## 4. Rule Catalog",
  },
];

function rubricSection(start: string, end: string): string {
  const from = rubric.indexOf(start);
  const to = rubric.indexOf(end);
  expect(from, `rubric heading ${JSON.stringify(start.trim())} missing`).toBeGreaterThan(-1);
  expect(to, `rubric heading ${JSON.stringify(end.trim())} missing`).toBeGreaterThan(from);
  return rubric.slice(from, to);
}

/** The bullet value for `- **Label:** value` inside one rule block. */
function bullet(block: string, label: string): string | null {
  const m = block.match(new RegExp(`^- \\*\\*${label}:\\*\\* (.+)$`, "m"));
  return m ? m[1].trim() : null;
}

describe("mcp-compliance-rules.json top level", () => {
  it("declares compatibility with exactly the supported spec versions", () => {
    expect(catalog.mcpSpecCompatibility).toEqual([...SUPPORTED_SPEC_VERSIONS]);
  });

  it("methodology version is semver and at least 2.0.0 (array-valued mcpSpecCompatibility)", () => {
    expect(catalog.specVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Number.parseInt(catalog.specVersion.split(".")[0], 10)).toBeGreaterThanOrEqual(2);
  });

  it("every rule carries a supported specVersion", () => {
    const bad = catalog.rules.filter((r) => !(SUPPORTED_SPEC_VERSIONS as readonly string[]).includes(r.specVersion));
    expect(bad.map((r) => `${r.id}: ${r.specVersion}`)).toEqual([]);
  });

  it("total rule count is the sum of both catalogs", () => {
    expect(catalog.rules).toHaveLength(TEST_DEFINITIONS.length + MODERN_TEST_DEFINITIONS.length);
  });

  it("categories cover the 8 test categories once each", () => {
    expect(catalog.categories.map((c) => c.id).sort()).toEqual(
      ["transport", "lifecycle", "tools", "resources", "prompts", "errors", "schema", "security"].sort(),
    );
  });
});

for (const { version, defs, rubricStart, rubricEnd } of CATALOGS) {
  describe(`rules.json ↔ ${version} catalog`, () => {
    const rules = catalog.rules.filter((r) => r.specVersion === version);
    const byId = new Map(rules.map((r) => [r.id, r]));
    const defIds = defs.map((d) => d.id);

    it("has no duplicate ids within the spec version", () => {
      expect(new Set(rules.map((r) => r.id)).size).toBe(rules.length);
    });

    it("has exactly the catalog's ids (no missing, no extra)", () => {
      const missing = defIds.filter((id) => !byId.has(id));
      const extra = rules.map((r) => r.id).filter((id) => !defIds.includes(id));
      expect({ missing, extra }).toEqual({ missing: [], extra: [] });
    });

    for (const def of defs) {
      it(`${def.id}: name, category, required, severity, specRef, transports match`, () => {
        const rule = byId.get(def.id);
        expect(rule, `rule ${def.id} missing from rules.json`).toBeDefined();
        if (!rule) return;
        expect(rule.name).toBe(def.name);
        expect(rule.category).toBe(def.category);
        expect(rule.defaultRequired).toBe(def.required);
        expect(rule.severity).toBe(def.required ? "error" : "warning");
        expect(rule.specRef).toBe(def.specRef);
        expect(rule.transports ?? null).toEqual(def.transports ?? null);
        expect(rule.description.length).toBeGreaterThan(0);
        expect(rule.passCriteria.length).toBeGreaterThan(0);
        expect(rule.failCriteria.length).toBeGreaterThan(0);
        expect(["tools", "resources", "prompts", "completions", "logging", "resources.subscribe", null]).toContain(
          rule.capabilityGated,
        );
      });
    }
  });

  describe(`COMPLIANCE_RUBRIC.md ↔ ${version} catalog`, () => {
    const section = rubricSection(rubricStart, rubricEnd);
    const headings = [...section.matchAll(/^#### `([^`]+)`/gm)].map((m) => m[1]);
    const defIds = defs.map((d) => d.id);

    it("rule headings appear once each", () => {
      expect(new Set(headings).size).toBe(headings.length);
    });

    it("rule headings are exactly the catalog's ids", () => {
      const missing = defIds.filter((id) => !headings.includes(id));
      const extra = headings.filter((id) => !defIds.includes(id));
      expect({ missing, extra }).toEqual({ missing: [], extra: [] });
    });

    it("per-category section headings carry the catalog's counts", () => {
      const counts: Record<string, number> = {};
      for (const d of defs) counts[d.category] = (counts[d.category] ?? 0) + 1;
      const found: Record<string, number> = {};
      for (const m of section.matchAll(/^### 3b?\.\d+ ([a-z]+) -- .*\((\d+) tests\)$/gm)) {
        found[m[1]] = Number.parseInt(m[2], 10);
      }
      expect(found).toEqual(counts);
    });

    // Each `#### `id`` block runs until the next `#### ` heading or the end
    // of the section. Its bullets must agree with the catalog: the required
    // flag (a "Yes"/"No" prefix, so "No (required at runtime when ...)" is
    // fine) and the absolute spec URL for this revision.
    const blocks = new Map<string, string>();
    {
      const parts = section.split(/^(?=#### `)/m);
      for (const part of parts) {
        const m = part.match(/^#### `([^`]+)`/);
        if (m) blocks.set(m[1], part);
      }
    }

    for (const def of defs) {
      it(`${def.id}: rubric block agrees on required flag and spec URL`, () => {
        const block = blocks.get(def.id);
        expect(block, `no rubric block for ${def.id}`).toBeDefined();
        if (!block) return;
        const required = bullet(block, "Default required");
        expect(required, `${def.id} has no Default required bullet`).not.toBeNull();
        expect(required?.startsWith(def.required ? "Yes" : "No"), `${def.id}: required bullet is ${required}`).toBe(
          true,
        );
        const ref = bullet(block, "Spec reference");
        expect(ref, `${def.id} has no Spec reference bullet`).not.toBeNull();
        expect(ref).toContain(`(${specBaseFor(version)}/${def.specRef})`);
      });
    }
  });
}
