import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkPagination,
  errorCodeText,
  errorWithCode,
  type RpcBodyCall,
  validateInputRequired,
  validatePromptMessages,
  validateResourceContents,
  validateResourceTemplates,
} from "../checks/validators.js";
import { createModernClient } from "../modern/client.js";
import { createRecorder } from "../recorder.js";
import { MODERN_SPEC_VERSION } from "../spec.js";
import { createHttpTransport } from "../transport/http.js";

/**
 * src/checks/validators.ts on the shapes a misbehaving server sends that the
 * object-shaped cases in modern-features.test.ts do not reach: a list call
 * whose first page is not a list result, a non-numeric error code, and
 * entries that are not objects at all. The body of an HTTP error page is
 * produced by the real HTTP transport and client, so the validator sees
 * exactly what the modern suite hands it.
 */

describe("checkPagination: a first page that is not a list result", () => {
  let server: Server;
  let url = "";

  beforeAll(async () => {
    // A tools/list endpoint whose framework answers with a plain-text 500.
    server = createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("upstream exploded");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("an HTTP 500 text/plain page fails as no result from the method", async () => {
    const transport = createHttpTransport({ url });
    let id = 1;
    const client = createModernClient({
      transport,
      recorder: createRecorder(),
      nextId: () => id++,
      timeout: 5000,
      protocolVersion: MODERN_SPEC_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "validators-test", version: "0.0.0" },
    });
    // The same adapter features.ts builds around ctx.client.rpc.
    const rpc: RpcBodyCall = async (m, params) => (await client.rpc(m, params)).body;
    try {
      // What reaches the validator: the transport's wrapper for a non-JSON body.
      expect(await rpc("tools/list")).toEqual({ _raw: "upstream exploded" });
      expect(await checkPagination(rpc, "tools/list", "tools")).toEqual({
        passed: false,
        details: "No result from tools/list",
        warnings: [],
      });
    } finally {
      await transport.close();
    }
  });

  it("a result without the list array fails naming the key, even when it carries a nextCursor", async () => {
    let calls = 0;
    const rpc: RpcBodyCall = async () => {
      calls++;
      return { jsonrpc: "2.0", id: 1, result: { nextCursor: "c1", ttlMs: 0, cacheScope: "public" } };
    };
    expect(await checkPagination(rpc, "resources/list", "resources")).toEqual({
      passed: false,
      details: "No resources array",
      warnings: [],
    });
    // The cursor of a page with no list is not followed.
    expect(calls).toBe(1);
  });

  it("an error whose code is not an integer is still an error on either page, named as the server sent it", async () => {
    const stringCode = { jsonrpc: "2.0", id: 1, error: { code: "E_LIST", message: "boom" } };
    expect(await checkPagination(async () => stringCode, "tools/list", "tools")).toEqual({
      passed: false,
      details: 'No result from tools/list (JSON-RPC error with non-integer code "E_LIST")',
      warnings: [],
    });
    const secondPageFails: RpcBodyCall = async (_m, params) =>
      params?.cursor === undefined ? { result: { tools: [1], nextCursor: "c1" } } : stringCode;
    expect(await checkPagination(secondPageFails, "tools/list", "tools")).toEqual({
      passed: false,
      details: 'Next page failed: tools/list with cursor returned error with non-integer code "E_LIST"',
      warnings: [],
    });
  });

  it("an error with no code at all is 'no code', never NaN; a long non-integer code is clipped", async () => {
    const noCode = { jsonrpc: "2.0", id: 1, error: { message: "boom" } };
    expect((await checkPagination(async () => noCode, "prompts/list", "prompts")).details).toBe(
      "No result from prompts/list (JSON-RPC error with no code)",
    );
    const secondPageFails: RpcBodyCall = async (_m, params) =>
      params?.cursor === undefined ? { result: { prompts: [], nextCursor: "c1" } } : noCode;
    expect((await checkPagination(secondPageFails, "prompts/list", "prompts")).details).toBe(
      "Next page failed: prompts/list with cursor returned error with no code",
    );
    const longCode = { error: { code: `E_${"X".repeat(60)}` } };
    expect((await checkPagination(async () => longCode, "tools/list", "tools")).details).toBe(
      `No result from tools/list (JSON-RPC error with non-integer code "E_${"X".repeat(34)}...)`,
    );
  });
});

describe("errorCodeText / errorWithCode: one rendering of a JSON-RPC error code for every detail", () => {
  it("an integer as is; anything else as sent, clipped; a missing member as 'no code'", () => {
    expect(errorCodeText(-32601)).toBe("-32601");
    expect(errorCodeText("E_LIST")).toBe('non-integer code "E_LIST"');
    expect(errorCodeText("-32601")).toBe('non-integer code "-32601"');
    expect(errorCodeText(1.5)).toBe("non-integer code 1.5");
    expect(errorCodeText(null)).toBe("non-integer code null");
    expect(errorCodeText(undefined)).toBe("no code");
    expect(errorWithCode(-32601)).toBe("JSON-RPC error -32601");
    expect(errorWithCode(undefined)).toBe("JSON-RPC error with no code");
    expect(errorWithCode("E_LIST", "error")).toBe('error with non-integer code "E_LIST"');
  });
});

describe("validators: entries that are not objects", () => {
  it("validateInputRequired flags an inputRequests array instead of the keyed object", () => {
    expect(
      validateInputRequired({
        resultType: "input_required",
        inputRequests: [{ method: "elicitation/create", params: {} }],
      }),
    ).toEqual({
      // brief() caps the rendering at 40 characters.
      issues: ['inputRequests must be an object (got [{"method":"elicitation/create","para...)'],
      requestKeys: [],
      hasRequestState: false,
    });
    // A valid requestState next to it does not excuse the wrong type.
    expect(
      validateInputRequired({ resultType: "input_required", inputRequests: "elicit", requestState: "s" }).issues,
    ).toEqual(['inputRequests must be an object (got "elicit")']);
  });

  it("validateResourceContents names a non-object item and still checks the ones after it", () => {
    expect(validateResourceContents(["x", { uri: "u", text: "" }, 7, { uri: "v" }]).issues).toEqual([
      'Content item is not an object ("x")',
      "Content item is not an object (7)",
      "Content item for v missing both text and blob",
    ]);
  });

  it("validatePromptMessages names a null or array message instead of throwing on it", () => {
    expect(
      validatePromptMessages([null, { role: "user", content: { type: "text", text: "hi" } }, ["assistant"]]).issues,
    ).toEqual(["Message is not an object (null)", 'Message is not an object (["assistant"])']);
  });

  it("validateResourceTemplates names a non-object entry and warns only about the real templates", () => {
    expect(validateResourceTemplates([1, { uriTemplate: "test://{id}", name: "t", description: "d" }, "tpl"])).toEqual({
      issues: ["Template entry is not an object (1)", 'Template entry is not an object ("tpl")'],
      warnings: [],
    });
  });
});
