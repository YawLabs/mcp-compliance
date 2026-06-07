import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve this package's version by walking up from a module's URL to the
 * nearest package.json. Works whether running from src/ (tsx), a standalone
 * dist entry, or bundled into dist/index.js — import.meta.url points at
 * wherever the code physically lives and the walk finds the owning
 * package.json. Returns "0.0.0" if none is found or it can't be parsed.
 *
 * Pass `import.meta.url` from the calling module.
 */
export function readPackageVersion(metaUrl: string): string {
  let dir = dirname(fileURLToPath(metaUrl));
  for (;;) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        return (JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string }).version ?? "0.0.0";
      } catch {
        return "0.0.0";
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return "0.0.0";
    dir = parent;
  }
}
