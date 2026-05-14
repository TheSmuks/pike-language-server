/**
 * Tests for lint rules: unused symbols and unreachable code.
 *
 * These tests exercise the lint rules directly (pure tree-sitter + symbol
 * table analysis). No Pike binary is needed — the rules operate on the
 * AST and symbol table alone.
 *
 * Per decision 0028:
 * - P3001: Unused local variable
 * - P3002: Unused parameter
 * - P3003: Unreachable code
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { initParser, parse } from "../../server/src/parser";
import { buildSymbolTable } from "../../server/src/features/symbolTable";
import { detectUnusedSymbols, CODE_UNUSED_VARIABLE, CODE_UNUSED_PARAMETER } from "../../server/src/features/lintRules/unusedSymbols";
import { detectUnreachableCode, CODE_UNREACHABLE } from "../../server/src/features/lintRules/unreachableCode";
import { runLintRules } from "../../server/src/features/lintRules";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildAndLint(src: string) {
  const tree = parse(src);
  const table = buildSymbolTable(tree, "file:///test.pike", 1);
  const unused = detectUnusedSymbols(table);
  const unreachable = detectUnreachableCode(tree);
  return { tree, table, unused, unreachable };
}

function lintAll(src: string) {
  const tree = parse(src);
  const table = buildSymbolTable(tree, "file:///test.pike", 1);
  return runLintRules(tree, table);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await initParser();
});

// ===========================================================================
// E1: Unused variable detection
// ===========================================================================

describe("unused variable lint (P3001)", () => {
  test("detects unused local variable", () => {
    const src = `
void foo() {
    string used = "hello";
    string unused = "world";
    write(used);
}
`;
    const { unused } = buildAndLint(src);
    const unusedVar = unused.find((d) => d.code === CODE_UNUSED_VARIABLE && d.message.includes("unused"));
    expect(unusedVar).toBeDefined();
    expect(unusedVar!.message).toContain("unused");
  });

  test("does NOT flag used variables", () => {
    const src = `
void foo() {
    string x = "hello";
    write(x);
}
`;
    const { unused } = buildAndLint(src);
    const xDiag = unused.find((d) => d.message.includes("'x'"));
    expect(xDiag).toBeUndefined();
  });

  test("does NOT flag _-prefixed variables", () => {
    const src = `
void foo() {
    string _unused = "hello";
}
`;
    const { unused } = buildAndLint(src);
    const underscoreDiag = unused.find((d) => d.message.includes("_unused"));
    expect(underscoreDiag).toBeUndefined();
  });

  test("does NOT flag file-scope variables (may be external)", () => {
    const src = `
string module_level = "exported";
`;
    const { unused } = buildAndLint(src);
    const moduleDiag = unused.find((d) => d.message.includes("module_level"));
    expect(moduleDiag).toBeUndefined();
  });

  test("does NOT flag class fields (may be external)", () => {
    const src = `
class Dog {
    string name;
    void create(string n) { name = n; }
}
`;
    const { unused } = buildAndLint(src);
    // 'name' is a class field, not a local — should not be flagged
    const nameDiag = unused.find((d) => d.message.includes("'name'"));
    expect(nameDiag).toBeUndefined();
  });

  test("flags multiple unused variables in same scope", () => {
    const src = `
void foo() {
    int a = 1;
    int b = 2;
    int c = 3;
    write(c);
}
`;
    const { unused } = buildAndLint(src);
    const names = unused
      .filter((d) => d.code === CODE_UNUSED_VARIABLE)
      .map((d) => {
        const match = d.message.match(/'(\w+)'/);
        return match ? match[1] : "";
      });
    expect(names).toContain("a");
    expect(names).toContain("b");
    // c IS used (write(c)), so it should NOT be in the unused list
    expect(names).toHaveLength(2);
  });
});

// ===========================================================================
// E1: Unused parameter detection
// ===========================================================================

describe("unused parameter lint (P3002)", () => {
  test("detects unused parameter", () => {
    const src = `
void foo(string used, int unused_param) {
    write(used);
}
`;
    const { unused } = buildAndLint(src);
    const paramDiag = unused.find((d) => d.code === CODE_UNUSED_PARAMETER);
    expect(paramDiag).toBeDefined();
    expect(paramDiag!.message).toContain("unused_param");
  });

  test("does NOT flag _-prefixed parameters", () => {
    const src = `
void foo(string _ignore) {
}
`;
    const { unused } = buildAndLint(src);
    const paramDiag = unused.find((d) => d.message.includes("_ignore"));
    expect(paramDiag).toBeUndefined();
  });

  test("does NOT flag used parameters", () => {
    const src = `
int add(int a, int b) {
    return a + b;
}
`;
    const { unused } = buildAndLint(src);
    const paramDiags = unused.filter((d) => d.code === CODE_UNUSED_PARAMETER);
    expect(paramDiags).toHaveLength(0);
  });

  test("can disable parameter checking", () => {
    const src = `
void foo(string used, int unused_param) {
    write(used);
}
`;
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test.pike", 1);
    const diags = detectUnusedSymbols(table, { checkParameters: false });
    const paramDiag = diags.find((d) => d.code === CODE_UNUSED_PARAMETER);
    expect(paramDiag).toBeUndefined();
  });
});

// ===========================================================================
// E2: Unreachable code detection
// ===========================================================================

describe("unreachable code lint (P3003)", () => {
  test("detects code after return", () => {
    const src = `
int foo() {
    return 42;
    write("unreachable");
}
`;
    const { unreachable } = buildAndLint(src);
    expect(unreachable.length).toBeGreaterThanOrEqual(1);
    expect(unreachable[0].code).toBe(CODE_UNREACHABLE);
  });

  test("detects code after break", () => {
    const src = `
void foo() {
    for (int i = 0; i < 10; i++) {
        break;
        write("unreachable");
    }
}
`;
    const { unreachable } = buildAndLint(src);
    expect(unreachable.length).toBeGreaterThanOrEqual(1);
    expect(unreachable[0].code).toBe(CODE_UNREACHABLE);
  });

  test("detects code after continue", () => {
    const src = `
void foo() {
    for (int i = 0; i < 10; i++) {
        continue;
        write("unreachable");
    }
}
`;
    const { unreachable } = buildAndLint(src);
    expect(unreachable.length).toBeGreaterThanOrEqual(1);
    expect(unreachable[0].code).toBe(CODE_UNREACHABLE);
  });

  test("does NOT flag code after conditional return (guard clause)", () => {
    const src = `
string foo(int x) {
    if (x < 0) {
        return "negative";
    }
    return "non-negative";
}
`;
    const { unreachable } = buildAndLint(src);
    expect(unreachable).toHaveLength(0);
  });

  test("flags multiple unreachable statements", () => {
    const src = `
int foo() {
    return 42;
    int x = 1;
    write("also unreachable");
}
`;
    const { unreachable } = buildAndLint(src);
    expect(unreachable.length).toBeGreaterThanOrEqual(2);
  });

  test("does NOT flag code with no terminators", () => {
    const src = `
void foo() {
    int a = 1;
    int b = 2;
    write(a + b);
}
`;
    const { unreachable } = buildAndLint(src);
    expect(unreachable).toHaveLength(0);
  });
});

// ===========================================================================
// E5: Lint pipeline
// ===========================================================================

describe("lint pipeline (runLintRules)", () => {
  test("runs all rules and merges results", () => {
    const src = `
int foo() {
    string unused_var = "hello";
    return 42;
    write("unreachable");
}
`;
    const all = lintAll(src);
    // Should have at least 1 unused + 1 unreachable
    const hasUnused = all.some((d) => d.code === CODE_UNUSED_VARIABLE);
    const hasUnreachable = all.some((d) => d.code === CODE_UNREACHABLE);
    expect(hasUnused).toBe(true);
    expect(hasUnreachable).toBe(true);
  });

  test("can disable individual rules", () => {
    const src = `
int foo() {
    string unused_var = "hello";
    return 42;
    write("unreachable");
}
`;
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test.pike", 1);
    const diags = runLintRules(tree, table, { unusedSymbols: false });
    const hasUnused = diags.some((d) => d.code === CODE_UNUSED_VARIABLE);
    expect(hasUnused).toBe(false);
  });
});
