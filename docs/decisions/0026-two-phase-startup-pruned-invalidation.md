# ADR 0026: Two-Phase Startup and Pruned Cache Invalidation

**Date**: 2026-05-19
**Status**: Accepted
**Deciders**: Pike LSP team

---

## Context

After Phase 1 optimizations reduced the build pipeline bottleneck, the remaining performance gap is in startup latency. The optimization proposal (M2, M3) identified two targets:

- **M2**: Serve cached data immediately on startup, refresh stale entries in background.
- **M3**: Only re-index files that actually changed and their dependents, not the entire workspace.

The original startup sequence was:
1. Load cache (non-blocking, fire-and-forget)
2. Background index discovers all files, parses them all, upserts them all

The problem: cache entries had no dependency information, so `invalidateWithDependents` couldn't work on restored entries. And background indexing re-indexed everything, even files whose content hadn't changed.

---

## Decision

### M3: Persist Forward Dependencies in Cache Entries

Each `CachedFileEntry` now includes a `dependencies: string[]` field containing the URIs of files this file depends on (inherit/import targets). When cache is restored:

1. Each entry is inserted via `upsertCachedFile` (unchanged — fast, sync).
2. `restoreDependencies(uri, deps)` reconstructs the reverse-dependency graph by calling `registerReverseDeps` with the persisted forward deps.
3. This enables `invalidateWithDependents` to work correctly on cache-restored data.

The reverse-dep graph is built from forward deps without any async resolution. This is safe because the forward deps are just URIs (strings), not resolved content.

### M2: Two-Phase Startup

**Phase 1 — Immediate serve** (existing behavior, enhanced):
- All cached entries are restored with their dependency links.
- The server is immediately operational with full symbol table data.
- Time-to-first-response: cache load time only (typically <500ms).

**Phase 2 — Background refresh** (`refreshStaleCacheEntries`):
- Runs asynchronously after Phase 1.
- For each cached entry, reads the file from disk and computes content hash.
- If hash matches cache: skip (no work needed).
- If hash differs: re-index the file via `upsertBackgroundFile`, then call `invalidateWithDependents` to transitively invalidate dependents.
- Files deleted from disk are also invalidated.

The background indexing step (7f) still runs in parallel, but it now skips files already in the index (including cache-restored ones). This means only truly new files (not in cache) are discovered and indexed from scratch.

### Shared Hash Function

The DJB2 hash was extracted from `WorkspaceIndex` into `cacheHash.ts` so both the index and the refresh logic can use the same hash function without coupling.

---

## Consequences

**Positive**:
- Time-to-first-response drops from "background index complete" to "cache load complete".
- Single-file edit only invalidates the file and its known dependents.
- Cache-restored entries have working reverse-dep graph for pruned invalidation.
- Background indexing does less work (skips cache-restored files).

**Negative**:
- Forward dependencies in cache entries may be stale if files were moved/renamed outside the editor. This is handled gracefully: the dep URIs are just strings, and resolution happens lazily. Stale URIs are no-ops.
- `refreshStaleCacheEntries` reads every cached file from disk. For 1000 files, this is ~1000 read syscalls. At ~0.1ms each, total is ~100ms — acceptable as background work.

**Deferred**:
- Adaptive loading (M1 Phase 2): initially load only entries needed for open files. Requires changes to the initial snapshot sent to the LSP client.

---

## Files Changed

| File | Change |
|------|--------|
| `server/src/features/persistentCache.ts` | Added `dependencies` field to `CachedFileEntry` |
| `server/src/features/workspaceIndex.ts` | Added `restoreDependencies` method |
| `server/src/features/cacheHash.ts` | New — extracted DJB2 hash |
| `server/src/serverLifecycle.ts` | Added `refreshStaleCacheEntries`, enhanced cache restore with deps |
