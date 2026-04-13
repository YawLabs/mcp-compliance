import { request } from "undici";
import type { ComplianceReport } from "./types.js";

const PUBLISH_BASE = "https://mcp.hosting";
const PUBLISH_PATH = "/api/compliance/ext";
const PUBLISH_TIMEOUT_MS = 10_000;
const PUBLISH_RETRIES = 2;

export interface PublishResponse {
  hash: string;
  reportUrl: string;
  badgeUrl: string;
  deleteToken: string;
}

/**
 * Defense-in-depth: strip anything that looks like request auth
 * from the report before uploading. The report shouldn't contain these
 * fields in the first place, but belt-and-suspenders.
 */
function sanitizeReport(report: ComplianceReport): Record<string, unknown> {
  const { headers: _h, auth: _a, ...rest } = report as unknown as Record<string, unknown>;
  void _h;
  void _a;
  return rest;
}

export async function publishReport(report: ComplianceReport): Promise<PublishResponse> {
  const body = JSON.stringify(sanitizeReport(report));

  let lastErr: unknown;
  for (let attempt = 0; attempt <= PUBLISH_RETRIES; attempt++) {
    try {
      const res = await request(`${PUBLISH_BASE}${PUBLISH_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
      });

      if (res.statusCode >= 500 && attempt < PUBLISH_RETRIES) {
        await res.body.dump();
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }

      const text = await res.body.text();
      if (res.statusCode >= 400) {
        let message = `Publish failed: HTTP ${res.statusCode}`;
        try {
          const parsed = JSON.parse(text) as { error?: string };
          if (parsed.error) message = `Publish failed: ${parsed.error}`;
        } catch {}
        throw new Error(message);
      }

      const parsed = JSON.parse(text) as PublishResponse;
      if (!parsed.hash || !parsed.deleteToken || !parsed.reportUrl || !parsed.badgeUrl) {
        throw new Error("Publish failed: malformed response from mcp.hosting");
      }
      return parsed;
    } catch (err) {
      lastErr = err;
      if (attempt < PUBLISH_RETRIES) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function unpublishReport(hash: string, deleteToken: string): Promise<void> {
  const res = await request(`${PUBLISH_BASE}${PUBLISH_PATH}/${hash}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${deleteToken}` },
    signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
  });

  const text = await res.body.text();
  if (res.statusCode === 204 || res.statusCode === 404) return;
  let message = `Unpublish failed: HTTP ${res.statusCode}`;
  try {
    const parsed = JSON.parse(text) as { error?: string };
    if (parsed.error) message = `Unpublish failed: ${parsed.error}`;
  } catch {}
  throw new Error(message);
}
