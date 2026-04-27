/**
 * Tests for WorkspaceIndex: in-memory per-file symbol table index.
 *
 * Tests use the server's parse() to build real symbol tables from corpus files.
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { initParser, parse } from "../../server/src/parser";
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

  test("upsertFile adds entry with symbol table", () => {
    const uri = corpusPath("basic-types.pike");
    const content = readCorpus("basic-types.pike");
    const tree = parse(content);

    const entry = index.upsertFile(uri, 1, tree, content, ModificationSource.DidOpen);

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

  test("size tracks file count", () => {
    expect(index.size).toBe(0);

    const content = readCorpus("basic-types.pike");
    const tree = parse(content);
    index.upsertFile(corpusPath("basic-types.pike"), 1, tree, content, ModificationSource.DidOpen);
    expect(index.size).toBe(1);

    const content2 = readCorpus("class-single-inherit.pike");
    const tree2 = parse(content2);
    index.upsertFile(corpusPath("class-single-inherit.pike"), 1, tree2, content2, ModificationSource.DidOpen);
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
    index.upsertFile(corpusPath("cross-inherit-simple-b.pike"), 1, treeB, contentB, ModificationSource.DidOpen);

    const contentA = readCorpus("cross-inherit-simple-a.pike");
    const treeA = parse(contentA);
    index.upsertFile(corpusPath("cross-inherit-simple-a.pike"), 1, treeA, contentA, ModificationSource.DidOpen);
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

  test("invalidate marks symbol table as null", () => {
    const content = readCorpus("basic-types.pike");
    const tree = parse(content);
    const uri = corpusPath("basic-types.pike");
    index.upsertFile(uri, 1, tree, content, ModificationSource.DidOpen);

    expect(index.getSymbolTable(uri)).not.toBeNull();
    index.invalidate(uri);
    expect(index.getSymbolTable(uri)).toBeNull();
  });

  test("invalidateWithDependents invalidates self and dependents", async () => {
    index.clear();

    // Dependency: B inherits from A, so B depends on A
    const contentA = readCorpus("cross-inherit-simple-a.pike");
    const treeA = parse(contentA);
    index.upsertFile(corpusPath("cross-inherit-simple-a.pike"), 1, treeA, contentA, ModificationSource.DidOpen);

    const contentB = readCorpus("cross-inherit-simple-b.pike");
    const treeB = parse(contentB);
    index.upsertFile(corpusPath("cross-inherit-simple-b.pike"), 1, treeB, contentB, ModificationSource.DidOpen);

    const uriA = corpusPath("cross-inherit-simple-a.pike");
    const uriB = corpusPath("cross-inherit-simple-b.pike");

    // Both have valid symbol tables
    expect(index.getSymbolTable(uriA)).not.toBeNull();
    expect(index.getSymbolTable(uriB)).not.toBeNull();

    // Invalidate A — B depends on A, so B should also be invalidated
    const invalidated = index.invalidateWithDependents(uriA);

    expect(invalidated).toContain(uriA);
    expect(invalidated).toContain(uriB);
    expect(index.getSymbolTable(uriA)).toBeNull();
    expect(index.getSymbolTable(uriB)).toBeNull();
  });
});

describe("WorkspaceIndex — #pike version detection", () => {
  let index: WorkspaceIndex;

  beforeAll(async () => {
    await initParser();
    index = new WorkspaceIndex({ workspaceRoot: CORPUS_DIR });
  });

  test("detects #pike version directive", () => {
    const content = readCorpus("compat-pike78.pike");
    const tree = parse(content);
    const uri = corpusPath("compat-pike78.pike");

    const entry = index.upsertFile(uri, 1, tree, content, ModificationSource.DidOpen);
    expect(entry.pikeVersion).not.toBeNull();
    expect(entry.pikeVersion!.major).toBe(7);
    expect(entry.pikeVersion!.minor).toBe(8);
  });

  test("returns null version for files without #pike", () => {
    const content = readCorpus("basic-types.pike");
    const tree = parse(content);
    const uri = corpusPath("basic-types.pike");

    const entry = index.upsertFile(uri, 1, tree, content, ModificationSource.DidOpen);
    expect(entry.pikeVersion).toBeNull();
  });
});

describe("WorkspaceIndex — module resolution", () => {
  let index: WorkspaceIndex;

  beforeAll(async () => {
    await initParser();
    index = new WorkspaceIndex({ workspaceRoot: CORPUS_DIR });

    // Index a file that uses cross-file references
    const content = readCorpus("cross-stdlib.pike");
    const tree = parse(content);
    index.upsertFile(corpusPath("cross-stdlib.pike"), 1, tree, content, ModificationSource.DidOpen);
  });

  test("resolveModule resolves system modules", () => {
    const uri = corpusPath("cross-stdlib.pike");
    const result = index.resolveModule("Stdio", uri);
    expect(result).not.toBeNull();
    expect(result).toContain("Stdio.pmod");
  });

  test("resolveModule resolves workspace modules", () => {
    const uri = corpusPath("cross-stdlib.pike");
    const result = index.resolveModule("cross_import_a", uri);
    expect(result).not.toBeNull();
    expect(result).toContain("cross_import_a.pmod");
  });
});
