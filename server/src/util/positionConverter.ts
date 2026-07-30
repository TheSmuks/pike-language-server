/**
 * Source line extraction helper.
 *
 * web-tree-sitter (0.26+) indexes JS-string input in UTF-16 code units — the
 * same unit LSP requires for `character` offsets. Tree-sitter `Point.column`
 * and LSP `Position.character` are therefore directly comparable with no
 * conversion: this module used to also host `utf8ToUtf16`/`utf16ToUtf8`
 * converters built on the false premise that tree-sitter emits UTF-8 byte
 * offsets. It does not, so those functions have been removed.
 */

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
