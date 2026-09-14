import { beforeAll, describe, expect, it } from "vitest";
import {
  checkPagination,
  summarizeIssues,
  validateCachingHints,
  validateContentBlocks,
  validateInputRequired,
  validatePromptMessages,
  validatePromptSchemas,
  validateResourceContents,
  validateResourceSchemas,
  validateResourceTemplates,
  validateToolAnnotations,
  validateToolOutputSchemas,
  validateToolSchemas,
  validateToolTitles,
} from "../checks/validators.js";
import { pickPrompt, pickTool } from "../suites/modern/features.js";
import type { ComplianceReport } from "../types.js";
import {
  type FixtureOptions,
  passedIds,
  resultOf,
  runModern,
  startHttpFixture,
  stdioFixture,
} from "./helpers/modern-fixture.js";

/**
 * The tools / resources / prompts / schema tests of the 2026-07-28 suite
 * (src/suites/modern/features.ts + schema.ts) driven through the real
 * runner against the modern fixture, on stdio AND HTTP: every id passes
 * on the clean fixture, and each fixture knob turns exactly the checks it
 * violates red. Checks the fixture has no knob for are pinned at the
 * validator seam at the bottom of the file.
 */

const TOOLS_IDS = [
  "tools-list",
  "tools-list-caching",
  "tools-list-deterministic-order",
  "tools-call",
  "tools-content-types",
  "tools-pagination",
];
const RESOURCES_IDS = [
  "resources-list",
  "resources-list-caching",
  "resources-read",
  "resources-read-caching",
  "resources-not-found",
  "resources-templates",
  "resources-templates-caching",
  "resources-pagination",
];
const PROMPTS_IDS = ["prompts-list", "prompts-list-caching", "prompts-get", "prompts-pagination"];
const SCHEMA_IDS = [
  "tools-schema",
  "tools-annotations",
  "tools-title-field",
  "tools-output-schema",
  "prompts-schema",
  "resources-schema",
];
const ALL_IDS = [...TOOLS_IDS, ...RESOURCES_IDS, ...PROMPTS_IDS, ...SCHEMA_IDS];

/** R* in the design: required when the capability is declared (the fixture declares all three). */
const REQUIRED_IDS = [
  "tools-list",
  "tools-list-caching",
  "tools-call",
  "tools-content-types",
  "resources-list",
  "resources-list-caching",
  "resources-read",
  "resources-read-caching",
  "resources-not-found",
  "prompts-list",
  "prompts-list-caching",
  "prompts-get",
];

/**
 * lifecycle-discover rides along so the capability gates are populated
 * whichever way the lifecycle module obtains the discover result under
 * `--only`; nothing below asserts on it.
 */
const ONLY = ["lifecycle-discover", ...ALL_IDS];

const CACHING_IDS = [
  "tools-list-caching",
  "resources-list-caching",
  "resources-read-caching",
  "resources-templates-caching",
  "prompts-list-caching",
];

type Kind = "stdio" | "http";

function allPass(ids: string[]): Record<string, string> {
  return Object.fromEntries(ids.map((id) => [id, "pass"]));
}

/** Expected passedIds() map: everything passes except `failing`. */
function expectFailing(report: ComplianceReport, failing: string[]) {
  const actual = passedIds(report, ALL_IDS);
  const passing = ALL_IDS.filter((id) => !failing.includes(id));
  expect(Object.fromEntries(passing.map((id) => [id, actual[id]]))).toEqual(allPass(passing));
  for (const id of failing) expect(actual[id], id).toMatch(/^FAIL: /);
}

async function run(kind: Kind, opts: FixtureOptions = {}): Promise<ComplianceReport> {
  if (kind === "stdio") return runModern(stdioFixture(opts).target, { only: ONLY });
  const fixture = await startHttpFixture(opts);
  try {
    return await runModern(fixture.target, { only: ONLY });
  } finally {
    await fixture.stop();
  }
}

describe.each<Kind>(["stdio", "http"])("2026-07-28 features + schema over %s", (kind) => {
  describe("clean fixture", () => {
    let report: ComplianceReport;
    beforeAll(async () => {
      report = await run(kind);
    });

    it("passes every tools / resources / prompts / schema test", () => {
      expect(passedIds(report, ALL_IDS)).toEqual(allPass(ALL_IDS));
    });

    it("calls the first tool with no required arguments and validates all five content types", () => {
      expect(resultOf(report, "tools-call").details).toBe("content_types: returned 5 content item(s)");
      expect(resultOf(report, "tools-content-types").details).toBe(
        "content_types: content types: text, image, audio, resource, resource_link",
      );
    });

    it("reports the caching hints it saw", () => {
      for (const id of CACHING_IDS) expect(resultOf(report, id).details).toContain('ttlMs=60000 cacheScope="public"');
    });

    it("gets the prompt with no required arguments", () => {
      expect(resultOf(report, "prompts-get").details).toBe("1 message(s) from simple");
    });

    it("reads the first listed resource and finds -32602 + data.uri for a missing one", () => {
      expect(resultOf(report, "resources-read").details).toBe("read 1 content item(s) from test://static-text");
      expect(resultOf(report, "resources-not-found").details).toBe(
        "nonexistent URI -> JSON-RPC error -32602 with data.uri",
      );
    });

    it("accepts an outputSchema whose root is not type object", () => {
      expect(resultOf(report, "tools-output-schema").details).toBe("1 tool(s) with valid outputSchema");
    });

    it("marks the R* tests required and the optional ones not", () => {
      for (const id of ALL_IDS) expect(resultOf(report, id).required, id).toBe(REQUIRED_IDS.includes(id));
    });

    it("fills the report counts from the cached lists", () => {
      expect(report.toolCount).toBe(11);
      expect(report.toolNames.slice(0, 3)).toEqual(["echo", "add", "content_types"]);
      expect(report.resourceCount).toBe(2);
      expect(report.resourceNames).toEqual(["static-text", "static-binary"]);
      expect(report.promptCount).toBe(2);
      expect(report.promptNames).toEqual(["simple", "greet"]);
    });
  });

  describe("fixture knobs", () => {
    it("no-caching: every caching-hints test fails naming the missing fields", async () => {
      const report = await run(kind, { breaks: ["no-caching"] });
      expectFailing(report, CACHING_IDS);
      for (const id of CACHING_IDS) expect(resultOf(report, id).details).toContain("ttlMs missing; cacheScope missing");
    });

    it("bad-caching: negative ttlMs and an unknown cacheScope fail", async () => {
      const report = await run(kind, { breaks: ["bad-caching"] });
      expectFailing(report, CACHING_IDS);
      const details = resultOf(report, "tools-list-caching").details;
      expect(details).toContain("ttlMs must be >= 0 (got -1)");
      expect(details).toContain('cacheScope must be "public" or "private" (got "shared")');
    });

    it("unstable-tool-order: the same set in a different order fails", async () => {
      const report = await run(kind, { breaks: ["unstable-tool-order"] });
      expectFailing(report, ["tools-list-deterministic-order"]);
      expect(resultOf(report, "tools-list-deterministic-order").details).toMatch(
        /order differs between calls: \[echo, add/,
      );
    });

    it("resource-not-found-legacy: the retired -32002 fails", async () => {
      const report = await run(kind, { breaks: ["resource-not-found-legacy"] });
      expectFailing(report, ["resources-not-found"]);
      expect(resultOf(report, "resources-not-found").details).toContain("-32002 is retired");
    });

    it("resource-not-found-no-uri: passes with a data.uri warning", async () => {
      const report = await run(kind, { breaks: ["resource-not-found-no-uri"] });
      expectFailing(report, []);
      expect(resultOf(report, "resources-not-found").details).toBe("nonexistent URI -> JSON-RPC error -32602");
      expect(report.warnings.some((w) => w.includes("error.data.uri is missing"))).toBe(true);
    });

    it("empty-contents-not-found: an empty contents array for a missing URI fails", async () => {
      const report = await run(kind, { breaks: ["empty-contents-not-found"] });
      expectFailing(report, ["resources-not-found"]);
      expect(resultOf(report, "resources-not-found").details).toContain("an empty contents array");
    });

    it("tool-no-input-schema: tools-schema fails and tools-call falls back to the first tool", async () => {
      const report = await run(kind, { breaks: ["tool-no-input-schema"] });
      expectFailing(report, ["tools-schema"]);
      const details = resultOf(report, "tools-schema").details;
      expect(details).toContain("echo: missing inputSchema (required)");
      expect(details).toContain("... and 8 more");
      expect(details.length).toBeLessThanOrEqual(220);
      expect(resultOf(report, "tools-call").details).toBe("echo: returned 1 content item(s)");
    });

    it("tool-no-input-schema under --only schema / --only tools-schema: the list is fetched on demand and tools-schema still fails", async () => {
      // The features module does not run under either filter, so the
      // schema module must fetch tools/list itself instead of skip-passing
      // a check the user asked for by name.
      const runOnly = async (only: string[]) => {
        if (kind === "stdio") return runModern(stdioFixture({ breaks: ["tool-no-input-schema"] }).target, { only });
        const fixture = await startHttpFixture({ breaks: ["tool-no-input-schema"] });
        try {
          return await runModern(fixture.target, { only });
        } finally {
          await fixture.stop();
        }
      };
      const byCategory = await runOnly(["schema"]);
      expect(byCategory.tests.map((t) => t.id).slice(0, SCHEMA_IDS.length)).toEqual(SCHEMA_IDS);
      const schemaResult = resultOf(byCategory, "tools-schema");
      expect(schemaResult.passed, schemaResult.details).toBe(false);
      expect(schemaResult.details).toContain("echo: missing inputSchema (required)");
      expect(passedIds(byCategory, ["tools-annotations", "prompts-schema", "resources-schema"])).toEqual(
        allPass(["tools-annotations", "prompts-schema", "resources-schema"]),
      );
      expect(resultOf(byCategory, "resources-schema").details).toBe("All 2 resource(s) valid");
      // Each list was fetched exactly once for the whole category.
      expect(byCategory.toolCount).toBe(11);
      expect(byCategory.promptCount).toBe(2);
      // Before the fix this run scored 100 with "skipped: no tools list available".
      expect(byCategory.score).toBeLessThan(100);

      const byId = await runOnly(["tools-schema"]);
      expect(byId.tests.map((t) => t.id)).toEqual(["tools-schema"]);
      expect(resultOf(byId, "tools-schema").passed).toBe(false);
      expect(resultOf(byId, "tools-schema").details).toContain("echo: missing inputSchema (required)");
    });

    it("capabilities-mismatch: the prompts tests are absent when prompts is not declared", async () => {
      const report = await run(kind, { breaks: ["capabilities-mismatch"] });
      const present = new Set(report.tests.map((t) => t.id));
      for (const id of [...PROMPTS_IDS, "prompts-schema"]) expect(present.has(id), id).toBe(false);
      const rest = ALL_IDS.filter((id) => !id.startsWith("prompts-"));
      expect(passedIds(report, rest)).toEqual(allPass(rest));
    });
  });
});

// ── Checks the fixture cannot break: pinned at the validator seam ──

describe("validators", () => {
  it("validateToolSchemas rejects bad names, missing and non-object inputSchema, wrong root type", () => {
    const bad = [
      { name: "ok", inputSchema: { type: "object" } },
      { inputSchema: { type: "object" } },
      { name: "has space", inputSchema: { type: "object" } },
      { name: "no_schema" },
      { name: "null_schema", inputSchema: null },
      { name: "string_schema", inputSchema: "x" },
      { name: "array_root", inputSchema: { type: "array" } },
      "not-an-object",
    ];
    const v = validateToolSchemas(bad);
    expect(v.issues).toEqual([
      "Tool missing name",
      "has space: name format invalid (expected [A-Za-z0-9_.-]{1,128})",
      "no_schema: missing inputSchema (required)",
      "null_schema: missing inputSchema (required)",
      "string_schema: inputSchema must be a valid JSON Schema object",
      'array_root: inputSchema.type must be "object" (got "array")',
      'Tool entry is not an object ("not-an-object")',
    ]);
    expect(v.warnings).toContain('Tool "ok" missing description');
    expect(validateToolSchemas([{ name: "a.b-c_1", description: "d", inputSchema: { type: "object" } }])).toEqual({
      issues: [],
      warnings: [],
    });
  });

  it("validateToolAnnotations rejects non-boolean hints, a non-string title and a non-object block", () => {
    const v = validateToolAnnotations([
      { name: "fine", annotations: { readOnlyHint: true, title: "T" } },
      { name: "none" },
      { name: "str", annotations: { destructiveHint: "no" } },
      { name: "title", annotations: { title: 3 } },
      { name: "arr", annotations: [] },
    ]);
    expect(v.annotated).toBe(4);
    expect(v.issues).toEqual([
      "str: annotations.destructiveHint should be boolean, got string",
      "title: annotations.title should be a string, got number",
      "arr: annotations must be an object",
    ]);
  });

  it("validateToolTitles rejects a non-string title and lists the tools without one", () => {
    const v = validateToolTitles([{ name: "a", title: "A" }, { name: "b" }, { name: "c", title: 1 }]);
    expect(v.withTitle).toEqual(["a"]);
    expect(v.withoutTitle).toEqual(["b"]);
    expect(v.issues).toEqual(["c: title should be a string, got number"]);
  });

  it("validateToolOutputSchemas accepts any object root and rejects null / non-object", () => {
    expect(validateToolOutputSchemas([{ name: "int", outputSchema: { type: "integer" } }, { name: "none" }])).toEqual({
      issues: [],
      withSchema: 1,
    });
    const v = validateToolOutputSchemas([
      { name: "nul", outputSchema: null },
      { name: "str", outputSchema: "object" },
      { name: "arr", outputSchema: [] },
    ]);
    expect(v.withSchema).toBe(3);
    expect(v.issues).toEqual([
      "nul: outputSchema must be a JSON Schema object (got null)",
      'str: outputSchema must be a JSON Schema object (got "object")',
      "arr: outputSchema must be a JSON Schema object (got [])",
    ]);
  });

  it("validatePromptSchemas rejects a nameless prompt, non-array arguments and a nameless argument", () => {
    const v = validatePromptSchemas([
      { name: "ok", description: "d", arguments: [{ name: "x" }] },
      { description: "no name" },
      { name: "obj", arguments: {} },
      { name: "anon", arguments: [{ required: true }] },
    ]);
    expect(v.issues).toEqual(["Prompt missing name", "obj: arguments must be an array", "anon: argument missing name"]);
    expect(v.warnings).toEqual(['Prompt "obj" missing description', 'Prompt "anon" missing description']);
  });

  it("validateResourceSchemas rejects an unparseable uri and a missing name, warns on description/mimeType", () => {
    const v = validateResourceSchemas([
      { uri: "test://a", name: "a", description: "d", mimeType: "text/plain" },
      { uri: "not a uri", name: "b" },
      { uri: "test://c" },
      { name: "no-uri" },
    ]);
    expect(v.issues).toEqual(["not a uri: invalid URI format", "test://c: missing name", "Resource missing uri"]);
    expect(v.warnings).toContain('Resource "test://c" missing description');
    expect(v.warnings).toContain('Resource "b" missing mimeType');
  });

  it("validateResourceTemplates rejects a missing uriTemplate / name and warns on a template without {params}", () => {
    const v = validateResourceTemplates([
      { uriTemplate: "test://{id}", name: "t", description: "d" },
      { name: "no-template" },
      { uriTemplate: 5, name: "num" },
      { uriTemplate: "test://flat", name: "flat" },
      { uriTemplate: "test://{x}" },
    ]);
    expect(v.issues).toEqual([
      "Template missing uriTemplate",
      "uriTemplate should be a string, got number",
      "test://{x}: missing name",
    ]);
    expect(v.warnings).toContain('Template "flat" has no URI template parameters (e.g., {id})');
  });

  it("validateContentBlocks rejects unknown and missing types", () => {
    const v = validateContentBlocks([{ type: "text", text: "x" }, { type: "video" }, { text: "untyped" }, "junk"]);
    expect(v.types).toEqual(["text"]);
    expect(v.issues).toEqual([
      'Unknown content type: "video"',
      "Content item missing type field",
      "Content item missing type field",
    ]);
  });

  it("validateResourceContents rejects items without uri or without text/blob, accepts empty text", () => {
    expect(
      validateResourceContents([
        { uri: "u", text: "" },
        { uri: "b", blob: "AAEC" },
      ]).issues,
    ).toEqual([]);
    expect(validateResourceContents([{ text: "x" }, { uri: "m" }, { uri: "n", text: 5 }]).issues).toEqual([
      "Content item missing uri",
      "Content item for m missing both text and blob",
      "Content item for n missing both text and blob",
    ]);
  });

  it("validatePromptMessages rejects a bad role and a missing content block", () => {
    const v = validatePromptMessages([
      { role: "user", content: { type: "text", text: "hi" } },
      { role: "system", content: { type: "text", text: "x" } },
      { role: "assistant" },
    ]);
    expect(v.issues).toEqual(['Invalid role: "system"', "Message missing content"]);
  });

  it("validateCachingHints rejects missing, non-integer and negative ttlMs and a bad cacheScope", () => {
    expect(validateCachingHints({ ttlMs: 0, cacheScope: "private" }).issues).toEqual([]);
    expect(validateCachingHints({}).issues).toEqual(["ttlMs missing", "cacheScope missing"]);
    expect(validateCachingHints({ ttlMs: 1.5, cacheScope: "public" }).issues).toEqual([
      "ttlMs must be an integer (got 1.5)",
    ]);
    expect(validateCachingHints({ ttlMs: "60", cacheScope: "public" }).issues).toEqual([
      'ttlMs must be an integer (got "60")',
    ]);
    expect(validateCachingHints({ ttlMs: -1, cacheScope: "shared" }).issues).toEqual([
      "ttlMs must be >= 0 (got -1)",
      'cacheScope must be "public" or "private" (got "shared")',
    ]);
  });

  it("validateInputRequired needs inputRequests or requestState and typed entries", () => {
    expect(validateInputRequired({ resultType: "input_required" }).issues).toEqual([
      "input_required result has neither inputRequests nor requestState",
    ]);
    expect(validateInputRequired({ resultType: "input_required", requestState: 1 }).issues).toEqual([
      "requestState must be a string (got 1)",
    ]);
    expect(
      validateInputRequired({ resultType: "input_required", inputRequests: { a: { params: {} } } }).issues,
    ).toEqual(["inputRequests.a must be { method, params }"]);
    const ok = validateInputRequired({
      resultType: "input_required",
      inputRequests: { user_name: { method: "elicitation/create", params: {} } },
      requestState: "s",
    });
    expect(ok).toEqual({ issues: [], requestKeys: ["user_name"], hasRequestState: true });
  });

  it("checkPagination walks nextCursor and fails on a bad cursor type or a broken second page", async () => {
    const pages =
      (second: unknown, cursor: unknown = "c1") =>
      async (_m: string, params?: Record<string, unknown>) =>
        params?.cursor === undefined ? { result: { tools: [1, 2], nextCursor: cursor, cacheScope: "public" } } : second;
    const ok = await checkPagination(pages({ result: { tools: [3], cacheScope: "public" } }), "tools/list", "tools");
    expect(ok).toEqual({ passed: true, details: "Pagination works: page 1 had 2 tools, page 2 had 1", warnings: [] });
    expect(await checkPagination(pages(null, 7), "tools/list", "tools")).toMatchObject({
      passed: false,
      details: "nextCursor should be string, got number",
    });
    expect(await checkPagination(pages({ error: { code: -32602 } }), "tools/list", "tools")).toMatchObject({
      passed: false,
      details: "Next page failed: tools/list with cursor returned error -32602",
    });
    expect(await checkPagination(pages({ result: {} }), "tools/list", "tools")).toMatchObject({
      passed: false,
      details: "Next page failed to return tools array",
    });
    const scoped = await checkPagination(
      pages({ result: { tools: [], cacheScope: "private" } }),
      "tools/list",
      "tools",
    );
    expect(scoped.passed).toBe(true);
    expect(scoped.warnings[0]).toContain("cacheScope differs between pages");
    expect(await checkPagination(async () => ({ error: { code: -32601 } }), "prompts/list", "prompts")).toMatchObject({
      passed: false,
      details: "No result from prompts/list (JSON-RPC error -32601)",
    });
    expect(await checkPagination(async () => ({ result: { tools: [] } }), "tools/list", "tools")).toMatchObject({
      passed: true,
      details: "0 tools, no nextCursor (single page)",
    });
  });

  it("pickTool prefers a tool with no required properties; pickPrompt prefers a prompt with no required args", () => {
    const tools = [
      { name: "needs", inputSchema: { type: "object", required: ["x"] } },
      { name: "free", inputSchema: { type: "object", properties: {} } },
    ];
    expect(pickTool(tools)?.name).toBe("free");
    expect(pickTool([tools[0]])?.name).toBe("needs");
    expect(pickTool([{ name: "bare" }])?.name).toBe("bare");
    expect(pickTool([])).toBeUndefined();
    const prompts = [
      { name: "greet", arguments: [{ name: "who", required: true }, { name: "tone" }] },
      { name: "simple", arguments: [{ name: "opt", required: false }] },
    ];
    expect(pickPrompt(prompts)).toEqual({ name: "simple", requiredArgs: [] });
    expect(pickPrompt([prompts[0]])).toEqual({ name: "greet", requiredArgs: ["who"] });
    expect(pickPrompt([])).toBeUndefined();
  });

  it("summarizeIssues caps the count and the length", () => {
    expect(summarizeIssues(["a", "b"])).toBe("a; b");
    expect(summarizeIssues(["a", "b", "c", "d", "e"])).toBe("a; b; c; ... and 2 more");
    expect(summarizeIssues(["x".repeat(300)]).length).toBe(220);
  });
});
