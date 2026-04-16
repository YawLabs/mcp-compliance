import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runComplianceSuite } from "../runner.js";

// Dogfood: run the compliance suite against this package's own MCP
// server. The strongest end-to-end signal we have — if the tool can
// test itself and grade cleanly, the stdio transport, lifecycle, and
// security gating are all working in concert.
//
// Requires a built dist/mcp/server.js. The regular `npm test` does not
// build, so we skip silently in that case; `npm run test:ci` builds
// first and runs this for real. (CI runs test:ci on every push.)
const serverPath = fileURLToPath(new URL("../../dist/mcp/server.js", import.meta.url));
const hasBuild = existsSync(serverPath);
const maybeDescribe = hasBuild ? describe : describe.skip;

maybeDescribe("integration (dogfood) — mcp-compliance tests its own MCP server", () => {
  it("grades itself A with no required-test failures", async () => {
    const report = await runComplianceSuite(
      { type: "stdio", command: process.execPath, args: [serverPath] },
      { timeout: 15000 },
    );

    // Basic sanity
    expect(report.serverInfo.name).toBe("mcp-compliance");
    expect(report.serverInfo.protocolVersion).toBe("2025-11-25");

    // Required tests (those that apply to stdio) must all pass.
    const requiredFails = report.tests.filter((t) => t.required && !t.passed);
    if (requiredFails.length > 0) {
      // Produce a useful failure message: list ids + details so a broken
      // commit is diagnosable from CI logs alone.
      const lines = requiredFails.map((t) => `  - ${t.id}: ${t.details}`).join("\n");
      throw new Error(`Required test failures when grading self:\n${lines}`);
    }
    expect(requiredFails).toEqual([]);

    // We expect a strong grade. This is not a score pin — if the suite
    // legitimately adds harder tests that the server now-happens-to-fail,
    // update the server. An A means every required test passed AND at
    // least some optional ones did too.
    expect(["A", "B"]).toContain(report.grade);

    // The dogfood surfaces all 3 declared tools.
    expect(report.toolCount).toBe(3);
    expect(report.toolNames.sort()).toEqual(["mcp_compliance_badge", "mcp_compliance_explain", "mcp_compliance_test"]);

    // Stdio-specific tests must have run and passed against our own server.
    const byId = new Map(report.tests.map((t) => [t.id, t]));
    expect(byId.get("stdio-framing")?.passed).toBe(true);
    expect(byId.get("stdio-unicode")?.passed).toBe(true);
    expect(byId.get("stdio-unknown-method-recovers")?.passed).toBe(true);
  }, 60_000);
});
