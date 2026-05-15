/**
 * UTF-8 ↔ UTF-16 position conversion utilities.
 *
 * Tree-sitter produces UTF-8 byte offsets. LSP requires UTF-16 code unit
 * offsets. For pure ASCII these are identical, but Unicode diverges:
 *
 *   - 2-byte UTF-8  (U+0080–U+07FF): 1 UTF-16 code unit
 *   - 3-byte UTF-8  (U+0800–U+FFFF): 1 UTF-16 code unit
 *   - 4-byte UTF-8  (U+10000+):      2 UTF-16 code units (surrogate pair)
 *
 * JavaScript strings are UTF-16 internally, so `string.length` gives the
 * UTF-16 code unit count. We use TextEncoder (UTF-8) to bridge the gap.
 */

const encoder = /* @__PURE__ */ new TextEncoder();

/**
 * Given a line of source text and a UTF-8 byte offset (from tree-sitter),
 * return the corresponding UTF-16 code unit offset (for LSP).
 *
 * Strategy: walk character by character, accumulating UTF-8 bytes until
 * we reach or exceed the target byte offset.
 */
export function utf8ToUtf16(lineText: string, utf8ByteOffset: number): number {
  if (utf8ByteOffset <= 0) return 0;

  const byteLengthLine = encoder.encode(lineText).byteLength;
  if (utf8ByteOffset >= byteLengthLine) return lineText.length;

  let byteCount = 0;
  let charIndex = 0;

  while (charIndex < lineText.length) {
    // The code point at charIndex determines how many bytes it encodes to.
    // We encode one code point at a time (which may span multiple UTF-16
    // code units for supplementary plane characters).
    const codePoint = lineText.codePointAt(charIndex)!;
    const charByteLength = encoder.encode(
      String.fromCodePoint(codePoint)
    ).byteLength;

    if (byteCount + charByteLength > utf8ByteOffset) {
      // The target byte offset falls inside this character. We cannot split
      // a character, so we return the start of it — the byte offset was
      // likely a tree-sitter node boundary which never splits characters.
      return charIndex;
    }

    byteCount += charByteLength;
    charIndex += codePoint > 0xffff ? 2 : 1;

    if (byteCount === utf8ByteOffset) return charIndex;
  }

  // If we exhaust the string, return its full length.
  return lineText.length;
}

/**
 * Given a line of source text and a UTF-16 code unit offset (from LSP
 * client), return the corresponding UTF-8 byte offset (for tree-sitter).
 *
 * Strategy: take the substring of the first N UTF-16 code units, encode
 * to UTF-8, and return the byte length.
 */
export function utf16ToUtf8(lineText: string, utf16Offset: number): number {
  if (utf16Offset <= 0) return 0;

  if (utf16Offset >= lineText.length) {
    return encoder.encode(lineText).byteLength;
  }

  // JavaScript's String.prototype.slice operates on UTF-16 code units.
  const prefix = lineText.slice(0, utf16Offset);
  return encoder.encode(prefix).byteLength;
}

/**
 * Extract a single line from source text by 0-based line number.
 * Returns an empty string if the line number is out of range.
 */
export function getLineText(source: string, line: number): string {
  if (line < 0) return "";

  const lines = source.split("\n");
  if (line >= lines.length) return "";

  return lines[line]!;
}
