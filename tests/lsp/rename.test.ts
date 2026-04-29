/**
 * Layer 1 tests for textDocument/rename and textDocument/prepareRename.
 *
 * Tests both:
 * - Direct API: rename.ts functions
 * - LSP protocol: client.sendRequest("textDocument/rename", ...)
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createTestServer, type TestServer } from "./helpers";
import { initParser, parse } from "../../server/src/parser";
import {
  buildSymbolTable,
  wireInheritance,
  type SymbolTable,
  type Declaration,
} from "../../server/src/features/symbolTable";
import {
  validateRenameName,
  getRenameLocations,
  buildWorkspaceEdit,
  prepareRename,
} from "../../server/src/features/rename";
import { WorkspaceIndex, ModificationSource } from "../../server/src/features/workspaceIndex";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CORPUS_DIR = join(import.meta.dir, "..", "..", "corpus", "files");

function readCorpus(filename: string): string {
  return readFileSync(join(CORPUS_DIR, filename), "utf-8");
}

function corpusUri(filename: string): string {
  return `file://${join(CORPUS_DIR, filename)}`;
}

function buildTable(filename: string): SymbolTable {
  const src = readCorpus(filename);
  const tree = parse(src);
  return buildSymbolTable(tree, corpusUri(filename), 1);
}

function findDecl(table: SymbolTable, name: string, kind?: string): Declaration | undefined {
  return table.declarations.find(
    (d) => d.name === name && (kind === undefined || d.kind === kind),
  );
}

// ---------------------------------------------------------------------------
// Validate rename name
// ---------------------------------------------------------------------------

describe("validateRenameName", () => {
  test("accepts valid identifiers", () => {
    expect(validateRenameName("myVar")).toBeNull();
    expect(validateRenameName("_private")).toBeNull();
    expect(validateRenameName("CamelCase")).toBeNull();
    expect(validateRenameName("snake_case")).toBeNull();
    expect(validateRenameName("x123")).toBeNull();
  });

  test("rejects empty string", () => {
    expect(validateRenameName("")).not.toBeNull();
  });

  test("rejects identifiers starting with digit", () => {
    expect(validateRenameName("123abc")).not.toBeNull();
  });

  test("rejects Pike keywords", () => {
    expect(validateRenameName("class")).not.toBeNull();
    expect(validateRenameName("if")).not.toBeNull();
    expect(validateRenameName("return")).not.toBeNull();
    expect(validateRenameName("void")).not.toBeNull();
    expect(validateRenameName("string")).not.toBeNull();
    expect(validateRenameName("import")).not.toBeNull();
    expect(validateRenameName("inherit")).not.toBeNull();
    expect(validateRenameName("foreach")).not.toBeNull();
  });

  test("rejects double-underscore reserved pattern", () => {
    expect(validateRenameName("__foo__")).not.toBeNull();
    expect(validateRenameName("__custom__")).not.toBeNull();
  });

  test("allows double underscore not matching reserved pattern", () => {
    // __foo (no trailing __) is fine
    expect(validateRenameName("__foo")).toBeNull();
    // foo__ is fine
    expect(validateRenameName("foo__")).toBeNull();
  });

  test("rejects identifiers with special characters", () => {
    expect(validateRenameName("my-var")).not.toBeNull();
    expect(validateRenameName("my.var")).not.toBeNull();
    expect(validateRenameName("my var")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Prepare rename — direct API
// ---------------------------------------------------------------------------

describe("prepareRename — direct API", () => {
  beforeAll(async () => {
    await initParser();
  });

  test("returns range for declaration", () => {
    const src = `class Animal {
  string name;
  void speak() { write(name); }
}`;
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test.pike", 1);

    // Position on "Animal" class declaration
    const result = prepareRename(table, 0, 6);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Animal");
    expect(result!.line).toBe(0);
    expect(result!.character).toBe(6);
  });

  test("returns range for member declaration", () => {
    const src = `class Animal {
  string name;
}`;
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test.pike", 1);

    // Position on "name" declaration
    const result = prepareRename(table, 1, 9);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("name");
  });

  test("returns null for position with no symbol", () => {
    const src = `class Animal { }`;
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test.pike", 1);

    // Position on whitespace
    const result = prepareRename(table, 0, 0);
    expect(result).toBeNull();
  });

  test("returns range when cursor is on a reference", () => {
    const src = `int x = 1;
x + 1;`;
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test.pike", 1);

    // Position on "x" reference in "x + 1"
    const xRef = table.references.find(r => r.name === "x" && r.loc.line === 1);
    expect(xRef).toBeDefined();

    const result = prepareRename(table, 1, xRef!.loc.character);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("x");
  });
});

// ---------------------------------------------------------------------------
// Get rename locations — same-file
// ---------------------------------------------------------------------------

describe("getRenameLocations — same-file", () => {
  beforeAll(async () => {
    await initParser();
  });

  test("renames a local variable with all references", () => {
    const src = `int counter = 0;
counter = counter + 1;
write((string)counter);`;
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test.pike", 1);

    // Find position of "counter" declaration
    const decl = findDecl(table, "counter", "variable");
    expect(decl).toBeDefined();

    const result = getRenameLocations(table, "file:///test.pike", decl!.nameRange.start.line, decl!.nameRange.start.character, null);
    expect(result).not.toBeNull();
    expect(result!.oldName).toBe("counter");

    // Should have: declaration (line 0) + assignment (line 1) + addition (line 1) + cast (line 2) = 4
    expect(result!.locations).toHaveLength(4);
    // All locations should be in the same file
    expect(result!.locations.every(l => l.uri === "file:///test.pike")).toBe(true);
  });

  test("renames a class with member references", () => {
    const src = `class Greeter {
  string name;
  void greet() { write("Hello " + name); }
}
Greeter g = Greeter("World");
g->name;`;
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test.pike", 1);

    const decl = findDecl(table, "Greeter", "class");
    expect(decl).toBeDefined();

    const result = getRenameLocations(table, "file:///test.pike", decl!.nameRange.start.line, decl!.nameRange.start.character, null);
    expect(result).not.toBeNull();
    expect(result!.oldName).toBe("Greeter");
    // Declaration + 2 constructor calls (Greeter g = Greeter(...))
    expect(result!.locations).toHaveLength(3);
  });

  test("renames a function parameter", () => {
    const src = `int add(int a, int b) {
  return a + b;
}`;
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test.pike", 1);

    const decl = findDecl(table, "a", "parameter");
    expect(decl).toBeDefined();

    const result = getRenameLocations(table, "file:///test.pike", decl!.nameRange.start.line, decl!.nameRange.start.character, null);
    expect(result).not.toBeNull();
    expect(result!.oldName).toBe("a");
    // Declaration + reference in "a + b"
    expect(result!.locations).toHaveLength(2);
  });

  test("returns null for position with no symbol", () => {
    const src = `void test() { }`;
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test.pike", 1);

    const result = getRenameLocations(table, "file:///test.pike", 0, 0, null);
    expect(result).toBeNull();
  });

  test("renames a class method", () => {
    const src = `class Calculator {
  int value;
  void reset() { value = 0; }
  int add(int x) { value += x; return value; }
}`;
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test.pike", 1);

    const decl = findDecl(table, "reset", "function");
    expect(decl).toBeDefined();

    const result = getRenameLocations(table, "file:///test.pike", decl!.nameRange.start.line, decl!.nameRange.start.character, null);
    expect(result).not.toBeNull();
    expect(result!.oldName).toBe("reset");
    // Declaration only — reset() is not called within this fixture
    expect(result!.locations).toHaveLength(1);
  });

  test("rename does not affect same-name identifier in different scope", () => {
    const src = [
      'int x = 1;',               // line 0: outer x (decl 1)
      'void foo() {',
      '  string x = "a";',        // line 2: inner x (decl 4)
      '  int y = x + 1;',         // line 3: reference to inner x
      '}',
      'int z = x + 2;',           // line 5: reference to outer x
    ].join('\n');
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test.pike", 1);

    // Rename the inner x (line 2, character 10 → position of 'x' in 'string x')
    const result = getRenameLocations(table, "file:///test.pike", 2, 10, null);
    expect(result).not.toBeNull();
    expect(result!.oldName).toBe("x");

    // Should have exactly 2 locations: inner x declaration + inner x reference
    expect(result!.locations).toHaveLength(2);

    // All locations must be inside foo() — lines 2 and 3 only
    const lines = result!.locations.map(l => l.line);
    expect(lines.every(l => l >= 2 && l <= 3)).toBe(true);

    // The file-scope x (line 0) and its reference (line 5) must NOT appear
    expect(lines).not.toContain(0);
    expect(lines).not.toContain(5);
  });

  test("rename includes arrow-access call sites", () => {
    const src = [
      'class Dog {',
      '  void bark() {}',
      '  void fetch(string item) {}',
      '}',
      'void test() {',
      '  Dog d = Dog();',
      '  d->bark();',
      '  d->fetch("stick");',
      '}',
    ].join('\n');
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test.pike", 1);

    // Rename bark method
    const barkDecl = table.declarations.find(d => d.name === "bark" && d.kind === "function");
    expect(barkDecl).toBeDefined();

    const result = getRenameLocations(
      table, "file:///test.pike",
      barkDecl!.nameRange.start.line,
      barkDecl!.nameRange.start.character,
      null,
    );
    expect(result).not.toBeNull();
    expect(result!.oldName).toBe("bark");

    // Should have 2 locations: declaration + arrow-access call site
    expect(result!.locations).toHaveLength(2);

    // The call site location should cover only the method name (not d->)
    const callSite = result!.locations.find(l => l.line !== barkDecl!.nameRange.start.line);
    expect(callSite).toBeDefined();
    expect(callSite!.length).toBe(4); // "bark" is 4 chars
    expect(callSite!.character).toBeGreaterThan(0);

    // Verify the range points to "bark" not "d" or "->"
    const srcLines = src.split('\n');
    const callLine = srcLines[callSite!.line];
    const renamedText = callLine.substring(callSite!.character, callSite!.character + callSite!.length);
    expect(renamedText).toBe("bark");
  });
});

// ---------------------------------------------------------------------------
// Get rename locations — cross-file
// ---------------------------------------------------------------------------

describe("getRenameLocations — cross-file", () => {
  beforeAll(async () => {
    await initParser();
  });

  const CORPUS_DIR = join(import.meta.dir, "..", "..", "corpus", "files");

  function makeIndexWithFiles(filenames: string[]): { index: WorkspaceIndex; uris: Map<string, string> } {
    const index = new WorkspaceIndex({ workspaceRoot: CORPUS_DIR });
    const uris = new Map<string, string>();
    for (const name of filenames) {
      const uri = "file://" + join(CORPUS_DIR, name);
      uris.set(name, uri);
      const src = readCorpus(name);
      const tree = parse(src);
      index.upsertFile(uri, 1, tree, src, ModificationSource.didOpen);
    }
    return { index, uris };
  }

  test("cross-file rename updates all files containing references", () => {
    const { index, uris } = makeIndexWithFiles([
      "cross-inherit-simple-a.pike",
      "cross-inherit-simple-b.pike",
    ]);
    const uriA = uris.get("cross-inherit-simple-a.pike")!;
    const tableA = index.getSymbolTable(uriA)!;

    // Rename the SPECIES constant in file A
    const speciesDecl = tableA.declarations.find(d => d.name === "SPECIES");
    expect(speciesDecl).toBeDefined();

    const result = getRenameLocations(
      tableA, uriA,
      speciesDecl!.nameRange.start.line,
      speciesDecl!.nameRange.start.character,
      index,
    );
    expect(result).not.toBeNull();
    expect(result!.oldName).toBe("SPECIES");

    // Locations should span at least 2 different files
    const affectedUris = new Set(result!.locations.map(l => l.uri));
    expect(affectedUris.size).toBeGreaterThanOrEqual(2);
    expect(affectedUris.has(uriA)).toBe(true);
    expect(affectedUris.has(uris.get("cross-inherit-simple-b.pike")!)).toBe(true);

    // Verify newText would be correct in each file
    const edit = buildWorkspaceEdit(result!.locations, "KIND");
    for (const [, edits] of Object.entries(edit.changes)) {
      for (const te of edits) {
        expect(te.newText).toBe("KIND");
      }
    }
  });
});
// ---------------------------------------------------------------------------
// Build workspace edit
// ---------------------------------------------------------------------------

describe("buildWorkspaceEdit", () => {
  test("groups locations by URI", () => {
    const locations = [
      { uri: "file:///a.pike", line: 0, character: 5, length: 3 },
      { uri: "file:///b.pike", line: 1, character: 0, length: 3 },
      { uri: "file:///a.pike", line: 2, character: 10, length: 3 },
    ];

    const edit = buildWorkspaceEdit(locations, "foo");

    expect(Object.keys(edit.changes).sort()).toEqual(["file:///a.pike", "file:///b.pike"]);
    expect(edit.changes["file:///a.pike"]).toHaveLength(2);
    expect(edit.changes["file:///b.pike"]).toHaveLength(1);
  });

  test("creates correct ranges", () => {
    const locations = [
      { uri: "file:///test.pike", line: 3, character: 7, length: 5 },
    ];

    const edit = buildWorkspaceEdit(locations, "newName");

    expect(edit.changes["file:///test.pike"]).toHaveLength(1);
    const te = edit.changes["file:///test.pike"][0];
    expect(te.newText).toBe("newName");
    expect(te.range.start).toEqual({ line: 3, character: 7 });
    expect(te.range.end).toEqual({ line: 3, character: 12 });
  });

  test("handles empty locations", () => {
    const edit = buildWorkspaceEdit([], "newName");
    expect(Object.keys(edit.changes)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// LSP protocol — rename via test server
// ---------------------------------------------------------------------------

describe("textDocument/rename — LSP protocol", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await createTestServer();
  });

  afterAll(async () => {
    await server.teardown();
  });

  test("renames a local variable", async () => {
    const uri = server.openDoc(
      "file:///rename-local.pike",
      "int counter = 0;\ncounter = counter + 1;\n",
    );

    const result = await server.client.sendRequest("textDocument/rename", {
      textDocument: { uri },
      position: { line: 0, character: 4 }, // "counter" declaration
      newName: "myCounter",
    });

    expect(result).not.toBeNull();
    const edit = result as { changes: Record<string, any[]> };
    expect(edit.changes[uri]).toBeDefined();
    // Declaration (line 0) + assignment (line 1) + addition (line 1) = 3
    expect(edit.changes[uri]).toHaveLength(3);

    // All edits should use the new name
    for (const te of edit.changes[uri]) {
      expect(te.newText).toBe("myCounter");
    }
  });

  test("renames a function", async () => {
    const uri = server.openDoc(
      "file:///rename-func.pike",
      "int add(int a, int b) { return a + b; }\nint x = add(1, 2);\n",
    );

    const result = await server.client.sendRequest("textDocument/rename", {
      textDocument: { uri },
      position: { line: 0, character: 4 }, // "add" declaration
      newName: "sum",
    });

    expect(result).not.toBeNull();
    const edit = result as { changes: Record<string, any[]> };
    expect(edit.changes[uri]).toBeDefined();
    // Declaration (line 0) + call site (line 1) = 2
    expect(edit.changes[uri]).toHaveLength(2);
  });

  test("returns null for empty position", async () => {
    const uri = server.openDoc(
      "file:///rename-empty.pike",
      "   \n",
    );

    const result = await server.client.sendRequest("textDocument/rename", {
      textDocument: { uri },
      position: { line: 0, character: 0 },
      newName: "foo",
    });

    expect(result).toBeNull();
  });

  test("returns null for rename to keyword", async () => {
    const uri = server.openDoc(
      "file:///rename-keyword.pike",
      "int myVar = 1;\n",
    );

    const result = await server.client.sendRequest("textDocument/rename", {
      textDocument: { uri },
      position: { line: 0, character: 4 }, // "myVar"
      newName: "class",
    });

    expect(result).toBeNull();
  });

  test("returns null when old name equals new name", async () => {
    const uri = server.openDoc(
      "file:///rename-same.pike",
      "int myVar = 1;\n",
    );

    const result = await server.client.sendRequest("textDocument/rename", {
      textDocument: { uri },
      position: { line: 0, character: 4 },
      newName: "myVar",
    });

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// LSP protocol — prepareRename
// ---------------------------------------------------------------------------

describe("textDocument/prepareRename — LSP protocol", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await createTestServer();
  });

  afterAll(async () => {
    await server.teardown();
  });

  test("returns range and placeholder for declaration", async () => {
    const uri = server.openDoc(
      "file:///prepare-decl.pike",
      "int myVar = 1;\n",
    );

    const result = await server.client.sendRequest("textDocument/prepareRename", {
      textDocument: { uri },
      position: { line: 0, character: 4 }, // "myVar"
    });

    expect(result).not.toBeNull();
    expect(result.placeholder).toBe("myVar");
    expect(result.range.start.line).toBe(0);
  });

  test("returns null for non-renameable position", async () => {
    const uri = server.openDoc(
      "file:///prepare-empty.pike",
      "   \n",
    );

    const result = await server.client.sendRequest("textDocument/prepareRename", {
      textDocument: { uri },
      position: { line: 0, character: 0 },
    });

    expect(result).toBeNull();
  });

  test("returns range for reference position", async () => {
    const uri = server.openDoc(
      "file:///prepare-ref.pike",
      "int x = 1;\nx + 1;\n",
    );

    const result = await server.client.sendRequest("textDocument/prepareRename", {
      textDocument: { uri },
      position: { line: 1, character: 0 }, // "x" reference
    });

    expect(result).not.toBeNull();
    expect(result.placeholder).toBe("x");
  });
});
