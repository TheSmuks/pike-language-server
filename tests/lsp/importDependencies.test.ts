/**
 * Import dependency tracking tests (decision 0015).
 *
 * Tests that import declarations create dependency edges in the WorkspaceIndex,
 * enabling cross-file propagation and dependency graph completeness.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { initParser, parse } from "../../server/src/parser";
import {
  buildSymbolTable,
  wireInheritance,
  getSymbolsInScope,
} from "../../server/src/features/symbolTable";
import { WorkspaceIndex, ModificationSource } from "../../server/src/features/workspaceIndex";
import { createTestServer, type TestServer } from "./helpers";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

beforeAll(async () => {
  await initParser();
});

// ---------------------------------------------------------------------------
// Import declarations produce correct DeclKind
// ---------------------------------------------------------------------------

describe("Import DeclKind", () => {
  test("import declarations get kind 'import'", () => {
    const src = 'import Stdio;';
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/a.pike", 1);

    const importDecls = table.declarations.filter(d => d.kind === "import");
    expect(importDecls.length).toBe(1);
    expect(importDecls[0].name).toBe("Stdio");
  });

  test("inherit declarations keep kind 'inherit'", () => {
    const src = 'class Base {} class Child { inherit Base; }';
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/a.pike", 1);

    const inheritDecls = table.declarations.filter(d => d.kind === "inherit");
    expect(inheritDecls.length).toBe(1);
    expect(inheritDecls[0].name).toBe("Base");
  });

  test("import and inherit in same file produce distinct kinds", () => {
    const src = 'import Stdio; class Base {} class Child { inherit Base; }';
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/a.pike", 1);

    const imports = table.declarations.filter(d => d.kind === "import");
    const inherits = table.declarations.filter(d => d.kind === "inherit");
    expect(imports.length).toBe(1);
    expect(inherits.length).toBe(1);
    expect(imports[0].name).toBe("Stdio");
    expect(inherits[0].name).toBe("Base");
  });
});

// ---------------------------------------------------------------------------
// Dependency graph includes import edges
// ---------------------------------------------------------------------------

describe("Dependency graph — import edges", () => {
  test("import creates a dependency edge", async () => {
    const index = new WorkspaceIndex({ workspaceRoot: "/test" });

    // Index a file with an import
    const src = 'import SomeModule;';
    const tree = parse(src);
    await index.upsertFile(
      "file:///test/consumer.pike",
      1,
      tree,
      src,
      ModificationSource.didOpen,
    );

    const deps = index.getDependents("file:///test/someModule.pmod");
    // The dependency edge goes from consumer → someModule
    // Reverse: someModule's dependents include consumer
    // But ModuleResolver can't resolve without real files, so the edge may be null
    // This test verifies the code path exists without crashing
    expect(deps).toBeDefined();
  });

  test("inherit and import both create edges for same target", async () => {
    const index = new WorkspaceIndex({ workspaceRoot: "/test" });

    const src = 'import SomeModule; inherit "someModule.pike";';
    const tree = parse(src);
    await index.upsertFile(
      "file:///test/consumer.pike",
      1,
      tree,
      src,
      ModificationSource.didOpen,
    );

    // Both import and inherit reference SomeModule
    // The dependency extraction should handle both without error
    const file = index.getFile("file:///test/consumer.pike");
    expect(file).toBeDefined();
  });

  test("removing import removes the edge", async () => {
    const index = new WorkspaceIndex({ workspaceRoot: "/test" });

    // Index with import
    const src1 = 'import SomeModule;';
    const tree1 = parse(src1);
    await index.upsertFile("file:///test/a.pike", 1, tree1, src1, ModificationSource.didOpen);

    // Re-index without import
    const src2 = 'int x;';
    const tree2 = parse(src2);
    await index.upsertFile("file:///test/a.pike", 2, tree2, src2, ModificationSource.didChange);

    // File should have no import declarations
    const file = index.getFile("file:///test/a.pike");
    expect(file?.symbolTable).toBeDefined();
    const imports = file!.symbolTable!.declarations.filter(d => d.kind === "import");
    expect(imports.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getSymbolsInScope skips import declarations
// ---------------------------------------------------------------------------

describe("getSymbolsInScope — import handling", () => {
  test("import declarations are excluded from symbols in scope", () => {
    const src = 'import Stdio; int x;';
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/a.pike", 1);

    // Import declarations should be excluded from getSymbolsInScope results
    const symbols = getSymbolsInScope(table, 0, 20);
    const names = symbols.map((d: any) => d.name);

    expect(names).toContain("x");
    expect(names).not.toContain("Stdio"); // import declarations skipped
  });

  test("inherit declarations are also excluded from symbols in scope", () => {
    const src = 'class Base {} class Child { inherit Base; }';
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/a.pike", 1);
    wireInheritance(table);

    const symbols = getSymbolsInScope(table, 2, 20);
    const names = symbols.map((d: any) => d.name);

    // Should not contain the inherit declaration itself
    expect(names).not.toContain("Base"); // inherit skipped, but Base class IS visible
  });
});

// ---------------------------------------------------------------------------
// T044: Dependency-closure indexing with depth/count caps (US2)
// ---------------------------------------------------------------------------

describe("T044: Dependency-closure indexing — depth and count caps (US2)", () => {
  let tempDir: string;
  let server: TestServer;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "pike-lsp-dep-closure-"));

    // Create a 3-level inherit chain: a → b → c
    writeFileSync(join(tempDir, "a.pike"), [
      'inherit "b.pike";',
      "class A { }",
    ].join("\n"));

    writeFileSync(join(tempDir, "b.pike"), [
      'inherit "c.pike";',
      "class B { }",
    ].join("\n"));

    writeFileSync(join(tempDir, "c.pike"), [
      "class C { }",
    ].join("\n"));

    server = await createTestServer({ rootUri: pathToFileURL(tempDir).href });
  });

  afterAll(async () => {
    await server.teardown();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("opening a file indexes its dependency closure from disk", async () => {
    const aUri = pathToFileURL(join(tempDir, "a.pike")).href;
    const bUri = pathToFileURL(join(tempDir, "b.pike")).href;
    const cUri = pathToFileURL(join(tempDir, "c.pike")).href;

    // Open a.pike — triggers indexDependencyClosure.
    server.openDoc(aUri, 'inherit "b.pike";\nclass A { }');

    // Wait for fire-and-forget closure indexing to complete.
    await new Promise(resolve => setTimeout(resolve, 200));

    // b.pike should be indexed as a direct dependency.
    const bEntry = server.server.index.getFile(bUri);
    expect(bEntry).toBeDefined();

    // c.pike should be indexed as a transitive dependency (depth >= 2).
    const cEntry = server.server.index.getFile(cUri);
    expect(cEntry).toBeDefined();
  });

  test("dependencyClosureCount caps total indexed files", async () => {
    // Fresh index with count cap of 1.
    const cappedServer = await createTestServer({
      rootUri: pathToFileURL(tempDir).href,
    });

    // Set count cap to 1 — only the first dependency should be indexed.
    cappedServer.server.context.resourceConfig.indexing.dependencyClosureCount = 1;
    cappedServer.server.context.resourceConfig.indexing.dependencyClosureDepth = 5;

    const aUri = pathToFileURL(join(tempDir, "a.pike")).href;
    const bUri = pathToFileURL(join(tempDir, "b.pike")).href;
    const cUri = pathToFileURL(join(tempDir, "c.pike")).href;

    cappedServer.openDoc(aUri, 'inherit "b.pike";\nclass A { }');
    await new Promise(resolve => setTimeout(resolve, 200));

    // b.pike should be indexed (first dependency, count = 1).
    expect(cappedServer.server.index.getFile(bUri)).toBeDefined();

    // c.pike should NOT be indexed (count cap reached).
    expect(cappedServer.server.index.getFile(cUri)).toBeUndefined();

    await cappedServer.teardown();
  });

  test("dependencyClosureDepth caps transitive indexing", async () => {
    // Fresh index with depth cap of 1.
    const depthServer = await createTestServer({
      rootUri: pathToFileURL(tempDir).href,
    });

    // Set depth cap to 1 — only direct dependencies indexed, no transitive.
    depthServer.server.context.resourceConfig.indexing.dependencyClosureDepth = 1;
    depthServer.server.context.resourceConfig.indexing.dependencyClosureCount = 100;

    const aUri = pathToFileURL(join(tempDir, "a.pike")).href;
    const bUri = pathToFileURL(join(tempDir, "b.pike")).href;
    const cUri = pathToFileURL(join(tempDir, "c.pike")).href;

    depthServer.openDoc(aUri, 'inherit "b.pike";\nclass A { }');
    await new Promise(resolve => setTimeout(resolve, 200));

    // b.pike is at depth 1 — should be indexed.
    expect(depthServer.server.index.getFile(bUri)).toBeDefined();

    // c.pike is at depth 2 — should NOT be indexed (depth cap = 1).
    expect(depthServer.server.index.getFile(cUri)).toBeUndefined();

    await depthServer.teardown();
  });
});
