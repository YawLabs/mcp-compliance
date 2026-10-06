import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

// scripts/update-manifests.mjs writes package.json's description (and the
// homepage, version, license and command) into Ruby double-quoted strings in
// the Homebrew formula. These tests pin the escaping that keeps each value a
// plain string (CodeQL js/incomplete-sanitization).
const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "update-manifests.mjs");

interface FormulaInput {
  className: string;
  cmd: string;
  description?: string;
  homepage: string;
  version: string;
  license?: string;
  assets: Record<"macArm64" | "macX64" | "linuxX64", { url: string; sha256: string }>;
}

let rubyString: (value: unknown) => string;
let renderFormula: (input: FormulaInput) => string;

beforeAll(async () => {
  // A computed specifier keeps tsc from resolving the untyped .mjs. Importing
  // it must not run the release side effects (`gh release download`).
  const mod = (await import(pathToFileURL(scriptPath).href)) as {
    rubyString: typeof rubyString;
    renderFormula: typeof renderFormula;
  };
  rubyString = mod.rubyString;
  renderFormula = mod.renderFormula;
});

// Read the body of a Ruby double-quoted literal the way Ruby does, failing on
// anything that would end the string early or interpolate code.
function parseRubyDq(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "\\") {
      const next = body[++i];
      if (next === undefined) throw new Error("dangling backslash escapes the closing quote");
      out += next === "n" ? "\n" : next === "r" ? "\r" : next;
    } else if (c === '"') {
      throw new Error(`unescaped quote at ${i} ends the string early`);
    } else if (c === "#" && /[{@$]/.test(body[i + 1] ?? "")) {
      throw new Error(`unescaped interpolation at ${i}`);
    } else if (c === "\n" || c === "\r") {
      throw new Error(`raw line break at ${i}`);
    } else {
      out += c;
    }
  }
  return out;
}

const HOSTILE = 'He said "hi" \\" #{system("rm -rf ~")} #@ivar #$global\nsecond line';

function formulaFor(overrides: Partial<FormulaInput> = {}): string {
  const asset = (name: string) => ({
    url: `https://github.com/YawLabs/mcp-compliance/releases/download/v1.2.3/${name}`,
    sha256: "a".repeat(64),
  });
  return renderFormula({
    className: "McpCompliance",
    cmd: "mcp-compliance",
    description: "MCP compliance testing",
    homepage: "https://github.com/YawLabs/mcp-compliance",
    version: "1.2.3",
    license: "MIT",
    assets: {
      macArm64: asset("mcp-compliance-darwin-arm64"),
      macX64: asset("mcp-compliance-darwin-x64"),
      linuxX64: asset("mcp-compliance-linux-x64"),
    },
    ...overrides,
  });
}

// The body of the one-line `<stanza> "..."` in a rendered formula.
function stanza(formula: string, name: string): string {
  const match = formula.match(new RegExp(`^  ${name} "(.*)"$`, "m"));
  if (!match) throw new Error(`no one-line ${name} stanza in:\n${formula}`);
  return match[1];
}

describe("update-manifests rubyString", () => {
  const cases = [
    "MCP compliance testing: spec suites for MCP 2025-11-25 (88 tests), with A-F grading",
    'He said "hi"',
    "trailing backslash \\",
    'backslash then quote \\"',
    "C:\\path\\to\\thing",
    '#{system("rm -rf ~")}',
    "#@ivar and #$global",
    "line one\nline two\r\n",
    "C# support, issue #12, trailing #",
    "",
  ];

  for (const input of cases) {
    it(`round-trips ${JSON.stringify(input)}`, () => {
      expect(parseRubyDq(rubyString(input))).toBe(input);
    });
  }

  it("escapes the backslash before the quote", () => {
    // The old `.replace(/"/g, '\\"')` turned `\"` into `\\"`, which Ruby reads
    // as an escaped backslash followed by a closing quote.
    expect(rubyString('a\\"b')).toBe('a\\\\\\"b');
  });

  it("escapes # only where it starts interpolation", () => {
    // `brew style` flags `\#` before anything else as a redundant escape.
    expect(rubyString("C# and #1")).toBe("C# and #1");
    expect(rubyString("#{x} #@y #$z")).toBe("\\#{x} \\#@y \\#$z");
  });

  it("treats null and undefined as empty", () => {
    expect(rubyString(undefined)).toBe("");
    expect(rubyString(null)).toBe("");
  });
});

describe("update-manifests renderFormula", () => {
  it("puts a hostile description through rubyString", () => {
    const formula = formulaFor({ description: HOSTILE });
    expect(stanza(formula, "desc")).toBe(rubyString(HOSTILE));
    expect(parseRubyDq(stanza(formula, "desc"))).toBe(HOSTILE);
  });

  it("escapes homepage, version and license too", () => {
    const formula = formulaFor({ homepage: 'https://x/"#{1}', version: '1"2', license: "MIT\\" });
    expect(parseRubyDq(stanza(formula, "homepage"))).toBe('https://x/"#{1}');
    expect(parseRubyDq(stanza(formula, "version"))).toBe('1"2');
    expect(parseRubyDq(stanza(formula, "license"))).toBe("MIT\\");
  });

  it("writes :cannot_represent for an unlicensed package", () => {
    expect(formulaFor({ license: "UNLICENSED" })).toMatch(/^ {2}license :cannot_represent$/m);
    expect(formulaFor({ license: undefined })).toMatch(/^ {2}license :cannot_represent$/m);
  });

  it("keeps the test block's own #{bin} interpolation", () => {
    expect(formulaFor()).toContain('shell_output("#{bin}/mcp-compliance --version")');
  });

  it("refuses a class name that is not a Ruby constant", () => {
    expect(() => formulaFor({ className: "Bad Name" })).toThrow(/class name/);
  });
});
