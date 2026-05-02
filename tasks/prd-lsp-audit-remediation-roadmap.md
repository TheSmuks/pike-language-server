# PRD: LSP Audit Remediation and Roadmap to 1.0

## Introduction

This document is the product of a full codebase audit of the Pike Language Server at commit following Phase 14 completion (1,565 tests, 14 phases, 25 feature files, 9916 LOC in `server/src/features/`). The audit examined every feature module, the test suite, extension wiring, documentation, and architectural decisions against three reference LSPs (rust-analyzer, gopls, clangd) documented in `docs/lsp-references.md`.

The audit found the LSP is **architecturally sound for its current scope** — a tier-3 LSP using a three-source resolution model (tree-sitter, Pike oracle, pre-built indices). The core data flow is correct: parse → symbol table → workspace index → cross-file resolution → LSP response.

However, the audit also found **six categories of issues** that range from architectural gaps that will block feature growth, through correctness bugs that produce wrong answers, to code quality problems that slow development. These are organized into a phased roadmap from the current alpha state through a 1.0 release.

## Goals

- Catalog every issue found in the audit with severity, impact, and evidence
- Establish a prioritized roadmap that addresses correctness first, then architecture, then feature growth
- Identify what was "implemented but not really there" — features that exist in code but don't work correctly or completely
- Identify what the LLM hallucinated — patterns that look correct but are subtly wrong
- Provide a concrete, phase-by-phase plan from current state to 1.0

## Terminology

- **P1**: Will produce wrong answers or crashes for real users under normal usage
- **P2**: Degrades experience or produces wrong answers in edge cases
- **P3**: Code quality, maintainability, or performance issues that don't affect correctness today but will compound

---

## Audit Findings

### Category 1: Architectural Gaps (Blocks Growth)

#### AG-1: No Snapshot/Immutable Workspace View

**Severity**: P1 (will cause inconsistent results under concurrent requests)
**Evidence**: `docs/lsp-references.md` documents this pattern from gopls. The current codebase has zero references to "Snapshot" or any immutable-view abstraction. Every handler reads mutable state from `WorkspaceIndex`, `LRUCache`, and the PikeWorker directly.

**What happens today**: The user types `obj->` which triggers completion. Simultaneously, a `didChange` arrives that mutates the symbol table. The completion handler reads a half-updated state — some references point to the old symbol table, others to the new one. Result: wrong completions, wrong definitions, or null dereferences.

**Why it hasn't bitten yet**: The test suite runs requests sequentially. Real editors send concurrent requests. The race window is small (tens of milliseconds) but non-zero.

**What rust-analyzer/gopls do**: Every request receives an immutable `Snapshot` of the workspace. Edits create new snapshots; in-flight requests on old snapshots complete or get cancelled. The snapshot is the single most important architectural pattern for any LSP that serves concurrent requests.

**Impact on roadmap**: Without this, every new feature that touches shared state adds another race surface. It must be the first architectural change.

#### AG-2: No Incremental Text Sync

**Severity**: P2 (performance, not correctness)
**Evidence**: `server.ts` line 225: `TextDocumentSyncKind.Full`. Every keystroke sends the entire file content to the server. For a 500-line file this is fine. For a 5000-line file this is ~250KB per keystroke.

**What gopls does**: Incremental sync — only the changed range is transmitted. The server applies a text delta.

**Why it matters at scale**: A 10K-line Pike file at ~100 bytes/line = 1MB. Full sync on every keystroke = 1MB * ~5 keys/sec = 5MB/sec of memory allocation and string processing. This will cause visible lag.

#### AG-3: No Multi-File Transaction Support

**Severity**: P2 (rename correctness across files)
**Evidence**: `rename.ts` builds a `WorkspaceEdit` with edits to multiple files, but each file's symbol table is read independently. If the workspace index is being invalidated concurrently (a `didChange` arrived for one of the files being renamed), the rename may produce edits based on stale state for some files and fresh state for others.

**What this means**: Rename preview may show inconsistent results. The user approves a rename, and one file gets the right edit while another misses an occurrence because its symbol table was invalidated mid-rename.

#### AG-4: No Request Prioritization

**Severity**: P3 (UX degradation)
**Evidence**: `pikeWorker.ts` uses a strict FIFO queue (line 127-128). All requests to the Pike subprocess are serialized. If the user triggers hover (fast, important) while a diagnosis is running (slow, 5s timeout), the hover waits.

**What gopls does**: Diagnostics are lower priority than interactive features. The user's keystroke-triggered completions and hover requests preempt background diagnosis.

#### AG-5: Synchronous Symbol Table Build Blocks Event Loop

**Severity**: P3 (latency spikes)
**Evidence**: `symbolTable.ts` `buildSymbolTable()` is synchronous. It walks the entire tree-sitter parse tree and builds declarations, scopes, and references in one blocking call. For a large file, this can take 50-100ms on the main event loop thread.

**What rust-analyzer does**: Analysis runs on a separate thread (rayon thread pool in Rust, but the equivalent here would be a worker thread or breaking the work into yieldable chunks).

---

### Category 2: Correctness Bugs (Wrong Answers)

#### CB-1: Arrow/Dot Rename Uses Name-Based Matching

**Severity**: P1 (will rename the wrong thing)
**Evidence**: `docs/known-limitations.md` explicitly documents this. `rename.ts` includes all `->bark` call sites when renaming `Dog.bark`, regardless of the receiver type. If `Cat` also has `bark()`, renaming `Dog.bark` also renames `Cat.bark`.

**Why it's P1**: The user sees a rename preview, but if they don't carefully check every occurrence, they ship a bug. The rename appears correct because the names match, but the semantics are wrong.

**What's needed**: Type-aware rename. Before including an arrow/dot reference in the rename set, resolve the receiver's type and confirm it matches the class being renamed.

#### CB-2: Cross-File Inherited Member Completion Returns Only Same-File Members

**Severity**: P2 (incomplete completions)
**Evidence**: `docs/state-of-project.md` line 101: "wireInheritance does not resolve cross-file inheritance". If class `Dog` inherits from `Animal` defined in another file, `dog->speak()` won't appear in completions for `dog->`.

**Root cause**: `wireInheritance()` in `scopeBuilder.ts` only wires scopes from the same file. Cross-file inheritance requires reading the parent file's symbol table and importing its class scope — this is not implemented.

#### CB-3: `typeof_()` Not Used for Completion or Definition

**Severity**: P2 (missing type information for `mixed`/`auto` variables)
**Evidence**: `docs/known-limitations.md`: "typeof_() is only called for hover, not completion or definition". A variable declared `mixed x = Dog()` shows the correct type on hover but `x->` produces no completions.

**Root cause**: `completion.ts` and `accessResolver.ts` use `declaredType` and `assignedType` from the symbol table. They never call `worker.typeof_()`. The PikeWorker has the method; it's just not wired.

#### CB-4: Diagnostics Always Have `character: 0`

**Severity**: P2 (UX: error underlines entire line)
**Evidence**: `diagnosticManager.ts` line 474: Pike diagnostics always set `character: 0` for both start and end. The Pike CompilationHandler reports line numbers but not column positions.

**What this looks like to the user**: Every Pike error underlines the entire line in red, not just the erroneous token. This makes it hard to see what exactly is wrong on long lines.

**Fix options**:
1. Parse Pike error messages to extract column info (Pike may include it in the message text)
2. Use tree-sitter to find the error token on the reported line and compute the column
3. Accept this as a permanent limitation and document it

#### CB-5: `assignedType` Only Captures Simple Constructor Calls

**Severity**: P2 (type inference limited to trivial cases)
**Evidence**: `scopeBuilder.ts` `extractInitializerType()` (line 67-). It only handles `Dog()` and `makeDog()` patterns. `mixed x = condition ? Dog() : Cat()` gets no type.

**What this means**: For any non-trivial initializer, the LSP falls back to `declaredType` (which is `mixed`). Completion and definition after `->` on these variables produce nothing.

#### CB-6: Variables in while/switch/do-while Blocks Leak to Enclosing Scope

**Severity**: P2 (wrong scope for variable resolution)
**Evidence**: `docs/known-limitations.md`: upstream tree-sitter-pike issue #4. Variables declared inside `while`, `switch`, or `do-while` blocks are not properly scoped. They leak to the enclosing scope.

**Impact**: Go-to-definition for a variable name that exists both inside a while block and outside it may resolve to the wrong declaration. Rename may include occurrences from the wrong scope.

---

### Category 3: Hallucinated / Subtly Wrong Patterns

#### HW-1: `findMemberInClass` Uses Range Overlap Instead of Scope Ownership

**Severity**: P2 (will match the wrong class scope)
**Evidence**: `typeResolver.ts` line 228-232. `findMemberInClass()` finds a "class body scope" by checking `s.kind === 'class' && s.parentId === classDecl.scopeId && posInRange(s.range, classDecl.nameRange.start)`.

**What's wrong**: This assumes a class body scope's range overlaps with the class declaration's name range. For nested classes, multiple class scopes may satisfy this condition. The correct approach is to find the scope whose `parentId` matches the class declaration's scope, and whose ID matches one of the parent scope's child scopes — not a range overlap.

**When this breaks**: A class defined inside another class's method. Both class scopes share the same file scope as parent. Range overlap may match the wrong inner class.

#### HW-2: `stdlibIndex` Key Format Assumption in Type Resolution

**Severity**: P3 (works today, fragile)
**Evidence**: `typeResolver.ts` line 161: `const stdlibKey = "predef." + typeName`. This assumes stdlib keys are `predef.X.Y.Z`. The actual format is confirmed by the data, but this convention is not documented anywhere in the code. If the data generation changes the key format, this silently returns null.

**Fix**: Extract the key prefix as a named constant with a comment explaining the convention.

#### HW-3: `PRIMITIVE_TYPES` Duplicated Logic

**Severity**: P3 (maintenance trap)
**Evidence**: `scopeBuilder.ts` defines `PRIMITIVE_TYPES`. `typeResolver.ts` line 101 duplicates the fallback logic: `declaredType && !PRIMITIVE_TYPES.has(declaredType) ? declaredType : assignedType`. This ternary pattern appears in 3 files.

**What's wrong**: The logic "use declaredType unless it's a primitive, then fall back to assignedType" is correct but fragile. If the fallback logic needs to change (e.g., also check for `object` which might have members), all three call sites must be updated.

**Fix**: Extract a single `resolveTypeName(decl: Declaration): string | null` function that encapsulates the priority chain.

#### HW-4: `completionTrigger.ts` at 578 Lines — God Module

**Severity**: P3 (maintainability)
**Evidence**: `completionTrigger.ts` contains: trigger context detection, stdlib children mapping, stdlib top-level listing, identifier filtering, declaration-to-completion-item conversion, sort key padding, declaration lookup, type member resolution, predef signature cleaning, and completion cache reset. This is 10+ responsibilities in one file.

**What this means**: Any change to completion behavior requires understanding all 578 lines. The file exceeds the 500-line guideline in AGENTS.md.

---

### Category 4: Missing Features (Documented as Implemented but Incomplete)

#### MF-1: `textDocument/implementation` Is Shallow

**Severity**: P2 (incomplete feature)
**Evidence**: `implementation.ts` only finds classes that directly inherit from the class at cursor. It does not find:
- Indirect inheritance (A inherits B inherits C — querying C won't find A)
- Interface-like patterns (classes implementing the same method signature)
- Method implementations (overridden methods in subclasses)

**What rust-analyzer does**: `textDocument/implementation` follows the full inheritance chain and also shows trait implementations.

#### MF-2: Code Actions Are Minimal

**Severity**: P3 (not wrong, just thin)
**Evidence**: `codeAction.ts` (235 lines) provides exactly two actions: "remove unused variable" and "add missing import". The ADR (0002) originally scoped code actions out of tier-3, then phase 14 added them minimally.

**What's missing**:
- Quick-fix for type errors (suggest cast, suggest correct type)
- Organize imports
- Add missing method implementation (for inherited classes)
- Generate constructor

#### MF-3: No `textDocument/documentLink`

**Severity**: P3 (convenience feature)
**Evidence**: Not listed in `state-of-project.md` capabilities table. String literals in `inherit` and `import` statements could be clickable links to the target file. rust-analyzer and gopls both provide this.

#### MF-4: No `textDocument/inlayHint`

**Severity**: P3 (convenience feature)
**Evidence**: Not implemented. Inlay hints would show:
- Inferred types on `mixed`/`auto` variables
- Parameter names at call sites
- Return types on functions without annotations

**Why it matters**: Pike code often uses `mixed` types. Inlay hints would surface type information without requiring hover.

#### MF-5: No `textDocument/callHierarchy`

**Severity**: P3 (navigation feature)
**Evidence**: Not implemented. rust-analyzer and gopls both provide call hierarchy.

#### MF-6: No `textDocument/selectionRange`

**Severity**: P3 (editor integration)
**Evidence**: Not implemented. Used by "Expand Selection" in VS Code. Would need tree-sitter tree walking, which is straightforward.

---

### Category 5: Code Quality Issues

#### CQ-1: 28 Empty `catch {}` Blocks

**Severity**: P3 (masked failures)
**Evidence**: `grep -rn "catch {" server/src/` returns 28 results. Most are in `server.ts` and `navigationHandler.ts` catching "Connection may be closed during teardown."

**Why this is dangerous**: The pattern `try { connection.console.error(...) } catch { // Connection closed }` is reasonable for teardown. But some of these catch blocks may also swallow programming errors (null dereferences, type errors) that should crash during development.

**Fix**: At minimum, add a comment to each explaining what error is expected. Ideally, catch the specific error type or check a `disposed` flag before the try.

#### CQ-2: `WorkspaceIndex` at 694 Lines — Two Responsibilities

**Severity**: P3 (single responsibility)
**Evidence**: `workspaceIndex.ts` handles both:
1. File indexing (upsert, remove, invalidate)
2. Cross-file resolution (resolveCrossFileDefinition, getCrossFileReferences, resolveCrossFileMemberAccess)

These are separate concerns. The resolution logic (lines 436-694) depends on the index but doesn't modify it. It should be a separate module.

#### CQ-3: `xmlParser.ts` at 836 Lines — Largest Feature File

**Severity**: P3 (exceeds 500-line guideline)
**Evidence**: `xmlParser.ts` is 836 lines. It handles AutoDoc XML parsing, which is a stable, well-tested component. But its size makes the feature directory harder to navigate.

**Fix**: Split into `xmlTokenizer.ts` (lexer) and `xmlParser.ts` (parser).

#### CQ-4: Handler Registration Scattered Between `server.ts` and `navigationHandler.ts`

**Severity**: P3 (discoverability)
**Evidence**: Some handlers are registered in `server.ts` (`onDidChangeContent`, `onDidClose`, `onDidChangeWatchedFiles`, `onShutdown`), others in `navigationHandler.ts` (`onDefinition`, `onReferences`, `onRename`, etc.), and `hoverHandler.ts` registers the hover handler. The split is not clearly delineated.

**What rust-analyzer does**: All handler registration in one place, with handlers delegating to feature modules.

#### CQ-5: No Shared Server Test Helper Refactoring

**Severity**: P3 (test quality)
**Evidence**: Multiple test files duplicate `createTestServer()` setup with slight variations. `sharedServer.test.ts` exists but the pattern is not universal.

---

### Category 6: Infrastructure and Process

#### IP-1: No Incremental Build for Extension

**Severity**: P3 (developer velocity)
**Evidence**: `build:extension` uses esbuild which is fast, but there's no watch mode for extension development. Changing server code requires manual rebuild.

#### IP-2: Harness Snapshots Not Version-Locked to Pike

**Severity**: P3 (test stability)
**Evidence**: Harness snapshots are generated by running `pike` on corpus files. Different Pike versions may produce different output. The snapshots are not tagged with the Pike version that generated them.

**What this means**: A user with Pike 8.0.702 runs `bun test` and gets snapshot mismatches because the snapshots were generated with Pike 8.0.1116.

#### IP-3: No Benchmark Regression Detection

**Severity**: P3 (performance)
**Evidence**: `tests/perf/benchmarks.test.ts` exists with 3x slack for CI variability. But there's no historical tracking — performance regressions between versions are invisible until a human notices.

---

## Roadmap: Alpha to 1.0

### Phase 15: Correctness Foundations

**Goal**: Fix every correctness bug. Add the Snapshot pattern. This phase produces no new features.

**Rationale**: Every subsequent phase builds on shared state. Fixing the state management model now prevents compounding race conditions.

| Story | Issue | Description |
|-------|-------|-------------|
| US-001 | AG-1 | Implement Snapshot pattern for WorkspaceIndex |
| US-002 | CB-1 | Type-aware arrow/dot rename |
| US-003 | CB-2 | Cross-file inherited member completion |
| US-004 | CB-3 | Wire `typeof_()` into completion and definition |
| US-005 | CB-6 | Add scope handlers for while/switch/do-while blocks |
| US-006 | CQ-1 | Audit all 28 empty catch blocks, add comments or specific error types |

**Exit criteria**:
- All 1,565+ existing tests pass
- New tests for each story
- `textDocument/rename` on arrow/dot access is type-aware
- `x->member` completion works for cross-file inherited members
- No empty catch blocks without explanatory comments

### Phase 16: Diagnostic Precision and Type Inference

**Goal**: Improve diagnostic quality. Extend type inference beyond simple constructors.

| Story | Issue | Description |
|-------|-------|-------------|
| US-007 | CB-4 | Extract column positions from Pike diagnostics or compute via tree-sitter |
| US-008 | CB-5 | Extend `extractInitializerType` to handle ternary, chains, and function return types |
| US-009 | HW-3 | Extract `resolveTypeName()` utility, deduplicate PRIMITIVE_TYPES fallback |
| US-010 | HW-1 | Fix `findMemberInClass` to use scope ownership instead of range overlap |

**Exit criteria**:
- Pike diagnostics have column-level positions where possible
- Type inference handles ternary constructors and function call chains
- `resolveTypeName()` is the single source of truth for type priority
- Nested class member resolution is correct

### Phase 17: Architectural Hardening

**Goal**: Address performance and structural issues. Prepare for feature additions.

| Story | Issue | Description |
|-------|-------|-------------|
| US-011 | AG-2 | Implement incremental text sync (`TextDocumentSyncKind.Incremental`) |
| US-012 | AG-4 | Add request prioritization to PikeWorker (interactive > background) |
| US-013 | AG-5 | Yield during symbol table build for large files |
| US-014 | CQ-2 | Extract cross-file resolution from `workspaceIndex.ts` into `crossFileResolver.ts` |
| US-015 | CQ-3 | Split `xmlParser.ts` into tokenizer and parser |
| US-016 | CQ-4 | Centralize handler registration |

**Exit criteria**:
- Incremental sync reduces per-keystroke data transfer by 95%+ for large files
- Hover and completion preempt background diagnosis
- Large file parsing does not block the event loop for >50ms
- No feature file exceeds 500 lines

### Phase 18: Feature Completions (Navigation)

**Goal**: Add missing navigation features to match rust-analyzer/gopls baseline.

| Story | Issue | Description |
|-------|-------|-------------|
| US-017 | MF-1 | Deep implementation lookup (transitive inheritance) |
| US-018 | MF-3 | `textDocument/documentLink` for import/inherit paths |
| US-019 | MF-6 | `textDocument/selectionRange` via tree-sitter |
| US-020 | AG-3 | Transactional rename across files |

**Exit criteria**:
- `textDocument/implementation` follows full inheritance chain
- Import/inherit paths are clickable
- Expand selection works
- Rename is atomic across all affected files

### Phase 19: Feature Completions (Productivity)

**Goal**: Add productivity features that make the LSP feel modern.

| Story | Issue | Description |
|-------|-------|-------------|
| US-021 | MF-4 | `textDocument/inlayHint` for inferred types and parameter names |
| US-022 | MF-5 | `textDocument/callHierarchy` |
| US-023 | MF-2 | Extend code actions (organize imports, add missing method, generate constructor) |
| US-024 | HW-4 | Refactor `completionTrigger.ts` into focused modules |

**Exit criteria**:
- Inlay hints show inferred types on `mixed`/`auto` variables
- Call hierarchy shows callers and callees
- At least 5 code actions available
- No file exceeds 500 lines

### Phase 20: Scale and Polish

**Goal**: Performance at realistic scale. Edge case handling. Production readiness.

| Story | Issue | Description |
|-------|-------|-------------|
| US-025 | IP-2 | Version-lock harness snapshots to Pike version |
| US-026 | IP-3 | Add benchmark regression tracking |
| US-027 | AG-3 (cont.) | Test and verify multi-file transaction safety under concurrent edits |
| US-028 | — | Stress test with real Pike codebase (Pike lib/modules, 500+ files) |
| US-029 | — | Edge case audit: empty files, files with only comments, files with parse errors |

**Exit criteria**:
- Harness snapshots include Pike version metadata
- Benchmark history tracks performance across versions
- No crashes or wrong answers on real Pike codebase
- 1.0 release candidate tagged

---

## Non-Goals

- **Formatting provider**: Pike has no canonical formatter. Out of scope for 1.0.
- **DAP integration**: The existing `hww3/vscode-debugger-pike` handles debugging. No overlap needed.
- **Roxen/RXML support**: The LSP targets Pike language features, not framework-specific features.
- **Language server protocol extensions**: No custom protocol messages.
- **Multi-root workspaces**: Single workspace root is sufficient for Pike projects.

---

## Functional Requirements

- FR-1: The server MUST serve all LSP requests from an immutable snapshot of workspace state (AG-1)
- FR-2: `textDocument/rename` on arrow/dot access MUST verify the receiver type before including references (CB-1)
- FR-3: Cross-file inherited members MUST appear in dot/arrow completion (CB-2)
- FR-4: `typeof_()` MUST be consulted when `declaredType` is `mixed`/`auto`/absent, for all features (CB-3)
- FR-5: Pike diagnostics SHOULD have column-level positions (CB-4)
- FR-6: Type inference MUST handle ternary expressions and function call chains (CB-5)
- FR-7: Variables declared in while/switch/do-while blocks MUST NOT leak to enclosing scope (CB-6)
- FR-8: Incremental text sync MUST be supported for files >1000 lines (AG-2)
- FR-9: Interactive requests (hover, completion) MUST preempt background diagnosis (AG-4)
- FR-10: No feature file MUST exceed 500 lines (CQ-2, CQ-3, HW-4)
- FR-11: `textDocument/implementation` MUST follow transitive inheritance chains (MF-1)
- FR-12: Import and inherit string paths MUST be navigable as document links (MF-3)
- FR-13: `textDocument/inlayHint` MUST show inferred types for `mixed`/`auto` variables (MF-4)
- FR-14: `textDocument/callHierarchy` MUST show callers and callees (MF-5)
- FR-15: All empty catch blocks MUST have explanatory comments (CQ-1)

---

## Design Considerations

### Snapshot Pattern (AG-1)

The implementation should follow gopls's approach:
1. `WorkspaceSnapshot` is an immutable interface over indexed data
2. Each `didChange` creates a new snapshot; old snapshots are reference-counted
3. Request handlers receive a snapshot at the start, use it throughout
4. Background operations (diagnosis, indexing) work on their own snapshot

This is the largest single change. It touches every handler and the WorkspaceIndex API. Phase 15 should implement the snapshot wrapper and migrate handlers incrementally.

### Type Resolution Centralization (HW-3)

The pattern `declaredType && !PRIMITIVE_TYPES.has(declaredType) ? declaredType : assignedType` appears in:
- `typeResolver.ts:101` (resolveMemberAccess)
- `completionTrigger.ts` (resolveTypeMembers)
- `hoverHandler.ts` (type display)

All three should call `resolveTypeName(decl)` which encapsulates:
1. If `declaredType` is present and not primitive → use it
2. If `assignedType` is present → use it
3. If the PikeWorker is available and type is `mixed`/`auto` → call `typeof_()`
4. Otherwise → null

### Cross-File Inheritance Wiring (CB-2)

`wireInheritance()` in `scopeBuilder.ts` currently only resolves same-file parents. The fix:
1. After building the symbol table, check for `inherit` declarations that resolve to other files
2. Look up the parent file's symbol table via the index adapter
3. Import the parent class scope's declarations into the child's inherited scopes
4. This requires the index adapter to support async resolution — currently sync-only

---

## Technical Considerations

### Snapshot Implementation in TypeScript

TypeScript doesn't have Rust's ownership system. The Snapshot pattern needs to be enforced by convention:
- `WorkspaceSnapshot` exposes only read methods
- `WorkspaceIndex` has a `snapshot(): WorkspaceSnapshot` method that returns a frozen view
- Frozen view can be implemented by capturing the current `files` Map entries at snapshot time

### Pike Column Position Extraction

Pike's CompilationHandler does not report column positions directly. Options:
1. Parse the error message text for patterns like `"line X:Y"` — Pike may include this
2. After receiving a line-only diagnostic, use tree-sitter to find ERROR nodes on that line
3. Accept line-only as a permanent limitation

Option 2 is the most robust: Pike says "error on line 42", tree-sitter says "ERROR node at line 42, columns 15-20". Merge the two.

### `typeof_()` Integration Cost

Calling `typeof_()` for completion requires a Pike subprocess round-trip (~30ms). This is too slow for interactive completion. Options:
1. Cache `typeof_()` results by (file, position, content-hash)
2. Use `typeof_()` only for pre-resolved types (on save, not on keystroke)
3. Accept the latency for `mixed` variables and show a loading indicator

Option 1 is the best: cache on save, serve from cache during completion.

---

## Success Metrics

- **Correctness**: Zero P1 issues remaining after Phase 16
- **Architecture**: Snapshot pattern implemented, zero race conditions in concurrent request tests
- **Feature parity**: Match rust-analyzer baseline for navigation features (definition, references, rename, implementation, call hierarchy)
- **Performance**: Completion response <20ms warm for 500-file workspace; hover <5ms warm
- **Code quality**: No file >500 lines; no empty catch blocks without comments; zero `as any` casts

---

## Open Questions

1. **Snapshot scope**: Should the snapshot include the PikeWorker state (diagnostics cache, autodoc cache), or only the workspace index? Including PikeWorker state means the snapshot captures everything; excluding it means Pike results can change under a snapshot.
2. **`typeof_()` caching strategy**: Cache on save vs. cache on first access vs. background pre-computation?
3. **Incremental sync edge cases**: How to handle edits that change the line count (insertions/deletions) when computing column positions for existing diagnostics?
4. **Phase ordering**: Should Phase 17 (architectural hardening) come before Phase 16 (diagnostic precision)? The former is larger but blocks more future work.
5. **1.0 release criteria**: Beyond "all tests pass and no P1 bugs," what user-facing milestones define 1.0 readiness? Multi-editor verification? Real-world codebase testing duration?

---

## Appendix: File Inventory and Risk Assessment

| File | Lines | Risk | Notes |
|------|-------|------|-------|
| `xmlParser.ts` | 836 | Low | Stable, well-tested. Size only. |
| `workspaceIndex.ts` | 694 | Medium | Dual responsibility. Cross-file resolution should extract. |
| `scopeBuilder.ts` | 644 | Medium | Core of symbol table. Changes here affect everything. |
| `navigationHandler.ts` | 592 | Low | Handler wiring. Safe to refactor. |
| `pikeWorker.ts` | 585 | Low | Well-isolated subprocess. FIFO queue is correct. |
| `declarationCollector.ts` | 580 | Medium | Directly affected by tree-sitter limitations (upstream #2, #3, #4). |
| `completionTrigger.ts` | 578 | High | God module, 10 responsibilities. Must split. |
| `moduleResolver.ts` | 553 | Low | Stable. Cache-only sync path is well-designed. |
| `diagnosticManager.ts` | 497 | Low | Debounce/supersession logic is correct. |
| `symbolTable.ts` | 437 | High | Core data structure. All resolution depends on it. |
| `signatureHelp.ts` | 405 | Low | Self-contained. |
| `completion.ts` | 385 | Medium | Depends on completionTrigger (HW-4). |
| `hoverHandler.ts` | 319 | Low | Three-tier routing works. |
| `semanticTokens.ts` | 306 | Low | Production + delta encoding. |
| `referenceCollector.ts` | 302 | Medium | Has one remaining TODO (arrow resolution). |
| `accessResolver.ts` | 278 | Medium | Chain resolution works but uses range overlap (HW-1). |
| `typeResolver.ts` | 277 | Medium | Core type resolution. HW-3 fallback duplication. |
| `rename.ts` | 260 | High | CB-1 (name-based matching) is a correctness bug. |
| `codeAction.ts` | 235 | Low | Minimal but correct. |
| `documentSymbol.ts` | 227 | Low | Stable. |
| `persistentCache.ts` | 220 | Low | Graceful fallback on corrupt cache. |
| `backgroundIndex.ts` | 184 | Low | Fire-and-forget. |
| `server.ts` | 482 | Medium | Entry point. Handler registration split (CQ-4). |

---

## Appendix: Upstream Dependencies

| Dependency | Issue | Impact | Status |
|------------|-------|--------|--------|
| tree-sitter-pike | #2: Missing field names on for_statement | Positional scanning workaround | Open |
| tree-sitter-pike | #3: catch expression lost in assignment | No scope for catch-block variables | Open |
| tree-sitter-pike | #4: No scope-introducing nodes for while/switch/plain blocks | Variable leakage | Open, workaround in Phase 15 (US-005) |
| pike-ai-kb | #11: pike-signature cannot resolve C-level predef builtins | Mitigated by predef-builtin-index.json | Open |
