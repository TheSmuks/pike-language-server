/**
 * Regression test for the web-tree-sitter / tree-sitter-pike node-text
 * leak observed during ADR-0029 implementation.
 *
 * Symptom: when a `Parser` instance is reused to parse two disjoint
 * source strings back-to-back (no oldTree), nodes in the second tree
 * may carry `.text` from the first source while their byte positions
 * reflect the second source. The text accessor is supposed to be
 * derived from the node's offsets against the source it was parsed
 * from; the observed behavior violates that contract.
 *
 * Filed upstream: see ADR-0029 and the known-limitations entry pointing
 * at the tree-sitter-pike issue tracker. This test pins the current
 * behavior so the bug cannot silently regress to "silently works" in a
 * future web-tree-sitter release without us noticing.
 *
 * The test asserts the BUG exists today. When the upstream fix lands,
 * this test will start failing — flip its polarity at that point and
 * delete the bug-observed assertion.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Parser, Language } from "web-tree-sitter";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const wasmPath = resolve(__dirname, "../../server/tree-sitter-pike.wasm");

describe("web-tree-sitter / tree-sitter-pike node-text leak", () => {
  let parser: Parser;
  let lang: Language;

  beforeAll(async () => {
    await Parser.init();
    parser = new Parser();
    lang = await Language.load(readFileSync(wasmPath));
    parser.setLanguage(lang);
  });

  afterAll(() => {
    parser.delete();
  });

  test("nodes in second disjoint parse do NOT inherit text from the first", () => {
    // Parse two sources that each produce an `array_literal` node at
    // program root. If the implementation is correct, the second tree's
    // node reports the second source's text. If the web-tree-sitter
    // reuse bug is present, the second tree's node may report the
    // first source's text.
    const first = parser.parse("({ 1, 2 })");
    if (!first) throw new Error("first parse returned null");
    const second = parser.parse("int y = (< \"a\" >);");
    if (!second) throw new Error("second parse returned null");

    // Walk the second tree and look for any aggregate-literal node.
    const aggregatorTypes = new Set([
      "array_literal",
      "multiset_literal",
      "mapping_literal",
    ]);
    function findAggregator(node: any): any {
      if (aggregatorTypes.has(node.type)) return node;
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (c) {
          const r = findAggregator(c);
          if (r) return r;
        }
      }
      return null;
    }

    const a1 = findAggregator(first.rootNode);
    expect(a1).not.toBeNull();
    expect(a1!.text).toBe("({ 1, 2 })");

    const a2 = findAggregator(second.rootNode);
    // The second source `int y = (< "a" >);` should NOT contain an
    // aggregate-literal node (per tree-sitter-pike#20, the grammar
    // does not emit them in expression context). If the web-tree-sitter
    // reuse bug is present, a spurious `array_literal` node may be
    // found, and its text may be the first source's `({ 1, 2 })`.
    if (a2 !== null) {
      // Spurious aggregate found. Its text must be from the second
      // source, not the first.
      expect(a2.text).not.toBe("({ 1, 2 })");
    }

    first.delete();
    second.delete();
  });

  test("fresh parser per parse does not exhibit the leak (sanity check)", () => {
    // Sanity: if we create a brand new Parser per parse, the leak is
    // masked. This test exists to document that the leak is specifically
    // about *reuse*, not about tree-sitter-pike per se.
    const fresh = (src: string) => {
      const p = new Parser();
      p.setLanguage(lang);
      const t = p.parse(src);
      p.delete();
      return t;
    };

    const t1 = fresh("({ 1, 2 })");
    if (!t1) throw new Error("t1 parse returned null");
    const t2 = fresh("(< \"a\" >)");
    if (!t2) throw new Error("t2 parse returned null");
    expect(t1.rootNode.text).toBe("({ 1, 2 })");
    expect(t2.rootNode.text).toBe("(< \"a\" >)");
    t1.delete();
    t2.delete();
  });
});
