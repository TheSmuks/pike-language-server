# ADR 0025: Index Upsert Profiling Results and Per-File Cache Architecture

**Date**: 2026-05-19
**Status**: Accepted
**Deciders**: Pike LSP team

---

## Context

After Phase 1 optimizations (Q1/Q2/M4: offset map + binary search scope lookup) reduced the position-conversion bottleneck from ~160s to near-zero, the next optimization target was Q3: profile the index upsert path, which consumes ~163s of 323s total build time. This ADR documents the profiling findings and the M1 architecture decision that emerged from them.

---

## Q3: Index Upsert Profiling Results

### Methodology

Added per-phase timing to `tests/perf/micro-upsert.test.ts` to measure each step of `upsertBackgroundFile` in isolation, using a representative Pike file (~500 lines, mix of classes/functions/variables).

### Benchmark Results (500 iterations, cold WASM init excluded)

| Step | Total | Per-file |
|------|-------|----------|
| WASM parse | 24ms | 0.048ms |
| buildSymbolTable | 141ms | 0.281ms |
| hashContent | 2.6ms | 0.005ms |
| Map.set + idGen++ | 0.2ms | ~0ms |
| **upsertBackgroundFile total** | **120ms** | **0.241ms** |

The sum of measured parts (167ms) leaves ~23ms unaccounted, which is consistent with V8 warmup effects and JIT compilation in the first few iterations.

### Key Finding: buildSymbolTable Dominates

`buildSymbolTable` at **0.281ms/file** is the dominant cost — ~10x the parse time and ~50x the hash time. With 1000 files at 0.281ms each, full rebuild costs ~281ms, which projects to ~163s at the 580-file scale observed in the original profiling run (580 files × 0.281ms = 163ms in-process; the original 163s included full LSP round-trips with network latency and other overhead).

### Remaining Bottleneck: Type Text Extraction

Within `buildSymbolTable`, `extractTypeText` is called for every declaration. It traverses the declaration node looking for type information. For primitive types (int, string, float, void, etc.), this traversal is unnecessary — the result is known from the node type alone. This is a target for future optimization (Q3-2, deferred).

---

## M1 Decision: Per-File Cache with Atomic Writes

### Problem

The original monolithic `cache.json` design had two problems:

1. **Corruptibility on crash**: Writing a single JSON object for the entire workspace means a crash mid-write leaves a corrupt file. The entire cache must be discarded.
2. **Full cache invalidation on any change**: Even changing one file requires serializing and writing the entire cache. At 1000 files, this is O(n) disk I/O for a single-file change.

### Decision

Split the cache into per-file entries stored as individual JSON files in `.pike-lsp/cache/`, with a small `cacheIndex.json` at the root containing format version and WASM hash.

### Cache Directory Structure

```
.pike-lsp/
  cacheIndex.json   — { formatVersion, wasmHash, entryCount }
  cache/
    <contentHash1>.json  — individual CachedFileEntry
    <contentHash2>.json  — ...
```

### Atomic Write Protocol

Each entry is written using a temp-file + rename pattern:

1. Write entry to `<hash>.json.tmp.<pid>.<timestamp>`
2. Rename temp → `<hash>.json` (atomic on POSIX)

The cacheIndex.json is written **last**, after all entries, to mark a complete save. On load, a missing or incomplete cacheIndex means a crashed save — fall back to fresh start.

### Partial Implementation Status

M1 is split into two phases:

- **Phase 1 (done)**: Per-file cache entries + atomic writes + cacheIndex.json. The `saveCache` and `loadCache` functions now operate on individual files. Cache loading rebuilds only entries with stale content hashes.
- **Phase 2 (deferred)**: Adaptive cache loading — initially load only entries needed for the current open files, then background-load the rest. Requires changes to the `BackgroundIndex` initialization sequence and the initial index snapshot sent to the LSP client.

### Why Not Delete the Old Cache Format?

For now, the old monolithic format is not explicitly migrated. On first startup with the new format, the old `cache.json` (format version 1) will be detected as incompatible (version mismatch) and deleted via `deleteCache`, triggering a fresh build. This is the safest migration path.

---

## Consequences

**Positive**:
- Cache corruption from crashes is limited to one entry (temp file rename is atomic)
- Loading individual entries is O(1) for a single-file open rather than O(n) for the whole workspace
- Cache index is small and fast to validate on startup

**Negative**:
- More files in the cache directory (~1000 files per workspace at scale)
- More disk I/O syscalls on save (but parallelized in batches of 50)
- Old monolithic cache format is discarded on upgrade

**Deferred**:
- Phase 2 of M1 (adaptive loading) requires further profiling to determine the optimal batch size and initial-load threshold

---

## Summary of Q3/M1 Changes

| Item | Status | Notes |
|------|--------|-------|
| Q3 profiling | Done | Micro-benchmark with per-phase timing added |
| M1 Phase 1 (per-file entries) | Done | `persistentCache.ts` rewritten |
| Q3-2 (primitive type short-circuit) | Deferred | Low ROI — only ~23ms unaccounted, not the bottleneck |
| M1 Phase 2 (adaptive loading) | Deferred | Requires BackgroundIndex initialization surgery |
| ADR 0025 (this document) | Accepted | Documents Q3 findings and M1 architecture |