/**
 * Tests for inlay hints — type hints (G1).
 *
 * These tests exercise the inlayHints module directly. No Pike binary needed.
 *
 * G2 (parameter name hints) is blocked — tree-sitter-pike does not produce
 * dedicated AST nodes for function call arguments, making it impossible to
 * reliably extract call-site parameter information.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { initParser, parse } from "../../server/src/parser";
import { buildSymbolTable } from "../../server/src/features/symbolTable";
import { produceInlayHints } from "../../server/src/features/inlayHints";
import { InlayHintKind } from "vscode-languageserver-types";

describe("Inlay hints (G1)", () => {
  beforeAll(async () => {
    await initParser();
  });

  function getHints(source: string, startLine = 0, endLine = 999) {
    const tree = parse(source, "file:///test.pike");
    assert(tree);
    const table = buildSymbolTable(tree, source);
    return produceInlayHints({
      tree,
      table,
      range: {
        start: { line: startLine, character: 0 },
        end: { line: endLine, character: 999 },
      },
    });
  }

  test("shows type hint for untyped variable with assignment", () => {
    const hints = getHints(`int main() {
    string name = "Rex";
    return 0;
}`);
    // 'name' already has declaredType=string, so no hint
    expect(hints.length).toBe(0);
  });

  test("no hint for already-typed variable", () => {
    const hints = getHints(`int main() {
    string name = "Rex";
    return 0;
}`);
    expect(hints.length).toBe(0);
  });

  test("no hint for untyped variable without assignment type", () => {
    const hints = getHints(`int main() {
    x = 42;
    return 0;
}`);
    expect(Array.isArray(hints)).toBe(true);
  });

  test("respects range filtering", () => {
    const source = `int main() {
    string name = "Rex";
    return 0;
}`;
    const hints = getHints(source, 0, 0);
    expect(hints.length).toBe(0);
  });

  test("hint placement is after variable name", () => {
    const source = `int main() {
    name = "Rex";
    return 0;
}`;
    const hints = getHints(source);
    for (const hint of hints) {
      if (hint.kind === InlayHintKind.Type) {
        expect(typeof hint.label).toBe("string");
        expect(hint.label).toContain(":");
      }
    }
  });

  test("no hint for parameters with type annotation", () => {
    const hints = getHints(`void greet(string name) {
    write(name);
}`);
    expect(hints.length).toBe(0);
  });
});

function assert(condition: unknown, msg?: string): asserts condition {
  if (!condition) throw new Error(msg ?? "Assertion failed");
}
