import { createHash } from "node:crypto";

/**
 * Generate a short, deterministic hash of a URL for badge paths.
 * Uses SHA-256 truncated to 12 hex chars (48 bits of entropy).
 */
function urlHash(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 12);
}

/**
 * Generate badge URLs and markdown for a compliance report.
 * Badge images are served by mcp.hosting.
 */
export function generateBadge(url: string): {
  imageUrl: string;
  reportUrl: string;
  markdown: string;
  html: string;
} {
  const hash = urlHash(url);

  const imageUrl = `https://mcp.hosting/api/compliance/ext/${hash}/badge`;
  const reportUrl = `https://mcp.hosting/compliance/ext/${hash}`;

  return {
    imageUrl,
    reportUrl,
    markdown: `[![MCP Compliant](${imageUrl})](${reportUrl})`,
    html: `<a href="${reportUrl}"><img src="${imageUrl}" alt="MCP Compliant"></a>`,
  };
}
