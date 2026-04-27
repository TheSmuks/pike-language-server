# Pike Language Server — Project Tracking

## Current Phase

**Phase 2: VSCode Extension + Tree-sitter** — In verification. Phase 3 entry pending review.

### Phase 2 Verification Status

| Item | Status |
|------|--------|
| 1. JSON-RPC serialization round-trip | Confirmed — real Content-Length + JSON envelope on wire |
| 1. Unicode round-trip test | Added — 2 tests (string literals, identifiers) |
| 2. Layer-2 phase commitment | Decision 0007 — deferred to Phase 5 |
| 3. Test failure message quality | Confirmed — file, symbol kind, name, actual set shown |
| 4. Test suite performance | Optimized — 227 tests in 500ms (2.2ms avg) |
| 5. LSP-vs-pike structural comparison | Confirmed — decision 0008 documents 5 structural diffs (enums, inheritance, error files, cross-file, class members) |

## Phase Status

| Phase | Status | Entry Checkpoint | Exit Checkpoint |
|-------|--------|-----------------|-----------------|
| Phase 0: Investigation | Complete (verified) | Repo created, template read, pike-ai-kb reachable | docs, corpus, 4 decision documents |
| Phase 1: Test Harness | **Complete (verified)** | Phase 0 complete | Harness code, ground-truth snapshots, canary tests |
| Phase 2: VSCode Extension + Tree-sitter | **Complete** | Phase 1 complete | Extension installs, documentSymbol works |
| Phase 3: Per-file Symbol Table | Pending | Phase 2 complete | Same-file go-to-definition and find-references |
| Phase 4: Cross-file Resolution | Pending | Phase 3 complete | Cross-file navigation, workspace index |
| Phase 5: Types and Diagnostics | Pending | Phase 4 complete | Diagnostics and hover from pike oracle |
| Phase 6+: Refinement | Pending | Phase 5 complete | Completion, rename, code actions |

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

None.

## Deferred Items

- [ ] **Phase 4 prerequisite: Replace filename-based cross-file invocation with manifest-driven per-file metadata.** The current `CROSS_FILE_FLAGS` hardcoded map in `runner.ts` does not scale. Before Phase 4 entry, the runner must read per-file flags (module-path, include-path) from corpus manifest metadata. See `decisions/0005-harness-architecture.md` §Deferred Items.
- [ ] **Phase 5 prerequisite: Wire `@vscode/test-electron` integration tests.** Layer-2 tests deferred from Phase 2. The integration test stubs exist at `tests/integration/` but require extension packaging (esbuild, VSIX) before they can run. See `decisions/0007-deferred-integration-tests.md`.
- [x] ~~Known limitation: tree-sitter-pike identifier grammar only accepts ASCII.~~ **Fixed** in tree-sitter-pike `28a8ae8` (Unicode property escapes). WASM updated, test updated.

## CI Improvement Tracking

- [ ] Add cross-version Pike snapshot testing hook (from decision 0004 caveat)
