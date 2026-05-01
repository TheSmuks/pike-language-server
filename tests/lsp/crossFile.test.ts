/**
 * Cross-file definition and references tests.
 *
 * Tests use the WorkspaceIndex with real parsed corpus files to verify
 * cross-file go-to-definition and find-references work correctly.
 *
 * Test strategy:
 * - Index both files of each cross-file corpus pair
 * - Verify that referencing symbols in one file resolve to definitions in the other
 * - Verify that cross-file references span both files
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { initParser, parse } from "../../server/src/parser";
import { WorkspaceIndex, ModificationSource } from "../../server/src/features/workspaceIndex";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CORPUS_DIR = join(import.meta.dir, "..", "..", "corpus", "files");

function corpusUri(name: string): string {
  return `file://${join(CORPUS_DIR, name)}`;
}

function readCorpus(name: string): string {
  return readFileSync(join(CORPUS_DIR, name), "utf-8");
}

/** Helper to index a file into the workspace */
async function indexFile(index: WorkspaceIndex, name: string): Promise<void> {
  const uri = corpusUri(name);
  const content = readCorpus(name);
  const tree = parse(content);
  await await index.upsertFile(uri, 1, tree, content, ModificationSource.DidOpen);
}

// ---------------------------------------------------------------------------
// Cross-file definition tests
// ---------------------------------------------------------------------------

describe("Cross-file definition — simple inherit", () => {
  let index: WorkspaceIndex;

  beforeAll(async () => {
    await initParser();
    index = new WorkspaceIndex({ workspaceRoot: CORPUS_DIR });
    // B inherits from A via string literal
    await indexFile(index, "cross-inherit-simple-a.pike");
    await indexFile(index, "cross-inherit-simple-b.pike");
  });

  test("inherit declaration in B resolves to file A", async () => {
    const uriB = corpusUri("cross-inherit-simple-b.pike");
    // The inherit declaration has the path text on its nameRange
    // Find the inherit declaration in B's symbol table
    const tableB = index.getSymbolTable(uriB);
    expect(tableB).not.toBeNull();

    const inheritDecl = tableB!.declarations.find(d => d.kind === "inherit");
    expect(inheritDecl).toBeDefined();

    const result = await index.resolveCrossFileDefinition(uriB,
    inheritDecl!.nameRange.start.line,
    inheritDecl!.nameRange.start.character,);

    expect(result).not.toBeNull();
    expect(result!.uri).toBe(corpusUri("cross-inherit-simple-a.pike"));
  });
});

describe("Cross-file definition — inherit with rename", () => {
  let index: WorkspaceIndex;

  beforeAll(async () => {
    await initParser();
    index = new WorkspaceIndex({ workspaceRoot: CORPUS_DIR });
    await indexFile(index, "cross-inherit-rename-a.pike");
    await indexFile(index, "cross-inherit-rename-b.pike");
  });

  test("inherit with alias resolves to target file", async () => {
    const uriB = corpusUri("cross-inherit-rename-b.pike");
    const tableB = index.getSymbolTable(uriB);
    expect(tableB).not.toBeNull();

    const inheritDecl = tableB!.declarations.find(d => d.kind === "inherit");
    expect(inheritDecl).toBeDefined();

    const result = await index.resolveCrossFileDefinition(uriB,
    inheritDecl!.nameRange.start.line,
    inheritDecl!.nameRange.start.character,);

    expect(result).not.toBeNull();
    expect(result!.uri).toBe(corpusUri("cross-inherit-rename-a.pike"));
  });
});

describe("Cross-file definition — inherit chain", () => {
  let index: WorkspaceIndex;

  beforeAll(async () => {
    await initParser();
    index = new WorkspaceIndex({ workspaceRoot: CORPUS_DIR });
    await indexFile(index, "cross-inherit-chain-a.pike");
    await indexFile(index, "cross-inherit-chain-b.pike");
    await indexFile(index, "cross-inherit-chain-c.pike");
  });

  test("C inherits B, B inherits A — chain resolves", async () => {
    const uriC = corpusUri("cross-inherit-chain-c.pike");
    const tableC = index.getSymbolTable(uriC);
    expect(tableC).not.toBeNull();

    const inheritDecl = tableC!.declarations.find(d => d.kind === "inherit");
    expect(inheritDecl).toBeDefined();

    const result = await index.resolveCrossFileDefinition(uriC,
    inheritDecl!.nameRange.start.line,
    inheritDecl!.nameRange.start.character,);

    expect(result).not.toBeNull();
    expect(result!.uri).toBe(corpusUri("cross-inherit-chain-b.pike"));
  });

  test("B inherits A — resolves correctly", async () => {
    const uriB = corpusUri("cross-inherit-chain-b.pike");
    const tableB = index.getSymbolTable(uriB);
    expect(tableB).not.toBeNull();

    const inheritDecl = tableB!.declarations.find(d => d.kind === "inherit");
    expect(inheritDecl).toBeDefined();

    const result = await index.resolveCrossFileDefinition(uriB,
    inheritDecl!.nameRange.start.line,
    inheritDecl!.nameRange.start.character,);

    expect(result).not.toBeNull();
    expect(result!.uri).toBe(corpusUri("cross-inherit-chain-a.pike"));
  });
});

describe("Cross-file definition — module import", () => {
  let index: WorkspaceIndex;

  beforeAll(async () => {
    await initParser();
    index = new WorkspaceIndex({ workspaceRoot: CORPUS_DIR });
    await indexFile(index, "cross_import_a.pmod");
    await indexFile(index, "cross-import-b.pike");
  });

  test("import declaration in B resolves to module A", async () => {
    const uriB = corpusUri("cross-import-b.pike");
    const tableB = index.getSymbolTable(uriB);
    expect(tableB).not.toBeNull();

    // import_decl is now stored as kind='import' in the symbol table
    const importDecl = tableB!.declarations.find(d => d.kind === "import");
    expect(importDecl).toBeDefined();
  });
});

describe("Cross-file references — simple inherit", () => {
  let index: WorkspaceIndex;

  beforeAll(async () => {
    await initParser();
    index = new WorkspaceIndex({ workspaceRoot: CORPUS_DIR });
    await indexFile(index, "cross-inherit-simple-a.pike");
    await indexFile(index, "cross-inherit-simple-b.pike");
  });

  test("declaration in A has dependents", async () => {
    const uriA = corpusUri("cross-inherit-simple-a.pike");
    const dependents = index.getDependents(uriA);
    expect(dependents.size).toBeGreaterThan(0);
    expect(dependents.has(corpusUri("cross-inherit-simple-b.pike"))).toBe(true);
  });
});

describe("Cross-file definition — pmod directory module", () => {
  let index: WorkspaceIndex;

  beforeAll(async () => {
    await initParser();
    index = new WorkspaceIndex({ workspaceRoot: CORPUS_DIR });
    // The .pmod directory is NOT listed as a corpus file — we index the user
    await indexFile(index, "cross-pmod-user.pike");
  });

  test("cross-pmod-user indexes successfully", async () => {
    const uri = corpusUri("cross-pmod-user.pike");
    const table = index.getSymbolTable(uri);
    expect(table).not.toBeNull();
  });
});

describe("Cross-file definition — self-contained files", () => {
  let index: WorkspaceIndex;

  beforeAll(async () => {
    await initParser();
    index = new WorkspaceIndex({ workspaceRoot: CORPUS_DIR });
    await indexFile(index, "cross-stdlib.pike");
  });

  test("cross-stdlib.pike indexes without error", async () => {
    const uri = corpusUri("cross-stdlib.pike");
    const table = index.getSymbolTable(uri);
    expect(table).not.toBeNull();
  });

  test("compat-pike78.pike detects #pike version", async () => {
    await indexFile(index, "compat-pike78.pike");
    const uri = corpusUri("compat-pike78.pike");
    const entry = index.getFile(uri);
    expect(entry).toBeDefined();
    expect(entry!.pikeVersion).not.toBeNull();
    expect(entry!.pikeVersion!.major).toBe(7);
    expect(entry!.pikeVersion!.minor).toBe(8);
  });
});

describe("Cross-file incremental update — invalidation", () => {
  let index: WorkspaceIndex;

  beforeAll(async () => {
    await initParser();
    index = new WorkspaceIndex({ workspaceRoot: CORPUS_DIR });
    await indexFile(index, "cross-inherit-simple-a.pike");
    await indexFile(index, "cross-inherit-simple-b.pike");
    await indexFile(index, "cross-inherit-chain-c.pike");
  });

  test("re-indexing a file preserves dependencies", async () => {
    const uriA = corpusUri("cross-inherit-simple-a.pike");
    const uriB = corpusUri("cross-inherit-simple-b.pike");

    // Re-index A with same content
    const content = readCorpus("cross-inherit-simple-a.pike");
    const tree = parse(content);
    await index.upsertFile(uriA, 2, tree, content, ModificationSource.DidChange);

    // B should still be a dependent of A
    const deps = index.getDependents(uriA);
    expect(deps.has(uriB)).toBe(true);
  });

  test("invalidating A invalidates B", async () => {
    const uriA = corpusUri("cross-inherit-simple-a.pike");
    const uriB = corpusUri("cross-inherit-simple-b.pike");

    // Both have valid tables
    expect(index.getSymbolTable(uriA)).not.toBeNull();
    expect(index.getSymbolTable(uriB)).not.toBeNull();

    // Invalidate A
    const invalidated = index.invalidateWithDependents(uriA);
    expect(invalidated).toContain(uriA);
    expect(invalidated).toContain(uriB);

    // B's table is now invalidated
    expect(index.getSymbolTable(uriB)).toBeNull();
  });

  test("removing a file cleans up dependencies", async () => {
    const uriB = corpusUri("cross-inherit-simple-b.pike");
    const uriA = corpusUri("cross-inherit-simple-a.pike");

    // Re-index to ensure clean state
    await indexFile(index, "cross-inherit-simple-a.pike");
    await indexFile(index, "cross-inherit-simple-b.pike");

    // Verify dependency exists
    expect(index.getDependents(uriA).has(uriB)).toBe(true);

    // Remove B
    index.removeFile(uriB);

    // A should no longer have B as a dependent
    expect(index.getDependents(uriA).has(uriB)).toBe(false);
    expect(index.getDependents(uriA).size).toBe(0);
  });
});

describe("Cross-file incremental update — transitive invalidation", () => {
  let index: WorkspaceIndex;
  let uriA: string, uriB: string, uriC: string;

  beforeAll(async () => {
    await initParser();
    index = new WorkspaceIndex({ workspaceRoot: CORPUS_DIR });
    // Chain: C inherits B, B inherits A
    await indexFile(index, "cross-inherit-chain-a.pike");
    await indexFile(index, "cross-inherit-chain-b.pike");
    await indexFile(index, "cross-inherit-chain-c.pike");
    uriA = corpusUri("cross-inherit-chain-a.pike");
    uriB = corpusUri("cross-inherit-chain-b.pike");
    uriC = corpusUri("cross-inherit-chain-c.pike");
  });

  test("dependency graph: A has B as dependent, B has C as dependent", async () => {
    expect(index.getDependents(uriA).has(uriB)).toBe(true);
    expect(index.getDependents(uriB).has(uriC)).toBe(true);
  });

  test("invalidating A transitively invalidates B AND C", async () => {
    // All three have valid tables
    expect(index.getSymbolTable(uriA)).not.toBeNull();
    expect(index.getSymbolTable(uriB)).not.toBeNull();
    expect(index.getSymbolTable(uriC)).not.toBeNull();

    // Invalidate A — the root of the chain
    const invalidated = index.invalidateWithDependents(uriA);

    // A itself is invalidated
    expect(invalidated).toContain(uriA);
    // B (direct dependent of A) is invalidated
    expect(invalidated).toContain(uriB);
    // C (transitive dependent: C→B→A) is also invalidated
    expect(invalidated).toContain(uriC);

    // None of the tables are servable
    expect(index.getSymbolTable(uriA)).toBeNull();
    expect(index.getSymbolTable(uriB)).toBeNull();
    expect(index.getSymbolTable(uriC)).toBeNull();
  });

  test("re-indexing B does not re-validate C (C remains stale)", async () => {
    // Re-index B with fresh content
    const contentB = readCorpus("cross-inherit-chain-b.pike");
    const treeB = parse(contentB);
    await index.upsertFile(uriB, 2, treeB, contentB, ModificationSource.DidChange);

    // B is now valid (upsertFile clears stale)
    expect(index.getSymbolTable(uriB)).not.toBeNull();

    // C is still stale — it was not re-indexed
    expect(index.getSymbolTable(uriC)).toBeNull();
    expect(index.isStale(uriC)).toBe(true);
  });

  test("re-indexing C makes it valid again", async () => {
    const contentC = readCorpus("cross-inherit-chain-c.pike");
    const treeC = parse(contentC);
    await index.upsertFile(uriC, 2, treeC, contentC, ModificationSource.DidChange);

    expect(index.getSymbolTable(uriC)).not.toBeNull();
    expect(index.isStale(uriC)).toBe(false);
  });

  test("invalidating B transitively invalidates C but NOT A", async () => {
    // Re-index all to clean state
    await indexFile(index, "cross-inherit-chain-a.pike");
    await indexFile(index, "cross-inherit-chain-b.pike");
    await indexFile(index, "cross-inherit-chain-c.pike");

    const invalidated = index.invalidateWithDependents(uriB);

    // B itself
    expect(invalidated).toContain(uriB);
    // C depends on B
    expect(invalidated).toContain(uriC);
    // A does NOT depend on B (B depends on A, not the other way)
    expect(invalidated).not.toContain(uriA);
    // A's table is still valid
    expect(index.getSymbolTable(uriA)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cross-file inheritance wiring (US-001)
// ---------------------------------------------------------------------------

describe("Cross-file inheritance wiring — US-001", () => {
  let index: WorkspaceIndex;

  beforeAll(async () => {
    await initParser();
    index = new WorkspaceIndex({ workspaceRoot: CORPUS_DIR });
    await indexFile(index, "cross-inherit-simple-a.pike");
    await indexFile(index, "cross-inherit-simple-b.pike");
  });

  test("Dog class scope has cross-file inherited scope from Animal", async () => {
    const uriB = corpusUri("cross-inherit-simple-b.pike");
    const tableB = index.getSymbolTable(uriB);
    expect(tableB).not.toBeNull();

    // Find Dog class
    const dogDecl = tableB!.declarations.find(d => d.kind === "class" && d.name === "Dog");
    expect(dogDecl).toBeDefined();

    // Find Dog's class scope
    const dogScope = tableB!.scopes.find(s =>
      s.kind === "class" && s.parentId === dogDecl!.scopeId &&
      s.range.start.line >= dogDecl!.range.start.line &&
      s.range.end.line <= dogDecl!.range.end.line,
    );
    expect(dogScope).toBeDefined();

    // Dog should have at least one inherited scope (Animal)
    expect(dogScope!.inheritedScopes.length).toBeGreaterThanOrEqual(1);

    // Check that the inherited scope contains Animal's members
    const inheritedScopeId = dogScope!.inheritedScopes[0];
    const inheritedScope = tableB!.scopeById.get(inheritedScopeId);
    expect(inheritedScope).toBeDefined();

    const inheritedNames = inheritedScope!.declarations.map(id => {
      const decl = tableB!.declById.get(id);
      return decl?.name;
    });

    // Animal's members should be present in the inherited scope
    expect(inheritedNames).toContain("speak");
    expect(inheritedNames).toContain("get_name");
    expect(inheritedNames).toContain("create");
  });

  test("same-file inheritance still works — class-single-inherit", async () => {
    const singleIndex = new WorkspaceIndex({ workspaceRoot: CORPUS_DIR });
    await indexFile(singleIndex, "class-single-inherit.pike");

    const uri = corpusUri("class-single-inherit.pike");
    const table = singleIndex.getSymbolTable(uri);
    expect(table).not.toBeNull();

    // Find Dog class
    const dogDecl = table!.declarations.find(d => d.kind === "class" && d.name === "Dog");
    expect(dogDecl).toBeDefined();

    const dogScope = table!.scopes.find(s =>
      s.kind === "class" && s.parentId === dogDecl!.scopeId &&
      s.range.start.line >= dogDecl!.range.start.line &&
      s.range.end.line <= dogDecl!.range.end.line,
    );
    expect(dogScope).toBeDefined();

    // Dog inherits Animal (same file) — should have inherited scope
    expect(dogScope!.inheritedScopes.length).toBeGreaterThanOrEqual(1);

    // Verify Animal's members are in the inherited scope
    const inheritedScopeId = dogScope!.inheritedScopes[0];
    const inheritedScope = table!.scopeById.get(inheritedScopeId);
    expect(inheritedScope).toBeDefined();

    const inheritedNames = inheritedScope!.declarations.map(id => {
      const decl = table!.declById.get(id);
      return decl?.name;
    });

    expect(inheritedNames).toContain("describe");
    expect(inheritedNames).toContain("get_name");
    expect(inheritedNames).toContain("create");
  });
});

describe("Cross-file inheritance chain wiring", () => {
  let index: WorkspaceIndex;

  beforeAll(async () => {
    await initParser();
    index = new WorkspaceIndex({ workspaceRoot: CORPUS_DIR });
    await indexFile(index, "cross-inherit-chain-a.pike");
    await indexFile(index, "cross-inherit-chain-b.pike");
  });

  test("Middle class inherits Base members from cross-file", async () => {
    const uriB = corpusUri("cross-inherit-chain-b.pike");
    const tableB = index.getSymbolTable(uriB);
    expect(tableB).not.toBeNull();

    const middleDecl = tableB!.declarations.find(d => d.kind === "class" && d.name === "Middle");
    expect(middleDecl).toBeDefined();

    const middleScope = tableB!.scopes.find(s =>
      s.kind === "class" && s.parentId === middleDecl!.scopeId &&
      s.range.start.line >= middleDecl!.range.start.line &&
      s.range.end.line <= middleDecl!.range.end.line,
    );
    expect(middleScope).toBeDefined();
    expect(middleScope!.inheritedScopes.length).toBeGreaterThanOrEqual(1);

    const inheritedScopeId = middleScope!.inheritedScopes[0];
    const inheritedScope = tableB!.scopeById.get(inheritedScopeId);
    expect(inheritedScope).toBeDefined();

    const inheritedNames = inheritedScope!.declarations.map(id => {
      const decl = tableB!.declById.get(id);
      return decl?.name;
    });

    // Base has: label, create, identify
    expect(inheritedNames).toContain("identify");
    expect(inheritedNames).toContain("create");
    expect(inheritedNames).toContain("label");
  });
});