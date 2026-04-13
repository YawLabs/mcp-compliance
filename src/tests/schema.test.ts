import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import addFormats from "ajv-formats";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { generateBadge } from "../badge.js";
import { REPORT_SCHEMA_VERSION } from "../types.js";
import type { ComplianceReport } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(__dirname, "../../schemas/report.v1.json");
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);

function sampleReport(): ComplianceReport {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    specVersion: "2025-11-25",
    toolVersion: "0.10.0",
    url: "https://example.com/mcp",
    timestamp: new Date().toISOString(),
    score: 92.5,
    grade: "A",
    overall: "pass",
    summary: { total: 81, passed: 75, failed: 6, required: 40, requiredPassed: 39 },
    categories: {
      transport: { passed: 13, total: 13 },
      lifecycle: { passed: 10, total: 10 },
    },
    tests: [
      {
        id: "transport-post",
        name: "HTTP POST accepted",
        category: "transport",
        passed: true,
        required: true,
        details: "HTTP 200",
        durationMs: 42,
        specRef: "https://modelcontextprotocol.io/specification/2025-11-25/basic/transports",
      },
    ],
    warnings: [],
    serverInfo: {
      protocolVersion: "2025-11-25",
      name: "example-server",
      version: "1.0.0",
      capabilities: { tools: {} },
    },
    toolCount: 1,
    toolNames: ["echo"],
    resourceCount: 0,
    resourceNames: [],
    promptCount: 0,
    promptNames: [],
    badge: generateBadge("https://example.com/mcp"),
  };
}

describe("report.v1.json schema", () => {
  it("schemaVersion constant matches schema const", () => {
    expect(REPORT_SCHEMA_VERSION).toBe(schema.properties.schemaVersion.const);
  });

  it("validates a minimal well-formed report", () => {
    const report = sampleReport();
    const ok = validate(report);
    if (!ok) {
      throw new Error(`Schema validation failed: ${JSON.stringify(validate.errors, null, 2)}`);
    }
    expect(ok).toBe(true);
  });

  it("rejects a report missing schemaVersion", () => {
    const { schemaVersion: _omit, ...report } = sampleReport() as ComplianceReport;
    void _omit;
    expect(validate(report)).toBe(false);
  });

  it("rejects a report with an unknown grade", () => {
    const report = sampleReport() as ComplianceReport & { grade: string };
    (report as { grade: string }).grade = "Z";
    expect(validate(report)).toBe(false);
  });

  it("rejects a report with an unknown test category", () => {
    const report = sampleReport();
    (report.tests[0] as unknown as { category: string }).category = "nonsense";
    expect(validate(report)).toBe(false);
  });

  it("rejects extra top-level properties (catches accidental schema drift)", () => {
    const report = sampleReport() as ComplianceReport & { extra: string };
    report.extra = "should-not-be-here";
    expect(validate(report)).toBe(false);
  });
});
