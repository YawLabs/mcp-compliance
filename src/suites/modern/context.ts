import type { DetectionResult } from "../../detect.js";
import type { Harness } from "../../harness.js";
import type { ModernClient, RpcResponse } from "../../modern/client.js";
import type { Recorder } from "../../recorder.js";
import type { Transport, TransportKind } from "../../transport/index.js";

/**
 * Shared state of one 2026-07-28 suite run. Category modules receive
 * this and register their tests through `harness.check`. Mutable fields
 * are populated in suite order (lifecycle fills `discover`/capabilities,
 * the feature modules fill the cached lists) — later modules may read
 * them, never re-fetch.
 */
export interface ModernState {
  /** The `server/discover` response the suite is using (null = discover failed). */
  discover: RpcResponse | null;
  supportedVersions: string[];
  capabilities: Record<string, unknown>;
  serverInfo: { name: string | null; version: string | null };
  instructions: string | null;
  /** tools/list result, or null when the list was not obtained. */
  tools: any[] | null;
  toolNames: string[];
  resources: any[] | null;
  resourceNames: string[];
  resourceTemplates: any[] | null;
  prompts: any[] | null;
  promptNames: string[];
}

export interface ModernSuiteContext {
  harness: Harness;
  client: ModernClient;
  recorder: Recorder;
  transport: Transport;
  kind: TransportKind;
  /** Per-request timeout (ms). */
  timeout: number;
  /** Budget for the first exchange with a cold stdio server (ms). */
  startupTimeout: number;
  /** HTTP URL of the server, "" on stdio. */
  backendUrl: string;
  /** Configured user headers (Authorization etc.), {} on stdio. */
  userHeaders: Record<string, string>;
  displayUrl: string;
  /** Result of `auto` detection, undefined when the version was pinned. */
  detection: DetectionResult | undefined;
  /** Whether the run was given credentials (`--auth` / an Authorization header). */
  hasAuth: boolean;
  state: ModernState;
}

export function hasCapability(ctx: ModernSuiteContext, name: string): boolean {
  const cap = ctx.state.capabilities[name];
  return !!cap && typeof cap === "object";
}

export const hasTools = (ctx: ModernSuiteContext) => hasCapability(ctx, "tools");
export const hasResources = (ctx: ModernSuiteContext) => hasCapability(ctx, "resources");
export const hasPrompts = (ctx: ModernSuiteContext) => hasCapability(ctx, "prompts");
export const hasCompletions = (ctx: ModernSuiteContext) => hasCapability(ctx, "completions");
