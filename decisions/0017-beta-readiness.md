# Decision 0017: Beta Readiness (Phase 9)

**Date:** 2026-04-28
**Status:** Accepted

## Context

The project is at v0.1.0-alpha.44, "Alpha -- functional for daily use, breaking changes possible." It has real users: 3 forks, a Helix user reporting install difficulties on the Pike mailing list, and alpha release 44 in the wild.

All planned LSP features through Phase 8 are implemented: documentSymbol, definition, references, hover, diagnostics, completion, and rename. The test suite has 1,051 tests, 0 failures, 8,896 assertions.

Phase 9 moves the project from Alpha to Beta. "Beta" means:
- The install story works for at least one non-VSCode client
- Core features are verified on real-world Pike code (not just the corpus)
- Performance characteristics are measured at realistic scale
- Resource policies hold after Phase 8 additions

## Decision

Phase 9 has three workstreams, executed in strict order. Workstream 2 does not begin until Workstream 1 is complete.

### Workstream 1: User-facing roughness (P1)

**Problem:** A Helix user on the Pike mailing list reports install difficulties ("Not having much success with npm and pnpm"). This blocks adoption.

**Scope:**
- Reproduce the Helix install failure from a clean Linux system with Pike 8 installed
- Fix the install story: clearer prerequisites, better error messages, single-command install path
- Verify the LSP works with at least one non-VSCode client (Helix or Neovim with nvim-lspconfig)
- Add `docs/other-editors.md` with verified setup instructions

**Exit criteria:**
- Install instructions verified end-to-end on clean Linux + one non-VSCode client
- At least one non-VSCode client setup documented with specific configuration
- No claim of multi-editor support without verified proof

### Workstream 2: Production quality (P2)

**Problem:** The test corpus was curated for language features, not for real-world patterns. Alpha-to-Beta requires knowing how the LSP behaves on actual codebases.

**Scope:**
- Run the full LSP against a real Pike codebase (Pike's lib/modules/, Roxen source, or pike-ai-kb)
- For each P1 failure (crash, wrong answer, missing core feature): file issue, fix
- For each P2 failure (degraded hover, missed completion, wrong navigation): document with specific description

**Exit criteria:**
- Real-codebase run completed
- All P1 failures fixed
- All P2 failures documented with specific input/position/output descriptions

### Workstream 3: Performance at scale (P3)

**Problem:** Performance baselines were measured on corpus files (small). Real codebases are 50-500x larger.

**Scope:**
- Measure member-access completion on realistic inputs (already verified: no linear scan exists, #2210 closed)
- Measure cold-workspace indexing on a 500-file codebase (synthesize if needed)
- Re-verify the eight resource policies from Phase 5 after Phase 8 added rename

**Exit criteria:**
- Cold-workspace indexing time documented for 500-file workspace
- Eight resource policies confirmed holding (or fixes applied)
- Completion p99 warm documented for large workspace

## What Phase 9 does NOT do

- No new LSP features (code actions, signature help, formatting, semantic tokens)
- No monorepo restructuring
- No breaking changes to the extension API

## Beta release criteria

Phase 9 produces a `v0.2.0-beta` tag when:
1. Workstream 1 is complete (verified non-VSCode client)
2. Workstream 2 is complete (real-codebase P1 failures fixed)
3. All 1,051+ existing tests pass
4. `docs/state-of-project.md` is current
5. CHANGELOG.md updated for beta release

Workstream 3 (performance) does not block the beta tag. It informs the beta -- if workspace indexing takes 30 seconds on a 500-file codebase, that should be documented -- but the beta tag is about correctness and installability, not performance optimization.

## Entry checkpoint

- Phase 8 complete (1,051 tests, post-audit fixes applied)
- docs/state-of-project.md updated
- PLAN.md archived
- 6 bot-filed issues and 2 bot PRs closed with explanations

## Test set

- All 1,051 existing tests still pass (regression)
- At least one integration test using a non-VSCode LSP client (even a headless test client)
- Install script or CI step that verifies install from scratch
