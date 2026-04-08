import { describe, expect, it } from "vitest";
import { parseSSEResponse } from "../runner.js";

describe("parseSSEResponse", () => {
  it("parses a basic JSON-RPC response", () => {
    const text = 'data: {"jsonrpc":"2.0","id":1,"result":{}}\n\n';
    const result = parseSSEResponse(text);
    expect(result).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  });

  it("returns the last JSON-RPC response when multiple events exist", () => {
    const text = [
      'data: {"jsonrpc":"2.0","id":1,"result":{"first":true}}',
      "",
      'data: {"jsonrpc":"2.0","id":2,"result":{"second":true}}',
      "",
    ].join("\n");
    const result = parseSSEResponse(text);
    expect(result).toEqual({ jsonrpc: "2.0", id: 2, result: { second: true } });
  });

  it("handles multi-line data fields concatenated with newlines", () => {
    const text = ['data: {"jsonrpc":"2.0",', 'data: "id":1,', 'data: "result":{}}', ""].join("\n");
    const result = parseSSEResponse(text);
    expect(result).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  });

  it("handles trailing data without final empty line", () => {
    const text = 'data: {"jsonrpc":"2.0","id":1,"result":{}}';
    const result = parseSSEResponse(text);
    expect(result).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  });

  it("returns null for empty input", () => {
    expect(parseSSEResponse("")).toBeNull();
  });

  it("returns null for non-JSON data", () => {
    const text = "data: hello world\n\n";
    expect(parseSSEResponse(text)).toBeNull();
  });

  it("ignores comment lines (starting with colon)", () => {
    const text = [": this is a comment", 'data: {"jsonrpc":"2.0","id":1,"result":{}}', ""].join("\n");
    const result = parseSSEResponse(text);
    expect(result).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  });

  it("ignores event: and id: fields", () => {
    const text = ["event: message", "id: 42", 'data: {"jsonrpc":"2.0","id":1,"result":{}}', ""].join("\n");
    const result = parseSSEResponse(text);
    expect(result).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  });

  it("handles data: with leading space stripped", () => {
    const text = 'data: {"jsonrpc":"2.0","id":1,"result":{}}\n\n';
    const result = parseSSEResponse(text);
    expect(result.id).toBe(1);
  });

  it("handles data: without leading space", () => {
    const text = 'data:{"jsonrpc":"2.0","id":1,"result":{}}\n\n';
    const result = parseSSEResponse(text);
    expect(result.id).toBe(1);
  });

  it("ignores non-JSON-RPC JSON objects", () => {
    const text = 'data: {"status":"ok"}\n\n';
    const result = parseSSEResponse(text);
    // Not a JSON-RPC response (no jsonrpc field or no id field)
    expect(result).toBeNull();
  });

  it("skips notifications (JSON-RPC without id)", () => {
    const text = [
      'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}',
      "",
      'data: {"jsonrpc":"2.0","id":1,"result":{}}',
      "",
    ].join("\n");
    const result = parseSSEResponse(text);
    expect(result.id).toBe(1);
  });

  it("handles empty data fields", () => {
    const text = ["data:", "", 'data: {"jsonrpc":"2.0","id":1,"result":{}}', ""].join("\n");
    const result = parseSSEResponse(text);
    expect(result).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  });
});
