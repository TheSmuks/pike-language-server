# Decision 0016: Rename Provider

**Date:** 2026-04-28
**Status:** Accepted

## Context

Phase 6 deferred rename with three blockers (decision 0013-verification §V6):
1. Arrow/dot type inference — resolved in Phase 7
2. Import dependency tracking — resolved in Phase 7
3. Cross-file scope verification — manageable with existing infrastructure

The LSP already has all resolution infrastructure:
- `getDefinitionAt()` — finds declaration at cursor
- `getReferencesTo()` — same-file references
- `WorkspaceIndex.getCrossFileReferences()` — cross-file references
- `resolveMemberAccess()` — arrow/dot target resolution

Rename combines `references` output with `WorkspaceEdit`.

## Decision

Implement `textDocument/rename` and `textDocument/prepareRename` as a thin layer over existing infrastructure.

### Architecture

**Module:** `server/src/features/rename.ts` (~190 LOC)

Pure functions, no state, no PikeWorker:

1. `prepareRename(table, line, char)` → `{ range, placeholder }` or null
   - Uses `getDefinitionAt()` to find the symbol
   - Returns null for non-renameable positions

2. `getRenameLocations(table, uri, line, char, index)` → `{ locations, oldName }` or null
   - Finds declaration via `getDefinitionAt()`
   - Tries `getCrossFileReferences()` first (cross-file)
   - Falls back to `getReferencesTo()` (same-file)
   - Returns all locations (declaration + references)

3. `buildWorkspaceEdit(locations, newName)` → `WorkspaceEdit`
   - Groups locations by URI
   - Creates `TextEdit[]` per document

4. `validateRenameName(newName)` → error string or null
   - Checks: non-empty, valid Pike identifier, not a reserved word

### Pike keyword validation

Reserved words sourced from Pike lexer (`src/lexer.h` keyword switch). Also blocks the `__foo__` double-underscore pattern (Pike lexer treats all such patterns as reserved).

### Scope-awareness

Rename reuses the same scope-aware reference resolution as `textDocument/references`. Same-name identifiers in different scopes are not renamed.

### Limitations

- **Untyped arrow/dot access**: `mixed x; x->method` — name-based matching only (same as references provider)
- **No module/file renaming**: File system operations out of scope
- **No string content renaming**: No renaming inside string literals
- **No preprocessor renaming**: `#define`, `#if` out of scope

## Alternatives Considered

1. **Text-based rename**: Simple find-and-replace across files. Rejected: renames homonyms, not scope-aware.
2. **PikeWorker-based rename**: Use Pike for verification. Rejected: adds subprocess dependency, Pike has no rename API.
3. **Postponing rename further**: Rejected: two of three blockers resolved, infrastructure ready, high user value for shared codebase.
