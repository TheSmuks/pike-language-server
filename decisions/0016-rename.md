# Decision 0016: Rename Provider

**Date:** 2026-04-28
**Status:** Accepted (amended — protected symbol rejection added)

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

**Module:** `server/src/features/rename.ts` (~260 LOC)

Pure functions, no state, no PikeWorker:

1. `prepareRename(table, line, char, protectedNames?)` → `{ range, placeholder }` or null
   - Uses `getDefinitionAt()` to find the symbol
   - Returns null for non-renameable positions
   - Rejects stdlib/predef protected names
   - Rejects Pike keywords

2. `getRenameLocations(table, uri, line, char, index, protectedNames?)` → `{ locations, oldName }` or null
   - Finds declaration via `getDefinitionAt()`
   - Rejects stdlib/predef protected names
   - Tries `getCrossFileReferences()` first (cross-file)
   - Falls back to `getReferencesTo()` (same-file)
   - Returns all locations (declaration + references)

3. `buildWorkspaceEdit(locations, newName)` → `WorkspaceEdit`
   - Groups locations by URI
   - Creates `TextEdit[]` per document

4. `validateRenameName(newName)` → error string or null
   - Checks: non-empty, valid Pike identifier, not a reserved word

### Protected symbol rejection (amendment)

Rename targets that match stdlib or predef names are rejected to prevent breakage:

- **Predef builtins** (283 entries from `predef-builtin-index.json`): `write`, `search`, `strlen`, etc.
  These are C-level functions compiled into the Pike runtime. Renaming them in user code
  would break calls to the original builtin without affecting the runtime.
- **Stdlib symbols** (5,471 entries from `stdlib-autodoc.json`): The unqualified name extracted
  from each FQN (e.g., `predef.Array.diff` → `diff`). Renaming a user function named `diff`
  would shadow the stdlib version; the rename protects against accidental breakage.

Implementation: `server.ts` builds a `Set<string>` once at module load via `buildProtectedNames()`.
This set is passed as `ProtectedNames` (a `ReadonlySet<string>`) to `prepareRename` and
`getRenameLocations`. Both functions return null when the targeted symbol's name is in the set.

### Pike keyword validation

Reserved words sourced from Pike lexer (`src/lexer.h` keyword switch). Also blocks the `__foo__` double-underscore pattern (Pike lexer treats all such patterns as reserved).

### Scope-awareness

Rename reuses the same scope-aware reference resolution as `textDocument/references`. Same-name identifiers in different scopes are not renamed.

### Limitations

- **Untyped arrow/dot access**: `mixed x; x->method` — name-based matching only (same as references provider)
- **No module/file renaming**: File system operations out of scope
- **No string content renaming**: No renaming inside string literals
- **No preprocessor renaming**: `#define`, `#if` out of scope
- **False positives on protected names**: If a user declares `int write = 5;`, rename rejects it because `write` is a predef builtin. This is conservative-by-design.

## Alternatives Considered

1. **Text-based rename**: Simple find-and-replace across files. Rejected: renames homonyms, not scope-aware.
2. **PikeWorker-based rename**: Use Pike for verification. Rejected: adds subprocess dependency, Pike has no rename API.
3. **Postponing rename further**: Rejected: two of three blockers resolved, infrastructure ready, high user value for shared codebase.
4. **No stdlib/predef rejection**: Allow renaming user symbols that shadow stdlib. Rejected: on a shared server with multiple users editing the same codebase, accidentally renaming a shadowing symbol breaks the mapping between user code and stdlib silently.