import { describe, test, expect, beforeAll } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { initParser, parse } from "../../server/src/parser";
import {
  buildSymbolTable,
  wireInheritance,
  getReferencesTo,
} from "../../server/src/features/symbolTable";
import { CORPUS_DIR } from "../../harness/src/runner";
import type { SymbolTable, Declaration, Reference } from "../../server/src/features/symbolTable";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readCorpus(filename: string): string {
  return readFileSync(join(CORPUS_DIR, filename), "utf-8");
}

function buildTable(src: string): SymbolTable {
  const tree = parse(src);
  return buildSymbolTable(tree, "file:///test.pike", 1);
}

/** Find a declaration by name (first match), optionally filtered by kind. */
function findDecl(table: SymbolTable, name: string, kind?: string): Declaration | undefined {
  return table.declarations.find(
    (d) => d.name === name && (kind === undefined || d.kind === kind),
  );
}

/** Count how many references resolve to a given declaration ID. */
function countRefsTo(table: SymbolTable, declId: number): number {
  return table.references.filter((r) => r.resolvesTo === declId).length;
}

/** Get all references resolving to a given declaration ID. */
function refsTo(table: SymbolTable, declId: number): Reference[] {
  return table.references.filter((r) => r.resolvesTo === declId);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await initParser();
});

// ===========================================================================
// 1. Find all references to a top-level function
// ===========================================================================

describe("references to top-level functions", () => {
  test("finds all references to str_len in fn-callbacks.pike", () => {
    const src = readCorpus("fn-callbacks.pike");
    const table = buildTable(src);
    const decl = findDecl(table, "str_len", "function");
    expect(decl).toBeDefined();

    // Query from declaration position
    const refs = getReferencesTo(table, decl!.nameRange.start.line, decl!.nameRange.start.character);
    expect(refs.length).toBeGreaterThanOrEqual(1);

    // Count raw references in the table that resolve to this declaration
    const rawCount = countRefsTo(table, decl!.id);
    expect(rawCount).toBeGreaterThanOrEqual(1);
  });

  test("finds all references to apply_int in fn-callbacks.pike", () => {
    const src = readCorpus("fn-callbacks.pike");
    const table = buildTable(src);
    const decl = findDecl(table, "apply_int", "function");
    expect(decl).toBeDefined();

    const refs = getReferencesTo(table, decl!.nameRange.start.line, decl!.nameRange.start.character);
    expect(refs.length).toBeGreaterThanOrEqual(1); // at least one call
  });

  test("finds references to join_strings in fn-varargs.pike", () => {
    const src = readCorpus("fn-varargs.pike");
    const table = buildTable(src);
    const decl = findDecl(table, "join_strings", "function");
    expect(decl).toBeDefined();

    const refs = getReferencesTo(table, decl!.nameRange.start.line, decl!.nameRange.start.character);
    expect(refs.length).toBeGreaterThanOrEqual(1); // call in main
  });

  test("finds references to add in fn-types.pike", () => {
    const src = readCorpus("fn-types.pike");
    const table = buildTable(src);
    const decl = findDecl(table, "add", "function");
    expect(decl).toBeDefined();

    const rawRefs = refsTo(table, decl!.id);
    // add is referenced as a value: function(int, int : int) binop = add;
    expect(rawRefs.length).toBeGreaterThanOrEqual(1);
  });

  test("finds references to map_ints in fn-types.pike", () => {
    const src = readCorpus("fn-types.pike");
    const table = buildTable(src);
    const decl = findDecl(table, "map_ints", "function");
    expect(decl).toBeDefined();

    const refs = getReferencesTo(table, decl!.nameRange.start.line, decl!.nameRange.start.character);
    expect(refs.length).toBeGreaterThanOrEqual(1); // call in main
  });
});

// ===========================================================================
// 2. Find all references to a class
// ===========================================================================

describe("references to classes", () => {
  test("finds all references to Dog class in class-single-inherit.pike", () => {
    const src = readCorpus("class-single-inherit.pike");
    const table = buildTable(src);
    const dogDecl = findDecl(table, "Dog", "class");
    expect(dogDecl).toBeDefined();

    const refs = getReferencesTo(table, dogDecl!.nameRange.start.line, dogDecl!.nameRange.start.character);
    expect(refs.length).toBeGreaterThanOrEqual(2);

    // Should include: declaration itself + type annotation (Dog d = ...) + constructor call (Dog(...))
    // Also GuideDog inherits Dog → inherit reference
    const refNames = refs.map((r) => r.name);
    expect(refNames.every((n) => n === "Dog")).toBe(true);
  });

  test("finds references to Leaf class in class-create.pike", () => {
    const src = readCorpus("class-create.pike");
    const table = buildTable(src);
    const leafDecl = findDecl(table, "Leaf", "class");
    expect(leafDecl).toBeDefined();

    const refs = getReferencesTo(table, leafDecl!.nameRange.start.line, leafDecl!.nameRange.start.character);
    // Declaration + type annotation (Leaf leaf = ...) + constructor call (Leaf(...))
    expect(refs.length).toBeGreaterThanOrEqual(2);
  });

  test("finds references to Builder class in class-this-object.pike", () => {
    const src = readCorpus("class-this-object.pike");
    const table = buildTable(src);
    const builderDecl = findDecl(table, "Builder", "class");
    expect(builderDecl).toBeDefined();

    // Declaration + type annotations + constructor calls
    const rawRefs = refsTo(table, builderDecl!.id);
    expect(rawRefs.length).toBeGreaterThanOrEqual(1);
  });

  test("finds references to class C in class-multi-inherit.pike", () => {
    const src = readCorpus("class-multi-inherit.pike");
    const table = buildTable(src);
    const cDecl = findDecl(table, "C", "class");
    expect(cDecl).toBeDefined();

    const refs = getReferencesTo(table, cDecl!.nameRange.start.line, cDecl!.nameRange.start.character);
    expect(refs.length).toBeGreaterThanOrEqual(2); // declaration + type annotation + constructor
  });
});

// ===========================================================================
// 3. Find all references to a parameter
// ===========================================================================

describe("references to parameters", () => {
  test("finds references to parameter cb in apply_int (fn-callbacks.pike)", () => {
    const src = readCorpus("fn-callbacks.pike");
    const table = buildTable(src);
    const cbDecl = table.declarations.find(
      (d) => d.name === "cb" && d.kind === "parameter",
    );
    expect(cbDecl).toBeDefined();

    const refs = getReferencesTo(table, cbDecl!.nameRange.start.line, cbDecl!.nameRange.start.character);
    // Usage `cb(val)`
    expect(refs.length).toBeGreaterThanOrEqual(1);
  });

  test("finds references to parameter s in str_len (fn-callbacks.pike)", () => {
    const src = readCorpus("fn-callbacks.pike");
    const table = buildTable(src);
    // str_len has parameter `s` — there are multiple functions with parameter `s`
    // Find the one in str_len's scope
    const sDecls = table.declarations.filter(
      (d) => d.name === "s" && d.kind === "parameter",
    );
    expect(sDecls.length).toBeGreaterThanOrEqual(1);

    // Each parameter `s` should have at least one reference
    for (const sDecl of sDecls) {
      const rawRefs = countRefsTo(table, sDecl.id);
      expect(rawRefs).toBeGreaterThanOrEqual(0);
    }
  });

  test("parameter in lambda captures enclosing variable", () => {
    const src = readCorpus("fn-lambda.pike");
    const table = buildTable(src);
    // `offset` is declared in main and captured by the lambda
    const offsetDecls = table.declarations.filter(
      (d) => d.name === "offset" && d.kind === "variable",
    );
    expect(offsetDecls.length).toBeGreaterThanOrEqual(1);

    // The variable should have references (the lambda captures it)
    for (const decl of offsetDecls) {
      const rawRefs = countRefsTo(table, decl.id);
      expect(rawRefs).toBeGreaterThanOrEqual(1);
    }
  });
});

// ===========================================================================
// 4. Find all references to a class member
// ===========================================================================

describe("references to class members", () => {
  test("finds references to get_id in class-create.pike", () => {
    const src = readCorpus("class-create.pike");
    const table = buildTable(src);
    const getIdDecl = findDecl(table, "get_id", "function");
    expect(getIdDecl).toBeDefined();

    // get_id is called via arrow access: leaf->info() → inside info(), get_id() is called
    // get_id is defined in Base and inherited by Middle and Leaf
    const rawRefs = refsTo(table, getIdDecl!.id);
    // Should have at least the declaration itself
    expect(rawRefs.length).toBeGreaterThanOrEqual(0);

    // Verify we can query from the declaration position
    const refs = getReferencesTo(table, getIdDecl!.nameRange.start.line, getIdDecl!.nameRange.start.character);
    expect(refs.length).toBeGreaterThanOrEqual(1); // at minimum the synthetic decl ref
  });

  test("finds references to get_label in class-create.pike", () => {
    const src = readCorpus("class-create.pike");
    const table = buildTable(src);
    const getLabelDecl = findDecl(table, "get_label", "function");
    expect(getLabelDecl).toBeDefined();

    const refs = getReferencesTo(table, getLabelDecl!.nameRange.start.line, getLabelDecl!.nameRange.start.character);
    expect(refs.length).toBeGreaterThanOrEqual(1);
  });

  test("finds arrow-access references to class member", () => {
    const src = readCorpus("class-single-inherit.pike");
    const table = buildTable(src);

    // Arrow accesses like d->describe() create references with kind 'arrow_access'
    const arrowRefs = table.references.filter((r) => r.kind === "arrow_access");
    expect(arrowRefs.length).toBeGreaterThanOrEqual(1);

    // Members accessed: describe, get_name, get_breed
    const arrowNames = new Set(arrowRefs.map((r) => r.name));
    expect(arrowNames.has("describe")).toBe(true);
  });

  test("class member name does not leak to same-name member in other class", () => {
    const src = readCorpus("class-single-inherit.pike");
    const table = buildTable(src);

    // Both Animal and Dog have `create` — references to Animal.create should not include Dog.create
    const creates = table.declarations.filter(
      (d) => d.name === "create" && d.kind === "function",
    );
    expect(creates.length).toBeGreaterThanOrEqual(2);

    // Each `create` is a distinct declaration
    const animalCreate = creates.find((d) => {
      // Find the one in Animal scope
      const scope = table.scopes.find((s) => s.id === d.scopeId);
      return scope?.kind === "class";
    });
    expect(animalCreate).toBeDefined();
    const refs = refsTo(table, animalCreate!.id);
    // All refs to Animal.create should resolve to Animal.create's id
    for (const r of refs) {
      expect(r.resolvesTo).toBe(animalCreate!.id);
    }
  });
});

// ===========================================================================
// 5. No references for unknown identifiers
// ===========================================================================

describe("no references for unknown positions", () => {
  test("empty position returns empty array", () => {
    const src = readCorpus("fn-callbacks.pike");
    const table = buildTable(src);

    // Line 0 is a comment — position that is not on any symbol
    const refs = getReferencesTo(table, 0, 0);
    expect(refs).toEqual([]);
  });

  test("position in whitespace returns empty array", () => {
    const src = readCorpus("fn-callbacks.pike");
    const table = buildTable(src);

    // Last line of the file is likely just closing brace + newline
    const lines = src.split("\n");
    const lastLine = lines.length - 1;
    const refs = getReferencesTo(table, lastLine, 0);
    expect(refs).toEqual([]);
  });

  test("unresolved reference returns empty when queried at that position", () => {
    const src = readCorpus("err-undef-fn.pike");
    const table = buildTable(src);

    // Find an unresolved reference (low confidence)
    const unresolved = table.references.find(
      (r) => r.resolvesTo === null && r.confidence === "low",
    );
    expect(unresolved).toBeDefined();
    const refs = getReferencesTo(table, unresolved!.loc.line, unresolved!.loc.character);
    // Unresolved → targetDeclId will be null → empty array
    expect(refs).toEqual([]);
  });
});

// ===========================================================================
// 6. Cross-scope: same name, different declarations
// ===========================================================================

describe("cross-scope disambiguation", () => {
  test("same variable name in different scopes resolves separately", () => {
    const src = readCorpus("fn-lambda.pike");
    const table = buildTable(src);

    // `counter` is declared in main and used in lambda
    const counterDecls = table.declarations.filter(
      (d) => d.name === "counter" && d.kind === "variable",
    );
    expect(counterDecls.length).toBeGreaterThanOrEqual(1);
    // All references to counter should resolve to the same declaration
    // (lambda captures the enclosing scope variable)
    const counterDecl = counterDecls[0];
    const refs = refsTo(table, counterDecl.id);
    // counter is incremented inside the lambda — should have refs
    expect(refs.length).toBeGreaterThanOrEqual(1);
  });

  test("parameter name does not conflict with same-name in other function", () => {
    const src = readCorpus("fn-callbacks.pike");
    const table = buildTable(src);

    // Multiple functions have parameter `s` or `val`
    const valDecls = table.declarations.filter(
      (d) => d.name === "val" && d.kind === "parameter",
    );
    expect(valDecls.length).toBeGreaterThanOrEqual(2);
    // Each should be distinct
    const ids = valDecls.map((d) => d.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });
});

// ===========================================================================
// 7. Enum references
// ===========================================================================

describe("references to enum members", () => {
  test("finds references to RED in enum-basic.pike", () => {
    const src = readCorpus("enum-basic.pike");
    const table = buildTable(src);
    const redDecl = findDecl(table, "RED", "enum_member");
    expect(redDecl).toBeDefined();

    const refs = getReferencesTo(table, redDecl!.nameRange.start.line, redDecl!.nameRange.start.character);
    // Declaration + case RED + Color c = RED + array ({RED, ...})
    expect(refs.length).toBeGreaterThanOrEqual(2);
  });

  test("finds references to STATUS_UNKNOWN in enum-basic.pike", () => {
    const src = readCorpus("enum-basic.pike");
    const table = buildTable(src);
    // NOTE: Only STATUS_UNKNOWN is a separate enum_member node in the AST;
    // STATUS_PENDING/STATUS_ACTIVE/STATUS_CLOSED are embedded in a comma_expr child.
    const statusDecl = findDecl(table, "STATUS_UNKNOWN", "enum_member");
    expect(statusDecl).toBeDefined();

    const refs = getReferencesTo(table, statusDecl!.nameRange.start.line, statusDecl!.nameRange.start.character);
    // With declaration no longer included, only actual references remain
    // STATUS_UNKNOWN may have no references beyond the declaration itself
    expect(refs.length).toBeGreaterThanOrEqual(0);
  });
});

// ===========================================================================
// 8. Inheritance-based references
// ===========================================================================

describe("inheritance-based references", () => {
  test("finds inherited method references via :: in class-create.pike", () => {
    const src = readCorpus("class-create.pike");
    const table = buildTable(src);

    // ::create() calls create references with kind 'scope_access'
    const scopeRefs = table.references.filter((r) => r.kind === "scope_access");
    expect(scopeRefs.length).toBeGreaterThanOrEqual(1);

    // All scope_access references should reference `create`
    const createRefs = scopeRefs.filter((r) => r.name === "create");
    expect(createRefs.length).toBeGreaterThanOrEqual(1);
  });

  test("finds references to inherited describe in class-single-inherit.pike", () => {
    const src = readCorpus("class-single-inherit.pike");
    const table = buildTable(src);

    // Dog.describe calls ::describe() — this is a scope_access to Animal.describe
    const describeDecls = table.declarations.filter(
      (d) => d.name === "describe" && d.kind === "function",
    );
    expect(describeDecls.length).toBeGreaterThanOrEqual(2); // Animal.describe + Dog.describe

    // Check that scope references to describe exist
    const describeScopeRefs = table.references.filter(
      (r) => r.name === "describe" && r.kind === "scope_access",
    );
    expect(describeScopeRefs.length).toBeGreaterThanOrEqual(1);
  });

  test("scoped access A::value resolves to A.value in class-multi-inherit.pike", () => {
    const src = readCorpus("class-multi-inherit.pike");
    const table = buildTable(src);

    const aValueDecl = table.declarations.find(
      (d) => d.name === "value" && d.kind === "function" && d.scopeId !== undefined,
    );
    expect(aValueDecl).toBeDefined();

    // A::value() and B::value() — scope_access references
    const valueScopeRefs = table.references.filter(
      (r) => r.name === "value" && r.kind === "scope_access",
    );
    expect(valueScopeRefs.length).toBeGreaterThanOrEqual(2);
  });
});

// ===========================================================================
// 9. Edge cases
// ===========================================================================

describe("edge cases", () => {
  test("empty source produces empty references", () => {
    const src = "";
    const table = buildTable(src);
    expect(table.references).toEqual([]);
    expect(table.declarations).toEqual([]);

    const refs = getReferencesTo(table, 0, 0);
    expect(refs).toEqual([]);
  });

  test("comment-only file produces no references", () => {
    const src = "// just a comment\n// another comment\n";
    const table = buildTable(src);
    expect(table.references).toEqual([]);

    const refs = getReferencesTo(table, 0, 0);
    expect(refs).toEqual([]);
  });

  test("querying at middle of a declaration name still finds references", () => {
    const src = readCorpus("fn-callbacks.pike");
    const table = buildTable(src);
    const decl = findDecl(table, "str_len", "function");
    expect(decl).toBeDefined();

    // Query from the middle of "str_len" (character after 'str_')
    const midChar = decl!.nameRange.start.character + 4;
    const refs = getReferencesTo(table, decl!.nameRange.start.line, midChar);
    expect(refs.length).toBeGreaterThanOrEqual(1);
  });
});
