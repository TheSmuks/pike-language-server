import type { WorkspaceIndex } from "./workspaceIndex";

/**
 * Indexing a file rewires its dependents, which drops their symbol tables so
 * the wiring can be rebuilt against the symbols now available; the rebuild is
 * deferred and coalesced so that typing stays cheap. For the length of that
 * window an index entry exists but holds nothing.
 *
 * Readers that resolve one URI through the on-demand indexer — hover,
 * go-to-definition, completion — never see the window, because that path
 * rebuilds what it is asked for. Readers that sweep every entry cannot: they
 * skip what is empty, so the file simply does not participate. For a file the
 * user has open that is not a delay, it is a wrong answer — its references are
 * missing from a rename, its class is missing from a hierarchy — and no cached
 * snapshot can stand in, because a snapshot holds what is on disk and never the
 * unsaved buffer.
 *
 * Restoring the emptied entries before such a sweep is bounded by how many were
 * invalidated, and each one is a file the on-demand indexer would have rebuilt
 * the moment it was asked for it.
 */
export async function restoreEmptyLiveEntries(index: WorkspaceIndex): Promise<void> {
  const emptied: string[] = [];
  for (const entry of index.getAllEntries()) {
    if (!entry.symbolTable && entry.stale) emptied.push(entry.uri);
  }
  for (const uri of emptied) {
    try {
      await index.getOrIndexSymbolTable(uri);
    } catch {
      // A file that cannot be re-indexed stays out of the results, which is
      // what it would have done anyway.
    }
  }
}
