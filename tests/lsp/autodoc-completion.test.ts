/**
 * Tests for the autodoc-skeleton completion (//! trigger).
 *
 * Verifies that typing `//!` on a line above a function, method, class, or
 * variable yields a single snippet completion whose text edit expands into a
 * `//!` skeleton with tab-stops populated from the declaration signature.
 * The plain-text `//!!` code action is covered by autodoc-template.test.ts.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import type { TextEdit } from "vscode-languageserver/node";
import { initParser, parse } from "../../server/src/parser";
import { buildSymbolTable } from "../../server/src/features/symbolTable";
import { buildAutodocCompletion } from "../../server/src/features/completion-autodoc";

describe("Autodoc completion — //! trigger", () => {
  beforeAll(async () => {
    await initParser();
  });

  let counter = 0;

  function complete(source: string, line: number, character: number) {
    const uri = `file:///test-autodoc-completion-${++counter}.pike`;
    const tree = parse(source, uri);
    if (!tree) throw new Error("parse failed");
    const table = buildSymbolTable(tree, uri, 0, undefined, source);
    return buildAutodocCompletion(table, line, character, source);
  }

  test("function with parameters and return type gets full skeleton", () => {
    const item = complete(`//!\nint add(int x, int y) {\n  return x + y;\n}`, 0, 3);
    expect(item).not.toBeNull();
    const text = item!.textEdit!.newText;
    expect(item!.insertTextFormat).toBe(2); // InsertTextFormat.Snippet
    expect(text).toContain("//! ${1:add — description.}");
    expect(text).toContain("@param x");
    expect(text).toContain("@param y");
    expect(text).toContain("@returns");
    // Distinct, ordered tab-stops for description + each param + return.
    expect(text).toContain("${2:");
    expect(text).toContain("${3:");
    expect(text).toContain("${4:");
  });

  test("void function omits @returns", () => {
    const item = complete(`//!\nvoid greet(string name) {\n}`, 0, 3);
    expect(item).not.toBeNull();
    const text = item!.textEdit!.newText;
    expect(text).toContain("@param name");
    expect(text).not.toContain("@returns");
  });

  test("class gets a single description line, no @param", () => {
    const item = complete(`//!\nclass Dog {\n}`, 0, 3);
    expect(item).not.toBeNull();
    const text = item!.textEdit!.newText;
    expect(text).toContain("${1:Dog — description.}");
    expect(text).not.toContain("@param");
  });

  test("text edit replaces only the typed //! marker and re-indents", () => {
    const item = complete(`  //!\n  void f(int a) {}`, 0, 5);
    expect(item).not.toBeNull();
    const edit = item!.textEdit as TextEdit;
    // Range starts after the indent, ends at the cursor (past `//!`).
    expect(edit.range).toEqual({
      start: { line: 0, character: 2 },
      end: { line: 0, character: 5 },
    });
    // Continuation lines are re-indented to match the trigger line.
    expect(edit.newText).toContain("\n  //! @param a");
  });

  test("//!! does not trigger the completion (code-action territory)", () => {
    expect(complete(`//!!\nint f() {}`, 0, 4)).toBeNull();
  });

  test("//! not above a declaration yields nothing", () => {
    expect(complete(`int x = 1;\n//!\nx++;`, 1, 3)).toBeNull();
  });

  test("skips existing doc lines to find the declaration", () => {
    const item = complete(`//!\n//! existing docs\nint foo(int a) {\n  return a;\n}`, 0, 3);
    expect(item).not.toBeNull();
    expect(item!.detail).toContain("foo");
  });

  test("does not fire when content already follows the cursor", () => {
    expect(complete(`//! already documented\nint f() {}`, 0, 3)).toBeNull();
  });
});
