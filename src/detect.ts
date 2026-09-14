import { standardHeadersFor } from "./modern/headers.js";
import { buildMeta, type ClientIdentity, MODERN_ERROR_CODES, withMeta } from "./modern/meta.js";
import { LEGACY_SPEC_VERSION, MODERN_SPEC_VERSION, type SpecVersion } from "./spec.js";
import type { JsonRpcId, Transport, TransportResponse } from "./transport/index.js";
import type { StdioTransport } from "./transport/stdio.js";

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
  /**
   * stdio only: a human-facing status line fired ~2s into an
   * unanswered probe. A server that answers the probe (result or error)
   * does so in milliseconds; only a 2025-11-25 server that IGNORES
   * unknown pre-initialize methods reaches this, and it then costs the
   * whole `timeout`, so the line says what is being waited on and how to
   * skip it. Never fires on HTTP (the caller narrates its own re-probe).
   */
  onStatus?: (message: string) => void;
}

/** How long the stdio era probe may sit unanswered before `onStatus` fires. */
export const STDIO_PROBE_STATUS_DELAY_MS = 2000;

function formatSeconds(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${(ms / 1000).toFixed(1)}s`;
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
      : result !== undefined
        ? "result without supportedVersions"
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
 * Whether a legacy-classified probe answer plainly shows a server of the
 * other era, as opposed to an outage or an intermediary's page: a
 * JSON-RPC body (an error, or a result without supportedVersions), or an
 * HTTP 4xx. A 5xx, or a non-JSON-RPC body at any other status (an HTML
 * page at 200, an empty body), says nothing about the era, so a pinned
 * run must not suggest switching eras on it.
 */
export function probeAnswerShowsEra(res: TransportResponse | null): boolean {
  if (!res) return false;
  const status = res.statusCode;
  if (status !== undefined && status >= 500) return false;
  if (status !== undefined && status >= 400) return true;
  const body = res.body as { jsonrpc?: unknown; result?: unknown; error?: unknown } | null | undefined;
  if (!body || typeof body !== "object") return false;
  return body.jsonrpc === "2.0" || body.result !== undefined || (!!body.error && typeof body.error === "object");
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
  const timer =
    opts.onStatus && transport.kind === "stdio"
      ? setTimeout(() => {
          opts.onStatus?.(
            `Probing spec era (server/discover, up to ${formatSeconds(opts.timeout)}). A ${LEGACY_SPEC_VERSION} server that ignores unknown methods takes the whole startup timeout; --spec-version ${LEGACY_SPEC_VERSION} skips the probe.`,
          );
        }, STDIO_PROBE_STATUS_DELAY_MS)
      : null;
  let res: TransportResponse | null = null;
  try {
    res = await transport.request("server/discover", probe.params, opts.nextId, {
      timeout: opts.timeout,
      headers: transport.kind === "http" ? probe.headers : undefined,
      signal: opts.signal,
    });
  } catch {
    res = null;
  } finally {
    if (timer) clearTimeout(timer);
  }
  return classifyDiscoverResponse(res);
}

// ── A stdio child that died on the probe ─────────────────────────────
// A legacy server whose dispatcher throws on an unknown method exits on
// `server/discover`; so does a server that exits at startup whatever it
// is sent (a missing env var, a one-shot CLI, a bad path). The suite and
// the benchmark both spawn a fresh instance and, once that instance's
// first exchange has settled, tell the two apart in one warning.

/**
 * The last few meaningful stderr lines of a stdio child, one line, for a
 * warning or a details string. Drops stack-frame lines ("    at ...")
 * and bare punctuation so the line that names the cause (e.g. "Error:
 * unhandled method server/discover") survives ahead of the frames that
 * follow it.
 */
export function summarizeStderr(tail: string): string {
  const lines = tail
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^at\s/.test(l) && /[A-Za-z0-9]/.test(l));
  return lines
    .slice(-3)
    .map((l) => (l.length > 160 ? `${l.slice(0, 157)}...` : l))
    .join(" | ");
}

/**
 * The stderr a dead child left behind. The 'exit' event that rejected the
 * request can land before the parent has read the pipe (a crashing Node
 * prints its stack, then exits; the two completions are not ordered), so
 * give the stream a moment to drain before quoting it.
 */
export async function settledStderr(dead: StdioTransport): Promise<string> {
  const deadline = Date.now() + 200;
  while (!dead.stderrTail().trim() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  await new Promise((r) => setTimeout(r, 20));
  return dead.stderrTail();
}

export interface ProbeExit {
  exitCode: number | null;
  /** One-line stderr summary (may be empty). */
  stderr: string;
}

/** The exit diagnostic of a stdio child that died on the probe, or null when it is alive (or the transport is HTTP). */
export async function probeExitOf(transport: Transport): Promise<ProbeExit | null> {
  if (transport.kind !== "stdio") return null;
  const dead = transport as StdioTransport;
  if (!dead.exited) return null;
  return { exitCode: dead.exitCode, stderr: summarizeStderr(await settledStderr(dead)) };
}

/**
 * The warning for a child that exited on the probe, composed once the
 * fresh instance's first exchange (the legacy initialize, or the modern
 * discover) has settled. `answered` says whether that exchange got any
 * reply. Only a fresh instance that survived earns the "died on the
 * probe" reading and its pin advice; when the fresh instance exited
 * unanswered too, the server exits at startup regardless of the probe,
 * and blaming the probe would send the user to pin a version that
 * changes nothing.
 */
export async function probeExitWarning(
  exit: ProbeExit,
  fresh: Transport,
  opts: { era: DetectionResult["era"]; answered: boolean; spawner: "suite" | "benchmark" },
): Promise<string> {
  const freshStdio = fresh.kind === "stdio" ? (fresh as StdioTransport) : null;
  if (opts.era === "legacy" && !opts.answered && freshStdio && !freshStdio.exited) {
    // An unanswered first exchange usually means the child is dying; its
    // write error can settle a beat before the 'exit' event lands.
    const deadline = Date.now() + 300;
    while (!freshStdio.exited && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  if (opts.era === "legacy" && !opts.answered && freshStdio?.exited) {
    const stderr = summarizeStderr(await settledStderr(freshStdio)) || exit.stderr;
    return `Server exited (code ${exit.exitCode}) before answering the ${MODERN_SPEC_VERSION} era probe (server/discover), and the fresh instance the ${opts.spawner} spawned exited at startup as well (code ${freshStdio.exitCode}) before answering initialize: the server exits at startup regardless of the probe${stderr ? `; last stderr: ${stderr}` : ""}. Check the command, its arguments and its environment.`;
  }
  const why =
    opts.era === "legacy"
      ? ` A ${LEGACY_SPEC_VERSION} server must tolerate unknown pre-initialize requests (answer with a JSON-RPC error or ignore them, never exit); pin --spec-version ${LEGACY_SPEC_VERSION} to skip the probe.`
      : "";
  return `Server exited (code ${exit.exitCode}) after the ${MODERN_SPEC_VERSION} era probe (server/discover)${exit.stderr ? `; last stderr: ${exit.stderr}` : ""}. The ${opts.spawner} spawned a fresh instance.${why}`;
}
