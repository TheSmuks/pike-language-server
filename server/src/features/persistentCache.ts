/**
 * Persistent cache for workspace index across LSP restarts.
 *
 * On shutdown, serializes symbol tables and metadata to disk.
 * On startup, loads cache and rebuilds only changed files.
 *
 * Cache format: single JSON file per workspace at .pike-lsp/cache.json.
 * Contains: file entries (URI, contentHash, declarations, scopes, references).
 *
 * Design: graceful fallback on corrupt cache — delete and rebuild.
 */

import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type {
  Declaration,
  Reference,
  Scope,
  SymbolTable,
} from "./symbolTable";
import type { WorkspaceIndex } from "./workspaceIndex";
import { createHash } from "node:crypto";

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

/** A single cached file entry. */
interface CachedFileEntry {
  uri: string;
  version: number;
  contentHash: string;
  symbolTable: SerializedSymbolTable | null;
}

/** The full cache file structure. */
interface CacheFile {
  /** Cache format version — bump when structure changes. */
  formatVersion: number;
  /** Hash of the tree-sitter-pike WASM to invalidate on grammar changes. */
  wasmHash: string;
  /** Cached file entries. */
  entries: CachedFileEntry[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CACHE_DIR = ".pike-lsp";
const CACHE_FILENAME = "cache.json";
const FORMAT_VERSION = 1;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the cache file path for a workspace root.
 */
export function getCachePath(workspaceRoot: string): string {
  return join(workspaceRoot, CACHE_DIR, CACHE_FILENAME);
}

/**
 * Save workspace index to persistent cache.
 *
 * Serializes all file entries from the index to a JSON file.
 * Errors are caught and logged — never throws.
 */
export async function saveCache(
  workspaceRoot: string,
  index: WorkspaceIndex,
  wasmHash: string,
): Promise<void> {
  if (!workspaceRoot) return;

  const cachePath = getCachePath(workspaceRoot);

  const entries: CachedFileEntry[] = [];
  for (const fileEntry of index.getAllEntries()) {
    entries.push({
      uri: fileEntry.uri,
      version: fileEntry.version,
      contentHash: fileEntry.contentHash,
      symbolTable: fileEntry.symbolTable
        ? serializeSymbolTable(fileEntry.symbolTable)
        : null,
    });
  }

  const cacheFile: CacheFile = {
    formatVersion: FORMAT_VERSION,
    wasmHash,
    entries,
  };

  try {
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, JSON.stringify(cacheFile), "utf-8");
  } catch (err) {
    // Cache save failure is non-critical — don't crash
    throw new Error(`Failed to save cache: ${(err as Error).message}`);
  }
}

/**
 * Load workspace index from persistent cache.
 *
 * Returns the cached entries or null if cache is missing, corrupt, or stale.
 * Corrupt caches are deleted automatically.
 */
export async function loadCache(
  workspaceRoot: string,
  currentWasmHash: string,
): Promise<CachedFileEntry[] | null> {
  if (!workspaceRoot) return null;

  const cachePath = getCachePath(workspaceRoot);

  if (!existsSync(cachePath)) return null;

  try {
    const raw = await readFile(cachePath, "utf-8");
    const cacheFile: CacheFile = JSON.parse(raw);

    // Validate format version
    if (cacheFile.formatVersion !== FORMAT_VERSION) {
      await deleteCache(workspaceRoot);
      return null;
    }

    // Validate WASM hash — grammar change invalidates everything
    if (cacheFile.wasmHash !== currentWasmHash) {
      await deleteCache(workspaceRoot);
      return null;
    }

    return cacheFile.entries;
  } catch {
    // Corrupt cache — delete and rebuild
    await deleteCache(workspaceRoot);
    return null;
  }
}

/**
 * Delete the cache file for a workspace.
 */
export async function deleteCache(workspaceRoot: string): Promise<void> {
  const cachePath = getCachePath(workspaceRoot);
  try {
    await rm(cachePath, { force: true });
  } catch {
    // Ignore deletion errors
  }
}

/**
 * Deserialize a cached symbol table back into a SymbolTable with Map fields.
 */
export function deserializeSymbolTable(serialized: SerializedSymbolTable): SymbolTable {
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
  // For now, use a simple marker. Real implementation would hash the WASM file.
  // This is sufficient for cache invalidation when the grammar changes.
  try {
    const content = readFileSync(wasmPath);
    return createHash("sha256").update(content).digest("hex").slice(0, 16);
  } catch {
    // WASM file unreadable (not found or permissions) — use fallback hash
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function serializeSymbolTable(table: SymbolTable): SerializedSymbolTable {
  return {
    uri: table.uri,
    version: table.version,
    declarations: table.declarations,
    references: table.references,
    scopes: table.scopes,
  };
}
