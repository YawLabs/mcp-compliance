import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { request } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INTERNAL_IP_PATTERNS, STACK_TRACE_PATTERNS } from "../checks/patterns.js";
import { getTestDefinitionMap } from "../definitions/index.js";
import { createHarness } from "../harness.js";
import { createModernClient, resultOf as rpcResultOf } from "../modern/client.js";
import { createRecorder } from "../recorder.js";
import { MODERN_SPEC_VERSION, specBaseFor } from "../spec.js";
import { createModernState, type ModernSuiteContext } from "../suites/modern/context.js";
import {
  classifyInjectionOutput,
  compareToolLists,
  findLeaks,
  INJECTION_DETECTORS,
  runSecurity,
} from "../suites/modern/security.js";
import { createHttpTransport } from "../transport/http.js";
import type { Transport } from "../transport/index.js";
import { createStdioTransport } from "../transport/stdio.js";
import type { ComplianceReport, TestResult } from "../types.js";
import {
  type FixtureOptions,
  type HttpFixture,
  passedIds,
  resultOf,
  runModern,
  startHttpFixture,
  stdioFixture,
} from "./helpers/modern-fixture.js";

/**
 * The 2026-07-28 security module (src/suites/modern/security.ts): every
 * security test passes on the clean fixture over stdio AND HTTP (except
 * the three that fail there BY DESIGN: no --auth, an http:// URL, and a
 * fixture that never answers 429), the auth trio behaves with and
 * without credentials, and each fixture knob turns the check it violates
 * RED. Knob runs are grouped one fixture start per knob.
 *
 * Two vehicles: `runModern` (the real dispatcher, with the lifecycle and
 * tools-list ids added so their modules fill ctx.state once they land)
 * and a direct context that seeds ctx.state itself, so the tool-dependent
 * tests are exercised for real today regardless of the other modules.
 */

const SECURITY_IDS = [
  "security-auth-required",
  "security-www-authenticate",
  "security-auth-malformed",
  "security-tls-required",
  "security-oauth-metadata",
  "security-token-in-uri",
  "security-cors-headers",
  "security-origin-validation",
  "security-command-injection",
  "security-sql-injection",
  "security-path-traversal",
  "security-ssrf-internal",
  "security-oversized-input",
  "security-extra-params",
  "security-tool-schema-defined",
  "security-tool-rug-pull",
  "security-tool-description-poisoning",
  "security-tool-cross-reference",
  "security-error-no-stacktrace",
  "security-error-no-internal-ip",
  "security-rate-limiting",
];

const HTTP_ONLY_IDS = [
  "security-auth-required",
  "security-www-authenticate",
  "security-auth-malformed",
  "security-tls-required",
  "security-oauth-metadata",
  "security-token-in-uri",
  "security-cors-headers",
  "security-origin-validation",
  "security-rate-limiting",
];

const BOTH_TRANSPORT_IDS = SECURITY_IDS.filter((id) => !HTTP_ONLY_IDS.includes(id));

const AUTH_IDS = [
  "security-auth-required",
  "security-www-authenticate",
  "security-auth-malformed",
  "security-oauth-metadata",
  "security-token-in-uri",
];

const TOOL_IDS = [
  "security-command-injection",
  "security-sql-injection",
  "security-path-traversal",
  "security-ssrf-internal",
  "security-oversized-input",
  "security-extra-params",
  "security-tool-schema-defined",
  "security-tool-rug-pull",
  "security-tool-description-poisoning",
  "security-tool-cross-reference",
];

/** Lifecycle / feature ids whose bodies fill ctx.state (discover, tools) once those modules land. */
const STATE_FILLERS = ["lifecycle-discover", "tools-list"];

const NO_AUTH_DETAILS =
  "Server does not require auth (no --auth provided and server accepted unauthenticated requests)";

/** Ids that FAIL on the clean HTTP fixture by design, with the details they must carry. */
const EXPECTED_FAIL_CLEAN_HTTP: Record<string, RegExp> = {
  "security-auth-required": new RegExp(`^${NO_AUTH_DETAILS.replace(/[()]/g, "\\$&")}$`),
  "security-tls-required": /^Server URL uses http: -- production servers should use HTTPS$/,
  "security-rate-limiting": /^No rate limiting detected \(50 rapid requests all returned 200\)$/,
};

function allPass(ids: string[]): Record<string, string> {
  return Object.fromEntries(ids.map((id) => [id, "pass"]));
}

function verdicts(tests: TestResult[], ids: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of ids) {
    const r = tests.find((t) => t.id === id);
    out[id] = !r ? "MISSING" : r.passed ? "pass" : `FAIL: ${r.details}`;
  }
  return out;
}

function detailsOf(tests: TestResult[], id: string): string {
  const r = tests.find((t) => t.id === id);
  if (!r) throw new Error(`test "${id}" did not run (ran: ${tests.map((t) => t.id).join(", ")})`);
  return r.details;
}

function expectAsciiDetails(tests: TestResult[], ids: string[]) {
  for (const id of ids) {
    const d = detailsOf(tests, id);
    expect(d, id).toMatch(/^[\x20-\x7e]+$/);
    expect(d.length, id).toBeLessThanOrEqual(220);
    expect(d, id).not.toMatch(/^Error:/);
  }
}

// ---------------------------------------------------------------------------
// Direct context: seeds ctx.state the way lifecycle/features do, runs only
// the security module, and returns its results.
// ---------------------------------------------------------------------------

interface DirectOptions {
  /** HTTP endpoint; omitted = spawn the stdio fixture. */
  url?: string;
  fixture?: FixtureOptions;
  headers?: Record<string, string>;
  only?: string[];
}

interface DirectRun {
  kind: "http" | "stdio";
  tests: TestResult[];
  warnings: string[];
  toolCount: number;
}

async function runDirect(opts: DirectOptions): Promise<DirectRun> {
  const kind = opts.url ? "http" : "stdio";
  const stdio = stdioFixture(opts.fixture).target;
  if (stdio.type !== "stdio") throw new Error("stdioFixture must describe a stdio target");
  const transport: Transport = opts.url
    ? createHttpTransport({ url: opts.url, headers: opts.headers })
    : createStdioTransport({ command: stdio.command, args: stdio.args, env: stdio.env });
  const recorder = createRecorder();
  const unsubscribe = transport.onMessage((m) => recorder.recordReceived(m));
  let id = 5000;
  const harness = createHarness({
    definitions: getTestDefinitionMap(MODERN_SPEC_VERSION),
    specBase: specBaseFor(MODERN_SPEC_VERSION),
    transportKind: kind,
    only: opts.only ?? SECURITY_IDS,
  });
  const client = createModernClient({
    transport,
    recorder,
    nextId: () => id++,
    timeout: 5000,
    protocolVersion: MODERN_SPEC_VERSION,
    clientCapabilities: { elicitation: {} },
    clientInfo: { name: "mcp-compliance-test", version: "0.0.0" },
  });
  const userHeaders = opts.headers ?? {};
  const ctx: ModernSuiteContext = {
    harness,
    client,
    recorder,
    transport,
    kind,
    timeout: 5000,
    startupTimeout: 10000,
    backendUrl: opts.url ?? "",
    userHeaders,
    displayUrl: opts.url ?? "stdio:fixture",
    detection: undefined,
    hasAuth: Object.keys(userHeaders).some((h) => h.toLowerCase() === "authorization"),
    state: { ...createModernState(), supportedVersions: [MODERN_SPEC_VERSION] },
  };
  try {
    // Seed what lifecycle + features would have cached.
    const discover = await client.rpc("server/discover", {}, { timeout: 10000 });
    const caps = rpcResultOf(discover.body)?.capabilities;
    if (caps && typeof caps === "object") {
      ctx.state.discover = discover;
      ctx.state.capabilities = caps as Record<string, unknown>;
      if ((caps as Record<string, unknown>).tools) {
        const listed = await client.rpc("tools/list", {});
        const tools = rpcResultOf(listed.body)?.tools;
        if (Array.isArray(tools)) {
          ctx.state.tools = tools;
          ctx.state.toolNames = tools.map((t: any) => t.name);
        }
      }
    }
    await runSecurity(ctx);
    await harness.drainPool();
  } finally {
    unsubscribe();
    await transport.close();
  }
  return { kind, tests: harness.tests, warnings: [...harness.warnings], toolCount: ctx.state.tools?.length ?? 0 };
}

// ---------------------------------------------------------------------------
// Pure classifiers: the negatives no fixture knob can produce
// ---------------------------------------------------------------------------

describe("security classifiers (unit)", () => {
  it("treats a verbatim echo of the payload as defended, execution evidence as an issue", () => {
    const cmd = INJECTION_DETECTORS.command;
    expect(classifyInjectionOutput("&& echo pwned", "&& echo pwned", cmd, false)).toBe("defended");
    expect(classifyInjectionOutput("you said: && echo pwned", "&& echo pwned", cmd, false)).toBe("defended");
    expect(classifyInjectionOutput("pwned", "&& echo pwned", cmd, false)).toBe("issue");
    expect(classifyInjectionOutput("root:x:0:0:root:/root:/bin/bash", "; cat /etc/passwd", cmd, false)).toBe("issue");
    expect(classifyInjectionOutput("executed: root:x:0:0 ; cat /etc/passwd", "; cat /etc/passwd", cmd, false)).toBe(
      "issue",
    );
    expect(classifyInjectionOutput("uid=0(root) gid=0(root)", "`id`", cmd, false)).toBe("issue");
  });

  it("lets rejection wording and isError override a detector hit", () => {
    const cmd = INJECTION_DETECTORS.command;
    expect(classifyInjectionOutput("Access denied: pwned", "&& echo pwned", cmd, false)).toBe("defended");
    expect(classifyInjectionOutput("pwned", "&& echo pwned", cmd, true)).toBe("defended");
  });

  it("flags database error text and internal metadata, not the echoed payload", () => {
    const sql = INJECTION_DETECTORS.sql;
    const payload = "1 UNION SELECT * FROM information_schema.tables--";
    expect(classifyInjectionOutput(payload, payload, sql, false)).toBe("defended");
    expect(classifyInjectionOutput('ERROR: syntax error at or near "\'"', "' OR 1=1 --", sql, false)).toBe("issue");
    expect(classifyInjectionOutput('SQLITE_ERROR: near "\'"', "' OR 1=1 --", sql, false)).toBe("issue");
    const ssrf = INJECTION_DETECTORS.ssrf;
    const url = "http://169.254.169.254/latest/meta-data/";
    expect(classifyInjectionOutput(`fetched ${url}`, url, ssrf, false)).toBe("defended");
    expect(classifyInjectionOutput("ami-0abc123\ninstance-id\niam/", url, ssrf, false)).toBe("issue");
    const path = INJECTION_DETECTORS.pathTraversal;
    expect(classifyInjectionOutput("../../etc/passwd", "../../etc/passwd", path, false)).toBe("defended");
    expect(classifyInjectionOutput("root:x:0:0:root:/root:/bin/sh", "../../etc/passwd", path, false)).toBe("issue");
    expect(classifyInjectionOutput("[boot loader]\ntimeout=30", "..\\..\\windows\\system.ini", path, false)).toBe(
      "issue",
    );
  });

  it("compareToolLists reports the first drift: count, names, then description/inputSchema/annotations", () => {
    const a = { name: "a", description: "A", inputSchema: { type: "object", properties: {} }, annotations: {} };
    const b = { name: "b", description: "B", inputSchema: { type: "object" } };
    expect(compareToolLists([a, b], [{ ...b }, { ...a }])).toBeNull();
    expect(compareToolLists([a, b], [a])).toBe("Tool count changed: 2 -> 1 (possible rug-pull)");
    expect(compareToolLists([a, b], [a, { ...b, name: "c" }])).toBe(
      "Tool names changed between calls (possible rug-pull)",
    );
    expect(compareToolLists([a, b], [a, { ...b, description: "B2" }])).toBe(
      'Tool "b" description changed between calls (possible rug-pull)',
    );
    expect(compareToolLists([a, b], [{ ...a, inputSchema: { type: "object", properties: { x: {} } } }, b])).toBe(
      'Tool "a" inputSchema changed between calls (possible rug-pull)',
    );
    expect(compareToolLists([a, b], [{ ...a, annotations: { readOnlyHint: true } }, b])).toBe(
      'Tool "a" annotations changed between calls (possible rug-pull)',
    );
    // Key order inside a schema is not a change.
    expect(
      compareToolLists(
        [{ name: "k", inputSchema: { type: "object", properties: {} } }],
        [{ name: "k", inputSchema: { properties: {}, type: "object" } }],
      ),
    ).toBeNull();
  });

  it("findLeaks reports stack traces and internal IPs but not echoes of the request's own input", () => {
    const trace = {
      text: '{"code":-32601,"message":"boom\\n    at Object.<anonymous> (/home/user/app/server.js:10:5)"}',
      requestText: "{}",
    };
    expect(findLeaks([trace], STACK_TRACE_PATTERNS)).toHaveLength(1);
    expect(findLeaks([trace], STACK_TRACE_PATTERNS)[0]).toMatch(/^Response contains: /);
    const ip = { text: '{"code":-32603,"message":"upstream 10.0.0.1 unreachable"}', requestText: "{}" };
    expect(findLeaks([ip], INTERNAL_IP_PATTERNS)).toHaveLength(1);
    expect(findLeaks([ip], INTERNAL_IP_PATTERNS)[0]).toContain("10.0.0.1");
    const echoed = {
      text: '{"code":-32602,"message":"invalid url http://10.0.0.1/"}',
      requestText: '{"name":"fetch","arguments":{"url":"http://10.0.0.1/"}}',
    };
    expect(findLeaks([echoed], INTERNAL_IP_PATTERNS)).toEqual([]);
    const clean = { text: '{"code":-32601,"message":"Method not found: nope"}', requestText: "{}" };
    expect(findLeaks([clean], STACK_TRACE_PATTERNS)).toEqual([]);
    expect(findLeaks([clean], INTERNAL_IP_PATTERNS)).toEqual([]);
    // Capped and deduplicated.
    expect(findLeaks([trace, trace, trace, trace], STACK_TRACE_PATTERNS, 2)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Clean fixture through the real dispatcher
// ---------------------------------------------------------------------------

describe("modern security suite: clean fixture over stdio (runModern)", () => {
  let report: ComplianceReport;

  beforeAll(async () => {
    report = await runModern(stdioFixture().target, { only: [...SECURITY_IDS, ...STATE_FILLERS] });
  });

  it("passes every transport-agnostic security test", () => {
    expect(passedIds(report, BOTH_TRANSPORT_IDS)).toEqual(allPass(BOTH_TRANSPORT_IDS));
  });

  it("does not run the HTTP-only security tests", () => {
    const ran = new Set(report.tests.map((t) => t.id));
    for (const id of HTTP_ONLY_IDS) expect(ran.has(id), id).toBe(false);
  });

  it("keeps every details string ASCII, bounded, and free of harness errors", () => {
    expectAsciiDetails(report.tests, BOTH_TRANSPORT_IDS);
  });

  it("marks every security test optional", () => {
    for (const id of BOTH_TRANSPORT_IDS) expect(resultOf(report, id).required, id).toBe(false);
  });
});

describe("modern security suite: clean fixture over HTTP (runModern)", () => {
  let fixture: HttpFixture;
  let report: ComplianceReport;

  beforeAll(async () => {
    fixture = await startHttpFixture();
    report = await runModern(fixture.url, { only: [...SECURITY_IDS, ...STATE_FILLERS] });
  });

  afterAll(async () => {
    await fixture.stop();
  });

  it("passes every security test except the three that fail on this fixture by design", () => {
    const passing = SECURITY_IDS.filter((id) => !(id in EXPECTED_FAIL_CLEAN_HTTP));
    expect(passedIds(report, passing)).toEqual(allPass(passing));
  });

  it("fails auth-required (no --auth), tls-required (http URL) and rate-limiting (never 429) with the legacy wording", () => {
    for (const [id, pattern] of Object.entries(EXPECTED_FAIL_CLEAN_HTTP)) {
      const r = resultOf(report, id);
      expect(r.passed, id).toBe(false);
      expect(r.details, id).toMatch(pattern);
    }
  });

  it("skip-passes the auth-dependent tests without --auth", () => {
    for (const id of [
      "security-www-authenticate",
      "security-auth-malformed",
      "security-oauth-metadata",
      "security-token-in-uri",
    ]) {
      expect(resultOf(report, id).details, id).toBe("Skipped: server does not require auth");
    }
  });

  it("names the observed status in the Origin and CORS verdicts", () => {
    expect(resultOf(report, "security-origin-validation").details).toBe("HTTP 403 (suspicious Origin rejected)");
    const cors = resultOf(report, "security-cors-headers").details;
    expect(cors).toMatch(
      /^No CORS headers returned \(OPTIONS HTTP 403, POST HTTP 403; server-to-server only, acceptable\)$/,
    );
  });

  it("keeps every details string ASCII, bounded, and free of harness errors", () => {
    expectAsciiDetails(report.tests, SECURITY_IDS);
    expect(report.specVersion).toBe(MODERN_SPEC_VERSION);
  });
});

// ---------------------------------------------------------------------------
// Direct context: the tool-dependent tests run for real on both transports
// ---------------------------------------------------------------------------

describe("modern security suite: direct context on the clean fixture", () => {
  let fixture: HttpFixture;
  let http: DirectRun;
  let stdio: DirectRun;

  beforeAll(async () => {
    fixture = await startHttpFixture();
    http = await runDirect({ url: fixture.url });
    stdio = await runDirect({});
  });

  afterAll(async () => {
    await fixture.stop();
  });

  function expectRealToolVerdicts(run: DirectRun) {
    expect(run.toolCount).toBe(11);
    expect(verdicts(run.tests, TOOL_IDS)).toEqual(allPass(TOOL_IDS));
    // echo.message, regional.region, regional.query: three string arguments on two tools.
    expect(detailsOf(run.tests, "security-command-injection")).toBe(
      "Tested 5 payload(s) x 3 argument(s) across 2 tool(s) -- server defended (rejected or sanitized)",
    );
    expect(detailsOf(run.tests, "security-sql-injection")).toBe(
      "Tested 3 payload(s) x 3 argument(s) across 2 tool(s) -- server defended (rejected or sanitized)",
    );
    expect(detailsOf(run.tests, "security-path-traversal")).toBe(
      "Tested 3 payload(s) x 3 argument(s) across 2 tool(s) -- server defended (rejected or sanitized)",
    );
    expect(detailsOf(run.tests, "security-ssrf-internal")).toBe("No tools with URL parameters found (skipped)");
    expect(detailsOf(run.tests, "security-extra-params")).toBe(
      "Server processed request (extra params likely ignored)",
    );
    expect(detailsOf(run.tests, "security-tool-schema-defined")).toBe("All 11 tool(s) have inputSchema defined");
    expect(detailsOf(run.tests, "security-tool-rug-pull")).toBe("11 tool(s) consistent across 2 calls");
    expect(detailsOf(run.tests, "security-tool-description-poisoning")).toBe(
      "11 tool(s) scanned -- no injection patterns found",
    );
    expect(detailsOf(run.tests, "security-tool-cross-reference")).toBe(
      "11 tool(s) checked -- no cross-references found",
    );
    expect(detailsOf(run.tests, "security-error-no-stacktrace")).toMatch(
      /^\d+ error response\(s\) checked -- no stack traces or sensitive data found$/,
    );
    expect(detailsOf(run.tests, "security-error-no-internal-ip")).toMatch(
      /^\d+ error response\(s\) checked -- no internal IP addresses found$/,
    );
  }

  it("over HTTP: every tool-dependent test runs against the 11 fixture tools and passes", () => {
    expectRealToolVerdicts(http);
    expect(detailsOf(http.tests, "security-oversized-input")).toBe(
      "HTTP 200, result -- server processed a 1 MB echo.message without rejecting it (survived)",
    );
  });

  it("over stdio: the same verdicts, with stdio wording where HTTP status codes do not exist", () => {
    expectRealToolVerdicts(stdio);
    expect(detailsOf(stdio.tests, "security-oversized-input")).toBe(
      "result -- server processed a 1 MB echo.message without rejecting it (survived)",
    );
    const ran = new Set(stdio.tests.map((t) => t.id));
    for (const id of HTTP_ONLY_IDS) expect(ran.has(id), id).toBe(false);
  });

  it("warns once when the server swallowed the 1 MB argument instead of rejecting it", () => {
    for (const run of [http, stdio]) {
      const oversized = run.warnings.filter((w) => w.startsWith("security-oversized-input:"));
      expect(oversized, run.kind).toHaveLength(1);
      expect(oversized[0]).toContain("echo.message");
    }
  });

  it("emits no other security warnings on a conformant server", () => {
    for (const run of [http, stdio]) {
      const others = run.warnings.filter((w) => !w.startsWith("security-oversized-input:"));
      expect(others, run.kind).toEqual([]);
    }
  });

  it("scans the whole run's recorded errors, not only its own probes", () => {
    // At least the five rpc probes (+ the raw invalid-JSON one on HTTP)
    // plus errors earlier tests produced (unknown-tool from extra-params
    // does not error; the injection calls on `regional` do: -32602).
    const count = (run: DirectRun) =>
      Number(/^(\d+) error/.exec(detailsOf(run.tests, "security-error-no-stacktrace"))?.[1]);
    expect(count(http)).toBeGreaterThan(6);
    expect(count(stdio)).toBeGreaterThan(5);
  });
});

// ---------------------------------------------------------------------------
// Auth fixture: with and without credentials
// ---------------------------------------------------------------------------

describe("modern security suite: auth fixture over HTTP", () => {
  let fixture: HttpFixture;
  let withAuth: ComplianceReport;
  let withoutAuth: ComplianceReport;

  beforeAll(async () => {
    fixture = await startHttpFixture({ auth: "secret" });
    withAuth = await runModern(fixture.url, {
      headers: { Authorization: "Bearer secret" },
      only: [...AUTH_IDS, ...STATE_FILLERS],
    });
    withoutAuth = await runModern(fixture.url, { only: AUTH_IDS });
  });

  afterAll(async () => {
    await fixture.stop();
  });

  it("with --auth: the auth trio, token-in-URI and PRM discovery all pass with the observed status", () => {
    expect(passedIds(withAuth, AUTH_IDS)).toEqual(allPass(AUTH_IDS));
    expect(resultOf(withAuth, "security-auth-required").details).toBe("HTTP 401 (unauthenticated request rejected)");
    expect(resultOf(withAuth, "security-www-authenticate").details).toBe(
      `WWW-Authenticate: Bearer resource_metadata="${fixture.base}/.well-known/oauth-protected-resource"`,
    );
    expect(resultOf(withAuth, "security-auth-malformed").details).toBe("HTTP 401 (malformed auth rejected)");
    expect(resultOf(withAuth, "security-token-in-uri").details).toBe("HTTP 401 (token in query string rejected)");
    expect(resultOf(withAuth, "security-oauth-metadata").details).toBe(
      `Protected Resource Metadata found at /.well-known/oauth-protected-resource: resource=${fixture.base}/mcp, 1 auth server(s)`,
    );
    expect(withAuth.warnings.filter((w) => w.startsWith("security-"))).toEqual([]);
  });

  it("without --auth: auth-required fails with the legacy wording and the rest skip-pass", () => {
    const r = resultOf(withoutAuth, "security-auth-required");
    expect(r.passed).toBe(false);
    expect(r.details).toBe(NO_AUTH_DETAILS);
    for (const id of AUTH_IDS.filter((i) => i !== "security-auth-required")) {
      expect(resultOf(withoutAuth, id).details, id).toBe("Skipped: server does not require auth");
    }
  });

  it("fixture contract: the query-string token is rejected while the header token is accepted on the same URL", async () => {
    // Pins WHY security-token-in-uri passes above: the fixture ignores
    // ?access_token and answers 401, not because the URL variant is
    // unreachable (the same URL with the header is served normally).
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN_SPEC_VERSION,
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    });
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": MODERN_SPEC_VERSION,
      "Mcp-Method": "server/discover",
    };
    const url = `${fixture.url}?access_token=secret`;
    const rejected = await request(url, { method: "POST", headers, body });
    await rejected.body.text();
    expect(rejected.statusCode).toBe(401);
    const served = await request(url, {
      method: "POST",
      headers: { ...headers, Authorization: "Bearer secret" },
      body,
    });
    const text = await served.body.text();
    expect(served.statusCode).toBe(200);
    expect(JSON.parse(text).result.supportedVersions).toContain(MODERN_SPEC_VERSION);
  });
});

// ---------------------------------------------------------------------------
// Knobs: each check goes RED under the violation it exists to catch
// ---------------------------------------------------------------------------

describe("knob injection-echo: the injection detectors fire on execution evidence", () => {
  let fixture: HttpFixture;
  let http: DirectRun;
  let stdio: DirectRun;

  beforeAll(async () => {
    fixture = await startHttpFixture({ breaks: ["injection-echo"] });
    http = await runDirect({ url: fixture.url });
    stdio = await runDirect({ fixture: { breaks: ["injection-echo"] } });
  });

  afterAll(async () => {
    await fixture.stop();
  });

  it("command-injection and path-traversal fail on both transports, naming the tool and argument", () => {
    for (const run of [http, stdio]) {
      const v = verdicts(run.tests, ["security-command-injection", "security-path-traversal"]);
      expect(v["security-command-injection"], run.kind).toMatch(
        /^FAIL: Payload ".+" appears to have executed in echo\.message \(output: executed: root:x:0:0 /,
      );
      expect(v["security-path-traversal"], run.kind).toMatch(
        /^FAIL: Payload ".+" returned sensitive file content in echo\.message \(output: executed: root:x:0:0 /,
      );
      expectAsciiDetails(run.tests, ["security-command-injection", "security-path-traversal"]);
    }
  });

  it("the passwd marker is not SQL or cloud-metadata evidence, so sql-injection and ssrf-internal stay green", () => {
    for (const run of [http, stdio]) {
      expect(verdicts(run.tests, ["security-sql-injection", "security-ssrf-internal"]), run.kind).toEqual(
        allPass(["security-sql-injection", "security-ssrf-internal"]),
      );
    }
  });
});

describe("knob tool-no-input-schema: security-tool-schema-defined", () => {
  let fixture: HttpFixture;
  let http: DirectRun;
  let stdio: DirectRun;

  beforeAll(async () => {
    fixture = await startHttpFixture({ breaks: ["tool-no-input-schema"] });
    http = await runDirect({ url: fixture.url });
    stdio = await runDirect({ fixture: { breaks: ["tool-no-input-schema"] } });
  });

  afterAll(async () => {
    await fixture.stop();
  });

  it("fails on both transports and names the tools", () => {
    for (const run of [http, stdio]) {
      expect(run.toolCount, run.kind).toBe(11);
      expect(verdicts(run.tests, ["security-tool-schema-defined"])["security-tool-schema-defined"], run.kind).toMatch(
        /^FAIL: 11 tool\(s\) missing inputSchema: echo, add, content_types, /,
      );
    }
  });

  it("the injection tests find no string arguments to target and skip-pass", () => {
    for (const run of [http, stdio]) {
      expect(detailsOf(run.tests, "security-command-injection"), run.kind).toBe(
        "No tools with string parameters to test",
      );
      // The oversized probe falls back to <first tool>.data.
      expect(detailsOf(run.tests, "security-oversized-input"), run.kind).toContain("echo.data");
    }
  });
});

describe("knobs stacktrace-errors + internal-ip-errors: information disclosure", () => {
  const breaks = ["stacktrace-errors", "internal-ip-errors"];
  let fixture: HttpFixture;
  let http: ComplianceReport;
  let stdio: ComplianceReport;

  beforeAll(async () => {
    fixture = await startHttpFixture({ breaks });
    http = await runModern(fixture.url, { only: [...SECURITY_IDS, ...STATE_FILLERS] });
    stdio = await runModern(stdioFixture({ breaks }).target, { only: [...SECURITY_IDS, ...STATE_FILLERS] });
  });

  afterAll(async () => {
    await fixture.stop();
  });

  it("error-no-stacktrace fails on both transports with the leaked frame", () => {
    for (const report of [http, stdio]) {
      const r = resultOf(report, "security-error-no-stacktrace");
      expect(r.passed).toBe(false);
      expect(r.details).toMatch(
        /^Response contains: at Object\.<anonymous> \(\/home\/user\/app\/server\.js:10:5\) \(matched in: /,
      );
      expect(r.details).toMatch(/^[\x20-\x7e]+$/);
    }
  });

  it("error-no-internal-ip fails on both transports with the leaked address", () => {
    for (const report of [http, stdio]) {
      const r = resultOf(report, "security-error-no-internal-ip");
      expect(r.passed).toBe(false);
      expect(r.details).toMatch(/^Error response contains internal IP: Response contains: 10\.0\.0\.1 \(matched in: /);
    }
  });
});

describe("knob no-origin-check: security-origin-validation", () => {
  let fixture: HttpFixture;
  let report: ComplianceReport;

  beforeAll(async () => {
    fixture = await startHttpFixture({ breaks: ["no-origin-check"] });
    report = await runModern(fixture.url, { only: ["security-origin-validation", "security-cors-headers"] });
  });

  afterAll(async () => {
    await fixture.stop();
  });

  it("fails when a foreign Origin is served a result", () => {
    const r = resultOf(report, "security-origin-validation");
    expect(r.passed).toBe(false);
    expect(r.details).toBe(
      "HTTP 200, result -- server accepted a request with an untrusted Origin (MUST validate Origin, 403)",
    );
  });

  it("cors-headers still passes: the fixture never reflects a foreign Origin", () => {
    const r = resultOf(report, "security-cors-headers");
    expect(r.passed).toBe(true);
    expect(r.details).toBe(
      "No CORS headers returned (OPTIONS HTTP 204, POST HTTP 200; server-to-server only, acceptable)",
    );
  });
});

// ---------------------------------------------------------------------------
// Permissive servers: branches the fixture has no knob for. A tiny inline
// node:http server that accepts every credential (header, garbage, query
// string), reflects or wildcards CORS, serves PRM at one of the lookup
// locations, throttles with 429, or answers oversized bodies with 413/500.
// ---------------------------------------------------------------------------

interface PermissiveOptions {
  cors?: "reflect" | "wildcard" | "none";
  prm?: "path" | "legacy" | "root-bad" | "none";
  /** POSTs beyond this count get 429. */
  rateLimitAfter?: number;
  /** Status for bodies over 500 KB. */
  bigBody?: 413 | 500;
}

interface PermissiveServer {
  url: string;
  base: string;
  close(): Promise<void>;
}

const SINK_TOOL = {
  name: "sink",
  description: "Accepts anything",
  inputSchema: { type: "object", properties: { data: { type: "string" } } },
};

function startPermissiveServer(opts: PermissiveOptions): Promise<PermissiveServer> {
  let posts = 0;
  let base = "";
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url ?? "/", base);
      const origin = req.headers.origin;
      const cors: Record<string, string> = {};
      if (opts.cors === "reflect" && typeof origin === "string") {
        cors["Access-Control-Allow-Origin"] = origin;
        cors["Access-Control-Allow-Credentials"] = "true";
      }
      if (opts.cors === "wildcard") cors["Access-Control-Allow-Origin"] = "*";
      const json = (status: number, obj: unknown, extra: Record<string, string> = {}) => {
        res.writeHead(status, { "Content-Type": "application/json", ...cors, ...extra });
        res.end(JSON.stringify(obj));
      };
      const path = url.pathname;
      if (path === "/.well-known/oauth-protected-resource" && opts.prm === "root-bad") {
        return json(200, { resource: `${base}/mcp` }); // no authorization_servers
      }
      if (path === "/.well-known/oauth-protected-resource/mcp" && opts.prm === "path") {
        return json(200, { resource: `${base}/mcp`, authorization_servers: ["https://as.example.com"] });
      }
      if (path === "/.well-known/oauth-authorization-server" && opts.prm === "legacy") {
        return json(200, { issuer: "https://as.example.com", token_endpoint: "https://as.example.com/token" });
      }
      if (path !== "/mcp") {
        res.writeHead(404);
        return res.end();
      }
      if (req.method === "OPTIONS") {
        res.writeHead(204, cors);
        return res.end();
      }
      posts++;
      if (opts.rateLimitAfter && posts > opts.rateLimitAfter) {
        return json(
          429,
          { jsonrpc: "2.0", id: null, error: { code: -32000, message: "slow down" } },
          { "Retry-After": "1" },
        );
      }
      if (opts.bigBody && body.length > 500_000) {
        return json(opts.bigBody, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "too big" } });
      }
      let msg: any;
      try {
        msg = JSON.parse(body.toString("utf8"));
      } catch {
        return json(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      }
      const result = (r: Record<string, unknown>) =>
        json(200, { jsonrpc: "2.0", id: msg?.id ?? null, result: { resultType: "complete", ...r } });
      switch (msg?.method) {
        case "server/discover":
          return result({
            supportedVersions: [MODERN_SPEC_VERSION],
            capabilities: { tools: {} },
            ttlMs: 0,
            cacheScope: "public",
          });
        case "tools/list":
          return result({ tools: [SINK_TOOL], ttlMs: 0, cacheScope: "public" });
        case "tools/call":
          return result({ content: [{ type: "text", text: "ok" }] });
        default:
          return json(404, {
            jsonrpc: "2.0",
            id: msg?.id ?? null,
            error: { code: -32601, message: "Method not found" },
          });
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      base = `http://127.0.0.1:${port}`;
      resolve({
        url: `${base}/mcp`,
        base,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

describe("permissive servers: the branches no fixture knob reaches", () => {
  const servers: PermissiveServer[] = [];
  let reflecting: DirectRun;
  let wildcard: DirectRun;
  let badPrm: DirectRun;
  let bare: DirectRun;
  const AUTH = { Authorization: "Bearer tok" };

  beforeAll(async () => {
    const a = await startPermissiveServer({ cors: "reflect", prm: "path", rateLimitAfter: 40, bigBody: 413 });
    const b = await startPermissiveServer({ cors: "wildcard", prm: "legacy", bigBody: 500 });
    const c = await startPermissiveServer({ cors: "none", prm: "root-bad" });
    const d = await startPermissiveServer({ cors: "none", prm: "none" });
    servers.push(a, b, c, d);
    reflecting = await runDirect({ url: a.url, headers: AUTH });
    wildcard = await runDirect({ url: b.url, headers: AUTH });
    badPrm = await runDirect({ url: c.url, headers: AUTH });
    bare = await runDirect({ url: d.url, headers: AUTH });
  });

  afterAll(async () => {
    for (const s of servers) await s.close();
  });

  it("auth-required, auth-malformed and token-in-uri fail when every credential is accepted", () => {
    expect(
      verdicts(reflecting.tests, ["security-auth-required", "security-auth-malformed", "security-token-in-uri"]),
    ).toEqual({
      "security-auth-required": "FAIL: HTTP 200, result -- server accepted unauthenticated request",
      "security-auth-malformed": "FAIL: HTTP 200, result -- server accepted malformed auth token",
      "security-token-in-uri":
        "FAIL: HTTP 200, result -- server accepted the auth token in the query string (MUST NOT)",
    });
    expect(detailsOf(reflecting.tests, "security-www-authenticate")).toBe("HTTP 200 -- not a 401 response (skipped)");
  });

  it("origin-validation fails on a served result; cors-headers fails on a reflected or wildcard ACAO", () => {
    expect(detailsOf(reflecting.tests, "security-origin-validation")).toBe(
      "HTTP 200, result -- server accepted a request with an untrusted Origin (MUST validate Origin, 403)",
    );
    expect(verdicts(reflecting.tests, ["security-cors-headers"])["security-cors-headers"]).toBe(
      "FAIL: Server reflects arbitrary Origin in CORS with Allow-Credentials on OPTIONS -- effectively wildcard",
    );
    expect(verdicts(wildcard.tests, ["security-cors-headers"])["security-cors-headers"]).toBe(
      'FAIL: Access-Control-Allow-Origin is "*" (wildcard) on OPTIONS -- allows cross-origin credential theft',
    );
    expect(detailsOf(bare.tests, "security-cors-headers")).toBe(
      "No CORS headers returned (OPTIONS HTTP 204, POST HTTP 200; server-to-server only, acceptable)",
    );
  });

  it("oauth-metadata finds the endpoint-path PRM, accepts legacy AS metadata with a warning, and fails otherwise", () => {
    expect(detailsOf(reflecting.tests, "security-oauth-metadata")).toBe(
      `Protected Resource Metadata found at /.well-known/oauth-protected-resource/mcp: resource=${servers[0].base}/mcp, 1 auth server(s)`,
    );
    expect(detailsOf(wildcard.tests, "security-oauth-metadata")).toBe(
      "Legacy OAuth AS metadata found: issuer=https://as.example.com (should migrate to PRM)",
    );
    expect(wildcard.warnings.filter((w) => w.startsWith("security-oauth-metadata:"))).toHaveLength(1);
    expect(verdicts(badPrm.tests, ["security-oauth-metadata"])["security-oauth-metadata"]).toBe(
      "FAIL: PRM response at /.well-known/oauth-protected-resource missing 'authorization_servers' array",
    );
    expect(verdicts(bare.tests, ["security-oauth-metadata"])["security-oauth-metadata"]).toBe(
      "FAIL: No Protected Resource Metadata (/.well-known/oauth-protected-resource -> HTTP 404; /.well-known/oauth-protected-resource/mcp -> HTTP 404) and no legacy OAuth metadata",
    );
  });

  it("rate-limiting passes on a 429 and fails when the burst is all served", () => {
    expect(detailsOf(reflecting.tests, "security-rate-limiting")).toBe(
      "Rate limiting detected (429 returned within 50 rapid requests)",
    );
    expect(verdicts(bare.tests, ["security-rate-limiting"])["security-rate-limiting"]).toBe(
      "FAIL: No rate limiting detected (50 rapid requests all returned 200)",
    );
  });

  it("oversized-input passes on 413 and fails on a 5xx", () => {
    expect(detailsOf(reflecting.tests, "security-oversized-input")).toBe(
      "HTTP 413 Payload Too Large on a 1 MB sink.data (good)",
    );
    expect(verdicts(wildcard.tests, ["security-oversized-input"])["security-oversized-input"]).toBe(
      "FAIL: HTTP 500 -- server error on a 1 MB sink.data (should answer 413/4xx or a JSON-RPC error)",
    );
    expect(reflecting.warnings.filter((w) => w.startsWith("security-oversized-input:"))).toEqual([]);
  });

  it("keeps every details string ASCII and bounded on hostile servers too", () => {
    for (const run of [reflecting, wildcard, badPrm, bare]) expectAsciiDetails(run.tests, SECURITY_IDS);
  });
});
