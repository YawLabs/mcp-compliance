import { describe, expect, it } from "vitest";
import { createComplianceServer } from "../mcp/server.js";

describe("createComplianceServer", () => {
  it("returns an McpServer instance", () => {
    const server = createComplianceServer();
    expect(server).toBeDefined();
  });

  it("can be called multiple times (no shared state)", () => {
    const server1 = createComplianceServer();
    const server2 = createComplianceServer();
    expect(server1).not.toBe(server2);
  });
});
