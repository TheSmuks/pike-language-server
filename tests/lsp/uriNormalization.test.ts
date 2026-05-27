/**
 * URI normalization regression tests.
 *
 * Verifies that WorkspaceIndex normalizes URIs at every boundary so that
 * files reached through different paths (e.g., symlink vs real path) always
 * map to the same index key. This prevents the "two entries for one file" bug
 * where ModuleResolver and VSCode didOpen produce different URIs for the same
 * file.
 *
 * Methodology: create a symlink to a real corpus file, then index via both the
 * real URI and the symlink URI. Assert that both lookups return the same entry.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { initParser, parse } from "../../server/src/parser";
import { WorkspaceIndex, ModificationSource } from "../../server/src/features/workspaceIndex";
import { readFileSync, symlinkSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";

const CORPUS_DIR = join(import.meta.dir, "..", "..", "corpus", "files");
const SYMLINK_DIR = join(import.meta.dir, "..", "..", "corpus", "symlink-test");

// Create a symlink directory pointing to the real corpus for symlink-based tests.
// Cleaned up in afterAll.
const SYMLINK_PATH = join(SYMLINK_DIR, "linked-a.pike");
const REAL_FILE = join(CORPUS_DIR, "cross-inherit-simple-a.pike");

function corpusUri(name: string): string {
  return pathToFileURL(join(CORPUS_DIR, name)).href;
}

function readCorpus(name: string): string {
  return readFileSync(join(CORPUS_DIR, name), "utf-8");
}

async function indexFile(index: WorkspaceIndex, name: string): Promise<void> {
  const uri = corpusUri(name);
  const content = readCorpus(name);
  const tree = parse(content);
  await index.upsertFile(uri, 1, tree, content, ModificationSource.DidOpen);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("URI normalization", () => {
  beforeAll(async () => {
    await initParser();
    // Create symlink directory and symlink
    if (!existsSync(SYMLINK_DIR)) mkdirSync(SYMLINK_DIR, { recursive: true });
    if (existsSync(SYMLINK_PATH)) unlinkSync(SYMLINK_PATH);
    symlinkSync(REAL_FILE, SYMLINK_PATH);
  });

  afterAll(() => {
    if (existsSync(SYMLINK_PATH)) unlinkSync(SYMLINK_PATH);
  });

  test("same file indexed via real path and symlink path produces one entry", async () => {
    const index = new WorkspaceIndex({ workspaceRoot: CORPUS_DIR });

    // Index via real path
    const realUri = pathToFileURL(REAL_FILE).href;
    const content = readFileSync(REAL_FILE, "utf-8");
    const tree1 = parse(content);
    await index.upsertFile(realUri, 1, tree1, content, ModificationSource.DidOpen);

    // Index via symlink path — should overwrite the same entry, not create a second one
    const symlinkUri = pathToFileURL(SYMLINK_PATH).href;
    const tree2 = parse(content);
    await index.upsertFile(symlinkUri, 2, tree2, content, ModificationSource.DidOpen);

    // Both URIs should resolve to the same entry (version 2 = latest write)
    const entry1 = index.getFile(realUri);
    const entry2 = index.getFile(symlinkUri);

    expect(entry1).not.toBeUndefined();
    expect(entry2).not.toBeUndefined();
    expect(entry1!.version).toBe(2);
    expect(entry2!.version).toBe(2);
    expect(index.size).toBe(1);
  });

  test("getFile normalizes URI at lookup boundary", async () => {
    const index = new WorkspaceIndex({ workspaceRoot: CORPUS_DIR });

    // Index via real path
    const realUri = pathToFileURL(REAL_FILE).href;
    const content = readFileSync(REAL_FILE, "utf-8");
    const tree = parse(content);
    await index.upsertFile(realUri, 1, tree, content, ModificationSource.DidOpen);

    // Lookup via symlink path — should find the real-path entry
    const symlinkUri = pathToFileURL(SYMLINK_PATH).href;
    const entry = index.getFile(symlinkUri);

    expect(entry).not.toBeUndefined();
    expect(entry!.uri).toBe(pathToFileURL(REAL_FILE).href);
  });

  test("getSymbolTable normalizes URI at lookup boundary", async () => {
    const index = new WorkspaceIndex({ workspaceRoot: CORPUS_DIR });

    const realUri = pathToFileURL(REAL_FILE).href;
    const content = readFileSync(REAL_FILE, "utf-8");
    const tree = parse(content);
    await index.upsertFile(realUri, 1, tree, content, ModificationSource.DidOpen);

    // Lookup via symlink path
    const symlinkUri = pathToFileURL(SYMLINK_PATH).href;
    const table = index.getSymbolTable(symlinkUri);

    expect(table).not.toBeNull();
    expect(table!.declarations.length).toBeGreaterThan(0);
  });

  test("removeFile normalizes URI at removal boundary", async () => {
    const index = new WorkspaceIndex({ workspaceRoot: CORPUS_DIR });

    const realUri = pathToFileURL(REAL_FILE).href;
    const content = readFileSync(REAL_FILE, "utf-8");
    const tree = parse(content);
    await index.upsertFile(realUri, 1, tree, content, ModificationSource.DidOpen);
    expect(index.size).toBe(1);

    // Remove via symlink path — should remove the real-path entry
    const symlinkUri = pathToFileURL(SYMLINK_PATH).href;
    index.removeFile(symlinkUri);

    expect(index.size).toBe(0);
    expect(index.getFile(realUri)).toBeUndefined();
  });

  test("invalidate normalizes URI at invalidation boundary", async () => {
    const index = new WorkspaceIndex({ workspaceRoot: CORPUS_DIR });

    const realUri = pathToFileURL(REAL_FILE).href;
    const content = readFileSync(REAL_FILE, "utf-8");
    const tree = parse(content);
    await index.upsertFile(realUri, 1, tree, content, ModificationSource.DidOpen);

    // Invalidate via symlink path
    const symlinkUri = pathToFileURL(SYMLINK_PATH).href;
    index.invalidate(symlinkUri);

    expect(index.isStale(realUri)).toBe(true);
    expect(index.getSymbolTable(realUri)).toBeNull();
  });

  test("upsertBackgroundFile normalizes URI", async () => {
    const index = new WorkspaceIndex({ workspaceRoot: CORPUS_DIR });

    const symlinkUri = pathToFileURL(SYMLINK_PATH).href;
    const content = readFileSync(REAL_FILE, "utf-8");
    const tree = parse(content);
    index.upsertBackgroundFile(symlinkUri, 1, tree, content);

    // Lookup via real path should find the entry
    const realUri = pathToFileURL(REAL_FILE).href;
    const entry = index.getFile(realUri);

    expect(entry).not.toBeUndefined();
    expect(entry!.uri).toBe(realUri);
  });
});
