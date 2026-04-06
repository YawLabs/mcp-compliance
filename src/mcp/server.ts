import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { runComplianceSuite } from '../runner.js';
import { generateBadge } from '../badge.js';
import { TEST_DEFINITIONS } from '../types.js';

const server = new McpServer({
  name: 'mcp-compliance',
  version: '0.1.0',
});

server.tool(
  'mcp_compliance_test',
  'Run the full MCP compliance test suite against a server URL. Returns grade (A-F), score, and detailed results for all 24 tests.',
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
      const ids = TEST_DEFINITIONS.map(t => t.id).join(', ');
      return {
        content: [{
          type: 'text' as const,
          text: `Unknown test ID: "${testId}"\n\nValid test IDs:\n${ids}`,
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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('MCP server error:', err);
  process.exit(1);
});
