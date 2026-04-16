import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { renderBadgeSvg } from "../badge-svg.js";
import { generateBadge } from "../badge.js";

function expectedHash(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 24);
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

describe("renderBadgeSvg", () => {
  it("produces valid SVG for a normal grade", () => {
    const svg = renderBadgeSvg({ grade: "A", score: 95, timestamp: "2025-01-01T00:00:00Z" });
    expect(svg).toContain("<svg xmlns=");
    expect(svg).toContain("</svg>");
    expect(svg).toMatch(/>A</);
  });

  it("escapes XML-special characters in grade (defense-in-depth)", () => {
    // The strict `Grade` union prevents in-tree callers from passing
    // hostile values, but BadgeSvgInput.grade is typed `string`. A
    // downstream caller passing user-controlled input shouldn't produce
    // injectable SVG.
    const hostile = '"><script>alert(1)</script><x';
    const svg = renderBadgeSvg({ grade: hostile, score: 50, timestamp: "2025-01-01T00:00:00Z" });
    expect(svg).not.toContain("<script>");
    expect(svg).not.toContain('"><script');
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).toContain("&quot;");
  });

  it("handles the untested case (null input) without interpolating anything exploitable", () => {
    const svg = renderBadgeSvg(null);
    expect(svg).toContain("MCP Compliance - untested");
    expect(svg).toContain(">unknown<");
  });

  it("renders a deterministic, parseable document", () => {
    const a = renderBadgeSvg({ grade: "B", score: 80, timestamp: "2025-06-01T00:00:00Z" });
    const b = renderBadgeSvg({ grade: "B", score: 80, timestamp: "2025-06-01T00:00:00Z" });
    expect(a).toBe(b);
    // The SVG must have exactly balanced angle brackets post-escape.
    const opens = (a.match(/</g) || []).length;
    const closes = (a.match(/>/g) || []).length;
    expect(opens).toBe(closes);
  });
});
