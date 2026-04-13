import { request } from "undici";
import { parseSSEResponse } from "../sse.js";
import type { Transport, TransportNotifyResult, TransportResponse } from "./index.js";

export interface HttpTransport extends Transport {
  readonly kind: "http";
  readonly url: string;
  /**
   * Raw POST bypassing JSON-RPC framing. Used by HTTP-transport tests
   * that need to inspect wire-level behavior (status codes, rejected
   * content types, batch requests, etc.).
   */
  rawPost(
    body: string,
    extraHeaders: Record<string, string>,
    timeout: number,
  ): Promise<{ statusCode: number; body: string; headers: Record<string, string> }>;
  rawRequest(
    method: "GET" | "POST" | "DELETE",
    body: string | undefined,
    extraHeaders: Record<string, string>,
    timeout: number,
  ): Promise<{ statusCode: number; body: string; headers: Record<string, string> }>;
}

export interface HttpTransportOptions {
  url: string;
  /** Extra headers merged into every request (e.g. Authorization). */
  headers?: Record<string, string>;
}

export function createHttpTransport(opts: HttpTransportOptions): HttpTransport {
  const { url } = opts;
  const userHeaders = { ...(opts.headers ?? {}) };
  let sessionId: string | null = null;
  let protocolVersion: string | null = null;

  function sessionHeaders(): Record<string, string> {
    const h: Record<string, string> = { ...userHeaders };
    if (sessionId) h["mcp-session-id"] = sessionId;
    if (protocolVersion) h["mcp-protocol-version"] = protocolVersion;
    return h;
  }

  function normalizeHeaders(raw: Record<string, string | string[] | undefined>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  }

  async function doRawRequest(
    method: "GET" | "POST" | "DELETE",
    body: string | undefined,
    extraHeaders: Record<string, string>,
    timeout: number,
  ) {
    const headers: Record<string, string> = {
      Accept: "application/json, text/event-stream",
      ...sessionHeaders(),
      ...extraHeaders,
    };
    if (body !== undefined && !("Content-Type" in headers) && !("content-type" in headers)) {
      headers["Content-Type"] = "application/json";
    }
    const res = await request(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(timeout),
    });
    const text = await res.body.text();
    return {
      statusCode: res.statusCode,
      body: text,
      headers: normalizeHeaders(res.headers as Record<string, string | string[] | undefined>),
    };
  }

  const transport: HttpTransport = {
    kind: "http",
    url,
    async request(method, params, nextId, init): Promise<TransportResponse> {
      const id = nextId();
      const body = JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} });
      const raw = await doRawRequest("POST", body, init.headers ?? {}, init.timeout);
      const contentType = (raw.headers["content-type"] || "").toLowerCase();

      let parsed: unknown;
      if (contentType.includes("text/event-stream")) {
        const sseParsed = parseSSEResponse(raw.body);
        if (sseParsed) {
          parsed = sseParsed;
        } else {
          try {
            parsed = JSON.parse(raw.body);
          } catch {
            parsed = { _raw: raw.body };
          }
        }
      } else {
        try {
          parsed = JSON.parse(raw.body);
        } catch {
          parsed = { _raw: raw.body };
        }
      }

      return {
        body: parsed,
        requestId: id,
        statusCode: raw.statusCode,
        headers: raw.headers,
      };
    },
    async notify(method, params, init): Promise<TransportNotifyResult> {
      const body = JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
      const raw = await doRawRequest("POST", body, init.headers ?? {}, init.timeout);
      return { statusCode: raw.statusCode, headers: raw.headers };
    },
    async close() {
      /* HTTP has no persistent resources; each request opens a new connection pool entry. */
    },
    setSessionId(id) {
      sessionId = id;
    },
    setProtocolVersion(v) {
      protocolVersion = v;
    },
    getSessionId() {
      return sessionId;
    },
    getProtocolVersion() {
      return protocolVersion;
    },
    rawPost(body, extraHeaders, timeout) {
      return doRawRequest("POST", body, extraHeaders, timeout);
    },
    rawRequest(method, body, extraHeaders, timeout) {
      return doRawRequest(method, body, extraHeaders, timeout);
    },
  };

  return transport;
}
