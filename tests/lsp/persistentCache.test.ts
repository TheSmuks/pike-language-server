/**
 * Persistent cache tests (US-022).
 *
 * Tests cache roundtrip, invalidation, corrupt recovery, and partial rebuild.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
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
  FORMAT_VERSION,
} from "../../server/src/features/persistentCache";
import { WorkspaceIndex } from "../../server/src/features/workspaceIndex";
import type { SymbolTable, Declaration, Scope } from "../../server/src/features/symbolTable";

let tempDir: string;
let index: WorkspaceIndex;
let origCacheHome: string | undefined;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "pike-lsp-cache-test-"));
  // Isolate the global cache under tempDir so tests never touch the real
  // user cache and everything is cleaned up with tempDir.
  origCacheHome = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = tempDir;
  index = new WorkspaceIndex({ workspaceRoot: tempDir });
});

afterAll(() => {
  if (origCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = origCacheHome;
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
    await index.upsertCachedFile(
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

    await index.upsertCachedFile(
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

  // Guards the upgrade path this bump exists for: a cache saved by an older
  // build (e.g. one that byte-converted positions, or decoded source as raw
  // UTF-8 regardless of #charset) must never be reused just because the wasm
  // hash still matches — its formatVersion is what gates that.
  test("cache invalidation on format version change (stale cache, same wasm hash)", async () => {
    const wasmHash = "format-version-hash";
    const cacheDir = join(getCachePath(tempDir), "cache");
    mkdirSync(cacheDir, { recursive: true });

    writeFileSync(join(cacheDir, "fmt-hash.json"), JSON.stringify({
      uri: "file:///test/fmt.pike",
      version: 1,
      contentHash: "fmt-hash",
      dependencies: [],
      symbolTable: makeTestSymbolTable("file:///test/fmt.pike", ["Fmt"]),
    }));

    // Same wasm hash as what we'll load with, but an older format version
    // than the running code understands.
    writeFileSync(
      join(getCachePath(tempDir), "cacheIndex.json"),
      JSON.stringify({ formatVersion: 1, wasmHash, entryCount: 1 }),
    );

    const loaded = await loadCache(tempDir, wasmHash);
    expect(loaded).toBeNull();

    // Stale cache should be wiped, not left around to be misread later.
    expect(existsSync(getCachePath(tempDir))).toBe(false);
  });

  test("corrupt cache recovery: deletes and returns null", async () => {
    const wasmHash = "test-hash";

    // Write corrupt JSON to the cache index file inside .pike-lsp/.
    // The per-file format reads cacheIndex.json first — corrupt JSON there
    // triggers a full cache wipe.
    const cacheDir = getCachePath(tempDir);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "cacheIndex.json"), "this is not valid json {{{");

    const loaded = await loadCache(tempDir, wasmHash);
    expect(loaded).toBeNull();

    // Cache directory should be deleted
    expect(existsSync(cacheDir)).toBe(false);
  });

  test("partial rebuild: cache entries are loaded but not overwriting newer data", async () => {
    const wasmHash = "partial-test";

    // Save with one entry
    await index.upsertCachedFile(
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
        await newIndex.upsertCachedFile(entry.uri, entry.version, table, entry.contentHash);
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

// ---------------------------------------------------------------------------
// Phase 3 (US1) — cache migration, self-healing, prune, staleness
// ---------------------------------------------------------------------------

describe("US1: Cache migration and self-healing (Phase 3)", () => {
  let migrationDir: string;
  let migrationIndex: WorkspaceIndex;

  beforeEach(() => {
    migrationDir = mkdtempSync(join(tmpdir(), "pike-lsp-cache-migration-"));
    migrationIndex = new WorkspaceIndex({ workspaceRoot: migrationDir });
  });

  afterEach(() => {
    rmSync(migrationDir, { recursive: true, force: true });
  });

  // T024: Old-format entries (no mtimeMs/sizeBytes) are loaded successfully.
  test("T024: loads old-format entries lacking mtimeMs/sizeBytes", async () => {
    const wasmHash = "migration-hash";
    const cacheDir = join(getCachePath(migrationDir), "cache");
    mkdirSync(cacheDir, { recursive: true });

    // Write an old-format entry (no mtimeMs/sizeBytes fields).
    const oldEntry = {
      uri: "file:///test/legacy.pike",
      version: 1,
      contentHash: "legacy-hash",
      dependencies: [],
      symbolTable: {
        uri: "file:///test/legacy.pike",
        version: 1,
        declarations: [],
        references: [],
        scopes: [],
      },
    };
    writeFileSync(join(cacheDir, "legacy-hash.json"), JSON.stringify(oldEntry));

    // Write the cacheIndex.json to match.
    writeFileSync(
      join(getCachePath(migrationDir), "cacheIndex.json"),
      JSON.stringify({ formatVersion: FORMAT_VERSION, wasmHash, entryCount: 1 }),
    );

    const loaded = await loadCache(migrationDir, wasmHash);
    expect(loaded).not.toBeNull();
    expect(loaded!.length).toBe(1);
    expect(loaded![0].uri).toBe("file:///test/legacy.pike");
    // Old entries lack mtimeMs — that's fine, they're optional.
    expect(loaded![0].mtimeMs).toBeUndefined();
  });

  // T024: Corrupt entries (invalid JSON) are skipped, not fatal.
  test("T024: corrupt entries are skipped, valid ones are loaded", async () => {
    const wasmHash = "corrupt-test-hash";
    const cacheDir = join(getCachePath(migrationDir), "cache");
    mkdirSync(cacheDir, { recursive: true });

    // Write one valid entry.
    const validEntry = {
      uri: "file:///test/valid.pike",
      version: 1,
      contentHash: "valid-hash",
      dependencies: [],
      symbolTable: {
        uri: "file:///test/valid.pike",
        version: 1,
        declarations: [],
        references: [],
        scopes: [],
      },
    };
    writeFileSync(join(cacheDir, "valid-hash.json"), JSON.stringify(validEntry));

    // Write one corrupt entry.
    writeFileSync(join(cacheDir, "corrupt-hash.json"), "{{invalid json");

    writeFileSync(
      join(getCachePath(migrationDir), "cacheIndex.json"),
      JSON.stringify({ formatVersion: FORMAT_VERSION, wasmHash, entryCount: 2 }),
    );

    const loaded = await loadCache(migrationDir, wasmHash);
    expect(loaded).not.toBeNull();
    expect(loaded!.length).toBe(1);
    expect(loaded![0].uri).toBe("file:///test/valid.pike");
  });

  // T024: Duplicate URIs — first entry wins, second is skipped.
  test("T024: duplicate URIs are deduplicated", async () => {
    const wasmHash = "dup-test-hash";
    const cacheDir = join(getCachePath(migrationDir), "cache");
    mkdirSync(cacheDir, { recursive: true });

    const makeEntry = (hash: string) => ({
      uri: "file:///test/dup.pike",
      version: 1,
      contentHash: hash,
      dependencies: [],
      symbolTable: {
        uri: "file:///test/dup.pike",
        version: 1,
        declarations: [],
        references: [],
        scopes: [],
      },
    });

    writeFileSync(join(cacheDir, "dup-a.json"), JSON.stringify(makeEntry("dup-a")));
    writeFileSync(join(cacheDir, "dup-b.json"), JSON.stringify(makeEntry("dup-b")));

    writeFileSync(
      join(getCachePath(migrationDir), "cacheIndex.json"),
      JSON.stringify({ formatVersion: FORMAT_VERSION, wasmHash, entryCount: 2 }),
    );

    const loaded = await loadCache(migrationDir, wasmHash);
    expect(loaded).not.toBeNull();
    expect(loaded!.length).toBe(1);
  });

  // T025: Cache file count equals live entry count after save.
  test("T025: stale entries are pruned on save", async () => {
    const wasmHash = "prune-test-hash";
    const cacheDir = join(getCachePath(migrationDir), "cache");
    mkdirSync(cacheDir, { recursive: true });

    // Pre-populate with a stale entry.
    writeFileSync(join(cacheDir, "stale-hash.json"), JSON.stringify({
      uri: "file:///test/deleted.pike",
      version: 1,
      contentHash: "stale-hash",
      dependencies: [],
      symbolTable: null,
    }));

    // Save with only a live entry — stale should be pruned.
    await migrationIndex.upsertCachedFile(
      "file:///test/live.pike",
      1,
      makeTestSymbolTable("file:///test/live.pike", ["Live"]),
      "live-hash",
    );
    await saveCache(migrationDir, migrationIndex, wasmHash);

    // Stale entry should be gone, only live entry should remain.
    expect(existsSync(join(cacheDir, "stale-hash.json"))).toBe(false);
    expect(existsSync(join(cacheDir, "live-hash.json"))).toBe(true);

    // Verify loaded entries match live count.
    const loaded = await loadCache(migrationDir, wasmHash);
    expect(loaded).not.toBeNull();
    expect(loaded!.length).toBe(1);
    expect(loaded![0].uri).toBe("file:///test/live.pike");

    await deleteCache(migrationDir);
  });

  // T026: Metadata staleness — loading a cache with unchanged WASM hash
  // does not read source file contents.
  test("T026: cache load reads only cache files, not source contents", async () => {
    const wasmHash = "staleness-hash";

    await migrationIndex.upsertCachedFile(
      "file:///test/cached.pike",
      1,
      makeTestSymbolTable("file:///test/cached.pike", ["Cached"]),
      "cached-hash",
    );
    await saveCache(migrationDir, migrationIndex, wasmHash);
    migrationIndex.clear();

    // Load — should return entries purely from cache files.
    const loaded = await loadCache(migrationDir, wasmHash);
    expect(loaded).not.toBeNull();
    expect(loaded!.length).toBe(1);
    expect(loaded![0].symbolTable).not.toBeNull();
    expect(loaded![0].symbolTable!.declarations[0].name).toBe("Cached");

    await deleteCache(migrationDir);
  });

  // Legacy in-workspace .pike-lsp/ is migrated to the global cache on load.
  test("migrates a legacy in-workspace .pike-lsp/ cache to the global cache", async () => {
    const wasmHash = "legacy-migration-hash";

    // Write a valid cache in the OLD in-workspace location.
    const legacyCache = join(migrationDir, ".pike-lsp", "cache");
    mkdirSync(legacyCache, { recursive: true });
    writeFileSync(join(legacyCache, "leg-hash.json"), JSON.stringify({
      uri: "file:///test/legacy.pike",
      version: 1,
      contentHash: "leg-hash",
      dependencies: [],
      symbolTable: makeTestSymbolTable("file:///test/legacy.pike", ["Legacy"]),
    }));
    writeFileSync(
      join(migrationDir, ".pike-lsp", "cacheIndex.json"),
      JSON.stringify({ formatVersion: FORMAT_VERSION, wasmHash, entryCount: 1 }),
    );

    const loaded = await loadCache(migrationDir, wasmHash);
    expect(loaded).not.toBeNull();
    expect(loaded!.length).toBe(1);
    expect(loaded![0].uri).toBe("file:///test/legacy.pike");

    // Legacy dir is gone; global cache now holds the entries.
    expect(existsSync(join(migrationDir, ".pike-lsp"))).toBe(false);
    expect(existsSync(getCachePath(migrationDir))).toBe(true);

    await deleteCache(migrationDir);
  });
});
