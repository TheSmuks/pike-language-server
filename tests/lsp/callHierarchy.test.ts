/**
 * Call hierarchy tests (T4.2).
 *
 * Tests prepareCallHierarchy, getIncomingCalls, and getOutgoingCalls
 * using mock SymbolTable and WorkspaceIndex. Follows the pattern from
 * codeLens.test.ts — pure unit tests, no LSP server needed.
 *
 * For getOutgoingCalls, a real tree-sitter parse is required to find
 * call nodes within a function body.
 *
 * Outgoing calls detect postfix_expr nodes with argument_list children,
 * matching tree-sitter-pike's AST representation for function calls.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Parser, Language } from "web-tree-sitter";
import type { SymbolTable, Declaration, Reference } from "../../server/src/features/symbolTable";
import type { WorkspaceIndex, FileEntry } from "../../server/src/features/workspaceIndex";
import {
  prepareCallHierarchy,
  getIncomingCalls,
  getOutgoingCalls,
} from "../../server/src/features/callHierarchy";
import type { CallHierarchyItem } from "vscode-languageserver/node";

let parser: Parser;

beforeAll(async () => {
  await Parser.init();
  parser = new Parser();
  const lang = await Language.load("./server/tree-sitter-pike.wasm");
  parser.setLanguage(lang);
});

afterAll(() => {
  parser.delete();
});

// ---------------------------------------------------------------------------
// Test factories
// ---------------------------------------------------------------------------

function makeDecl(overrides: Partial<Declaration> & { name: string; kind: Declaration["kind"] }): Declaration {
  return {
    id: overrides.id ?? Math.floor(Math.random() * 10000),
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

function makeTable(decls: Declaration[], refs?: Reference[]): SymbolTable {
  const declById = new Map(decls.map(d => [d.id, d]));
  return {
    uri: "file:///test/test.pike",
    version: 1,
    declarations: decls,
    references: refs ?? [],
    scopes: [{ id: 0, kind: "file" as const, range: { start: { line: 0, character: 0 }, end: { line: 100, character: 0 } }, parentId: null, declarations: decls.map(d => d.id), inheritedScopes: [] }],
    declById,
    scopeById: new Map([[0, { id: 0, kind: "file" as const, range: { start: { line: 0, character: 0 }, end: { line: 100, character: 0 } }, parentId: null, declarations: decls.map(d => d.id), inheritedScopes: [] }]]),
  };
}

/** Build a fake WorkspaceIndex with getCrossFileReferences and getFile. */
function makeWorkspaceIndex(
  refsByUri: Record<string, Array<{ uri: string; ref: Reference }>>,
  tablesByUri?: Record<string, SymbolTable>,
): WorkspaceIndex {
  return {
    getCrossFileReferences(_uri: string, _line: number, _character: number) {
      const key = `${_uri}:${_line}`;
      return refsByUri[key] ?? [];
    },
    getFile(uri: string): FileEntry | undefined {
      if (tablesByUri?.[uri]) {
        return { symbolTable: tablesByUri[uri], contentHash: "", dependencies: [], dependents: [], generation: 0 };
      }
      return undefined;
    },
    getAllEntries(): Array<{ uri: string; symbolTable: SymbolTable }> {
      if (!tablesByUri) return [];
      return Object.entries(tablesByUri).map(([uri, symbolTable]) => ({ uri, symbolTable }));
    },
  } as unknown as WorkspaceIndex;
}

// ---------------------------------------------------------------------------
// prepareCallHierarchy
// ---------------------------------------------------------------------------

describe("prepareCallHierarchy", () => {
  test("returns empty when no function at position", () => {
    const table = makeTable([
      makeDecl({ name: "x", kind: "variable", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } } }),
    ]);
    const result = prepareCallHierarchy(table, "file:///test/test.pike", 0, 0);
    expect(result).toEqual([]);
  });

  test("returns function when cursor is on function name", () => {
    const fn = makeDecl({
      name: "main",
      kind: "function",
      nameRange: { start: { line: 0, character: 4 }, end: { line: 0, character: 8 } },
      range: { start: { line: 0, character: 0 }, end: { line: 5, character: 1 } },
    });
    const table = makeTable([fn]);
    const result = prepareCallHierarchy(table, "file:///test/test.pike", 0, 4);
    expect(result.length).toBe(1);
    expect(result[0].name).toBe("main");
    expect(result[0].kind).toBe(12); // Function
  });

  test("returns method with kind=6", () => {
    const method = makeDecl({
      name: "speak",
      kind: "method",
      nameRange: { start: { line: 2, character: 6 }, end: { line: 2, character: 11 } },
      range: { start: { line: 2, character: 2 }, end: { line: 3, character: 3 } },
    });
    const table = makeTable([method]);
    const result = prepareCallHierarchy(table, "file:///test/test.pike", 2, 8);
    expect(result.length).toBe(1);
    expect(result[0].kind).toBe(6); // Method
  });

  test("returns innermost function when cursor is in nested function", () => {
    const outer = makeDecl({
      id: 1,
      name: "outer",
      kind: "function",
      nameRange: { start: { line: 0, character: 4 }, end: { line: 0, character: 9 } },
      range: { start: { line: 0, character: 0 }, end: { line: 10, character: 1 } },
    });
    const inner = makeDecl({
      id: 2,
      name: "inner",
      kind: "function",
      nameRange: { start: { line: 2, character: 6 }, end: { line: 2, character: 11 } },
      range: { start: { line: 2, character: 2 }, end: { line: 5, character: 3 } },
    });
    const table = makeTable([outer, inner]);

    // Cursor inside inner function body (line 3)
    const result = prepareCallHierarchy(table, "file:///test/test.pike", 3, 4);
    expect(result.length).toBe(1);
    expect(result[0].name).toBe("inner");
  });

  test("returns empty when cursor is outside any function", () => {
    const fn = makeDecl({
      name: "main",
      kind: "function",
      nameRange: { start: { line: 0, character: 4 }, end: { line: 0, character: 8 } },
      range: { start: { line: 0, character: 0 }, end: { line: 5, character: 1 } },
    });
    const table = makeTable([fn]);
    // Cursor on line 10 — outside the function range
    const result = prepareCallHierarchy(table, "file:///test/test.pike", 10, 0);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getIncomingCalls
// ---------------------------------------------------------------------------

describe("getIncomingCalls", () => {
  test("returns empty when no references found", () => {
    const index = makeWorkspaceIndex({});
    const item: CallHierarchyItem = {
      name: "target",
      kind: 12,
      uri: "file:///test/target.pike",
      range: { start: { line: 0, character: 0 }, end: { line: 5, character: 1 } },
      selectionRange: { start: { line: 0, character: 4 }, end: { line: 0, character: 10 } },
    };
    const result = getIncomingCalls(item, index);
    expect(result).toEqual([]);
  });

  test("returns callers grouped by function", () => {
    const callerFn = makeDecl({
      id: 1,
      name: "caller",
      kind: "function",
      nameRange: { start: { line: 0, character: 4 }, end: { line: 0, character: 10 } },
      range: { start: { line: 0, character: 0 }, end: { line: 5, character: 1 } },
    });
    const callerTable = makeTable([callerFn]);

    const ref: Reference = {
      name: "target",
      loc: { line: 2, character: 4 },
      kind: "call",
      resolvesTo: 99,
      confidence: "high",
    };

    const refsByUri = {
      "file:///test/target.pike:0": [
        { uri: "file:///test/caller.pike", ref },
      ],
    };
    const tablesByUri = {
      "file:///test/caller.pike": callerTable,
    };
    const index = makeWorkspaceIndex(refsByUri, tablesByUri);

    const item: CallHierarchyItem = {
      name: "target",
      kind: 12,
      uri: "file:///test/target.pike",
      range: { start: { line: 0, character: 0 }, end: { line: 5, character: 1 } },
      selectionRange: { start: { line: 0, character: 4 }, end: { line: 0, character: 10 } },
    };

    const result = getIncomingCalls(item, index);
    expect(result.length).toBe(1);
    expect(result[0].from.name).toBe("caller");
    expect(result[0].fromRanges.length).toBe(1);
    expect(result[0].fromRanges[0].start.line).toBe(2);
  });

  test("excludes self-references from same function", () => {
    const fn = makeDecl({
      id: 1,
      name: "recursive",
      kind: "function",
      nameRange: { start: { line: 0, character: 4 }, end: { line: 0, character: 13 } },
      range: { start: { line: 0, character: 0 }, end: { line: 5, character: 1 } },
    });
    const table = makeTable([fn]);

    const selfRef: Reference = {
      name: "recursive",
      loc: { line: 2, character: 4 },
      kind: "call",
      resolvesTo: 1,
      confidence: "high",
    };

    const refsByUri = {
      "file:///test/test.pike:0": [
        { uri: "file:///test/test.pike", ref: selfRef },
      ],
    };
    const tablesByUri = {
      "file:///test/test.pike": table,
    };
    const index = makeWorkspaceIndex(refsByUri, tablesByUri);

    const item: CallHierarchyItem = {
      name: "recursive",
      kind: 12,
      uri: "file:///test/test.pike",
      range: fn.range,
      selectionRange: fn.nameRange,
    };

    const result = getIncomingCalls(item, index);
    expect(result).toEqual([]);
  });

  test("merges multiple call sites from same caller", () => {
    const callerFn = makeDecl({
      id: 1,
      name: "multiCaller",
      kind: "function",
      nameRange: { start: { line: 0, character: 4 }, end: { line: 0, character: 15 } },
      range: { start: { line: 0, character: 0 }, end: { line: 10, character: 1 } },
    });
    const callerTable = makeTable([callerFn]);

    const ref1: Reference = { name: "target", loc: { line: 2, character: 4 }, kind: "call", resolvesTo: 99, confidence: "high" };
    const ref2: Reference = { name: "target", loc: { line: 5, character: 4 }, kind: "call", resolvesTo: 99, confidence: "high" };

    const refsByUri = {
      "file:///test/target.pike:0": [
        { uri: "file:///test/caller.pike", ref: ref1 },
        { uri: "file:///test/caller.pike", ref: ref2 },
      ],
    };
    const tablesByUri = {
      "file:///test/caller.pike": callerTable,
    };
    const index = makeWorkspaceIndex(refsByUri, tablesByUri);

    const item: CallHierarchyItem = {
      name: "target",
      kind: 12,
      uri: "file:///test/target.pike",
      range: { start: { line: 0, character: 0 }, end: { line: 5, character: 1 } },
      selectionRange: { start: { line: 0, character: 4 }, end: { line: 0, character: 10 } },
    };

    const result = getIncomingCalls(item, index);
    expect(result.length).toBe(1);
    expect(result[0].fromRanges.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// getOutgoingCalls
// ---------------------------------------------------------------------------

describe("getOutgoingCalls", () => {
  test("returns empty for function with no calls", () => {
    const src = [
      "int main() {",
      "  return 0;",
      "}",
    ].join("\n");
    const tree = parser.parse(src);

    const fn = makeDecl({
      name: "main",
      kind: "function",
      nameRange: { start: { line: 0, character: 4 }, end: { line: 0, character: 8 } },
      range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
    });
    const table = makeTable([fn]);
    const index = makeWorkspaceIndex({});

    const item: CallHierarchyItem = {
      name: "main",
      kind: 12,
      uri: "file:///test/test.pike",
      range: fn.range,
      selectionRange: fn.nameRange,
    };

    const result = getOutgoingCalls(item, tree, table, "file:///test/test.pike", index);
    expect(result).toEqual([]);
    tree.delete();
  });

  // Outgoing calls now correctly resolve through postfix_expr nodes.
  test("finds outgoing call to helper function", () => {
    const src = [
      "void caller() {",
      "  helper();",
      "}",
    ].join("\n");
    const tree = parser.parse(src);
    assert(tree, "Parse failed");

    const caller = makeDecl({
      id: 1,
      name: "caller",
      kind: "function",
      nameRange: { start: { line: 0, character: 5 }, end: { line: 0, character: 11 } },
      range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
    });
    const helper = makeDecl({
      id: 2,
      name: "helper",
      kind: "function",
      nameRange: { start: { line: 99, character: 5 }, end: { line: 99, character: 11 } },
      range: { start: { line: 99, character: 0 }, end: { line: 100, character: 1 } },
    });
    const table = makeTable([caller, helper]);
    const index = makeWorkspaceIndex({});

    const item: CallHierarchyItem = {
      name: "caller",
      kind: 12,
      uri: "file:///test/test.pike",
      range: caller.range,
      selectionRange: caller.nameRange,
    };

    const result = getOutgoingCalls(item, tree, table, "file:///test/test.pike", index);
    assert(result.length === 1, `Expected 1 outgoing call, got ${result.length}`);
    assert(result[0].to.name === "helper", `Expected callee "helper", got "${result[0].to.name}"`);
    tree.delete();
  });

  // Deduplication: multiple calls to the same function produce one outgoing entry.
  test("deduplicates multiple calls to the same function", () => {
    const src = [
      "void caller() {",
      "  helper();",
      "  helper();",
      "}",
    ].join("\n");
    const tree = parser.parse(src);
    assert(tree, "Parse failed");

    const caller = makeDecl({
      id: 1,
      name: "caller",
      kind: "function",
      nameRange: { start: { line: 0, character: 5 }, end: { line: 0, character: 11 } },
      range: { start: { line: 0, character: 0 }, end: { line: 3, character: 1 } },
    });
    const helper = makeDecl({
      id: 2,
      name: "helper",
      kind: "function",
      nameRange: { start: { line: 99, character: 5 }, end: { line: 99, character: 11 } },
      range: { start: { line: 99, character: 0 }, end: { line: 100, character: 1 } },
    });
    const table = makeTable([caller, helper]);
    const index = makeWorkspaceIndex({});

    const item: CallHierarchyItem = {
      name: "caller",
      kind: 12,
      uri: "file:///test/test.pike",
      range: caller.range,
      selectionRange: caller.nameRange,
    };

    const result = getOutgoingCalls(item, tree, table, "file:///test/test.pike", index);
    assert(result.length === 1, `Expected 1 deduplicated outgoing call, got ${result.length}`);
    tree.delete();
  });

  // Nested calls: foo(bar()) should produce two outgoing entries.
  test("finds nested calls", () => {
    const src = [
      "void caller() {",
      "  foo(bar());",
      "}",
    ].join("\n");
    const tree = parser.parse(src);
    assert(tree, "Parse failed");

    const caller = makeDecl({
      id: 1,
      name: "caller",
      kind: "function",
      nameRange: { start: { line: 0, character: 5 }, end: { line: 0, character: 11 } },
      range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
    });
    const foo = makeDecl({
      id: 2,
      name: "foo",
      kind: "function",
      nameRange: { start: { line: 50, character: 5 }, end: { line: 50, character: 8 } },
      range: { start: { line: 50, character: 0 }, end: { line: 51, character: 1 } },
    });
    const bar = makeDecl({
      id: 3,
      name: "bar",
      kind: "function",
      nameRange: { start: { line: 60, character: 5 }, end: { line: 60, character: 8 } },
      range: { start: { line: 60, character: 0 }, end: { line: 61, character: 1 } },
    });
    const table = makeTable([caller, foo, bar]);
    const index = makeWorkspaceIndex({});

    const item: CallHierarchyItem = {
      name: "caller",
      kind: 12,
      uri: "file:///test/test.pike",
      range: caller.range,
      selectionRange: caller.nameRange,
    };

    const result = getOutgoingCalls(item, tree, table, "file:///test/test.pike", index);
    const names = result.map(r => r.to.name).sort();
    assert(names.length === 2, `Expected 2 outgoing calls, got ${names.length}: ${names}`);
    assert(names[0] === "bar", `Expected "bar", got "${names[0]}"`);
    assert(names[1] === "foo", `Expected "foo", got "${names[1]}"`);
    tree.delete();
  });

  // Unresolved callee: function not in the symbol table — should not produce an entry.
  test("skips unresolved callees", () => {
    const src = [
      "void caller() {",
      "  unknown_func();",
      "}",
    ].join("\n");
    const tree = parser.parse(src);
    assert(tree, "Parse failed");

    const caller = makeDecl({
      id: 1,
      name: "caller",
      kind: "function",
      nameRange: { start: { line: 0, character: 5 }, end: { line: 0, character: 11 } },
      range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
    });
    const table = makeTable([caller]);
    const index = makeWorkspaceIndex({});

    const item: CallHierarchyItem = {
      name: "caller",
      kind: 12,
      uri: "file:///test/test.pike",
      range: caller.range,
      selectionRange: caller.nameRange,
    };

    const result = getOutgoingCalls(item, tree, table, "file:///test/test.pike", index);
    assert(result.length === 0, `Expected 0 outgoing calls for unresolved, got ${result.length}`);
    tree.delete();
  });
});

function assert(condition: unknown, msg: string): asserts condition {
  if (!condition) throw new Error(msg);
}
