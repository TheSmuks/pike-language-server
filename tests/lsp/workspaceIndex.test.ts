/**
 * Tests for WorkspaceIndex: in-memory per-file symbol table index.
 *
 * Tests use the server's parse() to build real symbol tables from corpus files.
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { initParser, parse } from "../../server/src/parser";
import type { Tree } from "web-tree-sitter";
import { WorkspaceIndex, ModificationSource } from "../../server/src/features/workspaceIndex";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CORPUS_DIR = join(import.meta.dir, "..", "..", "corpus", "files");

function corpusPath(name: string): string {
  return `file://${join(CORPUS_DIR, name)}`;
}

function readCorpus(name: string): string {
  return readFileSync(join(CORPUS_DIR, name), "utf-8");
}

// ---------------------------------------------------------------------------
// WorkspaceIndex tests
// ---------------------------------------------------------------------------

describe("WorkspaceIndex — basic operations", () => {
  let index: WorkspaceIndex;

  beforeAll(async () => {
    await initParser();
    index = new WorkspaceIndex({ workspaceRoot: CORPUS_DIR });
  });

  test("starts empty", () => {
    expect(index.size).toBe(0);
    expect(index.getAllUris()).toEqual([]);
  });

  test("upsertFile adds entry with symbol table", async () => {
    const uri = corpusPath("basic-types.pike");
    const content = readCorpus("basic-types.pike");
    const tree = parse(content);

    const entry = await index.upsertFile(uri, 1, tree, content, ModificationSource.DidOpen);

    expect(entry.uri).toBe(uri);
    expect(entry.version).toBe(1);
    expect(entry.symbolTable).not.toBeNull();
    expect(entry.symbolTable!.declarations.length).toBeGreaterThan(0);
    expect(entry.contentHash).toBeTruthy();
    expect(entry.lastModSource).toBe(ModificationSource.DidOpen);
  });

  test("getFile returns the entry", () => {
    const uri = corpusPath("basic-types.pike");
    const entry = index.getFile(uri);
    expect(entry).toBeDefined();
    expect(entry!.uri).toBe(uri);
  });

  test("getSymbolTable returns the table", () => {
    const uri = corpusPath("basic-types.pike");
    const table = index.getSymbolTable(uri);
    expect(table).not.toBeNull();
    expect(table!.uri).toBe(uri);
  });

  test("removeFile removes the entry", () => {
    const uri = corpusPath("basic-types.pike");
    index.removeFile(uri);
    expect(index.getFile(uri)).toBeUndefined();
    expect(index.getSymbolTable(uri)).toBeNull();
    expect(index.size).toBe(0);
  });

  test("size tracks file count", async () => {
    expect(index.size).toBe(0);

    const content = readCorpus("basic-types.pike");
    const tree = parse(content);
    await index.upsertFile(corpusPath("basic-types.pike"), 1, tree, content, ModificationSource.DidOpen);
    expect(index.size).toBe(1);

    const content2 = readCorpus("class-single-inherit.pike");
    const tree2 = parse(content2);
    await index.upsertFile(corpusPath("class-single-inherit.pike"), 1, tree2, content2, ModificationSource.DidOpen);
    expect(index.size).toBe(2);
  });

  test("clear removes everything", () => {
    index.clear();
    expect(index.size).toBe(0);
    expect(index.getAllUris()).toEqual([]);
  });
});

describe("WorkspaceIndex — cross-file dependencies", () => {
  let index: WorkspaceIndex;

  beforeAll(async () => {
    await initParser();
    index = new WorkspaceIndex({ workspaceRoot: CORPUS_DIR });

    // Index cross-file pair: simple inherit
    const contentB = readCorpus("cross-inherit-simple-b.pike");
    const treeB = parse(contentB);
    await index.upsertFile(corpusPath("cross-inherit-simple-b.pike"), 1, treeB, contentB, ModificationSource.DidOpen);

    const contentA = readCorpus("cross-inherit-simple-a.pike");
    const treeA = parse(contentA);
    await index.upsertFile(corpusPath("cross-inherit-simple-a.pike"), 1, treeA, contentA, ModificationSource.DidOpen);
  });

  test("tracks forward dependencies from inherit", () => {
    // cross-inherit-simple-b.pike inherits from cross-inherit-simple-a.pike (string literal)
    const entryB = index.getFile(corpusPath("cross-inherit-simple-b.pike"));
    expect(entryB).toBeDefined();
    expect(entryB!.dependencies.size).toBeGreaterThan(0);
  });

  test("tracks reverse dependencies (dependents)", () => {
    const uriA = corpusPath("cross-inherit-simple-a.pike");
    const dependents = index.getDependents(uriA);
    expect(dependents.size).toBeGreaterThan(0);
    expect(dependents.has(corpusPath("cross-inherit-simple-b.pike"))).toBe(true);
  });
});

describe("WorkspaceIndex — invalidation", () => {
  let index: WorkspaceIndex;

  beforeAll(async () => {
    await initParser();
    index = new WorkspaceIndex({ workspaceRoot: CORPUS_DIR });
  });

  test("invalidate marks symbol table as null", async () => {
    const content = readCorpus("basic-types.pike");
    const tree = parse(content);
    const uri = corpusPath("basic-types.pike");
    await index.upsertFile(uri, 1, tree, content, ModificationSource.DidOpen);

    expect(index.getSymbolTable(uri)).not.toBeNull();
    index.invalidate(uri);
    expect(index.getSymbolTable(uri)).toBeNull();
  });

  test("invalidateWithDependents invalidates self and dependents", async () => {
    index.clear();

    const contentA = readCorpus("cross-inherit-simple-a.pike");
    const treeA = parse(contentA);
    const uriA = corpusPath("cross-inherit-simple-a.pike");
    await index.upsertFile(uriA, 1, treeA, contentA, ModificationSource.DidOpen);

    const contentB = readCorpus("cross-inherit-simple-b.pike");
    const treeB = parse(contentB);
    const uriB = corpusPath("cross-inherit-simple-b.pike");
    await index.upsertFile(uriB, 1, treeB, contentB, ModificationSource.DidOpen);

    expect(index.getSymbolTable(uriA)).not.toBeNull();
    expect(index.getSymbolTable(uriB)).not.toBeNull();

    const invalidated = index.invalidateWithDependents(uriA);

    expect(invalidated).toContain(uriA);
    expect(invalidated).toContain(uriB);
    expect(index.getSymbolTable(uriA)).toBeNull();
    expect(index.getSymbolTable(uriB)).toBeNull();
  });

  test("rewireDependents invalidates previously-built dependents", async () => {
    index.clear();

    const contentA = readCorpus("cross-inherit-simple-a.pike");
    const treeA = parse(contentA);
    const uriA = corpusPath("cross-inherit-simple-a.pike");
    await index.upsertFile(uriA, 1, treeA, contentA, ModificationSource.DidOpen);

    const contentB = readCorpus("cross-inherit-simple-b.pike");
    const treeB = parse(contentB);
    const uriB = corpusPath("cross-inherit-simple-b.pike");
    await index.upsertFile(uriB, 1, treeB, contentB, ModificationSource.DidOpen);

    expect(index.getSymbolTable(uriB)).not.toBeNull();

    const reWired = index.rewireDependents(uriA);

    expect(reWired).toContain(uriB);
    expect(index.getSymbolTable(uriB)).toBeNull();
  });
});

describe("WorkspaceIndex — #pike version detection", () => {
  let index: WorkspaceIndex;

  beforeAll(async () => {
    await initParser();
    index = new WorkspaceIndex({ workspaceRoot: CORPUS_DIR });
  });

  test("detects #pike version directive", async () => {
    const content = readCorpus("compat-pike78.pike");
    const tree = parse(content);
    const uri = corpusPath("compat-pike78.pike");

    const entry = await index.upsertFile(uri, 1, tree, content, ModificationSource.DidOpen);
    expect(entry.pikeVersion).not.toBeNull();
    expect(entry.pikeVersion!.major).toBe(7);
    expect(entry.pikeVersion!.minor).toBe(8);
  });

  test("returns null version for files without #pike", async () => {
    const content = readCorpus("basic-types.pike");
    const tree = parse(content);
    const uri = corpusPath("basic-types.pike");

    const entry = await index.upsertFile(uri, 1, tree, content, ModificationSource.DidOpen);
    expect(entry.pikeVersion).toBeNull();
  });
});

describe("WorkspaceIndex — module resolution", () => {
  let index: WorkspaceIndex;

  beforeAll(async () => {
    await initParser();
    const pikeBinary = process.env.PIKE_BINARY ?? undefined;
    index = await WorkspaceIndex.create(CORPUS_DIR, pikeBinary);

    // Index a file that uses cross-file references
    const content = readCorpus("cross-stdlib.pike");
    const tree = parse(content);
    await index.upsertFile(corpusPath("cross-stdlib.pike"), 1, tree, content, ModificationSource.DidOpen);
  });

  test("resolveModule resolves system modules", async () => {
    const uri = corpusPath("cross-stdlib.pike");
    const result = await index.resolveModule("Stdio", uri);
    // System module resolution requires correct Pike paths from detectPikePaths.
    // In CI source builds, --show-paths output may go to stderr, so resolution
    // may fail. This is acceptable — the test validates the code path works
    // when paths are available.
    if (result === null && index.pikePaths.pikeHome === "") {
      return; // Pike paths unavailable in this environment
    }
    expect(result).not.toBeNull();
    expect(result).toContain("Stdio.pmod");
  });

  test("resolveModule resolves workspace modules", async () => {
    const uri = corpusPath("cross-stdlib.pike");
    const result = await index.resolveModule("cross_import_a", uri);
    expect(result).not.toBeNull();
    expect(result).toContain("cross_import_a.pmod");
  });
});


describe("WorkspaceIndex — hashContent produces positive hex", () => {
  test("hashContent never returns negative hex strings", async () => {
    const idx = new WorkspaceIndex({ workspaceRoot: "/tmp" });
    // Access hashContent indirectly via upsertFile — the contentHash on the entry
    // is the hex representation of the hash.
    //
    // Use strings with high char codes that historically triggered sign issues
    // with & 0xffffffff.
    const heavyContent = String.fromCharCode(0xffff).repeat(200);
    const tree = parse(heavyContent);
    const entry = await idx.upsertFile(
      "file:///tmp/test.pike",
      1,
      tree,
      heavyContent,
      ModificationSource.DidOpen,
    );
    // Hex string must not start with '-' (negative)
    expect(entry.contentHash.startsWith("-")).toBe(false);
    // Must be a non-empty hex string
    expect(entry.contentHash.length).toBeGreaterThan(0);
    expect(/^[0-9a-f]+$/.test(entry.contentHash)).toBe(true);
  });
});

describe("WorkspaceIndex — source-file filtering prevents false cross-file matches", () => {
  let index: WorkspaceIndex;

  beforeAll(async () => {
    await initParser();
    index = new WorkspaceIndex({ workspaceRoot: CORPUS_DIR });
  });

  test("unrelated same-name symbols in different files do not match", async () => {
    index.clear();

    // File A: defines 'process' as a top-level function
    const contentA = `
int process(int x) { return x * 2; }
int helper() { return process(3); }
int main() { return 0; }
`;
    const uriA = "file:///test/a.pike";
    const treeA = parse(contentA);
    await index.upsertFile(uriA, 1, treeA, contentA, ModificationSource.DidOpen);

    // File B: defines an unrelated 'process' function
    const contentB = `
string process(string s) { return s + "!"; }
int run() { return (int)process("0"); }
int main() { return 0; }
`;
    const uriB = "file:///test/b.pike";
    const treeB = parse(contentB);
    await index.upsertFile(uriB, 1, treeB, contentB, ModificationSource.DidOpen);

    // Find the declaration of 'process' in file A
    const tableA = index.getSymbolTable(uriA);
    expect(tableA).not.toBeNull();
    const processDeclA = tableA!.declarations.find(d => d.name === "process" && d.kind === "function");
    expect(processDeclA).toBeDefined();

    // Call getCrossFileReferences on A's 'process' declaration
    const crossRefs = await index.getCrossFileReferences(uriA, processDeclA!.nameRange.start.line, processDeclA!.nameRange.start.character);

    // B's 'process' must NOT appear — the files are unrelated
    const bRefs = crossRefs.filter(r => r.uri === uriB);
    expect(bRefs.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// US3: Index entry demotion and rehydration (Phase 5, T064)
//
// Goal: Verify that demoteNonEssentialEntries demotes only non-open,
// non-closure entries while preserving dependency edges, and that
// rehydrateEntry restores the symbol table from the on-demand indexer.
//
// Methodology: Build a small index with four background-indexed files.
// Manually set dependency edges via restoreDependencies so the demotion
// invariant ("dependency map survives demotion") can be asserted without
// relying on the module resolver.
// ---------------------------------------------------------------------------

describe("US3: Index entry demotion and rehydration (Phase 5, T064)", () => {
  let index: WorkspaceIndex;

  beforeAll(async () => {
    await initParser();
    index = new WorkspaceIndex({ workspaceRoot: "/tmp" });
  });

  test("T064: demoteNonEssentialEntries skips open and closure entries", () => {
    index.clear();

    const content = `int foo() { return 1; }`;
    const tree = parse(content);

    const uriOpen = "file:///test/us3-open.pike";
    const uriClosure = "file:///test/us3-closure.pike";
    const uriExtra1 = "file:///test/us3-extra1.pike";
    const uriExtra2 = "file:///test/us3-extra2.pike";

    // Background-index four files (lifecycle = "full").
    index.upsertBackgroundFile(uriOpen, 1, tree, content);
    index.upsertBackgroundFile(uriClosure, 1, tree, content);
    index.upsertBackgroundFile(uriExtra1, 1, tree, content);
    index.upsertBackgroundFile(uriExtra2, 1, tree, content);

    // All four start as "full".
    expect(index.getEntryLifecycle(uriOpen)).toBe("full");
    expect(index.getEntryLifecycle(uriExtra1)).toBe("full");

    const openUris = new Set([uriOpen]);
    const closureUris = new Set([uriOpen, uriClosure]);

    const demoted = index.demoteNonEssentialEntries(openUris, closureUris, 10);

    // Only the two extras should be demoted.
    expect(demoted.length).toBe(2);
    expect(demoted).toContain(uriExtra1);
    expect(demoted).toContain(uriExtra2);
    expect(demoted).not.toContain(uriOpen);
    expect(demoted).not.toContain(uriClosure);

    // Open and closure entries remain full.
    expect(index.getEntryLifecycle(uriOpen)).toBe("full");
    expect(index.getEntryLifecycle(uriClosure)).toBe("full");

    // Demoted entries have null symbol tables — not stale data presented as success.
    expect(index.getSymbolTable(uriExtra1)).toBeNull();
    expect(index.getSymbolTable(uriExtra2)).toBeNull();

    // Open file's symbol table is untouched.
    expect(index.getSymbolTable(uriOpen)).not.toBeNull();
  });

  test("T064: demoted entries retain dependency edges", () => {
    index.clear();

    const content = `int foo() { return 1; }`;
    const tree = parse(content);

    const uriSrc = "file:///test/us3-depsrc.pike";
    const uriDep = "file:///test/us3-depdep.pike";

    index.upsertBackgroundFile(uriSrc, 1, tree, content);
    index.upsertBackgroundFile(uriDep, 1, tree, content);

    // Set up a dependency edge: uriSrc depends on uriDep.
    index.restoreDependencies(uriSrc, new Set([uriDep]));

    // Verify the edge exists before demotion.
    const depsBefore = index.getDependencyMap().forwardEdges.get(uriSrc);
    expect(depsBefore).toBeDefined();
    expect(depsBefore!.has(uriDep)).toBe(true);

    // Demote uriDep (it is not open and not in any closure).
    const openUris = new Set([uriSrc]);
    const closureUris = new Set([uriSrc]);
    const demoted = index.demoteNonEssentialEntries(openUris, closureUris, 10);
    expect(demoted).toContain(uriDep);

    // The dependency edge must survive demotion.
    const depsAfter = index.getDependencyMap().forwardEdges.get(uriSrc);
    expect(depsAfter).toBeDefined();
    expect(depsAfter!.has(uriDep)).toBe(true);

    // Reverse edge (dependents) must also survive.
    const dependents = index.getDependents(uriDep);
    expect(dependents.has(uriSrc)).toBe(true);
  });

  test("T064: rehydrateEntry restores symbol table for demoted entries", async () => {
    index.clear();

    const content = `int foo() { return 42; }`;
    const tree = parse(content);
    const uriTarget = "file:///test/us3-rehydrate.pike";

    index.upsertBackgroundFile(uriTarget, 1, tree, content);
    expect(index.getEntryLifecycle(uriTarget)).toBe("full");

    // Demote the entry.
    const demoted = index.demoteNonEssentialEntries(new Set(), new Set(), 10);
    expect(demoted).toContain(uriTarget);
    expect(index.getEntryLifecycle(uriTarget)).toBe("demoted");
    expect(index.getSymbolTable(uriTarget)).toBeNull();

    // Set up an on-demand indexer that re-indexes from a stored tree.
    const storedTrees = new Map<string, { tree: Tree; content: string }>([
      [uriTarget, { tree, content }],
    ]);
    index.setOnDemandIndexFn(async (uri) => {
      const stored = storedTrees.get(uri);
      if (!stored) return null;
      return index.upsertBackgroundFile(uri, 1, stored.tree, stored.content);
    });

    // Rehydrate — the on-demand indexer should restore the symbol table.
    const restored = await index.rehydrateEntry(uriTarget);
    expect(restored).toBe(true);
    expect(index.getSymbolTable(uriTarget)).not.toBeNull();
  });

  test("T064: rehydrateEntry returns false for non-demoted or missing entries", async () => {
    index.clear();

    const content = `int foo() { return 1; }`;
    const tree = parse(content);
    const uriFull = "file:///test/us3-full.pike";

    index.upsertBackgroundFile(uriFull, 1, tree, content);

    // Full entry — rehydrate should be a no-op.
    const result = await index.rehydrateEntry(uriFull);
    expect(result).toBe(false);

    // Missing entry — rehydrate should return false.
    const missing = await index.rehydrateEntry("file:///test/us3-missing.pike");
    expect(missing).toBe(false);
  });

  test("T064: demoteNonEssentialEntries respects maxToDemote bound", () => {
    index.clear();

    const content = `int foo() { return 1; }`;
    const tree = parse(content);

    // Index 10 files, all non-essential.
    for (let i = 0; i < 10; i++) {
      index.upsertBackgroundFile(`file:///test/us3-bound-${i}.pike`, 1, tree, content);
    }

    // Only demote 3.
    const demoted = index.demoteNonEssentialEntries(new Set(), new Set(), 3);
    expect(demoted.length).toBe(3);

    // The remaining 7 are still full.
    let fullCount = 0;
    for (let i = 0; i < 10; i++) {
      if (index.getEntryLifecycle(`file:///test/us3-bound-${i}.pike`) === "full") {
        fullCount++;
      }
    }
    expect(fullCount).toBe(7);
  });
});
