/**
 * Pre-computed byte→UTF-16 offset map for fast position conversion.
 *
 * Tree-sitter produces UTF-8 byte column offsets. LSP requires UTF-16 code unit
 * offsets. For files with many position conversions (reference resolution, scope
 * lookups), re-encoding the same line text on every call is the dominant cost —
 * ~14μs per call × ~11M calls = ~160s on large files.
 *
 * This module builds a per-line Int32Array at parse time where:
 *   map[byteOffset] = utf16CodeUnitOffset
 *
 * Lookup is O(1) — a single array index — instead of O(lineLength) character scan.
 */

const encoder = /* @__PURE__ */ new TextEncoder();

/**
 * Pre-computed byte→UTF-16 offset map for one file.
 * Each entry in `lines` is an Int32Array indexed by byte offset within that line,
 * giving the corresponding UTF-16 code unit offset.
 *
 * For a line like "hello" (5 ASCII chars), the map is:
 *   [0, 1, 2, 3, 4, 5]
 * For a line with a 2-byte UTF-8 char at position 2 (e.g., "héllo"):
 *   byte 0→0, byte 1→1, byte 2→?, byte 3→2, byte 4→3, byte 5→4, byte 6→5
 *   Mid-character bytes (byte 2) map to the character's UTF-16 start (1).
 */
export interface OffsetMap {
  lines: Int32Array[];
}

/**
 * Build a byte→UTF-16 offset map for all lines in a source file.
 *
 * Cost: O(totalBytes) — one pass through each line's bytes.
 * For a 50K-line file this takes <1ms.
 */
export function buildOffsetMap(lines: string[]): OffsetMap {
  const result: Int32Array[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    result.push(buildLineMap(line));
  }
  return { lines: result };
}

/**
 * Build the byte→UTF-16 map for a single line.
 *
 * For ASCII-only lines, returns a trivial identity map (byte N = char N).
 * For lines with multi-byte UTF-8 characters, mid-character byte offsets
 * map to the start of that character in UTF-16 terms.
 */
function buildLineMap(line: string): Int32Array {
  const utf8 = encoder.encode(line);
  const map = new Int32Array(utf8.byteLength + 1);

  let byteCount = 0;
  let charIndex = 0;

  // Entry 0: byte offset 0 → UTF-16 offset 0
  map[0] = 0;

  while (charIndex < line.length) {
    const codePoint = line.codePointAt(charIndex)!;
    const charBytes = encoder.encode(String.fromCodePoint(codePoint)).byteLength;
    // UTF-16 code units for this code point: 2 for supplementary plane, 1 otherwise
    const utf16Advance = codePoint > 0xffff ? 2 : 1;

    // Mid-character byte offsets map to the character's start position
    for (let b = byteCount + 1; b < byteCount + charBytes; b++) {
      map[b] = charIndex;
    }

    byteCount += charBytes;
    map[byteCount] = charIndex + utf16Advance;
    charIndex += utf16Advance;
  }

  return map;
}

/**
 * Look up the UTF-16 offset for a given byte offset in a line.
 * O(1) — direct array index.
 *
 * @param map The pre-computed offset map
 * @param lineIndex 0-based line number
 * @param byteOffset UTF-8 byte column from tree-sitter
 * @returns UTF-16 code unit offset, or 0 if the line doesn't exist
 */
export function lookupUtf16(map: OffsetMap, lineIndex: number, byteOffset: number): number {
  const lineMap = map.lines[lineIndex];
  if (lineMap === undefined) return byteOffset; // fallback for out-of-range lines
  if (byteOffset < 0) return 0;
  if (byteOffset >= lineMap.length) return lineMap[lineMap.length - 1]!;
  return lineMap[byteOffset]!;
}
