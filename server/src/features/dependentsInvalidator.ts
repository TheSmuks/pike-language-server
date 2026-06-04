/**
 * Dependency-graph invalidation helper for WorkspaceIndex.
 *
 * `wireInheritance()` is deliberately synchronous. When a dependent is built
 * before its target is indexed, it skips the missing target and stores a
 * complete-but-unwired table. Re-indexing the target must therefore invalidate
 * every dependent, not only dependents whose table is already null.
 *
 * Extracted from workspaceIndexClass to keep the class under the
 * 500-line project convention.
 */

export interface RewireTarget {
  /** Return true if the file is in the index. */
  hasFile(uri: string): boolean;
  /** Invalidate a file and its dependents, returning the URIs invalidated. */
  invalidateWithDependents(uri: string): string[];
  getDependents(uri: string): Iterable<string>;
}

/**
 * Invalidate dependents of a newly-indexed file so inheritance/import wiring
 * runs again with the target table available.
 *
 * Returns the URIs that were invalidated.
 */
export function rewireDependents(deps: RewireTarget, uri: string): string[] {
  const reWired: string[] = [];

  for (const depUri of deps.getDependents(uri)) {
    if (!deps.hasFile(depUri)) continue;
    deps.invalidateWithDependents(depUri);
    reWired.push(depUri);
  }

  return reWired;
}
