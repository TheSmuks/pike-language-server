/**
 * Tests for G2: Parameter name inlay hints at call sites.
 *
 * Verifies that function call arguments show the corresponding parameter
 * name as an inlay hint. Requires tree-sitter-pike v1.2.2+ for proper
 * argument_list AST nodes.
 *
 * These tests exercise the inlayHints module directly. No Pike binary needed.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { initParser, parse, deleteTree } from "../../server/src/parser";
import { buildSymbolTable } from "../../server/src/features/symbolTable";
import { produceInlayHints } from "../../server/src/features/inlayHints";
import { InlayHintKind } from "vscode-languageserver-types";

describe("Inlay hints — G2: parameter name hints", () => {
  beforeAll(async () => {
    await initParser();
  });

  let testCounter = 0;

  /** Each test gets a unique URI to avoid incremental parse cache corruption. */
  function getHints(source: string, startLine = 0, endLine = 999) {
    const uri = `file:///test-g2-${++testCounter}.pike`;
    const tree = parse(source, uri);
    if (!tree) throw new Error("parse failed");
    const table = buildSymbolTable(tree, uri, 0);
    return produceInlayHints({
      tree,
      table,
      range: {
        start: { line: startLine, character: 0 },
        end: { line: endLine, character: 999 },
      },
      lines: source.split('\n'),
    });
  }

  function paramHints(source: string) {
    const allHints = getHints(source);
    return allHints.filter(h => h.kind === InlayHintKind.Parameter);
  }

  test("shows parameter name hint at simple function call", () => {
    const hints = paramHints(`void greet(string name, int age) {
    greet("Rex", 5);
}`);
    expect(hints.length).toBeGreaterThanOrEqual(1);
    const labels = hints.map(h => h.label);
    expect(labels).toContain("name: ");
  });

  test("shows multiple parameter name hints", () => {
    const hints = paramHints(`void greet(string name, int age) {
    greet("Rex", 5);
}`);
    expect(hints.length).toBe(2);
    const labels = hints.map(h => h.label);
    expect(labels).toContain("name: ");
    expect(labels).toContain("age: ");
  });

  test("shows parameter hint for method call via arrow", () => {
    const hints = paramHints(`class Dog {
  void bark(string msg, int volume) {}
}
void test() {
  Dog d;
  d->bark("woof", 3);
}`);
    expect(hints.length).toBe(2);
    const labels = hints.map(h => h.label);
    expect(labels).toContain("msg: ");
    expect(labels).toContain("volume: ");
  });

  test("no hints when function has no parameters", () => {
    const hints = paramHints(`void noop() {}
void test() {
    noop();
}`);
    expect(hints.length).toBe(0);
  });

  test("fewer hints when fewer arguments than parameters", () => {
    const hints = paramHints(`void greet(string name, int age) {
    greet("Rex");
}`);
    // Only 1 argument, so at most 1 parameter hint.
    expect(hints.length).toBe(1);
    expect(hints[0].label).toBe("name: ");
  });

  test("no hints for unknown function", () => {
    const hints = paramHints(`void test() {
    unknownFunc("Rex", 5);
}`);
    expect(hints.length).toBe(0);
  });

  test("hint position is at the start of each argument", () => {
    const hints = paramHints(`void greet(string name, int age) {
    greet("Rex", 5);
}`);
    expect(hints.length).toBe(2);
    // Both on the call line (line 1).
    expect(hints[0].position.line).toBe(1);
    expect(hints[1].position.line).toBe(1);
    // Second arg column should be greater than first.
    expect(hints[1].position.character).toBeGreaterThan(hints[0].position.character);
  });
});
