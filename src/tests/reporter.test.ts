import { describe, expect, it } from "vitest";
import { formatGithub, formatHtml, formatJson, formatMarkdown, formatSarif, formatTerminal } from "../reporter.js";
import type { ComplianceReport, TestResult } from "../types.js";

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
