import { request } from 'undici';
import type { TestResult, ComplianceReport } from './types.js';
import { computeScore } from './grader.js';
import { generateBadge } from './badge.js';

export type { TestResult, ComplianceReport } from './types.js';
export { TEST_DEFINITIONS } from './types.js';
export { computeGrade, computeScore } from './grader.js';
export { generateBadge } from './badge.js';

const SPEC_VERSION = '2025-11-25';
const SPEC_BASE = `https://modelcontextprotocol.io/specification/${SPEC_VERSION}`;

function createIdCounter() {
  let id = 0;
  return () => ++id;
}

const _defaultNextId = createIdCounter();

async function mcpRequest(
  backendUrl: string,
  method: string,
  params?: unknown,
  nextId: () => number = _defaultNextId,
): Promise<{
  statusCode: number;
  body: any;
  headers: Record<string, string>;
}> {
  const id = nextId();
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id,
    method,
    params: params || {},
  });

  const res = await request(backendUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    },
    body,
    signal: AbortSignal.timeout(15000),
  });

  const text = await res.body.text();
  const responseHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers)) {
    if (typeof v === 'string') responseHeaders[k] = v;
  }

  try {
    return { statusCode: res.statusCode, body: JSON.parse(text), headers: responseHeaders };
  } catch {
    return { statusCode: res.statusCode, body: { _raw: text }, headers: responseHeaders };
  }
}

async function mcpNotification(backendUrl: string, method: string, params?: unknown): Promise<void> {
  await request(backendUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }),
    signal: AbortSignal.timeout(5000),
  }).then(r => r.body.text()).catch(() => {});
}

export interface RunOptions {
  /** Optional callback for progress updates */
  onProgress?: (testId: string, passed: boolean, details: string) => void;
}

/**
 * Run the full MCP compliance test suite against a URL.
 */
export async function runComplianceSuite(url: string, options: RunOptions = {}): Promise<ComplianceReport> {
  // Validate URL
  let parsed: URL;
  try {
    parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('Only HTTP and HTTPS URLs are supported');
    }
  } catch (e: any) {
    if (e.message.includes('Only HTTP')) throw e;
    throw new Error(`Invalid URL: ${url}`);
  }

  const backendUrl = url;
  const tests: TestResult[] = [];
  const nextId = createIdCounter();
  const rpc = (method: string, params?: unknown) => mcpRequest(backendUrl, method, params, nextId);

  let serverInfo = {
    protocolVersion: null as string | null,
    name: null as string | null,
    version: null as string | null,
    capabilities: {} as Record<string, unknown>,
  };
  let toolCount = 0;
  let toolNames: string[] = [];
  let resourceCount = 0;
  let promptCount = 0;

  async function test(
    id: string,
    name: string,
    category: TestResult['category'],
    required: boolean,
    specRef: string,
    fn: () => Promise<{ passed: boolean; details: string }>,
  ): Promise<void> {
    const start = Date.now();
    try {
      const result = await fn();
      tests.push({
        id, name, category, required,
        passed: result.passed,
        details: result.details,
        durationMs: Date.now() - start,
        specRef: `${SPEC_BASE}/${specRef}`,
      });
      options.onProgress?.(id, result.passed, result.details);
    } catch (err: any) {
      tests.push({
        id, name, category, required,
        passed: false,
        details: `Error: ${err.message}`,
        durationMs: Date.now() - start,
        specRef: `${SPEC_BASE}/${specRef}`,
      });
      options.onProgress?.(id, false, `Error: ${err.message}`);
    }
  }

  // ── 1. TRANSPORT ──────────────────────────────────────────────────

  await test('transport-post', 'HTTP POST accepted', 'transport', true, 'basic/transports#streamable-http', async () => {
    const res = await request(backendUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      signal: AbortSignal.timeout(10000),
    });
    await res.body.text();
    const passed = res.statusCode >= 200 && res.statusCode < 300;
    const note = res.statusCode === 401 || res.statusCode === 403 ? ' (auth required)' : '';
    return { passed, details: `HTTP ${res.statusCode}${note}` };
  });

  await test('transport-content-type', 'Responds with JSON or SSE', 'transport', true, 'basic/transports#streamable-http', async () => {
    const res = await request(backendUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      signal: AbortSignal.timeout(10000),
    });
    await res.body.text();
    const rawCt = res.headers['content-type'];
    const ct = (Array.isArray(rawCt) ? rawCt[0] : rawCt || '').toLowerCase();
    const valid = ct.includes('application/json') || ct.includes('text/event-stream');
    return { passed: valid, details: `Content-Type: ${ct}` };
  });

  // ── 2. LIFECYCLE: Initialize ──────────────────────────────────────

  let initRes: any = null;

  await test('lifecycle-init', 'Initialize handshake', 'lifecycle', true, 'basic/lifecycle#initialization', async () => {
    initRes = await rpc('initialize', {
      protocolVersion: SPEC_VERSION,
      capabilities: { roots: { listChanged: true }, sampling: {} },
      clientInfo: { name: 'mcp-compliance', version: '1.0.0' },
    });
    const result = initRes.body?.result;
    if (!result) return { passed: false, details: 'No result in response' };
    serverInfo.protocolVersion = result.protocolVersion || null;
    serverInfo.name = result.serverInfo?.name || null;
    serverInfo.version = result.serverInfo?.version || null;
    serverInfo.capabilities = result.capabilities || {};
    return { passed: !!result.protocolVersion, details: `Protocol: ${result.protocolVersion || 'missing'}` };
  });

  await test('lifecycle-proto-version', 'Returns valid protocol version', 'lifecycle', true, 'basic/lifecycle#version-negotiation', async () => {
    const version = initRes?.body?.result?.protocolVersion;
    if (!version) return { passed: false, details: 'No protocolVersion' };
    const valid = /^\d{4}-\d{2}-\d{2}$/.test(version);
    return { passed: valid, details: `Version: ${version}` };
  });

  await test('lifecycle-server-info', 'Includes serverInfo', 'lifecycle', false, 'basic/lifecycle#initialization', async () => {
    const info = initRes?.body?.result?.serverInfo;
    return { passed: !!info?.name, details: info ? `${info.name} v${info.version || '?'}` : 'Missing serverInfo' };
  });

  await test('lifecycle-capabilities', 'Returns capabilities object', 'lifecycle', true, 'basic/lifecycle#capability-negotiation', async () => {
    const caps = initRes?.body?.result?.capabilities;
    if (!caps || typeof caps !== 'object') return { passed: false, details: 'No capabilities object in response' };
    const declared = Object.keys(caps).filter(k => caps[k] !== undefined);
    return { passed: true, details: declared.length > 0 ? `Capabilities: ${declared.join(', ')}` : 'Empty capabilities (valid)' };
  });

  await test('lifecycle-jsonrpc', 'Response is valid JSON-RPC 2.0', 'lifecycle', true, 'basic', async () => {
    const body = initRes?.body;
    const valid = body?.jsonrpc === '2.0' && body?.id !== undefined && (body?.result !== undefined || body?.error !== undefined);
    return { passed: valid, details: valid ? 'Valid JSON-RPC 2.0 response' : `Missing fields: jsonrpc=${body?.jsonrpc}, id=${body?.id}` };
  });

  // Send initialized notification
  await mcpNotification(backendUrl, 'notifications/initialized');

  // ── 2b. LIFECYCLE: Ping ───────────────────────────────────────────

  await test('lifecycle-ping', 'Responds to ping', 'lifecycle', true, 'basic/utilities#ping', async () => {
    const res = await rpc('ping');
    const body = res.body;
    if (body?.error) return { passed: false, details: `Error: ${body.error.message}` };
    if (body?.result !== undefined) return { passed: true, details: 'Ping responded successfully' };
    return { passed: false, details: 'No result in ping response' };
  });

  // ── 3. TOOLS ──────────────────────────────────────────────────────

  const hasTools = !!serverInfo.capabilities.tools;

  await test('tools-list', 'tools/list returns valid response', 'tools', hasTools, 'server/tools#listing-tools', async () => {
    const res = await rpc('tools/list');
    const tools = res.body?.result?.tools;
    if (!Array.isArray(tools)) return { passed: false, details: 'No tools array in result' };
    toolCount = tools.length;
    toolNames = tools.map((t: any) => t.name).filter(Boolean);
    return { passed: true, details: `${toolCount} tool(s): ${toolNames.slice(0, 5).join(', ')}${toolCount > 5 ? '...' : ''}` };
  });

  await test('tools-schema', 'All tools have name and inputSchema', 'schema', hasTools, 'server/tools#data-types', async () => {
    const res = await rpc('tools/list');
    const tools = res.body?.result?.tools || [];
    const issues: string[] = [];
    const warnings: string[] = [];
    for (const tool of tools) {
      if (!tool.name) { issues.push('Tool missing name'); continue; }
      if (tool.name.length > 128 || !/^[A-Za-z0-9_.\-]+$/.test(tool.name)) {
        issues.push(`${tool.name}: name format invalid`);
      }
      if (!tool.description) warnings.push(`${tool.name}: missing description`);
      if (!tool.inputSchema) {
        issues.push(`${tool.name}: missing inputSchema (required)`);
      } else if (typeof tool.inputSchema !== 'object' || tool.inputSchema === null) {
        issues.push(`${tool.name}: inputSchema must be a valid JSON Schema object`);
      } else if (tool.inputSchema.type !== 'object') {
        issues.push(`${tool.name}: inputSchema.type must be "object" (got "${tool.inputSchema.type || 'undefined'}")`);
      }
    }
    const detail = issues.length === 0
      ? (warnings.length > 0 ? `Schemas valid. Warnings: ${warnings.join('; ')}` : 'All tools have valid schemas')
      : issues.join('; ');
    return { passed: issues.length === 0, details: detail };
  });

  if (toolNames.length > 0) {
    await test('tools-call', 'tools/call responds correctly', 'tools', false, 'server/tools#calling-tools', async () => {
      const res = await rpc('tools/call', { name: toolNames[0], arguments: {} });
      const result = res.body?.result;
      const error = res.body?.error;
      if (error) {
        const code = error.code;
        if (code === -32602 || code === -32600) {
          return { passed: true, details: `Invalid params error (acceptable): code ${code}` };
        }
        return { passed: true, details: `Protocol error: code ${code} — ${error.message}` };
      }
      if (result?.content && Array.isArray(result.content)) {
        const badItems = result.content.filter((c: any) => !c.type);
        if (badItems.length > 0) return { passed: false, details: `${badItems.length} content item(s) missing 'type' field` };
        return { passed: true, details: `Returned ${result.content.length} content item(s)` };
      }
      if (result?.isError && result?.content && Array.isArray(result.content)) {
        return { passed: true, details: 'Tool returned execution error with content (valid)' };
      }
      return { passed: false, details: 'Response missing content array' };
    });

    await test('tools-call-unknown', 'Returns error for unknown tool name', 'errors', false, 'server/tools#error-handling', async () => {
      const res = await rpc('tools/call', { name: '__nonexistent_tool_compliance_test__', arguments: {} });
      const error = res.body?.error;
      const isError = res.body?.result?.isError;
      if (error) return { passed: true, details: `Error code: ${error.code} — ${error.message}` };
      if (isError) return { passed: true, details: 'Tool execution error with isError=true (valid)' };
      return { passed: false, details: 'No error returned for nonexistent tool' };
    });
  }

  // ── 4. RESOURCES ──────────────────────────────────────────────────

  const hasResources = !!serverInfo.capabilities.resources;

  if (hasResources) {
    await test('resources-list', 'resources/list returns valid response', 'resources', true, 'server/resources#listing-resources', async () => {
      const res = await rpc('resources/list');
      const resources = res.body?.result?.resources;
      if (!Array.isArray(resources)) return { passed: false, details: 'No resources array' };
      resourceCount = resources.length;
      return { passed: true, details: `${resourceCount} resource(s)` };
    });

    await test('resources-schema', 'Resources have uri and name', 'schema', true, 'server/resources#data-types', async () => {
      const res = await rpc('resources/list');
      const resources = res.body?.result?.resources || [];
      const issues: string[] = [];
      for (const r of resources) {
        if (!r.uri) issues.push('Resource missing uri');
        else {
          try { new URL(r.uri); } catch { issues.push(`${r.uri}: invalid URI format`); }
        }
        if (!r.name) issues.push(`${r.uri || '?'}: missing name`);
      }
      return { passed: issues.length === 0, details: issues.length === 0 ? 'All resources valid' : issues.join('; ') };
    });

    if (resourceCount > 0) {
      await test('resources-read', 'resources/read returns content', 'resources', false, 'server/resources#reading-resources', async () => {
        const listRes = await rpc('resources/list');
        const firstUri = listRes.body?.result?.resources?.[0]?.uri;
        if (!firstUri) return { passed: false, details: 'No resource URI to test' };
        const readRes = await rpc('resources/read', { uri: firstUri });
        const contents = readRes.body?.result?.contents;
        if (!Array.isArray(contents)) return { passed: false, details: 'No contents array' };
        const issues: string[] = [];
        for (const c of contents) {
          if (!c.uri) issues.push('Content item missing uri');
          if (!c.text && !c.blob) issues.push(`Content item for ${c.uri || '?'} missing both text and blob`);
        }
        if (issues.length > 0) return { passed: false, details: issues.join('; ') };
        return { passed: true, details: `Read ${contents.length} content item(s) from ${firstUri}` };
      });
    }

    await test('resources-templates', 'resources/templates/list returns valid response', 'resources', false, 'server/resources#resource-templates', async () => {
      const res = await rpc('resources/templates/list');
      const error = res.body?.error;
      if (error) {
        if (error.code === -32601) return { passed: true, details: 'Method not supported (acceptable)' };
        return { passed: false, details: `Error: ${error.message}` };
      }
      const templates = res.body?.result?.resourceTemplates;
      if (!Array.isArray(templates)) return { passed: false, details: 'No resourceTemplates array' };
      const issues: string[] = [];
      for (const t of templates) {
        if (!t.uriTemplate) issues.push('Template missing uriTemplate');
        if (!t.name) issues.push(`${t.uriTemplate || '?'}: missing name`);
      }
      if (issues.length > 0) return { passed: false, details: issues.join('; ') };
      return { passed: true, details: `${templates.length} resource template(s)` };
    });
  }

  // ── 5. PROMPTS ────────────────────────────────────────────────────

  const hasPrompts = !!serverInfo.capabilities.prompts;

  if (hasPrompts) {
    let promptNames: string[] = [];

    await test('prompts-list', 'prompts/list returns valid response', 'prompts', true, 'server/prompts#listing-prompts', async () => {
      const res = await rpc('prompts/list');
      const prompts = res.body?.result?.prompts;
      if (!Array.isArray(prompts)) return { passed: false, details: 'No prompts array' };
      promptCount = prompts.length;
      promptNames = prompts.map((p: any) => p.name).filter(Boolean);
      return { passed: true, details: `${promptCount} prompt(s): ${promptNames.slice(0, 5).join(', ')}${promptCount > 5 ? '...' : ''}` };
    });

    await test('prompts-schema', 'Prompts have name field', 'schema', true, 'server/prompts#data-types', async () => {
      const res = await rpc('prompts/list');
      const prompts = res.body?.result?.prompts || [];
      const issues: string[] = [];
      for (const p of prompts) {
        if (!p.name) issues.push('Prompt missing name');
        if (p.arguments && !Array.isArray(p.arguments)) issues.push(`${p.name || '?'}: arguments must be an array`);
        if (Array.isArray(p.arguments)) {
          for (const arg of p.arguments) {
            if (!arg.name) issues.push(`${p.name}: argument missing name`);
          }
        }
      }
      return { passed: issues.length === 0, details: issues.length === 0 ? 'All prompts valid' : issues.join('; ') };
    });

    if (promptNames.length > 0) {
      await test('prompts-get', 'prompts/get returns valid messages', 'prompts', false, 'server/prompts#getting-a-prompt', async () => {
        const res = await rpc('prompts/get', { name: promptNames[0] });
        const error = res.body?.error;
        if (error) return { passed: true, details: `Error (may need arguments): code ${error.code}` };
        const messages = res.body?.result?.messages;
        if (!Array.isArray(messages)) return { passed: false, details: 'No messages array in result' };
        const issues: string[] = [];
        for (const msg of messages) {
          if (!msg.role || !['user', 'assistant'].includes(msg.role)) issues.push(`Invalid role: ${msg.role}`);
          if (!msg.content) issues.push('Message missing content');
        }
        if (issues.length > 0) return { passed: false, details: issues.join('; ') };
        return { passed: true, details: `${messages.length} message(s) from ${promptNames[0]}` };
      });
    }
  }

  // ── 6. ERROR HANDLING ─────────────────────────────────────────────

  await test('error-unknown-method', 'Returns JSON-RPC error for unknown method', 'errors', true, 'basic', async () => {
    const res = await rpc('nonexistent/method');
    const error = res.body?.error;
    if (!error) return { passed: false, details: 'No JSON-RPC error returned for unknown method' };
    const correctCode = error.code === -32601;
    return {
      passed: true,
      details: `Error code: ${error.code}${correctCode ? ' (correct: Method not found)' : ' (expected -32601)'} — ${error.message}`,
    };
  });

  await test('error-method-code', 'Uses correct JSON-RPC error code for unknown method', 'errors', false, 'basic', async () => {
    const res = await rpc('nonexistent/method');
    const error = res.body?.error;
    if (!error) return { passed: false, details: 'No error returned' };
    return { passed: error.code === -32601, details: `Expected -32601, got ${error.code}` };
  });

  await test('error-invalid-jsonrpc', 'Handles malformed JSON-RPC', 'errors', true, 'basic', async () => {
    const res = await request(backendUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ not: 'a valid jsonrpc message' }),
      signal: AbortSignal.timeout(10000),
    });
    const text = await res.body.text();
    try {
      const body = JSON.parse(text);
      if (body?.error) {
        const correctCode = body.error.code === -32600;
        return { passed: true, details: `Error code: ${body.error.code}${correctCode ? ' (correct: Invalid Request)' : ''} — ${body.error.message}` };
      }
    } catch {}
    if (res.statusCode >= 400 && res.statusCode < 500) return { passed: true, details: `HTTP ${res.statusCode} (acceptable)` };
    return { passed: false, details: `HTTP ${res.statusCode} — expected JSON-RPC error or 4xx status` };
  });

  await test('error-invalid-json', 'Handles invalid JSON body', 'errors', false, 'basic', async () => {
    const res = await request(backendUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{this is not valid json!!!',
      signal: AbortSignal.timeout(10000),
    });
    const text = await res.body.text();
    try {
      const body = JSON.parse(text);
      if (body?.error) return { passed: true, details: `Error code: ${body.error.code} — ${body.error.message}` };
    } catch {}
    if (res.statusCode >= 400 && res.statusCode < 500) return { passed: true, details: `HTTP ${res.statusCode} (acceptable)` };
    return { passed: false, details: `HTTP ${res.statusCode} — expected parse error or 4xx status` };
  });

  await test('error-missing-params', 'Returns error for tools/call without name', 'errors', false, 'server/tools#error-handling', async () => {
    const res = await rpc('tools/call', {});
    const error = res.body?.error;
    const isError = res.body?.result?.isError;
    if (error) {
      const correctCode = error.code === -32602;
      return { passed: true, details: `Error code: ${error.code}${correctCode ? ' (correct: Invalid params)' : ''} — ${error.message}` };
    }
    if (isError) return { passed: true, details: 'Tool execution error (valid)' };
    return { passed: false, details: 'No error for tools/call without name' };
  });

  // ── Compute score ─────────────────────────────────────────────────

  const { score, grade, overall, summary, categories } = computeScore(tests);
  const badge = generateBadge(url);

  return {
    specVersion: SPEC_VERSION,
    url,
    timestamp: new Date().toISOString(),
    score,
    grade,
    overall,
    summary,
    categories,
    tests,
    serverInfo,
    toolCount,
    toolNames,
    resourceCount,
    promptCount,
    badge,
  };
}
