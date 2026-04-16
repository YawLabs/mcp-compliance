/**
 * Parse a Server-Sent Events response body and extract the first
 * JSON-RPC response message. Returns null if none found.
 *
 * Handles multi-line `data:` fields per the SSE spec; ignores `event:`,
 * `id:`, `retry:` and comment lines.
 */
export function parseSSEResponse(text: string): any {
  // Accept both CRLF and LF line endings. Servers behind proxies (nginx,
  // some CDNs) can normalize to CRLF, and splitting only on "\n" would
  // leave a trailing "\r" on the field name / content, causing
  // `line.startsWith("data:")` to still match but `JSON.parse` to see
  // `{...}\r` as trailing garbage (tolerated by V8 but out-of-spec). The
  // blank-line detector `line.trim() === ""` was already CRLF-tolerant.
  const lines = text.split(/\r?\n/);
  let firstJsonRpcResponse: any = null;
  let currentData: string[] = [];

  function flushEvent() {
    if (currentData.length === 0) return;
    const data = currentData.join("\n");
    currentData = [];
    if (!data.trim()) return;
    try {
      const parsed = JSON.parse(data);
      // Keep the first JSON-RPC response (the actual result).
      // Later events may be notifications that lack an id — skip those.
      if (!firstJsonRpcResponse && parsed.jsonrpc === "2.0" && parsed.id !== undefined) {
        firstJsonRpcResponse = parsed;
      }
    } catch {
      // Not valid JSON, skip
    }
  }

  for (const line of lines) {
    if (line.startsWith("data:")) {
      const content = line.slice(5);
      currentData.push(content.startsWith(" ") ? content.slice(1) : content);
    } else if (line.trim() === "") {
      flushEvent();
    }
    // Ignore other fields: event:, id:, retry:, and comments starting with ":"
  }

  // Handle trailing data without final empty line
  flushEvent();

  return firstJsonRpcResponse;
}
