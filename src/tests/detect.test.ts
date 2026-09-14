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
import { classifyDiscoverResponse } from "../detect.js";
import { runComplianceSuite } from "../runner.js";
import { AUTO_DETECT_NOTE_PREFIX, LEGACY_SPEC_VERSION, MODERN_SPEC_VERSION } from "../spec.js";
import type { TransportResponse } from "../transport/index.js";
import type { ComplianceReport, TransportTarget } from "../types.js";
import {
  type HttpFixture,
  LEGACY_ECHO_FIXTURE,
  LEGACY_SILENT_FIXTURE,
  resultOf,
  startHttpFixture,
  stdioFixture,
} from "./helpers/modern-fixture.js";

/**
 * Era detection end to end: `runComplianceSuite` with the default
 * `specVersion: "auto"` against every kind of server the spec's
 * dual-era client rules distinguish (basic/versioning#backward-compatibility,
 * basic/transports/stdio#backward-compatibility), plus the pinned
 * overrides and the classification rule on its own.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const reportSchema = JSON.parse(readFileSync(resolve(__dirname, "../../schemas/report.v1.json"), "utf8"));
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
const validateReport = ajv.compile(reportSchema);

const DEAD_URL = "http://127.0.0.1:1/mcp";

const legacyStdio = (fixture: string): TransportTarget => ({
  type: "stdio",
  command: process.execPath,
  args: [fixture],
});

/** The single auto-detection note, or every warning when it is not exactly one. */
function autoNote(report: ComplianceReport): string {
  const notes = report.warnings.filter((w) => w.startsWith(AUTO_DETECT_NOTE_PREFIX));
  expect(notes, `warnings: ${JSON.stringify(report.warnings, null, 2)}`).toHaveLength(1);
  return notes[0];
}

function expectNoAutoNote(report: ComplianceReport) {
  expect(report.warnings.filter((w) => w.startsWith(AUTO_DETECT_NOTE_PREFIX))).toEqual([]);
}

/**
 * The SDK v1 sessionful Streamable HTTP server from integration.test.ts:
 * a plain 2025-11-25 server that answers the modern probe with a 400 and
 * a JSON-RPC -32000 ("server not initialized").
 */
function createSdkV1Server(): McpServer {
  const mcp = new McpServer({ name: "detect-sdk-v1", version: "1.0.0" });
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

async function startSdkV1(): Promise<{ server: Server; url: string }> {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const server = createServer(async (req, res) => {
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
    if (sessionId && transports.has(sessionId)) {
      await transports.get(sessionId)!.handleRequest(req, res);
      return;
    }
    if (req.method === "POST") {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId);
      };
      const mcp = createSdkV1Server();
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
      if (transport.sessionId) transports.set(transport.sessionId, transport);
      return;
    }
    res.writeHead(405);
    res.end();
  });
  const url = await new Promise<string>((done) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      done(`http://127.0.0.1:${addr && typeof addr === "object" ? addr.port : 0}`);
    });
  });
  return { server, url };
}

describe("auto-detection: modern fixture", () => {
  let http: HttpFixture;

  beforeAll(async () => {
    http = await startHttpFixture();
  });

  afterAll(async () => {
    await http.stop();
  });

  it("HTTP: the preflight probe resolves 2026-07-28 and the header note says so", async () => {
    const report = await runComplianceSuite(http.target, { timeout: 5000, only: ["lifecycle-discover"] });
    expect(report.specVersion).toBe(MODERN_SPEC_VERSION);
    expect(report.serverInfo.protocolVersion).toBe(MODERN_SPEC_VERSION);
    expect(report.serverInfo.name).toBe("modern-fixture");
    const note = autoNote(report);
    expect(note).toMatch(
      /^Spec version auto-detected as 2026-07-28 \(server\/discover returned supportedVersions \[2026-07-28\]\)/,
    );
    expect(note).toContain("Pin with --spec-version to override.");
    expect(report.warnings.some((w) => w.includes("unreachable"))).toBe(false);
    expect(resultOf(report, "lifecycle-discover").passed).toBe(true);
  });

  it("stdio: the first exchange is the probe and resolves 2026-07-28", async () => {
    const report = await runComplianceSuite(stdioFixture().target, {
      timeout: 5000,
      startupTimeout: 10_000,
      only: ["lifecycle-discover"],
    });
    expect(report.specVersion).toBe(MODERN_SPEC_VERSION);
    expect(autoNote(report)).toContain("server/discover returned supportedVersions [2026-07-28]");
    expect(resultOf(report, "lifecycle-discover").passed).toBe(true);
    expect(report.url).toMatch(/^stdio:/);
  });

  it("pinned 2025-11-25 against the modern-only fixture: the legacy suite runs and its handshake fails", async () => {
    const report = await runComplianceSuite(http.target, {
      timeout: 5000,
      specVersion: LEGACY_SPEC_VERSION,
      only: ["lifecycle-init", "lifecycle-proto-version", "transport-post"],
    });
    expect(report.specVersion).toBe(LEGACY_SPEC_VERSION);
    expectNoAutoNote(report);
    expect(report.tests.map((t) => t.id)).toEqual(["transport-post", "lifecycle-init", "lifecycle-proto-version"]);
    const init = resultOf(report, "lifecycle-init");
    expect(init.passed, init.details).toBe(false);
    // The fixture answers initialize with -32601 naming its era; the legacy
    // suite only reports that no result came back (runner.ts lifecycle-init
    // does not surface the error body).
    expect(init.details).toBe("No result in response");
    expect(resultOf(report, "lifecycle-proto-version").passed).toBe(false);
    expect(report.serverInfo.protocolVersion).toBeNull();
    expect(report.overall).toBe("fail");
  });

  it("--only with a legacy id under auto: the miss is named and no test runs", async () => {
    const report = await runComplianceSuite(http.target, { timeout: 5000, only: ["lifecycle-init"] });
    expect(report.specVersion).toBe(MODERN_SPEC_VERSION);
    expect(report.tests).toEqual([]);
    const miss = report.warnings.find((w) => w.startsWith("Filter value(s)"));
    expect(miss, JSON.stringify(report.warnings)).toBeDefined();
    expect(miss).toContain('"lifecycle-init"');
    expect(miss).toContain("match no test id or category in the 2026-07-28 catalog");
    expect(miss).toContain("--list --spec-version 2026-07-28");
  });
});

describe("auto-detection: legacy stdio fixtures", () => {
  it("echo fixture answers the probe with -32601: legacy, reason names the code", async () => {
    const report = await runComplianceSuite(legacyStdio(LEGACY_ECHO_FIXTURE), {
      timeout: 5000,
      startupTimeout: 10_000,
      only: ["lifecycle-init", "lifecycle-ping"],
    });
    expect(report.specVersion).toBe(LEGACY_SPEC_VERSION);
    expect(autoNote(report)).toMatch(
      /^Spec version auto-detected as 2025-11-25 \(server\/discover probe returned JSON-RPC error -32601; treating the server as legacy\)/,
    );
    expect(resultOf(report, "lifecycle-init").passed).toBe(true);
    expect(resultOf(report, "lifecycle-ping").passed).toBe(true);
    expect(report.serverInfo.name).toBe("echo-fixture");
    expect(report.serverInfo.protocolVersion).toBe(LEGACY_SPEC_VERSION);
  });

  it("silent fixture never answers the probe: legacy on timeout, and the handshake still succeeds", async () => {
    const started = Date.now();
    const report = await runComplianceSuite(legacyStdio(LEGACY_SILENT_FIXTURE), {
      timeout: 5000,
      startupTimeout: 1500,
      only: ["lifecycle-init", "lifecycle-ping"],
    });
    const elapsed = Date.now() - started;
    expect(report.specVersion).toBe(LEGACY_SPEC_VERSION);
    expect(autoNote(report)).toMatch(
      /^Spec version auto-detected as 2025-11-25 \(server\/discover probe got no response; treating the server as legacy\)/,
    );
    // Fallback on a timeout, not on a code: the spec forbids keying the
    // fallback to one error and allows a legacy server to stay silent.
    const init = resultOf(report, "lifecycle-init");
    expect(init.passed, init.details).toBe(true);
    expect(resultOf(report, "lifecycle-ping").passed).toBe(true);
    expect(report.serverInfo.name).toBe("legacy-silent-fixture");
    // Detection cost is bounded by the startup timeout (plus spawn + suite).
    expect(elapsed).toBeGreaterThanOrEqual(1500);
    expect(elapsed).toBeLessThan(10_000);
  }, 20_000);

  it("pinned 2026-07-28 against the echo fixture: the modern suite runs and discover fails", async () => {
    const report = await runComplianceSuite(legacyStdio(LEGACY_ECHO_FIXTURE), {
      timeout: 5000,
      startupTimeout: 10_000,
      specVersion: MODERN_SPEC_VERSION,
      only: ["lifecycle-discover", "lifecycle-dual-era"],
    });
    expect(report.specVersion).toBe(MODERN_SPEC_VERSION);
    expectNoAutoNote(report);
    expect(report.tests.map((t) => t.id)).toEqual(["lifecycle-discover", "lifecycle-dual-era"]);
    const discover = resultOf(report, "lifecycle-discover");
    expect(discover.passed, discover.details).toBe(false);
    expect(discover.details).toMatch(/-32601/);
    expect(report.serverInfo.protocolVersion).toBeNull();
    // The late initialize probe sees the legacy handshake served.
    expect(resultOf(report, "lifecycle-dual-era").details).toMatch(
      /^dual-era: initialize answered with protocolVersion/,
    );
  });
});

describe("auto-detection: SDK v1 sessionful HTTP server", () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
    ({ server, url } = await startSdkV1());
  });

  afterAll(async () => {
    await new Promise<void>((done, fail) => server.close((err) => (err ? fail(err) : done())));
  });

  it("resolves 2025-11-25 from the 400 + -32000 the probe gets before initialize", async () => {
    const report = await runComplianceSuite(url, { timeout: 3000 });
    expect(report.specVersion).toBe(LEGACY_SPEC_VERSION);
    expect(autoNote(report)).toMatch(
      /^Spec version auto-detected as 2025-11-25 \(server\/discover probe returned JSON-RPC error -32000; treating the server as legacy\)/,
    );
    expect(report.serverInfo.name).toBe("detect-sdk-v1");
    expect(report.serverInfo.protocolVersion).toBe(LEGACY_SPEC_VERSION);
    expect(resultOf(report, "lifecycle-init").passed).toBe(true);
    const requiredFails = report.tests.filter((t) => t.required && !t.passed).map((t) => `${t.id}: ${t.details}`);
    expect(requiredFails).toEqual([]);
  }, 30_000);

  it("the legacy report shape is unchanged: identical to a pinned run modulo the auto note", async () => {
    const [auto, pinned] = await Promise.all([
      runComplianceSuite(url, { timeout: 3000 }),
      runComplianceSuite(url, { timeout: 3000, specVersion: LEGACY_SPEC_VERSION }),
    ]);
    expect(validateReport(auto), JSON.stringify(validateReport.errors, null, 2)).toBe(true);
    expect(auto.specVersion).toBe(pinned.specVersion);
    expect(auto.tests.map((t) => [t.id, t.passed])).toEqual(pinned.tests.map((t) => [t.id, t.passed]));
    expect(auto.tests.length).toBeGreaterThanOrEqual(71);
    expect(auto.grade).toBe(pinned.grade);
    expect(auto.score).toBe(pinned.score);
    expect(auto.summary).toEqual(pinned.summary);
    expect(auto.categories).toEqual(pinned.categories);
    expect(auto.serverInfo).toEqual(pinned.serverInfo);
    expect(auto.toolNames).toEqual(pinned.toolNames);
    // The only difference auto makes to a legacy server's report is the note.
    const autoWithoutNote = auto.warnings.filter((w) => !w.startsWith(AUTO_DETECT_NOTE_PREFIX));
    expect([...autoWithoutNote].sort()).toEqual([...pinned.warnings].sort());
    expectNoAutoNote(pinned);
  }, 60_000);
});

describe("auto-detection: unreachable server", () => {
  it("falls back to 2025-11-25 with the unreachable warning and no auto note", async () => {
    const report = await runComplianceSuite(DEAD_URL, { timeout: 2000, only: ["transport-post"] });
    expect(report.specVersion).toBe(LEGACY_SPEC_VERSION);
    expect(report.warnings.some((w) => w.includes("is unreachable"))).toBe(true);
    // Nothing was probed, so nothing was "detected": the default applies silently.
    expectNoAutoNote(report);
    expect(report.tests.map((t) => t.id)).toEqual(["transport-post"]);
    expect(report.tests[0].passed).toBe(false);
    expect(report.overall).toBe("fail");
  }, 15_000);
});

describe("classifyDiscoverResponse", () => {
  const res = (body: unknown, statusCode?: number): TransportResponse => ({ body, requestId: 0, statusCode });

  it("a result with supportedVersions is modern and seeds the discover result", () => {
    const body = {
      jsonrpc: "2.0",
      id: 0,
      result: { supportedVersions: ["2026-07-28", "2025-11-25"], capabilities: {} },
    };
    const d = classifyDiscoverResponse(res(body, 200));
    expect(d.version).toBe(MODERN_SPEC_VERSION);
    expect(d.era).toBe("modern");
    expect(d.supportedVersions).toEqual(["2026-07-28", "2025-11-25"]);
    expect(d.discover?.body).toBe(body);
    expect(d.reason).toBe("server/discover returned supportedVersions [2026-07-28, 2025-11-25]");
  });

  it("supportedVersions keeps only the strings", () => {
    const d = classifyDiscoverResponse(res({ result: { supportedVersions: ["2026-07-28", 7, null] } }));
    expect(d.era).toBe("modern");
    expect(d.supportedVersions).toEqual(["2026-07-28"]);
  });

  it.each([-32022, -32020, -32021])("modern error %i is modern (no fallback), with no discover result", (code) => {
    const d = classifyDiscoverResponse(res({ jsonrpc: "2.0", id: 0, error: { code, message: "x" } }, 400));
    expect(d.version).toBe(MODERN_SPEC_VERSION);
    expect(d.era).toBe("modern");
    expect(d.reason).toBe(`server/discover probe returned modern error code ${code}`);
    expect(d.discover).toBeUndefined();
    expect(d.supportedVersions).toBeUndefined();
  });

  it.each([
    [-32601, "a legacy stdio server's Method not found"],
    [-32000, "SDK v1's 'server not initialized'"],
    [-32602, "a legacy server that validates params"],
  ])("JSON-RPC error %i (%s) is legacy and the reason names the code", (code) => {
    const d = classifyDiscoverResponse(res({ jsonrpc: "2.0", id: 0, error: { code, message: "x" } }, 400));
    expect(d.version).toBe(LEGACY_SPEC_VERSION);
    expect(d.era).toBe("legacy");
    expect(d.reason).toBe(`server/discover probe returned JSON-RPC error ${code}; treating the server as legacy`);
  });

  it("HTTP 400 with a non-JSON body is legacy and the reason names the status", () => {
    const d = classifyDiscoverResponse(res({ _raw: "<html>Bad Request</html>" }, 400));
    expect(d.version).toBe(LEGACY_SPEC_VERSION);
    expect(d.reason).toBe("server/discover probe returned HTTP 400; treating the server as legacy");
  });

  it("HTTP 404 (an HTTP+SSE server without the modern endpoint) is legacy", () => {
    expect(classifyDiscoverResponse(res({ _raw: "Not Found" }, 404)).reason).toBe(
      "server/discover probe returned HTTP 404; treating the server as legacy",
    );
  });

  it("null (no reply within the timeout, or a transport error) is legacy", () => {
    const d = classifyDiscoverResponse(null);
    expect(d.version).toBe(LEGACY_SPEC_VERSION);
    expect(d.era).toBe("legacy");
    expect(d.reason).toBe("server/discover probe got no response; treating the server as legacy");
  });

  it("a result WITHOUT supportedVersions (a legacy server that answers anything with {}) is legacy", () => {
    const d = classifyDiscoverResponse(res({ jsonrpc: "2.0", id: 0, result: {} }, 200));
    expect(d.version).toBe(LEGACY_SPEC_VERSION);
    expect(d.era).toBe("legacy");
    expect(d.discover).toBeUndefined();
    expect(d.reason).toBe("server/discover probe returned a non-modern response; treating the server as legacy");
  });

  it("a result whose supportedVersions is not an array is legacy", () => {
    expect(classifyDiscoverResponse(res({ result: { supportedVersions: "2026-07-28" } }, 200)).era).toBe("legacy");
  });

  it("an empty 200 body with no result and no error is legacy", () => {
    expect(classifyDiscoverResponse(res({}, 200)).reason).toBe(
      "server/discover probe returned a non-modern response; treating the server as legacy",
    );
  });

  it("stdio replies carry no status: a bare error object still classifies by code", () => {
    expect(classifyDiscoverResponse(res({ error: { code: -32022 } })).era).toBe("modern");
    expect(classifyDiscoverResponse(res({ error: { code: -32601 } })).era).toBe("legacy");
    expect(classifyDiscoverResponse(res({ error: { code: "-32022" } })).era).toBe("legacy");
  });
});
