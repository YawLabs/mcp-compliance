import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runComplianceSuite } from "../runner.js";

/**
 * Five 2025-11-25 checks that used to credit whatever JSON-RPC error body
 * came back as the server's own answer: error-invalid-jsonrpc (a malformed
 * message), error-invalid-json (a body that is not JSON),
 * error-missing-params (a tools/call without a name), error-capability-gated
 * (a method of a capability the server did not declare), and
 * lifecycle-jsonrpc (the envelope of the initialize answer). A gateway
 * answering 401 with a -32001 "Unauthorized" body to every request earned
 * all five passes. They now read an answer the way
 * transport-content-type-reject, transport-batch-reject,
 * lifecycle-version-negotiate and error-unknown-method were taught to last
 * release: a 401, a 403 carrying a Bearer challenge, a Host/Origin 403 the
 * conformant twin cannot credit, a repeated 429, or a 5xx without the
 * check's own JSON-RPC code is not the server's answer, and fails as not
 * evaluable.
 */

type Answer =
  | 400
  | "bare-400"
  | 401
  | "bearer-403"
  | "host-403"
  | "bare-403"
  | 429
  | "429-once"
  | 503
  | "rpc-503"
  | "own-500"
  | "custom-500"
  | "host-worded-403"
  | "hang";

type Probe = "init" | "ping" | "malformed" | "badJson" | "missingName" | "list" | "other";

interface StubOptions {
  /**
   * A gate in front of the server: answers every request that does not
   * carry `Bearer <token>` (every request, when no token is set) and whose
   * JSON-RPC method is not in `exempt`.
   */
  gate?: Answer;
  token?: string;
  exempt?: string[];
  /** The handshake: served by default, declaring `capabilities`. */
  init?: Answer;
  /** What the handshake declares: nothing by default, so all three list methods are undeclared. */
  capabilities?: Record<string, unknown>;
  /** A JSON body that is no JSON-RPC message: 400 with -32600 by default. */
  malformed?: Answer;
  /** A body that is not JSON: 400 with -32700 by default. */
  badJson?: Answer;
  /** tools/call without a name: -32602 on 200 by default; "isError" answers a tool result flagged isError. */
  missingName?: Answer | "isError";
  /** tools/list, resources/list, prompts/list: -32601 on 200 by default; "serve" answers a result. */
  lists?: Answer | "serve";
  /** A ping: served by default. */
  ping?: Answer;
  /** Called with each probe as it arrives, before it is answered. */
  onProbe?: (probe: Probe) => void;
}

/**
 * A stateless 2025-11-25 HTTP server whose answer to each of the five
 * checks' requests (and to a ping, their conformant twin) is a knob, behind
 * an optional gate. Records which probe every POST was.
 */
async function startStub(opts: StubOptions): Promise<{ url: string; hits: Probe[]; stop(): Promise<void> }> {
  const hits: Probe[] = [];
  const throttledOnce = new Set<Probe>();
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
        params?: { name?: unknown };
      };
      const probe: Probe = !json
        ? "badJson"
        : one.method === undefined
          ? "malformed"
          : one.method === "initialize"
            ? "init"
            : one.method === "ping"
              ? "ping"
              : one.method === "tools/call" && one.params?.name === undefined
                ? "missingName"
                : ["tools/list", "resources/list", "prompts/list"].includes(one.method)
                  ? "list"
                  : "other";
      hits.push(probe);
      opts.onProbe?.(probe);
      const send = (status: number, body: string, headers: Record<string, string>) => {
        res.writeHead(status, headers);
        res.end(body);
      };
      const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
        send(status, JSON.stringify(body), { "content-type": "application/json", ...headers });
      const rpcError = (status: number, code: number, message: string, headers?: Record<string, string>) =>
        reply(status, { jsonrpc: "2.0", id: one.id ?? null, error: { code, message } }, headers);
      const result = (r: unknown) => reply(200, { jsonrpc: "2.0", id: one.id, result: r });
      /** Answer with `answer`; false when it is a "429-once" already spent (answer as the server would). */
      const answerWith = (answer: Answer): boolean => {
        switch (answer) {
          case 400:
            rpcError(400, -32600, "Bad Request");
            return true;
          case "bare-400":
            send(400, "Bad Request", { "content-type": "text/plain" });
            return true;
          case 401:
            rpcError(401, -32001, "Unauthorized", { "www-authenticate": 'Bearer realm="mcp"' });
            return true;
          case "bearer-403":
            rpcError(403, -32001, "Forbidden", { "www-authenticate": 'Bearer error="insufficient_scope"' });
            return true;
          case "host-403":
            rpcError(403, -32000, "Invalid Host: mcp.internal.example");
            return true;
          case "bare-403":
            rpcError(403, -32000, "Forbidden");
            return true;
          case "429-once":
            if (throttledOnce.has(probe)) return false;
            throttledOnce.add(probe);
            send(429, "Too Many Requests", { "content-type": "text/plain", "retry-after": "0" });
            return true;
          case 429:
            send(429, "Too Many Requests", { "content-type": "text/plain", "retry-after": "0" });
            return true;
          case 503:
            send(503, "Service Unavailable", { "content-type": "text/plain" });
            return true;
          case "rpc-503":
            rpcError(503, -32603, "Backend unavailable");
            return true;
          case "own-500":
            // The server's own JSON-RPC rejection of the probe's defect, on
            // an HTTP 500 (a framework that maps every JSON-RPC error to 500).
            if (probe === "malformed") rpcError(500, -32600, "Invalid Request: not a JSON-RPC message");
            else if (probe === "badJson") rpcError(500, -32700, "Parse error");
            else if (probe === "missingName") rpcError(500, -32602, "Invalid params: name is required");
            else if (probe === "list") rpcError(500, -32601, "Method not found");
            else rpcError(500, -32602, "Unsupported protocol version");
            return true;
          case "custom-500":
            rpcError(500, -32000, "Request rejected");
            return true;
          case "host-worded-403":
            // A refusal of the defect whose message happens to name the host.
            if (probe === "malformed") rpcError(403, -32600, "Malformed messages are not accepted by this host");
            else if (probe === "badJson") rpcError(403, -32700, "Invalid JSON is not accepted by this host");
            else if (probe === "missingName")
              rpcError(403, -32602, "A tool call without a name is refused on this host");
            else rpcError(403, -32601, "Method not available on this host");
            return true;
          case "hang":
            return true;
        }
      };
      const authed = opts.token !== undefined && req.headers.authorization === `Bearer ${opts.token}`;
      if (opts.gate !== undefined && !authed && !(opts.exempt ?? []).includes(one.method ?? "")) {
        if (answerWith(opts.gate)) return;
      }
      // Each probe falls back to the conformant server's answer, a spent
      // "429-once" included.
      switch (probe) {
        case "init":
          if (opts.init !== undefined && answerWith(opts.init)) return;
          return result({
            protocolVersion: "2025-11-25",
            capabilities: opts.capabilities ?? {},
            serverInfo: { name: "error-attribution-stub", version: "1" },
          });
        case "ping":
          if (opts.ping !== undefined && answerWith(opts.ping)) return;
          return result({});
        case "malformed":
          if (opts.malformed !== undefined && answerWith(opts.malformed)) return;
          return rpcError(400, -32600, "Invalid Request");
        case "badJson":
          if (opts.badJson !== undefined && answerWith(opts.badJson)) return;
          return rpcError(400, -32700, "Parse error");
        case "missingName": {
          const missing = opts.missingName;
          if (missing === "isError")
            return result({ content: [{ type: "text", text: "name is required" }], isError: true });
          if (missing !== undefined && answerWith(missing)) return;
          return rpcError(200, -32602, "Invalid params: name is required");
        }
        case "list": {
          const lists = opts.lists;
          if (lists === "serve") return result({ tools: [], resources: [], prompts: [] });
          if (lists !== undefined && answerWith(lists)) return;
          return rpcError(200, -32601, "Method not found");
        }
      }
      if (one.id === undefined) return send(202, "", {});
      return rpcError(200, -32601, "Method not found");
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
const ENVELOPE = "error-invalid-jsonrpc";
const PARSE = "error-invalid-json";
const PARAMS = "error-missing-params";
const GATED = "error-capability-gated";
const ALL = [JSONRPC, ENVELOPE, PARSE, PARAMS, GATED];
const ERRORS = [ENVELOPE, PARSE, PARAMS, GATED];

async function verdicts(
  stubOpts: StubOptions,
  runOpts: { only?: string[]; headers?: Record<string, string>; timeout?: number } = {},
): Promise<{ byId: Record<string, string>; hits: Probe[]; warnings: string[] }> {
  const stub = await startStub(stubOpts);
  try {
    const report = await runComplianceSuite(stub.url, {
      timeout: runOpts.timeout ?? 3000,
      specVersion: "2025-11-25",
      only: runOpts.only ?? ALL,
      ...(runOpts.headers ? { headers: runOpts.headers } : {}),
    });
    return {
      byId: Object.fromEntries(
        report.tests.map((t) => [t.id, `${t.passed ? "PASS" : "FAIL"}${t.skipped ? " (skipped)" : ""}: ${t.details}`]),
      ),
      hits: [...stub.hits],
      warnings: report.warnings,
    };
  } finally {
    await stub.stop();
  }
}

const pings = (hits: Probe[]) => hits.filter((h) => h === "ping").length;

/** What a conformant server's own answers read as. */
const CONFORMANT = {
  [JSONRPC]: "PASS: Valid JSON-RPC 2.0 response",
  [ENVELOPE]: "PASS: Error code: -32600 (correct: Invalid Request) — Invalid Request",
  [PARSE]: "PASS: Error code: -32700 — Parse error",
  [PARAMS]: "PASS: Error code: -32602 (correct: Invalid params) — Invalid params: name is required",
  [GATED]: "PASS: Tested 3 undeclared method(s): tools/list, resources/list, prompts/list — all returned errors",
};

describe("legacy error checks and lifecycle-jsonrpc: a server that answers each request itself keeps its PASS", () => {
  it("its own JSON-RPC errors, and no twin is asked", async () => {
    const { byId, hits } = await verdicts({});
    expect(byId).toEqual(CONFORMANT);
    expect(pings(hits)).toBe(0);
  }, 30_000);

  it("a bare 4xx, and a tool result flagged isError, pass as before; a served undeclared method fails as before", async () => {
    const { byId } = await verdicts({
      malformed: "bare-400",
      badJson: "bare-400",
      missingName: "isError",
      lists: "serve",
    });
    expect(byId).toEqual({
      [JSONRPC]: CONFORMANT[JSONRPC],
      [ENVELOPE]: "PASS: HTTP 400 (acceptable)",
      [PARSE]: "PASS: HTTP 400 (acceptable)",
      [PARAMS]: "PASS: Tool execution error (valid)",
      [GATED]:
        "FAIL: tools/list returned success despite missing tools capability; resources/list returned success despite missing resources capability; prompts/list returned success despite missing prompts capability",
    });
  }, 30_000);

  it("a server that declares every capability has no undeclared method to probe: still a skip", async () => {
    const { byId } = await verdicts({ capabilities: { tools: {}, resources: {}, prompts: {} } }, { only: [GATED] });
    expect(byId[GATED]).toBe(
      "PASS (skipped): Server declares all capabilities (tools, resources, prompts) — no undeclared methods to test",
    );
  }, 30_000);
});

describe("legacy error checks and lifecycle-jsonrpc: a gate that answers every request is not the server", () => {
  const handshake = (status: string, what: string) =>
    `not evaluable: the initialize handshake was not served either (${status}), so this rejection proves nothing about ${what} (see lifecycle-init)`;
  const lists = (answer: string) => `tools/list -> ${answer}, resources/list -> ${answer}, prompts/list -> ${answer}`;
  const neverSaw = (status: string) =>
    `not evaluable: the initialize handshake was not served (${status}), so the suite never saw which capabilities the server declares, and these answers prove nothing about undeclared methods (see lifecycle-init)`;

  it("a 401 on every request (no --auth): all five fail as not evaluable (before: five passes)", async () => {
    // Before: PASS "Valid JSON-RPC 2.0 response" (the gateway's envelope),
    // PASS "Error code: -32001 — Unauthorized" three times, and PASS "Tested
    // 3 undeclared method(s) ... all returned errors".
    const { byId } = await verdicts({ gate: 401 });
    const rpc401 = "HTTP 401, JSON-RPC error -32001";
    expect(byId).toEqual({
      [JSONRPC]: `FAIL: ${rpc401} on the initialize handshake -- not evaluable: an auth gate answered before the server read the request (pass --auth)`,
      [ENVELOPE]: `FAIL: ${rpc401} on the malformed JSON-RPC message -- ${handshake(rpc401, "the malformed JSON-RPC message")}`,
      [PARSE]: `FAIL: ${rpc401} on the invalid JSON body -- ${handshake(rpc401, "the invalid JSON body")}`,
      [PARAMS]: `FAIL: ${rpc401} on tools/call without a name -- ${handshake(rpc401, "the missing tool name")}`,
      [GATED]: `FAIL: ${lists(rpc401)} -- ${neverSaw(rpc401)}`,
    });
  }, 30_000);

  it("--auth with a credential the gate refuses: the handshake's 401 names the credential", async () => {
    const { byId } = await verdicts(
      { gate: 401, token: "right" },
      { only: [JSONRPC], headers: { Authorization: "Bearer wrong" } },
    );
    expect(byId[JSONRPC]).toBe(
      "FAIL: HTTP 401, JSON-RPC error -32001 on the initialize handshake -- not evaluable: an auth gate answered before the server read the request (credential rejected -- check --auth)",
    );
  }, 30_000);

  it("the same gate with the credential it accepts: the server behind it is measured as usual", async () => {
    const { byId } = await verdicts({ gate: 401, token: "right" }, { headers: { Authorization: "Bearer right" } });
    expect(byId).toEqual(CONFORMANT);
  }, 30_000);

  it("a Host guard's 403 on every request: not evaluable, lifecycle-jsonrpc quoting the guard (before: five passes)", async () => {
    const { byId, hits } = await verdicts({ gate: "host-403" });
    const host = "HTTP 403, JSON-RPC error -32000";
    expect(byId).toEqual({
      [JSONRPC]: `FAIL: ${host} on the initialize handshake ("Invalid Host: mcp.internal.example") -- not evaluable: the message names Host/Origin validation, which refuses a request whatever it carries`,
      [ENVELOPE]: `FAIL: ${host} on the malformed JSON-RPC message -- ${handshake(host, "the malformed JSON-RPC message")}`,
      [PARSE]: `FAIL: ${host} on the invalid JSON body -- ${handshake(host, "the invalid JSON body")}`,
      [PARAMS]: `FAIL: ${host} on tools/call without a name -- ${handshake(host, "the missing tool name")}`,
      [GATED]: `FAIL: ${lists(host)} -- ${neverSaw(host)}`,
    });
    // lifecycle-jsonrpc asked its twin, the same ping sent on its own, once.
    expect(pings(hits)).toBe(1);
  }, 30_000);

  it("a bare 403 on every request: the ping drew it too, so it is not attributable to the initialize", async () => {
    const { byId } = await verdicts({ gate: "bare-403" }, { only: [JSONRPC] });
    expect(byId[JSONRPC]).toBe(
      "FAIL: HTTP 403, JSON-RPC error -32000 on the initialize handshake -- not evaluable: the same ping sent on its own as application/json was refused (HTTP 403, JSON-RPC error -32000) too, so the 403 is not attributable to the initialize request (see security-auth-required)",
    );
  }, 30_000);

  it("a rate limiter's 429 on every request: resent once where a check can resend, then not evaluable", async () => {
    const { byId, hits } = await verdicts({ gate: 429 });
    expect(byId).toEqual({
      [JSONRPC]:
        "FAIL: HTTP 429 on the initialize handshake -- not evaluable: a rate limiter answered before the server read the request, so the initialize request was never looked at",
      [ENVELOPE]: `FAIL: HTTP 429, then after 0ms HTTP 429 on the malformed JSON-RPC message -- ${handshake("HTTP 429", "the malformed JSON-RPC message")}`,
      [PARSE]: `FAIL: HTTP 429, then after 0ms HTTP 429 on the invalid JSON body -- ${handshake("HTTP 429", "the invalid JSON body")}`,
      [PARAMS]: `FAIL: HTTP 429, then after 0ms HTTP 429 on tools/call without a name -- ${handshake("HTTP 429", "the missing tool name")}`,
      [GATED]: `FAIL: ${lists("HTTP 429")} -- ${neverSaw("HTTP 429")}`,
    });
    for (const probe of ["malformed", "badJson", "missingName"] as const) {
      expect(
        hits.filter((h) => h === probe),
        probe,
      ).toHaveLength(2);
    }
  }, 30_000);

  it("a gateway with no backend (a -32603 on 503 to every request): not evaluable", async () => {
    const { byId } = await verdicts({ gate: "rpc-503" }, { only: [JSONRPC] });
    expect(byId[JSONRPC]).toBe(
      "FAIL: HTTP 503, JSON-RPC error -32603 on the initialize handshake -- not evaluable: a server error (or a gateway with no backend) answered, so the envelope need not be the server's",
    );
  }, 30_000);
});

describe("legacy error checks: the answer to the probe alone, next to a served handshake", () => {
  const AUTH_GATE = "not evaluable: an auth gate answered before the server read the request (pass --auth)";

  it("a gateway that lets initialize through and answers everything else 401: the four error checks no longer credit it", async () => {
    // Before: PASS "Error code: -32001 — Unauthorized" three times and
    // "Tested 3 undeclared method(s) ... all returned errors".
    const { byId } = await verdicts({ gate: 401, exempt: ["initialize"] });
    const rpc401 = "HTTP 401, JSON-RPC error -32001";
    expect(byId).toEqual({
      [JSONRPC]: CONFORMANT[JSONRPC],
      [ENVELOPE]: `FAIL: ${rpc401} on the malformed JSON-RPC message -- ${AUTH_GATE}`,
      [PARSE]: `FAIL: ${rpc401} on the invalid JSON body -- ${AUTH_GATE}`,
      [PARAMS]: `FAIL: ${rpc401} on tools/call without a name -- ${AUTH_GATE}`,
      [GATED]: `FAIL: ${rpc401} on tools/list -- ${AUTH_GATE}; ${rpc401} on resources/list -- ${AUTH_GATE}; ${rpc401} on prompts/list -- ${AUTH_GATE}`,
    });
  }, 30_000);

  it("a 403 carrying a Bearer challenge on the probes alone is a gate too", async () => {
    const { byId } = await verdicts(
      { malformed: "bearer-403", missingName: "bearer-403" },
      { only: [ENVELOPE, PARAMS] },
    );
    expect(byId).toEqual({
      [ENVELOPE]: `FAIL: HTTP 403, JSON-RPC error -32001 on the malformed JSON-RPC message -- ${AUTH_GATE}`,
      [PARAMS]: `FAIL: HTTP 403, JSON-RPC error -32001 on tools/call without a name -- ${AUTH_GATE}`,
    });
  }, 30_000);

  it("a bare 403 on everything but initialize: the ping twin drew it too, asked once per check", async () => {
    const { byId, hits } = await verdicts({ gate: "bare-403", exempt: ["initialize"] }, { only: ERRORS });
    const refused = (what: string) =>
      `not evaluable: the same request for ping was refused (HTTP 403, JSON-RPC error -32000) too, so the 403 is not attributable to ${what} (see security-auth-required)`;
    const raw = (what: string) =>
      `not evaluable: a well-formed ping sent with the same headers was refused (HTTP 403, JSON-RPC error -32000) too, so the 403 is not attributable to ${what} (see security-auth-required)`;
    const bare = "HTTP 403, JSON-RPC error -32000";
    expect(byId).toEqual({
      [ENVELOPE]: `FAIL: ${bare} on the malformed JSON-RPC message -- ${raw("the malformed JSON-RPC message")}`,
      [PARSE]: `FAIL: ${bare} on the invalid JSON body -- ${raw("the invalid JSON body")}`,
      [PARAMS]: `FAIL: ${bare} on tools/call without a name -- ${refused("the missing tool name")}`,
      [GATED]: [
        `${bare} on tools/list -- ${refused("a method of the undeclared tools capability")}`,
        `${bare} on resources/list -- ${refused("a method of the undeclared resources capability")}`,
        `${bare} on prompts/list -- ${refused("a method of the undeclared prompts capability")}`,
      ]
        .join("; ")
        .replace(/^/, "FAIL: "),
    });
    expect(pings(hits)).toBe(4);
  }, 30_000);

  it("a 429 on each probe once: resent after Retry-After, and the second answer decides", async () => {
    const { byId, hits } = await verdicts({
      malformed: "429-once",
      badJson: "429-once",
      missingName: "429-once",
      lists: "429-once",
    });
    expect(byId).toEqual(CONFORMANT);
    expect(hits.filter((h) => h === "malformed")).toHaveLength(2);
    expect(hits.filter((h) => h === "badJson")).toHaveLength(2);
    expect(hits.filter((h) => h === "missingName")).toHaveLength(2);
    // Each of the three list methods once throttled, once answered: the
    // stub's "429-once" is per probe kind, so only the first list method
    // is throttled.
    expect(hits.filter((h) => h === "list")).toHaveLength(4);
  }, 30_000);

  it("a 429 on each probe, resent once and throttled again: not evaluable (before: four passes)", async () => {
    const { byId } = await verdicts({ malformed: 429, badJson: 429, missingName: 429, lists: 429 }, { only: ERRORS });
    const limiter = (what: string) =>
      `not evaluable: a rate limiter answered before the server read the request, so ${what} was never looked at`;
    const twice = "HTTP 429, then after 0ms HTTP 429";
    expect(byId).toEqual({
      [ENVELOPE]: `FAIL: ${twice} on the malformed JSON-RPC message -- ${limiter("the malformed JSON-RPC message")}`,
      [PARSE]: `FAIL: ${twice} on the invalid JSON body -- ${limiter("the invalid JSON body")}`,
      [PARAMS]: `FAIL: ${twice} on tools/call without a name -- ${limiter("the missing tool name")}`,
      [GATED]: `FAIL: ${["tools", "resources", "prompts"]
        .map((c) => `${twice} on ${c}/list -- ${limiter(`a method of the undeclared ${c} capability`)}`)
        .join("; ")}`,
    });
  }, 30_000);

  it("a 5xx without the check's own code fails: -32603 or a server-defined code (before: four passes)", async () => {
    const failed = (what: string) =>
      `the server failed on the request rather than refusing it (a broken server, or a gateway with no backend), which is no rejection of ${what}`;
    const internal = await verdicts(
      { malformed: "rpc-503", badJson: "rpc-503", missingName: "rpc-503", lists: "rpc-503" },
      { only: ERRORS },
    );
    const rpc503 = "HTTP 503, JSON-RPC error -32603";
    expect(internal.byId).toEqual({
      [ENVELOPE]: `FAIL: ${rpc503} on the malformed JSON-RPC message -- ${failed("the malformed JSON-RPC message")}`,
      [PARSE]: `FAIL: ${rpc503} on the invalid JSON body -- ${failed("the invalid JSON body")}`,
      [PARAMS]: `FAIL: ${rpc503} on tools/call without a name -- ${failed("the missing tool name")}`,
      [GATED]: `FAIL: ${["tools", "resources", "prompts"]
        .map((c) => `${rpc503} on ${c}/list -- ${failed(`a method of the undeclared ${c} capability`)}`)
        .join("; ")}`,
    });
    const custom = await verdicts({ malformed: "custom-500", missingName: "custom-500" }, { only: [ENVELOPE, PARAMS] });
    expect(custom.byId).toEqual({
      [ENVELOPE]: `FAIL: HTTP 500, JSON-RPC error -32000 on the malformed JSON-RPC message -- ${failed("the malformed JSON-RPC message")}`,
      [PARAMS]: `FAIL: HTTP 500, JSON-RPC error -32000 on tools/call without a name -- ${failed("the missing tool name")}`,
    });
    // A bare 5xx failed before too; the details now say why.
    const bare = await verdicts({ malformed: 503 }, { only: [ENVELOPE] });
    expect(bare.byId[ENVELOPE]).toBe(
      `FAIL: HTTP 503 on the malformed JSON-RPC message -- ${failed("the malformed JSON-RPC message")}`,
    );
  }, 30_000);

  it("a 5xx carrying the check's own code keeps its PASS, with a warning about the status", async () => {
    const { byId, warnings } = await verdicts({
      malformed: "own-500",
      badJson: "own-500",
      missingName: "own-500",
      lists: "own-500",
    });
    expect(byId).toEqual({
      [JSONRPC]: CONFORMANT[JSONRPC],
      [ENVELOPE]: "PASS: Error code: -32600 (correct: Invalid Request) — Invalid Request: not a JSON-RPC message",
      [PARSE]: "PASS: Error code: -32700 — Parse error",
      [PARAMS]: "PASS: Error code: -32602 (correct: Invalid params) — Invalid params: name is required",
      [GATED]: CONFORMANT[GATED],
    });
    const on5xx = (check: string, code: number, what: string) =>
      `${check}: the server answered ${what} with its own JSON-RPC error ${code} on HTTP 500; a rejected request is a client error, so a 4xx status is expected (a 5xx tells clients and gateways the server failed).`;
    expect(warnings.filter((w) => /^error-/.test(w))).toEqual([
      on5xx(ENVELOPE, -32600, "the malformed JSON-RPC message"),
      on5xx(PARSE, -32700, "the invalid JSON body"),
      on5xx(PARAMS, -32602, "the missing tool name"),
      on5xx(GATED, -32601, "a method of the undeclared tools capability"),
      on5xx(GATED, -32601, "a method of the undeclared resources capability"),
      on5xx(GATED, -32601, "a method of the undeclared prompts capability"),
    ]);
  }, 30_000);

  it("the status warning makes no claim about the verdict, so it reads right next to a check that fails on something else", async () => {
    // tools/list gets the server's own -32601 on HTTP 500 (a gate-shaped
    // knob, exempting everything else), resources/list and prompts/list are
    // served. The warning is pushed when tools/list is read, before the
    // check sees the served methods. Before: FAIL with a warning that the
    // same check's answer was "credited".
    const { byId, warnings } = await verdicts(
      {
        gate: "own-500",
        exempt: ["initialize", "notifications/initialized", "ping", "resources/list", "prompts/list"],
        lists: "serve",
      },
      { only: [GATED] },
    );
    expect(byId[GATED]).toBe(
      "FAIL: resources/list returned success despite missing resources capability; prompts/list returned success despite missing prompts capability",
    );
    expect(warnings.filter((w) => w.startsWith(GATED))).toEqual([
      "error-capability-gated: the server answered a method of the undeclared tools capability with its own JSON-RPC error -32601 on HTTP 500; a rejected request is a client error, so a 4xx status is expected (a 5xx tells clients and gateways the server failed).",
    ]);
    for (const w of warnings) expect(w).not.toMatch(/credited/);
  }, 30_000);

  it("a 403 on the probe alone, next to a served ping, is credited as the rejection it is, whatever its message names", async () => {
    const bare = await verdicts(
      { malformed: "bare-403", badJson: "bare-403", missingName: "bare-403", lists: "bare-403" },
      { only: ERRORS },
    );
    expect(bare.byId).toEqual({
      [ENVELOPE]: "PASS: Error code: -32000 — Forbidden",
      [PARSE]: "PASS: Error code: -32000 — Forbidden",
      [PARAMS]: "PASS: Error code: -32000 — Forbidden",
      [GATED]: CONFORMANT[GATED],
    });
    // One ping per check; error-capability-gated asks once for its three methods.
    expect(pings(bare.hits)).toBe(4);
    const worded = await verdicts(
      {
        malformed: "host-worded-403",
        badJson: "host-worded-403",
        missingName: "host-worded-403",
        lists: "host-worded-403",
      },
      { only: ERRORS },
    );
    expect(worded.byId).toEqual({
      [ENVELOPE]:
        "PASS: Error code: -32600 (correct: Invalid Request) — Malformed messages are not accepted by this host",
      [PARSE]: "PASS: Error code: -32700 — Invalid JSON is not accepted by this host",
      [PARAMS]:
        "PASS: Error code: -32602 (correct: Invalid params) — A tool call without a name is refused on this host",
      [GATED]: CONFORMANT[GATED],
    });
  }, 30_000);

  it("an abort while a raw-body probe waits is rethrown at once, not after the request timeout", async () => {
    const controller = new AbortController();
    const reason = new Error("client went away");
    const stub = await startStub({
      malformed: "hang",
      onProbe: (p) => {
        if (p === "malformed") setTimeout(() => controller.abort(reason), 50);
      },
    });
    try {
      const started = Date.now();
      await expect(
        runComplianceSuite(stub.url, {
          timeout: 10_000,
          specVersion: "2025-11-25",
          only: [ENVELOPE],
          signal: controller.signal,
        }),
      ).rejects.toBe(reason);
      // Before: the probe ignored the signal and waited out the 10 s timeout.
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      await stub.stop();
    }
  }, 30_000);
});

describe("legacy error checks and lifecycle-jsonrpc after a handshake the server did not serve", () => {
  it("a server that rejects the handshake and the probes alike: not evaluable; its own error envelope on the handshake is still valid JSON-RPC", async () => {
    // Before: five passes.
    const { byId } = await verdicts({ init: 400, missingName: 400 });
    const handshake = (what: string) =>
      `not evaluable: the initialize handshake was not served either (HTTP 400, JSON-RPC error -32600), so this rejection proves nothing about ${what} (see lifecycle-init)`;
    expect(byId).toEqual({
      [JSONRPC]: "PASS: Valid JSON-RPC 2.0 response",
      [ENVELOPE]: `FAIL: HTTP 400, JSON-RPC error -32600 on the malformed JSON-RPC message -- ${handshake("the malformed JSON-RPC message")}`,
      [PARSE]: `FAIL: HTTP 400, JSON-RPC error -32700 on the invalid JSON body -- ${handshake("the invalid JSON body")}`,
      [PARAMS]: `FAIL: HTTP 400, JSON-RPC error -32600 on tools/call without a name -- ${handshake("the missing tool name")}`,
      [GATED]:
        "FAIL: tools/list -> HTTP 200, JSON-RPC error -32601, resources/list -> HTTP 200, JSON-RPC error -32601, prompts/list -> HTTP 200, JSON-RPC error -32601 -- not evaluable: the initialize handshake was not served (HTTP 400, JSON-RPC error -32600), so the suite never saw which capabilities the server declares, and these answers prove nothing about undeclared methods (see lifecycle-init)",
    });
  }, 30_000);

  it("a rejection with a status the handshake did not draw is still the server's", async () => {
    const { byId } = await verdicts({ init: 400 }, { only: [PARAMS] });
    expect(byId[PARAMS]).toBe(CONFORMANT[PARAMS]);
  }, 30_000);
});

describe("legacy lifecycle-jsonrpc: whose envelope an initialize answered without a result carries", () => {
  it("a 401, or a 403 carrying a Bearer challenge, on the handshake alone: the auth gate's (before: PASS)", async () => {
    const auth = await verdicts({ init: 401 }, { only: [JSONRPC] });
    expect(auth.byId[JSONRPC]).toBe(
      "FAIL: HTTP 401, JSON-RPC error -32001 on the initialize handshake -- not evaluable: an auth gate answered before the server read the request (pass --auth)",
    );
    const bearer = await verdicts({ init: "bearer-403" }, { only: [JSONRPC] });
    expect(bearer.byId[JSONRPC]).toBe(
      "FAIL: HTTP 403, JSON-RPC error -32001 on the initialize handshake -- not evaluable: an auth gate answered before the server read the request (pass --auth)",
    );
  }, 30_000);

  it("a 5xx: not evaluable unless it carries a server's own refusal of the initialize, credited with a warning", async () => {
    const custom = await verdicts({ init: "custom-500" }, { only: [JSONRPC] });
    expect(custom.byId[JSONRPC]).toBe(
      "FAIL: HTTP 500, JSON-RPC error -32000 on the initialize handshake -- not evaluable: a server error (or a gateway with no backend) answered, so the envelope need not be the server's",
    );
    const own = await verdicts({ init: "own-500" }, { only: [JSONRPC] });
    expect(own.byId[JSONRPC]).toBe("PASS: Valid JSON-RPC 2.0 response");
    expect(own.warnings.filter((w) => w.startsWith(JSONRPC))).toEqual([
      "lifecycle-jsonrpc: the server answered the initialize request with its own JSON-RPC error -32602 on HTTP 500; a rejected request is a client error, so a 4xx status is expected (a 5xx tells clients and gateways the server failed).",
    ]);
  }, 30_000);

  it("a 403 on the handshake that the ping did not draw is the server's own envelope", async () => {
    const { byId, hits } = await verdicts({ init: "bare-403" }, { only: [JSONRPC] });
    expect(byId[JSONRPC]).toBe("PASS: Valid JSON-RPC 2.0 response");
    expect(pings(hits)).toBe(1);
  }, 30_000);
});

/**
 * A 2025-11-25 stdio server: "serve" initializes and answers every other
 * request -32601 (tools/call without a name included); "reject-all"
 * answers initialize -32602 and every other request -32002 "Server not
 * initialized".
 */
const STDIO_SERVER = `
import { createInterface } from "node:readline";
const mode = process.argv[2];
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const rl = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  const error = (code, message) => send({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
  if (msg.method === "initialize") {
    if (mode === "reject-all") return error(-32602, "Unsupported client");
    return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "stdio-errors", version: "1" } } });
  }
  if (mode === "reject-all") return error(-32002, "Server not initialized");
  if (msg.method === "ping") return send({ jsonrpc: "2.0", id: msg.id, result: {} });
  error(-32601, "Method not found");
});
rl.on("close", () => process.exit(0));
`;

describe("legacy error-missing-params, error-capability-gated and lifecycle-jsonrpc over stdio", () => {
  let dir: string;
  let script: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "mcp-legacy-error-attribution-"));
    script = join(dir, "server.mjs");
    writeFileSync(script, STDIO_SERVER);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function overStdio(mode: string) {
    const report = await runComplianceSuite(
      { type: "stdio", command: process.execPath, args: [script, mode] },
      { timeout: 5000, startupTimeout: 5000, specVersion: "2025-11-25", only: [JSONRPC, PARAMS, GATED] },
    );
    return Object.fromEntries(report.tests.map((t) => [t.id, `${t.passed ? "PASS" : "FAIL"}: ${t.details}`]));
  }

  it("a server that serves the handshake keeps its PASSes", async () => {
    expect(await overStdio("serve")).toEqual({
      [JSONRPC]: "PASS: Valid JSON-RPC 2.0 response",
      [PARAMS]: "PASS: Error code: -32601 — Method not found",
      [GATED]: CONFORMANT[GATED],
    });
  }, 30_000);

  it("a server that rejects the handshake too: its rejections prove nothing (before: two passes)", async () => {
    expect(await overStdio("reject-all")).toEqual({
      // Its own envelope, over a pipe nothing stands in front of.
      [JSONRPC]: "PASS: Valid JSON-RPC 2.0 response",
      [PARAMS]:
        "FAIL: JSON-RPC error -32002 on tools/call without a name -- not evaluable: the initialize handshake was not served either (JSON-RPC error -32602), so this rejection proves nothing about the missing tool name (see lifecycle-init)",
      [GATED]:
        "FAIL: tools/list -> JSON-RPC error -32002, resources/list -> JSON-RPC error -32002, prompts/list -> JSON-RPC error -32002 -- not evaluable: the initialize handshake was not served (JSON-RPC error -32602), so the suite never saw which capabilities the server declares, and these answers prove nothing about undeclared methods (see lifecycle-init)",
    });
  }, 30_000);
});
