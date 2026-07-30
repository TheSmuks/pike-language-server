/**
 * Parser binding unit contract.
 *
 * web-tree-sitter indexes JS-string input in UTF-16 code units, which is the
 * unit LSP requires. The server therefore passes tree-sitter positions through
 * unconverted. If an upgrade changes this to UTF-8 bytes, every position the
 * server emits silently drifts — so assert it here rather than trusting it.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { Parser, Language } from "web-tree-sitter";
import { resolve } from "node:path";

const WASM = resolve(import.meta.dir, "../../server/tree-sitter-pike.wasm");

let parser: Parser;

beforeAll(async () => {
  await Parser.init();
  parser = new Parser();
  parser.setLanguage(await Language.load(WASM));
});

afterAll(() => {
  parser.delete();
});

describe("web-tree-sitter index units", () => {
  test("columns are UTF-16 code units, not UTF-8 bytes", () => {
    // "© © " — two 2-byte UTF-8 characters, one UTF-16 code unit each.
    const line = "int x; // © © marker";
    const utf16Length = line.length;                              // 20
    const utf8Length = new TextEncoder().encode(line).byteLength; // 22
    expect(utf16Length).not.toBe(utf8Length); // the fixture must discriminate

    const tree = parser.parse(line + "\n")!;
    const commentNode = tree.rootNode.descendantForPosition({ row: 0, column: 7 });
    expect(commentNode).not.toBeNull();
    const comment = commentNode!;

    expect(comment.type).toBe("line_comment");
    expect(comment.startPosition.column).toBe(7);
    expect(comment.endPosition.column).toBe(utf16Length);
    expect(comment.endPosition.column).not.toBe(utf8Length);

    tree.delete();
  });

  test("astral-plane characters count as two code units", () => {
    // "😀" is 2 UTF-16 code units and 4 UTF-8 bytes.
    const line = "int x; // 😀 tail";
    const tree = parser.parse(line + "\n")!;
    const commentNode = tree.rootNode.descendantForPosition({ row: 0, column: 7 });
    expect(commentNode).not.toBeNull();
    const comment = commentNode!;

    expect(comment.endPosition.column).toBe(line.length);
    tree.delete();
  });
});
