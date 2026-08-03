/**
 * Regression: symbols that exist in the file but were invisible to the server.
 *
 * All three were found by sweeping real Roxen code with an integrity oracle
 * rather than by a targeted test, and all three are silent — the feature
 * answers successfully, just without the symbol.
 *
 *  - `if (int x = ...)` declared nothing, so `x` resolved to nothing from the
 *    body AND from its own name.
 *  - Any declaration carrying a modifier (`protected`, `private`, `static`)
 *    was dropped from the document outline. In idiomatic Pike that is most of
 *    the file: 861 missing symbols across 93 Roxen files.
 *  - `private { ... }` modifier blocks hid every declaration inside them.
 *
 * `#define` macros look like a fourth gap to a completeness sweep and are not
 * one — see the test below and the note in documentSymbol.ts.
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { initParser, parse } from "../../server/src/parser";
import { buildSymbolTable } from "../../server/src/features/symbolTable";
import { getDocumentSymbols, type DocumentSymbol } from "../../server/src/features/documentSymbol";

function names(symbols: DocumentSymbol[]): string[] {
  const out: string[] = [];
  const walk = (list: DocumentSymbol[]) => {
    for (const s of list) { out.push(s.name); if (s.children) walk(s.children); }
  };
  walk(symbols);
  return out;
}

function outlineOf(src: string): string[] {
  const tree = parse(src);
  return names(getDocumentSymbols(tree!));
}

describe("declarations in a condition are in scope for the body", () => {
  beforeAll(async () => { await initParser(); });

  // Verified against the real pike binary: this program runs and prints 7.
  const IF_SRC = `int main()
{
  mapping seen = ([ "a": 7 ]);
  if (int last_ts = seen["a"]) {
    return last_ts;
  }
  return 0;
}
`;

  test("the if-condition declaration becomes a symbol", () => {
    const table = buildSymbolTable(parse(IF_SRC)!, "file:///t.pike", 1, undefined, IF_SRC);
    const decl = table.declarations.find(d => d.name === "last_ts");
    expect(decl).toBeDefined();
    expect(decl!.kind).toBe("variable");
    expect(decl!.nameRange.start.line).toBe(3);
  });

  test("a use in the body resolves to it", () => {
    const table = buildSymbolTable(parse(IF_SRC)!, "file:///t.pike", 1, undefined, IF_SRC);
    const decl = table.declarations.find(d => d.name === "last_ts")!;
    const use = table.references.find(r => r.name === "last_ts" && r.loc.line === 4);
    expect(use).toBeDefined();
    expect(use!.resolvesTo).toBe(decl.id);
  });

  test("the same holds for while and switch", () => {
    const src = `int main()
{
  mapping m = ([]);
  while (int w = m["w"]) { return w; }
  switch (int sw = m["s"]) { case 1: return sw; }
  return 0;
}
`;
    const table = buildSymbolTable(parse(src)!, "file:///t.pike", 1, undefined, src);
    for (const name of ["w", "sw"]) {
      const decl = table.declarations.find(d => d.name === name);
      expect(decl).toBeDefined();
      const use = table.references.find(r => r.name === name && r.loc.line > decl!.nameRange.start.line - 1 && r.resolvesTo !== null);
      expect(use?.resolvesTo).toBe(decl!.id);
    }
  });
});

describe("the outline shows declarations that carry modifiers", () => {
  beforeAll(async () => { await initParser(); });

  test("protected / private / static declarations are listed", () => {
    const outline = outlineOf(`int plain_one() { return 1; }
protected int prot_one(string d) { return 2; }
private string priv_one() { return "x"; }
static int stat_one() { return 3; }
protected int prot_var;
`);
    expect(outline).toEqual(["plain_one", "prot_one", "priv_one", "stat_one", "prot_var"]);
  });

  test("a modifier block does not hide the declarations inside it", () => {
    const outline = outlineOf(`int outside() { return 1; }
private
{
  string inner_var;
  mixed inner_fn( mixed ... args ) { return 0; }
}
protected {
  int second_one;
}
`);
    expect(outline).toEqual(["outside", "inner_var", "inner_fn", "second_one"]);
  });

  // Macros are deliberately absent: Pike's own introspection does not report
  // them as file symbols, and documentSymbol.test.ts cross-checks the outline
  // against that oracle. An integrity sweep flags them as missing; they are not.
  test("#define macros stay out of the outline, matching the Pike oracle", () => {
    const outline = outlineOf(`#define MAX 10
int f() { return MAX; }
`);
    expect(outline).toEqual(["f"]);
  });

  test("class members keep their nesting and modifiers no longer hide them", () => {
    const tree = parse(`class Outer {
  protected int hidden_field;
  private void hidden_method() { }
  int visible() { return 0; }
}
`);
    const symbols = getDocumentSymbols(tree!);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe("Outer");
    expect(names(symbols[0].children ?? [])).toEqual([
      "hidden_field", "hidden_method", "visible",
    ]);
  });
});
