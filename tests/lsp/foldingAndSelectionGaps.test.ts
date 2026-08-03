/**
 * Regression: the selection-range chain ran backwards, and comment folding
 * only ever fired at file top level.
 *
 * LSP 3.17 defines SelectionRange.parent as "the parent selection range
 * containing this range", and the response is the innermost range for the
 * position. VSCode enforces containment in the SelectionRange constructor and
 * throws otherwise, so an inverted chain does not merely expand in the wrong
 * order — it takes expand-selection out entirely.
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { initParser, parse } from "../../server/src/parser";
import { produceFoldingRanges } from "../../server/src/features/foldingRange";
import { getSelectionRange } from "../../server/src/features/selectionRange";

interface Pos { line: number; character: number }
interface Range { start: Pos; end: Pos }

const SRC = `// top one
// top two
// top three
class Foo {
  //! doc line one
  //! doc line two
  //! doc line three
  int value;

  // plain one
  // plain two
  void set(int v) {
    value = v;
  }
}
`;

function contains(outer: Range, inner: Range): boolean {
  if (outer.start.line > inner.start.line) return false;
  if (outer.start.line === inner.start.line &&
      outer.start.character > inner.start.character) return false;
  if (outer.end.line < inner.end.line) return false;
  if (outer.end.line === inner.end.line &&
      outer.end.character < inner.end.character) return false;
  return true;
}

describe("selection range", () => {
  beforeAll(async () => { await initParser(); });

  const lines = SRC.split("\n");
  const line = lines.findIndex(l => l.includes("value = v;"));
  const character = lines[line].indexOf("value") + 2;

  test("every parent contains its child", () => {
    const head = getSelectionRange(parse(SRC)!, line, character);
    expect(head).not.toBeNull();

    let node = head;
    let depth = 0;
    while (node?.parent && depth < 16) {
      expect(contains(node.parent.range, node.range),
        `parent at depth ${depth} must contain its child`).toBe(true);
      node = node.parent;
      depth++;
    }
    expect(depth, "expected a chain, not a single range").toBeGreaterThan(0);
  });

  test("the head is the innermost range, not the outermost", () => {
    const head = getSelectionRange(parse(SRC)!, line, character)!;
    // The cursor is on `value`; the innermost meaningful range must not span
    // the whole method body.
    expect(head.range.start.line).toBe(line);
    expect(head.range.end.line).toBe(line);

    let outermost = head;
    while (outermost.parent) outermost = outermost.parent;
    expect(outermost.range.end.line).toBeGreaterThan(head.range.end.line);
  });

  test("the head contains the requested position", () => {
    const head = getSelectionRange(parse(SRC)!, line, character)!;
    expect(contains(head.range, {
      start: { line, character }, end: { line, character },
    })).toBe(true);
  });
});

describe("comment folding", () => {
  beforeAll(async () => { await initParser(); });

  test("an AutoDoc block inside a class folds", () => {
    const ranges = produceFoldingRanges(parse(SRC)!);
    const lines = SRC.split("\n");
    const docStart = lines.findIndex(l => l.includes("doc line one"));
    expect(ranges.some(r => r.startLine === docStart),
      "//! block inside the class").toBe(true);
  });

  test("a plain comment run inside a class folds", () => {
    const ranges = produceFoldingRanges(parse(SRC)!);
    const lines = SRC.split("\n");
    const plainStart = lines.findIndex(l => l.includes("plain one"));
    expect(ranges.some(r => r.startLine === plainStart),
      "// run inside the class").toBe(true);
  });

  test("the top-level comment group still folds", () => {
    const ranges = produceFoldingRanges(parse(SRC)!);
    expect(ranges.some(r => r.startLine === 0 && r.endLine === 2)).toBe(true);
  });

  test("a `//!` run and a `//` run are separate groups", () => {
    const ranges = produceFoldingRanges(parse(SRC)!);
    const lines = SRC.split("\n");
    const docStart = lines.findIndex(l => l.includes("doc line one"));
    const doc = ranges.find(r => r.startLine === docStart);
    expect(doc).toBeDefined();
    // It must stop at the last `//!`, not run on into the `//` block below.
    expect(doc!.endLine).toBe(lines.findIndex(l => l.includes("doc line three")));
  });
});
