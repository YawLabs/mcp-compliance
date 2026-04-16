import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TEST_DEFINITIONS } from "../types.js";
import type { TestCategory, TestDefinition } from "../types.js";

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

describe("README ↔ TEST_DEFINITIONS parity", () => {
  // Regression guard: the per-category counts shown in the README's "What
  // the N tests check" collapsible sections must match TEST_DEFINITIONS.
  // Drift previously went unnoticed when capability-gated tests were added
  // (transport went 13→16 when stdio-only tests landed; lifecycle 17→21
  // when the capability/meta-tolerance tests landed). A failing test here
  // is a signal to update the README at the same time.
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

  function readmeCountFor(category: TestCategory): number | null {
    const readmePath = fileURLToPath(new URL("../../README.md", import.meta.url));
    const src = readFileSync(readmePath, "utf8");
    const label = README_LABELS[category];
    const re = new RegExp(`<summary><strong>${label}\\s*\\((\\d+)\\s*tests?\\)</strong></summary>`);
    const m = src.match(re);
    return m ? Number.parseInt(m[1], 10) : null;
  }

  function runtimeCountFor(category: TestCategory): number {
    return TEST_DEFINITIONS.filter((t) => t.category === category).length;
  }

  for (const cat of VALID_CATEGORIES) {
    it(`README section "${cat}" count matches TEST_DEFINITIONS`, () => {
      const docCount = readmeCountFor(cat);
      expect(docCount, `README missing "<summary><strong>${cat}...</strong>" header`).not.toBeNull();
      expect(docCount).toBe(runtimeCountFor(cat));
    });
  }

  it("README totals match TEST_DEFINITIONS total", () => {
    let sum = 0;
    for (const cat of VALID_CATEGORIES) {
      const n = readmeCountFor(cat);
      if (n != null) sum += n;
    }
    expect(sum).toBe(TEST_DEFINITIONS.length);
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
