import { describe, expect, it } from "vitest";
import { splitStdioTarget } from "../stdio-split.js";

describe("splitStdioTarget", () => {
  it("splits `node dist/index.js serve` into command + args", () => {
    expect(splitStdioTarget("node dist/index.js serve")).toEqual({
      command: "node",
      args: ["dist/index.js", "serve"],
    });
  });

  it("collapses runs of whitespace", () => {
    expect(splitStdioTarget("node   dist/index.js\tserve")).toEqual({
      command: "node",
      args: ["dist/index.js", "serve"],
    });
  });

  it("returns a single-command no-arg form when there's only one token", () => {
    expect(splitStdioTarget("my-binary")).toEqual({ command: "my-binary", args: [] });
  });

  it("rejects quoted input rather than mis-parsing", () => {
    // A shell-style quoted arg would require a real parser to handle
    // correctly. Rejecting makes the failure mode loud instead of silent.
    expect(() => splitStdioTarget(`node script.js "a b"`)).toThrow(/quote characters/);
    expect(() => splitStdioTarget(`node 'dist/index.js' serve`)).toThrow(/quote characters/);
    expect(() => splitStdioTarget("node script.js `whoami`")).toThrow(/quote characters/);
  });

  it("rejects empty/whitespace-only input", () => {
    expect(() => splitStdioTarget("")).toThrow(/empty/);
    expect(() => splitStdioTarget("   \t  ")).toThrow(/empty/);
  });
});
