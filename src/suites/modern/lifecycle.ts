import type { ModernSuiteContext } from "./context.js";

/** PLACEHOLDER - implemented by the lifecycle task. */
export async function runLifecycle(_ctx: ModernSuiteContext): Promise<void> {}

/** Runs last: the legacy initialize probe can pin a dual-era stdio server to legacy semantics. */
export async function runLifecycleLate(_ctx: ModernSuiteContext): Promise<void> {}
