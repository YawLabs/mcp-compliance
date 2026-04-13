import { createHash } from "node:crypto";

/**
 * Generate a short, deterministic hash of a URL for badge paths.
 * SHA-256 truncated to 24 hex chars (96 bits of entropy) — matches the
 * server-side hash width used by mcp.hosting for `/compliance/ext/<hash>`.
 *
 * Exported so mcp.hosting (and other consumers) can compute matching
 * hashes when looking up reports/badges by URL. The hash is the canonical
 * key for `/compliance/ext/<hash>` and `/api/compliance/ext/<hash>/badge`.
 */
export function urlHash(url: string): string {
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
    // loading="lazy" so READMEs that embed many badges don't block first
    // paint on this image. Markdown renderers (GitHub, npmjs.com) emit
    // their own <img> from the markdown form so the attribute only
    // matters for the HTML form people paste into custom pages.
    html: `<a href="${reportUrl}"><img src="${imageUrl}" alt="MCP Compliant" loading="lazy"></a>`,
  };
}
