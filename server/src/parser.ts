// Tree-sitter parser with incremental parsing and LRU tree cache.
//
// Decision 0018: trees are retained per-document and passed as the old tree
// to `parser.parse(newText, oldTree)` so tree-sitter can reuse unchanged
// subtrees.  A size-bounded LRU cache evicts trees when documents close or
// the memory ceiling is hit.

import { Parser, Tree, Language } from 'web-tree-sitter';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { LRUCache } from './util/lruCache';

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
// Tree cache — LRUCache with memory ceiling
// ---------------------------------------------------------------------------

interface TreeEntry {
  tree: Tree;
  sourceLength: number;
}

function estimateTreeBytes(entry: TreeEntry): number {
  // Conservative: 1 node per ~40 bytes of source, each node ~200 bytes.
  return Math.max(entry.sourceLength, entry.tree.rootNode.descendantCount * 200);
}

const treeCache = new LRUCache<TreeEntry>({
  maxEntries: 50,
  maxBytes: 50 * 1024 * 1024,
  estimateSize: estimateTreeBytes,
  onEvict(_key, entry) { entry.tree.delete(); },
});

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
    treeCache.set(uri, { tree, sourceLength: source.length });
  }

  return tree;
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

export function getLanguage(): Language {
  if (!language) throw new Error('Language not loaded — call initParser() first');
  return language;
}
export type { Tree } from 'web-tree-sitter';
