import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { runComplianceSuite } from "../runner.js";

/**
 * Integration coverage for the auth-stripping security tests.
 *
 * The auth-stripping security tests (security-auth-required,
 * security-www-authenticate, security-auth-malformed,
 * security-session-not-auth) probe a server by sending a request with the
 * Authorization header removed/replaced and asserting the server rejects
 * it. Before the omitUserHeaders fix, the HttpTransport re-injected the
 * configured Authorization header via sessionHeaders() on EVERY request —
 * so the "stripped" probe still carried valid auth, the auth-requiring
 * server accepted it, and the tests false-passed (or false-failed,
 * depending on the assertion).
 *
 * These tests spin up a real MCP server that REQUIRES a bearer token at
 * the HTTP layer and run the full suite with valid auth. The auth-stripping
 * security tests can only pass if the stripped probe genuinely reaches the
 * server WITHOUT auth and is rejected with 401/403. We also record exactly
 * what the server saw on each probe so we can assert directly that a
 * stripped request arrived with no Authorization header.
 */

const VALID_TOKEN = "Bearer s3cr3t-valid-token";

/**
 * The 2025-11-25 auth siblings' not-evaluable skip, worded as the 2026-07-28
 * suite's AUTH_NOT_EVALUABLE (before: "Skipped: not evaluable (see
 * security-auth-required)", a pointer that said nothing on its own).
 */
const AUTH_NOT_EVALUABLE =
  "Skipped: HTTP 403 without a Bearer challenge, not attributable to authentication (see security-auth-required)";

let server: Server;
let serverUrl: string;

/**
 * Records the Authorization header value the server received for every
 * non-initialize POST whose JSON-RPC method is `ping`. The auth-stripping
 * security tests all probe with `ping`, so this captures exactly what the
 * "stripped" requests carried on the wire.
 */
const pingAuthHeaders: Array<string | undefined> = [];
/** Request URLs of the same `ping` probes, so the token-in-URI probe is observable. */
const pingUrls: string[] = [];

function createTestMcpServer(): McpServer {
  const mcp = new McpServer({ name: "auth-test-server", version: "1.0.0" });
  mcp.tool(
    "echo",
    "Echoes back the input",
    { message: z.string().optional().describe("Message to echo") },
    async ({ message }) => ({ content: [{ type: "text", text: String(message ?? "no message") }] }),
  );
  return mcp;
}

/** Read and buffer the request body so we can inspect it before delegating. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

beforeAll(async () => {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const auth = req.headers.authorization;
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    // Buffer the POST body up front so we can (a) record which probes are
    // `ping` and what auth they carried, and (b) hand the SDK a pre-parsed
    // body (the stream is single-read). GET/DELETE have no body.
    const rawBody = req.method === "POST" ? await readBody(req) : "";
    let parsedBody: unknown;
    let parseFailed = false;
    if (rawBody) {
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        parseFailed = true;
      }
    }
    const rpcMethod =
      parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody)
        ? ((parsedBody as { method?: string }).method ?? undefined)
        : undefined;
    if (rpcMethod === "ping") {
      pingAuthHeaders.push(auth);
      pingUrls.push(req.url ?? "");
    }

    // Auth gate at the HTTP layer (the SDK transport does not do auth).
    // Reject any request without the exact valid bearer token. This is the
    // behavior the auth-stripping security tests exist to detect.
    if (auth !== VALID_TOKEN) {
      res.writeHead(401, {
        "content-type": "application/json",
        "www-authenticate": 'Bearer realm="mcp", error="invalid_token"',
      });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } }));
      return;
    }

    // A spec server rejects unparseable JSON-RPC and a wrong request
    // Content-Type with a 4xx. Mirror that here so the transport tests
    // (which intentionally POST garbage / text-plain) behave realistically
    // and don't crash on a re-read of the consumed stream.
    if (req.method === "POST") {
      const ct = String(req.headers["content-type"] ?? "").toLowerCase();
      if (parseFailed) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
        return;
      }
      if (ct && !ct.includes("application/json")) {
        res.writeHead(415, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Unsupported Media Type" } }),
        );
        return;
      }
    }

    if (req.method === "DELETE") {
      if (sessionId && transports.has(sessionId)) {
        const t = transports.get(sessionId)!;
        await t.close();
        transports.delete(sessionId);
        res.writeHead(200);
        res.end();
      } else {
        res.writeHead(sessionId ? 404 : 400);
        res.end();
      }
      return;
    }

    if (sessionId && transports.has(sessionId)) {
      const t = transports.get(sessionId)!;
      await t.handleRequest(req, res, parsedBody);
      return;
    }

    if (req.method === "POST") {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });
      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId);
      };
      const mcp = createTestMcpServer();
      await mcp.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
      if (transport.sessionId) transports.set(transport.sessionId, transport);
      return;
    }

    res.writeHead(405);
    res.end();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") serverUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

function authHeaders(): Record<string, string> {
  return { Authorization: VALID_TOKEN };
}

describe("integration — auth-stripping security tests against an auth-requiring server", () => {
  it("the auth-requiring server accepts the authed initialize handshake", async () => {
    // Sanity: with valid auth the suite gets past initialize and runs
    // tests. If this fails the rest of the file is testing nothing.
    const report = await runComplianceSuite(serverUrl, { headers: authHeaders(), timeout: 3000 });
    expect(report.serverInfo.name).toBe("auth-test-server");
  }, 30000);

  it("security-auth-required PASSES because the stripped probe is genuinely unauthenticated", async () => {
    const report = await runComplianceSuite(serverUrl, { headers: authHeaders(), timeout: 3000 });
    const t = report.tests.find((x) => x.id === "security-auth-required");
    expect(t).toBeDefined();
    // Pre-fix: the stripped probe still carried Authorization (re-injected
    // by sessionHeaders), the server returned 200, and this assertion
    // would FAIL with "server accepted unauthenticated request".
    expect(t?.passed, `security-auth-required details: ${t?.details}`).toBe(true);
    // A 401 reads as an auth rejection on its own: no comparison ping, no hint.
    expect(t?.details).toBe("HTTP 401 (unauthenticated request rejected)");
  }, 30000);

  it("security-www-authenticate PASSES and observes the WWW-Authenticate header on the stripped 401", async () => {
    const report = await runComplianceSuite(serverUrl, { headers: authHeaders(), timeout: 3000 });
    const t = report.tests.find((x) => x.id === "security-www-authenticate");
    expect(t?.passed, `security-www-authenticate details: ${t?.details}`).toBe(true);
    // Proves the probe actually hit a 401 (not the "not a 401" pass branch).
    expect(t?.details).toMatch(/WWW-Authenticate/i);
  }, 30000);

  it("security-auth-malformed PASSES because the valid token is replaced by a garbage one", async () => {
    const report = await runComplianceSuite(serverUrl, { headers: authHeaders(), timeout: 3000 });
    const t = report.tests.find((x) => x.id === "security-auth-malformed");
    expect(t?.passed, `security-auth-malformed details: ${t?.details}`).toBe(true);
    expect(t?.details).toMatch(/401|403/);
  }, 30000);

  it("security-session-not-auth PASSES because the session ID alone does not satisfy auth", async () => {
    const report = await runComplianceSuite(serverUrl, { headers: authHeaders(), timeout: 3000 });
    const t = report.tests.find((x) => x.id === "security-session-not-auth");
    expect(t?.passed, `security-session-not-auth details: ${t?.details}`).toBe(true);
    expect(t?.details).toMatch(/401|403/);
  }, 30000);

  it("a stripped request genuinely reaches the server with NO Authorization header", async () => {
    // The load-bearing assertion: the server records the Authorization
    // value of every `ping` probe. The auth-stripping tests all send
    // `ping`. At least one must arrive with NO auth (security-auth-required
    // / security-www-authenticate / security-session-not-auth omit it
    // entirely). Before the fix, EVERY ping carried the valid token, so
    // this set would be empty and the test would fail.
    pingAuthHeaders.length = 0;
    pingUrls.length = 0;
    await runComplianceSuite(serverUrl, { headers: authHeaders(), timeout: 3000 });

    const seen = JSON.stringify(pingAuthHeaders);
    expect(pingAuthHeaders.length, "no ping probes were recorded").toBeGreaterThan(0);

    // The auth-stripping probes that should omit auth entirely
    // (security-auth-required, security-www-authenticate, and
    // security-session-not-auth) must arrive with NO Authorization header.
    // Before the fix sessionHeaders() re-injected the valid token, so this
    // count would be 0. We expect at least 2 (session-not-auth only runs
    // when the server issues a session id, so don't hard-pin to 3).
    const strippedCount = pingAuthHeaders.filter((h) => h === undefined).length;
    expect(strippedCount, `expected >=2 auth-free ping probes; saw: ${seen}`).toBeGreaterThanOrEqual(2);

    // The malformed-auth probe arrived carrying the GARBAGE token — proving
    // the configured-valid token was stripped first and the replacement
    // value took its place (rather than the valid one surviving the merge).
    expect(
      pingAuthHeaders.some((h) => typeof h === "string" && h.includes("INVALID_GARBAGE_TOKEN")),
      `expected a malformed-auth ping; saw: ${seen}`,
    ).toBe(true);

    // Every probe is exactly one of: the legitimate valid token (the many
    // authenticated pings the suite sends), undefined (a stripped probe), or
    // the garbage token (the malformed-auth probe). No stripped probe leaked
    // a partial/odd credential. (The valid-token pings are legitimate and
    // expected; the security tests are the undefined/garbage ones.)
    for (const h of pingAuthHeaders) {
      const ok = h === undefined || h === VALID_TOKEN || (typeof h === "string" && h.includes("INVALID_GARBAGE_TOKEN"));
      expect(ok, `unexpected auth value on a ping probe: ${JSON.stringify(h)} (all: ${seen})`).toBe(true);
    }
  }, 30000);

  it("security-token-in-uri really sends the token in the query string and no Authorization header", async () => {
    // Before the fix the probe went through the transport, which ignores
    // the URL it was handed and re-injects the configured Authorization
    // header, so the server saw an ordinary authenticated ping, answered
    // 200, and the test reported a FALSE "accepted auth token in query
    // string" failure on every server with auth.
    pingAuthHeaders.length = 0;
    pingUrls.length = 0;
    const report = await runComplianceSuite(serverUrl, {
      headers: authHeaders(),
      timeout: 3000,
      only: ["security-token-in-uri"],
    });
    const t = report.tests.find((x) => x.id === "security-token-in-uri");
    expect(t?.passed, `security-token-in-uri details: ${t?.details}`).toBe(true);
    expect(t?.details).toMatch(/401|403/);

    const idx = pingUrls.findIndex((u) => u.includes("access_token="));
    expect(
      idx,
      `no ping probe carried access_token in its URL; urls: ${JSON.stringify(pingUrls)}`,
    ).toBeGreaterThanOrEqual(0);
    expect(pingAuthHeaders[idx], "the token-in-URI probe must not also carry Authorization").toBeUndefined();
  }, 30000);
});

/**
 * An SDK v1 sessionful McpServer + StreamableHTTPServerTransport behind
 * `front`, which may answer a request itself (and returns true when it
 * did). The POST body is read before `front` runs, so a gateway can route
 * on the JSON-RPC method the way a real one does. Records the
 * Authorization header of every ping that reached the SDK server.
 */
async function startSdkBehind(
  front: (req: IncomingMessage, res: ServerResponse, rpcMethod?: string) => boolean,
): Promise<{ url: string; servedPings: Array<string | undefined>; stop(): Promise<void> }> {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const servedPings: Array<string | undefined> = [];
  const gated: Server = createServer(async (req, res) => {
    const body = req.method === "POST" ? await readBody(req) : "";
    let parsed: unknown;
    try {
      parsed = body ? JSON.parse(body) : undefined;
    } catch {}
    const method = (parsed as { method?: unknown } | undefined)?.method;
    if (front(req, res, typeof method === "string" ? method : undefined)) return;
    if (method === "ping") servedPings.push(req.headers.authorization);
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const known = sessionId ? transports.get(sessionId) : undefined;
    if (known) {
      await known.handleRequest(req, res, parsed);
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(sessionId ? 404 : 405);
      res.end();
      return;
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    await createTestMcpServer().connect(transport);
    await transport.handleRequest(req, res, parsed);
    if (transport.sessionId) transports.set(transport.sessionId, transport);
  });
  const url = await new Promise<string>((resolve) => {
    gated.listen(0, "127.0.0.1", () => {
      const addr = gated.address();
      resolve(`http://127.0.0.1:${addr && typeof addr === "object" ? addr.port : 0}/mcp`);
    });
  });
  return {
    url,
    servedPings,
    async stop() {
      for (const t of transports.values()) await t.close().catch(() => {});
      gated.closeAllConnections();
      await new Promise<void>((resolve) => gated.close(() => resolve()));
    },
  };
}

/**
 * The SDK's own Host guard (hostHeaderValidation, the DNS-rebinding
 * middleware createMcpExpressApp installs), allowing only a hostname the
 * test never uses -- a server with no auth at all reached through a tunnel
 * or proxy hostname it does not list. It answers 403 with a JSON-RPC -32000
 * "Invalid Host: ..." body and no WWW-Authenticate, whatever the request
 * carries. The middleware is Express-shaped; `status` / `json` are the two
 * response methods it calls.
 */
function sdkHostGuard(allowed: string[]) {
  const guard = hostHeaderValidation(allowed);
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    let passed = false;
    const expressRes = Object.assign(res, {
      status(code: number) {
        res.statusCode = code;
        return expressRes;
      },
      json(body: unknown) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(body));
      },
    });
    guard(req as never, expressRes as never, () => {
      passed = true;
    });
    return !passed;
  };
}

/**
 * The loopback server reached through a tunnel (ngrok, cloudflared) that
 * forwards the public hostname: every request arrives with `Host: <tunnel>`
 * and the SDK's Host guard, allowing the loopback names createMcpExpressApp
 * allows by default, refuses it with "Invalid Host: <tunnel>".
 */
function sdkHostGuardBehindTunnel(tunnelHost: string) {
  const guard = sdkHostGuard(["localhost", "127.0.0.1", "[::1]"]);
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    req.headers.host = tunnelHost;
    return guard(req, res);
  };
}

/**
 * A gateway whose method policy refuses a 2026-07-28 request (the era probe
 * the preflight sends, MCP-Protocol-Version: 2026-07-28) with a bare 403
 * before any authentication, and answers every request it allows that lacks
 * the token with 401 and a Bearer challenge.
 */
function policyThen401Gateway(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.headers["mcp-protocol-version"] === "2026-07-28") {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32000, message: "Protocol version not allowed by policy" },
      }),
    );
    return true;
  }
  if (req.headers.authorization === VALID_TOKEN) return false;
  res.writeHead(401, { "content-type": "application/json", "www-authenticate": 'Bearer realm="mcp"' });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } }));
  return true;
}

/**
 * A deployment whose gateway exempts the handshake: `initialize` is served
 * with no credential at all, and every other method that does not carry the
 * valid token draws 401 with a Bearer challenge -- so the era probe the
 * preflight sends is refused while the server itself serves an
 * unauthenticated request.
 */
function initializeExemptGateway(req: IncomingMessage, res: ServerResponse, rpcMethod?: string): boolean {
  if (req.headers.authorization === VALID_TOKEN || rpcMethod === "initialize") return false;
  res.writeHead(401, { "content-type": "application/json", "www-authenticate": 'Bearer realm="mcp"' });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } }));
  return true;
}

/**
 * A gateway that answers a request with no Authorization header with a bare
 * 403 (no WWW-Authenticate challenge -- basic/authorization asks for a 401),
 * and a wrong token with 401.
 */
function bare403Gateway(req: IncomingMessage, res: ServerResponse): boolean {
  const auth = req.headers.authorization;
  if (auth === VALID_TOKEN) return false;
  if (auth === undefined) {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Forbidden: missing credentials" } }),
    );
  } else {
    res.writeHead(401, { "content-type": "application/json", "www-authenticate": 'Bearer error="invalid_token"' });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } }));
  }
  return true;
}

/**
 * A gateway that lets the era probe (server/discover) through to the SDK
 * server without a token -- a method outside its auth policy -- and answers
 * every other request that lacks the token with 401 and a Bearer challenge.
 */
function discoverOpenGateway(req: IncomingMessage, res: ServerResponse, rpcMethod?: string): boolean {
  if (req.headers.authorization === VALID_TOKEN || rpcMethod === "server/discover") return false;
  res.writeHead(401, { "content-type": "application/json", "www-authenticate": 'Bearer realm="mcp"' });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } }));
  return true;
}

/**
 * A rate limiter in front of the SDK server that answers every request
 * lacking the token 429 -- no authentication refusal at all.
 */
function rateLimitingGateway(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.headers.authorization === VALID_TOKEN) return false;
  res.writeHead(429, { "content-type": "text/plain", "retry-after": "0" });
  res.end("Too Many Requests");
  return true;
}

/** The Bearer challenge of basic/authorization's insufficient-scope 403. */
const INSUFFICIENT_SCOPE =
  'Bearer realm="mcp", error="insufficient_scope", resource_metadata="https://auth.example/.well-known/oauth-protected-resource"';

/** A gateway that answers a request lacking the token 403 with {@link INSUFFICIENT_SCOPE}. */
function bearer403Gateway(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.headers.authorization === VALID_TOKEN) return false;
  res.writeHead(403, { "content-type": "application/json", "www-authenticate": INSUFFICIENT_SCOPE });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Forbidden" } }));
  return true;
}

describe("integration — legacy auth checks behind gateways that are not a bare 403", () => {
  const verdicts = (report: Awaited<ReturnType<typeof runComplianceSuite>>) =>
    Object.fromEntries(report.tests.map((t) => [t.id, `${t.passed ? "PASS" : "FAIL"}: ${t.details}`]));

  it("a gateway that lets server/discover through to the SDK server and answers every other unauthenticated request 401: auth-required passes on initialize's 401 (before: FAIL 'server accepted unauthenticated requests')", async () => {
    const sdk = await startSdkBehind(discoverOpenGateway);
    try {
      const report = await runComplianceSuite(sdk.url, {
        timeout: 3000,
        specVersion: "2025-11-25",
        only: ["security-auth-required"],
      });
      // Nothing was served without the token: the SDK refused the era probe
      // outside a session, and the gateway refused initialize.
      expect(report.serverInfo.name).toBeNull();
      expect(verdicts(report)).toEqual({
        "security-auth-required":
          "PASS: HTTP 401 on initialize (unauthenticated request rejected; pass --auth to run the authenticated suite and the remaining auth tests)",
      });
    } finally {
      await sdk.stop();
    }
  }, 30000);

  it("a rate limiter's 429 on every request without the token: the three probes fail naming it, not as 'server accepted' (before: 'HTTP 429 — server accepted ...')", async () => {
    const sdk = await startSdkBehind(rateLimitingGateway);
    try {
      const report = await runComplianceSuite(sdk.url, {
        timeout: 3000,
        specVersion: "2025-11-25",
        headers: authHeaders(),
        only: ["security-auth-required", "security-auth-malformed", "security-session-not-auth"],
      });
      expect(report.serverInfo.name).toBe("auth-test-server");
      const refused =
        "the request was refused, but not as an authentication refusal (a wrong path, a gateway or a rate limiter)";
      expect(verdicts(report)).toEqual({
        "security-auth-required": `FAIL: HTTP 429 on the unauthenticated ping -- ${refused}; the spec answers a missing credential with 401`,
        "security-auth-malformed": `FAIL: HTTP 429 on the ping carrying a malformed credential -- ${refused}; the spec answers an invalid token with 401`,
        "security-session-not-auth": `FAIL: HTTP 429 on the ping carrying only the session ID -- ${refused}; the spec answers a request without a credential with 401, whatever session it names`,
      });
    } finally {
      await sdk.stop();
    }
  }, 30000);

  it("an insufficient-scope 403 carrying a Bearer challenge: security-www-authenticate reads the challenge (before: 'WWW-Authenticate not applicable for 403')", async () => {
    const sdk = await startSdkBehind(bearer403Gateway);
    try {
      const report = await runComplianceSuite(sdk.url, {
        timeout: 3000,
        specVersion: "2025-11-25",
        headers: authHeaders(),
        only: ["security-auth-required", "security-www-authenticate"],
      });
      expect(verdicts(report)).toEqual({
        "security-auth-required": "PASS: HTTP 403 (unauthenticated request rejected)",
        "security-www-authenticate": `PASS: WWW-Authenticate: ${INSUFFICIENT_SCOPE} (HTTP 403)`,
      });
    } finally {
      await sdk.stop();
    }
  }, 30000);
});

describe("integration — legacy security-auth-required behind a bare 403 (the SDK's Host guard, a gateway)", () => {
  // A bare 403 is what streamable-http requires for an invalid Origin, what
  // the SDK's Host validation answers a hostname it does not allow, and what
  // gateways send; basic/authorization requires a 401 for a missing token.
  // So it counts as an auth rejection only next to the same request carrying
  // the credential being served.
  const ID = "security-auth-required";
  const run = (url: string, headers?: Record<string, string>) =>
    runComplianceSuite(url, { timeout: 3000, specVersion: "2025-11-25", only: [ID], ...(headers ? { headers } : {}) });
  const authRequired = (report: Awaited<ReturnType<typeof run>>) => {
    const t = report.tests.find((x) => x.id === ID);
    return { passed: t?.passed, details: t?.details };
  };

  it("the SDK's Host guard, without --auth: not evaluable (before: PASS 'unauthenticated preflight rejected')", async () => {
    const sdk = await startSdkBehind(sdkHostGuard(["mcp.example.com"]));
    try {
      expect(authRequired(await run(sdk.url))).toEqual({
        passed: false,
        details:
          'HTTP 403 ("Invalid Host: 127.0.0.1") on the unauthenticated preflight with no WWW-Authenticate: Bearer challenge -- not evaluable: the message names Host/Origin validation, which refuses the request with or without a credential (--auth does not get past it); allow the hostname you tested through in the server\'s allowed hosts/origins, or test an address it allows',
      });
    } finally {
      await sdk.stop();
    }
  }, 30000);

  it("the SDK's Host guard, with --auth: the credentialed ping is refused too, so still not evaluable (before: PASS)", async () => {
    const sdk = await startSdkBehind(sdkHostGuard(["mcp.example.com"]));
    try {
      expect(authRequired(await run(sdk.url, authHeaders()))).toEqual({
        passed: false,
        details:
          'HTTP 403 ("Invalid Host: 127.0.0.1") on the unauthenticated ping with no WWW-Authenticate: Bearer challenge, and the same ping with the credential was refused (HTTP 403, JSON-RPC error -32000) -- not evaluable: the message names Host/Origin validation rather than authentication; allow the hostname you tested through in the server\'s allowed hosts/origins, or test an address it allows',
      });
      expect(sdk.servedPings).toEqual([]);
    } finally {
      await sdk.stop();
    }
  }, 30000);

  it("a gateway's bare 403 with --auth: the credentialed ping is served, so it passes, noting the 401 the spec expects", async () => {
    const sdk = await startSdkBehind(bare403Gateway);
    try {
      const report = await run(sdk.url, authHeaders());
      expect(report.serverInfo.name).toBe("auth-test-server");
      expect(authRequired(report)).toEqual({
        passed: true,
        details:
          "HTTP 403 (unauthenticated request rejected; the same ping with the credential was served) -- basic/authorization expects 401 with a WWW-Authenticate challenge for a missing token",
      });
      // The SDK server itself served the comparison ping, inside the session.
      expect(sdk.servedPings).toEqual([VALID_TOKEN]);
    } finally {
      await sdk.stop();
    }
  }, 30000);

  it("through a tunnel hostname: the whole hostname is quoted with the allowed-hosts advice, and with --auth the sibling auth probes skip rather than credit the guard's 403", async () => {
    const TUNNEL = "abc123.ngrok-free.app";
    const sdk = await startSdkBehind(sdkHostGuardBehindTunnel(TUNNEL));
    const siblings = [
      "security-www-authenticate",
      "security-auth-malformed",
      "security-session-not-auth",
      "security-token-in-uri",
    ];
    try {
      const noAuth = await run(sdk.url);
      expect(authRequired(noAuth)).toEqual({
        passed: false,
        details: `HTTP 403 ("Invalid Host: ${TUNNEL}") on the unauthenticated preflight with no WWW-Authenticate: Bearer challenge -- not evaluable: the message names Host/Origin validation, which refuses the request with or without a credential (--auth does not get past it); allow the hostname you tested through in the server's allowed hosts/origins, or test an address it allows`,
      });
      const withAuth = await runComplianceSuite(sdk.url, {
        timeout: 3000,
        specVersion: "2025-11-25",
        headers: authHeaders(),
        only: [ID, ...siblings],
      });
      expect(authRequired(withAuth).details).toBe(
        `HTTP 403 ("Invalid Host: ${TUNNEL}") on the unauthenticated ping with no WWW-Authenticate: Bearer challenge, and the same ping with the credential was refused (HTTP 403, JSON-RPC error -32000) -- not evaluable: the message names Host/Origin validation rather than authentication; allow the hostname you tested through in the server's allowed hosts/origins, or test an address it allows`,
      );
      // Before: PASS "HTTP 403 (WWW-Authenticate not applicable for 403)",
      // "HTTP 403 (malformed auth rejected)", "Skipped: server does not issue
      // session IDs" and "HTTP 403 (token in query string rejected)" -- the
      // guard's 403 credited as an auth rejection.
      for (const id of siblings) {
        const t = withAuth.tests.find((x) => x.id === id);
        expect({ id, passed: t?.passed, details: t?.details }).toEqual({
          id,
          passed: true,
          details: AUTH_NOT_EVALUABLE,
        });
      }
      // The same run with security-auth-required filtered out (--only the
      // siblings, or a config's skip list). Before: PASS "HTTP 403
      // (WWW-Authenticate not applicable for 403)", "HTTP 403 (malformed auth
      // rejected)" and "HTTP 403 (token in query string rejected)" -- the skip
      // was a flag only security-auth-required's own body set.
      const siblingsOnly = await runComplianceSuite(sdk.url, {
        timeout: 3000,
        specVersion: "2025-11-25",
        headers: authHeaders(),
        only: siblings,
      });
      expect(siblingsOnly.tests.map((t) => ({ id: t.id, passed: t.passed, details: t.details }))).toEqual(
        siblings.map((id) => ({ id, passed: true, details: AUTH_NOT_EVALUABLE })),
      );
      // The SDK server behind the guard never saw a request.
      expect(sdk.servedPings).toEqual([]);
    } finally {
      await sdk.stop();
    }
  }, 30000);

  it("a gateway refusing the era probe with a bare 403 but every unauthenticated 2025-11-25 request with 401: passes on the 401 (before: FAIL not evaluable)", async () => {
    const sdk = await startSdkBehind(policyThen401Gateway);
    try {
      expect(authRequired(await run(sdk.url))).toEqual({
        passed: true,
        details:
          "HTTP 401 on initialize (unauthenticated request rejected; pass --auth to run the authenticated suite and the remaining auth tests)",
      });
      // With --auth the ping without the token draws the gateway's 401.
      const report = await run(sdk.url, authHeaders());
      expect(report.serverInfo.name).toBe("auth-test-server");
      expect(authRequired(report)).toEqual({ passed: true, details: "HTTP 401 (unauthenticated request rejected)" });
    } finally {
      await sdk.stop();
    }
  }, 30000);

  it("the same gateway without --auth: not evaluable, naming --auth as the way to compare (before: PASS)", async () => {
    const sdk = await startSdkBehind(bare403Gateway);
    try {
      expect(authRequired(await run(sdk.url))).toEqual({
        passed: false,
        details:
          'HTTP 403 ("Forbidden: missing credentials") on the unauthenticated preflight with no WWW-Authenticate: Bearer challenge -- not evaluable: it may be Host/Origin validation or a gateway rather than authentication (a server that requires a token answers 401); re-run with --auth to compare the same request with and without the credential',
      });
    } finally {
      await sdk.stop();
    }
  }, 30000);

  it("a gateway that exempts the handshake: the 401 on the preflight does not outrank the initialize it served (before: PASS)", async () => {
    // The server answered `initialize` without any credential, so the run
    // holds proof it serves unauthenticated requests -- whatever the era
    // probe drew. Before: PASS "HTTP 401 (unauthenticated preflight
    // rejected; pass --auth ...)".
    const sdk = await startSdkBehind(initializeExemptGateway);
    try {
      const report = await run(sdk.url);
      expect(report.serverInfo.name).toBe("auth-test-server");
      expect(authRequired(report)).toEqual({
        passed: false,
        details:
          "Server does not require auth: initialize was served with no credential, although the unauthenticated preflight got HTTP 401 (a server that requires authorization rejects every unauthenticated request, initialize included)",
      });
    } finally {
      await sdk.stop();
    }
  }, 30000);
});

describe("integration — legacy auth siblings read the SDK server the way the 2026-07-28 suite does", () => {
  const OAUTH = "security-oauth-metadata";
  const verdicts = (report: Awaited<ReturnType<typeof runComplianceSuite>>) =>
    Object.fromEntries(report.tests.map((t) => [t.id, `${t.passed ? "PASS" : "FAIL"}: ${t.details}`]));

  it("the SDK's Host guard with --auth: security-oauth-metadata skips the guard's 403 on the metadata locations (before: FAIL 'PRM endpoint returned HTTP 403 ...')", async () => {
    // The guard answers every path alike, /.well-known/* included, so a
    // "publish Protected Resource Metadata" remedy is advice the guard would
    // never let through. security-auth-required names the real cause.
    const sdk = await startSdkBehind(sdkHostGuard(["mcp.example.com"]));
    try {
      const report = await runComplianceSuite(sdk.url, {
        timeout: 3000,
        specVersion: "2025-11-25",
        headers: authHeaders(),
        only: [OAUTH],
      });
      const t = report.tests.find((x) => x.id === OAUTH);
      expect({ passed: t?.passed, skipped: t?.skipped, details: t?.details }).toEqual({
        passed: true,
        skipped: true,
        details:
          "Skipped: HTTP 403 without a Bearer challenge on the endpoint and on every well-known metadata location, not attributable to authentication (see security-auth-required)",
      });
      expect(sdk.servedPings).toEqual([]);
    } finally {
      await sdk.stop();
    }
  }, 30000);

  it("a gateway's bare 403 next to a served credentialed ping: the missing metadata is still a finding", async () => {
    // The credential is the variable here, so the 403 on the metadata
    // location is the gate refusing a request that lacks it -- not the guard.
    const sdk = await startSdkBehind(bare403Gateway);
    try {
      const report = await runComplianceSuite(sdk.url, {
        timeout: 3000,
        specVersion: "2025-11-25",
        headers: authHeaders(),
        only: [OAUTH],
      });
      // Both well-known locations are named (the endpoint path, then the
      // root), as the 2026-07-28 lookup names them. Before: "PRM endpoint
      // returned HTTP 403 and no legacy OAuth metadata found".
      expect(verdicts(report)).toEqual({
        [OAUTH]:
          "FAIL: No Protected Resource Metadata (/.well-known/oauth-protected-resource/mcp -> HTTP 403; /.well-known/oauth-protected-resource -> HTTP 403) and no legacy OAuth metadata",
      });
    } finally {
      await sdk.stop();
    }
  }, 30000);

  it("a credential the server refuses (a stale token): auth-malformed and token-in-uri skip rather than credit the 401 every credential draws", async () => {
    // Before: PASS "HTTP 401 (malformed auth rejected)" and PASS "HTTP 401
    // (token in query string rejected)" against a server that refused the
    // configured token too -- nothing told token validation from a blanket
    // refusal.
    const report = await runComplianceSuite(serverUrl, {
      timeout: 3000,
      specVersion: "2025-11-25",
      headers: { Authorization: "Bearer stale-token" },
      only: ["security-auth-malformed", "security-token-in-uri"],
    });
    expect(verdicts(report)).toEqual({
      "security-auth-malformed":
        "PASS: Skipped: the configured credential was refused too (the credentialed ping drew HTTP 401), so rejecting invalid tokens cannot be told from rejecting everything (check the configured credential)",
      "security-token-in-uri":
        "PASS: Skipped: the configured credential was refused too (the credentialed ping drew HTTP 401), so refusing it in the query string proves nothing (check the configured credential)",
    });
    expect(report.tests.map((t) => t.skipped)).toEqual([true, true]);
  }, 30000);

  it("the valid token: the same two checks measure the server's 401s", async () => {
    const report = await runComplianceSuite(serverUrl, {
      timeout: 3000,
      specVersion: "2025-11-25",
      headers: authHeaders(),
      only: ["security-auth-malformed", "security-token-in-uri"],
    });
    expect(verdicts(report)).toEqual({
      "security-auth-malformed": "PASS: HTTP 401 (malformed auth rejected)",
      "security-token-in-uri": "PASS: HTTP 401 (token in query string rejected)",
    });
    expect(report.tests.map((t) => t.skipped)).toEqual([undefined, undefined]);
  }, 30000);
});

describe("integration — the legacy auth checks read an upper-case Authorization header as a credential", () => {
  // HTTP header names are case-insensitive, so `-H "AUTHORIZATION: Bearer
  // x"` configures the same credential `--auth` does. Before, `hasAuth`
  // read only the `Authorization` / `authorization` spellings: every auth
  // check behaved as if none had been passed, against a server that
  // requires one.
  it("security-auth-required and its siblings measure the server instead of skipping", async () => {
    const report = await runComplianceSuite(serverUrl, {
      timeout: 3000,
      specVersion: "2025-11-25",
      headers: { AUTHORIZATION: VALID_TOKEN },
      only: ["security-auth-required", "security-www-authenticate", "security-session-not-auth"],
    });
    // The upper-case header got the suite through the handshake, as the
    // canonical spelling does.
    expect(report.serverInfo.name).toBe("auth-test-server");
    const verdicts = Object.fromEntries(report.tests.map((t) => [t.id, `${t.passed ? "PASS" : "FAIL"}: ${t.details}`]));
    // Before: FAIL "Server does not require auth (no --auth provided and
    // server accepted unauthenticated requests)" plus two "Skipped: no
    // --auth provided".
    expect(verdicts["security-auth-required"]).toBe("PASS: HTTP 401 (unauthenticated request rejected)");
    expect(verdicts["security-www-authenticate"]).toMatch(/^PASS: WWW-Authenticate: /);
    expect(verdicts["security-session-not-auth"]).toBe("PASS: HTTP 401 (session ID alone not sufficient for auth)");
  }, 30000);
});

describe("integration — the legacy negative probes do not credit an auth gate's refusal as the server's", () => {
  // transport-content-type-reject, transport-batch-reject,
  // lifecycle-version-negotiate and error-unknown-method pass on a rejection
  // of the defect they carry. A gate in front of the SDK server that refuses
  // the request never let the server see that defect.
  const NEGATIVE = [
    "transport-content-type-reject",
    "transport-batch-reject",
    "lifecycle-version-negotiate",
    "error-unknown-method",
  ];
  const verdicts = (report: Awaited<ReturnType<typeof runComplianceSuite>>) =>
    Object.fromEntries(report.tests.map((t) => [t.id, `${t.passed ? "PASS" : "FAIL"}: ${t.details}`]));
  const AUTH_GATE = "not evaluable: an auth gate answered before the server read the request (pass --auth)";

  it("the auth-requiring server without --auth: its 401 on every request is not four rejections (before: four passes)", async () => {
    // Before: PASS "HTTP 401 (incorrect Content-Type rejected)", PASS "HTTP
    // 401 (batch rejected)", PASS "Server rejected unknown version with
    // error: -32001 — Unauthorized", PASS "Error code: -32001 (expected
    // -32601) — Unauthorized".
    const report = await runComplianceSuite(serverUrl, { timeout: 3000, specVersion: "2025-11-25", only: NEGATIVE });
    const handshake =
      "not evaluable: the initialize handshake was not served either (HTTP 401, JSON-RPC error -32001), so this rejection proves nothing about";
    expect(verdicts(report)).toEqual({
      "transport-content-type-reject": `FAIL: HTTP 401, JSON-RPC error -32001 on the text/plain POST -- ${AUTH_GATE}`,
      "transport-batch-reject": `FAIL: HTTP 401, JSON-RPC error -32001 on the batch -- ${AUTH_GATE}`,
      "lifecycle-version-negotiate": `FAIL: HTTP 401, JSON-RPC error -32001 on the initialize requesting protocol version 2099-01-01 -- ${handshake} the unknown version (see lifecycle-init)`,
      "error-unknown-method": `FAIL: HTTP 401, JSON-RPC error -32001 on nonexistent/method -- ${handshake} the unknown method (see lifecycle-init)`,
    });
  }, 30000);

  it("the same server with the valid token: the server's own rejections keep their PASSes", async () => {
    const report = await runComplianceSuite(serverUrl, {
      timeout: 3000,
      specVersion: "2025-11-25",
      headers: authHeaders(),
      only: NEGATIVE,
    });
    expect(verdicts(report)).toEqual({
      "transport-content-type-reject": "PASS: HTTP 415 (incorrect Content-Type rejected)",
      "transport-batch-reject": "PASS: HTTP 400 (batch rejected)",
      "lifecycle-version-negotiate":
        "PASS: Server rejected unknown version with error: -32600 — Invalid Request: Server already initialized",
      "error-unknown-method": "PASS: Error code: -32601 (correct: Method not found) — Method not found",
    });
  }, 30000);

  it("a gateway that exempts initialize: the unknown method's 401 is the gateway's, while the version probe reaches the server", async () => {
    // Before: error-unknown-method PASSED "Error code: -32001 (expected
    // -32601) — Unauthorized" next to a served handshake.
    const sdk = await startSdkBehind(initializeExemptGateway);
    try {
      const report = await runComplianceSuite(sdk.url, { timeout: 3000, specVersion: "2025-11-25", only: NEGATIVE });
      expect(report.serverInfo.name).toBe("auth-test-server");
      expect(verdicts(report)).toEqual({
        "transport-content-type-reject": `FAIL: HTTP 401, JSON-RPC error -32001 on the text/plain POST -- ${AUTH_GATE}`,
        "transport-batch-reject": `FAIL: HTTP 401, JSON-RPC error -32001 on the batch -- ${AUTH_GATE}`,
        "lifecycle-version-negotiate":
          "PASS: Server rejected unknown version with error: -32600 — Invalid Request: Server already initialized",
        "error-unknown-method": `FAIL: HTTP 401, JSON-RPC error -32001 on nonexistent/method -- ${AUTH_GATE}`,
      });
    } finally {
      await sdk.stop();
    }
  }, 30000);

  it("a rate limiter's 429 on every request without the token: resent once, then not evaluable (before: two passes)", async () => {
    const sdk = await startSdkBehind(rateLimitingGateway);
    try {
      const report = await runComplianceSuite(sdk.url, { timeout: 3000, specVersion: "2025-11-25", only: NEGATIVE });
      const limiter = "not evaluable: a rate limiter answered before the server read the request, so";
      const handshake =
        "not evaluable: the initialize handshake was not served either (HTTP 429), so this rejection proves nothing about";
      expect(verdicts(report)).toEqual({
        "transport-content-type-reject": `FAIL: HTTP 429, then after 0ms HTTP 429 on the text/plain POST -- ${limiter} the Content-Type was never looked at`,
        "transport-batch-reject": `FAIL: HTTP 429, then after 0ms HTTP 429 on the batch -- ${limiter} the batch was never looked at`,
        "lifecycle-version-negotiate": `FAIL: HTTP 429, then after 0ms HTTP 429 on the initialize requesting protocol version 2099-01-01 -- ${handshake} the unknown version (see lifecycle-init)`,
        "error-unknown-method": `FAIL: HTTP 429, then after 0ms HTTP 429 on nonexistent/method -- ${handshake} the unknown method (see lifecycle-init)`,
      });
    } finally {
      await sdk.stop();
    }
  }, 30000);
});

describe("integration — the legacy error checks and lifecycle-jsonrpc do not credit an auth gate's envelope as the server's", () => {
  // error-invalid-jsonrpc, error-invalid-json, error-missing-params and
  // error-capability-gated pass on a JSON-RPC error; lifecycle-jsonrpc passes
  // on a valid envelope. A gate in front of the SDK server writes a valid
  // -32001 envelope on every refusal without the server ever seeing the
  // request.
  const CHECKS = [
    "lifecycle-jsonrpc",
    "error-invalid-jsonrpc",
    "error-invalid-json",
    "error-missing-params",
    "error-capability-gated",
  ];
  const verdicts = (report: Awaited<ReturnType<typeof runComplianceSuite>>) =>
    Object.fromEntries(report.tests.map((t) => [t.id, `${t.passed ? "PASS" : "FAIL"}: ${t.details}`]));
  const AUTH_GATE = "not evaluable: an auth gate answered before the server read the request (pass --auth)";
  const RPC_401 = "HTTP 401, JSON-RPC error -32001";

  it("the auth-requiring server without --auth: its 401 on every request is not five answers of the server's (before: five passes)", async () => {
    // Before: PASS "Valid JSON-RPC 2.0 response", PASS "Error code: -32001 —
    // Unauthorized" three times, PASS "Tested 3 undeclared method(s) ... all
    // returned errors".
    const report = await runComplianceSuite(serverUrl, { timeout: 3000, specVersion: "2025-11-25", only: CHECKS });
    const handshake = (what: string) =>
      `not evaluable: the initialize handshake was not served either (${RPC_401}), so this rejection proves nothing about ${what} (see lifecycle-init)`;
    expect(verdicts(report)).toEqual({
      "lifecycle-jsonrpc": `FAIL: ${RPC_401} on the initialize handshake -- ${AUTH_GATE}`,
      "error-invalid-jsonrpc": `FAIL: ${RPC_401} on the malformed JSON-RPC message -- ${handshake("the malformed JSON-RPC message")}`,
      "error-invalid-json": `FAIL: ${RPC_401} on the invalid JSON body -- ${handshake("the invalid JSON body")}`,
      "error-missing-params": `FAIL: ${RPC_401} on tools/call without a name -- ${handshake("the missing tool name")}`,
      "error-capability-gated": `FAIL: tools/list -> ${RPC_401}, resources/list -> ${RPC_401}, prompts/list -> ${RPC_401} -- not evaluable: the initialize handshake was not served (${RPC_401}), so the suite never saw which capabilities the server declares, and these answers prove nothing about undeclared methods (see lifecycle-init)`,
    });
  }, 30000);

  it("the same server with the valid token: the server's own answers keep their PASSes", async () => {
    const report = await runComplianceSuite(serverUrl, {
      timeout: 3000,
      specVersion: "2025-11-25",
      headers: authHeaders(),
      only: CHECKS,
    });
    const byId = verdicts(report);
    expect(byId["error-missing-params"]).toMatch(/^PASS: Error code: -32603 — \[/);
    delete byId["error-missing-params"];
    expect(byId).toEqual({
      "lifecycle-jsonrpc": "PASS: Valid JSON-RPC 2.0 response",
      "error-invalid-jsonrpc": "PASS: Error code: -32700 — Parse error: Invalid JSON-RPC message",
      "error-invalid-json": "PASS: Error code: -32700 — Parse error",
      "error-capability-gated":
        "PASS: Tested 2 undeclared method(s): resources/list, prompts/list — all returned errors",
    });
  }, 30000);

  it("a gateway that exempts initialize: the four error checks' 401s are the gateway's (before: four passes)", async () => {
    const sdk = await startSdkBehind(initializeExemptGateway);
    try {
      const report = await runComplianceSuite(sdk.url, { timeout: 3000, specVersion: "2025-11-25", only: CHECKS });
      expect(report.serverInfo.name).toBe("auth-test-server");
      expect(verdicts(report)).toEqual({
        "lifecycle-jsonrpc": "PASS: Valid JSON-RPC 2.0 response",
        "error-invalid-jsonrpc": `FAIL: ${RPC_401} on the malformed JSON-RPC message -- ${AUTH_GATE}`,
        "error-invalid-json": `FAIL: ${RPC_401} on the invalid JSON body -- ${AUTH_GATE}`,
        "error-missing-params": `FAIL: ${RPC_401} on tools/call without a name -- ${AUTH_GATE}`,
        "error-capability-gated": `FAIL: ${RPC_401} on resources/list -- ${AUTH_GATE}; ${RPC_401} on prompts/list -- ${AUTH_GATE}`,
      });
    } finally {
      await sdk.stop();
    }
  }, 30000);

  it("a rate limiter's 429 on every request without the token: not evaluable (before: three passes)", async () => {
    const sdk = await startSdkBehind(rateLimitingGateway);
    try {
      const report = await runComplianceSuite(sdk.url, { timeout: 3000, specVersion: "2025-11-25", only: CHECKS });
      const handshake = (what: string) =>
        `not evaluable: the initialize handshake was not served either (HTTP 429), so this rejection proves nothing about ${what} (see lifecycle-init)`;
      const twice = "HTTP 429, then after 0ms HTTP 429";
      expect(verdicts(report)).toEqual({
        "lifecycle-jsonrpc":
          "FAIL: HTTP 429 on the initialize handshake -- not evaluable: a rate limiter answered before the server read the request, so the initialize request was never looked at",
        "error-invalid-jsonrpc": `FAIL: ${twice} on the malformed JSON-RPC message -- ${handshake("the malformed JSON-RPC message")}`,
        "error-invalid-json": `FAIL: ${twice} on the invalid JSON body -- ${handshake("the invalid JSON body")}`,
        "error-missing-params": `FAIL: ${twice} on tools/call without a name -- ${handshake("the missing tool name")}`,
        "error-capability-gated":
          "FAIL: tools/list -> HTTP 429, resources/list -> HTTP 429, prompts/list -> HTTP 429 -- not evaluable: the initialize handshake was not served (HTTP 429), so the suite never saw which capabilities the server declares, and these answers prove nothing about undeclared methods (see lifecycle-init)",
      });
    } finally {
      await sdk.stop();
    }
  }, 30000);
});
