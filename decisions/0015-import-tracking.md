# 0015: Import Dependency Tracking

**Status**: Accepted
**Date**: 2026-04-28
**Depends on**: 0010 (cross-file resolution), 0014 (type resolution, DeclKind `'import'`)

## Context

Phase 4 introduced `WorkspaceIndex` with forward/reverse dependency graphs, but only for `inherit` declarations. `import` declarations were mapped to `DeclKind 'inherit'` alongside actual inherits, and `extractDependencies()` had a TODO for import edges.

Phase 7 introduced `DeclKind 'import'` to distinguish imports from inherits. The `extractDependencies()` function now handles both.

This decision documents the semantics and edge cases of import dependency tracking.

## Decision

### 1. Import declarations create dependency edges

When file A contains `import Foo`, a dependency edge A→B is created where B is the resolved URI of `Foo`. This mirrors the existing inherit dependency behavior.

### 2. Resolution strategy

Import declarations use `resolveImport()` which delegates to `resolveModule()`. This searches:
1. Workspace module paths (relative to current file, workspace root)
2. System module paths (pike home, pike include paths)

Inherit declarations use `resolveInherit()` which handles string literals differently. Both end up in the dependency set.

### 3. Deduplication

Both inherit and import edges go into the same `Set<string>` per file entry. If a file both inherits and imports the same module, only one edge is created (Set semantics).

### 4. Invalidation

When a file is re-indexed, its old dependency set is removed and a new one is computed. Both inherit and import edges are removed and re-added. The reverse dependency graph (`dependents`) is updated accordingly.

### 5. Cross-file propagation

When file B is edited, all files with B in their dependency set (both inherit and import dependents) are re-diagnosed. The `propagateToDependents()` method in `DiagnosticManager` uses the unified reverse dependency graph — no distinction between inherit and import dependents.

## What changed

| Before Phase 7 | After Phase 7 |
|----------------|---------------|
| `import_decl` mapped to `kind: 'inherit'` | `import_decl` maps to `kind: 'import'` |
| `extractDependencies()` only handled `kind === 'inherit'` with string-literal check | `extractDependencies()` handles both `kind === 'inherit'` and `kind === 'import'` |
| Import edges missing from dependency graph | Import edges included |

## Consequences

- Editing an imported module triggers re-diagnosis of importers
- The reverse dependency graph is more complete, improving cross-file propagation
- Import declarations are distinguishable from inherit declarations in the symbol table
- All consumers of `kind === 'inherit'` were audited and updated to handle both kinds where appropriate

## What this does NOT deliver

- Import tracking for dynamic module loading (runtime module names computed from expressions)
- Import tracking for `.so` binary modules (ModuleResolver skips these)
- Layer-2 integration test with real workspace files (deferred — requires `@vscode/test-electron`)
