/**
 * Tests for the arity quick-fix code action.
 *
 * Verifies that Pike compiler "Wrong number of arguments" diagnostics
 * produce a quick-fix that adds placeholder arguments for missing parameters.
 *
 * Tested via direct unit test of produceCodeActions(). No LSP server needed.
 */

import { describe, it, expect } from "bun:test";
import { produceCodeActions } from "../../server/src/features/codeAction";
import type { CodeActionParams, Diagnostic } from "vscode-languageserver/node";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal CodeActionParams for testing. */
function makeParams(diagnostics: Diagnostic[]): CodeActionParams {
  return {
    textDocument: { uri: "file:///test/arity.pike" },
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 0 },
    },
    context: {
      diagnostics,
    },
  };
}

/** Create a Pike diagnostic with source="pike". */
function pikeDiagnostic(
  line: number,
  message: string,
  startChar = 0,
  endChar = 0,
): Diagnostic {
  return {
    range: {
      start: { line, character: startChar },
      end: { line, character: endChar || startChar + 10 },
    },
    message,
    source: "pike",
    severity: 1,
  };
}

const CTX = { stdlibModules: new Set(["Stdio", "Array"]) };

// ---------------------------------------------------------------------------
// Matching: produces action for wrong-arity diagnostics
// ---------------------------------------------------------------------------

describe("arity quick-fix: matching", () => {
  it("matches 'Wrong number of arguments to foo(). Expected 3, got 2.'", () => {
    const diag = pikeDiagnostic(0, "Wrong number of arguments to greet(). Expected 3, got 2.");
    const params = makeParams([diag]);
    const actions = produceCodeActions(params, 'greet("Rex");\n', CTX);

    expect(actions.length).toBeGreaterThanOrEqual(1);
    const arityAction = actions.find(a => a.title.includes("missing argument"));
    expect(arityAction).toBeDefined();
  });

  it("matches 'Wrong number of arguments to foo()' without Expected/got counts", () => {
    // The matcher fires but without expected/actual counts no edit is produced.
    const diag = pikeDiagnostic(0, "Wrong number of arguments to greet().");
    const params = makeParams([diag]);
    const actions = produceCodeActions(params, 'greet("Rex");\n', CTX);

    // Matcher matches the diagnostic pattern but extractArityInfo returns null
    // (no counts), so no edit is produced and no action is pushed.
    // This is expected — the matcher fires but the edit producer bails out.
    const arityAction = actions.find(a => a.title.includes("greet"));
    // No action pushed because edits are empty.
    expect(arityAction).toBeUndefined();
  });

  it("does not match unrelated Pike diagnostics", () => {
    const diag = pikeDiagnostic(0, "Undefined identifier 'foo'");
    const params = makeParams([diag]);
    const actions = produceCodeActions(params, "foo;\n", CTX);

    const arityAction = actions.find(a => a.title.includes("argument"));
    expect(arityAction).toBeUndefined();
  });

  it("does not match diagnostics from other sources", () => {
    const diag = pikeDiagnostic(0, "Wrong number of arguments to foo(). Expected 2, got 1.");
    diag.source = "pike-lsp-lint";
    const params = makeParams([diag]);
    const actions = produceCodeActions(params, "foo(1);\n", CTX);

    const arityAction = actions.find(a => a.title.includes("argument"));
    expect(arityAction).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Title: dynamic based on arity mismatch direction
// ---------------------------------------------------------------------------

describe("arity quick-fix: title", () => {
  it("shows 'Add N missing argument(s) to funcName' when too few args", () => {
    const diag = pikeDiagnostic(0, "Wrong number of arguments to greet(). Expected 3, got 1.");
    const params = makeParams([diag]);
    const actions = produceCodeActions(params, 'greet("Rex");\n', CTX);

    const arityAction = actions.find(a => a.title.includes("missing argument"));
    expect(arityAction?.title).toBe("Add 2 missing argument(s) to greet");
  });

  it("shows 'Remove N extra argument(s)' title for too-many-args (no edit produced)", () => {
    // When too many args: the title says "Remove N extra" but no edit is
    // produced (ambiguous which args to remove). The action is NOT pushed
    // because edits are empty — this is by design.
    const diag = pikeDiagnostic(0, "Wrong number of arguments to greet(). Expected 1, got 3.");
    const params = makeParams([diag]);
    const sourceText = 'greet("Rex", 5, true);\n';
    const actions = produceCodeActions(params, sourceText, CTX);

    // No action pushed because fixArityMismatch returns [] for too-many.
    const arityAction = actions.find(a => a.title.includes("extra argument"));
    expect(arityAction).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Edit: adds placeholder arguments when too few
// ---------------------------------------------------------------------------

describe("arity quick-fix: edit production (too few args)", () => {
  it("inserts ', mixed' for 1 missing argument", () => {
    const diag = pikeDiagnostic(
      0,
      "Wrong number of arguments to greet(). Expected 2, got 1.",
    );
    const params = makeParams([diag]);
    const sourceText = 'greet("Rex");\n';
    const actions = produceCodeActions(params, sourceText, CTX);

    const arityAction = actions.find(a => a.title.includes("missing argument"));
    expect(arityAction).toBeDefined();
    const changes = arityAction?.edit?.changes?.["file:///test/arity.pike"];
    expect(changes).toBeDefined();
    expect(changes!.length).toBe(1);
    expect(changes![0].newText).toBe(", mixed");
  });

  it("inserts ', mixed, mixed' for 2 missing arguments", () => {
    const diag = pikeDiagnostic(
      0,
      "Wrong number of arguments to greet(). Expected 3, got 1.",
    );
    const params = makeParams([diag]);
    const sourceText = 'greet("Rex");\n';
    const actions = produceCodeActions(params, sourceText, CTX);

    const arityAction = actions.find(a => a.title.includes("missing argument"));
    const changes = arityAction?.edit?.changes?.["file:///test/arity.pike"];
    expect(changes).toBeDefined();
    expect(changes![0].newText).toBe(", mixed, mixed");
  });

  it("inserts at the correct position (before closing paren)", () => {
    const diag = pikeDiagnostic(
      1,
      "Wrong number of arguments to greet(). Expected 2, got 1.",
    );
    const params = makeParams([diag]);
    const sourceText = 'int main() {\n  greet("Rex");\n}\n';
    const actions = produceCodeActions(params, sourceText, CTX);

    const arityAction = actions.find(a => a.title.includes("missing argument"));
    const changes = arityAction?.edit?.changes?.["file:///test/arity.pike"];
    expect(changes).toBeDefined();
    // The insertion should be on line 1, at the position of ')'
    expect(changes![0].range.start.line).toBe(1);
    // In '  greet("Rex");' the ')' is at column 13
    expect(changes![0].range.start.character).toBe(13);
  });
});

// ---------------------------------------------------------------------------
// Edit: no edit when too many args (ambiguous which to remove)
// ---------------------------------------------------------------------------

describe("arity quick-fix: edit production (too many args)", () => {
  it("produces no action when too many arguments (removal is ambiguous)", () => {
    const diag = pikeDiagnostic(
      0,
      "Wrong number of arguments to greet(). Expected 1, got 3.",
    );
    const params = makeParams([diag]);
    const sourceText = 'greet("Rex", 5, true);\n';
    const actions = produceCodeActions(params, sourceText, CTX);

    // No action pushed because fixArityMismatch returns empty edits
    // when actual > expected (can't choose which args to remove).
    const arityAction = actions.find(a => a.title.includes("argument") && a.title.includes("greet"));
    expect(arityAction).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("arity quick-fix: edge cases", () => {
  it("produces no edit when counts match", () => {
    const diag = pikeDiagnostic(
      0,
      "Wrong number of arguments to greet(). Expected 1, got 1.",
    );
    const params = makeParams([diag]);
    const actions = produceCodeActions(params, 'greet("Rex");\n', CTX);

    // Matcher fires (0 missing) but edit producer returns [].
    const arityAction = actions.find(a =>
      a.title.includes("argument") && a.title.includes("greet")
    );
    expect(arityAction).toBeUndefined();
  });

  it("produces no action when function name not found in source line", () => {
    const diag = pikeDiagnostic(
      0,
      "Wrong number of arguments to unknown(). Expected 2, got 1.",
    );
    const params = makeParams([diag]);
    const actions = produceCodeActions(params, 'greet("Rex");\n', CTX);

    // Matcher fires but edit producer finds no function call on the line.
    const arityAction = actions.find(a => a.title.includes("missing argument"));
    expect(arityAction).toBeUndefined();
  });
});
