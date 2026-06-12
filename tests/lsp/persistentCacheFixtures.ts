/**
 * Cache fixture helpers for persistent cache tests.
 *
 * Generates controlled cache states for testing cache migration, self-healing,
 * and pruning:
 * - Old-format entries (missing fields added in schema v2)
 * - Corrupt entries (truncated/malformed JSON)
 * - Duplicate entries (same URI, different content hashes)
 * - Superseded entries (old content hash for a file that changed)
 * - Bloated cache (many entries for pressure testing)
 *
 * All fixtures write directly to disk, bypassing the normal save path, so tests
 * can verify that loadCache handles them correctly.
 */

import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CachedFileEntry } from "../../server/src/features/persistentCache";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CacheFixtureDir {
  /** Absolute path to the workspace root (parent of .pike-lsp/). */
  root: string;
  /** Absolute path to .pike-lsp/. */
  cacheDir: string;
  /** Absolute path to .pike-lsp/cache/. */
  entriesDir: string;
  /** Remove the temp directory. */
  cleanup(): void;
}

// ---------------------------------------------------------------------------
// Directory management
// ---------------------------------------------------------------------------

/**
 * Create a temp workspace with a .pike-lsp/cache/ directory structure.
 */
export function createCacheFixtureDir(): CacheFixtureDir {
  const root = mkdtempSync(join(tmpdir(), "pike-lsp-cache-fixture-"));
  const cacheDir = join(root, ".pike-lsp");
  const entriesDir = join(cacheDir, "cache");
  mkdirSync(entriesDir, { recursive: true });

  return {
    root,
    cacheDir,
    entriesDir,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Entry builders
// ---------------------------------------------------------------------------

/**
 * Build a valid CachedFileEntry for a given URI and content hash.
 */
export function buildValidEntry(
  uri: string,
  contentHash: string,
  declNames: string[] = ["Class1", "func1"],
): CachedFileEntry {
  const declarations = declNames.map((name, i) => ({
    id: i,
    name,
    kind: "class" as const,
    nameRange: { start: { line: 0, character: 0 }, end: { line: 0, character: name.length } },
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 20 } },
    scopeId: 0,
  }));

  return {
    uri,
    version: 1,
    contentHash,
    dependencies: [],
    symbolTable: {
      uri,
      version: 1,
      declarations,
      references: [],
      scopes: [{
        id: 0,
        kind: "file" as const,
        range: { start: { line: 0, character: 0 }, end: { line: 10, character: 0 } },
        parentId: null,
        declarations: declarations.map(d => d.id),
        inheritedScopes: [],
      }],
    },
  };
}

/**
 * Build an old-format entry missing the `dependencies` field (schema v1).
 */
export function buildOldFormatEntry(uri: string, contentHash: string): Record<string, unknown> {
  const entry = buildValidEntry(uri, contentHash);
  const old: Record<string, unknown> = { ...entry };
  delete old.dependencies;
  return old;
}

// ---------------------------------------------------------------------------
// Cache index writer
// ---------------------------------------------------------------------------

/**
 * Write a cacheIndex.json with given wasm hash and entry count.
 */
export function writeCacheIndex(
  dir: CacheFixtureDir,
  wasmHash: string,
  entryCount: number,
  formatVersion = 2,
): void {
  const indexData = JSON.stringify({ formatVersion, wasmHash, entryCount });
  writeFileSync(join(dir.cacheDir, "cacheIndex.json"), indexData, "utf-8");
}

/**
 * Write a single cache entry to the entries directory.
 */
export function writeCacheEntry(
  dir: CacheFixtureDir,
  contentHash: string,
  data: unknown,
): void {
  const entryPath = join(dir.entriesDir, `${contentHash}.json`);
  writeFileSync(entryPath, typeof data === "string" ? data : JSON.stringify(data), "utf-8");
}

// ---------------------------------------------------------------------------
// Fixture scenarios
// ---------------------------------------------------------------------------

/**
 * Populate a cache with:
 * - Valid entries
 * - Old-format entries (missing dependencies)
 * - Corrupt entries (malformed JSON)
 * - Duplicate entries (same URI, different hash)
 */
export function populateMixedCache(dir: CacheFixtureDir, wasmHash: string): {
  validCount: number;
  oldFormatCount: number;
  corruptCount: number;
  duplicateCount: number;
} {
  let valid = 0;
  let oldFmt = 0;
  let corrupt = 0;
  let dup = 0;

  // 3 valid entries
  for (let i = 0; i < 3; i++) {
    writeCacheEntry(dir, `validhash${i}`, buildValidEntry(`file:///valid${i}.pike`, `validhash${i}`));
    valid++;
  }

  // 2 old-format entries (no dependencies field)
  for (let i = 0; i < 2; i++) {
    writeCacheEntry(dir, `oldfonthash${i}`, buildOldFormatEntry(`file:///oldfmt${i}.pike`, `oldfonthash${i}`));
    oldFmt++;
  }

  // 2 corrupt entries
  writeCacheEntry(dir, "corrupthash0", "this is not valid json {{{");
  writeCacheEntry(dir, "corrupthash1", "{ broken");
  corrupt += 2;

  // 2 duplicate entries (same URI, different content hash)
  writeCacheEntry(dir, `duphashA`, buildValidEntry(`file:///dup.pike`, `duphashA`));
  writeCacheEntry(dir, `duphashB`, buildValidEntry(`file:///dup.pike`, `duphashB`));
  dup += 2;

  writeCacheIndex(dir, wasmHash, valid + oldFmt + corrupt + dup);
  return { validCount: valid, oldFormatCount: oldFmt, corruptCount: corrupt, duplicateCount: dup };
}

/**
 * Populate a bloated cache with N entries for memory/startup pressure testing.
 */
export function populateBloatedCache(
  dir: CacheFixtureDir,
  wasmHash: string,
  entryCount: number,
): void {
  for (let i = 0; i < entryCount; i++) {
    const hash = `bloathash${i.toString().padStart(8, "0")}`;
    writeCacheEntry(dir, hash, buildValidEntry(`file:///bloated/file${i}.pike`, hash, [`Decl${i}`]));
  }
  writeCacheIndex(dir, wasmHash, entryCount);
}

/**
 * Count the number of .json entry files in the cache entries directory.
 */
export function countCacheFiles(dir: CacheFixtureDir): number {
  if (!existsSync(dir.entriesDir)) return 0;
  return readdirSync(dir.entriesDir).filter(f => f.endsWith(".json")).length;
}
