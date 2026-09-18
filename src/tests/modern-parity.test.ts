import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MODERN_TEST_DEFINITIONS } from "../definitions/index.js";

// ─────────────────────────────────────────────────────────────────────
// Parity guard for the 2026-07-28 suite, the modern counterpart of the
// runner ↔ TEST_DEFINITIONS guard in types.test.ts. The legacy suite
// declares each test inline (`await test("<id>", name, category, ...)`)
// so a drifted id only produced a metadata miss; the modern suite is
// definition-driven (`harness.check("<id>", fn)` throws on an unknown id),
// so the live failure mode is the OTHER direction: a definition nobody
// invokes ships as a catalog entry that never runs, and the README /
// rules.json / rubric counts (all derived from the catalog) overstate what
// the tool checks. Post-hoc and stdio modules are scanned like any other.
// ─────────────────────────────────────────────────────────────────────

const SUITE_DIR = fileURLToPath(new URL("../suites/modern/", import.meta.url));

/**
 * The helper modules that register no test: the shared context, the gate
 * reader (whose answer a rejection is) that several modules share, and the
 * stdio liveness probe stdio-unicode and lifecycle-progress-token share.
 */
const HELPERS = ["context.ts", "gate.ts", "liveness.ts"];

/** Every module in src/suites/modern except the orchestrator itself and the helpers. */
const MODULES = readdirSync(SUITE_DIR)
  .filter((f) => f.endsWith(".ts") && f !== "index.ts" && !HELPERS.includes(f))
  .sort();

const INDEX_SRC = readFileSync(join(SUITE_DIR, "index.ts"), "utf8");

/**
 * Call sites that run a catalog test:
 *   - `check("<id>", ...)` / `harness.check("<id>", ...)` /
 *     `ctx.harness.check("<id>", ...)`, including the multi-line form
 *     `harness.check(\n  "<id>",` (whitespace allowed after the paren);
 *   - `injection("<id>", ...)`, security.ts's local wrapper around
 *     `check(id, ...)` for the four input-validation tests (the guard
 *     below proves it still forwards to `check`).
 * `expectRejection(ctx, "<id>", ...)` also carries an id, as a label for
 * warnings, but it is not preceded by `check(`/`injection(` so it is not
 * counted -- it sits inside the `harness.check("<id>", () => expectRejection(...))`
 * that IS counted.
 */
const CALL_SITE_RE = /\b(?:check|injection)\(\s*["']([a-z]+-[a-z0-9-]+)["']/g;

function callSitesIn(file: string): string[] {
  const src = readFileSync(join(SUITE_DIR, file), "utf8");
  return [...src.matchAll(CALL_SITE_RE)].map((m) => m[1]);
}

const callSites = new Map<string, string[]>(MODULES.map((f) => [f, callSitesIn(f)]));
const allInvoked = [...callSites.values()].flat();
const definedIds = MODERN_TEST_DEFINITIONS.map((t) => t.id);

describe("modern suite modules ↔ MODERN_TEST_DEFINITIONS parity", () => {
  it("scans the expected module set (a new module must be added to index.ts, see below)", () => {
    expect(MODULES).toEqual([
      "errors.ts",
      "features.ts",
      "lifecycle.ts",
      "posthoc.ts",
      "schema.ts",
      "security.ts",
      "stdio.ts",
      "transport.ts",
    ]);
  });

  it("no module interpolates a raw JSON-RPC error code into a string (errorCodeText / errorWithCode render it)", () => {
    // errorOf() turns a code that is not a number into NaN so comparisons
    // fail safe; printed raw it read "JSON-RPC error NaN". rawCode carries
    // what the server sent.
    const RAW_CODE_RE = /\$\{(?:err\w*|error\w*|errorOf\([^)]*\)\??)\.code\}/g;
    const offenders = [...MODULES, ...HELPERS].flatMap((f) =>
      [...readFileSync(join(SUITE_DIR, f), "utf8").matchAll(RAW_CODE_RE)].map((m) => `${f}: ${m[0]}`),
    );
    expect(offenders).toEqual([]);
  });

  it("security.ts's injection() wrapper still forwards to check(id, ...)", () => {
    const src = readFileSync(join(SUITE_DIR, "security.ts"), "utf8");
    expect(src).toMatch(/const injection = \([^)]*\) =>\s*check\(id,/);
  });

  it("every invoked id has a MODERN_TEST_DEFINITIONS entry", () => {
    const defined = new Set(definedIds);
    const unknown = [...callSites.entries()].flatMap(([file, ids]) =>
      ids.filter((id) => !defined.has(id)).map((id) => `${file}: ${id}`),
    );
    expect(unknown).toEqual([]);
  });

  it("every MODERN_TEST_DEFINITIONS id is invoked by some module", () => {
    const invoked = new Set(allInvoked);
    const orphans = definedIds.filter((id) => !invoked.has(id));
    expect(orphans).toEqual([]);
  });

  it("each id is invoked exactly once across all modules", () => {
    const counts = new Map<string, string[]>();
    for (const [file, ids] of callSites) {
      for (const id of ids) counts.set(id, [...(counts.get(id) ?? []), file]);
    }
    const dupes = [...counts.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([id, files]) => `${id} in ${files.join(", ")}`);
    expect(dupes).toEqual([]);
  });

  it("invoked count equals the catalog length (103)", () => {
    expect(allInvoked.length).toBe(MODERN_TEST_DEFINITIONS.length);
    expect(allInvoked.length).toBe(103);
  });

  it("post-hoc and stdio modules each own the ids their names promise", () => {
    const posthoc = callSites.get("posthoc.ts") ?? [];
    expect(posthoc).toEqual(
      expect.arrayContaining([
        "transport-no-server-requests",
        "lifecycle-log-level-gating",
        "error-id-echo",
        "error-retired-codes",
        "schema-result-type",
        "schema-no-input-required-on-lists",
        "schema-input-required-shape",
        "schema-wire-valid",
      ]),
    );
    const stdio = callSites.get("stdio.ts") ?? [];
    expect(stdio.sort()).toEqual([
      "stdio-cancellation",
      "stdio-framing",
      "stdio-unicode",
      "stdio-unknown-method-recovers",
    ]);
    for (const id of stdio) {
      expect(MODERN_TEST_DEFINITIONS.find((t) => t.id === id)?.transports, id).toEqual(["stdio"]);
    }
  });

  it("every module's ids stay within the categories its name implies", () => {
    const category = new Map(MODERN_TEST_DEFINITIONS.map((t) => [t.id, t.category]));
    const expectedCategories: Record<string, string[]> = {
      "errors.ts": ["errors"],
      "features.ts": ["tools", "resources", "prompts"],
      "lifecycle.ts": ["lifecycle"],
      "schema.ts": ["schema"],
      "security.ts": ["security"],
      "stdio.ts": ["transport"],
      "transport.ts": ["transport"],
      // Post-hoc checks are cross-cutting by design.
      "posthoc.ts": ["transport", "lifecycle", "errors", "schema"],
    };
    for (const [file, ids] of callSites) {
      const strays = ids.filter((id) => !expectedCategories[file]?.includes(category.get(id) ?? "?"));
      expect(strays, `${file} runs ids outside ${expectedCategories[file]?.join("/")}`).toEqual([]);
    }
  });
});

describe("index.ts runs every run* function the modules export", () => {
  const exported = new Map<string, string[]>(
    MODULES.map((file) => {
      const src = readFileSync(join(SUITE_DIR, file), "utf8");
      return [file, [...src.matchAll(/^export (?:async )?function (run[A-Za-z]+)\(/gm)].map((m) => m[1])];
    }),
  );
  const allExported = [...exported.values()].flat();
  const imported = [...INDEX_SRC.matchAll(/^import \{([^}]+)\} from "\.\/([a-z]+)\.js";/gm)].flatMap((m) =>
    m[1]
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.startsWith("run"))
      .map((name) => `${m[2]}.ts:${name}`),
  );
  const called = [...INDEX_SRC.matchAll(/await (run[A-Za-z]+)\(ctx\)/g)].map((m) => m[1]);

  it("every module exports at least one run* function", () => {
    for (const [file, names] of exported) expect(names.length, `${file} exports no run* function`).toBeGreaterThan(0);
  });

  it("index.ts imports each exported run* function from its own module", () => {
    const expected = [...exported.entries()].flatMap(([file, names]) => names.map((n) => `${basename(file)}:${n}`));
    expect(imported.sort()).toEqual(expected.sort());
  });

  it("index.ts awaits each exported run* function exactly once", () => {
    const counts = new Map<string, number>();
    for (const name of called) counts.set(name, (counts.get(name) ?? 0) + 1);
    const missing = allExported.filter((n) => !counts.has(n));
    const extra = [...counts.keys()].filter((n) => !allExported.includes(n));
    const repeated = [...counts.entries()].filter(([, n]) => n > 1).map(([n]) => n);
    expect({ missing, extra, repeated }).toEqual({ missing: [], extra: [], repeated: [] });
  });

  it("keeps the documented order: lifecycle first, late lifecycle after every feature, post-hoc last", () => {
    expect(called[0]).toBe("runLifecycle");
    expect(called.indexOf("runLifecycleLate")).toBeGreaterThan(called.indexOf("runStdio"));
    expect(called[called.length - 1]).toBe("runPostHoc");
    // Post-hoc scans the recorder, so the parallel pool must drain first.
    const postHocAt = INDEX_SRC.indexOf("await runPostHoc(ctx)");
    const drainBefore = INDEX_SRC.lastIndexOf("await harness.drainPool()", postHocAt);
    expect(drainBefore).toBeGreaterThan(INDEX_SRC.indexOf("await runLifecycleLate(ctx)"));
  });
});
