/**
 * Completion at cursor positions that sit on a boundary.
 *
 * Every case here came out of the LSP audit sweep, which probes the first
 * column of each identifier. Completion worked one column to the left and one
 * to the right of those positions and returned an empty list on the boundary
 * itself — three separate causes, all of them a specialised trigger firing
 * where it could never produce anything.
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { initParser, parse } from "../../server/src/parser";
import { buildSymbolTable, wireInheritance } from "../../server/src/features/symbolTable";
import {
  getCompletions,
  resetCompletionCache,
  type CompletionContext,
} from "../../server/src/features/completion";
import { WorkspaceIndex } from "../../server/src/features/workspaceIndex";
import stdlibAutodocIndex from "../../server/src/data/stdlib-autodoc.json";
import predefBuiltinIndex from "../../server/src/data/predef-builtin-index.json";

function makeCtx(source: string, uri = "file:///test/cursor-edges.pike"): CompletionContext {
  return {
    index: new WorkspaceIndex({ workspaceRoot: "/test" }),
    stdlibIndex: stdlibAutodocIndex as Record<string, { signature: string; markdown: string }>,
    predefBuiltins: predefBuiltinIndex as Record<string, string>,
    predefAutodoc: {},
    uri,
    source,
  };
}

async function completeAt(src: string, line: number, character: number): Promise<string[]> {
  const tree = parse(src);
  const table = buildSymbolTable(tree, "file:///test/cursor-edges.pike", 1, undefined, src);
  wireInheritance(table);
  const result = await getCompletions(table, tree, line, character, makeCtx(src));
  return result.items.map(i => i.label);
}

beforeAll(async () => {
  await initParser();
  resetCompletionCache();
});

describe("completion at column 0", () => {
  test("offers scope symbols at the start of a line", async () => {
    const src = [
      "class Shape { }",
      "",
      "Shape make_triangle() {",
      "  return Shape();",
      "}",
    ].join("\n");

    // Column 0 of `Shape make_triangle()`. There is no character before the
    // cursor to read a trigger from, which must mean "unqualified", not "no
    // completion is possible here".
    const labels = await completeAt(src, 2, 0);
    expect(labels).toContain("Shape");
  });
});

describe("completion inside a call's argument list", () => {
  const src = [
    "int apply_fn(function(int:int) f, int val) {",
    "  return f(val);",
    "}",
    "",
    "int main() {",
    "  function(int:int) doubler = lambda (int x) { return x * 2; };",
    "  int result = apply_fn(doubler, 5);",
    "  return 0;",
    "}",
  ].join("\n");

  test("offers the argument snippet for a function declared in the file", async () => {
    // Cursor between `(` and `doubler`. The callee is an ordinary same-file
    // function, whose parameters live in its own scope — its `declaredType`
    // holds only the return type, so reading the parameters from there finds
    // nothing.
    const labels = await completeAt(src, 6, 24);
    expect(labels.some(l => l.startsWith("apply_fn("))).toBe(true);
  });

  test("falls back to scope symbols when the callee cannot be resolved", async () => {
    const unknown = [
      "int main() {",
      "  int total = 7;",
      "  return no_such_function(total);",
      "}",
    ].join("\n");

    // Cursor between `(` and `total`. Nothing can be said about the callee, so
    // the argument expression the user is about to write is all that is left.
    const labels = await completeAt(unknown, 2, 26);
    expect(labels).toContain("total");
  });
});

describe("completion inside a declaration's parameter list", () => {
  test("offers type names, not a call snippet, after the opening paren", async () => {
    const src = [
      "enum Color { RED, GREEN }",
      "",
      "string color_name(Color c) {",
      '  return "";',
      "}",
    ].join("\n");

    // Cursor between `(` and `Color` in the *declaration* of color_name. The
    // `(`-trigger cannot tell a call from a parameter list on its own.
    const labels = await completeAt(src, 2, 18);
    expect(labels).toContain("Color");
    expect(labels.some(l => l.startsWith("color_name("))).toBe(false);
  });
});

describe("scope access through a parsed qualifier", () => {
  const src = [
    "class A {",
    "  int value() { return 1; }",
    "  string name() { return \"A\"; }",
    "}",
    "",
    "class B {",
    "  int value() { return 2; }",
    "}",
    "",
    "class C {",
    "  inherit A;",
    "  inherit B;",
    "  int sum() { return A::value() + B::value(); }",
    "}",
  ].join("\n");

  test("A:: offers A's members when the qualified call is already complete", async () => {
    // Cursor at the start of `value` in `A::value()`. `Base::` with nothing
    // after it parses as an error and reaches the handler as a bare
    // identifier; a complete `A::value()` reaches it as an inherit_specifier
    // whose text is `A::`, which never matched an inherit named `A`.
    const labels = await completeAt(src, 12, 24);
    expect(labels).toContain("value");
    expect(labels).toContain("name");
  });

  test("the qualifier itself is not treated as a member position", async () => {
    // Cursor on the `A` of `A::value()`. Asking for A's members here is wrong:
    // the user is on the qualifier, so the scope's own symbols are what apply.
    const labels = await completeAt(src, 12, 21);
    expect(labels).toContain("sum");
  });
});

describe("completion after a scope keyword", () => {
  test("global:: offers the file scope", async () => {
    const src = [
      "int total_size_limit = 10;",
      "string label = \"x\";",
      "class Sub {",
      "  int total_size_limit = 1;",
      "  int f() { return global::total_size_limit; }",
      "}",
    ].join("\n");

    // `global::` names the file scope, deliberately ignoring the member of the
    // same name that shadows it one scope in.
    const labels = await completeAt(src, 4, 29);
    expect(labels).toContain("total_size_limit");
    expect(labels).toContain("label");
  });

  test("bare :: offers members of an inherit the file does not declare", async () => {
    const src = [
      "class MyFile {",
      "  inherit Stdio.File;",
      "  int f() { return ::read(10); }",
      "}",
    ].join("\n");

    // `::` names the inherited scope. Roxen inherits stdlib and cross-file
    // classes far more often than same-file ones, and the same-file scope
    // wiring is the only thing this ever looked at.
    const labels = await completeAt(src, 2, 22);
    expect(labels).toContain("read");
  });
});

describe("completion after a single colon", () => {
  test("offers type names inside a mapping type", async () => {
    const src = [
      "class CacheEntry { int n; }",
      "class CacheStats { int m; }",
      "mapping(string:mapping(mixed:CacheEntry)) lookup = ([]);",
    ].join("\n");

    // Cursor at the start of `CacheEntry`, one character after the `:` of the
    // inner mapping type. A lone colon is not a trigger, which is not the same
    // as it forbidding completion — a type name is exactly what goes here.
    const labels = await completeAt(src, 2, 29);
    expect(labels).toContain("CacheEntry");
    expect(labels).toContain("CacheStats");
  });

  test("still routes a double colon to scope completion", async () => {
    const src = [
      "class A { int value() { return 1; } }",
      "class C {",
      "  inherit A;",
      "  int sum() { return A::value(); }",
      "}",
    ].join("\n");

    const labels = await completeAt(src, 3, 24);
    expect(labels).toContain("value");
  });
});

describe("completion after predef::", () => {
  test("offers Pike's predefined builtins", async () => {
    const src = [
      "void f(string fmt) {",
      "  predef::upper_case(fmt);",
      "}",
    ].join("\n");

    // `predef::` names Pike's predefined namespace. Nothing looked there, so
    // the qualifier fell through to the inherit search and found no inherit
    // called `predef`.
    const labels = await completeAt(src, 1, 10);
    expect(labels).toContain("upper_case");
  });
});

