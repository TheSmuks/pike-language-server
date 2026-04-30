# PRD: Pike Language Server — Roadmap to v1.0

## Introduction

The Pike Language Server is at Phase 9 (v0.1.0-alpha): 1,311 tests, seven LSP capabilities implemented, Neovim verified, real-codebase tested with zero P1 failures. It is a functional alpha that handles daily Pike editing.

The gap to v1.0 is not "add more features." It is three things:

1. **Close the correctness holes** where the LSP gives partial or wrong answers — cross-file inheritance, type inference, scope leaks from upstream tree-sitter bugs. These erode trust. A production LSP must give the right answer, even if that answer is "I don't know" (null), rather than a plausible wrong answer.
2. **Add the LSP capabilities** that users expect from any language server in 2026 — semantic tokens, document highlights, signature help, code actions. The server currently implements 7 of ~15 standard capabilities; the missing ones are what distinguish "an LSP" from "a good LSP."
3. **Harden the infrastructure** — incremental reindexing, persistent cache, full `workspace/symbol` support, configuration ergonomics. These are the things that make the LSP reliable on real codebases at scale.

This document maps the path from alpha to v1.0 in six phases (10–15). Each phase has clear entry/exit criteria, is ordered by dependency, and follows the project's established patterns (Pike as oracle, tree-sitter as parser, decision documents, harness-verified tests).

### Design Inspiration

This roadmap draws from two production LSPs:

- **rust-analyzer**: Incremental query-based compilation, salsa-style caching, semantic token full coverage, inlay hints, expand-macro, code actions with assists. We adopt its phased approach to type inference (local → cross-function → cross-crate) and its commitment to "never block the main thread."
- **gopls**: Snapshot-based workspace model, context-based cancellation, ModificationSource tracking, diagnostic debouncing. Our existing WorkspaceIndex already follows gopls's package-graph pattern; the roadmap extends it with gopls's caching and invalidation discipline.

We explicitly do NOT adopt: rust-analyzer's salsa framework (overkill for our scale), gopls's build-system integration (Pike has none), or clangd's on-disk index (unnecessary until workspace sizes exceed ~10k files).

## Goals

- Close all known correctness limitations documented in `docs/known-limitations.md`
- Implement the remaining standard LSP capabilities expected of a v1.0 language server
- Achieve type inference through function return types and cross-file inheritance chains
- Support workspaces of 1,000+ Pike files with <2s cold-start and <50ms incremental updates
- Maintain 1,500+ tests, 0 failures, with no regression between phases
- Produce a v1.0.0 release suitable for daily use by Pike developers

## Current State (Phase 9 Exit)

### Implemented Capabilities

| Capability | Status | Gaps |
|------------|--------|------|
| documentSymbol | Complete | — |
| definition | Complete | Arrow/dot only resolves declared types, not inferred |
| references | Complete | Cross-file inherited members have stale refs |
| hover | Complete | No inferred types; AutoDoc requires save; local scope hover gaps |
| diagnostics | Complete | No column positions; parse errors only from tree-sitter |
| completion | Complete | Cross-file inherited members missing; no return-type inference |
| rename | Complete | Name-based matching for unresolved arrow refs may over-rename |

### Architecture (Current)

```
┌──────────────┐     stdio      ┌──────────────┐
│  VSCode /    │ ◄─────────────► │  LSP Server  │
│  Neovim      │    LSP protocol │  (server.ts) │
└──────────────┘                 └──────┬───────┘
                                        │
                        ┌───────────────┼───────────────┐
                        │               │               │
                  ┌─────▼─────┐  ┌──────▼──────┐  ┌────▼─────┐
                  │ tree-sitter│  │ WorkspaceIndex│  │PikeWorker│
                  │  (parse)  │  │ (cross-file)  │  │ (oracle) │
                  └───────────┘  └──────────────┘  └──────────┘
                                       │
                          ┌────────────┼────────────┐
                          │            │            │
                    ┌─────▼────┐ ┌────▼─────┐ ┌───▼──────┐
                    │ SymbolTable│ │ModuleRes.│ │typeResolv.│
                    │ (per-file)│ │          │ │          │
                    └──────────┘ └──────────┘ └──────────┘
```

### Known Limitations to Resolve

1. **Cross-file inherited member completion** — `wireInheritance()` only resolves same-file inheritance; cross-file inherited scopes are empty (Phase 8 finding).
2. **Type inference through function return types** — `makeDog()->speak()` cannot resolve because return types are not tracked.
3. **Arrow/dot rename over-renaming** — Name-based matching includes call sites on different classes sharing the same method name.
4. **Upstream scope leaks** — tree-sitter-pike #2/#3/#4: `for` field names missing, `catch` in assignment lost, `while`/`switch`/`do-while` have no scope nodes.
5. **No column-level diagnostic positions** — Pike's CompilationHandler reports lines only.
6. **Hover on local variables** — Scope chain doesn't always reach the declaration in complex functions (2 P2 findings from Phase 9 WS2).

---

## Roadmap Phases

### Phase Ordering Rationale

The phases are ordered by dependency:

- **Phase 10** (Correctness) must come first because every subsequent feature builds on a correct symbol table and type resolver. Building semantic tokens on top of broken cross-file inheritance propagates wrong information to the user.
- **Phase 11** (Type Inference) extends the type resolver. Completion, hover, and the new features (semantic tokens, signature help) all consume type information.
- **Phase 12** (Semantic Tokens) is the first "new capability" phase because it exercises the full type resolution pipeline end-to-end, exposing any remaining gaps before lighter features are added.
- **Phase 13** (New Capabilities) adds the remaining LSP features that are independent of each other and can be parallelized.
- **Phase 14** (Infrastructure) hardens performance and reliability — only worth doing after the feature set is stable.
- **Phase 15** (Release) is polish and packaging.

---

## Phase 10: Cross-file Correctness

**Goal:** Close all known correctness gaps. Zero wrong answers.

### US-10.1: Cross-file inheritance wiring in WorkspaceIndex

**Description:** As a developer, I need `wireInheritance()` to resolve cross-file inheritance chains so that `Dog d; d->speak()` returns `speak()` even when `Animal` is in a different file.

**Acceptance Criteria:**
- [ ] `wireInheritance()` looks up inherited class via WorkspaceIndex when not found in same file
- [ ] `Dog d; d->speak()` completion returns `speak()` when `Animal` is in a different file
- [ ] `Dog d; d->speak()` go-to-definition jumps to `Animal.speak()` in the other file
- [ ] Cross-file inherited members appear in hover
- [ ] Cross-file inherited member rename is scope-correct (does not over-rename)
- [ ] Decision document written before implementation
- [ ] Tests use real corpus files (cross_inherit_chain.pike, class-single-inherit.pike)
- [ ] Typecheck passes

### US-10.2: Full scope chain for local variable hover

**Description:** As a user, I want hover on any local variable in a complex function, not just ones in the immediate scope.

**Acceptance Criteria:**
- [ ] Hover works for variables declared in outer scopes of deeply nested functions
- [ ] Verify against Phase 9 WS2 P2 findings (Protocols.HTTP.Query.ok, LysKOM.Raw.g)
- [ ] Add corpus file with deeply nested function scopes to exercise the fix
- [ ] Typecheck passes

### US-10.3: Scope leak mitigation for upstream tree-sitter bugs

**Description:** As a developer, I need per-construct scope handlers for `while`, `switch`, and `do-while` blocks so variables declared inside don't leak to the enclosing scope.

**Acceptance Criteria:**
- [ ] Add `collectWhileStatement()`, `collectSwitchStatement()`, `collectDoWhileStatement()` handlers in symbolTable.ts
- [ ] Variables in `while`/`switch`/`do-while` blocks are scoped correctly
- [ ] Backward-compatible: existing tests unaffected
- [ ] Document relationship to upstream issue tree-sitter-pike#4
- [ ] Typecheck passes

### US-10.4: Rename precision for arrow/dot access

**Description:** As a user, I want rename of `bark()` on `Dog` to NOT rename `bark()` on `Cat`.

**Acceptance Criteria:**
- [ ] When renaming `bark()` on `Dog`, filter arrow/dot access references by resolved type where possible
- [ ] If type cannot be resolved, keep current name-based behavior but add a warning to the rename result
- [ ] Add test: two classes with same method name, rename one does not affect the other
- [ ] Typecheck passes

### US-10.5: Decision 0002 scope audit

**Description:** As a developer, I need to verify that Decision 0002's type resolution boundaries are still accurate after Phase 10 changes.

**Acceptance Criteria:**
- [ ] Decision 0002 updated with Phase 10 resolution improvements
- [ ] "Undocumented object members" gap reassessed
- [ ] Typecheck passes

**Exit Criteria:**
- All Phase 10 tests pass (target: 50+ new tests)
- No P2 findings from Phase 9 WS2 remain open
- Cross-file inherited member completion/definition/hover/rename all work
- `docs/known-limitations.md` updated

---

## Phase 11: Type Inference

**Goal:** Infer types through function return types, assignments, and method calls. Move from "declared types only" to "common-case inferred types."

### US-11.1: Function return type tracking

**Description:** As a user, I want `makeDog()->speak()` to resolve `speak()` because `makeDog()` returns `Dog`.

**Acceptance Criteria:**
- [ ] `resolveType()` resolves through function return type annotations
- [ ] `makeDog()->speak()` completion returns `speak()` when `makeDog` has return type `Dog`
- [ ] `makeDog()->speak()` go-to-definition jumps to `Dog.speak()`
- [ ] Depth-limited to prevent infinite recursion (MAX_RESOLUTION_DEPTH already exists)
- [ ] Decision document written
- [ ] Typecheck passes

### US-11.2: Assignment-based type narrowing

**Description:** As a user, I want `Dog d = makeDog(); d->speak()` to resolve even without an explicit type annotation on `d`, because the assignment RHS is `Dog`.

**Acceptance Criteria:**
- [ ] Track variable assignments in the symbol table (DeclKind 'variable' gains optional `assignedType`)
- [ ] If `declaredType` is absent or `mixed`, fall through to `assignedType` from the initializer
- [ ] Only track simple assignments (`x = expr`), not control-flow-sensitive narrowing
- [ ] Typecheck passes

### US-11.3: PikeWorker `typeof` integration for hover

**Description:** As a user, I want hover on `mixed x = someFunction()` to show the inferred type from Pike, not just `mixed`.

**Acceptance Criteria:**
- [ ] Hover on local variable queries PikeWorker `typeof()` when declared type is `mixed` or absent
- [ ] Falls back to declared/assigned type if worker is unavailable or times out
- [ ] Does not add latency to hover for explicitly typed variables
- [ ] Decision document written (extends Decision 0011)
- [ ] Typecheck passes

### US-11.4: Inference test corpus

**Description:** As a developer, I need corpus files that exercise each inference path.

**Acceptance Criteria:**
- [ ] Corpus files for: return type inference, assignment inference, chained inference (`a()->b()->c`), inference failure cases
- [ ] Harness snapshots capture inferred types (extend introspect.pike if needed)
- [ ] Typecheck passes

**Exit Criteria:**
- Function return types resolve through the call chain
- Assignment-based narrowing works for simple cases
- `makeDog()->speak()` pattern fully works (completion, definition, hover)
- Pike `typeof()` integrated for `mixed` variable hover
- Target: 40+ new tests

---

## Phase 12: Semantic Tokens

**Goal:** Provide full semantic highlighting via `textDocument/semanticTokens/full`. This is the single highest-impact visual improvement for a language server.

### US-12.1: Semantic token data model

**Description:** As a developer, I need to map Pike's type system to LSP SemanticTokenTypes and SemanticTokenModifiers.

**Acceptance Criteria:**
- [ ] Define token type mapping: class, enum, function, method, variable, parameter, property, namespace, keyword, type, modifier
- [ ] Define modifier mapping: declaration, definition, readonly (constants), static (class members), deprecated (if AutoDoc says so), abstract
- [ ] Decision document written
- [ ] Typecheck passes

### US-12.2: Semantic token provider implementation

**Description:** As a user, I want my Pike code to be syntax-highlighted with semantic information — classes colored differently from variables, parameters distinguishable from locals, stdlib types recognized.

**Acceptance Criteria:**
- [ ] `textDocument/semanticTokens/full` handler registered
- [ ] Token production walks the symbol table + tree-sitter parse tree
- [ ] Tokens cover: classes, functions, methods, variables, parameters, constants, enums, enum members, typedefs, inheritance keywords, import paths
- [ ] Stdlib/predef types tokenized as `namespace` or `type` (not `variable`)
- [ ] Incremental token updates on `didChange` (delta encoding per LSP spec)
- [ ] Capability registered in `initialize` response
- [ ] Typecheck passes

### US-12.3: Semantic token tests

**Description:** As a developer, I need to verify that semantic tokens are correct against Pike's own understanding of the code.

**Acceptance Criteria:**
- [ ] Layer 1 tests: verify token types and modifiers for each declaration kind
- [ ] Layer 1 tests: verify cross-file semantic tokens (inherited members, imported symbols)
- [ ] Layer 2 test: verify tokens render correctly in VSCode
- [ ] Target: 30+ new tests
- [ ] Typecheck passes

**Exit Criteria:**
- Semantic tokens work for all declaration kinds in the symbol table
- Stdlib/predef types are correctly classified
- Delta encoding works for incremental edits
- Target: 30+ new tests

---

## Phase 13: New LSP Capabilities

**Goal:** Add the remaining standard LSP capabilities that users expect.

### US-13.1: Document highlights

**Description:** As a user, I want to see all occurrences of the symbol under my cursor highlighted in the current file.

**Acceptance Criteria:**
- [ ] `textDocument/documentHighlight` handler registered
- [ ] Uses `getReferencesTo()` from the symbol table (same-file, already implemented)
- [ ] Distinguishes read/write access (variable assignments vs reads)
- [ ] Tests for: variable, function, class, parameter, enum member
- [ ] Typecheck passes

### US-13.2: Folding ranges

**Description:** As a user, I want to fold classes, functions, blocks, imports, and comments.

**Acceptance Criteria:**
- [ ] `textDocument/foldingRange` handler registered
- [ ] Foldable ranges: class bodies, function bodies, if/for/foreach/while/switch blocks, import groups, comment blocks, AutoDoc blocks (`//!` groups)
- [ ] Uses tree-sitter parse tree (no symbol table needed)
- [ ] Tests for each foldable construct
- [ ] Typecheck passes

### US-13.3: Signature help

**Description:** As a user, I want parameter hints when calling a function or method, showing which parameter I'm currently typing.

**Acceptance Criteria:**
- [ ] `textDocument/signatureHelp` handler registered
- [ ] Trigger characters: `(`, `,`
- [ ] Shows parameter name and type from declaration (tree-sitter)
- [ ] For stdlib functions, shows signature from stdlib-autodoc.json
- [ ] Active parameter tracking based on comma count
- [ ] Decision document written
- [ ] Typecheck passes

### US-13.4: Code actions (quick fixes)

**Description:** As a user, I want quick-fix suggestions for common diagnostics: unused variables, undefined identifiers, missing imports.

**Acceptance Criteria:**
- [ ] `textDocument/codeAction` handler registered
- [ ] Code action: "Add missing import" for undefined identifier that matches a known symbol
- [ ] Code action: "Remove unused variable" for unused local diagnostics
- [ ] Code action: "Add type annotation" for variables where type is inferrable
- [ ] Actions use `WorkspaceEdit` (no direct file manipulation)
- [ ] Decision document written (revises Decision 0002 §13: code actions were out of scope; now in scope)
- [ ] Typecheck passes

### US-13.5: Workspace symbol search

**Description:** As a user, I want to search for symbols across the entire workspace (Ctrl+T / workspace/symbol).

**Acceptance Criteria:**
- [ ] `workspace/symbol` handler registered
- [ ] Searches across all indexed files in WorkspaceIndex
- [ ] Supports fuzzy/prefix matching on symbol names
- [ ] Returns SymbolInformation with location
- [ ] Lazy: only searches files that have been indexed (opened or changed)
- [ ] Typecheck passes

**Exit Criteria:**
- Five new capabilities implemented and tested
- All capabilities registered in `initialize` response
- Target: 60+ new tests across all capabilities
- Decision 0002 revised to include code actions

---

## Phase 14: Infrastructure Hardening

**Goal:** Make the LSP fast and reliable at scale. Support 1,000+ file workspaces.

### US-14.1: Incremental symbol table rebuilds

**Description:** As a developer, I need to rebuild only the parts of a symbol table that changed, not the entire table, so that editing a large file is fast.

**Acceptance Criteria:**
- [ ] Symbol table diffing: detect which scopes changed and only rebuild those
- [ ] WorkspaceIndex `upsertFile()` uses incremental update when possible
- [ ] Benchmark: 1,000-line file edit rebuilds in <10ms (currently rebuilds entire table)
- [ ] All existing tests pass (backward compatible)
- [ ] Decision document written
- [ ] Typecheck passes

### US-14.2: Background workspace indexing

**Description:** As a user, I want the LSP to index my entire workspace on startup, not just files I open, so that `workspace/symbol` and cross-file navigation work immediately.

**Acceptance Criteria:**
- [ ] On `initialized`, kick off background indexing of workspace Pike files
- [ ] File discovery via file watchers (already registered) + initial glob scan
- [ ] Indexing reports progress via `window/workDoneProgress`
- [ ] Does not block or degrade responsiveness of active editing
- [ ] Benchmark: 1,000-file workspace indexes in <5s
- [ ] Typecheck passes

### US-14.3: Persistent cache across restarts

**Description:** As a user, I want the LSP to start fast when reopening a workspace because it reuses cached analysis from the previous session.

**Acceptance Criteria:**
- [ ] Cache symbol tables and workspace index to disk (`.pike-lsp/cache/` in workspace)
- [ ] Cache keyed by file content hash (rebuild only changed files)
- [ ] Cache invalidated when pike version or tree-sitter-pike version changes
- [ ] Cold start with warm cache: <500ms to first responsive
- [ ] Decision document written
- [ ] Typecheck passes

### US-14.4: Configuration schema and settings UI

**Description:** As a user, I want a VSCode settings UI for the LSP configuration options, not just raw `initializationOptions`.

**Acceptance Criteria:**
- [ ] `package.json` contributes configuration with schema for all settings
- [ ] Settings: `diagnosticMode`, `diagnosticDebounceMs`, `maxNumberOfProblems`, `pikeBinaryPath`
- [ ] Settings changes take effect via `didChangeConfiguration` (no restart required)
- [ ] Default values documented
- [ ] Typecheck passes

### US-14.5: Cancellation token propagation

**Description:** As a developer, I need all request handlers to respect CancellationToken so that stale requests don't compete with new ones.

**Acceptance Criteria:**
- [ ] All handlers that accept CancellationToken check `token.isCancellationRequested` before expensive operations
- [ ] Completion handler already checks (Phase 6); extend to definition, references, hover, rename, semanticTokens
- [ ] Tests verify cancellation behavior
- [ ] Typecheck passes

**Exit Criteria:**
- 1,000-file workspace cold-start <5s, warm-start <500ms
- Incremental edits on large files <10ms
- All handlers respect cancellation
- Configuration UI in VSCode
- Target: 30+ new tests

---

## Phase 15: v1.0 Release

**Goal:** Polish, documentation, and release. No new features.

### US-15.1: Documentation audit

**Description:** As a user, I want comprehensive, accurate documentation for the LSP.

**Acceptance Criteria:**
- [ ] README.md covers: install, features, configuration, architecture, contributing
- [ ] `docs/other-editors.md` covers: Neovim, Helix, Sublime, Emacs (or verified generic config)
- [ ] All decision documents are current
- [ ] CHANGELOG.md covers all changes since alpha
- [ ] Typecheck passes

### US-15.2: Real-codebase verification (100+ files)

**Description:** As a developer, I need to verify the LSP against a real Pike codebase of 100+ files with all v1.0 features.

**Acceptance Criteria:**
- [ ] Run LSP against Pike's lib/modules/ (555 files) or equivalent
- [ ] Zero crashes
- [ ] Zero wrong answers (P1)
- [ ] All P2 findings documented with specific input/output
- [ ] Semantic tokens coverage measured (% of tokens with correct type)
- [ ] Typecheck passes

### US-15.3: Performance regression suite

**Description:** As a developer, I need automated performance regression tests so v1.0 stays fast.

**Acceptance Criteria:**
- [ ] Benchmark tests for: completion (cold/warm), hover, definition, semantic tokens, workspace indexing
- [ ] Benchmarks run in CI (marked as slow, separate workflow)
- [ ] Baseline measurements documented in `docs/state-of-project.md`
- [ ] Typecheck passes

### US-15.4: Version bump and release

**Description:** As a maintainer, I need to tag and release v1.0.0.

**Acceptance Criteria:**
- [ ] `package.json` version set to `1.0.0`
- [ ] VSIX built and tested on clean VSCode + Neovim
- [ ] GitHub release with changelog
- [ ] `docs/state-of-project.md` updated to reflect v1.0 status
- [ ] Typecheck passes

**Exit Criteria:**
- v1.0.0 tagged and released
- All documentation current
- Zero P1 findings on real codebase
- Performance baselines established

---

## Functional Requirements

- FR-1: Cross-file inheritance wiring must resolve through WorkspaceIndex for classes defined in other files
- FR-2: Type inference must resolve through function return type annotations
- FR-3: Type inference must resolve through simple assignment initializers
- FR-4: `textDocument/semanticTokens/full` must produce tokens for all symbol table declarations
- FR-5: `textDocument/documentHighlight` must highlight all same-file occurrences of the symbol under cursor
- FR-6: `textDocument/foldingRange` must produce foldable ranges for all block constructs
- FR-7: `textDocument/signatureHelp` must show parameter hints for function calls
- FR-8: `textDocument/codeAction` must provide quick fixes for at least: unused variables, undefined identifiers, missing imports
- FR-9: `workspace/symbol` must search across all indexed workspace files
- FR-10: Background workspace indexing must cover all .pike/.pmod files on startup
- FR-11: Persistent cache must survive LSP restarts and invalidate on version changes
- FR-12: All request handlers must respect CancellationToken
- FR-13: Configuration must be settable via VSCode settings UI without restart

## Non-Goals (Out of Scope for v1.0)

- **Debug adapter protocol (DAP):** Pike debugging is a separate project.
- **Refactoring beyond rename:** Extract function, inline variable, move class — these are v2.0 territory.
- **Inlay hints:** Would be valuable but depends on full type inference, which may not be complete by v1.0.
- **Call hierarchy / type hierarchy:** Requires deeper cross-file analysis than currently planned.
- **On-disk persistent index (clangd-style):** In-memory cache with disk persistence is sufficient for Pike workspace sizes (<10k files typically).
- **LSP 3.17+ proposed features:** Stick to stable LSP spec.
- **Full Pike preprocessor awareness:** Most Pike code doesn't use preprocessor in ways that affect structure. Handling remains as-is.
- **Multi-root workspaces:** Single root only for v1.0.

## Design Considerations

### What rust-analyzer teaches us

- **Incremental everything:** Every analysis result is recomputed from its inputs. No stale caches. We adopt this principle via content-hash caching (already in place) and extend it with Phase 14's incremental rebuilds.
- **Type inference as a progressive ladder:** rust-analyzer started with local inference, then added cross-function, then cross-crate. We follow the same ladder in Phases 10–11.
- **Semantic tokens are the proof of the pudding:** If semantic tokens are correct, the type system is correct. Phase 12 is the integration test for everything before it.

### What gopls teaches us

- **Snapshot immutability:** gopls's `Snapshot` pattern ensures concurrent requests see consistent state. Our per-file SymbolTable is already immutable (rebuilt on change), but we should formalize this in Phase 14.
- **Diagnostics as a separate pipeline:** gopls runs diagnostics in a separate goroutine with its own debouncing. Our `DiagnosticManager` already does this (Decision 0013). Extend the pattern to background indexing.
- **Modification source tracking:** Already implemented (`ModificationSource` enum). Extend to drive different invalidation strategies in Phase 14.

### Pike-specific considerations

- **Pike's module system is flat:** No nested packages like Java/Go. A module is either a `.pmod` file, a `.pmod` directory, or a `.pike` file. This simplifies cross-file resolution significantly.
- **Pike's type system is optionally-typed:** Variables can be `mixed`, functions can return `mixed`. The LSP must handle "I don't know" gracefully — null is better than a wrong guess.
- **AutoDoc coverage varies:** The LSP's hover quality depends on the codebase's documentation conventions. We cannot fix this; we can only document it.
- **Pike's compiler IS the oracle:** We don't implement Pike semantics. We wrap Pike's compiler. This limits what we can do but also limits what we can get wrong.

## Technical Considerations

### Dependency: tree-sitter-pike upstream fixes

Phases 10.3 (scope leaks) adds workarounds for tree-sitter-pike issues #2, #3, #4. If these get fixed upstream, the workarounds should be removed and replaced with field-based access. Track upstream releases.

### Dependency: pike-ai-kb C-level predef resolution

Issue pike-ai-kb#11 blocks richer predef builtin type information. Currently mitigated by `predef-builtin-index.json` (283 symbols). Phase 11.3 may benefit from the fix if it ships.

### Performance targets

| Operation | Target | Current |
|-----------|--------|---------|
| Cold start (1,000 files) | <5s | ~12s (estimated) |
| Warm start (cached) | <500ms | N/A (no cache) |
| Incremental edit | <10ms | ~0.3ms (small file), unknown for large |
| Completion (warm, p99) | <5ms | 2.4ms (current) |
| Semantic tokens (full) | <50ms | N/A |
| Hover | <50ms | ~0.3ms (current) |

### Test strategy

- Maintain the existing three-layer test model (protocol, VSCode integration, manual)
- Phase 12+ tests should include semantic token verification against ground truth
- Phase 14 adds performance regression tests as a fourth layer
- Target: 1,500+ tests by v1.0

## Success Metrics

- **Correctness:** Zero wrong answers on Pike stdlib (555 files). Zero crashes.
- **Completeness:** 12 LSP capabilities (up from 7). Semantic token coverage >90% for explicitly typed code.
- **Performance:** Cold start <5s for 1,000-file workspace. Incremental edit <10ms.
- **Adoption:** v1.0.0 tagged, VSCode Marketplace listed, Neovim docs verified.
- **Test coverage:** 1,500+ tests, 0 failures, 12,000+ assertions.

## Open Questions

1. **Should Phase 14 (Infrastructure) come before Phase 13 (New Capabilities)?** The current ordering prioritizes user-visible features. But if background indexing is needed for workspace/symbol to be useful, Phase 14.2 should move earlier. Revisit after Phase 12.
2. **Should we target LSP 3.17's inline completion for signature help?** Standard signature help is simpler; inline completion is richer but requires more plumbing. Start with standard.
3. **What is the right caching strategy for semantic tokens?** Full recomputation on every edit is simplest. Incremental delta encoding is what the LSP spec supports. Start with full, optimize if profiling shows it's slow.
4. **Should Phase 13 code actions use the Pike worker?** Simple code actions (remove unused, add import) can be done with tree-sitter alone. Richer actions (fix type error) would need Pike. Start simple.
5. **Should we add inlay hints to v1.0?** It's a high-impact feature that exercises the type inference pipeline. If Phase 11 goes smoothly, add it as US-13.6. Otherwise defer to v1.1.

## Phase Summary

| Phase | Name | Key Deliverable | New Tests | Depends On |
|-------|------|----------------|-----------|------------|
| 10 | Cross-file Correctness | Cross-file inheritance, scope fixes, rename precision | 50+ | Phase 9 |
| 11 | Type Inference | Return type + assignment inference, `typeof` integration | 40+ | Phase 10 |
| 12 | Semantic Tokens | Full semantic highlighting | 30+ | Phase 11 |
| 13 | New Capabilities | Highlights, folding, signature help, code actions, workspace symbol | 60+ | Phase 12 |
| 14 | Infrastructure | Incremental rebuild, background indexing, persistent cache, config UI | 30+ | Phase 13 |
| 15 | v1.0 Release | Documentation, verification, performance suite, tag | 10+ | Phase 14 |

**Total estimated tests at v1.0:** ~1,530+

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| tree-sitter-pike bugs block scope correctness | High | Medium | Workarounds in Phase 10.3; track upstream |
| Type inference is harder than expected | Medium | High | Phase 11 is designed to ship partial (assignment inference only) if return-type chains prove too complex |
| PikeWorker `typeof` latency degrades hover | Medium | Medium | Phase 11.3 falls back to declared type on timeout |
| Semantic tokens spec is complex to implement correctly | Low | Medium | Start with full (not incremental) tokens; add deltas in Phase 14 if needed |
| Background indexing blocks editor on large workspaces | Medium | High | Phase 14.2 indexes in background with workDoneProgress; does not block requests |
| Persistent cache corruption | Low | Medium | Cache keyed by content hash; invalidation on version change; graceful fallback to rebuild |
