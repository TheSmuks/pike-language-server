/**
 * Lightweight cache manifest for lazy (stub) startup restore.
 *
 * The per-file `<contentHash>.json` entries carry full symbol tables. Restoring
 * all of them at startup is the RAM/latency cost we want to avoid. The manifest
 * is a single small file listing only { uri, version, contentHash, dependencies }
 * for every cached file, so startup can rebuild the dependency graph as *stub*
 * entries (no symbol tables resident) and hydrate a file's table on demand.
 *
 * Constants here mirror persistentCache — they must stay in sync (format bump
 * invalidates both).
 */

import { writeFile, rename } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CachedFileEntry } from "./persistentCache";
import { getCachePath, migrateLegacyCache } from "./cachePaths";

const MANIFEST_FILENAME = "manifest.json";
const CACHE_INDEX_FILENAME = "cacheIndex.json";
const CACHE_SUBDIR = "cache";
const FORMAT_VERSION = 2;

/** A range in a document (line/character, 0-based). */
interface Range {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

/** An outline symbol (file- or class-scope declaration) for the resident index. */
export interface ManifestSymbol {
  name: string;
  kind: string;
  nameRange: Range;
}

/** One lightweight record per cached file. No symbol table. */
export interface CacheManifestEntry {
  uri: string;
  version: number;
  contentHash: string;
  dependencies: string[];
  /** Outline symbols, for the resident workspace-symbol index. */
  symbols?: ManifestSymbol[];
}

/** Declarations that never belong in workspace symbol search. */
const OUTLINE_SKIP = new Set(["parameter", "import", "include"]);

/**
 * Extract outline symbols (file-scope and class-scope declarations) from a
 * serialized symbol table. Function-local variables are excluded — they are
 * not useful in workspace search and would bloat the manifest.
 */
export function manifestSymbolsFrom(
  declarations: Array<{ name: string; kind: string; nameRange: Range; scopeId: number }>,
  scopes: Array<{ id: number; kind: string }>,
): ManifestSymbol[] {
  const outlineScopes = new Set(
    scopes.filter(s => s.kind === "file" || s.kind === "class").map(s => s.id),
  );
  const out: ManifestSymbol[] = [];
  for (const d of declarations) {
    if (!d.name || OUTLINE_SKIP.has(d.kind)) continue;
    if (!outlineScopes.has(d.scopeId)) continue;
    out.push({ name: d.name, kind: d.kind, nameRange: d.nameRange });
  }
  return out;
}

/**
 * Write the manifest atomically (temp file + rename) alongside the cache index.
 */
export async function writeManifest(cacheRoot: string, entries: CacheManifestEntry[]): Promise<void> {
  const path = join(cacheRoot, MANIFEST_FILENAME);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify({ version: FORMAT_VERSION, entries }), "utf-8");
  await rename(tmp, path);
}

/**
 * Load the manifest for a workspace, validating the cache index (wasm/format).
 *
 * Migrates a legacy in-workspace cache first (same as loadCache). Returns null
 * when there is no cache, the index is invalid/mismatched, or no manifest was
 * written (old caches predate the manifest) — the caller then falls back to the
 * eager path.
 */
export async function loadManifest(
  workspaceRoot: string,
  currentWasmHash: string,
): Promise<CacheManifestEntry[] | null> {
  if (!workspaceRoot) return null;
  const cacheRoot = getCachePath(workspaceRoot);
  await migrateLegacyCache(workspaceRoot, cacheRoot);

  const indexPath = join(cacheRoot, CACHE_INDEX_FILENAME);
  if (!existsSync(indexPath)) return null;
  try {
    const idx = JSON.parse(readFileSync(indexPath, "utf-8"));
    if (idx.formatVersion !== FORMAT_VERSION || idx.wasmHash !== currentWasmHash) return null;
  } catch {
    return null;
  }

  const manifestPath = join(cacheRoot, MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf-8"));
    if (!parsed || !Array.isArray(parsed.entries)) return null;
    return parsed.entries as CacheManifestEntry[];
  } catch {
    return null;
  }
}

/** Minimal index surface needed to restore stubs (avoids a WorkspaceIndex import). */
interface StubRestorable {
  restoreStub(uri: string, version: number, contentHash: string, dependencies: string[]): void;
}

/**
 * Restore every manifest entry as a stub. Returns the count restored.
 * Stubs carry dependency edges but no symbol table — hydrated on demand.
 */
export function restoreStubs(index: StubRestorable, manifest: CacheManifestEntry[]): number {
  for (const entry of manifest) {
    index.restoreStub(entry.uri, entry.version, entry.contentHash, entry.dependencies);
  }
  return manifest.length;
}

/**
 * Read a single cached entry's raw record by content hash (no deserialization).
 * Used to hydrate a stub's symbol table on demand. Returns null if absent/corrupt.
 */
export async function readRawCacheEntry(
  workspaceRoot: string,
  contentHash: string,
): Promise<CachedFileEntry | null> {
  const path = join(getCachePath(workspaceRoot), CACHE_SUBDIR, `${contentHash}.json`);
  if (!existsSync(path)) return null;
  try {
    const { readFile } = await import("node:fs/promises");
    return JSON.parse(await readFile(path, "utf-8")) as CachedFileEntry;
  } catch {
    return null;
  }
}
