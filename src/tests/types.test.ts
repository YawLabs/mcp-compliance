import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MODERN_TEST_DEFINITIONS } from "../definitions/index.js";
import { LEGACY_SPEC_VERSION, MODERN_SPEC_VERSION, type SpecVersion } from "../spec.js";
import type { TestCategory, TestDefinition } from "../types.js";
import { TEST_DEFINITIONS } from "../types.js";

const VALID_CATEGORIES: TestCategory[] = [
  "transport",
  "lifecycle",
  "tools",
  "resources",
  "prompts",
  "errors",
  "schema",
  "security",
];

describe("TEST_DEFINITIONS", () => {
  it("contains exactly 88 test definitions", () => {
    expect(TEST_DEFINITIONS).toHaveLength(88);
  });

  it("all IDs are unique", () => {
    const ids = TEST_DEFINITIONS.map((t) => t.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it("all have valid categories", () => {
    for (const def of TEST_DEFINITIONS) {
      expect(VALID_CATEGORIES).toContain(def.category);
    }
  });

  it("all have non-empty names", () => {
    for (const def of TEST_DEFINITIONS) {
      expect(def.name.length).toBeGreaterThan(0);
    }
  });

  it("all have non-empty descriptions", () => {
    for (const def of TEST_DEFINITIONS) {
      expect(def.description.length).toBeGreaterThan(0);
    }
  });

  it("all have non-empty specRef", () => {
    for (const def of TEST_DEFINITIONS) {
      expect(def.specRef.length).toBeGreaterThan(0);
    }
  });

  it("all have non-empty recommendations", () => {
    for (const def of TEST_DEFINITIONS) {
      expect(def.recommendation.length).toBeGreaterThan(0);
    }
  });

  it("has correct category counts", () => {
    const counts: Record<string, number> = {};
    for (const def of TEST_DEFINITIONS) {
      counts[def.category] = (counts[def.category] || 0) + 1;
    }
    expect(counts.transport).toBe(16);
    expect(counts.lifecycle).toBe(21);
    expect(counts.tools).toBe(4);
    expect(counts.resources).toBe(5);
    expect(counts.prompts).toBe(3);
    expect(counts.errors).toBe(10);
    expect(counts.schema).toBe(6);
    expect(counts.security).toBe(23);
  });

  it("has correct required test count", () => {
    const required = TEST_DEFINITIONS.filter((t) => t.required);
    // Default required (before capability gating): transport-post, transport-content-type,
    // transport-batch-reject, stdio-framing, lifecycle-init, lifecycle-proto-version,
    // lifecycle-capabilities, lifecycle-jsonrpc, lifecycle-ping, lifecycle-id-match,
    // error-unknown-method, error-invalid-jsonrpc
    expect(required.length).toBe(12);
  });

  it("IDs match expected format (kebab-case)", () => {
    for (const def of TEST_DEFINITIONS) {
      expect(def.id).toMatch(/^[a-z]+-[a-z0-9-]+$/);
    }
  });

  it("transport tests have transport specRefs", () => {
    const transportTests = TEST_DEFINITIONS.filter((t) => t.category === "transport");
    for (const t of transportTests) {
      expect(t.specRef).toContain("transport");
    }
  });

  it("lifecycle-logging has correct specRef", () => {
    const logging = TEST_DEFINITIONS.find((t) => t.id === "lifecycle-logging");
    expect(logging).toBeDefined();
    expect(logging!.specRef).toContain("logging");
    expect(logging!.required).toBe(false); // default, becomes required with capability
  });

  it("lifecycle-completions has correct specRef", () => {
    const comp = TEST_DEFINITIONS.find((t) => t.id === "lifecycle-completions");
    expect(comp).toBeDefined();
    expect(comp!.specRef).toContain("completion");
    expect(comp!.required).toBe(false);
  });

  it("lifecycle-cancellation has correct specRef", () => {
    const cancel = TEST_DEFINITIONS.find((t) => t.id === "lifecycle-cancellation");
    expect(cancel).toBeDefined();
    expect(cancel!.specRef).toContain("cancellation");
    expect(cancel!.required).toBe(false);
  });

  it("transport-content-type-init exists", () => {
    const ct = TEST_DEFINITIONS.find((t) => t.id === "transport-content-type-init");
    expect(ct).toBeDefined();
    expect(ct!.category).toBe("transport");
    expect(ct!.required).toBe(false);
  });
});

// Regression guard: the per-category counts shown in the README's "What
// the N tests check (<spec>)" collapsible sections must match the catalog
// for that spec version. Drift previously went unnoticed when
// capability-gated tests were added (transport went 13→16 when stdio-only
// tests landed; lifecycle 17→21 when the capability/meta-tolerance tests
// landed). A failing test here is a signal to update the README at the
// same time.
//
// The README has one such section per spec revision, each with the same
// <details><summary> structure, so the counts are scoped to the section
// whose heading names the revision — an unscoped `src.match` would only
// ever see the first section and let the second drift silently.
// README uses sentence-case labels that differ from the TestCategory
// union ("errors" → "Error Handling", "schema" → "Schema Validation"),
// so explicit mapping beats a fancy auto-cased guess.
const README_LABELS: Record<TestCategory, string> = {
  transport: "Transport",
  lifecycle: "Lifecycle",
  tools: "Tools",
  resources: "Resources",
  prompts: "Prompts",
  errors: "Error Handling",
  schema: "Schema Validation",
  security: "Security",
};

const README_SRC = readFileSync(fileURLToPath(new URL("../../README.md", import.meta.url)), "utf8");

/** The README section "## What the N tests check (<version>)", up to the next `## ` heading. */
function readmeSectionFor(version: SpecVersion): { headingCount: number; body: string } | null {
  const re = new RegExp(`^## What the (\\d+) tests check \\(${version}\\)$`, "m");
  const m = README_SRC.match(re);
  if (!m || m.index === undefined) return null;
  const rest = README_SRC.slice(m.index + m[0].length);
  const next = rest.search(/^## /m);
  return { headingCount: Number.parseInt(m[1], 10), body: next === -1 ? rest : rest.slice(0, next) };
}

function readmeCountFor(body: string, category: TestCategory): number | null {
  const label = README_LABELS[category];
  const re = new RegExp(`<summary><strong>${label}\\s*\\((\\d+)\\s*tests?\\)</strong></summary>`);
  const m = body.match(re);
  return m ? Number.parseInt(m[1], 10) : null;
}

const README_CATALOGS: Array<{ version: SpecVersion; defs: TestDefinition[] }> = [
  { version: LEGACY_SPEC_VERSION, defs: TEST_DEFINITIONS },
  { version: MODERN_SPEC_VERSION, defs: MODERN_TEST_DEFINITIONS },
];

for (const { version, defs } of README_CATALOGS) {
  describe(`README ↔ ${version} catalog parity`, () => {
    const section = readmeSectionFor(version);

    it(`README has a "What the N tests check (${version})" section`, () => {
      expect(section, `README missing "## What the N tests check (${version})" heading`).not.toBeNull();
    });

    it("section heading total matches the catalog length", () => {
      expect(section?.headingCount).toBe(defs.length);
    });

    for (const cat of VALID_CATEGORIES) {
      it(`README section "${cat}" count matches the catalog`, () => {
        const docCount = section ? readmeCountFor(section.body, cat) : null;
        expect(
          docCount,
          `README ${version} section missing "<summary><strong>${cat}...</strong>" header`,
        ).not.toBeNull();
        expect(docCount).toBe(defs.filter((t) => t.category === cat).length);
      });
    }

    it("README per-category totals sum to the catalog length", () => {
      let sum = 0;
      for (const cat of VALID_CATEGORIES) {
        const n = section ? readmeCountFor(section.body, cat) : null;
        if (n != null) sum += n;
      }
      expect(sum).toBe(defs.length);
    });
  });
}

describe("MODERN_TEST_DEFINITIONS", () => {
  it("contains exactly 103 test definitions", () => {
    expect(MODERN_TEST_DEFINITIONS).toHaveLength(103);
  });

  it("all IDs are unique", () => {
    const ids = MODERN_TEST_DEFINITIONS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("all have valid categories", () => {
    for (const def of MODERN_TEST_DEFINITIONS) {
      expect(VALID_CATEGORIES).toContain(def.category);
    }
  });

  it("all have non-empty names, descriptions, recommendations and specRefs", () => {
    for (const def of MODERN_TEST_DEFINITIONS) {
      expect(def.name.length, def.id).toBeGreaterThan(0);
      expect(def.description.length, def.id).toBeGreaterThan(0);
      expect(def.recommendation.length, def.id).toBeGreaterThan(0);
      expect(def.specRef.length, def.id).toBeGreaterThan(0);
    }
  });

  it("has correct category counts", () => {
    const counts: Record<string, number> = {};
    for (const def of MODERN_TEST_DEFINITIONS) {
      counts[def.category] = (counts[def.category] || 0) + 1;
    }
    expect(counts.transport).toBe(20);
    expect(counts.lifecycle).toBe(22);
    expect(counts.tools).toBe(6);
    expect(counts.resources).toBe(8);
    expect(counts.prompts).toBe(4);
    expect(counts.errors).toBe(12);
    expect(counts.schema).toBe(10);
    expect(counts.security).toBe(21);
  });

  it("has correct required test count", () => {
    // Default required (before capability gating), 24: transport-post,
    // transport-content-type, transport-batch-reject, the four
    // transport-header-* MUSTs, transport-no-server-requests,
    // lifecycle-discover(-versions,-caching), lifecycle-jsonrpc,
    // lifecycle-id-match, lifecycle-capabilities, the four lifecycle-meta-*
    // envelope rules, lifecycle-version-unsupported,
    // lifecycle-log-level-gating, error-unknown-method, error-method-code,
    // schema-result-type, schema-no-input-required-on-lists.
    const required = MODERN_TEST_DEFINITIONS.filter((t) => t.required);
    expect(required.length).toBe(24);
  });

  it("IDs match expected format (kebab-case)", () => {
    for (const def of MODERN_TEST_DEFINITIONS) {
      expect(def.id).toMatch(/^[a-z]+-[a-z0-9-]+$/);
    }
  });

  it("specRefs are relative to the spec base (no scheme, no leading slash)", () => {
    for (const def of MODERN_TEST_DEFINITIONS) {
      expect(def.specRef, def.id).not.toMatch(/^https?:\/\//);
      expect(def.specRef, def.id).not.toMatch(/^\//);
    }
  });

  it("transports, when set, is a non-empty list of http/stdio", () => {
    for (const def of MODERN_TEST_DEFINITIONS) {
      if (def.transports === undefined) continue;
      expect(def.transports.length, def.id).toBeGreaterThan(0);
      for (const t of def.transports) expect(["http", "stdio"], def.id).toContain(t);
    }
  });

  it("stdio-* tests are stdio-only and every other transport-category test is HTTP-only except the post-hoc scan", () => {
    for (const def of MODERN_TEST_DEFINITIONS) {
      if (def.id.startsWith("stdio-")) expect(def.transports, def.id).toEqual(["stdio"]);
      else if (def.category === "transport" && def.id !== "transport-no-server-requests") {
        expect(def.transports, def.id).toEqual(["http"]);
      }
    }
  });

  it("every id shared with the legacy catalog keeps the same category", () => {
    const legacy = new Map(TEST_DEFINITIONS.map((t) => [t.id, t.category]));
    const mismatched = MODERN_TEST_DEFINITIONS.filter((t) => legacy.has(t.id) && legacy.get(t.id) !== t.category).map(
      (t) => `${t.id}: ${legacy.get(t.id)} → ${t.category}`,
    );
    expect(mismatched).toEqual([]);
  });

  it("does not carry ids for mechanisms 2026-07-28 removed", () => {
    const ids = new Set(MODERN_TEST_DEFINITIONS.map((t) => t.id));
    for (const gone of [
      "lifecycle-init",
      "lifecycle-ping",
      "lifecycle-logging",
      "lifecycle-reinit-reject",
      "resources-subscribe",
      "transport-session-id",
      "transport-get",
      "security-session-entropy",
      "security-session-not-auth",
    ]) {
      expect(ids.has(gone), gone).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Parity guard: every `await test("<id>", ...)` call in runner.ts MUST
// have a matching entry in TEST_DEFINITIONS, and every TEST_DEFINITIONS
// entry MUST be invoked by the runner at least once. Without this check
// the two lists drift (e.g. a test gets renamed in runner but its entry
// in types.ts stays the old id → metadata lookups silently return undef).
// ─────────────────────────────────────────────────────────────────────
function extractRunnerTestIds(): string[] {
  const runnerPath = fileURLToPath(new URL("../runner.ts", import.meta.url));
  const src = readFileSync(runnerPath, "utf8");
  // Allow multiline match so `await test(\n  "id",\n  ...)` is captured.
  const matches = [...src.matchAll(/await\s+test\(\s*["']([^"']+)["']/g)];
  return matches.map((m) => m[1]);
}

describe("runner ↔ TEST_DEFINITIONS parity", () => {
  const runnerIds = extractRunnerTestIds();

  it("every runner test id has a TEST_DEFINITIONS entry", () => {
    const defined = new Set(TEST_DEFINITIONS.map((t) => t.id));
    const missing = runnerIds.filter((id) => !defined.has(id));
    expect(missing).toEqual([]);
  });

  it("every TEST_DEFINITIONS id is exercised by runner", () => {
    const runnerSet = new Set(runnerIds);
    const orphans = TEST_DEFINITIONS.map((t) => t.id).filter((id) => !runnerSet.has(id));
    expect(orphans).toEqual([]);
  });

  it("runner invokes each test id exactly once", () => {
    const counts = new Map<string, number>();
    for (const id of runnerIds) counts.set(id, (counts.get(id) ?? 0) + 1);
    const dupes = [...counts.entries()].filter(([, n]) => n > 1);
    expect(dupes).toEqual([]);
  });

  it("runner test count matches TEST_DEFINITIONS length", () => {
    expect(runnerIds.length).toBe(TEST_DEFINITIONS.length);
  });
});
