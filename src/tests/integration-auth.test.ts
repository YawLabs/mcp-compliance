import { randomUUID } from "node:crypto";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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

let server: Server;
let serverUrl: string;

/**
 * Records the Authorization header value the server received for every
 * non-initialize POST whose JSON-RPC method is `ping`. The auth-stripping
 * security tests all probe with `ping`, so this captures exactly what the
 * "stripped" requests carried on the wire.
 */
const pingAuthHeaders: Array<string | undefined> = [];

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
    expect(t?.details).toMatch(/401|403/);
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
});
