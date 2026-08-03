/**
 * Refine a definition location reported by the Pike runtime.
 *
 * `PikeWorker.resolve()` answers with a source file and a source *line*, and
 * nothing else. Two things go wrong if that is used verbatim:
 *
 *  - There is no column, so every answer landed at column 0 of the line —
 *    beside the symbol rather than on it.
 *  - The line Pike records for a multi-line declaration is frequently the `{`
 *    that opens the body, not the header. `string translate(...)` in
 *    Locale.pmod is reported two lines below where it is written, and for some
 *    symbols the reported line is an interior brace with no relation to the
 *    name at all.
 *
 * This module turns the runtime's approximate line into an exact position when
 * the name is genuinely there, and refuses to answer when it is not. Refusing
 * matters: the caller then offers the top of the file, which is honest about
 * not knowing the spot, instead of pointing confidently at a brace.
 */

import { readSource } from "../util/sourceDecoder";

/**
 * How far from the reported line to look.
 *
 * Deliberately small. Pike's line is off by the height of a declaration
 * header, not by an arbitrary amount, and a wide search would "find" an
 * unrelated mention of the same word and present it as the definition.
 */
const SEARCH_RADIUS = 3;

/** Position of `name` as a standalone word in `line`, or -1. */
function wordColumn(line: string, name: string): number {
  let from = 0;
  for (;;) {
    const index = line.indexOf(name, from);
    if (index < 0) return -1;
    const before = index > 0 ? line[index - 1] : "";
    const after = index + name.length < line.length ? line[index + name.length] : "";
    const boundedLeft = before === "" || !/[A-Za-z0-9_]/.test(before);
    const boundedRight = after === "" || !/[A-Za-z0-9_]/.test(after);
    // `x->name` and `Foo.name` are uses of the symbol, not the place it is
    // written; accepting one would answer a reference as if it were the
    // definition.
    const isMemberAccess = line.slice(Math.max(0, index - 2), index).endsWith("->") ||
      before === ".";
    if (boundedLeft && boundedRight && !isMemberAccess) return index;
    from = index + 1;
  }
}

/**
 * Find the exact position of `name` near `reportedLine` (0-based) in
 * `sourceFile`, or null when it is not there.
 *
 * Searches the reported line first, then outward, upward before downward —
 * Pike reports the body brace, so the header is above it.
 */
export async function refineRuntimeTarget(
  sourceFile: string,
  reportedLine: number,
  name: string,
): Promise<{ line: number; character: number } | null> {
  let text: string;
  try {
    text = await readSource(sourceFile);
  } catch {
    return null;
  }

  const lines = text.split("\n");
  if (lines.length === 0) return null;

  const anchor = Math.min(Math.max(reportedLine, 0), lines.length - 1);
  for (let distance = 0; distance <= SEARCH_RADIUS; distance++) {
    const candidates = distance === 0
      ? [anchor]
      : [anchor - distance, anchor + distance];
    for (const index of candidates) {
      if (index < 0 || index >= lines.length) continue;
      const column = wordColumn(lines[index], name);
      if (column >= 0) return { line: index, character: column };
    }
  }
  return null;
}
