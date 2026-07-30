import { test, expect } from "bun:test";
import { MATRIX } from "../../tools/lsp-audit/matrix";
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
