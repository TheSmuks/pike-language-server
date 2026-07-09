/**
 * Regression tests for typed-constant recovery.
 *
 * The tree-sitter-pike grammar has no rule for `constant <type> <name> = ...`:
 * it binds the type identifier to the `name` field and pushes the real name
 * into a trailing ERROR node. `recoverTypedConstant` in the declaration
 * collector recovers the real name so the constant is not (wrongly) named after
 * its type — which otherwise mislabels the type keyword as a semantic token and
 * makes it lose its grammar color (see the Ayu Mirage color investigation).
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { initParser, parse } from "../../server/src/parser";
import { buildSymbolTable, type SymbolTable } from "../../server/src/features/symbolTable";

function buildTableFromSrc(src: string): SymbolTable {
  const tree = parse(src);
  return buildSymbolTable(tree, "file:///test.pike", 1, undefined, src);
}

beforeAll(async () => {
  await initParser();
});

describe("typed constant recovery", () => {
  test("typed constant is named after the constant, not its type", () => {
    const table = buildTableFromSrc(`constant string NAME = "counter";`);

    const named = table.declarations.find((d) => d.name === "NAME");
    expect(named).toBeDefined();
    expect(named!.kind).toBe("constant");
    expect(named!.declaredType).toBe("string");

    // The type keyword must NOT become a declaration.
    expect(table.declarations.some((d) => d.name === "string")).toBe(false);
  });

  test("typed constant name range covers the name, not the type", () => {
    // `constant string NAME` — NAME starts at column 16.
    const table = buildTableFromSrc(`constant string NAME = "x";`);
    const named = table.declarations.find((d) => d.name === "NAME");
    expect(named).toBeDefined();
    expect(named!.nameRange.start.character).toBe(16);
  });

  test("untyped constant is unaffected", () => {
    const table = buildTableFromSrc(`constant MAX = 100;`);
    const max = table.declarations.find((d) => d.name === "MAX");
    expect(max).toBeDefined();
    expect(max!.kind).toBe("constant");
  });

  test("typed constant inside a class scope", () => {
    const table = buildTableFromSrc(`class C {\n  constant int LIMIT = 5;\n}`);
    const limit = table.declarations.find((d) => d.name === "LIMIT");
    expect(limit).toBeDefined();
    expect(limit!.kind).toBe("constant");
    expect(limit!.declaredType).toBe("int");
    expect(table.declarations.some((d) => d.name === "int")).toBe(false);
  });
});
