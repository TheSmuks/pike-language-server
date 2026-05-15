/**
 * Type hierarchy tests.
 *
 * Tests prepareTypeHierarchy, getSupertypes, and getSubtypes
 * using mock SymbolTable and WorkspaceIndex. Follows the pattern from
 * callHierarchy.test.ts — pure unit tests, no LSP server needed.
 */

import { describe, test, expect } from "bun:test";
import type { SymbolTable, Declaration, Scope } from "../../server/src/features/symbolTable";
import type { WorkspaceIndex, FileEntry } from "../../server/src/features/workspaceIndex";
import {
  prepareTypeHierarchy,
  getSupertypes,
  getSubtypes,
} from "../../server/src/features/typeHierarchy";
import type { TypeHierarchyItem } from "vscode-languageserver/node";
import { SymbolKind } from "vscode-languageserver/node";

// ---------------------------------------------------------------------------
// Test factories
// ---------------------------------------------------------------------------

let nextId = 1;

function makeDecl(overrides: Partial<Declaration> & { name: string; kind: Declaration["kind"] }): Declaration {
  return {
    id: overrides.id ?? nextId++,
    name: overrides.name,
    kind: overrides.kind,
    nameRange: overrides.nameRange ?? {
      start: { line: 0, character: 0 },
      end: { line: 0, character: overrides.name.length },
    },
    range: overrides.range ?? {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 10 },
    },
    scopeId: overrides.scopeId ?? 0,
  };
}

function makeScope(overrides: Partial<Scope> & { id: number; kind: Scope["kind"] }): Scope {
  return {
    id: overrides.id,
    kind: overrides.kind,
    range: overrides.range ?? { start: { line: 0, character: 0 }, end: { line: 100, character: 0 } },
    parentId: overrides.parentId ?? null,
    declarations: overrides.declarations ?? [],
    inheritedScopes: overrides.inheritedScopes ?? [],
  };
}

function makeTable(decls: Declaration[], scopes: Scope[]): SymbolTable {
  const declById = new Map(decls.map(d => [d.id, d]));
  const scopeById = new Map(scopes.map(s => [s.id, s]));
  return {
    uri: "file:///test/test.pike",
    version: 1,
    declarations: decls,
    references: [],
    scopes,
    declById,
    scopeById,
  };
}

/** Build a fake WorkspaceIndex with getAllEntries. */
function makeWorkspaceIndex(
  entries: Array<{ uri: string; symbolTable: SymbolTable }>,
): WorkspaceIndex {
  return {
    getAllEntries(): Array<{ uri: string; symbolTable: SymbolTable }> {
      return entries;
    },
  } as unknown as WorkspaceIndex;
}

/** Reset ID counter between tests */
function resetIds(): void {
  nextId = 1;
}

// ---------------------------------------------------------------------------
// prepareTypeHierarchy
// ---------------------------------------------------------------------------

describe("prepareTypeHierarchy", () => {
  test("returns null when no class at position", () => {
    resetIds();
    const variable = makeDecl({
      name: "x",
      kind: "variable",
      nameRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
    });
    const scopes = [
      makeScope({ id: 0, kind: "file", declarations: [variable.id] }),
    ];
    const table = makeTable([variable], scopes);
    const result = prepareTypeHierarchy(table, "file:///test/test.pike", 0, 0);
    expect(result).toBeNull();
  });

  test("returns class when cursor is on class name", () => {
    resetIds();
    const cls = makeDecl({
      name: "Animal",
      kind: "class",
      nameRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 12 } },
      range: { start: { line: 0, character: 0 }, end: { line: 5, character: 1 } },
      scopeId: 0,
    });
    const classScope = makeScope({ id: 1, kind: "class", parentId: 0, declarations: [], range: { start: { line: 0, character: 0 }, end: { line: 5, character: 1 } } });
    const fileScope = makeScope({ id: 0, kind: "file", declarations: [cls.id] });
    const table = makeTable([cls], [fileScope, classScope]);

    const result = prepareTypeHierarchy(table, "file:///test/test.pike", 0, 8);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(1);
    expect(result![0].name).toBe("Animal");
    expect(result![0].kind).toBe(SymbolKind.Class);
  });

  test("returns innermost class when cursor is in nested class body", () => {
    resetIds();
    const outer = makeDecl({
      id: 1,
      name: "Outer",
      kind: "class",
      nameRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
      range: { start: { line: 0, character: 0 }, end: { line: 10, character: 1 } },
      scopeId: 0,
    });
    const inner = makeDecl({
      id: 2,
      name: "Inner",
      kind: "class",
      nameRange: { start: { line: 2, character: 8 }, end: { line: 2, character: 13 } },
      range: { start: { line: 2, character: 2 }, end: { line: 8, character: 3 } },
      scopeId: 10, // will be the outer class scope
    });
    const fileScope = makeScope({ id: 0, kind: "file", declarations: [outer.id] });
    const outerScope = makeScope({ id: 10, kind: "class", parentId: 0, declarations: [inner.id], range: { start: { line: 0, character: 0 }, end: { line: 10, character: 1 } } });
    const innerScope = makeScope({ id: 20, kind: "class", parentId: 10, declarations: [], range: { start: { line: 2, character: 2 }, end: { line: 8, character: 3 } } });
    const table = makeTable([outer, inner], [fileScope, outerScope, innerScope]);

    // Cursor on line 5 — inside inner class
    const result = prepareTypeHierarchy(table, "file:///test/test.pike", 5, 4);
    expect(result).not.toBeNull();
    expect(result![0].name).toBe("Inner");
  });

  test("returns null when cursor is outside any class", () => {
    resetIds();
    const cls = makeDecl({
      name: "Foo",
      kind: "class",
      nameRange: { start: { line: 2, character: 6 }, end: { line: 2, character: 9 } },
      range: { start: { line: 2, character: 0 }, end: { line: 5, character: 1 } },
      scopeId: 0,
    });
    const fileScope = makeScope({ id: 0, kind: "file", declarations: [cls.id] });
    const classScope = makeScope({ id: 1, kind: "class", parentId: 0, declarations: [], range: { start: { line: 2, character: 0 }, end: { line: 5, character: 1 } } });
    const table = makeTable([cls], [fileScope, classScope]);

    // Cursor on line 10 — outside class
    const result = prepareTypeHierarchy(table, "file:///test/test.pike", 10, 0);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getSupertypes
// ---------------------------------------------------------------------------

describe("getSupertypes", () => {
  test("returns empty when class has no inheritance", () => {
    resetIds();
    const base = makeDecl({
      name: "Base",
      kind: "class",
      nameRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 10 } },
      range: { start: { line: 0, character: 0 }, end: { line: 5, character: 1 } },
      scopeId: 0,
    });
    const fileScope = makeScope({ id: 0, kind: "file", declarations: [base.id] });
    const classScope = makeScope({ id: 1, kind: "class", parentId: 0, declarations: [], inheritedScopes: [], range: { start: { line: 0, character: 0 }, end: { line: 5, character: 1 } } });
    const table = makeTable([base], [fileScope, classScope]);
    const index = makeWorkspaceIndex([]);

    const item: TypeHierarchyItem = {
      name: "Base",
      kind: SymbolKind.Class,
      uri: "file:///test/test.pike",
      range: base.range,
      selectionRange: base.nameRange,
    };

    const result = getSupertypes(index, table, "file:///test/test.pike", item);
    expect(result).toEqual([]);
  });

  test("returns parent class from inheritedScopes", () => {
    resetIds();
    // Base class
    const base = makeDecl({
      id: 1,
      name: "Base",
      kind: "class",
      nameRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 10 } },
      range: { start: { line: 0, character: 0 }, end: { line: 3, character: 1 } },
      scopeId: 0,
    });
    // Child class
    const child = makeDecl({
      id: 2,
      name: "Child",
      kind: "class",
      nameRange: { start: { line: 5, character: 6 }, end: { line: 5, character: 11 } },
      range: { start: { line: 5, character: 0 }, end: { line: 10, character: 1 } },
      scopeId: 0,
    });

    const fileScope = makeScope({ id: 0, kind: "file", declarations: [base.id, child.id] });
    const baseScope = makeScope({ id: 10, kind: "class", parentId: 0, declarations: [], inheritedScopes: [], range: { start: { line: 0, character: 0 }, end: { line: 3, character: 1 } } });
    const childScope = makeScope({ id: 20, kind: "class", parentId: 0, declarations: [], inheritedScopes: [baseScope.id], range: { start: { line: 5, character: 0 }, end: { line: 10, character: 1 } } });

    const table = makeTable([base, child], [fileScope, baseScope, childScope]);
    const index = makeWorkspaceIndex([]);

    const item: TypeHierarchyItem = {
      name: "Child",
      kind: SymbolKind.Class,
      uri: "file:///test/test.pike",
      range: child.range,
      selectionRange: child.nameRange,
    };

    const result = getSupertypes(index, table, "file:///test/test.pike", item);
    expect(result.length).toBe(1);
    expect(result[0].name).toBe("Base");
  });

  test("returns multiple parent classes for multiple inheritance", () => {
    resetIds();
    const parentA = makeDecl({
      id: 1,
      name: "ParentA",
      kind: "class",
      nameRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } },
      range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
      scopeId: 0,
    });
    const parentB = makeDecl({
      id: 2,
      name: "ParentB",
      kind: "class",
      nameRange: { start: { line: 4, character: 6 }, end: { line: 4, character: 13 } },
      range: { start: { line: 4, character: 0 }, end: { line: 6, character: 1 } },
      scopeId: 0,
    });
    const child = makeDecl({
      id: 3,
      name: "Child",
      kind: "class",
      nameRange: { start: { line: 8, character: 6 }, end: { line: 8, character: 11 } },
      range: { start: { line: 8, character: 0 }, end: { line: 12, character: 1 } },
      scopeId: 0,
    });

    const fileScope = makeScope({ id: 0, kind: "file", declarations: [parentA.id, parentB.id, child.id] });
    const parentAScope = makeScope({ id: 10, kind: "class", parentId: 0, declarations: [], inheritedScopes: [], range: parentA.range });
    const parentBScope = makeScope({ id: 20, kind: "class", parentId: 0, declarations: [], inheritedScopes: [], range: parentB.range });
    const childScope = makeScope({ id: 30, kind: "class", parentId: 0, declarations: [], inheritedScopes: [10, 20], range: child.range });

    const table = makeTable([parentA, parentB, child], [fileScope, parentAScope, parentBScope, childScope]);
    const index = makeWorkspaceIndex([]);

    const item: TypeHierarchyItem = {
      name: "Child",
      kind: SymbolKind.Class,
      uri: "file:///test/test.pike",
      range: child.range,
      selectionRange: child.nameRange,
    };

    const result = getSupertypes(index, table, "file:///test/test.pike", item);
    expect(result.length).toBe(2);
    const names = result.map(r => r.name).sort();
    expect(names).toEqual(["ParentA", "ParentB"]);
  });
});

// ---------------------------------------------------------------------------
// getSubtypes
// ---------------------------------------------------------------------------

describe("getSubtypes", () => {
  test("returns empty when no class inherits from target", () => {
    resetIds();
    const base = makeDecl({
      name: "Base",
      kind: "class",
      nameRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 10 } },
      range: { start: { line: 0, character: 0 }, end: { line: 3, character: 1 } },
      scopeId: 0,
    });
    const fileScope = makeScope({ id: 0, kind: "file", declarations: [base.id] });
    const baseScope = makeScope({ id: 10, kind: "class", parentId: 0, declarations: [], inheritedScopes: [], range: base.range });
    const table = makeTable([base], [fileScope, baseScope]);
    const index = makeWorkspaceIndex([{ uri: "file:///test/test.pike", symbolTable: table }]);

    const item: TypeHierarchyItem = {
      name: "Base",
      kind: SymbolKind.Class,
      uri: "file:///test/test.pike",
      range: base.range,
      selectionRange: base.nameRange,
    };

    const result = getSubtypes(index, "file:///test/test.pike", item);
    expect(result).toEqual([]);
  });

  test("returns child class that inherits from target", () => {
    resetIds();
    const base = makeDecl({
      id: 1,
      name: "Base",
      kind: "class",
      nameRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 10 } },
      range: { start: { line: 0, character: 0 }, end: { line: 3, character: 1 } },
      scopeId: 0,
    });
    const child = makeDecl({
      id: 2,
      name: "Child",
      kind: "class",
      nameRange: { start: { line: 5, character: 6 }, end: { line: 5, character: 11 } },
      range: { start: { line: 5, character: 0 }, end: { line: 10, character: 1 } },
      scopeId: 0,
    });

    const fileScope = makeScope({ id: 0, kind: "file", declarations: [base.id, child.id] });
    const baseScope = makeScope({ id: 10, kind: "class", parentId: 0, declarations: [], inheritedScopes: [], range: base.range });
    const childScope = makeScope({ id: 20, kind: "class", parentId: 0, declarations: [], inheritedScopes: [baseScope.id], range: child.range });

    const table = makeTable([base, child], [fileScope, baseScope, childScope]);
    const index = makeWorkspaceIndex([{ uri: "file:///test/test.pike", symbolTable: table }]);

    const item: TypeHierarchyItem = {
      name: "Base",
      kind: SymbolKind.Class,
      uri: "file:///test/test.pike",
      range: base.range,
      selectionRange: base.nameRange,
    };

    const result = getSubtypes(index, "file:///test/test.pike", item);
    expect(result.length).toBe(1);
    expect(result[0].name).toBe("Child");
  });

  test("finds subtypes across multiple files", () => {
    resetIds();
    // File 1: Base class
    const base = makeDecl({
      id: 1,
      name: "Base",
      kind: "class",
      nameRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 10 } },
      range: { start: { line: 0, character: 0 }, end: { line: 3, character: 1 } },
      scopeId: 0,
    });
    const file1Scope = makeScope({ id: 0, kind: "file", declarations: [base.id] });
    const baseScope = makeScope({ id: 10, kind: "class", parentId: 0, declarations: [], inheritedScopes: [], range: base.range });
    const table1 = makeTable([base], [file1Scope, baseScope]);

    // File 2: Child class with inherit declaration matching Base
    const child = makeDecl({
      id: 2,
      name: "Child",
      kind: "class",
      nameRange: { start: { line: 1, character: 6 }, end: { line: 1, character: 11 } },
      range: { start: { line: 1, character: 0 }, end: { line: 5, character: 1 } },
      scopeId: 100,
    });
    const inheritDecl = makeDecl({
      id: 3,
      name: "Base",
      kind: "inherit",
      nameRange: { start: { line: 2, character: 10 }, end: { line: 2, character: 14 } },
      range: { start: { line: 2, character: 2 }, end: { line: 2, character: 14 } },
      scopeId: 200,
    });
    const file2Scope = makeScope({ id: 100, kind: "file", declarations: [child.id] });
    // Child scope contains inherit decl and has Base in inheritedScopes
    const childScope = makeScope({
      id: 200,
      kind: "class",
      parentId: 100,
      declarations: [inheritDecl.id],
      inheritedScopes: [],  // Base not in same file, but inherit decl is here
      range: child.range,
    });
    const table2 = makeTable([child, inheritDecl], [file2Scope, childScope]);

    const index = makeWorkspaceIndex([
      { uri: "file:///test/base.pike", symbolTable: table1 },
      { uri: "file:///test/child.pike", symbolTable: table2 },
    ]);

    const item: TypeHierarchyItem = {
      name: "Base",
      kind: SymbolKind.Class,
      uri: "file:///test/base.pike",
      range: base.range,
      selectionRange: base.nameRange,
    };

    const result = getSubtypes(index, "file:///test/base.pike", item);
    // The child has an inherit declaration matching "Base" name
    expect(result.length).toBe(1);
    expect(result[0].name).toBe("Child");
  });
});
