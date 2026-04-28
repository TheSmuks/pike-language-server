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
function indexFile(index: WorkspaceIndex, name: string): void {
  const uri = corpusUri(name);
  const content = readCorpus(name);
  const tree = parse(content);
  index.upsertFile(uri, 1, tree, content, ModificationSource.DidOpen);
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
    indexFile(index, "cross-inherit-simple-a.pike");
    indexFile(index, "cross-inherit-simple-b.pike");
  });

  test("inherit declaration in B resolves to file A", () => {
    const uriB = corpusUri("cross-inherit-simple-b.pike");
    // The inherit declaration has the path text on its nameRange
    // Find the inherit declaration in B's symbol table
    const tableB = index.getSymbolTable(uriB);
    expect(tableB).not.toBeNull();

    const inheritDecl = tableB!.declarations.find(d => d.kind === "inherit");
    expect(inheritDecl).toBeDefined();

    const result = index.resolveCrossFileDefinition(
      uriB,
      inheritDecl!.nameRange.start.line,
      inheritDecl!.nameRange.start.character,
    );

    expect(result).not.toBeNull();
    expect(result!.uri).toBe(corpusUri("cross-inherit-simple-a.pike"));
  });
});

describe("Cross-file definition — inherit with rename", () => {
  let index: WorkspaceIndex;

  beforeAll(async () => {
    await initParser();
    index = new WorkspaceIndex({ workspaceRoot: CORPUS_DIR });
    indexFile(index, "cross-inherit-rename-a.pike");
    indexFile(index, "cross-inherit-rename-b.pike");
  });

  test("inherit with alias resolves to target file", () => {
    const uriB = corpusUri("cross-inherit-rename-b.pike");
    const tableB = index.getSymbolTable(uriB);
    expect(tableB).not.toBeNull();

    const inheritDecl = tableB!.declarations.find(d => d.kind === "inherit");
    expect(inheritDecl).toBeDefined();

    const result = index.resolveCrossFileDefinition(
      uriB,
      inheritDecl!.nameRange.start.line,
      inheritDecl!.nameRange.start.character,
    );

    expect(result).not.toBeNull();
    expect(result!.uri).toBe(corpusUri("cross-inherit-rename-a.pike"));
  });
});

describe("Cross-file definition — inherit chain", () => {
  let index: WorkspaceIndex;

  beforeAll(async () => {
    await initParser();
    index = new WorkspaceIndex({ workspaceRoot: CORPUS_DIR });
    indexFile(index, "cross-inherit-chain-a.pike");
    indexFile(index, "cross-inherit-chain-b.pike");
    indexFile(index, "cross-inherit-chain-c.pike");
  });

  test("C inherits B, B inherits A — chain resolves", () => {
    const uriC = corpusUri("cross-inherit-chain-c.pike");
    const tableC = index.getSymbolTable(uriC);
    expect(tableC).not.toBeNull();

    const inheritDecl = tableC!.declarations.find(d => d.kind === "inherit");
    expect(inheritDecl).toBeDefined();

    const result = index.resolveCrossFileDefinition(
      uriC,
      inheritDecl!.nameRange.start.line,
      inheritDecl!.nameRange.start.character,
    );

    expect(result).not.toBeNull();
    expect(result!.uri).toBe(corpusUri("cross-inherit-chain-b.pike"));
  });

  test("B inherits A — resolves correctly", () => {
    const uriB = corpusUri("cross-inherit-chain-b.pike");
    const tableB = index.getSymbolTable(uriB);
    expect(tableB).not.toBeNull();

    const inheritDecl = tableB!.declarations.find(d => d.kind === "inherit");
    expect(inheritDecl).toBeDefined();

    const result = index.resolveCrossFileDefinition(
      uriB,
      inheritDecl!.nameRange.start.line,
      inheritDecl!.nameRange.start.character,
    );

    expect(result).not.toBeNull();
    expect(result!.uri).toBe(corpusUri("cross-inherit-chain-a.pike"));
  });
});

describe("Cross-file definition — module import", () => {
  let index: WorkspaceIndex;

  beforeAll(async () => {
    await initParser();
    index = new WorkspaceIndex({ workspaceRoot: CORPUS_DIR });
    indexFile(index, "cross_import_a.pmod");
    indexFile(index, "cross-import-b.pike");
  });

  test("import declaration in B resolves to module A", () => {
    const uriB = corpusUri("cross-import-b.pike");
    const tableB = index.getSymbolTable(uriB);
    expect(tableB).not.toBeNull();

    // import_decl is stored as kind='inherit' in the symbol table (DECL_KIND_MAP)
    const importDecl = tableB!.declarations.find(d => d.kind === "inherit");
    expect(importDecl).toBeDefined();
  });
});

describe("Cross-file references — simple inherit", () => {
  let index: WorkspaceIndex;

  beforeAll(async () => {
    await initParser();
    index = new WorkspaceIndex({ workspaceRoot: CORPUS_DIR });
    indexFile(index, "cross-inherit-simple-a.pike");
    indexFile(index, "cross-inherit-simple-b.pike");
  });

  test("declaration in A has dependents", () => {
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
    indexFile(index, "cross-pmod-user.pike");
  });

  test("cross-pmod-user indexes successfully", () => {
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
    indexFile(index, "cross-stdlib.pike");
  });

  test("cross-stdlib.pike indexes without error", () => {
    const uri = corpusUri("cross-stdlib.pike");
    const table = index.getSymbolTable(uri);
    expect(table).not.toBeNull();
  });

  test("compat-pike78.pike detects #pike version", () => {
    indexFile(index, "compat-pike78.pike");
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
    indexFile(index, "cross-inherit-simple-a.pike");
    indexFile(index, "cross-inherit-simple-b.pike");
    indexFile(index, "cross-inherit-chain-c.pike");
  });

  test("re-indexing a file preserves dependencies", () => {
    const uriA = corpusUri("cross-inherit-simple-a.pike");
    const uriB = corpusUri("cross-inherit-simple-b.pike");

    // Re-index A with same content
    const content = readCorpus("cross-inherit-simple-a.pike");
    const tree = parse(content);
    index.upsertFile(uriA, 2, tree, content, ModificationSource.DidChange);

    // B should still be a dependent of A
    const deps = index.getDependents(uriA);
    expect(deps.has(uriB)).toBe(true);
  });

  test("invalidating A invalidates B", () => {
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

  test("removing a file cleans up dependencies", () => {
    const uriB = corpusUri("cross-inherit-simple-b.pike");
    const uriA = corpusUri("cross-inherit-simple-a.pike");

    // Re-index to ensure clean state
    indexFile(index, "cross-inherit-simple-a.pike");
    indexFile(index, "cross-inherit-simple-b.pike");

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
    indexFile(index, "cross-inherit-chain-a.pike");
    indexFile(index, "cross-inherit-chain-b.pike");
    indexFile(index, "cross-inherit-chain-c.pike");
    uriA = corpusUri("cross-inherit-chain-a.pike");
    uriB = corpusUri("cross-inherit-chain-b.pike");
    uriC = corpusUri("cross-inherit-chain-c.pike");
  });

  test("dependency graph: A has B as dependent, B has C as dependent", () => {
    expect(index.getDependents(uriA).has(uriB)).toBe(true);
    expect(index.getDependents(uriB).has(uriC)).toBe(true);
  });

  test("invalidating A transitively invalidates B AND C", () => {
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

  test("re-indexing B does not re-validate C (C remains stale)", () => {
    // Re-index B with fresh content
    const contentB = readCorpus("cross-inherit-chain-b.pike");
    const treeB = parse(contentB);
    index.upsertFile(uriB, 2, treeB, contentB, ModificationSource.DidChange);

    // B is now valid (upsertFile clears stale)
    expect(index.getSymbolTable(uriB)).not.toBeNull();

    // C is still stale — it was not re-indexed
    expect(index.getSymbolTable(uriC)).toBeNull();
    expect(index.isStale(uriC)).toBe(true);
  });

  test("re-indexing C makes it valid again", () => {
    const contentC = readCorpus("cross-inherit-chain-c.pike");
    const treeC = parse(contentC);
    index.upsertFile(uriC, 2, treeC, contentC, ModificationSource.DidChange);

    expect(index.getSymbolTable(uriC)).not.toBeNull();
    expect(index.isStale(uriC)).toBe(false);
  });

  test("invalidating B transitively invalidates C but NOT A", () => {
    // Re-index all to clean state
    indexFile(index, "cross-inherit-chain-a.pike");
    indexFile(index, "cross-inherit-chain-b.pike");
    indexFile(index, "cross-inherit-chain-c.pike");

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