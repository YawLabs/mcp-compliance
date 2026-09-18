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

/**
 * The auth checks that send a request with no valid credential and read the
 * 401/403 answering it. When security-auth-required cannot attribute that
 * 403 to authentication, the same refusal is no evidence for them either
 * and they skip (security-oauth-metadata without --auth, which is the only
 * thing that says the server is auth-protected at all; with one, only when
 * the well-known metadata locations drew the same 403).
 */
const AUTH_SIBLINGS = [
  "security-www-authenticate",
  "security-auth-malformed",
  "security-oauth-metadata",
  "security-token-in-uri",
];
const SIBLING_SKIP =
  "Skipped: HTTP 403 without a Bearer challenge, not attributable to authentication (see security-auth-required)";

const detailsOf = (report: ComplianceReport, id: string) => resultOf(report, id).details;

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

  it("the negative probes that now read a gate's answer as not evaluable keep their verdicts", () => {
    // The SDK answers each probe itself next to a served handshake, so
    // attributing the rejection changes nothing; the batch is the documented
    // deviation (SDK_LEGACY_REQUIRED_DEVIATIONS) either way.
    const verdict = (id: string) => {
      const t = resultOf(report, id);
      return `${t.passed ? "PASS" : "FAIL"}: ${t.details}`;
    };
    expect({
      ct: verdict("transport-content-type-reject"),
      batch: verdict("transport-batch-reject"),
      version: verdict("lifecycle-version-negotiate"),
      unknown: verdict("error-unknown-method"),
    }).toEqual({
      ct: "PASS: HTTP 415 (incorrect Content-Type rejected)",
      batch: "FAIL: HTTP 200 — expected error or 4xx for batch request",
      version: "PASS: Server negotiated down to 2025-11-25 (correct)",
      unknown: "PASS: Error code: -32601 (correct: Method not found) — Method not found",
    });
  });

  it("the error checks and lifecycle-jsonrpc, which now read a gate's answer as not evaluable, keep their verdicts", () => {
    // The SDK answers each of them itself next to a served handshake, so
    // attributing the answer changes nothing and nothing is warned about.
    const verdict = (id: string) => {
      const t = resultOf(report, id);
      return `${t.passed ? "PASS" : "FAIL"}${t.skipped ? " (skipped)" : ""}: ${t.details}`;
    };
    // The SDK's -32602 carries its zod error, a multi-line message.
    expect(verdict("error-missing-params")).toMatch(
      /^PASS: Error code: -32602 \(correct: Invalid params\) — Invalid tools\/call request: \[/,
    );
    expect({
      jsonrpc: verdict("lifecycle-jsonrpc"),
      envelope: verdict("error-invalid-jsonrpc"),
      parse: verdict("error-invalid-json"),
      gated: verdict("error-capability-gated"),
    }).toEqual({
      jsonrpc: "PASS: Valid JSON-RPC 2.0 response",
      envelope:
        "PASS: Error code: -32600 (correct: Invalid Request) — Bad Request: the request body is not a valid JSON-RPC message",
      parse: "PASS: Error code: -32700 — Parse error: Invalid JSON",
      gated:
        "PASS (skipped): Server declares all capabilities (tools, resources, prompts) — no undeclared methods to test",
    });
    expect(report.warnings.filter((w) => /^(lifecycle-jsonrpc|error-)/.test(w))).toEqual([]);
  });

  it("security-cors-headers and lifecycle-progress-token, which now read a missing answer and the progress they get, keep their verdicts", () => {
    const verdict = (id: string) => {
      const t = resultOf(report, id);
      return `${t.passed ? "PASS" : "FAIL"}${t.skipped ? " (skipped)" : ""}: ${t.details}`;
    };
    expect({ cors: verdict("security-cors-headers"), progress: verdict("lifecycle-progress-token") }).toEqual({
      // SDK v2's Origin guard refuses both probes (they carry a foreign
      // Origin) with no CORS headers.
      cors: "PASS: No CORS headers returned (OPTIONS HTTP 403, POST HTTP 403; server-to-server only, acceptable)",
      progress: "PASS: Server accepted request with progressToken (no progress events observed — optional)",
    });
    expect(report.warnings.filter((w) => /^(security-cors-headers|lifecycle-progress-token)/.test(w))).toEqual([]);
  });
});

describe("SDK v2 behind its Host guard, pinned --spec-version 2025-11-25: the error checks and lifecycle-jsonrpc do not credit the guard", () => {
  let mounted: Mounted;
  let report: ComplianceReport;

  beforeAll(async () => {
    mounted = await mount("stateless", { allowedHosts: ["mcp.example.com"] });
    report = await runComplianceSuite(mounted.url, {
      timeout: 5000,
      specVersion: "2025-11-25",
      only: [
        "lifecycle-jsonrpc",
        "error-invalid-jsonrpc",
        "error-invalid-json",
        "error-missing-params",
        "error-capability-gated",
      ],
    });
  }, 60_000);

  afterAll(async () => {
    await unmount(mounted);
  });

  it("every request drew the guard's 403, so each fails as not evaluable (before: five passes)", () => {
    // Before: PASS "Valid JSON-RPC 2.0 response" on the guard's envelope, PASS
    // "Error code: -32000 — Invalid Host: 127.0.0.1" three times, and PASS
    // "Tested 3 undeclared method(s) ... all returned errors".
    const byId = Object.fromEntries(report.tests.map((t) => [t.id, `${t.passed ? "PASS" : "FAIL"}: ${t.details}`]));
    const rpc403 = "HTTP 403, JSON-RPC error -32000";
    const handshake = (what: string) =>
      `not evaluable: the initialize handshake was not served either (${rpc403}), so this rejection proves nothing about ${what} (see lifecycle-init)`;
    expect(byId).toEqual({
      "lifecycle-jsonrpc": `FAIL: ${rpc403} on the initialize handshake ("Invalid Host: 127.0.0.1") -- not evaluable: the message names Host/Origin validation, which refuses a request whatever it carries`,
      "error-invalid-jsonrpc": `FAIL: ${rpc403} on the malformed JSON-RPC message -- ${handshake("the malformed JSON-RPC message")}`,
      "error-invalid-json": `FAIL: ${rpc403} on the invalid JSON body -- ${handshake("the invalid JSON body")}`,
      "error-missing-params": `FAIL: ${rpc403} on tools/call without a name -- ${handshake("the missing tool name")}`,
      "error-capability-gated": `FAIL: tools/list -> ${rpc403}, resources/list -> ${rpc403}, prompts/list -> ${rpc403} -- not evaluable: the initialize handshake was not served (${rpc403}), so the suite never saw which capabilities the server declares, and these answers prove nothing about undeclared methods (see lifecycle-init)`,
    });
  });
});

describe("SDK v2 behind its Host guard, pinned --spec-version 2025-11-25: the negative probes do not credit the guard", () => {
  let mounted: Mounted;
  let report: ComplianceReport;

  beforeAll(async () => {
    mounted = await mount("stateless", { allowedHosts: ["mcp.example.com"] });
    report = await runComplianceSuite(mounted.url, {
      timeout: 5000,
      specVersion: "2025-11-25",
      only: [
        "transport-content-type-reject",
        "transport-batch-reject",
        "lifecycle-version-negotiate",
        "error-unknown-method",
      ],
    });
  }, 60_000);

  afterAll(async () => {
    await unmount(mounted);
  });

  it("every probe drew the guard's 403, so each fails as not evaluable (before: four passes)", () => {
    // Before: PASS "HTTP 403 (incorrect Content-Type rejected)", PASS "HTTP
    // 403 (batch rejected)", and the version and method checks credited the
    // guard's -32000 "Invalid Host" error as the server's rejection.
    const byId = Object.fromEntries(report.tests.map((t) => [t.id, `${t.passed ? "PASS" : "FAIL"}: ${t.details}`]));
    const guard = `("Invalid Host: 127.0.0.1") -- not evaluable: the message names Host/Origin validation, which refuses a request whatever it carries`;
    const handshake =
      "not evaluable: the initialize handshake was not served either (HTTP 403, JSON-RPC error -32000), so this rejection proves nothing about";
    expect(byId).toEqual({
      "transport-content-type-reject": `FAIL: HTTP 403, JSON-RPC error -32000 on the text/plain POST ${guard}`,
      "transport-batch-reject": `FAIL: HTTP 403, JSON-RPC error -32000 on the batch ${guard}`,
      "lifecycle-version-negotiate": `FAIL: HTTP 403, JSON-RPC error -32000 on the initialize requesting protocol version 2099-01-01 -- ${handshake} the unknown version (see lifecycle-init)`,
      "error-unknown-method": `FAIL: HTTP 403, JSON-RPC error -32000 on nonexistent/method -- ${handshake} the unknown method (see lifecycle-init)`,
    });
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
  const ORIGIN = "security-origin-validation";
  const RATE = "security-rate-limiting";
  let mounted: Mounted;
  let noAuth: ComplianceReport;
  let withAuth: ComplianceReport;

  beforeAll(async () => {
    mounted = await mount("reject", { allowedHosts: ["mcp.example.com"] });
    const pinned = { timeout: 5000, specVersion: "2026-07-28" as const, only: [ID, ...AUTH_SIBLINGS, ORIGIN, RATE] };
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

  it("the siblings skip that same 403 rather than crediting the guard, with and without --auth", () => {
    // Before: security-www-authenticate PASSED "HTTP 403 (WWW-Authenticate
    // not applicable for 403)" and security-auth-malformed PASSED "HTTP 403"
    // on both probes -- the Host guard's blanket 403 read as three separate
    // pieces of evidence that the server validates credentials.
    expect(detailsOf(noAuth, "security-www-authenticate")).toBe(SIBLING_SKIP);
    expect(detailsOf(withAuth, "security-www-authenticate")).toBe(SIBLING_SKIP);
    expect(detailsOf(withAuth, "security-auth-malformed")).toBe(SIBLING_SKIP);
    // Before: PASSED "HTTP 403 (token in query string rejected)" -- the
    // guard's 403, read as the server refusing a token it never looked at.
    expect(detailsOf(withAuth, "security-token-in-uri")).toBe(SIBLING_SKIP);
    // Without a credential there is nothing to compare against, as before.
    expect(detailsOf(noAuth, "security-auth-malformed")).toBe(
      "Skipped: needs a valid credential to compare against (pass --auth)",
    );
    expect(detailsOf(noAuth, "security-token-in-uri")).toBe(
      "Skipped: needs a valid credential to place in the URI (pass --auth)",
    );
    for (const report of [noAuth, withAuth]) {
      for (const id of AUTH_SIBLINGS) expect(resultOf(report, id).passed, id).toBe(true);
    }
  });

  it("security-oauth-metadata skips without --auth and, with one, once the well-known locations drew the guard's 403 too", () => {
    // Before, without --auth: the bare 403 sent it to the well-known
    // locations and it FAILED "No Protected Resource Metadata", blaming the
    // server for metadata a Host guard was never going to serve.
    expect(detailsOf(noAuth, "security-oauth-metadata")).toBe(SIBLING_SKIP);
    // With --auth the lookup still happens -- a document it finds would
    // pass -- but the guard answers every well-known location with the same
    // bare 403. Before: FAILED "No Protected Resource Metadata
    // (/.well-known/oauth-protected-resource/mcp -> HTTP 403;
    // /.well-known/oauth-protected-resource -> HTTP 403) and no legacy OAuth
    // metadata", advising a document the guard would never let through.
    const withCredential = resultOf(withAuth, "security-oauth-metadata");
    expect([withCredential.passed, withCredential.details]).toEqual([
      true,
      "Skipped: HTTP 403 without a Bearer challenge on the endpoint and on every well-known metadata location, not attributable to authentication (see security-auth-required)",
    ]);
  });

  it("security-origin-validation and security-rate-limiting do not read the guard's 403 as an Origin check or an auth gate", () => {
    // Before: origin-validation PASSED "HTTP 403 (suspicious Origin
    // rejected)" on the guard's answer to every request, and
    // rate-limiting skipped as "rejected by auth (HTTP 403)", advising
    // --auth or the configured credential.
    for (const report of [noAuth, withAuth]) {
      const origin = resultOf(report, ORIGIN);
      expect([origin.passed, origin.details]).toEqual([
        true,
        "Skipped: HTTP 403 to the foreign Origin, but the conformant server/discover was not served either, so the refusal is not attributable to the Origin (see security-auth-required)",
      ]);
      const rate = resultOf(report, RATE);
      expect([rate.passed, rate.details]).toEqual([
        true,
        "Skipped: all 50 rapid server/discover requests drew HTTP 403 before reaching a handler, not as an auth refusal (Host/Origin validation or a gateway), so rate limiting was not measured (see security-auth-required)",
      ]);
    }
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
  const ORIGIN = "security-origin-validation";
  let mounted: Mounted;
  let noAuth: ComplianceReport;
  let withAuth: ComplianceReport;
  let wrongAuth: ComplianceReport;

  beforeAll(async () => {
    mounted = await mount("reject", { bare403Unless: "Bearer tok" });
    const pinned = { timeout: 5000, specVersion: "2026-07-28" as const, only: [ID, ...AUTH_SIBLINGS, ORIGIN] };
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

  it("with --auth the credential is the variable, so the siblings measure the gate instead of skipping", () => {
    // The gate answers every credential but `Bearer tok` with the same bare
    // 403, which here is a real (if non-conformant) rejection: the SDK
    // served the credentialed request.
    expect(detailsOf(withAuth, "security-www-authenticate")).toBe("HTTP 403 (WWW-Authenticate not applicable for 403)");
    expect(detailsOf(withAuth, "security-auth-malformed")).toBe(
      "well-formed invalid token: HTTP 403; malformed credential: HTTP 403",
    );
    expect(detailsOf(withAuth, "security-token-in-uri")).toBe("HTTP 403 (token in query string rejected)");
  });

  it("with --auth the SDK's own Origin guard answering the foreign Origin with 403 is credited: the Origin is the one variable", () => {
    // localhostOriginValidation refuses the foreign Origin before the gate
    // or the SDK sees the request; the same request without it was served.
    const origin = resultOf(withAuth, ORIGIN);
    expect([origin.passed, origin.details]).toEqual([true, "HTTP 403 (suspicious Origin rejected)"]);
  });

  it("without a credential the gate accepts, the siblings skip rather than credit the same 403", () => {
    // Before: both runs PASSED www-authenticate on "HTTP 403
    // (WWW-Authenticate not applicable for 403)", and auth-malformed passed
    // the wrongAuth run on the gate's 403; token-in-uri passed it as "HTTP
    // 403 (token in query string rejected)".
    expect(detailsOf(noAuth, "security-www-authenticate")).toBe(SIBLING_SKIP);
    expect(detailsOf(wrongAuth, "security-www-authenticate")).toBe(SIBLING_SKIP);
    expect(detailsOf(wrongAuth, "security-auth-malformed")).toBe(SIBLING_SKIP);
    expect(detailsOf(wrongAuth, "security-token-in-uri")).toBe(SIBLING_SKIP);
    expect(detailsOf(noAuth, "security-oauth-metadata")).toBe(SIBLING_SKIP);
  });

  it("security-oauth-metadata: the gate's 403 on the metadata is a finding next to a served credential, and not evaluable next to a refused one", () => {
    // The credential is the variable, so the 403 is an auth gate -- and it
    // stands in front of the metadata clients must fetch without one.
    const served = resultOf(withAuth, "security-oauth-metadata");
    expect([served.passed, served.details]).toEqual([
      false,
      "No Protected Resource Metadata (/.well-known/oauth-protected-resource/mcp -> HTTP 403; /.well-known/oauth-protected-resource -> HTTP 403) and no legacy OAuth metadata",
    ]);
    // With a credential the gate refuses too, the same 403s are the one
    // refusal nothing could attribute. Before: the same FAIL as above.
    const refused = resultOf(wrongAuth, "security-oauth-metadata");
    expect([refused.passed, refused.details]).toEqual([
      true,
      "Skipped: HTTP 403 without a Bearer challenge on the endpoint and on every well-known metadata location, not attributable to authentication (see security-auth-required)",
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
    // The two negative probes that run over stdio are answered by the SDK
    // next to a served handshake: attributing their answer changes nothing.
    expect(resultOf(report, "lifecycle-version-negotiate").details).toBe(
      "Server negotiated down to 2025-11-25 (correct)",
    );
    expect(resultOf(report, "error-unknown-method").details).toBe(
      "Error code: -32601 (correct: Method not found) — Method not found",
    );
    // So are the error checks that run over stdio, and the handshake's
    // envelope is the SDK's own: reading whose answer each is changes nothing.
    expect(resultOf(report, "lifecycle-jsonrpc").details).toBe("Valid JSON-RPC 2.0 response");
    expect(resultOf(report, "error-missing-params").details).toMatch(
      /^Error code: -32602 \(correct: Invalid params\) — Invalid tools\/call request: \[/,
    );
    expect(resultOf(report, "error-capability-gated").details).toBe(
      "Server declares all capabilities (tools, resources, prompts) — no undeclared methods to test",
    );
    // The echo tool reflects the unicode probe intact, judged the 2026-07-28
    // way now. Before: "Unicode string round-tripped through tool call".
    expect(resultOf(report, "stdio-unicode").details).toBe(
      "tools/call echo reproduced the CJK/emoji probe byte-for-byte",
    );
    // The SDK completes the 1 MB call, which passes as survived with the
    // body-limit advice (the 2026-07-28 suite words it the same way).
    expect(report.warnings.filter((w) => w.startsWith("security-oversized-input"))).toEqual([
      "security-oversized-input: the server completed a tools/call carrying a 1 MB string argument (echo.data) instead of rejecting it; enforce a request body limit (413) or maxLength in inputSchema.",
    ]);
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
    // Both of rug-pull's lists come from the restarted child: the one read at
    // the restart, before any tools/call, and one after a tools/call.
    // Before: the first child's list against the new one's.
    expect(resultOf(report, "security-tool-rug-pull").details).toBe(
      "1 tool(s) consistent across 2 calls to the server restarted after security-oversized-input (before and after a tools/call)",
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
