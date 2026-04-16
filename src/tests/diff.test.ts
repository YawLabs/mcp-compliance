import { describe, expect, it } from "vitest";
import { diffReports, hasRegressions } from "../diff.js";
import type { ComplianceReport } from "../types.js";

function stubReport(over: Partial<ComplianceReport> = {}): ComplianceReport {
  return {
    schemaVersion: "1.0.0",
    specVersion: "2025-11-25",
    toolVersion: "0.0.0-test",
    url: "http://example.com/mcp",
    timestamp: "2025-01-01T00:00:00.000Z",
    score: 100,
    grade: "A",
    overall: "pass",
    summary: { total: 0, passed: 0, failed: 0, required: 0, requiredPassed: 0 },
    categories: {},
    tests: [],
    warnings: [],
    serverInfo: { protocolVersion: "2025-11-25", name: "test", version: "1.0.0", capabilities: {} },
    toolCount: 0,
    toolNames: [],
    resourceCount: 0,
    resourceNames: [],
    promptCount: 0,
    promptNames: [],
    badge: {
      imageUrl: "https://mcp.hosting/x",
      reportUrl: "https://mcp.hosting/r",
      markdown: "",
      html: "",
    },
    ...over,
  };
}

describe("diffReports — spec version guard", () => {
  it("throws on mismatched specVersion between baseline and current", () => {
    const baseline = stubReport({ specVersion: "2025-06-18" });
    const current = stubReport({ specVersion: "2025-11-25" });
    expect(() => diffReports(baseline, current)).toThrow(/Spec version mismatch/);
  });

  it("allows matching specVersion to diff normally", () => {
    const baseline = stubReport({
      tests: [
        {
          id: "t1",
          name: "t1",
          category: "transport",
          required: true,
          passed: true,
          details: "ok",
          durationMs: 1,
          specRef: "x",
        },
      ],
    });
    const current = stubReport({
      tests: [
        {
          id: "t1",
          name: "t1",
          category: "transport",
          required: true,
          passed: false,
          details: "broke",
          durationMs: 1,
          specRef: "x",
        },
      ],
    });
    const summary = diffReports(baseline, current);
    expect(summary.regressions).toHaveLength(1);
    expect(summary.regressions[0].id).toBe("t1");
    expect(hasRegressions(summary)).toBe(true);
  });

  it("tolerates missing specVersion on either side (legacy reports)", () => {
    const baseline = stubReport({ specVersion: undefined as unknown as string });
    const current = stubReport();
    expect(() => diffReports(baseline, current)).not.toThrow();
  });
});
