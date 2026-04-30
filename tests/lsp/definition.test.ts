/**
 * Layer 1 tests for textDocument/definition — Phase 3 symbol resolution.
 *
 * Tests both:
 * - Direct API: buildSymbolTable + getDefinitionAt
 * - LSP protocol: client.sendRequest("textDocument/definition", ...)
 *
 * Uses corpus files + harness snapshots for real tree-sitter parsing.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createTestServer, type TestServer } from "./helpers";
import { initParser, parse } from "../../server/src/parser";
import {
  buildSymbolTable,
  wireInheritance,
  getDefinitionAt,
  getReferencesTo,
  type SymbolTable,
  type Declaration,
  type Reference,
} from "../../server/src/features/symbolTable";
import { readSnapshot } from "../../harness/src/snapshot";
import { listCorpusFiles, CORPUS_DIR } from "../../harness/src/runner";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readCorpusSource(filename: string): string {
  return readFileSync(join(CORPUS_DIR, filename), "utf-8");
}

function corpusUri(filename: string): string {
  return `file://${join(CORPUS_DIR, filename)}`;
}

function snapshotName(filename: string): string {
  return filename.replace(/\.(pike|pmod)$/, "");
}

/** Build symbol table from a corpus file. */
function buildTable(filename: string): SymbolTable {
  const src = readCorpusSource(filename);
  const tree = parse(src);
  return buildSymbolTable(tree, corpusUri(filename), 1);
}

/** Find a reference by name (first match). */
function findRef(table: SymbolTable, name: string): Reference | undefined {
  return table.references.find((r) => r.name === name);
}

/** Find a resolved reference by name (first match that resolves). */
function findResolvedRef(
  table: SymbolTable,
  name: string,
): { ref: Reference; decl: Declaration } | null {
  const ref = table.references.find(
    (r) => r.name === name && r.resolvesTo !== null,
  );
  if (!ref) return null;
  const decl = table.declarations.find((d) => d.id === ref.resolvesTo);
  if (!decl) return null;
  return { ref, decl };
}

/** Find a declaration by name and kind. */
function findDecl(
  table: SymbolTable,
  name: string,
  kind?: string,
): Declaration | undefined {
  return table.declarations.find(
    (d) => d.name === name && (kind === undefined || d.kind === kind),
  );
}

// ---------------------------------------------------------------------------
// Parser init (shared across all tests)
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await initParser();
});

// ===========================================================================
// 1. Direct API tests — top-level function definition
// ===========================================================================

describe("definition API: top-level functions", () => {
  test("basic-types.pike — main function declaration is found", () => {
    const table = buildTable("basic-types.pike");
    const mainDecl = findDecl(table, "main", "function");
    expect(mainDecl).toBeDefined();
    expect(mainDecl!.name).toBe("main");
    expect(mainDecl!.kind).toBe("function");
    expect(mainDecl!.nameRange.start.line).toBe(6);
    expect(mainDecl!.nameRange.start.character).toBe(4);
  });

  test("basic-types.pike — do_nothing function declaration is found", () => {
    const table = buildTable("basic-types.pike");
    const decl = findDecl(table, "do_nothing", "function");
    expect(decl).toBeDefined();
    expect(decl!.nameRange.start.line).toBe(41);
  });

  test("fn-types.pike — add function found at top level", () => {
    const table = buildTable("fn-types.pike");
    const decl = findDecl(table, "add", "function");
    expect(decl).toBeDefined();
    expect(decl!.name).toBe("add");
  });

  test("fn-types.pike — map_ints function found at top level", () => {
    const table = buildTable("fn-types.pike");
    const decl = findDecl(table, "map_ints", "function");
    expect(decl).toBeDefined();
  });

  test("fn-varargs.pike — join_strings and sum_ints found", () => {
    const table = buildTable("fn-varargs.pike");
    expect(findDecl(table, "join_strings", "function")).toBeDefined();
    expect(findDecl(table, "sum_ints", "function")).toBeDefined();
    expect(findDecl(table, "first_of", "function")).toBeDefined();
  });
});

// ===========================================================================
// 2. Direct API tests — top-level class definition
// ===========================================================================

describe("definition API: top-level classes", () => {
  test("class-create.pike — Base class declaration", () => {
    const table = buildTable("class-create.pike");
    const decl = findDecl(table, "Base", "class");
    expect(decl).toBeDefined();
    expect(decl!.nameRange.start.line).toBe(6);
  });

  test("class-create.pike — Middle class declaration", () => {
    const table = buildTable("class-create.pike");
    const decl = findDecl(table, "Middle", "class");
    expect(decl).toBeDefined();
    expect(decl!.nameRange.start.line).toBe(18);
  });

  test("class-create.pike — Leaf class declaration", () => {
    const table = buildTable("class-create.pike");
    const decl = findDecl(table, "Leaf", "class");
    expect(decl).toBeDefined();
    expect(decl!.nameRange.start.line).toBe(33);
  });

  test("class-single-inherit.pike — Animal, Dog, GuideDog classes", () => {
    const table = buildTable("class-single-inherit.pike");
    expect(findDecl(table, "Animal", "class")).toBeDefined();
    expect(findDecl(table, "Dog", "class")).toBeDefined();
    expect(findDecl(table, "GuideDog", "class")).toBeDefined();
  });

  test("class-this-object.pike — Builder class declaration", () => {
    const table = buildTable("class-this-object.pike");
    const decl = findDecl(table, "Builder", "class");
    expect(decl).toBeDefined();
    expect(decl!.nameRange.start.line).toBe(3);
  });
});

// ===========================================================================
// 3. Direct API tests — class member resolution
// ===========================================================================

describe("definition API: class member resolution", () => {
  test("class-create.pike — id resolves to class variable in Base", () => {
    const table = buildTable("class-create.pike");
    // id at line 10 (inside Base.create) should resolve to the class variable 'id'
    const result = findResolvedRef(table, "id");
    expect(result).not.toBeNull();
    // The declaration should be a variable inside the Base class scope
    expect(result!.decl.kind).toBe("variable");
    expect(result!.decl.name).toBe("id");
  });

  test("class-create.pike — label resolves to class variable in Middle", () => {
    const table = buildTable("class-create.pike");
    const result = findResolvedRef(table, "label");
    expect(result).not.toBeNull();
    expect(result!.decl.kind).toBe("variable");
    expect(result!.decl.name).toBe("label");
  });

  test("class-create.pike — weight resolves to class variable in Leaf", () => {
    const table = buildTable("class-create.pike");
    const result = findResolvedRef(table, "weight");
    expect(result).not.toBeNull();
    expect(result!.decl.kind).toBe("variable");
    expect(result!.decl.name).toBe("weight");
  });

  test("class-this-object.pike — buf resolves to class variable in Builder", () => {
    const table = buildTable("class-this-object.pike");
    // buf is referenced at line 8 (buf += s)
    const result = findResolvedRef(table, "buf");
    expect(result).not.toBeNull();
    expect(result!.decl.kind).toBe("variable");
    expect(result!.decl.name).toBe("buf");
  });

  test("class-single-inherit.pike — name resolves within Animal class scope", () => {
    const table = buildTable("class-single-inherit.pike");
    const result = findResolvedRef(table, "name");
    expect(result).not.toBeNull();
    // Should resolve to a variable declaration within the Animal class
    expect(result!.decl.kind).toBe("variable");
    expect(result!.decl.name).toBe("name");
    // The declaration's scope should be a class scope
    const scope = table.scopes.find((s) => s.id === result!.decl.scopeId);
    expect(scope).toBeDefined();
    expect(scope!.kind).toBe("class");
  });
});

// ===========================================================================
// 4. Direct API tests — parameter resolution
// ===========================================================================

describe("definition API: parameter resolution", () => {
  test("fn-types.pike — parameter a resolves in add function", () => {
    const table = buildTable("fn-types.pike");
    const paramA = findDecl(table, "a", "parameter");
    expect(paramA).toBeDefined();
    expect(paramA!.name).toBe("a");
    // Parameter scope should be a function scope
    const scope = table.scopes.find((s) => s.id === paramA!.scopeId);
    expect(scope).toBeDefined();
    expect(scope!.kind).toBe("function");
  });

  test("fn-types.pike — parameter b resolves in add function", () => {
    const table = buildTable("fn-types.pike");
    const paramB = findDecl(table, "b", "parameter");
    expect(paramB).toBeDefined();
  });

  test("fn-varargs.pike — parameter sep in join_strings", () => {
    const table = buildTable("fn-varargs.pike");
    const sep = findDecl(table, "sep", "parameter");
    expect(sep).toBeDefined();
  });

  test("fn-varargs.pike — parameter total in sum_ints resolves as variable", () => {
    const table = buildTable("fn-varargs.pike");
    const total = findDecl(table, "total", "variable");
    expect(total).toBeDefined();
  });

  test("class-single-inherit.pike — _name parameter in Animal.create resolves", () => {
    const table = buildTable("class-single-inherit.pike");
    const param = table.declarations.find(
      (d) => d.name === "_name" && d.kind === "parameter",
    );
    expect(param).toBeDefined();
    // _name at line 10 should be referenced at line 11
    const ref = table.references.find(
      (r) =>
        r.name === "_name" &&
        r.resolvesTo !== null &&
        r.loc.line === 11,
    );
    expect(ref).toBeDefined();
    expect(ref!.resolvesTo).toBe(param!.id);
  });
});

// ===========================================================================
// 5. Direct API tests — local variable resolution
// ===========================================================================

describe("definition API: local variable resolution", () => {
  test("basic-types.pike — 'anything' variable resolves to its declaration", () => {
    const table = buildTable("basic-types.pike");
    // anything is declared at line 26, referenced at line 27
    const result = findResolvedRef(table, "anything");
    expect(result).not.toBeNull();
    expect(result!.decl.name).toBe("anything");
    expect(result!.decl.kind).toBe("variable");
    expect(result!.decl.nameRange.start.line).toBe(26);
  });

  test("fn-types.pike — local variable 'sum' in main resolves", () => {
    const table = buildTable("fn-types.pike");
    const sumDecl = findDecl(table, "sum", "variable");
    expect(sumDecl).toBeDefined();
  });

  test("fn-lambda.pike — closure captures 'offset' from enclosing scope", () => {
    const table = buildTable("fn-lambda.pike");
    // offset is declared in main, referenced inside lambda
    const offsetDecl = findDecl(table, "offset", "variable");
    expect(offsetDecl).toBeDefined();
    // The lambda captures offset — reference at line 15 resolves to it
    const ref = table.references.find(
      (r) => r.name === "offset" && r.resolvesTo !== null,
    );
    expect(ref).toBeDefined();
    expect(ref!.resolvesTo).toBe(offsetDecl!.id);
  });

  test("fn-lambda.pike — counter captured by lambda closure", () => {
    const table = buildTable("fn-lambda.pike");
    const counterDecl = findDecl(table, "counter", "variable");
    expect(counterDecl).toBeDefined();
    // counter is referenced inside the lambda at line 45/46
    const refs = table.references.filter(
      (r) => r.name === "counter" && r.resolvesTo === counterDecl!.id,
    );
    expect(refs.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// 6. Direct API tests — inheritance scope
// ===========================================================================

describe("definition API: inheritance scope", () => {
  test("class-single-inherit.pike — Dog inherits Animal scope", () => {
    const table = buildTable("class-single-inherit.pike");
    // Dog class scope should have Animal's scope in inheritedScopes
    const dogScope = table.scopes.find(
      (s) => s.kind === "class" &&
        s.declarations.some((d) => {
          const decl = table.declarations.find((dd) => dd.id === d);
          return decl?.name === "breed";
        }),
    );
    expect(dogScope).toBeDefined();
    expect(dogScope!.inheritedScopes.length).toBeGreaterThan(0);
  });

  test("class-single-inherit.pike — Dog.create calls ::create resolving to Animal.create", () => {
    const table = buildTable("class-single-inherit.pike");
    // Line 29: ::create(_id, "woof") — scope_access to create in Animal
    const ref = table.references.find(
      (r) => r.kind === "scope_access" && r.name === "create" && r.loc.line === 29,
    );
    expect(ref).toBeDefined();
    expect(ref!.resolvesTo).not.toBeNull();
    const targetDecl = table.declarations.find((d) => d.id === ref!.resolvesTo);
    expect(targetDecl).toBeDefined();
    expect(targetDecl!.name).toBe("create");
    // Should be Animal's create (declared at line 10)
    expect(targetDecl!.nameRange.start.line).toBe(10);
  });

  test("class-single-inherit.pike — Dog.describe calls ::describe resolving to Animal.describe", () => {
    const table = buildTable("class-single-inherit.pike");
    const ref = table.references.find(
      (r) => r.kind === "scope_access" && r.name === "describe" && r.loc.line === 36,
    );
    expect(ref).toBeDefined();
    expect(ref!.resolvesTo).not.toBeNull();
    const targetDecl = table.declarations.find((d) => d.id === ref!.resolvesTo);
    expect(targetDecl).toBeDefined();
    expect(targetDecl!.name).toBe("describe");
    // Animal.describe at line 15
    expect(targetDecl!.nameRange.start.line).toBe(15);
  });

  test("class-single-inherit.pike — GuideDog inherits Dog which inherits Animal", () => {
    const table = buildTable("class-single-inherit.pike");
    // GuideDog's ::create should resolve to Dog's create
    const ref = table.references.find(
      (r) => r.kind === "scope_access" && r.name === "create" && r.loc.line === 49,
    );
    expect(ref).toBeDefined();
    expect(ref!.resolvesTo).not.toBeNull();
    const targetDecl = table.declarations.find((d) => d.id === ref!.resolvesTo);
    expect(targetDecl).toBeDefined();
    // Should be Middle's create (line 28 in Dog)
    expect(targetDecl!.nameRange.start.line).toBe(28);
  });

  test("class-create.pike — Middle inherits Base and ::create resolves to Base.create", () => {
    const table = buildTable("class-create.pike");
    const ref = table.references.find(
      (r) => r.kind === "scope_access" && r.name === "create" && r.loc.line === 24,
    );
    expect(ref).toBeDefined();
    expect(ref!.resolvesTo).not.toBeNull();
    const targetDecl = table.declarations.find((d) => d.id === ref!.resolvesTo);
    expect(targetDecl).toBeDefined();
    // Base.create at line 9
    expect(targetDecl!.nameRange.start.line).toBe(9);
  });
});

// ===========================================================================
// 7. Direct API tests — scope-aware shadowing
// ===========================================================================

describe("definition API: scope-aware shadowing", () => {
  test("parameter shadows outer variable of same name", () => {
    // Use fn-types.pike: parameter 'a' in add() is separate from any
    // local variable named 'a'
    const table = buildTable("fn-types.pike");
    const paramA = table.declarations.find(
      (d) => d.name === "a" && d.kind === "parameter",
    );
    const localA = table.declarations.find(
      (d) => d.name === "a" && d.kind === "variable",
    );
    expect(paramA).toBeDefined();
    // There should be a parameter 'a' — it may also have local 'a' elsewhere
    // but they must have different scope IDs
    if (localA) {
      expect(paramA!.scopeId).not.toBe(localA.scopeId);
    }
  });

  test("inline Pike — inner block variable shadows outer", () => {
    const src = `int main() {
    int x = 1;
    if (1) {
        int x = 2;
        return x;
    }
    return x;
}`;
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///shadow.pike", 1);

    // Should have two declarations for 'x'
    const xDecls = table.declarations.filter((d) => d.name === "x");
    expect(xDecls.length).toBeGreaterThanOrEqual(2);

    // Reference at line 4 (inside if block) should resolve to inner x
    const innerRef = table.references.find(
      (r) => r.name === "x" && r.loc.line === 4,
    );
    if (innerRef && innerRef.resolvesTo !== null) {
      const innerDecl = table.declarations.find(
        (d) => d.id === innerRef.resolvesTo,
      );
      expect(innerDecl).toBeDefined();
      expect(innerDecl!.nameRange.start.line).toBe(3); // inner x at line 3
    }

    // Reference at line 6 (outside if block) should resolve to outer x
    const outerRef = table.references.find(
      (r) => r.name === "x" && r.loc.line === 6,
    );
    if (outerRef && outerRef.resolvesTo !== null) {
      const outerDecl = table.declarations.find(
        (d) => d.id === outerRef.resolvesTo,
      );
      expect(outerDecl).toBeDefined();
      expect(outerDecl!.nameRange.start.line).toBe(1); // outer x at line 1
    }
  });
});

// ===========================================================================
// 7b. Scope handlers for while, switch, do-while (US-005)
// ===========================================================================

describe("definition API: while/switch/do-while scope isolation (US-005)", () => {
  beforeAll(async () => {
    await initParser();
  });

  test("while loop variables don't leak to enclosing scope", () => {
    const src = [
      'void test() {',
      '  int x = 1;',
      '  while (x > 0) {',
      '    int y = 2;',
      '    x = y - 1;',
      '  }',
      '  // y is not visible here',
      '}',
    ].join('\n');
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test-while.pike", 1);

    // y should be declared at line 3 (inside while body)
    const yDecl = table.declarations.find(d => d.name === 'y');
    expect(yDecl).toBeDefined();
    expect(yDecl!.nameRange.start.line).toBe(3);

    // y's scope should NOT be the function scope — it should be nested
    const funcScope = table.scopes.find(s => s.kind === 'function');
    expect(funcScope).toBeDefined();
    expect(yDecl!.scopeId).not.toBe(funcScope!.id);
  });

  test("switch case variables don't leak to enclosing scope", () => {
    const src = [
      'void test(int x) {',
      '  switch (x) {',
      '    case 1:',
      '      int a = 10;',
      '      break;',
      '    case 2:',
      '      int b = 20;',
      '      break;',
      '  }',
      '}',
    ].join('\n');
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test-switch.pike", 1);

    // a and b should be declared inside the switch body scope
    const aDecl = table.declarations.find(d => d.name === 'a');
    const bDecl = table.declarations.find(d => d.name === 'b');
    expect(aDecl).toBeDefined();
    expect(bDecl).toBeDefined();

    // Both should be in a scope nested under the function scope
    const funcScope = table.scopes.find(s => s.kind === 'function');
    expect(funcScope).toBeDefined();
    expect(aDecl!.scopeId).not.toBe(funcScope!.id);
    expect(bDecl!.scopeId).not.toBe(funcScope!.id);
  });

  test("do-while loop variables don't leak to enclosing scope", () => {
    const src = [
      'void test() {',
      '  int x = 0;',
      '  do {',
      '    int y = x + 1;',
      '    x = y;',
      '  } while (x < 10);',
      '}',
    ].join('\n');
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test-dowhile.pike", 1);

    // y should be declared inside the do-while body scope
    const yDecl = table.declarations.find(d => d.name === 'y');
    expect(yDecl).toBeDefined();
    expect(yDecl!.nameRange.start.line).toBe(3);

    // y's scope should NOT be the function scope
    const funcScope = table.scopes.find(s => s.kind === 'function');
    expect(funcScope).toBeDefined();
    expect(yDecl!.scopeId).not.toBe(funcScope!.id);
  });
});

// ===========================================================================
// 7c. Full scope chain for deeply nested variables (US-006)
// ===========================================================================

describe("definition API: deep scope chain resolution (US-006)", () => {
  beforeAll(async () => {
    await initParser();
  });

  test("variable in outer function scope resolves from 4 levels deep", () => {
    const src = readCorpusSource("nested-scope-chain.pike");
    const tree = parse(src);
    const table = buildSymbolTable(tree, corpusUri("nested-scope-chain.pike"), 1);

    // level3 = level0 + level1 + level2 is at line 18
    // level0 is at the outermost function scope (line 9)
    const level0Ref = table.references.find(
      r => r.name === 'level0' && r.loc.line === 18,
    );
    expect(level0Ref).toBeDefined();
    expect(level0Ref!.resolvesTo).not.toBeNull();

    const level0Decl = table.declarations.find(d => d.id === level0Ref!.resolvesTo);
    expect(level0Decl).toBeDefined();
    expect(level0Decl!.nameRange.start.line).toBe(9); // string level0
  });

  test("for-loop variable resolves from inside while/if nesting", () => {
    const src = readCorpusSource("nested-scope-chain.pike");
    const tree = parse(src);
    const table = buildSymbolTable(tree, corpusUri("nested-scope-chain.pike"), 1);

    // level1 is at line 12 (inside for loop)
    // level1 reference at line 18 should resolve to declaration at line 12
    const level1Refs = table.references.filter(
      r => r.name === 'level1' && r.loc.line === 18,
    );
    expect(level1Refs.length).toBeGreaterThanOrEqual(1);

    const decl = table.declarations.find(d => d.id === level1Refs[0].resolvesTo);
    expect(decl).toBeDefined();
    expect(decl!.nameRange.start.line).toBe(12);
  });

  test("getDefinitionAt resolves through 4 scope levels", () => {
    const src = readCorpusSource("nested-scope-chain.pike");
    const tree = parse(src);
    const table = buildSymbolTable(tree, corpusUri("nested-scope-chain.pike"), 1);

    // On line 18: string level3 = level0 + level1 + level2;
    const level0Ref = table.references.find(r => r.name === 'level0' && r.loc.line === 18);
    const level1Ref = table.references.find(r => r.name === 'level1' && r.loc.line === 18);
    const level2Ref = table.references.find(r => r.name === 'level2' && r.loc.line === 18);

    expect(level0Ref).toBeDefined();
    expect(level1Ref).toBeDefined();
    expect(level2Ref).toBeDefined();

    const def0 = getDefinitionAt(table, 18, level0Ref!.loc.character);
    const def1 = getDefinitionAt(table, 18, level1Ref!.loc.character);
    const def2 = getDefinitionAt(table, 18, level2Ref!.loc.character);

    expect(def0?.name).toBe('level0');
    expect(def1?.name).toBe('level1');
    expect(def2?.name).toBe('level2');
  });
});
// 8. Direct API tests — no definition for external symbols
// ===========================================================================

describe("definition API: unresolved external symbols", () => {
  test("basic-types.pike — Stdio reference resolves to null", () => {
    const table = buildTable("basic-types.pike");
    const stdioRef = table.references.find((r) => r.name === "Stdio");
    expect(stdioRef).toBeDefined();
    expect(stdioRef!.resolvesTo).toBeNull();
  });

  test("basic-types.pike — File dot_access resolves to null", () => {
    const table = buildTable("basic-types.pike");
    const fileRef = table.references.find(
      (r) => r.name === "File" && r.kind === "dot_access",
    );
    expect(fileRef).toBeDefined();
    expect(fileRef!.resolvesTo).toBeNull();
  });

  test("import-stdlib.pike — File() call resolves to null (external)", () => {
    const table = buildTable("import-stdlib.pike");
    const fileRef = table.references.find(
      (r) => r.name === "File" && r.resolvesTo === null,
    );
    expect(fileRef).toBeDefined();
  });

  test("stdlib-fileio.pike — Stdio references are unresolved", () => {
    const table = buildTable("stdlib-fileio.pike");
    const stdioRefs = table.references.filter(
      (r) => r.name === "Stdio" && r.resolvesTo === null,
    );
    expect(stdioRefs.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// 9. Direct API tests — enum resolution
// ===========================================================================

describe("definition API: enum resolution", () => {
  test("enum-basic.pike — Color enum declaration found", () => {
    const table = buildTable("enum-basic.pike");
    const colorDecl = findDecl(table, "Color", "enum");
    expect(colorDecl).toBeDefined();
    expect(colorDecl!.nameRange.start.line).toBe(7);
  });

  test("enum-basic.pike — RED resolves to enum_member", () => {
    const table = buildTable("enum-basic.pike");
    const redDecl = findDecl(table, "RED", "enum_member");
    expect(redDecl).toBeDefined();
    expect(redDecl!.nameRange.start.line).toBe(8);

    // Reference to RED at line 39 should resolve to this declaration
    const ref = table.references.find(
      (r) => r.name === "RED" && r.loc.line === 39,
    );
    expect(ref).toBeDefined();
    expect(ref!.resolvesTo).toBe(redDecl!.id);
  });

  test("enum-basic.pike — GREEN and BLUE resolve to enum_member", () => {
    const table = buildTable("enum-basic.pike");
    const greenDecl = findDecl(table, "GREEN", "enum_member");
    const blueDecl = findDecl(table, "BLUE", "enum_member");
    expect(greenDecl).toBeDefined();
    expect(blueDecl).toBeDefined();
  });

  test("enum-basic.pike — Color type reference resolves to enum", () => {
    const table = buildTable("enum-basic.pike");
    const colorTypeRef = table.references.find(
      (r) => r.name === "Color" && r.kind === "type_ref",
    );
    expect(colorTypeRef).toBeDefined();
    expect(colorTypeRef!.resolvesTo).not.toBeNull();
    const targetDecl = table.declarations.find(
      (d) => d.id === colorTypeRef!.resolvesTo,
    );
    expect(targetDecl).toBeDefined();
    expect(targetDecl!.kind).toBe("enum");
    expect(targetDecl!.name).toBe("Color");
  });

  test("enum-basic.pike — Status enum declaration found", () => {
    const table = buildTable("enum-basic.pike");
    const statusDecl = findDecl(table, "Status", "enum");
    expect(statusDecl).toBeDefined();
  });
});

// ===========================================================================
// 10. Direct API tests — getDefinitionAt
// ===========================================================================

describe("definition API: getDefinitionAt", () => {
  test("returns declaration for resolved reference position", () => {
    const table = buildTable("basic-types.pike");
    // anything is referenced at line 27, character 4
    const decl = getDefinitionAt(table, 27, 4);
    expect(decl).not.toBeNull();
    expect(decl!.name).toBe("anything");
    expect(decl!.kind).toBe("variable");
  });

  test("returns declaration when position is on declaration name", () => {
    const table = buildTable("basic-types.pike");
    // main is declared at line 6, character 4
    const decl = getDefinitionAt(table, 6, 5);
    expect(decl).not.toBeNull();
    expect(decl!.name).toBe("main");
    expect(decl!.kind).toBe("function");
  });

  test("returns null for empty file", () => {
    const tree = parse("");
    const table = buildSymbolTable(tree, "file:///empty.pike", 1);
    const decl = getDefinitionAt(table, 0, 0);
    expect(decl).toBeNull();
  });

  test("returns null for position with no reference or declaration", () => {
    const table = buildTable("basic-types.pike");
    // Line 0, col 0 is a comment, nothing there
    const decl = getDefinitionAt(table, 0, 0);
    expect(decl).toBeNull();
  });

  test("returns null for unresolved reference position", () => {
    const table = buildTable("basic-types.pike");
    // Stdio is at line 46, char 12, but resolvesTo is null
    const stdioRef = table.references.find((r) => r.name === "Stdio");
    if (stdioRef) {
      const decl = getDefinitionAt(
        table,
        stdioRef.loc.line,
        stdioRef.loc.character,
      );
      expect(decl).toBeNull();
    }
  });

  test("class member reference resolves via getDefinitionAt", () => {
    const table = buildTable("class-single-inherit.pike");
    // name at line 11, char 8 resolves to class variable
    const decl = getDefinitionAt(table, 11, 8);
    expect(decl).not.toBeNull();
    expect(decl!.name).toBe("name");
    expect(decl!.kind).toBe("variable");
  });
});

// ===========================================================================
// 11. Direct API tests — getReferencesTo
// ===========================================================================

describe("definition API: getReferencesTo", () => {
  test("finds all references to a variable", () => {
    const table = buildTable("basic-types.pike");
    // anything is declared at line 26, char 10
    const refs = getReferencesTo(table, 26, 10);
    expect(refs.length).toBeGreaterThan(0);
    // Should include the declaration itself and at least 2 references
    expect(refs.some((r) => r.loc.line === 27)).toBe(true);
    expect(refs.some((r) => r.loc.line === 28)).toBe(true);
  });

  test("finds references to a function declaration", () => {
    const table = buildTable("enum-basic.pike");
    // color_name declared at line 29, char 7
    const refs = getReferencesTo(table, 29, 7);
    expect(refs.length).toBeGreaterThan(0);
    // Should include the reference at line 40
    expect(refs.some((r) => r.loc.line === 40)).toBe(true);
  });

  test("returns empty for unresolved position", () => {
    const table = buildTable("basic-types.pike");
    const refs = getReferencesTo(table, 0, 0);
    expect(refs).toEqual([]);
  });
});

// ===========================================================================
// 12. Direct API tests — error files
// ===========================================================================

describe("definition API: error files produce partial results", () => {
  test("err-syntax-basic.pike — does not crash, returns a table", () => {
    const src = readCorpusSource("err-syntax-basic.pike");
    const tree = parse(src);
    expect(() =>
      buildSymbolTable(tree, "file:///err-syntax-basic.pike", 1),
    ).not.toThrow();
  });

  test("err-syntax-basic.pike — main function is still found", () => {
    const table = buildTable("err-syntax-basic.pike");
    const mainDecl = findDecl(table, "main", "function");
    expect(mainDecl).toBeDefined();
  });

  test("err-undef-var.pike — does not crash", () => {
    const table = buildTable("err-undef-var.pike");
    expect(table).toBeDefined();
    expect(Array.isArray(table.declarations)).toBe(true);
  });
});

// ===========================================================================
// 13. LSP protocol tests — textDocument/definition
// ===========================================================================

describe("definition LSP: textDocument/definition via protocol", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await createTestServer();
  });

  afterAll(async () => {
    await server.teardown();
  });

  test("returns Location for resolved reference", async () => {
    const src = readCorpusSource("basic-types.pike");
    const uri = server.openDoc(corpusUri("basic-types.pike"), src);
    // anything referenced at line 27, char 4
    const result = await server.client.sendRequest("textDocument/definition", {
      textDocument: { uri },
      position: { line: 27, character: 4 },
    });
    expect(result).not.toBeNull();
    expect(result.uri).toBe(uri);
    expect(result.range.start.line).toBe(26);
    expect(result.range.start.character).toBe(10);
  });

  test("returns Location for function declaration name", async () => {
    const src = readCorpusSource("basic-types.pike");
    const uri = server.openDoc(corpusUri("basic-types.pike"), src);
    // main declared at line 6, char 4
    const result = await server.client.sendRequest("textDocument/definition", {
      textDocument: { uri },
      position: { line: 6, character: 5 },
    });
    expect(result).not.toBeNull();
    expect(result.range.start.line).toBe(6);
    expect(result.range.start.character).toBe(4);
  });

  test("returns null for unknown document", async () => {
    const result = await server.client.sendRequest("textDocument/definition", {
      textDocument: { uri: "file:///nonexistent.pike" },
      position: { line: 0, character: 0 },
    });
    expect(result).toBeNull();
  });

  test("returns null for position with no definition", async () => {
    const src = readCorpusSource("basic-types.pike");
    const uri = server.openDoc(corpusUri("basic-types.pike"), src);
    const result = await server.client.sendRequest("textDocument/definition", {
      textDocument: { uri },
      position: { line: 0, character: 0 },
    });
    expect(result).toBeNull();
  });

  test("returns null for unresolved external symbol", async () => {
    const src = readCorpusSource("basic-types.pike");
    const uri = server.openDoc(corpusUri("basic-types.pike"), src);
    // Stdio at line 46, char 12
    const result = await server.client.sendRequest("textDocument/definition", {
      textDocument: { uri },
      position: { line: 46, character: 12 },
    });
    expect(result).toBeNull();
  });

  test("class member definition resolves via LSP", async () => {
    const src = readCorpusSource("class-single-inherit.pike");
    const uri = server.openDoc(corpusUri("class-single-inherit.pike"), src);
    // name at line 11, char 8 (inside Animal.create: name = _name)
    const result = await server.client.sendRequest("textDocument/definition", {
      textDocument: { uri },
      position: { line: 11, character: 8 },
    });
    expect(result).not.toBeNull();
    expect(result.uri).toBe(uri);
    // Should point to the 'name' variable declaration in Animal class
    expect(result.range.start.character).toBe(21); // protected string name
  });

  test("parameter definition resolves via LSP", async () => {
    const src = readCorpusSource("class-single-inherit.pike");
    const uri = server.openDoc(corpusUri("class-single-inherit.pike"), src);
    // _name referenced at line 11, char 15
    const result = await server.client.sendRequest("textDocument/definition", {
      textDocument: { uri },
      position: { line: 11, character: 15 },
    });
    expect(result).not.toBeNull();
    expect(result.range.start.line).toBe(10); // parameter declaration line
  });

  test("type reference resolves to class declaration via LSP", async () => {
    const src = readCorpusSource("class-single-inherit.pike");
    const uri = server.openDoc(corpusUri("class-single-inherit.pike"), src);
    // Dog at line 60, char 4 is a type_ref
    const result = await server.client.sendRequest("textDocument/definition", {
      textDocument: { uri },
      position: { line: 60, character: 4 },
    });
    expect(result).not.toBeNull();
    // Should resolve to Dog class declaration
    expect(result.range.start.line).toBe(24);
    expect(result.range.start.character).toBe(6);
  });

  test("inheritance scope access resolves via LSP", async () => {
    const src = readCorpusSource("class-single-inherit.pike");
    const uri = server.openDoc(corpusUri("class-single-inherit.pike"), src);
    // ::describe at line 36 — the scope_access
    // The 'describe' name is at col 17
    const result = await server.client.sendRequest("textDocument/definition", {
      textDocument: { uri },
      position: { line: 36, character: 17 },
    });
    expect(result).not.toBeNull();
    // Should resolve to Animal.describe (line 15)
    expect(result.range.start.line).toBe(15);
  });

  test("enum member resolves via LSP", async () => {
    const src = readCorpusSource("enum-basic.pike");
    const uri = server.openDoc(corpusUri("enum-basic.pike"), src);
    // RED at line 39, char 14
    const result = await server.client.sendRequest("textDocument/definition", {
      textDocument: { uri },
      position: { line: 39, character: 14 },
    });
    expect(result).not.toBeNull();
    expect(result.range.start.line).toBe(8);
    expect(result.range.start.character).toBe(4);
  });

  test("closure variable resolves via LSP", async () => {
    const src = readCorpusSource("fn-lambda.pike");
    const uri = server.openDoc(corpusUri("fn-lambda.pike"), src);
    // offset referenced inside lambda at line 15, char 19
    const result = await server.client.sendRequest("textDocument/definition", {
      textDocument: { uri },
      position: { line: 15, character: 19 },
    });
    expect(result).not.toBeNull();
    // Should resolve to offset declaration at line 13
    expect(result.range.start.line).toBe(13);
  });
});

// ===========================================================================
// 14. LSP protocol tests — textDocument/references
// ===========================================================================

describe("definition LSP: textDocument/references via protocol", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await createTestServer();
  });

  afterAll(async () => {
    await server.teardown();
  });

  test("finds references to top-level function", async () => {
    const src = readCorpusSource("enum-basic.pike");
    const uri = server.openDoc(corpusUri("enum-basic.pike"), src);
    // color_name declared at line 29, char 7
    const result = await server.client.sendRequest("textDocument/references", {
      textDocument: { uri },
      position: { line: 29, character: 7 },
      context: { includeDeclaration: true },
    });
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    // Should include the call site at line 40
    expect(result.some((r: any) => r.range.start.line === 40)).toBe(true);
  });

  test("finds references to class variable", async () => {
    const src = readCorpusSource("class-single-inherit.pike");
    const uri = server.openDoc(corpusUri("class-single-inherit.pike"), src);
    // 'name' class variable declared at line 7, char 21
    const result = await server.client.sendRequest("textDocument/references", {
      textDocument: { uri },
      position: { line: 7, character: 21 },
      context: { includeDeclaration: true },
    });
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(1);
    // Should include references at line 11 and line 16
    expect(result.some((r: any) => r.range.start.line === 11)).toBe(true);
    expect(result.some((r: any) => r.range.start.line === 16)).toBe(true);
  });

  test("returns empty for unknown document", async () => {
    const result = await server.client.sendRequest("textDocument/references", {
      textDocument: { uri: "file:///nonexistent.pike" },
      position: { line: 0, character: 0 },
      context: { includeDeclaration: true },
    });
    expect(result).toEqual([]);
  });
});

// ===========================================================================
// 15. Cross-check: resolved references match snapshot symbols
// ===========================================================================

describe("definition cross-check: resolved refs match snapshot symbols", () => {
  const corpusFiles = listCorpusFiles();
  const filesWithSymbols = corpusFiles.filter((f) => {
    const snap = readSnapshot(snapshotName(f));
    return (snap?.symbols?.length ?? 0) > 0 && !f.startsWith("err-");
  });

  test.each(filesWithSymbols)(
    "%s — all resolved identifier refs point to valid declarations",
    (filename: string) => {
      const table = buildTable(filename);
      for (const ref of table.references) {
        if (ref.resolvesTo !== null) {
          const decl = table.declarations.find((d) => d.id === ref.resolvesTo);
          expect(decl, `ref "${ref.name}" at L${ref.loc.line} resolves to id ${ref.resolvesTo} but no decl found`).toBeDefined();
          // this_ref resolves `this` to the class declaration, so names won't match
          if (ref.kind !== 'this_ref') {
            expect(decl!.name, `ref "${ref.name}" resolves to decl "${decl!.name}" — name mismatch`).toBe(ref.name);
          }
        }
      }
    },
  );

  test.each(filesWithSymbols)(
    "%s — snapshot top-level functions/classes have declarations",
    (filename: string) => {
      const table = buildTable(filename);
      const snap = readSnapshot(snapshotName(filename))!;
      for (const sym of snap.symbols) {
        if (sym.kind === "function" || sym.kind === "class") {
          // Pike may report function-typed variables as "function" but LSP parses them as "variable"
          const decl = table.declarations.find(
            (d) => d.name === sym.name && (d.kind === sym.kind || (sym.kind === "function" && d.kind === "variable")),
          );
          expect(
            decl,
            `Pike snapshot ${sym.kind} "${sym.name}" not found in declarations for ${filename}`,
          ).toBeDefined();
        }
      }
    },
  );
});


// ===========================================================================
// 16. Cross-file inherited member definition (US-001)
// ===========================================================================

describe("definition LSP: cross-file inherited member (US-001)", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await createTestServer();
  });

  afterAll(async () => {
    await server.teardown();
  });

  test("d->speak() resolves to Animal.speak in cross-file A", async () => {
    // Index file A first so B's wireInheritance can resolve Animal
    const srcA = readCorpusSource("cross-inherit-simple-a.pike");
    server.openDoc(corpusUri("cross-inherit-simple-a.pike"), srcA);

    const srcB = readCorpusSource("cross-inherit-simple-b.pike");
    const uriB = server.openDoc(corpusUri("cross-inherit-simple-b.pike"), srcB);

    // d->speak() — speak is at line 25, char 28
    const result = await server.client.sendRequest("textDocument/definition", {
      textDocument: { uri: uriB },
      position: { line: 25, character: 28 },
    });

    expect(result).not.toBeNull();
    // Should resolve to Animal.speak in file A
    expect(result.uri).toBe(corpusUri("cross-inherit-simple-a.pike"));
    expect(result.range.start.line).toBe(18); // speak() is declared at line 18 in file A
  });

  test("definition: d->speak() resolves via assignedType when declaredType is mixed (US-008)", async () => {
    const src = [
      'class Dog { void speak() {} }',
      'void test() {',
      '  mixed d = Dog();',
      '  d->speak();',
      '}',
    ].join('\n');
    const uri = server.openDoc("file:///test-assigned.pike", src);

    const result = await server.client.sendRequest("textDocument/definition", {
      textDocument: { uri },
      position: { line: 3, character: 5 }, // on 'speak'
    });

    // assignedType='Dog' should let the resolver find Dog.speak
    expect(result).not.toBeNull();
    expect(result.uri).toBe(uri);
    // Should point to the speak method inside Dog class
    expect(result.range.start.line).toBe(0); // Dog class is at line 0
  });
});