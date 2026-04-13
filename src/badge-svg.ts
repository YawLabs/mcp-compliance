/**
 * Renders a shields.io-style SVG compliance badge locally. Used by the
 * `--output <file.svg>` flag on `test` and `badge` when a user wants a
 * committable badge artifact instead of (or in addition to) publishing.
 *
 * Intentionally duplicated from mcp-hosting/src/lib/compliance-badge.ts
 * so this package has no runtime coupling to the hosting service.
 */

const GRADE_COLORS: Record<string, string> = {
  A: "#4c1",
  B: "#97CA00",
  C: "#dfb317",
  D: "#fe7d37",
  F: "#e05d44",
};

const UNTESTED_COLOR = "#9f9f9f";

export interface BadgeSvgInput {
  grade?: string;
  score?: number;
  timestamp?: string;
}

export function renderBadgeSvg(input: BadgeSvgInput | null): string {
  let gradeLabel = "unknown";
  let color = UNTESTED_COLOR;
  let title = "MCP Compliance - untested";

  if (input?.grade) {
    gradeLabel = input.grade;
    color = GRADE_COLORS[input.grade] || UNTESTED_COLOR;
    const date = input.timestamp ? new Date(input.timestamp).toLocaleDateString() : "unknown date";
    title = `MCP Compliant: Grade ${input.grade}${input.score != null ? ` (${input.score}%)` : ""} - tested ${date}`;
  }

  const leftText = "MCP Compliant";
  const rightText = gradeLabel;
  const leftWidth = 95;
  const rightWidth = 40;
  const totalWidth = leftWidth + rightWidth;
  const leftX = leftWidth / 2;
  const rightX = leftWidth + rightWidth / 2;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20" role="img" aria-label="${leftText}: ${rightText}">
  <title>${title}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r">
    <rect width="${totalWidth}" height="20" rx="3" fill="#fff"/>
  </clipPath>
  <g clip-path="url(#r)">
    <rect width="${leftWidth}" height="20" fill="#555"/>
    <rect x="${leftWidth}" width="${rightWidth}" height="20" fill="${color}"/>
    <rect width="${totalWidth}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="110">
    <text aria-hidden="true" x="${leftX * 10}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${(leftWidth - 10) * 10}">${leftText}</text>
    <text x="${leftX * 10}" y="140" transform="scale(.1)" fill="#fff" textLength="${(leftWidth - 10) * 10}">${leftText}</text>
    <text aria-hidden="true" x="${rightX * 10}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${(rightWidth - 10) * 10}">${rightText}</text>
    <text x="${rightX * 10}" y="140" transform="scale(.1)" fill="#fff" textLength="${(rightWidth - 10) * 10}">${rightText}</text>
  </g>
</svg>`;
}
