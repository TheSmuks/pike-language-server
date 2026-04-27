# Pike Language Server — Project Tracking

## Current Phase

**Phase 0: Investigation** — Complete (verified). Phase 1 entry pending review.

## Phase Status

| Phase | Status | Entry Checkpoint | Exit Checkpoint |
|-------|--------|-----------------|-----------------|
| Phase 0: Investigation | **Complete (verified)** | Repo created, template read, pike-ai-kb reachable | docs/pike-interface.md, docs/existing-tooling.md, corpus/manifest.md, 3+ decision documents |
| Phase 1: Test Harness Scaffolding | Pending | Phase 0 complete | Harness code, ground-truth snapshots, canary tests |
| Phase 2: VSCode Extension + Tree-sitter | Pending | Phase 1 complete | Extension installs, documentSymbol works |
| Phase 3: Per-file Symbol Table | Pending | Phase 2 complete | Same-file go-to-definition and find-references |
| Phase 4: Cross-file Resolution | Pending | Phase 3 complete | Cross-file navigation, workspace index |
| Phase 5: Types and Diagnostics | Pending | Phase 4 complete | Diagnostics and hover from pike oracle |
| Phase 6+: Refinement | Pending | Phase 5 complete | Completion, rename, code actions |

## Phase 0 Exit Checkpoint — Verified

### Deliverables

- [x] `docs/pike-interface.md` — 382 lines, 10+ sections, specific examples from live testing. **Updated with §3b (CompilationHandler), §3c (AutoDoc), §3d (error format stability).**
- [x] `docs/existing-tooling.md` — 145 lines, 12 entries documented with source URLs
- [x] `corpus/manifest.md` — 35 committed files (23 valid, 12 error), 21 planned P1/P2 entries
- [x] `corpus/files/` — **35 files** covering 13 language feature categories, all verified against pike
- [x] `decisions/0001-pike-as-oracle.md` — pike as oracle, alternatives considered
- [x] `decisions/0002-tier-3-scope.md` — tier-3 scope with precise type-resolution boundary (revised)
- [x] `decisions/0003-pike-ai-kb-integration.md` — pike-ai-kb usage strategy with fallback
- [x] `decisions/0004-structured-diagnostics.md` — CompilationHandler + AutoDoc discovery

### Verification Checks (2026-04-26)

**Check 1: Class-member typing boundary — Corrected.**
- Decision 0002 was revised to include a precise three-source type-resolution boundary table
- Sources: A (pike runtime), B (AutoDoc), C (source parser)
- Gap explicitly stated: undocumented object members require source parsing only
- Harness now knows what ground truth to capture per feature

**Check 2: Structured output investigation — New finding.**
- `compile_string(source, filename, handler)` with custom `CompilationHandler` captures structured diagnostics (file, line, message) — no stderr parsing needed
- `Tools.AutoDoc.PikeExtractor` extracts type information as XML for documented members
- `Standards.JSON.encode` enables JSON output from Pike scripts
- Error format stability: `CompilationHandler` is documented stable API; only Pike 8.0.1116 available for testing; error message strings unchanged across 8.0.x series
- **This changes the harness design**: use CompilationHandler instead of stderr parsing
- Decision 0004 created to document this discovery

**Check 3: Corpus size — Corrected.**
- Expanded from 19 to 35 files (target was 30-50)
- 23 valid / 12 error = 34% error rate (appropriate for harness robustness)
- 2 cross-file pairs (cross-lib-base + consumer, cross_lib_module + user)
- All files verified against pike 8.0.1116
- Manifest updated to reflect actual committed files

### Key Findings

1. **Pike has structured output via CompilationHandler** — `compile_string` with custom handler produces structured diagnostics. No stderr parsing needed for the harness.
2. **AutoDoc extracts type information as XML** — covers documented members with full generic types. Only works for `//!` documented members.
3. **Diagnostics are fully achievable** via handler JSON output.
4. **Type information is partially available.** Three sources: runtime typeof() (locals/expressions), AutoDoc (documented members), source parsing (all declarations).
5. **pike-ai-kb covers stdlib completion, hover, and syntax checking.** Does not cover cross-file navigation or project symbol indexing.
6. **The `typeof() → mixed` limitation for object members is the fundamental constraint.** Source parsing is the only option for undocumented members.
7. **Project is feasible as scoped.** No pause required at Phase 0.

## Completed Phase History

### Phase 0: Investigation (2026-04-26)

**Deliverables:**
- `docs/pike-interface.md` — Pike 8.0.1116 interface reference (10+ sections)
- `docs/existing-tooling.md` — Survey of 12 existing Pike tooling projects
- `corpus/manifest.md` — 35 committed + 21 planned corpus entries
- `corpus/files/` — 35 Pike files covering 13 language feature categories
- `decisions/0001-pike-as-oracle.md` — Use pike as oracle for diagnostics and types
- `decisions/0002-tier-3-scope.md` — Tier-3 scope with precise type-resolution boundary
- `decisions/0003-pike-ai-kb-integration.md` — pike-ai-kb usage strategy with fallback
- `decisions/0004-structured-diagnostics.md` — CompilationHandler + AutoDoc structured output

**Decisions:** 4 ADRs

## Open Issues

None.
