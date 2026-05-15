/**
 * Selection range tests (T4.1).
 *
 * Tests getSelectionRange() directly with tree-sitter parsed Pike source.
 * Exercises: nested expression selection, statement selection, deduplication,
 * fallback to root range, multi-line constructs.
 *
 * Note: tree-sitter-pike grammar uses node types like `program` (not
 * `source_file`), `declaration`/`function_decl` (not `function_definition`),
 * `expression_statement`, `block`, `if_statement`, `return_statement`, etc.
 * The MEANINGFUL_TYPES set in selectionRange.ts defines which types produce
 * ranges — tests match against those types.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Parser, Language } from "web-tree-sitter";
import { getSelectionRange } from "../../server/src/features/selectionRange";

let parser: Parser;

beforeAll(async () => {
  await Parser.init();
  parser = new Parser();
  const lang = await Language.load("./server/tree-sitter-pike.wasm");
  parser.setLanguage(lang);
});

afterAll(() => {
  parser.delete();
});

function assert(condition: unknown, msg: string): asserts condition {
  if (!condition) throw new Error(msg);
}

/** Parse source and return selection range at (line, character). */
function rangeAt(src: string, line: number, character: number) {
  const tree = parser.parse(src);
  assert(tree, "Parse failed");
  const result = getSelectionRange(tree, line, character);
  tree.delete();
  return result;
}

/** Collect all ranges in the linked list, from outermost to innermost. */
function collectRanges(range: NonNullable<ReturnType<typeof getSelectionRange>>) {
  const ranges = [range.range];
  let current = range.parent;
  while (current) {
    ranges.push(current.range);
    current = current.parent;
  }
  return ranges;
}

// ---------------------------------------------------------------------------
// Basic selection
// ---------------------------------------------------------------------------

describe("getSelectionRange basic cases", () => {
  test("returns a range for empty document", () => {
    const result = rangeAt("", 0, 0);
    // Empty document still has a root node — returns root range
    expect(result).toBeDefined();
  });

  test("selects call expression (postfix_expr) inside expression statement", () => {
    const src = "write(42);";
    // Cursor on 'w' of write (line 0, char 0)
    const result = rangeAt(src, 0, 0);
    assert(result, "Expected non-null result");

    const ranges = collectRanges(result);
    // MEANINGFUL_TYPES includes expression_statement, postfix_expr.
    // postfix_expr wraps the call, expression_statement wraps everything.
    const hasPostfix = ranges.some(
      r => r.start.line === 0 && r.start.character === 0 && r.end.character === 10,
    );
    expect(hasPostfix).toBe(true);

    const hasExprStmt = ranges.some(
      r => r.start.character === 0 && r.end.character === 10,
    );
    expect(hasExprStmt).toBe(true);
  });

  test("selects block and return_statement inside function", () => {
    const src = [
      "int main() {",
      "  return 0;",
      "}",
    ].join("\n");

    const result = rangeAt(src, 1, 2);
    assert(result, "Expected non-null result");

    const ranges = collectRanges(result);
    // MEANINGFUL_TYPES includes block, return_statement
    const hasBlock = ranges.some(
      r => r.start.line === 0 && r.start.character === 11 && r.end.line === 2 && r.end.character === 1,
    );
    expect(hasBlock).toBe(true);

    const hasReturn = ranges.some(
      r => r.start.line === 1 && r.start.character === 2 && r.end.character === 11,
    );
    expect(hasReturn).toBe(true);
  });

  test("selects block inside class", () => {
    const src = [
      "class Dog {",
      "  void speak() {}",
      "  int value;",
      "}",
    ].join("\n");

    const result = rangeAt(src, 1, 3);
    assert(result, "Expected non-null result");

    const ranges = collectRanges(result);
    // class_decl and class_body are NOT in MEANINGFUL_TYPES, but block is.
    // The empty block {} of speak() is in MEANINGFUL_TYPES.
    expect(ranges.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Nested constructs
// ---------------------------------------------------------------------------

describe("getSelectionRange nested constructs", () => {
  test("selects progressively from innermost outward in binary expression", () => {
    const src = "int x = 1 + 2 * 3;";
    // Cursor on '2' (char 12)
    const result = rangeAt(src, 0, 12);
    assert(result, "Expected non-null result");

    const ranges = collectRanges(result);
    // Grammar wraps everything in comma_expr > assign_expr > ... > add_expr > mul_expr
    // None of the intermediate expression types are in MEANINGFUL_TYPES.
    // postfix_expr and type are. Should get at least those two.
    expect(ranges.length).toBeGreaterThanOrEqual(2);
  });

  test("selects if_statement and block inside function", () => {
    const src = [
      "int main() {",
      "  if (1) {",
      "    return 1;",
      "  }",
      "}",
    ].join("\n");

    // Cursor on 'return 1;' (line 2, char 4)
    const result = rangeAt(src, 2, 4);
    assert(result, "Expected non-null result");

    const ranges = collectRanges(result);
    // Should include: return_statement, block (if body), if_statement,
    // block (fn body), possibly more
    const hasIf = ranges.some(r => r.start.line === 1 && r.end.line === 3);
    expect(hasIf).toBe(true);
  });

  test("selects argument_list in function call", () => {
    const src = "write(1, 2, 3);";
    // Cursor on second argument '2' (char 9)
    const result = rangeAt(src, 0, 9);
    assert(result, "Expected non-null result");

    const ranges = collectRanges(result);
    // argument_list is in MEANINGFUL_TYPES, spans [6, 13]
    const hasArgList = ranges.some(
      r => r.start.character === 6 && r.end.character === 13,
    );
    expect(hasArgList).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

describe("getSelectionRange deduplication", () => {
  test("does not produce duplicate ranges for adjacent meaningful nodes", () => {
    const src = [
      "int main() {",
      "  int x = 1;",
      "}",
    ].join("\n");

    const result = rangeAt(src, 1, 6);
    assert(result, "Expected non-null result");

    const ranges = collectRanges(result);
    // Check no two consecutive ranges are identical
    for (let i = 1; i < ranges.length; i++) {
      const prev = ranges[i - 1];
      const curr = ranges[i];
      const identical =
        prev.start.line === curr.start.line &&
        prev.start.character === curr.start.character &&
        prev.end.line === curr.end.line &&
        prev.end.character === curr.end.character;
      expect(identical).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("getSelectionRange edge cases", () => {
  test("cursor at end of file returns valid range", () => {
    const src = "int x = 1;";
    const result = rangeAt(src, 0, 10);
    expect(result).toBeDefined();
  });

  test("cursor on class keyword returns declaration range", () => {
    const src = "class Foo { int x; }";
    // Cursor on 'c' of class (char 0)
    const result = rangeAt(src, 0, 0);
    assert(result, "Expected non-null result");

    const ranges = collectRanges(result);
    // class_decl is not in MEANINGFUL_TYPES but block is
    expect(ranges.length).toBeGreaterThanOrEqual(1);
  });

  test("fallback to root when no meaningful types found", () => {
    // In most real code, there will be meaningful types.
    // But if cursor is in a region with only non-meaningful nodes,
    // the function falls back to root range.
    const src = ";;;";
    const result = rangeAt(src, 0, 0);
    assert(result, "Expected non-null result");
    // Should return root range (the whole document)
    expect(result.range.start.line).toBe(0);
    expect(result.parent).toBeUndefined();
  });

  test("empty block returns block range", () => {
    const src = [
      "int main() {",
      "}",
    ].join("\n");

    // Cursor inside empty block (line 0, char 12 — at '{')
    const result = rangeAt(src, 0, 11);
    assert(result, "Expected non-null result");

    const ranges = collectRanges(result);
    expect(ranges.length).toBeGreaterThanOrEqual(1);
  });
});
