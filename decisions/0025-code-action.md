# 0025: Code Action

**Status**: Accepted
**Date**: 2026-05-04
**Decision Maker**: Pike LSP team

## Context

The LSP `textDocument/codeAction` request lets clients offer quick-fixes based on diagnostics. Pike has common errors with known fixes: unused variables and missing imports.

The server already runs Pike compilation for diagnostics via PikeWorker. The question is how to translate Pike diagnostics into actionable quick-fixes.

## Decision

### Quick-fix registry

Implement an extensible `QuickFixRegistry` that maps diagnostic codes or patterns to fix actions. Initial entries:

| Diagnostic | Fix | Implementation |
|------------|-----|----------------|
| Pike: "Unknown identifier" | Add missing import | Use `ModuleResolver` to find the identifier in stdlib, add `import <Module>;` |
| Pike: "Unused variable" | Remove unused variable | Delete the variable declaration and all its references |
| Pike: "Shadows declaration" | Rename variable | Offer rename to a unique name |

### Add-missing-import fix

1. When Pike reports an unknown identifier (e.g., `Stdio.File`), check if it's in the stdlib index
2. If found, determine the containing module (e.g., `Stdio` contains `File`)
3. Generate an `import Stdio;` statement — add to top of file or merge with existing `import Stdio;`
4. Return a `WorkspaceEdit` with the import insertion

### Remove-unused-variable fix

1. When Pike reports an unused variable, find the declaration in the symbol table
2. Check that the variable has no references (the diagnostic confirms this)
3. Delete the declaration line (or just the variable if part of a multi-variable declaration)
4. Return a `WorkspaceEdit` removing the declaration

### Extensibility

New quick-fixes register via the registry:
```typescript
registry.register('P0001', async (ctx) => { /* fix logic */ });
```

## Consequences

### Positive

- Extensible — new fixes add one entry to the registry, no core changes needed
- Add-import is high-value: Pike's module system requires explicit imports, and knowing what to add is non-obvious
- Remove-unused-var is high-value: Pike's strict_types mode flags these as warnings

### Negative

- Some diagnostics have ambiguous fixes (e.g., "Wrong type" could mean fix the value or fix the annotation)
- Import insertion must be idempotent — merging with existing imports requires care

### Neutral

- Code actions are triggered by diagnostics — no new request type needed
- The fixes use existing infrastructure (ModuleResolver, symbol table, rename)