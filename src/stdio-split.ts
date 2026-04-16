/**
 * Split a stdio target string that was passed as one quoted argument
 * (e.g. `"node dist/index.js serve"`) into command + argv. Needed
 * because the stdio transport spawns with shell: false on Linux, so a
 * single-string command is looked up as a literal executable name and
 * fails with ENOENT. On Windows, Node's default spawn goes through
 * cmd.exe which word-splits — which is exactly why this bug went
 * unnoticed on Windows for so long.
 *
 * Deliberately minimal: whitespace split, no shell quote parsing. If
 * the user needs embedded spaces in an arg (e.g. a flag value with a
 * path containing spaces), they should use the unquoted form so each
 * token arrives as its own argv entry:
 *
 *     mcp-compliance test node dist/index.js serve --flag "a b"
 *
 * rather than:
 *
 *     mcp-compliance test "node dist/index.js serve --flag 'a b'"
 *
 * If the one-string form contains quote characters, we reject it
 * rather than silently mis-parsing. That forces the caller toward the
 * unquoted variadic form, which is the only shape that works
 * correctly across platforms without a shell.
 */
export function splitStdioTarget(s: string): { command: string; args: string[] } {
  if (/["'`]/.test(s)) {
    throw new Error(
      "stdio command contains quote characters — pass the command and its args as separate tokens (e.g. `mcp-compliance test node dist/index.js serve`) instead of wrapping them in one quoted string.",
    );
  }
  const tokens = s.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    throw new Error("stdio command is empty");
  }
  return { command: tokens[0], args: tokens.slice(1) };
}
