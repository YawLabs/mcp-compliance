import { errorWithCode } from "../../checks/validators.js";
import type { DetectionResult } from "../../detect.js";
import type { Harness, TestOutcome } from "../../harness.js";
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
  discoverRejection: { code: number | null; rawCode: unknown; statusCode: number } | null;
  /**
   * How long the setup `server/discover` took to answer (ms), null when
   * it never did. On a pinned stdio run it is the first exchange with the
   * process, so it bounds the server's cold start; the fresh-process
   * initialize probe (lifecycle-dual-era) sizes its wait from it.
   */
  discoverLatencyMs: number | null;
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
   * an InitializeResult carrying a protocolVersion: the server serves the
   * 2025 handshake. Read together with `discover`: served alongside a
   * DiscoverResult it is a dual-era server (SDK 2.0 servers advertise
   * only modern versions in `supportedVersions` yet still serve
   * initialize, so the dual-era warning keys on both); served while the
   * conformant server/discover was rejected it is a legacy-only server
   * pinned to the wrong suite.
   */
  legacyInitializeServed: boolean;
  /** List methods already attempted (so a failed list is not re-fetched). */
  listAttempts: Set<ListKey>;
  /**
   * Why a list is unavailable, per list: the JSON-RPC error the call drew,
   * the shape defect of its result, or the transport error's first line.
   * A check that needs the list reads it through `listUnavailable` so a
   * `--only` run that filtered out the `-list` test still names the cause
   * instead of pointing at a test that is not in the report.
   */
  listFailures: Partial<Record<ListKey, string>>;
}

export type ListKey = "tools" | "resources" | "prompts" | "resourceTemplates";

export const LIST_METHOD: Record<ListKey, string> = {
  tools: "tools/list",
  resources: "resources/list",
  prompts: "prompts/list",
  resourceTemplates: "resources/templates/list",
};

/** The catalog test that owns each list call (and reports its failure when it runs). */
export const LIST_TEST_ID: Record<ListKey, string> = {
  tools: "tools-list",
  resources: "resources-list",
  prompts: "prompts-list",
  resourceTemplates: "resources-templates",
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

/** Catalog category of each `LIST_TEST_ID` (what `harness.shouldRun` filters on). */
const LIST_TEST_CATEGORY: Record<ListKey, string> = {
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
  /**
   * Whether the run was given credentials (`--auth` / an Authorization
   * header). Matched on the header NAME case-insensitively (see
   * `runModernSuite` in ./index.ts): HTTP header names are
   * case-insensitive and `--header authorization:...` must count as a
   * credential exactly like `--header Authorization:...`, or the whole
   * auth suite silently reads as "no --auth provided".
   */
  hasAuth: boolean;
  /** RunOptions.signal, for requests made outside the shared client. */
  signal?: AbortSignal;
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
    discoverLatencyMs: null,
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
    listFailures: {},
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

/** ASCII, single-line, clipped: a server's error message can carry anything. */
function clip(text: string, max = 80): string {
  const line = (text.split("\n")[0] ?? "").replace(/[^\x20-\x7e]/g, "?").trim();
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

/**
 * Why a list response yields no list: a JSON-RPC error, no result object,
 * or a result without the array (or with non-object entries). Null when
 * the response carries a valid list.
 */
export function listFailureReason(key: ListKey, res: RpcResponse): string | null {
  const err = errorOf(res.body);
  if (err) return `${errorWithCode(err.rawCode)}${err.message ? ` (${clip(err.message, 60)})` : ""}`;
  const result = resultOf(res.body);
  if (!result) return `no result object (HTTP ${res.statusCode})`;
  const list = result[LIST_RESULT_KEY[key]];
  if (!Array.isArray(list)) return `result has no ${LIST_RESULT_KEY[key]} array`;
  if (!list.every(isPlainObject)) return `${LIST_RESULT_KEY[key]} array has non-object entries`;
  return null;
}

/** Remember why a list call failed (a transport error's first line, or a `listFailureReason`). */
export function recordListFailure(ctx: ModernSuiteContext, key: ListKey, reason: unknown): void {
  const text = reason instanceof Error ? reason.message : String(reason);
  ctx.state.listFailures[key] = clip(text, 120);
}

/**
 * Publish a list response into ctx.state when it carries a valid array;
 * otherwise record why it did not (see `listFailures`).
 */
export function publishList(ctx: ModernSuiteContext, key: ListKey, res: RpcResponse): unknown[] | null {
  const reason = listFailureReason(key, res);
  if (reason) {
    recordListFailure(ctx, key, reason);
    return null;
  }
  const items = (resultOf(res.body) as Record<string, unknown>)[LIST_RESULT_KEY[key]] as Record<string, unknown>[];
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
 * list call failed (the `-list` test reports why when it runs; otherwise
 * `listUnavailable` names the recorded reason), or when a list was
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
    return publishList(ctx, key, res);
  } catch (err) {
    recordListFailure(ctx, key, err);
    return null;
  }
}

/**
 * Verdict for a check that cannot run because the list it needs failed.
 * When the `-list` test that owns the call is in this run's report, the
 * check skip-passes and points at it (one failure, reported once). When
 * that test was filtered out (`--only schema`, `--skip tools-list`), the
 * check FAILS with the recorded reason: nothing else in the report would
 * name the broken list, and a green `--only tools-schema` on a server
 * whose tools/list is broken is exactly the false pass the check is
 * there to prevent. `what` says what the check had nothing to do
 * ("no tools list to validate").
 */
export function listUnavailable(ctx: ModernSuiteContext, key: ListKey, what: string): TestOutcome {
  const method = LIST_METHOD[key];
  const reason = ctx.state.listFailures[key] ?? (ctx.state.listAttempts.has(key) ? "no list obtained" : null);
  if (reason === null) return { passed: true, details: `skipped: no ${key} list available, ${what}` };
  if (ctx.harness.shouldRun(LIST_TEST_ID[key], LIST_TEST_CATEGORY[key])) {
    return { passed: true, details: `skipped: ${method} failed, ${what} (see ${LIST_TEST_ID[key]})` };
  }
  return { passed: false, details: `${method} failed (${reason}); ${what}` };
}

export const ensureTools = (ctx: ModernSuiteContext) => ensureList(ctx, "tools");
export const ensureResources = (ctx: ModernSuiteContext) => ensureList(ctx, "resources");
export const ensurePrompts = (ctx: ModernSuiteContext) => ensureList(ctx, "prompts");
export const ensureResourceTemplates = (ctx: ModernSuiteContext) => ensureList(ctx, "resourceTemplates");
