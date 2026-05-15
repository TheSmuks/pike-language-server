/**
 * Tests for commit characters on completion items.
 *
 * Commit characters let the LSP client commit a completion and insert the
 * typed character in one step, triggering follow-on actions like dot-access
 * completion or function-call parens.
 *
 * Rules under test:
 *   1. Functions/methods get "("
 *   2. Classes get "." and "("
 *   3. Variables/parameters/inherit with a non-primitive type get "."
 *   4. Everything else gets no commit characters
 */
import { describe, it, expect } from "bun:test";
import { declToCompletionItem } from "../../server/src/features/completion-items";
import type { Declaration } from "../../server/src/features/symbolTable";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid Declaration stub for testing. */
function makeDecl(
  kind: Declaration["kind"],
  overrides?: Partial<Declaration>,
): Declaration {
  return {
    id: 1,
    name: "testItem",
    kind,
    nameRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } },
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } },
    scopeId: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Functions and methods
// ---------------------------------------------------------------------------

describe("commit characters: functions and methods", () => {
  it("function gets '(' as commit character", () => {
    const item = declToCompletionItem(makeDecl("function", {
      declaredType: "function(string:void)",
    }), 0);
    expect(item.commitCharacters).toEqual(["("]);
  });

  it("method gets '(' as commit character", () => {
    const item = declToCompletionItem(makeDecl("method", {
      declaredType: "function(int:int)",
    }), 0);
    expect(item.commitCharacters).toEqual(["("]);
  });

  it("function without declared type still gets '('", () => {
    // Functions are always callable, even without type info.
    const item = declToCompletionItem(makeDecl("function"), 0);
    expect(item.commitCharacters).toEqual(["("]);
  });
});

// ---------------------------------------------------------------------------
// Classes
// ---------------------------------------------------------------------------

describe("commit characters: classes", () => {
  it("class gets '.' and '(' as commit characters", () => {
    const item = declToCompletionItem(makeDecl("class"), 0);
    expect(item.commitCharacters).toEqual([".", "("]);
  });
});

// ---------------------------------------------------------------------------
// Variables and parameters with class types
// ---------------------------------------------------------------------------

describe("commit characters: typed variables and parameters", () => {
  it("variable with class type gets '.'", () => {
    const item = declToCompletionItem(makeDecl("variable", {
      declaredType: "Dog",
    }), 0);
    expect(item.commitCharacters).toEqual(["."]);
  });

  it("variable with assignedType gets '.' when non-primitive", () => {
    const item = declToCompletionItem(makeDecl("variable", {
      assignedType: "Stdio.File",
    }), 0);
    expect(item.commitCharacters).toEqual(["."]);
  });

  it("parameter with class type gets '.'", () => {
    const item = declToCompletionItem(makeDecl("parameter", {
      declaredType: "Connection",
    }), 0);
    expect(item.commitCharacters).toEqual(["."]);
  });

  it("variable with primitive type 'string' gets no commit characters", () => {
    const item = declToCompletionItem(makeDecl("variable", {
      declaredType: "string",
    }), 0);
    expect(item.commitCharacters).toBeUndefined();
  });

  it("variable with primitive type 'int' gets no commit characters", () => {
    const item = declToCompletionItem(makeDecl("variable", {
      declaredType: "int",
    }), 0);
    expect(item.commitCharacters).toBeUndefined();
  });

  it("variable with primitive type 'mixed' gets no commit characters", () => {
    const item = declToCompletionItem(makeDecl("variable", {
      declaredType: "mixed",
    }), 0);
    expect(item.commitCharacters).toBeUndefined();
  });

  it("variable with primitive type 'void' gets no commit characters", () => {
    const item = declToCompletionItem(makeDecl("variable", {
      declaredType: "void",
    }), 0);
    expect(item.commitCharacters).toBeUndefined();
  });

  it("variable with primitive type 'array' gets no commit characters", () => {
    const item = declToCompletionItem(makeDecl("variable", {
      declaredType: "array",
    }), 0);
    expect(item.commitCharacters).toBeUndefined();
  });

  it("variable with primitive type 'mapping' gets no commit characters", () => {
    const item = declToCompletionItem(makeDecl("variable", {
      declaredType: "mapping",
    }), 0);
    expect(item.commitCharacters).toBeUndefined();
  });

  it("variable with no type info gets no commit characters", () => {
    const item = declToCompletionItem(makeDecl("variable"), 0);
    expect(item.commitCharacters).toBeUndefined();
  });

  it("parameter with no type info gets no commit characters", () => {
    const item = declToCompletionItem(makeDecl("parameter"), 0);
    expect(item.commitCharacters).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Inherit with class type
// ---------------------------------------------------------------------------

describe("commit characters: inherit", () => {
  it("inherit with class type gets '.'", () => {
    const item = declToCompletionItem(makeDecl("inherit", {
      declaredType: "Animal",
    }), 0);
    expect(item.commitCharacters).toEqual(["."]);
  });

  it("inherit with no type gets no commit characters", () => {
    const item = declToCompletionItem(makeDecl("inherit"), 0);
    expect(item.commitCharacters).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Other kinds with no commit characters
// ---------------------------------------------------------------------------

describe("commit characters: kinds without commit characters", () => {
  it("constant gets no commit characters", () => {
    const item = declToCompletionItem(makeDecl("constant", {
      declaredType: "int",
    }), 0);
    expect(item.commitCharacters).toBeUndefined();
  });

  it("enum gets no commit characters", () => {
    const item = declToCompletionItem(makeDecl("enum"), 0);
    expect(item.commitCharacters).toBeUndefined();
  });

  it("enum_member gets no commit characters", () => {
    const item = declToCompletionItem(makeDecl("enum_member"), 0);
    expect(item.commitCharacters).toBeUndefined();
  });

  it("typedef gets no commit characters", () => {
    const item = declToCompletionItem(makeDecl("typedef"), 0);
    expect(item.commitCharacters).toBeUndefined();
  });

  it("import gets no commit characters", () => {
    const item = declToCompletionItem(makeDecl("import"), 0);
    expect(item.commitCharacters).toBeUndefined();
  });
});
