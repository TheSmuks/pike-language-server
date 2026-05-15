/**
 * CodeLens provider tests.
 *
 * Tests the reference-count code lens feature:
 *   produceCodeLenses(symbolTable, tree, uri, workspaceIndex) → CodeLens[]
 *
 * Verifies that lenses are produced for function/method declarations with
 * references, skipped for zero-reference declarations, and omitted for
 * non-function declarations (classes, variables).
 */

import { describe, test, expect } from "bun:test";
import { produceCodeLenses } from "../../server/src/features/codeLens";
import type { CodeLens } from "vscode-languageserver/node";
import type { SymbolTable, Declaration } from "../../server/src/features/symbolTable";
import type { Tree } from "web-tree-sitter";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal SymbolTable with the given declarations. */
function makeTable(decls: Partial<Declaration>[]): SymbolTable {
  return {
    uri: "file:///a.pike",
    version: 1,
    scopes: [],
    references: [],
    declById: new Map(),
    scopeById: new Map(),
    declarations: decls.map((d, i) => ({
      id: i,
      name: d.name ?? `decl${i}`,
      kind: d.kind ?? "function",
      range: d.range ?? {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 10 },
      },
      nameRange: d.nameRange ?? {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 5 },
      },
      scopeId: d.scopeId ?? 0,
      ...d,
    })) as Declaration[],
  };
}

/** Build a fake WorkspaceIndex that returns canned cross-file references. */
function makeWorkspaceIndex(
  refsByUri: Record<string, { ref: { loc: { line: number; character: number } } }[]>,
) {
  return {
    getCrossFileReferences(uri: string, line: number, _character: number) {
      const key = `${uri}:${line}`;
      return refsByUri[key] ?? [];
    },
  } as any;
}

/** A fake Tree — produceCodeLenses only uses it as a passthrough arg. */
const fakeTree = {} as Tree;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("produceCodeLenses", () => {
  test("returns empty array when there are no declarations", () => {
    const table = makeTable([]);
    const index = makeWorkspaceIndex({});
    const lenses = produceCodeLenses(table, fakeTree, "file:///a.pike", index);
    expect(lenses).toEqual([]);
  });

  test("skips declarations with zero references", () => {
    const table = makeTable([
      { kind: "function", name: "unused", nameRange: { start: { line: 5, character: 0 }, end: { line: 5, character: 6 } } },
    ]);
    const index = makeWorkspaceIndex({});
    const lenses = produceCodeLenses(table, fakeTree, "file:///a.pike", index);
    expect(lenses).toEqual([]);
  });

  test("produces lens for function with references", () => {
    const table = makeTable([
      {
        kind: "function",
        name: "myFunc",
        nameRange: { start: { line: 3, character: 4 }, end: { line: 3, character: 10 } },
      },
    ]);
    const index = makeWorkspaceIndex({
      "file:///a.pike:3": [
        // A reference from a different location (not the declaration itself)
        { ref: { loc: { line: 10, character: 2 } } },
        { ref: { loc: { line: 20, character: 5 } } },
      ],
    });
    const lenses = produceCodeLenses(table, fakeTree, "file:///a.pike", index);

    expect(lenses.length).toBe(1);
    expect(lenses[0].range.start.line).toBe(3);
    expect(lenses[0].range.start.character).toBe(4);
    expect(lenses[0].command?.title).toBe("2 references");
    expect(lenses[0].command?.command).toBe("pike.showReferences");
  });

  test("produces singular 'reference' for exactly 1 reference", () => {
    const table = makeTable([
      {
        kind: "method",
        name: "doThing",
        nameRange: { start: { line: 7, character: 0 }, end: { line: 7, character: 6 } },
      },
    ]);
    const index = makeWorkspaceIndex({
      "file:///a.pike:7": [
        { ref: { loc: { line: 15, character: 0 } } },
      ],
    });
    const lenses = produceCodeLenses(table, fakeTree, "file:///a.pike", index);

    expect(lenses.length).toBe(1);
    expect(lenses[0].command?.title).toBe("1 reference");
  });

  test("skips non-function/method declarations even with references", () => {
    const table = makeTable([
      { kind: "class", name: "Foo", nameRange: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } } },
      { kind: "variable", name: "bar", nameRange: { start: { line: 2, character: 0 }, end: { line: 2, character: 3 } } },
    ]);
    const index = makeWorkspaceIndex({
      "file:///a.pike:1": [{ ref: { loc: { line: 10, character: 0 } } }],
      "file:///a.pike:2": [{ ref: { loc: { line: 11, character: 0 } } }],
    });
    const lenses = produceCodeLenses(table, fakeTree, "file:///a.pike", index);
    expect(lenses).toEqual([]);
  });

  test("excludes self-reference from count", () => {
    const table = makeTable([
      {
        kind: "function",
        name: "recursive",
        nameRange: { start: { line: 4, character: 0 }, end: { line: 4, character: 9 } },
      },
    ]);
    const index = makeWorkspaceIndex({
      "file:///a.pike:4": [
        // This reference is at the same position as the declaration — should be excluded
        { ref: { loc: { line: 4, character: 0 } } },
      ],
    });
    const lenses = produceCodeLenses(table, fakeTree, "file:///a.pike", index);
    // Zero references after excluding self-reference → no lens
    expect(lenses).toEqual([]);
  });

  test("handles multiple function declarations with mixed reference counts", () => {
    const table = makeTable([
      {
        kind: "function",
        name: "used",
        nameRange: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } },
      },
      {
        kind: "function",
        name: "alsoUsed",
        nameRange: { start: { line: 5, character: 0 }, end: { line: 5, character: 8 } },
      },
      {
        kind: "function",
        name: "notUsed",
        nameRange: { start: { line: 10, character: 0 }, end: { line: 10, character: 6 } },
      },
    ]);
    const index = makeWorkspaceIndex({
      "file:///a.pike:1": [{ ref: { loc: { line: 20, character: 0 } } }],
      "file:///a.pike:5": [{ ref: { loc: { line: 21, character: 0 } } }, { ref: { loc: { line: 22, character: 0 } } }, { ref: { loc: { line: 23, character: 0 } } }],
      "file:///a.pike:10": [],
    });
    const lenses = produceCodeLenses(table, fakeTree, "file:///a.pike", index);

    expect(lenses.length).toBe(2);
    expect(lenses[0].command?.title).toBe("1 reference");
    expect(lenses[1].command?.title).toBe("3 references");
  });
});
