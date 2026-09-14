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
 * isError: true, and unknown methods with -32000.
 */
const BAD_STDIO_SCRIPT = `
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("close", () => process.exit(0));
const mode = process.env.BAD_MODE || "results";
const caps = mode === "isError" ? { tools: {} } : { tools: {}, resources: {}, prompts: {} };
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result: { resultType: "complete", ...result } });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined || msg.id === null) return;
  switch (msg.method) {
    case "server/discover":
      return reply(msg.id, { supportedVersions: ["2026-07-28"], capabilities: caps, ttlMs: 0, cacheScope: "public" });
    case "tools/list":
    case "resources/list":
    case "prompts/list":
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

function badStdio(mode: "results" | "isError"): TransportTarget {
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

  it("reads a JSON-RPC error carried on an SSE body", async () => {
    bad.set(({ parseError, method, id }) => {
      if (parseError) {
        const frame = JSON.stringify(rpcError(null, -32700, "Parse error"));
        return { status: 400, raw: `event: message\ndata: ${frame}\n\n`, contentType: "text/event-stream" };
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

describe("errors suite: canned bad stdio server", () => {
  afterAll(() => {
    removeBadStdio();
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
