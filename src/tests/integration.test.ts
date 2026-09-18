import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { runComplianceSuite } from "../runner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const reportSchema = JSON.parse(readFileSync(resolve(__dirname, "../../schemas/report.v1.json"), "utf8"));
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
const validateReport = ajv.compile(reportSchema);

let server: Server;
let serverUrl: string;

/**
 * Create a minimal but spec-compliant MCP server for integration testing.
 */
function createTestMcpServer(): McpServer {
  const mcp = new McpServer({
    name: "integration-test-server",
    version: "1.0.0",
  });

  mcp.tool(
    "echo",
    "Echoes back the input",
    { message: z.string().optional().describe("Message to echo") },
    async ({ message }) => ({
      content: [{ type: "text", text: String(message ?? "no message") }],
    }),
  );

  mcp.resource("hello", "file:///test/hello.txt", async () => ({
    contents: [{ uri: "file:///test/hello.txt", text: "Hello, world!" }],
  }));

  mcp.prompt("greeting", "A simple greeting prompt", async () => ({
    messages: [{ role: "user" as const, content: { type: "text" as const, text: "Hello!" } }],
  }));

  return mcp;
}

beforeAll(async () => {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  server = createServer(async (req, res) => {
    // Get or create transport for this session
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (req.method === "DELETE") {
      if (sessionId && transports.has(sessionId)) {
        const transport = transports.get(sessionId)!;
        await transport.close();
        transports.delete(sessionId);
        res.writeHead(200);
        res.end();
      } else {
        res.writeHead(sessionId ? 404 : 400);
        res.end();
      }
      return;
    }

    // For POST requests, check if we have an existing session
    if (sessionId && transports.has(sessionId)) {
      const transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res);
      return;
    }

    // No session or unknown session — create new transport for initialization
    if (req.method === "POST") {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          transports.delete(transport.sessionId);
        }
      };

      const mcp = createTestMcpServer();
      await mcp.connect(transport);

      await transport.handleRequest(req, res);
      if (transport.sessionId) {
        transports.set(transport.sessionId, transport);
      }
      return;
    }

    res.writeHead(405);
    res.end();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        serverUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

describe("integration — full compliance suite against real server", () => {
  it("passes all required tests", async () => {
    const report = await runComplianceSuite(serverUrl, { timeout: 3000 });
    // All required tests must pass
    const requiredFails = report.tests.filter((t) => t.required && !t.passed);
    if (requiredFails.length > 0) {
      const details = requiredFails.map((t) => `  ${t.id}: ${t.details}`).join("\n");
      throw new Error(`Required tests failed:\n${details}`);
    }
    expect(report.overall).not.toBe("fail");
  }, 30000);

  it("returns a valid report structure", async () => {
    const report = await runComplianceSuite(serverUrl, { timeout: 3000 });

    expect(report.specVersion).toBe("2025-11-25");
    expect(report.score).toBeGreaterThan(0);
    expect(["A", "B", "C", "D", "F"]).toContain(report.grade);
    expect(report.serverInfo.name).toBe("integration-test-server");
    expect(report.serverInfo.version).toBe("1.0.0");
    expect(report.toolCount).toBeGreaterThan(0);
    expect(report.toolNames).toContain("echo");
    expect(report.resourceCount).toBeGreaterThan(0);
    expect(report.promptCount).toBeGreaterThan(0);
  }, 30000);

  it("runs all 88 tests", async () => {
    const report = await runComplianceSuite(serverUrl, { timeout: 3000 });
    // Should run a significant number of tests (all 88 tests including security)
    expect(report.tests.length).toBeGreaterThanOrEqual(71);
  }, 30000);

  it("lifecycle-progress-token actually exercises a tool (it used to run before tools/list and always skip)", async () => {
    const report = await runComplianceSuite(serverUrl, { timeout: 3000 });
    const t = report.tests.find((x) => x.id === "lifecycle-progress-token");
    expect(t).toBeDefined();
    expect(t?.passed).toBe(true);
    expect(t?.details).not.toMatch(/No tools available/);
    // The SDK answers a POST whose Accept lacks application/json with 406
    // and never calls the tool; the details must show the call was served.
    expect(t?.details).toBe("Server accepted request with progressToken (no progress events observed — optional)");
  }, 30000);

  it("security-cors-headers keeps its verdict on the SDK server", async () => {
    // The SDK server answers the OPTIONS preflight (405, no CORS headers)
    // and serves the ping carrying the foreign Origin (200, none either):
    // reading both probes, and one that got no answer, the 2026-07-28 way
    // changes nothing but the details for a server that answers them.
    const report = await runComplianceSuite(serverUrl, {
      timeout: 3000,
      specVersion: "2025-11-25",
      only: ["security-cors-headers"],
    });
    const t = report.tests.find((x) => x.id === "security-cors-headers");
    expect({ passed: t?.passed, details: t?.details }).toEqual({
      passed: true,
      details: "No CORS headers returned (OPTIONS HTTP 405, POST HTTP 200; server-to-server only, acceptable)",
    });
  }, 30000);

  it("security-auth-required and security-oversized-input keep their verdicts on the SDK server", async () => {
    // No auth at all: the unauthenticated preflight was served (a JSON-RPC
    // 400, not a 401/403). The 1 MB tools/call is answered over SSE with a
    // result, which the check now parses through the transport instead of
    // passing any status below 400 unread.
    const report = await runComplianceSuite(serverUrl, {
      timeout: 3000,
      only: ["tools-list", "security-auth-required", "security-oversized-input"],
    });
    const verdict = (id: string) => {
      const t = report.tests.find((x) => x.id === id);
      return { passed: t?.passed, details: t?.details };
    };
    expect(verdict("security-auth-required")).toEqual({
      passed: false,
      details: "Server does not require auth (no --auth provided and server accepted unauthenticated requests)",
    });
    // The SDK completes the call (zod strips the unknown `data` argument),
    // so it passes as having survived the megabyte, with the warning the
    // 2026-07-28 suite gives the same result. Before: "HTTP 200 — server
    // handled 1MB payload without crashing", with no warning.
    expect(verdict("security-oversized-input")).toEqual({
      passed: true,
      details: "HTTP 200, result -- server processed a 1 MB echo.data without rejecting it (survived)",
    });
    expect(report.warnings.filter((w) => w.startsWith("security-oversized-input"))).toEqual([
      "security-oversized-input: the server completed a tools/call carrying a 1 MB string argument (echo.data) instead of rejecting it; enforce a request body limit (413) or maxLength in inputSchema.",
    ]);
  }, 30000);

  it("security-extra-params and security-rate-limiting keep their verdicts on the SDK server", async () => {
    // The SDK answers the unknown arguments with a result (zod strips them)
    // and every ping of the burst with 200: reading the status and the
    // transport error the 2026-07-28 way changes neither verdict.
    const report = await runComplianceSuite(serverUrl, {
      timeout: 3000,
      only: ["tools-list", "security-extra-params", "security-rate-limiting"],
    });
    const verdicts = Object.fromEntries(report.tests.map((t) => [t.id, `${t.passed ? "PASS" : "FAIL"}: ${t.details}`]));
    expect(verdicts["security-extra-params"]).toBe("PASS: Server processed request (extra params likely ignored)");
    expect(verdicts["security-rate-limiting"]).toBe(
      "FAIL: No rate limiting detected (50 rapid requests all returned 200)",
    );
    expect(
      report.warnings.filter((w) => w.startsWith("security-extra-params") || w.startsWith("security-rate-limiting")),
    ).toEqual([]);
  }, 30000);

  it("the checks that used to swallow a transport error keep their verdicts on the SDK server", async () => {
    // Every one of these answered its probe, so reading the failure the
    // 2026-07-28 way changes nothing: the server rejects the duplicate
    // initialize, the auth probes have no credential to strip, and the
    // foreign Origin is accepted (the SDK's DNS-rebinding protection is
    // off by default in this setup).
    const report = await runComplianceSuite(serverUrl, {
      timeout: 3000,
      only: [
        "lifecycle-reinit-reject",
        "security-www-authenticate",
        "security-auth-malformed",
        "security-session-not-auth",
        "security-token-in-uri",
        "security-origin-validation",
      ],
    });
    const verdicts = Object.fromEntries(report.tests.map((t) => [t.id, `${t.passed ? "PASS" : "FAIL"}: ${t.details}`]));
    expect(verdicts).toEqual({
      "lifecycle-reinit-reject":
        "PASS: Re-initialization rejected with error: -32600 — Invalid Request: Server already initialized",
      "security-www-authenticate": "PASS: Skipped: no --auth provided",
      "security-auth-malformed": "PASS: Skipped: no --auth provided",
      "security-session-not-auth": "PASS: Skipped: no --auth provided",
      "security-token-in-uri": "PASS: Skipped: no --auth provided",
      "security-origin-validation":
        "FAIL: HTTP 200 — server accepted request with untrusted Origin header (spec: MUST validate Origin for DNS rebinding protection)",
    });
  }, 30000);

  it("the negative probes that now read a gate's answer as not evaluable keep their verdicts on the SDK server", async () => {
    // Each probe is answered by the SDK itself -- a 415, a 400, a JSON-RPC
    // -32600, a -32601 -- next to a served handshake, so attributing the
    // rejection changes nothing, and no twin request is sent.
    const report = await runComplianceSuite(serverUrl, {
      timeout: 3000,
      only: [
        "transport-content-type-reject",
        "transport-batch-reject",
        "lifecycle-version-negotiate",
        "error-unknown-method",
      ],
    });
    const verdicts = Object.fromEntries(report.tests.map((t) => [t.id, `${t.passed ? "PASS" : "FAIL"}: ${t.details}`]));
    expect(verdicts).toEqual({
      "transport-content-type-reject": "PASS: HTTP 415 (incorrect Content-Type rejected)",
      "transport-batch-reject": "PASS: HTTP 400 (batch rejected)",
      "lifecycle-version-negotiate":
        "PASS: Server rejected unknown version with error: -32600 — Invalid Request: Server already initialized",
      "error-unknown-method": "PASS: Error code: -32601 (correct: Method not found) — Method not found",
    });
  }, 30000);

  it("the error checks and lifecycle-jsonrpc, which now read a gate's answer as not evaluable, keep their verdicts on the SDK server", async () => {
    // The SDK answers each probe itself next to a served handshake: a 400
    // with -32700 for the malformed message and the invalid JSON, a -32603
    // on 200 for tools/call without a name (its zod error), so attributing
    // the answer changes nothing. The server declares all three
    // capabilities, so error-capability-gated has nothing to probe.
    const report = await runComplianceSuite(serverUrl, {
      timeout: 3000,
      only: [
        "lifecycle-jsonrpc",
        "error-invalid-jsonrpc",
        "error-invalid-json",
        "error-missing-params",
        "error-capability-gated",
      ],
    });
    const verdicts = Object.fromEntries(report.tests.map((t) => [t.id, `${t.passed ? "PASS" : "FAIL"}: ${t.details}`]));
    expect(verdicts["error-missing-params"]).toMatch(/^PASS: Error code: -32603 — \[/);
    delete verdicts["error-missing-params"];
    expect(verdicts).toEqual({
      "lifecycle-jsonrpc": "PASS: Valid JSON-RPC 2.0 response",
      "error-invalid-jsonrpc": "PASS: Error code: -32700 — Parse error: Invalid JSON-RPC message",
      "error-invalid-json": "PASS: Error code: -32700 — Parse error: Invalid JSON",
      "error-capability-gated":
        "PASS: Server declares all capabilities (tools, resources, prompts) — no undeclared methods to test",
    });
    expect(report.warnings.filter((w) => /^(lifecycle-jsonrpc|error-)/.test(w))).toEqual([]);
  }, 30000);

  it("the passes that measured nothing are the flagged ones, and nothing the server was measured on is flagged", async () => {
    const report = await runComplianceSuite(serverUrl, { timeout: 3000 });
    const flagged = report.tests.filter((t) => t.skipped).map((t) => t.id);
    expect(flagged).toEqual([
      "lifecycle-logging",
      "lifecycle-completions",
      "transport-sse-event-field",
      // The server declares tools, resources and prompts, so there is no
      // undeclared method to probe. Before: a plain pass.
      "error-capability-gated",
      "security-www-authenticate",
      "security-auth-malformed",
      "security-session-not-auth",
      "security-oauth-metadata",
      "security-token-in-uri",
      "security-ssrf-internal",
      "security-tool-cross-reference",
    ]);
    expect(report.summary.skipped).toBe(flagged.length);
    expect(report.categories.security.skipped).toBe(7);
    // A failure is never flagged.
    expect(report.tests.filter((t) => !t.passed && t.skipped !== undefined)).toEqual([]);
    // The checks with something to judge on this server keep their verdicts, unflagged.
    const view = (id: string) => {
      const t = report.tests.find((x) => x.id === id);
      return { passed: t?.passed, skipped: t?.skipped, details: t?.details };
    };
    expect(view("tools-schema")).toEqual({
      passed: true,
      skipped: undefined,
      details: "All tools have valid schemas",
    });
    expect(view("resources-schema")).toEqual({ passed: true, skipped: undefined, details: "All resources valid" });
    expect(view("prompts-schema")).toEqual({ passed: true, skipped: undefined, details: "All prompts valid" });
    expect(view("tools-content-types")).toEqual({ passed: true, skipped: undefined, details: "Content types: text" });
    expect(view("security-error-no-stacktrace")).toEqual({
      passed: true,
      skipped: undefined,
      details: "3 error responses checked — no stack traces or sensitive data found",
    });
    expect(view("security-error-no-internal-ip")).toEqual({
      passed: true,
      skipped: undefined,
      details: "No internal IP addresses found in error responses",
    });
    expect(view("security-command-injection")).toEqual({
      passed: true,
      skipped: undefined,
      details:
        "Tested 5 payloads against echo.message — no command execution detected (0 rejected, 5 returned without it)",
    });
  }, 30000);

  it("has no preflight warning for reachable server", async () => {
    const report = await runComplianceSuite(serverUrl, { timeout: 3000 });
    expect(report.warnings.some((w) => w.includes("unreachable"))).toBe(false);
  }, 30000);

  it("real report validates against schemas/report.v1.json", async () => {
    const report = await runComplianceSuite(serverUrl, { timeout: 3000 });
    const ok = validateReport(report);
    if (!ok) {
      // Surface the validator errors so drift is obvious — without this,
      // a missing field would just show as `false` and require manual digging.
      throw new Error(
        `Real CLI output does not match report.v1 schema:\n${JSON.stringify(validateReport.errors, null, 2)}`,
      );
    }
    expect(ok).toBe(true);
  }, 30000);

  it("produces deterministic output (modulo timings/timestamps)", async () => {
    const [a, b] = await Promise.all([
      runComplianceSuite(serverUrl, { timeout: 3000 }),
      runComplianceSuite(serverUrl, { timeout: 3000 }),
    ]);

    const stripVolatile = (report: typeof a) => ({
      ...report,
      timestamp: "FIXED",
      tests: report.tests.map((t) => ({ ...t, durationMs: 0 })),
    });

    const aStable = stripVolatile(a);
    const bStable = stripVolatile(b);

    // The two runs must agree on grade, score, per-test pass/fail, and every
    // structural field. Any drift here is a determinism bug that would make
    // leaderboards unstable.
    expect(bStable.grade).toBe(aStable.grade);
    expect(bStable.score).toBe(aStable.score);
    expect(bStable.overall).toBe(aStable.overall);
    expect(bStable.summary).toEqual(aStable.summary);
    expect(bStable.categories).toEqual(aStable.categories);
    expect(bStable.tests.map((t) => [t.id, t.passed])).toEqual(aStable.tests.map((t) => [t.id, t.passed]));
    // Warnings are content-deterministic: every push site uses static text
    // or stable identifiers (tool names, status codes, version numbers).
    // Drift here means a non-deterministic warning crept in.
    expect([...bStable.warnings].sort()).toEqual([...aStable.warnings].sort());
  }, 60000);
});

/**
 * The same SDK server with the transport's own DNS-rebinding protection on
 * (StreamableHTTPServerTransport's enableDnsRebindingProtection), given the
 * Host values it allows for the port it listens on. An Origin it does not
 * list draws the SDK's 403 "Invalid Origin header: ..."; a Host it does not
 * list draws 403 "Invalid Host header: ..." on every request, the way a
 * server reached through a tunnel or proxy hostname answers.
 */
async function startGuardedSdkServer(
  allowedHosts: (port: number) => string[],
): Promise<{ url: string; port: number; stop(): Promise<void> }> {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  let port = 0;
  const guarded = createServer(async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const existing = sessionId ? transports.get(sessionId) : undefined;
    if (existing) {
      await existing.handleRequest(req, res);
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end();
      return;
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableDnsRebindingProtection: true,
      allowedHosts: allowedHosts(port),
      allowedOrigins: ["http://localhost"],
    });
    await createTestMcpServer().connect(transport);
    await transport.handleRequest(req, res);
    if (transport.sessionId) transports.set(transport.sessionId, transport);
  });
  await new Promise<void>((resolve) => guarded.listen(0, "127.0.0.1", resolve));
  const addr = guarded.address();
  port = addr && typeof addr === "object" ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    async stop() {
      for (const t of transports.values()) await t.close().catch(() => {});
      guarded.closeAllConnections();
      await new Promise<void>((resolve) => guarded.close(() => resolve()));
    },
  };
}

describe("integration — the SDK's DNS-rebinding protection, read by the 2025-11-25 suite", () => {
  const ORIGIN = "security-origin-validation";
  const RATE = "security-rate-limiting";

  async function verdicts(allowedHosts: (port: number) => string[]) {
    const guarded = await startGuardedSdkServer(allowedHosts);
    try {
      const report = await runComplianceSuite(guarded.url, {
        timeout: 3000,
        specVersion: "2025-11-25",
        only: ["tools-list", ORIGIN, RATE],
      });
      return {
        port: guarded.port,
        name: report.serverInfo.name,
        byId: Object.fromEntries(report.tests.map((t) => [t.id, `${t.passed ? "PASS" : "FAIL"}: ${t.details}`])),
      };
    } finally {
      await guarded.stop();
    }
  }

  it("the Origin guard refusing the foreign Origin next to the served handshake keeps its PASS", async () => {
    const { name, byId } = await verdicts((port) => [`127.0.0.1:${port}`]);
    expect(name).toBe("integration-test-server");
    expect(byId[ORIGIN]).toBe("PASS: HTTP 403 (suspicious Origin rejected)");
    expect(byId[RATE]).toBe("FAIL: No rate limiting detected (50 rapid requests all returned 200)");
  }, 30000);

  it("the Host guard refusing every request: the Origin check skips, and the burst is not read as a missing limiter", async () => {
    // Before: origin-validation PASSED "HTTP 403 (suspicious Origin
    // rejected)" -- the Host guard's answer to every request, the Origin
    // never looked at -- and rate-limiting FAILED "No rate limiting
    // detected (50 rapid requests all returned 403)".
    const { port, name, byId } = await verdicts(() => ["mcp.example.com"]);
    expect(name).toBeNull();
    expect(byId[ORIGIN]).toBe(
      "PASS: Skipped: HTTP 403 to the foreign Origin, but initialize was not served either, so the refusal is not attributable to the Origin (see security-auth-required)",
    );
    expect(byId[RATE]).toBe(
      `FAIL: HTTP 403 ("Invalid Host header: 127.0.0.1:${port}") on all 50 rapid pings, which does not read as an auth refusal -- not evaluable: it may be Host/Origin validation or a gateway refusing every request before the server reads it, so rate limiting was not measured (see security-auth-required)`,
    );
  }, 30000);
});

describe("integration — the negative probes behind the SDK's Host guard, read by the 2025-11-25 suite", () => {
  const NEGATIVE = [
    "transport-content-type-reject",
    "transport-batch-reject",
    "lifecycle-version-negotiate",
    "error-unknown-method",
  ];

  async function verdicts(allowedHosts: (port: number) => string[]) {
    const guarded = await startGuardedSdkServer(allowedHosts);
    try {
      const report = await runComplianceSuite(guarded.url, {
        timeout: 3000,
        specVersion: "2025-11-25",
        only: NEGATIVE,
      });
      return {
        port: guarded.port,
        byId: Object.fromEntries(report.tests.map((t) => [t.id, `${t.passed ? "PASS" : "FAIL"}: ${t.details}`])),
      };
    } finally {
      await guarded.stop();
    }
  }

  it("a Host guard refusing every request: none of the four credits its 403 (before: four passes)", async () => {
    // Before: PASS "HTTP 403 (incorrect Content-Type rejected)", PASS "HTTP
    // 403 (batch rejected)", PASS "Server rejected unknown version with error:
    // -32000 — Invalid Host header: ..." and PASS "Error code: -32000
    // (expected -32601) — Invalid Host header: ..." -- the guard's answer to
    // every request, the defect never looked at.
    const { port, byId } = await verdicts(() => ["mcp.example.com"]);
    const guard = `("Invalid Host header: 127.0.0.1:${port}") -- not evaluable: the message names Host/Origin validation, which refuses a request whatever it carries`;
    const handshake =
      "not evaluable: the initialize handshake was not served either (HTTP 403, JSON-RPC error -32000), so this rejection proves nothing about";
    expect(byId).toEqual({
      "transport-content-type-reject": `FAIL: HTTP 403, JSON-RPC error -32000 on the text/plain POST ${guard}`,
      "transport-batch-reject": `FAIL: HTTP 403, JSON-RPC error -32000 on the batch ${guard}`,
      "lifecycle-version-negotiate": `FAIL: HTTP 403, JSON-RPC error -32000 on the initialize requesting protocol version 2099-01-01 -- ${handshake} the unknown version (see lifecycle-init)`,
      "error-unknown-method": `FAIL: HTTP 403, JSON-RPC error -32000 on nonexistent/method -- ${handshake} the unknown method (see lifecycle-init)`,
    });
  }, 30000);

  it("the same guard allowing the Host the run uses: the SDK's own answers keep their PASSes", async () => {
    const { byId } = await verdicts((port) => [`127.0.0.1:${port}`]);
    expect(byId).toEqual({
      "transport-content-type-reject": "PASS: HTTP 415 (incorrect Content-Type rejected)",
      "transport-batch-reject": "PASS: HTTP 400 (batch rejected)",
      "lifecycle-version-negotiate":
        "PASS: Server rejected unknown version with error: -32600 — Invalid Request: Server already initialized",
      "error-unknown-method": "PASS: Error code: -32601 (correct: Method not found) — Method not found",
    });
  }, 30000);
});
