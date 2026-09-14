import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { classifyDiscoverResponse, REASON_PREFIX } from "../detect.js";
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

/** The pinned-run "server speaks the other era" warning, if any. */
function pinMismatch(report: ComplianceReport): string | undefined {
  return report.warnings.find((w) => w.startsWith("Server answered the 2026-07-28 server/discover probe"));
}

/**
 * A legacy stdio server whose unguarded dispatcher THROWS on an unknown
 * pre-initialize method -- so the modern era probe kills the process
 * (uncaught exception, exit code 1). Written to a temp dir per run: the
 * fixtures directory models servers that answer or stay silent, not
 * ones that die. Answers initialize / ping / tools/list once up.
 */
const CRASH_ON_PROBE_SERVER = `
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  switch (msg.method) {
    case "initialize":
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "crash-on-probe", version: "1" } } });
      break;
    case "ping":
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
      break;
    case "tools/list":
      send({ jsonrpc: "2.0", id: msg.id, result: { tools: [] } });
      break;
    default:
      throw new Error("unhandled method " + msg.method);
  }
});
rl.on("close", () => process.exit(0));
`;

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
      /^Spec version auto-detected as 2026-07-28 \(server\/discover -> supportedVersions \[2026-07-28\]\)/,
    );
    expect(note).toContain("Pin with --spec-version to override.");
    expect(report.warnings.some((w) => w.includes("unreachable"))).toBe(false);
    expect(pinMismatch(report)).toBeUndefined();
    expect(resultOf(report, "lifecycle-discover").passed).toBe(true);
  });

  it("stdio: the first exchange is the probe and resolves 2026-07-28", async () => {
    const status: string[] = [];
    const report = await runComplianceSuite(stdioFixture().target, {
      timeout: 5000,
      startupTimeout: 10_000,
      only: ["lifecycle-discover"],
      onStatus: (m) => status.push(m),
    });
    expect(report.specVersion).toBe(MODERN_SPEC_VERSION);
    expect(autoNote(report)).toContain("server/discover -> supportedVersions [2026-07-28]");
    expect(resultOf(report, "lifecycle-discover").passed).toBe(true);
    expect(report.url).toMatch(/^stdio:/);
    // The probe was answered at once: no "still probing" status line.
    expect(status).toEqual([]);
  });

  it("pinned 2025-11-25 against the modern-only fixture: the legacy suite runs, its handshake fails, and the report names the era mismatch", async () => {
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
    // The fixture answers initialize with -32601 naming its era (spec
    // SHOULD); the legacy suite surfaces that code and message instead of
    // a bare "No result in response".
    expect(init.details).toMatch(/^Initialize answered with JSON-RPC error -32601: Method not found: initialize\./);
    expect(init.details).toContain("This server speaks MCP 2026-07-28");
    expect(resultOf(report, "lifecycle-proto-version").passed).toBe(false);
    expect(report.serverInfo.protocolVersion).toBeNull();
    expect(report.overall).toBe("fail");
    // The preflight already held the server's DiscoverResult; a pinned run
    // classifies it too and says which era the server actually spoke.
    expect(pinMismatch(report), JSON.stringify(report.warnings)).toBe(
      "Server answered the 2026-07-28 server/discover probe with a DiscoverResult (supportedVersions [2026-07-28]); this run is pinned to 2025-11-25. Re-run with --spec-version 2026-07-28 (or auto) to grade it.",
    );
  });

  it("pinned 2026-07-28 against the modern fixture: same era, no mismatch warning", async () => {
    const report = await runComplianceSuite(http.target, {
      timeout: 5000,
      specVersion: MODERN_SPEC_VERSION,
      only: ["lifecycle-discover"],
    });
    expect(report.specVersion).toBe(MODERN_SPEC_VERSION);
    expectNoAutoNote(report);
    expect(pinMismatch(report)).toBeUndefined();
    expect(resultOf(report, "lifecycle-discover").passed).toBe(true);
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
    const status: string[] = [];
    const report = await runComplianceSuite(legacyStdio(LEGACY_ECHO_FIXTURE), {
      timeout: 5000,
      startupTimeout: 10_000,
      only: ["lifecycle-init", "lifecycle-ping"],
      onStatus: (m) => status.push(m),
    });
    expect(report.specVersion).toBe(LEGACY_SPEC_VERSION);
    expect(autoNote(report)).toMatch(
      /^Spec version auto-detected as 2025-11-25 \(server\/discover -> JSON-RPC error -32601, legacy\)/,
    );
    expect(resultOf(report, "lifecycle-init").passed).toBe(true);
    expect(resultOf(report, "lifecycle-ping").passed).toBe(true);
    expect(report.serverInfo.name).toBe("echo-fixture");
    expect(report.serverInfo.protocolVersion).toBe(LEGACY_SPEC_VERSION);
    // An immediate -32601 never reaches the "still probing" status line.
    expect(status).toEqual([]);
    expect(report.warnings.some((w) => w.startsWith("Server exited"))).toBe(false);
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
      /^Spec version auto-detected as 2025-11-25 \(server\/discover -> no response, legacy\)/,
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

  it("silent fixture: ~2s into the outstanding probe onStatus says what the wait is and how to skip it", async () => {
    const status: Array<{ at: number; message: string }> = [];
    const started = Date.now();
    const report = await runComplianceSuite(legacyStdio(LEGACY_SILENT_FIXTURE), {
      timeout: 5000,
      startupTimeout: 3500,
      only: ["lifecycle-init"],
      onStatus: (message) => status.push({ at: Date.now() - started, message }),
    });
    expect(report.specVersion).toBe(LEGACY_SPEC_VERSION);
    expect(resultOf(report, "lifecycle-init").passed).toBe(true);
    expect(status).toHaveLength(1);
    expect(status[0].message).toBe(
      "Probing spec era (server/discover, up to 3.5s). A 2025-11-25 server that ignores unknown methods takes the whole startup timeout; --spec-version 2025-11-25 skips the probe.",
    );
    // Fired while the probe was still outstanding, not after it resolved.
    expect(status[0].at).toBeGreaterThanOrEqual(1900);
    expect(status[0].at).toBeLessThan(3500);
  }, 20_000);

  it("pinned 2025-11-25 skips the probe entirely: no wait, no status line, no auto note", async () => {
    const status: string[] = [];
    const started = Date.now();
    const report = await runComplianceSuite(legacyStdio(LEGACY_SILENT_FIXTURE), {
      timeout: 5000,
      startupTimeout: 10_000,
      specVersion: LEGACY_SPEC_VERSION,
      only: ["lifecycle-init"],
      onStatus: (m) => status.push(m),
    });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(resultOf(report, "lifecycle-init").passed).toBe(true);
    expectNoAutoNote(report);
    expect(status).toEqual([]);
    // A pinned stdio run sends no probe, so there is nothing to compare
    // the pin against (the mismatch warning is HTTP-only).
    expect(pinMismatch(report)).toBeUndefined();
  });

  describe("a legacy server that exits on the probe", () => {
    let dir: string;
    let script: string;
    let exitOnFirstLine: string;

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "mcp-compliance-crash-"));
      script = join(dir, "crash-on-probe.mjs");
      writeFileSync(script, CRASH_ON_PROBE_SERVER);
      // Dies with code 3 on the first request it receives, whatever it is.
      exitOnFirstLine = join(dir, "exit-on-first-line.mjs");
      writeFileSync(
        exitOnFirstLine,
        'process.stdin.once("data", () => { process.stderr.write("bye\\n"); process.exit(3); });\n',
      );
    });

    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("auto: the exit is reported with its code and stderr, and the legacy suite runs against a fresh child", async () => {
      const report = await runComplianceSuite(legacyStdio(script), {
        timeout: 5000,
        startupTimeout: 10_000,
        only: ["lifecycle-init", "lifecycle-ping"],
      });
      expect(report.specVersion).toBe(LEGACY_SPEC_VERSION);
      // The probe rejection (child exit) classifies as "no response".
      expect(autoNote(report)).toContain("server/discover -> no response, legacy");
      const exited = report.warnings.find((w) => w.startsWith("Server exited"));
      expect(exited, JSON.stringify(report.warnings, null, 2)).toBeDefined();
      expect(exited).toContain("Server exited (code 1) after the 2026-07-28 era probe (server/discover)");
      // The stderr tail keeps the line naming the cause ahead of the stack frames.
      expect(exited).toContain("last stderr:");
      expect(exited).toContain("Error: unhandled method server/discover");
      expect(exited).not.toMatch(/\bat\s+\S+\s*\(/);
      expect(exited).toContain("must tolerate unknown pre-initialize requests");
      expect(exited).toContain("spawned a fresh instance");
      expect(exited).toContain("pin --spec-version 2025-11-25 to skip the probe");
      // Without the re-spawn the handshake goes to a dead child and fails.
      const init = resultOf(report, "lifecycle-init");
      expect(init.passed, init.details).toBe(true);
      expect(resultOf(report, "lifecycle-ping").passed).toBe(true);
      expect(report.serverInfo.name).toBe("crash-on-probe");
    }, 20_000);

    it("pinned 2025-11-25: no probe, so the server never dies and nothing is re-spawned", async () => {
      const report = await runComplianceSuite(legacyStdio(script), {
        timeout: 5000,
        startupTimeout: 10_000,
        specVersion: LEGACY_SPEC_VERSION,
        only: ["lifecycle-init", "lifecycle-ping"],
      });
      expect(report.warnings.some((w) => w.startsWith("Server exited"))).toBe(false);
      expect(resultOf(report, "lifecycle-init").passed).toBe(true);
      expect(resultOf(report, "lifecycle-ping").passed).toBe(true);
    }, 20_000);

    it("lifecycle-init names the transport error when the handshake itself gets no response", async () => {
      // Pinned legacy (no probe): the FIRST request is initialize, and the
      // child dies on it. The handshake's rejection reason -- the exit
      // diagnostic plus the stderr tail -- reaches the details, on one line.
      const report = await runComplianceSuite(legacyStdio(exitOnFirstLine), {
        timeout: 5000,
        startupTimeout: 5000,
        specVersion: LEGACY_SPEC_VERSION,
        only: ["lifecycle-init"],
      });
      const init = resultOf(report, "lifecycle-init");
      expect(init.passed).toBe(false);
      expect(init.details).toMatch(/^Initialize request failed: /);
      expect(init.details).toContain("exit code 3");
      // (The stderr tail rides along when the parent has read it before the
      // exit event lands; that ordering is not guaranteed, so not asserted.)
      expect(init.details).not.toContain("\n");
    }, 20_000);
  });

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
      /^Spec version auto-detected as 2025-11-25 \(server\/discover -> JSON-RPC error -32000, legacy\)/,
    );
    expect(report.serverInfo.name).toBe("detect-sdk-v1");
    expect(report.serverInfo.protocolVersion).toBe(LEGACY_SPEC_VERSION);
    expect(resultOf(report, "lifecycle-init").passed).toBe(true);
    const requiredFails = report.tests.filter((t) => t.required && !t.passed).map((t) => `${t.id}: ${t.details}`);
    expect(requiredFails).toEqual([]);
  }, 30_000);

  it("pinned 2026-07-28 against the legacy server: the mismatch warning points back at 2025-11-25", async () => {
    const report = await runComplianceSuite(url, {
      timeout: 3000,
      specVersion: MODERN_SPEC_VERSION,
      only: ["lifecycle-discover"],
    });
    expect(report.specVersion).toBe(MODERN_SPEC_VERSION);
    expectNoAutoNote(report);
    expect(resultOf(report, "lifecycle-discover").passed).toBe(false);
    expect(pinMismatch(report), JSON.stringify(report.warnings)).toBe(
      "Server answered the 2026-07-28 server/discover probe with JSON-RPC error -32000; this run is pinned to 2026-07-28. Re-run with --spec-version 2025-11-25 (or auto) to grade it.",
    );
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
    const started = Date.now();
    const report = await runComplianceSuite(DEAD_URL, { timeout: 2000, only: ["transport-post"] });
    expect(report.specVersion).toBe(LEGACY_SPEC_VERSION);
    const unreachable = report.warnings.find((w) => w.includes("is unreachable"));
    expect(unreachable, JSON.stringify(report.warnings)).toBeDefined();
    // A refused connection is named as such (not "did not answer") and is
    // never re-probed: the run fails fast.
    expect(unreachable).toMatch(/^Server at http:\/\/127\.0\.0\.1:1\/mcp is unreachable \(.*ECONNREFUSED/);
    expect(unreachable).toContain("every test that needs the server will fail");
    expect(unreachable).not.toContain("era probe");
    expect(Date.now() - started).toBeLessThan(5000);
    // Nothing was probed, so nothing was "detected": the default applies silently.
    expectNoAutoNote(report);
    expect(pinMismatch(report)).toBeUndefined();
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
    expect(d.responded).toBe(true);
    expect(d.eraUndetermined).toBeUndefined();
    expect(d.supportedVersions).toEqual(["2026-07-28", "2025-11-25"]);
    expect(d.discover?.body).toBe(body);
    expect(d.reason).toBe("server/discover -> supportedVersions [2026-07-28, 2025-11-25]");
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
    expect(d.responded).toBe(true);
    expect(d.reason).toBe(`server/discover -> modern error ${code}`);
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
    expect(d.responded).toBe(true);
    expect(d.eraUndetermined).toBeUndefined();
    expect(d.reason).toBe(`server/discover -> JSON-RPC error ${code}, legacy`);
  });

  it("HTTP 400 with a non-JSON body is legacy and the reason names the status", () => {
    const d = classifyDiscoverResponse(res({ _raw: "<html>Bad Request</html>" }, 400));
    expect(d.version).toBe(LEGACY_SPEC_VERSION);
    expect(d.reason).toBe("server/discover -> HTTP 400, legacy");
  });

  it("HTTP 404 (an HTTP+SSE server without the modern endpoint) is legacy", () => {
    expect(classifyDiscoverResponse(res({ _raw: "Not Found" }, 404)).reason).toBe(
      "server/discover -> HTTP 404, legacy",
    );
  });

  it.each([
    401, 403,
  ])("HTTP %i is refused before the era shows: legacy default, reason names auth, era undetermined", (status) => {
    // The SDK's requireBearerAuth shape: a non-JSON-RPC body on the status.
    const d = classifyDiscoverResponse(res({ error: "invalid_token", error_description: "x" }, status));
    expect(d.version).toBe(LEGACY_SPEC_VERSION);
    expect(d.era).toBe("legacy");
    expect(d.responded).toBe(true);
    expect(d.eraUndetermined).toBe(true);
    expect(d.reason).toBe(
      `server/discover -> HTTP ${status} (authentication required -- pass --auth); era not determinable, using 2025-11-25`,
    );
  });

  it("HTTP 401 carrying a non-modern JSON-RPC error body is still the auth case", () => {
    const d = classifyDiscoverResponse(res({ jsonrpc: "2.0", id: 0, error: { code: -32001, message: "nope" } }, 401));
    expect(d.eraUndetermined).toBe(true);
    expect(d.reason).toContain("HTTP 401 (authentication required -- pass --auth)");
  });

  it("HTTP 401 carrying a MODERN error code is modern (the server showed its era after all)", () => {
    const d = classifyDiscoverResponse(res({ jsonrpc: "2.0", id: 0, error: { code: -32022, message: "x" } }, 401));
    expect(d.era).toBe("modern");
    expect(d.eraUndetermined).toBeUndefined();
  });

  it("null (no reply within the timeout, or a transport error) is legacy and did not respond", () => {
    const d = classifyDiscoverResponse(null);
    expect(d.version).toBe(LEGACY_SPEC_VERSION);
    expect(d.era).toBe("legacy");
    expect(d.responded).toBe(false);
    expect(d.reason).toBe("server/discover -> no response, legacy");
  });

  it("a result WITHOUT supportedVersions (a legacy server that answers anything with {}) is legacy", () => {
    const d = classifyDiscoverResponse(res({ jsonrpc: "2.0", id: 0, result: {} }, 200));
    expect(d.version).toBe(LEGACY_SPEC_VERSION);
    expect(d.era).toBe("legacy");
    expect(d.discover).toBeUndefined();
    expect(d.reason).toBe("server/discover -> non-modern response, legacy");
  });

  it("a result whose supportedVersions is not an array is legacy", () => {
    expect(classifyDiscoverResponse(res({ result: { supportedVersions: "2026-07-28" } }, 200)).era).toBe("legacy");
  });

  it("an empty 200 body with no result and no error is legacy", () => {
    expect(classifyDiscoverResponse(res({}, 200)).reason).toBe("server/discover -> non-modern response, legacy");
  });

  it("every reason starts with REASON_PREFIX so the reporter can fold it into its label", () => {
    const shapes: Array<TransportResponse | null> = [
      null,
      res({ result: { supportedVersions: ["2026-07-28"] } }, 200),
      res({ error: { code: -32022 } }, 400),
      res({ error: { code: -32601 } }, 200),
      res({ _raw: "x" }, 404),
      res({ _raw: "x" }, 401),
      res({}, 200),
    ];
    for (const shape of shapes) {
      expect(classifyDiscoverResponse(shape).reason.startsWith(REASON_PREFIX)).toBe(true);
    }
  });

  it("stdio replies carry no status: a bare error object still classifies by code", () => {
    expect(classifyDiscoverResponse(res({ error: { code: -32022 } })).era).toBe("modern");
    expect(classifyDiscoverResponse(res({ error: { code: -32601 } })).era).toBe("legacy");
    expect(classifyDiscoverResponse(res({ error: { code: "-32022" } })).era).toBe("legacy");
  });
});
