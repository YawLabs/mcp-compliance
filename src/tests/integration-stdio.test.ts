import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runComplianceSuite } from "../runner.js";

const fixturePath = fileURLToPath(new URL("./fixtures/echo-server.mjs", import.meta.url));

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
});
