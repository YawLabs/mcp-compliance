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
  /** Cancels the probe (RunOptions.signal). */
  signal?: AbortSignal;
}

export interface DetectionResult {
  version: SpecVersion;
  era: "modern" | "legacy";
  /**
   * Human-readable reason, stable wording (goes into report warnings).
   * Always starts with `REASON_PREFIX` ("server/discover -> ") and is
   * kept short: the terminal header prints it on one line after
   * "auto-detected from server/discover: ", so the part after the prefix
   * should stay near 30 columns for the common shapes.
   */
  reason: string;
  /** Whether the server sent ANY response to the probe (false = timeout, crash, transport error). */
  responded: boolean;
  /**
   * True when the probe was refused before the server could show its
   * era (HTTP 401/403): the legacy default applies, but it says nothing
   * about the server, so callers must not report it as "the server is
   * legacy" or suggest re-pinning based on it.
   */
  eraUndetermined?: boolean;
  /**
   * The probe response when the server answered with a DiscoverResult.
   * Seeds serverInfo/capabilities so the modern suite does not repeat
   * the request.
   */
  discover?: TransportResponse;
  /** `supportedVersions` from a DiscoverResult, when present. */
  supportedVersions?: string[];
}

/** Every `DetectionResult.reason` starts with this; formatters may strip it. */
export const REASON_PREFIX = "server/discover -> ";

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
      responded: false,
      reason: `${REASON_PREFIX}no response, legacy`,
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
      responded: true,
      reason: `${REASON_PREFIX}supportedVersions [${supportedVersions.join(", ")}]`,
      discover: res,
      supportedVersions,
    };
  }
  const code = body?.error?.code;
  if (isModernErrorCode(code)) {
    return {
      version: MODERN_SPEC_VERSION,
      era: "modern",
      responded: true,
      reason: `${REASON_PREFIX}modern error ${code}`,
    };
  }
  if (res.statusCode === 401 || res.statusCode === 403) {
    // Refused before the era could show (whatever the body says):
    // neither modern nor legacy is observable without credentials. The
    // legacy default still applies (spec: a 4xx without a modern error
    // body falls back to initialize).
    return {
      version: LEGACY_SPEC_VERSION,
      era: "legacy",
      responded: true,
      eraUndetermined: true,
      reason: `${REASON_PREFIX}HTTP ${res.statusCode} (authentication required -- pass --auth); era not determinable, using ${LEGACY_SPEC_VERSION}`,
    };
  }
  const detail =
    typeof code === "number"
      ? `JSON-RPC error ${code}`
      : res.statusCode !== undefined && res.statusCode !== 200
        ? `HTTP ${res.statusCode}`
        : "non-modern response";
  return {
    version: LEGACY_SPEC_VERSION,
    era: "legacy",
    responded: true,
    reason: `${REASON_PREFIX}${detail}, legacy`,
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
      signal: opts.signal,
    });
  } catch {
    res = null;
  }
  return classifyDiscoverResponse(res);
}
