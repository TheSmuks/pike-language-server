import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { EXPECTATIONS, checkExpectation } from "../../tools/lsp-audit/expectations";

test("covers the five tier-2 capabilities", () => {
  const methods = new Set(EXPECTATIONS.map((e) => e.method));
  expect(methods).toContain("textDocument/definition");
  expect(methods).toContain("textDocument/hover");
  expect(methods).toContain("textDocument/references");
  expect(methods).toContain("textDocument/prepareRename");
  expect(methods).toContain("textDocument/completion");
});

test("names ten distinct corpus files, all of which exist", () => {
  const files = new Set(EXPECTATIONS.map((e) => e.file));
  expect(files.size).toBe(10);
  for (const file of files) {
    expect(existsSync(join("corpus/files", file))).toBe(true);
  }
});

test("checkExpectation matches a definition landing on the right line", () => {
  const exp = EXPECTATIONS.find((e) => e.expect.kind === "definitionAt")!;
  const target = exp.expect as { kind: "definitionAt"; file: string; line: number };
  const good = [{ uri: `file:///corpus/files/${target.file}`, range: { start: { line: target.line } } }];
  const bad = [{ uri: `file:///corpus/files/${target.file}`, range: { start: { line: target.line + 99 } } }];
  expect(checkExpectation(exp, good)).toBe(true);
  expect(checkExpectation(exp, bad)).toBe(false);
});

test("checkExpectation treats a missing result as a failure", () => {
  expect(checkExpectation(EXPECTATIONS[0], null)).toBe(false);
});
