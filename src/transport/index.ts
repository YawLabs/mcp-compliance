/**
 * Transport abstraction. Lets the runner drive MCP servers over any
 * protocol (Streamable HTTP today, stdio next). Each transport maps the
 * common operations — send a JSON-RPC request, send a notification —
 * onto its own wire format.
 *
 * HTTP-specific fields (`statusCode`, `headers`) are optional on the
 * response so stdio can omit them. Tests that rely on those fields are
 * gated by transport kind at the runner level.
 */

export type TransportKind = "http" | "stdio";

export interface TransportRequestInit {
  timeout: number;
  /** HTTP only: extra headers for this specific request */
  headers?: Record<string, string>;
}

export interface TransportResponse {
  /** Parsed JSON-RPC body. May be `{ _raw: string }` when parse fails. */
  body: unknown;
  /** The JSON-RPC id sent on the request. */
  requestId: number;
  /** HTTP only. */
  statusCode?: number;
  /** HTTP only. */
  headers?: Record<string, string>;
}

export interface TransportNotifyResult {
  /** HTTP only. */
  statusCode?: number;
  /** HTTP only. */
  headers?: Record<string, string>;
}

export interface Transport {
  readonly kind: TransportKind;
  /**
   * Send a JSON-RPC request. The transport allocates the id via the
   * provided counter so tests can correlate.
   */
  request(
    method: string,
    params: unknown | undefined,
    nextId: () => number,
    init: TransportRequestInit,
  ): Promise<TransportResponse>;
  /** Send a JSON-RPC notification (no id, no response body). */
  notify(method: string, params: unknown | undefined, init: TransportRequestInit): Promise<TransportNotifyResult>;
  /** Release any underlying resources (HTTP: no-op; stdio: terminate child). */
  close(): Promise<void>;
  /** Session state shared across tests. */
  setSessionId(id: string | null): void;
  setProtocolVersion(version: string | null): void;
  getSessionId(): string | null;
  getProtocolVersion(): string | null;
}

export type { HttpTransport } from "./http.js";
export { createHttpTransport } from "./http.js";
