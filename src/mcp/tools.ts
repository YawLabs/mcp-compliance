import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { findTestDefinition, getTestDefinitions } from "../definitions/index.js";
import { runComplianceSuite } from "../runner.js";
import { type SpecVersion, SUPPORTED_SPEC_VERSIONS, specBaseFor } from "../spec.js";
import type { TestDefinition } from "../types.js";

/** `auto` plus every catalog the tool ships; the order is the order shown to clients. */
const SPEC_VERSION_OPTIONS = ["auto", ...SUPPORTED_SPEC_VERSIONS] as const;

/**
 * One explain entry, labelled with the spec version(s) it describes so a
 * shared id read from two catalogs stays unambiguous. Several versions
 * means the prose is identical in each; the spec link still differs per
 * revision, so one reference line is printed per version.
 */
function describeDefinition(versions: readonly SpecVersion[], def: TestDefinition, note = ""): string {
  const many = versions.length > 1;
  return [
    `Test: ${def.id}`,
    `Spec version: ${versions.join(", ")}${note}`,
    `Name: ${def.name}`,
    `Category: ${def.category}`,
    `Required: ${def.required ? "Yes" : "No"}`,
    ...versions.map((v) => `Spec reference${many ? ` (${v})` : ""}: ${specBaseFor(v)}/${def.specRef}`),
    "",
    def.description,
    "",
    `Fix: ${def.recommendation}`,
  ].join("\n");
}

/** True when two catalogs describe an id identically, so one entry can speak for both. */
function sameProse(a: TestDefinition, b: TestDefinition): boolean {
  return (
    a.name === b.name &&
    a.category === b.category &&
    a.required === b.required &&
    a.specRef === b.specRef &&
    a.description === b.description &&
    a.recommendation === b.recommendation
  );
}

/** The unknown-id listing, grouped per suite so a 2025 id is not mistaken for a 2026 one. */
function listIdsPerSuite(): string {
  return SUPPORTED_SPEC_VERSIONS.map(
    (v) =>
      `Valid test IDs (${v} suite):\n${getTestDefinitions(v)
        .map((t) => t.id)
        .join(", ")}`,
  ).join("\n\n");
}

/**
 * Register all mcp-compliance tools on an McpServer instance.
 */
export function registerTools(server: McpServer) {
  server.tool(
    "mcp_compliance_test",
    "Run the MCP compliance test suite against a server URL — the spec suite for the server's MCP revision, 2025-11-25 or 2026-07-28, auto-detected unless specVersion pins one. Returns grade (A-F), score, and detailed results covering transport, lifecycle, tools, resources, prompts, errors, schema validation, and security.",
    {
      url: z.string().url().describe("The MCP server URL to test (must be HTTP or HTTPS)"),
      specVersion: z
        .enum(SPEC_VERSION_OPTIONS)
        .optional()
        .describe(
          'MCP spec revision to test against. "auto" (default) probes the server and grades it against the newest revision it speaks; pin "2025-11-25" or "2026-07-28" to force one suite.',
        ),
      auth: z.string().optional().describe('Authorization header value (e.g., "Bearer tok123")'),
      headers: z
        .record(z.string(), z.string())
        .optional()
        .describe('Additional headers to include on all requests (e.g., {"X-Api-Key": "abc"})'),
      timeout: z
        .number()
        .int()
        .min(1)
        .max(300000)
        .optional()
        .describe("Request timeout in milliseconds (default: 15000, max: 300000)"),
      retries: z
        .number()
        .int()
        .min(0)
        .max(10)
        .optional()
        .describe("Number of retries for failed tests (default: 0, max: 10)"),
      only: z.array(z.string()).optional().describe("Only run tests matching these categories or test IDs"),
      skip: z.array(z.string()).optional().describe("Skip tests matching these categories or test IDs"),
    },
    {
      title: "Run MCP Compliance Tests",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async ({ url, specVersion, auth, headers: extraHeaders, timeout, retries, only, skip }) => {
      try {
        const headers: Record<string, string> = { ...extraHeaders };
        if (auth) headers.Authorization = auth;

        const report = await runComplianceSuite(url, {
          specVersion: specVersion ?? "auto",
          headers: Object.keys(headers).length > 0 ? headers : undefined,
          timeout,
          retries,
          only,
          skip,
        });

        const summary = [
          `Grade: ${report.grade} (${report.score}%)`,
          `Overall: ${report.overall}`,
          `Spec: ${report.specVersion}`,
          `Tests: ${report.summary.passed}/${report.summary.total} passed (${report.summary.requiredPassed}/${report.summary.required} required)`,
          "",
          ...report.tests.map(
            (t) => `${t.passed ? "PASS" : "FAIL"} ${t.name}${t.required ? " (required)" : ""} — ${t.details}`,
          ),
        ];

        if (report.serverInfo.name) {
          summary.unshift(`Server: ${report.serverInfo.name} v${report.serverInfo.version || "?"}`);
        }

        if (report.warnings.length > 0) {
          summary.push("", `Warnings (${report.warnings.length}):`);
          for (const w of report.warnings) {
            summary.push(`  - ${w}`);
          }
        }

        return {
          content: [
            { type: "text" as const, text: summary.join("\n") },
            { type: "text" as const, text: `\n\nFull report:\n${JSON.stringify(report, null, 2)}` },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error running compliance test: ${message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "mcp_compliance_explain",
    "Explain what a specific compliance test ID checks and why it matters. Ids are per spec suite: pass specVersion to read one catalog, or omit it to search both (a shared id whose criteria differ is explained once per suite).",
    {
      testId: z
        .string()
        .describe(
          'The test ID to explain (e.g., "transport-post", "tools-schema", "lifecycle-init" for 2025-11-25, "lifecycle-discover" for 2026-07-28)',
        ),
      specVersion: z
        .enum(SUPPORTED_SPEC_VERSIONS)
        .optional()
        .describe("Catalog to look the id up in. Omit to search every supported spec revision."),
    },
    {
      title: "Explain Compliance Test",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ testId, specVersion }) => {
      const versions: readonly SpecVersion[] = specVersion ? [specVersion] : SUPPORTED_SPEC_VERSIONS;
      const found = versions
        .map((v) => ({ version: v, def: findTestDefinition(v, testId) }))
        .filter((hit): hit is { version: SpecVersion; def: TestDefinition } => hit.def !== undefined);

      if (found.length === 0) {
        const elsewhere = SUPPORTED_SPEC_VERSIONS.filter(
          (v) => !versions.includes(v) && findTestDefinition(v, testId) !== undefined,
        );
        const where = specVersion ? ` in the ${specVersion} suite` : "";
        const hint =
          elsewhere.length > 0
            ? `\n\nIt exists in the ${elsewhere.join(" and ")} suite; pass that specVersion or omit specVersion to search every suite.`
            : "";
        return {
          content: [
            {
              type: "text" as const,
              text: `Unknown test ID: "${testId}"${where}${hint}\n\n${listIdsPerSuite()}`,
            },
          ],
          isError: true,
        };
      }

      // A shared id with identical prose in every catalog is one test;
      // say so once rather than repeating it per suite.
      if (found.length > 1 && found.every((hit) => sameProse(hit.def, found[0].def))) {
        const text = describeDefinition(
          found.map((hit) => hit.version),
          found[0].def,
          " (identical in each)",
        );
        return { content: [{ type: "text" as const, text }] };
      }

      const sections = found.map((hit) => describeDefinition([hit.version], hit.def));
      const preface =
        found.length > 1
          ? `"${testId}" exists in ${found.length} spec suites with different criteria; each is explained below.\n\n`
          : "";
      return {
        content: [{ type: "text" as const, text: preface + sections.join("\n\n---\n\n") }],
      };
    },
  );
}
