import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INTERNAL_IP_PATTERNS, STACK_TRACE_PATTERNS } from "../checks/patterns.js";
import { getTestDefinitionMap } from "../definitions/index.js";
import { createHarness } from "../harness.js";
import { createModernClient, resultOf as rpcResultOf } from "../modern/client.js";
import { createRecorder, type Recorder } from "../recorder.js";
import { MODERN_SPEC_VERSION, specBaseFor } from "../spec.js";
import { createModernState, type ModernSuiteContext } from "../suites/modern/context.js";
import {
  classifyInjectionOutput,
  compareToolLists,
  findLeaks,
  INJECTION_DETECTORS,
  pickInjectionTarget,
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
 * fixture that never answers 429), the auth tests behave with and
 * without credentials, and each fixture knob turns the check it violates
 * RED. Knob runs are grouped one fixture start per knob.
 *
 * Two vehicles: `runModern` (the real dispatcher, filtered to exactly the
 * security ids -- the `--only security` shape, which must measure the
 * server rather than skip) and a direct context that seeds ctx.state
 * itself and runs only the security module. Branches the fixture has no
 * knob for (strict bearer parsers, header-advertised PRM, tools/call-only
 * rate limiting, destructive tools, slow or dying tools) run against
 * small inline servers at the end of the file.
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

const INJECTION_IDS = [
  "security-command-injection",
  "security-sql-injection",
  "security-path-traversal",
  "security-ssrf-internal",
];

const TOOL_IDS = [
  ...INJECTION_IDS,
  "security-oversized-input",
  "security-extra-params",
  "security-tool-schema-defined",
  "security-tool-rug-pull",
  "security-tool-description-poisoning",
  "security-tool-cross-reference",
];

const NO_AUTH_DETAILS = "HTTP 200, result -- server accepted unauthenticated request (no --auth provided)";
const UNREACHED = "never reached the tool (JSON-RPC or transport error)";

/** Ids that FAIL on the clean HTTP fixture by design, with the details they must carry. */
const EXPECTED_FAIL_CLEAN_HTTP: Record<string, RegExp> = {
  "security-auth-required": new RegExp(`^${NO_AUTH_DETAILS.replace(/[()]/g, "\\$&")}$`),
  "security-tls-required": /^Server URL uses http: -- production servers should use HTTPS$/,
  // content_types is the fixture's first read-only tool without required arguments.
  "security-rate-limiting":
    /^No rate limiting detected \(50 rapid tools\/call content_types requests all returned 200\)$/,
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

/** Distinct JSON-RPC error objects the recorder holds: what the leak scan must count. */
function uniqueRecordedErrors(recorder: Recorder): number {
  return new Set(recorder.errors().map((e) => JSON.stringify((e.message as { error?: unknown }).error ?? null))).size;
}

// ---------------------------------------------------------------------------
// Direct context: seeds ctx.state the way lifecycle/features do, runs only
// the security module, and returns its results.
// ---------------------------------------------------------------------------

interface DirectOptions {
  /** HTTP endpoint; omitted = spawn a stdio server. */
  url?: string;
  /** stdio command to spawn instead of the modern fixture. */
  command?: { command: string; args: string[] };
  fixture?: FixtureOptions;
  headers?: Record<string, string>;
  only?: string[];
  /** Per-request timeout (default 5000). */
  timeout?: number;
}

interface DirectRun {
  kind: "http" | "stdio";
  tests: TestResult[];
  warnings: string[];
  toolCount: number;
  recorder: Recorder;
}

async function runDirect(opts: DirectOptions): Promise<DirectRun> {
  const kind = opts.url ? "http" : "stdio";
  const stdio = stdioFixture(opts.fixture).target;
  if (stdio.type !== "stdio") throw new Error("stdioFixture must describe a stdio target");
  const transport: Transport = opts.url
    ? createHttpTransport({ url: opts.url, headers: opts.headers })
    : opts.command
      ? createStdioTransport(opts.command)
      : createStdioTransport({ command: stdio.command, args: stdio.args, env: stdio.env });
  const recorder = createRecorder();
  const unsubscribe = transport.onMessage((m, meta) => recorder.recordReceived(m, meta));
  let id = 5000;
  const harness = createHarness({
    definitions: getTestDefinitionMap(MODERN_SPEC_VERSION),
    specBase: specBaseFor(MODERN_SPEC_VERSION),
    transportKind: kind,
    only: opts.only ?? SECURITY_IDS,
  });
  const timeout = opts.timeout ?? 5000;
  const client = createModernClient({
    transport,
    recorder,
    nextId: () => id++,
    timeout,
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
    timeout,
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
  return {
    kind,
    tests: harness.tests,
    warnings: [...harness.warnings],
    toolCount: ctx.state.tools?.length ?? 0,
    recorder,
  };
}

// ---------------------------------------------------------------------------
// Pure classifiers: the negatives no fixture knob can produce
// ---------------------------------------------------------------------------

describe("security classifiers (unit)", () => {
  it("treats a verbatim echo of the payload as benign, execution evidence as an issue", () => {
    const cmd = INJECTION_DETECTORS.command;
    expect(classifyInjectionOutput("&& echo pwned", "&& echo pwned", cmd, false)).toBe("benign");
    expect(classifyInjectionOutput("you said: && echo pwned", "&& echo pwned", cmd, false)).toBe("benign");
    expect(classifyInjectionOutput("pwned", "&& echo pwned", cmd, false)).toBe("issue");
    expect(classifyInjectionOutput("root:x:0:0:root:/root:/bin/bash", "; cat /etc/passwd", cmd, false)).toBe("issue");
    expect(classifyInjectionOutput("executed: root:x:0:0 ; cat /etc/passwd", "; cat /etc/passwd", cmd, false)).toBe(
      "issue",
    );
    expect(classifyInjectionOutput("uid=0(root) gid=0(root)", "`id`", cmd, false)).toBe("issue");
    expect(classifyInjectionOutput("handled tool_1", "`id`", cmd, false)).toBe("benign");
  });

  it("counts rejection wording and isError as rejected, even over a detector hit", () => {
    const cmd = INJECTION_DETECTORS.command;
    expect(classifyInjectionOutput("Access denied: pwned", "&& echo pwned", cmd, false)).toBe("rejected");
    expect(classifyInjectionOutput("pwned", "&& echo pwned", cmd, true)).toBe("rejected");
    expect(classifyInjectionOutput("", "`id`", cmd, true)).toBe("rejected");
    expect(classifyInjectionOutput("invalid argument: shell metacharacters", "`id`", cmd, false)).toBe("rejected");
  });

  it("flags database error text and internal metadata, not the echoed payload", () => {
    const sql = INJECTION_DETECTORS.sql;
    const payload = "1 UNION SELECT * FROM information_schema.tables--";
    expect(classifyInjectionOutput(payload, payload, sql, false)).toBe("benign");
    expect(classifyInjectionOutput('ERROR: syntax error at or near "\'"', "' OR 1=1 --", sql, false)).toBe("issue");
    expect(classifyInjectionOutput('SQLITE_ERROR: near "\'"', "' OR 1=1 --", sql, false)).toBe("issue");
    const ssrf = INJECTION_DETECTORS.ssrf;
    const url = "http://169.254.169.254/latest/meta-data/";
    expect(classifyInjectionOutput(`fetched ${url}`, url, ssrf, false)).toBe("benign");
    expect(classifyInjectionOutput("ami-0abc123\ninstance-id\niam/", url, ssrf, false)).toBe("issue");
    const path = INJECTION_DETECTORS.pathTraversal;
    expect(classifyInjectionOutput("../../etc/passwd", "../../etc/passwd", path, false)).toBe("benign");
    expect(classifyInjectionOutput("root:x:0:0:root:/root:/bin/sh", "../../etc/passwd", path, false)).toBe("issue");
    expect(classifyInjectionOutput("[boot loader]\ntimeout=30", "..\\..\\windows\\system.ini", path, false)).toBe(
      "issue",
    );
  });

  const destructive = {
    name: "delete_record",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    annotations: { destructiveHint: true },
  };
  const plain = { name: "search", inputSchema: { type: "object", properties: { q: { type: "string" } } } };
  const readOnly = {
    name: "lookup",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string" },
        limit: { type: "integer" },
        verbose: { type: "boolean" },
        mode: { type: "string", enum: ["fast", "full"] },
        tags: { type: "array" },
        opts: { type: "object" },
        note: {},
      },
      required: ["q", "limit", "verbose", "mode", "tags", "opts", "note"],
    },
    annotations: { readOnlyHint: true },
  };
  const file = {
    name: "read_file",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
    annotations: { readOnlyHint: true },
  };
  const fetch = {
    name: "fetch",
    inputSchema: { type: "object", properties: { url: { type: "string" } } },
    annotations: { readOnlyHint: true },
  };

  it("pickInjectionTarget: one target, read-only first, destructive skipped, required siblings filled", () => {
    const target = pickInjectionTarget([destructive, plain, readOnly, file, fetch]);
    expect(target?.tool.name).toBe("lookup");
    expect(target?.param).toBe("q");
    expect(target?.fill).toEqual({ limit: 1, verbose: false, mode: "fast", tags: [], opts: {}, note: "test" });
    expect(target?.skippedDestructive).toEqual(["delete_record"]);
    expect(target?.destructiveProbed).toBe(false);
    // Read-only beats list order; an unannotated tool beats a destructive one.
    expect(pickInjectionTarget([plain, readOnly])?.tool.name).toBe("lookup");
    expect(pickInjectionTarget([destructive, plain])?.tool.name).toBe("search");
    expect(pickInjectionTarget([plain, destructive])?.skippedDestructive).toEqual(["delete_record"]);
  });

  it("pickInjectionTarget: argument-name preferences pick across tools, else the shared target", () => {
    const all = [destructive, plain, readOnly, file, fetch];
    const byPath = pickInjectionTarget(all, [/path/i]);
    expect([byPath?.tool.name, byPath?.param, byPath?.fill]).toEqual(["read_file", "path", {}]);
    const byUrl = pickInjectionTarget(all, [/url/i]);
    expect([byUrl?.tool.name, byUrl?.param]).toEqual(["fetch", "url"]);
    const fallback = pickInjectionTarget(all, [/nothing-matches/]);
    expect([fallback?.tool.name, fallback?.param]).toEqual(["lookup", "q"]);
    // A destructive tool's matching argument does not win while an alternative exists.
    expect(pickInjectionTarget([destructive, plain], [/id/])?.tool.name).toBe("search");
  });

  it("pickInjectionTarget: a destructive tool is probed only when nothing else has a string argument", () => {
    const only = pickInjectionTarget([destructive, { name: "noop", inputSchema: { type: "object", properties: {} } }]);
    expect([only?.tool.name, only?.param, only?.destructiveProbed, only?.skippedDestructive]).toEqual([
      "delete_record",
      "id",
      true,
      [],
    ]);
    expect(pickInjectionTarget([{ name: "noop", inputSchema: { type: "object", properties: {} } }])).toBeNull();
    expect(pickInjectionTarget([])).toBeNull();
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

  it("leak patterns cover link-local addresses, internal hostnames and JSON-escaped Windows paths", () => {
    const metadata = { text: '{"code":-32603,"message":"connect ECONNREFUSED 169.254.169.254:80"}', requestText: "{}" };
    expect(findLeaks([metadata], INTERNAL_IP_PATTERNS)[0]).toContain("169.254.169.254");
    const host = { text: '{"code":-32603,"message":"getaddrinfo ENOTFOUND db01.corp.internal"}', requestText: "{}" };
    expect(findLeaks([host], INTERNAL_IP_PATTERNS)[0]).toContain("corp.internal");
    const lan = { text: '{"code":-32603,"message":"upstream cache.lan:6379 refused"}', requestText: "{}" };
    expect(findLeaks([lan], INTERNAL_IP_PATTERNS)[0]).toContain("cache.lan");
    // A dotted file name is not a hostname.
    const dotted = { text: '{"code":-32603,"message":"cannot read settings.local.json"}', requestText: "{}" };
    expect(findLeaks([dotted], INTERNAL_IP_PATTERNS)).toEqual([]);
    // The samples are JSON-serialised, so the backslashes arrive doubled.
    const win = {
      text: JSON.stringify({ code: -32603, message: "ENOENT: no such file, open 'C:\\Users\\svc\\app\\config.json'" }),
      requestText: "{}",
    };
    expect(findLeaks([win], STACK_TRACE_PATTERNS)[0]).toContain("C:\\\\Users\\\\svc");
    const rawWin = { text: "ENOENT: open C:\\Users\\svc\\app", requestText: "{}" };
    expect(findLeaks([rawWin], STACK_TRACE_PATTERNS)[0]).toContain("C:\\Users\\svc");
  });
});

// ---------------------------------------------------------------------------
// Clean fixture through the real dispatcher, filtered to the security ids
// only (`--only security`): the tool-dependent tests must fetch tools/list
// themselves rather than skip.
// ---------------------------------------------------------------------------

describe("modern security suite: clean fixture over stdio (runModern, --only security)", () => {
  let report: ComplianceReport;

  beforeAll(async () => {
    report = await runModern(stdioFixture().target, { only: SECURITY_IDS });
  });

  it("passes every transport-agnostic security test", () => {
    expect(passedIds(report, BOTH_TRANSPORT_IDS)).toEqual(allPass(BOTH_TRANSPORT_IDS));
  });

  it("fetches the tools list itself instead of skip-passing the tool-dependent tests", () => {
    expect(report.toolCount).toBe(11);
    expect(resultOf(report, "security-tool-schema-defined").details).toBe("All 11 tool(s) have inputSchema defined");
    expect(resultOf(report, "security-command-injection").details).toMatch(
      /^Tested 5 payload\(s\) against echo\.message/,
    );
    for (const id of TOOL_IDS) expect(resultOf(report, id).details, id).not.toMatch(/^Skipped/);
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

describe("modern security suite: clean fixture over HTTP (runModern, --only security)", () => {
  let fixture: HttpFixture;
  let report: ComplianceReport;

  beforeAll(async () => {
    fixture = await startHttpFixture();
    report = await runModern(fixture.url, { only: SECURITY_IDS });
  });

  afterAll(async () => {
    await fixture.stop();
  });

  it("passes every security test except the three that fail on this fixture by design", () => {
    const passing = SECURITY_IDS.filter((id) => !(id in EXPECTED_FAIL_CLEAN_HTTP));
    expect(passedIds(report, passing)).toEqual(allPass(passing));
  });

  it("fails auth-required (no --auth), tls-required (http URL) and rate-limiting (never 429) naming what was observed", () => {
    for (const [id, pattern] of Object.entries(EXPECTED_FAIL_CLEAN_HTTP)) {
      const r = resultOf(report, id);
      expect(r.passed, id).toBe(false);
      expect(r.details, id).toMatch(pattern);
    }
    expect(report.toolCount).toBe(11);
  });

  it("without --auth on a server that needs none: the token-dependent tests skip, the rest report the 200", () => {
    expect(resultOf(report, "security-www-authenticate").details).toBe("HTTP 200 -- not a 401 response (skipped)");
    expect(resultOf(report, "security-oauth-metadata").details).toBe(
      "Skipped: server does not require auth (unauthenticated server/discover answered HTTP 200)",
    );
    expect(resultOf(report, "security-auth-malformed").details).toBe(
      "Skipped: needs a valid credential to compare against (pass --auth)",
    );
    expect(resultOf(report, "security-token-in-uri").details).toBe(
      "Skipped: needs a valid credential to place in the URI (pass --auth)",
    );
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
    // One target per test: echo is the first read-only tool with a string
    // argument, and it needs nothing else filled. The fixture echoes, so
    // nothing is rejected and nothing counts as defended.
    expect(detailsOf(run.tests, "security-command-injection")).toBe(
      `Tested 5 payload(s) against echo.message: 0 rejected, 5 returned without evidence of execution, 0 ${UNREACHED}`,
    );
    expect(detailsOf(run.tests, "security-sql-injection")).toBe(
      `Tested 3 payload(s) against echo.message: 0 rejected, 3 returned without evidence of execution, 0 ${UNREACHED}`,
    );
    expect(detailsOf(run.tests, "security-path-traversal")).toBe(
      `Tested 3 payload(s) against echo.message: 0 rejected, 3 returned without evidence of execution, 0 ${UNREACHED}`,
    );
    // No URL-named argument anywhere: SSRF falls back to the shared target.
    expect(detailsOf(run.tests, "security-ssrf-internal")).toBe(
      `Tested 4 payload(s) against echo.message: 0 rejected, 4 returned without evidence of execution, 0 ${UNREACHED}`,
    );
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
      /^\d+ unique error response\(s\) checked -- no stack traces or sensitive data found$/,
    );
    expect(detailsOf(run.tests, "security-error-no-internal-ip")).toMatch(
      /^\d+ unique error response\(s\) checked -- no internal IP addresses or hostnames found$/,
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

  it("counts each distinct error response once: its own probes are already in the recorder", () => {
    // Every probe answer is a JSON-RPC error the recorder also holds (the
    // raw invalid-JSON probe included), so the scan must report exactly
    // the recorder's distinct error objects -- not probes plus recorder.
    const count = (run: DirectRun) =>
      Number(/^(\d+) unique error/.exec(detailsOf(run.tests, "security-error-no-stacktrace"))?.[1]);
    for (const run of [http, stdio]) {
      expect(count(run), run.kind).toBe(uniqueRecordedErrors(run.recorder));
      expect(count(run), run.kind).toBeGreaterThanOrEqual(5);
    }
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
    withAuth = await runModern(fixture.url, { headers: { Authorization: "Bearer secret" }, only: AUTH_IDS });
    withoutAuth = await runModern(fixture.url, { only: AUTH_IDS });
  });

  afterAll(async () => {
    await fixture.stop();
  });

  it("with --auth: the auth tests, token-in-URI and PRM discovery all pass with the observed status", () => {
    expect(passedIds(withAuth, AUTH_IDS)).toEqual(allPass(AUTH_IDS));
    expect(resultOf(withAuth, "security-auth-required").details).toBe("HTTP 401 (unauthenticated request rejected)");
    expect(resultOf(withAuth, "security-www-authenticate").details).toBe(
      `WWW-Authenticate: Bearer resource_metadata="${fixture.base}/.well-known/oauth-protected-resource"`,
    );
    // Both credentials drew 401: the fixture answers every wrong token that way.
    expect(resultOf(withAuth, "security-auth-malformed").details).toBe(
      "well-formed invalid token: HTTP 401; malformed credential: HTTP 401",
    );
    expect(resultOf(withAuth, "security-token-in-uri").details).toBe("HTTP 401 (token in query string rejected)");
    // The challenge's resource_metadata URL is tried first.
    expect(resultOf(withAuth, "security-oauth-metadata").details).toBe(
      `Protected Resource Metadata found at /.well-known/oauth-protected-resource (via WWW-Authenticate): resource=${fixture.base}/mcp, 1 auth server(s)`,
    );
    expect(withAuth.warnings.filter((w) => w.startsWith("security-"))).toEqual([]);
  });

  it("without --auth: the 401 the run observed passes auth-required, www-authenticate and PRM discovery", () => {
    expect(resultOf(withoutAuth, "security-auth-required").details).toBe(
      "HTTP 401 (unauthenticated request rejected); pass --auth to exercise the rest of the auth suite",
    );
    expect(resultOf(withoutAuth, "security-www-authenticate").details).toBe(
      `WWW-Authenticate: Bearer resource_metadata="${fixture.base}/.well-known/oauth-protected-resource"`,
    );
    expect(resultOf(withoutAuth, "security-oauth-metadata").details).toBe(
      `Protected Resource Metadata found at /.well-known/oauth-protected-resource (via WWW-Authenticate): resource=${fixture.base}/mcp, 1 auth server(s)`,
    );
    expect(passedIds(withoutAuth, AUTH_IDS)).toEqual(allPass(AUTH_IDS));
  });

  it("without --auth: only the tests that need a valid credential skip", () => {
    expect(resultOf(withoutAuth, "security-auth-malformed").details).toBe(
      "Skipped: needs a valid credential to compare against (pass --auth)",
    );
    expect(resultOf(withoutAuth, "security-token-in-uri").details).toBe(
      "Skipped: needs a valid credential to place in the URI (pass --auth)",
    );
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
    http = await runModern(fixture.url, { only: SECURITY_IDS });
    stdio = await runModern(stdioFixture({ breaks }).target, { only: SECURITY_IDS });
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

describe("knob no-id-echo: the leak scan still counts each distinct error once", () => {
  let fixture: HttpFixture;
  let run: DirectRun;

  beforeAll(async () => {
    // Error replies carry id: null, so the recorder cannot correlate them
    // with the request; the probe sample and the recorded sample must
    // still collapse into one.
    fixture = await startHttpFixture({ breaks: ["no-id-echo"] });
    run = await runDirect({ url: fixture.url, only: ["security-error-no-stacktrace"] });
  });

  afterAll(async () => {
    await fixture.stop();
  });

  it("reports exactly the recorder's distinct error objects", () => {
    const count = Number(/^(\d+) unique error/.exec(detailsOf(run.tests, "security-error-no-stacktrace"))?.[1]);
    expect(count).toBe(uniqueRecordedErrors(run.recorder));
    expect(count).toBeGreaterThanOrEqual(5);
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
// Inline servers: branches the fixture has no knob for. A tiny node:http
// server that accepts every credential or parses bearer tokens strictly,
// reflects or wildcards CORS, serves PRM at one of the lookup locations
// (including a header-advertised one), throttles with 429 (everything or
// tools/call only), answers oversized bodies with 413/500, publishes a
// destructive tool, or is slow / drops the socket on tools/call.
// ---------------------------------------------------------------------------

interface InlineOptions {
  /**
   * Bearer handling on POST /mcp. Default: accept everything.
   * "strict": `Bearer tok` served; a well-formed unknown token 401; a
   * value outside the b64token grammar 400 (RFC 6750 invalid_request).
   * "strict-400": like strict but the well-formed unknown token also 400s.
   */
  auth?: "strict" | "strict-400";
  cors?: "reflect" | "wildcard" | "none";
  /**
   * Where Protected Resource Metadata lives. "header": only at /oauth/prm,
   * advertised through WWW-Authenticate. "header-mismatch": the same, but
   * its `resource` is not the endpoint.
   */
  prm?: "path" | "legacy" | "root-bad" | "none" | "header" | "header-mismatch";
  /** POSTs (or tools/call only) beyond this count get 429. */
  rateLimit?: { after: number; scope: "all" | "tools-call" };
  /** Status for bodies over 500 KB. */
  bigBody?: 413 | 500;
  tools?: "sink" | "injection-set" | "mirrored-first" | "mirrored-only" | "required-only" | "none";
  /** Delay every tools/call answer by this many ms. */
  slowToolsCall?: number;
  /** Destroy the socket on tools/call instead of answering. */
  dropOnToolsCall?: boolean;
}

interface InlineServer {
  url: string;
  base: string;
  /** Every tools/call the server received, in order. */
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  close(): Promise<void>;
}

const SINK_TOOL = {
  name: "sink",
  description: "Accepts anything",
  inputSchema: { type: "object", properties: { data: { type: "string" } } },
  annotations: { readOnlyHint: true },
};

/** A destructive tool first, an unannotated one second, then read-only tools with distinct argument names. */
const INJECTION_SET_TOOLS = [
  {
    name: "delete_record",
    description: "Deletes a record",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    annotations: { destructiveHint: true },
  },
  {
    name: "search",
    description: "Searches",
    inputSchema: { type: "object", properties: { q: { type: "string" } } },
  },
  {
    name: "lookup",
    description: "Looks something up",
    inputSchema: {
      type: "object",
      properties: { q: { type: "string" }, limit: { type: "integer" }, verbose: { type: "boolean" } },
      required: ["q", "limit", "verbose"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "read_file",
    description: "Reads a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "fetch",
    description: "Fetches a URL",
    inputSchema: { type: "object", properties: { url: { type: "string" } } },
    annotations: { readOnlyHint: true },
  },
];

const MIRRORED_FIRST_TOOL = {
  name: "sink",
  description: "Region first, then the query",
  inputSchema: {
    type: "object",
    properties: { region: { type: "string", "x-mcp-header": "Region" }, query: { type: "string" } },
  },
  annotations: { readOnlyHint: true },
};

const MIRRORED_ONLY_TOOL = {
  name: "sink",
  description: "Only a header-mirrored argument",
  inputSchema: { type: "object", properties: { region: { type: "string", "x-mcp-header": "Region" } } },
  annotations: { readOnlyHint: true },
};

const REQUIRED_ONLY_TOOL = {
  name: "lookup",
  description: "Read-only but needs an argument",
  inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
  annotations: { readOnlyHint: true },
};

const B64TOKEN = /^Bearer [A-Za-z0-9._~+/-]+=*$/;

function startInlineServer(opts: InlineOptions): Promise<InlineServer> {
  let posts = 0;
  let toolCalls = 0;
  let base = "";
  const calls: InlineServer["calls"] = [];
  const toolList = () => {
    switch (opts.tools ?? "sink") {
      case "sink":
        return [SINK_TOOL];
      case "injection-set":
        return INJECTION_SET_TOOLS;
      case "mirrored-first":
        return [MIRRORED_FIRST_TOOL];
      case "mirrored-only":
        return [MIRRORED_ONLY_TOOL];
      case "required-only":
        return [REQUIRED_ONLY_TOOL];
      case "none":
        return [];
    }
  };
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
      const prmUrl =
        opts.prm === "header" || opts.prm === "header-mismatch"
          ? `${base}/oauth/prm`
          : `${base}/.well-known/oauth-protected-resource`;
      const path = url.pathname;
      if (path === "/.well-known/oauth-protected-resource" && opts.prm === "root-bad") {
        return json(200, { resource: `${base}/mcp` }); // no authorization_servers
      }
      if (path === "/.well-known/oauth-protected-resource/mcp" && opts.prm === "path") {
        return json(200, { resource: `${base}/mcp`, authorization_servers: ["https://as.example.com"] });
      }
      if (path === "/oauth/prm" && (opts.prm === "header" || opts.prm === "header-mismatch")) {
        const resource = opts.prm === "header" ? `${base}/mcp` : `${base}/other`;
        return json(200, { resource, authorization_servers: ["https://as.example.com"] });
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
      if (opts.auth) {
        const authz = req.headers.authorization;
        const rejection = { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Unauthorized" } };
        if (!authz) {
          return json(401, rejection, { "WWW-Authenticate": `Bearer resource_metadata="${prmUrl}"` });
        }
        if (authz !== "Bearer tok") {
          const wellFormed = B64TOKEN.test(authz);
          if (wellFormed && opts.auth === "strict") {
            return json(401, rejection, {
              "WWW-Authenticate": `Bearer error="invalid_token", resource_metadata="${prmUrl}"`,
            });
          }
          return json(400, rejection, { "WWW-Authenticate": 'Bearer error="invalid_request"' });
        }
      }
      posts++;
      let msg: any;
      try {
        msg = JSON.parse(body.toString("utf8"));
      } catch {
        return json(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      }
      const limited =
        opts.rateLimit &&
        (opts.rateLimit.scope === "all"
          ? posts > opts.rateLimit.after
          : msg?.method === "tools/call" && toolCalls >= opts.rateLimit.after);
      if (msg?.method === "tools/call") {
        toolCalls++;
        // Recorded before the 429 gate so a throttled burst is still observable.
        calls.push({
          name: String(msg?.params?.name),
          args: (msg?.params?.arguments ?? {}) as Record<string, unknown>,
        });
      }
      if (limited) {
        return json(
          429,
          { jsonrpc: "2.0", id: msg?.id ?? null, error: { code: -32000, message: "slow down" } },
          { "Retry-After": "1" },
        );
      }
      if (opts.bigBody && body.length > 500_000) {
        return json(opts.bigBody, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "too big" } });
      }
      const result = (r: Record<string, unknown>) =>
        json(200, { jsonrpc: "2.0", id: msg?.id ?? null, result: { resultType: "complete", ...r } });
      const error = (code: number, message: string) =>
        json(200, { jsonrpc: "2.0", id: msg?.id ?? null, error: { code, message } });
      const tools = toolList();
      switch (msg?.method) {
        case "server/discover":
          return result({
            supportedVersions: [MODERN_SPEC_VERSION],
            capabilities: opts.tools === "none" ? {} : { tools: {} },
            ttlMs: 0,
            cacheScope: "public",
          });
        case "tools/list":
          return result({ tools, ttlMs: 0, cacheScope: "public" });
        case "tools/call": {
          const name = String(msg?.params?.name);
          const args = (msg?.params?.arguments ?? {}) as Record<string, unknown>;
          if (opts.dropOnToolsCall) return req.socket.destroy();
          const answer = () => {
            if (opts.tools !== "injection-set") return result({ content: [{ type: "text", text: "ok" }] });
            switch (name) {
              case "lookup":
                if (typeof args.q !== "string" || args.limit !== 1 || args.verbose !== false) {
                  return error(
                    -32602,
                    "Invalid params: q (string), limit (integer) and verbose (boolean) are required",
                  );
                }
                return result({ content: [{ type: "text", text: "3 results" }] });
              case "read_file":
                return result({
                  content: [{ type: "text", text: "access denied: outside the allowed directory" }],
                  isError: true,
                });
              case "fetch":
                return error(-32602, "Invalid params: url must be https");
              default:
                return result({ content: [{ type: "text", text: "ok" }] });
            }
          };
          if (opts.slowToolsCall) return void setTimeout(answer, opts.slowToolsCall);
          return answer();
        }
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
        calls,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

describe("inline servers: permissive auth, CORS, PRM locations, throttling and body limits", () => {
  const servers: InlineServer[] = [];
  let reflecting: DirectRun;
  let wildcard: DirectRun;
  let badPrm: DirectRun;
  let bare: DirectRun;
  const AUTH = { Authorization: "Bearer tok" };

  beforeAll(async () => {
    const a = await startInlineServer({
      cors: "reflect",
      prm: "path",
      rateLimit: { after: 40, scope: "all" },
      bigBody: 413,
    });
    const b = await startInlineServer({ cors: "wildcard", prm: "legacy", bigBody: 500 });
    const c = await startInlineServer({ cors: "none", prm: "root-bad" });
    const d = await startInlineServer({ cors: "none", prm: "none" });
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
      "security-auth-malformed":
        "FAIL: well-formed invalid token: HTTP 200, result -- server accepted an invalid bearer token (MUST answer 401); malformed credential: HTTP 200, result -- server accepted a malformed Authorization header",
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

  it("oauth-metadata tries the endpoint-path PRM before the root, accepts legacy AS metadata with a warning, and fails otherwise", () => {
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
    // Spec order: the endpoint-path variant first, the root second.
    expect(verdicts(bare.tests, ["security-oauth-metadata"])["security-oauth-metadata"]).toBe(
      "FAIL: No Protected Resource Metadata (/.well-known/oauth-protected-resource/mcp -> HTTP 404; /.well-known/oauth-protected-resource -> HTTP 404) and no legacy OAuth metadata",
    );
  });

  it("rate-limiting bursts the read-only no-argument tool: passes on a 429, fails when every call is served", () => {
    expect(detailsOf(reflecting.tests, "security-rate-limiting")).toBe(
      "Rate limiting detected (429 returned within 50 rapid tools/call sink requests)",
    );
    expect(verdicts(bare.tests, ["security-rate-limiting"])["security-rate-limiting"]).toBe(
      "FAIL: No rate limiting detected (50 rapid tools/call sink requests all returned 200)",
    );
    expect(bare.warnings.filter((w) => w.startsWith("security-rate-limiting:"))).toEqual([]);
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

describe("inline servers: strict bearer parsing and header-advertised PRM", () => {
  const servers: InlineServer[] = [];
  let strict: DirectRun;
  let strict400: DirectRun;
  let mismatch: DirectRun;
  const AUTH = { Authorization: "Bearer tok" };

  beforeAll(async () => {
    const a = await startInlineServer({ auth: "strict", prm: "header" });
    const b = await startInlineServer({ auth: "strict-400", prm: "header" });
    const c = await startInlineServer({ auth: "strict", prm: "header-mismatch" });
    servers.push(a, b, c);
    strict = await runDirect({ url: a.url, headers: AUTH, only: AUTH_IDS });
    strict400 = await runDirect({ url: b.url, headers: AUTH, only: AUTH_IDS });
    mismatch = await runDirect({ url: c.url, headers: AUTH, only: AUTH_IDS });
  });

  afterAll(async () => {
    for (const s of servers) await s.close();
  });

  it("auth-malformed passes a 400 on the malformed credential as long as the well-formed invalid token draws 401", () => {
    expect(verdicts(strict.tests, AUTH_IDS)).toEqual(allPass(AUTH_IDS));
    expect(detailsOf(strict.tests, "security-auth-malformed")).toBe(
      "well-formed invalid token: HTTP 401; malformed credential: HTTP 400 (RFC 6750 invalid_request)",
    );
    expect(detailsOf(strict.tests, "security-auth-required")).toBe("HTTP 401 (unauthenticated request rejected)");
  });

  it("auth-malformed fails when the well-formed invalid token is answered 400 instead of the mandated 401", () => {
    expect(verdicts(strict400.tests, ["security-auth-malformed"])["security-auth-malformed"]).toBe(
      "FAIL: well-formed invalid token: HTTP 400, JSON-RPC error -32600 -- expected 401 (invalid tokens MUST receive 401)",
    );
  });

  it("oauth-metadata fetches the resource_metadata URL from the challenge first, wherever it points", () => {
    expect(detailsOf(strict.tests, "security-www-authenticate")).toBe(
      `WWW-Authenticate: Bearer resource_metadata="${servers[0].base}/oauth/prm"`,
    );
    expect(detailsOf(strict.tests, "security-oauth-metadata")).toBe(
      `Protected Resource Metadata found at /oauth/prm (via WWW-Authenticate): resource=${servers[0].base}/mcp, 1 auth server(s)`,
    );
    expect(strict.warnings.filter((w) => w.startsWith("security-oauth-metadata:"))).toEqual([]);
  });

  it("oauth-metadata warns when the document's resource is not the MCP endpoint", () => {
    expect(detailsOf(mismatch.tests, "security-oauth-metadata")).toBe(
      `Protected Resource Metadata found at /oauth/prm (via WWW-Authenticate): resource=${servers[2].base}/other, 1 auth server(s) (resource does not match the endpoint, see warning)`,
    );
    const warnings = mismatch.warnings.filter((w) => w.startsWith("security-oauth-metadata:"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`names resource "${servers[2].base}/other"`);
    expect(warnings[0]).toContain("RFC 9728");
  });

  it("keeps every details string ASCII and bounded", () => {
    for (const run of [strict, strict400, mismatch]) expectAsciiDetails(run.tests, AUTH_IDS);
  });
});

describe("inline servers: one injection target per test, destructive tools skipped, required siblings filled", () => {
  let server: InlineServer;
  let run: DirectRun;

  beforeAll(async () => {
    server = await startInlineServer({ tools: "injection-set" });
    run = await runDirect({ url: server.url, only: INJECTION_IDS });
  });

  afterAll(async () => {
    await server.close();
  });

  it("never calls the destructive tool and probes one (tool, argument) per test", () => {
    const names = new Set(server.calls.map((c) => c.name));
    expect(names.has("delete_record")).toBe(false);
    expect(names.has("search")).toBe(false);
    // 5 command + 3 sql payloads on lookup.q, 3 traversal on read_file.path, 4 SSRF on fetch.url.
    expect(server.calls.filter((c) => c.name === "lookup")).toHaveLength(8);
    expect(server.calls.filter((c) => c.name === "read_file")).toHaveLength(3);
    expect(server.calls.filter((c) => c.name === "fetch")).toHaveLength(4);
    expect(server.calls).toHaveLength(15);
  });

  it("fills lookup's other required arguments with typed placeholders so the payload reaches the handler", () => {
    for (const call of server.calls.filter((c) => c.name === "lookup")) {
      expect(call.args.limit).toBe(1);
      expect(call.args.verbose).toBe(false);
      expect(typeof call.args.q).toBe("string");
    }
  });

  it("reports the three buckets and claims 'defended' only when every payload was rejected", () => {
    expect(verdicts(run.tests, INJECTION_IDS)).toEqual(allPass(INJECTION_IDS));
    expect(detailsOf(run.tests, "security-command-injection")).toBe(
      `Tested 5 payload(s) against lookup.q: 0 rejected, 5 returned without evidence of execution, 0 ${UNREACHED}`,
    );
    expect(detailsOf(run.tests, "security-sql-injection")).toBe(
      `Tested 3 payload(s) against lookup.q: 0 rejected, 3 returned without evidence of execution, 0 ${UNREACHED}`,
    );
    expect(detailsOf(run.tests, "security-path-traversal")).toBe(
      `Tested 3 payload(s) against read_file.path: 3 rejected, 0 returned without evidence of execution, 0 ${UNREACHED} -- server defended`,
    );
    expect(detailsOf(run.tests, "security-ssrf-internal")).toBe(
      `Tested 4 payload(s) against fetch.url: 0 rejected, 0 returned without evidence of execution, 4 ${UNREACHED}`,
    );
    expectAsciiDetails(run.tests, INJECTION_IDS);
  });

  it("pushes exactly one warning for the skipped destructive tool and one for the placeholder fill", () => {
    expect(run.warnings).toEqual([
      "security injection tests: skipped destructive tool(s) delete_record (annotations.destructiveHint true).",
      "security injection tests: filled required argument(s) limit=1, verbose=false of lookup with placeholders so the payload could reach the handler.",
    ]);
  });
});

describe("inline servers: oversized-input avoids header-mirrored arguments", () => {
  const servers: InlineServer[] = [];
  let mirroredFirst: DirectRun;
  let mirroredOnly: DirectRun;

  beforeAll(async () => {
    const a = await startInlineServer({ tools: "mirrored-first" });
    const b = await startInlineServer({ tools: "mirrored-only" });
    servers.push(a, b);
    mirroredFirst = await runDirect({ url: a.url, only: ["security-oversized-input"] });
    mirroredOnly = await runDirect({ url: b.url, only: ["security-oversized-input"] });
  });

  afterAll(async () => {
    for (const s of servers) await s.close();
  });

  it("sends the 1 MB value in the first string argument that is NOT x-mcp-header, so the body path is measured", () => {
    expect(detailsOf(mirroredFirst.tests, "security-oversized-input")).toBe(
      "HTTP 200, result -- server processed a 1 MB sink.query without rejecting it (survived)",
    );
    expect(servers[0].calls).toHaveLength(1);
    expect(String(servers[0].calls[0].args.query)).toHaveLength(1_000_000);
  });

  it("falls back to the mirrored argument only when nothing else exists, and says the header limit was measured", () => {
    const r = mirroredOnly.tests.find((t) => t.id === "security-oversized-input");
    expect(r?.passed).toBe(true);
    expect(r?.details).toMatch(/ \[region is x-mcp-header: measured the header limit, not the body\]$/);
    expectAsciiDetails(mirroredOnly.tests, ["security-oversized-input"]);
  });
});

describe("inline servers: rate limiting on tools/call only, and the discover fallback", () => {
  const servers: InlineServer[] = [];
  let toolsOnly: DirectRun;
  let noTools: DirectRun;
  let requiredOnly: DirectRun;

  beforeAll(async () => {
    const a = await startInlineServer({ rateLimit: { after: 10, scope: "tools-call" } });
    const b = await startInlineServer({ tools: "none" });
    const c = await startInlineServer({ tools: "required-only" });
    servers.push(a, b, c);
    toolsOnly = await runDirect({ url: a.url, only: ["security-rate-limiting"] });
    noTools = await runDirect({ url: b.url, only: ["security-rate-limiting"] });
    requiredOnly = await runDirect({ url: c.url, only: ["security-rate-limiting"] });
  });

  afterAll(async () => {
    for (const s of servers) await s.close();
  });

  it("passes a server that throttles tool invocations but serves discovery freely", () => {
    expect(detailsOf(toolsOnly.tests, "security-rate-limiting")).toBe(
      "Rate limiting detected (429 returned within 50 rapid tools/call sink requests)",
    );
    expect(servers[0].calls.length).toBe(50);
  });

  it("bursts server/discover only when no read-only argument-free tool exists, and then passes with a warning", () => {
    expect(detailsOf(noTools.tests, "security-rate-limiting")).toBe(
      "50 rapid server/discover requests all returned 200; tool invocations could not be bursted (server declares no tools, see warning)",
    );
    expect(detailsOf(requiredOnly.tests, "security-rate-limiting")).toBe(
      "50 rapid server/discover requests all returned 200; tool invocations could not be bursted (no read-only tool without required arguments, see warning)",
    );
    for (const run of [noTools, requiredOnly]) {
      const warnings = run.warnings.filter((w) => w.startsWith("security-rate-limiting:"));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("only server/discover was bursted");
    }
    expect(servers[2].calls).toEqual([]);
  });
});

describe("inline servers: extra-params tells a slow tool from a dead server", () => {
  const servers: InlineServer[] = [];
  let slow: DirectRun;
  let dropped: DirectRun;
  let died: DirectRun;
  let dir = "";

  beforeAll(async () => {
    const a = await startInlineServer({ slowToolsCall: 1500 });
    const b = await startInlineServer({ dropOnToolsCall: true });
    servers.push(a, b);
    slow = await runDirect({ url: a.url, only: ["security-extra-params"], timeout: 500 });
    dropped = await runDirect({ url: b.url, only: ["security-extra-params"] });
    // A stdio server that exits on tools/call.
    dir = mkdtempSync(join(tmpdir(), "mcp-compliance-sec-"));
    const script = join(dir, "exit-on-call.mjs");
    writeFileSync(
      script,
      [
        'import { createInterface } from "node:readline";',
        "const rl = createInterface({ input: process.stdin });",
        'const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");',
        'rl.on("line", (line) => {',
        "  let msg;",
        "  try { msg = JSON.parse(line); } catch { return; }",
        "  if (msg.id === undefined) return;",
        '  const result = (r) => send({ jsonrpc: "2.0", id: msg.id, result: { resultType: "complete", ...r } });',
        '  if (msg.method === "server/discover") return result({ supportedVersions: ["2026-07-28"], capabilities: { tools: {} }, ttlMs: 0, cacheScope: "public" });',
        '  if (msg.method === "tools/list") return result({ tools: [{ name: "boom", inputSchema: { type: "object", properties: {} } }], ttlMs: 0, cacheScope: "public" });',
        '  if (msg.method === "tools/call") process.exit(3);',
        '  send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });',
        "});",
        "",
      ].join("\n"),
    );
    died = await runDirect({ command: { command: process.execPath, args: [script] }, only: ["security-extra-params"] });
  }, 30_000);

  afterAll(async () => {
    for (const s of servers) await s.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("a timeout is inconclusive: passes with a warning, never 'crashed'", () => {
    const r = slow.tests.find((t) => t.id === "security-extra-params");
    expect(r?.passed).toBe(true);
    expect(r?.details).toBe(
      "tools/call sink did not answer within 500ms -- extra-params verdict inconclusive (see warning)",
    );
    const warnings = slow.warnings.filter((w) => w.startsWith("security-extra-params:"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("not a crash");
  });

  it("a dropped connection fails as a possible crash", () => {
    expect(verdicts(dropped.tests, ["security-extra-params"])["security-extra-params"]).toMatch(
      /^FAIL: connection dropped on unknown tool arguments \(tools\/call sink\): .+ \(server may have crashed\)$/,
    );
  });

  it("a stdio child that exits on the call fails as died", () => {
    expect(verdicts(died.tests, ["security-extra-params"])["security-extra-params"]).toMatch(
      /^FAIL: server died on unknown tool arguments \(tools\/call boom\): .*exit code 3/,
    );
    expectAsciiDetails(died.tests, ["security-extra-params"]);
  });
});
