# Intelligent LSP Features Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Transform the Pike LSP from a syntax-aware editor into an intelligent development tool that provides real-time type-aware completion, signature help, syntax/semantic diagnostics, and code quality warnings.

**Architecture:** Two complementary layers: (1) a **fast tree-sitter lint layer** that provides instant feedback on keystroke (syntax errors, unused variables, unreachable code) using only the AST and symbol table data already in memory, and (2) the **existing Pike compiler layer** for deep semantic errors (type mismatches, wrong arity, missing symbols). The fast layer runs synchronously on every parse; the Pike layer runs asynchronously via PikeWorker with debouncing.

**Tech Stack:** tree-sitter-pike (already integrated), PikeWorker (already integrated), LSP Diagnostics protocol, LSP SignatureHelp protocol, LSP Completion protocol.

**Pre-existing constraint:** We do NOT build a type checker in TypeScript. Pike is the oracle for type correctness. The tree-sitter layer catches only structural/syntactic issues that don't require type information.

---

## Design Principles

1. **Pike is the oracle.** The LSP does not reimplement Pike's type system. It catches what can be determined structurally (unused variables, unreachable code, parse errors) and delegates type errors to Pike's compiler.

2. **Two-speed diagnostics.** Fast lint (tree-sitter, <5ms) runs on every keystroke. Deep diagnostics (Pike compiler, ~500ms) runs debounced. The user sees parse errors and code quality warnings instantly; type errors appear after a short delay.

3. **Existing data, new consumers.** The symbol table already tracks all declarations and references. The tree-sitter parse tree already identifies all statement nodes. The new features consume this existing data — no new data sources needed for Phase E.

4. **Incremental delivery.** Each phase is independently valuable and shippable. Phase E1 (unused variables) is useful on its own. Phase E2 (unreachable code) is useful on its own. No phase depends on a later phase.

---

## Phase E: Intelligent Diagnostics (Code Quality)

### Why this phase first

The user explicitly asked for "syntax and grammar errors", "missing argument on a function", "wrong type for variable assignment", "unreachable code", "unused variables". Diagnostics are the highest-impact feature for making the LSP feel "smart" — they provide immediate, actionable feedback while coding. Completion improvements (Phase F) are valuable but secondary to "the editor tells me what's wrong before I compile."

### E1: Unused Variable Detection

**Objective:** Emit `DiagnosticSeverity.Hint` for local variables and parameters that are declared but never referenced.

**Data source:** Symbol table already tracks declarations with `Reference[]` arrays. A variable with zero references is unused. No new parsing needed.

**Scope:** Local variables (`DeclKind.Variable`), parameters (`DeclKind.Parameter`), and local functions (`DeclKind.Function`) within the current file. Class members and module-level symbols are excluded (they may be used externally).

**Exclusions (not unused):**
- Variables prefixed with `_` (Pike convention for intentionally unused)
- The `_` variable itself (Pike's wildcard)
- Variables in scope ID 0 (file/module scope) — these are potentially exported
- Parameters (Pike doesn't have an unused-parameter convention, but we emit at `Hint` level)
- Loop variables from `foreach` — they may be used implicitly

**Files:**
- Create: `server/src/features/lintRules/unusedSymbols.ts`
- Modify: `server/src/features/diagnostics.ts`
- Test: `tests/lsp/lint-unused.test.ts`

---

### E2: Unreachable Code Detection

**Objective:** Emit `DiagnosticSeverity.Warning` for statements that follow a `return`, `break`, or `continue` statement in the same block scope.

**Data source:** Tree-sitter AST. Walk each `block` node's children. If a `return_statement`, `break_statement`, or `continue_statement` has subsequent siblings, those siblings are unreachable.

**Scope:** Only within the same block. Does NOT track:
- Unreachable code across `if/else` branches (requires data flow)
- Unreachable code in `switch` without `break` (complex, Pike-specific)
- Code after `throw` (Pike doesn't have a `throw` keyword — uses `error()` function)

**Files:**
- Create: `server/src/features/lintRules/unreachableCode.ts`
- Modify: `server/src/features/diagnostics.ts`
- Test: `tests/lsp/lint-unreachable.test.ts`

---

### E3: Missing Return Statement Warning

**Objective:** Emit `DiagnosticSeverity.Hint` for functions/methods declared with a non-`void`/non-`mixed` return type that have at least one code path not ending in a `return`.

**Data source:** Symbol table has `declaredType` on function declarations (e.g., `int foo()`). Tree-sitter AST has the function body. Walk the body: if no `return_statement` exists anywhere in the body, the function may be missing a return.

**Scope:** Only flag functions with explicit return type annotations that are not `void`, `mixed`, `zero`, or `none`. Conservative: only flags when there are ZERO return statements in the body (not path analysis — that's a future improvement).

**Files:**
- Create: `server/src/features/lintRules/missingReturn.ts`
- Modify: `server/src/features/diagnostics.ts`
- Test: `tests/lsp/lint-missing-return.test.ts`

---

### E4: Unused Import/Inherit Detection

**Objective:** Emit `DiagnosticSeverity.Hint` for `inherit` and `import` declarations that are never referenced in the file.

**Data source:** Symbol table tracks `inherit`/`import` declarations with their imported names. If the imported name never appears as a reference prefix (e.g., `Stdio.FILE` has `Stdio` as the reference prefix), the import is unused.

**Scope:** Same-file only. An import that provides symbols used in other files is NOT unused — the import makes those symbols available.

**Files:**
- Create: `server/src/features/lintRules/unusedImports.ts`
- Modify: `server/src/features/diagnostics.ts`
- Test: `tests/lsp/lint-unused-imports.test.ts`

---

### E5: Lint Infrastructure — Fast Diagnostics Pipeline

**Objective:** Wire all lint rules into a unified pipeline that runs on every parse (immediately, before PikeWorker diagnostics). Results are merged with Pike diagnostics — lint diagnostics are superseded by Pike diagnostics on the same line (Pike is authoritative).

**Architecture:**
```
textDocument/didChange
  → tree-sitter parse (already happens)
  → runLintRules(tree, symbolTable) → Diagnostic[]  (NEW, <5ms)
  → publish immediately as pike-lsp-lint diagnostics
  → (existing) schedule PikeWorker diagnose after 500ms debounce
  → (existing) merge: Pike diagnostics supersede lint on same line
```

**Files:**
- Create: `server/src/features/lintRules/index.ts` (pipeline orchestrator)
- Modify: `server/src/features/diagnostics.ts` (merge lint + Pike diagnostics)
- Modify: `server/src/features/diagnosticManager.ts` (integrate lint into diagnostic cycle)
- Decision: `decisions/0028-lint-layer.md`

---

## Phase F: Intelligent Completion

### Why this phase second

Completion quality is the second most impactful feature for "smart" feel. The user asked for "autocompletion features, like function signatures." Current completion works but has gaps: no type-aware method resolution for `obj->method(`, no auto-import, no commit characters. Phase F closes these gaps.

### F1: Type-Aware Method Completion on Arrow/Dot Access

**Objective:** When typing `obj->` or `obj.`, resolve `obj`'s type and enumerate only members of that type (including inherited members). Currently works for simple cases but fails for:
- Variables initialized by function call (`Dog d = makeDog(); d->` should show Dog members)
- Method chains (`getContainer()->getItem()->` should resolve through return types)
- Stdlib types (`Stdio.FILE f; f->` should show File methods)

**Implementation:** Extend the existing `resolveMemberAccess` path in `completion.ts`. The `typeResolver.ts` already has `resolveType()` and `resolveTypeMembers()`. The gap is in how completion's dot/arrow handler invokes it — it tries `declaredType` and `assignedType` separately but doesn't follow the full resolution chain through function return types.

**Files:**
- Modify: `server/src/features/completion.ts` (enhance dot/arrow resolution)
- Modify: `server/src/features/typeResolver.ts` (ensure return-type resolution works transitively)
- Test: `tests/lsp/completion-typewise.test.ts`

---

### F2: Constructor Signature Help on `ClassName(`

**Objective:** When typing `Dog(`, show the `create` method's signature with parameter names and types. Currently the signature help tries to match the callee name to a top-level function — it doesn't look for constructors.

**Implementation:** In `signatureHelp.ts`, after the initial lookup fails, check if the callee matches a class name in the symbol table. If so, look for a `create` method in that class scope and use its parameters as the constructor signature.

**Files:**
- Modify: `server/src/features/signatureHelp.ts`
- Test: `tests/lsp/signature-constructor.test.ts`

---

### F3: Type-Aware Method Signature Help

**Objective:** When typing `obj->method(`, resolve `obj`'s type, find `method` in that type's class scope, and show `method`'s signature with parameters.

**Implementation:** In `signatureHelp.ts`, extend the callee extraction for `postfix_expr` with `->` operator. When the callee is `d->speak`, resolve `d`'s type, look up `speak` in that type's class members, and build the signature from its declaration.

**Files:**
- Modify: `server/src/features/signatureHelp.ts`
- Test: `tests/lsp/signature-method.test.ts`

---

### F4: Completion Commit Characters

**Objective:** Add `.` and `(` as commit characters so that selecting a completion item with `.` or `(` after it automatically commits and triggers the next completion (dot-access or function call).

**Implementation:** Add `commitCharacters: [".", "("]` to completion items where appropriate:
- Items with known class types get `.` and `->` (dot access continues)
- Function/method items get `(` (triggers signature help)

**Files:**
- Modify: `server/src/features/completionTrigger.ts` (add commitCharacters to `declToCompletionItem`)

---

### F5: Auto-Import Completion

**Objective:** When typing an undefined identifier, offer completion items that import the module providing that identifier. E.g., typing `FILE` suggests importing `Stdio` (which provides `FILE`).

**Implementation:** When no local match is found for an unqualified identifier:
1. Search `stdlib-autodoc.json` for symbols matching the typed name
2. For each match, create a completion item with `additionalTextEdits` that inserts `inherit Stdio;` (or the appropriate module) at the top of the file
3. Mark with `CompletionItemKind.Module` and detail showing the source

**Files:**
- Modify: `server/src/features/completion.ts` (add auto-import fallback)
- Test: `tests/lsp/completion-autoimport.test.ts`

---

## Phase G: Inlay Hints

### Why this phase third

Inlay hints provide the "writing" experience improvement the user described — they show inferred types and parameter names inline without the user having to hover. This is the "cherry on top" after diagnostics and completion are solid.

### G1: Type Inlay Hints for Variables

**Objective:** Show inferred types inline for variables declared without explicit type annotations.

Example:
```pike
x = Dog();          // shows: x: Dog = Dog();
result = compute(); // shows: result: mixed = compute();
```

**Implementation:** In `textDocument/inlayHint`, walk the symbol table for the file. For each variable declaration without a `declaredType` but with an `assignedType`, emit an inlay hint before the `=` sign showing the inferred type.

**Files:**
- Create: `server/src/features/inlayHints.ts`
- Modify: `server/src/features/navigationHandler.ts` (register handler)
- Modify: `server/src/server.ts` (register capability)
- Test: `tests/lsp/inlay-hints.test.ts`
- Decision: `decisions/0029-inlay-hints.md`

---

### G2: Parameter Name Hints at Call Sites

**Objective:** Show parameter names inline at call sites.

Example:
```pike
create("Rex", 5); // shows: create(name: "Rex", age: 5);
```

**Implementation:** At each `postfix_expr` with arguments, resolve the callee to its declaration. Extract parameter names from the declaration. Emit inlay hints before each argument showing the corresponding parameter name.

**Files:**
- Modify: `server/src/features/inlayHints.ts`
- Test: `tests/lsp/inlay-hints.test.ts` (extend)

---

## Phase H: PikeWorker Enhancement

### Why this phase alongside E-G

The Pike compiler is already producing rich diagnostics (type errors, wrong arity, undefined symbols). Two improvements make these more valuable:

### H1: Faster Diagnostic Turnaround

**Objective:** Reduce the latency between typing and seeing Pike's type errors.

**Approach:** Currently PikeWorker starts on first use (lazy) and diagnoses after 500ms debounce. Improvement: pre-warm the worker during background indexing so it's ready when the user starts editing. Also reduce debounce for small edits (single-line changes can be diagnosed faster).

**Files:**
- Modify: `server/src/features/pikeWorker.ts` (pre-warm API)
- Modify: `server/src/features/diagnosticManager.ts` (adaptive debounce)

---

### H2: Enrich Pike Diagnostics with Arity Information

**Objective:** When Pike reports "Wrong number of arguments to foo()", add the expected arity as a diagnostic data field and provide a quick-fix to add/remove arguments.

**Implementation:** Parse Pike's error message for the expected/actual argument count. Add as `Diagnostic.data`. The code action provider creates a `quickfix` that adds placeholder arguments or removes extras.

**Files:**
- Modify: `harness/Common.pmod/Common.pike` (enrich normalize_diagnostics)
- Modify: `server/src/features/codeAction.ts` (arity quick-fix)
- Test: `tests/lsp/codeaction-arity.test.ts`

---

## Implementation Order

The phases are ordered by impact and independence:

| Phase | Tasks | Impact | Dependencies |
|-------|-------|--------|-------------|
| E1 | Unused variable lint | High — instant feedback on dead code | None (uses existing symbol table) |
| E2 | Unreachable code lint | Medium — catches a common bug class | None (uses existing parse tree) |
| E3 | Missing return lint | Low — niche but useful | None |
| E4 | Unused import lint | Medium — cleanup guidance | None |
| E5 | Lint pipeline wiring | High — makes E1-E4 visible | E1-E4 |
| F1 | Type-aware completion | High — biggest "smart" improvement | None |
| F2 | Constructor signatures | Medium — common pattern | None |
| F3 | Method signatures | High — enables `obj->method(` help | F1 |
| F4 | Commit characters | Low — polish | None |
| F5 | Auto-import | Medium — reduces friction | None |
| G1 | Type inlay hints | Medium — "writing" experience | None |
| G2 | Parameter name hints | Medium — call site clarity | G1 |
| H1 | Faster diagnostics | Medium — perceived responsiveness | None |
| H2 | Arity quick-fix | Low — convenience | None |

**Recommended execution order:** E1 → E2 → E5 → F1 → F2 → F3 → H1 → G1 → E3 → E4 → F4 → F5 → G2 → H2

This front-loads the highest-impact items: unused variables and unreachable code (instant feedback), followed by type-aware completion and method signatures (intelligent suggestions).

---

## What We're NOT Building

Per the architecture skill and existing decisions:

- **Type checking in TypeScript.** We do NOT reimplement Pike's type system. The LSP catches structural issues (unused vars, unreachable code) but delegates all type errors to Pike's compiler.
- **Salsa-like incremental computation.** The Pike binary is the oracle. We don't build a reactive computation framework.
- **Data flow analysis.** No taint tracking, no null analysis, no alias analysis. These require a full type system implementation.
- **Full dead code elimination analysis.** We detect obviously unreachable code (after return/break/continue) but not complex dead paths (if-false branches, always-throwing functions).
- **Refactoring features** (extract function, inline variable, etc.) — out of scope for this plan.
- **Type narrowing** (narrowing `mixed` to `string` inside `if (stringp(x))`) — requires control flow analysis.

---

## Corpus Files Needed

New corpus files for testing each feature:

| File | Purpose |
|------|---------|
| `lint-unused-var.pike` | Local variables with zero references |
| `lint-unused-param.pike` | Unused parameters |
| `lint-unreachable-return.pike` | Code after return statements |
| `lint-unreachable-break.pike` | Code after break/continue |
| `lint-missing-return.pike` | Non-void functions without return |
| `lint-unused-import.pike` | Import/inherit without usage |
| `completion-typewise.pike` | Type-aware dot/arrow completion |
| `signature-constructor.pike` | Constructor call signatures |
| `signature-method.pike` | Method call signatures with type resolution |
