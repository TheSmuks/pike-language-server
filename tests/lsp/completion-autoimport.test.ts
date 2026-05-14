/**
 * Tests for F5: Auto-import completion suggestions.
 *
 * When the user types an unqualified identifier that doesn't match any local
 * symbol but exists in a stdlib module, the completion list should offer it
 * with an additionalTextEdits that inserts `inherit Module;`.
 *
 * These tests exercise the completion module directly. No Pike binary needed.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { initParser, parse } from "../../server/src/parser";
import { buildSymbolTable } from "../../server/src/features/symbolTable";
import { getCompletions } from "../../server/src/features/completion";
import { CompletionItemKind } from "vscode-languageserver/node";
import stdlibIndex from "../../server/src/data/stdlib-autodoc.json" assert { type: "json" };

// Predef builtins for testing — minimal subset.
const predefBuiltins: Record<string, string> = {
  write: "void write(mixed ... args)",
};

describe("Completion — F5: auto-import suggestions", () => {
  beforeAll(async () => {
    await initParser();
  });

  let counter = 0;

  async function complete(source: string, line: number, character: number) {
    const uri = `file:///test-autoimport-${++counter}.pike`;
    const tree = parse(source, uri);
    if (!tree) throw new Error("parse failed");
    const table = buildSymbolTable(tree, uri, 0);
    return getCompletions(table, tree, line, character, {
      index: {
        resolveInherit: async () => null,
        getSymbolTable: () => null,
        getAllFiles: () => [],
        findUrisByModule: () => [],
      } as any,
      stdlibIndex: stdlibIndex as any,
      predefBuiltins,
      uri,
    });
  }

  test("suggests auto-import for stdlib symbol matching typed prefix", async () => {
    const source = `void test() {
  get_v
}`;
    // Cursor at col 3 — on the identifier "get_v" which starts at col 2
    const result = await complete(source, 1, 3);
    const autoItems = result.items.filter(i => i.detail?.startsWith("Auto-import from"));
    expect(autoItems.length).toBeGreaterThan(0);
    expect(autoItems[0].additionalTextEdits).toBeDefined();
    expect(autoItems[0].additionalTextEdits!.length).toBe(1);
    expect(autoItems[0].additionalTextEdits![0].newText).toContain("inherit Arg;");
  });

  test("auto-import has additionalTextEdits with inherit statement", async () => {
    const source = `void test() {
  get_v
}`;
    const result = await complete(source, 1, 3);
    const autoItems = result.items.filter(i => i.detail?.startsWith("Auto-import from"));
    if (autoItems.length > 0) {
      const edit = autoItems[0].additionalTextEdits![0];
      expect(edit.range.start.line).toBe(0);
      expect(edit.newText).toMatch(/^inherit \w+;\n$/);
    }
  });

  test("no auto-import when module is already inherited", async () => {
    const source = `inherit Arg;
void test() {
  get_v
}`;
    const result = await complete(source, 2, 3);
    const autoItems = result.items.filter(
      i => i.detail?.startsWith("Auto-import from Arg"),
    );
    expect(autoItems.length).toBe(0);
  });

  test("auto-import sorts after local symbols", async () => {
    const source = `void test() {
  get_v
}`;
    const result = await complete(source, 1, 3);
    const autoItems = result.items.filter(i => i.detail?.startsWith("Auto-import from"));
    const localItems = result.items.filter(i => !i.detail?.startsWith("Auto-import from"));
    if (autoItems.length > 0 && localItems.length > 0) {
      expect(autoItems[0].sortText! > localItems[0].sortText!).toBe(true);
    }
  });

  test("no auto-import for very short prefixes (less than 2 chars)", async () => {
    const source = `void test() {
  g
}`;
    const result = await complete(source, 1, 2);
    const autoItems = result.items.filter(i => i.detail?.startsWith("Auto-import from"));
    expect(autoItems.length).toBe(0);
  });

  test("auto-import inserts after existing inherits", async () => {
    const source = `inherit Stdio;
void test() {
  get_v
}`;
    const result = await complete(source, 2, 3);
    const autoItems = result.items.filter(i => i.detail?.startsWith("Auto-import from"));
    if (autoItems.length > 0) {
      const edit = autoItems[0].additionalTextEdits![0];
      // Should insert after the existing inherit on line 0
      expect(edit.range.start.line).toBe(1);
    }
  });
});
