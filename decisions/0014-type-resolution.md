# 0014: Type Resolution Architecture

**Status**: Accepted
**Date**: 2026-04-28

## Context

Phase 7 P1. Arrow/dot access references (`obj->member`, `Module.function`) currently produce `resolvesTo: null` in the symbol table. This blocks:
- Go-to-definition through arrow/dot access
- Accurate find-references for class members
- Completion on typed variables (same-file types work, cross-file and stdlib types don't)
- Rename (the most common rename targets are arrow/dot accessed members)

### Constraints

1. **No PikeWorker usage.** Type resolution uses tree-sitter + pre-built indices + WorkspaceIndex only. The PikeWorker is a shared singleton; type resolution runs on every symbol table build and must be fast.
2. **No inferred types.** Only declared types from type annotations are resolved. `mixed`, `object`, and untyped variables remain unresolved.
3. **No compound types.** `array(Animal)`, `mapping(string:int)`, `multiset(string)` are not decomposed. Only simple named types and qualified types (`Stdio.File`) are resolved.
4. **Graceful degradation.** If resolution fails (file not indexed, type not found), the reference stays `resolvesTo: null` with `confidence: 'low'`. This matches current behavior exactly.
5. **Resource budget.** No new subprocesses, no new timers, no persistent caches beyond the per-symbol-table resolution pass. Memory impact < 10 KB for a 100-file workspace.
6. **File size guideline.** New module `typeResolver.ts` scoped at ~300 LOC.

### Available infrastructure

- `Declaration.declaredType` — type annotation text on variables/parameters (string, e.g., `"Animal"`, `"Stdio.File"`)
- `SymbolTable` with scopes, declarations, references, `wireInheritance()` already links inherit declarations to inherited scopes
- `WorkspaceIndex` with cross-file symbol table lookup, `resolveInherit()`, `resolveImport()`, `resolveModule()`
- Stdlib prefix index (`getStdlibChildrenMap()`) — maps FQN prefixes to member names + kinds
- `ModuleResolver` — resolves module paths, import paths, inherit paths
- `resolveTypeMembers()` in completion.ts — existing same-file type resolution (inlined, needs extraction)

### What currently works

- Same-file declared type resolution: `Animal a; a->` resolves to Animal class members via inline `resolveTypeMembers()` in completion.ts
- Class member completion: `Animal a; a->` shows Animal's members (same file only)
- Arrow/dot references collected in symbol table with `kind: 'arrow_access' | 'dot_access'` but `resolvesTo: null`

### What doesn't work

- Cross-file type resolution: `Animal a` where Animal is inherited from another file → null
- Stdlib type resolution: `Stdio.File f; f->` → null (completion shows members via stdlib prefix index, but definition/references can't navigate)
- Qualified type resolution: `Stdio.File` as a type annotation → null
- Return type resolution: `Calculator calc = Calculator(); calc->` → null
- Arrow/dot go-to-definition: `obj->method` → no navigation
- Arrow/dot reference resolution: `obj->method` not linked to the method declaration

## Decision

### 1. New module: `typeResolver.ts`

A pure function module with no class, no state, no side effects.

```typescript
// Resolve a declared type name to the Declaration of the target class/type.
// Returns null if the type cannot be resolved.
export function resolveType(
  typeName: string,
  context: TypeResolutionContext,
): Declaration | null;

// Resolve an arrow/dot access reference to its target declaration.
// Returns the Declaration of the member being accessed, or null.
export function resolveMemberAccess(
  ref: Reference,
  refIndex: number,
  table: SymbolTable,
  context: TypeResolutionContext,
): Declaration | null;

export interface TypeResolutionContext {
  table: SymbolTable;
  uri: string;
  index: WorkspaceIndex;
  stdlibIndex: Record<string, { signature: string; markdown: string }>;
}
```

### 2. Resolution chain for `resolveType()`

The function resolves a type name through this ordered chain:

1. **Same-file class.** Look up `typeName` in `table.declarations` where `kind === 'class'`. Return the class declaration.

2. **Cross-file class via inherit.** For each `inherit` declaration in the table, resolve the inherit target via `WorkspaceIndex.resolveInherit()`. Get the target file's symbol table. Find a class declaration matching `typeName`. Return it.

3. **Cross-file class via import.** For each `import` declaration in the table, resolve via `WorkspaceIndex.resolveImport()`. Get the target file's symbol table. Find a class declaration matching `typeName`. Return it.

4. **Qualified type (e.g., `Stdio.File`).** Split on `.`. The first segment is a module name — resolve via `WorkspaceIndex.resolveModule()`. If found, look for a class matching the second segment in the target file's declarations. Recurse for deeper segments.

5. **Stdlib type.** Check if `predef.<typeName>` has entries in the stdlib index. If so, return a synthetic declaration representing the stdlib type (enough for member enumeration, not for navigation).

The chain stops at the first successful resolution. Each step adds one level of recursion depth.

### 3. Resolution chain for `resolveMemberAccess()`

For an arrow/dot reference `obj->member`:

1. **Find the LHS declaration.** Walk backward from the reference position to find the identifier on the left side of `->` or `.`. Look it up in the symbol table's scope chain.
2. **Resolve the LHS type.** If the LHS is a variable/parameter with `declaredType`, call `resolveType()`.
3. **Find the class scope.** If the type resolves to a class declaration, find its class scope.
4. **Find the member.** Search the class scope's declarations for one matching the reference name.
5. **Inherited members.** If not found in the immediate class scope, search inherited scopes (already wired by `wireInheritance()`).

For dot access `Module.member`:

1. **Resolve LHS as module.** Try `WorkspaceIndex.resolveModule(lhsText)`.
2. **Find member in target file.** Get target symbol table, search file-scope declarations for matching name.
3. **Fallback: class name.** If LHS is a class name in scope, resolve as arrow access (classes are namespaces for static members in Pike).

### 4. Recursion guard

Both functions share a depth counter (passed internally, not exposed). Maximum depth: 5. Returns null when exceeded.

This handles:
- `A a; B b; a = b;` — no recursion (type names are different)
- Circular type aliases (theoretical, Pike doesn't have these natively but typedef could chain)
- Deep qualified types like `A.B.C.D.E.F` — depth limit cuts off at 5 segments

### 5. Symbol table integration

After `buildSymbolTable()` and `wireInheritance()`, a new post-build pass resolves arrow/dot access references:

```typescript
// In symbolTable.ts, new exported function
export function resolveAccessReferences(
  table: SymbolTable,
  context: TypeResolutionContext,
): void;
```

This function iterates all references with `kind === 'arrow_access' | 'dot_access'` and `resolvesTo === null`. For each, it calls `resolveMemberAccess()`. If resolved, it sets `resolvesTo` to the target declaration ID and `confidence` to `'high'`.

The function mutates the existing references in place. This is safe because:
- The symbol table is a single-owner snapshot (immutable-snapshot pattern from decision 0009)
- No other code has a reference to this table yet (it was just built)
- The function runs synchronously before the table is published

### 6. Completion wiring

`resolveTypeMembers()` in completion.ts is replaced by calls to `resolveType()` from typeResolver.ts. The existing inline logic is removed.

`completeMemberAccess()` gains:
- Cross-file class resolution: `Animal a` where Animal is inherited → resolves members
- Stdlib type resolution: `Stdio.File f; f->` → shows File members from stdlib index
- Return type resolution: `Calculator calc = Calculator(); calc->` → resolves Calculator type

### 7. Definition provider wiring

`definitionProvider` in server.ts gains arrow/dot access handling:

When the cursor is on an arrow/dot access reference (position matches an `arrow_access` or `dot_access` reference in the symbol table), and the reference has `resolvesTo !== null`, navigate to the resolved declaration.

Cross-file: if the resolved declaration is in a different file, return a location in that file.

### 8. Hover provider wiring

`declForHover()` in server.ts gains arrow/dot access handling:

When the cursor is on an arrow/dot member name, look up the reference → follow `resolvesTo` → get the declaration → render hover using existing tier logic (AutoDoc → stdlib → tree-sitter).

### 9. DeclKind change: add 'import'

To properly distinguish import declarations from inherit declarations (required for correct resolution chain), add `'import'` to `DeclKind`:

- `import_decl` maps to `kind: 'import'` (was `'inherit'`)
- `inherit_decl` maps to `kind: 'inherit'` (unchanged)
- `collectInheritDecl()` renamed to `collectInheritOrImportDecl()` — handles both node types with same logic (both have a `path` field)
- All code that currently checks `kind === 'inherit'` and should match both imports and inherits is updated to `kind === 'inherit' || kind === 'import'`

Code that should match only inherits (e.g., `wireInheritance()`) continues checking `kind === 'inherit'` only.

Code that should match only imports (e.g., import resolution in dependency tracking) checks `kind === 'import'`.

Code that should match both (e.g., `getSymbolsInScope` skipping both, `extractDependencies` handling both) checks both kinds.

### 10. Latency targets

| Path | Target | Rationale |
|------|--------|-----------|
| Same-file type resolution | < 1ms | In-memory symbol table lookup |
| Cross-file type resolution | < 10ms | WorkspaceIndex lookup + symbol table fetch |
| Stdlib type resolution | < 5ms | HashMap lookup in stdlib prefix index |
| Full resolveAccessReferences pass | < 50ms per file | One pass over all references |

These targets are met by design: no I/O, no subprocess, no network.

## Consequences

- Arrow/dot access references get `resolvesTo` populated for declared-type cases
- Go-to-definition works through arrow/dot access
- Completion quality improves for cross-file and stdlib typed variables
- Rename prerequisite partially delivered (arrow/dot access resolution is one of two blockers)
- No PikeWorker usage added
- `DeclKind` gains `'import'`, requiring updates to all consumers of `kind === 'inherit'`
- The type resolver is a separate module, not embedded in completion.ts — it serves completion, definition, hover, and references

## What this does NOT deliver

- Inferred types for `mixed`/`object`/untyped variables (still null)
- Compound type decomposition (`array(Animal)`, `mapping(string:int)`)
- Chained member access (`a->b->c` where `b` returns a typed object) — limited to one level of indirection initially
- Generic/parameterized types
- PikeWorker-based type inference (available but unused)

## Rename prerequisite status

After this decision is implemented:
- [x] Arrow/dot access type resolution → delivered
- [ ] Import dependency tracking → Phase 7 P2
- [ ] Cross-file scope verification → future phase
- [ ] Rename implementation → future phase (~600 LOC)
