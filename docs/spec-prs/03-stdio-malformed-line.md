# Specify stdio behavior on malformed lines

## Problem

`basic/transports#stdio` defines the line-delimited JSON framing but doesn't specify what servers SHOULD do when they receive a line that isn't valid JSON or isn't a valid JSON-RPC message.

Observed variance in the wild:
- Some servers parse-error, respond with JSON-RPC error `-32700`, and continue
- Some servers silently drop the line and continue (correct per most JSON-RPC frameworks)
- Some servers crash / exit
- Some servers emit their own banner text, which itself isn't valid JSON and cascades into parse failures on the client side

## Proposed wording change

Add to `basic/transports#stdio`:

> A stdio server **MUST NOT** terminate upon receiving an unparseable line on stdin. Recommended behavior:
>
> - If the line is not valid UTF-8 or not valid JSON: **SHOULD** be silently ignored (no response written). The server **MUST** continue reading subsequent lines.
> - If the line is valid JSON but not a valid JSON-RPC 2.0 message (missing `jsonrpc` or `method`, or both `id` and not a notification): the server **SHOULD** respond with a JSON-RPC error using `id: null`, code `-32600` ("Invalid Request").
> - Non-JSON output on stdout (e.g., startup banners, log messages) is **NOT** permitted. Servers **MUST** write all diagnostic output to stderr.

## Rationale

- Turns an undefined corner case into a well-defined protocol requirement.
- Last rule in particular catches a common bug where servers print a banner like `"Ready on port 3000\n"` to stdout, breaking the line-JSON contract.
- Aligns with the general JSON-RPC 2.0 spec's error code conventions.

## Backwards-compat considerations

Servers currently printing to stdout need to switch those prints to stderr. Servers that crash on parse errors need a try/catch around parsing. Both are bug fixes, not behavior changes.
