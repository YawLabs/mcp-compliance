import { standardHeadersFor } from "./modern/headers.js";
import { buildMeta, type ClientIdentity, MODERN_ERROR_CODES, withMeta } from "./modern/meta.js";
import { LEGACY_SPEC_VERSION, MODERN_SPEC_VERSION, type SpecVersion } from "./spec.js";
import type { JsonRpcId, Transport, TransportResponse } from "./transport/index.js";

/**
 * Era detection for `--spec-version auto`, following the spec's own rules
 * for dual-era clients:
 *
 *   - stdio (transports/stdio#backward-compatibility): probe with
 *     `server/discover`. A DiscoverResult or a recognised modern error
 *     means modern; ANY other error, or no reply within the timeout,
 *     means legacy. The fallback MUST NOT be keyed to one error code.
 *   - HTTP (transports/streamable-http#backward-compatibility): send a
 *     modern request; a result or a recognised modern JSON-RPC error means
 *     modern, anything else (400 "not initialized", -32601, -32000, HTML,
 *     404 from an HTTP+SSE server, connection failure) means legacy.
 *
 * Dual-era servers answer the probe as modern; the caller grades the
 * newest era and reports the other one in a warning.
 */

export interface DetectOptions {
  nextId: () => JsonRpcId;
  /** Time budget for the probe. Use the startup timeout: cold stdio servers are slow. */
  timeout: number;
  clientInfo: ClientIdentity;
}

export interface DetectionResult {
  version: SpecVersion;
  era: "modern" | "legacy";
  /** Human-readable reason, stable wording (goes into report warnings). */
  reason: string;
  /**
   * The probe response when the server answered with a DiscoverResult.
   * Seeds serverInfo/capabilities so the modern suite does not repeat
   * the request.
   */
  discover?: TransportResponse;
  /** `supportedVersions` from a DiscoverResult, when present. */
  supportedVersions?: string[];
}

const MODERN_CODES = new Set<number>(Object.values(MODERN_ERROR_CODES));

export function isModernErrorCode(code: unknown): boolean {
  return typeof code === "number" && MODERN_CODES.has(code);
}

/**
 * Classify one response to a modern `server/discover` probe. Exported so
 * the classification rule is unit-testable without a live server.
 */
export function classifyDiscoverResponse(res: TransportResponse | null): DetectionResult {
  if (!res) {
    return {
      version: LEGACY_SPEC_VERSION,
      era: "legacy",
      reason: "server/discover probe got no response; treating the server as legacy",
    };
  }
  const body = res.body as { result?: unknown; error?: { code?: unknown } } | undefined;
  const result = body?.result;
  if (
    result &&
    typeof result === "object" &&
    Array.isArray((result as { supportedVersions?: unknown }).supportedVersions)
  ) {
    const supportedVersions = (result as { supportedVersions: unknown[] }).supportedVersions.filter(
      (v): v is string => typeof v === "string",
    );
    return {
      version: MODERN_SPEC_VERSION,
      era: "modern",
      reason: `server/discover returned supportedVersions [${supportedVersions.join(", ")}]`,
      discover: res,
      supportedVersions,
    };
  }
  const code = body?.error?.code;
  if (isModernErrorCode(code)) {
    return {
      version: MODERN_SPEC_VERSION,
      era: "modern",
      reason: `server/discover probe returned modern error code ${code}`,
    };
  }
  const detail =
    typeof code === "number"
      ? `JSON-RPC error ${code}`
      : res.statusCode !== undefined && res.statusCode !== 200
        ? `HTTP ${res.statusCode}`
        : "a non-modern response";
  return {
    version: LEGACY_SPEC_VERSION,
    era: "legacy",
    reason: `server/discover probe returned ${detail}; treating the server as legacy`,
  };
}

/**
 * The probe request: a conformant modern `server/discover`. Exposed so
 * the HTTP preflight can send the very same bytes (one round-trip serves
 * both reachability and era detection).
 */
export function buildDiscoverProbe(clientInfo: ClientIdentity): {
  params: Record<string, unknown>;
  headers: Record<string, string>;
} {
  const params = withMeta({}, buildMeta({ protocolVersion: MODERN_SPEC_VERSION, clientCapabilities: {}, clientInfo }));
  const headers = standardHeadersFor({ method: "server/discover", params, protocolVersion: MODERN_SPEC_VERSION });
  return { params, headers };
}

/** Send the modern `server/discover` probe and classify the reply. */
export async function detectSpecVersion(transport: Transport, opts: DetectOptions): Promise<DetectionResult> {
  const probe = buildDiscoverProbe(opts.clientInfo);
  let res: TransportResponse | null = null;
  try {
    res = await transport.request("server/discover", probe.params, opts.nextId, {
      timeout: opts.timeout,
      headers: transport.kind === "http" ? probe.headers : undefined,
    });
  } catch {
    res = null;
  }
  return classifyDiscoverResponse(res);
}
