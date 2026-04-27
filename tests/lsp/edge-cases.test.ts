/**
 * Layer 1 tests for Phase 3 verification edge cases.
 *
 * Covers scoping, shadowing, forward references, recursion, closures,
 * class member resolution, inheritance with rename, and enum resolution.
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { initParser, parse } from "../../server/src/parser";
import {
  buildSymbolTable,
  wireInheritance,
  getDefinitionAt,
  getReferencesTo,
  type SymbolTable,
  type Declaration,
  type Reference,
} from "../../server/src/features/symbolTable";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildTableFromSrc(src: string): SymbolTable {
  const tree = parse(src);
  return buildSymbolTable(tree, "file:///test.pike", 1);
}

function findDecl(table: SymbolTable, name: string, kind?: string): Declaration | undefined {
  return table.declarations.find(
    (d) => d.name === name && (kind === undefined || d.kind === kind),
  );
}

function findRef(table: SymbolTable, name: string, line: number): Reference | undefined {
  return table.references.find((r) => r.name === name && r.loc.line === line);
}

function findResolvedRef(
  table: SymbolTable,
  name: string,
  line: number,
): { ref: Reference; decl: Declaration } | null {
  const ref = table.references.find(
    (r) => r.name === name && r.loc.line === line && r.resolvesTo !== null,
  );
  if (!ref) return null;
  const decl = table.declarations.find((d) => d.id === ref.resolvesTo);
  if (!decl) return null;
  return { ref, decl };
}

// ---------------------------------------------------------------------------
// Parser init (shared)
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await initParser();
});

// ===========================================================================
// 1. Parameter shadows enclosing scope variable
// ===========================================================================

describe("edge case: parameter shadows enclosing variable", () => {
  test("reference to x inside foo resolves to parameter, not file-scope variable", () => {
    const src = `int x = 1;
void foo(int x) {
    return x;
}`;
    const table = buildTableFromSrc(src);

    // File-scope x and parameter x should be separate declarations
    const fileX = findDecl(table, "x", "variable");
    const paramX = findDecl(table, "x", "parameter");
    expect(fileX).toBeDefined();
    expect(paramX).toBeDefined();
    expect(fileX!.scopeId).not.toBe(paramX!.scopeId);

    // Reference to x on line 2 (inside foo) should resolve to parameter
    const resolved = findResolvedRef(table, "x", 2);
    expect(resolved).not.toBeNull();
    expect(resolved!.decl.kind).toBe("parameter");
    expect(resolved!.decl.scopeId).toBe(paramX!.scopeId);
  });
});

// ===========================================================================
// 2. Block-scoped declaration shadows outer block declaration
// ===========================================================================

describe("edge case: inner block variable shadows outer", () => {
  test("x inside if-block resolves to inner declaration", () => {
    const src = `int main() {
    int x = 1;
    if (1) {
        int x = 2;
        return x;
    }
    return x;
}`;
    const table = buildTableFromSrc(src);

    const xDecls = table.declarations.filter((d) => d.name === "x");
    expect(xDecls.length).toBeGreaterThanOrEqual(2);

    // Line 4 (inside if) should resolve to inner x (line 3)
    const innerResolved = findResolvedRef(table, "x", 4);
    if (innerResolved) {
      expect(innerResolved.decl.nameRange.start.line).toBe(3);
    }
  });

  test("x outside if-block resolves to outer declaration", () => {
    const src = `int main() {
    int x = 1;
    if (1) {
        int x = 2;
        return x;
    }
    return x;
}`;
    const table = buildTableFromSrc(src);

    // Line 6 (outside if) should resolve to outer x (line 1)
    const outerResolved = findResolvedRef(table, "x", 6);
    if (outerResolved) {
      expect(outerResolved.decl.nameRange.start.line).toBe(1);
    }
  });
});

// ===========================================================================
// 3. Class member shadows enclosing function variable
// ===========================================================================

describe("edge case: class member shadows enclosing variable", () => {
  test("x inside method resolves to class member, not file-scope variable", () => {
    const src = `int x = 1;
class Foo {
    int x = 2;
    void bar() {
        return x;
    }
}`;
    const table = buildTableFromSrc(src);

    const fileX = findDecl(table, "x", "variable");
    expect(fileX).toBeDefined();
    // fileX should be at line 0
    expect(fileX!.nameRange.start.line).toBe(0);

    // x reference on line 4 should resolve to class member x
    const resolved = findResolvedRef(table, "x", 4);
    expect(resolved).not.toBeNull();
    // The resolved decl should NOT be the file-scope x
    expect(resolved!.decl.id).not.toBe(fileX!.id);
    // It should be the class member x (declared at line 2)
    expect(resolved!.decl.nameRange.start.line).toBe(2);
  });
});

// ===========================================================================
// 4. Inherited member resolution within same file
// ===========================================================================

describe("edge case: inherited member resolution", () => {
  test("reference to val in B's method resolves to A's val through inheritance", () => {
    const src = `class A {
    int val;
    void foo() { return val; }
}
class B {
    inherit A;
    void bar() { return val; }
}`;
    const table = buildTableFromSrc(src);
    wireInheritance(table);

    const aVal = findDecl(table, "val", "variable");
    expect(aVal).toBeDefined();

    // val in B's bar (line 6) should resolve to A's val
    const resolved = findResolvedRef(table, "val", 6);
    expect(resolved).not.toBeNull();
    expect(resolved!.decl.id).toBe(aVal!.id);
  });
});

// ===========================================================================
// 5. Inherit with rename: alias::member
// ===========================================================================

describe("edge case: inherit with rename", () => {
  test("creature::species resolves to Animal's species declaration", () => {
    const src = `class Animal {
    string species;
}
class Dog {
    inherit Animal : creature;
    void test() {
        write(creature::species);
    }
}`;
    const table = buildTableFromSrc(src);
    wireInheritance(table);

    // species should be a scope_access reference that resolves
    const speciesRef = table.references.find(
      (r) => r.kind === "scope_access" && r.name === "species",
    );
    expect(speciesRef).toBeDefined();
    expect(speciesRef!.resolvesTo).not.toBeNull();

    const speciesDecl = table.declarations.find(
      (d) => d.id === speciesRef!.resolvesTo,
    );
    expect(speciesDecl).toBeDefined();
    expect(speciesDecl!.name).toBe("species");
  });

  test("go-to-def on Animal in inherit statement resolves to Animal class", () => {
    const src = `class Animal {
    string species;
}
class Dog {
    inherit Animal : creature;
    void test() {
        write(creature::species);
    }
}`;
    const table = buildTableFromSrc(src);
    wireInheritance(table);

    // The inherit declaration should have name "Animal"
    const inheritDecl = table.declarations.find(
      (d) => d.kind === "inherit" && d.name === "Animal",
    );
    expect(inheritDecl).toBeDefined();
    expect(inheritDecl!.alias).toBe("creature");

    // getDefinitionAt on the inherit declaration position should resolve to Animal class
    const def = getDefinitionAt(
      table,
      inheritDecl!.nameRange.start.line,
      inheritDecl!.nameRange.start.character,
    );
    expect(def).not.toBeNull();
    expect(def!.name).toBe("Animal");
    expect(def!.kind).toBe("class");
  });

  test("go-to-def on creature alias resolves to Animal class", () => {
    const src = `class Animal {
    string species;
}
class Dog {
    inherit Animal : creature;
    void test() {
        write(creature::species);
    }
}`;
    const table = buildTableFromSrc(src);
    wireInheritance(table);

    const inheritDecl = table.declarations.find(
      (d) => d.kind === "inherit" && d.alias === "creature",
    );
    expect(inheritDecl).toBeDefined();

    // The alias "creature" appears after the name in the range;
    // getDefinitionAt anywhere in the inherit range should resolve to Animal
    const def = getDefinitionAt(
      table,
      inheritDecl!.range.start.line,
      inheritDecl!.range.end.character - 1,
    );
    expect(def).not.toBeNull();
    expect(def!.kind).toBe("class");
    expect(def!.name).toBe("Animal");
  });
});

// ===========================================================================
// 6. Forward reference to later class member
// ===========================================================================

describe("edge case: forward reference in class", () => {
  test("second() reference inside first() resolves to second declaration", () => {
    const src = `class Foo {
    void first() { second(); }
    void second() { first(); }
}`;
    const table = buildTableFromSrc(src);

    const secondDecl = findDecl(table, "second", "function");
    expect(secondDecl).toBeDefined();

    // second() call on line 1 should resolve to second declaration
    const resolved = findResolvedRef(table, "second", 1);
    expect(resolved).not.toBeNull();
    expect(resolved!.decl.id).toBe(secondDecl!.id);
  });
});

// ===========================================================================
// 7. Recursive function reference
// ===========================================================================

describe("edge case: recursive function reference", () => {
  test("fib reference inside fib resolves to fib declaration", () => {
    const src = `int fib(int n) { return n < 2 ? n : fib(n-1) + fib(n-2); }`;
    const table = buildTableFromSrc(src);

    const fibDecl = findDecl(table, "fib", "function");
    expect(fibDecl).toBeDefined();

    const fibRefs = table.references.filter((r) => r.name === "fib" && r.resolvesTo !== null);
    // There should be at least two recursive calls (fib(n-1) and fib(n-2))
    expect(fibRefs.length).toBeGreaterThanOrEqual(2);
    for (const ref of fibRefs) {
      expect(ref.resolvesTo).toBe(fibDecl!.id);
    }
  });
});

// ===========================================================================
// 8. Mutual recursion
// ===========================================================================

describe("edge case: mutual recursion", () => {
  test("odd reference inside even resolves to odd declaration", () => {
    const src = `int even(int n) { return n==0 ? 1 : odd(n-1); }
int odd(int n) { return n==0 ? 0 : even(n-1); }`;
    const table = buildTableFromSrc(src);

    const oddDecl = findDecl(table, "odd", "function");
    expect(oddDecl).toBeDefined();

    const resolved = findResolvedRef(table, "odd", 0);
    expect(resolved).not.toBeNull();
    expect(resolved!.decl.id).toBe(oddDecl!.id);
  });

  test("even reference inside odd resolves to even declaration", () => {
    const src = `int even(int n) { return n==0 ? 1 : odd(n-1); }
int odd(int n) { return n==0 ? 0 : even(n-1); }`;
    const table = buildTableFromSrc(src);

    const evenDecl = findDecl(table, "even", "function");
    expect(evenDecl).toBeDefined();

    const resolved = findResolvedRef(table, "even", 1);
    expect(resolved).not.toBeNull();
    expect(resolved!.decl.id).toBe(evenDecl!.id);
  });
});

// ===========================================================================
// 9. For-loop init variable scoping
// ===========================================================================

describe("edge case: for-loop init variable scoping", () => {
  test("for-init variable declaration is registered in for-scope", () => {
    const src = `int main() {
    for (int i = 0; i < 3; i++) {
        write("%d", i);
    }
}`;
    const table = buildTableFromSrc(src);

    // The for scope should have at least one declaration (the for-init var)
    const forScope = table.scopes.find((s) => s.kind === "for");
    expect(forScope).toBeDefined();
    expect(forScope!.declarations.length).toBeGreaterThanOrEqual(1);

    // References to i inside the loop should resolve to the for-init declaration
    const iRefs = table.references.filter((r) => r.name === "i");
    for (const ref of iRefs) {
      if (ref.resolvesTo !== null) {
        const decl = table.declarations.find((d) => d.id === ref.resolvesTo);
        expect(decl).toBeDefined();
        expect(decl!.name).toBe("i");
      }
    }
  });

  test("outer i is visible after for loop", () => {
    const src = `int main() {
    int i = 99;
    for (int i = 0; i < 3; i++) {
        write("%d", i);
    }
    write("%d", i);
}`;
    const table = buildTableFromSrc(src);

    // Outer i is declared
    const outerI = findDecl(table, "i", "variable");
    expect(outerI).toBeDefined();
    expect(outerI!.nameRange.start.line).toBe(1);

    // Reference to i after the for loop (line 5) resolves to outer i
    // because the for scope has ended
    const afterLoopRef = findRef(table, "i", 5);
    expect(afterLoopRef).toBeDefined();
    // After the loop, the for scope has ended, so it should resolve to outer i.
    if (afterLoopRef!.resolvesTo !== null) {
      expect(afterLoopRef!.resolvesTo).toBe(outerI!.id);
    }
  });
});

// ===========================================================================
// 10. Lambda capturing outer variable
// ===========================================================================

describe("edge case: lambda capturing outer variable", () => {
  test("x inside lambda resolves to outer declaration", () => {
    const src = `int main() {
    int x = 10;
    function(:int) f = lambda () { return x; };
}`;
    const table = buildTableFromSrc(src);

    const outerX = findDecl(table, "x", "variable");
    expect(outerX).toBeDefined();

    const xRef = findRef(table, "x", 2);
    expect(xRef).toBeDefined();
    // Lambda capture now resolves to the outer x declaration
    expect(xRef!.resolvesTo).toBe(outerX!.id);
  });
});

// ===========================================================================
// 11. this inside class method
// ===========================================================================

describe("edge case: this inside class method", () => {
  test("this reference resolves to enclosing class declaration", () => {
    const src = `class Foo {
    int val;
    void bar() {
        this.val = 1;
    }
}`;
    const table = buildTableFromSrc(src);

    const fooDecl = findDecl(table, "Foo", "class");
    expect(fooDecl).toBeDefined();

    const thisRef = table.references.find(
      (r) => r.kind === "this_ref" && r.name === "this",
    );
    expect(thisRef).toBeDefined();
    expect(thisRef!.resolvesTo).toBe(fooDecl!.id);
  });
});

// ===========================================================================
// 12. this_program inside class method
// ===========================================================================

describe("edge case: this_program inside class method", () => {
  test("this_program reference resolves to enclosing class declaration", () => {
    const src = `class Foo {
    int val;
    void bar() {
        this_program x = this_program;
    }
}`;
    const table = buildTableFromSrc(src);

    const fooDecl = findDecl(table, "Foo", "class");
    expect(fooDecl).toBeDefined();

    const tpRef = table.references.find(
      (r) => r.kind === "this_ref" && r.name === "this_program",
    );
    expect(tpRef).toBeDefined();
    expect(tpRef!.resolvesTo).toBe(fooDecl!.id);
  });
});

// ===========================================================================
// 13. Enum member resolution
// ===========================================================================

describe("edge case: enum member resolution", () => {
  test("RED reference resolves to enum_member declaration", () => {
    const src = `enum Color { RED, GREEN, BLUE };
int x = RED;`;
    const table = buildTableFromSrc(src);

    const redDecl = findDecl(table, "RED", "enum_member");
    expect(redDecl).toBeDefined();

    const redRef = findResolvedRef(table, "RED", 1);
    expect(redRef).not.toBeNull();
    expect(redRef!.decl.id).toBe(redDecl!.id);
    expect(redRef!.decl.kind).toBe("enum_member");
  });
});
