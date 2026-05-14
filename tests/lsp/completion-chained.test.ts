/**
 * Tests for F1: Chained call type inference.
 *
 * Verifies that member access completion (d->, obj.) works when the LHS is:
 * 1. A simple variable with known type (existing functionality, baseline)
 * 2. A function call that returns a type (makeDog()-> completes as Dog)
 * 3. A chained call (getContainer()->getItem()-> completes as Item members)
 *
 * These are direct API tests of getCompletions() with no LSP server.
 *
 * Cursor position convention: the cursor must be right AFTER the trailing
 * `->` so that detectTriggerContext's text-based fallback reads the last
 * two characters as `->` and triggers arrow completion.
 */

import { describe, it, expect } from "bun:test";
import { initParser, parse } from "../../server/src/parser";
import { buildSymbolTable, wireInheritance, type SymbolTable } from "../../server/src/features/symbolTable";
import { getCompletions, type CompletionContext } from "../../server/src/features/completion";
import { WorkspaceIndex } from "../../server/src/features/workspaceIndex";
import stdlibAutodocIndex from "../../server/src/data/stdlib-autodoc.json";
import predefBuiltinIndex from "../../server/src/data/predef-builtin-index.json";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

await initParser();

/** Build a minimal CompletionContext for direct API tests. */
function makeCtx(uri = "file:///test/chained.pike"): CompletionContext {
  return {
    index: new WorkspaceIndex({ workspaceRoot: "/test" }),
    stdlibIndex: stdlibAutodocIndex as Record<string, { signature: string; markdown: string }>,
    predefBuiltins: predefBuiltinIndex as Record<string, string>,
    uri,
  };
}

function completionLabels(result: { items: Array<{ label: string }> }): string[] {
  return result.items.map(i => i.label);
}

/**
 * Return the cursor column that sits right after the last `->` on the given
 * line. This is the column detectTriggerContext expects for arrow completion.
 */
function colAfterArrow(src: string, lineIdx: number): number {
  const line = src.split("\n")[lineIdx];
  if (!line) throw new Error(`line ${lineIdx} not found`);
  return line.length;
}

// ---------------------------------------------------------------------------
// F1: Chained call type inference
// ---------------------------------------------------------------------------

describe("F1: chained call type inference for member access completion", () => {

  it("baseline: simple variable d-> completes with Dog members", async () => {
    const src = [
      "class Dog {",
      "  string name;",
      "  void bark() {}",
      "  void fetch(string item) {}",
      "}",
      "void test() {",
      "  Dog d;",
      "  d->",
      "}",
    ].join("\n");
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/f1-dog.pike", 1);
    wireInheritance(table);

    // "  d->" on line 7, cursor at col 5 (right after '>')
    const result = await getCompletions(table, tree, 7, colAfterArrow(src, 7), makeCtx());
    const labels = completionLabels(result);

    expect(labels).toContain("bark");
    expect(labels).toContain("fetch");
    expect(labels).toContain("name");
  });

  it("single function call: makeDog()-> completes with Dog members", async () => {
    const src = [
      "class Dog {",
      "  string name;",
      "  void bark() {}",
      "}",
      "Dog makeDog() { return Dog(); }",
      "void test() {",
      "  makeDog()->",
      "}",
    ].join("\n");
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/f1-single-call.pike", 1);
    wireInheritance(table);

    // "  makeDog()->" on line 6, cursor right after '>'
    const result = await getCompletions(table, tree, 6, colAfterArrow(src, 6), makeCtx());
    const labels = completionLabels(result);

    expect(labels).toContain("bark");
    expect(labels).toContain("name");
  });

  it("two-step chain: getContainer()->getItem()-> completes with Item members", async () => {
    const src = [
      "class Container {",
      "  Item getItem() { return Item(); }",
      "}",
      "class Item {",
      "  int id;",
      "  void use() {}",
      "}",
      "Container getContainer() { return Container(); }",
      "void test() {",
      "  getContainer()->getItem()->",
      "}",
    ].join("\n");
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/f1-two-chain.pike", 1);
    wireInheritance(table);

    const result = await getCompletions(table, tree, 9, colAfterArrow(src, 9), makeCtx());
    const labels = completionLabels(result);

    // Should show Item members (id, use), not Container members
    expect(labels).toContain("use");
    expect(labels).toContain("id");
  });

  it("three-step chain: a()->b()->c()-> completes with C members", async () => {
    const src = [
      "class A { B get() { return B(); } }",
      "class B { C get() { return C(); } }",
      "class C { int value; void render() {} }",
      "A getA() { return A(); }",
      "void test() {",
      "  getA()->get()->get()->",
      "}",
    ].join("\n");
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/f1-three-chain.pike", 1);
    wireInheritance(table);

    const result = await getCompletions(table, tree, 5, colAfterArrow(src, 5), makeCtx());
    const labels = completionLabels(result);

    // Should show C members (value, render), not A or B members
    expect(labels).toContain("render");
    expect(labels).toContain("value");
  });

  it("chain with void return type produces no completions", async () => {
    const src = [
      "class Container {",
      "  void process() {}",
      "}",
      "Container getContainer() { return Container(); }",
      "void test() {",
      "  getContainer()->process()->", // process returns void, no member access
      "}",
    ].join("\n");
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/f1-void-chain.pike", 1);
    wireInheritance(table);

    const result = await getCompletions(table, tree, 5, colAfterArrow(src, 5), makeCtx());
    const labels = completionLabels(result);

    // void has no members, so result should be empty
    expect(labels).toHaveLength(0);
  });

  it("unresolvable chain falls back gracefully (no crash)", async () => {
    const src = [
      "void test() {",
      "  unknownFunc()->something()->",  // cannot resolve unknownFunc
      "}",
    ].join("\n");
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/f1-unresolved.pike", 1);
    wireInheritance(table);

    const result = await getCompletions(table, tree, 1, colAfterArrow(src, 1), makeCtx());
    expect(result.items).toHaveLength(0);
  });
});
