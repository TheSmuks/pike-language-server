/**
 * Persistent cache for workspace index across LSP restarts.
 *
 * On shutdown, serializes symbol tables to per-file JSON entries in .pike-lsp/cache/.
 * On startup, reads individual cache entries and validates each by content hash.
 *
 * Design decisions (see ADR 0025):
 * - Per-file cache entries: loading one file does not require parsing the entire
 *   cache. Only the entries for changed files are rebuilt.
 * - Atomic writes: each entry is written to a temp file then renamed, so a crash
 *   during save cannot corrupt an existing valid entry.
 * - Content-hash invalidation: individual entries are invalidated when their
 *   content hash changes. Grammar (WASM) changes invalidate the entire cache.
 * - Forward dependencies are serialized per entry, enabling the M3 reverse-dependency
 *   graph to be reconstructed from cache without async resolution.
 * - No monolithic manifest: the WASM hash and format version live in a small
 *   cacheIndex.json at cache root. This is read first to decide whether to
 *   even scan the cache directory.
 *
 * Cache directory structure:
 *   .pike-lsp/
 *     cacheIndex.json   — { formatVersion, wasmHash, entryCount }
 *     cache/
 *       <contentHash1>.json  — individual file entry (CachedFileEntry)
 *       <contentHash2>.json  — ...
 */

import { mkdir, readFile, writeFile, rm, readdir, rename, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Declaration,
  Reference,
  Scope,
  SymbolTable,
} from "./symbolTable";
import type { WorkspaceIndex } from "./workspaceIndex";
import { createHash } from "node:crypto";
import { startSpan, stopSpan, bump, measureAsync, measureSync } from "./profiler";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Serialized symbol table (without Map fields, which are rebuilt on load). */
interface SerializedSymbolTable {
  uri: string;
  version: number;
  declarations: Declaration[];
  references: Reference[];
  scopes: Scope[];
}

/** A single cached file entry. Stored as <contentHash>.json. */
export interface CachedFileEntry {
  uri: string;
  version: number;
  contentHash: string;
  /** Forward dependency URIs (inherit/import targets), persisted for M3. */
  dependencies: string[];
  symbolTable: SerializedSymbolTable | null;
  /** Last-modified time of the source file when cached (ms epoch). */
  mtimeMs?: number;
  /** Size of the source file in bytes when cached. */
  sizeBytes?: number;
}

/** CacheIndex: small root file with format version and WASM hash.
 *  Read first to decide whether to scan the cache directory. */
interface CacheIndex {
  /** Cache format version — bump when structure changes. */
  formatVersion: number;
  /** Hash of the tree-sitter-pike WASM to invalidate on grammar changes. */
  wasmHash: string;
  /** Number of entries saved. Used for sanity check on load. */
  entryCount: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CACHE_DIR = ".pike-lsp";
const CACHE_SUBDIR = "cache";
const CACHE_INDEX_FILENAME = "cacheIndex.json";
const FORMAT_VERSION = 2; // Per-file entries (was 1: monolithic)
const MAX_ENTRIES = 100_000;
/** Maximum entries to load in one batch. Prevents memory spike on large caches. */
const LOAD_BATCH_SIZE = 50;
/** If cache has more entries than this on load, wipe and rebuild from scratch. */
const MAX_CACHE_ENTRIES_ON_LOAD = 50_000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the cache root path for a workspace.
 */
export function getCachePath(workspaceRoot: string): string {
  return join(workspaceRoot, CACHE_DIR);
}

/**
 * Save workspace index to persistent cache.
 *
 * Writes each file entry as an individual JSON file to .pike-lsp/cache/.
 * Uses atomic write (temp file + rename) to prevent corruption on crash.
 * Writes cacheIndex.json last, after all entries, to mark a complete save.
 *
 * Forward dependency URIs are serialized per entry, enabling the reverse
 * dependency graph to be reconstructed from cache without async resolution.
 *
 * Errors are caught and logged — never throws.
 */
export async function saveCache(
  workspaceRoot: string,
  index: WorkspaceIndex,
  wasmHash: string,
): Promise<void> {
  if (!workspaceRoot) return;

  startSpan("saveCache");
  const cacheDir = join(workspaceRoot, CACHE_DIR, CACHE_SUBDIR);

  try {
    await mkdir(cacheDir, { recursive: true });
  } catch {
    stopSpan("saveCache");
    return;
  }

  // T035: Collect live entries — stale cache files for deleted files are pruned.
  const liveEntries = new Set<string>();
  const entries: CachedFileEntry[] = [];
  for (const fileEntry of index.getAllEntries()) {
    if (!fileEntry.symbolTable) continue;
    liveEntries.add(fileEntry.contentHash);
    entries.push({
      uri: fileEntry.uri,
      version: fileEntry.version,
      contentHash: fileEntry.contentHash,
      dependencies: [...fileEntry.dependencies],
      symbolTable: serializeSymbolTable(fileEntry.symbolTable),
    });
  }

  // T035: Prune stale entries — files no longer in the index get deleted.
  await pruneStaleEntries(cacheDir, liveEntries);

  // T031/T033: Stat source files to populate mtime/size metadata.
  // Old-format entries that lacked these fields are upgraded on this save.
  await populateSourceMetadata(entries);

  // Write all entries in parallel batches, then write the index atomically.
  await writeEntriesBatched(cacheDir, entries);
  await writeCacheIndexAtomically(workspaceRoot, wasmHash, entries.length);
  stopSpan("saveCache");
}

/**
 * Load workspace index from persistent cache.
 *
 * Returns cached entries keyed by URI, or null if cache is missing, corrupt,
 * or invalidated by WASM/format change. Each entry includes forward
 * dependency URIs for reverse-dep graph reconstruction.
 *
 * Corrupt individual entries are skipped (not deleted) — only the full cache
 * root is deleted if the format or WASM hash is wrong.
 */
export async function loadCache(
  workspaceRoot: string,
  currentWasmHash: string,
): Promise<CachedFileEntry[] | null> {
  if (!workspaceRoot) return null;

  startSpan("loadCache");
  const cacheDir = join(workspaceRoot, CACHE_DIR);
  const indexPath = join(cacheDir, CACHE_INDEX_FILENAME);

  if (!existsSync(indexPath)) {
    stopSpan("loadCache");
    return null;
  }

  // Validate index hash/version; delete cache and return null on mismatch.
  const cacheIndex = await readAndValidateCacheIndex(workspaceRoot, indexPath, currentWasmHash);
  if (!cacheIndex) return null;

  // Scan and load all cache entries in bounded batches.
  // Returns null if overflow wipe occurred — caller treats as cache miss.
  const results = await loadCacheEntries(cacheDir, CACHE_SUBDIR);
  stopSpan("loadCache");
  if (results === null || results.length === 0) return null;
  return results;
}

/**
 * Delete the entire cache directory for a workspace.
 */
export async function deleteCache(workspaceRoot: string): Promise<void> {
  const cachePath = join(workspaceRoot, CACHE_DIR);
  try {
    await rm(cachePath, { recursive: true, force: true });
  } catch {
    // Ignore deletion errors.
  }
}

/**
 * Deserialize a cached symbol table back into a SymbolTable with Map fields.
 */
export function deserializeSymbolTable(serialized: SerializedSymbolTable): SymbolTable {
  assertSerializedSymbolTableBounds(serialized);

  const declById = new Map<number, Declaration>();
  for (const decl of serialized.declarations) {
    declById.set(decl.id, decl);
  }

  const scopeById = new Map<number, Scope>();
  for (const scope of serialized.scopes) {
    scopeById.set(scope.id, scope);
  }

  return {
    uri: serialized.uri,
    version: serialized.version,
    declarations: serialized.declarations,
    references: serialized.references,
    scopes: serialized.scopes,
    declById,
    scopeById,
  };
}

/**
 * Compute a hash of the tree-sitter-pike WASM file for cache invalidation.
 */
export function computeWasmHash(wasmPath: string): string {
  return measureSync("cacheWasmHash", () => {
    try {
      const content = readFileSync(wasmPath);
      return createHash("sha256").update(content).digest("hex").slice(0, 16);
    } catch {
      return "unknown";
    }
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function assertSerializedSymbolTableBounds(serialized: SerializedSymbolTable): void {
  if (serialized.declarations.length > MAX_ENTRIES) {
    throw new Error(`Cached symbol table has too many declarations: ${serialized.declarations.length}`);
  }
  if (serialized.scopes.length > MAX_ENTRIES) {
    throw new Error(`Cached symbol table has too many scopes: ${serialized.scopes.length}`);
  }
}

function serializeSymbolTable(table: SymbolTable): SerializedSymbolTable {
  return {
    uri: table.uri,
    version: table.version,
    declarations: table.declarations,
    references: table.references,
    scopes: table.scopes,
  };
}

async function writeEntriesBatched(cacheDir: string, entries: CachedFileEntry[]): Promise<void> {
  const BATCH = 50;
  for (let i = 0; i < entries.length; i += BATCH) {
    await Promise.all(entries.slice(i, i + BATCH).map(e => saveEntry(cacheDir, e)));
    bump("cacheDiskWrites");
  }
}

/**
 * T035: Prune stale cache entries.
 *
 * Deletes cache files that are no longer in the live index (e.g. files
 * deleted from the workspace). Keeps temp files alone (they'll be cleaned
 * by the atomic-write logic). Errors on individual deletes are non-fatal.
 */
async function pruneStaleEntries(cacheDir: string, liveHashes: Set<string>): Promise<void> {
  let existingFiles: string[];
  try {
    existingFiles = await readdir(cacheDir);
  } catch {
    return;
  }

  const staleFiles = existingFiles.filter(file => {
    if (!file.endsWith(".json")) return false;
    if (file.includes(".tmp.")) return false;
    // Extract contentHash from filename: <contentHash>.json
    const hash = file.slice(0, -5); // strip ".json"
    return !liveHashes.has(hash);
  });

  if (staleFiles.length === 0) return;

  await Promise.all(staleFiles.map(async (file) => {
    try {
      await rm(join(cacheDir, file), { force: true });
      bump("cacheEntryPrunes");
    } catch {
      // Non-fatal — stale file will be retried on next save.
    }
  }));
}

/**
 * T031/T033: Stat source files to populate mtime/size metadata.
 *
 * Old-format cache entries that lacked these fields are upgraded on save.
 * On the next load, mtime/size enables fast staleness checks without a
 * full content read. Files not on disk (e.g. open-only, unsaved docs)
 * are left undefined — the entry still saves, it just lacks fast-check data.
 *
 * Stats are batched to avoid opening too many file descriptors at once.
 */
async function populateSourceMetadata(entries: CachedFileEntry[]): Promise<void> {
  for (let i = 0; i < entries.length; i += LOAD_BATCH_SIZE) {
    const batch = entries.slice(i, i + LOAD_BATCH_SIZE);
    await Promise.all(batch.map(async (entry) => {
      const meta = await statSourceFile(entry.uri);
      if (meta) {
        entry.mtimeMs = meta.mtimeMs;
        entry.sizeBytes = meta.sizeBytes;
      }
    }));
  }
}

/** Stat a source file by URI. Returns null if the file is not on disk. */
async function statSourceFile(uri: string): Promise<{ mtimeMs: number; sizeBytes: number } | null> {
  try {
    const filePath = fileURLToPath(uri);
    const stats = await stat(filePath);
    return { mtimeMs: stats.mtimeMs, sizeBytes: stats.size };
  } catch {
    // File may not exist on disk (open-only document, virtual file).
    // Leave metadata undefined — the entry still saves without it.
    return null;
  }
}

async function writeCacheIndexAtomically(workspaceRoot: string, wasmHash: string, entryCount: number): Promise<void> {
  startSpan("serializeCacheIndex");
  const indexData = JSON.stringify({ formatVersion: FORMAT_VERSION, wasmHash, entryCount });
  stopSpan("serializeCacheIndex");
  await writeFileAtomic(join(workspaceRoot, CACHE_DIR, CACHE_INDEX_FILENAME), indexData);
  bump("cacheDiskWrites");
}

async function readAndValidateCacheIndex(
  workspaceRoot: string,
  indexPath: string,
  currentWasmHash: string,
): Promise<CacheIndex | null> {
  startSpan("cacheRead");
  const raw = await readFile(indexPath, "utf-8");
  bump("cacheDiskReads");
  stopSpan("cacheRead");

  startSpan("deserializeCache");
  let cacheIndex: CacheIndex;
  try {
    cacheIndex = JSON.parse(raw);
  } catch {
    stopSpan("deserializeCache");
    await deleteCache(workspaceRoot);
    return null;
  }

  if (cacheIndex.formatVersion !== FORMAT_VERSION || cacheIndex.wasmHash !== currentWasmHash) {
    stopSpan("deserializeCache");
    await deleteCache(workspaceRoot);
    return null;
  }
  stopSpan("deserializeCache");
  return cacheIndex;
}

async function loadCacheEntries(cacheDir: string, subdir: string): Promise<CachedFileEntry[] | null> {
  const cacheSubdir = join(cacheDir, subdir);
  if (!existsSync(cacheSubdir)) return [];

  let cacheFiles: string[];
  try {
    cacheFiles = await readdir(cacheSubdir);
  } catch {
    return [];
  }

  const jsonFiles = cacheFiles.filter(f => f.endsWith(".json") && !f.includes(".tmp."));

  // T032: Overflow protection — if cache is unreasonably large, wipe and rebuild.
  if (jsonFiles.length > MAX_CACHE_ENTRIES_ON_LOAD) {
    bump("cacheEntryPrunes");
    await rm(cacheSubdir, { recursive: true, force: true });
    return null;
  }

  // T032: Bounded-batch loading — process entries in chunks to avoid memory spikes.
  const results: CachedFileEntry[] = [];
  const seenUris = new Set<string>();
  let corruptCount = 0;

  for (let i = 0; i < jsonFiles.length; i += LOAD_BATCH_SIZE) {
    const batch = jsonFiles.slice(i, i + LOAD_BATCH_SIZE);
    await Promise.all(batch.map(async (file) => {
      const entry = await loadSingleEntry(cacheSubdir, file);
      if (!entry) {
        corruptCount++;
        return;
      }

      // T034: Skip duplicates — keep the first entry for each URI.
      if (seenUris.has(entry.uri)) {
        bump("cacheEntryPrunes");
        return;
      }
      seenUris.add(entry.uri);

      // T033: Old-format entries may lack mtimeMs/sizeBytes — leave undefined.
      // The workspace index will stat the source file on first access and
      // populate these fields on the next cache save.
      results.push(entry);
    }));
  }

  if (corruptCount > 0) {
    bump("cacheEntryPrunes");
  }

  bump("cacheEntryLoads");
  return results;
}

/**
 * Load and validate a single cache entry.
 * Returns null for corrupt or invalid entries (self-healing).
 */
async function loadSingleEntry(cacheSubdir: string, file: string): Promise<CachedFileEntry | null> {
  try {
    const entryPath = join(cacheSubdir, file);
    startSpan("cacheRead");
    const entryRaw = await readFile(entryPath, "utf-8");
    bump("cacheDiskReads");
    stopSpan("cacheRead");

    const entry: CachedFileEntry = JSON.parse(entryRaw);

    // T034: Validate required fields — skip corrupt entries.
    if (!entry.uri || typeof entry.uri !== "string") return null;
    if (!entry.contentHash || typeof entry.contentHash !== "string") return null;
    if (!("symbolTable" in entry)) return null;
    if (!Array.isArray(entry.dependencies)) entry.dependencies = [];

    return entry;
  } catch {
    // Skip corrupt entries — they will be rebuilt on next save.
    return null;
  }
}

/**
 * Write a single cache entry atomically: write to temp file, then rename.
 * The rename is atomic on POSIX systems, so a crash mid-write cannot corrupt
 * the existing entry.
 */
async function saveEntry(cacheDir: string, entry: CachedFileEntry): Promise<void> {
  const targetPath = join(cacheDir, `${entry.contentHash}.json`);
  const tempPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
  try {
    await writeFile(tempPath, JSON.stringify(entry), "utf-8");
    await rename(tempPath, targetPath);
  } catch {
    try { await rm(tempPath, { force: true }); } catch { /* ignore */ }
  }
}

/**
 * Atomic write: write content to temp file then rename.
 * Used for the cache index which must not be corruptible.
 */
async function writeFileAtomic(path: string, content: string): Promise<void> {
  const tempPath = `${path}.tmp.${process.pid}.${Date.now()}`;
  try {
    await writeFile(tempPath, content, "utf-8");
    await rename(tempPath, path);
  } catch {
    try { await rm(tempPath, { force: true }); } catch { /* ignore */ }
  }
}
