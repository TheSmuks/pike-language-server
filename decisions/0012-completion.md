# 0012: Completion Provider

**Status**: Accepted
**Date**: 2026-04-27

## Context

Phase 6 P1. The LSP currently provides hover, definition, references, and document symbols — but no completion. Completion is the most-requested LSP feature and the highest UX value add.

### Constraints

1. ~93% of completions resolve without the Pike worker (tree-sitter + pre-built indices). The completion provider MUST NOT block on the worker in the common case.
2. Tree-sitter symbol tables guarantee structural correctness — suggested symbols actually exist in scope. The failure mode is *missing* completions, not *wrong* completions.
3. The Pike worker is a singleton with FIFO queueing. Completion requests must not saturate it.
4. File size guideline: 500 lines per module. Completion logic should be in `features/completion.ts`, not in server.ts.
5. Must pass the existing 917 tests with no regressions.

### Available infrastructure

- `SymbolTable` with scopes, declarations, references, inheritance wiring
- `WorkspaceIndex` with cross-file module/inherit resolution
- Stdlib index: 5,505 symbols keyed by `predef.<Module>.<Class>.<member>` FQN
- Predef builtin index: 283 symbols keyed by bare function name
- Tree-sitter parse tree for position-aware node inspection

## Decision

### Trigger characters

`.` `>` `:` — plus manual invocation (Ctrl+Space).

In the handler, check preceding character(s) to distinguish:
- `.` → dot completion (module member / struct member)
- `>` preceded by `-` → arrow completion (`obj->member`)
- `:` preceded by `:` → scope completion (`Foo::member`)

### Completion sources (ordered by priority)

1. **Local scope**: parameters, local variables, functions, classes in scope at cursor position. Walk the scope chain from innermost to file scope.
2. **Class members**: when inside a class, add all member declarations. Include inherited members (via `inheritedScopes`).
3. **Inherited (cross-file)**: resolve `inherit` declarations via `WorkspaceIndex.resolveInherit()`, get target file's symbol table, enumerate class scope declarations.
4. **Imported modules**: resolve `import` declarations via `WorkspaceIndex.resolveImport()`, get target file's top-level declarations.
5. **Stdlib members**: for dot/arrow/scope access on a known type, enumerate matching FQN prefixes from the stdlib index.
6. **Predef builtins**: bare names matching from the 283-entry index.
7. **Top-level stdlib**: for unqualified completion, offer stdlib module/class names.

### Completion kinds

For dot/arrow/scope access, resolve the left-hand side to determine context:

| Context | How resolved | Sources |
|---------|-------------|---------|
| `expr.` (dot on expression) | Resolve declared type of expr → class scope | Symbol table + WorkspaceIndex |
| `expr->` (arrow on expression) | Same as dot — Pike uses `->` for all object access | Same |
| `Module.` (dot on module name) | Resolve module path via WorkspaceIndex | WorkspaceIndex + stdlib |
| `Foo::` (scope on identifier) | Find inherit declaration matching name → target scope | Symbol table + WorkspaceIndex |
| `local::` / `::` (bare scope) | Find enclosing class scope → inherited scopes | Symbol table |

### Unqualified completion (no trigger character, or identifier prefix)

When the cursor is on an identifier (or at a position where an identifier could start):

1. Walk the scope chain from innermost to file scope, collecting all declarations.
2. For class scopes, include inherited members.
3. For the file scope, include imported symbols (resolve imports).
4. Add predef builtin names.
5. Add top-level stdlib module names (first segment after `predef.`).
6. Filter by prefix match if the user has typed partial text.

### Stdlib prefix matching

The stdlib index is a flat `Record<string, {signature, markdown}>`. For completion, we need prefix-based enumeration:

- Build a secondary index at server init: `Map<string, CompletionMember[]>` mapping FQN prefixes to their direct child names + kinds.
- E.g., `predef.Stdio.File` → `[{name: "read", kind: "method"}, {name: "open", kind: "method"}, ...]`
- Cost: O(N) once at startup. Memory: ~500KB (names are short strings).
- This secondary index is built in `completion.ts` and exported as a lazy-initialized singleton.

### Data flow

```
connection.onCompletion(params)
  → Get document, get symbol table (via getSymbolTable)
  → Get tree-sitter node at position
  → Determine completion context (unqualified / dot / arrow / scope)
  → If dot/arrow/scope: resolve left-hand side, collect members
  → If unqualified: collect all symbols in scope
  → Merge with stdlib/predef matches
  → Deduplicate by name (prefer local over inherited over stdlib)
  → Sort by proximity (local > class > inherited > imported > stdlib > predef)
  → Return CompletionList
```

### Latency targets

| Path | Target | Rationale |
|------|--------|-----------|
| Unqualified (local scope only) | < 10ms | Scope walk is O(scopes × declarations) |
| Dot/arrow on declared type | < 20ms | Scope walk + stdlib prefix lookup |
| Dot/arrow on stdlib type | < 30ms | Stdlib prefix lookup only |
| Cross-file inherit | < 50ms | WorkspaceIndex lookup + symbol table fetch |

### API surface

New file: `server/src/features/completion.ts`

```typescript
// Main entry point — called from server.ts
export function getCompletions(
  table: SymbolTable,
  tree: Tree,
  line: number,
  character: number,
  context: {
    index: WorkspaceIndex;
    stdlibIndex: Record<string, { signature: string; markdown: string }>;
    predefBuiltins: Record<string, string>;
    uri: string;
  },
): CompletionItem[];
```

New export from `symbolTable.ts`:

```typescript
// Enumerate all declarations visible at a position
export function getSymbolsInScope(
  table: SymbolTable,
  line: number,
  character: number,
): Declaration[];
```

### Registration in server.ts

```typescript
capabilities: {
  // ...existing...
  completionProvider: {
    triggerCharacters: ['.', '>', ':'],
  },
}
```

Handler follows the same flat pattern as hover/references.

## Consequences

- Completion is available for the most common Pike editing scenarios without Pike worker involvement.
- The secondary stdlib index adds ~500KB to server memory, built once at startup.
- Cross-file completion requires the target file to have been opened/indexed. Unindexed files produce no cross-file completions (graceful degradation).
- `getSymbolsInScope` is a new general-purpose API that could also power improved hover context in the future.

## Worker dependency matrix

| Scenario | Worker needed? | Current behavior | Precision |
|----------|---------------|-----------------|-----------|
| Local variables and parameters | No | Full — all visible declarations enumerated | Exact |
| File-scope declarations | No | Full — top-level functions, classes, variables | Exact |
| Class members (same file) | No | Full — scope walk includes inheritedScopes | Exact |
| Inherited members (same file) | No | Full — wireInheritance links class scopes | Exact |
| Cross-file inherited members | No | WorkspaceIndex resolves target file, enumerates declarations | Exact (if target indexed) |
| Imported module members | No | WorkspaceIndex resolves import path, enumerates target file | Exact (if target indexed) |
| Stdlib module members (dot access) | No | Secondary stdlib prefix index (built lazily, ~4ms first time) | Exact |
| Predef builtins (unqualified) | No | Flat lookup in prebuilt index (283 symbols) | Exact |
| Declared-type member access (`Animal a; a->`) | No | **Not resolved** — symbol table does not track type annotations | None (0 items) |
| Inferred-type member access (`mixed x; x->`) | No | **Not resolved** — no type information available | None (0 items) |
| Expression return type (`foo()->`) | No | **Not resolved** — would need declared return type lookup | None (0 items) |

**Summary:** Worker-dependent scenarios all return empty results in v1. The LSP never calls the worker for completion. This means declared-type member access (the `obj->member` pattern) is the most significant gap — users get 0 suggestions after `->` on typed variables. This is an honest answer ("we don't know the members") rather than a wrong one.

**Future improvement:** Track type annotations in the symbol table (phase 6+). The `Declaration` type would gain an optional `declaredType` field. Then `resolveTypeMembers()` could look up the class scope by name. This requires no worker — just symbol table enhancement.

## Ranking algorithm

Completion items are sorted by `sortText` with priority tiers:

| Tier | Sort prefix | Source | Example |
|------|------------|--------|---------|
| 0 | `0000` | Local scope (parameters, variables, functions in scope chain) | `local_var`, `param`, `alpha` |
| 10 | `0010` | Stdlib member (from dot/arrow/scope access) | `File`, `read_file` |
| 20 | `0020` | Cross-file imported symbols | Members of imported module |
| 30 | `0030` | Predef builtins | `write`, `werror`, `sin` |
| 40 | `0040` | Stdlib top-level modules | `Stdio`, `Array`, `String` |

Within each tier, items are sorted alphabetically by name.

**What's not implemented:**
- Recently used identifiers are not ranked higher (no MRU tracking)
- Prefix matching doesn't prioritize exact-prefix over substring (the LSP client handles this filtering)
- No fuzzy matching

## Latency measurements

Measured on AMD Ryzen 7 3700X, Node.js 22:

| Path | File size | Cold (ms) | Warm (ms) | Target |
|------|-----------|-----------|-----------|--------|
| Unqualified | 7 lines | 6.04 | 0.52 | < 10ms |
| Unqualified | 272 lines | 3.80 | 0.66 | < 10ms |
| Unqualified | 1882 lines | 5.30 | 2.61 | < 50ms |
| Dot access (Stdio.) | — | 8.28* | 0.06 | < 30ms |
| Scope access (Base::) | — | 2.33 | 0.15 | < 50ms |

*Cold dot access includes stdlib secondary index build (~4ms). Subsequent dot accesses: 0.06ms.

All targets from the original design are met.

## Cancellation

The completion handler checks `CancellationToken.isCancellationRequested` at three points:
1. Entry — before any work
2. After symbol table lookup — before tree-sitter parse
3. After tree-sitter parse — before completion computation

This ensures that fast typing cancels stale completion requests before they produce results. The vscode-languageserver framework delivers `$/cancelRequest` notifications, which set `isCancellationRequested` on the token.

## Audit findings (10-position ground truth)

### Bugs found and fixed

| Bug | Positions affected | Fix |
|-----|-------------------|-----|
| Operator symbols (backtick identifiers) in predef completions | All unqualified | Added `isCompletableIdentifier()` filter — rejects names starting with backtick, pure operators, brackets |
| Trailing dot/arrow ERROR nodes (`Stdio.\n`, `a->\n`) | 3, 7 | `findLhsBeforePosition()` now handles ERROR nodes and anonymous operator tokens, walking previous siblings |
| Foreach loop variables not captured | 9 | Fixed `collectForeachStatement()` — `foreach_lvalues` is an unnamed child, not a named field. Fixed `collectForeachLvalues()` — identifiers are siblings of type nodes, not children |

### Remaining gaps (by design)

| Gap | Positions affected | Behavior |
|-----|-------------------|----------|
| Declared type not tracked in symbol table | 2 | After `obj->` on typed variable, returns 0 items. User sees no suggestions. |
| Mixed type member access | 10 | After `mixed->`, returns 0 items. Correct — type is unknown. |
| Scope resolution for nested module paths | — | `Stdio.File.read` requires chained prefix resolution. Currently resolves `Stdio.File` but not deeper paths in all cases. |