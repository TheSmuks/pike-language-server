# PRD: Pike LSP Full Audit Remediation & Roadmap

## Introduction

The Pike Language Server codebase was largely LLM-generated across 14 phases. While the architecture is sound and 1588 tests pass, a deep audit reveals real bugs, shallow test coverage, TigerStyle violations, documentation inaccuracies, and missing capabilities compared to mature LSPs like rust-analyzer and gopls.

This PRD captures every finding from a full codebase audit, fixes critical bugs immediately, and produces a prioritized roadmap for the remaining work. The goal: transform the codebase from "compiles and passes tests" to "production-ready LSP that real Pike developers can rely on."

## Goals

- Fix all confirmed bugs that produce incorrect LSP behavior under real conditions
- Eliminate test mocks, harden vacuous assertions, and convert hand-written expectations to oracle-derived where feasible
- Correct all documentation inaccuracies (wrong directory names, stale counts, phantom scripts)
- Produce a phased roadmap for TigerStyle compliance (file/function splits) and architectural improvements
- Establish a clear target state informed by rust-analyzer and gopls patterns

## Audit Findings

### Critical (produces incorrect behavior)

| ID | File | Finding |
|----|------|---------|
| A-001 | `symbolTable.ts` `extractInitializerType` | `Dog d = makeDog()` sets `assignedType = 'makeDog'` (the function name), not `'Dog'` (the return type). Type inference from call expressions returns the callee name, not the type. |
| A-002 | `pikeWorker.ts` `requestCount` never reset | After `shouldForceRestart()` triggers a restart, `requestCount` stays above the ceiling forever. Every subsequent request triggers a restart. |
| A-003 | `pikeWorker.ts` `drainQueue` uses `Array.shift()` | O(n) per shift, O(n²) total for queue processing. Under load (rapid didChange events), this creates visible latency. |
| A-004 | `backgroundIndex.ts` URI construction | `file://${filepath}` does not encode spaces or special characters. Paths like `/my project/foo.pike` produce invalid URIs. |
| A-005 | `moduleResolver.ts` synchronous filesystem calls | `detectPikePaths` uses `execSync`, `existsSync`, `statSync` — all block the event loop. Called during `onInitialize`, blocking LSP startup. |

### High (brittle, will break under edge cases)

| ID | File | Finding |
|----|------|---------|
| A-006 | `server.ts` `declForHover` | Extracts signature via `source.split('\n')[decl.range.start.line]` — includes trailing semicolons, comments, and closing braces. |
| A-007 | `server.ts` `renderPredefSignature` regex | Naively strips `scope(...)` wrappers. Breaks on nested `scope()` calls like `scope(0, scope(1, function(...)))`. Duplicated in `completion.ts` `cleanPredefSignature`. |
| A-008 | `completion.ts` `completeMemberAccess` ignores `_accessType` | No distinction between `.` (public members) and `->` (all members) access. Pike's access control is bypassed. |
| A-009 | `completion.ts` `findIdentifierInExpr` | Only checks `node.child(node.childCount - 1)` — misses identifiers in comma expressions and multi-child nodes. |
| A-010 | `typeResolver.ts` synthetic Declaration `id: -1` | Multiple synthetic declarations collide in `declById` map. `containsDecl` function is dead code. |
| A-011 | `signatureHelp.ts` `findEnclosingCall` | Doesn't verify cursor is inside the argument list, or that parentheses are balanced. For chained calls `a.b().c()`, extracts wrong callee. |
| A-012 | `signatureHelp.ts` `splitParams` | Naive comma splitter doesn't handle nested function type signatures like `function(int, string: void)`. |
| A-013 | `accessResolver.ts` chained access | For `a.b.c`, takes `children[i - 1]` as LHS — may get another postfix_expr instead of identifier. |
| A-014 | `accessResolver.ts` `resolveAccessCore` re-parses | Parses the document again even though caller already has a parsed tree. Wasteful. |
| A-015 | `workspaceIndex.ts` `hashContent` DJB2 | Bitwise `& 0xffffffff` produces signed 32-bit integers. `hash.toString(16)` can produce negative hex strings. |
| A-016 | `workspaceIndex.ts` `getCrossFileReferences` | Matches by name with `ref.resolvesTo === null` — produces false positives when unrelated files have same-named symbols. |
| A-017 | `pikeWorker.ts` `restart()` race condition | Waits 100ms then pings — process may not be ready. No health check loop. |

### Medium (incorrect but unlikely in practice / code quality)

| ID | File | Finding |
|----|------|---------|
| A-018 | `parser.ts` `getCachedTree` | Bypasses LRU recency update — cached trees get prematurely evicted. |
| A-019 | `parser.ts` `initParser` | Swallows all WASM-load errors silently — impossible to debug path issues. |
| A-020 | `symbolTable.ts` `getReferencesTo` | Includes declaration itself via `results.unshift()` — callers must know first element may be the decl, not a reference. |
| A-021 | `symbolTable.ts` `wireCrossFileInheritance` | Mutates symbol table non-reproducibly — same file produces different tables depending on workspace index state. |
| A-022 | `symbolTable.ts` `findScopeForNode` | Uses scope ID as tiebreaker — assumes monotonically increasing IDs, fragile. |
| A-023 | `autodocRenderer.ts` `parseXml` | Hand-written XML parser with no well-formedness validation. Malformed XML produces silent incorrect output. |
| A-024 | `autodocRenderer.ts` duplicate `case 'group'` | Second case is unreachable in `renderBlocks`. |
| A-025 | `rename.ts` `__foo__` reserved pattern | Regex `/^__[a-z].*__$/` misses uppercase patterns like `__FOO__`. |
| A-026 | `rename.ts` `validateRenameName` | Doesn't check against `protectedNames` set (stdlib/predef). That check only exists in `getRenameLocations`. |
| A-027 | `diagnosticManager.ts` `computeContentHash` | SHA-256 for cache invalidation is overkill — faster non-crypto hash would suffice. |
| A-028 | `diagnosticManager.ts` `safeParseDiagnostics` | Parses without URI, doesn't benefit from LRU cache. |
| A-029 | `persistentCache.ts` `computeWasmHash` | Uses `require('node:fs')` (CommonJS) in ESM module. `readFileSync` blocks event loop. |

### Low (style / documentation / minor)

| ID | File | Finding |
|----|------|---------|
| A-030 | `lruCache.ts` `evictOne` | O(n) per eviction. Should use min-heap for O(log n). |
| A-031 | `completion.ts` module-level singletons | `stdlibChildrenMap` and `stdlibTopLevelNames` are never invalidated. Stale if stdlib index changes at runtime. |
| A-032 | `moduleResolver.ts` cache key | Includes `currentFile` — same module resolved from different files creates separate entries. Large cache for big workspaces. |

### Documentation Inaccuracies

| ID | Document | Finding |
|----|----------|---------|
| D-001 | `AGENTS.md` | Lists `extension/` directory. Actual directory is `client/`. |
| D-002 | `AGENTS.md` | Lists `bun run lint` command. No `lint` script exists in `package.json`. |
| D-003 | `docs/architecture.md` | Same `extension/` → `client/` error as AGENTS.md. |
| D-004 | `docs/ci.md` | References `npm ci` and `actions/setup-node@v4`. Project uses Bun, not npm. Template boilerplate. |
| D-005 | `docs/existing-tooling.md` | Claims "No tree-sitter grammar for Pike" — tree-sitter-pike now exists and is used. Outdated historical claim. |
| D-006 | `docs/state-of-project.md` | Claims 1,565 tests — actual is 1,588. Claims 37 corpus files — actual is 66. |
| D-007 | `decisions/0002-tier-3-scope.md` | Lists rename and code actions as "out of scope" — both were implemented in later phases. |
| D-008 | `decisions/0010-cross-file-resolution.md` | Says "resolve.pike NOT IMPLEMENTED" — file now exists at `harness/resolve.pike`. |
| D-009 | `decisions/0003-pike-ai-kb-integration.md` | Describes PikeOracle MCP interface that was never built. Superseded by PikeWorker subprocess (decision 0011). |

### Test Integrity Issues

| ID | File | Finding |
|----|------|---------|
| T-001 | `tests/lsp/hover.test.ts` US-009 | Monkey-patches `worker.typeof_` to simulate Pike responses. This IS a mock, violating the project's no-mock rule. |
| T-002 | `tests/lsp/references.test.ts` | Several tests use `if (result) { expect... }` — pass vacuously when result is null/undefined. |
| T-003 | `tests/lsp/edge-cases.test.ts` | Same conditional assertion pattern — tests pass when they should fail. |
| T-004 | `tests/lsp/definition.test.ts` | Same conditional assertion pattern in scope shadowing tests. |
| T-005 | `tests/integration/activation.test.ts` | Empty stub — 11 lines, 0 tests, just comments. |
| T-006 | `tests/integration/crossFilePropagation.test.ts` | Empty stub — 45 lines, 0 tests, just comments. |
| T-007 | `tests/integration/documentSymbol.test.ts` | Empty stub — 9 lines, 0 tests. |
| T-008 | `tests/integration/error-recovery.test.ts` | Empty stub — 9 lines, 0 tests. |
| T-009 | `tests/lsp/lifecycle.test.ts` | 1 `test.todo('exit after shutdown does not throw')` — never implemented. |
| T-010 | `tests/lsp/real-codebase-verification.test.ts` | 11 tests that mostly check `toBeDefined()` — crash testing, not correctness testing. |
| T-011 | Multiple definition/completion/edge-case tests | Hand-written expected values (line numbers, ref counts) verified by human/LLM, not derived from Pike oracle. |

### TigerStyle Violations

| File | Lines | Limit | Ratio |
|------|-------|-------|-------|
| `symbolTable.ts` | 1,892 | 500 | 3.8x |
| `server.ts` | 1,087 | 500 | 2.2x |
| `completion.ts` | 927 | 500 | 1.9x |
| `autodocRenderer.ts` | 918 | 500 | 1.8x |
| `pikeWorker.ts` | 554 | 500 | 1.1x |
| `workspaceIndex.ts` | 581 | 500 | 1.2x |

### Missing LSP Capabilities (vs rust-analyzer / gopls)

| ID | Capability | rust-analyzer | gopls | Pike LSP |
|----|-----------|---------------|-------|----------|
| M-001 | Immutable workspace snapshots | salsa-based | Snapshot type | No — mutable global state |
| M-002 | Incremental AST invalidation | InputFunction memoization | Package-level | Full rebuild per edit |
| M-003 | Inlay hints | Full | Full | None |
| M-004 | Code lenses | Full | Full | None |
| M-005 | Go to Implementation | Full | Full | None |
| M-006 | Find All Implementers | Full | Full | None |
| M-007 | Call hierarchy | Full | Full | None |
| M-008 | Type hierarchy | Full | Partial | None |
| M-009 | Selection range | Full | Full | None |
| M-010 | Linked editing range | Full | Partial | None |
| M-011 | On-type formatting | Full | Partial | None |
| M-012 | Persistent on-disk symbol index | salsa cache | go/packages | JSON cache exists but fragile |
| M-013 | Cancel token propagation to Pike worker | N/A (in-process) | context.Context | No — cancellation checked only at handler level |

## Roadmap

### Phase 1: Critical Bug Fixes (PR this cycle)

Fix bugs that produce incorrect LSP behavior. No structural changes.

---

### US-001: Fix extractInitializerType returning function name instead of type
**Description:** As a Pike developer using the LSP, I want type inference from call expressions to resolve to the actual return type, so that completion and hover show correct types.

**Acceptance Criteria:**
- [ ] `extractInitializerType` in `symbolTable.ts` does not assign the callee function name as `assignedType`
- [ ] For `Dog d = makeDog()`, `assignedType` is either resolved to `Dog` (if resolvable) or left unset — never `'makeDog'`
- [ ] Add a test: parse `class Dog {} Dog d = makeDog();` and verify `assignedType` is not `'makeDog'`
- [ ] Typecheck passes

---

### US-002: Fix PikeWorker requestCount never resetting after forced restart
**Description:** As a developer, I want the PikeWorker request counter to reset after a forced restart, so that the worker doesn't restart on every subsequent request.

**Acceptance Criteria:**
- [ ] `requestCount` is reset to 0 in `restart()` method after the new process is confirmed healthy
- [ ] Add a test: force `requestCount` above ceiling, trigger restart, verify it resets to 0
- [ ] Typecheck passes

---

### US-003: Replace PikeWorker queue Array.shift with proper deque
**Description:** As a developer, I want the PikeWorker request queue to process in O(1) per dequeue, so that rapid edit bursts don't create visible latency.

**Acceptance Criteria:**
- [ ] Replace `this.queue.shift()` with index-based dequeue (maintain `head` index, reset when empty)
- [ ] Or use a simple ring buffer pattern
- [ ] Existing worker tests still pass
- [ ] Typecheck passes

---

### US-004: Encode file URIs in backgroundIndex
**Description:** As a Pike developer with spaces in file paths, I want background indexing to produce valid URIs, so that workspace symbols are discoverable.

**Acceptance Criteria:**
- [ ] `backgroundIndex.ts` uses `Uri.file(filepath).toString()` or `encodeURI` for file URIs
- [ ] Add a test: create temp directory with space in name, verify workspace/symbol returns valid URI
- [ ] Typecheck passes

---

### US-005: Convert moduleResolver sync calls to async
**Description:** As a developer, I want module resolution to not block the event loop, so that LSP startup and file resolution don't freeze the server.

**Acceptance Criteria:**
- [ ] `detectPikePaths` uses `execFile` (async) instead of `execSync`
- [ ] `findModuleInPath` uses `fs.promises.access` and `fs.promises.stat` instead of sync variants
- [ ] `onInitialize` handler awaits the async path detection
- [ ] Existing module resolver tests still pass
- [ ] Typecheck passes

---

### Phase 2: High-Priority Fixes

Fix brittle code that will break under real-world edge cases.

---

### US-006: Fix declForHover signature extraction
**Description:** As a Pike developer using hover, I want to see clean function/class signatures without trailing semicolons or comments.

**Acceptance Criteria:**
- [ ] `declForHover` in `server.ts` extracts the declaration node range from the tree-sitter AST instead of splitting source by newline
- [ ] Signatures do not include trailing `;`, `{`, or inline comments
- [ ] Existing hover tests still pass
- [ ] Add a test: hover over `int x = 5; // comment` and verify signature is `int x = 5` not `int x = 5; // comment`
- [ ] Typecheck passes

---

### US-007: Deduplicate and fix scope-stripping regex
**Description:** As a developer, I want a single correct scope-stripping utility, so that nested `scope()` calls render correctly and the logic isn't duplicated.

**Acceptance Criteria:**
- [ ] Extract scope-stripping logic to a shared utility function in `util/`
- [ ] Handle nested `scope()` calls correctly (e.g., `scope(0, scope(1, function(...)))`)
- [ ] Replace both usages in `server.ts` (`renderPredefSignature`) and `completion.ts` (`cleanPredefSignature`)
- [ ] Add a test for nested scope stripping
- [ ] Typecheck passes

---

### US-008: Distinguish dot vs arrow member access in completion
**Description:** As a Pike developer, I want the LSP to respect Pike's access control — `.` shows only public members, `->` shows all members.

**Acceptance Criteria:**
- [ ] `completeMemberAccess` uses the `accessType` parameter (currently `_accessType`, ignored)
- [ ] For `.` access, filter to public declarations only
- [ ] For `->` access, show all declarations
- [ ] Add tests for both access types
- [ ] Typecheck passes

---

### US-009: Fix typeResolver synthetic Declaration ID collisions
**Description:** As a developer, I want synthetic declarations to have unique IDs, so that `declById` lookups don't collide.

**Acceptance Criteria:**
- [ ] Use a monotonically increasing counter for synthetic declaration IDs (starting from a negative range to distinguish from real IDs)
- [ ] Remove dead `containsDecl` function
- [ ] Existing type resolution tests pass
- [ ] Typecheck passes

---

### US-010: Fix signatureHelp chained call and nested type handling
**Description:** As a Pike developer using signature help, I want correct parameter tracking for chained calls and function-type parameters.

**Acceptance Criteria:**
- [ ] `findEnclosingCall` verifies cursor is inside the argument list (between `(` and matching `)`)
- [ ] For chained calls `a.b().c()`, correctly identifies `c` as the callee
- [ ] `splitParams` handles nested function type signatures `function(int, string: void)` as a single parameter
- [ ] Add tests for chained calls and function-type parameters
- [ ] Typecheck passes

---

### US-011: Fix accessResolver chained access resolution
**Description:** As a developer, I want chained access `a.b.c` to resolve correctly, so that go-to-definition and hover work on multi-level chains.

**Acceptance Criteria:**
- [ ] `resolveAccessCore` accepts optional pre-parsed tree parameter to avoid re-parsing
- [ ] Chained access correctly unwraps nested postfix_expr nodes
- [ ] Add tests for `a.b.c`, `a->b->c`, and mixed `a.b->c` patterns
- [ ] Typecheck passes

---

### US-012: Fix workspaceIndex hash and cross-file false positives
**Description:** As a developer, I want content hashes to always be positive and cross-file references to not produce false positives.

**Acceptance Criteria:**
- [ ] `hashContent` uses `>>> 0` (unsigned right shift) to ensure unsigned 32-bit result
- [ ] `getCrossFileReferences` adds file-path scoping to prevent same-name symbol false positives
- [ ] Existing workspace index tests pass
- [ ] Typecheck passes

---

### US-013: Fix PikeWorker restart health check
**Description:** As a developer, I want worker restart to be reliable, so that the server recovers cleanly from worker crashes.

**Acceptance Criteria:**
- [ ] `restart()` replaces fixed 100ms sleep with a health-check loop (ping with exponential backoff, max 3 attempts, 500ms total)
- [ ] If health check fails after max attempts, surface error to client via `window/showMessage`
- [ ] Add a test for restart health check
- [ ] Typecheck passes

---

### US-014: Fix rename regex and protected name validation
**Description:** As a developer, I want rename to correctly reject all reserved identifiers and check protected names at validation time.

**Acceptance Criteria:**
- [ ] `__foo__` regex uses `/^__[a-zA-Z].*__$/` to match uppercase patterns
- [ ] `validateRenameName` checks against `protectedNames` set, not just `PIKE_KEYWORDS`
- [ ] Add tests for `__FOO__` rejection and protected name rejection at validation
- [ ] Typecheck passes

---

### Phase 3: Medium-Priority Fixes

---

### US-015: Fix parser cache LRU recency update
**Description:** As a developer, I want cached parse trees to have their recency updated on access, so that frequently-used trees aren't prematurely evicted.

**Acceptance Criteria:**
- [ ] `getCachedTree` calls the LRU `get` method instead of raw map access
- [ ] Add a test: fill cache to capacity, access oldest entry, add new entry, verify oldest entry is NOT evicted
- [ ] Typecheck passes

---

### US-016: Add WASM load error reporting
**Description:** As a developer debugging a broken installation, I want to see which WASM candidate paths were tried and why each failed.

**Acceptance Criteria:**
- [ ] `initParser` logs each candidate path and the error before trying the next
- [ ] If all candidates fail, throws an error listing all attempted paths
- [ ] Typecheck passes

---

### US-017: Clarify getReferencesTo includes declaration
**Description:** As a developer consuming the symbol table API, I want `getReferencesTo` to return references only, with the declaration available separately.

**Acceptance Criteria:**
- [ ] `getReferencesTo` returns only actual references, not the declaration itself
- [ ] Or: rename to `getReferencesIncludingDecl` and add a separate `getReferencesOnly` if callers need the old behavior
- [ ] Audit all callers — none should break from the change
- [ ] Update existing reference tests if behavior changes
- [ ] Typecheck passes

---

### US-018: Remove unreachable duplicate case in autodocRenderer
**Description:** As a developer, I want no unreachable code in the renderer.

**Acceptance Criteria:**
- [ ] Remove duplicate `case 'group'` in `renderBlocks`
- [ ] Typecheck passes

---

### US-019: Fix diagnosticManager SHA-256 overkill and line guard
**Description:** As a developer, I want content hashing to be fast and Pike-to-LSP line conversion to be safe.

**Acceptance Criteria:**
- [ ] Replace SHA-256 with a fast non-crypto hash (e.g., DJB2 or FNV-1a)
- [ ] Guard `pd.line - 1` conversion against `pd.line <= 0`
- [ ] Existing diagnostic tests pass
- [ ] Typecheck passes

---

### US-020: Fix persistentCache ESM/CJS mismatch
**Description:** As a developer, I want cache code to work in both Bun and strict ESM environments.

**Acceptance Criteria:**
- [ ] Replace `require('node:fs')` with `import { readFileSync } from 'node:fs'`
- [ ] Or convert to async `readFile` to avoid blocking the event loop
- [ ] Existing cache tests pass
- [ ] Typecheck passes

---

### Phase 4: Documentation Corrections

---

### US-021: Fix all documentation inaccuracies
**Description:** As a developer reading the docs, I want every document to accurately reflect the current state of the codebase.

**Acceptance Criteria:**
- [ ] D-001: `AGENTS.md` — change `extension/` to `client/` in project structure
- [ ] D-002: `AGENTS.md` — remove `bun run lint` from build instructions, or add a lint script
- [ ] D-003: `docs/architecture.md` — change `extension/` to `client/`
- [ ] D-004: `docs/ci.md` — replace `npm ci` and `setup-node` with Bun equivalents
- [ ] D-005: `docs/existing-tooling.md` — add note that tree-sitter-pike now exists, mark "no grammar" claim as historical
- [ ] D-006: `docs/state-of-project.md` — update test count to 1,588, corpus count to 66
- [ ] D-007: `decisions/0002-tier-3-scope.md` — update "out of scope" to note rename and code actions were implemented
- [ ] D-008: `decisions/0010-cross-file-resolution.md` — remove "NOT IMPLEMENTED" note for resolve.pike
- [ ] D-009: `decisions/0003-pike-ai-kb-integration.md` — add note that PikeOracle MCP was replaced by PikeWorker subprocess per decision 0011
- [ ] Typecheck passes

---

### Phase 5: Test Integrity

---

### US-022: Remove mock from hover tests
**Description:** As a developer, I want hover tests to use real Pike responses, not monkey-patched worker methods.

**Acceptance Criteria:**
- [ ] Replace `worker.typeof_ = async (...) => ...` with real Pike subprocess invocation (gated on `pikeAvailable`)
- [ ] Add `describe.skipIf(!pikeAvailable)` for typeof tests
- [ ] Or: use pre-recorded Pike responses from harness snapshots as fixtures
- [ ] No monkey-patching of server internals
- [ ] Typecheck passes

---

### US-023: Harden vacuous conditional assertions
**Description:** As a developer, I want tests that fail when the tested behavior is wrong, not tests that pass silently.

**Acceptance Criteria:**
- [ ] Audit all tests in `references.test.ts`, `edge-cases.test.ts`, `definition.test.ts` for `if (result) { expect... }` patterns
- [ ] Replace with `expect(result).toBeDefined()` followed by unconditional `expect(result!.xxx)` — or use `assert(result)` before expectations
- [ ] Verify no test count change (same tests, stronger assertions)
- [ ] Typecheck passes

---

### US-024: Remove or implement integration test stubs
**Description:** As a developer, I want no empty test files inflating the test count.

**Acceptance Criteria:**
- [ ] Delete `tests/integration/activation.test.ts`, `tests/integration/documentSymbol.test.ts`, `tests/integration/error-recovery.test.ts`
- [ ] For `tests/integration/crossFilePropagation.test.ts`: either implement or delete. If keeping, implement real cross-file propagation tests using the existing corpus files and PikeWorker
- [ ] Run full test suite — verify 0 fail
- [ ] Typecheck passes

---

### US-025: Implement lifecycle todo test
**Description:** As a developer, I want the exit-after-shutdown test to exist and pass.

**Acceptance Criteria:**
- [ ] Convert `test.todo('exit after shutdown does not throw')` to a real test
- [ ] Test sends `shutdown` request, then `exit` notification, verifies no thrown error
- [ ] Typecheck passes

---

### US-026: Add correctness assertions to real-codebase-verification tests
**Description:** As a developer, I want the corpus-wide smoke tests to verify semantic correctness, not just "didn't crash."

**Acceptance Criteria:**
- [ ] For each corpus file, verify at least one semantic property: symbol count matches expected range, or specific symbol names are present
- [ ] Verify hover returns non-empty markdown for at least one symbol per file
- [ ] Verify definition returns a valid location for at least one identifier per file
- [ ] Typecheck passes

---

### Phase 6: TigerStyle Compliance (File Splits)

These are deferred to a follow-up phase per user preference. Listed here for completeness.

---

### US-027: Split symbolTable.ts (1,892 → ≤500 lines per file)
**Description:** As a developer, I want the symbol table module to be within TigerStyle limits, so that each file has a single responsibility.

**Acceptance Criteria:**
- [ ] Extract scope construction into `scopeBuilder.ts`
- [ ] Extract declaration collection into `declarationCollector.ts`
- [ ] Extract reference collection into `referenceCollector.ts`
- [ ] Extract cross-file wiring into `crossFileResolver.ts`
- [ ] Keep core types and `buildSymbolTable` orchestrator in `symbolTable.ts`
- [ ] All files ≤ 500 lines
- [ ] All existing tests pass with only import path changes
- [ ] Typecheck passes

---

### US-028: Split server.ts (1,087 → ≤500 lines)
**Description:** As a developer, I want the server entry point to be within TigerStyle limits.

**Acceptance Criteria:**
- [ ] Extract hover handler logic into `hoverHandler.ts`
- [ ] Extract completion handler into `completionHandler.ts` (wire only, logic stays in completion.ts)
- [ ] Extract definition/references handlers into `navigationHandler.ts`
- [ ] Keep `createPikeServer` wiring and lifecycle in `server.ts`
- [ ] All files ≤ 500 lines
- [ ] All existing tests pass
- [ ] Typecheck passes

---

### US-029: Split completion.ts (927 → ≤500 lines)
**Description:** As a developer, I want completion to be within TigerStyle limits.

**Acceptance Criteria:**
- [ ] Extract `detectTriggerContext` (~200 lines) into `completionTrigger.ts`
- [ ] Extract member/stdlib completion into `completionProviders.ts`
- [ ] Keep core `getCompletions` orchestrator in `completion.ts`
- [ ] All files ≤ 500 lines
- [ ] All existing tests pass
- [ ] Typecheck passes

---

### US-030: Split autodocRenderer.ts (918 → ≤500 lines)
**Description:** As a developer, I want the autodoc renderer to be within TigerStyle limits.

**Acceptance Criteria:**
- [ ] Extract XML parser into `xmlParser.ts`
- [ ] Extract block/inline rendering into `autodocBlocks.ts`
- [ ] Keep main render entry point in `autodocRenderer.ts`
- [ ] All files ≤ 500 lines
- [ ] All existing tests pass
- [ ] Typecheck passes

---

### Phase 7: Architectural Improvements (Inspired by rust-analyzer / gopls)

These are long-term improvements. Listed for roadmap visibility.

---

### US-031: Add immutable workspace snapshot pattern
**Description:** As a developer, I want each LSP request to operate on a consistent snapshot of workspace state, so that concurrent edits don't produce inconsistent results.

**Acceptance Criteria:**
- [ ] Design a `WorkspaceSnapshot` type that holds immutable references to: parse trees, symbol tables, workspace index, PikeWorker cache
- [ ] Each didChange/create a new snapshot; in-flight requests reference the old one
- [ ] Handlers receive snapshot as parameter instead of accessing mutable globals
- [ ] Reference: gopls `internal/cache/snapshot.go`
- [ ] Typecheck passes

---

### US-032: Add CancellationToken propagation to PikeWorker
**Description:** As a developer, I want cancellation requests to abort Pike subprocess work, so that stale diagnostics don't consume resources.

**Acceptance Criteria:**
- [ ] PikeWorker accepts `CancellationToken` on `diagnose` and `typeof_` calls
- [ ] Check token before writing to stdin; if cancelled, resolve immediately
- [ ] Reference: gopls context-based cancellation
- [ ] Typecheck passes

---

### US-033: Add inlay hints support
**Description:** As a Pike developer, I want to see inferred types displayed inline, so that I can understand code without hovering.

**Acceptance Criteria:**
- [ ] Implement `textDocument/inlayHint` handler
- [ ] Show inferred types for `mixed` declarations where `assignedType` is resolved
- [ ] Show parameter names at call sites
- [ ] Reference: rust-analyzer inlay hints
- [ ] Typecheck passes

---

### US-034: Add go-to-implementation support
**Description:** As a Pike developer, I want to find all implementations of a class method or interface, so that I can navigate inheritance hierarchies.

**Acceptance Criteria:**
- [ ] Implement `textDocument/implementation` handler
- [ ] For a class, find all classes that inherit from it
- [ ] For a method, find all overrides in subclasses
- [ ] Uses existing WorkspaceIndex dependency graph
- [ ] Typecheck passes

---

## Functional Requirements

- FR-1: Type inference from call expressions must not assign the callee function name as the type (A-001)
- FR-2: PikeWorker must reset its request counter after a forced restart (A-002)
- FR-3: PikeWorker must use O(1) dequeue for its request queue (A-003)
- FR-4: File URIs in background indexing must be properly encoded (A-004)
- FR-5: Module resolution must not block the event loop (A-005)
- FR-6: Hover signatures must be extracted from AST ranges, not source line splitting (A-006)
- FR-7: Scope-stripping must handle nested scope() calls and must not be duplicated (A-007)
- FR-8: Completion must distinguish dot (public) vs arrow (all) member access (A-008)
- FR-9: Synthetic declarations must have unique IDs that don't collide (A-010)
- FR-10: Signature help must verify cursor is inside argument list and handle chained calls (A-011)
- FR-11: All documentation must reference correct directory names, test counts, and implementation status
- FR-12: No test may use mocks of Pike worker — use real subprocess or pre-recorded fixtures
- FR-13: No test may pass vacuously via conditional assertions — all assertions must be unconditional
- FR-14: No empty test stubs — implement or delete
- FR-15: All files must be ≤500 lines (deferred to Phase 6)
- FR-16: All functions must be ≤50 lines

## Non-Goals

- No rewrite of the tree-sitter grammar (tree-sitter-pike issues are tracked separately)
- No support for editors other than VSCode at this time (other editor support is documented but not a priority)
- No build system integration (Pike has no build system equivalent to Cargo/Go modules)
- No telemetry, profiling endpoints, or web UI
- No code generation or refactoring beyond basic rename and code actions
- No Pike preprocessor (#if/#ifdef) handling beyond what tree-sitter-pike already provides
- Phase 6 (file splits) and Phase 7 (architectural improvements) are deferred — not in scope for the immediate PR

## Design Considerations

### Scope-stripping utility
Pike's `scope()` wrapper appears in predef signatures like `scope(0, function(string, int: void))`. Nested scopes like `scope(0, scope(1, function(...)))` exist. A recursive descent parser is needed — regex is insufficient.

### Member access control
Pike distinguishes:
- `obj.member` — public members only
- `obj->member` — all members (including private/protected)

The LSP must propagate this distinction to completion and go-to-definition.

### Async module resolution
`moduleResolver.ts` is called during `onInitialize` and during completion/definition. Converting to async requires:
1. Making `detectPikePaths` async (called once at init)
2. Making `resolve*` methods async (called per request)
3. Updating all callers to await

### Workspace snapshot
The gopls Snapshot pattern is the long-term target but requires significant refactoring. Current mutable state lives in:
- `documents` map (server.ts)
- `autodocCache` (LRU)
- `workspaceIndex` (WorkspaceIndex)
- `pikeWorker` (PikeWorker)

Phase 7 should wrap these in an immutable container.

## Technical Considerations

### Oracle-derived test expectations
Currently ~60% of test expectations are hand-written. Converting to oracle-derived requires:
1. Running `pike` on each test fixture to extract ground truth (symbols, types, locations)
2. Storing results as JSON snapshots (like `harness/resolve-snapshots/`)
3. Comparing LSP output against snapshots in tests

This is the biggest test integrity gap. `crossFileOracle.test.ts` and `documentSymbol.test.ts` already demonstrate the pattern.

### LRU cache performance
The O(n) eviction in `lruCache.ts` is acceptable for current cache sizes (50 entries). If the cache grows (e.g., for workspace-wide symbol tables), a doubly-linked-list approach would be needed.

### Event loop blocking
`moduleResolver.ts` is the worst offender for event loop blocking. `pikeWorker.ts` uses async I/O correctly. `persistentCache.ts` has one sync call (`computeWasmHash`).

## Success Metrics

- 0 confirmed bugs that produce incorrect LSP behavior
- 0 mocks in test suite
- 0 vacuous conditional assertions
- 0 empty test stubs
- 0 documentation inaccuracies
- All files ≤ 500 lines (Phase 6)
- Test suite: 1588+ tests, all passing
- Hover signatures are clean (no trailing semicolons/comments)
- Completion distinguishes dot vs arrow access
- PikeWorker recovers reliably from crashes

## Open Questions

- Should we add a `lint` script to package.json, or remove it from AGENTS.md? (Currently referenced in docs but doesn't exist.)
- Should `getReferencesTo` continue including the declaration, or return references only? Callers need auditing.
- Should integration test stubs be deleted or implemented? Cross-file propagation has a 45-line comment describing what to test — worth implementing or removing?
- What is the target timeline for Phase 6 (file splits) and Phase 7 (architectural improvements)?
- Should the oracle conversion of hand-written test expectations happen per-phase or as a dedicated phase?
