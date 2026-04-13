import { describe, expect, it } from "vitest";
import { formatGithub, formatJson, formatMarkdown, formatSarif, formatTerminal } from "../reporter.js";
import type { ComplianceReport } from "../types.js";

function makeReport(overrides: Partial<ComplianceReport> = {}): ComplianceReport {
  return {
    specVersion: "2025-11-25",
    toolVersion: "0.3.0",
    url: "https://example.com/mcp",
    timestamp: "2026-04-07T00:00:00.000Z",
    score: 85,
    grade: "B",
    overall: "partial",
    summary: { total: 10, passed: 8, failed: 2, required: 5, requiredPassed: 5 },
    categories: {
      transport: { passed: 3, total: 3 },
      lifecycle: { passed: 5, total: 7 },
    },
    tests: [
      {
        id: "transport-post",
        name: "HTTP POST accepted",
        category: "transport",
        passed: true,
        required: true,
        details: "HTTP 200",
        durationMs: 42,
      },
      {
        id: "lifecycle-init",
        name: "Initialize handshake",
        category: "lifecycle",
        passed: false,
        required: false,
        details: "No result in response",
        durationMs: 100,
      },
    ],
    warnings: [],
    serverInfo: {
      protocolVersion: "2025-11-25",
      name: "test-server",
      version: "1.0.0",
      capabilities: { tools: {} },
    },
    toolCount: 3,
    toolNames: ["tool_a", "tool_b", "tool_c"],
    resourceCount: 0,
    resourceNames: [],
    promptCount: 0,
    promptNames: [],
    badge: {
      imageUrl: "https://mcp.hosting/api/compliance/test/badge",
      reportUrl: "https://mcp.hosting/compliance/test",
      markdown:
        "[![MCP Compliant](https://mcp.hosting/api/compliance/test/badge)](https://mcp.hosting/compliance/test)",
      html: '<a href="https://mcp.hosting/compliance/test"><img src="https://mcp.hosting/api/compliance/test/badge" alt="MCP Compliant"></a>',
    },
    ...overrides,
    schemaVersion: "1",
  };
}

describe("formatTerminal", () => {
  it("includes grade, score, and overall", () => {
    const output = formatTerminal(makeReport());
    expect(output).toContain("B");
    expect(output).toContain("85");
    expect(output).toContain("PARTIAL");
  });

  it("includes spec version and tool version", () => {
    const output = formatTerminal(makeReport());
    expect(output).toContain("2025-11-25");
    expect(output).toContain("v0.3.0");
  });

  it("includes URL", () => {
    const output = formatTerminal(makeReport());
    expect(output).toContain("https://example.com/mcp");
  });

  it("includes server info", () => {
    const output = formatTerminal(makeReport());
    expect(output).toContain("test-server");
    expect(output).toContain("1.0.0");
  });

  it("includes test counts", () => {
    const output = formatTerminal(makeReport());
    expect(output).toContain("8");
    expect(output).toContain("2");
    expect(output).toContain("10");
  });

  it("includes PASS and FAIL markers", () => {
    const output = formatTerminal(makeReport());
    expect(output).toContain("PASS");
    expect(output).toContain("FAIL");
  });

  it("includes category sections", () => {
    const output = formatTerminal(makeReport());
    expect(output).toContain("Transport");
    expect(output).toContain("Lifecycle");
  });

  it("includes capabilities", () => {
    const output = formatTerminal(makeReport());
    expect(output).toContain("tools");
  });

  it("includes tool names", () => {
    const output = formatTerminal(makeReport());
    expect(output).toContain("tool_a");
    expect(output).toContain("tool_b");
  });

  it("includes badge markdown", () => {
    const output = formatTerminal(makeReport());
    expect(output).toContain("[![MCP Compliant]");
  });

  it("shows warnings when present", () => {
    const output = formatTerminal(makeReport({ warnings: ["Protocol version mismatch"] }));
    expect(output).toContain("Warnings");
    expect(output).toContain("Protocol version mismatch");
  });

  it("hides warnings section when empty", () => {
    const output = formatTerminal(makeReport({ warnings: [] }));
    expect(output).not.toContain("Warnings");
  });

  it("handles PASS overall", () => {
    const output = formatTerminal(makeReport({ overall: "pass" }));
    expect(output).toContain("PASS");
  });

  it("handles FAIL overall", () => {
    const output = formatTerminal(makeReport({ overall: "fail" }));
    expect(output).toContain("FAIL");
  });

  it("shows all grades", () => {
    for (const grade of ["A", "B", "C", "D", "F"] as const) {
      const output = formatTerminal(makeReport({ grade }));
      expect(output).toContain(grade);
    }
  });

  it("truncates long tool lists", () => {
    const names = Array.from({ length: 15 }, (_, i) => `tool_${i}`);
    const output = formatTerminal(makeReport({ toolCount: 15, toolNames: names }));
    expect(output).toContain("...");
  });

  it("handles missing server info", () => {
    const output = formatTerminal(
      makeReport({
        serverInfo: { protocolVersion: null, name: null, version: null, capabilities: {} },
      }),
    );
    expect(output).not.toContain("Server:");
  });

  it("shows fix recommendations for failed tests", () => {
    const output = formatTerminal(
      makeReport({
        tests: [
          {
            id: "lifecycle-init",
            name: "Initialize handshake",
            category: "lifecycle",
            passed: false,
            required: true,
            details: "No result in response",
            durationMs: 100,
          },
        ],
      }),
    );
    expect(output).toContain("Fix:");
  });

  it("does not show fix recommendations for passing tests", () => {
    const output = formatTerminal(
      makeReport({
        tests: [
          {
            id: "transport-post",
            name: "HTTP POST accepted",
            category: "transport",
            passed: true,
            required: true,
            details: "HTTP 200",
            durationMs: 42,
          },
        ],
      }),
    );
    expect(output).not.toContain("Fix:");
  });
});

describe("formatJson", () => {
  it("returns valid JSON", () => {
    const output = formatJson(makeReport());
    const parsed = JSON.parse(output);
    expect(parsed.grade).toBe("B");
    expect(parsed.score).toBe(85);
  });

  it("includes all report fields", () => {
    const output = formatJson(makeReport());
    const parsed = JSON.parse(output);
    expect(parsed.specVersion).toBe("2025-11-25");
    expect(parsed.toolVersion).toBe("0.3.0");
    expect(parsed.url).toBe("https://example.com/mcp");
    expect(parsed.tests).toHaveLength(2);
    expect(parsed.summary.total).toBe(10);
    expect(parsed.badge.markdown).toContain("MCP Compliant");
  });

  it("is pretty-printed", () => {
    const output = formatJson(makeReport());
    expect(output).toContain("\n");
    expect(output).toContain("  ");
  });
});

describe("formatSarif", () => {
  it("returns valid JSON", () => {
    const output = formatSarif(makeReport());
    const parsed = JSON.parse(output);
    expect(parsed.version).toBe("2.1.0");
  });

  it("includes SARIF schema reference", () => {
    const output = formatSarif(makeReport());
    const parsed = JSON.parse(output);
    expect(parsed.$schema).toContain("sarif-schema");
  });

  it("includes tool driver info", () => {
    const output = formatSarif(makeReport());
    const parsed = JSON.parse(output);
    expect(parsed.runs[0].tool.driver.name).toBe("mcp-compliance");
    expect(parsed.runs[0].tool.driver.version).toBe("0.3.0");
  });

  it("includes rules for all tests", () => {
    const output = formatSarif(makeReport());
    const parsed = JSON.parse(output);
    expect(parsed.runs[0].tool.driver.rules).toHaveLength(2);
  });

  it("only includes failed tests in results", () => {
    const output = formatSarif(makeReport());
    const parsed = JSON.parse(output);
    // Only lifecycle-init fails in the default makeReport
    expect(parsed.runs[0].results).toHaveLength(1);
    expect(parsed.runs[0].results[0].ruleId).toBe("lifecycle-init");
  });

  it("marks required failures as error level", () => {
    const output = formatSarif(
      makeReport({
        tests: [
          {
            id: "lifecycle-init",
            name: "Initialize handshake",
            category: "lifecycle",
            passed: false,
            required: true,
            details: "No result",
            durationMs: 100,
          },
        ],
      }),
    );
    const parsed = JSON.parse(output);
    expect(parsed.runs[0].results[0].level).toBe("error");
  });

  it("marks optional failures as warning level", () => {
    const output = formatSarif(
      makeReport({
        tests: [
          {
            id: "lifecycle-server-info",
            name: "Includes serverInfo",
            category: "lifecycle",
            passed: false,
            required: false,
            details: "Missing",
            durationMs: 50,
          },
        ],
      }),
    );
    const parsed = JSON.parse(output);
    expect(parsed.runs[0].results[0].level).toBe("warning");
  });

  it("includes invocation with grade and score", () => {
    const output = formatSarif(makeReport());
    const parsed = JSON.parse(output);
    const inv = parsed.runs[0].invocations[0];
    expect(inv.properties.grade).toBe("B");
    expect(inv.properties.score).toBe(85);
  });

  it("includes server context in invocation properties", () => {
    const output = formatSarif(makeReport());
    const parsed = JSON.parse(output);
    const props = parsed.runs[0].invocations[0].properties;
    expect(props.serverUrl).toBe("https://example.com/mcp");
    expect(props.serverName).toBe("test-server");
    expect(props.serverVersion).toBe("1.0.0");
    expect(props.protocolVersion).toBe("2025-11-25");
    expect(props.testsPassed).toBe(8);
    expect(props.testsTotal).toBe(10);
  });

  it("includes fix recommendations in result messages", () => {
    const output = formatSarif(
      makeReport({
        tests: [
          {
            id: "lifecycle-init",
            name: "Initialize handshake",
            category: "lifecycle",
            passed: false,
            required: true,
            details: "No result",
            durationMs: 100,
          },
        ],
      }),
    );
    const parsed = JSON.parse(output);
    expect(parsed.runs[0].results[0].message.text).toContain("Fix:");
  });

  it("returns no results when all tests pass", () => {
    const output = formatSarif(
      makeReport({
        tests: [
          {
            id: "transport-post",
            name: "HTTP POST accepted",
            category: "transport",
            passed: true,
            required: true,
            details: "HTTP 200",
            durationMs: 42,
          },
        ],
      }),
    );
    const parsed = JSON.parse(output);
    expect(parsed.runs[0].results).toHaveLength(0);
  });
});

describe("formatGithub", () => {
  it("emits ::error for failed required tests and ::warning for failed optional tests", () => {
    const output = formatGithub(
      makeReport({
        tests: [
          {
            id: "transport-post",
            name: "HTTP POST",
            category: "transport",
            passed: false,
            required: true,
            details: "HTTP 500",
            durationMs: 10,
          },
          {
            id: "tools-pagination",
            name: "Pagination",
            category: "tools",
            passed: false,
            required: false,
            details: "no nextCursor",
            durationMs: 5,
          },
          {
            id: "lifecycle-ping",
            name: "Ping",
            category: "lifecycle",
            passed: true,
            required: true,
            details: "ok",
            durationMs: 1,
          },
        ],
      }),
    );
    expect(output).toContain("::error title=transport-post::HTTP 500");
    expect(output).toContain("::warning title=tools-pagination::no nextCursor");
    expect(output).not.toContain("lifecycle-ping");
  });

  it("always emits a ::notice summary line with grade and counts", () => {
    const output = formatGithub(makeReport());
    // % is URL-encoded as %25 per GitHub Actions workflow command rules
    expect(output).toMatch(/::notice title=MCP Compliance::Grade B \(85%25\)/);
  });

  it("escapes %, \\r, and \\n in titles and messages", () => {
    const output = formatGithub(
      makeReport({
        tests: [
          {
            id: "evil",
            name: "x",
            category: "errors",
            passed: false,
            required: true,
            details: "first\nsecond\rthird %literal",
            durationMs: 1,
          },
        ],
      }),
    );
    expect(output).toContain("first%0Asecond%0Dthird %25literal");
  });
});

describe("formatMarkdown", () => {
  it("includes a header with grade and target", () => {
    const output = formatMarkdown(makeReport());
    expect(output).toContain("# MCP Compliance Report");
    expect(output).toContain("**Grade:");
    expect(output).toContain("B (85%)");
    expect(output).toContain("`https://example.com/mcp`");
  });

  it("renders a per-category summary table", () => {
    const output = formatMarkdown(makeReport());
    expect(output).toContain("| Category | Passed | Total |");
    expect(output).toContain("| Transport | 3 | 3 |");
    expect(output).toContain("| Lifecycle | 5 | 7 |");
  });

  it("lists failed tests with id and details", () => {
    const output = formatMarkdown(makeReport());
    expect(output).toContain("## Failed tests (1)");
    expect(output).toContain("**lifecycle-init**");
  });

  it("omits the failed tests section when none failed", () => {
    const output = formatMarkdown(
      makeReport({
        tests: [
          {
            id: "lifecycle-ping",
            name: "Ping",
            category: "lifecycle",
            passed: true,
            required: true,
            details: "ok",
            durationMs: 1,
          },
        ],
      }),
    );
    expect(output).not.toContain("## Failed tests");
  });

  it("includes the badge section for HTTP targets", () => {
    const output = formatMarkdown(makeReport());
    expect(output).toContain("## Badge");
    expect(output).toContain("MCP Compliant");
  });

  it("omits the badge section for stdio targets (no public URL)", () => {
    const output = formatMarkdown(makeReport({ url: "stdio:node ./server.js" }));
    expect(output).not.toContain("## Badge");
  });
});

describe("formatTerminal — stdio targets", () => {
  it("does not print badge markdown for stdio (would render unknown)", () => {
    const output = formatTerminal(makeReport({ url: "stdio:node ./server.js" }));
    expect(output).not.toContain("Badge markdown:");
    expect(output).toContain("--output");
  });

  it("still prints badge markdown for HTTP targets", () => {
    const output = formatTerminal(makeReport());
    expect(output).toContain("Badge markdown:");
  });
});
