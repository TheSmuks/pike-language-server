# Pike Language Server — Project Tracking

## Current Phase

**Phase 1: Test Harness Scaffolding** — Complete. Phase 2 entry pending review.

## Phase Status

| Phase | Status | Entry Checkpoint | Exit Checkpoint |
|-------|--------|-----------------|-----------------|
| Phase 0: Investigation | Complete (verified) | Repo created, template read, pike-ai-kb reachable | docs, corpus, 4 decision documents |
| Phase 1: Test Harness | **Complete** | Phase 0 complete | Harness code, ground-truth snapshots, canary tests |
| Phase 2: VSCode Extension + Tree-sitter | Pending | Phase 1 complete | Extension installs, documentSymbol works |
| Phase 3: Per-file Symbol Table | Pending | Phase 2 complete | Same-file go-to-definition and find-references |
| Phase 4: Cross-file Resolution | Pending | Phase 3 complete | Cross-file navigation, workspace index |
| Phase 5: Types and Diagnostics | Pending | Phase 4 complete | Diagnostics and hover from pike oracle |
| Phase 6+: Refinement | Pending | Phase 5 complete | Completion, rename, code actions |

## Phase 1 Exit Checkpoint — Verified

### Exit Criteria

- [x] **harness/ directory with harness code** — introspect.pike + TypeScript runner + snapshot manager
- [x] **harness/snapshots/ with ground-truth for every corpus file** — 35/35 snapshots
- [x] **harness verify produces zero diffs** — `bun run harness:verify` → "All 35 snapshots verified"
- [x] **5-10 canary tests, hand-verified, running in CI** — 11 canary tests across 4 categories
- [x] **Decision 0004 expanded with CompilationHandler finding** — includes cross-version caveat
- [x] **All five phase 1 tests pass:**
  - [x] Every corpus file has a snapshot (35/35)
  - [x] All canaries pass (11/11)
  - [x] Two consecutive runs produce identical output (3/3 deterministic files)
  - [x] Modifying a corpus file produces a diff (mutation detection works)
  - [x] Deliberately breaking harness makes canaries fail (removing snapshot → fail, breaking script → 5/11 fail)

### Test Suite Summary

```
52 tests, 0 failures, 468 assertions, 15 seconds
- harness.test.ts: 41 tests (coverage, ground truth, determinism, mutation, schema)
- canary.test.ts: 11 tests (valid files, error files, deliberately broken, structure)
```

### Deliverables

| Component | Path | Lines | Purpose |
|-----------|------|-------|---------|
| Pike introspection script | `harness/introspect.pike` | ~120 | CompilationHandler + AutoDoc → JSON |
| TypeScript types | `harness/src/types.ts` | ~30 | IntrospectionResult, Diagnostic interfaces |
| TypeScript runner | `harness/src/runner.ts` | ~170 | Subprocess invocation, CLI modes |
| Snapshot manager | `harness/src/snapshot.ts` | ~130 | Read/write/diff with canonical ordering |
| Harness tests | `harness/__tests__/harness.test.ts` | ~155 | 41 tests |
| Canary tests | `harness/__tests__/canary.test.ts` | ~170 | 11 hand-verified tests |
| Ground-truth snapshots | `harness/snapshots/` | 35 files | JSON from Pike 8.0.1116 |
| Harness architecture | `decisions/0005-harness-architecture.md` | ~120 | Design decision |

### Key Decisions

- **Decision 0005**: Harness architecture — two-layer system (Pike script + TypeScript runner), canonical JSON for stable comparison, 11 canaries as integrity checks.

### Design Decisions for Verification Review

These are assumptions the harness makes that verification should scrutinize:

1. **Diagnostics are the only ground truth captured.** The harness does not capture symbol information or type resolution from pike — only compile-time diagnostics and AutoDoc XML. Phase 2+ will add new ground-truth sources.

2. **AutoDoc is captured but not compared structurally.** AutoDoc XML is stored in snapshots as a raw string. The harness does not parse or diff the XML — it only checks that the string matches. Future phases may need structured AutoDoc comparison.

3. **Cross-file test invocation is special-cased.** `cross-lib-user.pike` needs `--module-path .` and `cross-lib-consumer.pike` needs `--include-path .`. The runner detects these by filename pattern. This is fragile — if more cross-file tests are added, the detection needs updating.

4. **Snapshot format stability depends on Pike's JSON output ordering.** Pike's `Standards.JSON.encode` uses mapping iteration order, which is not guaranteed stable. The TypeScript canonicalizer reorders keys for comparison. If Pike changes its mapping implementation, the canonicalizer should still work — but this was a source of test flakiness during development.

5. **The `--strict` flag is used for all files.** This means `#pragma strict_types` is prepended to files that already have it (no-op, since the script checks for existing pragma). Files without it get strict checking even if they weren't designed for it — but all corpus files were written with strict_types awareness.

## Completed Phase History

### Phase 1: Test Harness Scaffolding (2026-04-26)

**Deliverables:**
- `harness/introspect.pike` — Pike introspection script (CompilationHandler + AutoDoc)
- `harness/src/` — TypeScript runner, snapshot manager, types
- `harness/__tests__/` — 52 tests (41 harness + 11 canary)
- `harness/snapshots/` — 35 ground-truth JSON snapshots
- `decisions/0005-harness-architecture.md` — Harness architecture decision
- `package.json`, `tsconfig.json` — Project setup with bun + TypeScript 5.x

### Phase 0: Investigation (2026-04-26)

**Deliverables:**
- `docs/pike-interface.md` — Pike 8.0.1116 interface reference
- `docs/existing-tooling.md` — Survey of 12 existing Pike tooling projects
- `corpus/manifest.md` — 35 committed + 21 planned corpus entries
- `corpus/files/` — 35 Pike files covering 13 language feature categories
- `decisions/0001` through `decisions/0004` — Architecture decisions

## Open Issues

None.

## CI Improvement Tracking

- [ ] Add cross-version Pike snapshot testing hook (from decision 0004 caveat)
