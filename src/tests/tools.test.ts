import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { registerTools } from "../mcp/tools.js";

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

describe("registerTools", () => {
  it("registers exactly 3 tools", () => {
    const { server, tools } = createMockServer();
    registerTools(server);
    expect(Object.keys(tools)).toHaveLength(3);
  });

  it("registers mcp_compliance_test tool", () => {
    const { server, tools } = createMockServer();
    registerTools(server);
    expect(tools.mcp_compliance_test).toBeDefined();
    expect(tools.mcp_compliance_test.description).toContain("compliance test suite");
  });

  it("registers mcp_compliance_badge tool", () => {
    const { server, tools } = createMockServer();
    registerTools(server);
    expect(tools.mcp_compliance_badge).toBeDefined();
    expect(tools.mcp_compliance_badge.description).toContain("badge");
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
    for (const [name, tool] of Object.entries(tools)) {
      expect(tool.annotations.readOnlyHint).toBe(true);
    }
  });

  it("all tools have destructiveHint=false annotation", () => {
    const { server, tools } = createMockServer();
    registerTools(server);
    for (const [name, tool] of Object.entries(tools)) {
      expect(tool.annotations.destructiveHint).toBe(false);
    }
  });

  it("all tools have idempotentHint=true annotation", () => {
    const { server, tools } = createMockServer();
    registerTools(server);
    for (const [name, tool] of Object.entries(tools)) {
      expect(tool.annotations.idempotentHint).toBe(true);
    }
  });

  it("all tools have title annotation", () => {
    const { server, tools } = createMockServer();
    registerTools(server);
    for (const [name, tool] of Object.entries(tools)) {
      expect(typeof tool.annotations.title).toBe("string");
      expect(tool.annotations.title.length).toBeGreaterThan(0);
    }
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
});
