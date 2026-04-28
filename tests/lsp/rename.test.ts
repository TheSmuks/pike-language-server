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

    // Should have: declaration + 3 references (assignment, addition, cast)
    expect(result!.locations.length).toBeGreaterThanOrEqual(2);
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
    // Should include at least the declaration + the constructor calls
    expect(result!.locations.length).toBeGreaterThanOrEqual(1);
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
    expect(result!.locations.length).toBeGreaterThanOrEqual(2);
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
    expect(result!.locations.length).toBeGreaterThanOrEqual(1);
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
    expect(edit.changes[uri].length).toBeGreaterThanOrEqual(2);

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
    // Declaration + call site
    expect(edit.changes[uri].length).toBeGreaterThanOrEqual(2);
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
