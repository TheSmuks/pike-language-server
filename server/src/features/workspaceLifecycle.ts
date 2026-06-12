/**
 * Lifecycle, demotion, and dependency-graph mutation helpers for WorkspaceIndex.
 *
 * Extracted from workspaceIndexClass.ts to keep that file under the 500-line
 * TigerStyle limit. These functions operate on the index's internal maps, which
 * the class passes in — mirroring the registerReverseDeps / removeDependencies
 * pattern in workspaceIndexImpl.ts. The class retains all private state; these
 * helpers never close over it, so they stay independently testable.
 */

import type { FileEntry } from "./workspaceTypes";
import type { DependencyContext } from "./workspaceDependencies";
import { extractDependencies } from "./workspaceDependencies";
import { registerReverseDeps } from "./workspaceIndexImpl";

// ---------------------------------------------------------------------------
// Invalidation
// ---------------------------------------------------------------------------

/**
 * Invalidate a file and transitively invalidate all its dependents.
 *
 * Stale-marking with lazy rebuild avoids rebuilding entire subtrees on every
 * keystroke: only the origin file drops its symbol table; dependents are
 * flagged stale so they rebuild lazily when next queried.
 *
 * `sourceUri` must already be normalized (the caller normalizes once).
 */
export function invalidateWithDependentsImpl(
  files: Map<string, FileEntry>,
  dependents: Map<string, Set<string>>,
  sourceUri: string,
): string[] {
  const invalidated: string[] = [];
  const visited = new Set<string>();
  const queue = [sourceUri];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    if (visited.has(current)) continue;
    visited.add(current);

    const entry = files.get(current);
    if (!entry) continue;

    // The origin file drops its symbol table; dependents only stale-mark.
    if (current === sourceUri) entry.symbolTable = null;
    entry.stale = true;
    invalidated.push(current);

    const deps = dependents.get(current);
    if (deps) {
      for (const depUri of deps) {
        if (!visited.has(depUri)) queue.push(depUri);
      }
    }
  }
  return invalidated;
}

// ---------------------------------------------------------------------------
// Demotion (memory pressure)
// ---------------------------------------------------------------------------

/**
 * Demote non-essential "full" entries under memory pressure.
 *
 * `essential` is the pre-normalized set of URIs (open files + their dependency
 * closure) whose symbol tables must be retained. All other "full" entries have
 * their symbol tables dropped but keep identity and dependency edges for
 * rehydration. Stops after `maxToDemote` so a single pressure event cannot
 * drop the entire index.
 *
 * Returns the demoted URIs in iteration order.
 */
export function demoteNonEssentialEntriesImpl(
  files: Map<string, FileEntry>,
  essential: Set<string>,
  maxToDemote: number,
): string[] {
  const demoted: string[] = [];
  for (const [uri, entry] of files) {
    if (demoted.length >= maxToDemote) break;
    if (essential.has(uri)) continue;
    if (entry.lifecycle !== "full") continue;

    // Demote: drop symbol table, keep identity + dependency edges.
    entry.symbolTable = null;
    entry.lifecycle = "demoted";
    demoted.push(uri);
  }
  return demoted;
}

/**
 * Invoke the on-demand indexer, swallowing and logging failures.
 *
 * Returns the indexed entry or null. Shared by getOrIndexSymbolTable (and
 * rehydrateEntry) so on-demand failures are logged consistently rather than
 * propagated — the caller treats a failed index as "still unavailable".
 */
export async function indexOnDemand(
  onDemandIndex: (uri: string) => Promise<FileEntry | null>,
  uri: string,
  logTag: string,
): Promise<FileEntry | null> {
  try {
    return await onDemandIndex(uri);
  } catch (err) {
    console.debug(`[${logTag}] on-demand indexing failed for ${uri}:`, err);
    return null;
  }
}

/**
 * Rehydrate a demoted entry by re-indexing it via the on-demand indexer.
 *
 * Returns true if the symbol table was restored, false if the entry is absent,
 * not in the "demoted" state, or no on-demand indexer is registered. Never
 * reports success without a restored symbol table.
 */
export async function rehydrateEntryImpl(
  files: Map<string, FileEntry>,
  uri: string,
  onDemandIndex: ((uri: string) => Promise<FileEntry | null>) | null,
): Promise<boolean> {
  const entry = files.get(uri);
  if (!entry) return false;
  if (entry.lifecycle !== "demoted") return false;
  if (!onDemandIndex) return false;

  try {
    const indexed = await onDemandIndex(uri);
    if (indexed?.symbolTable) return true;
  } catch {
    // Re-indexing failed — entry stays demoted. Do not present false success.
  }
  return false;
}

// ---------------------------------------------------------------------------
// Dependency restoration / lazy resolution
// ---------------------------------------------------------------------------

/**
 * Restore forward dependencies for a cache-restored file.
 *
 * Reconstructs the reverse-dependency graph from serialized forward deps
 * without async resolution. `uri` and `normFn` must already be the index's
 * normalizer. Only restores when the entry has no deps yet (just cached).
 */
export function restoreDependenciesImpl(
  files: Map<string, FileEntry>,
  dependents: Map<string, Set<string>>,
  uri: string,
  dependencies: Set<string>,
  normFn: (uri: string) => string,
): void {
  const entry = files.get(uri);
  if (!entry) return;
  if (entry.dependencies.size > 0) return;

  // Normalize dependency URIs too -- they were serialized from a previous
  // session where the filesystem layout may have changed (symlinks added/removed).
  const normalizedDeps = new Set<string>();
  for (const depUri of dependencies) {
    normalizedDeps.add(normFn(depUri));
  }

  entry.dependencies = normalizedDeps;
  entry.depsResolved = true;
  registerReverseDeps(dependents, uri, normalizedDeps, normFn);
}

/**
 * Ensure a file's dependency links are populated (lazy upgrade for
 * background-indexed / cache-restored entries).
 *
 * Returns true if dependencies were resolved this call, false if the file is
 * absent, has no symbol table, or was already resolved. `uri` must be normalized.
 */
export async function ensureDependenciesResolvedImpl(
  files: Map<string, FileEntry>,
  dependents: Map<string, Set<string>>,
  uri: string,
  depCtx: DependencyContext,
  normFn: (uri: string) => string,
): Promise<boolean> {
  const entry = files.get(uri);
  if (!entry) return false;
  if (!entry.symbolTable) return false;

  // Already resolved -- distinguish "resolved and found deps" from
  // "resolved and found nothing" via the depsResolved sentinel flag.
  if (entry.depsResolved) return false;

  // Resolve dependencies for this entry.
  const deps = await extractDependencies(depCtx, entry.symbolTable, uri, new Map());

  // Mark as resolved even if no deps found -- avoids re-running resolution
  // for files that genuinely have no imports/inherits.
  entry.depsResolved = true;

  if (deps.size > 0) {
    entry.dependencies = deps;
    registerReverseDeps(dependents, uri, deps, normFn);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Dependency map snapshot
// ---------------------------------------------------------------------------

/**
 * Build the forward-edges view of the dependency graph from live file entries.
 * Reverse edges and the generation counter are owned by the class.
 */
export function buildDependencyForwardEdges(
  files: Map<string, FileEntry>,
): Map<string, Set<string>> {
  const forwardEdges = new Map<string, Set<string>>();
  for (const entry of files.values()) {
    if (entry.dependencies.size > 0) {
      forwardEdges.set(entry.uri, entry.dependencies);
    }
  }
  return forwardEdges;
}
