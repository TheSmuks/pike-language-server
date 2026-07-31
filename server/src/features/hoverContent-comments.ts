/**
 * The `//!` autodoc comment tier of hover (tier 2b).
 *
 * Split out of hoverContent.ts to keep it under the 500-line TigerStyle limit,
 * the same reason hoverContent-file.ts exists. One concern: find the autodoc
 * block above a declaration and render it.
 */

import { renderAutodocLines } from "./autodocLineRenderer";
import type { HoverInfo } from "./hoverContent";

/** Scan backwards from declLine, collecting //! autodoc lines. */
function collectAutodocLines(lines: string[], declLine: number): string[] {
  const autodocLines: string[] = [];
  let scanLine = declLine - 1;
  while (scanLine >= 0) {
    const lineText = (lines[scanLine] ?? "").trimEnd();
    if (lineText.endsWith("*/")) {
      // Skip over block comments by scanning back to the opening /*.
      // Default to bailing out in case /* is never found (malformed input)
      // to avoid an infinite loop when scanLine is not decremented.
      const commentEnd = scanLine;
      scanLine = -1;
      for (let bl = commentEnd; bl >= 0; bl--) {
        if ((lines[bl] ?? "").includes("/*")) {
          scanLine = bl - 1;
          break;
        }
      }
      continue;
    }
    const match = lineText.match(/^\/\/!\s?(.*)/);
    if (match) {
      autodocLines.unshift(match[1]);
      scanLine--;
    } else if (lineText === "" || lineText.startsWith("//")) {
      scanLine--;
    } else {
      break;
    }
  }
  return autodocLines;
}

/** Group autodoc lines into paragraphs on blank separators. */
function autodocParagraphs(autodocLines: string[]): string[] {
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of autodocLines) {
    if (line.length === 0) {
      if (current.length > 0) {
        paragraphs.push(current.join(" "));
        current = [];
      }
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) paragraphs.push(current.join(" "));
  return paragraphs;
}

/** Tier 2b: //! autodoc comments above the declaration. */
export function hoverFromComments(
  decl: { name: string; nameRange: { start: { line: number; character: number } } },
  signature: string,
  lines: string[],
): HoverInfo | null {
  const declLine = decl.nameRange.start.line;
  if (declLine <= 0) return null;

  const autodocLines = collectAutodocLines(lines, declLine);
  if (autodocLines.length === 0) return null;

  const paragraphs = autodocParagraphs(autodocLines);
  if (paragraphs.length === 0) return null;

  const rendered = renderAutodocLines(autodocLines);
  // isAutodoc stays false: it means "documentation already embeds the
  // signature", which is true of Tier 1's XML render but not here —
  // renderAutodocLines emits comment prose only (it strips @decl). Marking
  // these autodoc made formatHover drop the signature block, so a `//!`-
  // documented symbol lost its signature whenever the XML cache was cold or
  // the extractor was unavailable.
  // Constructed here rather than imported: hoverContent.ts imports this
  // module, so reaching back for its makeHoverInfo would close a cycle.
  return {
    name: decl.name,
    signature,
    documentation: rendered || paragraphs.join("\n\n"),
    line: decl.nameRange.start.line,
    character: decl.nameRange.start.character,
  };
}

// ---------------------------------------------------------------------------
// Public: declForHover
// ---------------------------------------------------------------------------

