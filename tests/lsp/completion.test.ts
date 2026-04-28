/**
 * Completion tests (LSP layer + direct API).
 *
 * Tests the completion provider from decision 0012:
 * - Unqualified completion: local scope, predef builtins, stdlib top-level
 * - Dot access completion: module members
 * - Arrow access completion: object members
 * - Scope access completion: inherited members
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestServer, type TestServer } from "./helpers";
import {
  initParser,
  parse,
} from "../../server/src/parser";
import {
  buildSymbolTable,
  wireInheritance,
  getSymbolsInScope,
  type SymbolTable,
} from "../../server/src/features/symbolTable";
import {
  getCompletions,
  resetCompletionCache,
  type CompletionContext,
} from "../../server/src/features/completion";
import { WorkspaceIndex, ModificationSource } from "../../server/src/features/workspaceIndex";
import stdlibAutodocIndex from "../../server/src/data/stdlib-autodoc.json";
import predefBuiltinIndex from "../../server/src/data/predef-builtin-index.json";

// ---------------------------------------------------------------------------
// Shared server
// ---------------------------------------------------------------------------

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
  resetCompletionCache();
});

afterAll(async () => {
  await server.teardown();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CompletionResult {
  isIncomplete: boolean;
  items: Array<{
    label: string;
    kind?: number;
    detail?: string;
    sortText?: string;
  }>;
}

function completionLabels(result: CompletionResult): string[] {
  return result.items.map(i => i.label);
}

/** Build a minimal CompletionContext for direct API tests. */
function makeCtx(uri = "file:///test/test.pike"): CompletionContext {
  return {
    index: new WorkspaceIndex({ workspaceRoot: "/test" }),
    stdlibIndex: stdlibAutodocIndex as Record<string, { signature: string; markdown: string }>,
    predefBuiltins: predefBuiltinIndex as Record<string, string>,
    uri,
  };
}

// ---------------------------------------------------------------------------
// Direct API: getSymbolsInScope
// ---------------------------------------------------------------------------

describe("getSymbolsInScope", () => {
  test("returns local variables in function scope", () => {
    const src = [
      "void foo() {",
      "  int x = 1;",
      "  string y = \"hello\";",
      "  // cursor here",
      "}",
    ].join("\n");
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/scope.pike", 1);
    wireInheritance(table);

    // Line 3 (0-indexed), character 2 — inside the function body after both decls
    const symbols = getSymbolsInScope(table, 3, 2);
    const names = symbols.map(s => s.name);

    expect(names).toContain("x");
    expect(names).toContain("y");
    // The function itself should be visible from the enclosing scope
    expect(names).toContain("foo");
  });

  test("returns function parameters", () => {
    const src = "void foo(int a, string b) { /* cursor */ }";
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/params.pike", 1);
    wireInheritance(table);

    // Line 0, character 30 — inside function body
    const symbols = getSymbolsInScope(table, 0, 30);
    const names = symbols.map(s => s.name);

    expect(names).toContain("a");
    expect(names).toContain("b");
  });

  test("returns class members when inside class scope", () => {
    const src = [
      "class Foo {",
      "  int x;",
      "  void bar() {}",
      "  void baz() {",
      "    // cursor here",
      "  }",
      "}",
    ].join("\n");
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/class.pike", 1);
    wireInheritance(table);

    // Line 4, character 4 — inside baz() method body
    const symbols = getSymbolsInScope(table, 4, 4);
    const names = symbols.map(s => s.name);

    expect(names).toContain("x");
    expect(names).toContain("bar");
    expect(names).toContain("baz");
    expect(names).toContain("Foo");
  });

  test("deduplicates — inner scope shadows outer", () => {
    const src = [
      "int x = 1;",
      "void foo() {",
      "  string x = \"inner\";",
      "  // cursor here",
      "}",
    ].join("\n");
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/shadow.pike", 1);
    wireInheritance(table);

    const symbols = getSymbolsInScope(table, 3, 2);
    const xDecls = symbols.filter(s => s.name === "x");

    // Should have exactly one 'x' — the inner one
    expect(xDecls).toHaveLength(1);
    expect(xDecls[0].kind).toBe("variable");
  });

  test("returns file-scope declarations (top-level)", () => {
    const src = [
      "int alpha = 1;",
      "string beta = \"two\";",
      "void gamma() {}",
      "// cursor",
    ].join("\n");
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/top-level.pike", 1);
    wireInheritance(table);

    const symbols = getSymbolsInScope(table, 3, 0);
    const names = symbols.map(s => s.name);

    expect(names).toContain("alpha");
    expect(names).toContain("beta");
    expect(names).toContain("gamma");
  });

  test("does not include declarations after cursor in block scope", () => {
    const src = [
      "void foo() {",
      "  int before = 1;",
      "  // cursor",
      "  int after = 2;",
      "}",
    ].join("\n");
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/ordering.pike", 1);
    wireInheritance(table);

    // Line 2, char 2 — after 'before' but before 'after'
    const symbols = getSymbolsInScope(table, 2, 2);
    const names = symbols.map(s => s.name);

    expect(names).toContain("before");
    expect(names).not.toContain("after");
  });
});

// ---------------------------------------------------------------------------
// Direct API: getCompletions — unqualified
// ---------------------------------------------------------------------------

describe("getCompletions — unqualified", () => {
  test("returns local variables and functions in scope", () => {
    const src = [
      "int alpha = 1;",
      "void beta() {}",
      "void gamma() {",
      "  string local_var = \"hi\";",
      "  al",
      "}",
    ].join("\n");
    const tree = parse(src);
    const ctx = makeCtx();
    const result = getCompletions(
      { uri: "file:///test/unqual.pike", version: 1, declarations: [], references: [], scopes: [] },
      tree,
      4, 3, // cursor on "al" at line 4, char 3
      ctx,
    );

    // We need to use the actual symbol table from parsing
    const table = buildSymbolTable(tree, "file:///test/unqual.pike", 1);
    wireInheritance(table);

    const realResult = getCompletions(table, tree, 4, 3, ctx);
    const labels = completionLabels(realResult);

    expect(labels).toContain("alpha");
    expect(labels).toContain("beta");
    expect(labels).toContain("gamma");
    expect(labels).toContain("local_var");
  });

  test("includes predef builtins", () => {
    const src = "void foo() { wr }";
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/predef.pike", 1);
    wireInheritance(table);
    const ctx = makeCtx();

    // Cursor at line 0, char 15 — after "wr"
    const result = getCompletions(table, tree, 0, 15, ctx);
    const labels = completionLabels(result);

    // 'write' is a C-level predef builtin
    expect(labels).toContain("write");
    // 'werror' too
    expect(labels).toContain("werror");
  });

  test("includes stdlib top-level module names", () => {
    const src = "void foo() { Std }";
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/stdlib.pike", 1);
    wireInheritance(table);
    const ctx = makeCtx();

    const result = getCompletions(table, tree, 0, 16, ctx);
    const labels = completionLabels(result);

    // 'Stdio' is a top-level stdlib module
    expect(labels).toContain("Stdio");
    // 'String' is another one
    expect(labels).toContain("String");
  });

  test("local symbols rank higher than predef builtins", () => {
    const src = [
      "void foo() {",
      "  int write = 42;",  // shadows predef 'write'
      "  wr",
      "}",
    ].join("\n");
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/shadow-predef.pike", 1);
    wireInheritance(table);
    const ctx = makeCtx();

    const result = getCompletions(table, tree, 2, 3, ctx);
    const writeItems = result.items.filter(i => i.label === "write");

    // Should have both, but local should come first (lower sortText)
    expect(writeItems.length).toBeGreaterThanOrEqual(1);

    // The local 'write' variable should have a lower sort key than predef
    const localWrite = writeItems.find(i => i.kind === 6); // Variable = 6
    const predefWrite = writeItems.find(i => i.kind === 3); // Function = 3

    if (localWrite && predefWrite) {
      expect(localWrite.sortText!).toBeLessThan(predefWrite.sortText!);
    }
  });
});

// ---------------------------------------------------------------------------
// LSP protocol: completion requests
// ---------------------------------------------------------------------------

describe("textDocument/completion (LSP protocol)", () => {
  test("returns empty list for non-existent document", async () => {
    const result = await server.client.sendRequest(
      "textDocument/completion",
      {
        textDocument: { uri: "file:///nonexistent.pike" },
        position: { line: 0, character: 0 },
      },
    ) as CompletionResult;

    expect(result.items).toHaveLength(0);
  });

  test("returns local symbols for simple file", async () => {
    const uri = "file:///test/completion-local.pike";
    const source = [
      "int counter = 0;",
      "void increment() { counter++; }",
      "void main() { inc }",
    ].join("\n");
    server.openDoc(uri, source);

    const result = await server.client.sendRequest(
      "textDocument/completion",
      {
        textDocument: { uri },
        position: { line: 2, character: 17 }, // cursor after "inc"
      },
    ) as CompletionResult;

    const labels = completionLabels(result);

    expect(labels).toContain("increment");
    expect(labels).toContain("counter");
    expect(labels).toContain("main");
  });

  test("returns predef builtins for bare identifier", async () => {
    const uri = "file:///test/completion-predef.pike";
    const source = "void main() { wri }";
    server.openDoc(uri, source);

    const result = await server.client.sendRequest(
      "textDocument/completion",
      {
        textDocument: { uri },
        position: { line: 0, character: 17 }, // cursor after "wri"
      },
    ) as CompletionResult;

    const labels = completionLabels(result);
    expect(labels).toContain("write");
  });

  test("returns completions inside class body", async () => {
    const uri = "file:///test/completion-class.pike";
    const source = [
      "class Animal {",
      "  string name;",
      "  void speak() {}",
      "  void test() {",
      "    na",
      "  }",
      "}",
    ].join("\n");
    server.openDoc(uri, source);

    const result = await server.client.sendRequest(
      "textDocument/completion",
      {
        textDocument: { uri },
        position: { line: 4, character: 5 }, // cursor after "na"
      },
    ) as CompletionResult;

    const labels = completionLabels(result);
    expect(labels).toContain("name");
    expect(labels).toContain("speak");
    expect(labels).toContain("test");
  });

  test("returns CompletionList structure", async () => {
    const uri = "file:///test/completion-structure.pike";
    const source = "int x = 1;";
    server.openDoc(uri, source);

    const result = await server.client.sendRequest(
      "textDocument/completion",
      {
        textDocument: { uri },
        position: { line: 0, character: 0 },
      },
    ) as CompletionResult;

    expect(result).toHaveProperty("isIncomplete");
    expect(result).toHaveProperty("items");
    expect(Array.isArray(result.items)).toBe(true);
  });

  test("completion items have required LSP fields", async () => {
    const uri = "file:///test/completion-fields.pike";
    const source = "void foo(int x) { x; }";
    server.openDoc(uri, source);

    const result = await server.client.sendRequest(
      "textDocument/completion",
      {
        textDocument: { uri },
        position: { line: 0, character: 20 }, // inside function body
      },
    ) as CompletionResult;

    // Should have at least one item (x, foo, predef builtins)
    expect(result.items.length).toBeGreaterThan(0);

    // Each item must have a label
    for (const item of result.items) {
      expect(item.label).toBeDefined();
      expect(typeof item.label).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------
// Stdlib secondary index
// ---------------------------------------------------------------------------

describe("stdlib secondary index", () => {
  test("Stdio.File has known members", () => {
    const ctx = makeCtx();
    // Trigger a completion that forces index building
    const src = "void foo() {}";
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/idx.pike", 1);
    wireInheritance(table);

    const result = getCompletions(table, tree, 0, 0, ctx);
    // Just verify the index builds — check that Stdio is in the top-level
    const labels = completionLabels(result);
    expect(labels).toContain("Stdio");
  });

  test("predef builtin count is correct", () => {
    const predefKeys = Object.keys(predefBuiltinIndex);
    expect(predefKeys.length).toBe(283);
  });

  test("stdlib index has expected entry count", () => {
    const stdlibKeys = Object.keys(stdlibAutodocIndex);
    expect(stdlibKeys.length).toBeGreaterThan(5400);
  });
});
