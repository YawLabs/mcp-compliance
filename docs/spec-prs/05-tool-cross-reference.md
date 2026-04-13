# Add advisory against tool cross-references in descriptions

## Problem

The spec allows arbitrary strings in tool descriptions. In practice, when a tool description references other tools by name (e.g., `"read_file: use read_text_file for plain text"`), LLM agents consistently make mistakes:

- They sometimes call the referenced tool even when the current tool was the right choice.
- They get confused about which tool to pick when there are dependency chains.
- They hallucinate tools that don't exist but sound like they should, based on description hints.

This isn't a spec violation today. But it's a reliability issue that compliance tooling routinely flags.

## Proposed wording change

Add to `server/tools#calling-tools` or a new `server/tools#best-practices` section:

> Tool descriptions **SHOULD NOT** reference other tools by name. Each tool description should be self-contained. If tools have logical relationships or usage patterns (e.g., "read this tool's output, then call tool X"), document those patterns in the server-level `instructions` field rather than inside individual tool descriptions.
>
> Servers MAY include general task guidance in descriptions ("prefer the structured output version for downstream parsing") as long as no specific other tool is named.

## Rationale

- LLMs treat tool descriptions as authoritative input; cross-references are a source of hallucination.
- Server-level `instructions` field exists exactly for multi-tool coordination — use the right surface.
- Most tool sets don't need cross-references; this only affects a minority of multi-tool servers.

## Backwards-compat considerations

This is an advisory (`SHOULD NOT`), not a requirement. Existing servers with cross-references keep working; compliance tools can issue warnings without blocking.

If we upgrade this to `MUST NOT` in a future spec, we need a migration window — probably one spec cycle of advisory before enforcing.
