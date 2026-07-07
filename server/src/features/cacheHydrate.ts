/**
 * On-demand hydration of a stub entry's symbol table from the on-disk cache.
 *
 * A stub carries dependency edges but no symbol table. When a stub is needed
 * (an open file's dependency closure, or an on-demand cross-file query), we can
 * restore its table from the per-file cache JSON far cheaper than re-parsing and
 * re-resolving from source — but only when the source is unchanged. The caller
 * passes the already-read file content so we hash once and avoid a second read.
 */

import type { SymbolTable } from "./symbolTable";
import { readRawCacheEntry } from "./cacheManifest";
import { deserializeSymbolTable } from "./persistentCache";
import { hashContent } from "./cacheHash";

/** Minimal index surface needed to hydrate (avoids a WorkspaceIndex import). */
interface HydratableIndex {
  getFile(uri: string): { symbolTable: SymbolTable | null; contentHash: string; lifecycle?: string } | undefined;
  hydrateStub(uri: string, table: SymbolTable): boolean;
}

/**
 * Hydrate a stub/demoted entry from cache when `content` still matches the
 * cached content hash. Returns true only on a successful, non-stale hydration;
 * false means the caller should index from source instead (absent, already
 * full, stale, or cache miss).
 */
export async function hydrateFromCache(
  index: HydratableIndex,
  workspaceRoot: string,
  uri: string,
  content: string,
): Promise<boolean> {
  const entry = index.getFile(uri);
  if (!entry || entry.symbolTable) return false;
  if (entry.lifecycle !== "stub" && entry.lifecycle !== "demoted") return false;
  if (hashContent(content) !== entry.contentHash) return false;

  const raw = await readRawCacheEntry(workspaceRoot, entry.contentHash);
  if (!raw?.symbolTable) return false;
  return index.hydrateStub(uri, deserializeSymbolTable(raw.symbolTable));
}
