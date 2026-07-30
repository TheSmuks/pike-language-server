import { test, expect } from "bun:test";
import { derivePositions, lexicalIdentifiers } from "../../tools/lsp-audit/positions";

const SRC = `int counter;

int bump() {
  counter = counter + 1;
  return counter;
}
`;

test("finds the declaration and its references", () => {
  const positions = derivePositions(SRC, ["counter"]);
  expect(positions[0]).toEqual({ line: 0, character: 4, symbol: "counter", kind: "declaration" });
  expect(positions.filter((p) => p.kind === "reference").length).toBe(3);
});

test("caps reference sites per declaration", () => {
  const many = "int x;\n" + "int f() { return x + x + x + x + x + x + x; }\n";
  const positions = derivePositions(many, ["x"], 2);
  expect(positions.filter((p) => p.kind === "reference").length).toBe(2);
});

test("falls back to a lexical scan when no symbol names are supplied", () => {
  const positions = derivePositions(SRC, []);
  expect(positions.length).toBeGreaterThan(0);
  expect(positions.some((p) => p.symbol === "bump")).toBe(true);
});

test("does not match identifiers inside longer words", () => {
  const positions = derivePositions("int x;\nint xylophone;\n", ["x"]);
  expect(positions).toHaveLength(1);
  expect(positions[0].kind).toBe("declaration");
});

test("positions are UTF-16 code units, so astral characters count as two", () => {
  // The emoji is one code point but two UTF-16 units, matching how both LSP
  // and tree-sitter count. Verified against the real values: a UTF-16 scan
  // puts "after" at 21, a byte-based scan would put it at 23. Asserting 21 is
  // what makes this test catch an accidental byte conversion.
  const positions = derivePositions('string s = "\u{1F600}"; int after;\n', ["after"]);
  expect(positions[0].character).toBe(21);
});

test("lexicalIdentifiers skips Pike keywords", () => {
  expect(lexicalIdentifiers("int x; return x;")).not.toContain("return");
  expect(lexicalIdentifiers("int x; return x;")).toContain("x");
});

test("positions never land inside a comment", () => {
  // corpus/files/autodoc-documented.pike names the class in its own `//!`
  // prose. Sweeping that word asked for hover and definition inside a comment,
  // where nothing is the correct answer — 39 of the corpus tier's first-round
  // hover/definition "empty" findings came from comment text alone.
  const text = [
    "//! Create a new Widget with the given value.",
    "class Widget {",
    "  int value;",
    "}",
    "",
  ].join("\n");
  const positions = derivePositions(text, ["Widget"]);
  expect(positions).toHaveLength(1);
  expect(positions[0].line).toBe(1);
});

test("positions never land inside a string literal", () => {
  const text = 'string tag = "Widget";\nclass Widget { }\n';
  const positions = derivePositions(text, ["Widget"]);
  expect(positions.map((p) => p.line)).toEqual([1]);
});

test("a block comment hides its contents from the sweep", () => {
  const text = "/* Widget is described here */\nclass Widget { }\n";
  expect(derivePositions(text, ["Widget"]).map((p) => p.line)).toEqual([1]);
});

test("commented occurrences do not consume the per-declaration budget", () => {
  // The mask is applied BEFORE `seen` advances. If it were not, three lines of
  // prose would exhaust maxRefsPerDecl and push the real code positions out of
  // the sweep entirely — a subtler failure than a bad position, because the
  // capability then reports clean at zero positions.
  const text = [
    "// Widget",
    "// Widget",
    "// Widget",
    "class Widget { }",
    "Widget make() { return Widget(); }",
  ].join("\n");
  const positions = derivePositions(text, ["Widget"], 1);
  expect(positions.map((p) => p.line)).toEqual([3, 4]);
});

test("an unterminated quote does not swallow the rest of the file", () => {
  const text = "string broken = \"oops;\nclass Widget { }\n";
  expect(derivePositions(text, ["Widget"]).map((p) => p.line)).toEqual([1]);
});
