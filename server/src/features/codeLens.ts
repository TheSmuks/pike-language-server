/**
 * Code lens provider for Pike LSP.
 *
 * Shows reference counts above function and method declarations.
 * Uses the workspace index to count references across all files.
 *
 * Performance: Reference counts are cached by workspace generation.
 * The cache is invalidated automatically when the index changes
 * (any upsertFile / removeFile bumps the generation counter).
 * This makes repeated code lens requests O(1) when nothing changed.
 */

import type { Tree } from "web-tree-sitter";
import type {
  CodeLens,
} from "vscode-languageserver/node";
import type { SymbolTable, Declaration } from "./symbolTable";
import type { WorkspaceIndex } from "./workspaceIndex";

// ---------------------------------------------------------------------------
// Generation-based cache
// ---------------------------------------------------------------------------

/**
 * Cached reference counts for a single URI.
 * Invalidated when the workspace generation changes.
 */
interface CachedRefCounts {
  /** Workspace generation at the time of computation. */
  generation: number;
  /** Map from declaration line → reference count. */
  counts: Map<number, number>;
}

/**
 * Global cache: URI → CachedRefCounts.
 * One entry per open file, invalidated on generation bump.
 */
const refCountCache = new Map<string, CachedRefCounts>();

/**
 * Get or compute reference counts for all declarations in a file.
 * Returns cached results if the workspace generation hasn't changed.
 */
function getOrComputeRefCounts(
  table: SymbolTable,
  uri: string,
  workspaceIndex: WorkspaceIndex,
): Map<number, number> {
  const currentGen = (workspaceIndex as any).generation as number;
  const cached = refCountCache.get(uri);

  // Cache hit: same generation, return cached counts
  if (cached && cached.generation === currentGen) {
    return cached.counts;
  }

  // Cache miss or stale: compute fresh counts
  const counts = new Map<number, number>();

  for (const decl of table.declarations) {
    if (decl.kind !== "function" && decl.kind !== "method") continue;
    const count = countReferences(decl, uri, workspaceIndex);
    counts.set(decl.nameRange.start.line, count);
  }

  refCountCache.set(uri, { generation: currentGen, counts });

  // Evict stale entries for other URIs to bound memory
  if (refCountCache.size > 100) {
    for (const [cachedUri, entry] of refCountCache) {
      if (entry.generation < currentGen) {
        refCountCache.delete(cachedUri);
      }
    }
  }

  return counts;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Produce code lenses for a document — reference count annotations
 * above function and method declarations.
 */
export function produceCodeLenses(
  table: SymbolTable,
  tree: Tree,
  uri: string,
  workspaceIndex: WorkspaceIndex,
): CodeLens[] {
  const lenses: CodeLens[] = [];
  const refCounts = getOrComputeRefCounts(table, uri, workspaceIndex);

  for (const decl of table.declarations) {
    if (decl.kind !== "function" && decl.kind !== "method") continue;

    const refCount = refCounts.get(decl.nameRange.start.line) ?? 0;
    if (refCount === 0) continue;

    lenses.push({
      range: {
        start: {
          line: decl.nameRange.start.line,
          character: decl.nameRange.start.character,
        },
        end: {
          line: decl.nameRange.end.line,
          character: decl.nameRange.end.character,
        },
      },
      command: {
        title: `${refCount} reference${refCount !== 1 ? "s" : ""}`,
        command: "pike.showReferences",
        arguments: [
          uri,
          { line: decl.nameRange.start.line, character: decl.nameRange.start.character },
          [],
        ],
      },
    });
  }

  return lenses;
}

// ---------------------------------------------------------------------------
// Internal: reference counting
// ---------------------------------------------------------------------------

/**
 * Count references to a declaration across the workspace.
 */
function countReferences(
  decl: Declaration,
  uri: string,
  workspaceIndex: WorkspaceIndex,
): number {
  let count = 0;

  const sameFileRefs = workspaceIndex.getCrossFileReferences(
    uri,
    decl.nameRange.start.line,
    decl.nameRange.start.character,
  );

  // Each reference from a different location counts
  // (exclude the declaration itself)
  for (const { ref } of sameFileRefs) {
    if (ref.loc.line !== decl.nameRange.start.line ||
        ref.loc.character !== decl.nameRange.start.character) {
      count++;
    }
  }

  return count;
}
