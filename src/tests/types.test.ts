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
];

describe("TEST_DEFINITIONS", () => {
  it("contains exactly 43 test definitions", () => {
    expect(TEST_DEFINITIONS).toHaveLength(43);
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
    expect(counts.transport).toBe(7);
    expect(counts.lifecycle).toBe(10);
    expect(counts.tools).toBe(4);
    expect(counts.resources).toBe(5);
    expect(counts.prompts).toBe(3);
    expect(counts.errors).toBe(8);
    expect(counts.schema).toBe(6);
  });

  it("has correct required test count", () => {
    const required = TEST_DEFINITIONS.filter((t) => t.required);
    // Default required (before capability gating): transport-post, transport-content-type,
    // transport-batch-reject, lifecycle-init, lifecycle-proto-version, lifecycle-capabilities,
    // lifecycle-jsonrpc, lifecycle-ping, lifecycle-id-match, error-unknown-method, error-invalid-jsonrpc
    expect(required.length).toBe(11);
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
});
