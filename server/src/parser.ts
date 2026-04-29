/**
 * Tree-sitter parser with incremental parsing and LRU tree cache.
 *
 * Decision 0018: trees are retained per-document and passed as the old tree
 * to `parser.parse(newText, oldTree)` so tree-sitter can reuse unchanged
 * subtrees.  A size-bounded LRU cache evicts trees when documents close or
 * the memory ceiling is hit.
 */

import { Parser, Tree, Language } from 'web-tree-sitter';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// Parser singleton
// ---------------------------------------------------------------------------

let parserInstance: Parser | null = null;
let language: Language | null = null;

export async function initParser(wasmPath?: string): Promise<void> {
  if (parserInstance) return;
  await Parser.init();
  parserInstance = new Parser();
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
  parserInstance.setLanguage(language);
}

// ---------------------------------------------------------------------------
// Tree cache — LRU with memory ceiling
// ---------------------------------------------------------------------------

/** Max number of cached trees.  Shared-server deployment: keep bounded. */
const TREE_CACHE_MAX_ENTRIES = 50;

/** Approximate byte ceiling for cached trees.  50 MB. */
const TREE_CACHE_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Rough byte estimate for a tree.  Tree-sitter doesn't expose an exact
 * size, but the node count is a reasonable proxy (each node ≈ 200 bytes
 * internally).  We use the source length as a lower bound and multiply.
 */
function estimateTreeBytes(tree: Tree, sourceLength: number): number {
  // Conservative: 1 node per ~40 bytes of source, each node ~200 bytes.
  return Math.max(sourceLength, tree.rootNode.descendantCount * 200);
}

interface CacheEntry {
  tree: Tree;
  /** Approximate byte size of the cached tree. */
  bytes: number;
  /** Monotonic counter for LRU ordering. */
  accessSeq: number;
}

const treeCache = new Map<string, CacheEntry>();
let cacheSeq = 0;
let cacheBytes = 0;

function evictOne(): void {
  let oldestKey: string | null = null;
  let oldestSeq = Infinity;
  for (const [key, entry] of treeCache) {
    if (entry.accessSeq < oldestSeq) {
      oldestSeq = entry.accessSeq;
      oldestKey = key;
    }
  }
  if (oldestKey) {
    const removed = treeCache.get(oldestKey)!;
    removed.tree.delete();
    cacheBytes -= removed.bytes;
    treeCache.delete(oldestKey);
  }
}

/** Store a tree in the cache, evicting if necessary. */
function cacheTree(uri: string, tree: Tree, sourceLength: number): void {
  // Remove old entry if present
  const old = treeCache.get(uri);
  if (old) {
    old.tree.delete();
    cacheBytes -= old.bytes;
  }

  const bytes = estimateTreeBytes(tree, sourceLength);

  // Evict until we have room (entry count ceiling)
  while (treeCache.size >= TREE_CACHE_MAX_ENTRIES && treeCache.size > 0) {
    evictOne();
  }
  // Evict until we have room (byte ceiling)
  while (cacheBytes + bytes > TREE_CACHE_MAX_BYTES && treeCache.size > 0) {
    evictOne();
  }

  cacheSeq++;
  treeCache.set(uri, { tree, bytes, accessSeq: cacheSeq });
  cacheBytes += bytes;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse source text, using the cached tree for the given URI if available.
 *
 * After parsing, the new tree is stored in the cache keyed by `uri`.
 * Callers that need the tree for later operations (symbol table, diagnostics)
 * should use this function — not `parseFresh`.
 */
export function parse(source: string, uri?: string): Tree {
  if (!parserInstance) throw new Error('Parser not initialized — call initParser() first');

  let oldTree: Tree | undefined;
  if (uri) {
    const cached = treeCache.get(uri);
    if (cached) {
      oldTree = cached.tree;
    }
  }

  const tree = parserInstance.parse(source, oldTree ?? null);
  if (!tree) throw new Error('Parse returned null — is a language set?');

  if (uri) {
    cacheTree(uri, tree, source.length);
  }

  return tree;
}

/**
 * Remove a cached tree.  Called on didClose to free memory immediately.
 */
export function deleteTree(uri: string): void {
  const entry = treeCache.get(uri);
  if (entry) {
    entry.tree.delete();
    cacheBytes -= entry.bytes;
    treeCache.delete(uri);
  }
}

/**
 * Get the cached tree for a URI without re-parsing, or null.
 */
export function getCachedTree(uri: string): Tree | null {
  const entry = treeCache.get(uri);
  if (entry) {
    cacheSeq++;
    entry.accessSeq = cacheSeq;
    return entry.tree;
  }
  return null;
}

/**
 * Clear all cached trees.  Called on shutdown.
 */
export function clearTreeCache(): void {
  for (const entry of treeCache.values()) {
    entry.tree.delete();
  }
  treeCache.clear();
  cacheBytes = 0;
}

export function getLanguage(): Language {
  if (!language) throw new Error('Language not loaded — call initParser() first');
  return language;
}
