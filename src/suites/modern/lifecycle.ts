import type { TestOutcome } from "../../harness.js";
import {
  createModernClient,
  describeResponse,
  errorOf,
  type RpcOptions,
  type RpcResponse,
  resultOf,
} from "../../modern/client.js";
import { JSONRPC_ERROR_CODES, META, MODERN_ERROR_CODES, metaOf } from "../../modern/meta.js";
import { LEGACY_SPEC_VERSION, MODERN_SPEC_VERSION } from "../../spec.js";
import type { Transport, TransportStream } from "../../transport/index.js";
import type { StdioTransport } from "../../transport/stdio.js";
import {
  ensurePrompts,
  ensureResourceTemplates,
  ensureTools,
  hasCapability,
  hasCompletions,
  hasTools,
  type ModernSuiteContext,
} from "./context.js";

/**
 * Lifecycle category of the 2026-07-28 suite. There is no handshake in
 * this era: `server/discover` is the first request the suite trusts and
 * its result seeds every capability gate, so `runLifecycle` runs first
 * and populates `ctx.state` before registering its own tests.
 * `runLifecycleLate` holds the tests that need the feature lists
 * (completions, progress), the two claim-less `_meta` probes, and the
 * legacy `initialize` probe. The claim-less probes run late because a
 * dual-era stdio server (the SDK 2.0 default) that has not yet been
 * pinned modern by a non-discover request treats ANY claim-less message
 * as a legacy opening and pins the whole process to legacy semantics; by
 * the time the late tests run, the feature modules have pinned it modern
 * and the probes draw the -32602 the spec requires. The initialize probe
 * runs last, on a fresh child on stdio, for the mirror-image reason.
 */

const ACK_METHOD = "notifications/subscriptions/acknowledged";
const PROGRESS_METHOD = "notifications/progress";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Every YYYY-MM-DD in prose (the versions a rejected initialize SHOULD name). */
const VERSION_MENTION_RE = /\d{4}-\d{2}-\d{2}/g;
const UNSUPPORTED_VERSION = "1999-01-01";
const PROGRESS_TOKEN = "compliance-progress-1";
const VENDOR_META_KEY = "com.example.compliance/probe";
/**
 * JSON-RPC id of the legacy initialize sent to a FRESH stdio child: the
 * first (and only) request that process sees, so a low id is what a real
 * legacy client would send. Distinct from the suite's counter (1000+) and
 * the raw transport probes (99901+), so the recorder correlates it.
 */
const LEGACY_INITIALIZE_ID = 1;

/** Removed in 2026-07-28; each must draw a JSON-RPC error. `initialize` is probed separately (lifecycle-dual-era). */
const REMOVED_METHOD_PROBES: Array<[string, Record<string, unknown>]> = [
  ["ping", {}],
  ["logging/setLevel", { level: "info" }],
  ["resources/subscribe", { uri: "test://x" }],
];

let stringIdSeq = 0;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function describeType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  return typeof v === "object" ? "an object" : typeof v;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** First line of an error message, clipped, so transport diagnostics do not flood a details string. */
function short(text: string, max = 100): string {
  const line = text.split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

function listOf(values: unknown[], max = 6): string {
  const shown = values.slice(0, max).map((v) => (typeof v === "string" ? v : JSON.stringify(v)));
  return values.length > max ? `${shown.join(", ")}, ... (${values.length} total)` : shown.join(", ");
}

/** " (HTTP 400)" on HTTP, "" on stdio. */
function statusOf(ctx: ModernSuiteContext, res: RpcResponse): string {
  return ctx.kind === "http" ? ` (HTTP ${res.statusCode})` : "";
}

function fail(details: string): TestOutcome {
  return { passed: false, details };
}

function pass(details: string): TestOutcome {
  return { passed: true, details };
}

/** The setup `server/discover` exchange, shared by the lifecycle tests. */
interface DiscoverProbe {
  /** The response, or null when the transport produced none (timeout, crash, connection failure). */
  res: RpcResponse | null;
  /** Transport-level failure message when `res` is null. */
  error: string | null;
  /** The DiscoverResult object, when the response carried one. */
  result: Record<string, unknown> | undefined;
}

function describeProbeFailure(probe: DiscoverProbe, ctx: ModernSuiteContext): string {
  if (!probe.res) return `server/discover got no response (${short(probe.error ?? "unknown error")})`;
  return `server/discover answered ${describeResponse(probe.res)}${statusOf(ctx, probe.res)}`;
}

/**
 * Populate `ctx.state` from a DiscoverResult. Anything malformed is left
 * at its empty default so a later capability gate reads "not declared"
 * rather than crashing on a boolean where an object was expected.
 */
function seedState(ctx: ModernSuiteContext, res: RpcResponse, result: Record<string, unknown>): void {
  ctx.state.discover = res;
  ctx.state.supportedVersions = Array.isArray(result.supportedVersions)
    ? result.supportedVersions.filter((v): v is string => typeof v === "string")
    : [];
  ctx.state.capabilities = isObject(result.capabilities) ? result.capabilities : {};
  const info = metaOf(result)?.[META.serverInfo];
  ctx.state.serverInfo = {
    name: isObject(info) && typeof info.name === "string" ? info.name : null,
    version: isObject(info) && typeof info.version === "string" ? info.version : null,
  };
  ctx.state.instructions = typeof result.instructions === "string" ? result.instructions : null;
}

/**
 * Why a rejection of a deliberately malformed request cannot be credited
 * to the injected defect: the CONFORMANT setup `server/discover` was
 * itself rejected (or never answered), so the server rejects everything
 * and the negative probe measured nothing. Null when the discover result
 * is in hand. Shared by the `_meta` tests here and the header tests in
 * transport.ts; every negative probe reads it after seeing a rejection.
 */
export function notEvaluable(ctx: ModernSuiteContext): string | null {
  if (ctx.state.discover) return null;
  const rejection = ctx.state.discoverRejection;
  if (!rejection) {
    return "not evaluable: the conformant server/discover got no response, so this rejection proves nothing about the injected defect";
  }
  const code = rejection.code === null ? "no JSON-RPC error code" : String(rejection.code);
  const status = ctx.kind === "http" ? ` (HTTP ${rejection.statusCode})` : "";
  return `not evaluable: the conformant server/discover was itself rejected with ${code}${status}, so this rejection proves nothing about the injected defect`;
}

/**
 * Shared verdict for the "request must be rejected" tests: a result
 * fails, a JSON-RPC error with `expectedCode` passes, any other code
 * passes with a warning, and on HTTP the status must be 400. A bare HTTP
 * 4xx with no JSON-RPC body (an intermediary rejecting the request) is
 * accepted with a warning: it is a rejection, just not a diagnosable one.
 * Any rejection is credited only when the conformant discover was served
 * (see `notEvaluable`).
 */
async function expectRejection(
  ctx: ModernSuiteContext,
  id: string,
  what: string,
  expectedCode: number,
  send: () => Promise<RpcResponse>,
): Promise<TestOutcome> {
  let res: RpcResponse;
  try {
    res = await send();
  } catch (err) {
    return fail(`${what}: no response (${short(messageOf(err))})`);
  }
  const status = statusOf(ctx, res);
  if (resultOf(res.body)) {
    return fail(`${what}: server returned a result${status} (expected JSON-RPC error ${expectedCode})`);
  }
  const unattributable = notEvaluable(ctx);
  if (unattributable) return fail(`${what}: ${unattributable}`);
  const err = errorOf(res.body);
  if (!err) {
    if (ctx.kind === "http" && res.statusCode >= 400) {
      ctx.harness.warnings.push(
        `${id}: ${what} was rejected with HTTP ${res.statusCode} but no JSON-RPC error body (expected ${expectedCode})`,
      );
      return pass(`${what}: rejected with HTTP ${res.statusCode}, no JSON-RPC error body (see warning)`);
    }
    return fail(`${what}: neither result nor JSON-RPC error in the response${status}`);
  }
  if (ctx.kind === "http" && res.statusCode !== 400) {
    return fail(`${what}: JSON-RPC error ${err.code} with HTTP ${res.statusCode} (expected 400)`);
  }
  if (err.code !== expectedCode) {
    ctx.harness.warnings.push(
      `${id}: ${what} was rejected with ${err.code}${err.message ? ` (${short(err.message, 60)})` : ""} (expected ${expectedCode})`,
    );
    return pass(`${what}: rejected with ${err.code}${status}, expected ${expectedCode} (see warning)`);
  }
  return pass(`${what}: rejected with ${err.code}${status}`);
}

/**
 * Problems with an UnsupportedProtocolVersionError's `data`: `supported`
 * must be a non-empty array of strings that is a subset of the versions
 * `server/discover` advertised (when known), and `requested` must echo
 * the version the request declared. Exported for unit tests: the fixture
 * has no knob for a non-subset `supported` list.
 */
export function unsupportedVersionDataProblems(data: unknown, requested: string, known: readonly string[]): string[] {
  const problems: string[] = [];
  const obj = isObject(data) ? data : undefined;
  const supported = obj?.supported;
  if (!Array.isArray(supported) || supported.length === 0) {
    problems.push("data.supported missing or empty");
  } else {
    const foreign = supported.filter((v) => typeof v !== "string" || (known.length > 0 && !known.includes(v)));
    if (foreign.length > 0) {
      problems.push(
        `data.supported [${listOf(supported)}] is not a subset of supportedVersions [${listOf([...known])}]: ${listOf(foreign)}`,
      );
    }
  }
  if (obj?.requested !== requested) {
    problems.push(`data.requested ${obj ? JSON.stringify(obj.requested) : "missing"} (expected "${requested}")`);
  }
  return problems;
}

/**
 * Where a rejected legacy `initialize` names the versions the server
 * supports (basic/versioning: a modern-only server SHOULD name them "in
 * any error it returns to an initialize request"): in `data.supported`
 * (the UnsupportedProtocolVersionError shape -- a non-empty string array),
 * in the message (a YYYY-MM-DD other than the version the probe itself
 * requested, which a message merely echoing the rejected version does not
 * satisfy), or both. Null when neither names one. Exported for unit
 * tests: the fixture has no knob for a data-only rejection.
 */
export function supportedVersionsNamedIn(
  err: { message: string; data?: unknown },
  requested: string = LEGACY_SPEC_VERSION,
): string | null {
  const supported = isObject(err.data) ? err.data.supported : undefined;
  const inData = Array.isArray(supported) && supported.length > 0 && supported.every((v) => typeof v === "string");
  const mentioned = err.message.match(VERSION_MENTION_RE) ?? [];
  const inMessage = mentioned.some((v) => v !== requested);
  if (inData && inMessage) return "message and data.supported name supported versions";
  if (inData) return "data.supported names supported versions";
  if (inMessage) return "message names supported versions";
  return null;
}

export async function runLifecycle(ctx: ModernSuiteContext): Promise<void> {
  const { harness, client } = ctx;

  // ── Setup: the discover exchange every capability gate reads ──────
  const probe: DiscoverProbe = { res: null, error: null, result: undefined };
  try {
    probe.res = await client.rpc("server/discover", {}, { timeout: ctx.startupTimeout });
    probe.result = resultOf(probe.res.body);
  } catch (err) {
    probe.error = messageOf(err);
  }
  if (probe.res && probe.result) {
    seedState(ctx, probe.res, probe.result);
  } else if (probe.res) {
    // The conformant request was rejected: remember how, so the negative
    // probes can tell "rejected the defect" from "rejects everything".
    const code = errorOf(probe.res.body)?.code;
    ctx.state.discoverRejection = {
      code: typeof code === "number" && !Number.isNaN(code) ? code : null,
      statusCode: probe.res.statusCode,
    };
  }

  await harness.check("lifecycle-discover", async () => {
    const { result } = probe;
    if (!result || !probe.res) return fail(describeProbeFailure(probe, ctx));
    const problems: string[] = [];
    if (!Array.isArray(result.supportedVersions)) {
      problems.push(`supportedVersions is ${describeType(result.supportedVersions)}, expected an array`);
    }
    if (!isObject(result.capabilities)) {
      problems.push(`capabilities is ${describeType(result.capabilities)}, expected an object`);
    }
    if (problems.length > 0) return fail(`DiscoverResult invalid: ${problems.join("; ")}`);
    const caps = Object.keys(result.capabilities as object);
    return pass(
      `supportedVersions [${listOf(result.supportedVersions as unknown[])}], capabilities: ${caps.length ? caps.join(", ") : "(none)"}${statusOf(ctx, probe.res)}`,
    );
  });

  await harness.check("lifecycle-discover-versions", async () => {
    const { result } = probe;
    if (!result) return fail(`${describeProbeFailure(probe, ctx)}; supportedVersions unavailable`);
    const raw = result.supportedVersions;
    if (!Array.isArray(raw) || raw.length === 0) {
      return fail("supportedVersions missing or empty (expected a non-empty array of YYYY-MM-DD strings)");
    }
    const malformed = raw.filter((v) => typeof v !== "string" || !DATE_RE.test(v));
    if (malformed.length > 0) {
      return fail(`supportedVersions has malformed entries: ${listOf(malformed)} (expected YYYY-MM-DD strings)`);
    }
    if (!raw.includes(MODERN_SPEC_VERSION)) {
      // Same wording as the suite-level warning so the two dedupe.
      harness.warnings.push(
        `Server advertises supportedVersions [${raw.join(", ")}] without ${MODERN_SPEC_VERSION}; tests still run against ${MODERN_SPEC_VERSION}.`,
      );
    }
    return pass(`supportedVersions: ${listOf(raw)}${raw.includes(MODERN_SPEC_VERSION) ? "" : " (see warning)"}`);
  });

  await harness.check("lifecycle-discover-caching", async () => {
    const { result } = probe;
    if (!result) return fail(`${describeProbeFailure(probe, ctx)}; no caching hints to check`);
    const problems: string[] = [];
    const ttl = result.ttlMs;
    if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < 0) {
      problems.push(`ttlMs ${ttl === undefined ? "missing" : JSON.stringify(ttl)} (expected an integer >= 0)`);
    }
    const scope = result.cacheScope;
    if (scope !== "public" && scope !== "private") {
      problems.push(
        `cacheScope ${scope === undefined ? "missing" : JSON.stringify(scope)} (expected "public" or "private")`,
      );
    }
    if (problems.length > 0) return fail(problems.join("; "));
    return pass(`ttlMs=${ttl}, cacheScope=${scope}`);
  });

  await harness.check("lifecycle-jsonrpc", async () => {
    if (!probe.res) return fail(describeProbeFailure(probe, ctx));
    const body = probe.res.body;
    if (!isObject(body)) return fail(`response body is ${describeType(body)}, expected a JSON-RPC object`);
    const problems: string[] = [];
    if (body.jsonrpc !== "2.0") problems.push(`jsonrpc=${JSON.stringify(body.jsonrpc)} (expected "2.0")`);
    if (body.id !== probe.res.requestId) {
      problems.push(`id=${JSON.stringify(body.id)} does not echo request id ${JSON.stringify(probe.res.requestId)}`);
    }
    const hasResult = "result" in body;
    const hasError = "error" in body;
    if (hasResult && hasError) problems.push("both result and error present");
    if (!hasResult && !hasError) problems.push("neither result nor error present");
    if (hasResult && !isObject(body.result))
      problems.push(`result is ${describeType(body.result)}, expected an object`);
    if (problems.length > 0) return fail(`Invalid JSON-RPC 2.0 envelope: ${problems.join("; ")}`);
    return pass(
      `Valid JSON-RPC 2.0 response (id ${JSON.stringify(body.id)} echoed, ${hasResult ? "result" : "error"})`,
    );
  });

  await harness.check("lifecycle-id-match", async () => {
    let res: RpcResponse;
    try {
      res = await client.rpc("server/discover", {});
    } catch (err) {
      const sent = ctx.recorder.sent[ctx.recorder.sent.length - 1];
      return fail(
        `no response matched request id ${JSON.stringify(sent?.id)} within ${ctx.timeout}ms; a retyped or dropped id never resolves (${short(messageOf(err), 60)})`,
      );
    }
    const body = res.body;
    const id = isObject(body) ? body.id : undefined;
    if (id === undefined) return fail(`No id in response${statusOf(ctx, res)}`);
    if (id === res.requestId)
      return pass(`Request id=${JSON.stringify(res.requestId)}, response id=${JSON.stringify(id)} (match)`);
    return fail(
      `Request id=${JSON.stringify(res.requestId)} (${typeof res.requestId}), response id=${JSON.stringify(id)} (${typeof id}): MISMATCH`,
    );
  });

  await harness.check("lifecycle-string-id", async () => {
    const stringId = `compliance-str-${++stringIdSeq}`;
    let res: RpcResponse;
    try {
      res = await client.rpc("server/discover", {}, { id: stringId });
    } catch (err) {
      return fail(
        `no response echoed string id "${stringId}" within ${ctx.timeout}ms; a coerced or dropped id never resolves (${short(messageOf(err), 60)})`,
      );
    }
    const id = isObject(res.body) ? res.body.id : undefined;
    if (id === stringId) return pass(`String id "${stringId}" echoed back as a string`);
    if (id === undefined) return fail(`No id in response${statusOf(ctx, res)}`);
    return fail(`String id "${stringId}" sent, got back id=${JSON.stringify(id)} (${typeof id})`);
  });

  await harness.check("lifecycle-capabilities", async () => {
    const { result } = probe;
    if (!result) return fail(`${describeProbeFailure(probe, ctx)}; no capabilities object`);
    const caps = result.capabilities;
    if (!isObject(caps)) return fail(`capabilities is ${describeType(caps)}, expected an object`);
    const declared = Object.entries(caps).filter(([, v]) => v !== undefined);
    const bad = declared.filter(([, v]) => !isObject(v)).map(([k, v]) => `${k} is ${describeType(v)}`);
    if (bad.length > 0) return fail(`Declared capabilities must be objects: ${bad.join(", ")}`);
    return pass(
      declared.length > 0 ? `Capabilities: ${declared.map(([k]) => k).join(", ")}` : "Empty capabilities (valid)",
    );
  });

  await harness.check("lifecycle-server-info", async () => {
    const { result } = probe;
    if (!result) return fail(`${describeProbeFailure(probe, ctx)}; no serverInfo`);
    const info = metaOf(result)?.[META.serverInfo];
    if (!isObject(info)) return fail(`No _meta["${META.serverInfo}"] object on the discover result`);
    if (typeof info.name !== "string" || typeof info.version !== "string") {
      return fail(`serverInfo needs string name and version, got ${short(JSON.stringify(info), 80)}`);
    }
    return pass(`${info.name} v${info.version}`);
  });

  await harness.check("lifecycle-instructions", async () => {
    const { result } = probe;
    if (!result) return fail(describeProbeFailure(probe, ctx));
    if (result.instructions === undefined) return pass("No instructions field (optional)");
    if (typeof result.instructions === "string") return pass(`Instructions: "${short(result.instructions, 80)}"`);
    return fail(`instructions should be a string, got ${describeType(result.instructions)}`);
  });

  // The two claim-less `_meta` probes (no _meta at all; _meta without
  // protocolVersion) live in runLifecycleLate -- see the module comment.
  // This one still carries a protocolVersion claim, so it cannot re-select
  // a dual-era server's era and stays early.
  await harness.check("lifecycle-meta-client-capabilities-required", () =>
    expectRejection(
      ctx,
      "lifecycle-meta-client-capabilities-required",
      "server/discover without _meta clientCapabilities",
      JSONRPC_ERROR_CODES.INVALID_PARAMS,
      () => client.rpc("server/discover", {}, { meta: { [META.clientCapabilities]: undefined } }),
    ),
  );

  await harness.check("lifecycle-meta-client-info-optional", async () => {
    let res: RpcResponse;
    try {
      res = await client.rpc("server/discover", {}, { meta: { [META.clientInfo]: undefined } });
    } catch (err) {
      return fail(`server/discover without clientInfo: no response (${short(messageOf(err))})`);
    }
    const status = statusOf(ctx, res);
    const err = errorOf(res.body);
    if (err)
      return fail(`server/discover without clientInfo rejected with ${err.code}${status}; clientInfo is optional`);
    if (!resultOf(res.body)) return fail(`server/discover without clientInfo: no result${status}`);
    if (ctx.kind === "http" && (res.statusCode < 200 || res.statusCode >= 300)) {
      return fail(`server/discover without clientInfo returned a result with HTTP ${res.statusCode} (expected 2xx)`);
    }
    return pass(`Served server/discover without clientInfo${status}`);
  });

  await harness.check("lifecycle-version-unsupported", async () => {
    const what = `server/discover declaring protocol version ${UNSUPPORTED_VERSION}`;
    let res: RpcResponse;
    try {
      res = await client.rpc("server/discover", {}, { protocolVersion: UNSUPPORTED_VERSION });
    } catch (err) {
      return fail(`${what}: no response (${short(messageOf(err))})`);
    }
    const status = statusOf(ctx, res);
    if (resultOf(res.body)) return fail(`${what} was served (result)${status}; expected -32022`);
    const err = errorOf(res.body);
    if (!err) return fail(`${what}: no JSON-RPC error in the response${status} (expected -32022)`);
    if (err.code !== MODERN_ERROR_CODES.UNSUPPORTED_PROTOCOL_VERSION) {
      return fail(`${what}: rejected with ${err.code}${status}, expected -32022 UnsupportedProtocolVersionError`);
    }
    const problems: string[] = [];
    if (ctx.kind === "http" && res.statusCode !== 400) problems.push(`HTTP ${res.statusCode} (expected 400)`);
    problems.push(...unsupportedVersionDataProblems(err.data, UNSUPPORTED_VERSION, ctx.state.supportedVersions));
    if (problems.length > 0) return fail(`-32022 returned but ${problems.join("; ")}`);
    const supported = (err.data as { supported: unknown[] }).supported;
    return pass(`-32022${status}; data.supported [${listOf(supported)}], data.requested ${UNSUPPORTED_VERSION}`);
  });

  await harness.check("lifecycle-removed-methods", async () => {
    const failures: string[] = [];
    const summary: string[] = [];
    let warned = false;
    for (const [method, params] of REMOVED_METHOD_PROBES) {
      let res: RpcResponse;
      try {
        res = await client.rpc(method, params);
      } catch (err) {
        failures.push(`${method}: no response (${short(messageOf(err), 60)})`);
        continue;
      }
      if (resultOf(res.body)) {
        failures.push(`${method}: served (result)${statusOf(ctx, res)}`);
        continue;
      }
      const err = errorOf(res.body);
      if (!err) {
        if (ctx.kind === "http" && res.statusCode >= 400) {
          harness.warnings.push(
            `lifecycle-removed-methods: ${method} rejected with HTTP ${res.statusCode} but no JSON-RPC error body`,
          );
          warned = true;
          summary.push(`${method} HTTP ${res.statusCode}`);
        } else {
          failures.push(`${method}: neither result nor JSON-RPC error${statusOf(ctx, res)}`);
        }
        continue;
      }
      if (err.code !== JSONRPC_ERROR_CODES.METHOD_NOT_FOUND) {
        harness.warnings.push(
          `lifecycle-removed-methods: ${method} rejected with ${err.code} (expected -32601 Method not found)`,
        );
        warned = true;
      } else if (ctx.kind === "http" && res.statusCode !== 404) {
        harness.warnings.push(
          `lifecycle-removed-methods: ${method} answered -32601 with HTTP ${res.statusCode} (expected 404)`,
        );
        warned = true;
      }
      summary.push(`${method} ${err.code}${ctx.kind === "http" ? `/${res.statusCode}` : ""}`);
    }
    if (failures.length > 0) return fail(failures.join("; "));
    return pass(`${summary.join(", ")}${warned ? " (see warnings)" : ""}`);
  });

  await harness.check("lifecycle-capability-handlers-match", async () => {
    if (!probe.result) return fail(`${describeProbeFailure(probe, ctx)}; capability declarations unknown`);
    const features: Array<[string, string, string]> = [
      ["tools", "tools/list", "tools"],
      ["resources", "resources/list", "resources"],
      ["prompts", "prompts/list", "prompts"],
    ];
    const failures: string[] = [];
    const summary: string[] = [];
    for (const [cap, method, key] of features) {
      const declared = hasCapability(ctx, cap);
      let res: RpcResponse;
      try {
        res = await client.rpc(method, {});
      } catch (err) {
        failures.push(`${cap}: ${method} got no response (${short(messageOf(err), 60)})`);
        continue;
      }
      const result = resultOf(res.body);
      const err = errorOf(res.body);
      if (declared) {
        if (result && Array.isArray(result[key]))
          summary.push(`${cap}: declared, ${(result[key] as unknown[]).length} listed`);
        else if (result) failures.push(`${cap}: declared but ${method} result has no ${key} array`);
        else failures.push(`${cap}: declared but ${method} returned ${describeResponse(res)}${statusOf(ctx, res)}`);
        continue;
      }
      if (!err) {
        failures.push(
          `${cap}: not declared but ${method} ${result ? "returned a result" : "gave no JSON-RPC error"}${statusOf(ctx, res)}`,
        );
        continue;
      }
      if (err.code !== JSONRPC_ERROR_CODES.METHOD_NOT_FOUND) {
        harness.warnings.push(
          `lifecycle-capability-handlers-match: undeclared ${method} rejected with ${err.code} (expected -32601)`,
        );
      }
      summary.push(`${cap}: undeclared, ${method} -> ${err.code}`);
    }
    if (failures.length > 0) return fail(failures.join("; "));
    return pass(summary.join("; "));
  });

  await harness.check("lifecycle-subscriptions-listen", () => checkSubscriptionsListen(ctx));

  await harness.check("lifecycle-meta-tolerance", async () => {
    let res: RpcResponse;
    try {
      res = await client.rpc("server/discover", {}, { meta: { [VENDOR_META_KEY]: "x" } });
    } catch (err) {
      return fail(`server/discover with an extra _meta key: no response (${short(messageOf(err))})`);
    }
    const err = errorOf(res.body);
    if (err) {
      return fail(
        `Server rejected _meta with unknown key "${VENDOR_META_KEY}": ${err.code}${statusOf(ctx, res)}; unknown keys must be ignored`,
      );
    }
    if (!resultOf(res.body)) return fail(`server/discover with an extra _meta key: no result${statusOf(ctx, res)}`);
    return pass(`Served server/discover with unknown _meta key "${VENDOR_META_KEY}"`);
  });
}

/**
 * The listen filter the suite requests: every listChanged the server
 * advertises. `advertised` names what gates the acknowledgment
 * requirement (resources.subscribe counts, though with no URI to
 * subscribe to it adds nothing to the filter). Exported for unit tests.
 */
export function listenFilterFor(capabilities: Record<string, unknown>): {
  filter: Record<string, boolean>;
  advertised: string[];
} {
  const flag = (cap: string, key: string) => {
    const c = capabilities[cap];
    return isObject(c) && c[key] === true;
  };
  const filter: Record<string, boolean> = {};
  const advertised: string[] = [];
  if (flag("tools", "listChanged")) {
    filter.toolsListChanged = true;
    advertised.push("tools.listChanged");
  }
  if (flag("prompts", "listChanged")) {
    filter.promptsListChanged = true;
    advertised.push("prompts.listChanged");
  }
  if (flag("resources", "listChanged")) {
    filter.resourcesListChanged = true;
    advertised.push("resources.listChanged");
  }
  // resources.subscribe advertises resources/updated; the suite has no URI to
  // subscribe to, so it counts as "advertised" without adding to the filter.
  if (flag("resources", "subscribe")) advertised.push("resources.subscribe");
  return { filter, advertised };
}

async function checkSubscriptionsListen(ctx: ModernSuiteContext): Promise<TestOutcome> {
  const { filter, advertised } = listenFilterFor(ctx.state.capabilities);
  const isAdvertised = advertised.length > 0;
  const listenTimeout = Math.min(3000, ctx.timeout);
  const advertisedNote = isAdvertised
    ? `${advertised.join(", ")} advertised`
    : "nothing subscription-related advertised";

  let stream: TransportStream;
  try {
    stream = await ctx.client.stream("subscriptions/listen", { notifications: filter }, { timeout: listenTimeout });
  } catch (err) {
    return fail(`subscriptions/listen: no response (${short(messageOf(err))})`);
  }

  // Read until the first notification or the response to the listen itself.
  let first: Record<string, unknown> | undefined;
  let response: Record<string, unknown> | undefined;
  try {
    for await (const msg of stream.messages) {
      if (!isObject(msg)) continue;
      if (typeof msg.method === "string" && msg.id === undefined) {
        first = msg;
        break;
      }
      if (msg.id === stream.requestId && ("result" in msg || "error" in msg)) {
        response = msg;
        break;
      }
    }
  } finally {
    await stream.close();
  }

  const httpStatus = ctx.kind === "http" && stream.statusCode !== undefined ? ` (HTTP ${stream.statusCode})` : "";
  const err = response ? errorOf(response) : undefined;
  if (err) {
    if (isAdvertised) {
      return fail(`subscriptions/listen rejected with ${err.code}${httpStatus} although ${advertisedNote}`);
    }
    if (err.code !== JSONRPC_ERROR_CODES.METHOD_NOT_FOUND) {
      ctx.harness.warnings.push(
        `lifecycle-subscriptions-listen: rejected with ${err.code} (expected -32601 when unsupported)`,
      );
    }
    return pass(`${advertisedNote}; subscriptions/listen rejected with ${err.code}${httpStatus}`);
  }
  if (response) return fail(`subscriptions/listen ended with a result before any acknowledgment${httpStatus}`);
  if (!first) {
    if (ctx.kind === "http" && stream.statusCode !== undefined && stream.statusCode >= 400) {
      if (isAdvertised)
        return fail(`subscriptions/listen rejected up front with HTTP ${stream.statusCode} although ${advertisedNote}`);
      ctx.harness.warnings.push(
        `lifecycle-subscriptions-listen: rejected with HTTP ${stream.statusCode} but no JSON-RPC error body`,
      );
      return pass(`${advertisedNote}; subscriptions/listen rejected with HTTP ${stream.statusCode}, no JSON-RPC body`);
    }
    if (stream.exit) {
      const how = stream.exit.signal ? `signal ${stream.exit.signal}` : `code ${stream.exit.code}`;
      return fail(`server exited (${how}) after subscriptions/listen before any acknowledgment; ${advertisedNote}`);
    }
    return fail(`No acknowledgment within ${listenTimeout}ms of subscriptions/listen${httpStatus}; ${advertisedNote}`);
  }
  const problem = acknowledgmentProblem(first, stream.requestId);
  if (problem) return fail(problem);
  const honoured = (first.params as Record<string, unknown>).notifications as Record<string, unknown>;
  const surplus = acknowledgmentSurplus(honoured, filter);
  if (surplus.length > 0) {
    ctx.harness.warnings.push(
      `lifecycle-subscriptions-listen: acknowledgment honours ${surplus.join(", ")}; the listen request did not ask for that, so the server may send notifications outside the requested filter`,
    );
  }
  return pass(
    `Acknowledged subscription ${JSON.stringify(stream.requestId)} first; honoured ${short(JSON.stringify(honoured), 80)}${surplus.length > 0 ? " (see warning)" : ""}`,
  );
}

/**
 * Why the first notification on a listen stream is not a valid
 * acknowledgment, or undefined when it is: it must be
 * notifications/subscriptions/acknowledged, its _meta subscriptionId must
 * equal the listen request id (same JSON type: "1" is not 1), and it must
 * carry a notifications object. Exported for unit tests: no fixture knob
 * retypes the subscription id.
 */
export function acknowledgmentProblem(first: Record<string, unknown>, requestId: string | number): string | undefined {
  if (first.method !== ACK_METHOD) {
    return `First frame on the listen stream was ${String(first.method)}, expected ${ACK_METHOD}`;
  }
  const params = isObject(first.params) ? first.params : undefined;
  const subscriptionId = metaOf(params)?.[META.subscriptionId];
  if (subscriptionId !== requestId) {
    return `Acknowledgment _meta subscriptionId ${JSON.stringify(subscriptionId)} does not equal the listen request id ${JSON.stringify(requestId)}`;
  }
  if (!params || !isObject(params.notifications)) {
    return "Acknowledgment has no notifications object naming the honoured filter";
  }
  return undefined;
}

/**
 * What an acknowledgment honours beyond the filter the listen requested:
 * a `true` for a listChanged type the request did not ask for, a
 * resourceSubscriptions URI the request did not name, or a value of the
 * wrong type. The ack "reflects the subset the server agreed to honor"
 * (basic/patterns/subscriptions#acknowledgment), so a surplus entry is a
 * server that may send notifications outside the requested filter; the
 * spec puts no MUST on the ack's contents, so the caller warns rather
 * than fails. Exported for unit tests: no fixture knob over-declares.
 */
export function acknowledgmentSurplus(honoured: Record<string, unknown>, requested: Record<string, unknown>): string[] {
  const surplus: string[] = [];
  for (const [key, value] of Object.entries(honoured)) {
    if (key === "resourceSubscriptions") {
      if (!Array.isArray(value)) {
        surplus.push(`resourceSubscriptions ${JSON.stringify(value)} (expected an array of URIs)`);
        continue;
      }
      const asked = Array.isArray(requested.resourceSubscriptions) ? requested.resourceSubscriptions : [];
      for (const uri of value) {
        if (!asked.includes(uri)) surplus.push(`resourceSubscriptions ${JSON.stringify(uri)} (not requested)`);
      }
      continue;
    }
    if (typeof value !== "boolean") {
      surplus.push(`${key}: ${JSON.stringify(value)} (expected a boolean)`);
      continue;
    }
    if (value && requested[key] !== true) surplus.push(`${key}: true (not requested)`);
  }
  return surplus;
}

/** Verdict over the progress notifications observed for one request. */
export interface ProgressVerdict {
  ok: boolean;
  problem?: string;
  values: number[];
}

/**
 * Every notifications/progress observed for a request must echo its
 * progressToken and carry a strictly increasing progress value
 * (basic/patterns/progress: "MUST increase with each notification").
 * Exported so the rule is unit-testable without a fixture that misbehaves.
 */
export function evaluateProgress(token: string | number, notifications: unknown[]): ProgressVerdict {
  const values: number[] = [];
  for (const n of notifications) {
    const params = isObject(n) && isObject(n.params) ? n.params : undefined;
    if (!params) return { ok: false, problem: `${PROGRESS_METHOD} without a params object`, values };
    if (params.progressToken !== token) {
      return {
        ok: false,
        problem: `${PROGRESS_METHOD} carries token ${JSON.stringify(params.progressToken)}, expected ${JSON.stringify(token)}`,
        values,
      };
    }
    const progress = params.progress;
    if (typeof progress !== "number" || Number.isNaN(progress)) {
      return { ok: false, problem: `${PROGRESS_METHOD} progress ${JSON.stringify(progress)} is not a number`, values };
    }
    const previous = values[values.length - 1];
    if (previous !== undefined && progress <= previous) {
      return {
        ok: false,
        problem: `progress did not increase (${previous} -> ${progress})`,
        values: [...values, progress],
      };
    }
    values.push(progress);
  }
  return { ok: true, values };
}

function requiresArguments(inputSchema: unknown): boolean {
  return isObject(inputSchema) && Array.isArray(inputSchema.required) && inputSchema.required.length > 0;
}

/**
 * The tool to call with a progressToken: one without required arguments
 * (so `arguments: {}` is valid), preferring one that advertises progress
 * in its name or description, else the first listed tool.
 */
function pickProgressTool(tools: unknown[]): Record<string, unknown> | undefined {
  const named = tools.filter(isObject).filter((t) => typeof t.name === "string");
  const noArgs = named.filter((t) => !requiresArguments(t.inputSchema));
  const mentionsProgress = (t: Record<string, unknown>) =>
    /progress/i.test(String(t.name)) || /progress/i.test(typeof t.description === "string" ? t.description : "");
  return noArgs.find(mentionsProgress) ?? noArgs[0] ?? named[0];
}

/** First variable name of an RFC 6570 template ("{id}", "{?q,lang}", "{+path*}" -> id, q, path). */
function firstTemplateVariable(uriTemplate: string): string | undefined {
  const m = /\{([^}]+)\}/.exec(uriTemplate);
  if (!m) return undefined;
  const name = m[1]
    .replace(/^[+#./;?&]/, "")
    .split(",")[0]
    .replace(/[:*].*$/, "")
    .trim();
  return name || undefined;
}

/**
 * The legacy `initialize` exchange on a FRESH stdio child, recorded like
 * any other exchange. A dual-era stdio server selects its era from how the
 * client opens the process, so on the suite's already-modern process a
 * late initialize is rejected even by a server that serves legacy clients
 * (the SDK 2.0 default); only a fresh process shows what a legacy client
 * actually gets. The caller owns `fresh` and closes it.
 */
async function initializeOnFresh(
  ctx: ModernSuiteContext,
  fresh: Transport,
  params: Record<string, unknown>,
  opts: RpcOptions,
): Promise<RpcResponse> {
  const probeClient = createModernClient({
    transport: fresh,
    recorder: ctx.recorder,
    nextId: () => LEGACY_INITIALIZE_ID,
    timeout: ctx.startupTimeout,
    protocolVersion: ctx.client.protocolVersion,
    clientCapabilities: ctx.client.clientCapabilities,
    clientInfo: ctx.client.clientInfo,
    signal: ctx.signal,
  });
  const unsubscribe = fresh.onMessage((m, meta) => ctx.recorder.recordReceived(m, meta));
  try {
    return await probeClient.rpc("initialize", params, { ...opts, timeout: ctx.startupTimeout });
  } finally {
    unsubscribe();
  }
}

export async function runLifecycleLate(ctx: ModernSuiteContext): Promise<void> {
  const { harness, client } = ctx;

  if (hasCompletions(ctx)) {
    await harness.check(
      "lifecycle-completions",
      async () => {
        let ref: Record<string, unknown> | undefined;
        let argument: Record<string, unknown> | undefined;
        let source = "";
        let fallback = false;
        const prompt = ((await ensurePrompts(ctx)) ?? []).find(
          (p) =>
            isObject(p) &&
            typeof p.name === "string" &&
            Array.isArray(p.arguments) &&
            p.arguments.some((a) => isObject(a) && typeof a.name === "string"),
        ) as Record<string, unknown> | undefined;
        if (prompt) {
          const arg = (prompt.arguments as unknown[]).find((a) => isObject(a) && typeof a.name === "string") as Record<
            string,
            unknown
          >;
          ref = { type: "ref/prompt", name: prompt.name };
          argument = { name: arg.name, value: "" };
          source = `prompt "${String(prompt.name)}" argument "${String(arg.name)}"`;
        } else {
          for (const t of (await ensureResourceTemplates(ctx)) ?? []) {
            if (!isObject(t) || typeof t.uriTemplate !== "string") continue;
            const variable = firstTemplateVariable(t.uriTemplate);
            if (!variable) continue;
            ref = { type: "ref/resource", uri: t.uriTemplate };
            argument = { name: variable, value: "" };
            source = `resource template "${t.uriTemplate}" variable "${variable}"`;
            break;
          }
        }
        if (!ref || !argument) {
          // No listed prompt or template argument to complete: probe with a
          // placeholder ref, where InvalidParams is an acceptable answer.
          ref = { type: "ref/prompt", name: "__test__" };
          argument = { name: "test", value: "" };
          source = 'probe prompt "__test__" (no prompt or template argument listed)';
          fallback = true;
        }
        let res: RpcResponse;
        try {
          res = await client.rpc("completion/complete", { ref, argument });
        } catch (err) {
          return fail(`completion/complete for ${source}: no response (${short(messageOf(err), 60)})`);
        }
        const err = errorOf(res.body);
        if (err) {
          if (fallback && err.code === JSONRPC_ERROR_CODES.INVALID_PARAMS) {
            return pass(`InvalidParams for ${source} (acceptable)`);
          }
          return fail(`completion/complete for ${source}: ${describeResponse(res)}${statusOf(ctx, res)}`);
        }
        const result = resultOf(res.body);
        const completion = result && isObject(result.completion) ? result.completion : undefined;
        if (!completion || !Array.isArray(completion.values)) {
          return fail(`completion/complete for ${source}: result has no completion.values array`);
        }
        return pass(`Returned ${completion.values.length} completion(s) for ${source}`);
      },
      { required: true },
    );
  }

  await harness.check("lifecycle-progress-token", async () => {
    const tools = await ensureTools(ctx);
    if (!tools) {
      return pass(hasTools(ctx) ? "skipped: tools/list failed (see tools-list)" : "skipped: server declares no tools");
    }
    if (tools.length === 0) return pass("skipped: server lists no tools");
    const tool = pickProgressTool(tools);
    if (!tool) return pass("skipped: no listed tool has a name");
    const name = String(tool.name);
    const seqStart = ctx.recorder.received.length;
    let res: RpcResponse;
    try {
      res = await client.rpc(
        "tools/call",
        { name, arguments: {}, _meta: { progressToken: PROGRESS_TOKEN } },
        { toolInputSchema: tool.inputSchema },
      );
    } catch (err) {
      return fail(`tools/call ${name} with progressToken: no response (${short(messageOf(err), 60)})`);
    }
    // HTTP: notifications ride the response stream (res.messages) and are
    // also emitted to the recorder; stdio: only the recorder sees them.
    // Union by identity so the HTTP copies are not counted twice.
    const seen = new Set<unknown>();
    const notifications: unknown[] = [];
    const consider = (m: unknown) => {
      if (isObject(m) && m.method === PROGRESS_METHOD && !seen.has(m)) {
        seen.add(m);
        notifications.push(m);
      }
    };
    for (const m of res.messages) consider(m);
    for (const r of ctx.recorder.received.slice(seqStart)) consider(r.message);
    const callNote = errorOf(res.body)
      ? `tools/call ${name} returned ${describeResponse(res)}`
      : `tools/call ${name} succeeded`;
    const verdict = evaluateProgress(PROGRESS_TOKEN, notifications);
    if (!verdict.ok) return fail(`${verdict.problem} (${callNote})`);
    if (notifications.length === 0) return pass(`${callNote}; no ${PROGRESS_METHOD} observed (optional)`);
    return pass(
      `${notifications.length} ${PROGRESS_METHOD} echoed token "${PROGRESS_TOKEN}" with increasing progress (${listOf(verdict.values, 8)})`,
    );
  });

  // The claim-less probes: a request with no protocolVersion claim is
  // malformed (basic/index#meta, -32602). They run here, after the feature
  // modules, because a dual-era stdio server that is still deciding its
  // era treats a claim-less message as a legacy opening and pins the
  // process to legacy for good; by now a non-discover modern request has
  // pinned it modern and the probes measure the validation they target.
  await harness.check("lifecycle-meta-required", () =>
    expectRejection(
      ctx,
      "lifecycle-meta-required",
      "server/discover without _meta",
      JSONRPC_ERROR_CODES.INVALID_PARAMS,
      () => client.rpc("server/discover", {}, { meta: false }),
    ),
  );

  await harness.check("lifecycle-meta-protocol-version-required", () =>
    expectRejection(
      ctx,
      "lifecycle-meta-protocol-version-required",
      "server/discover without _meta protocolVersion",
      JSONRPC_ERROR_CODES.INVALID_PARAMS,
      () => client.rpc("server/discover", {}, { meta: { [META.protocolVersion]: undefined } }),
    ),
  );

  // Runs LAST. On stdio the probe goes to a FRESH child: a dual-era server
  // selects its era per process, so the suite's process (pinned modern by
  // now) would reject an initialize that a legacy client opening a new
  // process is served. On HTTP every request is its own opening.
  await harness.check("lifecycle-dual-era", async () => {
    const legacyParams = {
      protocolVersion: LEGACY_SPEC_VERSION,
      capabilities: {},
      clientInfo: client.clientInfo,
    };
    // Exactly what a 2025-11-25 client sends: no modern _meta, no Mcp-Method,
    // and the legacy protocol version in the header.
    const opts: RpcOptions = {
      meta: false,
      headers: { "Mcp-Method": null, "MCP-Protocol-Version": LEGACY_SPEC_VERSION },
    };
    const fresh = ctx.kind === "stdio" ? ctx.spawnFresh?.() : undefined;
    const where = fresh ? " on a fresh process" : "";
    let res: RpcResponse;
    try {
      res = fresh
        ? await initializeOnFresh(ctx, fresh, legacyParams, opts)
        : await client.rpc("initialize", legacyParams, opts);
    } catch (err) {
      const message = messageOf(err);
      const probed = (fresh ?? ctx.transport) as StdioTransport;
      if (ctx.kind === "stdio" && probed.exited) {
        return fail(`Server exited after a legacy initialize request${where}: ${short(message)}`);
      }
      harness.warnings.push(
        `lifecycle-dual-era: legacy initialize got no response (${short(message, 60)}); a modern-only server SHOULD reject it with an error naming its supported versions`,
      );
      return pass(
        `No response to legacy initialize${where} within ${fresh ? ctx.startupTimeout : ctx.timeout}ms; era undetermined (see warning)`,
      );
    } finally {
      await fresh?.close();
    }
    const status = statusOf(ctx, res);
    const result = resultOf(res.body);
    if (result) {
      // The suite-level dual-era warning keys on this: SDK 2.0 servers
      // advertise only modern versions yet still serve the handshake.
      ctx.state.legacyInitializeServed = true;
      if (typeof result.protocolVersion === "string") {
        return pass(
          `dual-era: initialize answered with protocolVersion ${result.protocolVersion}${where}; legacy handshake served alongside ${MODERN_SPEC_VERSION}`,
        );
      }
      return pass(`initialize returned a result without protocolVersion${status}${where}; era ambiguous`);
    }
    const err = errorOf(res.body);
    if (err) {
      const named = supportedVersionsNamedIn(err);
      if (!named) {
        harness.warnings.push(
          `lifecycle-dual-era: initialize rejected with ${err.code} but neither the message nor data.supported names a supported protocol version (spec SHOULD): "${short(err.message, 80)}"`,
        );
      }
      return pass(
        `modern-only: initialize rejected with ${err.code}${status}${where}${named ? `; ${named}` : " (see warning)"}`,
      );
    }
    if (ctx.kind === "http" && res.statusCode >= 400) {
      harness.warnings.push(
        `lifecycle-dual-era: initialize rejected with HTTP ${res.statusCode} and no JSON-RPC error body; a modern-only server SHOULD name its supported versions in the error`,
      );
      return pass(
        `modern-only: initialize rejected with HTTP ${res.statusCode} and no JSON-RPC error body (see warning)`,
      );
    }
    return pass(`initialize answered with neither result nor error${status}${where}; era undetermined`);
  });
}
