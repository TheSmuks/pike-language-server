# 0033: Lazy, On-Demand Indexing

**Status**: Accepted
**Date**: 2026-05-18
**Decision Maker**: LSP team
**Supersedes**: 0022 (Background Workspace Indexing) — replaces eager strategy

## Context

The current indexing strategy eagerly discovers, reads, parses, and indexes every `.pike`/`.pmod` file in the workspace on every startup. This works for small workspaces but fails at scale:

- Startup takes 2+ minutes for large workspaces before the server is responsive.
- Cache restoration (`upsertCachedFile`) resolves dependencies eagerly via async filesystem operations, creating a cascade of `stat()` calls that dominates startup time.
- Background indexing processes files in directory-walk order with no priority — the user's open files wait behind hundreds of unrelated files.
- There is no way to cancel or pause background indexing when user requests arrive.

This is fundamentally at odds with how production LSPs work. rust-analyzer computes everything lazily via salsa (incremental on-demand queries). gopls loads only package metadata at startup and type-checks on demand. Both guarantee sub-second time-to-first-response regardless of workspace size.

## Decision

### Principle: lazy by default, background as optimization

The server is **responsive immediately**. Every LSP request works on whatever data is available. Background indexing is a low-priority optimization that pre-populates data for future requests — it never blocks user-facing features.

### 1. Index insertion never resolves dependencies

Both `upsertBackgroundFile` and `upsertCachedFile` build symbol tables synchronously and insert with an empty dependency set. No async filesystem operations during insertion. Dependencies are resolved lazily when cross-file queries need them.

This is already the pattern for `upsertBackgroundFile`. `upsertCachedFile` is brought in line by removing its `extractDependencies` call.

### 2. Open files indexed first

Before the background sweep, all currently-open documents are indexed via `upsertFile` (full resolution including dependencies). This gives immediate feature availability for the files the user is actually looking at — typically 1-5 files, essentially free.

### 3. Background indexing is cancellable

`indexWorkspaceFiles` accepts a `CancellationToken`. The batch loop checks the token between batches. When cancelled, it stops cleanly and reports how many files were indexed. The token is NOT wired to user requests (that would add complexity for marginal gain) — it exists for future use and for clean shutdown.

### 4. Lazy dependency resolution at query time

Cross-file queries (go-to-definition across files, find-references) call `ensureDependenciesResolved` on the target file before proceeding. This resolves dependencies on demand and caches the result. Files that are never queried cross-file never pay the resolution cost.

### 5. Persistent cache is retained but simplified

The persistent cache is useful for avoiding re-parsing after a restart. The change makes it fast: `upsertCachedFile` no longer resolves dependencies, so cache restoration is just deserialization + insertion — milliseconds per file, no async work. The cache remains invalidated on grammar changes (WASM hash mismatch) since that's correctness-critical.

### 6. Startup sequence

```
initialize:
  - detectPikePaths (or use overrides) — synchronous

onInitialized:
  1. initParser (blocking — everything needs it)
  2. indexOpenDocuments (immediate — usually 0-5 files)
  3. loadCache (fire-and-forget — fast now, no dep resolution)
  4. indexWorkspaceFiles (fire-and-forget, cancellable, low priority)
  5. worker.warmUp (fire-and-forget)
```

Steps 2-5 run concurrently. The server responds to requests after step 1 completes. Background indexing and cache loading populate data that future requests will use.

## Consequences

### Positive

- Time-to-first-response: ~1s (parser init + open file indexing), regardless of workspace size.
- Background indexing does not block user requests — the event loop is free.
- Cache loading is fast: O(n) deserialization, zero async filesystem operations.
- Dependency resolution cost is paid only for files involved in cross-file queries.
- Cancellation token enables future priority inversion (pause background on user request).

### Negative

- First cross-file query on a file may be slow (dependency resolution). Mitigated by: (a) open files get full resolution immediately, (b) background indexing pre-populates symbol tables so resolution has more data to work with.
- Background-indexed files have no dependency edges until resolved. `invalidateWithDependents` on a background-indexed file will not invalidate its dependents (because there are no edges). This is acceptable: stale data is lazily refreshed on next query.

### Neutral

- `upsertCachedFile` signature changes from async to sync (was already sync in practice — the only async part was `extractDependencies`, now removed).
- The `ensureDependenciesResolved` method becomes the gateway for cross-file feature correctness.

## Alternatives Considered

### Full salsa-style query system (rust-analyzer)
Incremental memoized queries with automatic invalidation. Extremely powerful but requires a fundamental architectural rewrite. Overkill for a Tier-3 LSP with a Pike-specific niche. The lazy `ensureDependenciesResolved` pattern gives 80% of the benefit for 5% of the complexity.

### Drop persistent cache entirely (rust-analyzer)
rust-analyzer recomputes everything from source on restart. Viable because salsa makes recomputation cheap. Our background indexing is already fast (sync, no deps), so the cache is a minor optimization. Retained because it's now cheap to maintain and avoids re-parsing unchanged files.

### Separate worker process for indexing
Adds IPC complexity. The batch + yield approach is sufficient — tree-sitter parsing is fast, and the event loop is freed between batches.

## Reference

- rust-analyzer architecture: https://rust-analyzer.github.io/book/contributing/architecture.html
  - Core invariant: "typing inside a function's body never invalidates global derived data"
  - `prime_caches` runs at idle priority, cancellable
  - salsa: incremental on-demand computation
- gopls architecture: golang.org/x/tools/gopls/internal/cache
  - Snapshot pattern for concurrent request isolation
  - Metadata first, type-check on demand
  - Persistent per-package cache keyed on content hash
- Pike LSP references doc: `docs/lsp-references.md` — "Cross-translation-unit indexing" and "Performance: when things get slow"
