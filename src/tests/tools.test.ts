import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerTools } from "../mcp/tools.js";
import { runComplianceSuite } from "../runner.js";
import { SUPPORTED_SPEC_VERSIONS } from "../spec.js";
import type { ComplianceReport } from "../types.js";

// The test tool hands its arguments to runComplianceSuite; mock only that
// export so the handler's wiring (specVersion, headers, filters) can be
// asserted without a server. Everything else on the module stays real.
vi.mock("../runner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runner.js")>();
  return { ...actual, runComplianceSuite: vi.fn() };
});

const mockedRun = vi.mocked(runComplianceSuite);

function fakeReport(specVersion: string): ComplianceReport {
  return {
    schemaVersion: "1",
    specVersion,
    toolVersion: "0.0.0",
    url: "https://example.com/mcp",
    timestamp: "2026-09-13T00:00:00.000Z",
    score: 100,
    grade: "A",
    overall: "pass",
    summary: { total: 1, passed: 1, failed: 0, required: 1, requiredPassed: 1 },
    categories: { transport: { passed: 1, total: 1 } },
    tests: [
      {
        id: "transport-post",
        name: "HTTP POST accepted",
        category: "transport",
        passed: true,
        required: true,
        details: "HTTP 200",
        durationMs: 1,
      },
    ],
    warnings: [],
    serverInfo: { protocolVersion: specVersion, name: null, version: null, capabilities: {} },
    toolCount: 0,
    toolNames: [],
    resourceCount: 0,
    resourceNames: [],
    promptCount: 0,
    promptNames: [],
    badge: { imageUrl: "", reportUrl: "", markdown: "", html: "" },
  };
}

type ToolHandler = (...args: any[]) => Promise<any>;

// Capture tool registrations by mocking server.tool()
function createMockServer() {
  const tools: Record<string, { description: string; schema: any; annotations: any; handler: ToolHandler }> = {};

  const server = {
    tool: vi.fn((name: string, description: string, schema: any, annotations: any, handler: ToolHandler) => {
      tools[name] = { description, schema, annotations, handler };
    }),
  } as unknown as McpServer;

  return { server, tools };
}

const SPEC_2025 = "https://modelcontextprotocol.io/specification/2025-11-25/";
const SPEC_2026 = "https://modelcontextprotocol.io/specification/2026-07-28/";

beforeEach(() => {
  mockedRun.mockReset();
});

describe("registerTools", () => {
  it("registers exactly 2 tools", () => {
    const { server, tools } = createMockServer();
    registerTools(server);
    expect(Object.keys(tools)).toHaveLength(2);
  });

  it("registers mcp_compliance_test tool", () => {
    const { server, tools } = createMockServer();
    registerTools(server);
    expect(tools.mcp_compliance_test).toBeDefined();
    expect(tools.mcp_compliance_test.description).toContain("compliance test suite");
  });

  it("registers mcp_compliance_explain tool", () => {
    const { server, tools } = createMockServer();
    registerTools(server);
    expect(tools.mcp_compliance_explain).toBeDefined();
    expect(tools.mcp_compliance_explain.description).toContain("Explain");
  });

  it("all tools have readOnlyHint annotation", () => {
    const { server, tools } = createMockServer();
    registerTools(server);
    for (const [_name, tool] of Object.entries(tools)) {
      expect(tool.annotations.readOnlyHint).toBe(true);
    }
  });

  it("all tools have destructiveHint=false annotation", () => {
    const { server, tools } = createMockServer();
    registerTools(server);
    for (const [_name, tool] of Object.entries(tools)) {
      expect(tool.annotations.destructiveHint).toBe(false);
    }
  });

  it("all tools have idempotentHint=true annotation", () => {
    const { server, tools } = createMockServer();
    registerTools(server);
    for (const [_name, tool] of Object.entries(tools)) {
      expect(tool.annotations.idempotentHint).toBe(true);
    }
  });

  it("all tools have title annotation", () => {
    const { server, tools } = createMockServer();
    registerTools(server);
    for (const [_name, tool] of Object.entries(tools)) {
      expect(typeof tool.annotations.title).toBe("string");
      expect(tool.annotations.title.length).toBeGreaterThan(0);
    }
  });
});

describe("mcp_compliance_test tool", () => {
  it("describes the per-revision suite instead of a fixed test count", () => {
    const { server, tools } = createMockServer();
    registerTools(server);
    const desc = tools.mcp_compliance_test.description;
    expect(desc).not.toMatch(/\b88\b/);
    expect(desc).toContain("2025-11-25");
    expect(desc).toContain("2026-07-28");
  });

  it("accepts specVersion = auto plus every supported spec version, and nothing else", () => {
    const { server, tools } = createMockServer();
    registerTools(server);
    const field = tools.mcp_compliance_test.schema.specVersion;
    expect(field).toBeDefined();
    // Optional wrapper around the enum: the option list must track SUPPORTED_SPEC_VERSIONS.
    expect(field.unwrap().options).toEqual(["auto", ...SUPPORTED_SPEC_VERSIONS]);
    expect(field.safeParse(undefined).success).toBe(true);
    expect(field.safeParse("auto").success).toBe(true);
    expect(field.safeParse("2026-07-28").success).toBe(true);
    expect(field.safeParse("2024-11-05").success).toBe(false);
  });

  it("forwards a pinned specVersion to runComplianceSuite", async () => {
    mockedRun.mockResolvedValue(fakeReport("2026-07-28"));
    const { server, tools } = createMockServer();
    registerTools(server);
    const result = await tools.mcp_compliance_test.handler({
      url: "https://example.com/mcp",
      specVersion: "2026-07-28",
    });
    expect(mockedRun).toHaveBeenCalledTimes(1);
    expect(mockedRun.mock.calls[0][0]).toBe("https://example.com/mcp");
    expect(mockedRun.mock.calls[0][1]).toMatchObject({ specVersion: "2026-07-28" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Spec: 2026-07-28");
  });

  it("defaults specVersion to auto when omitted", async () => {
    mockedRun.mockResolvedValue(fakeReport("2025-11-25"));
    const { server, tools } = createMockServer();
    registerTools(server);
    await tools.mcp_compliance_test.handler({ url: "https://example.com/mcp" });
    expect(mockedRun.mock.calls[0][1]).toMatchObject({ specVersion: "auto" });
  });

  it("still forwards auth, headers and filters alongside specVersion", async () => {
    mockedRun.mockResolvedValue(fakeReport("2025-11-25"));
    const { server, tools } = createMockServer();
    registerTools(server);
    await tools.mcp_compliance_test.handler({
      url: "https://example.com/mcp",
      auth: "Bearer tok",
      headers: { "X-Api-Key": "abc" },
      only: ["transport"],
      skip: ["security"],
      timeout: 1234,
      retries: 2,
    });
    expect(mockedRun.mock.calls[0][1]).toMatchObject({
      specVersion: "auto",
      headers: { Authorization: "Bearer tok", "X-Api-Key": "abc" },
      only: ["transport"],
      skip: ["security"],
      timeout: 1234,
      retries: 2,
    });
  });

  it("reports a thrown runner error as an isError result", async () => {
    mockedRun.mockRejectedValue(new Error("boom"));
    const { server, tools } = createMockServer();
    registerTools(server);
    const result = await tools.mcp_compliance_test.handler({ url: "https://example.com/mcp" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("boom");
  });
});

describe("mcp_compliance_explain handler", () => {
  it("returns explanation for valid test ID", async () => {
    const { server, tools } = createMockServer();
    registerTools(server);
    const result = await tools.mcp_compliance_explain.handler({ testId: "transport-post" });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toContain("transport-post");
    expect(result.content[0].text).toContain("HTTP POST");
    expect(result.isError).toBeUndefined();
  });

  it("returns error for unknown test ID", async () => {
    const { server, tools } = createMockServer();
    registerTools(server);
    const result = await tools.mcp_compliance_explain.handler({ testId: "nonexistent-test" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unknown test ID");
    expect(result.content[0].text).toContain("nonexistent-test");
  });

  it("lists valid test IDs on unknown", async () => {
    const { server, tools } = createMockServer();
    registerTools(server);
    const result = await tools.mcp_compliance_explain.handler({ testId: "bad" });
    expect(result.content[0].text).toContain("transport-post");
    expect(result.content[0].text).toContain("lifecycle-init");
  });

  it("includes spec reference URL", async () => {
    const { server, tools } = createMockServer();
    registerTools(server);
    const result = await tools.mcp_compliance_explain.handler({ testId: "lifecycle-ping" });
    expect(result.content[0].text).toContain("modelcontextprotocol.io");
  });

  it("includes category and required status", async () => {
    const { server, tools } = createMockServer();
    registerTools(server);
    const result = await tools.mcp_compliance_explain.handler({ testId: "lifecycle-init" });
    expect(result.content[0].text).toContain("lifecycle");
    expect(result.content[0].text).toContain("Yes");
  });

  it("includes fix recommendation", async () => {
    const { server, tools } = createMockServer();
    registerTools(server);
    const result = await tools.mcp_compliance_explain.handler({ testId: "transport-post" });
    expect(result.content[0].text).toContain("Fix:");
  });

  it("accepts specVersion = every supported spec version, and nothing else (no auto)", () => {
    const { server, tools } = createMockServer();
    registerTools(server);
    const field = tools.mcp_compliance_explain.schema.specVersion;
    expect(field.unwrap().options).toEqual([...SUPPORTED_SPEC_VERSIONS]);
    expect(field.safeParse(undefined).success).toBe(true);
    expect(field.safeParse("auto").success).toBe(false);
  });

  it("explains a 2026-only id from the 2026 catalog when specVersion is omitted", async () => {
    const { server, tools } = createMockServer();
    registerTools(server);
    const result = await tools.mcp_compliance_explain.handler({ testId: "lifecycle-discover" });
    expect(result.isError).toBeUndefined();
    const text: string = result.content[0].text;
    expect(text).toContain("Test: lifecycle-discover");
    expect(text).toContain("Spec version: 2026-07-28");
    expect(text).toContain(`Spec reference: ${SPEC_2026}server/discover`);
    expect(text).not.toContain(SPEC_2025);
    expect(text).toContain("Fix: Implement a server/discover handler");
  });

  it("explains a 2025-only id with the 2025 spec link when specVersion is omitted", async () => {
    const { server, tools } = createMockServer();
    registerTools(server);
    const result = await tools.mcp_compliance_explain.handler({ testId: "lifecycle-init" });
    expect(result.isError).toBeUndefined();
    const text: string = result.content[0].text;
    expect(text).toContain("Spec version: 2025-11-25");
    expect(text).toContain(`Spec reference: ${SPEC_2025}`);
    expect(text).not.toContain(SPEC_2026);
    // Single-suite hit: no "exists in N suites" preface.
    expect(text).not.toContain("spec suites");
  });

  it("returns both labelled entries for an id shared by both catalogs with different prose", async () => {
    const { server, tools } = createMockServer();
    registerTools(server);
    const result = await tools.mcp_compliance_explain.handler({ testId: "transport-post" });
    expect(result.isError).toBeUndefined();
    const text: string = result.content[0].text;
    // Same category and required flag in both catalogs. A shared id covers
    // the same feature but its criteria follow each revision, so explain
    // must not claim the check is identical. "different criteria" was said
    // of every one of the 66 shared ids.
    expect(text).toContain(
      '"transport-post" exists in 2 spec suites with the same category and required flag; it covers the same feature, but the pass/fail criteria follow each revision.',
    );
    expect(text).not.toContain("the check is the same");
    expect(text).not.toContain("different criteria");
    expect(text).toContain("Spec version: 2025-11-25");
    expect(text).toContain("Spec version: 2026-07-28");
    expect(text).toContain(`Spec reference: ${SPEC_2025}basic/transports`);
    expect(text).toContain(`Spec reference: ${SPEC_2026}basic/transports/streamable-http`);
    // Each era keeps its own recommendation.
    expect(text).toContain("Ensure your server listens for POST requests");
    expect(text).toContain("answer a well-formed server/discover with 200");
    expect(text.split("Test: transport-post")).toHaveLength(3);
  });

  it.each([
    ["stdio-framing", "required transport in 2025-11-25, optional transport in 2026-07-28"],
    ["error-method-code", "optional errors in 2025-11-25, required errors in 2026-07-28"],
  ])("says 'different criteria' only when the required flag really changed: %s", async (id, flags) => {
    const { server, tools } = createMockServer();
    registerTools(server);
    const result = await tools.mcp_compliance_explain.handler({ testId: id });
    const text: string = result.content[0].text;
    expect(text).toContain(
      `"${id}" exists in 2 spec suites with different criteria (${flags}); each is explained below.`,
    );
    expect(text).not.toContain("with the same category and required flag");
  });

  it("reads only the requested catalog when specVersion is given", async () => {
    const { server, tools } = createMockServer();
    registerTools(server);
    const modern = await tools.mcp_compliance_explain.handler({ testId: "transport-post", specVersion: "2026-07-28" });
    expect(modern.isError).toBeUndefined();
    expect(modern.content[0].text).toContain("Spec version: 2026-07-28");
    expect(modern.content[0].text).toContain(SPEC_2026);
    expect(modern.content[0].text).not.toContain(SPEC_2025);
    expect(modern.content[0].text).not.toContain("Ensure your server listens for POST requests");
    expect(modern.content[0].text).not.toContain("spec suites");

    const legacy = await tools.mcp_compliance_explain.handler({ testId: "transport-post", specVersion: "2025-11-25" });
    expect(legacy.content[0].text).toContain("Spec version: 2025-11-25");
    expect(legacy.content[0].text).not.toContain(SPEC_2026);
    expect(legacy.content[0].text).toContain("Ensure your server listens for POST requests");
  });

  it("errors when a pinned catalog lacks the id, and names the suite that has it", async () => {
    const { server, tools } = createMockServer();
    registerTools(server);
    const result = await tools.mcp_compliance_explain.handler({ testId: "lifecycle-init", specVersion: "2026-07-28" });
    expect(result.isError).toBe(true);
    const text: string = result.content[0].text;
    expect(text).toContain('Unknown test ID: "lifecycle-init" in the 2026-07-28 suite');
    expect(text).toContain("It exists in the 2025-11-25 suite");
  });

  it("groups the unknown-id listing per suite", async () => {
    const { server, tools } = createMockServer();
    registerTools(server);
    const result = await tools.mcp_compliance_explain.handler({ testId: "bad" });
    const text: string = result.content[0].text;
    expect(text).toContain("Valid test IDs (2025-11-25 suite):");
    expect(text).toContain("Valid test IDs (2026-07-28 suite):");
    expect(text).not.toContain("It exists in");
    const legacyBlock = text.slice(text.indexOf("(2025-11-25 suite)"), text.indexOf("(2026-07-28 suite)"));
    const modernBlock = text.slice(text.indexOf("(2026-07-28 suite)"));
    expect(legacyBlock).toContain("lifecycle-init");
    expect(legacyBlock).not.toContain("lifecycle-discover");
    expect(modernBlock).toContain("lifecycle-discover");
    expect(modernBlock).not.toContain("lifecycle-init");
  });
});
