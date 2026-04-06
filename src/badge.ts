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
  // Extract a subdomain-like identifier from the URL
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    parsed = new URL('https://unknown');
  }

  // Use full URL (encoded) for the badge path, not just hostname
  const encoded = encodeURIComponent(parsed.href);

  const imageUrl = `https://mcp.hosting/api/compliance/${encoded}/badge`;
  const reportUrl = `https://mcp.hosting/compliance/${encoded}`;

  return {
    imageUrl,
    reportUrl,
    markdown: `[![MCP Compliant](${imageUrl})](${reportUrl})`,
    html: `<a href="${reportUrl}"><img src="${imageUrl}" alt="MCP Compliant"></a>`,
  };
}
