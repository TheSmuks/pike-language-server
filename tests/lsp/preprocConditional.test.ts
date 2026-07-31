/**
 * Conditional-compilation directives as addressable positions.
 *
 * `#ifdef X`, `#if constant(Y)` and `#undef Z` used to be one opaque grammar
 * token each, so every position-driven capability answered nothing inside them
 * — 2316 identifier occurrences across the Roxen corpus. The grammar now gives
 * a condition real identifier nodes; these tests pin that the names in a
 * condition resolve to the macro they refer to, and that the preprocessor's own
 * operators are not mistaken for Pike symbols.
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { initParser, parse } from "../../server/src/parser";
import { buildSymbolTable, getDefinitionAt } from "../../server/src/features/symbolTable";

const URI = "file:///test/preproc-conditional.pike";

const SOURCE = [
  "#define ENABLE_DUMPING 1", // line 0
  "#define OTHER_FLAG 2", // line 1
  "", // 2
  "#ifdef ENABLE_DUMPING", // 3
  "int a;", // 4
  "#endif", // 5
  "", // 6
  "#ifndef OTHER_FLAG", // 7
  "int b;", // 8
  "#endif", // 9
  "", // 10
  "#if constant(OTHER_FLAG) && defined(ENABLE_DUMPING)", // 11
  "int c;", // 12
  "#endif", // 13
  "", // 14
  "#undef ENABLE_DUMPING", // 15
  "",
].join("\n");

function table() {
  return buildSymbolTable(parse(SOURCE), URI, 1, undefined, SOURCE);
}

/** Column of `name` on `line`, as an editor would report the cursor. */
function columnOf(line: number, name: string): number {
  const col = SOURCE.split("\n")[line].indexOf(name);
  expect(col).toBeGreaterThanOrEqual(0);
  return col;
}

describe("conditional directives are addressable", () => {
  beforeAll(async () => {
    await initParser();
  });

  test("#ifdef name resolves to its #define", () => {
    const def = getDefinitionAt(table(), 3, columnOf(3, "ENABLE_DUMPING"));
    expect(def).not.toBeNull();
    expect(def!.nameRange.start.line).toBe(0);
  });

  test("#ifndef name resolves to its #define", () => {
    const def = getDefinitionAt(table(), 7, columnOf(7, "OTHER_FLAG"));
    expect(def).not.toBeNull();
    expect(def!.nameRange.start.line).toBe(1);
  });

  test("both names in a compound #if condition resolve", () => {
    const t = table();
    const other = getDefinitionAt(t, 11, columnOf(11, "OTHER_FLAG"));
    const enable = getDefinitionAt(t, 11, columnOf(11, "ENABLE_DUMPING"));
    expect(other?.nameRange.start.line).toBe(1);
    expect(enable?.nameRange.start.line).toBe(0);
  });

  test("#undef name resolves to its #define", () => {
    const def = getDefinitionAt(table(), 15, columnOf(15, "ENABLE_DUMPING"));
    expect(def).not.toBeNull();
    expect(def!.nameRange.start.line).toBe(0);
  });

  test("constant and defined are preprocessor operators, not references", () => {
    const names = new Set(table().references.map(r => r.name));
    expect(names.has("constant")).toBe(false);
    expect(names.has("defined")).toBe(false);
  });

  test("a macro used only in a condition still counts as used", () => {
    const t = table();
    const uses = t.references.filter(r => r.name === "ENABLE_DUMPING");
    // #ifdef, #if ... defined(...), #undef
    expect(uses.length).toBe(3);
  });
});
