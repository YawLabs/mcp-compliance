import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runComplianceSuite } from "../runner.js";

const fixturePath = fileURLToPath(new URL("./fixtures/echo-server.mjs", import.meta.url));

/**
 * A 2025-11-25 stdio server with no tool to call: `tools: "none"` declares
 * no tools capability at all (a prompts-only server), `"empty"` declares it
 * and lists none. Everything else it answers like echo-server.mjs would.
 */
const NO_TOOL_STDIO_SERVER = `
import { createInterface } from "node:readline";
const mode = process.env.TOOLS;
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return;
  const reply = (result) => send({ jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: "2025-11-25",
        capabilities: mode === "empty" ? { tools: {}, prompts: {} } : { prompts: {} },
        serverInfo: { name: "no-tool-fixture", version: "1" },
      });
    case "ping":
      return reply({});
    case "prompts/list":
      return reply({ prompts: [] });
    case "tools/list":
      if (mode === "empty") return reply({ tools: [] });
  }
  send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found: " + msg.method } });
});
`;

describe("integration (stdio) — legacy checks with nothing to measure over stdio skip, flagged", () => {
  const run = (target: Parameters<typeof runComplianceSuite>[0], only: string[]) =>
    runComplianceSuite(target, { timeout: 5000, specVersion: "2025-11-25", only });
  const view = (report: Awaited<ReturnType<typeof run>>) =>
    Object.fromEntries(report.tests.map((t) => [t.id, { passed: t.passed, skipped: t.skipped, details: t.details }]));

  it("the error-disclosure checks send raw HTTP, which a stdio target cannot receive: skipped, saying so", async () => {
    // Before: PASS "0 error responses checked — no stack traces or sensitive
    // data found" and PASS "No response to check (connection error)" on every
    // stdio run -- the probes failed client-side on the empty URL.
    const report = await run({ type: "stdio", command: process.execPath, args: [fixturePath] }, [
      "security-error-no-stacktrace",
      "security-error-no-internal-ip",
    ]);
    expect(view(report)).toEqual({
      "security-error-no-stacktrace": {
        passed: true,
        skipped: true,
        details:
          "Skipped: the error probes are raw HTTP requests, which a stdio target cannot receive, so no error response was scanned",
      },
      "security-error-no-internal-ip": {
        passed: true,
        skipped: true,
        details:
          "Skipped: the error probe is a raw HTTP request, which a stdio target cannot receive, so no error response was scanned",
      },
    });
  }, 30_000);

  it("stdio-unicode: a server with a tool to carry the probe is measured, not flagged", async () => {
    const report = await run({ type: "stdio", command: process.execPath, args: [fixturePath] }, [
      "tools-list",
      "stdio-unicode",
    ]);
    expect(view(report)["stdio-unicode"]).toEqual({
      passed: true,
      skipped: undefined,
      details: "Unicode string round-tripped through tool call",
    });
  }, 30_000);

  it("stdio-unicode: with no tool to carry the probe nothing unicode is sent, so it skips", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-legacy-unicode-"));
    const script = join(dir, "no-tool-server.mjs");
    writeFileSync(script, NO_TOOL_STDIO_SERVER);
    try {
      const target = (tools: "none" | "empty") => ({
        type: "stdio" as const,
        command: process.execPath,
        args: [script],
        env: { TOOLS: tools },
      });
      // A server that declares no tools. Before: FAIL "tools/list returned
      // error" -- its -32601 to a list it never offered.
      const none = await run(target("none"), ["stdio-unicode"]);
      expect(view(none)["stdio-unicode"]).toEqual({
        passed: true,
        skipped: true,
        details: "Skipped: server declares no tools, so there is no tool call to carry the unicode probe",
      });
      // Declared but empty: tools/list is still asked, and a served list is
      // a pass that measured nothing about unicode. Before: unflagged.
      const empty = await run(target("empty"), ["tools-list", "stdio-unicode"]);
      expect(view(empty)["stdio-unicode"]).toEqual({
        passed: true,
        skipped: true,
        details: "tools/list returned successfully (no tools to probe with unicode)",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("integration (stdio) — runComplianceSuite against the echo fixture", () => {
  it("runs end-to-end over stdio and produces a report", async () => {
    const report = await runComplianceSuite(
      { type: "stdio", command: process.execPath, args: [fixturePath] },
      { timeout: 5000 },
    );
    expect(report.tests.length).toBeGreaterThan(0);
    expect(report.url).toContain("stdio:");
    // Stdio should not run HTTP-only transport tests.
    const ran = new Set(report.tests.map((t) => t.id));
    expect(ran.has("transport-post")).toBe(false);
    expect(ran.has("transport-session-id")).toBe(false);
    expect(ran.has("transport-content-type")).toBe(false);
    // Protocol-level tests still run.
    expect(ran.has("lifecycle-init")).toBe(true);
    expect(ran.has("lifecycle-ping")).toBe(true);
  }, 30_000);

  it("reports the fixture's server info from initialize", async () => {
    const report = await runComplianceSuite(
      { type: "stdio", command: process.execPath, args: [fixturePath] },
      { timeout: 5000 },
    );
    expect(report.serverInfo.name).toBe("echo-fixture");
    expect(report.serverInfo.protocolVersion).toBe("2025-11-25");
  }, 30_000);

  it("runs the stdio-specific test suite", async () => {
    const report = await runComplianceSuite(
      { type: "stdio", command: process.execPath, args: [fixturePath] },
      { timeout: 5000 },
    );
    const byId = new Map(report.tests.map((t) => [t.id, t]));
    // All three stdio-specific tests should run against the fixture.
    expect(byId.has("stdio-framing")).toBe(true);
    expect(byId.has("stdio-unicode")).toBe(true);
    expect(byId.has("stdio-unknown-method-recovers")).toBe(true);
    // The fixture is well-behaved — all three should pass.
    expect(byId.get("stdio-framing")?.passed).toBe(true);
    expect(byId.get("stdio-unicode")?.passed).toBe(true);
    expect(byId.get("stdio-unknown-method-recovers")?.passed).toBe(true);
  }, 30_000);

  it("a plain echo tool passes the injection tests: reflecting the payload verbatim is not execution", async () => {
    // The 2025-11-25 detectors used to match the payload itself coming
    // back ("&& echo pwned" -> "pwned", "... information_schema ..." ->
    // "information_schema") and fail an echo tool that the 2026-07-28
    // suite passes, so a dual-era server got opposite verdicts per era.
    // tools-list is what discovers the echo tool the injection tests target.
    const report = await runComplianceSuite(
      { type: "stdio", command: process.execPath, args: [fixturePath] },
      {
        timeout: 5000,
        only: ["tools-list", "security-command-injection", "security-sql-injection", "security-path-traversal"],
      },
    );
    const verdicts = Object.fromEntries(
      report.tests
        .filter((t) => t.category === "security")
        .map((t) => [t.id, t.passed ? "pass" : `FAIL: ${t.details}`]),
    );
    expect(verdicts).toEqual({
      "security-command-injection": "pass",
      "security-sql-injection": "pass",
      "security-path-traversal": "pass",
    });
    const byId = new Map(report.tests.map((t) => [t.id, t]));
    expect(byId.get("security-command-injection")?.details).toBe(
      "Tested 5 payloads against echo.message — no command execution detected (0 rejected, 5 returned without it)",
    );
    expect(byId.get("security-sql-injection")?.details).toBe(
      "Tested 3 payloads against echo.message — no database error detected (0 rejected, 3 returned without it)",
    );
  }, 30_000);
});
