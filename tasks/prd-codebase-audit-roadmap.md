# PRD: Codebase Audit & Production Roadmap

## Introduction

A full audit of the Pike Language Server codebase (7,640 LOC server, 1,396 tests passing) reveals three categories of problems:

1. **Structural/architectural** — the codebase lacks foundations that production LSPs (rust-analyzer, gopls) consider mandatory: immutable workspace snapshots, proper concurrency control, and clean parser lifecycle.
2. **Correctness gaps** — features that are "implemented" give wrong or missing answers in common cases: cross-file inheritance returns empty, rename blocks 3,470 common identifiers, type resolution is same-file only.
3. **Hallucinated quality** — the test suite passes 1,396 tests but most tests verify the code does *something*, not that it does the *right thing* compared to Pike. Tests assert structural properties of the output, not semantic correctness against the oracle.

The goal: a production-ready beta where every advertised LSP capability gives correct answers for real Pike code, backed by a test suite that catches regressions.

## Goals

- Every LSP capability gives correct answers for real Pike code (verified against Pike oracle)
- Architecture supports concurrent requests without stale-state bugs (snapshot pattern)
- No feature is advertised that doesn't work for the common case
- Test suite catches real bugs (oracle-verified expectations, not structural assertions)
- Codebase follows the project's own TigerStyle conventions (already partially adopted)

## Non-Goals

- Adding new LSP capabilities (code actions, formatting, signature help, folding range)
- Multi-editor support beyond what already works
- Performance optimization beyond correctness requirements
- On-disk index persistence
- .so binary module resolution
- Type inference for dynamically-typed variables

---

## Audit Findings

### P0: Bugs That Ship Wrong Answers

#### P0-1: Rename blocks 3,470 common identifiers

**File:** `server/src/server.ts:75-91`

`buildProtectedNames()` extracts the *unqualified short name* of every stdlib symbol (e.g., `predef.Array.diff` → `diff`) and adds it to the protected set. This means `get`, `set`, `name`, `id`, `value`, `data`, `error`, `size`, `type`, `key`, `result`, `create`, `destroy`, `init`, and ~3,455 other common names cannot be renamed anywhere in user code.

The intent was correct — prevent renaming stdlib symbols — but the implementation is wrong. Only symbols that are *actually resolved to stdlib* should be protected, not any symbol that shares a name with a stdlib symbol.

**Impact:** `prepareRename` returns null for the most common variable names in Pike code. Users cannot rename a local variable called `name` or `error`.

#### P0-2: `wireInheritance` cross-file resolution only works through file-level inherit/import

**File:** `server/src/features/symbolTable.ts:1580-1697`

`wireCrossFileInheritance()` only finds classes that are brought into scope by a *file-level* inherit or import declaration. It does not wire inheritance for classes that:
- Are inherited by qualified name (`inherit Stdio.File`)
- Are imported into a class scope (not file scope)
- Appear through transitive inheritance chains longer than one hop

This means `d->speak()` on a `Dog` that inherits from a cross-file `Animal` returns empty completion and null definition, even when both files are indexed.

**Impact:** The most common cross-file pattern (class in file A inherits from class in file B) gives empty results for member access.

#### P0-3: Type resolution ignores function return types

**File:** `server/src/features/typeResolver.ts`

`resolveMemberAccess()` only resolves through explicitly-declared variable types. If a function returns `Animal`, calling `f()->speak()` cannot resolve `speak`. Only direct declared types on variables and parameters are used.

**Impact:** Method chaining and function call results cannot be completed or navigated.

#### P0-4: Stdlib hover lookup uses unqualified name, produces false positives

**File:** `server/src/server.ts:630`

```typescript
const entry = stdlibIndex[`predef.${decl.name}`];
```

This looks up `predef.name` where `name` is the declaration's short name. If the user has a local variable called `File`, it matches `predef.File` and shows stdlib documentation instead of the local declaration.

**Impact:** Hover shows wrong documentation for identifiers that share names with stdlib symbols.

### P1: Architectural Gaps (Compared to rust-analyzer/gopls)

#### P1-1: No snapshot pattern — concurrent requests can see inconsistent state

**Problem:** gopls and rust-analyzer both use an immutable Snapshot pattern. Every LSP request operates on a frozen view of the workspace. New edits create a new snapshot; in-flight requests complete on the old one.

The Pike LSP has no equivalent. `onDidChangeContent` mutates `index` in-place. If a hover request starts while `onDidChangeContent` is mid-rebuild, the hover handler sees a partially-updated WorkspaceIndex — some files have new symbol tables, others don't.

**Current mitigation:** JavaScript's single-threaded execution means mutations don't interleave within a single event loop tick. But `async` functions with `await` points do interleave. The PikeWorker's `diagnose()` is async; if a hover request comes in while diagnostics are in-flight, the index state is indeterminate.

**What to build:** An immutable `WorkspaceSnapshot` type that captures the current state of all caches. Every LSP handler receives a snapshot; edits create a new one. This is the single most important architectural change for correctness.

#### P1-2: Global mutable parser singleton

**File:** `server/src/parser.ts:17-18`

```typescript
let parserInstance: Parser | null = null;
let language: Language | null = null;
```

Module-level mutable state. The parser is a process-wide singleton. Tests that call `initParser()` affect each other. No way to create an isolated parser for a test or to reset state without side effects.

**What to do:** Make `Parser` a class instance, not module state. Pass it through dependency injection.

#### P1-3: `WorkspaceIndex` uses stale-marking without actual rebuild

**File:** `server/src/features/workspaceIndex.ts:225-258`

`invalidateWithDependents()` marks dependents as stale but `getSymbolTable()` returns `null` for stale entries. Nobody ever rebuilds the stale tables — the caller gets null and falls back to re-parsing. The "lazy rebuild" described in comments doesn't exist.

**What this means:** After editing file A, all files that depend on A return null symbol tables until the user opens and edits them individually. Cross-file features break until every dependent file is touched.

#### P1-4: No request cancellation support beyond completion

**File:** `server/src/server.ts`

`onCompletion` checks `CancellationToken`. No other handler does. `onDefinition`, `onReferences`, `onHover`, and `onRenameRequest` all ignore cancellation. If the user types rapidly, stale requests run to completion and may overwrite newer results.

#### P1-5: Completion's stdlib indices are module-level mutable globals

**File:** `server/src/features/completion.ts:55-56`

```typescript
let stdlibChildrenMap: Map<string, StdlibMember[]> | null = null;
let stdlibTopLevelNames: { name: string; kind: CompletionItemKind }[] | null = null;
```

Module-level lazy singletons. `resetCompletionCache()` exists for tests but it's a workaround for the real problem: these should be owned by the server instance, not by the module.

### P2: Code Quality Issues

#### P2-1: DRY violations

| Duplicated concept | Files | Lines |
|---|---|---|
| `PRIMITIVE_TYPES` set | `typeResolver.ts`, `completion.ts` | 12 lines each |
| `rangeContains` / `posInRange` / `containsRange` | `typeResolver.ts`, `completion.ts`, `symbolTable.ts` | 3 copies |
| `renderPredefSignature` vs `cleanPredefSignature` | `server.ts`, `completion.ts` | Same logic, different names |
| `containsDecl` | `typeResolver.ts:269` | Defined, never called (dead code) |

#### P2-2: `server.ts` is 794 lines — exceeds the 500-line guideline

The file contains the server factory, hover formatting, signature rendering, cache management, and all LSP handler wiring. Per the project's own AGENTS.md: "File length: 500 lines → Split into focused modules."

#### P2-3: `resolutionCtx` used before declaration

**File:** `server/src/server.ts:405,541,553`

`resolutionCtx` is referenced in `onDefinition` and `onHover` handlers but declared after both. Works due to closure capture semantics, but reads as a forward reference.

#### P2-4: `symbolTable.ts` is 1,707 lines — exceeds the 500-line guideline by 3.4x

The file contains types, builder state, scope walking, declaration collection for 10+ node types, reference collection, resolution queries, and inheritance wiring. Each of these is a separate concern.

### P3: Test Quality Issues

#### P3-1: Tests verify structure, not semantics

Most LSP tests follow this pattern:
```typescript
const result = await client.sendRequest('textDocument/definition', { ... });
expect(result).toHaveLength(1);  // Correct length
expect(result[0].uri).toContain('class-single-inherit');  // Correct file
```

This verifies that *something* was returned, not that the *right thing* was returned. A test that returns line 5 when the correct answer is line 12 would pass if both lines are in the expected file.

#### P3-2: No oracle comparison in LSP tests

The harness has 37 oracle snapshots from Pike, but the LSP tests don't compare against them. The LSP tests create in-memory documents with hand-crafted source and hand-expect positions. These are testing the LSP's internal logic, not its agreement with Pike.

#### P3-3: Cross-file propagation test admits it doesn't test cross-file propagation

**File:** `tests/lsp/diagnostics.test.ts` — the diagnostic propagation test logs `"dependency graph empty — propagation not tested"`. The test passes because there's nothing to propagate in an in-memory workspace.

#### P3-4: `protectedNames` rename blocking is untested

No test verifies that a user *can* rename a variable called `name` or `error`. The rename tests use names like `myVar`, `bark`, `sound` — none of which collide with stdlib.

---

## Roadmap

### Phase A: Architecture Foundations

**Goal:** Immutable workspace model, proper parser lifecycle, request cancellation.

**Entry:** Current state (1,396 tests passing).
**Exit:** All tests still pass. Architecture supports concurrent correctness.

### US-A01: Extract Parser class from module globals

**Description:** As a developer, I need the parser to be an instance so tests and the server don't share mutable state.

**Acceptance Criteria:**
- [ ] `Parser` is a class with `init()`, `parse()`, `getCachedTree()`, `deleteTree()`, `clearTreeCache()`, `getLanguage()` methods
- [ ] `server.ts` creates and owns a `Parser` instance
- [ ] Tests create their own instances without side effects
- [ ] No module-level mutable state in `parser.ts`
- [ ] Typecheck passes

### US-A02: Implement WorkspaceSnapshot

**Description:** As a developer, I need every LSP request to operate on an immutable snapshot of workspace state so concurrent requests don't see inconsistent data.

**Acceptance Criteria:**
- [ ] `WorkspaceSnapshot` type captures: document versions, symbol tables, tree cache, pike cache, autodoc cache
- [ ] `onDidChangeContent` / `onDidSave` create a new snapshot; old snapshot remains valid for in-flight requests
- [ ] Every LSP handler receives a snapshot, never reads mutable state directly
- [ ] Existing tests pass without modification (snapshot creation is transparent)
- [ ] Typecheck passes

### US-A03: Add CancellationToken checks to all LSP handlers

**Description:** As a user, I want stale requests to be cancelled when I type so I don't get wrong results.

**Acceptance Criteria:**
- [ ] `onDefinition`, `onReferences`, `onHover`, `onRenameRequest`, `onPrepareRename` check `CancellationToken.isCancellationRequested` before returning
- [ ] Long-running paths (PikeWorker calls) check cancellation before invocation
- [ ] Typecheck passes

### US-A04: Implement actual lazy rebuild for stale WorkspaceIndex entries

**Description:** As a developer, I need stale index entries to rebuild on access, not return null.

**Acceptance Criteria:**
- [ ] `getSymbolTable()` for a stale entry triggers rebuild (re-parse + re-build symbol table)
- [ ] Rebuild uses the latest document content from the document manager
- [ ] Rebuild result is stored back into the index entry (clearing stale flag)
- [ ] If document is not available (file not open), return null (current behavior)
- [ ] Typecheck passes

### US-A05: Split `symbolTable.ts` into focused modules

**Description:** As a developer, I need the symbol table code to be organized so I can find and modify specific concerns without scrolling 1,700 lines.

**Acceptance Criteria:**
- [ ] `symbolTable.ts` re-exports from focused modules (backward compatible)
- [ ] New modules: `types.ts` (interfaces), `builder.ts` (build + scope walking), `queries.ts` (getDefinitionAt, getReferencesTo, etc.), `inheritance.ts` (wireInheritance + cross-file)
- [ ] Each module under 500 lines
- [ ] No module-level mutable state (builder receives state as parameter)
- [ ] All 1,396 tests pass without modification

### US-A06: Move stdlib indices from module globals to server-owned state

**Description:** As a developer, I need the stdlib completion indices to be owned by the server instance so they don't leak between tests.

**Acceptance Criteria:**
- [ ] `stdlibChildrenMap` and `stdlibTopLevelNames` are instance state, not module globals
- [ ] `resetCompletionCache()` removed (no longer needed)
- [ ] Tests updated to create fresh server instances
- [ ] Typecheck passes

---

### Phase B: Correctness — Fix Wrong Answers

**Goal:** Every P0 bug fixed. Every LSP capability gives correct answers for real Pike code.

**Entry:** Phase A complete.
**Exit:** All P0 bugs fixed with regression tests. All existing tests pass.

### US-B01: Fix protectedNames — scope protection to actual resolution, not name collision

**Description:** As a user, I want to rename local variables even when their name matches a stdlib symbol. The LSP should only block rename when the symbol *resolves to* stdlib, not when it *shares a name with* stdlib.

**Acceptance Criteria:**
- [ ] `protectedNames` is removed as a pre-computed set of 3,470 short names
- [ ] `prepareRename` checks whether the declaration at cursor is *actually in stdlib* (resolution check, not name check)
- [ ] A local variable named `name` can be renamed
- [ ] A stdlib reference like `Stdio.FILE` cannot be renamed
- [ ] Regression test: rename a variable called `name` succeeds
- [ ] Regression test: rename a variable called `write` (predef builtin) fails
- [ ] All existing rename tests pass
- [ ] Typecheck passes

### US-B02: Fix stdlib hover false positives — use FQN, not short name

**Description:** As a user, I want hover on a local variable called `File` to show local info, not `predef.File` documentation.

**Acceptance Criteria:**
- [ ] Stdlib hover lookup uses the declaration's fully-qualified context (scope chain), not just its short name
- [ ] A local variable `File` in user code shows the tree-sitter declared type, not `predef.File` docs
- [ ] An actual stdlib reference like `Stdio.FILE` shows stdlib docs
- [ ] Regression test: hover on local `File` does not show stdlib markdown
- [ ] All existing hover tests pass
- [ ] Typecheck passes

### US-B03: Fix cross-file inheritance wiring for qualified inherits

**Description:** As a user, I want `d->speak()` to resolve `speak` when `Dog` inherits from `Animal` defined in another file, via any inherit path (string literal, qualified name, or identifier).

**Acceptance Criteria:**
- [ ] `wireCrossFileInheritance()` resolves through qualified inherit paths (`inherit Stdio.File`, `inherit Module.Class`), not just file-level inherits
- [ ] `resolveMemberAccess()` returns correct members for cross-file inherited classes
- [ ] Completion after `d->` returns inherited members from cross-file classes
- [ ] Go-to-definition on `d->speak()` navigates to the cross-file class method
- [ ] Regression tests using real corpus files
- [ ] All existing tests pass
- [ ] Typecheck passes

### US-B04: Deduplicate shared constants and utilities

**Description:** As a developer, I need shared types and utilities in one place so changes don't require editing 3 files.

**Acceptance Criteria:**
- [ ] `PRIMITIVE_TYPES` defined once (in `typeResolver.ts`, imported by `completion.ts`)
- [ ] `rangeContains` / `posInRange` / `containsRange` unified into one function in a shared module
- [ ] `renderPredefSignature` / `cleanPredefSignature` unified into one function
- [ ] Dead code removed: `containsDecl` in `typeResolver.ts`
- [ ] All existing tests pass
- [ ] Typecheck passes

---

### Phase C: Test Quality — Make Tests That Catch Bugs

**Goal:** Every LSP feature has oracle-verified tests. Protected names bug (P0-1) would have been caught by tests.

**Entry:** Phase B complete.
**Exit:** Every feature has at least one oracle-verified test. Test count increases by 50+.

### US-C01: Add oracle-verified definition tests

**Description:** As a developer, I need definition tests that compare LSP output against Pike's actual resolution, so I can trust that "passing tests" means "correct behavior."

**Acceptance Criteria:**
- [ ] At least 10 definition test cases where expected positions come from Pike introspection (not hand-written)
- [ ] Tests cover: same-file class, same-file function, parameter, local variable, cross-file inherit, cross-file import, arrow access, scope access
- [ ] Tests assert exact line and character, not just "file contains X"
- [ ] Typecheck passes

### US-C02: Add oracle-verified hover tests

**Description:** As a developer, I need hover tests that verify the *content* shown to the user, not just "hover returned non-null."

**Acceptance Criteria:**
- [ ] At least 8 hover test cases verifying: correct type signature, correct documentation content, correct source (workspace AutoDoc / stdlib / predef / tree-sitter)
- [ ] Test that hover on local variable with stdlib-colliding name shows local info, not stdlib
- [ ] Typecheck passes

### US-C03: Add rename scope regression tests

**Description:** As a developer, I need tests that verify rename protection is scoped correctly.

**Acceptance Criteria:**
- [ ] Test: rename a variable called `name` in user code → succeeds
- [ ] Test: rename a variable called `error` in user code → succeeds
- [ ] Test: rename a variable called `get` in user code → succeeds
- [ ] Test: rename a reference to `Stdio.write` → blocked (stdlib)
- [ ] Test: rename a reference to `write()` (predef builtin) → blocked
- [ ] Typecheck passes

### US-C04: Add cross-file integration tests with real files

**Description:** As a developer, I need tests that exercise the full cross-file resolution pipeline with real Pike files on disk, so I can catch the "dependency graph empty" gap.

**Acceptance Criteria:**
- [ ] Tests create temporary workspace with 2-3 Pike files
- [ ] Tests verify: cross-file definition, cross-file references, cross-file inheritance completion, cross-file diagnostic propagation
- [ ] Dependency graph is non-empty in these tests
- [ ] Typecheck passes

---

### Phase D: Hardening — Production Quality

**Goal:** Server handles edge cases gracefully, never crashes, and gives clear error messages.

**Entry:** Phase C complete.
**Exit:** Server runs for 8 hours on a 500-file Pike project without crashes or memory leaks.

### US-D01: `server.ts` decomposition

**Description:** As a developer, I need the server entry point to be under 500 lines so it's navigable.

**Acceptance Criteria:**
- [ ] Extract hover logic into `features/hoverProvider.ts`
- [ ] Extract cache management into `features/cacheManager.ts`
- [ ] `server.ts` is wiring-only: handler registration, lifecycle hooks
- [ ] `server.ts` under 400 lines
- [ ] All tests pass
- [ ] Typecheck passes

### US-D02: Error recovery — every handler returns gracefully, never throws

**Description:** As a user, I want the server to stay alive even when individual requests fail.

**Acceptance Criteria:**
- [ ] Audit every LSP handler for uncaught exceptions
- [ ] Every handler has a top-level try/catch that returns a safe default (null, [], etc.)
- [ ] Caught exceptions are logged with enough context to diagnose
- [ ] No `catch {}` empty handlers (already mostly done)
- [ ] Typecheck passes

### US-D03: PikeWorker crash recovery validation

**Description:** As a user, I want the server to recover automatically when the Pike subprocess crashes.

**Acceptance Criteria:**
- [ ] PikeWorker restarts on crash, replays any cached state needed
- [ ] In-flight requests receive error responses (not hangs)
- [ ] Queued requests are replayed after restart
- [ ] Test: kill PikeWorker mid-request → server returns error, subsequent request works
- [ ] Typecheck passes

---

## Functional Requirements

- FR-1: The parser MUST be an instance, not a module singleton
- FR-2: Every LSP request MUST operate on an immutable snapshot of workspace state
- FR-3: Every LSP handler MUST check CancellationToken before returning
- FR-4: Stale WorkspaceIndex entries MUST rebuild on access, not return null
- FR-5: Rename protection MUST be scoped to symbols that resolve to stdlib, not name collision
- FR-6: Stdlib hover lookup MUST use resolution context, not bare short name
- FR-7: Cross-file inheritance MUST wire through qualified inherit paths, not just file-level imports
- FR-8: Shared constants (PRIMITIVE_TYPES, rangeContains) MUST be defined once
- FR-9: Every source file MUST be under 500 lines
- FR-10: No module-level mutable state for parser or completion indices
- FR-11: Every P0 fix MUST include a regression test that would have caught the original bug
- FR-12: Definition and hover tests MUST compare against Pike oracle for at least 10 cases each

## Non-Goals

- New LSP capabilities (code actions, formatting, signature help, folding range, document highlight)
- Type inference for dynamically-typed variables
- .so binary module resolution
- On-disk index persistence
- joinnode multi-path merge
- Build system integration

## Design Considerations

### Snapshot Pattern (from gopls)

The most impactful architectural change. gopls's `Snapshot` type is defined in `golang.org/x/tools/gopls/internal/cache`. Each snapshot is an immutable view of the workspace. Every LSP handler receives a snapshot at the start.

For Pike LSP, a snapshot would capture:
- A frozen map of URI → FileEntry (symbol table, version, content hash)
- A frozen map of URI → cached Pike diagnostics
- A frozen map of URI → cached AutoDoc XML
- The stdlib and predef indices (immutable, shared)

The `WorkspaceIndex` would produce a snapshot on each mutation. Handlers would read from the snapshot. This eliminates the "partially-updated index" problem.

### Lazy Rebuild (from rust-analyzer's salsa)

rust-analyzer's salsa query system memoizes analysis results and incrementally invalidates them when inputs change. For Pike LSP, a simpler version: stale entries rebuild on next access, using the latest document content. This is what the comments claim to do but don't actually implement.

### Protected Names (from gopls)

gopls protects standard library symbols by checking whether the identifier's *definition* resolves to the standard library. It doesn't block renames based on name collision. The fix: resolve the declaration at the rename position, check if it's in a known stdlib/predef file, and only then block the rename.

## Technical Considerations

### Migration strategy

Each phase is backward-compatible. The snapshot pattern is introduced as a wrapper around existing state. Existing tests pass at every phase boundary. No big-bang rewrites.

### Module boundaries after decomposition

```
server/src/
  features/
    types.ts            — shared types (Range, Location, Declaration, etc.)
    rangeUtils.ts       — rangeContains, posInRange (shared)
    primitives.ts       — PRIMITIVE_TYPES set (shared)
    parser.ts           — Parser class (instance, not singleton)
    symbolTable/
      index.ts          — re-exports
      builder.ts        — buildSymbolTable, scope walking
      queries.ts        — getDefinitionAt, getReferencesTo, getSymbolsInScope
      inheritance.ts    — wireInheritance, wireLocalInheritance, wireCrossFileInheritance
    completion.ts       — completion provider (imports shared types)
    hoverProvider.ts    — hover logic extracted from server.ts
    cacheManager.ts     — autodoc + pike cache management
    ... (other features unchanged)
  snapshot.ts           — WorkspaceSnapshot type
  server.ts             — wiring only (<400 lines)
```

### Test infrastructure additions

- Oracle-verified tests use the existing harness infrastructure (37 Pike snapshots)
- Cross-file integration tests create temp workspaces with real `.pike` files
- Rename regression tests verify both positive (can rename) and negative (blocked) cases

## Success Metrics

- Zero P0 bugs in production
- Every LSP capability gives correct answers for 14+ representative stdlib files (P2 findings from Phase 9 resolved)
- `d->speak()` resolves correctly for cross-file inheritance chains (the most common user pattern)
- A variable named `name` can be renamed
- Hover on a local `File` variable shows local info, not stdlib docs
- Server runs for 8 hours on a 500-file project without crashes
- Test suite has 50+ oracle-verified tests (up from 0)

## Open Questions

- Should the snapshot pattern use structural sharing (copy-on-write maps) to reduce memory, or is deep copy sufficient for Pike workspaces (typically <1000 files)?
- Should `wireCrossFileInheritance` be eager (at build time) or lazy (at query time)? Eager is simpler but wastes time if the inherited class is never queried. Lazy is correct but adds latency on first access.
- Should the PikeWorker's `typeof_()` method be connected to hover for runtime type inference? The method exists but is unused. This would close the "hover shows declared types, not inferred types" gap, but requires Pike subprocess queries on every hover.
- What is the right scope for the "narrow and deepen" approach — drop rename entirely until cross-file is solid, or keep it but restrict to same-file only?

## Inventory: What Works, What's Broken, What's Hallucinated

### Works correctly
- `documentSymbol` — 14/14 files in Phase 9 production test
- Parse diagnostics (tree-sitter ERROR nodes → LSP diagnostics)
- Same-file definition resolution (scope chain walking)
- Same-file references (scope-aware reference collection)
- Same-file rename (scope-aware, keyword validation)
- Real-time diagnostics with debouncing (Decision 0013)
- PikeWorker lifecycle management (lazy start, idle eviction, crash recovery)
- Standalone build and non-VSCode editor support

### Implemented but gives wrong/empty answers
- Cross-file definition — works for direct inherit/import targets, fails for qualified paths and transitive chains
- Cross-file references — works for direct dependents, returns name-matched false positives for inherited symbols
- Cross-file completion — empty after `->` on cross-file inherited classes
- Type resolution — only resolves explicitly-declared types, not return types or inferred types
- Rename — blocks 3,470 common identifiers due to name-collision protection
- Hover — false-positive stdlib matches on local identifiers with stdlib-colliding names

### Hallucinated (documented as working but not verified or not working)
- "1,311 tests passing" — count is real but tests don't verify correctness
- "Lazy rebuild on stale entries" (WorkspaceIndex comments) — stale entries return null, nothing rebuilds them
- "Cross-file propagation tested" — diagnostic propagation test says "dependency graph empty — propagation not tested"
- "All LSP capabilities production-quality" — Phase 9 workstream 2 found 7 P2 items (5 type-resolution gaps, 2 scope-resolution gaps) that are open
- "wireInheritance resolves cross-file" — only resolves through file-level inherit/import, not qualified paths

### Test quality gaps
- 0 oracle-verified LSP tests (all expectations are hand-written)
- 0 tests for rename protection scope (would have caught P0-1)
- 0 tests for hover false positives on name-colliding identifiers
- 0 cross-file tests with real files on disk (all use in-memory documents)
- 1 test that admits it doesn't test what it claims to test (cross-file propagation)
