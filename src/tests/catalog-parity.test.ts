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
// Neither file is shipped in the npm package, and the 2026-07-28 half is
// only regenerated when someone runs scripts/gen-catalog-docs.ts by hand,
// so nothing else notices when a test is added, renamed, re-categorised or
// flipped between required and optional without the docs following. Before this guard the
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

/**
 * Each `#### `id`` block of a rubric section, keyed by id. A block runs
 * until the next `#### ` heading or the end of the section.
 */
function ruleBlocks(section: string): Map<string, string> {
  const blocks = new Map<string, string>();
  for (const part of section.split(/^(?=#### `)/m)) {
    const m = part.match(/^#### `([^`]+)`/);
    if (m) blocks.set(m[1], part);
  }
  return blocks;
}

describe("mcp-compliance-rules.json top level", () => {
  it("declares compatibility with exactly the supported spec versions", () => {
    expect(catalog.mcpSpecCompatibility).toEqual([...SUPPORTED_SPEC_VERSIONS]);
  });

  it("methodology version is semver and at least 2.0.0 (array-valued mcpSpecCompatibility)", () => {
    expect(catalog.specVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Number.parseInt(catalog.specVersion.split(".")[0], 10)).toBeGreaterThanOrEqual(2);
  });

  it("is at least 3.0.0, the version that leaves skips out of the score (a scoring change is a major bump)", () => {
    expect(Number.parseInt(catalog.specVersion.split(".")[0], 10)).toBeGreaterThanOrEqual(3);
  });

  it("the rubric header names the same methodology version and date as the catalog", () => {
    // Both are written by hand (the catalog's in scripts/gen-catalog-docs.ts),
    // so a bump to one alone would leave two version labels for one document.
    expect(rubric).toContain(`\n**Version:** ${catalog.specVersion}\n`);
    expect(rubric).toContain(`\n**Date:** ${catalog.specDate}\n`);
    // The section 4 schema example shows the current values too.
    expect(rubric).toContain(`  "specVersion": "${catalog.specVersion}",\n  "specDate": "${catalog.specDate}",`);
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

    // Each rule block's bullets must agree with the catalog: the required
    // flag (a "Yes"/"No" prefix, so "No (required at runtime when ...)" is
    // fine) and the absolute spec URL for this revision.
    const blocks = ruleBlocks(section);

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

// ─────────────────────────────────────────────────────────────────────
// Section 3b and the 2026-07-28 rules in rules.json are written by
// scripts/gen-catalog-docs.ts, which cannot be imported (it writes both
// files at load). Besides per-rule fields it writes prose the checks above
// never read: the rule count, a "Counts:" line and the transport intro's
// HTTP-only / stdio-only figures are literal strings in the script, and
// each rule's description and capability gate are copied in. After a
// catalog change a regenerated rubric could state stale totals and stay
// green, so recompute every figure from the catalog here. (The
// 2025-11-25 rules are hand-maintained and their descriptions differ from
// TEST_DEFINITIONS by design, so this is 2026-07-28 only.)
// ─────────────────────────────────────────────────────────────────────
describe("COMPLIANCE_RUBRIC.md section 3b and rules.json: generated prose ↔ 2026-07-28 catalog", () => {
  const defs = MODERN_TEST_DEFINITIONS;
  const section = rubricSection("\n## 3b. Test Rules", "\n## 4. Rule Catalog");
  const blocks = ruleBlocks(section);
  const rules = new Map(catalog.rules.filter((r) => r.specVersion === MODERN_SPEC_VERSION).map((r) => [r.id, r]));

  const onlyOn = (kind: "http" | "stdio") => (d: TestDefinition) =>
    d.transports?.length === 1 && d.transports[0] === kind;
  const inCategory = (category: string) => defs.filter((d) => d.category === category);

  it("the section intro states the rule count", () => {
    expect(section).toContain(`has ${defs.length} rules in the same 8 categories`);
  });

  it("the Counts line matches the per-category, required-by-default and per-transport totals", () => {
    const transport = inCategory("transport");
    const transportStdio = transport.filter(onlyOn("stdio")).length;
    const perCategory = ["transport", "lifecycle", "tools", "resources", "prompts", "errors", "schema", "security"].map(
      (category) =>
        category === "transport"
          ? `transport ${transport.length} (${transport.length - transportStdio} HTTP + ${transportStdio} stdio)`
          : `${category} ${inCategory(category).length}`,
    );
    const httpOnly = defs.filter(onlyOn("http")).length;
    const stdioOnly = defs.filter(onlyOn("stdio")).length;
    const both = defs.length - httpOnly - stdioOnly;
    const required = defs.filter((d) => d.required).length;
    expect(section).toContain(
      `Counts: ${perCategory.join(", ")}. Required by default: ${required}. ` +
        `Runs on HTTP: ${httpOnly + both} (${httpOnly} HTTP-only + ${both} both); ` +
        `on stdio: ${stdioOnly + both} (${stdioOnly} stdio-only + ${both} both).`,
    );
  });

  it("the transport intro's HTTP-only / stdio-only figures and its one both-transport rule match", () => {
    const transport = inCategory("transport");
    const httpOnly = transport.filter(onlyOn("http")).length;
    const stdioOnly = transport.filter(onlyOn("stdio")).length;
    const intro = section.slice(section.indexOf("### 3b.1 transport"), section.indexOf("#### `"));
    expect(intro).toContain(`${httpOnly} rules are HTTP-only (\`transports: ["http"]\`), ${stdioOnly} are stdio-only`);
    expect(intro).toContain(`hence "${transport.length - stdioOnly} HTTP + ${stdioOnly} stdio"`);
    // The intro names the single transport rule that runs on both.
    const onBoth = transport.filter((d) => !onlyOn("http")(d) && !onlyOn("stdio")(d)).map((d) => d.id);
    expect(onBoth).toEqual(["transport-no-server-requests"]);
    expect(intro).toContain("`transport-no-server-requests` is a post-hoc scan of the recording that runs on both");
  });

  it("rules.json and the rubric Description bullet carry each rule's catalog description verbatim", () => {
    const drift: string[] = [];
    for (const def of defs) {
      if (rules.get(def.id)?.description !== def.description) drift.push(`${def.id}: rules.json description`);
      const block = blocks.get(def.id);
      if (!block || bullet(block, "Description") !== def.description) drift.push(`${def.id}: rubric Description`);
    }
    expect(drift).toEqual([]);
  });

  it("the rubric's Default required bullet names the same capability gate as rules.json", () => {
    // Both come from one script-only `gate` per rule (there is no catalog
    // field for it); a hand edit to either file must not go unnoticed.
    const drift: string[] = [];
    for (const def of defs) {
      const gate = rules.get(def.id)?.capabilityGated ?? null;
      const block = blocks.get(def.id);
      const named = (block ? bullet(block, "Default required") : null)?.match(/`([a-z.]+)`/)?.[1] ?? null;
      if (named !== gate) drift.push(`${def.id}: rules.json ${gate}, rubric ${named}`);
    }
    expect(drift).toEqual([]);
  });
});
