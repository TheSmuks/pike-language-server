/**
 * Tests for signature help: constructors and type-aware method resolution.
 *
 * These tests exercise the signatureHelp module directly against a tree-sitter
 * parse tree and symbol table. No Pike binary is needed.
 *
 * Methodology:
 * - Build a symbol table from Pike source using parse() + buildSymbolTable()
 * - Call produceSignatureHelp() at specific cursor positions
 * - Assert the returned signature label and parameter info
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { initParser, parse } from "../../server/src/parser";
import { buildSymbolTable } from "../../server/src/features/symbolTable";
import {
  produceSignatureHelp,
  splitParams,
} from "../../server/src/features/signatureHelp";

// Source layout (0-indexed lines):
//  0: class Dog {
//  1:   string name;
//  2:   int age;
//  3:
//  4:   void create(string name, int age) {
//  ...
// 16: }
// 17:
// 18: class Cat {
// 19:   void meow() {
// 20:     write("meow");
// 21:   }
// 22: }
// 23:
// 24: void greet(string greeting, int times) {
// 25:   write(greeting);
// 26: }
// 27:
// 28: int main() {
// 29:   Dog d = Dog("Rex", 5);
// 30:   d->bark("hello", 3);
// 31:   greet("hi", 2);
// 32:   return 0;
// 33: }
const SOURCE = `class Dog {
  string name;
  int age;

  void create(string name, int age) {
    this.name = name;
    this.age = age;
  }

  void bark(string msg, int volume) {
    write(msg + "!");
  }

  int getAge() {
    return age;
  }
}

class Cat {
  void meow() {
    write("meow");
  }
}

void greet(string greeting, int times) {
  write(greeting);
}

int main() {
  Dog d = Dog("Rex", 5);
  d->bark("hello", 3);
  greet("hi", 2);
  return 0;
}`;

describe("SignatureHelp", () => {
  beforeAll(async () => {
    await initParser();
  });

  function getTableAndTree() {
    const tree = parse(SOURCE, "file:///test.pike");
    assert(tree);
    const table = buildSymbolTable(tree, SOURCE);
    return { tree, table };
  }

  test("constructor signature for Dog(", () => {
    const { tree, table } = getTableAndTree();

    // Line 29: "  Dog d = Dog("Rex", 5);"
    // Cursor right after the opening paren of Dog(
    // "  Dog d = Dog(" → column 14 (0-indexed: 2+4+1+1+2+1+3 = Dog( at col 12, paren at 15)
    // Let's just use column 14 — inside the parens
    const result = produceSignatureHelp(tree, table, 29, 16);
    assert(result, "Expected signature help for Dog(");
    expect(result.signatures).toHaveLength(1);

    const sig = result.signatures[0];
    expect(sig.label).toContain("create");
    expect(sig.parameters).toHaveLength(2);
    expect(sig.parameters[0].label).toContain("name");
    expect(sig.parameters[1].label).toContain("age");
  });

  test("method signature for d->bark(", () => {
    const { tree, table } = getTableAndTree();

    // Line 30: "  d->bark("hello", 3);"
    // Cursor inside the parens after bark(
    const result = produceSignatureHelp(tree, table, 30, 10);
    assert(result, "Expected signature help for d->bark(");
    expect(result.signatures).toHaveLength(1);

    const sig = result.signatures[0];
    expect(sig.label).toContain("bark");
    expect(sig.parameters).toHaveLength(2);
    expect(sig.parameters[0].label).toContain("msg");
    expect(sig.parameters[1].label).toContain("volume");
  });

  test("active parameter tracks commas", () => {
    const { tree, table } = getTableAndTree();

    // Line 30: "  d->bark("hello", 3);"
    // After the comma: column ~19
    const result = produceSignatureHelp(tree, table, 30, 19);
    assert(result, "Expected signature help for d->bark(");
    expect(result.activeParameter).toBe(1);
  });

  test("local function signature for greet(", () => {
    const { tree, table } = getTableAndTree();

    // Line 31: "  greet("hi", 2);"
    // Cursor inside parens after greet(
    const result = produceSignatureHelp(tree, table, 31, 9);
    assert(result, "Expected signature help for greet(");
    expect(result.signatures).toHaveLength(1);

    const sig = result.signatures[0];
    expect(sig.label).toContain("greet");
    expect(sig.parameters).toHaveLength(2);
    expect(sig.parameters[0].label).toContain("greeting");
    expect(sig.parameters[1].label).toContain("times");
  });

  test("no signature for position outside any call", () => {
    const { tree, table } = getTableAndTree();

    const result = produceSignatureHelp(tree, table, 0, 0);
    expect(result).toBeNull();
  });
});

describe("splitParams", () => {
  test("splits simple params", () => {
    expect(splitParams("string a, int b")).toEqual(["string a", " int b"]);
  });

  test("handles nested parens", () => {
    expect(splitParams("function(:string) cb, int x")).toEqual([
      "function(:string) cb",
      " int x",
    ]);
  });

  test("single param", () => {
    expect(splitParams("string name")).toEqual(["string name"]);
  });

  test("empty string returns empty array", () => {
    expect(splitParams("")).toEqual([]);
  });
});

function assert(condition: unknown, msg?: string): asserts condition {
  if (!condition) throw new Error(msg ?? "Assertion failed");
}
