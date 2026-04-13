import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "mcp-compliance-config-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("returns null when no config is found", () => {
    expect(loadConfig(undefined, workDir)).toBeNull();
  });

  it("loads mcp-compliance.config.json from cwd", () => {
    writeFileSync(
      join(workDir, "mcp-compliance.config.json"),
      JSON.stringify({
        target: { type: "http", url: "https://example.com/mcp" },
        timeout: 20000,
      }),
    );
    const cfg = loadConfig(undefined, workDir);
    expect(cfg?.target).toEqual({ type: "http", url: "https://example.com/mcp" });
    expect(cfg?.timeout).toBe(20000);
  });

  it("loads .mcp-compliancerc.json when the named config isn't present", () => {
    writeFileSync(
      join(workDir, ".mcp-compliancerc.json"),
      JSON.stringify({ target: { type: "stdio", command: "node", args: ["server.js"] } }),
    );
    const cfg = loadConfig(undefined, workDir);
    expect(cfg?.target).toEqual({ type: "stdio", command: "node", args: ["server.js"] });
  });

  it("reads the 'mcp-compliance' field from package.json as a fallback", () => {
    writeFileSync(
      join(workDir, "package.json"),
      JSON.stringify({
        name: "fake",
        "mcp-compliance": { target: { type: "http", url: "https://pkg-json.example/mcp" } },
      }),
    );
    const cfg = loadConfig(undefined, workDir);
    expect(cfg?.target).toEqual({ type: "http", url: "https://pkg-json.example/mcp" });
  });

  it("loads an explicit --config path", () => {
    const custom = join(workDir, "my.json");
    writeFileSync(custom, JSON.stringify({ timeout: 5000 }));
    const cfg = loadConfig(custom, workDir);
    expect(cfg?.timeout).toBe(5000);
  });

  it("throws when an explicit config file does not exist", () => {
    expect(() => loadConfig("nonexistent.json", workDir)).toThrow(/not found/);
  });

  it("rejects unknown top-level keys", () => {
    writeFileSync(join(workDir, "mcp-compliance.config.json"), JSON.stringify({ unknown: 42 }));
    expect(() => loadConfig(undefined, workDir)).toThrow(/unknown key/);
  });

  it("rejects http target without a url", () => {
    writeFileSync(join(workDir, "mcp-compliance.config.json"), JSON.stringify({ target: { type: "http" } }));
    expect(() => loadConfig(undefined, workDir)).toThrow(/"url"/);
  });

  it("rejects stdio target without a command", () => {
    writeFileSync(join(workDir, "mcp-compliance.config.json"), JSON.stringify({ target: { type: "stdio" } }));
    expect(() => loadConfig(undefined, workDir)).toThrow(/"command"/);
  });

  it("rejects an invalid format value", () => {
    writeFileSync(join(workDir, "mcp-compliance.config.json"), JSON.stringify({ format: "xml" }));
    expect(() => loadConfig(undefined, workDir)).toThrow(/format must be/);
  });

  it("throws on malformed JSON", () => {
    writeFileSync(join(workDir, "mcp-compliance.config.json"), "{ not json");
    expect(() => loadConfig(undefined, workDir)).toThrow(/Failed to parse/);
  });

  it("prefers mcp-compliance.config.json over the package.json field", () => {
    writeFileSync(
      join(workDir, "mcp-compliance.config.json"),
      JSON.stringify({ target: { type: "http", url: "https://wins.example/mcp" } }),
    );
    writeFileSync(
      join(workDir, "package.json"),
      JSON.stringify({
        name: "fake",
        "mcp-compliance": { target: { type: "http", url: "https://loses.example/mcp" } },
      }),
    );
    expect(loadConfig(undefined, workDir)?.target).toEqual({ type: "http", url: "https://wins.example/mcp" });
  });
});
