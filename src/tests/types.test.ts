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
  it("contains exactly 85 test definitions", () => {
    expect(TEST_DEFINITIONS).toHaveLength(85);
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
    expect(counts.lifecycle).toBe(18);
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
