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
  return createHash("sha256").update(url).digest("hex").slice(0, 12);
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
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), { mode: 0o600 });
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
