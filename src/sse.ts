/**
 * Parse a Server-Sent Events response body and extract the first
 * JSON-RPC response message. Returns null if none found.
 *
 * Handles multi-line `data:` fields per the SSE spec; ignores `event:`,
 * `id:`, `retry:` and comment lines.
 */
export function parseSSEResponse(text: string): any {
  for (const parsed of parseSSEMessages(text)) {
    // Keep the first JSON-RPC response (the actual result).
    // Later events may be notifications that lack an id — skip those.
    if (parsed && typeof parsed === "object" && (parsed as any).jsonrpc === "2.0" && (parsed as any).id !== undefined) {
      return parsed;
    }
  }
  return null;
}

/**
 * Parse a complete SSE body into every JSON message it carries, in wire
 * order — responses AND notifications. Events whose data is not valid
 * JSON are skipped. Used by the modern (2026-07-28) suite, where the
 * response stream of a request also carries `notifications/progress`,
 * `notifications/message`, and the `subscriptions/listen` traffic.
 */
export function parseSSEMessages(text: string): unknown[] {
  const decoder = createSSEDecoder();
  const out: unknown[] = [];
  for (const data of decoder.push(text)) out.push(...jsonOrNothing(data));
  for (const data of decoder.flush()) out.push(...jsonOrNothing(data));
  return out;
}

function jsonOrNothing(data: string): unknown[] {
  if (!data.trim()) return [];
  try {
    return [JSON.parse(data)];
  } catch {
    return [];
  }
}

/**
 * Incremental SSE decoder for streaming bodies. Feed it chunks as they
 * arrive; each `push` returns the `data` payloads of every event that
 * completed inside that chunk. `flush` returns a trailing event that was
 * never terminated by a blank line (servers that close the stream right
 * after the last `data:` line).
 *
 * Accepts CRLF and LF line endings. Servers behind proxies (nginx, some
 * CDNs) can normalize to CRLF, and splitting only on "\n" would leave a
 * trailing "\r" on the field name / content, causing
 * `line.startsWith("data:")` to still match but `JSON.parse` to see
 * `{...}\r` as trailing garbage (tolerated by V8 but out-of-spec).
 */
export function createSSEDecoder(): { push(chunk: string): string[]; flush(): string[] } {
  let pending = "";
  let currentData: string[] = [];

  function takeEvent(): string | null {
    if (currentData.length === 0) return null;
    const data = currentData.join("\n");
    currentData = [];
    return data;
  }

  function consumeLine(line: string, out: string[]) {
    if (line.startsWith("data:")) {
      const content = line.slice(5);
      currentData.push(content.startsWith(" ") ? content.slice(1) : content);
    } else if (line.trim() === "") {
      const ev = takeEvent();
      if (ev !== null) out.push(ev);
    }
    // Ignore other fields: event:, id:, retry:, and comments starting with ":"
  }

  return {
    push(chunk) {
      pending += chunk;
      const out: string[] = [];
      let idx: number;
      // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic line splitter
      while ((idx = pending.indexOf("\n")) !== -1) {
        let line = pending.slice(0, idx);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        pending = pending.slice(idx + 1);
        consumeLine(line, out);
      }
      return out;
    },
    flush() {
      const out: string[] = [];
      if (pending.length > 0) {
        let line = pending;
        if (line.endsWith("\r")) line = line.slice(0, -1);
        pending = "";
        consumeLine(line, out);
      }
      const ev = takeEvent();
      if (ev !== null) out.push(ev);
      return out;
    },
  };
}
