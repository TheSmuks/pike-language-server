/**
 * The range a hover response reports.
 *
 * Split out of hoverHandler.ts to keep both files under the 500-line limit.
 */

import type { Hover } from "vscode-languageserver/node";

/**
 * The identifier token at a position, as a range in THIS document.
 *
 * LSP defines Hover.range as a range in the document that was hovered, used to
 * visualise the hover. Every tier below derives it from whatever it happened to
 * resolve, and none of those is that: `resolveHoverForDecl` uses the
 * DECLARATION's position, so hovering a use highlighted a different line; the
 * stdlib tiers use a declaration in another FILE, producing line 950 of a
 * 103-line document; and the builtin/module-path/scope tiers use the raw cursor
 * column, so hovering the middle of `write` returned `ite("` — the tail of the
 * word plus the next two tokens.
 *
 * Returning null drops the range, which is legal and honest, rather than
 * emitting one that points at the wrong text.
 */
export function hoveredIdentifierRange(
  text: string,
  position: { line: number; character: number },
): { start: { line: number; character: number }; end: { line: number; character: number } } | null {
  const line = text.split("\n")[position.line];
  if (line === undefined) return null;

  const isWord = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_]/.test(c);

  // A cursor resting just past the last character still hovers that word.
  let start = position.character;
  if (!isWord(line[start]) && isWord(line[start - 1])) start--;
  if (!isWord(line[start])) return null;

  let end = start;
  // Bounded: `start` only decreases, and isWord(undefined) is false at index -1.
  while (isWord(line[start - 1])) start--;
  // Bounded: `end` only increases, and isWord(undefined) is false past the end.
  while (isWord(line[end])) end++;
  return {
    start: { line: position.line, character: start },
    end: { line: position.line, character: end },
  };
}

/** Replace a hover's range with the identifier actually under the cursor. */
export function pinHoverRange(
  hover: Hover | null,
  text: string,
  position: { line: number; character: number },
): Hover | null {
  if (!hover) return null;
  const range = hoveredIdentifierRange(text, position);
  if (!range) {
    const { range: _dropped, ...rest } = hover;
    return rest;
  }
  return { ...hover, range };
}

