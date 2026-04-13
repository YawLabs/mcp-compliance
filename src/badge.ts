import { createHash } from "node:crypto";

/**
 * Generate a short, deterministic hash of a URL for badge paths.
 * SHA-256 truncated to 24 hex chars (96 bits of entropy) — matches the
 * server-side hash width used by mcp.hosting for `/compliance/ext/<hash>`.
 */
function urlHash(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 24);
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
