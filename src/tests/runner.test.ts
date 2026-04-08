import { describe, expect, it } from "vitest";
import { runComplianceSuite } from "../runner.js";

// Use localhost on a port that's definitely not listening for instant ECONNREFUSED
const DEAD_URL = "http://127.0.0.1:1/mcp";

describe("runComplianceSuite — input validation", () => {
  it("rejects non-HTTP URLs", async () => {
    await expect(runComplianceSuite("ftp://example.com")).rejects.toThrow("Only HTTP and HTTPS");
  });

  it("rejects invalid URLs", async () => {
    await expect(runComplianceSuite("not-a-url")).rejects.toThrow("Invalid URL");
  });

  it("rejects empty string", async () => {
    await expect(runComplianceSuite("")).rejects.toThrow("Invalid URL");
  });

  it("rejects file:// URLs", async () => {
    await expect(runComplianceSuite("file:///etc/passwd")).rejects.toThrow("Only HTTP and HTTPS");
  });

  it("rejects javascript: URLs", async () => {
    await expect(runComplianceSuite("javascript:alert(1)")).rejects.toThrow("Only HTTP and HTTPS");
  });

  it("rejects data: URLs", async () => {
    await expect(runComplianceSuite("data:text/html,test")).rejects.toThrow("Only HTTP and HTTPS");
  });
});

describe("runComplianceSuite — connection failures", () => {
  it("fails gracefully for unreachable host", async () => {
    const report = await runComplianceSuite(DEAD_URL, {
      timeout: 2000,
      only: ["transport-post", "transport-content-type", "transport-batch-reject"],
    });
    expect(report.grade).toBeDefined();
    expect(report.overall).toBe("fail");
    expect(report.tests.length).toBeGreaterThan(0);
    for (const t of report.tests) {
      expect(t.passed).toBe(false);
    }
  }, 15000);

  it("includes preflight warning for unreachable host", async () => {
    const report = await runComplianceSuite(DEAD_URL, {
      timeout: 2000,
      only: ["transport-post"],
    });
    expect(report.warnings.some((w) => w.includes("unreachable"))).toBe(true);
  }, 15000);
});

describe("runComplianceSuite — filtering", () => {
  it("only runs specified categories", async () => {
    const report = await runComplianceSuite(DEAD_URL, {
      only: ["transport"],
      timeout: 2000,
    });
    // Only transport tests should be present (plus lifecycle always runs for init)
    for (const t of report.tests) {
      expect(t.category).toBe("transport");
    }
  }, 30000);

  it("skips specified categories", async () => {
    const report = await runComplianceSuite(DEAD_URL, {
      skip: ["transport", "lifecycle", "tools", "resources", "prompts", "schema"],
      timeout: 2000,
    });
    // No transport or lifecycle tests
    const transportTests = report.tests.filter((t) => t.category === "transport");
    expect(transportTests).toHaveLength(0);
    const lifecycleTests = report.tests.filter((t) => t.category === "lifecycle");
    expect(lifecycleTests).toHaveLength(0);
  }, 30000);

  it("filters by test ID", async () => {
    const report = await runComplianceSuite(DEAD_URL, {
      only: ["transport-post"],
      timeout: 2000,
    });
    expect(report.tests).toHaveLength(1);
    expect(report.tests[0].id).toBe("transport-post");
  }, 15000);
});

describe("runComplianceSuite — report structure", () => {
  it("includes all required report fields", async () => {
    const report = await runComplianceSuite(DEAD_URL, {
      only: ["transport-post"],
      timeout: 2000,
    });
    expect(report.specVersion).toBe("2025-11-25");
    expect(report.toolVersion).toBeDefined();
    expect(report.url).toBe(DEAD_URL);
    expect(report.timestamp).toBeDefined();
    expect(typeof report.score).toBe("number");
    expect(["A", "B", "C", "D", "F"]).toContain(report.grade);
    expect(["pass", "partial", "fail"]).toContain(report.overall);
    expect(report.summary).toBeDefined();
    expect(report.categories).toBeDefined();
    expect(report.tests).toBeDefined();
    expect(report.warnings).toBeDefined();
    expect(report.serverInfo).toBeDefined();
    expect(report.badge).toBeDefined();
  }, 15000);

  it("badge contains valid URLs", async () => {
    const report = await runComplianceSuite(DEAD_URL, {
      only: ["transport-post"],
      timeout: 2000,
    });
    expect(report.badge.imageUrl).toContain("mcp.hosting");
    expect(report.badge.reportUrl).toContain("mcp.hosting");
    expect(report.badge.markdown).toContain("[![MCP Compliant]");
    expect(report.badge.html).toContain("<a href=");
  }, 15000);

  it("each test has required fields", async () => {
    const report = await runComplianceSuite(DEAD_URL, {
      only: ["transport-post", "transport-content-type"],
      timeout: 2000,
    });
    for (const t of report.tests) {
      expect(t.id).toBeDefined();
      expect(t.name).toBeDefined();
      expect(t.category).toBeDefined();
      expect(typeof t.passed).toBe("boolean");
      expect(typeof t.required).toBe("boolean");
      expect(typeof t.details).toBe("string");
      expect(typeof t.durationMs).toBe("number");
      expect(t.specRef).toContain("modelcontextprotocol.io");
    }
  }, 15000);

  it("includes onProgress callbacks", async () => {
    const progressCalls: Array<{ testId: string; passed: boolean }> = [];
    await runComplianceSuite(DEAD_URL, {
      only: ["transport-post"],
      timeout: 2000,
      onProgress: (testId, passed) => {
        progressCalls.push({ testId, passed });
      },
    });
    expect(progressCalls).toHaveLength(1);
    expect(progressCalls[0].testId).toBe("transport-post");
    expect(typeof progressCalls[0].passed).toBe("boolean");
  }, 15000);

  it("tracks durationMs for each test", async () => {
    const report = await runComplianceSuite(DEAD_URL, {
      only: ["transport-post"],
      timeout: 2000,
    });
    for (const t of report.tests) {
      expect(t.durationMs).toBeGreaterThanOrEqual(0);
    }
  }, 15000);
});

describe("runComplianceSuite — exports", () => {
  it("exports TEST_DEFINITIONS", async () => {
    const { TEST_DEFINITIONS } = await import("../runner.js");
    expect(Array.isArray(TEST_DEFINITIONS)).toBe(true);
    expect(TEST_DEFINITIONS.length).toBe(48);
    for (const def of TEST_DEFINITIONS) {
      expect(def.id).toBeDefined();
      expect(def.name).toBeDefined();
      expect(def.category).toBeDefined();
      expect(typeof def.required).toBe("boolean");
      expect(def.specRef).toBeDefined();
      expect(def.description).toBeDefined();
    }
  });

  it("exports computeGrade", async () => {
    const { computeGrade } = await import("../runner.js");
    expect(computeGrade(95)).toBe("A");
    expect(computeGrade(80)).toBe("B");
    expect(computeGrade(65)).toBe("C");
    expect(computeGrade(50)).toBe("D");
    expect(computeGrade(20)).toBe("F");
  });

  it("exports computeScore", async () => {
    const { computeScore } = await import("../runner.js");
    expect(typeof computeScore).toBe("function");
  });

  it("exports generateBadge", async () => {
    const { generateBadge } = await import("../runner.js");
    const badge = generateBadge("https://example.com/mcp");
    expect(badge.imageUrl).toContain("mcp.hosting");
    expect(badge.markdown).toContain("MCP Compliant");
  });
});
