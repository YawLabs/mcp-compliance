import type { DetectionResult } from "../../detect.js";
import type { Harness } from "../../harness.js";
import { errorOf, type ModernClient, type RpcResponse, resultOf } from "../../modern/client.js";
import type { Recorder } from "../../recorder.js";
import type { Transport, TransportKind } from "../../transport/index.js";

/**
 * Shared state of one 2026-07-28 suite run. Category modules receive
 * this and register their tests through `harness.check`. Mutable fields
 * are populated in suite order (lifecycle fills `discover`/capabilities,
 * the feature modules fill the cached lists) -- later modules read them
 * through the `ensure*` loaders below, which fetch a list once on demand
 * so a `--only <category>` run still exercises real server data instead
 * of skipping.
 */
export interface ModernState {
  /** The `server/discover` response the suite is using (null = discover failed). */
  discover: RpcResponse | null;
  /**
   * How the conformant setup `server/discover` was rejected, when it was.
   * Negative probes compare against it: a rejection identical to the one
   * the CONFORMANT request drew proves nothing about the injected defect.
   */
  discoverRejection: { code: number | null; statusCode: number } | null;
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
  /**
   * Set by lifecycle-dual-era when a LEGACY `initialize` was answered with
   * an InitializeResult: the server serves the 2025 handshake as well.
   * SDK 2.0 servers advertise only modern versions in `supportedVersions`
   * yet still serve initialize, so the dual-era warning keys on both.
   */
  legacyInitializeServed: boolean;
  /** List methods already attempted (so a failed list is not re-fetched). */
  listAttempts: Set<ListKey>;
}

export type ListKey = "tools" | "resources" | "prompts" | "resourceTemplates";

export const LIST_METHOD: Record<ListKey, string> = {
  tools: "tools/list",
  resources: "resources/list",
  prompts: "prompts/list",
  resourceTemplates: "resources/templates/list",
};

const LIST_RESULT_KEY: Record<ListKey, string> = {
  tools: "tools",
  resources: "resources",
  prompts: "prompts",
  resourceTemplates: "resourceTemplates",
};

const LIST_CAPABILITY: Record<ListKey, string> = {
  tools: "tools",
  resources: "resources",
  prompts: "prompts",
  resourceTemplates: "resources",
};

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
  /**
   * stdio only: spawn a second, independent instance of the server. A
   * dual-era stdio server pins its era per process, so a probe that must
   * see "what a legacy client opening a fresh process gets" (the
   * lifecycle-dual-era initialize) cannot share the suite's process.
   * Callers own the returned transport and must close() it.
   */
  spawnFresh?: () => Transport;
  state: ModernState;
}

export function createModernState(): ModernState {
  return {
    discover: null,
    discoverRejection: null,
    supportedVersions: [],
    capabilities: {},
    serverInfo: { name: null, version: null },
    instructions: null,
    tools: null,
    toolNames: [],
    resources: null,
    resourceNames: [],
    resourceTemplates: null,
    prompts: null,
    promptNames: [],
    legacyInitializeServed: false,
    listAttempts: new Set(),
  };
}

export function hasCapability(ctx: ModernSuiteContext, name: string): boolean {
  const cap = ctx.state.capabilities[name];
  return !!cap && typeof cap === "object";
}

export const hasTools = (ctx: ModernSuiteContext) => hasCapability(ctx, "tools");
export const hasResources = (ctx: ModernSuiteContext) => hasCapability(ctx, "resources");
export const hasPrompts = (ctx: ModernSuiteContext) => hasCapability(ctx, "prompts");
export const hasCompletions = (ctx: ModernSuiteContext) => hasCapability(ctx, "completions");

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function namesOf(items: Record<string, unknown>[]): string[] {
  return items.map((i) => i.name).filter((n): n is string => typeof n === "string");
}

/** Publish a list response into ctx.state when it carries a valid array. */
export function publishList(ctx: ModernSuiteContext, key: ListKey, res: RpcResponse): unknown[] | null {
  const list = resultOf(res.body)?.[LIST_RESULT_KEY[key]];
  if (!Array.isArray(list) || !list.every(isPlainObject)) return null;
  const items = list as Record<string, unknown>[];
  switch (key) {
    case "tools":
      ctx.state.tools = items;
      ctx.state.toolNames = namesOf(items);
      break;
    case "resources":
      ctx.state.resources = items;
      ctx.state.resourceNames = namesOf(items);
      break;
    case "prompts":
      ctx.state.prompts = items;
      ctx.state.promptNames = namesOf(items);
      break;
    case "resourceTemplates":
      ctx.state.resourceTemplates = items;
      break;
  }
  return items;
}

/**
 * The cached list, fetching it once when nothing has asked for it yet.
 * Returns null when the server does not declare the capability, when the
 * list call failed (the `-list` test reports why), or when a list was
 * already attempted and failed. Every module reads lists through this so
 * `--only <category>` runs measure the server rather than skipping.
 */
export async function ensureList(ctx: ModernSuiteContext, key: ListKey): Promise<any[] | null> {
  const cached = ctx.state[key];
  if (cached) return cached;
  if (!hasCapability(ctx, LIST_CAPABILITY[key])) return null;
  if (ctx.state.listAttempts.has(key)) return null;
  ctx.state.listAttempts.add(key);
  try {
    const res = await ctx.client.rpc(LIST_METHOD[key]);
    if (errorOf(res.body)) return null;
    return publishList(ctx, key, res);
  } catch {
    return null;
  }
}

export const ensureTools = (ctx: ModernSuiteContext) => ensureList(ctx, "tools");
export const ensureResources = (ctx: ModernSuiteContext) => ensureList(ctx, "resources");
export const ensurePrompts = (ctx: ModernSuiteContext) => ensureList(ctx, "prompts");
export const ensureResourceTemplates = (ctx: ModernSuiteContext) => ensureList(ctx, "resourceTemplates");
