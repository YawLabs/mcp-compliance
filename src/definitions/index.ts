import { LEGACY_SPEC_VERSION, MODERN_SPEC_VERSION, type SpecVersion } from "../spec.js";
import { TEST_DEFINITIONS, type TestDefinition } from "../types.js";
import { MODERN_TEST_DEFINITIONS } from "./2026-07-28.js";

/**
 * Test catalogs per spec revision. The 2025-11-25 catalog is the
 * long-standing `TEST_DEFINITIONS` export in types.ts; the 2026-07-28
 * catalog lives next to this file. Ids are only comparable within one
 * catalog — a reused id means the check is semantically identical in
 * both eras, a new id means the pass criteria differ.
 */
export function getTestDefinitions(version: SpecVersion): TestDefinition[] {
  if (version === MODERN_SPEC_VERSION) return MODERN_TEST_DEFINITIONS;
  if (version === LEGACY_SPEC_VERSION) return TEST_DEFINITIONS;
  throw new Error(`No test catalog for spec version ${version as string}`);
}

const MAPS = new Map<SpecVersion, ReadonlyMap<string, TestDefinition>>();

/** Same catalog, keyed by id (cached). */
export function getTestDefinitionMap(version: SpecVersion): ReadonlyMap<string, TestDefinition> {
  let m = MAPS.get(version);
  if (!m) {
    m = new Map(getTestDefinitions(version).map((d) => [d.id, d]));
    MAPS.set(version, m);
  }
  return m;
}

/** Look a test up by id in a specific catalog. */
export function findTestDefinition(version: SpecVersion, id: string): TestDefinition | undefined {
  return getTestDefinitionMap(version).get(id);
}

export { MODERN_TEST_DEFINITIONS };
