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
  /** Whether the probe carried a user-configured Authorization header (see ClassifyOptions). */
  authorizationSent?: boolean;
}

export interface ClassifyOptions {
  /**
   * Whether the probe carried a user-configured Authorization header. It
   * decides how a 401/403 reads (see `readAuthRefusal`). With a header, a
   * 401, or a 403 whose Bearer challenge carries an `error` parameter,
   * means the credential was rejected, any other 403 is worded as
   * forbidden, and the reason never tells the user to pass --auth. Without
   * one, a 401, or a 403 carrying a Bearer challenge, means a credential is
   * required (pass --auth), and any other 403 is worded as forbidden.
   */
  authorizationSent?: boolean;
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
   * With `eraUndetermined`: how the refusal reads (see `readAuthRefusal`).
   * Callers word their warning from this, not from the preflight, which a
   * re-probe after a preflight timeout never saw.
   */
  refusal?: AuthRefusal;
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

type HeaderMap = Record<string, string | string[] | undefined>;

/** One challenge of a WWW-Authenticate header: its scheme and auth-params, both names lower-cased. */
interface AuthChallenge {
  scheme: string;
  params: Map<string, string>;
}

const TCHAR = /[!#$%&'*+.^_`|~0-9A-Za-z-]/;

/**
 * Split one WWW-Authenticate value into its challenges (RFC 9110 11.6.1).
 * Commas separate both the challenges and the auth-params inside one, so a
 * bare token after a comma starts a challenge, a `name=value` pair belongs
 * to the challenge before it, and a token68 (`Negotiate ab/cd==`) is
 * skipped. Quoted values are unescaped, so text inside one (`realm="error=x"`)
 * is never read as a parameter. Lenient: malformed input yields whatever
 * challenges parse, never an exception.
 */
function parseChallenges(value: string): AuthChallenge[] {
  const challenges: AuthChallenge[] = [];
  const n = value.length;
  let i = 0;
  // A bare token right after a scheme (no comma between) is its token68.
  let afterScheme = false;
  const skipBlanks = () => {
    while (i < n && (value[i] === " " || value[i] === "\t")) i++;
  };
  while (i < n) {
    if (value[i] === ",") {
      afterScheme = false;
      i++;
      continue;
    }
    if (!TCHAR.test(value[i])) {
      i++;
      continue;
    }
    const start = i;
    while (i < n && TCHAR.test(value[i])) i++;
    const token = value.slice(start, i);
    skipBlanks();
    if (value[i] !== "=") {
      if (!afterScheme) {
        challenges.push({ scheme: token.toLowerCase(), params: new Map() });
        afterScheme = true;
      }
      continue;
    }
    i++;
    skipBlanks();
    if (i >= n || value[i] === "=" || value[i] === ",") {
      // token68 padding (`abc==`), not a parameter.
      while (i < n && value[i] !== ",") i++;
      continue;
    }
    let paramValue = "";
    if (value[i] === '"') {
      i++;
      while (i < n && value[i] !== '"') {
        if (value[i] === "\\" && i + 1 < n) i++;
        paramValue += value[i++];
      }
      i++;
    } else {
      const valueStart = i;
      while (i < n && value[i] !== "," && value[i] !== " " && value[i] !== "\t") i++;
      paramValue = value.slice(valueStart, i);
    }
    const current = challenges[challenges.length - 1];
    const name = token.toLowerCase();
    if (current && !current.params.has(name)) current.params.set(name, paramValue);
    afterScheme = false;
  }
  return challenges;
}

/** Every Bearer challenge across a response's WWW-Authenticate headers (names matched case-insensitively, repeated headers included). */
function bearerChallenges(headers: HeaderMap | undefined): AuthChallenge[] {
  if (!headers) return [];
  const out: AuthChallenge[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "www-authenticate" || value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) {
      out.push(...parseChallenges(v).filter((c) => c.scheme === "bearer"));
    }
  }
  return out;
}

/** Collapse whitespace, drop control characters and cap the length of server-supplied text quoted in a warning. */
function snippet(text: string, max: number): string {
  const flat = text
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

/**
 * How a 401/403 reads (see `readAuthRefusal`):
 * - `auth-required`: no Authorization header was sent, and the status asks
 *   for one (a 401, or a 403 carrying a Bearer challenge); pass --auth.
 * - `credential-rejected`: an Authorization header was sent and the status
 *   refused it (a 401, or a 403 whose Bearer challenge carries `error`).
 * - `forbidden`: any other 403. streamable-http requires a bare 403 for an
 *   invalid Origin and the SDK's Host validation answers a tunnel or proxy
 *   hostname with one, so it says nothing about the credential on its own.
 */
export type AuthRefusalKind = "auth-required" | "credential-rejected" | "forbidden";

export interface AuthRefusal {
  statusCode: number;
  /** Whether the refused request carried a user-configured Authorization header. */
  authorizationSent: boolean;
  kind: AuthRefusalKind;
  /** The `error` parameter of the response's first Bearer challenge that carries one ("invalid_token", "insufficient_scope", ...). */
  bearerError?: string;
  /** A JSON-RPC `error.message` in the body (e.g. "Invalid Host: abc.ngrok-free.app"), one line, capped at 120 chars. */
  message?: string;
}

/**
 * Read a 401/403 the way basic/authorization splits the two statuses
 * ("Authorization required or token invalid" is 401, "Invalid or expired
 * tokens MUST receive a HTTP 401"; 403 is "Invalid scopes or insufficient
 * permissions", signalled by a `WWW-Authenticate: Bearer
 * error="insufficient_scope"` challenge), and RFC 6750 3.1 (a request that
 * carried no token gets a Bearer challenge without an error code). Returns
 * undefined for any other status. Exported so every place that words a
 * 401/403 (the era-probe note and warning, transport-post in both suites,
 * the security suite) reads it the same way.
 */
export function readAuthRefusal(
  res: { statusCode?: number; headers?: HeaderMap; body?: unknown },
  authorizationSent: boolean,
): AuthRefusal | undefined {
  const { statusCode } = res;
  if (statusCode !== 401 && statusCode !== 403) return undefined;
  const bearer = bearerChallenges(res.headers);
  // RFC 6750 error values never contain `"` or `\`; drop them so the value quotes cleanly.
  const bearerError = bearer
    .map((c) => snippet((c.params.get("error") ?? "").replace(/["\\]/g, ""), 40))
    .find((e) => e !== "");
  let kind: AuthRefusalKind;
  if (authorizationSent) {
    kind = statusCode === 401 || bearerError !== undefined ? "credential-rejected" : "forbidden";
  } else {
    kind = statusCode === 401 || bearer.length > 0 ? "auth-required" : "forbidden";
  }
  const refusal: AuthRefusal = { statusCode, authorizationSent, kind };
  if (bearerError !== undefined) refusal.bearerError = bearerError;
  const rawMessage = (res.body as { error?: { message?: unknown } } | null | undefined)?.error?.message;
  const message = typeof rawMessage === "string" ? snippet(rawMessage, 120) : "";
  if (message) refusal.message = message;
  return refusal;
}

/**
 * Whether a 401/403 refused the credential a request carried: a 401
 * always, a 403 only when a Bearer challenge carries an `error` parameter
 * (a bare 403, or `Bearer realm=...` with no error, may be Host/Origin
 * validation or a gateway). `readAuthRefusal(res, true).kind ===
 * "credential-rejected"`, for callers that hold only a status and headers.
 */
export function refusedCredential(statusCode: number | undefined, headers: HeaderMap | undefined): boolean {
  return readAuthRefusal({ statusCode, headers }, true)?.kind === "credential-rejected";
}

/**
 * The parenthesised hint for a 401/403 in a note or a transport-post
 * detail: `noCredential` (the caller's "pass --auth" wording) when a
 * credential is required, "credential rejected" when the one sent was
 * refused, and a neutral "forbidden" naming Host/Origin validation, a
 * gateway, and missing credentials or the token's permissions otherwise.
 * `dash` is the separator the caller's wording uses.
 */
export function authRefusalHint(refusal: AuthRefusal, noCredential: string, dash = "--"): string {
  switch (refusal.kind) {
    case "auth-required":
      return noCredential;
    case "credential-rejected":
      return `credential rejected ${dash} check --auth`;
    default:
      return `forbidden ${dash} Host/Origin validation, a gateway, or ${refusal.authorizationSent ? "token permissions" : "missing credentials"}`;
  }
}

/**
 * Classify one response to a modern `server/discover` probe. Exported so
 * the classification rule is unit-testable without a live server.
 */
export function classifyDiscoverResponse(res: TransportResponse | null, opts: ClassifyOptions = {}): DetectionResult {
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
  const refusal = readAuthRefusal(res, opts.authorizationSent === true);
  if (refusal) {
    // Refused before the era could show (whatever the body says):
    // neither modern nor legacy is observable. The legacy default still
    // applies (spec: a 4xx without a modern error body falls back to
    // initialize). "pass --auth" only when the status asks for a
    // credential none was sent for; "credential rejected" only when it
    // refused the one sent; a bare 403 may be Host/Origin validation.
    const why = authRefusalHint(refusal, "authentication required -- pass --auth");
    return {
      version: LEGACY_SPEC_VERSION,
      era: "legacy",
      responded: true,
      eraUndetermined: true,
      refusal,
      reason: `${REASON_PREFIX}HTTP ${refusal.statusCode} (${why}); era not determinable, using ${LEGACY_SPEC_VERSION}`,
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
  return classifyDiscoverResponse(res, { authorizationSent: opts.authorizationSent });
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
