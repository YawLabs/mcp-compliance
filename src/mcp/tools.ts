import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runComplianceSuite } from '../runner.js';
import { TEST_DEFINITIONS } from '../types.js';

/**
 * Register all mcp-compliance tools on an McpServer instance.
 */
export function registerTools(server: McpServer) {
  server.tool(
    'mcp_compliance_test',
    'Run the full MCP compliance test suite against a server URL. Returns grade (A-F), score, and detailed results for all 43 tests covering transport, lifecycle, tools, resources, prompts, errors, and schema validation.',
    {
      url: z.string().url().describe('The MCP server URL to test (must be HTTP or HTTPS)'),
    },
    async ({ url }) => {
      try {
        const report = await runComplianceSuite(url);

        const summary = [
          `Grade: ${report.grade} (${report.score}%)`,
          `Overall: ${report.overall}`,
          `Tests: ${report.summary.passed}/${report.summary.total} passed (${report.summary.requiredPassed}/${report.summary.required} required)`,
          '',
          ...report.tests.map(t =>
            `${t.passed ? 'PASS' : 'FAIL'} ${t.name}${t.required ? ' (required)' : ''} — ${t.details}`
          ),
        ];

        if (report.serverInfo.name) {
          summary.unshift(`Server: ${report.serverInfo.name} v${report.serverInfo.version || '?'}`);
        }

        if (report.warnings.length > 0) {
          summary.push('', `Warnings (${report.warnings.length}):`);
          for (const w of report.warnings) {
            summary.push(`  - ${w}`);
          }
        }

        return {
          content: [
            { type: 'text' as const, text: summary.join('\n') },
            { type: 'text' as const, text: `\n\nFull report:\n${JSON.stringify(report, null, 2)}` },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: 'text' as const, text: `Error running compliance test: ${err.message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'mcp_compliance_badge',
    'Get the badge markdown embed code for an MCP server. Runs the compliance test suite first to determine the grade.',
    {
      url: z.string().url().describe('The MCP server URL to test'),
    },
    async ({ url }) => {
      try {
        const report = await runComplianceSuite(url);
        const badge = report.badge;

        return {
          content: [{
            type: 'text' as const,
            text: [
              `Grade: ${report.grade} (${report.score}%)`,
              '',
              'Markdown:',
              badge.markdown,
              '',
              'HTML:',
              badge.html,
            ].join('\n'),
          }],
        };
      } catch (err: any) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'mcp_compliance_explain',
    'Explain what a specific compliance test ID checks and why it matters.',
    {
      testId: z.string().describe('The test ID to explain (e.g., "transport-post", "lifecycle-init", "tools-schema")'),
    },
    async ({ testId }) => {
      const def = TEST_DEFINITIONS.find(t => t.id === testId);
      if (!def) {
        return {
          content: [{
            type: 'text' as const,
            text: `Unknown test ID: "${testId}"\n\nValid test IDs:\n${TEST_DEFINITIONS.map(t => t.id).join(', ')}`,
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: [
            `Test: ${def.id}`,
            `Name: ${def.name}`,
            `Category: ${def.category}`,
            `Required: ${def.required ? 'Yes' : 'No'}`,
            `Spec reference: https://modelcontextprotocol.io/specification/2025-11-25/${def.specRef}`,
            '',
            def.description,
          ].join('\n'),
        }],
      };
    },
  );
}
