// Tree-sitter parser with incremental parsing and LRU tree cache.
//
// Decision 0018: trees are retained per-document and passed as the old tree
// to `parser.parse(newText, oldTree)` so tree-sitter can reuse unchanged
// subtrees.  A size-bounded LRU cache evicts trees when documents close or
// the memory ceiling is hit.
//
// The old tree MUST be edited via `tree.edit()` before re-parsing so that
// tree-sitter's ReusableNode mechanism has correct position information.
// Without this, tree-sitter may incorrectly reuse stale subtrees, producing
// wrong parse results after edits (missing new declarations, broken
// highlighting, stale completions).

import { Parser, Tree, Language, Edit, type Point } from 'web-tree-sitter';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { LRUCache } from './util/lruCache';
import { startSpan, stopSpan, bump, measureSync, measureAsync } from './features/profiler';

// ---------------------------------------------------------------------------
// Parser singleton
// ---------------------------------------------------------------------------

let parserInstance: Parser | null = null;
let language: Language | null = null;
let initPromise: Promise<void> | null = null;
let parserReady = false;

/**
 * Initialize the tree-sitter parser.  Safe to call multiple times — subsequent
 * calls return the same promise and do not re-initialize.
 *
 * If initialization fails (e.g., WASM file transiently unavailable on NFS),
 * the cached promise is cleared so the next call retries. Without this, a
 * one-time I/O error makes the parser permanently unusable for the entire
 * server lifetime.
 */
export function initParser(wasmPath?: string): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = doInit(wasmPath);
  // Allow retry on failure — transient I/O errors should not be permanent.
  initPromise.catch(() => { initPromise = null; });
  return initPromise;
}

async function doInit(wasmPath?: string): Promise<void> {
  await measureAsync("parserInit", async () => {
    await Parser.init();
    const parser = new Parser();

    // Try WASM in multiple locations:
    // 1. Explicit path provided by caller
    // 2. Same directory as this module (standalone bundle)
    // 3. One level up (tsc output: dist/server/src/ -> dist/server/)
    // 4. Sibling to server/ directory (extension bundle: server/dist/ -> server/)
    // Resolve __dirname equivalent that works in both CJS (tsc) and ESM (esbuild)
    const thisDir = typeof __dirname !== 'undefined'
      ? __dirname
      : dirname(fileURLToPath(import.meta.url));
    const candidates = wasmPath ? [wasmPath] : [
      resolve(thisDir, 'tree-sitter-pike.wasm'),
      resolve(thisDir, '..', 'tree-sitter-pike.wasm'),
      resolve(thisDir, '..', '..', 'tree-sitter-pike.wasm'),
    ];
    let loaded = false;
    for (const candidate of candidates) {
      try {
        language = await Language.load(candidate);
        loaded = true;
        break;
      } catch {
        // Try next location
      }
    }
    if (!loaded) {
      throw new Error(`tree-sitter-pike.wasm not found. Searched: ${candidates.join(', ')}`);
    }
    parser.setLanguage(language);
    // Only assign parserInstance after language is fully loaded so parse() callers
    // always see a fully-initialized parser.
    parserInstance = parser;
    parserReady = true;
  });
}

// ---------------------------------------------------------------------------
// Tree cache — LRUCache with memory ceiling
// ---------------------------------------------------------------------------

interface TreeEntry {
  tree: Tree;
  source: string;
}

function estimateTreeBytes(entry: TreeEntry): number {
  // Conservative: 1 node per ~40 bytes of source, each node ~200 bytes.
  return Math.max(entry.source.length, entry.tree.rootNode.descendantCount * 200);
}

const treeCache = new LRUCache<TreeEntry>({
  maxEntries: 50,
  maxBytes: 50 * 1024 * 1024,
  estimateSize: estimateTreeBytes,
  onEvict(_key, entry) { entry.tree.delete(); },
});

// ---------------------------------------------------------------------------
// Edit computation
// ---------------------------------------------------------------------------

/**
 * Compute a tree-sitter Edit by finding the common prefix and suffix between
 * old and new source text.  O(N) where N is the length of the shorter string.
 *
 * Returns null when old and new are identical (no edit needed).
 */
function computeEdit(oldSource: string, newSource: string): Edit | null {
  if (oldSource === newSource) return null;

  // Find common prefix length (in UTF-16 code units = JS string indices).
  const minLen = Math.min(oldSource.length, newSource.length);
  let prefixLen = 0;
  while (prefixLen < minLen && oldSource[prefixLen] === newSource[prefixLen]) {
    prefixLen++;
  }

  // Find common suffix length, stopping before the common prefix.
  const maxSuffix = Math.min(oldSource.length, newSource.length) - prefixLen;
  let suffixLen = 0;
  while (
    suffixLen < maxSuffix &&
    oldSource[oldSource.length - 1 - suffixLen] === newSource[newSource.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  const startIndex = prefixLen;
  const oldEndIndex = oldSource.length - suffixLen;
  const newEndIndex = newSource.length - suffixLen;

  // Compute line/column for the three points from old and new source.
  const oldStartPos = offsetToPoint(oldSource, startIndex);
  const oldEndPos = offsetToPoint(oldSource, oldEndIndex);
  const newEndPos = offsetToPoint(newSource, newEndIndex);

  return new Edit({
    startIndex,
    oldEndIndex,
    newEndIndex,
    startPosition: oldStartPos,
    oldEndPosition: oldEndPos,
    newEndPosition: newEndPos,
  });
}

/**
 * Convert a byte offset in a string to a tree-sitter Point (row, column).
 * O(N) but only called once per edit boundary.
 */
function offsetToPoint(source: string, offset: number): Point {
  let row = 0;
  let column = 0;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') {
      row++;
      column = 0;
    } else {
      column++;
    }
  }
  return { row, column };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns true after the parser has been initialized and is ready to parse.
 * Use this to check readiness without awaiting the init promise.
 */
export function isParserReady(): boolean {
  return parserReady;
}

/**
 * Parse source text, using the cached tree for the given URI if available.
 *
 * The old tree is edited via `tree.edit()` with a computed diff before being
 * passed to tree-sitter for incremental re-parse.  This is required by the
 * tree-sitter incremental algorithm (see "Advanced Parsing" docs).
 *
 * After parsing, the new tree is stored in the cache keyed by `uri`.
 */
export function parse(source: string, uri?: string): Tree {
  bump("parseCalls");
  return measureSync("parse", () => {
    if (!parserInstance) throw new Error('Parser not initialized — call initParser() first');

    let oldTree: Tree | undefined;
    if (uri) {
      const cached = treeCache.get(uri);
      if (cached) {
        // Edit the old tree so tree-sitter's ReusableNode has correct positions.
        const edit = computeEdit(cached.source, source);
        if (edit) {
          cached.tree.edit(edit);
        }
        oldTree = cached.tree;
      }
    }

    const tree = parserInstance.parse(source, oldTree ?? null);
    if (!tree) throw new Error('Parse returned null — is a language set?');

    if (uri) {
      treeCache.set(uri, { tree, source });
    }

    return tree;
  });
}

/**
 * Remove a cached tree.  Called on didClose to free memory immediately.
 */
export function deleteTree(uri: string): void {
  treeCache.delete(uri);
}

/**
 * Get the cached tree for a URI without re-parsing, or null.
 */
export function getCachedTree(uri: string): Tree | null {
  const entry = treeCache.get(uri);
  return entry?.tree ?? null;
}

/**
 * Clear all cached trees.  Called on shutdown.
 */
export function clearTreeCache(): void {
  treeCache.clear();
}

/**
 * Return cache statistics for memory monitoring.
 */
export function getTreeCacheStats(): { size: number; bytes: number } {
  return { size: treeCache.size, bytes: treeCache.bytes };
}

/**
 * Evict the oldest `count` entries from the tree cache.
 * Returns the number of entries actually evicted.
 */
export function evictTreeCacheOldest(count: number): number {
  let evicted = 0;
  for (const [key] of treeCache.entries()) {
    if (evicted >= count) break;
    treeCache.delete(key);
    evicted++;
  }
  return evicted;
}

export function getLanguage(): Language {
  if (!language) throw new Error('Language not loaded — call initParser() first');
  return language;
}

export type { Tree } from 'web-tree-sitter';
export { parserInstance };