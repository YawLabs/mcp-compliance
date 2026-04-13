import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateBadge } from "../badge.js";

function expectedHash(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 12);
}

describe("generateBadge", () => {
  it("generates correct badge URLs using URL hash", () => {
    const badge = generateBadge("https://my-server.example.com/mcp");
    const hash = expectedHash("https://my-server.example.com/mcp");
    expect(badge.imageUrl).toBe(`https://mcp.hosting/api/compliance/ext/${hash}/badge`);
    expect(badge.reportUrl).toBe(`https://mcp.hosting/compliance/ext/${hash}`);
    expect(badge.markdown).toContain("[![MCP Compliant]");
    expect(badge.html).toContain("<a href=");
  });

  it("produces short badge URLs regardless of input length", () => {
    const longUrl = "https://example.com/api/v2/mcp?key=abc123&token=very-long-auth-token-here&region=us-east-1";
    const badge = generateBadge(longUrl);
    // Hash-based URL should be much shorter than encoded full URL
    expect(badge.imageUrl.length).toBeLessThan(80);
  });

  it("produces deterministic hashes", () => {
    const badge1 = generateBadge("https://example.com/mcp");
    const badge2 = generateBadge("https://example.com/mcp");
    expect(badge1.imageUrl).toBe(badge2.imageUrl);
  });

  it("produces different hashes for different URLs", () => {
    const badge1 = generateBadge("https://example.com/mcp");
    const badge2 = generateBadge("https://other.com/mcp");
    expect(badge1.imageUrl).not.toBe(badge2.imageUrl);
  });
});
