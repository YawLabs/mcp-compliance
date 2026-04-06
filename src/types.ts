export type TestCategory = 'transport' | 'lifecycle' | 'tools' | 'resources' | 'prompts' | 'errors' | 'schema';

export interface TestResult {
  id: string;
  name: string;
  category: TestCategory;
  passed: boolean;
  required: boolean;
  details: string;
  durationMs: number;
  specRef?: string;
}

export type Grade = 'A' | 'B' | 'C' | 'D' | 'F';
export type Overall = 'pass' | 'partial' | 'fail';

export interface ComplianceReport {
  specVersion: string;
  url: string;
  timestamp: string;
  score: number;
  grade: Grade;
  overall: Overall;
  summary: {
    total: number;
    passed: number;
    failed: number;
    required: number;
    requiredPassed: number;
  };
  categories: Record<string, { passed: number; total: number }>;
  tests: TestResult[];
  serverInfo: {
    protocolVersion: string | null;
    name: string | null;
    version: string | null;
    capabilities: Record<string, unknown>;
  };
  toolCount: number;
  toolNames: string[];
  resourceCount: number;
  promptCount: number;
  badge: {
    imageUrl: string;
    reportUrl: string;
    markdown: string;
    html: string;
  };
}

export interface TestDefinition {
  id: string;
  name: string;
  category: TestCategory;
  required: boolean;
  specRef: string;
  description: string;
}

/** All 24 test IDs with descriptions for the explain command */
export const TEST_DEFINITIONS: TestDefinition[] = [
  { id: 'transport-post', name: 'HTTP POST accepted', category: 'transport', required: true, specRef: 'basic/transports#streamable-http', description: 'Verifies the server accepts HTTP POST requests and returns a 2xx status code. This is the fundamental transport requirement for Streamable HTTP MCP servers.' },
  { id: 'transport-content-type', name: 'Responds with JSON or SSE', category: 'transport', required: true, specRef: 'basic/transports#streamable-http', description: 'Checks that the server responds with Content-Type application/json or text/event-stream. MCP servers must use one of these two content types.' },
  { id: 'lifecycle-init', name: 'Initialize handshake', category: 'lifecycle', required: true, specRef: 'basic/lifecycle#initialization', description: 'Tests the initialize handshake by sending an initialize request with client capabilities. The server must return a result with protocolVersion.' },
  { id: 'lifecycle-proto-version', name: 'Returns valid protocol version', category: 'lifecycle', required: true, specRef: 'basic/lifecycle#version-negotiation', description: 'Validates that the protocolVersion returned by the server matches the YYYY-MM-DD date format required by the spec.' },
  { id: 'lifecycle-server-info', name: 'Includes serverInfo', category: 'lifecycle', required: false, specRef: 'basic/lifecycle#initialization', description: 'Checks that the server includes a serverInfo object with at least a name field in its initialize response. While recommended, this is not strictly required.' },
  { id: 'lifecycle-capabilities', name: 'Returns capabilities object', category: 'lifecycle', required: true, specRef: 'basic/lifecycle#capability-negotiation', description: 'Verifies the server returns a capabilities object in its initialize response. An empty object is valid (no optional features declared).' },
  { id: 'lifecycle-jsonrpc', name: 'Response is valid JSON-RPC 2.0', category: 'lifecycle', required: true, specRef: 'basic', description: 'Validates that the initialize response is a proper JSON-RPC 2.0 message with jsonrpc="2.0", an id field, and either a result or error field.' },
  { id: 'lifecycle-ping', name: 'Responds to ping', category: 'lifecycle', required: true, specRef: 'basic/utilities#ping', description: 'Tests that the server responds to the ping method with an empty result object. This is a required utility method.' },
  { id: 'tools-list', name: 'tools/list returns valid response', category: 'tools', required: false, specRef: 'server/tools#listing-tools', description: 'Calls tools/list and validates it returns an array of tool definitions. Required if the server declares tools capability.' },
  { id: 'tools-schema', name: 'All tools have name and inputSchema', category: 'schema', required: false, specRef: 'server/tools#data-types', description: 'Validates every tool has a valid name (1-128 chars, alphanumeric/underscore/hyphen/dot) and a required inputSchema of type "object".' },
  { id: 'tools-call', name: 'tools/call responds correctly', category: 'tools', required: false, specRef: 'server/tools#calling-tools', description: 'Calls the first tool with empty arguments and verifies the response format. Accepts both successful results and InvalidParams errors.' },
  { id: 'tools-call-unknown', name: 'Returns error for unknown tool name', category: 'errors', required: false, specRef: 'server/tools#error-handling', description: 'Calls tools/call with a nonexistent tool name and verifies the server returns an error response.' },
  { id: 'resources-list', name: 'resources/list returns valid response', category: 'resources', required: false, specRef: 'server/resources#listing-resources', description: 'Calls resources/list and validates it returns an array. Required if the server declares resources capability.' },
  { id: 'resources-schema', name: 'Resources have uri and name', category: 'schema', required: false, specRef: 'server/resources#data-types', description: 'Validates every resource has a valid URI (parseable as a URL) and a name field.' },
  { id: 'resources-read', name: 'resources/read returns content', category: 'resources', required: false, specRef: 'server/resources#reading-resources', description: 'Reads the first resource and validates the response contains a contents array with proper uri and text/blob fields.' },
  { id: 'resources-templates', name: 'resources/templates/list returns valid response', category: 'resources', required: false, specRef: 'server/resources#resource-templates', description: 'Tests the resource templates endpoint. Accepts Method not found (-32601) since templates are optional.' },
  { id: 'prompts-list', name: 'prompts/list returns valid response', category: 'prompts', required: false, specRef: 'server/prompts#listing-prompts', description: 'Calls prompts/list and validates it returns an array. Required if the server declares prompts capability.' },
  { id: 'prompts-schema', name: 'Prompts have name field', category: 'schema', required: false, specRef: 'server/prompts#data-types', description: 'Validates every prompt has a name and that any arguments array contains items with name fields.' },
  { id: 'prompts-get', name: 'prompts/get returns valid messages', category: 'prompts', required: false, specRef: 'server/prompts#getting-a-prompt', description: 'Gets the first prompt and validates the response contains a messages array with proper role and content fields.' },
  { id: 'error-unknown-method', name: 'Returns JSON-RPC error for unknown method', category: 'errors', required: true, specRef: 'basic', description: 'Sends an unknown method and verifies the server returns a JSON-RPC error. The spec requires error code -32601 (Method not found).' },
  { id: 'error-method-code', name: 'Uses correct JSON-RPC error code for unknown method', category: 'errors', required: false, specRef: 'basic', description: 'Checks the error code is specifically -32601 (Method not found) for unknown methods, as required by JSON-RPC 2.0.' },
  { id: 'error-invalid-jsonrpc', name: 'Handles malformed JSON-RPC', category: 'errors', required: true, specRef: 'basic', description: 'Sends a malformed JSON-RPC message (missing required fields) and verifies the server returns an error or 4xx status.' },
  { id: 'error-invalid-json', name: 'Handles invalid JSON body', category: 'errors', required: false, specRef: 'basic', description: 'Sends invalid JSON and verifies the server returns a parse error (-32700) or 4xx status code.' },
  { id: 'error-missing-params', name: 'Returns error for tools/call without name', category: 'errors', required: false, specRef: 'server/tools#error-handling', description: 'Calls tools/call with an empty params object (missing required name field) and verifies an error is returned.' },
];
