import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  hostHeaderValidation,
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import { createMcpHandler, type McpHttpHandler, McpServer } from "@modelcontextprotocol/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { REASON_PREFIX } from "../detect.js";
import { runComplianceSuite } from "../runner.js";
import { AUTO_DETECT_NOTE_PREFIX } from "../spec.js";
import type { ComplianceReport, TransportTarget } from "../types.js";
import { resultOf } from "./helpers/modern-fixture.js";

/**
 * The official SDK v2 (`@modelcontextprotocol/server@2.0.0`) as an
 * independent 2026-07-28 reference server, mounted on node:http through
 * `toNodeHandler` from `@modelcontextprotocol/node@2.0.0` (with the loopback
 * Host/Origin guards its README prescribes for a hand-wired server) and over
 * stdio through `serveStdio` (src/tests/fixtures/sdk2-stdio-server.mjs).
 *
 * The hand-rolled fixture proves every modern check can FAIL; this file
 * proves the checks produce no false failures against an implementation we
 * did not write. Every failing id is asserted EXACTLY: the localhost-inherent
 * security checks, plus the SDK behaviours documented next to each
 * allowlist below with the spec text they deviate from. Those pins are
 * deliberate -- a catalog check is never loosened to make the SDK pass, and
 * when the SDK fixes a behaviour the corresponding pin goes red so the
 * allowlist gets pruned rather than rotting.
 */

const SDK2_STDIO_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "sdk2-stdio-server.mjs");

/**
 * Optional checks every 2026-07-28 HTTP run on plain loopback fails
 * regardless of the server. That catalog's security-rate-limiting reports
 * a quiet burst as a warning, not a failure (asserted in the warning
 * list below); the 2025-11-25 catalog's still fails it.
 */
const LOCALHOST_INHERENT = ["security-auth-required", "security-tls-required"];
const LEGACY_LOCALHOST_INHERENT = [...LOCALHOST_INHERENT, "security-rate-limiting"];

/**
 * Why security-auth-required is localhost-inherent here: the loopback Host
 * guard lets 127.0.0.1 through and the SDK serves the credential-less
 * server/discover. A 403 from the guard would read differently (see the
 * Host guard block at the end of the file).
 */
const LOCALHOST_AUTH_REQUIRED = "HTTP 200, result -- server accepted unauthenticated request (no --auth provided)";

/** The auto-detection note every run against the SDK opens with. */
const AUTO_DETECT_NOTE = `${AUTO_DETECT_NOTE_PREFIX}2026-07-28 (${REASON_PREFIX}supportedVersions [2026-07-28]). Pin with --spec-version to override.`;

/**
 * The SDK server declares tools/resources/prompts but no `completions`
 * capability, so the capability-gated lifecycle-completions never runs:
 * one fewer than the catalog's 99 HTTP / 75 stdio.
 */
const HTTP_TEST_COUNT = 98;
const STDIO_TEST_COUNT = 74;

/**
 * SDK v2 answers a modern request (full `_meta` envelope) that omits the
 * `MCP-Protocol-Version` header with HTTP 200 and the result, in BOTH
 * serving modes. The spec: "Every POST request to the MCP endpoint MUST
 * include an MCP-Protocol-Version header" (basic/transports/streamable-http
 * #protocol-version-header) and a missing required standard header is a
 * validation failure the server MUST answer with 400 + -32020
 * (#server-validation). The same section lets a server that supports
 * pre-2025-06-18 clients treat a header-less request as 2025-03-26 -- the
 * dual-era default can lean on that MAY (although it serves the request as
 * 2026-07-28, not as 2025-03-26); a `legacy: 'reject'` endpoint "does not
 * support such clients" and "MUST reject a request without the header".
 */
const SDK_HTTP_REQUIRED_DEVIATIONS = ["transport-header-version-required"];

/**
 * SDK v2's stateless legacy fallback still speaks 2025-03-26-era batching:
 * a JSON-RPC batch of two pings is answered 200 with an SSE stream of two
 * results -- even when the request carries `MCP-Protocol-Version:
 * 2025-11-25`, whose transport requires "a single JSON-RPC request,
 * notification, or response" per POST (2025-11-25 basic/transports
 * #sending-messages-to-the-server; batching was removed in 2025-06-18).
 * SDK v1 rejects the same batch, which is why integration.test.ts passes.
 */
const SDK_LEGACY_REQUIRED_DEVIATIONS = ["transport-batch-reject"];

/**
 * Over stdio in the default `legacy: 'serve'` mode, ANY claim-less message
 * (no `_meta["io.modelcontextprotocol/protocolVersion"]`) received while
 * the connection is still deciding its era -- i.e. before any modern
 * request other than `server/discover` -- flips the whole connection to
 * the legacy era for the rest of the process. The versioning page
 * (basic/versioning#backward-compatibility) keys a dual-era server's era
 * to "how the client opens" (a modern `_meta` request or an `initialize`)
 * and says nothing about a malformed non-initialize message re-selecting
 * it, so the SDK is over-broad there. The suite copes rather than
 * penalises: its two claim-less probes (lifecycle-meta-required: no
 * `_meta`; lifecycle-meta-protocol-version-required: `_meta` without
 * protocolVersion) run LATE, after the feature modules have pinned the
 * process modern, where the SDK answers them with the -32602 the spec
 * requires (basic/index#request-metadata). Asserted below by their
 * details: had they run early, the flipped process would have answered
 * -32601 and every modern-only check after them would have failed. A
 * `--only` run that skips the feature modules pins the process itself
 * with one modern request first, so a single-probe run measures the
 * same state (asserted below too).
 */
const CLAIM_LESS_PROBES = ["lifecycle-meta-required", "lifecycle-meta-protocol-version-required"];

/** Same surface as src/tests/fixtures/sdk2-stdio-server.mjs; keep them in sync. */
function createSdkServer(): McpServer {
  const mcp = new McpServer({ name: "sdk2-http-server", version: "2.0.0" });

  mcp.registerTool(
    "echo",
    {
      title: "Echo",
      description: "Echoes back the input",
      inputSchema: z.object({ message: z.string().optional().describe("Message to echo") }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ message }) => ({
      content: [{ type: "text" as const, text: String(message ?? "no message") }],
    }),
  );

  mcp.registerResource(
    "hello",
    "file:///test/hello.txt",
    { title: "Hello", description: "A static greeting", mimeType: "text/plain" },
    async (uri) => ({
      contents: [{ uri: uri.href, text: "Hello, world!" }],
    }),
  );

  mcp.registerPrompt("greeting", { title: "Greeting", description: "A simple greeting prompt" }, async () => ({
    messages: [{ role: "user" as const, content: { type: "text" as const, text: "Hello!" } }],
  }));

  return mcp;
}

interface Mounted {
  server: Server;
  handler: McpHttpHandler;
  url: string;
}

interface MountOptions {
  /**
   * The hostnames the SDK's Host guard (hostHeaderValidation) allows.
   * Default: the loopback names localhostHostValidation allows, which the
   * run's 127.0.0.1 URL passes.
   */
  allowedHosts?: string[];
  /**
   * A gate in front of the SDK: a request whose Authorization is not this
   * value is answered with a bare HTTP 403 (a JSON-RPC error, no
   * WWW-Authenticate) and never reaches the SDK.
   */
  bare403Unless?: string;
  /**
   * The Host header every request arrives with, as through a tunnel or
   * reverse proxy (ngrok, cloudflared) that forwards the public hostname to
   * this loopback server: the loopback Host guard refuses it.
   */
  tunnelHost?: string;
}

/** Mount exactly as the @modelcontextprotocol/node README shows for plain node:http. */
async function mount(legacy: "stateless" | "reject", opts: MountOptions = {}): Promise<Mounted> {
  const handler = createMcpHandler(() => createSdkServer(), { legacy });
  const mcpHandler = toNodeHandler(handler);
  const validateHost = opts.allowedHosts ? hostHeaderValidation(opts.allowedHosts) : localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const server = createServer(async (req, res) => {
    if (opts.tunnelHost) req.headers.host = opts.tunnelHost;
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;
    if (opts.bare403Unless !== undefined && req.headers.authorization !== opts.bare403Unless) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Forbidden" }, id: null }));
      return;
    }
    await mcpHandler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr !== "object") throw new Error("server did not bind");
  return { server, handler, url: `http://127.0.0.1:${addr.port}/mcp` };
}

async function unmount(m: Mounted | undefined): Promise<void> {
  if (!m) return;
  await m.handler.close();
  await new Promise<void>((resolve, reject) => m.server.close((err) => (err ? reject(err) : resolve())));
}

const sorted = (ids: string[]) => [...ids].sort();

/** Failing ids split by required flag, with details, so a mismatch names the surprise. */
function failures(report: ComplianceReport): { required: string[]; optional: string[]; details: string[] } {
  const failing = report.tests.filter((t) => !t.passed);
  return {
    required: sorted(failing.filter((t) => t.required).map((t) => t.id)),
    optional: sorted(failing.filter((t) => !t.required).map((t) => t.id)),
    details: failing.map((t) => `${t.required ? "REQUIRED" : "optional"} ${t.id}: ${t.details}`),
  };
}

function expectFailingSets(report: ComplianceReport, required: string[], optional: string[]) {
  const got = failures(report);
  expect({ required: got.required, optional: got.optional }, got.details.join("\n")).toEqual({
    required: sorted(required),
    optional: sorted(optional),
  });
}

/** The two claim-less probes drew a clean -32602 (no "expected -32602" warning). */
function expectClaimLessProbesClean(report: ComplianceReport, status: string) {
  expect(resultOf(report, "lifecycle-meta-required").details).toBe(
    `server/discover without _meta: rejected with -32602${status}`,
  );
  expect(resultOf(report, "lifecycle-meta-protocol-version-required").details).toBe(
    `server/discover without _meta protocolVersion: rejected with -32602${status}`,
  );
  expect(report.warnings.filter((w) => CLAIM_LESS_PROBES.some((id) => w.startsWith(`${id}:`)))).toEqual([]);
}

describe("SDK v2 over HTTP, default (dual-era) serving", () => {
  let mounted: Mounted;
  let report: ComplianceReport;

  beforeAll(async () => {
    mounted = await mount("stateless");
    report = await runComplianceSuite(mounted.url, { timeout: 5000 });
  }, 60_000);

  afterAll(async () => {
    await unmount(mounted);
  });

  it("auto resolves to 2026-07-28 with the detection note", () => {
    expect(report.specVersion).toBe("2026-07-28");
    expect(report.serverInfo.protocolVersion).toBe("2026-07-28");
    expect(report.warnings.filter((w) => w === AUTO_DETECT_NOTE)).toHaveLength(1);
    expect(report.warnings.some((w) => w.includes("unreachable"))).toBe(false);
  });

  it("discovers the registered surface through server/discover", () => {
    expect(report.serverInfo.name).toBe("sdk2-http-server");
    expect(report.serverInfo.version).toBe("2.0.0");
    expect(Object.keys(report.serverInfo.capabilities ?? {}).sort()).toEqual(["prompts", "resources", "tools"]);
    expect(report.toolCount).toBe(1);
    expect(report.toolNames).toEqual(["echo"]);
    expect(report.resourceCount).toBe(1);
    expect(report.resourceNames).toEqual(["hello"]);
    expect(report.promptCount).toBe(1);
    expect(report.promptNames).toEqual(["greeting"]);
  });

  it("runs the HTTP catalog minus the capability-gated completions test", () => {
    expect(report.tests).toHaveLength(HTTP_TEST_COUNT);
    expect(report.tests.some((t) => t.id === "lifecycle-completions")).toBe(false);
  });

  it("fails exactly the localhost-inherent checks plus the documented SDK deviation", () => {
    expectFailingSets(report, SDK_HTTP_REQUIRED_DEVIATIONS, LOCALHOST_INHERENT);
    expect(resultOf(report, "security-auth-required").details).toBe(LOCALHOST_AUTH_REQUIRED);
  });

  it("grades A on score; the single required miss keeps overall at fail", () => {
    expect(report.grade).toBe("A");
    expect(report.score).toBeGreaterThanOrEqual(90);
    expect(report.overall).toBe("fail");
    expect(report.summary.required - report.summary.requiredPassed).toBe(SDK_HTTP_REQUIRED_DEVIATIONS.length);
  });

  it("reports the served legacy handshake as dual-era in lifecycle-dual-era", () => {
    const dual = resultOf(report, "lifecycle-dual-era");
    expect(dual.passed, dual.details).toBe(true);
    expect(dual.details).toBe(
      "dual-era: initialize answered with protocolVersion 2025-11-25; legacy handshake served alongside 2026-07-28",
    );
  });

  it("the dual-era warning names --spec-version 2025-11-25 although supportedVersions lists only 2026-07-28", () => {
    // The SDK advertises `["2026-07-28"]` -- the spec describes
    // supportedVersions as the modern per-request versions the client
    // "should choose one of ... for subsequent requests" -- while still
    // serving `initialize`; the warning keys on the served handshake.
    const dual = report.warnings.find((w) => w.startsWith("Server is dual-era"));
    expect(dual, `warnings: ${JSON.stringify(report.warnings, null, 2)}`).toBe(
      "Server is dual-era (also serves the legacy initialize handshake); this run graded 2026-07-28. Re-run with --spec-version 2025-11-25 to test the legacy handshake.",
    );
  });

  it("the claim-less _meta probes draw a clean -32602 over HTTP", () => {
    expectClaimLessProbesClean(report, " (HTTP 400)");
  });

  it("only warns about the auto-detection, the oversized-input observation, the quiet burst and the dual era", () => {
    const prefixes = report.warnings.map((w) => w.split(":")[0]);
    expect(sorted(prefixes)).toEqual(
      sorted([
        AUTO_DETECT_NOTE.split(":")[0],
        "security-oversized-input",
        "security-rate-limiting",
        "Server is dual-era (also serves the legacy initialize handshake); this run graded 2026-07-28. Re-run with --spec-version 2025-11-25 to test the legacy handshake.",
      ]),
    );
    expect(new Set(report.warnings).size).toBe(report.warnings.length);
  });
});

describe("SDK v2 over HTTP, pinned --spec-version 2025-11-25", () => {
  let mounted: Mounted;
  let report: ComplianceReport;

  beforeAll(async () => {
    mounted = await mount("stateless");
    report = await runComplianceSuite(mounted.url, { timeout: 5000, specVersion: "2025-11-25" });
  }, 60_000);

  afterAll(async () => {
    await unmount(mounted);
  });

  it("runs the legacy suite: the initialize handshake succeeds and the report is stamped 2025-11-25", () => {
    expect(report.specVersion).toBe("2025-11-25");
    expect(report.warnings.some((w) => w.includes("auto-detected"))).toBe(false);
    const init = resultOf(report, "lifecycle-init");
    expect(init.passed, init.details).toBe(true);
    expect(report.serverInfo.protocolVersion).toBe("2025-11-25");
    expect(report.serverInfo.name).toBe("sdk2-http-server");
    expect(report.toolNames).toEqual(["echo"]);
    expect(report.resourceNames).toEqual(["hello"]);
    expect(report.promptNames).toEqual(["greeting"]);
  });

  it("stateless legacy serving: no session id, second initialize accepted", () => {
    // Each legacy request is a fresh stateless instance, so there is nothing
    // to re-initialize against; the suite reports that honestly.
    expect(resultOf(report, "lifecycle-reinit-reject").passed).toBe(false);
    expect(resultOf(report, "lifecycle-reinit-reject").details).toMatch(/accepted second initialize/);
  });

  it("fails exactly the loopback checks, the stateless reinit, and the batch deviation", () => {
    // The legacy injection checks read the echo tool's verbatim reflection
    // as benign (as the 2026 suite always did), so no echo artifacts here.
    expectFailingSets(report, SDK_LEGACY_REQUIRED_DEVIATIONS, [
      ...LEGACY_LOCALHOST_INHERENT,
      "lifecycle-reinit-reject",
    ]);
    // Without --auth the legacy check reads the preflight, which the SDK
    // served: an accepted request, not a refusal.
    expect(resultOf(report, "security-auth-required").details).toMatch(/accepted unauthenticated/);
  });
});

describe("SDK v2 over HTTP, legacy: 'reject' (modern-only)", () => {
  let mounted: Mounted;
  let report: ComplianceReport;

  beforeAll(async () => {
    mounted = await mount("reject");
    report = await runComplianceSuite(mounted.url, { timeout: 5000 });
  }, 60_000);

  afterAll(async () => {
    await unmount(mounted);
  });

  it("auto resolves to 2026-07-28 and lifecycle-dual-era reports modern-only", () => {
    expect(report.specVersion).toBe("2026-07-28");
    const dual = resultOf(report, "lifecycle-dual-era");
    expect(dual.passed, dual.details).toBe(true);
    // -32022 whose message only echoes the rejected 2025-11-25; the
    // supported list lives in data.supported, which is where the spec's
    // UnsupportedProtocolVersionError puts it -- credited from there.
    expect(dual.details).toBe(
      "modern-only: initialize rejected with -32022 (HTTP 400); data.supported names supported versions",
    );
    expect(report.warnings.some((w) => w.startsWith("Server is dual-era"))).toBe(false);
    expect(report.warnings.some((w) => w.startsWith("lifecycle-dual-era:"))).toBe(false);
  });

  it("fails exactly the localhost-inherent checks plus the header deviation (a MUST in this mode)", () => {
    expect(report.tests).toHaveLength(HTTP_TEST_COUNT);
    expectFailingSets(report, SDK_HTTP_REQUIRED_DEVIATIONS, LOCALHOST_INHERENT);
    expect(resultOf(report, "security-auth-required").details).toBe(LOCALHOST_AUTH_REQUIRED);
    expectClaimLessProbesClean(report, " (HTTP 400)");
  });
});

/**
 * The SDK's Host guard answers a hostname it does not allow -- a tunnel or
 * proxy name in front of a server that allows only loopback names -- with a
 * bare HTTP 403: `{"error":{"code":-32000,"message":"Invalid Host: ..."}}`
 * and no WWW-Authenticate. Reproduced by allowing only a hostname the run
 * does not use, so every request draws it, credentialed or not: the 403
 * says nothing about authentication (basic/authorization answers missing
 * authorization with 401), and security-auth-required must not credit it.
 */
describe("SDK v2 behind its Host guard: a bare 403 on every request is not an authentication rejection", () => {
  const ID = "security-auth-required";
  let mounted: Mounted;
  let noAuth: ComplianceReport;
  let withAuth: ComplianceReport;

  beforeAll(async () => {
    mounted = await mount("reject", { allowedHosts: ["mcp.example.com"] });
    const pinned = { timeout: 5000, specVersion: "2026-07-28" as const, only: [ID] };
    noAuth = await runComplianceSuite(mounted.url, pinned);
    withAuth = await runComplianceSuite(mounted.url, { ...pinned, headers: { Authorization: "Bearer tok" } });
  }, 60_000);

  afterAll(async () => {
    await unmount(mounted);
  });

  it("fixture contract: the guard answers the credentialed request with the same bare 403 and the SDK's Invalid Host error", async () => {
    const res = await fetch(mounted.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer tok",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover", params: {} }),
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toBeNull();
    expect(await res.json()).toEqual({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Invalid Host: 127.0.0.1" },
      id: null,
    });
  });

  it("without --auth: not evaluable, quoting the guard and pointing at the allowed hosts, not --auth", () => {
    // Before: passed as "HTTP 403 (unauthenticated request rejected); pass
    // --auth to exercise the rest of the auth suite".
    const result = resultOf(noAuth, ID);
    expect([result.passed, result.details]).toEqual([
      false,
      'not evaluable: HTTP 403 without a Bearer challenge ("Invalid Host: 127.0.0.1") names Host/Origin validation, not authentication: allow the hostname you tested through',
    ]);
  });

  it("with --auth: the credentialed server/discover drew the same 403, so the credential is not the variable either", () => {
    // Before: passed as "HTTP 403 (unauthenticated request rejected)".
    const result = resultOf(withAuth, ID);
    expect([result.passed, result.details]).toEqual([
      false,
      'not evaluable: HTTP 403 without a Bearer challenge ("Invalid Host: 127.0.0.1") names Host/Origin validation, not authentication: allow the hostname you tested through',
    ]);
  });
});

/**
 * The SDK behind a gate that answers a missing (or wrong) credential with a
 * bare 403 instead of the 401 the spec requires. With --auth the SDK serves
 * the credentialed server/discover, so the credential is the only variable
 * and the 403 is credited; without it the same 403 cannot be told from the
 * Host guard's above.
 */
/**
 * The loopback server a README tells you to mount, reached through a tunnel
 * that forwards its public hostname: the SDK's default Host guard answers
 * "Invalid Host: <tunnel hostname>" to every request. The hostname is the
 * one actionable part of the details, so it must survive the 220-character
 * limit whole, with and without --auth.
 */
describe("SDK v2 reached through a tunnel hostname", () => {
  const ID = "security-auth-required";
  const HOST = "gentle-river-shadow-4821.trycloudflare.com";
  let mounted: Mounted;
  let noAuth: ComplianceReport;
  let withAuth: ComplianceReport;

  beforeAll(async () => {
    mounted = await mount("reject", { tunnelHost: HOST });
    const pinned = { timeout: 5000, specVersion: "2026-07-28" as const, only: [ID] };
    noAuth = await runComplianceSuite(mounted.url, pinned);
    withAuth = await runComplianceSuite(mounted.url, { ...pinned, headers: { Authorization: "Bearer tok" } });
  }, 60_000);

  afterAll(async () => {
    await unmount(mounted);
  });

  it("quotes the whole tunnel hostname and advises allowing it, with and without --auth", () => {
    // Before: with --auth the quoted message was clipped to "Invalid Host:
    // gentle-..." (the fixed text left 24 characters), and both runs advised
    // --auth, which a Host guard refuses the same way.
    const expected = `not evaluable: HTTP 403 without a Bearer challenge ("Invalid Host: ${HOST}") names Host/Origin validation, not authentication: allow the hostname you tested through`;
    for (const report of [noAuth, withAuth]) {
      const result = resultOf(report, ID);
      expect([result.passed, result.details]).toEqual([false, expected]);
    }
  });
});

describe("SDK v2 behind a gate that answers a missing credential with a bare 403", () => {
  const ID = "security-auth-required";
  let mounted: Mounted;
  let noAuth: ComplianceReport;
  let withAuth: ComplianceReport;
  let wrongAuth: ComplianceReport;

  beforeAll(async () => {
    mounted = await mount("reject", { bare403Unless: "Bearer tok" });
    const pinned = { timeout: 5000, specVersion: "2026-07-28" as const, only: [ID] };
    noAuth = await runComplianceSuite(mounted.url, pinned);
    withAuth = await runComplianceSuite(mounted.url, { ...pinned, headers: { Authorization: "Bearer tok" } });
    wrongAuth = await runComplianceSuite(mounted.url, { ...pinned, headers: { Authorization: "Bearer wrong" } });
  }, 60_000);

  afterAll(async () => {
    await unmount(mounted);
  });

  it("with --auth: the SDK served the credentialed server/discover, so the 403 passes, naming the 401 the spec expects", () => {
    expect(withAuth.serverInfo.name).toBe("sdk2-http-server");
    const result = resultOf(withAuth, ID);
    expect([result.passed, result.details]).toEqual([
      true,
      "HTTP 403 without a Bearer challenge (unauthenticated request rejected; the same request with the credential was served) -- the spec expects 401 when authorization is required",
    ]);
  });

  it("without --auth: the same 403 is not evaluable", () => {
    const result = resultOf(noAuth, ID);
    expect([result.passed, result.details]).toEqual([
      false,
      'not evaluable: HTTP 403 without a Bearer challenge ("Forbidden") may be Host/Origin validation or a gateway; pass --auth to compare with a credentialed request',
    ]);
  });

  it("with a credential the gate refuses the same way: not evaluable, pointing at the gate rather than --auth", () => {
    const result = resultOf(wrongAuth, ID);
    expect([result.passed, result.details]).toEqual([
      false,
      'not evaluable: HTTP 403 without a Bearer challenge ("Forbidden") may be Host/Origin validation or a gateway; the credentialed request got 403 too: fix the gateway or allowed hosts',
    ]);
  });
});

describe("SDK v2 over stdio (serveStdio)", () => {
  const target = (env: Record<string, string> = {}): TransportTarget => ({
    type: "stdio",
    command: process.execPath,
    args: [SDK2_STDIO_FIXTURE],
    env,
  });
  const run = (env: Record<string, string> = {}, extra: Record<string, unknown> = {}) =>
    runComplianceSuite(target(env), { timeout: 5000, startupTimeout: 15_000, ...extra });

  it("default (legacy: serve): every test passes, A / 100, and the era survives the late claim-less probes", async () => {
    const report = await run();
    expect(report.specVersion).toBe("2026-07-28");
    expect(report.serverInfo.name).toBe("sdk2-stdio-server");
    expect(report.toolNames).toEqual(["echo"]);
    expect(report.tests).toHaveLength(STDIO_TEST_COUNT);
    expectFailingSets(report, [], []);
    expect(report.grade).toBe("A");
    expect(report.score).toBe(100);
    expect(report.overall).toBe("pass");
    // Sent on the already-modern process: -32602, not the -32601 a flipped
    // legacy instance would answer (see CLAIM_LESS_PROBES).
    expectClaimLessProbesClean(report, "");
    // The initialize probe went to a FRESH child, where a legacy client's
    // opening is served: the suite's own process, pinned modern, would have
    // rejected it with -32022 and mislabelled the server modern-only.
    expect(resultOf(report, "lifecycle-dual-era").details).toBe(
      "dual-era: initialize answered with protocolVersion 2025-11-25 on a fresh process; legacy handshake served alongside 2026-07-28",
    );
    expect(
      report.warnings.some((w) => w.startsWith("Server is dual-era (also serves the legacy initialize handshake)")),
    ).toBe(true);
  }, 60_000);

  it("SDK2_LEGACY=reject: modern-only, every test passes, initialize rejected with -32022 on a fresh process", async () => {
    const report = await run({ SDK2_LEGACY: "reject" });
    expect(report.specVersion).toBe("2026-07-28");
    expect(report.tests).toHaveLength(STDIO_TEST_COUNT);
    expect(resultOf(report, "lifecycle-dual-era").details).toBe(
      "modern-only: initialize rejected with -32022 on a fresh process; data.supported names supported versions",
    );
    // With the claim-less probes late, the SDK answers them -32602 like the
    // serve mode does; the -32022-without-`requested` replies that used to
    // trip schema-wire-valid were an artifact of probing before the pin.
    expectFailingSets(report, [], []);
    expectClaimLessProbesClean(report, "");
    expect(resultOf(report, "schema-wire-valid").details).toMatch(/no violations/);
    expect(report.grade).toBe("A");
    expect(report.warnings.some((w) => w.startsWith("Server is dual-era"))).toBe(false);
  }, 60_000);

  it("pinned 2025-11-25: the legacy suite initializes and every required test passes", async () => {
    const report = await run({}, { specVersion: "2025-11-25" });
    expect(report.specVersion).toBe("2025-11-25");
    const init = resultOf(report, "lifecycle-init");
    expect(init.passed, init.details).toBe(true);
    expect(report.serverInfo.name).toBe("sdk2-stdio-server");
    expect(report.toolNames).toEqual(["echo"]);
    expectFailingSets(report, [], []);
    expect(report.warnings.filter((w) => w.startsWith("security-oversized-input"))).toEqual([]);
  }, 60_000);

  it("pinned 2025-11-25, a process that exits on a stdin line over 500 KB: only oversized-input fails, the rest run against a restarted child", async () => {
    // The same SDK server, preloaded with a stdin reader that exits the
    // process once a line passes 500 KB -- what a server with a line-length
    // guard (or one that runs out of memory) does with the 1 MB tools/call.
    const exitOnLongLine = [
      "let n = 0;",
      'process.stdin.on("data", (c) => {',
      '  const s = c.toString("utf8");',
      '  const i = s.lastIndexOf("\\n");',
      "  n = i === -1 ? n + s.length : s.length - i - 1;",
      "  if (n > 500000) process.exit(3);",
      "});",
    ].join("\n");
    const report = await runComplianceSuite(
      {
        type: "stdio",
        command: process.execPath,
        args: ["--import", `data:text/javascript,${encodeURIComponent(exitOnLongLine)}`, SDK2_STDIO_FIXTURE],
      },
      { timeout: 5000, startupTimeout: 15_000, specVersion: "2025-11-25" },
    );
    expect(report.serverInfo.name).toBe("sdk2-stdio-server");
    // Before: the child stayed dead, so the required stdio-framing failed
    // ("5/5 rapid pings failed — framing likely broken"), overall "fail",
    // security-extra-params passed "Request rejected (acceptable)" and
    // rug-pull, stdio-unicode and stdio-unknown-method-recovers failed.
    expectFailingSets(report, [], ["security-oversized-input"]);
    expect(resultOf(report, "security-oversized-input").details).toMatch(
      /^server died on a 1 MB echo\.data: .*exit code 3/,
    );
    expect(report.overall).not.toBe("fail");
    expect(resultOf(report, "stdio-framing").details).toBe("5/5 rapid pings returned cleanly");
    expect(resultOf(report, "security-extra-params").details).toBe(
      "Server processed request (extra params likely ignored)",
    );
    expect(report.warnings.filter((w) => w.startsWith("security-oversized-input"))).toEqual([
      "security-oversized-input: the server exited on a 1 MB echo.data and was restarted with a fresh initialize handshake, so the tests after it ran against the new instance.",
    ]);
  }, 90_000);

  it("--only <claim-less probe>: the process is pinned modern first, so the verdict matches the full run", async () => {
    // Only the setup discover has run, and discover does not pin: without a
    // modern request first, the SDK reads the claim-less probe as a legacy
    // opening and answers -32601 (with an "expected -32602" warning).
    const single = await run({}, { only: ["lifecycle-meta-required"] });
    expect(single.tests.map((t) => t.id)).toEqual(["lifecycle-meta-required"]);
    expect(resultOf(single, "lifecycle-meta-required").details).toBe(
      "server/discover without _meta: rejected with -32602",
    );
    expect(single.warnings.filter((w) => w.startsWith("lifecycle-meta-required:"))).toEqual([]);
    // The pin request was the declared tools list, published to the report.
    expect(single.toolNames).toEqual(["echo"]);

    const pair = await run({}, { only: CLAIM_LESS_PROBES });
    expect(pair.tests.map((t) => t.id)).toEqual(CLAIM_LESS_PROBES);
    expectClaimLessProbesClean(pair, "");
  }, 60_000);
});
