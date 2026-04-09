import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SPEC_BASE, runComplianceSuite } from "../runner.js";
import { TEST_DEFINITIONS } from "../types.js";

/**
 * Register all mcp-compliance tools on an McpServer instance.
 */
export function registerTools(server: McpServer) {
  server.tool(
    "mcp_compliance_test",
    "Run the full MCP compliance test suite against a server URL. Returns grade (A-F), score, and detailed results for all 69 tests covering transport, lifecycle, tools, resources, prompts, errors, schema validation, and security.",
    {
      url: z.string().url().describe("The MCP server URL to test (must be HTTP or HTTPS)"),
      auth: z.string().optional().describe('Authorization header value (e.g., "Bearer tok123")'),
      headers: z
        .record(z.string())
        .optional()
        .describe('Additional headers to include on all requests (e.g., {"X-Api-Key": "abc"})'),
      timeout: z.number().optional().describe("Request timeout in milliseconds (default: 15000)"),
      retries: z.number().optional().describe("Number of retries for failed tests (default: 0)"),
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
    async ({ url, auth, headers: extraHeaders, timeout, retries, only, skip }) => {
      try {
        const headers: Record<string, string> = { ...extraHeaders };
        if (auth) headers.Authorization = auth;

        const report = await runComplianceSuite(url, {
          headers: Object.keys(headers).length > 0 ? headers : undefined,
          timeout,
          retries,
          only,
          skip,
        });

        const summary = [
          `Grade: ${report.grade} (${report.score}%)`,
          `Overall: ${report.overall}`,
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
    "mcp_compliance_badge",
    "Get the badge markdown embed code for an MCP server. Runs the compliance test suite first to determine the grade.",
    {
      url: z.string().url().describe("The MCP server URL to test"),
      auth: z.string().optional().describe('Authorization header value (e.g., "Bearer tok123")'),
      headers: z.record(z.string()).optional().describe("Additional headers to include on all requests"),
      timeout: z.number().optional().describe("Request timeout in milliseconds (default: 15000)"),
    },
    {
      title: "Get Compliance Badge",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async ({ url, auth, headers: extraHeaders, timeout }) => {
      try {
        const headers: Record<string, string> = { ...extraHeaders };
        if (auth) headers.Authorization = auth;

        const report = await runComplianceSuite(url, {
          headers: Object.keys(headers).length > 0 ? headers : undefined,
          timeout,
        });
        const badge = report.badge;

        return {
          content: [
            {
              type: "text" as const,
              text: [
                `Grade: ${report.grade} (${report.score}%)`,
                "",
                "Markdown:",
                badge.markdown,
                "",
                "HTML:",
                badge.html,
              ].join("\n"),
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "mcp_compliance_explain",
    "Explain what a specific compliance test ID checks and why it matters.",
    {
      testId: z.string().describe('The test ID to explain (e.g., "transport-post", "lifecycle-init", "tools-schema")'),
    },
    {
      title: "Explain Compliance Test",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ testId }) => {
      const def = TEST_DEFINITIONS.find((t) => t.id === testId);
      if (!def) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Unknown test ID: "${testId}"\n\nValid test IDs:\n${TEST_DEFINITIONS.map((t) => t.id).join(", ")}`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Test: ${def.id}`,
              `Name: ${def.name}`,
              `Category: ${def.category}`,
              `Required: ${def.required ? "Yes" : "No"}`,
              `Spec reference: ${SPEC_BASE}/${def.specRef}`,
              "",
              def.description,
              "",
              `Fix: ${def.recommendation}`,
            ].join("\n"),
          },
        ],
      };
    },
  );
}
