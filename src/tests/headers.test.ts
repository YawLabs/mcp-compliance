import { describe, expect, it } from "vitest";
import {
  decodeHeaderValue,
  encodeHeaderValue,
  HEADER_METHOD,
  HEADER_NAME,
  HEADER_PROTOCOL_VERSION,
  mcpNameFor,
  mcpParamHeadersFor,
  needsBase64,
  standardHeadersFor,
} from "../modern/headers.js";

/**
 * Unit tests for the 2026-07-28 Streamable HTTP request-metadata headers
 * (basic/transports/streamable-http#request-metadata): the value
 * encoding with its `=?base64?...?=` sentinel, Mcp-Name, and the
 * `Mcp-Param-*` mirroring of `x-mcp-header` annotations -- including the
 * nested `properties` chains the schema-extension section permits.
 */

describe("header value encoding (=?base64?...?= sentinel)", () => {
  it("leaves plain RFC 9110 field values alone", () => {
    for (const v of ["echo", "us-east-1", "a b\tc", "", "~!*()"]) {
      expect(needsBase64(v)).toBe(false);
      expect(encodeHeaderValue(v)).toBe(v);
    }
  });

  it("encodes non-ASCII, control characters and surrounding whitespace", () => {
    expect(needsBase64("héllo")).toBe(true);
    expect(needsBase64("line\nbreak")).toBe(true);
    expect(needsBase64(" padded")).toBe(true);
    expect(needsBase64("padded ")).toBe(true);
    expect(encodeHeaderValue("héllo 世界")).toBe(`=?base64?${Buffer.from("héllo 世界", "utf8").toString("base64")}?=`);
    expect(encodeHeaderValue(" padded")).toBe("=?base64?IHBhZGRlZA==?=");
  });

  it("encodes a value that already looks like the sentinel so it cannot be mistaken for one", () => {
    const lookalike = "=?base64?abc?=";
    expect(needsBase64(lookalike)).toBe(true);
    const encoded = encodeHeaderValue(lookalike);
    expect(encoded).not.toBe(lookalike);
    expect(decodeHeaderValue(encoded)).toBe(lookalike);
  });

  it("round-trips through decodeHeaderValue and passes plain values through", () => {
    for (const v of ["plain", "héllo 世界 🚀", " x ", "=?base64?x?="]) {
      expect(decodeHeaderValue(encodeHeaderValue(v))).toBe(v);
    }
    expect(decodeHeaderValue("plain")).toBe("plain");
  });
});

describe("mcpNameFor", () => {
  it("mirrors params.name for tools/call and prompts/get, params.uri for resources/read", () => {
    expect(mcpNameFor("tools/call", { name: "echo" })).toBe("echo");
    expect(mcpNameFor("prompts/get", { name: "greet" })).toBe("greet");
    expect(mcpNameFor("resources/read", { uri: "test://static-text" })).toBe("test://static-text");
  });

  it("is undefined for other methods, missing params, or a non-string field", () => {
    expect(mcpNameFor("tools/list", { name: "echo" })).toBeUndefined();
    expect(mcpNameFor("tools/call", undefined)).toBeUndefined();
    expect(mcpNameFor("tools/call", { name: 42 })).toBeUndefined();
    expect(mcpNameFor("resources/read", { name: "not-a-uri" })).toBeUndefined();
  });
});

describe("mcpParamHeadersFor (x-mcp-header mirroring)", () => {
  const regional = {
    type: "object",
    properties: {
      region: { type: "string", "x-mcp-header": "Region" },
      query: { type: "string" },
      retries: { type: "integer", "x-mcp-header": "Retries" },
      dryRun: { type: "boolean", "x-mcp-header": "Dry-Run" },
    },
  };

  it("mirrors top-level string, integer and boolean arguments", () => {
    expect(mcpParamHeadersFor(regional, { region: "us-east-1", query: "q", retries: 3, dryRun: false })).toEqual({
      "Mcp-Param-Region": "us-east-1",
      "Mcp-Param-Retries": "3",
      "Mcp-Param-Dry-Run": "false",
    });
  });

  it("omits the header when the argument is absent, null, or not a primitive the spec allows", () => {
    expect(mcpParamHeadersFor(regional, { query: "q" })).toEqual({});
    expect(mcpParamHeadersFor(regional, { region: null })).toEqual({});
    expect(mcpParamHeadersFor(regional, { retries: 1.5 })).toEqual({});
    expect(mcpParamHeadersFor(regional, { region: ["us-east-1"] })).toEqual({});
    expect(mcpParamHeadersFor(regional, { region: { nested: true } })).toEqual({});
  });

  it("encodes a mirrored value that is not a plain field value", () => {
    expect(mcpParamHeadersFor(regional, { region: "région" })).toEqual({
      "Mcp-Param-Region": encodeHeaderValue("région"),
    });
  });

  it("returns nothing for a schema without properties, a non-object schema, or non-object arguments", () => {
    expect(mcpParamHeadersFor({ type: "object" }, { region: "x" })).toEqual({});
    expect(mcpParamHeadersFor(undefined, { region: "x" })).toEqual({});
    expect(mcpParamHeadersFor(regional, undefined)).toEqual({});
    expect(mcpParamHeadersFor(regional, "region=x")).toEqual({});
  });

  it("follows nested properties chains and reads the value at the exact path", () => {
    const nested = {
      type: "object",
      properties: {
        config: {
          type: "object",
          properties: {
            tenant: { type: "string", "x-mcp-header": "Tenant" },
            limits: {
              type: "object",
              properties: { max: { type: "integer", "x-mcp-header": "Max" } },
            },
          },
        },
        tenant: { type: "string" }, // same key at the root, NOT annotated
      },
    };
    expect(mcpParamHeadersFor(nested, { config: { tenant: "acme", limits: { max: 10 } }, tenant: "root" })).toEqual({
      "Mcp-Param-Tenant": "acme",
      "Mcp-Param-Max": "10",
    });
    // The value must sit at the annotated path: a root-level `tenant` does not feed config.tenant.
    expect(mcpParamHeadersFor(nested, { tenant: "root" })).toEqual({});
    // A missing intermediate object yields no header, never a throw.
    expect(mcpParamHeadersFor(nested, { config: "not-an-object" })).toEqual({});
    expect(mcpParamHeadersFor(nested, { config: { limits: null } })).toEqual({});
  });

  it("does not descend through items, composition keywords or $ref (annotations there are invalid)", () => {
    const schema = {
      type: "object",
      properties: {
        list: {
          type: "array",
          items: { type: "object", properties: { id: { type: "string", "x-mcp-header": "Id" } } },
        },
        either: { oneOf: [{ type: "object", properties: { k: { type: "string", "x-mcp-header": "K" } } }] },
        all: { allOf: [{ properties: { a: { type: "string", "x-mcp-header": "A" } } }] },
        ref: { $ref: "#/$defs/x" },
      },
      $defs: { x: { type: "object", properties: { r: { type: "string", "x-mcp-header": "R" } } } },
    };
    expect(
      mcpParamHeadersFor(schema, { list: [{ id: "1" }], either: { k: "v" }, all: { a: "b" }, ref: { r: "z" } }),
    ).toEqual({});
  });
});

describe("standardHeadersFor", () => {
  it("always carries the protocol version and method, plus Mcp-Name where the method has one", () => {
    expect(standardHeadersFor({ method: "tools/list", params: undefined, protocolVersion: "2026-07-28" })).toEqual({
      [HEADER_PROTOCOL_VERSION]: "2026-07-28",
      [HEADER_METHOD]: "tools/list",
    });
    expect(
      standardHeadersFor({ method: "prompts/get", params: { name: "greet" }, protocolVersion: "2026-07-28" }),
    ).toEqual({
      [HEADER_PROTOCOL_VERSION]: "2026-07-28",
      [HEADER_METHOD]: "prompts/get",
      [HEADER_NAME]: "greet",
    });
  });

  it("encodes a non-ASCII Mcp-Name and mirrors nested Mcp-Param-* for tools/call when the schema is given", () => {
    const headers = standardHeadersFor({
      method: "tools/call",
      params: { name: "héllo", arguments: { config: { tenant: "acme" } } },
      protocolVersion: "2026-07-28",
      toolInputSchema: {
        type: "object",
        properties: {
          config: { type: "object", properties: { tenant: { type: "string", "x-mcp-header": "Tenant" } } },
        },
      },
    });
    expect(headers[HEADER_NAME]).toBe(encodeHeaderValue("héllo"));
    expect(headers["Mcp-Param-Tenant"]).toBe("acme");
  });

  it("mirrors no Mcp-Param-* without a tool schema or for a method other than tools/call", () => {
    const schema = { type: "object", properties: { region: { type: "string", "x-mcp-header": "Region" } } };
    const noSchema = standardHeadersFor({
      method: "tools/call",
      params: { name: "regional", arguments: { region: "eu" } },
      protocolVersion: "2026-07-28",
    });
    expect(Object.keys(noSchema).some((k) => k.startsWith("Mcp-Param-"))).toBe(false);
    const wrongMethod = standardHeadersFor({
      method: "prompts/get",
      params: { name: "regional", arguments: { region: "eu" } },
      protocolVersion: "2026-07-28",
      toolInputSchema: schema,
    });
    expect(Object.keys(wrongMethod).some((k) => k.startsWith("Mcp-Param-"))).toBe(false);
  });
});
