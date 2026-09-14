import { computeScore } from "./grader.js";
import type { SpecVersion } from "./spec.js";
import type { ComplianceReport, TestResult } from "./types.js";
import { REPORT_SCHEMA_VERSION } from "./types.js";

export interface ReportInputs {
  specVersion: SpecVersion;
  toolVersion: string;
  /** Display URL: the HTTP URL or `stdio:<command> <args>`. */
  url: string;
  tests: TestResult[];
  /** Already deduped/capped by the harness. */
  warnings: string[];
  serverInfo: ComplianceReport["serverInfo"];
  toolCount: number;
  toolNames: string[];
  resourceCount: number;
  resourceNames: string[];
  promptCount: number;
  promptNames: string[];
}

/**
 * Assemble the report from a finished run. Shared by every suite so the
 * report shape (schema v1) has exactly one producer.
 */
export function assembleReport(input: ReportInputs): ComplianceReport {
  const { score, grade, overall, summary, categories } = computeScore(input.tests);
  // Badge URLs are retired (the mcp.hosting renderer is gone); the field is
  // kept empty for report-schema back-compat. Use `--output <file>.svg` for
  // a local badge image instead.
  const badge = { imageUrl: "", reportUrl: "", markdown: "", html: "" };

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    specVersion: input.specVersion,
    toolVersion: input.toolVersion,
    url: input.url,
    timestamp: new Date().toISOString(),
    score,
    grade,
    overall,
    summary,
    categories,
    tests: input.tests,
    warnings: input.warnings,
    serverInfo: input.serverInfo,
    toolCount: input.toolCount,
    toolNames: input.toolNames,
    resourceCount: input.resourceCount,
    resourceNames: input.resourceNames,
    promptCount: input.promptCount,
    promptNames: input.promptNames,
    badge,
  };
}
