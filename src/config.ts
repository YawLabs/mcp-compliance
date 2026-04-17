import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TransportTarget } from "./types.js";

/**
 * Config file shape. Every field optional — config supplies defaults
 * that CLI flags override.
 */
export interface ComplianceConfig {
  target?: TransportTarget;
  timeout?: number;
  startupTimeout?: number;
  preflightTimeout?: number;
  retries?: number;
  only?: string[];
  skip?: string[];
  strict?: boolean;
  format?: "terminal" | "json" | "sarif";
  verbose?: boolean;
}

const SEARCH_NAMES = ["mcp-compliance.config.json", ".mcp-compliancerc.json", ".mcp-compliancerc"];

/**
 * Load config from an explicit path, or search cwd for known names, or
 * read the "mcp-compliance" field from package.json. Returns null when
 * no config is found.
 */
export function loadConfig(explicitPath?: string, cwd: string = process.cwd()): ComplianceConfig | null {
  if (explicitPath) {
    const abs = resolve(cwd, explicitPath);
    if (!existsSync(abs)) throw new Error(`Config file not found: ${explicitPath}`);
    return parseConfig(readFileSync(abs, "utf8"), abs);
  }

  for (const name of SEARCH_NAMES) {
    const abs = join(cwd, name);
    if (existsSync(abs)) return parseConfig(readFileSync(abs, "utf8"), abs);
  }

  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { "mcp-compliance"?: unknown };
      if (pkg["mcp-compliance"]) return validate(pkg["mcp-compliance"], pkgPath);
    } catch {
      // package.json unparseable — ignore, not our problem
    }
  }

  return null;
}

function parseConfig(contents: string, source: string): ComplianceConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(contents);
  } catch (err) {
    throw new Error(`Failed to parse config at ${source}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return validate(raw, source);
}

function validate(raw: unknown, source: string): ComplianceConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Config at ${source} must be a JSON object`);
  }
  const obj = raw as Record<string, unknown>;
  const allowed = new Set([
    "target",
    "timeout",
    "startupTimeout",
    "preflightTimeout",
    "retries",
    "only",
    "skip",
    "strict",
    "format",
    "verbose",
  ]);
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) {
      throw new Error(`Config at ${source}: unknown key "${k}"`);
    }
  }
  if (obj.target !== undefined) validateTarget(obj.target, source);
  if (obj.format !== undefined && !["terminal", "json", "sarif"].includes(obj.format as string)) {
    throw new Error(`Config at ${source}: format must be one of terminal, json, sarif`);
  }
  return obj as ComplianceConfig;
}

function validateTarget(t: unknown, source: string): void {
  if (!t || typeof t !== "object" || Array.isArray(t)) {
    throw new Error(`Config at ${source}: target must be an object`);
  }
  const obj = t as Record<string, unknown>;
  if (obj.type !== "http" && obj.type !== "stdio") {
    throw new Error(`Config at ${source}: target.type must be "http" or "stdio"`);
  }
  if (obj.type === "http" && typeof obj.url !== "string") {
    throw new Error(`Config at ${source}: http target requires string "url"`);
  }
  if (obj.type === "stdio" && typeof obj.command !== "string") {
    throw new Error(`Config at ${source}: stdio target requires string "command"`);
  }
}
