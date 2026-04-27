# Decision 0008: LSP-vs-Pike Symbol Comparison Policy

**Date:** 2026-04-27
**Status:** Accepted
**Context:** Phase 2 exit verification — structural differences between tree-sitter and Pike symbol extraction

## Findings

Three sources produce documentSymbol-like data:

| Source | Scope | Report level |
|--------|-------|-------------|
| **Tree-sitter** (LSP server) | Parse tree | Top-level + nested class members |
| **Pike `indices(program)`** (harness) | Compiled program | Top-level only |
| **Pike `indices(instance)`** | Instantiated class members | Nested |

The comparison uses tree-sitter vs `indices(program)` because both operate at file scope without instantiation.

## Structural Differences

### 1. Enum handling

**Pike**: Flattens enum members to top-level variables. Reports enums as `unknown` kind.
```
variable   BLUE     line:?
variable   GREEN    line:?
unknown    Color    line:?
```

**Tree-sitter**: Nests enum members as `EnumMember` children of `Enum`.
```
Enum Color
  EnumMember RED
  EnumMember GREEN
  EnumMember BLUE
```

**Policy**: Tolerated. The LSP server follows tree-sitter's structure (nested), which matches LSP client expectations (VSCode Outline shows enums with members). Pike's flat view is a runtime artifact — it's how Pike's module system works, not how the source is structured.

### 2. Inheritance

**Pike**: Does not report `inherit` lines as symbols.
**Tree-sitter**: Reports `inherit X` as `Module X` children of the inheriting class.

**Policy**: Tree-sitter's `inherit` symbols are filtered by `TS_ONLY_KINDS` (Module, TypeParameter) in the comparison. In the LSP Outline, showing inheritance as child nodes is useful for navigation.

### 3. Error files

**Pike**: Fails to compile → no symbols.
**Tree-sitter**: Produces partial parse tree → symbols from valid portions.

**Policy**: Error files are excluded from the cross-check. The comparison only runs on files where Pike compilation succeeds (`hasSymbols` filter).

### 4. Cross-file files

**Pike**: Files that import/inherit from other corpus files compile with cross-file flags, but `indices(program)` may return empty depending on module resolution.
**Tree-sitter**: Parses each file independently, finds declarations regardless.

**Policy**: Cross-file files are excluded from cross-check via `hasSymbols` filter.

### 5. Class members

**Pike `indices(program)`**: Reports only top-level declarations. Class members (create, methods, variables) are not visible at program scope.
**Tree-sitter**: Reports class members as nested children.

**Policy**: The comparison is top-level only. Class member comparison requires `indices(instance)` which needs instantiation — deferred to Phase 3 when the harness supports per-class member extraction.

## Comparison Specificity

The bidirectional check is:
1. **Pike → LSP**: Every Pike symbol with kind `class` or `function` must exist in LSP top-level symbols.
2. **LSP → Pike**: Every LSP top-level symbol with kind other than `Module` or `TypeParameter` must exist in Pike snapshot.

This is intentionally narrow. It verifies the high-confidence subset:
- Top-level class and function declarations are unambiguous — both systems agree.
- Enum names are verified LSP→Pike but not Pike→LSP (because Pike reports them as `unknown`).
- Enum members, class members, and inherit/import lines are not compared.

## Consequences

- The comparison catches missing or misnamed top-level classes and functions — the most common documentSymbol bug.
- The comparison does not catch incorrect nesting, wrong symbol kinds for class members, or enum member ordering issues.
- Phase 3 will add `indices(instance)` extraction, enabling per-class member comparison.
- If tree-sitter's enum/member nesting proves wrong for VSCode's Outline view, this is a Phase 3 correction.
