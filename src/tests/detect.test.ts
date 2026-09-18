import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import {
  classifyDiscoverResponse,
  namesHostOrOriginValidation,
  probeAnswerShowsEra,
  probeExitWarning,
  REASON_PREFIX,
  readAuthRefusal,
  refusedCredential,
  STDIO_PROBE_STATUS_DELAY_MS,
} from "../detect.js";
import { runComplianceSuite } from "../runner.js";
import { AUTO_DETECT_NOTE_PREFIX, LEGACY_SPEC_VERSION, MODERN_SPEC_VERSION } from "../spec.js";
import type { TransportResponse } from "../transport/index.js";
import type { StdioTransport } from "../transport/stdio.js";
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
 * A node:http stub that answers every request with one fixed status and
 * body -- the shapes a proxy or gateway puts in front of a server (a 502
 * page, an HTML 200), which say nothing about the server's era.
 */
async function startFixedServer(
  statusCode: number,
  body: string,
  contentType = "text/html",
  headers: Record<string, string> = {},
): Promise<{ url: string; stop(): Promise<void> }> {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(statusCode, { "content-type": contentType, ...headers });
      res.end(body);
    });
  });
  const url = await new Promise<string>((done) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      done(`http://127.0.0.1:${addr && typeof addr === "object" ? addr.port : 0}/mcp`);
    });
  });
  return {
    url,
    stop: () => new Promise<void>((done, fail) => server.close((err) => (err ? fail(err) : done()))),
  };
}

type SseAnswer = { result: unknown } | { error: { code: number; message: string } };

/**
 * A node:http stub that answers every JSON-RPC request with 200 and
 * Content-Type text/event-stream -- a normal Streamable HTTP response mode
 * -- so the HTTP preflight (the era probe) has to read its reply through
 * the SSE arm. `answer` decides each reply by method; notifications get a
 * bare 202. `framing: "json"` keeps the text/event-stream header but
 * writes a plain JSON body (no `data:` lines), the shape the SSE parser
 * returns null on. Records every method it was sent.
 */
async function startSseServer(
  answer: (method: string) => SseAnswer,
  framing: "sse" | "json" = "sse",
): Promise<{ url: string; methods: string[]; stop(): Promise<void> }> {
  const methods: string[] = [];
  const server = createServer((req, res) => {
    let text = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => {
      text += c;
    });
    req.on("end", () => {
      let msg: { id?: unknown; method?: string } = {};
      try {
        msg = JSON.parse(text);
      } catch {}
      const method = msg.method ?? "?";
      methods.push(method);
      if (msg.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      const json = JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...answer(method) });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(framing === "sse" ? `event: message\ndata: ${json}\n\n` : json);
    });
  });
  const url = await new Promise<string>((done) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      done(`http://127.0.0.1:${addr && typeof addr === "object" ? addr.port : 0}/mcp`);
    });
  });
  return {
    url,
    methods,
    stop: () => new Promise<void>((done, fail) => server.close((err) => (err ? fail(err) : done()))),
  };
}

const SSE_DISCOVER_RESULT = {
  resultType: "complete",
  supportedVersions: ["2026-07-28"],
  capabilities: {},
  ttlMs: 0,
  cacheScope: "public",
  _meta: { "io.modelcontextprotocol/serverInfo": { name: "sse-modern", version: "1" } },
};

/** A modern-only server that streams its replies: DiscoverResult, -32601 for anything else. */
const modernSseAnswer = (method: string): SseAnswer =>
  method === "server/discover"
    ? { result: SSE_DISCOVER_RESULT }
    : { error: { code: -32601, message: `Method not found: ${method}` } };

/** A 2025-11-25 server that streams its replies: -32601 for server/discover, a served handshake and ping. */
const legacySseAnswer = (method: string): SseAnswer => {
  if (method === "initialize") {
    return {
      result: { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "sse-legacy", version: "1" } },
    };
  }
  if (method === "ping") return { result: {} };
  return { error: { code: -32601, message: `Method not found: ${method}` } };
};

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
    const started = Date.now();
    let answeredAfterMs = Number.POSITIVE_INFINITY;
    const report = await runComplianceSuite(legacyStdio(LEGACY_ECHO_FIXTURE), {
      timeout: 5000,
      startupTimeout: 10_000,
      only: ["lifecycle-init", "lifecycle-ping"],
      onStatus: (m) => status.push(m),
      onTestComplete: () => {
        answeredAfterMs = Math.min(answeredAfterMs, Date.now() - started);
      },
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
    // The delay counts from spawn, so on a loaded machine a slow node
    // start can legitimately cross it; the guarantee only holds when the
    // first test finished (probe answered) before the delay elapsed.
    if (answeredAfterMs < STDIO_PROBE_STATUS_DELAY_MS) expect(status).toEqual([]);
    expect(status.length).toBeLessThanOrEqual(1);
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
    let exitAtStartup: string;
    let oneShotCli: string;
    let crashOnInit: string;

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
      // Exits at startup whatever it is sent: a server missing its env var.
      exitAtStartup = join(dir, "exit-at-startup.mjs");
      writeFileSync(
        exitAtStartup,
        'process.stderr.write("Error: API_KEY environment variable is required\\n"); process.exit(1);\n',
      );
      // A one-shot CLI passed where a server was expected: prints, exits 0.
      oneShotCli = join(dir, "one-shot-cli.mjs");
      writeFileSync(oneShotCli, 'process.stdout.write("usage: tool <command>\\n"); process.exit(0);\n');
      // Throws from a 4-deep call on initialize: Node prints the source
      // line, the Error line, then the stack frames.
      crashOnInit = join(dir, "crash-on-init.mjs");
      writeFileSync(
        crashOnInit,
        [
          'import { createInterface } from "node:readline";',
          "const d = () => { throw new Error('DATABASE_URL is not set'); };",
          "const c = () => d(); const b = () => c(); const a = () => b();",
          'createInterface({ input: process.stdin }).on("line", () => a());',
          "",
        ].join("\n"),
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

    it("lifecycle-init keeps the line naming the cause, not the stack frames, when a stdio child crashes on initialize", async () => {
      const report = await runComplianceSuite(legacyStdio(crashOnInit), {
        timeout: 5000,
        startupTimeout: 5000,
        specVersion: LEGACY_SPEC_VERSION,
        only: ["lifecycle-init"],
      });
      const init = resultOf(report, "lifecycle-init");
      expect(init.passed).toBe(false);
      expect(init.details).toMatch(
        /^Initialize request failed: server crashed with exit code 1 before completing the request/,
      );
      // The raw transport message ends in 800 chars of stderr that is
      // mostly "    at ..." frames, which used to push the Error line out
      // of the 400-char clip. summarizeStderr keeps the cause.
      expect(init.details).toContain("last stderr:");
      expect(init.details).toContain("Error: DATABASE_URL is not set");
      expect(init.details).not.toMatch(/\bat\s+\S+\s*\(/);
      expect(init.details).not.toContain("\n");
    }, 20_000);

    it.each([
      ["a server that exits at startup (missing env var, code 1)", () => exitAtStartup, "code 1"],
      ["a one-shot CLI that exits 0", () => oneShotCli, "code 0"],
    ])(
      "auto: %s is not blamed on the probe and gets no pin advice",
      async (_label, path, code) => {
        // Both die on the probe AND on the fresh instance's initialize, so
        // pinning 2025-11-25 would change nothing; the old warning said the
        // server "must tolerate unknown pre-initialize requests" and sent
        // the user to pin.
        const report = await runComplianceSuite(legacyStdio(path()), {
          timeout: 5000,
          startupTimeout: 10_000,
          only: ["lifecycle-init"],
        });
        expect(report.specVersion).toBe(LEGACY_SPEC_VERSION);
        const exited = report.warnings.find((w) => w.startsWith("Server exited"));
        expect(exited, JSON.stringify(report.warnings, null, 2)).toBeDefined();
        expect(exited).toContain(`Server exited (${code}) before answering the 2026-07-28 era probe (server/discover)`);
        expect(exited).toContain(`exited at startup as well (${code}) before answering initialize`);
        expect(exited).toContain("the server exits at startup regardless of the probe");
        expect(exited).not.toContain("pin --spec-version");
        expect(exited).not.toContain("must tolerate unknown pre-initialize requests");
        const init = resultOf(report, "lifecycle-init");
        expect(init.passed).toBe(false);
        expect(init.details).toMatch(/^Initialize request failed: /);
      },
      20_000,
    );

    it("auto: the missing-env-var server's stderr is quoted in the startup-exit warning", async () => {
      const report = await runComplianceSuite(legacyStdio(exitAtStartup), {
        timeout: 5000,
        startupTimeout: 10_000,
        only: ["lifecycle-init"],
      });
      const exited = report.warnings.find((w) => w.startsWith("Server exited"));
      expect(exited).toContain("last stderr: Error: API_KEY environment variable is required");
      expect(exited).toContain("Check the command, its arguments and its environment.");
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
    // The late initialize probe sees the legacy handshake served; with
    // server/discover rejected the server is legacy-only, not dual-era.
    expect(resultOf(report, "lifecycle-dual-era").details).toMatch(
      /^legacy-only: initialize answered with protocolVersion/,
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

describe("pinned 2025-11-25 against a dual-era server", () => {
  let http: HttpFixture;

  beforeAll(async () => {
    http = await startHttpFixture({ breaks: ["initialize-ok"] });
  });

  afterAll(async () => {
    await http.stop();
  });

  it("says the run grades the legacy side instead of sending the user back to 2026-07-28", async () => {
    // auto grades a dual-era server as 2026-07-28 and tells the user to
    // re-run pinned to 2025-11-25; that pinned run then used to answer
    // "the server spoke 2026-07-28, re-run with 2026-07-28 (or auto)",
    // because the mismatch check never looked at supportedVersions.
    const report = await runComplianceSuite(http.target, {
      timeout: 5000,
      specVersion: LEGACY_SPEC_VERSION,
      only: ["lifecycle-init"],
    });
    expect(report.specVersion).toBe(LEGACY_SPEC_VERSION);
    expect(resultOf(report, "lifecycle-init").passed).toBe(true);
    expect(pinMismatch(report), JSON.stringify(report.warnings)).toBeUndefined();
    expect(report.warnings).toContain(
      "Server is dual-era (server/discover advertised supportedVersions [2026-07-28, 2025-11-25]); this run grades its 2025-11-25 side.",
    );
    expect(report.warnings.some((w) => w.includes("Re-run with --spec-version 2026-07-28"))).toBe(false);
  });
});

describe("pinned-run mismatch warning fires only on a real era signal", () => {
  it.each([
    ["HTTP 502 with an HTML body (an outage)", 502, "<html>Bad Gateway</html>", "text/html"],
    ["HTTP 200 with an HTML body (a login page)", 200, "<html>Sign in</html>", "text/html"],
    [
      "HTTP 503 with a JSON-RPC-looking body",
      503,
      '{"jsonrpc":"2.0","id":0,"error":{"code":-32000,"message":"down"}}',
      "application/json",
    ],
  ])(
    "pinned 2026-07-28: %s does not suggest switching eras",
    async (_label, status, body, ct) => {
      const stub = await startFixedServer(status, body, ct);
      try {
        const report = await runComplianceSuite(stub.url, {
          timeout: 2000,
          specVersion: MODERN_SPEC_VERSION,
          only: ["lifecycle-discover"],
        });
        expect(report.specVersion).toBe(MODERN_SPEC_VERSION);
        expect(pinMismatch(report), JSON.stringify(report.warnings)).toBeUndefined();
        expect(report.warnings.some((w) => w.includes("Re-run with --spec-version"))).toBe(false);
        // The server did respond, so it is not "unreachable" either.
        expect(report.warnings.some((w) => w.includes("unreachable"))).toBe(false);
      } finally {
        await stub.stop();
      }
    },
    15_000,
  );

  it("pinned 2026-07-28: an HTTP 404 (an HTTP+SSE server without the endpoint) still counts as a legacy signal", async () => {
    const stub = await startFixedServer(404, "Not Found", "text/plain");
    try {
      const report = await runComplianceSuite(stub.url, {
        timeout: 2000,
        specVersion: MODERN_SPEC_VERSION,
        only: ["lifecycle-discover"],
      });
      expect(pinMismatch(report), JSON.stringify(report.warnings)).toBe(
        "Server answered the 2026-07-28 server/discover probe with HTTP 404; this run is pinned to 2026-07-28. Re-run with --spec-version 2025-11-25 (or auto) to grade it.",
      );
    } finally {
      await stub.stop();
    }
  }, 15_000);

  it("pinned 2026-07-28: a JSON-RPC result without supportedVersions is named as such", async () => {
    const stub = await startFixedServer(200, '{"jsonrpc":"2.0","id":0,"result":{}}', "application/json");
    try {
      const report = await runComplianceSuite(stub.url, {
        timeout: 2000,
        specVersion: MODERN_SPEC_VERSION,
        only: ["lifecycle-discover"],
      });
      expect(pinMismatch(report), JSON.stringify(report.warnings)).toBe(
        "Server answered the 2026-07-28 server/discover probe with a result without supportedVersions; this run is pinned to 2026-07-28. Re-run with --spec-version 2025-11-25 (or auto) to grade it.",
      );
    } finally {
      await stub.stop();
    }
  }, 15_000);
});

describe("HTTP preflight answered as an SSE stream", () => {
  // The preflight is a raw request, not the transport, so it parses a
  // text/event-stream reply itself before classifying it. If that arm
  // breaks, the `event:`/`data:` text falls to JSON.parse, lands as
  // { _raw } and classifies as "non-modern response, legacy": a modern
  // server that streams its replies would be graded on the wrong catalog.

  it("auto: an SSE DiscoverResult resolves 2026-07-28", async () => {
    const stub = await startSseServer(modernSseAnswer);
    try {
      const report = await runComplianceSuite(stub.url, { timeout: 5000, only: ["lifecycle-discover"] });
      expect(stub.methods[0]).toBe("server/discover");
      expect(report.specVersion).toBe(MODERN_SPEC_VERSION);
      expect(autoNote(report)).toMatch(
        /^Spec version auto-detected as 2026-07-28 \(server\/discover -> supportedVersions \[2026-07-28\]\)/,
      );
      expect(report.warnings.some((w) => w.includes("unreachable"))).toBe(false);
      const discover = resultOf(report, "lifecycle-discover");
      expect(discover.passed, discover.details).toBe(true);
    } finally {
      await stub.stop();
    }
  }, 15_000);

  it("auto: an SSE -32601 resolves 2025-11-25 and the reason names the code", async () => {
    const stub = await startSseServer(legacySseAnswer);
    try {
      const report = await runComplianceSuite(stub.url, { timeout: 5000, only: ["lifecycle-init"] });
      expect(report.specVersion).toBe(LEGACY_SPEC_VERSION);
      expect(autoNote(report)).toMatch(
        /^Spec version auto-detected as 2025-11-25 \(server\/discover -> JSON-RPC error -32601, legacy\)/,
      );
      const init = resultOf(report, "lifecycle-init");
      expect(init.passed, init.details).toBe(true);
      expect(report.serverInfo.name).toBe("sse-legacy");
    } finally {
      await stub.stop();
    }
  }, 15_000);

  it("pinned 2025-11-25 against a modern server that streams: the mismatch warning reads the SSE DiscoverResult", async () => {
    const stub = await startSseServer(modernSseAnswer);
    try {
      const report = await runComplianceSuite(stub.url, {
        timeout: 5000,
        specVersion: LEGACY_SPEC_VERSION,
        only: ["lifecycle-init"],
      });
      expect(report.specVersion).toBe(LEGACY_SPEC_VERSION);
      expectNoAutoNote(report);
      expect(resultOf(report, "lifecycle-init").passed).toBe(false);
      expect(pinMismatch(report), JSON.stringify(report.warnings)).toBe(
        "Server answered the 2026-07-28 server/discover probe with a DiscoverResult (supportedVersions [2026-07-28]); this run is pinned to 2025-11-25. Re-run with --spec-version 2026-07-28 (or auto) to grade it.",
      );
    } finally {
      await stub.stop();
    }
  }, 15_000);

  it("auto: a text/event-stream header over a plain JSON body still resolves 2026-07-28", async () => {
    // The SSE parser finds no `data:` event and returns null; the body
    // must then fall through to JSON.parse rather than classify as empty.
    const stub = await startSseServer(modernSseAnswer, "json");
    try {
      const report = await runComplianceSuite(stub.url, { timeout: 5000, only: ["lifecycle-discover"] });
      expect(report.specVersion).toBe(MODERN_SPEC_VERSION);
      expect(autoNote(report)).toContain("server/discover -> supportedVersions [2026-07-28]");
    } finally {
      await stub.stop();
    }
  }, 15_000);
});

describe("auth-gated server without --auth", () => {
  let http: HttpFixture;

  beforeAll(async () => {
    http = await startHttpFixture({ auth: "secret" });
  });

  afterAll(async () => {
    await http.stop();
  });

  it("auto: the first warning says auth is required and the grade is not meaningful; security-auth-required does not claim acceptance", async () => {
    const report = await runComplianceSuite(http.target, {
      timeout: 5000,
      only: ["transport-post", "security-auth-required"],
    });
    // The 401 lands on the legacy default with the era undetermined.
    expect(report.specVersion).toBe(LEGACY_SPEC_VERSION);
    expect(autoNote(report)).toContain("HTTP 401 (authentication required -- pass --auth); era not determinable");
    expect(report.warnings[0]).toBe(
      `Server at ${http.target} requires authentication (the server/discover probe got HTTP 401) and no Authorization header was sent, so the era could not be determined and the 2025-11-25 grade below is not meaningful. Re-run with --auth <token> (or -H "Authorization: ...").`,
    );
    expect(resultOf(report, "transport-post").details).toBe("HTTP 401 (auth required — pass --auth)");
    // The unauthenticated preflight WAS rejected: the old detail said the
    // server "accepted unauthenticated requests" on the same report.
    const auth = resultOf(report, "security-auth-required");
    expect(auth.passed, auth.details).toBe(true);
    expect(auth.details).toBe(
      "HTTP 401 (unauthenticated preflight rejected; pass --auth to run the authenticated suite and the remaining auth tests)",
    );
    expect(auth.details).not.toContain("accepted unauthenticated");
  }, 20_000);

  it.each([
    ["auto", undefined],
    ["pinned 2025-11-25", LEGACY_SPEC_VERSION],
  ] as const)(
    "%s: a preflight that timed out is not read as accepted; security-auth-required asks again and reads the 401",
    async (_label, specVersion) => {
      // The first request (the preflight) outlives preflightTimeout; every
      // request is refused with a Bearer 401. Before: the preflight held no
      // status, so the check FAILED "Server does not require auth (... server
      // accepted unauthenticated requests)" against a server that refuses them all.
      let first = true;
      const pings: Array<string | undefined> = [];
      const server = createServer((req, res) => {
        let text = "";
        req.setEncoding("utf8");
        req.on("data", (c: string) => {
          text += c;
        });
        req.on("end", () => {
          if (text.includes('"method":"ping"')) pings.push(req.headers.authorization);
          const delay = first ? 1500 : 0;
          first = false;
          setTimeout(() => {
            if (res.destroyed) return;
            res.writeHead(401, { "content-type": "application/json", "www-authenticate": 'Bearer realm="mcp"' });
            res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } }));
          }, delay);
        });
      });
      const url = await new Promise<string>((done) => {
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address();
          done(`http://127.0.0.1:${addr && typeof addr === "object" ? addr.port : 0}/mcp`);
        });
      });
      try {
        const report = await runComplianceSuite(url, {
          timeout: 5000,
          preflightTimeout: 300,
          startupTimeout: 5000,
          only: ["security-auth-required"],
          ...(specVersion ? { specVersion } : {}),
        });
        expect(report.specVersion).toBe(LEGACY_SPEC_VERSION);
        const auth = resultOf(report, "security-auth-required");
        expect({ passed: auth.passed, details: auth.details }).toEqual({
          passed: true,
          details:
            "HTTP 401 (unauthenticated request rejected; pass --auth to run the authenticated suite and the remaining auth tests)",
        });
        expect(pings).toEqual([undefined]);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((done) => server.close(() => done()));
      }
    },
    20_000,
  );

  it("pinned 2025-11-25 without --auth: the same first-position warning, worded for a pinned run", async () => {
    const report = await runComplianceSuite(http.target, {
      timeout: 5000,
      specVersion: LEGACY_SPEC_VERSION,
      only: ["transport-post"],
    });
    expect(report.warnings[0]).toBe(
      `Server at ${http.target} requires authentication (the preflight got HTTP 401) and no Authorization header was sent, so the 2025-11-25 grade below is not meaningful. Re-run with --auth <token> (or -H "Authorization: ...").`,
    );
    expect(pinMismatch(report)).toBeUndefined();
  }, 20_000);

  it("with --auth: no such warning, and the server is graded in its real era", async () => {
    const report = await runComplianceSuite(http.target, {
      timeout: 5000,
      headers: { Authorization: "Bearer secret" },
      only: ["lifecycle-discover"],
    });
    expect(report.specVersion).toBe(MODERN_SPEC_VERSION);
    expect(report.warnings.some((w) => w.includes("requires authentication"))).toBe(false);
    expect(resultOf(report, "lifecycle-discover").passed).toBe(true);
  }, 20_000);
});

describe("auth-gated server with a rejected --auth credential", () => {
  // A wrong or expired token: the Authorization header WAS sent, so the
  // report must say the credential was refused, never "pass --auth".
  let http: HttpFixture;
  const WRONG = { Authorization: "Bearer WRONG" };

  beforeAll(async () => {
    http = await startHttpFixture({ auth: "secret" });
  });

  afterAll(async () => {
    await http.stop();
  });

  it("auto: the first warning says the configured credential was rejected; the note and transport-post say check --auth", async () => {
    const report = await runComplianceSuite(http.target, {
      timeout: 5000,
      headers: WRONG,
      only: ["transport-post"],
    });
    expect(report.specVersion).toBe(LEGACY_SPEC_VERSION);
    expect(report.warnings[0]).toBe(
      `Server at ${http.target} rejected the configured credential (the server/discover probe carried an Authorization header and got HTTP 401), so the era could not be determined and the 2025-11-25 grade below is not meaningful. Check the --auth value (or the -H "Authorization: ..." header): a 401 means the token is invalid or expired.`,
    );
    expect(autoNote(report)).toBe(
      "Spec version auto-detected as 2025-11-25 (server/discover -> HTTP 401 (credential rejected -- check --auth); era not determinable, using 2025-11-25). Pin with --spec-version to override.",
    );
    expect(resultOf(report, "transport-post").details).toBe("HTTP 401 (credential rejected — check --auth)");
    expect(report.warnings.filter((w) => w.includes("pass --auth") || w.includes("no Authorization header"))).toEqual(
      [],
    );
  }, 20_000);

  it.each([
    LEGACY_SPEC_VERSION,
    MODERN_SPEC_VERSION,
  ] as const)("pinned %s: the same first-position warning, worded for a pinned run", async (specVersion) => {
    const report = await runComplianceSuite(http.target, {
      timeout: 5000,
      headers: WRONG,
      specVersion,
      only: [specVersion === MODERN_SPEC_VERSION ? "lifecycle-discover" : "lifecycle-init"],
    });
    expect(report.warnings[0]).toBe(
      `Server at ${http.target} rejected the configured credential (the preflight carried an Authorization header and got HTTP 401), so the ${specVersion} grade below is not meaningful. Check the --auth value (or the -H "Authorization: ..." header): a 401 means the token is invalid or expired.`,
    );
    expectNoAutoNote(report);
    expect(pinMismatch(report)).toBeUndefined();
  }, 20_000);

  it("a 403 (insufficient scope) names a missing scope or permission instead of an invalid token", async () => {
    // basic/authorization "Runtime Insufficient Scope Errors": 403 with a
    // WWW-Authenticate: Bearer error="insufficient_scope" challenge.
    const stub = await startFixedServer(403, JSON.stringify({ error: "insufficient_scope" }), "application/json", {
      "WWW-Authenticate": 'Bearer error="insufficient_scope", scope="files:read"',
    });
    try {
      const auto = await runComplianceSuite(stub.url, { timeout: 5000, headers: WRONG, only: ["transport-post"] });
      expect(auto.warnings[0]).toBe(
        `Server at ${stub.url} rejected the configured credential (the server/discover probe carried an Authorization header and got HTTP 403), so the era could not be determined and the 2025-11-25 grade below is not meaningful. Check the --auth value (or the -H "Authorization: ..." header): the 403's Bearer error="insufficient_scope" challenge means the token lacks a required scope or permission.`,
      );
      expect(resultOf(auto, "transport-post").details).toBe("HTTP 403 (credential rejected — check --auth)");
      const pinned = await runComplianceSuite(stub.url, {
        timeout: 5000,
        headers: WRONG,
        specVersion: MODERN_SPEC_VERSION,
        only: ["transport-post"],
      });
      expect(pinned.warnings[0]).toBe(
        `Server at ${stub.url} rejected the configured credential (the preflight carried an Authorization header and got HTTP 403), so the 2026-07-28 grade below is not meaningful. Check the --auth value (or the -H "Authorization: ..." header): the 403's Bearer error="insufficient_scope" challenge means the token lacks a required scope or permission.`,
      );
      expect(resultOf(pinned, "transport-post").details).toBe("HTTP 403 (credential rejected -- check --auth)");
    } finally {
      await stub.stop();
    }
  }, 20_000);

  it("a 403 whose Bearer challenge says invalid_token is a rejected credential, worded from the error value", async () => {
    // A gateway that answers an expired token with 403 instead of the 401
    // basic/authorization requires. Before: the neutral "no
    // insufficient_scope challenge" wording sent the user to Host/Origin
    // validation although the challenge names the token.
    const stub = await startFixedServer(403, JSON.stringify({ error: "invalid_token" }), "application/json", {
      "WWW-Authenticate": 'Bearer error="invalid_token", error_description="The access token expired"',
    });
    const rejected = (probe: string, era: string, spec: string) =>
      `Server at ${stub.url} rejected the configured credential (${probe} carried an Authorization header and got HTTP 403), so ${era}the ${spec} grade below is not meaningful. Check the --auth value (or the -H "Authorization: ..." header): the 403's Bearer error="invalid_token" challenge means the token is invalid or expired (basic/authorization requires a 401 for that).`;
    try {
      const auto = await runComplianceSuite(stub.url, { timeout: 5000, headers: WRONG, only: ["transport-post"] });
      expect(auto.warnings[0]).toBe(
        rejected("the server/discover probe", "the era could not be determined and ", LEGACY_SPEC_VERSION),
      );
      expect(autoNote(auto)).toContain("server/discover -> HTTP 403 (credential rejected -- check --auth)");
      expect(resultOf(auto, "transport-post").details).toBe("HTTP 403 (credential rejected — check --auth)");
      const pinned = await runComplianceSuite(stub.url, {
        timeout: 5000,
        headers: WRONG,
        specVersion: MODERN_SPEC_VERSION,
        only: ["transport-post"],
      });
      expect(pinned.warnings[0]).toBe(rejected("the preflight", "", MODERN_SPEC_VERSION));
      expect(resultOf(pinned, "transport-post").details).toBe("HTTP 403 (credential rejected -- check --auth)");
      expect([...auto.warnings, ...pinned.warnings].some((w) => w.includes("Host and Origin"))).toBe(false);
    } finally {
      await stub.stop();
    }
  }, 20_000);

  it.each([
    // The SDK's requireBearerAuth answer to a wrong token.
    [
      401,
      'Bearer error="invalid_token", error_description="Invalid token"',
      'the 401\'s Bearer error="invalid_token" challenge means the token is invalid or expired',
    ],
    [
      403,
      'Bearer realm="mcp", error="invalid_request"',
      'the 403\'s Bearer error="invalid_request" challenge means the request is malformed (an unsupported parameter, or the token sent more than one way)',
    ],
    [403, "Bearer error=token_revoked", 'the 403\'s Bearer error="token_revoked" challenge refuses the token'],
    // An escaped quote inside an earlier quoted value (RFC 9110 quoted-pair)
    // neither ends that value nor hides the error parameter after it.
    [
      403,
      'Bearer error_description="The \\"exp\\" claim, is past", error="invalid_token"',
      'the 403\'s Bearer error="invalid_token" challenge means the token is invalid or expired (basic/authorization requires a 401 for that)',
    ],
  ])(
    "HTTP %i with %s: the rejected-credential warning names the challenge's error",
    async (status, challenge, reason) => {
      const stub = await startFixedServer(status, "", "text/plain", { "WWW-Authenticate": challenge });
      try {
        const pinned = await runComplianceSuite(stub.url, {
          timeout: 5000,
          headers: WRONG,
          specVersion: MODERN_SPEC_VERSION,
          only: ["transport-post"],
        });
        expect(pinned.warnings[0]).toBe(
          `Server at ${stub.url} rejected the configured credential (the preflight carried an Authorization header and got HTTP ${status}), so the 2026-07-28 grade below is not meaningful. Check the --auth value (or the -H "Authorization: ..." header): ${reason}.`,
        );
        expect(resultOf(pinned, "transport-post").details).toBe(`HTTP ${status} (credential rejected -- check --auth)`);
      } finally {
        await stub.stop();
      }
    },
    20_000,
  );

  it("a 403 with no Bearer error challenge (the SDK's Host validation behind a tunnel) is not called a rejected credential", async () => {
    // The official SDK's Host guard answering a request forwarded with a
    // tunnel hostname: 403, a JSON-RPC -32000 body, no WWW-Authenticate.
    // Before: "rejected the configured credential ... a 403 means the token
    // lacks a required scope or permission" on a server with no auth at all.
    const stub = await startFixedServer(
      403,
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Invalid Host: abc.ngrok-free.app" },
        id: null,
      }),
      "application/json",
    );
    const neutral = (probe: string, era: string, spec: string) =>
      `Server at ${stub.url} refused ${probe} with HTTP 403 ("Invalid Host: abc.ngrok-free.app"), so ${era}the ${spec} grade below is not meaningful. The request carried an Authorization header, but the 403 has no WWW-Authenticate: Bearer challenge with an error parameter, so it need not be about the credential: check the server's Host and Origin validation (a tunnel or proxy hostname it does not allow), any gateway in front of it, and the permissions of the --auth token.`;
    try {
      const auto = await runComplianceSuite(stub.url, { timeout: 5000, headers: WRONG, only: ["transport-post"] });
      expect(auto.specVersion).toBe(LEGACY_SPEC_VERSION);
      expect(auto.warnings[0]).toBe(
        neutral("the server/discover probe", "the era could not be determined and ", LEGACY_SPEC_VERSION),
      );
      expect(autoNote(auto)).toBe(
        "Spec version auto-detected as 2025-11-25 (server/discover -> HTTP 403 (forbidden -- Host/Origin validation, a gateway, or token permissions); era not determinable, using 2025-11-25). Pin with --spec-version to override.",
      );
      expect(resultOf(auto, "transport-post").details).toBe(
        "HTTP 403 (forbidden — Host/Origin validation, a gateway, or token permissions)",
      );
      for (const specVersion of [LEGACY_SPEC_VERSION, MODERN_SPEC_VERSION] as const) {
        const pinned = await runComplianceSuite(stub.url, {
          timeout: 5000,
          headers: WRONG,
          specVersion,
          only: ["transport-post"],
        });
        expect(pinned.warnings[0]).toBe(neutral("the preflight", "", specVersion));
        expect(resultOf(pinned, "transport-post").details).toBe(
          specVersion === MODERN_SPEC_VERSION
            ? "HTTP 403 (forbidden -- Host/Origin validation, a gateway, or token permissions)"
            : "HTTP 403 (forbidden — Host/Origin validation, a gateway, or token permissions)",
        );
      }
      expect(auto.warnings.some((w) => w.includes("rejected the configured credential"))).toBe(false);
      expect(auto.warnings.some((w) => w.includes("lacks a required scope"))).toBe(false);
    } finally {
      await stub.stop();
    }
  }, 30_000);

  it("without --auth, the same bare 403 is not called authentication required: the advice names Host/Origin, a gateway, then --auth", async () => {
    // A server with no auth at all behind a tunnel, tested without --auth:
    // the SDK Host guard's 403 carries no Bearer challenge, and a server
    // that wants a token answers 401 (basic/authorization "Authorization
    // required"). Before: "requires authentication ... Re-run with --auth".
    const stub = await startFixedServer(
      403,
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Invalid Host: abc.ngrok-free.app" },
        id: null,
      }),
      "application/json",
    );
    const neutral = (probe: string, era: string, spec: string) =>
      `Server at ${stub.url} refused ${probe} with HTTP 403 ("Invalid Host: abc.ngrok-free.app") and no Authorization header was sent, so ${era}the ${spec} grade below is not meaningful. The 403 has no WWW-Authenticate: Bearer challenge, and a server that requires a token answers 401, so it need not be about authentication: check the server's Host and Origin validation (a tunnel or proxy hostname it does not allow) and any gateway in front of it; re-run with --auth <token> (or -H "Authorization: ...") only if the server does require a credential.`;
    try {
      const auto = await runComplianceSuite(stub.url, { timeout: 5000, only: ["transport-post"] });
      expect(auto.specVersion).toBe(LEGACY_SPEC_VERSION);
      expect(auto.warnings[0]).toBe(
        neutral("the server/discover probe", "the era could not be determined and ", LEGACY_SPEC_VERSION),
      );
      expect(autoNote(auto)).toBe(
        "Spec version auto-detected as 2025-11-25 (server/discover -> HTTP 403 (forbidden -- Host/Origin validation, a gateway, or missing credentials); era not determinable, using 2025-11-25). Pin with --spec-version to override.",
      );
      expect(resultOf(auto, "transport-post").details).toBe(
        "HTTP 403 (forbidden — Host/Origin validation, a gateway, or missing credentials)",
      );
      for (const specVersion of [LEGACY_SPEC_VERSION, MODERN_SPEC_VERSION] as const) {
        const pinned = await runComplianceSuite(stub.url, { timeout: 5000, specVersion, only: ["transport-post"] });
        expect(pinned.warnings[0]).toBe(neutral("the preflight", "", specVersion));
        expect(resultOf(pinned, "transport-post").details).toBe(
          specVersion === MODERN_SPEC_VERSION
            ? "HTTP 403 (forbidden -- Host/Origin validation, a gateway, or missing credentials)"
            : "HTTP 403 (forbidden — Host/Origin validation, a gateway, or missing credentials)",
        );
        expect(pinned.warnings.some((w) => w.includes("requires authentication"))).toBe(false);
      }
      expect(auto.warnings.some((w) => w.includes("requires authentication") || w.includes("pass --auth"))).toBe(false);
    } finally {
      await stub.stop();
    }
  }, 30_000);

  it("without --auth, a 403 carrying a Bearer challenge still reads as authentication required", async () => {
    // A server that wants a token but answers 403 (not the 401 the spec
    // asks for): the Bearer challenge says what it wants, so --auth stays
    // the advice in the warning, the note and transport-post.
    const stub = await startFixedServer(403, "", "text/plain", {
      "WWW-Authenticate": 'Bearer realm="mcp", resource_metadata="https://x/.well-known/oauth-protected-resource"',
    });
    try {
      const auto = await runComplianceSuite(stub.url, { timeout: 5000, only: ["transport-post"] });
      expect(auto.warnings[0]).toBe(
        `Server at ${stub.url} requires authentication (the server/discover probe got HTTP 403) and no Authorization header was sent, so the era could not be determined and the 2025-11-25 grade below is not meaningful. Re-run with --auth <token> (or -H "Authorization: ...").`,
      );
      expect(autoNote(auto)).toContain("server/discover -> HTTP 403 (authentication required -- pass --auth)");
      expect(resultOf(auto, "transport-post").details).toBe("HTTP 403 (auth required — pass --auth)");
      const pinned = await runComplianceSuite(stub.url, {
        timeout: 5000,
        specVersion: MODERN_SPEC_VERSION,
        only: ["transport-post"],
      });
      expect(pinned.warnings[0]).toBe(
        `Server at ${stub.url} requires authentication (the preflight got HTTP 403) and no Authorization header was sent, so the 2026-07-28 grade below is not meaningful. Re-run with --auth <token> (or -H "Authorization: ...").`,
      );
      expect(resultOf(pinned, "transport-post").details).toBe("HTTP 403 (auth required -- pass --auth)");
    } finally {
      await stub.stop();
    }
  }, 20_000);

  it("auto re-probe after a preflight timeout: a bare 403 on the re-probe is read from the re-probe, not defaulted to 401", async () => {
    let first = true;
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        const delay = first ? 1500 : 0;
        first = false;
        setTimeout(() => {
          if (res.destroyed) return;
          res.writeHead(403, { "content-type": "text/plain" });
          res.end("Forbidden");
        }, delay);
      });
    });
    const url = await new Promise<string>((done) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        done(`http://127.0.0.1:${addr && typeof addr === "object" ? addr.port : 0}/mcp`);
      });
    });
    try {
      const report = await runComplianceSuite(url, {
        timeout: 5000,
        preflightTimeout: 300,
        startupTimeout: 5000,
        headers: WRONG,
        only: ["transport-post"],
      });
      expect(autoNote(report)).toContain(
        "server/discover -> HTTP 403 (forbidden -- Host/Origin validation, a gateway, or token permissions)",
      );
      // Before: the preflight timed out, so the warning fell back to "HTTP 401 ... invalid or expired".
      expect(report.warnings[0]).toMatch(
        new RegExp(`^Server at ${url.replace(/[.]/g, "\\.")} refused the server/discover probe with HTTP 403, so `),
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  }, 20_000);

  it("auto re-probe after a preflight timeout: the credential rejection still reads as rejected, not missing", async () => {
    // The first request (the preflight) outlives preflightTimeout; the
    // re-sent era probe is refused at once with the configured header.
    let first = true;
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        const delay = first ? 1500 : 0;
        first = false;
        setTimeout(() => {
          if (res.destroyed) return;
          res.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" });
          res.end(JSON.stringify({ error: "invalid_token" }));
        }, delay);
      });
    });
    const url = await new Promise<string>((done) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        done(`http://127.0.0.1:${addr && typeof addr === "object" ? addr.port : 0}/mcp`);
      });
    });
    try {
      const report = await runComplianceSuite(url, {
        timeout: 5000,
        preflightTimeout: 300,
        startupTimeout: 5000,
        headers: WRONG,
        only: ["transport-post"],
      });
      expect(report.specVersion).toBe(LEGACY_SPEC_VERSION);
      expect(autoNote(report)).toContain("server/discover -> HTTP 401 (credential rejected -- check --auth)");
      expect(report.warnings[0]).toContain(
        `Server at ${url} rejected the configured credential (the server/discover probe carried an Authorization header and got HTTP 401)`,
      );
      expect(report.warnings.some((w) => w.includes("pass --auth"))).toBe(false);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  }, 20_000);
});

describe("--only values gated off the target transport", () => {
  it("stdio: an HTTP-only id selects nothing, and the report says so instead of pointing at absent warnings", async () => {
    const report = await runComplianceSuite(legacyStdio(LEGACY_ECHO_FIXTURE), {
      timeout: 5000,
      startupTimeout: 10_000,
      specVersion: LEGACY_SPEC_VERSION,
      only: ["transport-post"],
    });
    expect(report.tests).toEqual([]);
    // The id exists in the catalog, so the unknown-id warning must not fire...
    expect(report.warnings.some((w) => w.includes("match no test id"))).toBe(false);
    // ...but the transport gate does.
    expect(report.warnings).toContain(
      'Filter value(s) "transport-post" match only tests that do not apply to a stdio target (http-only), so they select nothing here; run --list --transport stdio --spec-version 2025-11-25 to see the ids that apply.',
    );
  }, 20_000);

  it("a value that also matches runnable tests is not flagged", async () => {
    const report = await runComplianceSuite(legacyStdio(LEGACY_ECHO_FIXTURE), {
      timeout: 5000,
      startupTimeout: 10_000,
      specVersion: LEGACY_SPEC_VERSION,
      only: ["lifecycle-init", "transport"],
    });
    // "transport" on stdio still runs the stdio-* tests.
    expect(report.tests.map((t) => t.id)).toContain("stdio-framing");
    expect(report.warnings.some((w) => w.includes("select nothing here"))).toBe(false);
  }, 20_000);
});

describe("abort during the HTTP preflight", () => {
  it("rejects with the abort reason as soon as the signal fires, not after the preflight deadline", async () => {
    const hanging = createServer(() => {
      // never answers
    });
    const url = await new Promise<string>((done) => {
      hanging.listen(0, "127.0.0.1", () => {
        const addr = hanging.address();
        done(`http://127.0.0.1:${addr && typeof addr === "object" ? addr.port : 0}/mcp`);
      });
    });
    try {
      const controller = new AbortController();
      const reason = new Error("user abort");
      setTimeout(() => controller.abort(reason), 200);
      const started = Date.now();
      await expect(
        runComplianceSuite(url, {
          timeout: 5000,
          preflightTimeout: 4000,
          startupTimeout: 4000,
          signal: controller.signal,
        }),
      ).rejects.toBe(reason);
      expect(Date.now() - started).toBeLessThan(1500);
    } finally {
      hanging.closeAllConnections();
      await new Promise<void>((done) => hanging.close(() => done()));
    }
  }, 10_000);
});

describe("abort after the preflight: the era probe, the re-probe and the pinned handshake", () => {
  // Each of these waits is bounded by startupTimeout (60s by default), and
  // the first harness abort gate is on the far side of it. The caller's
  // signal has to reach the request itself, so a UI disconnect or an MCP
  // tool cancel ends the run now, with the abort reason, rather than a
  // minute later. The cancelled request must not surface as a legacy
  // "no response" either: the run rejects, it does not report.
  const startupTimeout = 20_000;
  // Well under startupTimeout, well over the abort latency on a loaded box.
  const promptly = 8000;

  it("auto over stdio: an abort while the era probe waits on a silent legacy server rejects with the reason at once", async () => {
    const controller = new AbortController();
    const reason = new Error("client disconnected during the probe");
    const status: string[] = [];
    const started = Date.now();
    await expect(
      runComplianceSuite(legacyStdio(LEGACY_SILENT_FIXTURE), {
        timeout: 5000,
        startupTimeout,
        signal: controller.signal,
        // The status line fires STDIO_PROBE_STATUS_DELAY_MS into the probe,
        // so aborting from it lands inside the wait, not before the request
        // is written.
        onStatus: (m) => {
          status.push(m);
          setTimeout(() => controller.abort(reason), 50);
        },
      }),
    ).rejects.toBe(reason);
    expect(status).toHaveLength(1);
    expect(status[0]).toContain("Probing spec era (server/discover, up to 20s)");
    expect(Date.now() - started).toBeLessThan(STDIO_PROBE_STATUS_DELAY_MS + promptly);
  }, 30_000);

  it("auto over HTTP: an abort during the era re-probe after a preflight timeout rejects with the reason at once", async () => {
    const hanging = createServer(() => {
      // never answers: the preflight times out, then the re-probe hangs
    });
    const url = await new Promise<string>((done) => {
      hanging.listen(0, "127.0.0.1", () => {
        const addr = hanging.address();
        done(`http://127.0.0.1:${addr && typeof addr === "object" ? addr.port : 0}/mcp`);
      });
    });
    try {
      const controller = new AbortController();
      const reason = new Error("client disconnected during the re-probe");
      const status: string[] = [];
      const started = Date.now();
      await expect(
        runComplianceSuite(url, {
          timeout: 5000,
          preflightTimeout: 200,
          startupTimeout,
          signal: controller.signal,
          // Announced the moment the preflight gives up, right before the
          // re-probe is sent: the abort lands inside its wait.
          onStatus: (m) => {
            status.push(m);
            setTimeout(() => controller.abort(reason), 200);
          },
        }),
      ).rejects.toBe(reason);
      expect(status).toEqual([
        "Preflight got no reply within 200ms; re-sending the era probe (server/discover, up to 20s) before defaulting to 2025-11-25.",
      ]);
      expect(Date.now() - started).toBeLessThan(promptly);
    } finally {
      hanging.closeAllConnections();
      await new Promise<void>((done) => hanging.close(() => done()));
    }
  }, 30_000);

  describe("pinned 2025-11-25 over stdio", () => {
    let dir: string;
    let neverAnswers: string;
    let marker: string;

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "mcp-compliance-abort-"));
      marker = join(dir, "received-initialize");
      // Reads stdin and never writes a byte; touches the marker on its
      // first line so the test knows `initialize` is pending server-side.
      neverAnswers = join(dir, "never-answers.mjs");
      writeFileSync(
        neverAnswers,
        [
          'import { writeFileSync } from "node:fs";',
          'process.stdin.once("data", () => writeFileSync(process.argv[2], ""));',
          "process.stdin.resume();",
          "",
        ].join("\n"),
      );
    });

    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("an abort while initialize is pending rejects with the reason, not the startup-timeout 'no response'", async () => {
      const controller = new AbortController();
      const reason = new Error("client disconnected during initialize");
      const started = Date.now();
      const run = runComplianceSuite(
        { type: "stdio", command: process.execPath, args: [neverAnswers, marker] },
        { timeout: 5000, startupTimeout, specVersion: LEGACY_SPEC_VERSION, signal: controller.signal },
      );
      // No probe on a pinned run: the first line the child reads is initialize.
      const deadline = Date.now() + 10_000;
      while (!existsSync(marker) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      expect(existsSync(marker)).toBe(true);
      controller.abort(reason);
      await expect(run).rejects.toBe(reason);
      expect(Date.now() - started).toBeLessThan(promptly);
    }, 30_000);
  });
});

describe("probeExitWarning: the fresh child's exit can land after its initialize has already failed", () => {
  // The fresh instance's write error (EPIPE) can reject initialize a beat
  // before the child's 'exit' event lands. The runner quotes stderr first,
  // which usually hides the gap; the benchmark calls probeExitWarning right
  // after its warm-up fails. The fake exposes only what probeExitWarning
  // reads: `exited`, `exitCode` and `stderrTail()`.
  const STARTUP_STDERR = "Error: API_KEY environment variable is required";
  const probeExit = { exitCode: 1, stderr: STARTUP_STDERR };
  function freshChild(exitAfterMs: number | null): StdioTransport {
    let exited = false;
    if (exitAfterMs !== null) {
      setTimeout(() => {
        exited = true;
      }, exitAfterMs);
    }
    return {
      kind: "stdio",
      get exited() {
        return exited;
      },
      get exitCode() {
        return exited ? 1 : null;
      },
      stderrTail: () => (exited ? `${STARTUP_STDERR}\n` : ""),
    } as unknown as StdioTransport;
  }

  it("an exit that lands after the failed initialize still reads as a startup exit, with no pin advice", async () => {
    const warning = await probeExitWarning(probeExit, freshChild(60), {
      era: "legacy",
      answered: false,
      spawner: "benchmark",
    });
    expect(warning).toBe(
      `Server exited (code 1) before answering the 2026-07-28 era probe (server/discover), and the fresh instance the benchmark spawned exited at startup as well (code 1) before answering initialize: the server exits at startup regardless of the probe; last stderr: ${STARTUP_STDERR}. Check the command, its arguments and its environment.`,
    );
  });

  it("a fresh child that stays up is given a bounded wait, then the probe is blamed with the pin advice", async () => {
    const started = Date.now();
    const warning = await probeExitWarning(
      { exitCode: 1, stderr: "Error: unhandled method server/discover" },
      freshChild(null),
      { era: "legacy", answered: false, spawner: "suite" },
    );
    const elapsed = Date.now() - started;
    expect(warning).toBe(
      "Server exited (code 1) after the 2026-07-28 era probe (server/discover); last stderr: Error: unhandled method server/discover. The suite spawned a fresh instance. A 2025-11-25 server must tolerate unknown pre-initialize requests (answer with a JSON-RPC error or ignore them, never exit); pin --spec-version 2025-11-25 to skip the probe.",
    );
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(5000);
  });
});

describe("probeAnswerShowsEra", () => {
  const res = (body: unknown, statusCode?: number): TransportResponse => ({ body, requestId: 0, statusCode });

  it("a JSON-RPC body is an era signal at any non-5xx status", () => {
    expect(probeAnswerShowsEra(res({ jsonrpc: "2.0", id: 0, error: { code: -32601, message: "x" } }, 200))).toBe(true);
    expect(probeAnswerShowsEra(res({ jsonrpc: "2.0", id: 0, error: { code: -32000, message: "x" } }, 400))).toBe(true);
    expect(probeAnswerShowsEra(res({ jsonrpc: "2.0", id: 0, result: {} }, 200))).toBe(true);
    // stdio replies carry no status.
    expect(probeAnswerShowsEra(res({ error: { code: -32601 } }))).toBe(true);
  });

  it("a 4xx is an era signal even without a JSON-RPC body (404 from an HTTP+SSE server)", () => {
    expect(probeAnswerShowsEra(res({ _raw: "Not Found" }, 404))).toBe(true);
    expect(probeAnswerShowsEra(res({ error: "Bad Request" }, 400))).toBe(true);
  });

  it("a 5xx or a non-JSON-RPC body elsewhere is not", () => {
    expect(probeAnswerShowsEra(res({ _raw: "<html>Bad Gateway</html>" }, 502))).toBe(false);
    expect(probeAnswerShowsEra(res({ jsonrpc: "2.0", id: 0, error: { code: -32000 } }, 503))).toBe(false);
    expect(probeAnswerShowsEra(res({ _raw: "<html>Sign in</html>" }, 200))).toBe(false);
    expect(probeAnswerShowsEra(res({}, 200))).toBe(false);
    expect(probeAnswerShowsEra(res({ error: "Bad Gateway" }, 200))).toBe(false);
    expect(probeAnswerShowsEra(null)).toBe(false);
  });
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
    [401, "authentication required -- pass --auth"],
    // No Bearer challenge on the 403: it may be Host/Origin validation.
    [403, "forbidden -- Host/Origin validation, a gateway, or missing credentials"],
  ])("HTTP %i is refused before the era shows: legacy default, era undetermined, reason %s", (status, hint) => {
    // The SDK's requireBearerAuth shape: a non-JSON-RPC body on the status.
    const d = classifyDiscoverResponse(res({ error: "invalid_token", error_description: "x" }, status));
    expect(d.version).toBe(LEGACY_SPEC_VERSION);
    expect(d.era).toBe("legacy");
    expect(d.responded).toBe(true);
    expect(d.eraUndetermined).toBe(true);
    expect(d.reason).toBe(`server/discover -> HTTP ${status} (${hint}); era not determinable, using 2025-11-25`);
  });

  it("refusedCredential: a 401 always, a 403 only when a Bearer challenge carries an error parameter, read from a repeated header too", () => {
    // undici hands a repeated header to the legacy transport-post as string[].
    const scopeAmongOthers = { "www-authenticate": ['Basic realm="proxy"', 'Bearer error="insufficient_scope"'] };
    expect(refusedCredential(403, scopeAmongOthers)).toBe(true);
    expect(refusedCredential(403, { "www-authenticate": ['Basic realm="proxy"', 'Bearer realm="mcp"'] })).toBe(false);
    expect(refusedCredential(403, undefined)).toBe(false);
    expect(refusedCredential(401, undefined)).toBe(true);
    // Any error value names the credential, not only insufficient_scope.
    expect(refusedCredential(403, { "www-authenticate": 'Bearer error="invalid_token"' })).toBe(true);
    expect(refusedCredential(403, { "www-authenticate": 'Bearer realm="mcp", error="invalid_request"' })).toBe(true);
    expect(refusedCredential(403, { "www-authenticate": "bearer error=invalid_token" })).toBe(true);
    // The error must belong to a Bearer challenge: not another scheme's
    // parameter after a comma, not text inside a quoted value, not empty.
    expect(refusedCredential(403, { "www-authenticate": 'Bearer realm="mcp", DPoP error="insufficient_scope"' })).toBe(
      false,
    );
    expect(refusedCredential(403, { "www-authenticate": 'Bearer realm="error=insufficient_scope"' })).toBe(false);
    expect(refusedCredential(403, { "www-authenticate": 'Bearer error=""' })).toBe(false);
    expect(refusedCredential(403, { "www-authenticate": 'Bearer error_description="insufficient_scope"' })).toBe(false);
    // A token68 scheme ahead of the Bearer challenge does not swallow it.
    expect(refusedCredential(403, { "www-authenticate": 'Negotiate ab/cd==, Bearer error="invalid_token"' })).toBe(
      true,
    );
    // Neither status: no refusal to read, whatever the headers say.
    expect(refusedCredential(400, scopeAmongOthers)).toBe(false);
    expect(refusedCredential(undefined, scopeAmongOthers)).toBe(false);
  });

  it("readAuthRefusal: the kind follows the status, the Bearer challenge and whether a credential was sent", () => {
    const bare = {};
    const realm = { "www-authenticate": 'Bearer realm="mcp"' };
    const invalid = { "www-authenticate": 'Bearer error="invalid_token"' };
    const kind = (status: number, headers: Record<string, string>, sent: boolean) =>
      readAuthRefusal({ statusCode: status, headers }, sent)?.kind;
    // No credential sent: a 401, or a 403 carrying any Bearer challenge, asks for one.
    expect(kind(401, bare, false)).toBe("auth-required");
    expect(kind(403, realm, false)).toBe("auth-required");
    expect(kind(403, invalid, false)).toBe("auth-required");
    expect(kind(403, bare, false)).toBe("forbidden");
    expect(kind(403, { "www-authenticate": 'Basic realm="proxy"' }, false)).toBe("forbidden");
    // A credential sent: a 401, or a 403 whose Bearer challenge carries an error, refused it.
    expect(kind(401, bare, true)).toBe("credential-rejected");
    expect(kind(403, invalid, true)).toBe("credential-rejected");
    expect(kind(403, realm, true)).toBe("forbidden");
    expect(kind(403, bare, true)).toBe("forbidden");
    // Any other status is not an auth refusal.
    expect(readAuthRefusal({ statusCode: 400, headers: invalid }, true)).toBeUndefined();
    expect(readAuthRefusal({ statusCode: undefined }, false)).toBeUndefined();
    expect(readAuthRefusal({ statusCode: 403, headers: invalid, body: { error: "invalid_token" } }, true)).toEqual({
      statusCode: 403,
      authorizationSent: true,
      kind: "credential-rejected",
      bearerError: "invalid_token",
    });
    // A JSON-RPC error message is kept on one line, stripped of control
    // characters (an ESC here) and capped.
    const esc = String.fromCharCode(27);
    const noisy = readAuthRefusal(
      {
        statusCode: 403,
        body: { jsonrpc: "2.0", error: { code: -32000, message: `Invalid\n${esc}[31mHost: ${"x".repeat(200)}` } },
      },
      false,
    );
    expect(noisy?.message).toMatch(/^Invalid \[31mHost: x+\.\.\.$/);
    expect(noisy?.message).toHaveLength(120);
  });

  it("namesHostOrOriginValidation: the SDK's Host and Origin guard messages, and nothing that merely contains the letters", () => {
    for (const message of [
      "Invalid Host: abc123.ngrok-free.app",
      "Invalid Host header: evil.example:8080",
      "Missing Host header",
      "Invalid Origin: https://evil.example",
      "Invalid Origin header: null",
      "host not allowed",
    ]) {
      expect(namesHostOrOriginValidation(message), message).toBe(true);
    }
    for (const message of [
      undefined,
      "",
      "Forbidden",
      "Method not allowed by policy",
      "localhost only",
      "hostname mismatch",
      "Original request blocked",
    ]) {
      expect(namesHostOrOriginValidation(message), String(message)).toBe(false);
    }
  });

  it("readAuthRefusal: an escaped quote inside a quoted challenge value is part of the value, so an error parameter after it is still read", () => {
    // RFC 9110 5.6.4: `\"` inside a quoted-string is a quoted-pair. Read as
    // the closing quote, the rest of the value splits into bogus challenges
    // that swallow the `error` after it, and a refused token reads as a
    // Host/Origin 403.
    const expired = {
      "www-authenticate": 'Bearer error_description="The \\"exp\\" claim, is past", error="invalid_token"',
    };
    expect(readAuthRefusal({ statusCode: 403, headers: expired }, true)).toEqual({
      statusCode: 403,
      authorizationSent: true,
      kind: "credential-rejected",
      bearerError: "invalid_token",
    });
    expect(refusedCredential(403, expired)).toBe(true);
    const quotedRealm = { "www-authenticate": 'Bearer realm="say \\"hi\\"", error="insufficient_scope"' };
    expect(readAuthRefusal({ statusCode: 403, headers: quotedRealm }, true)).toEqual({
      statusCode: 403,
      authorizationSent: true,
      kind: "credential-rejected",
      bearerError: "insufficient_scope",
    });
    // Without a credential sent the same challenge only asks for one.
    expect(readAuthRefusal({ statusCode: 403, headers: expired }, false)?.kind).toBe("auth-required");
    // Text between escaped quotes is still inside the value, never a parameter.
    expect(refusedCredential(403, { "www-authenticate": 'Bearer realm="a \\"error=invalid_token\\" b"' })).toBe(false);
  });

  const withHeaders = (body: unknown, statusCode: number, headers: Record<string, string>): TransportResponse => ({
    body,
    requestId: 0,
    statusCode,
    headers,
  });
  const SCOPE_CHALLENGE = 'Bearer error="insufficient_scope", scope="files:read", resource_metadata="https://x/prm"';

  it.each([
    ["a 401 without a challenge", res({ error: "invalid_token", error_description: "x" }, 401)],
    [
      "a 401 with a Bearer challenge",
      withHeaders({ error: "invalid_token" }, 401, { "www-authenticate": 'Bearer error="invalid_token"' }),
    ],
    [
      "a 403 with a Bearer insufficient_scope challenge",
      withHeaders({ error: "insufficient_scope" }, 403, { "www-authenticate": SCOPE_CHALLENGE }),
    ],
    // Header names are matched case-insensitively (a hand-built response map).
    ["the same 403, header name capitalised", withHeaders({}, 403, { "WWW-Authenticate": SCOPE_CHALLENGE })],
    // Any Bearer error names the credential; the spec wants 401 for these,
    // but a gateway answering 403 is still refusing the token.
    [
      "a 403 with a Bearer invalid_token challenge",
      withHeaders({ error: "invalid_token" }, 403, {
        "www-authenticate": 'Bearer error="invalid_token", error_description="The access token expired"',
      }),
    ],
    [
      "a 403 with a Bearer invalid_request challenge",
      withHeaders({}, 403, { "www-authenticate": 'Bearer realm="mcp", error="invalid_request"' }),
    ],
  ])("%s with an Authorization header on the probe: the credential was rejected, and the reason does not say to pass --auth", (_name, response) => {
    const d = classifyDiscoverResponse(response, { authorizationSent: true });
    expect(d.version).toBe(LEGACY_SPEC_VERSION);
    expect(d.eraUndetermined).toBe(true);
    expect(d.reason).toBe(
      `server/discover -> HTTP ${response.statusCode} (credential rejected -- check --auth); era not determinable, using 2025-11-25`,
    );
    expect(d.refusal?.kind).toBe("credential-rejected");
    expect(d.refusal?.statusCode).toBe(response.statusCode);
    expect(d.refusal?.authorizationSent).toBe(true);
  });

  it.each([
    // The SDK's Host validation answering a tunnel hostname: 403, a JSON-RPC
    // -32000 body, no WWW-Authenticate. streamable-http requires the same
    // bare 403 for an invalid Origin.
    [
      "the SDK Host guard's 403",
      withHeaders(
        { jsonrpc: "2.0", error: { code: -32000, message: "Invalid Host: abc.ngrok-free.app" }, id: null },
        403,
        {
          "content-type": "application/json",
        },
      ),
      "forbidden -- Host/Origin validation, a gateway, or missing credentials",
    ],
    [
      "a 403 with a JSON body naming a scope but no challenge",
      res({ error: "insufficient_scope" }, 403),
      "forbidden -- Host/Origin validation, a gateway, or missing credentials",
    ],
    // A Bearer challenge with no error asks for a token without refusing one:
    // neutral when a token was sent, authentication required when none was.
    [
      "a 403 whose Bearer challenge carries no error",
      withHeaders({}, 403, { "www-authenticate": 'Bearer realm="mcp"' }),
      "authentication required -- pass --auth",
    ],
    [
      "a 403 whose insufficient_scope is not a Bearer challenge",
      withHeaders({}, 403, { "www-authenticate": 'DPoP error="insufficient_scope"' }),
      "forbidden -- Host/Origin validation, a gateway, or missing credentials",
    ],
  ])("%s with an Authorization header on the probe: not called a credential rejection", (_name, response, noCredentialHint) => {
    const d = classifyDiscoverResponse(response, { authorizationSent: true });
    expect(d.version).toBe(LEGACY_SPEC_VERSION);
    expect(d.eraUndetermined).toBe(true);
    // Before: "(credential rejected -- check --auth)" for every 403.
    expect(d.reason).toBe(
      "server/discover -> HTTP 403 (forbidden -- Host/Origin validation, a gateway, or token permissions); era not determinable, using 2025-11-25",
    );
    expect(d.refusal?.kind).toBe("forbidden");
    // Without the header, only a Bearer challenge keeps the --auth advice.
    const noHeader = classifyDiscoverResponse(response);
    expect(noHeader.reason).toBe(
      `server/discover -> HTTP 403 (${noCredentialHint}); era not determinable, using 2025-11-25`,
    );
    expect(noHeader.refusal?.authorizationSent).toBe(false);
  });

  it("authorizationSent changes only the auth reason: other shapes classify exactly as without it", () => {
    for (const shape of [
      res({ _raw: "Not Found" }, 404),
      res({ jsonrpc: "2.0", id: 0, error: { code: -32601, message: "x" } }, 200),
      res({ result: { supportedVersions: ["2026-07-28"] } }, 200),
      null,
    ]) {
      expect(classifyDiscoverResponse(shape, { authorizationSent: true })).toEqual(classifyDiscoverResponse(shape));
    }
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

  it("a result WITHOUT supportedVersions (a legacy server that answers anything with {}) is legacy and the reason says so", () => {
    const d = classifyDiscoverResponse(res({ jsonrpc: "2.0", id: 0, result: {} }, 200));
    expect(d.version).toBe(LEGACY_SPEC_VERSION);
    expect(d.era).toBe("legacy");
    expect(d.discover).toBeUndefined();
    expect(d.reason).toBe("server/discover -> result without supportedVersions, legacy");
  });

  it("a result whose supportedVersions is not an array is legacy", () => {
    const d = classifyDiscoverResponse(res({ result: { supportedVersions: "2026-07-28" } }, 200));
    expect(d.era).toBe("legacy");
    expect(d.reason).toBe("server/discover -> result without supportedVersions, legacy");
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
