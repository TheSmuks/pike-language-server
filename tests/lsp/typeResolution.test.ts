/**
 * Type resolution tests (decision 0014).
 *
 * Tests resolveType() and resolveMemberAccess() from typeResolver.ts.
 * Covers: same-file, primitives, recursion guards, member access, definition integration.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { readFileSync } from "fs";
import { initParser, parse } from "../../server/src/parser";
import {
  buildSymbolTable,
  wireInheritance,
  type SymbolTable,
  type Declaration,
} from "../../server/src/features/symbolTable";
import {
  resolveType,
  resolveMemberAccess,
  type TypeResolutionContext,
} from "../../server/src/features/typeResolver";
import { WorkspaceIndex, ModificationSource } from "../../server/src/features/workspaceIndex";
import stdlibAutodocIndex from "../../server/src/data/stdlib-autodoc.json";
import { createTestServer, type TestServer } from "./helpers";
import { resetCompletionCache } from "../../server/src/features/completion";

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
  resetCompletionCache();
});

afterAll(async () => {
  await server.teardown();
  resetCompletionCache();
});

/** Build a minimal TypeResolutionContext for direct API tests. */
function makeTypeCtx(
  table: SymbolTable,
  uri = "file:///test/test.pike",
  wsIndex?: WorkspaceIndex,
): TypeResolutionContext {
  return {
    table,
    uri,
    index: wsIndex ?? new WorkspaceIndex({ workspaceRoot: "/test" }),
    stdlibIndex: stdlibAutodocIndex as Record<string, { signature: string; markdown: string }>,
  };
}

// ---------------------------------------------------------------------------
// resolveType — same-file class resolution
// ---------------------------------------------------------------------------

describe("resolveType — same-file", () => {
  test("resolves same-file class by name", () => {
    const src = 'class Animal { string name; } Animal a;';
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/a.pike", 1);
    const ctx = makeTypeCtx(table, "file:///test/a.pike");

    const result = resolveType("Animal", ctx);
    expect(result).not.toBeNull();
    expect(result!.decl.name).toBe("Animal");
    expect(result!.decl.kind).toBe("class");
    expect(result!.uri).toBe("file:///test/a.pike");
  });

  test("returns null for primitive types", () => {
    const src = 'int x;';
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/a.pike", 1);
    const ctx = makeTypeCtx(table);

    for (const t of ["int", "string", "mixed", "void", "float", "bool", "zero"]) {
      expect(resolveType(t, ctx)).toBeNull();
    }
  });

  test("returns null for unknown types", () => {
    const src = 'NonExistent x;';
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/a.pike", 1);
    const ctx = makeTypeCtx(table);

    expect(resolveType("NonExistent", ctx)).toBeNull();
  });

  test("returns null for empty type name", () => {
    const src = 'int x;';
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/a.pike", 1);
    const ctx = makeTypeCtx(table);

    expect(resolveType("", ctx)).toBeNull();
  });

  test("resolves correct class when multiple exist", () => {
    const src = 'class Dog { void bark() {} } class Cat { void meow() {} }';
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/a.pike", 1);
    const ctx = makeTypeCtx(table);

    const dog = resolveType("Dog", ctx);
    expect(dog).not.toBeNull();
    expect(dog!.decl.name).toBe("Dog");

    const cat = resolveType("Cat", ctx);
    expect(cat).not.toBeNull();
    expect(cat!.decl.name).toBe("Cat");
  });

  test("returns null for object/function/program types", () => {
    const src = 'object a; function b; program c;';
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/a.pike", 1);
    const ctx = makeTypeCtx(table);

    expect(resolveType("object", ctx)).toBeNull();
    expect(resolveType("function", ctx)).toBeNull();
    expect(resolveType("program", ctx)).toBeNull();
  });

  test("returns null for compound types (array, mapping, multiset)", () => {
    const src = 'array a; mapping b; multiset c;';
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/a.pike", 1);
    const ctx = makeTypeCtx(table);

    expect(resolveType("array", ctx)).toBeNull();
    expect(resolveType("mapping", ctx)).toBeNull();
    expect(resolveType("multiset", ctx)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveMemberAccess — same-file declared type
// ---------------------------------------------------------------------------

describe("resolveMemberAccess — same-file", () => {
  test("resolves member through declared type variable", () => {
    const src = 'class Animal { string name; int age; void speak() {} } void test() { Animal a; a->name }';
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/a.pike", 1);
    wireInheritance(table);
    const ctx = makeTypeCtx(table);

    const varA = table.declarations.find(d => d.name === "a" && d.kind === "variable");
    expect(varA).not.toBeUndefined();

    const member = resolveMemberAccess("a", "name", varA!, ctx);
    expect(member).not.toBeNull();
    expect(member!.name).toBe("name");
  });

  test("resolves method through declared type parameter", () => {
    const src = 'class Dog { void bark() {} } void train(Dog d) { d->bark }';
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/a.pike", 1);
    wireInheritance(table);
    const ctx = makeTypeCtx(table);

    const paramD = table.declarations.find(d => d.name === "d" && d.kind === "parameter");
    expect(paramD).not.toBeUndefined();

    const member = resolveMemberAccess("d", "bark", paramD!, ctx);
    expect(member).not.toBeNull();
    expect(member!.name).toBe("bark");
  });

  test("resolves inherited member through class LHS", () => {
    const src = 'class Base { void greet() {} } class Child { inherit Base; void child_method() {} }';
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/a.pike", 1);
    wireInheritance(table);
    const ctx = makeTypeCtx(table);

    const childClass = table.declarations.find(d => d.name === "Child" && d.kind === "class");
    expect(childClass).not.toBeUndefined();

    const member = resolveMemberAccess("c", "greet", childClass!, ctx);
    expect(member).not.toBeNull();
    expect(member!.name).toBe("greet");
  });

  test("returns null for mixed type variable", () => {
    const src = 'void test() { mixed x; x->something }';
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/a.pike", 1);
    wireInheritance(table);
    const ctx = makeTypeCtx(table);

    const varX = table.declarations.find(d => d.name === "x" && d.kind === "variable");
    expect(varX).not.toBeUndefined();

    const member = resolveMemberAccess("x", "something", varX!, ctx);
    expect(member).toBeNull();
  });

  test("returns null when member does not exist in class", () => {
    const src = 'class Animal { string name; } void test() { Animal a; a->nonexistent }';
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/a.pike", 1);
    wireInheritance(table);
    const ctx = makeTypeCtx(table);

    const varA = table.declarations.find(d => d.name === "a" && d.kind === "variable");
    expect(varA).not.toBeUndefined();

    const member = resolveMemberAccess("a", "nonexistent", varA!, ctx);
    expect(member).toBeNull();
  });

  test("returns null when no lhs declaration provided", () => {
    const src = 'void test() { x->method }';
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/a.pike", 1);
    const ctx = makeTypeCtx(table);

    const member = resolveMemberAccess("x", "method", null, ctx);
    expect(member).toBeNull();
  });

  test("resolves member when LHS is a class declaration", () => {
    const src = 'class Utils { void helper() {} }';
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/a.pike", 1);
    const ctx = makeTypeCtx(table);

    const utilsClass = table.declarations.find(d => d.name === "Utils" && d.kind === "class");
    expect(utilsClass).not.toBeUndefined();

    const member = resolveMemberAccess("Utils", "helper", utilsClass!, ctx);
    expect(member).not.toBeNull();
    expect(member!.name).toBe("helper");
  });
});

// ---------------------------------------------------------------------------
// Recursion guards
// ---------------------------------------------------------------------------

describe("Recursion guards", () => {
  test("resolveType returns null at max depth", () => {
    const src = 'class Foo { string x; }';
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/a.pike", 1);
    const ctx = makeTypeCtx(table);

    expect(resolveType("Foo", ctx, 5)).toBeNull();
  });

  test("resolveType succeeds at depth 4 (same-file is step 1)", () => {
    const src = 'class Foo { string x; }';
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/a.pike", 1);
    const ctx = makeTypeCtx(table);

    const result = resolveType("Foo", ctx, 4);
    expect(result).not.toBeNull();
    expect(result!.decl.name).toBe("Foo");
  });

  test("resolveMemberAccess returns null at max depth", () => {
    const src = 'class Foo { string x; }';
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/a.pike", 1);
    const ctx = makeTypeCtx(table);

    const fooClass = table.declarations.find(d => d.name === "Foo" && d.kind === "class")!;
    expect(resolveMemberAccess("foo", "x", fooClass, ctx, 5)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Definition provider — arrow/dot access via LSP
// ---------------------------------------------------------------------------

describe("Definition provider — arrow/dot access", () => {
  test("go-to-def on arrow member resolves to method declaration", async () => {
    const src = [
      'class Animal {',
      '  void speak() {}',
      '}',
      'void test() { Animal a; a->speak(); }',
    ].join("\n");

    const uri = server.openDoc("file:///test/arrow-def-t7.pike", src);

    const result = await server.client.sendRequest("textDocument/definition", {
      textDocument: { uri },
      position: { line: 3, character: 27 }, // on 'speak'
    });
    expect(result).not.toBeNull();
    expect(result.uri).toBe(uri);
    expect(result.range.start.line).toBe(1); // line of 'void speak()'
  });

  test("hover on arrow member shows method info", async () => {
    const src = [
      'class Animal {',
      '  void speak() {}',
      '}',
      'void test() { Animal a; a->speak(); }',
    ].join("\n");

    const uri = server.openDoc("file:///test/arrow-hover-t7.pike", src);

    const result = await server.client.sendRequest("textDocument/hover", {
      textDocument: { uri },
      position: { line: 3, character: 27 }, // on 'speak'
    });
    expect(result).not.toBeNull();
    expect(result.contents.value).toContain("speak");
  });

  test("go-to-def on mixed type arrow returns null", async () => {
    const src = 'void test() { mixed x; x->something(); }';
    const uri = server.openDoc("file:///test/mixed-def-t7.pike", src);

    const result = await server.client.sendRequest("textDocument/definition", {
      textDocument: { uri },
      position: { line: 0, character: 25 }, // on 'something'
    });

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveType — cross-file resolution
// ---------------------------------------------------------------------------

describe("resolveType — cross-file", () => {
  const CORPUS_DIR = join(import.meta.dir, "..", "..", "corpus", "files");
  let crossFileIndex: WorkspaceIndex;

  function indexFile(name: string): void {
    const uri = `file://${join(CORPUS_DIR, name)}`;
    const src = readFileSync(join(CORPUS_DIR, name), "utf-8");
    const tree = parse(src);
    crossFileIndex.upsertFile(uri, 1, tree, src, ModificationSource.didOpen);
  }

  beforeAll(async () => {
    crossFileIndex = new WorkspaceIndex({ workspaceRoot: CORPUS_DIR });
    indexFile("cross_import_a.pmod");
    indexFile("cross-import-b.pike");
  });

  test("resolves class from imported module", () => {
    const uriB = `file://${join(CORPUS_DIR, "cross-import-b.pike")}`;
    const tableB = crossFileIndex.getSymbolTable(uriB)!;
    const ctx = makeTypeCtx(tableB, uriB, crossFileIndex);

    const result = resolveType("Greeter", ctx);
    expect(result).not.toBeNull();
    expect(result!.decl.name).toBe("Greeter");
    expect(result!.decl.kind).toBe("class");
    expect(result!.uri).toContain("cross_import_a.pmod");
  });

  test("resolves qualified type cross_import_a.Greeter", () => {
    const uriB = `file://${join(CORPUS_DIR, "cross-import-b.pike")}`;
    const tableB = crossFileIndex.getSymbolTable(uriB)!;
    const ctx = makeTypeCtx(tableB, uriB, crossFileIndex);

    const result = resolveType("cross_import_a.Greeter", ctx);
    expect(result).not.toBeNull();
    expect(result!.decl.name).toBe("Greeter");
    expect(result!.decl.kind).toBe("class");
  });

  test("resolves member of imported module class through declared type", () => {
    const uriB = `file://${join(CORPUS_DIR, "cross-import-b.pike")}`;
    const tableB = crossFileIndex.getSymbolTable(uriB)!;
    const ctx = makeTypeCtx(tableB, uriB, crossFileIndex);

    const varG = tableB.declarations.find(d => d.name === "g" && d.kind === "variable");
    expect(varG).not.toBeUndefined();
    expect(varG!.declaredType).toBe("Greeter");

    const member = resolveMemberAccess("g", "greet", varG!, ctx);
    expect(member).not.toBeNull();
    expect(member!.name).toBe("greet");
  });

  test("resolves member of imported module class create method", () => {
    const uriB = `file://${join(CORPUS_DIR, "cross-import-b.pike")}`;
    const tableB = crossFileIndex.getSymbolTable(uriB)!;
    const ctx = makeTypeCtx(tableB, uriB, crossFileIndex);

    const varG = tableB.declarations.find(d => d.name === "g" && d.kind === "variable");
    const member = resolveMemberAccess("g", "create", varG!, ctx);
    expect(member).not.toBeNull();
    expect(member!.name).toBe("create");
  });

  test("returns null for unknown type in cross-file context", () => {
    const uriB = `file://${join(CORPUS_DIR, "cross-import-b.pike")}`;
    const tableB = crossFileIndex.getSymbolTable(uriB)!;
    const ctx = makeTypeCtx(tableB, uriB, crossFileIndex);

    expect(resolveType("NonExistentClass", ctx)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveType — qualified and stdlib types
// ---------------------------------------------------------------------------

describe("resolveType — qualified types", () => {
  const CORPUS_DIR = join(import.meta.dir, "..", "..", "corpus", "files");
  let crossFileIndex: WorkspaceIndex;

  function indexFile(name: string): void {
    const uri = `file://${join(CORPUS_DIR, name)}`;
    const src = readFileSync(join(CORPUS_DIR, name), "utf-8");
    const tree = parse(src);
    crossFileIndex.upsertFile(uri, 1, tree, src, ModificationSource.didOpen);
  }

  beforeAll(() => {
    crossFileIndex = new WorkspaceIndex({ workspaceRoot: CORPUS_DIR });
    indexFile("cross_import_a.pmod");
  });

  test("resolves cross_import_a.Greeter as qualified type", () => {
    const src = "void test() {}";
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/main.pike", 1);
    const ctx = makeTypeCtx(table, "file:///test/main.pike", crossFileIndex);

    const result = resolveType("cross_import_a.Greeter", ctx);
    expect(result).not.toBeNull();
    expect(result!.decl.name).toBe("Greeter");
    expect(result!.decl.kind).toBe("class");
  });

  test("resolves Stdio.File as stdlib type", () => {
    const src = "void test() {}";
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/main.pike", 1);
    const ctx = makeTypeCtx(table);

    const result = resolveType("Stdio.File", ctx);
    expect(result).not.toBeNull();
    expect(result!.decl.name).toBe("File");
    expect(result!.uri).toBe("stdlib://Stdio.File");
  });

  test("resolves Stdio.File as stdlib type via WorkspaceIndex context", () => {
    const src = "void test() {}";
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/main.pike", 1);
    const ctx = makeTypeCtx(table, "file:///test/main.pike", crossFileIndex);

    // WorkspaceIndex does not have Stdio, so it falls through to stdlib index
    const result = resolveType("Stdio.File", ctx);
    expect(result).not.toBeNull();
    expect(result!.decl.name).toBe("File");
  });

  test("returns null for non-existent qualified type", () => {
    const src = "void test() {}";
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/main.pike", 1);
    const ctx = makeTypeCtx(table);

    expect(resolveType("NonExistent.Module", ctx)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Depth limit
// ---------------------------------------------------------------------------

describe("resolveType depth limit", () => {
  beforeAll(async () => {
    await initParser();
  });

  test("resolveType returns null when depth exceeds MAX_RESOLUTION_DEPTH", () => {
    // Build a symbol table with a chain of classes that reference each other:
    //   class A { A next; }
    //   class B { B next; }
    //   ... (enough to exceed depth 5 via member access chain)
    //
    // resolveType itself only recurses through resolveMemberAccess.
    // The direct depth guard is tested by calling resolveType with depth=5.
    const src = "class A {}";
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/depth.pike", 1);
    const ctx = makeTypeCtx(table);

    // Calling resolveType with depth >= MAX_RESOLUTION_DEPTH should return null
    // even if the type exists, because the depth guard fires before any lookup.
    const result = resolveType("A", ctx, 5);
    expect(result).toBeNull();
  });

  test("resolveMemberAccess terminates at depth limit", () => {
    // Build: class Wrapper { Wrapper inner; }
    // Resolving inner->inner->inner->... should terminate at depth 5.
    const src = "class Wrapper { Wrapper inner; void fetch() {} }";
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/depth-member.pike", 1);
    wireInheritance(table);
    const ctx = makeTypeCtx(table);

    // Get the inner declaration
    const innerDecl = table.declarations.find(d => d.name === "inner");
    expect(innerDecl).toBeDefined();
    expect(innerDecl!.declaredType).toBe("Wrapper");

    // Resolving member access at depth 5 should return null
    const result = resolveMemberAccess("inner", "fetch", innerDecl!, ctx, 5);
    expect(result).toBeNull();
  });

  test("resolveMemberAccess works within depth limit", () => {
    const src = "class Wrapper { Wrapper inner; void fetch() {} }";
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/depth-ok.pike", 1);
    wireInheritance(table);
    const ctx = makeTypeCtx(table);

    const innerDecl = table.declarations.find(d => d.name === "inner");
    // Depth 0 should work: inner is Wrapper -> resolve Wrapper -> find fetch
    const result = resolveMemberAccess("inner", "fetch", innerDecl!, ctx, 0);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("fetch");
  });
});