#!/usr/bin/env node

// src/index.ts
import { Command } from "commander";
import chalk2 from "chalk";

// src/runner.ts
import { request } from "undici";

// src/grader.ts
function computeGrade(score) {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 40) return "D";
  return "F";
}
function computeScore(tests) {
  const total = tests.length;
  const passed = tests.filter((t) => t.passed).length;
  const failed = total - passed;
  const requiredTests = tests.filter((t) => t.required);
  const requiredPassed = requiredTests.filter((t) => t.passed).length;
  const requiredScore = requiredTests.length > 0 ? requiredPassed / requiredTests.length * 70 : 70;
  const optionalTests = tests.filter((t) => !t.required);
  const optionalPassed = optionalTests.filter((t) => t.passed).length;
  const optionalScore = optionalTests.length > 0 ? optionalPassed / optionalTests.length * 30 : 30;
  const score = Math.round(requiredScore + optionalScore);
  const overall = requiredPassed === requiredTests.length ? passed === total ? "pass" : "partial" : "fail";
  const categories = {};
  for (const t of tests) {
    if (!categories[t.category]) categories[t.category] = { passed: 0, total: 0 };
    categories[t.category].total++;
    if (t.passed) categories[t.category].passed++;
  }
  return {
    score,
    grade: computeGrade(score),
    overall,
    summary: { total, passed, failed, required: requiredTests.length, requiredPassed },
    categories
  };
}

// src/badge.ts
function generateBadge(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    parsed = new URL("https://unknown");
  }
  const hostname = parsed.hostname;
  const encoded = encodeURIComponent(hostname);
  const imageUrl = `https://mcp.hosting/api/compliance/${encoded}/badge`;
  const reportUrl = `https://mcp.hosting/compliance/${encoded}`;
  return {
    imageUrl,
    reportUrl,
    markdown: `[![MCP Compliant](${imageUrl})](${reportUrl})`,
    html: `<a href="${reportUrl}"><img src="${imageUrl}" alt="MCP Compliant"></a>`
  };
}

// src/runner.ts
var SPEC_VERSION = "2025-11-25";
var SPEC_BASE = `https://modelcontextprotocol.io/specification/${SPEC_VERSION}`;
function createIdCounter() {
  let id = 0;
  return () => ++id;
}
var _defaultNextId = createIdCounter();
async function mcpRequest(backendUrl, method, params, nextId = _defaultNextId) {
  const id = nextId();
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    params: params || {}
  });
  const res = await request(backendUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream"
    },
    body,
    signal: AbortSignal.timeout(15e3)
  });
  const text = await res.body.text();
  const responseHeaders = {};
  for (const [k, v] of Object.entries(res.headers)) {
    if (typeof v === "string") responseHeaders[k] = v;
  }
  try {
    return { statusCode: res.statusCode, body: JSON.parse(text), headers: responseHeaders };
  } catch {
    return { statusCode: res.statusCode, body: { _raw: text }, headers: responseHeaders };
  }
}
async function mcpNotification(backendUrl, method, params) {
  await request(backendUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, ...params ? { params } : {} }),
    signal: AbortSignal.timeout(5e3)
  }).then((r) => r.body.text()).catch(() => {
  });
}
async function runComplianceSuite(url, options = {}) {
  let parsed;
  try {
    parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("Only HTTP and HTTPS URLs are supported");
    }
  } catch (e) {
    if (e.message.includes("Only HTTP")) throw e;
    throw new Error(`Invalid URL: ${url}`);
  }
  const backendUrl = url;
  const tests = [];
  const nextId = createIdCounter();
  const rpc = (method, params) => mcpRequest(backendUrl, method, params, nextId);
  let serverInfo = {
    protocolVersion: null,
    name: null,
    version: null,
    capabilities: {}
  };
  let toolCount = 0;
  let toolNames = [];
  let resourceCount = 0;
  let promptCount = 0;
  async function test(id, name, category, required, specRef, fn) {
    const start = Date.now();
    try {
      const result = await fn();
      tests.push({
        id,
        name,
        category,
        required,
        passed: result.passed,
        details: result.details,
        durationMs: Date.now() - start,
        specRef: `${SPEC_BASE}/${specRef}`
      });
      options.onProgress?.(id, result.passed, result.details);
    } catch (err) {
      tests.push({
        id,
        name,
        category,
        required,
        passed: false,
        details: `Error: ${err.message}`,
        durationMs: Date.now() - start,
        specRef: `${SPEC_BASE}/${specRef}`
      });
      options.onProgress?.(id, false, `Error: ${err.message}`);
    }
  }
  await test("transport-post", "HTTP POST accepted", "transport", true, "basic/transports#streamable-http", async () => {
    const res = await request(backendUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      signal: AbortSignal.timeout(1e4)
    });
    await res.body.text();
    const passed = res.statusCode >= 200 && res.statusCode < 300;
    const note = res.statusCode === 401 || res.statusCode === 403 ? " (auth required)" : "";
    return { passed, details: `HTTP ${res.statusCode}${note}` };
  });
  await test("transport-content-type", "Responds with JSON or SSE", "transport", true, "basic/transports#streamable-http", async () => {
    const res = await request(backendUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      signal: AbortSignal.timeout(1e4)
    });
    await res.body.text();
    const rawCt = res.headers["content-type"];
    const ct = (Array.isArray(rawCt) ? rawCt[0] : rawCt || "").toLowerCase();
    const valid = ct.includes("application/json") || ct.includes("text/event-stream");
    return { passed: valid, details: `Content-Type: ${ct}` };
  });
  let initRes = null;
  await test("lifecycle-init", "Initialize handshake", "lifecycle", true, "basic/lifecycle#initialization", async () => {
    initRes = await rpc("initialize", {
      protocolVersion: SPEC_VERSION,
      capabilities: { roots: { listChanged: true }, sampling: {} },
      clientInfo: { name: "mcp-compliance", version: "1.0.0" }
    });
    const result = initRes.body?.result;
    if (!result) return { passed: false, details: "No result in response" };
    serverInfo.protocolVersion = result.protocolVersion || null;
    serverInfo.name = result.serverInfo?.name || null;
    serverInfo.version = result.serverInfo?.version || null;
    serverInfo.capabilities = result.capabilities || {};
    return { passed: !!result.protocolVersion, details: `Protocol: ${result.protocolVersion || "missing"}` };
  });
  await test("lifecycle-proto-version", "Returns valid protocol version", "lifecycle", true, "basic/lifecycle#version-negotiation", async () => {
    const version = initRes?.body?.result?.protocolVersion;
    if (!version) return { passed: false, details: "No protocolVersion" };
    const valid = /^\d{4}-\d{2}-\d{2}$/.test(version);
    return { passed: valid, details: `Version: ${version}` };
  });
  await test("lifecycle-server-info", "Includes serverInfo", "lifecycle", false, "basic/lifecycle#initialization", async () => {
    const info = initRes?.body?.result?.serverInfo;
    return { passed: !!info?.name, details: info ? `${info.name} v${info.version || "?"}` : "Missing serverInfo" };
  });
  await test("lifecycle-capabilities", "Returns capabilities object", "lifecycle", true, "basic/lifecycle#capability-negotiation", async () => {
    const caps = initRes?.body?.result?.capabilities;
    if (!caps || typeof caps !== "object") return { passed: false, details: "No capabilities object in response" };
    const declared = Object.keys(caps).filter((k) => caps[k] !== void 0);
    return { passed: true, details: declared.length > 0 ? `Capabilities: ${declared.join(", ")}` : "Empty capabilities (valid)" };
  });
  await test("lifecycle-jsonrpc", "Response is valid JSON-RPC 2.0", "lifecycle", true, "basic", async () => {
    const body = initRes?.body;
    const valid = body?.jsonrpc === "2.0" && body?.id !== void 0 && (body?.result !== void 0 || body?.error !== void 0);
    return { passed: valid, details: valid ? "Valid JSON-RPC 2.0 response" : `Missing fields: jsonrpc=${body?.jsonrpc}, id=${body?.id}` };
  });
  await mcpNotification(backendUrl, "notifications/initialized");
  await test("lifecycle-ping", "Responds to ping", "lifecycle", true, "basic/utilities#ping", async () => {
    const res = await rpc("ping");
    const body = res.body;
    if (body?.error) return { passed: false, details: `Error: ${body.error.message}` };
    if (body?.result !== void 0) return { passed: true, details: "Ping responded successfully" };
    return { passed: false, details: "No result in ping response" };
  });
  const hasTools = !!serverInfo.capabilities.tools;
  await test("tools-list", "tools/list returns valid response", "tools", hasTools, "server/tools#listing-tools", async () => {
    const res = await rpc("tools/list");
    const tools = res.body?.result?.tools;
    if (!Array.isArray(tools)) return { passed: false, details: "No tools array in result" };
    toolCount = tools.length;
    toolNames = tools.map((t) => t.name).filter(Boolean);
    return { passed: true, details: `${toolCount} tool(s): ${toolNames.slice(0, 5).join(", ")}${toolCount > 5 ? "..." : ""}` };
  });
  await test("tools-schema", "All tools have name and inputSchema", "schema", hasTools, "server/tools#data-types", async () => {
    const res = await rpc("tools/list");
    const tools = res.body?.result?.tools || [];
    const issues = [];
    const warnings = [];
    for (const tool of tools) {
      if (!tool.name) {
        issues.push("Tool missing name");
        continue;
      }
      if (tool.name.length > 128 || !/^[A-Za-z0-9_.\-]+$/.test(tool.name)) {
        issues.push(`${tool.name}: name format invalid`);
      }
      if (!tool.description) warnings.push(`${tool.name}: missing description`);
      if (!tool.inputSchema) {
        issues.push(`${tool.name}: missing inputSchema (required)`);
      } else if (typeof tool.inputSchema !== "object" || tool.inputSchema === null) {
        issues.push(`${tool.name}: inputSchema must be a valid JSON Schema object`);
      } else if (tool.inputSchema.type !== "object") {
        issues.push(`${tool.name}: inputSchema.type must be "object" (got "${tool.inputSchema.type || "undefined"}")`);
      }
    }
    const detail = issues.length === 0 ? warnings.length > 0 ? `Schemas valid. Warnings: ${warnings.join("; ")}` : "All tools have valid schemas" : issues.join("; ");
    return { passed: issues.length === 0, details: detail };
  });
  if (toolNames.length > 0) {
    await test("tools-call", "tools/call responds correctly", "tools", false, "server/tools#calling-tools", async () => {
      const res = await rpc("tools/call", { name: toolNames[0], arguments: {} });
      const result = res.body?.result;
      const error = res.body?.error;
      if (error) {
        const code = error.code;
        if (code === -32602 || code === -32600) {
          return { passed: true, details: `Invalid params error (acceptable): code ${code}` };
        }
        return { passed: true, details: `Protocol error: code ${code} \u2014 ${error.message}` };
      }
      if (result?.content && Array.isArray(result.content)) {
        const badItems = result.content.filter((c) => !c.type);
        if (badItems.length > 0) return { passed: false, details: `${badItems.length} content item(s) missing 'type' field` };
        return { passed: true, details: `Returned ${result.content.length} content item(s)` };
      }
      if (result?.isError && result?.content && Array.isArray(result.content)) {
        return { passed: true, details: "Tool returned execution error with content (valid)" };
      }
      return { passed: false, details: "Response missing content array" };
    });
    await test("tools-call-unknown", "Returns error for unknown tool name", "errors", false, "server/tools#error-handling", async () => {
      const res = await rpc("tools/call", { name: "__nonexistent_tool_compliance_test__", arguments: {} });
      const error = res.body?.error;
      const isError = res.body?.result?.isError;
      if (error) return { passed: true, details: `Error code: ${error.code} \u2014 ${error.message}` };
      if (isError) return { passed: true, details: "Tool execution error with isError=true (valid)" };
      return { passed: false, details: "No error returned for nonexistent tool" };
    });
  }
  const hasResources = !!serverInfo.capabilities.resources;
  if (hasResources) {
    await test("resources-list", "resources/list returns valid response", "resources", true, "server/resources#listing-resources", async () => {
      const res = await rpc("resources/list");
      const resources = res.body?.result?.resources;
      if (!Array.isArray(resources)) return { passed: false, details: "No resources array" };
      resourceCount = resources.length;
      return { passed: true, details: `${resourceCount} resource(s)` };
    });
    await test("resources-schema", "Resources have uri and name", "schema", true, "server/resources#data-types", async () => {
      const res = await rpc("resources/list");
      const resources = res.body?.result?.resources || [];
      const issues = [];
      for (const r of resources) {
        if (!r.uri) issues.push("Resource missing uri");
        else {
          try {
            new URL(r.uri);
          } catch {
            issues.push(`${r.uri}: invalid URI format`);
          }
        }
        if (!r.name) issues.push(`${r.uri || "?"}: missing name`);
      }
      return { passed: issues.length === 0, details: issues.length === 0 ? "All resources valid" : issues.join("; ") };
    });
    if (resourceCount > 0) {
      await test("resources-read", "resources/read returns content", "resources", false, "server/resources#reading-resources", async () => {
        const listRes = await rpc("resources/list");
        const firstUri = listRes.body?.result?.resources?.[0]?.uri;
        if (!firstUri) return { passed: false, details: "No resource URI to test" };
        const readRes = await rpc("resources/read", { uri: firstUri });
        const contents = readRes.body?.result?.contents;
        if (!Array.isArray(contents)) return { passed: false, details: "No contents array" };
        const issues = [];
        for (const c of contents) {
          if (!c.uri) issues.push("Content item missing uri");
          if (!c.text && !c.blob) issues.push(`Content item for ${c.uri || "?"} missing both text and blob`);
        }
        if (issues.length > 0) return { passed: false, details: issues.join("; ") };
        return { passed: true, details: `Read ${contents.length} content item(s) from ${firstUri}` };
      });
    }
    await test("resources-templates", "resources/templates/list returns valid response", "resources", false, "server/resources#resource-templates", async () => {
      const res = await rpc("resources/templates/list");
      const error = res.body?.error;
      if (error) {
        if (error.code === -32601) return { passed: true, details: "Method not supported (acceptable)" };
        return { passed: false, details: `Error: ${error.message}` };
      }
      const templates = res.body?.result?.resourceTemplates;
      if (!Array.isArray(templates)) return { passed: false, details: "No resourceTemplates array" };
      const issues = [];
      for (const t of templates) {
        if (!t.uriTemplate) issues.push("Template missing uriTemplate");
        if (!t.name) issues.push(`${t.uriTemplate || "?"}: missing name`);
      }
      if (issues.length > 0) return { passed: false, details: issues.join("; ") };
      return { passed: true, details: `${templates.length} resource template(s)` };
    });
  }
  const hasPrompts = !!serverInfo.capabilities.prompts;
  if (hasPrompts) {
    let promptNames = [];
    await test("prompts-list", "prompts/list returns valid response", "prompts", true, "server/prompts#listing-prompts", async () => {
      const res = await rpc("prompts/list");
      const prompts = res.body?.result?.prompts;
      if (!Array.isArray(prompts)) return { passed: false, details: "No prompts array" };
      promptCount = prompts.length;
      promptNames = prompts.map((p) => p.name).filter(Boolean);
      return { passed: true, details: `${promptCount} prompt(s): ${promptNames.slice(0, 5).join(", ")}${promptCount > 5 ? "..." : ""}` };
    });
    await test("prompts-schema", "Prompts have name field", "schema", true, "server/prompts#data-types", async () => {
      const res = await rpc("prompts/list");
      const prompts = res.body?.result?.prompts || [];
      const issues = [];
      for (const p of prompts) {
        if (!p.name) issues.push("Prompt missing name");
        if (p.arguments && !Array.isArray(p.arguments)) issues.push(`${p.name || "?"}: arguments must be an array`);
        if (Array.isArray(p.arguments)) {
          for (const arg of p.arguments) {
            if (!arg.name) issues.push(`${p.name}: argument missing name`);
          }
        }
      }
      return { passed: issues.length === 0, details: issues.length === 0 ? "All prompts valid" : issues.join("; ") };
    });
    if (promptNames.length > 0) {
      await test("prompts-get", "prompts/get returns valid messages", "prompts", false, "server/prompts#getting-a-prompt", async () => {
        const res = await rpc("prompts/get", { name: promptNames[0] });
        const error = res.body?.error;
        if (error) return { passed: true, details: `Error (may need arguments): code ${error.code}` };
        const messages = res.body?.result?.messages;
        if (!Array.isArray(messages)) return { passed: false, details: "No messages array in result" };
        const issues = [];
        for (const msg of messages) {
          if (!msg.role || !["user", "assistant"].includes(msg.role)) issues.push(`Invalid role: ${msg.role}`);
          if (!msg.content) issues.push("Message missing content");
        }
        if (issues.length > 0) return { passed: false, details: issues.join("; ") };
        return { passed: true, details: `${messages.length} message(s) from ${promptNames[0]}` };
      });
    }
  }
  await test("error-unknown-method", "Returns JSON-RPC error for unknown method", "errors", true, "basic", async () => {
    const res = await rpc("nonexistent/method");
    const error = res.body?.error;
    if (!error) return { passed: false, details: "No JSON-RPC error returned for unknown method" };
    const correctCode = error.code === -32601;
    return {
      passed: true,
      details: `Error code: ${error.code}${correctCode ? " (correct: Method not found)" : " (expected -32601)"} \u2014 ${error.message}`
    };
  });
  await test("error-method-code", "Uses correct JSON-RPC error code for unknown method", "errors", false, "basic", async () => {
    const res = await rpc("nonexistent/method");
    const error = res.body?.error;
    if (!error) return { passed: false, details: "No error returned" };
    return { passed: error.code === -32601, details: `Expected -32601, got ${error.code}` };
  });
  await test("error-invalid-jsonrpc", "Handles malformed JSON-RPC", "errors", true, "basic", async () => {
    const res = await request(backendUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ not: "a valid jsonrpc message" }),
      signal: AbortSignal.timeout(1e4)
    });
    const text = await res.body.text();
    try {
      const body = JSON.parse(text);
      if (body?.error) {
        const correctCode = body.error.code === -32600;
        return { passed: true, details: `Error code: ${body.error.code}${correctCode ? " (correct: Invalid Request)" : ""} \u2014 ${body.error.message}` };
      }
    } catch {
    }
    if (res.statusCode >= 400 && res.statusCode < 500) return { passed: true, details: `HTTP ${res.statusCode} (acceptable)` };
    return { passed: false, details: `HTTP ${res.statusCode} \u2014 expected JSON-RPC error or 4xx status` };
  });
  await test("error-invalid-json", "Handles invalid JSON body", "errors", false, "basic", async () => {
    const res = await request(backendUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{this is not valid json!!!",
      signal: AbortSignal.timeout(1e4)
    });
    const text = await res.body.text();
    try {
      const body = JSON.parse(text);
      if (body?.error) return { passed: true, details: `Error code: ${body.error.code} \u2014 ${body.error.message}` };
    } catch {
    }
    if (res.statusCode >= 400 && res.statusCode < 500) return { passed: true, details: `HTTP ${res.statusCode} (acceptable)` };
    return { passed: false, details: `HTTP ${res.statusCode} \u2014 expected parse error or 4xx status` };
  });
  await test("error-missing-params", "Returns error for tools/call without name", "errors", false, "server/tools#error-handling", async () => {
    const res = await rpc("tools/call", {});
    const error = res.body?.error;
    const isError = res.body?.result?.isError;
    if (error) {
      const correctCode = error.code === -32602;
      return { passed: true, details: `Error code: ${error.code}${correctCode ? " (correct: Invalid params)" : ""} \u2014 ${error.message}` };
    }
    if (isError) return { passed: true, details: "Tool execution error (valid)" };
    return { passed: false, details: "No error for tools/call without name" };
  });
  const { score, grade, overall, summary, categories } = computeScore(tests);
  const badge = generateBadge(url);
  return {
    specVersion: SPEC_VERSION,
    url,
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
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
    badge
  };
}

// src/reporter.ts
import chalk from "chalk";
var CATEGORY_LABELS = {
  transport: "Transport",
  lifecycle: "Lifecycle",
  tools: "Tools",
  resources: "Resources",
  prompts: "Prompts",
  errors: "Error Handling",
  schema: "Schema Validation"
};
var CATEGORY_ORDER = ["transport", "lifecycle", "tools", "resources", "prompts", "errors", "schema"];
function gradeColor(grade) {
  switch (grade) {
    case "A":
      return chalk.green.bold(grade);
    case "B":
      return chalk.greenBright.bold(grade);
    case "C":
      return chalk.yellow.bold(grade);
    case "D":
      return chalk.rgb(255, 165, 0).bold(grade);
    case "F":
      return chalk.red.bold(grade);
  }
}
function overallColor(overall) {
  switch (overall) {
    case "pass":
      return chalk.green.bold("PASS");
    case "partial":
      return chalk.yellow.bold("PARTIAL");
    case "fail":
      return chalk.red.bold("FAIL");
    default:
      return overall;
  }
}
function testLine(t) {
  const icon = t.passed ? chalk.green("  PASS") : chalk.red("  FAIL");
  const req = t.required ? chalk.dim(" (required)") : "";
  const dur = chalk.dim(` ${t.durationMs}ms`);
  return `${icon}  ${t.name}${req}${dur}
${chalk.dim(`         ${t.details}`)}`;
}
function formatTerminal(report) {
  const lines = [];
  lines.push("");
  lines.push(chalk.bold("MCP Compliance Report"));
  lines.push(chalk.dim(`Spec: ${report.specVersion}  |  ${report.timestamp}`));
  lines.push(chalk.dim(`URL: ${report.url}`));
  if (report.serverInfo.name) {
    lines.push(chalk.dim(`Server: ${report.serverInfo.name} v${report.serverInfo.version || "?"} (protocol ${report.serverInfo.protocolVersion || "?"})`));
  }
  lines.push("");
  lines.push(`  Grade: ${gradeColor(report.grade)}  Score: ${chalk.bold(String(report.score))}%  Overall: ${overallColor(report.overall)}`);
  lines.push(`  Tests: ${chalk.green(String(report.summary.passed))} passed / ${chalk.red(String(report.summary.failed))} failed / ${report.summary.total} total`);
  lines.push(`  Required: ${report.summary.requiredPassed}/${report.summary.required} passed`);
  const grouped = {};
  for (const t of report.tests) {
    if (!grouped[t.category]) grouped[t.category] = [];
    grouped[t.category].push(t);
  }
  for (const cat of CATEGORY_ORDER) {
    const catTests = grouped[cat];
    if (!catTests || catTests.length === 0) continue;
    const catStats = report.categories[cat];
    const label = CATEGORY_LABELS[cat] || cat;
    const catColor = catStats && catStats.passed === catStats.total ? chalk.green : chalk.yellow;
    lines.push("");
    lines.push(catColor(`  ${label} (${catStats?.passed || 0}/${catStats?.total || 0})`));
    for (const t of catTests) {
      lines.push(testLine(t));
    }
  }
  if (report.toolCount > 0) {
    lines.push("");
    lines.push(chalk.dim(`  Tools (${report.toolCount}): ${report.toolNames.slice(0, 10).join(", ")}${report.toolCount > 10 ? "..." : ""}`));
  }
  if (report.resourceCount > 0) {
    lines.push(chalk.dim(`  Resources: ${report.resourceCount}`));
  }
  if (report.promptCount > 0) {
    lines.push(chalk.dim(`  Prompts: ${report.promptCount}`));
  }
  lines.push("");
  lines.push(chalk.dim("  Badge markdown:"));
  lines.push(`  ${report.badge.markdown}`);
  lines.push("");
  return lines.join("\n");
}
function formatJson(report) {
  return JSON.stringify(report, null, 2);
}

// src/index.ts
var program = new Command();
program.name("mcp-compliance").description("Test MCP servers for spec compliance").version("0.1.0");
program.command("test").description("Run the full compliance test suite against an MCP server").argument("<url>", "MCP server URL to test").option("--format <format>", "Output format: terminal or json", "terminal").option("--strict", "Exit with code 1 on any required test failure (for CI)").action(async (url, opts) => {
  try {
    if (opts.format === "terminal") {
      console.log(chalk2.dim(`
Testing ${url}...
`));
    }
    const report = await runComplianceSuite(url);
    if (opts.format === "json") {
      console.log(formatJson(report));
    } else {
      console.log(formatTerminal(report));
    }
    if (opts.strict && report.overall === "fail") {
      process.exit(1);
    }
  } catch (err) {
    if (opts.format === "json") {
      console.error(JSON.stringify({ error: err.message }));
    } else {
      console.error(chalk2.red(`
Error: ${err.message}
`));
    }
    process.exit(1);
  }
});
program.command("badge").description("Run tests and output just the badge markdown embed code").argument("<url>", "MCP server URL to test").action(async (url) => {
  try {
    console.log(chalk2.dim(`
Testing ${url}...
`));
    const report = await runComplianceSuite(url);
    console.log(`Grade: ${report.grade} (${report.score}%)
`);
    console.log(report.badge.markdown);
    console.log("");
  } catch (err) {
    console.error(chalk2.red(`
Error: ${err.message}
`));
    process.exit(1);
  }
});
program.parse();
