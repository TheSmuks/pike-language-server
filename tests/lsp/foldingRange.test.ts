/**
 * Folding range tests (US-016).
 *
 * Tests textDocument/foldingRange via LSP protocol and produceFoldingRanges directly.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Parser, Language } from "web-tree-sitter";
import { createTestServer, type TestServer } from "./helpers";
import { produceFoldingRanges, type FoldingRange } from "../../server/src/features/foldingRange";

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

function parseAndGetRanges(src: string): FoldingRange[] {
  const tree = parser.parse(src);
  assert(tree, "Parse failed");
  const ranges = produceFoldingRanges(tree);
  tree.delete();
  return ranges;
}

function assert(condition: unknown, msg: string): asserts condition {
  if (!condition) throw new Error(msg);
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

describe("produceFoldingRanges unit tests", () => {
  test("folds class body", () => {
    const src = [
      "class Dog {",
      "  void speak() {}",
      "  int value;",
      "}",
    ].join("\n");
    const ranges = parseAndGetRanges(src);
    const classBody = ranges.find(r => r.startLine === 0 && r.endLine === 3);
    expect(classBody).toBeDefined();
  });

  test("folds function body", () => {
    const src = [
      "int main() {",
      "  return 0;",
      "}",
    ].join("\n");
    const ranges = parseAndGetRanges(src);
    const fnBody = ranges.find(r => r.startLine === 0 && r.endLine === 2);
    expect(fnBody).toBeDefined();
  });

  test("folds if/for/while/switch blocks", () => {
    const src = [
      "int main() {",
      "  if (1) {",
      "    return 1;",
      "  }",
      "  for (int i = 0; i < 10; i++) {",
      "    write(i);",
      "  }",
      "  while (1) {",
      "    break;",
      "  }",
      "  switch(1) {",
      "    case 1: break;",
      "  }",
      "}",
    ].join("\n");
    const ranges = parseAndGetRanges(src);
    // Should have ranges for: function block, if, for, while, switch
    expect(ranges.length).toBeGreaterThanOrEqual(5);
  });

  test("folds consecutive comment groups", () => {
    const src = [
      "// First comment",
      "// Second comment",
      "// Third comment",
      "int x = 1;",
    ].join("\n");
    const ranges = parseAndGetRanges(src);
    const commentGroup = ranges.find(r => r.kind === "comment");
    expect(commentGroup).toBeDefined();
    expect(commentGroup!.startLine).toBe(0);
    expect(commentGroup!.endLine).toBe(2);
  });

  test("does not fold single-line blocks", () => {
    const src = "int main() { return 0; }";
    const ranges = parseAndGetRanges(src);
    // Single-line block should not produce a fold range
    expect(ranges.length).toBe(0);
  });

  test("folds nested class inside function", () => {
    const src = [
      "int main() {",
      "  class Inner {",
      "    void method() {",
      "      return;",
      "    }",
      "  }",
      "  return 0;",
      "}",
    ].join("\n");
    const ranges = parseAndGetRanges(src);
    // Outer function block, class body, inner method block
    expect(ranges.length).toBeGreaterThanOrEqual(3);
  });

  test("folds switch case groups", () => {
    const src = [
      "switch (x) {",
      "  case 1:",
      "    int a = 1;",
      "    break;",
      "  case 2:",
      "  case 3:",
      "    int b = 2;",
      "    break;",
      "  default:",
      "    int c = 3;",
      "    break;",
      "}",
    ].join("\n");
    const ranges = parseAndGetRanges(src);

    // Should fold: the entire switch block (line 0-11),
    // plus 3 case groups:
    //   case 1:     lines 1-3
    //   case 2..3:  lines 4-7 (fall-through: case 2 has no body)
    //   default:    lines 8-10
    const switchBlock = ranges.find(r => r.startLine === 0 && r.endLine === 11);
    expect(switchBlock).toBeDefined();

    // case 1 group: lines 1-3
    const case1 = ranges.find(r => r.startLine === 1 && r.endLine === 3);
    expect(case1).toBeDefined();

    // case 2..3 group: starts at case 2 (line 4), ends at break (line 7).
    // Fall-through merges case 2 and case 3 into one foldable group.
    const case23 = ranges.find(r => r.startLine === 4 && r.endLine === 7);
    expect(case23).toBeDefined();

    // default group: lines 8-10 (does not include closing `}`)
    const defaultGroup = ranges.find(r => r.startLine === 8 && r.endLine === 10);
    expect(defaultGroup).toBeDefined();
  });

  test("does not fold single-line case groups", () => {
    const src = [
      "switch (x) {",
      "  case 1: break;",
      "  case 2: break;",
      "}",
    ].join("\n");
    const ranges = parseAndGetRanges(src);

    // The switch block itself should be foldable (lines 0-3),
    // but individual case groups are single-line — no extra fold ranges.
    const switchBlock = ranges.find(r => r.startLine === 0 && r.endLine === 3);
    expect(switchBlock).toBeDefined();

    // No case group folds (they're all single-line).
    const caseFolds = ranges.filter(
      r => r.startLine > 0 && r.endLine < 3,
    );
    expect(caseFolds.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// LSP protocol tests
// ---------------------------------------------------------------------------

describe("US-016: textDocument/foldingRange LSP protocol", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await createTestServer();
  });

  afterAll(async () => {
    await server.teardown();
  });

  test("returns folding ranges for class and function", async () => {
    const src = [
      "class Dog {",
      "  void speak() {}",
      "}",
      "",
      "int main() {",
      "  return 0;",
      "}",
    ].join("\n");
    const uri = server.openDoc("file:///test/folding.pike", src);

    const result = await server.client.sendRequest("textDocument/foldingRange", {
      textDocument: { uri },
    });

    expect(result).toBeDefined();
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  test("returns empty array for unknown document", async () => {
    const result = await server.client.sendRequest("textDocument/foldingRange", {
      textDocument: { uri: "file:///nonexistent.pike" },
    });

    expect(result).toEqual([]);
  });
});
