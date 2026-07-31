/**
 * Semantic-token delta cache.
 *
 * The client sends `textDocument/semanticTokens/full/delta` with the resultId
 * of the tokens it currently holds, and we return only the integer-array edits
 * needed to turn those into the current ones. Split out of
 * navigationDocumentFeatures.ts, which was at the file-size limit.
 */

import { LRUCache } from "../util/lruCache";

// ---------------------------------------------------------------------------
// Semantic tokens delta cache
//
// The client sends `textDocument/semanticTokens/full/delta` with the resultId
// of the tokens it currently holds; we return only the integer-array edits
// needed to transform that into the current tokens. This avoids re-sending the
// entire token array on every keystroke. We cache the last emitted full token
// array per document, keyed by resultId, in a bounded LRU so a burst of open
// files can't grow it without limit.
// ---------------------------------------------------------------------------

export interface CachedSemanticTokens {
  resultId: string;
  data: number[];
}

export const semanticTokensCache = new LRUCache<CachedSemanticTokens>({
  maxEntries: 64,
  // 4 bytes per int; cap the whole cache near 32 MB of token data.
  maxBytes: 32 * 1024 * 1024,
  estimateSize: (v) => v.data.length * 4 + v.resultId.length,
});

let semanticTokensResultCounter = 0;

export function nextSemanticTokensResultId(): string {
  semanticTokensResultCounter += 1;
  return String(semanticTokensResultCounter);
}

/**
 * Diff two flat semantic-token integer arrays into the minimal single edit the
 * LSP `SemanticTokensDelta` shape expects, by trimming the common prefix and
 * suffix. Returns an empty edit list when the arrays are identical.
 */
export function diffSemanticTokens(
  oldData: number[],
  newData: number[],
): Array<{ start: number; deleteCount: number; data: number[] }> {
  const oldLen = oldData.length;
  const newLen = newData.length;

  let prefix = 0;
  const maxPrefix = Math.min(oldLen, newLen);
  while (prefix < maxPrefix && oldData[prefix] === newData[prefix]) prefix++;

  let suffix = 0;
  const maxSuffix = Math.min(oldLen, newLen) - prefix;
  while (
    suffix < maxSuffix &&
    oldData[oldLen - 1 - suffix] === newData[newLen - 1 - suffix]
  ) {
    suffix++;
  }

  if (prefix === oldLen && prefix === newLen) return [];

  return [{
    start: prefix,
    deleteCount: oldLen - prefix - suffix,
    data: newData.slice(prefix, newLen - suffix),
  }];
}
