import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  EXPECTATIONS,
  checkExpectation,
  expectationPositions,
} from "../../tools/lsp-audit/expectations";

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
  const notRename = EXPECTATIONS.find((e) => e.expect.kind !== "renameAllowed")!;
  expect(checkExpectation(notRename, null)).toBe(false);
});

test("a null prepareRename is the CORRECT answer when rename is disallowed", () => {
  // null is precisely what the server returns for a non-renameable position.
  // If the null guard ran first, `allowed: false` could never pass and would
  // report "wrong" exactly when the server behaved correctly.
  const disallowed = EXPECTATIONS.find(
    (e) => e.expect.kind === "renameAllowed" && e.expect.allowed === false,
  );
  if (!disallowed) return; // no such expectation in the set
  expect(checkExpectation(disallowed, null)).toBe(true);
  expect(checkExpectation(disallowed, { range: {} })).toBe(false);
});

test("every expectation position is exported for the sweep to visit", () => {
  // Without this the sweep only visits TOP-LEVEL documentSymbol names, which
  // reaches 1 of 20 expectations — fields, locals and class members are never
  // emitted as top-level symbols, so tier 2 would check almost nothing.
  const positions = expectationPositions();
  const total = [...positions.values()].reduce((n, list) => n + list.length, 0);
  expect(total).toBe(EXPECTATIONS.length);
  for (const e of EXPECTATIONS) {
    const forFile = positions.get(e.file) ?? [];
    expect(forFile.some((p) => p.line === e.line && p.character === e.character)).toBe(true);
  }
});
