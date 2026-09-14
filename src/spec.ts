/**
 * Spec-version catalog. The tool tests against more than one MCP
 * specification revision per release; everything that depends on WHICH
 * revision (test definitions, spec-reference URLs, the wire envelope)
 * resolves through the helpers here rather than a global constant.
 *
 * Two eras exist:
 *   - "legacy"  (2025-11-25 and earlier): initialize handshake, sessions,
 *     ping, logging/setLevel, resources/subscribe, HTTP GET stream.
 *   - "modern"  (2026-07-28 and later): stateless, every request carries
 *     its protocol version + client capabilities in `params._meta`,
 *     `server/discover` replaces initialize, `subscriptions/listen`
 *     replaces the GET stream and resources/subscribe.
 */

export const SUPPORTED_SPEC_VERSIONS = ["2025-11-25", "2026-07-28"] as const;

export type SpecVersion = (typeof SUPPORTED_SPEC_VERSIONS)[number];

/** `auto` = probe the server and pick the newest era it speaks. */
export type SpecVersionOption = SpecVersion | "auto";

export const LEGACY_SPEC_VERSION: SpecVersion = "2025-11-25";
export const MODERN_SPEC_VERSION: SpecVersion = "2026-07-28";

/**
 * Version used when `auto` cannot decide (server unreachable, no
 * response to the probe). Legacy is the safe default: every server that
 * existed before 2026-07-28 speaks it, and the legacy suite already
 * reports unreachable servers as failures on every test.
 */
export const DEFAULT_SPEC_VERSION: SpecVersion = LEGACY_SPEC_VERSION;

export type SpecEra = "legacy" | "modern";

/**
 * Prefix of the report warning the runner emits when `auto` resolved the
 * spec version. Human-facing formatters lift that entry out of the
 * warnings list and into the header (it is information, not a problem);
 * JSON/SARIF consumers still see it as a warning.
 */
export const AUTO_DETECT_NOTE_PREFIX = "Spec version auto-detected as ";

export function specEraOf(version: SpecVersion): SpecEra {
  return version >= MODERN_SPEC_VERSION ? "modern" : "legacy";
}

export function isSpecVersion(value: unknown): value is SpecVersion {
  return typeof value === "string" && (SUPPORTED_SPEC_VERSIONS as readonly string[]).includes(value);
}

export function isSpecVersionOption(value: unknown): value is SpecVersionOption {
  return value === "auto" || isSpecVersion(value);
}

/** Base URL for spec references of the given revision. */
export function specBaseFor(version: SpecVersion): string {
  return `https://modelcontextprotocol.io/specification/${version}`;
}

/**
 * Parse a user-supplied `--spec-version` / config value. Throws with a
 * message that lists the accepted values so the CLI and config loader
 * can surface it verbatim.
 */
export function parseSpecVersionOption(value: string): SpecVersionOption {
  if (isSpecVersionOption(value)) return value;
  throw new Error(`Invalid spec version "${value}". Expected one of: auto, ${SUPPORTED_SPEC_VERSIONS.join(", ")}.`);
}
