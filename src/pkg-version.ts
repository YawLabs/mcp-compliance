import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Injected by esbuild's `--define:__VERSION__` at single-binary (SEA) build
// time. Guarded by `typeof` so it stays undefined under tsx/dist (where the
// filesystem walk below is the real source of truth). esbuild dead-code-
// eliminates the typeof branch under the define, so this carries no runtime
// cost in the bundled binary.
declare const __VERSION__: string | undefined;

/**
 * Resolve this package's version by walking up from a module's URL to the
 * nearest package.json. Works whether running from src/ (tsx), a standalone
 * dist entry, or bundled into dist/index.js — import.meta.url points at
 * wherever the code physically lives and the walk finds the owning
 * package.json. Returns "0.0.0" if none is found or it can't be parsed.
 *
 * In the CJS single-binary (Node SEA) bundle, `import.meta.url` is empty
 * (esbuild's cjs output cannot populate it), so `metaUrl` arrives undefined.
 * There we prefer the build-time `__VERSION__` define and never touch the
 * filesystem — the package.json the walk looks for does not exist next to a
 * standalone binary.
 *
 * Pass `import.meta.url` from the calling module.
 */
export function readPackageVersion(metaUrl: string): string {
  if (typeof __VERSION__ === "string" && __VERSION__) return __VERSION__;
  // CJS bundle: import.meta.url is empty -> metaUrl is undefined. Avoid
  // fileURLToPath(undefined) (throws ERR_INVALID_ARG_TYPE) and bail to the
  // default rather than crash at module load.
  if (!metaUrl) return "0.0.0";
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
