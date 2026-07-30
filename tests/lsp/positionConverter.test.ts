/**
 * Position converter tests — source line extraction.
 *
 * `utf8ToUtf16`/`utf16ToUtf8` were removed: web-tree-sitter indexes JS-string
 * input in UTF-16 code units (the same unit LSP requires), so tree-sitter
 * `Point.column` and LSP `Position.character` need no conversion. This file
 * now covers the one function that remains in positionConverter.ts.
 */

import { test, expect, describe } from "bun:test";
import { getLineText } from "../../server/src/util/positionConverter";

// ---------------------------------------------------------------------------
// getLineText
// ---------------------------------------------------------------------------
describe("getLineText", () => {
  test("extracts first line", () => {
    expect(getLineText("hello\nworld", 0)).toBe("hello");
  });

  test("extracts second line", () => {
    expect(getLineText("hello\nworld", 1)).toBe("world");
  });

  test("single line without newline", () => {
    expect(getLineText("hello", 0)).toBe("hello");
  });

  test("out of range returns empty string", () => {
    expect(getLineText("hello", 5)).toBe("");
  });

  test("negative line returns empty string", () => {
    expect(getLineText("hello", -1)).toBe("");
  });
});
