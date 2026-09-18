import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { MODERN_SPEC_VERSION } from "../spec.js";
import { runModern } from "./helpers/modern-fixture.js";

/**
 * Six 2026-07-28 checks that used to credit whatever JSON-RPC error body came
 * back as the server's own answer: lifecycle-jsonrpc (the envelope of the
 * setup server/discover), error-unknown-method, error-invalid-jsonrpc (a
 * malformed envelope), error-invalid-json (a body that is not JSON),
 * error-missing-params (a tools/call without a name) and
 * error-capability-gated (a method of a capability the server did not
 * declare). A gateway answering 401 with a -32001 "Unauthorized" body that
 * echoes the request id earned their passes. They now read an answer the way
 * the 2025-11-25 suite does (postInitRejection in runner.ts), through one
 * shared reader (src/suites/modern/gate.ts): a 401, a 403 carrying a Bearer
 * challenge, a 403 the conformant server/discover (the twin) cannot credit,
 * a repeated 429, or a 5xx without the check's own JSON-RPC code is not the
 * server's answer, and fails as not evaluable.
 */

type Answer =
  | "rpc-400"
  | "rpc-401"
  | "bare-401"
  | "bearer-403"
  | "host-403"
  | "longhost-403"
  | "bare-403"
  | "html-403"
  | 429
  | "429-once"
  | "bare-503"
  | "rpc-503"
  | "own-500"
  | "own-500-no-id"
  | "custom-500"
  | "hang"
  | "reset";

type Probe =
  | "discover"
  | "unknown"
  | "malformed"
  | "badJson"
  | "missingName"
  | "list"
  | "cursor"
  | "listen"
  | "batch"
  | "textPlain"
  | "other";

interface StubOptions {
  /**
   * A gate in front of the server: answers every request that does not carry
   * `Bearer <token>` (every request, when no token is set) and whose probe is
   * not in `exempt`.
   */
  gate?: Answer;
  token?: string;
  exempt?: Probe[];
  /**
   * Only the first N server/discover requests are answered as usual; every
   * later one is answered with `lateDiscover` (default: the gate's answer) --
   * a WAF that starts blocking this client partway through the run. The
   * first is the pinned run's preflight, the second the setup discover. A
   * list answers the late discovers in turn, its last entry repeating.
   */
  discoverThrough?: number;
  lateDiscover?: Answer | Answer[];
  /** The server's own answer to server/discover: served by default, declaring `capabilities`. */
  discover?: Answer | "legacy-400";
  /** What server/discover declares: tools only by default, so resources/list and prompts/list are undeclared. */
  capabilities?: Record<string, unknown>;
  /** An unknown method: 404 with -32601 by default. */
  unknown?: Answer;
  /** A JSON body that is no JSON-RPC message: 400 with -32600 by default. */
  malformed?: Answer;
  /** A body that is not JSON: 400 with -32700 by default. */
  badJson?: Answer;
  /** tools/call without a name: 400 with -32602 by default. */
  missingName?: Answer;
  /** tools/list, resources/list, prompts/list without a cursor: served when declared, 404 with -32601 when not, by default. */
  lists?: Answer;
  /** A list request carrying a cursor (error-invalid-cursor): 400 with -32602 by default. */
  cursor?: Answer;
  /** subscriptions/listen: 404 with -32601 by default (nothing advertised). */
  listen?: Answer;
  /** A JSON array body (transport-batch-reject): 400 with an id-null -32600 by default. */
  batch?: Answer;
  /** A POST with Content-Type text/plain (transport-content-type-reject): a bare 415 by default. */
  textPlain?: Answer;
  /** Called with each probe as it arrives, before it is answered. */
  onProbe?: (probe: Probe) => void;
}

const RETRY_AFTER = "0";

/**
 * A stateless 2026-07-28 HTTP server whose answer to each checked request is a
 * knob, behind an optional gate. Records which probe every POST was.
 */
async function startStub(opts: StubOptions): Promise<{ url: string; hits: Probe[]; stop(): Promise<void> }> {
  const hits: Probe[] = [];
  const throttledOnce = new Set<Probe>();
  let discovers = 0;
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let msg: unknown;
      let json = true;
      try {
        msg = JSON.parse(text);
      } catch {
        json = false;
      }
      const one = (msg && typeof msg === "object" && !Array.isArray(msg) ? msg : {}) as {
        id?: unknown;
        method?: string;
        params?: { name?: unknown; cursor?: unknown };
      };
      const probe: Probe = String(req.headers["content-type"] ?? "").startsWith("text/plain")
        ? "textPlain"
        : Array.isArray(msg)
          ? "batch"
          : !json
            ? "badJson"
            : one.method === undefined
              ? "malformed"
              : one.method === "server/discover"
                ? "discover"
                : one.method.startsWith("compliance/nonexistent")
                  ? "unknown"
                  : one.method === "tools/call" && one.params?.name === undefined
                    ? "missingName"
                    : ["tools/list", "resources/list", "prompts/list"].includes(one.method)
                      ? one.params?.cursor !== undefined
                        ? "cursor"
                        : "list"
                      : one.method === "subscriptions/listen"
                        ? "listen"
                        : "other";
      hits.push(probe);
      if (probe === "discover") discovers++;
      opts.onProbe?.(probe);
      const send = (status: number, body: string, headers: Record<string, string>) => {
        res.writeHead(status, headers);
        res.end(body);
      };
      const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
        send(status, JSON.stringify(body), { "content-type": "application/json", ...headers });
      const rpcError = (status: number, code: number, message: string, headers?: Record<string, string>) =>
        reply(status, { jsonrpc: "2.0", id: one.id ?? null, error: { code, message } }, headers);
      const result = (r: Record<string, unknown>) =>
        reply(200, { jsonrpc: "2.0", id: one.id, result: { resultType: "complete", ...r } });
      /** Answer with `answer`; false when it is a "429-once" already spent (answer as the server would). */
      const answerWith = (answer: Answer): boolean => {
        switch (answer) {
          case "rpc-400":
            // A status the server itself chose: its own refusal of the request.
            rpcError(400, -32600, "Invalid Request");
            return true;
          case "rpc-401":
            // The measured gateway: 401, a -32001 body that echoes the request id.
            rpcError(401, -32001, "Unauthorized", { "www-authenticate": 'Bearer realm="mcp"' });
            return true;
          case "bare-401":
            // An auth gate with no body at all.
            send(401, "", { "www-authenticate": 'Bearer realm="mcp"' });
            return true;
          case "bearer-403":
            rpcError(403, -32001, "Forbidden", { "www-authenticate": 'Bearer error="insufficient_scope"' });
            return true;
          case "host-403":
            rpcError(403, -32000, "Invalid Host: mcp.internal.example");
            return true;
          case "longhost-403":
            rpcError(403, -32000, `Invalid Host header: ${"very-long-internal-hostname.".repeat(5)}example`);
            return true;
          case "bare-403":
            rpcError(403, -32000, "Forbidden");
            return true;
          case "html-403":
            // A WAF's block page: no JSON-RPC body, no challenge.
            send(403, "<html><body><h1>403 Forbidden</h1></body></html>", { "content-type": "text/html" });
            return true;
          case "429-once":
            if (throttledOnce.has(probe)) return false;
            throttledOnce.add(probe);
            send(429, "Too Many Requests", { "content-type": "text/plain", "retry-after": RETRY_AFTER });
            return true;
          case 429:
            send(429, "Too Many Requests", { "content-type": "text/plain", "retry-after": RETRY_AFTER });
            return true;
          case "bare-503":
            send(503, "Service Unavailable", { "content-type": "text/plain" });
            return true;
          case "rpc-503":
            rpcError(503, -32603, "Backend unavailable");
            return true;
          case "own-500":
            // The server's own JSON-RPC rejection of the probe's defect, on an
            // HTTP 500 (a framework that maps every JSON-RPC error to 500).
            if (probe === "malformed") rpcError(500, -32600, "Invalid Request: not a JSON-RPC message");
            else if (probe === "batch") rpcError(500, -32600, "Invalid Request: batches are not supported");
            else if (probe === "badJson") rpcError(500, -32700, "Parse error");
            else if (probe === "missingName") rpcError(500, -32602, "Invalid params: name is required");
            else if (probe === "cursor") rpcError(500, -32602, "Invalid params: invalid cursor");
            else rpcError(500, -32601, "Method not found");
            return true;
          case "own-500-no-id":
            // The server's own -32601 on a 500, without echoing the request id.
            reply(500, { jsonrpc: "2.0", id: null, error: { code: -32601, message: "Method not found" } });
            return true;
          case "custom-500":
            rpcError(500, -32000, "Request rejected");
            return true;
          case "hang":
            return true;
          case "reset":
            req.socket.destroy();
            return true;
        }
      };
      if (probe === "discover" && opts.discoverThrough !== undefined && discovers > opts.discoverThrough) {
        const late = opts.lateDiscover ?? opts.gate ?? "bare-403";
        const turn = discovers - opts.discoverThrough - 1;
        if (answerWith(Array.isArray(late) ? late[Math.min(turn, late.length - 1)] : late)) return;
      }
      const authed = opts.token !== undefined && req.headers.authorization === `Bearer ${opts.token}`;
      const exempt = (opts.exempt ?? []).includes(probe);
      if (opts.gate !== undefined && !authed && !exempt) {
        if (answerWith(opts.gate)) return;
      }
      // Each probe falls back to the conformant server's answer, a spent
      // "429-once" included.
      switch (probe) {
        case "discover":
          if (opts.discover === "legacy-400") return rpcError(400, -32601, "Method not found: server/discover");
          if (opts.discover !== undefined && answerWith(opts.discover)) return;
          return result({
            supportedVersions: [MODERN_SPEC_VERSION],
            capabilities: opts.capabilities ?? { tools: {} },
            ttlMs: 0,
            cacheScope: "public",
          });
        case "unknown":
          if (opts.unknown !== undefined && answerWith(opts.unknown)) return;
          return rpcError(404, -32601, "Method not found");
        case "malformed":
          if (opts.malformed !== undefined && answerWith(opts.malformed)) return;
          return rpcError(400, -32600, "Invalid Request");
        case "badJson":
          if (opts.badJson !== undefined && answerWith(opts.badJson)) return;
          return rpcError(400, -32700, "Parse error");
        case "missingName":
          if (opts.missingName !== undefined && answerWith(opts.missingName)) return;
          return rpcError(400, -32602, "Invalid params: name is required");
        case "list": {
          if (opts.lists !== undefined && answerWith(opts.lists)) return;
          const key = String(one.method).split("/")[0];
          if (key in (opts.capabilities ?? { tools: {} })) return result({ [key]: [] });
          return rpcError(404, -32601, "Method not found");
        }
        case "cursor":
          if (opts.cursor !== undefined && answerWith(opts.cursor)) return;
          return rpcError(400, -32602, "Invalid params: invalid cursor");
        case "listen":
          if (opts.listen !== undefined && answerWith(opts.listen)) return;
          return rpcError(404, -32601, "Method not found");
        case "batch":
          if (opts.batch !== undefined && answerWith(opts.batch)) return;
          return rpcError(400, -32600, "Invalid Request: batches are not supported");
        case "textPlain":
          if (opts.textPlain !== undefined && answerWith(opts.textPlain)) return;
          return send(415, "Unsupported Media Type", { "content-type": "text/plain" });
      }
      if (one.id === undefined) return send(202, "", {});
      return rpcError(404, -32601, "Method not found");
    });
  });
  const url = await new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(`http://127.0.0.1:${addr && typeof addr === "object" ? addr.port : 0}/mcp`);
    });
  });
  return {
    url,
    hits,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const JSONRPC = "lifecycle-jsonrpc";
const UNKNOWN = "error-unknown-method";
const ENVELOPE = "error-invalid-jsonrpc";
const PARSE = "error-invalid-json";
const PARAMS = "error-missing-params";
const GATED = "error-capability-gated";
const ERRORS = [UNKNOWN, ENVELOPE, PARSE, PARAMS, GATED];
const ALL = [JSONRPC, ...ERRORS];

async function verdicts(
  stubOpts: StubOptions,
  runOpts: { only?: string[]; headers?: Record<string, string>; timeout?: number; signal?: AbortSignal } = {},
): Promise<{ byId: Record<string, string>; details: Record<string, string>; hits: Probe[]; warnings: string[] }> {
  const stub = await startStub(stubOpts);
  try {
    const report = await runModern(stub.url, {
      timeout: runOpts.timeout ?? 3000,
      only: runOpts.only ?? ALL,
      ...(runOpts.headers ? { headers: runOpts.headers } : {}),
      ...(runOpts.signal ? { signal: runOpts.signal } : {}),
    });
    return {
      byId: Object.fromEntries(
        report.tests.map((t) => [t.id, `${t.passed ? "PASS" : "FAIL"}${t.skipped ? " (skipped)" : ""}: ${t.details}`]),
      ),
      details: Object.fromEntries(report.tests.map((t) => [t.id, t.details])),
      hits: [...stub.hits],
      warnings: report.warnings,
    };
  } finally {
    await stub.stop();
  }
}

const count = (hits: Probe[], probe: Probe) => hits.filter((h) => h === probe).length;

/** The warnings the six checks draw (every other warning in these runs is the pinned run's own). */
const checkWarnings = (warnings: string[]) =>
  warnings.filter((w) => /^(lifecycle-jsonrpc|error-)|spec requires/.test(w));

/** What a conformant server's own answers read as (the setup discover is the stub's second request, id 1001). */
const CONFORMANT = {
  [JSONRPC]: "PASS: Valid JSON-RPC 2.0 response (id 1001 echoed, result)",
  [UNKNOWN]: "PASS: JSON-RPC error -32601 on HTTP 404, id echoed",
  [ENVELOPE]: "PASS: JSON-RPC error -32600 (correct: Invalid Request) on HTTP 400",
  [PARSE]: "PASS: JSON-RPC error -32700 (correct: Parse error) on HTTP 400",
  [PARAMS]: "PASS: JSON-RPC error -32602 (correct: Invalid params) (Invalid params: name is required)",
  [GATED]: "PASS: Undeclared method(s) rejected: resources/list -> -32601, prompts/list -> -32601",
};

const AUTH = "an auth gate answered before the server read the request (pass --auth)";
const RATE = "a rate limiter answered before the server read the request";
const reason = (why: string, about: string) => `not evaluable: ${why}, so it proves nothing about ${about}`;
/** What error-capability-gated's notEvaluable reason (a rejected setup discover) names. */
const GATED_ABOUT = "whether undeclared methods are rejected";
/** What its gateVerdict reasons name (shorter: they follow every method's answer). */
const GATED_GATE = "the undeclared methods";
/**
 * gateVerdict's reason for a 5xx without the check's own code: the server
 * failing on the probe, a failure of the check on its own terms, so no
 * "not evaluable" (before: "not evaluable: a 5xx that carries no ... proves
 * nothing about ...").
 */
const failedOn = (codes?: string) =>
  `the server failed on the request rather than rejecting it (a broken server, or a gateway with no backend)${codes ? `; ${codes} on a 4xx is expected` : ""}`;
/** A bare 403 whose conformant twin (`request`) did not reach the server either. */
const twinFailed = (request: string, twin: string, about: string, pointer = true) =>
  `not evaluable: a conformant ${request} ${twin} too, so the 403 proves nothing about ${about}${pointer ? " (see security-auth-required)" : ""}`;
/** The rejection-on-5xx warning: the status only, never the verdict (before: "... rejected X ...; credited, but ..."). */
const on5xx = (check: string, what: string, code: number, expected = "a 4xx status is expected", status = 500) =>
  `${check}: the server answered ${what} with its own JSON-RPC error ${code} on HTTP ${status}; a rejected request is a client error, so ${expected} (a 5xx tells clients and gateways the server failed)`;

/** Every listed check's details within the 220-character budget, in printable ASCII. */
function expectWithinBudget(details: Record<string, string>, ids: string[]) {
  for (const id of ids) {
    const text = details[id];
    expect(text, id).toBeDefined();
    expect(text.length, `${id} (${text.length}): ${text}`).toBeLessThanOrEqual(220);
    expect(text, id).toMatch(/^[\x20-\x7e]*$/);
  }
}

describe("modern gate reading: a server that answers each request itself keeps its PASS", () => {
  it("its own JSON-RPC errors: every verdict and warning unchanged, and no twin is asked", async () => {
    const { byId, hits, warnings } = await verdicts({});
    expect(byId).toEqual(CONFORMANT);
    expect(checkWarnings(warnings)).toEqual([]);
    // The preflight and the setup discover; no conformant twin was sent.
    expect(count(hits, "discover")).toBe(2);
  }, 30_000);

  it("a server that declares every capability has no undeclared method to probe: still a skip", async () => {
    const { byId } = await verdicts({ capabilities: { tools: {}, resources: {}, prompts: {} } }, { only: [GATED] });
    expect(byId[GATED]).toBe(
      "PASS (skipped): Server declares all capabilities (tools, resources, prompts); no undeclared methods to test",
    );
  }, 30_000);

  it("a legacy server's own -32601 on HTTP 400 to server/discover is still a valid envelope", async () => {
    const { byId } = await verdicts({ discover: "legacy-400" }, { only: [JSONRPC] });
    expect(byId[JSONRPC]).toBe("PASS: Valid JSON-RPC 2.0 response (id 1001 echoed, error)");
  }, 30_000);
});

describe("modern gate reading: the measured gateway (401 with a -32001 body that echoes the id)", () => {
  it("server/discover gated too: lifecycle-jsonrpc no longer credits the gateway's envelope (before: PASS)", async () => {
    // Before: PASS "Valid JSON-RPC 2.0 response (id 1001 echoed, error)".
    const { byId } = await verdicts({ gate: "rpc-401" });
    const rejected =
      "not evaluable: the conformant server/discover was itself rejected with -32001 (HTTP 401), so this rejection proves nothing about";
    expect(byId).toEqual({
      [JSONRPC]: `FAIL: server/discover answered JSON-RPC error -32001 (HTTP 401); ${reason(AUTH, "the server's JSON-RPC envelope")}`,
      // Unchanged: the rejected discover already made these not evaluable.
      [UNKNOWN]: `FAIL: JSON-RPC error -32001 (HTTP 401) for an unknown method; ${rejected} the injected defect`,
      [ENVELOPE]: `FAIL: JSON-RPC error -32001 on HTTP 401 for a malformed envelope; ${rejected} the injected defect`,
      [PARSE]: `FAIL: JSON-RPC error -32001 on HTTP 401 for invalid JSON; ${rejected} the injected defect`,
      [GATED]: `FAIL: tools/list -> -32001, resources/list -> -32001, prompts/list -> -32001; ${rejected} ${GATED_ABOUT}`,
    });
  }, 30_000);

  it("server/discover let through, everything else answered 401: the five error checks no longer credit it (before: five passes)", async () => {
    // Before: PASS "JSON-RPC error -32001 on HTTP 401 (spec requires 404), id
    // echoed", PASS "JSON-RPC error -32001 on HTTP 401" twice, PASS
    // "JSON-RPC error -32001 (Unauthorized)" and PASS "Undeclared method(s)
    // rejected: resources/list -> -32001 (expected -32601), prompts/list ->
    // -32001 (expected -32601)", with a "spec requires 404" warning.
    const { byId, warnings } = await verdicts({ gate: "rpc-401", exempt: ["discover"] });
    const rpc = "JSON-RPC error -32001";
    expect(byId).toEqual({
      [JSONRPC]: CONFORMANT[JSONRPC],
      [UNKNOWN]: `FAIL: ${rpc} (HTTP 401) for an unknown method; ${reason(AUTH, "the unknown method")}`,
      [ENVELOPE]: `FAIL: ${rpc} on HTTP 401 for a malformed envelope; ${reason(AUTH, "the malformed envelope")}`,
      [PARSE]: `FAIL: ${rpc} on HTTP 401 for invalid JSON; ${reason(AUTH, "the invalid JSON")}`,
      [PARAMS]: `FAIL: ${rpc} (HTTP 401) for a tools/call without a name; ${reason(AUTH, "the missing tool name")}`,
      // The methods that drew the same answer are named together.
      [GATED]: `FAIL: resources/list, prompts/list -> -32001 (HTTP 401); ${reason(AUTH, GATED_GATE)}`,
    });
    expect(checkWarnings(warnings)).toEqual([]);
  }, 30_000);

  it("--auth with a credential the gate refuses: the 401 names the credential", async () => {
    const { byId } = await verdicts(
      { gate: "rpc-401", token: "right", exempt: ["discover"] },
      { only: [UNKNOWN], headers: { Authorization: "Bearer wrong" } },
    );
    expect(byId[UNKNOWN]).toBe(
      `FAIL: JSON-RPC error -32001 (HTTP 401) for an unknown method; ${reason(
        "an auth gate answered before the server read the request (credential rejected -- check --auth)",
        "the unknown method",
      )}`,
    );
  }, 30_000);

  it("the same gate with the credential it accepts: the server behind it is measured as usual", async () => {
    const { byId } = await verdicts(
      { gate: "rpc-401", token: "right" },
      { headers: { Authorization: "Bearer right" } },
    );
    expect(byId).toEqual(CONFORMANT);
  }, 30_000);

  it("a 403 carrying a Bearer challenge on the probes alone is an auth gate too", async () => {
    const { byId } = await verdicts({ unknown: "bearer-403", missingName: "bearer-403" }, { only: [UNKNOWN, PARAMS] });
    expect(byId).toEqual({
      [UNKNOWN]: `FAIL: JSON-RPC error -32001 (HTTP 403) for an unknown method; ${reason(AUTH, "the unknown method")}`,
      [PARAMS]: `FAIL: JSON-RPC error -32001 (HTTP 403) for a tools/call without a name; ${reason(AUTH, "the missing tool name")}`,
    });
  }, 30_000);
});

describe("modern gate reading: a 403 without a Bearer challenge, read against the conformant server/discover", () => {
  it("next to a served twin, the 403 is credited whatever its message names; the twin is asked once per check", async () => {
    const bare = await verdicts({ gate: "bare-403", exempt: ["discover"] }, { only: ERRORS });
    expect(bare.byId).toEqual({
      [UNKNOWN]: "PASS: JSON-RPC error -32000 on HTTP 403 (spec requires 404), id echoed",
      [ENVELOPE]: "PASS: JSON-RPC error -32000 on HTTP 403",
      [PARSE]: "PASS: JSON-RPC error -32000 on HTTP 403",
      [PARAMS]: "PASS: JSON-RPC error -32000 (Forbidden)",
      [GATED]:
        "PASS: Undeclared method(s) rejected: resources/list -> -32000 (expected -32601), prompts/list -> -32000 (expected -32601)",
    });
    // Preflight + setup discover, then one twin per check (error-capability-gated
    // asks once for both of its methods).
    expect(count(bare.hits, "discover")).toBe(2 + ERRORS.length);
    const host = await verdicts({ gate: "host-403", exempt: ["discover"] }, { only: [UNKNOWN, ENVELOPE] });
    expect(host.byId).toEqual({
      [UNKNOWN]: "PASS: JSON-RPC error -32000 on HTTP 403 (spec requires 404), id echoed",
      [ENVELOPE]: "PASS: JSON-RPC error -32000 on HTTP 403",
    });
  }, 30_000);

  it("a twin refused the same way: not evaluable, quoting a message that names Host/Origin validation", async () => {
    // A guard that let the setup discover through and now refuses every
    // request, the conformant twin included.
    const host = await verdicts({ gate: "host-403", exempt: ["discover"], discoverThrough: 2 }, { only: ERRORS });
    // Within the 220-character budget the quoted message, which names the
    // refused host, outranks the explanation (before: "..., which refuses a
    // request whatever it carries, ...", up to 272 characters).
    const guard = (about: string) =>
      reason('its message ("Invalid Host: mcp.internal.example") names Host/Origin validation', about);
    const rpc = "JSON-RPC error -32000";
    expect(host.byId).toEqual({
      [UNKNOWN]: `FAIL: ${rpc} (HTTP 403) for an unknown method; ${guard("the unknown method")}`,
      [ENVELOPE]: `FAIL: ${rpc} on HTTP 403 for a malformed envelope; ${guard("the malformed envelope")}`,
      [PARSE]: `FAIL: ${rpc} on HTTP 403 for invalid JSON; ${guard("the invalid JSON")}`,
      [PARAMS]: `FAIL: ${rpc} (HTTP 403) for a tools/call without a name; ${guard("the missing tool name")}`,
      [GATED]: `FAIL: resources/list, prompts/list -> -32000 (HTTP 403); ${guard(GATED_GATE)}`,
    });
    expectWithinBudget(host.details, ERRORS);
    const bare = await verdicts({ gate: "bare-403", exempt: ["discover"], discoverThrough: 2 }, { only: [UNKNOWN] });
    // " for an unknown method" gives way to the pointer: the reason names the unknown method already.
    expect(bare.byId[UNKNOWN]).toBe(
      `FAIL: JSON-RPC error -32000 (HTTP 403); ${twinFailed("server/discover", "was refused (HTTP 403, JSON-RPC error -32000)", "the unknown method")}`,
    );
  }, 30_000);

  it("a twin that got no answer cannot credit the 403 either", async () => {
    const { byId } = await verdicts(
      { gate: "bare-403", exempt: ["discover"], discoverThrough: 2, lateDiscover: "hang" },
      { only: [UNKNOWN], timeout: 1000 },
    );
    // The stub hangs every discover after the setup one: the twin.
    expect(byId[UNKNOWN]).toBe(
      `FAIL: JSON-RPC error -32000 (HTTP 403) for an unknown method; ${twinFailed("server/discover", "got no response within 1000ms", "the unknown method")}`,
    );
  }, 30_000);
});

describe("modern gate reading: a rate limiter's 429", () => {
  it("a 429 on each probe once: resent after Retry-After, and the second answer decides", async () => {
    const { byId, hits, warnings } = await verdicts({
      unknown: "429-once",
      malformed: "429-once",
      badJson: "429-once",
      missingName: "429-once",
      lists: "429-once",
    });
    expect(byId).toEqual(CONFORMANT);
    expect(checkWarnings(warnings)).toEqual([]);
    for (const probe of ["unknown", "malformed", "badJson", "missingName"] as const) {
      expect(count(hits, probe), probe).toBe(2);
    }
    // The stub's "429-once" is per probe kind: the first list method is
    // throttled once, the second is not.
    expect(count(hits, "list")).toBe(3);
  }, 30_000);

  it("a 429 on each probe, resent once and throttled again: not evaluable (before: three passes)", async () => {
    // Before: PASS "HTTP 429 without a JSON-RPC body (acceptable)" twice and
    // PASS "Undeclared method(s) rejected: resources/list -> rejected (HTTP
    // 429), ...", FAIL "No JSON-RPC error body for unknown method (HTTP 429)"
    // and FAIL "No JSON-RPC error for tools/call without name (HTTP 429)".
    const { byId } = await verdicts(
      { unknown: 429, malformed: 429, badJson: 429, missingName: 429, lists: 429 },
      { only: ERRORS },
    );
    const twice = "HTTP 429, then after 0ms HTTP 429";
    const none = "no JSON-RPC error body";
    expect(byId).toEqual({
      [UNKNOWN]: `FAIL: ${none} (${twice}) for an unknown method; ${reason(RATE, "the unknown method")}`,
      [ENVELOPE]: `FAIL: ${none} on ${twice} for a malformed envelope; ${reason(RATE, "the malformed envelope")}`,
      [PARSE]: `FAIL: ${none} on ${twice} for invalid JSON; ${reason(RATE, "the invalid JSON")}`,
      [PARAMS]: `FAIL: ${none} (${twice}) for a tools/call without a name; ${reason(RATE, "the missing tool name")}`,
      [GATED]: `FAIL: resources/list, prompts/list -> no JSON-RPC body (${twice}); ${reason(RATE, GATED_GATE)}`,
    });
  }, 30_000);

  it("no probe is resent once the setup server/discover was rejected: every rejection is not evaluable already (before: each resent)", async () => {
    // Pinned run against a server that answers everything 429. Before, each
    // probe was resent after Retry-After (capped at 2 s) although the verdict
    // was withheld whatever the resend drew: error-capability-gated resent
    // all three list methods (6 requests, up to 6 s) and printed the same
    // details; error-unknown-method, error-invalid-jsonrpc and
    // error-invalid-json resent theirs too.
    const { details, hits } = await verdicts(
      { discover: 429, unknown: 429, malformed: 429, badJson: 429, lists: 429 },
      { only: [UNKNOWN, ENVELOPE, PARSE, "error-parse-code", "error-invalid-request-code", GATED] },
    );
    expect(count(hits, "list")).toBe(3);
    expect(count(hits, "unknown")).toBe(1);
    expect(count(hits, "malformed")).toBe(2);
    expect(count(hits, "badJson")).toBe(2);
    const rejected =
      "not evaluable: the conformant server/discover was itself rejected with no JSON-RPC error code (HTTP 429), so this rejection proves nothing about";
    // Within 220 characters " for <what>" gives way to the reason where both do not fit.
    expect(details).toEqual({
      [UNKNOWN]: `no JSON-RPC error body (HTTP 429); ${rejected} the injected defect`,
      [ENVELOPE]: `no JSON-RPC error body on HTTP 429; ${rejected} the injected defect`,
      [PARSE]: `no JSON-RPC error body on HTTP 429 for invalid JSON; ${rejected} the injected defect`,
      "error-parse-code": `no JSON-RPC error body on HTTP 429 for invalid JSON; ${rejected} the injected defect`,
      "error-invalid-request-code": `no JSON-RPC error body on HTTP 429; ${rejected} the injected defect`,
      [GATED]: expect.stringMatching(
        /^tools\/list -> no JSON-RPC body \(HTTP 429\), .*; not evaluable: the conformant/,
      ),
    });
  }, 30_000);
});

describe("modern error-parse-code and error-invalid-request-code: whose bodiless 4xx it is", () => {
  // Both credit a 4xx with no JSON-RPC body, with a warning. That is what a
  // rate limiter, an auth gate or a WAF answers too, so it is now read the
  // way error-invalid-json and error-invalid-jsonrpc read the same answer
  // (gateVerdict); before, the two pairs contradicted each other in one run.
  const PARSE_CODE = "error-parse-code";
  const REQUEST_CODE = "error-invalid-request-code";
  const RAW = [ENVELOPE, PARSE, PARSE_CODE, REQUEST_CODE];
  const bareWarnings = (warnings: string[]) => warnings.filter((w) => w.includes("with no JSON-RPC body"));

  it("a conformant -32700 / -32600 on HTTP 400 keeps its PASS, with no extra request", async () => {
    const { byId, hits, warnings } = await verdicts({}, { only: [PARSE_CODE, REQUEST_CODE] });
    expect(byId).toEqual({
      [PARSE_CODE]: "PASS: -32700 (Parse error) on HTTP 400",
      [REQUEST_CODE]: "PASS: -32600 (Invalid Request) on HTTP 400",
    });
    expect(count(hits, "discover")).toBe(2);
    expect(count(hits, "badJson")).toBe(1);
    expect(count(hits, "malformed")).toBe(1);
    expect(bareWarnings(warnings)).toEqual([]);
  }, 30_000);

  it("a rate limiter's 429, resent once and throttled again: not evaluable (before: two passes, no resend)", async () => {
    // Before: error-parse-code PASSED "HTTP 429 without a JSON-RPC body
    // (expected -32700 Parse error); passes with a warning", and
    // error-invalid-request-code likewise, next to error-invalid-json's
    // "not evaluable: a rate limiter answered ...".
    const { byId, hits, warnings } = await verdicts({ badJson: 429, malformed: 429 }, { only: RAW });
    const twice = "no JSON-RPC error body on HTTP 429, then after 0ms HTTP 429";
    expect(byId).toEqual({
      [ENVELOPE]: `FAIL: ${twice} for a malformed envelope; ${reason(RATE, "the malformed envelope")}`,
      [PARSE]: `FAIL: ${twice} for invalid JSON; ${reason(RATE, "the invalid JSON")}`,
      [PARSE_CODE]: `FAIL: ${twice} for invalid JSON; ${reason(RATE, "the invalid JSON")}`,
      [REQUEST_CODE]: `FAIL: ${twice} for a message with no method; ${reason(RATE, "the missing method")}`,
    });
    // Each probe sent and resent once.
    expect(count(hits, "badJson")).toBe(4);
    expect(count(hits, "malformed")).toBe(4);
    expect(bareWarnings(warnings)).toEqual([]);
    const once = await verdicts({ badJson: "429-once", malformed: "429-once" }, { only: [PARSE_CODE, REQUEST_CODE] });
    expect(once.byId).toEqual({
      [PARSE_CODE]: "PASS: -32700 (Parse error) on HTTP 400",
      [REQUEST_CODE]: "PASS: -32600 (Invalid Request) on HTTP 400",
    });
  }, 30_000);

  it("an auth gate's bodiless 401, server/discover let through: not evaluable (before: two passes)", async () => {
    const { byId, warnings } = await verdicts({ gate: "bare-401", exempt: ["discover"] }, { only: RAW });
    const none = "no JSON-RPC error body on HTTP 401";
    expect(byId).toEqual({
      [ENVELOPE]: `FAIL: ${none} for a malformed envelope; ${reason(AUTH, "the malformed envelope")}`,
      [PARSE]: `FAIL: ${none} for invalid JSON; ${reason(AUTH, "the invalid JSON")}`,
      [PARSE_CODE]: `FAIL: ${none} for invalid JSON; ${reason(AUTH, "the invalid JSON")}`,
      [REQUEST_CODE]: `FAIL: ${none} for a message with no method; ${reason(AUTH, "the missing method")}`,
    });
    expect(bareWarnings(warnings)).toEqual([]);
  }, 30_000);

  it("a WAF's HTML 403 that refuses the conformant twin too: not evaluable; one that refuses the defect alone: credited", async () => {
    // Before: both exact-code checks PASSED on the WAF's 403 while
    // error-invalid-json said the same 403 proved nothing.
    const waf = await verdicts({ gate: "html-403", exempt: ["discover"], discoverThrough: 2 }, { only: RAW });
    const none = "no JSON-RPC error body on HTTP 403";
    const refused = (about: string) => twinFailed("server/discover", "was refused (HTTP 403)", about);
    expect(waf.byId).toEqual({
      [ENVELOPE]: `FAIL: ${none} for a malformed envelope; ${refused("the malformed envelope")}`,
      [PARSE]: `FAIL: ${none} for invalid JSON; ${refused("the invalid JSON")}`,
      [PARSE_CODE]: `FAIL: ${none} for invalid JSON; ${refused("the invalid JSON")}`,
      [REQUEST_CODE]: `FAIL: ${none} for a message with no method; ${refused("the missing method")}`,
    });
    expectWithinBudget(waf.details, RAW);
    expect(bareWarnings(waf.warnings)).toEqual([]);
    // The twin served: the refusal is of the defect, credited with the warning as before.
    const defect = await verdicts({ badJson: "html-403", malformed: "html-403" }, { only: [PARSE_CODE, REQUEST_CODE] });
    expect(defect.byId).toEqual({
      [PARSE_CODE]: "PASS: HTTP 403 without a JSON-RPC body (expected -32700 Parse error); passes with a warning",
      [REQUEST_CODE]: "PASS: HTTP 403 without a JSON-RPC body (expected -32600 Invalid Request); passes with a warning",
    });
    expect(bareWarnings(defect.warnings)).toEqual([
      "HTTP 403 with no JSON-RPC body for invalid JSON; the spec expects a -32700 (Parse error) JSON-RPC error body.",
      "HTTP 403 with no JSON-RPC body for a message with no method; the spec expects a -32600 (Invalid Request) JSON-RPC error body.",
    ]);
  }, 30_000);
});

describe("modern gate reading: a 5xx", () => {
  it("without the check's own code: the server failing on the probe, not 'not evaluable' (before: three passes)", async () => {
    // Before the gate reading: PASS "JSON-RPC error -32603 on HTTP 503 (spec
    // requires 404), id echoed", FAIL "HTTP 503 for a malformed envelope;
    // ...", FAIL "HTTP 503 for invalid JSON; ...", PASS "JSON-RPC error
    // -32603 (Backend unavailable)" and PASS "Undeclared method(s) rejected:
    // ... -32603 (expected -32601)". Next to a served setup discover such a
    // 5xx is almost always the server crashing on the defect -- what these
    // checks look for -- so the reason says so instead of "not evaluable:
    // ... proves nothing about ..." (the verdicts are unchanged).
    const internal = await verdicts(
      { unknown: "rpc-503", malformed: "rpc-503", badJson: "rpc-503", missingName: "rpc-503", lists: "rpc-503" },
      { only: ERRORS },
    );
    const rpc = "JSON-RPC error -32603";
    expect(internal.byId).toEqual({
      [UNKNOWN]: `FAIL: ${rpc} (HTTP 503) for an unknown method; ${failedOn("-32601")}`,
      [ENVELOPE]: `FAIL: ${rpc} on HTTP 503 for a malformed envelope; ${failedOn("-32600")}`,
      [PARSE]: `FAIL: ${rpc} on HTTP 503 for invalid JSON; ${failedOn("-32700")}`,
      [PARAMS]: `FAIL: ${rpc} (HTTP 503) for a tools/call without a name; ${failedOn("-32602")}`,
      [GATED]: `FAIL: resources/list, prompts/list -> -32603 (HTTP 503); ${failedOn("-32601")}`,
    });
    for (const details of Object.values(internal.details)) expect(details).not.toContain("not evaluable");
    expect(checkWarnings(internal.warnings)).toEqual([]);
    const custom = await verdicts(
      { unknown: "custom-500", malformed: "bare-503", badJson: "bare-503" },
      { only: [UNKNOWN, ENVELOPE, PARSE] },
    );
    expect(custom.byId).toEqual({
      [UNKNOWN]: `FAIL: JSON-RPC error -32000 (HTTP 500) for an unknown method; ${failedOn("-32601")}`,
      // A bare 5xx failed before too; the details now say why.
      [ENVELOPE]: `FAIL: no JSON-RPC error body on HTTP 503 for a malformed envelope; ${failedOn("-32600")}`,
      [PARSE]: `FAIL: no JSON-RPC error body on HTTP 503 for invalid JSON; ${failedOn("-32700")}`,
    });
  }, 30_000);

  it("carrying the check's own code: credited, with a warning that names the status only (before: two failures)", async () => {
    // Before: FAIL "HTTP 500 for a malformed envelope; ..." and FAIL "HTTP 500
    // for invalid JSON; ...", and error-unknown-method warned "spec requires
    // 404" instead of naming the 5xx.
    const { byId, warnings } = await verdicts({
      unknown: "own-500",
      malformed: "own-500",
      badJson: "own-500",
      missingName: "own-500",
      lists: "own-500",
    });
    expect(byId).toEqual({
      [JSONRPC]: CONFORMANT[JSONRPC],
      [UNKNOWN]: "PASS: JSON-RPC error -32601 on HTTP 500 (spec requires 404), id echoed",
      [ENVELOPE]: "PASS: JSON-RPC error -32600 (correct: Invalid Request) on HTTP 500",
      [PARSE]: "PASS: JSON-RPC error -32700 (correct: Parse error) on HTTP 500",
      [PARAMS]: "PASS: JSON-RPC error -32602 (correct: Invalid params) (Invalid params: name is required)",
      [GATED]: CONFORMANT[GATED],
    });
    expect(checkWarnings(warnings)).toEqual([
      on5xx(UNKNOWN, "an unknown method", -32601, "HTTP 404 is required for an unknown method"),
      on5xx(ENVELOPE, "a malformed envelope", -32600),
      on5xx(PARSE, "invalid JSON", -32700),
      on5xx(PARAMS, "a tools/call without a name", -32602),
      on5xx(GATED, "resources/list (undeclared resources capability)", -32601),
      on5xx(GATED, "prompts/list (undeclared prompts capability)", -32601),
    ]);
  }, 30_000);

  it("the warning makes no claim about the verdict, so it cannot contradict a check that fails on another criterion", async () => {
    // An unknown method answered on HTTP 500 with the server's own -32601 but
    // id null: the check fails on the id. Before, the warning next to that
    // FAIL said the answer was "credited".
    const { byId, warnings } = await verdicts({ unknown: "own-500-no-id" }, { only: [UNKNOWN] });
    expect(byId[UNKNOWN]).toBe("FAIL: JSON-RPC error -32601 did not echo the request id (sent 1002, got null)");
    expect(checkWarnings(warnings)).toEqual([
      on5xx(UNKNOWN, "an unknown method", -32601, "HTTP 404 is required for an unknown method"),
    ]);
    for (const w of warnings) expect(w).not.toMatch(/credited/);
  }, 30_000);
});

describe("modern lifecycle-jsonrpc: whose envelope a server/discover answered without a result carries", () => {
  const ABOUT = "the server's JSON-RPC envelope";

  it("a 401, or a 403 carrying a Bearer challenge, on server/discover alone: the auth gate's (before: PASS)", async () => {
    const auth = await verdicts({ discover: "rpc-401" }, { only: [JSONRPC] });
    expect(auth.byId[JSONRPC]).toBe(
      `FAIL: server/discover answered JSON-RPC error -32001 (HTTP 401); ${reason(AUTH, ABOUT)}`,
    );
    const bearer = await verdicts({ discover: "bearer-403" }, { only: [JSONRPC] });
    expect(bearer.byId[JSONRPC]).toBe(
      `FAIL: server/discover answered JSON-RPC error -32001 (HTTP 403); ${reason(AUTH, ABOUT)}`,
    );
  }, 30_000);

  it("a 403 without a Bearer challenge refused the conformant request itself: not evaluable", async () => {
    const host = await verdicts({ discover: "host-403" }, { only: [JSONRPC] });
    expect(host.byId[JSONRPC]).toBe(
      `FAIL: server/discover answered JSON-RPC error -32000 (HTTP 403); ${reason(
        'its message ("Invalid Host: mcp.internal.example") names Host/Origin validation, which refuses a request whatever it carries',
        ABOUT,
      )}`,
    );
    const bare = await verdicts({ discover: "bare-403" }, { only: [JSONRPC] });
    expect(bare.byId[JSONRPC]).toBe(
      `FAIL: server/discover answered JSON-RPC error -32000 (HTTP 403); not evaluable: a 403 without a Bearer challenge refused the conformant request itself (Host/Origin validation or a gateway), so it proves nothing about ${ABOUT} (see security-auth-required)`,
    );
  }, 30_000);

  it("a 5xx: not evaluable unless it carries a server's own refusal of server/discover, credited with a warning", async () => {
    const internal = await verdicts({ discover: "rpc-503" }, { only: [JSONRPC] });
    // Still not evaluable here: the 5xx answered the conformant request
    // itself, so its envelope need not be the server's (the legacy suite's
    // wording for the same case). Shorter than before (252 characters).
    expect(internal.byId[JSONRPC]).toBe(
      `FAIL: server/discover answered JSON-RPC error -32603 (HTTP 503); ${reason(
        "a server error (or a gateway with no backend) answered",
        ABOUT,
      )}`,
    );
    expectWithinBudget(internal.details, [JSONRPC]);
    const own = await verdicts({ discover: "own-500" }, { only: [JSONRPC] });
    expect(own.byId[JSONRPC]).toBe("PASS: Valid JSON-RPC 2.0 response (id 1001 echoed, error)");
    expect(checkWarnings(own.warnings)).toEqual([on5xx(JSONRPC, "the conformant server/discover", -32601)]);
  }, 30_000);

  it("a 429: server/discover is resent once after Retry-After, and the second answer decides", async () => {
    // The preflight is served; the setup discover is throttled once.
    const once = await verdicts({ discoverThrough: 1, lateDiscover: "429-once" }, { only: [JSONRPC] });
    expect(once.byId[JSONRPC]).toBe(
      "PASS: Valid JSON-RPC 2.0 response (id 1002 echoed, result; resent once after HTTP 429)",
    );
    const always = await verdicts({ discover: 429 }, { only: [JSONRPC] });
    expect(always.byId[JSONRPC]).toBe(
      `FAIL: server/discover answered no JSON-RPC error body (HTTP 429, then after 0ms HTTP 429); ${reason(RATE, ABOUT)}`,
    );
    // A resend that gets no answer leaves no envelope to judge.
    const gone = await verdicts(
      { discoverThrough: 1, lateDiscover: [429, "hang"] },
      { only: [JSONRPC], timeout: 1000 },
    );
    expect(gone.byId[JSONRPC]).toMatch(
      /^FAIL: server unreachable: server\/discover answered HTTP 429, and its resend got no response \(\S/,
    );
  }, 30_000);
});

describe("modern gate reading: a caller's abort", () => {
  it("an abort while the conformant twin waits is rethrown at once, not after the request timeout", async () => {
    const controller = new AbortController();
    const abortReason = new Error("client went away");
    let discovers = 0;
    const stub = await startStub({
      gate: "bare-403",
      exempt: ["discover"],
      discoverThrough: 2,
      lateDiscover: "hang",
      onProbe: (p) => {
        if (p === "discover" && ++discovers === 3) setTimeout(() => controller.abort(abortReason), 50);
      },
    });
    try {
      const started = Date.now();
      await expect(
        runModern(stub.url, { timeout: 10_000, only: [UNKNOWN, ENVELOPE], signal: controller.signal }),
      ).rejects.toBe(abortReason);
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      await stub.stop();
    }
  }, 30_000);
});

describe("modern gate reading: a twin that never reached the server cannot credit a bare 403", () => {
  // A WAF that let the preflight and the setup server/discover through and
  // then answers every probe with a bare 403; what the twin (a later
  // server/discover) draws decides. Before: a twin whose status merely
  // differed from 403 credited the 403, so a rate-limited or backend-less
  // twin passed all five checks on the WAF's refusal.
  const notReached = (twin: string, about: string, pointer = true) =>
    twinFailed("server/discover", twin, about, pointer);
  const rpc = "JSON-RPC error -32000";
  const wafRun = (lateDiscover: Answer | Answer[], only = ERRORS, timeout?: number) =>
    verdicts(
      { gate: "bare-403", exempt: ["discover"], discoverThrough: 2, lateDiscover },
      { only, ...(timeout ? { timeout } : {}) },
    );

  it("a twin still throttled after its one resend: all five not evaluable (before: five passes)", async () => {
    // Before: PASS "JSON-RPC error -32000 on HTTP 403 (spec requires 404), id
    // echoed", PASS "JSON-RPC error -32000 on HTTP 403" twice, PASS
    // "JSON-RPC error -32000 (Forbidden)" and PASS "Undeclared method(s)
    // rejected: resources/list -> -32000 (expected -32601), ...". Within the
    // 220-character budget " for <what>" gives way to the reason's pointer
    // (the reason names what the probe varied already), and the pointer
    // gives way when even that is not enough.
    const { byId, details, hits } = await wafRun(429);
    const twin = "was not served (HTTP 429, then after 0ms HTTP 429)";
    expect(byId).toEqual({
      [UNKNOWN]: `FAIL: ${rpc} (HTTP 403); ${notReached(twin, "the unknown method")}`,
      [ENVELOPE]: `FAIL: ${rpc} on HTTP 403; ${notReached(twin, "the malformed envelope")}`,
      [PARSE]: `FAIL: ${rpc} on HTTP 403; ${notReached(twin, "the invalid JSON")}`,
      [PARAMS]: `FAIL: ${rpc} (HTTP 403); ${notReached(twin, "the missing tool name")}`,
      [GATED]: `FAIL: resources/list, prompts/list -> -32000 (HTTP 403); ${notReached(twin, GATED_GATE, false)}`,
    });
    expectWithinBudget(details, ERRORS);
    // Preflight + setup discover, then each check's twin sent and resent once.
    expect(count(hits, "discover")).toBe(2 + 2 * ERRORS.length);
  }, 30_000);

  it("a twin answered 5xx (a gateway with no backend) or 401 (an auth gate): not evaluable (before: passes)", async () => {
    const down = await wafRun("bare-503", [UNKNOWN, ENVELOPE]);
    expect(down.byId).toEqual({
      [UNKNOWN]: `FAIL: ${rpc} (HTTP 403) for an unknown method; ${notReached("was not served (HTTP 503)", "the unknown method")}`,
      [ENVELOPE]: `FAIL: ${rpc} on HTTP 403 for a malformed envelope; ${notReached("was not served (HTTP 503)", "the malformed envelope")}`,
    });
    const gated = await wafRun("rpc-401", [PARAMS]);
    expect(gated.byId[PARAMS]).toBe(
      `FAIL: ${rpc} (HTTP 403); ${notReached("was refused (HTTP 401, JSON-RPC error -32001)", "the missing tool name")}`,
    );
  }, 30_000);

  it("a twin that got no answer, or a long Host message: the details stay within 220 characters, ending on the reason", async () => {
    // Before: 271 characters for a twin whose connection was reset, 302 for
    // one throttled and then reset, and 322 to 365 for a long Host message
    // (unclipped reasons after an unclipped head).
    const reset = await wafRun("reset", ERRORS, 2000);
    expectWithinBudget(reset.details, ERRORS);
    for (const id of ERRORS) {
      expect(reset.details[id], id).toMatch(
        /^.+; not evaluable: a conformant server\/discover got no response \(connection (closed|failed): .+ too, so the 403 proves nothing about .+$/,
      );
    }
    const throttledThenReset = await wafRun([429, "reset"], [PARAMS, GATED], 2000);
    expectWithinBudget(throttledThenReset.details, [PARAMS, GATED]);
    expect(throttledThenReset.details[PARAMS]).toMatch(
      /^JSON-RPC error -32000 \(HTTP 403\); not evaluable: a conformant server\/discover answered HTTP 429, and its resend got no response .* too, so the 403 proves nothing about the missing tool name/,
    );
    const longHost = await verdicts(
      { gate: "longhost-403", exempt: ["discover"], discoverThrough: 2 },
      { only: [...ERRORS, "error-invalid-cursor"] },
    );
    expectWithinBudget(longHost.details, [...ERRORS, "error-invalid-cursor"]);
    for (const [id, text] of Object.entries(longHost.details)) {
      // The message is quoted as far as it fits; the conclusion is whole.
      expect(text, id).toMatch(
        /; not evaluable: its message \("Invalid Host header: very-long-internal-hostname\.[^"]*"\) names Host\/Origin validation, so it proves nothing about the [A-Za-z ]+$/,
      );
    }
    // error-capability-gated with nothing declared: all three list methods
    // probed, named together before one reason (before: 351 characters, each
    // method's answer repeated). What does not fit is cut from the head.
    const three = await verdicts({ capabilities: {}, lists: 429 }, { only: [GATED] });
    expectWithinBudget(three.details, [GATED]);
    expect(
      three.details[GATED].startsWith("tools/list, resources/list, prompts/list -> no JSON-RPC body (HTTP 429"),
    ).toBe(true);
    expect(three.details[GATED].endsWith(`...; ${reason(RATE, GATED_GATE)}`)).toBe(true);
  }, 30_000);

  it("a twin served when resent after one 429, or answered with a status the server chose, still credits the 403", async () => {
    const resent = await wafRun("429-once", [UNKNOWN]);
    expect(resent.byId[UNKNOWN]).toBe("PASS: JSON-RPC error -32000 on HTTP 403 (spec requires 404), id echoed");
    // Preflight + setup discover, the twin throttled, and its resend served.
    expect(count(resent.hits, "discover")).toBe(4);
    const own = await wafRun("rpc-400", [UNKNOWN, ENVELOPE]);
    expect(own.byId).toEqual({
      [UNKNOWN]: "PASS: JSON-RPC error -32000 on HTTP 403 (spec requires 404), id echoed",
      [ENVELOPE]: "PASS: JSON-RPC error -32000 on HTTP 403",
    });
  }, 30_000);
});

describe("modern transport-batch-reject and transport-content-type-reject: whose rejection it is", () => {
  const BATCH = "transport-batch-reject";
  const CT = "transport-content-type-reject";
  const TRANSPORT = [BATCH, CT];
  const transportWarnings = (warnings: string[]) => warnings.filter((w) => w.startsWith("transport-"));

  it("the server's own 400 on the batch and 415 on text/plain keep their PASS, and no twin is asked", async () => {
    const { byId, hits, warnings } = await verdicts({}, { only: TRANSPORT });
    expect(byId).toEqual({
      [BATCH]: "PASS: HTTP 400 (batch rejected)",
      [CT]: "PASS: HTTP 415 (text/plain rejected)",
    });
    expect(count(hits, "discover")).toBe(2);
    expect(transportWarnings(warnings)).toEqual([]);
  }, 30_000);

  it("the measured gateway's 401 with a -32001 body, server/discover let through or not: not evaluable (before: two passes, one required)", async () => {
    // Before: PASS "HTTP 401 (batch rejected)" and PASS "HTTP 401 (text/plain rejected)".
    const expected = {
      [BATCH]: `FAIL: HTTP 401, JSON-RPC error -32001 on the batch; ${reason(AUTH, "the batch")}`,
      [CT]: `FAIL: HTTP 401, JSON-RPC error -32001 on the text/plain POST; ${reason(AUTH, "the Content-Type")}`,
    };
    const through = await verdicts({ gate: "rpc-401", exempt: ["discover"] }, { only: TRANSPORT });
    expect(through.byId).toEqual(expected);
    const everything = await verdicts({ gate: "rpc-401" }, { only: TRANSPORT });
    expect(everything.byId).toEqual(expected);
  }, 30_000);

  it("a 429 is resent once: throttled again is not evaluable, served on the resend is judged as usual", async () => {
    // Before: PASS "HTTP 429 (batch rejected)" and PASS "HTTP 429 (text/plain rejected)".
    const twice = "HTTP 429, then after 0ms HTTP 429";
    const always = await verdicts({ batch: 429, textPlain: 429 }, { only: TRANSPORT });
    expect(always.byId).toEqual({
      [BATCH]: `FAIL: ${twice} on the batch; ${reason(RATE, "the batch")}`,
      [CT]: `FAIL: ${twice} on the text/plain POST; ${reason(RATE, "the Content-Type")}`,
    });
    const once = await verdicts({ batch: "429-once", textPlain: "429-once" }, { only: TRANSPORT });
    expect(once.byId).toEqual({
      [BATCH]: "PASS: HTTP 400 (batch rejected)",
      [CT]: "PASS: HTTP 415 (text/plain rejected)",
    });
    expect(count(once.hits, "batch")).toBe(2);
    expect(count(once.hits, "textPlain")).toBe(2);
  }, 30_000);

  it("a 5xx fails as the server failing on the probe unless the batch drew the server's own -32600, which is credited with a warning", async () => {
    // Before: PASS "HTTP 503, JSON-RPC error -32603 (batch rejected)"; the
    // text/plain 503 failed "(expected 4xx for text/plain)". A text/plain
    // POST has no code of its own, so its reason names none.
    const down = await verdicts({ batch: "rpc-503", textPlain: "bare-503" }, { only: TRANSPORT });
    expect(down.byId).toEqual({
      [BATCH]: `FAIL: HTTP 503, JSON-RPC error -32603 on the batch; ${failedOn("-32600")}`,
      [CT]: `FAIL: HTTP 503 on the text/plain POST; ${failedOn()}`,
    });
    const own = await verdicts({ batch: "own-500" }, { only: [BATCH] });
    expect(own.byId[BATCH]).toBe("PASS: HTTP 500, JSON-RPC error -32600 (batch rejected)");
    expect(transportWarnings(own.warnings)).toEqual([on5xx("transport-batch-reject", "a batch", -32600)]);
  }, 30_000);

  it("a bare 403: credited next to a served twin, not evaluable next to a twin that was refused too", async () => {
    const served = await verdicts({ gate: "bare-403", exempt: ["discover"] }, { only: TRANSPORT });
    expect(served.byId).toEqual({
      [BATCH]: "PASS: HTTP 403 (batch rejected)",
      [CT]: "PASS: HTTP 403 (text/plain rejected)",
    });
    // One twin per check.
    expect(count(served.hits, "discover")).toBe(4);
    const refused = await verdicts({ gate: "bare-403", exempt: ["discover"], discoverThrough: 2 }, { only: TRANSPORT });
    const twin = (about: string) =>
      twinFailed("server/discover", "was refused (HTTP 403, JSON-RPC error -32000)", about);
    expect(refused.byId).toEqual({
      [BATCH]: `FAIL: HTTP 403, JSON-RPC error -32000 on the batch; ${twin("the batch")}`,
      [CT]: `FAIL: HTTP 403, JSON-RPC error -32000 on the text/plain POST; ${twin("the Content-Type")}`,
    });
  }, 30_000);
});

describe("modern error-invalid-cursor and lifecycle-subscriptions-listen: whose rejection it is", () => {
  const CURSOR = "error-invalid-cursor";
  const LISTEN = "lifecycle-subscriptions-listen";
  const BOTH = [CURSOR, LISTEN];
  const CURSOR_ABOUT = "the invalid cursor";
  const LISTEN_ABOUT = "subscriptions/listen";
  const ownWarnings = (warnings: string[]) =>
    warnings.filter((w) => w.startsWith(`${CURSOR}:`) || w.startsWith(`${LISTEN}:`));

  it("the server's own -32602 on the cursor and -32601 on the listen keep their PASS", async () => {
    const { byId, hits, warnings } = await verdicts({}, { only: BOTH });
    expect(byId).toEqual({
      [CURSOR]:
        "PASS: tools/list rejected the cursor: -32602 (correct: Invalid params) (Invalid params: invalid cursor)",
      [LISTEN]: "PASS: nothing subscription-related advertised; subscriptions/listen rejected with -32601 (HTTP 404)",
    });
    expect(count(hits, "discover")).toBe(2);
    expect(ownWarnings(warnings)).toEqual([]);
  }, 30_000);

  it("the measured gateway (server/discover let through, everything else 401 with -32001): both not evaluable (before: two passes)", async () => {
    // Before: PASS "tools/list rejected the cursor: -32001 (Unauthorized)" and
    // PASS "nothing subscription-related advertised; subscriptions/listen
    // rejected with -32001 (HTTP 401)", with a warning about the code.
    const { byId, warnings } = await verdicts({ gate: "rpc-401", exempt: ["discover"] }, { only: BOTH });
    expect(byId).toEqual({
      [CURSOR]: `FAIL: JSON-RPC error -32001 (HTTP 401) for tools/list with an invalid cursor; ${reason(AUTH, CURSOR_ABOUT)}`,
      [LISTEN]: `FAIL: subscriptions/listen rejected with -32001 (HTTP 401); ${reason(AUTH, LISTEN_ABOUT)}`,
    });
    expect(ownWarnings(warnings)).toEqual([]);
  }, 30_000);

  it("a 429 is resent once: throttled again is not evaluable, answered on the resend is judged as usual", async () => {
    const twice = "HTTP 429, then after 0ms HTTP 429";
    const always = await verdicts({ cursor: 429, listen: 429 }, { only: BOTH });
    expect(always.byId).toEqual({
      [CURSOR]: `FAIL: no JSON-RPC error body (${twice}) for tools/list with an invalid cursor; ${reason(RATE, CURSOR_ABOUT)}`,
      [LISTEN]: `FAIL: subscriptions/listen rejected (${twice}); ${reason(RATE, LISTEN_ABOUT)}`,
    });
    const once = await verdicts({ cursor: "429-once", listen: "429-once" }, { only: BOTH });
    expect(once.byId).toEqual({
      [CURSOR]:
        "PASS: tools/list rejected the cursor: -32602 (correct: Invalid params) (Invalid params: invalid cursor)",
      [LISTEN]:
        "PASS: nothing subscription-related advertised; subscriptions/listen rejected with -32601 (HTTP 429, then after 0ms HTTP 404)",
    });
    expect(count(once.hits, "cursor")).toBe(2);
    expect(count(once.hits, "listen")).toBe(2);
  }, 30_000);

  it("a 5xx fails as the server failing on the probe unless it carries the check's own code, which is credited with a warning", async () => {
    // Before: FAIL "tools/list with an invalid cursor answered HTTP 503" and
    // PASS "...; subscriptions/listen rejected with -32603 (HTTP 503)".
    const down = await verdicts({ cursor: "rpc-503", listen: "rpc-503" }, { only: BOTH });
    expect(down.byId).toEqual({
      [CURSOR]: `FAIL: JSON-RPC error -32603 (HTTP 503) for tools/list with an invalid cursor; ${failedOn("-32602")}`,
      [LISTEN]: `FAIL: subscriptions/listen rejected with -32603 (HTTP 503); ${failedOn("-32601")}`,
    });
    const own = await verdicts({ cursor: "own-500", listen: "own-500" }, { only: BOTH });
    expect(own.byId).toEqual({
      [CURSOR]:
        "PASS: tools/list rejected the cursor: -32602 (correct: Invalid params) (Invalid params: invalid cursor)",
      [LISTEN]: "PASS: nothing subscription-related advertised; subscriptions/listen rejected with -32601 (HTTP 500)",
    });
    expect(ownWarnings(own.warnings)).toEqual([
      on5xx(LISTEN, "subscriptions/listen", -32601),
      on5xx(CURSOR, "tools/list with an invalid cursor", -32602),
    ]);
  }, 30_000);

  it("a bare 403 on the cursor is read against the same list method without it, not server/discover", async () => {
    // The server refusing the cursor itself: the conformant tools/list next
    // to it is served, so the 403 is the server's (one list twin, no
    // discover twin).
    const own = await verdicts({ cursor: "bare-403" }, { only: [CURSOR] });
    expect(own.byId[CURSOR]).toBe("PASS: tools/list rejected the cursor: -32000 (Forbidden)");
    expect(count(own.hits, "list")).toBe(1);
    expect(count(own.hits, "discover")).toBe(2);
    // A gateway or ACL that lets server/discover through but refuses
    // tools/list itself with a bare 403. Before: tools-list FAILED "tools/list
    // returned JSON-RPC error -32000 (Forbidden)" while error-invalid-cursor
    // PASSED "tools/list rejected the cursor: -32000 (Forbidden)" in the same
    // report, its server/discover twin having been served.
    const acl = await verdicts({ lists: "bare-403", cursor: "bare-403" }, { only: ["tools-list", CURSOR] });
    expect(acl.byId).toEqual({
      "tools-list": "FAIL: tools/list returned JSON-RPC error -32000 (Forbidden)",
      [CURSOR]: `FAIL: JSON-RPC error -32000 (HTTP 403); ${twinFailed("tools/list", "was refused (HTTP 403, JSON-RPC error -32000)", CURSOR_ABOUT)}`,
    });
    expectWithinBudget(acl.details, [CURSOR]);
  }, 30_000);

  it("a bare 403 on everything but server/discover: the listen is credited next to its served twin, the cursor is not", async () => {
    // Before: both PASS -- the cursor's server/discover twin credited the
    // gateway's refusal of tools/list.
    const served = await verdicts({ gate: "bare-403", exempt: ["discover"] }, { only: BOTH });
    expect(served.byId).toEqual({
      [CURSOR]: `FAIL: JSON-RPC error -32000 (HTTP 403); ${twinFailed("tools/list", "was refused (HTTP 403, JSON-RPC error -32000)", CURSOR_ABOUT)}`,
      [LISTEN]: "PASS: nothing subscription-related advertised; subscriptions/listen rejected with -32000 (HTTP 403)",
    });
    const refused = await verdicts({ gate: "bare-403", exempt: ["discover"], discoverThrough: 2 }, { only: BOTH });
    expect(refused.byId).toEqual({
      [CURSOR]: `FAIL: JSON-RPC error -32000 (HTTP 403); ${twinFailed("tools/list", "was refused (HTTP 403, JSON-RPC error -32000)", CURSOR_ABOUT)}`,
      [LISTEN]: `FAIL: subscriptions/listen rejected with -32000 (HTTP 403); ${twinFailed("server/discover", "was refused (HTTP 403, JSON-RPC error -32000)", LISTEN_ABOUT)}`,
    });
  }, 30_000);
});
