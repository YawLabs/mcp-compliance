import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ComplianceReport, TransportTarget } from "../types.js";
import {
  type HttpFixture,
  passedIds,
  resultOf,
  runModern,
  startHttpFixture,
  stdioFixture,
} from "./helpers/modern-fixture.js";

/**
 * The 2026-07-28 errors module (src/suites/modern/errors.ts): every id
 * passes on the clean fixture over BOTH transports, and every id is shown
 * going red -- via a fixture break knob where one exists, otherwise via a
 * canned "bad server" that answers with the exact wrong shape.
 */

const HTTP_ONLY = ["error-invalid-jsonrpc", "error-invalid-json", "error-parse-code", "error-invalid-request-code"];
const BOTH = [
  "error-unknown-method",
  "error-method-code",
  "error-missing-params",
  "tools-call-unknown",
  "error-capability-gated",
  "error-invalid-cursor",
];
const ALL = [...BOTH, ...HTTP_ONLY];

const NOT_FOUND_WARNING = "spec requires 404";
const BARE_4XX_WARNING = "with no JSON-RPC body";

function warned(report: ComplianceReport, needle: string): boolean {
  return report.warnings.some((w) => w.includes(needle));
}

function expectFail(report: ComplianceReport, id: string, detail: string) {
  const r = resultOf(report, id);
  expect(r.passed, `${id} should fail: ${r.details}`).toBe(false);
  expect(r.details).toContain(detail);
}

function expectPass(report: ComplianceReport, id: string, detail?: string) {
  const r = resultOf(report, id);
  expect(r.passed, `${id} should pass: ${r.details}`).toBe(true);
  if (detail) expect(r.details).toContain(detail);
}

// ---------------------------------------------------------------------------
// Canned bad servers: the ids with no fixture knob are proven red here.
// ---------------------------------------------------------------------------

interface Canned {
  status: number;
  body?: unknown;
  /** Verbatim body (HTML, empty, SSE); wins over `body`. */
  raw?: string;
  contentType?: string;
  /** Drop the connection without answering (a server whose body parser kills the socket). */
  destroy?: boolean;
}

interface Seen {
  parsed: unknown;
  parseError: boolean;
  method: string | undefined;
  params: Record<string, unknown>;
  id: unknown;
}

type Decide = (seen: Seen) => Canned;

function discoverResult(capabilities: Record<string, unknown>) {
  return {
    resultType: "complete",
    supportedVersions: ["2026-07-28"],
    capabilities,
    ttlMs: 0,
    cacheScope: "public",
  };
}

const rpcResult = (id: unknown, result: Record<string, unknown>) => ({
  jsonrpc: "2.0",
  id,
  result: { resultType: "complete", ...result },
});
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

/** In-process HTTP server whose every answer is chosen by the current `decide`. */
async function startBadHttp(): Promise<{ url: string; set(decide: Decide): void; stop(): Promise<void> }> {
  let decide: Decide = () => ({ status: 500 });
  const server: Server = createServer((req, res) => {
    let text = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      text += chunk;
    });
    req.on("end", () => {
      let parsed: unknown;
      let parseError = false;
      try {
        parsed = JSON.parse(text);
      } catch {
        parseError = true;
      }
      const obj = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
      const canned = decide({
        parsed,
        parseError,
        method: typeof obj.method === "string" ? obj.method : undefined,
        params: obj.params && typeof obj.params === "object" ? (obj.params as Record<string, unknown>) : {},
        id: obj.id,
      });
      if (canned.destroy) {
        req.socket.destroy();
        return;
      }
      const payload = canned.raw ?? (canned.body === undefined ? "" : JSON.stringify(canned.body));
      res.writeHead(canned.status, { "Content-Type": canned.contentType ?? "application/json" });
      res.end(payload);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    set(next) {
      decide = next;
    },
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/**
 * Canned stdio server, written to a temp file because the stdio
 * transport spawns through a shell on Windows (an inline `-e` script
 * would be mangled). BAD_MODE=results answers every request with a
 * result (unknown methods included, list pages without their array);
 * BAD_MODE=isError declares only tools, answers tools/call with
 * isError: true, and unknown methods with -32000. BAD_MODE=reject
 * answers every request, server/discover included, with -32601 (a
 * 2025-era server that knows no modern method). BAD_MODE=silent declares
 * only tools and never answers resources/list or prompts/list (a server
 * that drops requests for methods it has no handler for).
 */
const BAD_STDIO_SCRIPT = `
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("close", () => process.exit(0));
const mode = process.env.BAD_MODE || "results";
const caps = mode === "isError" || mode === "silent" ? { tools: {} } : { tools: {}, resources: {}, prompts: {} };
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result: { resultType: "complete", ...result } });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined || msg.id === null) return;
  if (mode === "reject") {
    return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found: " + msg.method } });
  }
  switch (msg.method) {
    case "server/discover":
      return reply(msg.id, { supportedVersions: ["2026-07-28"], capabilities: caps, ttlMs: 0, cacheScope: "public" });
    case "tools/list":
    case "resources/list":
    case "prompts/list":
      if (mode === "silent" && msg.method !== "tools/list") return;
      return reply(msg.id, {});
    case "tools/call":
      return reply(msg.id, mode === "isError"
        ? { content: [{ type: "text", text: "boom" }], isError: true }
        : { content: [{ type: "text", text: "ok" }] });
    default:
      if (mode === "isError") return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "nope" } });
      return reply(msg.id, {});
  }
});
`;

let badStdioDir: string | undefined;

function badStdio(mode: "results" | "isError" | "reject" | "silent"): TransportTarget {
  if (!badStdioDir) {
    badStdioDir = mkdtempSync(join(tmpdir(), "mcp-compliance-bad-stdio-"));
    writeFileSync(join(badStdioDir, "bad-stdio.cjs"), BAD_STDIO_SCRIPT, "utf8");
  }
  return {
    type: "stdio",
    command: process.execPath,
    args: [join(badStdioDir, "bad-stdio.cjs")],
    env: { BAD_MODE: mode },
  };
}

function removeBadStdio() {
  if (!badStdioDir) return;
  try {
    rmSync(badStdioDir, { recursive: true, force: true });
  } catch {
    // Best effort: the child may still be exiting on Windows.
  }
  badStdioDir = undefined;
}

// ---------------------------------------------------------------------------
// Clean fixture: everything passes on both transports
// ---------------------------------------------------------------------------

describe("errors suite: clean fixture over stdio", () => {
  let report: ComplianceReport;

  beforeAll(async () => {
    report = await runModern(stdioFixture().target, { only: ALL });
  });

  it("passes every transport-neutral id", () => {
    const expected = Object.fromEntries(BOTH.map((id) => [id, "pass"]));
    expect(passedIds(report, BOTH)).toEqual(expected);
  });

  it("does not run the raw-body probes on stdio", () => {
    for (const id of HTTP_ONLY) expect(report.tests.find((t) => t.id === id)).toBeUndefined();
  });

  it("names the observed codes without HTTP statuses", () => {
    expect(resultOf(report, "error-unknown-method").details).toBe("JSON-RPC error -32601, id echoed");
    expect(resultOf(report, "error-method-code").details).toBe("-32601 (Method not found)");
    expect(resultOf(report, "error-missing-params").details).toContain("-32602 (correct: Invalid params)");
    expect(resultOf(report, "tools-call-unknown").details).toContain("-32602 (correct: Invalid params)");
    expect(resultOf(report, "error-capability-gated").details).toContain("declares all capabilities");
    // Nothing undeclared to probe: a skip, where the checks that probed are verdicts.
    expect(resultOf(report, "error-capability-gated").skipped).toBe(true);
    expect(report.tests.filter((t) => t.skipped).map((t) => t.id)).toEqual(["error-capability-gated"]);
    expect(resultOf(report, "error-invalid-cursor").details).toContain("tools/list rejected the cursor: -32602");
    expect(warned(report, NOT_FOUND_WARNING)).toBe(false);
  });
});

describe("errors suite: clean fixture over HTTP", () => {
  let fixture: HttpFixture;
  let report: ComplianceReport;

  beforeAll(async () => {
    fixture = await startHttpFixture();
    report = await runModern(fixture.url, { only: ALL });
  });
  afterAll(async () => {
    await fixture.stop();
  });

  it("passes every id", () => {
    const expected = Object.fromEntries(ALL.map((id) => [id, "pass"]));
    expect(passedIds(report, ALL)).toEqual(expected);
  });

  it("records the 404 and the exact codes", () => {
    expect(resultOf(report, "error-unknown-method").details).toBe("JSON-RPC error -32601 on HTTP 404, id echoed");
    expect(resultOf(report, "error-invalid-jsonrpc").details).toBe(
      "JSON-RPC error -32600 (correct: Invalid Request) on HTTP 400",
    );
    expect(resultOf(report, "error-invalid-json").details).toBe(
      "JSON-RPC error -32700 (correct: Parse error) on HTTP 400",
    );
    expect(resultOf(report, "error-parse-code").details).toBe("-32700 (Parse error) on HTTP 400");
    expect(resultOf(report, "error-invalid-request-code").details).toBe("-32600 (Invalid Request) on HTTP 400");
    expect(warned(report, NOT_FOUND_WARNING)).toBe(false);
    expect(warned(report, BARE_4XX_WARNING)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fixture knobs
// ---------------------------------------------------------------------------

describe("errors suite: knob unknown-method-200", () => {
  let fixture: HttpFixture;
  afterAll(async () => {
    await fixture?.stop();
  });

  it("passes error-unknown-method with a warning on the status over HTTP", async () => {
    fixture = await startHttpFixture({ breaks: ["unknown-method-200"] });
    const report = await runModern(fixture.url, { only: ["error-unknown-method", "error-method-code"] });
    expectPass(report, "error-unknown-method", "on HTTP 200 (spec requires 404)");
    expectPass(report, "error-method-code");
    expect(warned(report, NOT_FOUND_WARNING)).toBe(true);
  });

  it("is invisible on stdio, where the status is synthetic", async () => {
    const report = await runModern(stdioFixture({ breaks: ["unknown-method-200"] }).target, {
      only: ["error-unknown-method"],
    });
    expectPass(report, "error-unknown-method", "JSON-RPC error -32601, id echoed");
    expect(warned(report, NOT_FOUND_WARNING)).toBe(false);
  });
});

describe("errors suite: knobs no-id-echo and wrong-id-type", () => {
  let fixture: HttpFixture;
  afterAll(async () => {
    await fixture?.stop();
  });

  it("fails error-unknown-method over HTTP when the error carries id null", async () => {
    fixture = await startHttpFixture({ breaks: ["no-id-echo"] });
    const report = await runModern(fixture.url, { only: ["error-unknown-method", "error-method-code"] });
    expectFail(report, "error-unknown-method", "did not echo the request id");
    expect(resultOf(report, "error-unknown-method").details).toContain("got null");
    // The code check is independent of the id echo.
    expectPass(report, "error-method-code");
    await fixture.stop();
  });

  it("fails error-unknown-method over HTTP when a numeric id comes back as a string", async () => {
    fixture = await startHttpFixture({ breaks: ["wrong-id-type"] });
    const report = await runModern(fixture.url, { only: ["error-unknown-method"] });
    expectFail(report, "error-unknown-method", "did not echo the request id");
    expect(resultOf(report, "error-unknown-method").details).toMatch(/sent \d+, got "\d+"/);
  });

  it("fails both unknown-method tests over stdio, where an unmatched id never resolves", async () => {
    const report = await runModern(stdioFixture({ breaks: ["no-id-echo"] }).target, {
      only: ["error-unknown-method", "error-method-code"],
      timeout: 1000,
    });
    expectFail(report, "error-unknown-method", "No response to compliance/nonexistent-method-");
    expectFail(report, "error-method-code", "No response to compliance/nonexistent-method-");
  });
});

describe("errors suite: knob capabilities-mismatch", () => {
  let fixture: HttpFixture;
  afterAll(async () => {
    await fixture?.stop();
  });

  it("fails error-capability-gated over HTTP", async () => {
    fixture = await startHttpFixture({ breaks: ["capabilities-mismatch"] });
    const report = await runModern(fixture.url, { only: ["error-capability-gated", "error-invalid-cursor"] });
    expectFail(
      report,
      "error-capability-gated",
      "prompts/list returned a result despite the undeclared prompts capability",
    );
    // tools is still declared, so the cursor probe is unaffected.
    expectPass(report, "error-invalid-cursor", "tools/list rejected the cursor");
  });

  it("fails error-capability-gated over stdio", async () => {
    const report = await runModern(stdioFixture({ breaks: ["capabilities-mismatch"] }).target, {
      only: ["error-capability-gated"],
    });
    expectFail(
      report,
      "error-capability-gated",
      "prompts/list returned a result despite the undeclared prompts capability",
    );
  });
});

// ---------------------------------------------------------------------------
// Canned bad servers (no knob exists for these shapes)
// ---------------------------------------------------------------------------

describe("errors suite: canned bad HTTP server", () => {
  let bad: Awaited<ReturnType<typeof startBadHttp>>;
  beforeAll(async () => {
    bad = await startBadHttp();
  });
  afterAll(async () => {
    await bad.stop();
  });

  it("fails every id when the server answers everything with a result", async () => {
    bad.set(({ parseError, method, id }) => {
      if (parseError) return { status: 200, body: rpcResult(null, {}) };
      if (method === "server/discover")
        return { status: 200, body: rpcResult(id, discoverResult({ tools: {}, resources: {}, prompts: {} })) };
      if (method === "tools/call")
        return { status: 200, body: rpcResult(id, { content: [{ type: "text", text: "ok" }] }) };
      return { status: 200, body: rpcResult(id ?? null, {}) };
    });
    const report = await runModern(bad.url, { only: ALL });
    expectFail(report, "error-unknown-method", "Unknown method returned a result (HTTP 200)");
    expectFail(report, "error-method-code", "No JSON-RPC error returned for unknown method (HTTP 200)");
    expectFail(report, "error-missing-params", "tools/call without name produced a result (HTTP 200)");
    expectFail(report, "tools-call-unknown", "Unknown tool produced a successful result (HTTP 200)");
    expectFail(report, "error-invalid-cursor", "ignored the cursor but the result has no tools array");
    expectPass(report, "error-capability-gated", "declares all capabilities");
    expectFail(report, "error-invalid-jsonrpc", "Malformed envelope produced a result on HTTP 200");
    expectFail(report, "error-invalid-json", "Invalid JSON produced a result on HTTP 200");
    expectFail(report, "error-parse-code", "Result instead of -32700 (Parse error) for invalid JSON on HTTP 200");
    expectFail(report, "error-invalid-request-code", "Result instead of -32600 (Invalid Request)");
  });

  it("fails on wrong codes, 5xx, isError results and undeclared capabilities", async () => {
    bad.set(({ parseError, method, params, id }) => {
      if (parseError) return { status: 500, body: rpcError(null, -32600, "bad") };
      if (method === undefined) return { status: 400, body: rpcError(id ?? null, -32601, "Method not found") };
      if (method === "server/discover") return { status: 200, body: rpcResult(id, discoverResult({ tools: {} })) };
      if (method === "tools/call") {
        return { status: 200, body: rpcResult(id, { content: [{ type: "text", text: "boom" }], isError: true }) };
      }
      if (method === "tools/list" && typeof params.cursor === "string") {
        return { status: 503, body: rpcError(id, -32603, "cursor decode crashed") };
      }
      if (method === "resources/list" || method === "prompts/list") return { status: 200, body: rpcResult(id, {}) };
      return { status: 200, body: rpcError(id, -32000, "unknown") };
    });
    const report = await runModern(bad.url, { only: ALL });
    expectPass(report, "error-unknown-method", "JSON-RPC error -32000 on HTTP 200 (spec requires 404)");
    expect(warned(report, NOT_FOUND_WARNING)).toBe(true);
    expectFail(report, "error-method-code", "Expected -32601 (Method not found), got -32000");
    expectFail(report, "error-missing-params", "produced a result with isError: true");
    expectPass(report, "tools-call-unknown", "isError: true (valid)");
    expectFail(report, "error-invalid-cursor", "tools/list with an invalid cursor answered HTTP 503");
    expectFail(
      report,
      "error-capability-gated",
      "resources/list returned a result despite the undeclared resources capability",
    );
    expect(resultOf(report, "error-capability-gated").details).toContain("prompts/list returned a result");
    expectPass(report, "error-invalid-jsonrpc", "JSON-RPC error -32601 on HTTP 400");
    expectFail(report, "error-invalid-json", "HTTP 500 for invalid JSON");
    expectFail(report, "error-parse-code", "Expected -32700 (Parse error) for invalid JSON, got -32600");
    expectFail(
      report,
      "error-invalid-request-code",
      "Expected -32600 (Invalid Request) for a message with no method, got -32601",
    );
  });

  it("passes the bare-4xx paths with a warning and fails a bare 404 for an unknown method", async () => {
    bad.set(({ parseError, method, id }) => {
      if (parseError || method === undefined) return { status: 400, raw: "", contentType: "text/plain" };
      if (method === "server/discover") return { status: 200, body: rpcResult(id, discoverResult({ tools: {} })) };
      if (method === "tools/call") return { status: 200, body: rpcError(id, -32602, "Unknown tool") };
      if (method === "tools/list") return { status: 200, body: rpcError(id, -32602, "Invalid cursor") };
      return { status: 404, raw: "", contentType: "text/plain" };
    });
    const report = await runModern(bad.url, { only: ALL });
    expectFail(report, "error-unknown-method", "No JSON-RPC error body for unknown method (HTTP 404)");
    expectFail(report, "error-method-code", "No JSON-RPC error returned for unknown method (HTTP 404)");
    expectPass(report, "error-invalid-jsonrpc", "HTTP 400 without a JSON-RPC body (acceptable)");
    expectPass(report, "error-invalid-json", "HTTP 400 without a JSON-RPC body (acceptable)");
    expectPass(
      report,
      "error-parse-code",
      "HTTP 400 without a JSON-RPC body (expected -32700 Parse error); passes with a warning",
    );
    expectPass(
      report,
      "error-invalid-request-code",
      "HTTP 400 without a JSON-RPC body (expected -32600 Invalid Request); passes with a warning",
    );
    expect(report.warnings.filter((w) => w.includes(BARE_4XX_WARNING))).toEqual([
      "HTTP 400 with no JSON-RPC body for invalid JSON; the spec expects a -32700 (Parse error) JSON-RPC error body.",
      "HTTP 400 with no JSON-RPC body for a message with no method; the spec expects a -32600 (Invalid Request) JSON-RPC error body.",
    ]);
    // Only tools is declared and the undeclared list methods answer a bare 404: a rejection, not a result.
    expectPass(report, "error-capability-gated", "resources/list -> rejected (HTTP 404)");
    // The undeclared methods were probed: a verdict, not a skip.
    expect(resultOf(report, "error-capability-gated").skipped).toBeUndefined();
  });

  it("fails the raw-body probes on an HTML 200 page and an error that drops the id", async () => {
    bad.set(({ parseError, method, id }) => {
      if (parseError || method === undefined)
        return { status: 200, raw: "<html><body>Bad Request</body></html>", contentType: "text/html" };
      if (method === "server/discover") return { status: 200, body: rpcResult(id, discoverResult({})) };
      return { status: 404, body: rpcError(null, -32601, "Method not found") };
    });
    const report = await runModern(bad.url, { only: ALL });
    expectFail(report, "error-unknown-method", "did not echo the request id");
    expectPass(report, "error-method-code");
    expectFail(report, "error-invalid-jsonrpc", "HTTP 200 with no JSON-RPC error; expected a JSON-RPC error or 4xx");
    expectFail(report, "error-invalid-json", "HTTP 200 with no JSON-RPC error; expected -32700 or a 4xx");
    expectFail(
      report,
      "error-parse-code",
      "HTTP 200 with no JSON-RPC error; expected -32700 (Parse error) for invalid JSON",
    );
    expectFail(
      report,
      "error-invalid-request-code",
      "HTTP 200 with no JSON-RPC error; expected -32600 (Invalid Request)",
    );
    // No capability declared: the tools-gated ids are absent and the cursor probe has nothing to call.
    expect(report.tests.find((t) => t.id === "error-missing-params")).toBeUndefined();
    expect(report.tests.find((t) => t.id === "tools-call-unknown")).toBeUndefined();
    expectPass(report, "error-invalid-cursor", "No list methods available to test (skipped)");
  });

  it("passes the error codes it tolerates and reads an array body by its first element", async () => {
    // Policy, per the catalog: capability gating, missing params, unknown
    // tools and bad cursors each expect "a JSON-RPC error", the exact code
    // only noted; error-invalid-json takes any error or a 4xx (the exact
    // -32700 is error-parse-code's job).
    bad.set(({ parseError, parsed, method, params, id }) => {
      if (parseError) return { status: 400, body: rpcError(null, -32600, "Invalid Request") };
      if (method === undefined) {
        // The malformed envelope crashes the handler; the method-less
        // request is answered as a one-element JSON-RPC batch reply.
        if ((parsed as { not?: unknown }).not !== undefined) return { status: 500, raw: "", contentType: "text/plain" };
        return { status: 400, body: [rpcError(99999, -32600, "Invalid Request")] };
      }
      if (method === "server/discover") return { status: 200, body: rpcResult(id, discoverResult({ tools: {} })) };
      if (method === "tools/call") return { status: 200, body: rpcError(id, -32603, "handler crashed") };
      if (method === "tools/list" && typeof params.cursor === "string") {
        return { status: 200, body: rpcError(id, -32603, "cursor decode crashed") };
      }
      if (method === "resources/list" || method === "prompts/list") {
        return { status: 200, body: rpcError(id, -32603, "Internal error") };
      }
      return { status: 404, body: rpcError(id, -32601, "Method not found") };
    });
    const report = await runModern(bad.url, { only: ALL });
    expect(Object.fromEntries(report.tests.map((t) => [t.id, { passed: t.passed, details: t.details }]))).toEqual({
      "error-unknown-method": { passed: true, details: "JSON-RPC error -32601 on HTTP 404, id echoed" },
      "error-method-code": { passed: true, details: "-32601 (Method not found)" },
      "error-invalid-jsonrpc": {
        passed: false,
        details: "HTTP 500 for a malformed envelope; expected a JSON-RPC error or 4xx",
      },
      "error-invalid-json": { passed: true, details: "JSON-RPC error -32600 on HTTP 400" },
      "error-parse-code": {
        passed: false,
        details: "Expected -32700 (Parse error) for invalid JSON, got -32600 (Invalid Request)",
      },
      "error-invalid-request-code": { passed: true, details: "-32600 (Invalid Request) on HTTP 400" },
      "error-missing-params": { passed: true, details: "JSON-RPC error -32603 (handler crashed)" },
      "tools-call-unknown": { passed: true, details: "JSON-RPC error -32603 (handler crashed)" },
      "error-capability-gated": {
        passed: true,
        details:
          "Undeclared method(s) rejected: resources/list -> -32603 (expected -32601), prompts/list -> -32603 (expected -32601)",
      },
      "error-invalid-cursor": {
        passed: true,
        details: "tools/list rejected the cursor: -32603 (cursor decode crashed)",
      },
    });
    expect(warned(report, BARE_4XX_WARNING)).toBe(false);
  });

  it("names an error code that is not an integer as the server sent it, and a missing one as 'no code' -- never NaN", async () => {
    // JSON-RPC requires an integer code. The verdicts are the ones any
    // error earns (a wrong code still fails the exact-code ids); only the
    // rendering is under test: before, every one of these read "NaN".
    const coded = (id: unknown, code: unknown, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
    const uncoded = (id: unknown, message: string) => ({ jsonrpc: "2.0", id, error: { message } });
    bad.set(({ parseError, method, params, id }) => {
      if (parseError) return { status: 400, body: coded(null, "PARSE", "bad json") };
      if (method === undefined) return { status: 400, body: uncoded(id ?? null, "Invalid Request") };
      if (method === "server/discover") return { status: 200, body: rpcResult(id, discoverResult({ tools: {} })) };
      if (method === "tools/call") return { status: 200, body: coded(id, null, "bad call") };
      if (method === "tools/list" && typeof params.cursor === "string") {
        return { status: 200, body: uncoded(id, "Invalid cursor") };
      }
      if (method === "resources/list" || method === "prompts/list") {
        return { status: 200, body: coded(id, -32601.5, "not here") };
      }
      return { status: 404, body: coded(id, "E_NOPE", "Method not found") };
    });
    const report = await runModern(bad.url, { only: ALL });
    expect(Object.fromEntries(report.tests.map((t) => [t.id, { passed: t.passed, details: t.details }]))).toEqual({
      "error-unknown-method": {
        passed: true,
        details: 'JSON-RPC error with non-integer code "E_NOPE" on HTTP 404, id echoed',
      },
      "error-method-code": {
        passed: false,
        details: 'Expected -32601 (Method not found), got non-integer code "E_NOPE" (Method not found)',
      },
      "error-invalid-jsonrpc": { passed: true, details: "JSON-RPC error with no code on HTTP 400" },
      "error-invalid-json": { passed: true, details: 'JSON-RPC error with non-integer code "PARSE" on HTTP 400' },
      "error-parse-code": {
        passed: false,
        details: 'Expected -32700 (Parse error) for invalid JSON, got non-integer code "PARSE" (bad json)',
      },
      "error-invalid-request-code": {
        passed: false,
        details: "Expected -32600 (Invalid Request) for a message with no method, got no code (Invalid Request)",
      },
      "error-missing-params": { passed: true, details: "JSON-RPC error with non-integer code null (bad call)" },
      "tools-call-unknown": { passed: true, details: "JSON-RPC error with non-integer code null (bad call)" },
      "error-capability-gated": {
        passed: true,
        details:
          "Undeclared method(s) rejected: resources/list -> non-integer code -32601.5 (expected -32601), prompts/list -> non-integer code -32601.5 (expected -32601)",
      },
      "error-invalid-cursor": { passed: true, details: "tools/list rejected the cursor: no code (Invalid cursor)" },
    });
    expect(JSON.stringify(report.tests)).not.toContain("NaN");
  });

  it("names a non-integer code the same way when every probe is rejected as not evaluable", async () => {
    bad.set(({ id }) => ({ status: 400, body: { jsonrpc: "2.0", id: id ?? null, error: { code: "E_INIT" } } }));
    const report = await runModern(bad.url, { only: ["lifecycle-discover", ...ALL] });
    expect(resultOf(report, "lifecycle-discover").passed).toBe(false);
    const rpc = 'JSON-RPC error with non-integer code "E_INIT" (HTTP 400) for an unknown method; not evaluable';
    const raw = (what: string) =>
      `JSON-RPC error with non-integer code "E_INIT" on HTTP 400 for ${what}; not evaluable`;
    expectFail(report, "error-unknown-method", rpc);
    expectFail(report, "error-method-code", rpc);
    expectFail(report, "error-invalid-jsonrpc", raw("a malformed envelope"));
    expectFail(report, "error-invalid-json", raw("invalid JSON"));
    expectFail(report, "error-parse-code", raw("invalid JSON"));
    expectFail(report, "error-invalid-request-code", raw("a message with no method"));
    expectFail(report, "error-capability-gated", 'tools/list -> non-integer code "E_INIT", resources/list');
  });

  it("fails a probe answered with neither an error nor a result, and reads an SSE body with no response as no body", async () => {
    bad.set(({ parseError, method, params, id }) => {
      if (parseError) {
        // A request-scoped stream carrying only a log notification.
        const note = JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/message",
          params: { level: "error", data: "unparseable body" },
        });
        return { status: 400, raw: `event: message\ndata: ${note}\n\n`, contentType: "text/event-stream" };
      }
      if (method === "server/discover") return { status: 200, body: rpcResult(id, discoverResult({ tools: {} })) };
      if (method === "tools/call" || (method === "tools/list" && typeof params.cursor === "string")) {
        return { status: 200, body: { jsonrpc: "2.0", id } };
      }
      return { status: 404, body: rpcError(id ?? null, -32601, "Method not found") };
    });
    const only = [
      "error-invalid-json",
      "error-parse-code",
      "error-missing-params",
      "tools-call-unknown",
      "error-invalid-cursor",
    ];
    const report = await runModern(bad.url, { only });
    expect(Object.fromEntries(report.tests.map((t) => [t.id, { passed: t.passed, details: t.details }]))).toEqual({
      "error-invalid-json": { passed: true, details: "HTTP 400 without a JSON-RPC body (acceptable)" },
      "error-parse-code": {
        passed: true,
        details: "HTTP 400 without a JSON-RPC body (expected -32700 Parse error); passes with a warning",
      },
      "error-missing-params": { passed: false, details: "No JSON-RPC error for tools/call without name (HTTP 200)" },
      "tools-call-unknown": { passed: false, details: "No JSON-RPC error for unknown tool (HTTP 200)" },
      "error-invalid-cursor": {
        passed: false,
        details: "No JSON-RPC error or result for an invalid cursor (HTTP 200)",
      },
    });
    expect(report.warnings.filter((w) => w.includes(BARE_4XX_WARNING))).toEqual([
      "HTTP 400 with no JSON-RPC body for invalid JSON; the spec expects a -32700 (Parse error) JSON-RPC error body.",
    ]);
  });

  it("turns a dropped connection into a failure naming the probe, and keeps probing the other methods", async () => {
    // The server kills the socket for every probe; only server/discover and
    // unknown methods are answered.
    const methods: string[] = [];
    bad.set(({ parseError, method, id }) => {
      methods.push(parseError ? "<invalid json>" : (method ?? "<no method>"));
      if (method === "server/discover") return { status: 200, body: rpcResult(id, discoverResult({ tools: {} })) };
      if (method?.startsWith("compliance/")) return { status: 404, body: rpcError(id, -32601, "Method not found") };
      return { status: 0, destroy: true };
    });
    const report = await runModern(bad.url, { only: ALL });
    const results = Object.fromEntries(report.tests.map((t) => [t.id, t]));
    for (const id of [
      "error-invalid-jsonrpc",
      "error-invalid-json",
      "error-parse-code",
      "error-invalid-request-code",
    ]) {
      expect(results[id], id).toMatchObject({
        passed: false,
        details: expect.stringMatching(/^No response to the raw body probe: \S/),
      });
    }
    for (const id of ["error-missing-params", "tools-call-unknown"]) {
      expect(results[id], id).toMatchObject({
        passed: false,
        details: expect.stringMatching(/^No response to tools\/call: \S/),
      });
    }
    expect(results["error-invalid-cursor"]).toMatchObject({
      passed: false,
      details: expect.stringMatching(/^No response to tools\/list: \S/),
    });
    // One dropped list method does not end the loop: both are named.
    expect(results["error-capability-gated"]).toMatchObject({
      passed: false,
      details: expect.stringMatching(
        /^resources\/list: No response to resources\/list: \S.*; prompts\/list: No response to prompts\/list: \S/,
      ),
    });
    expect(methods.filter((m) => m === "resources/list" || m === "prompts/list")).toEqual([
      "resources/list",
      "prompts/list",
    ]);
    // The known methods still pass.
    expect(results["error-unknown-method"]?.passed).toBe(true);
    for (const t of report.tests) expect(t.details, t.id).not.toMatch(/^Error: /);
  });

  it("reads a JSON-RPC error carried on an SSE body, after a notification frame", async () => {
    bad.set(({ parseError, method, id }) => {
      if (parseError) {
        // The stream MAY carry notifications before the response: the first
        // JSON-RPC RESPONSE frame is the answer, not the first data frame.
        const note = JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info" } });
        const frame = JSON.stringify(rpcError(null, -32700, "Parse error"));
        return {
          status: 400,
          raw: `event: message\ndata: ${note}\n\nevent: message\ndata: ${frame}\n\n`,
          contentType: "text/event-stream",
        };
      }
      if (method === "server/discover") return { status: 200, body: rpcResult(id, discoverResult({})) };
      return { status: 404, body: rpcError(id ?? null, -32601, "Method not found") };
    });
    const report = await runModern(bad.url, { only: ["error-invalid-json", "error-parse-code"] });
    expectPass(report, "error-invalid-json", "JSON-RPC error -32700 (correct: Parse error) on HTTP 400");
    expectPass(report, "error-parse-code", "-32700 (Parse error) on HTTP 400");
    expect(warned(report, BARE_4XX_WARNING)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A server that rejects everything: no rejection is credited
// ---------------------------------------------------------------------------

/** notEvaluable's reason (lifecycle.ts) for a setup discover rejected as `rejection`. */
function notEvaluableReason(rejection: string, about = "the injected defect"): string {
  return `not evaluable: the conformant server/discover was itself rejected with ${rejection}, so this rejection proves nothing about ${about}`;
}

const GATED_ABOUT = "whether undeclared methods are rejected";

const REJECT_EVERYTHING: Array<{
  name: string;
  canned: (id: unknown) => Canned;
  /** How each probe's answer is named in the details. */
  answer: string;
  status: number;
  /** How the setup discover's rejection is named in the reason. */
  rejection: string;
  /** How each undeclared list method's answer is named by error-capability-gated. */
  listAnswer: string;
}> = [
  {
    name: "400 / -32000 'Server not initialized' with the id echoed (a 2025-era SDK v1 server)",
    canned: (id) => ({ status: 400, body: rpcError(id ?? null, -32000, "Bad Request: Server not initialized") }),
    answer: "JSON-RPC error -32000",
    status: 400,
    rejection: "-32000 (HTTP 400)",
    listAnswer: "-32000",
  },
  {
    name: "404 / -32601 for every method, server/discover included",
    canned: (id) => ({ status: 404, body: rpcError(id ?? null, -32601, "Method not found") }),
    answer: "JSON-RPC error -32601",
    status: 404,
    rejection: "-32601 (HTTP 404)",
    listAnswer: "-32601",
  },
  {
    name: "a bare 400 with no JSON-RPC body (a gateway in front of it)",
    canned: () => ({ status: 400, raw: "Bad Request", contentType: "text/plain" }),
    answer: "no JSON-RPC error body",
    status: 400,
    rejection: "no JSON-RPC error code (HTTP 400)",
    listAnswer: "no JSON-RPC body (HTTP 400)",
  },
  {
    name: "a bare 503 with no JSON-RPC body (the server is down behind its proxy)",
    canned: () => ({ status: 503, raw: "Service Unavailable", contentType: "text/plain" }),
    answer: "no JSON-RPC error body",
    status: 503,
    rejection: "no JSON-RPC error code (HTTP 503)",
    listAnswer: "no JSON-RPC body (HTTP 503)",
  },
];

describe("errors suite: a server that rejects everything, server/discover included", () => {
  let bad: Awaited<ReturnType<typeof startBadHttp>>;
  beforeAll(async () => {
    bad = await startBadHttp();
  });
  afterAll(async () => {
    await bad.stop();
  });

  it.each(REJECT_EVERYTHING)("fails every rejection as not evaluable over HTTP: $name", async (shape) => {
    // Before the attribution guard the first shape PASSED error-unknown-method
    // (required), error-invalid-jsonrpc, error-invalid-json and
    // error-capability-gated; the second also PASSED error-method-code
    // (required); the third passed the four raw-body probes and
    // error-capability-gated -- each on the server's answer to everything.
    // The 503 shape passed error-capability-gated ("rejected (HTTP 503)") and
    // failed the rest, blaming each probe ("HTTP 503 for invalid JSON") for
    // what the server does to every request.
    bad.set(({ id }) => shape.canned(id));
    const report = await runModern(bad.url, { only: ["lifecycle-discover", ...ALL] });
    expect(resultOf(report, "lifecycle-discover").passed).toBe(false);
    const reason = notEvaluableReason(shape.rejection);
    const rpc = (what: string) => `${shape.answer} (HTTP ${shape.status}) for ${what}; ${reason}`;
    const raw = (what: string) => `${shape.answer} on HTTP ${shape.status} for ${what}; ${reason}`;
    const lists = ["tools/list", "resources/list", "prompts/list"].map((m) => `${m} -> ${shape.listAnswer}`);
    expect(Object.fromEntries(report.tests.map((t) => [t.id, { passed: t.passed, details: t.details }]))).toEqual({
      "lifecycle-discover": expect.objectContaining({ passed: false }),
      "error-unknown-method": { passed: false, details: rpc("an unknown method") },
      "error-method-code": { passed: false, details: rpc("an unknown method") },
      "error-invalid-jsonrpc": { passed: false, details: raw("a malformed envelope") },
      "error-invalid-json": { passed: false, details: raw("invalid JSON") },
      "error-parse-code": { passed: false, details: raw("invalid JSON") },
      "error-invalid-request-code": { passed: false, details: raw("a message with no method") },
      // Nothing is declared without a served discover, so all three list
      // methods are probed; their answers are recorded, not judged.
      "error-capability-gated": {
        passed: false,
        details: `${lists.join(", ")}; ${notEvaluableReason(shape.rejection, GATED_ABOUT)}`,
      },
      // No capability is declared without a served discover: nothing to probe, nothing credited.
      "error-invalid-cursor": { passed: true, details: "No list methods available to test (skipped)" },
    });
    expect(resultOf(report, "error-unknown-method").required).toBe(true);
    expect(resultOf(report, "error-method-code").required).toBe(true);
    // Nothing was credited, so none of the "passes with a warning" notes either.
    expect(warned(report, NOT_FOUND_WARNING)).toBe(false);
    expect(warned(report, BARE_4XX_WARNING)).toBe(false);
  });

  it("still judges a result on its own: a served probe fails for the result, not as not evaluable", async () => {
    // server/discover is rejected, but the malformed probes are SERVED (on
    // an error status, even): that is a defect whatever the discover state,
    // as in expectRejection and evaluateHeaderRejection.
    bad.set(({ method, id }) => {
      if (method === "server/discover") return { status: 400, body: rpcError(id, -32000, "Server not initialized") };
      if (method === undefined) return { status: 400, body: rpcResult(null, {}) };
      return { status: 400, body: rpcResult(id, {}) };
    });
    const report = await runModern(bad.url, { only: ALL });
    expectFail(report, "error-unknown-method", "Unknown method returned a result (HTTP 400)");
    expectFail(report, "error-method-code", "No JSON-RPC error returned for unknown method (HTTP 400)");
    expectFail(report, "error-invalid-jsonrpc", "Malformed envelope produced a result on HTTP 400");
    expectFail(report, "error-invalid-json", "Invalid JSON produced a result on HTTP 400");
    expectFail(report, "error-parse-code", "Result instead of -32700 (Parse error) for invalid JSON on HTTP 400");
    expectFail(report, "error-invalid-request-code", "Result instead of -32600 (Invalid Request)");
    // The list methods were served too, but "undeclared" is unknowable
    // without a discover result: recorded, not blamed.
    expect(resultOf(report, "error-capability-gated")).toMatchObject({
      passed: false,
      details: `tools/list -> result, resources/list -> result, prompts/list -> result; ${notEvaluableReason("-32000 (HTTP 400)", GATED_ABOUT)}`,
    });
    for (const t of report.tests) {
      if (t.id !== "error-capability-gated") expect(t.details, t.id).not.toContain("not evaluable");
    }
  });

  it("still judges a 200 with no JSON-RPC body on its own: an HTML page is not a rejection to attribute", async () => {
    // The URL serves a web page to every POST, server/discover included:
    // nothing was rejected, so the probes fail for what they got (as
    // before the guard), not as "not evaluable" -- except capability
    // gating, which has no declaration to judge against.
    bad.set(() => ({ status: 200, raw: "<html><body>Hello</body></html>", contentType: "text/html" }));
    const report = await runModern(bad.url, { only: ["lifecycle-discover", ...ALL] });
    expect(resultOf(report, "lifecycle-discover").passed).toBe(false);
    expectFail(report, "error-unknown-method", "No JSON-RPC error body for unknown method (HTTP 200)");
    expectFail(report, "error-method-code", "No JSON-RPC error returned for unknown method (HTTP 200)");
    expectFail(report, "error-invalid-jsonrpc", "HTTP 200 with no JSON-RPC error; expected a JSON-RPC error or 4xx");
    expectFail(report, "error-invalid-json", "HTTP 200 with no JSON-RPC error; expected -32700 or a 4xx");
    expectFail(report, "error-parse-code", "HTTP 200 with no JSON-RPC error; expected -32700 (Parse error)");
    expectFail(
      report,
      "error-invalid-request-code",
      "HTTP 200 with no JSON-RPC error; expected -32600 (Invalid Request)",
    );
    expect(resultOf(report, "error-capability-gated")).toMatchObject({
      passed: false,
      details: `tools/list -> no JSON-RPC body (HTTP 200), resources/list -> no JSON-RPC body (HTTP 200), prompts/list -> no JSON-RPC body (HTTP 200); ${notEvaluableReason("no JSON-RPC error code (HTTP 200)", GATED_ABOUT)}`,
    });
    for (const t of report.tests) {
      if (t.id !== "error-capability-gated") expect(t.details, t.id).not.toContain("not evaluable");
    }
  });
});

describe("errors suite: canned bad stdio server", () => {
  afterAll(() => {
    removeBadStdio();
  });

  it("fails every rejection as not evaluable when server/discover is rejected too", async () => {
    // Before the attribution guard error-unknown-method and error-method-code
    // (both required) and error-capability-gated PASSED on the blanket -32601.
    const report = await runModern(badStdio("reject"), { only: ["lifecycle-discover", ...BOTH] });
    const reason = notEvaluableReason("-32601");
    expect(Object.fromEntries(report.tests.map((t) => [t.id, { passed: t.passed, details: t.details }]))).toEqual({
      "lifecycle-discover": expect.objectContaining({ passed: false }),
      "error-unknown-method": { passed: false, details: `JSON-RPC error -32601 for an unknown method; ${reason}` },
      "error-method-code": { passed: false, details: `JSON-RPC error -32601 for an unknown method; ${reason}` },
      "error-capability-gated": {
        passed: false,
        details: `tools/list -> -32601, resources/list -> -32601, prompts/list -> -32601; ${notEvaluableReason("-32601", GATED_ABOUT)}`,
      },
      "error-invalid-cursor": { passed: true, details: "No list methods available to test (skipped)" },
    });
  });

  it("fails error-capability-gated naming each undeclared list method that never answered", async () => {
    // A stdio server that silently drops requests it has no handler for:
    // each list method times out, is recorded, and the loop goes on.
    const report = await runModern(badStdio("silent"), { only: ["error-capability-gated"], timeout: 1000 });
    const timedOut = (method: string) =>
      `${method}: No response to ${method}: stdio transport: request timed out after 1000ms (method=${method})`;
    const details = `${timedOut("resources/list")}; ${timedOut("prompts/list")}`;
    expect(resultOf(report, "error-capability-gated")).toMatchObject({
      passed: false,
      // Clipped to 200 characters.
      details: details.length > 200 ? `${details.slice(0, 197)}...` : details,
    });
  });

  it("fails every transport-neutral id when the server answers everything with a result", async () => {
    const report = await runModern(badStdio("results"), { only: BOTH });
    expectFail(report, "error-unknown-method", "Unknown method returned a result; expected a JSON-RPC error");
    expectFail(report, "error-method-code", "No JSON-RPC error returned for unknown method");
    expectFail(report, "error-missing-params", "tools/call without name produced a result; a schema-invalid request");
    expectFail(report, "tools-call-unknown", "Unknown tool produced a successful result");
    expectFail(report, "error-invalid-cursor", "tools/list ignored the cursor but the result has no tools array");
    expectPass(report, "error-capability-gated", "declares all capabilities");
  });

  it("fails on isError results for missing params and results for undeclared capabilities", async () => {
    const report = await runModern(badStdio("isError"), { only: BOTH });
    expectPass(report, "error-unknown-method", "JSON-RPC error -32000, id echoed");
    expectFail(report, "error-method-code", "Expected -32601 (Method not found), got -32000 (nope)");
    expectFail(report, "error-missing-params", "produced a result with isError: true");
    expectPass(report, "tools-call-unknown", "isError: true (valid)");
    expectFail(
      report,
      "error-capability-gated",
      "resources/list returned a result despite the undeclared resources capability",
    );
    expect(resultOf(report, "error-capability-gated").details).toContain("prompts/list returned a result");
    expect(warned(report, NOT_FOUND_WARNING)).toBe(false);
  });
});
