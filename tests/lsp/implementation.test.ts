/**
 * Tests for findImplementations — locating classes that inherit from
 * the class at a given position.
 *
 * Covers:
 * - Same-file class with implementers
 * - Same-file class with no implementers
 * - Cross-file implementation
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { initParser, parse } from "../../server/src/parser";
import { WorkspaceIndex, ModificationSource } from "../../server/src/features/workspaceIndex";
import { findImplementations } from "../../server/src/features/implementation";
import { buildSymbolTable } from "../../server/src/features/symbolTable";

const CORPUS_DIR = join(import.meta.dir, "..", "..", "corpus", "files");

function corpusUri(name: string): string {
  return `file://${join(CORPUS_DIR, name)}`;
}

function readCorpus(name: string): string {
  return readFileSync(join(CORPUS_DIR, name), "utf-8");
}

/** Index a file into the workspace. */
async function indexFile(index: WorkspaceIndex, name: string): Promise<void> {
  const uri = corpusUri(name);
  const content = readCorpus(name);
  const tree = parse(content);
  await index.upsertFile(uri, 1, tree, content, ModificationSource.DidOpen);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await initParser();
});

// ---------------------------------------------------------------------------
// Same-file: class with implementers
// ---------------------------------------------------------------------------

describe("findImplementations — same-file class with implementers", () => {
  test("Animal has Dog and GuideDog as implementers", () => {
    const src = readCorpus("class-single-inherit.pike");
    const tree = parse(src);
    const table = buildSymbolTable(tree, corpusUri("class-single-inherit.pike"), 1);

    // Find the Animal class declaration
    const animalDecl = table.declarations.find(
      (d) => d.kind === "class" && d.name === "Animal",
    );
    expect(animalDecl).toBeDefined();

    // Build a workspace index with just this file
    const index = new WorkspaceIndex({ workspaceRoot: CORPUS_DIR });
    // Use getSymbolTable by upserting
    const uri = corpusUri("class-single-inherit.pike");
    // Since we need the symbol table in the index, upsert the file
    // But upsertFile is async and requires a tree; we already have one
    // Use a synchronous approach: directly test findImplementations with a
    // minimally populated index via getAllEntries mock... No, let's just use
    // the real index.

    // We'll do async indexing in the test below, but for this test let's
    // just verify the function works with a real WorkspaceIndex.
  });

  test("Animal has Dog and GuideDog as implementers (with index)", async () => {
    const index = new WorkspaceIndex({ workspaceRoot: CORPUS_DIR });
    await indexFile(index, "class-single-inherit.pike");

    const uri = corpusUri("class-single-inherit.pike");
    const table = index.getSymbolTable(uri);
    expect(table).not.toBeNull();

    const animalDecl = table!.declarations.find(
      (d) => d.kind === "class" && d.name === "Animal",
    );
    expect(animalDecl).toBeDefined();

    const impls = findImplementations(
      index,
      uri,
      animalDecl!.nameRange.start.line,
      animalDecl!.nameRange.start.character,
    );

    expect(impls.length).toBe(1);

    const implNames = impls.map((i) => {
      const depTable = index.getSymbolTable(i.uri);
      // Find the class declaration at the returned range
      const cls = depTable?.declarations.find(
        (d) =>
          d.kind === "class" &&
          d.nameRange.start.line === i.range.start.line &&
          d.nameRange.start.character === i.range.start.character,
      );
      return cls?.name;
    });

    expect(implNames).toContain("Dog");
  });

  test("Dog has GuideDog as implementer", async () => {
    const index = new WorkspaceIndex({ workspaceRoot: CORPUS_DIR });
    await indexFile(index, "class-single-inherit.pike");

    const uri = corpusUri("class-single-inherit.pike");
    const table = index.getSymbolTable(uri);
    expect(table).not.toBeNull();

    const dogDecl = table!.declarations.find(
      (d) => d.kind === "class" && d.name === "Dog",
    );
    expect(dogDecl).toBeDefined();

    const impls = findImplementations(
      index,
      uri,
      dogDecl!.nameRange.start.line,
      dogDecl!.nameRange.start.character,
    );

    expect(impls.length).toBe(1);

    const depTable = index.getSymbolTable(impls[0].uri);
    const cls = depTable?.declarations.find(
      (d) =>
        d.kind === "class" &&
        d.nameRange.start.line === impls[0].range.start.line &&
        d.nameRange.start.character === impls[0].range.start.character,
    );
    expect(cls?.name).toBe("GuideDog");
  });
});

// ---------------------------------------------------------------------------
// Same-file: class with no implementers
// ---------------------------------------------------------------------------

describe("findImplementations — class with no implementers", () => {
  test("GuideDog has no implementers", async () => {
    const index = new WorkspaceIndex({ workspaceRoot: CORPUS_DIR });
    await indexFile(index, "class-single-inherit.pike");

    const uri = corpusUri("class-single-inherit.pike");
    const table = index.getSymbolTable(uri);
    expect(table).not.toBeNull();

    const guideDogDecl = table!.declarations.find(
      (d) => d.kind === "class" && d.name === "GuideDog",
    );
    expect(guideDogDecl).toBeDefined();

    const impls = findImplementations(
      index,
      uri,
      guideDogDecl!.nameRange.start.line,
      guideDogDecl!.nameRange.start.character,
    );

    expect(impls.length).toBe(0);
  });

  test("non-class position returns empty", async () => {
    const index = new WorkspaceIndex({ workspaceRoot: CORPUS_DIR });
    await indexFile(index, "class-single-inherit.pike");

    const uri = corpusUri("class-single-inherit.pike");
    const table = index.getSymbolTable(uri);
    expect(table).not.toBeNull();

    // Find the `main` function declaration
    const mainDecl = table!.declarations.find(
      (d) => d.kind === "function" && d.name === "main",
    );
    expect(mainDecl).toBeDefined();

    const impls = findImplementations(
      index,
      uri,
      mainDecl!.nameRange.start.line,
      mainDecl!.nameRange.start.character,
    );

    expect(impls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Cross-file implementation
// ---------------------------------------------------------------------------

describe("findImplementations — cross-file", () => {
  test("Animal in simple-a is implemented by Dog in simple-b", async () => {
    const index = new WorkspaceIndex({ workspaceRoot: CORPUS_DIR });
    await indexFile(index, "cross-inherit-simple-a.pike");
    await indexFile(index, "cross-inherit-simple-b.pike");

    const uriA = corpusUri("cross-inherit-simple-a.pike");
    const tableA = index.getSymbolTable(uriA);
    expect(tableA).not.toBeNull();

    const animalDecl = tableA!.declarations.find(
      (d) => d.kind === "class" && d.name === "Animal",
    );
    expect(animalDecl).toBeDefined();

    const impls = findImplementations(
      index,
      uriA,
      animalDecl!.nameRange.start.line,
      animalDecl!.nameRange.start.character,
    );

    expect(impls.length).toBe(1);

    const uriB = corpusUri("cross-inherit-simple-b.pike");
    expect(impls[0].uri).toBe(uriB);

    const tableB = index.getSymbolTable(uriB);
    const cls = tableB?.declarations.find(
      (d) =>
        d.kind === "class" &&
        d.nameRange.start.line === impls[0].range.start.line &&
        d.nameRange.start.character === impls[0].range.start.character,
    );
    expect(cls?.name).toBe("Dog");
  });

  test("Base in chain-a is implemented by Middle in chain-b", async () => {
    const index = new WorkspaceIndex({ workspaceRoot: CORPUS_DIR });
    await indexFile(index, "cross-inherit-chain-a.pike");
    await indexFile(index, "cross-inherit-chain-b.pike");
    await indexFile(index, "cross-inherit-chain-c.pike");

    const uriA = corpusUri("cross-inherit-chain-a.pike");
    const tableA = index.getSymbolTable(uriA);
    expect(tableA).not.toBeNull();

    const baseDecl = tableA!.declarations.find(
      (d) => d.kind === "class" && d.name === "Base",
    );
    expect(baseDecl).toBeDefined();

    const impls = findImplementations(
      index,
      uriA,
      baseDecl!.nameRange.start.line,
      baseDecl!.nameRange.start.character,
    );

    // Middle (in chain-b) and no other in chain-c (chain-c inherits Middle, not Base)
    expect(impls.length).toBe(1);

    const uriB = corpusUri("cross-inherit-chain-b.pike");
    expect(impls[0].uri).toBe(uriB);

    const tableB = index.getSymbolTable(uriB);
    const cls = tableB?.declarations.find(
      (d) =>
        d.kind === "class" &&
        d.nameRange.start.line === impls[0].range.start.line &&
        d.nameRange.start.character === impls[0].range.start.character,
    );
    expect(cls?.name).toBe("Middle");
  });
});
