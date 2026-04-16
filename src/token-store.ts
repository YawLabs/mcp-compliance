import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const STORE_DIR = join(homedir(), ".mcp-compliance");
const STORE_PATH = join(STORE_DIR, "tokens.json");

export interface TokenEntry {
  deleteToken: string;
  url: string;
  publishedAt: string;
}

type Store = Record<string, TokenEntry>;

export function hashUrl(url: string): string {
  // Must match mcp-hosting's hash width (24 hex = 96 bits). Older v0.9.0
  // installs used 12 chars; the server accepts both for read/delete.
  return createHash("sha256").update(url).digest("hex").slice(0, 24);
}

function readStore(): Store {
  if (!existsSync(STORE_PATH)) return {};
  try {
    const raw = readFileSync(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

function writeStore(store: Store): void {
  const dir = dirname(STORE_PATH);
  try {
    // The mode flags are best-effort: they constrain the file to the owner
    // on POSIX, but Node silently ignores `mode` on Win32 (mode controls
    // only the read-only bit). Protection on Windows comes from the
    // default NTFS ACL on %USERPROFILE%, which already restricts the
    // %USERPROFILE%\.mcp-compliance directory to the current user. These
    // are delete-tokens for a public reporting service, not credentials;
    // per-user filesystem isolation is adequate for the threat model.
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), { mode: 0o600 });
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EACCES" || code === "EPERM") {
      throw new Error(
        `Cannot write delete-token store at ${STORE_PATH}: permission denied. ` +
          "If you don't need to publish, re-run with --no-publish. Otherwise, ensure your home directory is writable.",
      );
    }
    if (code === "ENOSPC") {
      throw new Error(`Cannot write delete-token store at ${STORE_PATH}: no space left on device.`);
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot write delete-token store at ${STORE_PATH}: ${message}`);
  }
}

export function saveToken(hash: string, entry: TokenEntry): void {
  const store = readStore();
  store[hash] = entry;
  writeStore(store);
}

export function getTokenForUrl(url: string): { hash: string; entry: TokenEntry } | null {
  const hash = hashUrl(url);
  const store = readStore();
  const entry = store[hash];
  return entry ? { hash, entry } : null;
}

export function deleteToken(hash: string): void {
  const store = readStore();
  if (!(hash in store)) return;
  delete store[hash];
  writeStore(store);
}

export const tokenStorePath = STORE_PATH;
