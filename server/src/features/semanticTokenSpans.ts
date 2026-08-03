/**
 * Keeping a semantic token on an identifier, and each span unique.
 *
 * Split out of semanticTokens.ts to keep both files under the 500-line limit.
 */

import type { SemanticToken } from "./semanticTokens";

/**
 * How many leading characters of `name` form a bare identifier.
 *
 * A semantic token must span an identifier. Two names in the symbol table are
 * not one: a `this_ref` is recorded as `this_object()`, parentheses included,
 * and a dotted inherit path as `RXML.TagSet`. Painting the whole string made
 * the token swallow the call operator and the `.` separator — and because
 * semantic tokens win over TextMate scopes in VSCode, that repaints
 * punctuation as part of a name. Returns 0 when the name does not start with
 * an identifier at all, so the caller can drop the token instead of colouring
 * something arbitrary.
 */
export function identifierPrefixLength(name: string): number {
  const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(name);
  return match ? match[0].length : 0;
}

/**
 * Drop tokens that repeat a span already emitted.
 *
 * The client advertises overlappingTokenSupport=false, and several producers
 * can record the same symbol twice (an enum member reached both as a
 * declaration and as a reference), which put two identical tuples on the wire.
 */
export function dropDuplicateSpans(tokens: SemanticToken[]): SemanticToken[] {
  const seen = new Set<string>();
  const out: SemanticToken[] = [];
  for (const token of tokens) {
    const key = `${token.line}:${token.character}:${token.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(token);
  }
  return out;
}

