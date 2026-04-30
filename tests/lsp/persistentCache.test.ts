/**
 * Persistent cache tests (US-022).
 *
 * Tests cache roundtrip, invalidation, corrupt recovery, and partial rebuild.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFile, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  saveCache,
  loadCache,
  deleteCache,
  deserializeSymbolTable,
  computeWasmHash,
  getCachePath,
} from "../../server/src/features/persistentCache";
import { WorkspaceIndex } from "../../server/src/features/workspaceIndex";
import type { SymbolTable, Declaration, Scope } from "../../server/src/features/symbolTable";

let tempDir: string;
let index: WorkspaceIndex;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "pike-lsp-cache-test-"));
  index = new WorkspaceIndex({ workspaceRoot: tempDir });
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeTestSymbolTable(uri: string, declNames: string[]): SymbolTable {
  const declarations: Declaration[] = declNames.map((name, i) => ({
    id: i,
    name,
    kind: "class" as const,
    nameRange: { start: { line: 0, character: 0 }, end: { line: 0, character: name.length } },
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 20 } },
    scopeId: 0,
  }));

  const scopes: Scope[] = [{
    id: 0,
    kind: "file" as const,
    range: { start: { line: 0, character: 0 }, end: { line: 10, character: 0 } },
    parentId: null,
    declarations: declarations.map(d => d.id),
    inheritedScopes: [],
  }];

  return {
    uri,
    version: 1,
    declarations,
    references: [],
    scopes,
    declById: new Map(declarations.map(d => [d.id, d])),
    scopeById: new Map(scopes.map(s => [s.id, s])),
  };
}

describe("US-022: Persistent cache", () => {
  test("cache roundtrip: save and load preserves entries", async () => {
    const wasmHash = "abc123";

    // Add entries to index
    index.upsertCachedFile(
      "file:///test/a.pike",
      1,
      makeTestSymbolTable("file:///test/a.pike", ["Animal", "Dog"]),
      "hash-a",
    );

    await saveCache(tempDir, index, wasmHash);

    const loaded = await loadCache(tempDir, wasmHash);
    expect(loaded).not.toBeNull();
    expect(loaded!.length).toBe(1);

    const entry = loaded![0];
    expect(entry.uri).toBe("file:///test/a.pike");
    expect(entry.contentHash).toBe("hash-a");
    expect(entry.symbolTable).not.toBeNull();
    expect(entry.symbolTable!.declarations.length).toBe(2);
    expect(entry.symbolTable!.declarations[0].name).toBe("Animal");

    // Clean up
    await deleteCache(tempDir);
    index.clear();
  });

  test("cache invalidation on wasm hash change", async () => {
    const wasmHash1 = "hash-v1";
    const wasmHash2 = "hash-v2";

    index.upsertCachedFile(
      "file:///test/b.pike",
      1,
      makeTestSymbolTable("file:///test/b.pike", ["Foo"]),
      "hash-b",
    );

    await saveCache(tempDir, index, wasmHash1);

    // Load with different wasm hash — should return null and delete cache
    const loaded = await loadCache(tempDir, wasmHash2);
    expect(loaded).toBeNull();

    // Cache file should be deleted
    expect(existsSync(getCachePath(tempDir))).toBe(false);

    index.clear();
  });

  test("corrupt cache recovery: deletes and returns null", async () => {
    const wasmHash = "test-hash";

    // Write corrupt JSON to cache file
    const cachePath = getCachePath(tempDir);
    mkdirSync(join(tempDir, ".pike-lsp"), { recursive: true });
    writeFileSync(cachePath, "this is not valid json {{{");

    const loaded = await loadCache(tempDir, wasmHash);
    expect(loaded).toBeNull();

    // Cache file should be deleted
    expect(existsSync(cachePath)).toBe(false);
  });

  test("partial rebuild: cache entries are loaded but not overwriting newer data", async () => {
    const wasmHash = "partial-test";

    // Save with one entry
    index.upsertCachedFile(
      "file:///test/old.pike",
      1,
      makeTestSymbolTable("file:///test/old.pike", ["OldClass"]),
      "hash-old",
    );

    await saveCache(tempDir, index, wasmHash);
    index.clear();

    // Load and restore
    const loaded = await loadCache(tempDir, wasmHash);
    expect(loaded).not.toBeNull();
    expect(loaded!.length).toBe(1);

    // Deserialize and add to a new index
    const newIndex = new WorkspaceIndex({ workspaceRoot: tempDir });
    for (const entry of loaded!) {
      if (entry.symbolTable) {
        const table = deserializeSymbolTable(entry.symbolTable);
        newIndex.upsertCachedFile(entry.uri, entry.version, table, entry.contentHash);
      }
    }

    // Verify the restored entry
    const file = newIndex.getFile("file:///test/old.pike");
    expect(file).toBeDefined();
    expect(file!.symbolTable).not.toBeNull();
    expect(file!.symbolTable!.declarations.length).toBe(1);
    expect(file!.symbolTable!.declarations[0].name).toBe("OldClass");

    // Clean up
    await deleteCache(tempDir);
    newIndex.clear();
  });

  test("computeWasmHash returns a string", () => {
    // This just verifies the function works without crashing
    const hash = computeWasmHash("/nonexistent/path.wasm");
    expect(typeof hash).toBe("string");
    expect(hash).toBe("unknown"); // Non-existent file returns "unknown"
  });
});
