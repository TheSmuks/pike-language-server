/**
 * CodeLens provider tests.
 *
 * Tests the lazily-resolved reference-count code lens feature:
 *   produceCodeLenses(symbolTable, uri) → CodeLens[]        (bare, no counts)
 *   resolveCodeLens(lens, workspaceIndex) → CodeLens        (fills in count)
 *
 * produce emits one lens per function/method declaration (counts are computed
 * on resolve, so zero-reference declarations show "0 references" rather than
 * being hidden). Non-function declarations (classes, variables) are omitted.
 */

import { describe, test, expect } from "bun:test";
import { produceCodeLenses, resolveCodeLens } from "../../server/src/features/codeLens";
import type { SymbolTable, Declaration } from "../../server/src/features/symbolTable";

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
/**
 * The real getCrossFileReferences returns `{ uri, ref }` — the URI matters,
 * because only a reference in the lens's OWN file can be the declaration's own
 * occurrence. Entries default to the queried URI unless one is given.
 */
function makeWorkspaceIndex(
  refsByUri: Record<string, Array<{
    uri?: string;
    ref: { loc: { line: number; character: number } };
  }>>,
) {
  return {
    getCrossFileReferences(uri: string, line: number, _character: number) {
      const key = `${uri}:${line}`;
      return (refsByUri[key] ?? []).map(entry => ({ uri: entry.uri ?? uri, ...entry }));
    },
  } as any;
}

// ---------------------------------------------------------------------------
// produce
// ---------------------------------------------------------------------------

describe("produceCodeLenses", () => {
  test("returns empty array when there are no declarations", () => {
    const lenses = produceCodeLenses(makeTable([]), "file:///a.pike");
    expect(lenses).toEqual([]);
  });

  test("emits a bare lens (no command) per function/method declaration", () => {
    const table = makeTable([
      { kind: "function", name: "a", nameRange: { start: { line: 3, character: 4 }, end: { line: 3, character: 5 } } },
      { kind: "method", name: "b", nameRange: { start: { line: 7, character: 0 }, end: { line: 7, character: 1 } } },
    ]);
    const lenses = produceCodeLenses(table, "file:///a.pike");
    expect(lenses.length).toBe(2);
    expect(lenses[0].command).toBeUndefined();
    expect(lenses[0].range.start.line).toBe(3);
    expect(lenses[0].range.start.character).toBe(4);
    expect(lenses[0].data).toEqual({ uri: "file:///a.pike", line: 3, character: 4 });
  });

  test("omits non-function/method declarations", () => {
    const table = makeTable([
      { kind: "class", name: "Foo", nameRange: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } } },
      { kind: "variable", name: "bar", nameRange: { start: { line: 2, character: 0 }, end: { line: 2, character: 3 } } },
    ]);
    expect(produceCodeLenses(table, "file:///a.pike")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// resolve
// ---------------------------------------------------------------------------

describe("resolveCodeLens", () => {
  test("fills in the reference count (plural)", () => {
    const table = makeTable([
      { kind: "function", name: "myFunc", nameRange: { start: { line: 3, character: 4 }, end: { line: 3, character: 10 } } },
    ]);
    const index = makeWorkspaceIndex({
      "file:///a.pike:3": [
        { ref: { loc: { line: 10, character: 2 } } },
        { ref: { loc: { line: 20, character: 5 } } },
      ],
    });
    const [lens] = produceCodeLenses(table, "file:///a.pike");
    const resolved = resolveCodeLens(lens, index);
    expect(resolved.command?.title).toBe("2 references");
    expect(resolved.command?.command).toBe("pike.showReferences");
  });

  test("uses singular 'reference' for exactly 1", () => {
    const table = makeTable([
      { kind: "method", name: "doThing", nameRange: { start: { line: 7, character: 0 }, end: { line: 7, character: 6 } } },
    ]);
    const index = makeWorkspaceIndex({
      "file:///a.pike:7": [{ ref: { loc: { line: 15, character: 0 } } }],
    });
    const [lens] = produceCodeLenses(table, "file:///a.pike");
    expect(resolveCodeLens(lens, index).command?.title).toBe("1 reference");
  });

  test("shows '0 references' for an unreferenced declaration", () => {
    const table = makeTable([
      { kind: "function", name: "unused", nameRange: { start: { line: 5, character: 0 }, end: { line: 5, character: 6 } } },
    ]);
    const index = makeWorkspaceIndex({});
    const [lens] = produceCodeLenses(table, "file:///a.pike");
    expect(resolveCodeLens(lens, index).command?.title).toBe("0 references");
  });

  test("excludes the self-reference from the count", () => {
    const table = makeTable([
      { kind: "function", name: "recursive", nameRange: { start: { line: 4, character: 0 }, end: { line: 4, character: 9 } } },
    ]);
    const index = makeWorkspaceIndex({
      // Reference at the declaration's own position — must be excluded.
      "file:///a.pike:4": [{ ref: { loc: { line: 4, character: 0 } } }],
    });
    const [lens] = produceCodeLenses(table, "file:///a.pike");
    expect(resolveCodeLens(lens, index).command?.title).toBe("0 references");
  });

  test("counts a reference at the same position in a DIFFERENT file", () => {
    const table = makeTable([
      { kind: "function", name: "greet", nameRange: { start: { line: 4, character: 0 }, end: { line: 4, character: 5 } } },
    ]);
    const index = makeWorkspaceIndex({
      // Same line and column as the declaration, but another file — a real
      // call, not the declaration's own occurrence. The exclusion used to drop
      // it because it never compared the URI, so the lens said the function
      // was dead.
      "file:///a.pike:4": [{ uri: "file:///b.pike", ref: { loc: { line: 4, character: 0 } } }],
    });
    const [lens] = produceCodeLenses(table, "file:///a.pike");
    expect(resolveCodeLens(lens, index).command?.title).toBe("1 reference");
  });

  test("returns the lens unchanged when it carries no data payload", () => {
    const index = makeWorkspaceIndex({});
    const bare = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } };
    expect(resolveCodeLens(bare, index).command).toBeUndefined();
  });
});
