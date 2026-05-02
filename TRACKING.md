# Pike Language Server — Project Tracking

## Current Phase

**Phase 15: Correctness Foundations** — All workstreams complete. 1,612 tests passing, 0 failures, 13,072 assertions.

Completion refinements (P1) ✓. Rename bug fix (P2) ✓. Diagnostics fix (P3) ✓. CI canary fix (P4) ✓. Decision docs 0017-0018 (P5) ✓.

| Phase | Status | Entry Checkpoint | Exit Checkpoint |
|-------|--------|-----------------|-----------------|
| Phase 0: Investigation | Complete (verified) | Repo created, template read, pike-ai-kb reachable | docs, corpus, 4 decision documents |
| Phase 1: Test Harness | **Complete (verified)** | Phase 0 complete | Harness code, ground-truth snapshots, canary tests |
| Phase 2: VSCode Extension + Tree-sitter | **Complete** | Phase 1 complete | Extension installs, documentSymbol works |
| Phase 3: Per-file Symbol Table | **Complete (verified)** | Phase 2 complete | Same-file go-to-definition and find-references |
| Phase 4: Cross-file Resolution | **Complete** | Phase 3 complete | Cross-file navigation, workspace index |
| Phase 5: Types and Diagnostics | **Exit verified** | Phase 4 complete + resolve.pike + integration tests | Diagnostics from Pike, three-tier hover, shared-server hardened |
| Phase 6: Refinement | **Complete (verified)** | Phase 5 complete | P1: Completion. P2: Real-time diagnostics. P3 rename deferred (type inference prerequisite). |
| Phase 7: Type Resolution + Import Tracking | **Complete** | Phase 6 complete | P1: Type resolver. P2: Import tracking. 37 new tests. |
| Phase 8: Rename | **Complete + post-audit fixes** | Phase 7 complete | textDocument/rename, textDocument/prepareRename, 30 rename tests, 3 audit bugs fixed |
| Phase 9: Stabilize and Multi-editor | **Complete** | Phase 8 complete | Standalone build, Neovim verified, real-codebase tested, performance measured |
| Phase 10: Type Inference | **Complete** | Phase 9 complete | assignedType, extractInitializerType, PRIMITIVE_TYPES, typeof integration |
bp|| Phase 11: Inference Docs | **Complete** | Phase 10 complete | Decision 0019, corpus files, harness snapshots, known-limitations |
jf|| Phase 12: Semantic Tokens | **Complete** | Phase 11 complete | Token type/modifier mapping, production, delta encoding. Decision 0020. |
vk|| Phase 13: LSP Features | **Complete** | Phase 12 complete | documentHighlight, foldingRange, signatureHelp, semanticTokens handler. Decisions 0020, 0021. |
kc|| Phase 14: Workspace Features | **Complete** | Phase 13 complete | Code actions, workspace symbol, background indexing, persistent cache, configuration, cancellation. |
ya|| Phase 15: Correctness Foundations | **Complete** | Phase 14 complete | Completion refinements, rename bug fix, diagnostics fix, CI canary fix. Decisions 0017, 0018. |

## Phase 1 Exit Checkpoint — Verified

### Exit Criteria

- [x] **harness/ directory with harness code** — introspect.pike + TypeScript runner + snapshot manager
- [x] **harness/snapshots/ with ground-truth for every corpus file** — 37/37 snapshots
- [x] **harness verify produces zero diffs** — `bun run harness:verify` → "All 37 snapshots verified"
- [x] **5-10 canary tests, hand-verified, running in CI** — 11 canary tests across 4 categories
- [x] **Decision 0004 expanded with CompilationHandler finding** — includes cross-version caveat
- [x] **All five phase 1 tests pass:**
  - [x] Every corpus file has a snapshot (37/37)
  - [x] All canaries pass (11/11)
  - [x] Two consecutive runs produce identical output (3/3 deterministic files)
  - [x] Modifying a corpus file produces a diff (mutation detection works)
  - [x] Deliberately breaking harness makes canaries fail

### Test Suite Summary

```
70 tests, 0 failures, 514 assertions, ~11 seconds
- harness.test.ts: 41 tests (coverage, ground truth, determinism, mutation, schema)
- canary.test.ts: 11 tests (valid files, error files, deliberately broken, structure)
- snapshot-canonicalizer.test.ts: 16 tests (extensibility, deep nesting, generic diff)
- 2 additional corpus files (autodoc-documented, basic-nonstrict)
```

### Deliverables

| Component | Path | Lines | Purpose |
|-----------|------|-------|---------|
| Pike introspection script | `harness/introspect.pike` | ~130 | CompilationHandler + AutoDoc → JSON |
| TypeScript types | `harness/src/types.ts` | ~35 | IntrospectionResult, Diagnostic interfaces |
| TypeScript runner | `harness/src/runner.ts` | ~170 | Subprocess invocation, CLI modes |
| Snapshot manager | `harness/src/snapshot.ts` | ~115 | Generic canonical read/write/diff |
| Harness tests | `harness/__tests__/harness.test.ts` | ~155 | 41 tests |
| Canary tests | `harness/__tests__/canary.test.ts` | ~170 | 11 hand-verified tests |
| Canonicalizer tests | `harness/__tests__/snapshot-canonicalizer.test.ts` | ~270 | 16 extensibility and nesting tests |
| Ground-truth snapshots | `harness/snapshots/` | 37 files | JSON from Pike 8.0.1116 |
| Harness architecture | `decisions/0005-harness-architecture.md` | ~170 | Design decision |

### Key Decisions

- **Decision 0005**: Harness architecture — two-layer system (Pike script + TypeScript runner), generic canonical JSON for stable comparison, strict/non-strict handling.

## Phase 1 Verification Results

Five self-flagged assumptions were checked. Each item: confirmed / corrected / new finding.

### Item 1: Snapshot format extensibility — **Corrected**

The original canonicalizer (`canonicalizeResult`) hardcoded every field of `IntrospectionResult`. When Phase 3 adds a `symbols` field, it would silently drop it.

**Fix:** Rewrote `snapshot.ts` with generic `deepSortKeys` that recursively sorts keys at every nesting level, and `diffSnapshot` that iterates over the union of all top-level keys (excluding `pike_version`). Added 16 unit tests confirming arbitrary nesting, arrays of objects, and future schema shapes are handled without code changes.

### Item 2: AutoDoc XML comparison — **Corrected (bug found)**

No corpus file had `//!` doc comments. The AutoDoc code path was completely untested. Additionally, a bug was found: `extract_autodoc` prepends `./` to the output path, which breaks when given an absolute path. With the runner passing absolute paths, AutoDoc extraction silently failed (returned null) for all files.

**Fix:** 
1. Fixed `introspect.pike` to pass relative paths to `extract_autodoc` and construct XML path with `./` prefix.
2. Added `autodoc-documented.pike` corpus file with `//!` comments on class, methods, and standalone function.
3. Verified: AutoDoc XML captured (1939 bytes), two consecutive verifies produce zero diff, modifying `//!` content produces autodoc field diff.

### Item 3: Cross-file invocation phase 4 commitment — **Confirmed (deferred)**

Documented in `decisions/0005-harness-architecture.md` §Deferred Items. Phase 4 entry checkpoint requires replacing `CROSS_FILE_FLAGS` with manifest-driven per-file metadata. Added to TRACKING.md deferred items.

### Item 4: Canonicalizer handles arbitrary nesting — **Confirmed**

16 unit tests exercise: top-level key sorting, recursive nested sorting, arrays of mixed objects/primitives, 6+ levels of nesting, null/empty/zero values. All pass. The generic `deepSortKeys` implementation handles any JSON shape without hardcoding.

### Item 5: Non-strict-mode diagnostics — **New finding**

All 36 corpus files had `#pragma strict_types`. The harness had never exercised non-strict compilation. The runner defaulted to `strict: true`, which is a substantive bias — the LSP will encounter real-world Pike files without strict mode.

**Fix:**
1. Changed runner default from `strict: true` to `strict: false`. Files that need strict mode already declare `#pragma strict_types` in source — the `--strict` flag is redundant for them.
2. Added `basic-nonstrict.pike` corpus file (no `#pragma strict_types`).
3. Verified behavioral difference: non-strict produces 5 diagnostics, strict produces 9 (adds 4 "Unused local variable" warnings).
4. Documented strict/non-strict handling in decision 0005.

## Completed Phase History

## Phase 7 — Complete

### P1: Type Resolution
Decision 0014. Pure-function type resolver with `resolveType()` and `resolveMemberAccess()`. Resolution chain: same-file class → qualified type → cross-file via inherit/import → stdlib. Integrated into completion (replaces inline `resolveTypeMembers()`), definition (arrow/dot access), and hover providers. 20 type resolution tests.

### P2: Import Dependency Tracking
Decision 0015. `DeclKind 'import'` added to distinguish `import` from `inherit` declarations. `extractDependencies()` now includes import edges in the dependency graph. `propagateToDependents()` covers import dependents. 8 import dependency tests.

### Changes
- `server/src/features/typeResolver.ts` — New: `resolveType()`, `resolveMemberAccess()`, supporting helpers (~260 LOC)
- `server/src/features/symbolTable.ts` — `DeclKind 'import'` added, `collectInheritDecl()` derives kind from node type
- `server/src/features/completion.ts` — Inline `resolveTypeMembers()` replaced with `resolveMemberAccess()` calls; cross-file + inherited member completion
- `server/src/features/workspaceIndex.ts` — `extractDependencies()` handles both `kind === 'inherit'` and `kind === 'import'`
- `server/src/server.ts` — Arrow/dot access definition and hover resolution via `resolveAccessCore()`
- `decisions/0014-type-resolution.md` — Type resolution architecture
- `decisions/0015-import-tracking.md` — Import dependency tracking semantics
- `tests/lsp/typeResolution.test.ts` — 29 tests
- `tests/lsp/importDependencies.test.ts` — 8 tests

### Bugs found and fixed
- `findMemberInClass` used `containsDecl()` to find class scope — class declaration is in file scope, not class body scope. Fixed to use `parentId` + `posInRange`.
- Same fix applied to `findMemberInInheritedScopes`.
- `resolveMemberAccess` "class as LHS" path didn't check inherited scopes — added `findMemberInInheritedScopes` call.
- `collectInheritDecl` hardcoded `kind: 'inherit'` — now derives from `node.type`.
- Cross-file oracle test only matched `kind === 'inherit'` — updated to match both kinds.
- Tree-sitter Node identity comparison (`===`) unreliable across `descendantForPosition` vs `children[i]` — changed to position comparison.

### Test suite at exit: 1,016 tests, 0 failures, 8,785 assertions, 27 files.

## Phase 8 — Complete + Post-Audit Fixes

### Rename
Decision 0016. `textDocument/rename` + `textDocument/prepareRename`. Reuses existing `getDefinitionAt()`, `getReferencesTo()`, and `getCrossFileReferences()` infrastructure. Scope-aware renaming across files. Pike keyword validation prevents invalid renames.

### Changes
- `server/src/features/rename.ts` — New: `prepareRename()`, `getRenameLocations()`, `buildWorkspaceEdit()`, `validateRenameName()` (~190 LOC)
- `server/src/server.ts` — Wired rename + prepareRename handlers, registered `renameProvider` capability
- `decisions/0016-rename.md` — Rename architecture
- `tests/lsp/rename.test.ts` — 30 tests (validation, prepare, same-file rename, scope isolation, cross-file, arrow-access, LSP protocol)

### Audit Fixes (7 items)

Three bugs found and fixed:

1. **`containsDecl` bug in completion.ts** — `resolveTypeMembers()` used `containsDecl()` to find class body scope, which always failed because class declarations live in file scope. Applied the same `parentId + rangeContains` fix already present in `typeResolver.ts`. Removed unused `containsDecl` function. Test: `"dot completion on same-file class name returns its members"`.

2. **Cross-file rename filter too strict** — `getCrossFileReferences()` filtered by `resolvesTo !== null`, excluding all inherited symbol references which have `resolvesTo=null`. Changed to `resolvesTo === null` to correctly match unresolved inherited references in dependent files. Test: `"cross-file rename updates all files containing references"`.

3. **Arrow-access call sites excluded from rename** — `getReferencesTo()` only returned references where `resolvesTo === targetDeclId`, excluding arrow/dot access references (which have `resolvesTo=null`). Added fallback to include arrow/dot access name-matching references. Test: `"rename includes arrow-access call sites"`.

Four test gaps closed:

4. Rename location count assertions changed from `>=N` to `toHaveLength(N)` across 6 assertions.
5. `resolveType` depth limit tested via 3 new tests (depth guard, member access termination, within-limit success).
6. Cross-file arrow completion tested via `"cross-file arrow completion returns members from imported class"` using real corpus files.
7. Scope-isolation rename tested via `"rename does not affect same-name identifier in different scope"` (confirmed code was already correct).

### Known Limitations Discovered

- Cross-file inherited member completion (e.g., `Dog d; d->` where `Dog` inherits from a cross-file class) returns only same-file members. `wireInheritance()` does not resolve cross-file inheritance — inherited scopes remain empty.
- Arrow/dot access rename uses name-based matching for unresolved references, which may include call sites on different classes that share the same method name.

### Test suite at current state: 1,051 tests, 0 failures, 8,896 assertions, 28 files.

## Phase 9 — In Progress

### Decision: 0017 (Beta Readiness)

Three workstreams: User-facing roughness, Production quality, Performance at scale.

### Workstream 1: User-facing Roughness — Complete

**Problem:** A Helix user on the Pike mailing list reported install difficulties. The server had no standalone build, no bin entry, no non-VSCode docs.

**Findings:**
1. No `bin` field in package.json — users didn't know what command to run
2. The `tsc` build output couldn't run with Node.js due to `moduleResolution: "bundler"` in tsconfig
3. `bun dist/server/src/server.js --stdio` worked but the WASM wasn't in the build output
4. `web-tree-sitter.wasm` (the runtime WASM) also wasn't copied
5. No instructions for non-VSCode editors

**Changes:**
- `scripts/build-standalone.sh` — new: esbuild bundle + WASM + data files to `standalone/`
- `bin/pike-language-server` — new: wrapper script that runs `standalone/server.js` via bun
- `package.json` — added `bin` field and `build:standalone` script
- `server/src/parser.ts` — WASM path resolution now searches multiple locations (standalone bundle, tsc output, extension bundle)
- `README.md` — rewritten: clear install for VSCode and non-VSCode, lists features, removes confusing Node.js requirement
- `docs/other-editors.md` — new: verified Neovim setup with nvim-lspconfig, generic LSP client config, troubleshooting
- `.gitignore` — added `standalone/` (build artifact)
- `docs/state-of-project.md` — updated for Phase 8 completion
- `PLAN.md` — deleted (stale Phase 7-8 handoff)
- 6 GitHub issues (#2210, #2217-2221) and 2 PRs (#2222-2223) closed — filed against non-existent `packages/` paths
- `decisions/0017-beta-readiness.md` — Phase 9 scope and exit criteria

**Verification:**
- Standalone server tested with Node.js child process: initialize, documentSymbols, hover, completion all work
- Neovim 0.10.4 + nvim-lspconfig: LSP client attaches, all capabilities advertised (documentSymbol, definition, references, hover, completion, rename)
- Document symbols on `class Animal/Dog` test file: correct symbol hierarchy
- Hover on `name` field: returns `string name` with range
- Completion after `d->`: returns breed, fetch, name, age (class + inherited members)
- All 1,311 tests pass (0 failures) after parser.ts changes

### Workstream 2: Production Quality — Complete

**Test target:** 555 Pike stdlib files (640 .pike/.pmod files, 5-2528 lines each)

**P1 findings: 0 crashes, 0 wrong answers.**

Tested 14 representative files spanning 10-2528 lines with all LSP features:
- `documentSymbol`: 14/14 files returned correct symbols (6-53 per file, class + function counts match)
- `hover`: 10/14 files returned type info on first typed identifier
- `completion`: 5/7 files with `->` returned results (401-403 items from stdlib + workspace)
- `references`: 4/4 files with class/inherit returned references
- `definition`: 2/2 files with inherit resolved the inherited symbol

**P2 findings (7 items):**

| File | Feature | Issue |
|------|---------|-------|
| `Crypto.pmod/HMAC.pike` | completion | Empty after `->` on `B` variable (type unresolved) |
| `Geography.pmod/GeoIP.pmod` | completion | Empty after `->` on `data` variable (type unresolved) |
| `SSL.pmod/Packet.pike` | completion | Empty after `->` on `content_type` (type unresolved) |
| `Protocols.pmod/HTTP.pmod/Query.pike` | hover | No hover on `ok` field at line 7 (local scope hover gap) |
| `Protocols.pmod/IMAP.pmod/parser.pike` | completion | Empty after `->` on `b` variable (type unresolved) |
| `Protocols.pmod/LysKOM.pmod/Raw.pike` | hover | No hover on `g` at line 20 (local variable hover gap) |
| `Protocols.pmod/SMTP.pmod/module.pmod` | completion | Empty after `->` on `data` variable (type unresolved) |

**Analysis:**
- 5 of 7 P2s are completion after `->` where the variable's type cannot be resolved by tree-sitter alone (would need Pike runtime type inference). This is a known limitation documented in `docs/known-limitations.md`.
- 2 of 7 P2s are hover on local variables in complex functions where the scope chain doesn't reach the declaration. This is a scope resolution gap, not a crash.
- No crashes, no wrong answers, no missing core features.

**Test infrastructure finding:**
- The vscode-languageserver `createConnection(ProposedFeatures.all)` watchdog monitors `processId` from `initialize` params. If `process.kill(processId, 0)` throws (e.g., PID 1 = EPERM), the server exits with code 1. This caused false-positive crash reports in test harnesses. Fix: pass `processId: null` in test clients, or use a real process PID.

**parser.ts ESM compatibility fix:**
- Original `__dirname` usage broke in esbuild ESM bundles (`__dirname` is undefined in ESM). Fixed with `typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url))` fallback.

**Test suite: 1,311 tests, 0 failures, 10,720 assertions.**

### Workstream 3: Performance at Scale — Complete

**#2210 verification:** No linear scan exists in completion. All paths use O(1) hash lookups (`WorkspaceIndex.files.get()`) or single-file `declarations.find()`. The `findClassInWorkspace` and `collectClassMembersFromWorkspace` functions mentioned in #2210 do not exist in the codebase.

**Member-access completion benchmark (`obj->`):**

| Case | Lines | Members | Cold | Warm p50 | Warm p99 | Max | Items |
|------|-------|---------|------|----------|----------|-----|-------|
| Small (10 members, no inherit) | 17 | 10 | 9.7ms | 0.7ms | 1.9ms | 1.9ms | 4 |
| Medium (65 members, 3-level chain) | 79 | 65 | 11.1ms | 0.8ms | 2.3ms | 2.3ms | 20 |
| Large (200 members, 4-level chain) | 217 | 200 | 9.8ms | 1.4ms | 2.4ms | 2.4ms | 0* |

*Large class returns 0 items because multi-level inheritance resolution does not yet
traverse the full chain for completion — known P2 correctness issue, not performance.

**Code path analysis:** All WorkspaceIndex lookups (`resolveModule`, `resolveImport`, `resolveInherit`,
`getSymbolTable`) are O(1) hash map access. Linear scans (`declarations.find()`) are bounded by
single-file symbol count, not workspace size. Warm p99 <2.5ms across all inputs.

**Cold-workspace indexing (561 Pike stdlib files, estimated from measured per-file times):**

| Size bucket | Count | Avg per file | Estimated total |
|-------------|-------|-------------|-----------------|
| Small (<50L) | 162 | 2ms | 324ms |
| Medium (50-200L) | 158 | 5ms | 790ms |
| Large (200-500L) | 114 | 15ms | 1,710ms |
| XL (500-1500L) | 91 | 50ms | 4,550ms |
| XXL (1500+L) | 36 | 120ms | 4,320ms |
| **Total** | **561** | | **~12s** |

**Resource policies verified (all 8 holding after Phase 8):**

| Policy | Status | Details |
|--------|--------|---------|
| Nice +5 on Pike subprocess | Verified | `niceValue: 5` in PikeWorkerConfig |
| Idle eviction (5 min) | Verified | `idleTimeoutMs: 300000` |
| No file watchers | Verified | Server uses editor-pushed notifications only |
| Memory ceiling | Verified | `maxRequestsBeforeRestart: 100`, `maxActiveMinutes: 30` |
| Per-request timeout (5s) | Verified | `requestTimeoutMs: 5000` |
| Cache caps | Verified | `CACHE_MAX_ENTRIES: 50`, `CACHE_MAX_BYTES: 25MB` |
| Timeout as diagnostic | Verified | `timedOut: true` returned, surfaced to user |
| FIFO queueing | Verified | High/low priority queues in DiagnosticManager |

**Phase 8 rename impact:** `PIKE_KEYWORDS` set is static (allocated once). `locations` arrays are request-scoped. No resource leaks or new resource concerns.
## Phase 6 — Complete (Verified)

### P1: Completion
Decision 0012. Tree-sitter-first completion provider. Three resolution paths (unqualified, dot/arrow, scope). 19 tests.

### P2: Real-time Diagnostics
Decision 0013. DiagnosticManager with debouncing, supersession, priority, cross-file propagation. 15 tests.

### P3: Rename — Shipped in Phase 8
Originally deferred from Phase 6 due to type inference prerequisites. Prerequisites resolved in Phase 7 (type resolution + import tracking). Delivered in Phase 8 (Decision 0016). Stdlib/predef rejection added post-Phase 9.

### P4: Code Actions — Deferred (Decision 0002 §13)

### Phase 6 Verification (2026-04-28)

**Bugs found and fixed:**
- `connection.onDidSave` was never registered (dead code). Switched to `documents.onDidSave`.
- Post-teardown `sendDiagnostics` calls logged errors. Added `disposed` guards.

**Measurements:**
| Item | Result |
|------|--------|
| V1: 50 rapid didChange | ≤ 3 diagnose invocations (target: ≤ 3) |
| V1: 200ms-gap typing | ≤ 2 diagnose invocations |
| V2: Hover latency (idle) | < 100ms (tree-sitter only) |
| V2: Hover latency (during diagnose) | < 100ms (unaffected) |
| V5: Parse diagnostic latency | ~50ms |
| V5: Supersession (error+fix) | ≤ 1 Pike diagnose for final content |

**Findings (not bugs):**
1. Priority queue scope: DiagnosticManager's priority queue controls only its own dispatch. Hover/completion bypass it.
2. Cross-file propagation: code correct, but dependency graph empty in in-process tests (ModuleResolver needs files on disk). Layer-2 integration test needed.
3. Rename deferred: resolver-driven approach exists (~600 LOC) but needs type inference + import tracking first.

**Test suite at exit:** 979 tests, 0 failures, 8,697 assertions, 24 files.

### Phase 4: Cross-File Resolution (2026-04-27)

**Deliverables:**
- `server/src/features/moduleResolver.ts` — Pike's module resolution algorithm (~394 lines)
- `server/src/features/workspaceIndex.ts` — In-memory per-file symbol table index (~484 lines)
- `server/src/server.ts` — Updated: WorkspaceIndex integration, cross-file definition/references
- `corpus/corpus.json` — Manifest-driven per-file compilation metadata
- `harness/src/runner.ts` — Updated: manifest reader, shared snapshotNameForFile helper
- `tests/lsp/moduleResolver.test.ts` — 21 ModuleResolver tests
- `tests/lsp/workspaceIndex.test.ts` — 15 WorkspaceIndex tests
- `tests/lsp/crossFile.test.ts` — 12 cross-file definition/reference/invalidation tests
- `decisions/0010-cross-file-resolution.md` — Cross-file resolution architecture
- 14 new corpus files covering cross-file patterns

**ModuleResolver:**
- Resolves module paths: Stdio.File, cross_import_a, cross_pmod_dir.helpers
- Resolves inherit paths: string literal, identifier, dot-path, relative (.Foo)
- Resolves import paths: Stdio, cross_pmod_dir
- #pike version-aware search paths
- Priority: .pmod directory > .pmod file > .pike file
- Hyphen-to-underscore normalization
- Caching with per-query invalidation

**WorkspaceIndex:**
- Per-file symbol table storage with forward/reverse dependency graphs
- Invalidation propagation: file change → dependents invalidated
- ModificationSource tracking (didOpen, didChange, didChangeWatchedFiles, etc.)
- Cross-file definition resolution through inherit/import chains
- Cross-file references across workspace files

**Cross-file patterns tested:**
- Simple cross-file inherit (string literal)
- Inherit with rename (alias)
- Three-file inherit chain
- Module import (.pmod file)
- Directory module (.pmod/ with module.pmod)
- Stdlib module resolution
- #pike 7.8 version directive detection
- Incremental update and invalidation

**Test suite:** 830 tests, 0 failures, 7359 assertions
- Phase 1-3 tests: 782 (regression suite)
- Phase 4 ModuleResolver tests: 21
- Phase 4 WorkspaceIndex tests: 15
- Phase 4 cross-file tests: 12

### Phase 3: Per-file Symbol Table (2026-04-27) — Verified

**Deliverables:**
- `server/src/features/symbolTable.ts` — Symbol table builder, scope-aware resolver, definition/reference query API (~1151 lines)
- `server/src/server.ts` — Updated: definitionProvider + referencesProvider wired, symbol table cache (lazy rebuild)
- `harness/introspect.pike` — Extended: class body member extraction via indices(instance)
- `tests/lsp/definition.test.ts` — 110 Layer 1 definition tests
- `tests/lsp/references.test.ts` — 29 Layer 1 references tests
- `tests/lsp/edge-cases.test.ts` — 18 edge-case tests (scoping, shadowing, forward refs, lambda, inherit-rename)
- `docs/known-limitations.md` — Upstream limitation tracking (tree-sitter-pike #1 resolved, #2/#3/#4 filed)
- `decisions/0009-symbol-resolution.md` — Symbol table architecture, scope rules, cache invalidation policy, Pike-verified behaviors
- 4 new corpus files: scope-for-catch, scope-shadow-params, class-forward-refs, class-inherit-rename

**Symbol table architecture:**
- Immutable snapshot pattern: build new table per parse-tree change, never mutate
- 10-level scope hierarchy: lambda → file scope
- Inheritance wiring: post-build pass resolves inherit declarations to inherited class scopes
- Cache invalidation: lazy rebuild on next request after didChange (explicit policy in 0009)

**Resolution coverage:**
- identifier_expr: scope chain walk (innermost → outermost) — 30/33 resolved on class-single-inherit.pike
- scope_expr (::): inherit specifier → inherited scope → member (including alias via inherit-with-rename)
- this_expr: resolve to enclosing class declaration
- type references: id_type → class/enum/typedef lookup
- arrow access (obj->member): collected but not yet resolved through variable types

**Bugs found and fixed:**
- For-loop init declarations now register in for-scope (tree-sitter for_statement has no field names)
- If-block consequence/alternative push their own block scope (variables no longer leak to enclosing)
- Lambda scopes in variable initializers now discovered
- Scope tie-breaking prefers deeper scopes when ranges are equal
- Inherit-with-rename: alias stored, scope_access resolves through alias, go-to-def on both path and alias

**Test suite:** 614 tests, 0 failures, 5680 assertions
- Phase 1 + 2 tests: 405 (regression suite)
- Phase 3 definition tests: 110
- Phase 3 references tests: 29
- Edge-case tests: 18

**Upstream issues filed:**
- tree-sitter-pike#1 (Unicode identifiers) — fixed in 28a8ae8, WASM rebuilt (302KB)
- tree-sitter-pike#2 — Missing field names on for_statement children
- tree-sitter-pike#3 — catch expression lost in assignment context
- tree-sitter-pike#4 — No scope-introducing nodes for while/switch/plain blocks

### Phase 3 Exit Verification

Five verification items resolved:

**Item 1: Pike-specific scoping** — All cases verified against Pike 8.0.1116. For-init, lambda capture, this/this_program confirmed correct. Catch block variables not tracked (tree-sitter-pike#3 limitation).

**Item 2: Forward references** — Pike allows forward references within class scope. LSP 'flat class scope' policy matches Pike behavior. Mutual recursion works at file scope.

**Item 3: Cache invalidation policy** — Decision 0009 updated with explicit policy: trigger (didChange), cached data (full SymbolTable per URI), rebuild timing (lazy), in-flight behavior (JSON-RPC ordering), lifecycle table.

**Item 4: Class extraction audit** — All 8 valid corpus classes are instantiable with no-arg constructors. Phase 5 alternative documented (program introspection, compile_string stub, Tools.AutoDoc).

**Item 5: Test depth** — 18 edge-case tests covering: parameter shadowing, block shadowing, class member shadowing, inherited member resolution, inherit-with-rename (3 tests), forward references, recursion, mutual recursion, for-loop scoping (2 tests), lambda capture, this, this_program, enum members.

### Phase 2: VSCode Extension + Tree-sitter (2026-04-26)

**Deliverables:**
- `server/src/server.ts` — LSP server with stdio transport, documentSymbol handler, testable factory
- `server/src/parser.ts` — Tree-sitter WASM initialization and parse cache
- `server/src/features/documentSymbol.ts` — Declaration extraction from parse tree
- `server/src/features/diagnostics.ts` — ERROR node → LSP diagnostic conversion
- `server/tree-sitter-pike.wasm` — Compiled Pike grammar (290KB)
- `client/extension.ts` — VSCode extension activating on .pike/.pmod/.mmod
- `harness/introspect.pike` — Extended with symbol extraction (indices/values/typeof)
- `tests/lsp/` — Protocol-level LSP tests (Layer 1)
- `tests/integration/` — VSCode integration test stubs (Layer 2)
- `MANUAL_SMOKE_TESTS.md` — Manual UX checklist (Layer 3)
- `docs/lsp-references.md` — LSP architecture reference + testing strategies
- `decisions/0006-lsp-server-architecture.md` — Server architecture decision

**Three-layer test infrastructure:**
- Layer 1 (protocol-level): 227 tests in tests/lsp/ — in-process PassThrough transport
- Layer 2 (VSCode integration): 3 test stubs in tests/integration/ — run before releases
- Layer 3 (manual): 3 items in MANUAL_SMOKE_TESTS.md — run before releases
- Tree-sitter unit tests: 108 tests in harness/__tests__/tree-sitter-symbol.test.ts

**Test suite:** 403 tests, 0 failures, 4306 assertions
- Phase 1 tests: 70 (harness + canary + canonicalizer)
- Phase 2 tree-sitter unit tests: 108 (renamed from document-symbol.test.ts)
- Layer 1 LSP tests: 227 (documentSymbol, lifecycle, error-handling)
- Layer 2 integration stubs: 3 todo
- Layer 3 manual: 3 items

### Phase 1: Test Harness Scaffolding (2026-04-26)

**Deliverables:**
- `harness/introspect.pike` — Pike introspection script (CompilationHandler + AutoDoc)
- `harness/src/` — TypeScript runner, snapshot manager, types
- `harness/__tests__/` — 70 tests (41 harness + 11 canary + 16 canonicalizer + 2 corpus additions)
- `harness/snapshots/` — 37 ground-truth JSON snapshots
- `decisions/0005-harness-architecture.md` — Harness architecture decision
- `package.json`, `tsconfig.json` — Project setup with bun + TypeScript 5.x

### Phase 0: Investigation (2026-04-26)

**Deliverables:**
- `docs/pike-interface.md` — Pike 8.0.1116 interface reference
- `docs/existing-tooling.md` — Survey of 12 existing Pike tooling projects
- `corpus/manifest.md` — 37 committed + 21 planned corpus entries
- `corpus/files/` — 37 Pike files covering 14 language feature categories
- `decisions/0001` through `decisions/0004` — Architecture decisions

## Open Issues

| Issue | Impact | Filed |
|-------|--------|-------|
| tree-sitter-pike#2: Missing field names on `for_statement` children | Must use positional child scanning instead of field-based API | [link](https://github.com/TheSmuks/tree-sitter-pike/issues/2) |
| tree-sitter-pike#3: `catch` expression lost in assignment context | Cannot create scopes for catch-block variables in `mixed err = catch { }` pattern | [link](https://github.com/TheSmuks/tree-sitter-pike/issues/3) |
| tree-sitter-pike#4: No scope-introducing nodes for while/switch/plain blocks | Variables in while/switch/do-while leak to enclosing scope | [link](https://github.com/TheSmuks/tree-sitter-pike/issues/4) |

## Deferred Items

- [x] **Phase 4 prerequisite: Replace filename-based cross-file invocation with manifest-driven per-file metadata.** Done in Phase 4. `corpus/corpus.json` replaces `CROSS_FILE_FLAGS`. Runner reads per-file compilation flags from manifest.
- [x] **Phase 5 prerequisite: Build `harness/resolve.pike` for cross-file resolution ground truth.** Done. `resolve.pike` introspects cross-file resolution via `master()->resolv()` and `cast_to_program()`. 7 resolution snapshots. 5 oracle tests comparing LSP against Pike.
- [x] **Phase 5 prerequisite: Wire `@vscode/test-electron` integration tests.** Done. Extension packaging with esbuild, 3 integration tests running inside VSCode extension host. See `decisions/0007-deferred-integration-tests.md`.
- [x] ~~Known limitation: tree-sitter-pike identifier grammar only accepts ASCII.~~ **Fixed** in tree-sitter-pike `28a8ae8` (Unicode property escapes). WASM updated, test updated.
- [x] **Rename feature:** Resolver-driven workspace-wide rename scoped at ~600 LOC. **Done in Phase 8.** 30 rename tests, scope-aware, cross-file, arrow-access support.
- [ ] **Cross-file propagation integration test:** `propagateToDependents` code correct but untested with real workspace files (ModuleResolver needs on-disk files). Requires layer-2 VSCode integration test.

## Oracle Gaps

The project's principle is "Pike is the oracle." Phase 4 has gaps where ground truth is structural (not from Pike):

| Area | Gap | Phase to fix |
|------|-----|-------------|
| Cross-file resolution targets | Tests verify file-level wiring (A→B) but not semantic correctness (which class, which members) | Phase 5 (`resolve.pike`) |
| .pmod directory member enumeration | `cross_pmod_dir.pmod/` not introspected by harness; no ground truth for what members the directory exposes | Phase 5 (`resolve.pike`) |
| Import symbol availability | `import cross_import_a` test only checks declaration exists, not which symbols become available | Phase 5 (`resolve.pike`) |
| Module resolution for .so/builtins | `Stdio.File` and 60 other C-implemented modules return NOT FOUND | Phase 5+ (pike-ai-kb or pre-built system map) |

## CI Improvement Tracking

- [ ] Add cross-version Pike snapshot testing hook (from decision 0004 caveat)
