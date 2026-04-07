import { describe, expect, it } from "vitest";
import { generateBadge } from "../badge.js";

describe("generateBadge", () => {
  it("generates correct badge URLs using full encoded URL", () => {
    const badge = generateBadge("https://my-server.example.com/mcp");
    const encoded = encodeURIComponent("https://my-server.example.com/mcp");
    expect(badge.imageUrl).toBe(`https://mcp.hosting/api/compliance/${encoded}/badge`);
    expect(badge.reportUrl).toBe(`https://mcp.hosting/compliance/${encoded}`);
    expect(badge.markdown).toContain("[![MCP Compliant]");
    expect(badge.html).toContain("<a href=");
  });

  it("handles simple URLs", () => {
    const badge = generateBadge("https://localhost:3000");
    const encoded = encodeURIComponent("https://localhost:3000/");
    expect(badge.imageUrl).toContain(encoded);
  });

  it("encodes path and query in badge URL", () => {
    const badge = generateBadge("https://example.com/api/mcp?key=abc");
    const encoded = encodeURIComponent("https://example.com/api/mcp?key=abc");
    expect(badge.imageUrl).toBe(`https://mcp.hosting/api/compliance/${encoded}/badge`);
  });
});
