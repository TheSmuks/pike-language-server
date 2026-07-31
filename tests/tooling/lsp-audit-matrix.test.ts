import { test, expect } from "bun:test";
import { MATRIX, hasFoldableRegion } from "../../tools/lsp-audit/matrix";
import { buildServerCapabilities } from "../../server/src/serverCapabilities";

test("every declared server capability has at least one matrix entry", () => {
  const declared = Object.keys(buildServerCapabilities().capabilities);
  const covered = new Set(MATRIX.map((entry) => entry.declaredBy));
  const uncovered = declared.filter((key) => !covered.has(key));
  expect(uncovered).toEqual([]);
});

test("every matrix entry names a capability the server actually declares", () => {
  const declared = new Set(Object.keys(buildServerCapabilities().capabilities));
  const orphans = MATRIX.filter((e) => !declared.has(e.declaredBy)).map((e) => e.method);
  expect(orphans).toEqual([]);
});

test("position-driven entries build params carrying the position", () => {
  const hover = MATRIX.find((e) => e.method === "textDocument/hover");
  expect(hover?.driver).toBe("position");
  const params = hover!.params({
    uri: "file:///x.pike",
    position: { line: 2, character: 4 },
    text: "",
  }) as { position: { line: number } };
  expect(params.position.line).toBe(2);
});

test("validate distinguishes an answer from an empty result", () => {
  const definition = MATRIX.find((e) => e.method === "textDocument/definition")!;
  expect(definition.validate(null)).toBe("empty");
  expect(definition.validate([])).toBe("empty");
  expect(definition.validate([{ uri: "file:///x.pike" }])).toBe("ok");
});

test("foldingRange is legal-empty for a file with nothing to fold", () => {
  // corpus/files/cross_pmod_dir.pmod/helpers.pike: five lines, every function
  // body on one line. Zero folding ranges is correct there, and a blanket
  // nonEmpty reported it as a defect.
  const folding = MATRIX.find((e) => e.method === "textDocument/foldingRange")!;
  const flat = "// Helpers\nint add(int a, int b) { return a + b; }\n";
  expect(folding.validate([], { uri: "file:///x.pike", position: null, text: flat })).toBe("ok");
});

test("foldingRange still catches an outage on a file that has foldable regions", () => {
  const folding = MATRIX.find((e) => e.method === "textDocument/foldingRange")!;
  const nested = "int add(int a, int b) {\n  return a + b;\n}\n";
  expect(folding.validate([], { uri: "file:///x.pike", position: null, text: nested })).toBe("empty");
  expect(folding.validate([{ startLine: 0, endLine: 2 }], { uri: "file:///x.pike", position: null, text: nested })).toBe("ok");
});

test("a brace in prose does not make an unfoldable file look foldable", () => {
  // Otherwise the strict branch is taken for a file that legitimately has
  // nothing to fold, which is the false finding this check exists to prevent.
  expect(hasFoldableRegion('// see the { block below\nint x = 1;\n')).toBe(false);
  expect(hasFoldableRegion('string s = "{\\n";\nint x = 1;\n')).toBe(false);
  expect(hasFoldableRegion("int f() {\n  return 1;\n}\n")).toBe(true);
});
