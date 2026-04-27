# Pike Language Server — Project Tracking

## Current Phase

**Phase 0: Investigation** — Complete. Phase 1 entry pending review.

## Phase Status

| Phase | Status | Entry Checkpoint | Exit Checkpoint |
|-------|--------|-----------------|-----------------|
| Phase 0: Investigation | **Complete** | Repo created, template read, pike-ai-kb reachable | docs/pike-interface.md, docs/existing-tooling.md, corpus/manifest.md, 3 decision documents |
| Phase 1: Test Harness Scaffolding | Pending | Phase 0 complete | Harness code, ground-truth snapshots, canary tests |
| Phase 2: VSCode Extension + Tree-sitter | Pending | Phase 1 complete | Extension installs, documentSymbol works |
| Phase 3: Per-file Symbol Table | Pending | Phase 2 complete | Same-file go-to-definition and find-references |
| Phase 4: Cross-file Resolution | Pending | Phase 3 complete | Cross-file navigation, workspace index |
| Phase 5: Types and Diagnostics | Pending | Phase 4 complete | Diagnostics and hover from pike oracle |
| Phase 6+: Refinement | Pending | Phase 5 complete | Completion, rename, code actions |

## Phase 0 Exit Checkpoint — Verified

- [x] `docs/pike-interface.md` exists — 322 lines, 10 sections, specific examples from live testing
- [x] `docs/existing-tooling.md` exists — 145 lines, 12 entries documented with source URLs
- [x] `corpus/manifest.md` exists — 56 entries across 15 categories with priority levels
- [x] `corpus/files/` exists — 19 initial corpus files (14 error-free, 5 error), verified against pike
- [x] `decisions/0001-pike-as-oracle.md` exists — pike as oracle, alternatives considered
- [x] `decisions/0002-tier-3-scope.md` exists — tier-3 scope based on what pike exposes, feasibility confirmed
- [x] `decisions/0003-pike-ai-kb-integration.md` exists — where kb is used, fallback strategy

### Key Findings

1. **Pike has no structured output mode.** All diagnostics are human-readable text to stderr. Must parse.
2. **Diagnostics are fully achievable.** `pike file.pike 2>&1` produces stable `<file>:<line>:<message>` format.
3. **Type information is partially available.** `typeof()` works for locals/expressions but returns `mixed` for object members.
4. **pike-ai-kb covers stdlib completion, hover, and syntax checking.** Does not cover cross-file navigation or project symbol indexing.
5. **The `typeof() → mixed` limitation for object members is the fundamental constraint.** Requires source-level parsing for member types.
6. **Project is feasible as scoped.** No need to pause at Phase 0.

## Completed Phase History

### Phase 0: Investigation (2026-04-26)

**Deliverables:**
- `docs/pike-interface.md` — Pike 8.0.1116 interface reference (10 sections)
- `docs/existing-tooling.md` — Survey of 12 existing Pike tooling projects
- `corpus/manifest.md` — 56-entry corpus inventory with priorities
- `corpus/files/` — 19 initial corpus files covering 13 language feature categories
- `decisions/0001-pike-as-oracle.md` — Use pike as oracle for diagnostics and types
- `decisions/0002-tier-3-scope.md` — Tier-3 scope definition based on pike capabilities
- `decisions/0003-pike-ai-kb-integration.md` — pike-ai-kb usage strategy with fallback

**Decisions:** 3 ADRs

## Open Issues

None.
