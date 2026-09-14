import {
  brief,
  checkPagination,
  isInputRequired,
  isPlainObject,
  type RpcBodyCall,
  summarizeIssues,
  validateCachingHints,
  validateContentBlocks,
  validateInputRequired,
  validatePromptMessages,
  validateResourceContents,
  validateResourceTemplates,
} from "../../checks/validators.js";
import { errorOf, type RpcResponse, resultOf } from "../../modern/client.js";
import {
  ensureList,
  hasPrompts,
  hasResources,
  hasTools,
  LIST_METHOD,
  type ListKey,
  type ModernSuiteContext,
  publishList,
} from "./context.js";

/**
 * Tools / resources / prompts tests of the 2026-07-28 suite. Each block is
 * gated on the capability `server/discover` declared (absent from the
 * report otherwise). The list tests publish their arrays into `ctx.state`
 * through the context's `publishList`, and every consumer -- here and in
 * the lifecycle / transport / schema modules -- reads them back through
 * the context's `ensureList`, which fetches once on demand when a `-list`
 * test did not run (a `--only` run). One cache, one attempt per list, so
 * the modules agree on what the server listed.
 *
 * What stays private is the RESPONSE cache below: the `-list-caching`
 * tests validate the caching hints on the same response the `-list` test
 * saw, and the context only keeps the arrays.
 */

interface Outcome {
  passed: boolean;
  details: string;
}

/** Responses this module already obtained, so one run sends each once. */
interface ResponseCache {
  lists: Partial<Record<ListKey, RpcResponse>>;
  read?: { uri: string; res: RpcResponse };
}

const pass = (details: string): Outcome => ({ passed: true, details });
const fail = (details: string): Outcome => ({ passed: false, details });

function errDetail(err: { code: number; message: string }): string {
  const msg = err.message
    .replace(/\s+/g, " ")
    .replace(/[^\x20-\x7e]/g, "?")
    .trim()
    .slice(0, 80);
  return `JSON-RPC error ${err.code}${msg ? ` (${msg})` : ""}`;
}

function namesOf(items: unknown[], key = "name"): string[] {
  return items
    .map((it) => (isPlainObject(it) ? it[key] : undefined))
    .filter((n): n is string => typeof n === "string" && n.length > 0);
}

function showNames(names: string[], max = 5): string {
  return `${names.slice(0, max).join(", ")}${names.length > max ? "..." : ""}`;
}

export async function runFeatures(ctx: ModernSuiteContext): Promise<void> {
  const cache: ResponseCache = { lists: {} };
  if (hasTools(ctx)) await runTools(ctx, cache);
  if (hasResources(ctx)) await runResources(ctx, cache);
  if (hasPrompts(ctx)) await runPrompts(ctx, cache);
}

// ── Shared plumbing ───────────────────────────────────────────────

/**
 * Send `<key>/list`, keep the response for the caching test and publish
 * the array into ctx.state when valid. Marks the attempt on the context so
 * a later `ensureList` never re-sends a list that was asked for and failed.
 */
async function fetchList(ctx: ModernSuiteContext, cache: ResponseCache, key: ListKey): Promise<RpcResponse> {
  ctx.state.listAttempts.add(key);
  const res = await ctx.client.rpc(LIST_METHOD[key]);
  cache.lists[key] = res;
  publishList(ctx, key, res);
  return res;
}

/** The list response, fetching once when the `-list` test did not run. */
async function listResponse(ctx: ModernSuiteContext, cache: ResponseCache, key: ListKey): Promise<RpcResponse> {
  return cache.lists[key] ?? fetchList(ctx, cache, key);
}

function listOutcome(res: RpcResponse, method: string, key: "tools" | "resources" | "prompts"): Outcome {
  const err = errorOf(res.body);
  if (err) return fail(`${method} returned ${errDetail(err)}`);
  const result = resultOf(res.body);
  if (!result) return fail(`${method}: no result object (HTTP ${res.statusCode})`);
  const list = result[key];
  if (!Array.isArray(list)) return fail(`No ${key} array in result`);
  const nonObjects = list.filter((it) => !isPlainObject(it)).length;
  if (nonObjects > 0) return fail(`${nonObjects} of ${list.length} ${key} entries are not objects`);
  const names = namesOf(list);
  return pass(`${list.length} ${key.replace(/s$/, "")}(s)${names.length ? `: ${showNames(names)}` : ""}`);
}

/**
 * Caching-hint check on a response. `onError` decides what an error
 * response means: "fail" for a list the server MUST serve, "skip" for an
 * optional method (templates) where an error is "not applicable".
 */
function cachingOutcome(res: RpcResponse, method: string, onError: "fail" | "skip"): Outcome {
  const err = errorOf(res.body);
  if (err) {
    const detail = `${method} returned ${errDetail(err)}; no complete result to check caching hints on`;
    return onError === "fail" ? fail(detail) : pass(`not applicable: ${detail}`);
  }
  const result = resultOf(res.body);
  if (!result) return fail(`${method}: no result object (HTTP ${res.statusCode})`);
  if (isInputRequired(result)) {
    return pass(`${method}: not applicable (input_required interim results carry no caching hints)`);
  }
  const v = validateCachingHints(result);
  if (v.issues.length > 0) return fail(`${method}: ${summarizeIssues(v.issues)}`);
  return pass(`${method}: ${v.summary}`);
}

async function paginationOutcome(ctx: ModernSuiteContext, method: string, key: string): Promise<Outcome> {
  const rpc: RpcBodyCall = async (m, params) => (await ctx.client.rpc(m, params)).body;
  const out = await checkPagination(rpc, method, key);
  ctx.harness.warnings.push(...out.warnings);
  return { passed: out.passed, details: out.details };
}

function inputRequiredOutcome(label: string, result: Record<string, unknown>): Outcome {
  const shape = validateInputRequired(result);
  if (shape.issues.length > 0) return fail(`${label}: MRTR input_required malformed: ${summarizeIssues(shape.issues)}`);
  const parts = [`inputRequests: ${shape.requestKeys.length ? showNames(shape.requestKeys) : "none"}`];
  if (shape.hasRequestState) parts.push("requestState");
  return pass(`${label}: MRTR input_required (${parts.join(", ")})`);
}

// ── Tools ─────────────────────────────────────────────────────────

interface PickedTool {
  name: string;
  inputSchema: unknown;
}

/**
 * The tool to call with `{}`: the first whose inputSchema declares no
 * required properties (a call that can succeed), else the first tool
 * (whose -32602 is an acceptable answer).
 */
export function pickTool(tools: unknown[]): PickedTool | undefined {
  const named = tools.filter(isPlainObject).filter((t) => typeof t.name === "string" && t.name.length > 0);
  const noArgs = named.find((t) => {
    const schema = t.inputSchema;
    if (!isPlainObject(schema)) return false;
    const required = schema.required;
    return required === undefined || (Array.isArray(required) && required.length === 0);
  });
  const chosen = noArgs ?? named[0];
  return chosen ? { name: chosen.name as string, inputSchema: chosen.inputSchema } : undefined;
}

async function runTools(ctx: ModernSuiteContext, cache: ResponseCache): Promise<void> {
  const { harness, client } = ctx;

  await harness.check(
    "tools-list",
    async () => listOutcome(await fetchList(ctx, cache, "tools"), "tools/list", "tools"),
    {
      required: true,
    },
  );

  await harness.check(
    "tools-list-caching",
    async () => cachingOutcome(await listResponse(ctx, cache, "tools"), "tools/list", "fail"),
    { required: true },
  );

  await harness.check("tools-list-deterministic-order", async () => {
    const first = await ensureList(ctx, "tools");
    if (!first) return pass("skipped: no tools list available");
    const baseline = namesOf(first);
    const snapshots: string[][] = [];
    for (let call = 2; call <= 3; call++) {
      const res = await client.rpc("tools/list");
      const err = errorOf(res.body);
      if (err) return fail(`tools/list call ${call} returned ${errDetail(err)}`);
      const list = resultOf(res.body)?.tools;
      if (!Array.isArray(list)) return fail(`tools/list call ${call} returned no tools array`);
      snapshots.push(namesOf(list));
    }
    if (baseline.length < 2) return pass(`${baseline.length} tool(s); order is trivially deterministic`);
    const setKey = (names: string[]) => [...names].sort().join("\n");
    for (const snap of snapshots) {
      if (setKey(snap) !== setKey(baseline)) {
        return pass(
          `tool set changed between calls (${baseline.length} vs ${snap.length} tools); order not comparable`,
        );
      }
    }
    for (const snap of snapshots) {
      if (snap.join("\n") !== baseline.join("\n")) {
        return fail(`tools/list order differs between calls: [${showNames(baseline)}] vs [${showNames(snap)}]`);
      }
    }
    return pass(`${baseline.length} tools in the same order across 3 calls`);
  });

  const callPicked = async (): Promise<{ tool: PickedTool; res: RpcResponse } | Outcome> => {
    const tools = await ensureList(ctx, "tools");
    if (!tools) return pass("skipped: no tools list available");
    const tool = pickTool(tools);
    if (!tool) return pass("skipped: server lists no tools");
    const res = await client.rpc(
      "tools/call",
      { name: tool.name, arguments: {} },
      { toolInputSchema: isPlainObject(tool.inputSchema) ? tool.inputSchema : undefined },
    );
    return { tool, res };
  };

  await harness.check(
    "tools-call",
    async () => {
      const called = await callPicked();
      if ("passed" in called) return called;
      const { tool, res } = called;
      const err = errorOf(res.body);
      if (err) {
        if (err.code === -32602 || err.code === -32600) {
          return pass(`${tool.name}: invalid params error (acceptable): code ${err.code}`);
        }
        return pass(`${tool.name}: protocol error: ${errDetail(err)}`);
      }
      const result = resultOf(res.body);
      if (!result) return fail(`${tool.name}: no result object (HTTP ${res.statusCode})`);
      if (isInputRequired(result)) return inputRequiredOutcome(tool.name, result);
      const content = result.content;
      if (!Array.isArray(content)) return fail(`${tool.name}: response missing content array`);
      if (result.isError === true) return pass(`${tool.name}: tool returned execution error with content (valid)`);
      const untyped = content.filter((c) => !isPlainObject(c) || !c.type).length;
      if (untyped > 0) return fail(`${tool.name}: ${untyped} content item(s) missing 'type' field`);
      return pass(`${tool.name}: returned ${content.length} content item(s)`);
    },
    { required: true },
  );

  await harness.check(
    "tools-content-types",
    async () => {
      const called = await callPicked();
      if ("passed" in called) return called;
      const { tool, res } = called;
      const err = errorOf(res.body);
      if (err) return pass(`${tool.name}: tool returned error (content types not applicable): code ${err.code}`);
      const result = resultOf(res.body);
      if (!result) return fail(`${tool.name}: no result object (HTTP ${res.statusCode})`);
      if (isInputRequired(result)) return pass(`${tool.name}: input_required result (content types not applicable)`);
      const content = result.content;
      if (!Array.isArray(content) || content.length === 0) return pass(`${tool.name}: no content items to validate`);
      const v = validateContentBlocks(content);
      if (v.issues.length > 0) return fail(`${tool.name}: ${summarizeIssues(v.issues)}`);
      return pass(`${tool.name}: content types: ${v.types.join(", ")}`);
    },
    { required: true },
  );

  await harness.check("tools-pagination", () => paginationOutcome(ctx, "tools/list", "tools"));
}

// ── Resources ─────────────────────────────────────────────────────

type ReadAttempt = { uri: string; res: RpcResponse } | { skipped: string };

/** resources/read of the first listed resource, sent once per run. */
async function readFirstResource(ctx: ModernSuiteContext, cache: ResponseCache): Promise<ReadAttempt> {
  if (cache.read) return cache.read;
  const resources = await ensureList(ctx, "resources");
  if (!resources) return { skipped: "skipped: no resources list available" };
  const first = resources.find((r) => isPlainObject(r) && typeof r.uri === "string" && r.uri.length > 0);
  if (!isPlainObject(first)) return { skipped: "skipped: server lists no resources with a uri" };
  const uri = first.uri as string;
  const res = await ctx.client.rpc("resources/read", { uri });
  cache.read = { uri, res };
  return cache.read;
}

/** resources/templates/list, sent once per run; the same shared list slot as the other lists. */
function templatesResponse(ctx: ModernSuiteContext, cache: ResponseCache): Promise<RpcResponse> {
  return listResponse(ctx, cache, "resourceTemplates");
}

async function runResources(ctx: ModernSuiteContext, cache: ResponseCache): Promise<void> {
  const { harness, client } = ctx;

  await harness.check(
    "resources-list",
    async () => listOutcome(await fetchList(ctx, cache, "resources"), "resources/list", "resources"),
    { required: true },
  );

  await harness.check(
    "resources-list-caching",
    async () => cachingOutcome(await listResponse(ctx, cache, "resources"), "resources/list", "fail"),
    { required: true },
  );

  await harness.check(
    "resources-read",
    async () => {
      const attempt = await readFirstResource(ctx, cache);
      if ("skipped" in attempt) return pass(attempt.skipped);
      const { uri, res } = attempt;
      const err = errorOf(res.body);
      if (err) return fail(`resources/read ${uri}: ${errDetail(err)}`);
      const result = resultOf(res.body);
      if (!result) return fail(`resources/read ${uri}: no result object (HTTP ${res.statusCode})`);
      if (isInputRequired(result)) return inputRequiredOutcome(`resources/read ${uri}`, result);
      const contents = result.contents;
      if (!Array.isArray(contents)) return fail(`resources/read ${uri}: no contents array`);
      if (contents.length === 0) {
        harness.warnings.push(
          `resources/read of the listed resource ${uri} returned an empty contents array; a listed resource is expected to have content`,
        );
        return pass(`read 0 content items from ${uri} (empty contents for a listed resource; see warnings)`);
      }
      const v = validateResourceContents(contents);
      if (v.issues.length > 0) return fail(`resources/read ${uri}: ${summarizeIssues(v.issues)}`);
      return pass(`read ${contents.length} content item(s) from ${uri}`);
    },
    { required: true },
  );

  await harness.check(
    "resources-read-caching",
    async () => {
      const attempt = await readFirstResource(ctx, cache);
      if ("skipped" in attempt) return pass(attempt.skipped);
      return cachingOutcome(attempt.res, `resources/read ${attempt.uri}`, "fail");
    },
    { required: true },
  );

  await harness.check(
    "resources-not-found",
    async () => {
      const uri = `test://mcp-compliance/does-not-exist-${Math.random().toString(36).slice(2, 10)}`;
      const res = await client.rpc("resources/read", { uri });
      const err = errorOf(res.body);
      if (!err) {
        const result = resultOf(res.body);
        if (!result) return fail(`nonexistent URI: no JSON-RPC error and no result object (HTTP ${res.statusCode})`);
        if (isInputRequired(result)) return fail("nonexistent URI returned input_required instead of a JSON-RPC error");
        const contents = result.contents;
        const count = Array.isArray(contents) ? contents.length : 0;
        if (count === 0) {
          return fail(
            `nonexistent URI returned a result with ${Array.isArray(contents) ? "an empty" : "no"} contents array (MUST be JSON-RPC error -32602)`,
          );
        }
        return fail(`nonexistent URI returned ${count} content item(s) instead of a JSON-RPC error`);
      }
      if (err.code === -32002) {
        return fail("error code -32002 is retired in 2026-07-28; a missing resource MUST be -32602 Invalid params");
      }
      const dataUri = isPlainObject(err.data) ? err.data.uri : undefined;
      const echoed = dataUri === uri;
      if (!echoed) {
        harness.warnings.push(
          `resources-not-found: error.data.uri ${dataUri === undefined ? "is missing" : `is ${brief(dataUri)}, not the requested URI`}; servers SHOULD name the missing resource in data.uri`,
        );
      }
      if (err.code === -32602) return pass(`nonexistent URI -> JSON-RPC error -32602${echoed ? " with data.uri" : ""}`);
      harness.warnings.push(
        `resources-not-found: server answered a nonexistent URI with code ${err.code}; -32602 Invalid params is expected`,
      );
      return pass(`nonexistent URI -> JSON-RPC error ${err.code} (expected -32602; see warnings)`);
    },
    { required: true },
  );

  await harness.check("resources-templates", async () => {
    const res = await templatesResponse(ctx, cache);
    const err = errorOf(res.body);
    if (err) {
      if (err.code === -32601) return pass("Method not supported (acceptable): -32601");
      return fail(`resources/templates/list returned ${errDetail(err)}`);
    }
    const result = resultOf(res.body);
    if (!result) return fail(`resources/templates/list: no result object (HTTP ${res.statusCode})`);
    const templates = result.resourceTemplates;
    if (!Array.isArray(templates)) return fail("No resourceTemplates array");
    const v = validateResourceTemplates(templates);
    harness.warnings.push(...v.warnings);
    if (v.issues.length > 0) return fail(summarizeIssues(v.issues));
    return pass(`${templates.length} resource template(s)`);
  });

  await harness.check("resources-templates-caching", async () =>
    cachingOutcome(await templatesResponse(ctx, cache), "resources/templates/list", "skip"),
  );

  await harness.check("resources-pagination", () => paginationOutcome(ctx, "resources/list", "resources"));
}

// ── Prompts ───────────────────────────────────────────────────────

interface PickedPrompt {
  name: string;
  /** Names of the required arguments (empty when the prompt needs none). */
  requiredArgs: string[];
}

/** The prompt to get: the first with no required arguments, else the first prompt. */
export function pickPrompt(prompts: unknown[]): PickedPrompt | undefined {
  const named = prompts.filter(isPlainObject).filter((p) => typeof p.name === "string" && p.name.length > 0);
  const requiredArgsOf = (p: Record<string, unknown>): string[] =>
    Array.isArray(p.arguments)
      ? p.arguments
          .filter((a): a is Record<string, unknown> => isPlainObject(a) && a.required === true)
          .map((a) => a.name)
          .filter((n): n is string => typeof n === "string" && n.length > 0)
      : [];
  const noArgs = named.find((p) => requiredArgsOf(p).length === 0);
  const chosen = noArgs ?? named[0];
  return chosen ? { name: chosen.name as string, requiredArgs: requiredArgsOf(chosen) } : undefined;
}

async function runPrompts(ctx: ModernSuiteContext, cache: ResponseCache): Promise<void> {
  const { harness, client } = ctx;

  await harness.check(
    "prompts-list",
    async () => listOutcome(await fetchList(ctx, cache, "prompts"), "prompts/list", "prompts"),
    { required: true },
  );

  await harness.check(
    "prompts-list-caching",
    async () => cachingOutcome(await listResponse(ctx, cache, "prompts"), "prompts/list", "fail"),
    { required: true },
  );

  await harness.check(
    "prompts-get",
    async () => {
      const prompts = await ensureList(ctx, "prompts");
      if (!prompts) return pass("skipped: no prompts list available");
      const prompt = pickPrompt(prompts);
      if (!prompt) return pass("skipped: server lists no prompts");
      const params: Record<string, unknown> = { name: prompt.name };
      if (prompt.requiredArgs.length > 0) {
        params.arguments = Object.fromEntries(prompt.requiredArgs.map((a) => [a, "test"]));
      }
      const res = await client.rpc("prompts/get", params);
      const err = errorOf(res.body);
      if (err) {
        if (err.code === -32602 || err.code === -32600) {
          return pass(`${prompt.name}: invalid params error (acceptable): code ${err.code}`);
        }
        return fail(`${prompt.name}: ${errDetail(err)} (expected messages, input_required or -32602)`);
      }
      const result = resultOf(res.body);
      if (!result) return fail(`${prompt.name}: no result object (HTTP ${res.statusCode})`);
      if (isInputRequired(result)) return inputRequiredOutcome(prompt.name, result);
      const messages = result.messages;
      if (!Array.isArray(messages)) return fail(`${prompt.name}: no messages array in result`);
      const v = validatePromptMessages(messages);
      if (v.issues.length > 0) return fail(`${prompt.name}: ${summarizeIssues(v.issues)}`);
      const note = prompt.requiredArgs.length > 0 ? " (placeholder arguments sent)" : "";
      return pass(`${messages.length} message(s) from ${prompt.name}${note}`);
    },
    { required: true },
  );

  await harness.check("prompts-pagination", () => paginationOutcome(ctx, "prompts/list", "prompts"));
}
