/**
 * Internal helpers for WorkspaceIndex.
 *
 * Extracted from workspaceIndex.ts to keep file sizes manageable.
 * These methods are tightly coupled to WorkspaceIndex and are not intended
 * for external consumption.
 */

import type { Tree } from "web-tree-sitter";
import type { PikeVersionDirective } from "./workspaceTypes";
import { hashContent } from "./cacheHash";
import { uriToPath as uriToPathUtil, normalizeUri } from "../util/uri";
import type { FileEntry } from "./workspaceTypes";

// ---------------------------------------------------------------------------
// URI normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a URI for use as an index key.
 *
 * Resolves symlinks via realpath so that the same file always maps to the
 * same key, regardless of how the URI was obtained (VSCode didOpen,
 * ModuleResolver resolution, background indexing, file watcher).
 *
 * This prevents the "two entries for one file" bug where:
 * - ModuleResolver resolves `import CoreModule` -> `/opt/pike/modules/Core.pmod`
 *   (the path reported by Pike, which may contain symlinks)
 * - VSCode opens the same file -> `/opt/pike-8.0.1116/modules/Core.pmod`
 *   (the real path, after resolving symlinks)
 * Without normalization these produce two different URIs, two index entries,
 * and cross-file references between them break silently.
 */
export function normUri(uri: string): string {
  return normalizeUri(uri);
}

// ---------------------------------------------------------------------------
// Sync resolution adapter for symbol table building
// ---------------------------------------------------------------------------

/**
 * Interface required by buildSymbolTable for cross-file resolution during parsing.
 * Provided by WorkspaceIndex via createSyncIndexAdapter.
 */
export interface SyncIndexAdapter {
  getSymbolTable(uri: string): import("./symbolTable").SymbolTable | null;
  resolveImport(mod: string, from: string): string | null;
  resolveInherit(path: string, isString: boolean, from: string): string | null;
}

/**
 * Create a sync index adapter for use during symbol table building.
 *
 * The adapter bridges WorkspaceIndex's async resolution API and the synchronous
 * symbol table builder. When the resolver cache is warm (post-warmResolverCache),
 * sync methods return correct results; when cold (background indexing), they
 * return null and cross-file resolution happens at query time instead.
 */
export function createSyncIndexAdapter(
  self: {
    getSymbolTable(uri: string): import("./symbolTable").SymbolTable | null;
    resolveImportSync(importPath: string, fromUri: string): string | null;
    resolveInheritSync(pathText: string, isStringLiteral: boolean, fromUri: string): string | null;
  },
  _fromUri: string,
): SyncIndexAdapter {
  return {
    getSymbolTable(uri: string) { return self.getSymbolTable(uri); },
    resolveImport(mod: string, from: string) { return self.resolveImportSync(mod, from); },
    resolveInherit(path: string, isString: boolean, from: string) { return self.resolveInheritSync(path, isString, from); },
  };
}

// ---------------------------------------------------------------------------
// Dependency graph helpers
// ---------------------------------------------------------------------------

/**
 * Register forward dependencies as reverse (dependents) edges.
 * Called whenever new forward deps are computed so cross-file queries
 * can efficiently find all files that depend on a given file.
 */
export function registerReverseDeps(
  dependents: Map<string, Set<string>>,
  uri: string,
  dependencies: Set<string>,
  normFn: (uri: string) => string,
): void {
  for (const depUri of dependencies) {
    const normalizedDepUri = normFn(depUri);
    let depSet = dependents.get(normalizedDepUri);
    if (!depSet) { depSet = new Set(); dependents.set(normalizedDepUri, depSet); }
    depSet.add(uri);
  }
}

/**
 * Remove a file's entries from the reverse-dependency graph.
 * Called before replacing or removing a file entry to keep the graph consistent.
 */
export function removeDependencies(
  dependents: Map<string, Set<string>>,
  entry: FileEntry,
  normFn: (uri: string) => string,
): void {
  for (const depUri of entry.dependencies) {
    const normalizedDepUri = normFn(depUri);
    const depSet = dependents.get(normalizedDepUri);
    if (depSet) {
      depSet.delete(entry.uri);
      if (depSet.size === 0) dependents.delete(normalizedDepUri);
    }
  }
}

// ---------------------------------------------------------------------------
// Pike version parsing
// ---------------------------------------------------------------------------

/**
 * Parse #pike version directive from file content.
 * Format: #pike <major>[.<minor>]
 *
 * Special case: `#pike __REAL_VERSION__` resolves to the Pike home version.
 */
export function parsePikeVersion(
  tree: Tree,
  content: string,
  pikeHome: string,
): PikeVersionDirective | null {
  const root = tree.rootNode;
  if (!root) return null;

  if (content.match(/#pike\s+__REAL_VERSION__/)) {
    const homeVersion = pikeHome.match(/(\d+)\.(\d+)/);
    if (homeVersion) {
      return { major: parseInt(homeVersion[1], 10), minor: parseInt(homeVersion[2], 10) };
    }
  }

  const match = content.match(/#pike\s+(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  return { major: parseInt(match[1], 10), minor: match[2] ? parseInt(match[2], 10) : 0 };
}

// ---------------------------------------------------------------------------
// Content hashing
// ---------------------------------------------------------------------------

/** Content hash for cache validity -- delegates to shared DJB2. */
export function hashContentFile(content: string): string {
  return hashContent(content);
}

// ---------------------------------------------------------------------------
// URI conversion (delegated)
// ---------------------------------------------------------------------------

/** Convert a file URI to a filesystem path. */
export function uriToPath(uri: string): string {
  return uriToPathUtil(uri);
}