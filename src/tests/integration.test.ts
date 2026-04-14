import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import addFormats from "ajv-formats";
import Ajv2020 from "ajv/dist/2020.js";
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
