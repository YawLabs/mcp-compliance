import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeScore } from "../grader.js";
import { formatGithub, formatHtml, formatJson, formatMarkdown, formatSarif, formatTerminal } from "../reporter.js";
import { runComplianceSuite } from "../runner.js";
import type { ComplianceReport, TestResult } from "../types.js";
import { type HttpFixture, startHttpFixture } from "./helpers/modern-fixture.js";

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

  it("includes failed-test markers", () => {
    const output = formatTerminal(makeReport());
    // Failed tests get a ✗ marker plus the FAILED TESTS section header
    expect(output).toContain("✗");
    expect(output).toContain("FAILED");
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

  it("includes the local-badge hint", () => {
    const output = formatTerminal(makeReport());
    expect(output).toContain("--output");
  });

  it("shows warnings when present", () => {
    const output = formatTerminal(makeReport({ warnings: ["Protocol version mismatch"] }));
    expect(output).toMatch(/WARNINGS|Warnings/);
    expect(output).toContain("Protocol version mismatch");
  });

  it("hides warnings section when empty", () => {
    const output = formatTerminal(makeReport({ warnings: [] }));
    expect(output).not.toMatch(/WARNINGS|Warnings/);
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
    expect(output).toContain(`Implement the "initialize" method handler`);
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
    expect(output).not.toContain("→");
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

  it("always emits a ::notice summary line with grade, counts and the spec version", () => {
    const output = formatGithub(makeReport());
    // % is URL-encoded as %25 per GitHub Actions workflow command rules
    expect(output).toMatch(/::notice title=MCP Compliance::Grade B \(85%25\)/);
    expect(output).toContain("(5/5 required); spec 2025-11-25");
  });

  it("emits every report warning as a ::warning titled mcp-compliance", () => {
    // The Action defaults to this format, so without these the dual-era,
    // pinned-mismatch, unreachable and "pass --auth" notes never reached
    // a PR.
    const output = formatGithub(
      makeReport({
        warnings: [
          "Server is dual-era (also advertises 2025-11-25); this run graded 2026-07-28. Re-run with --spec-version 2025-11-25 to test the legacy handshake.",
          "Server at https://example.com/mcp requires authentication\nline two",
        ],
      }),
    );
    const lines = output.split("\n");
    expect(lines).toContain(
      "::warning title=mcp-compliance::Server is dual-era (also advertises 2025-11-25); this run graded 2026-07-28. Re-run with --spec-version 2025-11-25 to test the legacy handshake.",
    );
    expect(lines).toContain(
      "::warning title=mcp-compliance::Server at https://example.com/mcp requires authentication%0Aline two",
    );
    // Failure annotations keep their own titles (the test id).
    expect(lines).toContain("::warning title=lifecycle-init::No result in response");
  });

  it("folds the auto-detection note into the ::notice instead of a ::warning", () => {
    const output = formatGithub(
      makeReport({
        specVersion: "2026-07-28",
        warnings: [
          "Spec version auto-detected as 2026-07-28 (server/discover -> supportedVersions [2026-07-28]). Pin with --spec-version to override.",
        ],
      }),
    );
    expect(output).not.toContain("::warning title=mcp-compliance");
    expect(output).toContain("; spec 2026-07-28 (auto-detected from server/discover: supportedVersions [2026-07-28])");
  });

  it("an empty run says no tests ran instead of Grade F 0/0", () => {
    const empty = makeReport({
      specVersion: "2026-07-28",
      score: 0,
      grade: "F",
      overall: "fail",
      summary: { total: 0, passed: 0, failed: 0, required: 0, requiredPassed: 0 },
      categories: {},
      tests: [],
      warnings: ['Filter value(s) "lifecycle-init" match no test id or category in the 2026-07-28 catalog'],
    });
    const output = formatGithub(empty);
    expect(output).toContain(
      "::notice title=MCP Compliance::No tests ran -- check --only/--skip (see warnings); spec 2026-07-28",
    );
    expect(output).not.toContain("Grade F");
    expect(output).toContain('::warning title=mcp-compliance::Filter value(s) "lifecycle-init"');
    // Without a warning to point at, no "(see warnings)".
    expect(formatGithub({ ...empty, warnings: [] })).toContain(
      "::notice title=MCP Compliance::No tests ran -- check --only/--skip; spec 2026-07-28",
    );
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

  it("no longer emits a hosted badge section", () => {
    const output = formatMarkdown(makeReport());
    expect(output).not.toContain("## Badge");
  });
});

describe("formatTerminal — stdio targets", () => {
  it("prints the local-badge hint, not dead hosted markdown", () => {
    const output = formatTerminal(makeReport({ url: "stdio:node ./server.js" }));
    expect(output).not.toContain("[![MCP Compliant]");
    expect(output).toContain("--output");
  });
});

/**
 * Per-spec catalogs. A report's ids belong to the catalog of the spec
 * version it was produced with: a 2026-only id must get its recommendation
 * under a 2026 report and NOT under a 2025 one, and a shared id must get
 * the recommendation of the report's own era.
 */
describe("per-spec catalog lookups", () => {
  const discoverFailure: TestResult = {
    id: "lifecycle-discover",
    name: "server/discover returns DiscoverResult",
    category: "lifecycle",
    passed: false,
    required: true,
    details: "-32601 method not found",
    durationMs: 12,
  };
  const postFailure: TestResult = {
    id: "transport-post",
    name: "HTTP POST accepted",
    category: "transport",
    passed: false,
    required: true,
    details: "HTTP 404",
    durationMs: 8,
  };

  function modernReport(overrides: Partial<ComplianceReport> = {}): ComplianceReport {
    return makeReport({
      specVersion: "2026-07-28",
      serverInfo: {
        protocolVersion: "2026-07-28",
        name: "modern-server",
        version: "2.0.0",
        capabilities: { tools: {} },
      },
      tests: [discoverFailure],
      ...overrides,
    });
  }

  describe("formatSarif", () => {
    it("stamps automationDetails.id with the report's spec version (trailing slash)", () => {
      expect(JSON.parse(formatSarif(modernReport())).runs[0].automationDetails).toEqual({
        id: "mcp-compliance/2026-07-28/",
      });
      expect(JSON.parse(formatSarif(makeReport())).runs[0].automationDetails).toEqual({
        id: "mcp-compliance/2025-11-25/",
      });
    });

    it("keeps the existing invocation properties next to automationDetails", () => {
      const run = JSON.parse(formatSarif(modernReport())).runs[0];
      expect(run.invocations[0].properties.specVersion).toBe("2026-07-28");
      expect(run.invocations[0].properties.protocolVersion).toBe("2026-07-28");
      expect(run.invocations[0].properties.serverName).toBe("modern-server");
    });

    it("falls back to the spec base of the report's version when a result has no specRef", () => {
      const modernRule = JSON.parse(formatSarif(modernReport())).runs[0].tool.driver.rules[0];
      expect(modernRule.helpUri).toBe("https://modelcontextprotocol.io/specification/2026-07-28/basic");
      const legacyRule = JSON.parse(formatSarif(makeReport())).runs[0].tool.driver.rules[0];
      expect(legacyRule.helpUri).toBe("https://modelcontextprotocol.io/specification/2025-11-25/basic");
    });

    it("prefers the result's own absolute specRef over the fallback", () => {
      const ref = "https://modelcontextprotocol.io/specification/2026-07-28/server/discover#response";
      const rule = JSON.parse(formatSarif(modernReport({ tests: [{ ...discoverFailure, specRef: ref }] }))).runs[0].tool
        .driver.rules[0];
      expect(rule.helpUri).toBe(ref);
    });

    it("gives a 2026-only id its recommendation and description under a 2026 report", () => {
      const run = JSON.parse(formatSarif(modernReport())).runs[0];
      expect(run.results[0].ruleId).toBe("lifecycle-discover");
      expect(run.results[0].message.text).toContain("Fix: Implement a server/discover handler");
      expect(run.tool.driver.rules[0].fullDescription.text).toContain("Servers MUST implement server/discover");
    });

    it("does not give a 2026-only id a recommendation under a 2025 report", () => {
      // Same failing result, only the report's specVersion differs.
      const run = JSON.parse(formatSarif(makeReport({ tests: [discoverFailure] }))).runs[0];
      expect(run.results[0].ruleId).toBe("lifecycle-discover");
      expect(run.results[0].message.text).toBe(discoverFailure.details);
      expect(run.results[0].message.text).not.toContain("Fix:");
      // With no catalog entry the rule description falls back to the details.
      expect(run.tool.driver.rules[0].fullDescription.text).toBe(discoverFailure.details);
    });

    it("uses the report era's recommendation for an id shared by both catalogs", () => {
      const modern = JSON.parse(formatSarif(modernReport({ tests: [postFailure] }))).runs[0].results[0].message.text;
      const legacy = JSON.parse(formatSarif(makeReport({ tests: [postFailure] }))).runs[0].results[0].message.text;
      expect(modern).toContain("answer a well-formed server/discover with 200");
      expect(modern).not.toContain("Ensure your server listens for POST requests");
      expect(legacy).toContain("Ensure your server listens for POST requests");
      expect(legacy).not.toContain("server/discover");
    });

    it("treats a report with no specVersion as a 2025-11-25 report", () => {
      const legacy = makeReport({ tests: [{ ...postFailure }] });
      // Older reports predate the field; the reporter must not throw or lose recommendations.
      const stripped = { ...legacy, specVersion: undefined } as unknown as ComplianceReport;
      const run = JSON.parse(formatSarif(stripped)).runs[0];
      expect(run.automationDetails.id).toBe("mcp-compliance/2025-11-25/");
      expect(run.tool.driver.rules[0].helpUri).toBe("https://modelcontextprotocol.io/specification/2025-11-25/basic");
      expect(run.results[0].message.text).toContain("Ensure your server listens for POST requests");
    });

    it("keeps an unrecognised specVersion in automationDetails but reads the 2025 catalog", () => {
      const run = JSON.parse(formatSarif(makeReport({ specVersion: "2025-06-18", tests: [postFailure] }))).runs[0];
      expect(run.automationDetails.id).toBe("mcp-compliance/2025-06-18/");
      expect(run.results[0].message.text).toContain("Ensure your server listens for POST requests");
    });
  });

  describe("formatTerminal", () => {
    it("shows the 2026 recommendation for a 2026-only id under a 2026 report", () => {
      const output = formatTerminal(modernReport());
      expect(output).toContain("2026-07-28");
      expect(output).toContain("→ Implement a server/discover handler");
    });

    it("shows no recommendation for a 2026-only id under a 2025 report", () => {
      const output = formatTerminal(makeReport({ tests: [discoverFailure] }));
      expect(output).toContain("-32601 method not found");
      expect(output).not.toContain("→");
    });

    it("picks the report era's recommendation for a shared id", () => {
      const modern = formatTerminal(modernReport({ tests: [postFailure] }));
      const legacy = formatTerminal(makeReport({ tests: [postFailure] }));
      expect(modern).toContain("answer a well-formed server/discover with 200");
      expect(modern).not.toContain("Ensure your server listens for POST requests");
      expect(legacy).toContain("Ensure your server listens for POST requests");
      expect(legacy).not.toContain("server/discover");
    });
  });

  it("markdown and html print the 2026 spec version unchanged", () => {
    expect(formatMarkdown(modernReport())).toContain("- **Spec:** 2026-07-28");
    expect(formatHtml(modernReport())).toContain("Spec 2026-07-28");
  });
});

/** Visible width of a terminal line: ANSI colour codes (ESC [ ... m) stripped. */
function visibleWidth(line: string): number {
  const esc = String.fromCharCode(27);
  return line.split(esc).reduce((acc, part, i) => acc + (i === 0 ? part : part.replace(/^\[[0-9;]*m/, "")), "").length;
}

describe("auto-detection note placement", () => {
  const note =
    "Spec version auto-detected as 2026-07-28 (server/discover -> supportedVersions [2026-07-28]). Pin with --spec-version to override.";
  const report = makeReport({ specVersion: "2026-07-28", warnings: [note, 'Resource "x" missing description'] });

  it("terminal: the note sits under Spec:, not in WARNINGS, and the count excludes it", () => {
    const out = formatTerminal(report);
    expect(out).toContain("            auto-detected from server/discover: supportedVersions [2026-07-28]");
    // The pin hint lives in --help; it is not repeated on the header line.
    expect(out).not.toContain("pin with --spec-version");
    expect(out).toContain("WARNINGS (1)");
    expect(out).not.toContain("! Spec version auto-detected");
  });

  it.each([
    ["modern, one version", "server/discover -> supportedVersions [2026-07-28]"],
    ["legacy, -32601", "server/discover -> JSON-RPC error -32601, legacy"],
    ["legacy, silent", "server/discover -> no response, legacy"],
    ["legacy, HTTP 404", "server/discover -> HTTP 404, legacy"],
    ["modern error", "server/discover -> modern error -32022"],
  ])("terminal: the header line for %s fits in 80 columns", (_label, reason) => {
    const out = formatTerminal(
      makeReport({
        warnings: [`Spec version auto-detected as 2026-07-28 (${reason}). Pin with --spec-version to override.`],
      }),
    );
    const line = out.split("\n").find((l) => l.includes("auto-detected from server/discover"));
    expect(line).toBeDefined();
    expect(visibleWidth(line as string), line).toBeLessThanOrEqual(80);
  });

  it("markdown and html: the note is appended to the spec line and dropped from the warnings", () => {
    const md = formatMarkdown(report);
    expect(md).toContain("- **Spec:** 2026-07-28 (auto-detected from server/discover: supportedVersions [2026-07-28])");
    expect(md).not.toContain("- Spec version auto-detected");
    const html = formatHtml(report);
    expect(html).toContain("Spec 2026-07-28 (auto-detected from server/discover: supportedVersions [2026-07-28])");
    expect(html).toContain("Warnings (1)");
  });

  it("a note whose reason lacks the server/discover prefix (an older report) is shown verbatim", () => {
    const old = makeReport({
      warnings: [
        "Spec version auto-detected as 2025-11-25 (server/discover probe got no response; treating the server as legacy). Pin with --spec-version to override.",
      ],
    });
    const out = formatTerminal(old);
    expect(out).toContain("auto-detected: server/discover probe got no response; treating the server as legacy");
    expect(out).not.toContain("WARNINGS");
  });

  it("json keeps the note as a warning for machine consumers", () => {
    expect(JSON.parse(formatJson(report)).warnings).toContain(note);
  });

  it("a report without the note renders unchanged", () => {
    const out = formatTerminal(makeReport({ warnings: ["only a real warning"] }));
    expect(out).not.toContain("auto-detected");
    expect(out).toContain("WARNINGS (1)");
  });
});

describe("empty run (nothing matched --only/--skip)", () => {
  const empty = makeReport({
    score: 0,
    grade: "F",
    overall: "fail",
    summary: { total: 0, passed: 0, failed: 0, required: 0, requiredPassed: 0 },
    categories: {},
    tests: [],
    warnings: ['Filter value(s) "lifecycle-init" match no test id or category in the 2026-07-28 catalog'],
  });

  it("terminal: says no tests ran instead of 'All tests passed'", () => {
    const out = formatTerminal(empty);
    expect(out).toContain("No tests ran -- check --only/--skip (see warnings)");
    expect(out).not.toContain("All tests passed");
    expect(out).toContain("WARNINGS (1)");
    expect(out).toContain('"lifecycle-init"');
  });

  it("terminal: '(see warnings)' only when there is a WARNINGS section, and 'Required 0/0' gets no check mark", () => {
    // A valid id gated off the transport used to produce this shape with
    // no warning at all (now the runner warns), and any other zero-test
    // run must not point at an absent section.
    const out = formatTerminal({ ...empty, warnings: [] });
    expect(out).toContain("No tests ran -- check --only/--skip");
    expect(out).not.toContain("(see warnings)");
    expect(out).not.toContain("WARNINGS");
    expect(out).not.toContain("0/0 ✓");
    expect(formatTerminal(empty)).not.toContain("0/0 ✓");
  });

  it("terminal: a run where every test passed still says so", () => {
    const allPass = makeReport({
      summary: { total: 1, passed: 1, failed: 0, required: 1, requiredPassed: 1 },
      tests: [makeReport().tests[0]],
    });
    expect(formatTerminal(allPass)).toContain("All tests passed");
    expect(formatTerminal(allPass)).not.toContain("No tests ran");
  });
});

const REPORT_SCHEMA_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../schemas/report.v1.json");
const schemaAjv = new Ajv2020({ strict: true, allErrors: true });
addFormats(schemaAjv);
const validateReport = schemaAjv.compile(JSON.parse(readFileSync(REPORT_SCHEMA_PATH, "utf8")));

/** "valid", or the schema errors as JSON so a failing assertion shows them. */
function schemaCheck(report: unknown): string {
  return validateReport(report) ? "valid" : JSON.stringify(validateReport.errors);
}

/** A report whose score and counts are what computeScore gives for its tests. */
function reportOf(tests: TestResult[]): ComplianceReport {
  const s = computeScore(tests);
  return makeReport({
    score: s.score,
    grade: s.grade,
    overall: s.overall,
    summary: s.summary,
    categories: s.categories,
    tests,
  });
}

/** The same report as a tool without the skip flag would have written it. */
function unflagged(report: ComplianceReport): ComplianceReport {
  const { skipped: _s, ...summary } = report.summary;
  return {
    ...report,
    summary,
    categories: Object.fromEntries(
      Object.entries(report.categories).map(([k, { passed, total }]) => [k, { passed, total }]),
    ),
    tests: report.tests.map(({ skipped: _t, ...t }) => t),
  };
}

/**
 * An SDK v1 sessionful McpServer behind the SDK's own Host guard
 * (hostHeaderValidation), allowing only `allowed`. The guard is
 * Express-shaped; `status` / `json` are the two response methods it calls.
 */
async function startSdkBehindHostGuard(allowed: string[]): Promise<{ url: string; stop(): Promise<void> }> {
  const guard = hostHeaderValidation(allowed);
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let passed = false;
    const expressRes = Object.assign(res, {
      status(code: number) {
        res.statusCode = code;
        return expressRes;
      },
      json(body: unknown) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(body));
      },
    });
    guard(req as never, expressRes as never, () => {
      passed = true;
    });
    if (!passed) return;
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const known = sessionId ? transports.get(sessionId) : undefined;
    if (known) {
      await known.handleRequest(req, res);
      return;
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    const mcp = new McpServer({ name: "host-guarded", version: "1.0.0" });
    mcp.tool("echo", "Echoes back the input", async () => ({ content: [{ type: "text", text: "ok" }] }));
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
    if (transport.sessionId) transports.set(transport.sessionId, transport);
  });
  const url = await new Promise<string>((done) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      done(`http://127.0.0.1:${addr && typeof addr === "object" ? addr.port : 0}/mcp`);
    });
  });
  return {
    url,
    async stop() {
      for (const t of transports.values()) await t.close().catch(() => {});
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

/**
 * Skipped checks: `passed: true` (not failures) that measured nothing.
 * Before the flag existed a skip was indistinguishable from a pass in
 * every format -- the terminal listed only failures, so a gated server
 * whose auth checks could not be evaluated read as if it had satisfied
 * them. Each format now names them and says the score leaves them out.
 */
describe("skipped checks", () => {
  const plain = (s: string) => stripVTControlCharacters(s);
  const pass: TestResult = {
    id: "security-auth-required",
    name: "Server requires authentication",
    category: "security",
    passed: true,
    required: false,
    details: "HTTP 401 (unauthenticated request rejected)",
    durationMs: 5,
  };
  const fail: TestResult = {
    id: "security-tls-required",
    name: "HTTPS required",
    category: "security",
    passed: false,
    required: false,
    details: "Server uses plain HTTP",
    durationMs: 1,
  };
  const skipA: TestResult = {
    id: "security-www-authenticate",
    name: "WWW-Authenticate on 401",
    category: "security",
    passed: true,
    skipped: true,
    required: false,
    details: "Skipped: not evaluable (see security-auth-required)",
    durationMs: 3,
  };
  const skipB: TestResult = {
    id: "security-token-in-uri",
    name: "Rejects token in URI",
    category: "security",
    passed: true,
    skipped: true,
    required: true,
    details: "Skipped: needs a valid credential to place in the URI (pass --auth)",
    durationMs: 2,
  };

  const mixed = reportOf([pass, fail, skipA, skipB]);

  describe("terminal", () => {
    it("counts the skips next to the failures and on the category bar", () => {
      const out = plain(formatTerminal(mixed));
      expect(out).toMatch(/Tests {5}3\/4 {2}\(1 failed, 2 skipped\)/);
      // The ratio keeps the pass total; the bar and percentage count what
      // was measured, as the score does: 1 pass of 2 measured, 50% (it
      // read 75% while skips scored as passes).
      expect(out).toMatch(/Security {2}█{12}░{12} +3\/4 +50% {2}2 skipped$/m);
    });

    it("a category bar scores what was measured: 18/23 with 16 skips reads 29%, the same as the grade of an --only run", () => {
      const tests: TestResult[] = [
        ...Array.from({ length: 16 }, (_, i) => ({ ...skipA, id: `s${i}` })),
        { ...pass, id: "p0" },
        { ...pass, id: "p1" },
        ...Array.from({ length: 5 }, (_, i) => ({ ...fail, id: `f${i}` })),
      ];
      const report = reportOf(tests);
      expect([report.score, report.grade]).toEqual([29, "F"]);
      const out = plain(formatTerminal(report));
      // round(2/7 * 24) = 7 cells filled.
      expect(out).toMatch(/Security {2}█{7}░{17} +18\/23 +29% {2}16 skipped$/m);
      expect(out).not.toMatch(/Security .* 78%/);
    });

    it("a category in which every check skipped reads '--' over an empty dim bar, not a full bar at 100%", () => {
      const out = plain(formatTerminal(reportOf([skipA, skipB])));
      expect(out).toMatch(/Security {2}─{24} +2\/2 +-- {2}2 skipped$/m);
      expect(out).not.toContain("100%");
    });

    it("a category without skips keeps its bar and percentage (older reports too)", () => {
      const out = plain(formatTerminal(reportOf([pass, fail])));
      expect(out).toMatch(/Security {2}█{12}░{12} +1\/2 +50%$/m);
      // No flags: raw counts, as before skips were tracked.
      expect(plain(formatTerminal(unflagged(mixed)))).toMatch(/Security {2}█{18}░{6} +3\/4 +75%$/m);
    });

    it("names every skipped check with its details, under a caveat that the score leaves them out", () => {
      const out = plain(formatTerminal(mixed));
      expect(out).toContain("SKIPPED CHECKS (2)");
      expect(out).toContain("These measured nothing -- left out of the score above.");
      expect(out).toContain("- WWW-Authenticate on 401  [security-www-authenticate]  optional");
      expect(out).toContain("      Skipped: not evaluable (see security-auth-required)");
      expect(out).toContain("- Rejects token in URI  [security-token-in-uri]  required");
      // Skips are not failures, and a plain pass is in neither list.
      const failedBlock = out.slice(out.indexOf("FAILED TESTS"), out.indexOf("SKIPPED CHECKS"));
      expect(failedBlock).toContain("[security-tls-required]");
      expect(failedBlock).not.toContain("[security-www-authenticate]");
      expect(out).not.toContain("[security-auth-required]");
    });

    it("does not say 'All tests passed' when nothing failed but something was skipped", () => {
      const out = plain(formatTerminal(reportOf([pass, skipA])));
      expect(out).not.toContain("All tests passed");
      expect(out).toContain("✓ No test failed -- 1 skipped, see below");
      expect(out).toContain("SKIPPED CHECKS (1)");
    });

    it("renders a report without skips exactly as a report without the flag (pinned: clean runs do not change)", () => {
      const clean = reportOf([pass, fail]);
      expect(formatTerminal(clean)).toBe(formatTerminal(unflagged(clean)));
      const out = plain(formatTerminal(clean));
      expect(out).not.toContain("skipped");
      expect(out).not.toContain("SKIPPED");
      expect(plain(formatTerminal(reportOf([pass])))).toContain("✓ All tests passed");
    });

    it("reads a report from an older tool (no flags, no counts) as having no skips", () => {
      const out = plain(formatTerminal(unflagged(mixed)));
      expect(out).not.toContain("SKIPPED CHECKS");
      expect(out).toMatch(/Tests {5}3\/4 {2}\(1 failed\)/);
    });

    it("never lists a failure as a skip, even one carrying the flag", () => {
      const out = plain(formatTerminal(reportOf([{ ...fail, skipped: true }])));
      expect(out).toContain("FAILED TESTS (1)");
      expect(out).not.toContain("SKIPPED CHECKS");
    });
  });

  describe("json", () => {
    it("carries the flag on each skip and the counts in summary and categories, and validates against report.v1", () => {
      const parsed = JSON.parse(formatJson(mixed));
      expect(parsed.tests.map((t: TestResult) => [t.id, t.passed, t.skipped])).toEqual([
        ["security-auth-required", true, undefined],
        ["security-tls-required", false, undefined],
        ["security-www-authenticate", true, true],
        ["security-token-in-uri", true, true],
      ]);
      expect(parsed.summary).toEqual({ total: 4, passed: 3, failed: 1, required: 1, requiredPassed: 1, skipped: 2 });
      expect(parsed.categories).toEqual({ security: { passed: 3, total: 4, skipped: 2 } });
      expect(parsed.schemaVersion).toBe("1");
      expect(schemaCheck(parsed)).toBe("valid");
    });

    it("a report without any of the new fields still validates (the schema change is additive)", () => {
      expect(schemaCheck(JSON.parse(formatJson(unflagged(mixed))))).toBe("valid");
    });

    it("the schema rejects a failure marked as a skip, a non-boolean flag and a negative count", () => {
      const bad = JSON.parse(formatJson(mixed));
      bad.tests[1].skipped = true;
      expect(schemaCheck(bad)).toMatch(/must be equal to constant/);
      const notBool = JSON.parse(formatJson(mixed));
      notBool.tests[2].skipped = "yes";
      expect(schemaCheck(notBool)).toMatch(/must be boolean/);
      const negative = JSON.parse(formatJson(mixed));
      negative.summary.skipped = -1;
      expect(schemaCheck(negative)).toMatch(/must be >= 0/);
      // `skipped: false` is legal: absent and false mean the same.
      const explicitFalse = JSON.parse(formatJson(mixed));
      explicitFalse.tests[1].skipped = false;
      expect(schemaCheck(explicitFalse)).toBe("valid");
    });
  });

  describe("sarif", () => {
    it("keeps results failures-only, so Code Scanning opens no alert for a skip", () => {
      const run = JSON.parse(formatSarif(mixed)).runs[0];
      expect(run.results.map((r: { ruleId: string }) => r.ruleId)).toEqual(["security-tls-required"]);
      expect(run.results).toEqual(JSON.parse(formatSarif(unflagged(mixed))).runs[0].results);
    });

    it("names the skips in the invocation properties", () => {
      const props = JSON.parse(formatSarif(mixed)).runs[0].invocations[0].properties;
      expect(props.testsPassed).toBe(3);
      expect(props.testsTotal).toBe(4);
      expect(props.testsSkipped).toBe(2);
      expect(props.skippedTests).toEqual([
        { id: "security-www-authenticate", details: "Skipped: not evaluable (see security-auth-required)" },
        { id: "security-token-in-uri", details: "Skipped: needs a valid credential to place in the URI (pass --auth)" },
      ]);
    });

    it("an older report reads as zero skips", () => {
      const props = JSON.parse(formatSarif(unflagged(mixed))).runs[0].invocations[0].properties;
      expect(props.testsSkipped).toBe(0);
      expect(props.skippedTests).toEqual([]);
    });
  });

  describe("github", () => {
    it("puts the skip count in the ::notice and adds no annotation per skip", () => {
      const out = formatGithub(mixed);
      expect(out).toContain("3/4 passed, 1 failed, 2 skipped (1/1 required)");
      expect(out).not.toContain("security-www-authenticate");
      expect(out.split("\n").filter((l) => l.startsWith("::error") || l.startsWith("::warning"))).toHaveLength(1);
    });

    it("a run without skips keeps the old notice", () => {
      expect(formatGithub(reportOf([pass, fail]))).toContain("1/2 passed, 1 failed (0/0 required)");
    });
  });

  describe("markdown", () => {
    it("says under the table how many passes measured nothing and lists them in their own section", () => {
      const out = formatMarkdown(mixed);
      expect(out).toContain('_2 of those passes measured nothing -- see "Skipped checks" below._');
      expect(out).toContain("## Skipped checks (2)");
      expect(out).toContain("These measured nothing -- left out of the score above.");
      expect(out).toContain("- ⊘ **security-www-authenticate** — Skipped: not evaluable (see security-auth-required)");
      expect(out).toContain(
        "- ⊘ **security-token-in-uri** *(required)* — Skipped: needs a valid credential to place in the URI (pass --auth)",
      );
      const failedSection = out.slice(out.indexOf("## Failed tests"), out.indexOf("## Skipped checks"));
      expect(failedSection).toContain("security-tls-required");
      expect(failedSection).not.toContain("security-www-authenticate");
    });

    it("a category row says how many of its passes were skips, as the terminal bars and HTML cards do", () => {
      const lines = formatMarkdown(
        reportOf([pass, fail, skipA, skipB, { ...pass, id: "transport-post", category: "transport" }]),
      ).split("\n");
      expect(lines).toContain("| Security | 3 (2 skipped) | 4 |");
      // A category without skips, and the Total row, keep their old cells.
      expect(lines).toContain("| Transport | 1 | 1 |");
      expect(lines).toContain("| **Total** | **4** | **5** |");
      // An older report (no flags) reads as having no skips.
      expect(formatMarkdown(unflagged(mixed)).split("\n")).toContain("| Security | 3 | 4 |");
    });

    it("a report without skips renders exactly as before", () => {
      const clean = reportOf([pass, fail]);
      expect(formatMarkdown(clean)).toBe(formatMarkdown(unflagged(clean)));
      expect(formatMarkdown(clean)).not.toContain("Skipped");
      expect(formatMarkdown(clean).split("\n")).toContain("| Security | 1 | 2 |");
    });
  });

  describe("html", () => {
    it("marks a skip SKIP (not PASS) in the per-category table and lists the skips in their own card", () => {
      const out = formatHtml(mixed);
      expect(out.match(/<td class="status skip">SKIP<\/td>/g)).toHaveLength(4);
      expect(out.match(/<td class="status pass">PASS<\/td>/g)).toHaveLength(1);
      expect(out).toContain("<h2>Skipped checks (2)</h2>");
      expect(out).toContain("3 / 4 tests passed · 1 / 1 required · 2 skipped");
      expect(out).toContain('<div class="cat-label">2 skipped</div>');
    });

    it("colours a category card by what it measured: skips are left out, and an all-skipped category is neutral, not green", () => {
      // 3/4 with 2 skips is 1 of 2 measured: partial (it was "partial" by
      // the raw counts too, but for a different reason).
      expect(formatHtml(mixed)).toContain('<div class="cat-stat partial">3/4</div>');
      // 2 passes, both skips: nothing measured. By the raw counts it was "full".
      const allSkipped = formatHtml(reportOf([skipA, skipB]));
      expect(allSkipped).toContain('<div class="cat-stat none">2/2</div>');
      expect(allSkipped).not.toContain("cat-stat full");
      // A measured pass next to skips is full; a measured failure next to them is empty.
      expect(formatHtml(reportOf([pass, skipA]))).toContain('<div class="cat-stat full">2/2</div>');
      expect(formatHtml(reportOf([fail, skipA]))).toContain('<div class="cat-stat empty">1/2</div>');
      // Without flags the raw counts decide, as before.
      expect(formatHtml(unflagged(reportOf([skipA, skipB])))).toContain('<div class="cat-stat full">2/2</div>');
    });

    it("a report without skips renders exactly as before", () => {
      const clean = reportOf([pass, fail]);
      expect(formatHtml(clean)).toBe(formatHtml(unflagged(clean)));
      expect(formatHtml(clean)).not.toContain("SKIP");
    });
  });

  /**
   * Every test that ran was a skip. The score leaves skips out, so there
   * is nothing to score: 0 / F with nothing failed. The terminal, GitHub,
   * markdown and HTML reports and the SARIF invocation properties say so
   * in the same words, naming the count, so the F cannot read as a server
   * that failed everything (as an empty run says "No tests ran"). The
   * JSON report carries no prose; its counts show it.
   */
  describe("every test skipped", () => {
    const allSkipped = reportOf([skipA, skipB]);
    const NOTE = "No test measured anything -- all 2 that ran were skipped, and skips are left out of the score";

    it("scores 0 / F, while overall stays pass (nothing failed) and the counts keep the skips as passes", () => {
      expect(allSkipped.score).toBe(0);
      expect(allSkipped.grade).toBe("F");
      expect(allSkipped.overall).toBe("pass");
      expect(allSkipped.summary).toEqual({
        total: 2,
        passed: 2,
        failed: 0,
        required: 1,
        requiredPassed: 1,
        skipped: 2,
      });
      expect(schemaCheck(JSON.parse(formatJson(allSkipped)))).toBe("valid");
    });

    it("terminal: says nothing was measured instead of 'No test failed', and still lists the skips", () => {
      const out = plain(formatTerminal(allSkipped));
      expect(out).toContain(`! ${NOTE} (see SKIPPED CHECKS below)`);
      expect(out).toMatch(/GRADE +F +0%/);
      expect(out).not.toContain("No test failed");
      expect(out).not.toContain("All tests passed");
      expect(out).not.toContain("No tests ran");
      expect(out).toContain("SKIPPED CHECKS (2)");
      expect(out).toContain("These measured nothing -- left out of the score above.");
    });

    it("github: the ::notice carries the note in place of the counts", () => {
      const out = formatGithub(allSkipped);
      // "%" is workflow-command escaped.
      expect(out).toContain(`::notice title=MCP Compliance::Grade F (0%25) — ${NOTE}; spec `);
      expect(out.split("\n")).toHaveLength(1);
    });

    it("markdown: a quoted line under the grade, and the skip list", () => {
      const lines = formatMarkdown(allSkipped).split("\n");
      expect(lines).toContain(`> **${NOTE}.** See "Skipped checks" below.`);
      expect(lines).toContain("## Skipped checks (2)");
    });

    it("html: a warning in the grade card", () => {
      expect(formatHtml(allSkipped)).toContain(`<div class="warn" style="margin-top:12px">${NOTE}.</div>`);
    });

    it("sarif: the invocation properties carry the note next to grade F / score 0; results stay failures-only", () => {
      const run = JSON.parse(formatSarif(allSkipped)).runs[0];
      expect(run.results).toEqual([]);
      expect(run.invocations[0].properties).toMatchObject({ grade: "F", score: 0, testsSkipped: 2, note: NOTE });
      // Only on such a run: a measured run's property bag is unchanged.
      expect(JSON.parse(formatSarif(mixed)).runs[0].invocations[0].properties).not.toHaveProperty("note");
      expect(JSON.parse(formatSarif(reportOf([]))).runs[0].invocations[0].properties).not.toHaveProperty("note");
    });

    it("says it only when every test skipped: a measured test, or an empty run, prints no such line", () => {
      for (const report of [reportOf([skipA, skipB, fail]), reportOf([skipA, pass]), reportOf([])]) {
        expect(plain(formatTerminal(report))).not.toContain("No test measured anything");
        expect(formatGithub(report)).not.toContain("No test measured anything");
        expect(formatMarkdown(report)).not.toContain("No test measured anything");
        expect(formatHtml(report)).not.toContain("No test measured anything");
      }
      // A report from an older tool (no flags) has no skips to be all of.
      expect(plain(formatTerminal(unflagged(allSkipped)))).not.toContain("No test measured anything");
    });
  });
});

/**
 * The same thing end to end: real suites against real servers, so the
 * flag is proven on the details the suites actually write (not on a
 * hand-built report), and the verdicts are proven not to move.
 *
 * - The SDK's own Host guard (hostHeaderValidation, the DNS-rebinding
 *   middleware createMcpExpressApp installs) in front of an SDK v1
 *   McpServer, allowing only a hostname the test never uses: every
 *   request draws a bare 403 "Invalid Host: 127.0.0.1" with no
 *   WWW-Authenticate. With --auth the 2025-11-25 security-auth-required
 *   cannot attribute that 403 to authentication, and the four auth checks
 *   that lean on it skip as not evaluable -- the run the finding measured.
 * - The modern fixture over HTTP with no --auth: a clean server whose
 *   credential-dependent checks skip for want of a credential.
 */
describe("skipped checks, end to end against real servers", () => {
  const AUTH_SIBLINGS = [
    "security-www-authenticate",
    "security-auth-malformed",
    "security-session-not-auth",
    "security-token-in-uri",
  ];
  let guarded: { url: string; stop(): Promise<void> };
  let fixture: HttpFixture;
  let hostGuarded: ComplianceReport;
  let clean: ComplianceReport;

  beforeAll(async () => {
    guarded = await startSdkBehindHostGuard(["mcp.example.com"]);
    fixture = await startHttpFixture();
    [hostGuarded, clean] = await Promise.all([
      runComplianceSuite(guarded.url, {
        specVersion: "2025-11-25",
        only: ["security"],
        headers: { Authorization: "Bearer realtoken" },
        timeout: 3000,
      }),
      runComplianceSuite(fixture.target, {
        specVersion: "2026-07-28",
        only: ["security"],
        timeout: 5000,
        startupTimeout: 10_000,
      }),
    ]);
  }, 120_000);

  afterAll(async () => {
    await guarded?.stop();
    await fixture?.stop();
  });

  const flagged = (r: ComplianceReport) => r.tests.filter((t) => t.skipped === true).map((t) => t.id);
  const byId = (r: ComplianceReport, id: string) => {
    const t = r.tests.find((x) => x.id === id);
    if (!t) throw new Error(`${id} did not run (ran: ${r.tests.map((x) => x.id).join(", ")})`);
    return t;
  };

  it("bare 403: the four auth checks that could not be evaluated are flagged; the check that says why is a failure, unflagged", () => {
    // The flag is what this file tests. The suite's wording is pinned by
    // the suite's own tests (and has changed more than once), so only the
    // pointer to the check that explains the skip is checked here.
    for (const id of AUTH_SIBLINGS) {
      expect(byId(hostGuarded, id), id).toMatchObject({
        passed: true,
        skipped: true,
        details: expect.stringContaining("(see security-auth-required)"),
      });
    }
    const authRequired = byId(hostGuarded, "security-auth-required");
    expect(authRequired.passed).toBe(false);
    expect(authRequired.details).toMatch(/not evaluable/);
    expect(Object.hasOwn(authRequired, "skipped")).toBe(false);
    expect(hostGuarded.summary.skipped).toBe(flagged(hostGuarded).length);
    expect(hostGuarded.categories.security.skipped).toBe(flagged(hostGuarded).length);
  });

  it("clean fixture: the credential-dependent checks are flagged, and nothing that failed is", () => {
    for (const id of ["security-www-authenticate", "security-oauth-metadata", "security-auth-malformed"]) {
      expect(byId(clean, id).skipped, `${id}: ${byId(clean, id).details}`).toBe(true);
    }
    for (const report of [hostGuarded, clean]) {
      for (const t of report.tests.filter((x) => !x.passed)) expect(Object.hasOwn(t, "skipped"), t.id).toBe(false);
    }
  });

  it("the flag moves only the score: overall and every count match the same tests without it", () => {
    for (const report of [hostGuarded, clean]) {
      const without = computeScore(report.tests.map(({ skipped: _s, ...t }) => t));
      expect(report.overall).toBe(without.overall);
      const { skipped: _count, ...summary } = report.summary;
      const { skipped: _none, ...before } = without.summary;
      expect(summary).toEqual(before);
      // The score is the measured tests' score: the skips are left out.
      const measured = computeScore(report.tests.filter((t) => !(t.passed && t.skipped === true)));
      expect(report.score).toBe(measured.score);
      expect(report.grade).toBe(measured.grade);
    }
  });

  it("bare 403: scored over what it measured, the Host-guarded run is an F, not the B its skips made it", () => {
    // Pinned for the run the change was measured on. Every test here is
    // optional (--only security); the checks that measured something are
    // the two passes (CORS, stack traces) and the five failures
    // (auth-required, TLS, oversized-input, internal IP, rate limiting):
    // 2/7 = 29 (F). Scored as passes, the 16 skips made it 18/23 = 78 (B).
    const measured = hostGuarded.tests.filter((t) => !(t.passed && t.skipped === true));
    expect(measured.filter((t) => t.passed)).toHaveLength(2);
    expect(measured.filter((t) => !t.passed)).toHaveLength(5);
    expect(hostGuarded.summary.skipped).toBe(16);
    expect([hostGuarded.score, hostGuarded.grade]).toEqual([29, "F"]);
    const asPasses = computeScore(hostGuarded.tests.map(({ skipped: _s, ...t }) => t));
    expect([asPasses.score, asPasses.grade]).toEqual([78, "B"]);
  });

  it("both reports validate against report.v1", () => {
    expect(schemaCheck(JSON.parse(formatJson(hostGuarded)))).toBe("valid");
    expect(schemaCheck(JSON.parse(formatJson(clean)))).toBe("valid");
  });

  it("the terminal report names every skipped check; before the flag it listed only the failures", () => {
    for (const report of [hostGuarded, clean]) {
      const out = stripVTControlCharacters(formatTerminal(report));
      const ids = flagged(report);
      expect(ids.length).toBeGreaterThan(0);
      expect(out).toContain(`SKIPPED CHECKS (${ids.length})`);
      expect(out).toContain(`${ids.length} skipped`);
      const block = out.slice(out.indexOf("SKIPPED CHECKS"));
      for (const id of ids) expect(block, id).toContain(`[${id}]`);
    }
  });
});
