import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, type McpHttpHandler, McpServer } from "@modelcontextprotocol/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { runComplianceSuite } from "../runner.js";
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

/** Optional checks every HTTP run on plain loopback fails regardless of the server. */
const LOCALHOST_INHERENT = ["security-auth-required", "security-rate-limiting", "security-tls-required"];

/**
 * The SDK's `localhostOriginValidation()` guard (the README-prescribed
 * front for a hand-wired node:http server, and what the Express/Hono/
 * Fastify app factories apply by default) answers a rejected Origin with
 * 403 and `{"jsonrpc":"2.0","error":{"code":-32000,...},"id":null}` without
 * reading the body, so the two guard rejections the suite provokes
 * (security-origin-validation, the CORS preflight) carry `id: null` for a
 * request whose id was readable. JSON-RPC reserves null for an id that
 * could not be detected; the post-hoc echo check flags it. A judgement
 * call on the SDK's side (reject before parsing), so pinned, not disputed.
 */
const SDK_GUARD_OPTIONAL_DEVIATIONS = ["error-id-echo"];

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
 * (no `_meta["io.modelcontextprotocol/protocolVersion"]`) received before
 * the connection is pinned flips the whole connection to the legacy era
 * for the rest of the process -- even after a successful modern
 * `server/discover` opening. The suite deliberately sends two such probes
 * (lifecycle-meta-required: no `_meta`; lifecycle-meta-protocol-version-
 * required: `_meta` without protocolVersion) because the modern spec says
 * they MUST be rejected with -32602 (basic/index#request-metadata). From
 * the flip onward the legacy instance serves every modern-envelope request:
 * `server/discover` becomes -32601, results lose `resultType` and the
 * caching hints, `subscriptions/listen` is unknown. The versioning page
 * (basic/versioning#backward-compatibility) keys a dual-era server's era to
 * "how the client opens" -- a modern `_meta` request or an `initialize` --
 * and says nothing about a later malformed message re-selecting the era.
 * `CLAIM_LESS_PROBES` names the two triggers; skipping just those two
 * yields a clean A (asserted below), which isolates the cause.
 */
const CLAIM_LESS_PROBES = ["lifecycle-meta-required", "lifecycle-meta-protocol-version-required"];
const SDK_STDIO_SERVE_FAILURES = {
  required: [
    "lifecycle-meta-client-info-optional",
    "lifecycle-version-unsupported",
    "tools-list-caching",
    "resources-list-caching",
    "resources-read-caching",
    "prompts-list-caching",
    "schema-result-type",
  ],
  optional: [
    "lifecycle-removed-methods",
    "lifecycle-subscriptions-listen",
    "lifecycle-meta-tolerance",
    "resources-templates-caching",
    "stdio-unknown-method-recovers",
    "stdio-cancellation",
    "schema-wire-valid",
  ],
};

/**
 * Over stdio with `legacy: 'reject'`, a claim-less request is answered with
 * -32022 whose `data` carries `supported` but no `requested` ("the request
 * did not name a protocol version"). The schema makes both required
 * (schema.ts UnsupportedProtocolVersionError.data.requested: string), so the
 * post-hoc wire validation flags those two replies. On HTTP the same
 * request gets -32602 instead and the schema check is clean.
 */
const SDK_STDIO_REJECT_OPTIONAL_DEVIATIONS = ["schema-wire-valid"];

/**
 * The legacy suite's injection checks flag any tool that echoes its input:
 * the fixture's `echo` returns the payload verbatim, which the 2025 checks
 * read as "executed". The 2026 suite's classifier scrubs echoes and passes.
 * Fixture behaviour, not an SDK finding; integration.test.ts has the same
 * echo tool and only asserts required tests.
 */
const LEGACY_ECHO_ARTIFACTS = ["security-command-injection", "security-sql-injection"];

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

/** Mount exactly as the @modelcontextprotocol/node README shows for plain node:http. */
async function mount(legacy: "stateless" | "reject"): Promise<Mounted> {
  const handler = createMcpHandler(() => createSdkServer(), { legacy });
  const mcpHandler = toNodeHandler(handler);
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const server = createServer(async (req, res) => {
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;
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

  it("auto resolves to 2026-07-28 with the header note", () => {
    expect(report.specVersion).toBe("2026-07-28");
    expect(report.serverInfo.protocolVersion).toBe("2026-07-28");
    expect(
      report.warnings.filter((w) => w.startsWith("Spec version auto-detected as 2026-07-28 (server/discover returned")),
    ).toHaveLength(1);
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

  it("fails exactly the localhost-inherent checks plus the documented SDK deviations", () => {
    expectFailingSets(report, SDK_HTTP_REQUIRED_DEVIATIONS, [...LOCALHOST_INHERENT, ...SDK_GUARD_OPTIONAL_DEVIATIONS]);
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
    expect(dual.details).toMatch(/^dual-era: initialize answered with protocolVersion 2025-11-25/);
  });

  // KNOWN GAP (runner, not SDK): the dual-era warning in
  // src/suites/modern/index.ts is keyed only on `supportedVersions`
  // containing 2025-11-25. The SDK advertises `["2026-07-28"]` -- the spec
  // describes supportedVersions as the modern per-request versions the
  // client "should choose one of ... for subsequent requests"
  // (server/discover#discoverresult), so listing a legacy version there
  // would be wrong -- while still serving `initialize`. The lifecycle-dual-
  // era probe above sees that, but the warning that tells the user to
  // re-run with --spec-version 2025-11-25 is never emitted. Flip to `it`
  // once the warning also keys on the late initialize probe.
  it.fails("the dual-era warning names --spec-version 2025-11-25", () => {
    const dual = report.warnings.find((w) => w.startsWith("Server is dual-era"));
    expect(dual, `warnings: ${JSON.stringify(report.warnings, null, 2)}`).toBeDefined();
    expect(dual).toContain("--spec-version 2025-11-25");
  });

  it("only warns about the auto-detection and the oversized-input observation", () => {
    const prefixes = report.warnings.map((w) => w.split(":")[0]);
    expect(sorted(prefixes)).toEqual(
      sorted([
        "Spec version auto-detected as 2026-07-28 (server/discover returned supportedVersions [2026-07-28]). Pin with --spec-version to override.",
        "security-oversized-input",
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

  it("fails exactly the loopback checks, the echo artifacts, the stateless reinit, and the batch deviation", () => {
    expectFailingSets(report, SDK_LEGACY_REQUIRED_DEVIATIONS, [
      ...LOCALHOST_INHERENT,
      ...LEGACY_ECHO_ARTIFACTS,
      "lifecycle-reinit-reject",
    ]);
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
    // -32022 "Unsupported protocol version: 2025-11-25" -- names a version,
    // which is what the spec SHOULDs for legacy clients' diagnostics.
    expect(dual.details).toMatch(/^modern-only: initialize rejected with -32022.*message names supported versions/);
    expect(report.warnings.some((w) => w.startsWith("Server is dual-era"))).toBe(false);
    expect(report.warnings.some((w) => w.startsWith("lifecycle-dual-era:"))).toBe(false);
  });

  it("fails exactly the localhost-inherent checks plus the header deviation (a MUST in this mode)", () => {
    expect(report.tests).toHaveLength(HTTP_TEST_COUNT);
    expectFailingSets(report, SDK_HTTP_REQUIRED_DEVIATIONS, [...LOCALHOST_INHERENT, ...SDK_GUARD_OPTIONAL_DEVIATIONS]);
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

  it("default (legacy: serve): auto resolves to 2026-07-28, then the claim-less probes flip the era", async () => {
    const report = await run();
    expect(report.specVersion).toBe("2026-07-28");
    expect(report.serverInfo.name).toBe("sdk2-stdio-server");
    expect(report.toolNames).toEqual(["echo"]);
    expect(report.tests).toHaveLength(STDIO_TEST_COUNT);
    // The two probes themselves pass (a -32601 is still a rejection; the
    // code mismatch is a warning), everything modern-only after them fails.
    expect(resultOf(report, "lifecycle-meta-required").passed).toBe(true);
    expect(resultOf(report, "lifecycle-meta-protocol-version-required").passed).toBe(true);
    expectFailingSets(report, SDK_STDIO_SERVE_FAILURES.required, SDK_STDIO_SERVE_FAILURES.optional);
    // The legacy instance that took over still answers initialize.
    expect(resultOf(report, "lifecycle-dual-era").details).toMatch(
      /^dual-era: initialize answered with protocolVersion 2025-11-25/,
    );
  }, 60_000);

  it("default (legacy: serve): with only the two claim-less probes skipped the SDK grades A on every test", async () => {
    const report = await run({}, { skip: CLAIM_LESS_PROBES });
    expect(report.specVersion).toBe("2026-07-28");
    expect(report.tests).toHaveLength(STDIO_TEST_COUNT - CLAIM_LESS_PROBES.length);
    expectFailingSets(report, [], []);
    expect(report.grade).toBe("A");
    expect(report.score).toBe(100);
    expect(report.overall).toBe("pass");
  }, 60_000);

  it("SDK2_LEGACY=reject: modern-only, every required test passes, initialize rejected with -32022", async () => {
    const report = await run({ SDK2_LEGACY: "reject" });
    expect(report.specVersion).toBe("2026-07-28");
    expect(report.tests).toHaveLength(STDIO_TEST_COUNT);
    const dual = resultOf(report, "lifecycle-dual-era");
    expect(dual.details).toMatch(/^modern-only: initialize rejected with -32022.*message names supported versions/);
    expectFailingSets(report, [], SDK_STDIO_REJECT_OPTIONAL_DEVIATIONS);
    expect(resultOf(report, "schema-wire-valid").details).toMatch(/must have required property 'requested'/);
    expect(report.grade).toBe("A");
  }, 60_000);

  it("pinned 2025-11-25: the legacy suite initializes and every required test passes", async () => {
    const report = await run({}, { specVersion: "2025-11-25" });
    expect(report.specVersion).toBe("2025-11-25");
    const init = resultOf(report, "lifecycle-init");
    expect(init.passed, init.details).toBe(true);
    expect(report.serverInfo.name).toBe("sdk2-stdio-server");
    expect(report.toolNames).toEqual(["echo"]);
    expectFailingSets(report, [], LEGACY_ECHO_ARTIFACTS);
  }, 60_000);
});
