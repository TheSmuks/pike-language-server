/**
 * Derive sweep positions for a document.
 *
 * Positions must not come from a feature under audit. If documentSymbol is
 * broken and we take positions from it, every other capability is swept at
 * zero positions and the run reports a clean bill of health. So the sweep
 * passes in whatever documentSymbol produced, and this module falls back to a
 * lexical identifier scan when that comes back empty.
 *
 * All columns are UTF-16 code units, which is what LSP and tree-sitter both
 * use. JavaScript string indices are already in that space — no conversion.
 */

export interface SweepPosition {
  line: number;
  character: number;
  symbol: string;
  kind: "declaration" | "reference";
}

/** Reserved words that are never useful sweep targets. */
const KEYWORDS = new Set([
  "array", "break", "case", "catch", "class", "constant", "continue", "default",
  "do", "else", "enum", "extern", "final", "float", "for", "foreach", "function",
  "gauge", "global", "if", "import", "inherit", "inline", "int", "lambda",
  "local", "mapping", "mixed", "multiset", "object", "optional", "predef",
  "private", "program", "protected", "public", "return", "sscanf", "static",
  "string", "switch", "typedef", "typeof", "variant", "void", "while", "zero",
]);

const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/g;

/** Every identifier in source order, keywords removed, duplicates kept. */
export function lexicalIdentifiers(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(IDENTIFIER)) {
    if (!KEYWORDS.has(match[0])) found.push(match[0]);
  }
  return found;
}

/** Convert a string offset to a line/character pair in UTF-16 code units. */
function toPosition(text: string, offset: number): { line: number; character: number } {
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, character: offset - lineStart };
}

/**
 * Positions for the given symbols: the first occurrence of each is treated as
 * its declaration, and up to `maxRefsPerDecl` later occurrences as references.
 *
 * When `symbolNames` is empty, every distinct lexical identifier is used
 * instead, so a file still gets swept when documentSymbol returns nothing.
 */
export function derivePositions(
  text: string,
  symbolNames: string[],
  maxRefsPerDecl = 5,
): SweepPosition[] {
  const names = symbolNames.length > 0 ? symbolNames : [...new Set(lexicalIdentifiers(text))];
  const positions: SweepPosition[] = [];

  for (const name of names) {
    const pattern = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(name)}(?![A-Za-z0-9_])`, "g");
    let seen = 0;
    for (const match of text.matchAll(pattern)) {
      if (seen > maxRefsPerDecl) break;
      const { line, character } = toPosition(text, match.index);
      positions.push({ line, character, symbol: name, kind: seen === 0 ? "declaration" : "reference" });
      seen++;
    }
  }
  return positions;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
