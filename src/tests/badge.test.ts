import { describe, expect, it } from "vitest";
import { renderBadgeSvg } from "../badge-svg.js";

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
