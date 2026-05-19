# Optimization Proposal: Pike LSP Indexing Performance

**Author**: AI Performance Engineer
**Date**: 2026-05-19
**Status**: Draft
**Target**: 323s → <30s (Phase 1), <2s (Phase 2), <100ms incremental (Phase 3)

---

## Executive Summary

Full workspace indexing takes **323 seconds** on the current codebase. Profiling identifies a single root cause — `utf8ToUtf16()` called ~11.3M times inside `findScopeForNode()` — consuming ~160s. The remaining ~163s splits between reference resolution overhead and index upsert. This proposal presents a three-phase plan with concrete, measurable fixes for each.

---

## Priority Matrix (Impact vs. Effort)

```
Impact ↑
  │
  │  Q1 ★★★    Q2 ★★
  │  utf8 cache  byte→utf16 map
  │
  │  Q3 ★★     M1 ★★     L1 ★★★
  │  upsert opt  disk cache  Salsa arch
  │──────────────────────────────────→ Effort
  │  M2 ★★     M3 ★      L2 ★★
  │  stale srv  dep graph  version vec
  │
  │  M4 ★      L3 ★★
  │  binary src  parallel idx
```

| ID | Item | Impact | Effort | ROI |
|----|------|--------|--------|-----|
| Q1 | Cache utf8ToUtf16 in findScopeForNode | ★★★ | 1 day | Critical |
| Q2 | Pre-compute byte→UTF-16 offset map | ★★ | 2 days | High |
| Q3 | Profile & optimize index upsert | ★★ | 3 days | High |
| M1 | Content-addressed disk cache | ★★ | 1 week | Medium |
| M2 | Two-phase startup (stale serve) | ★ | 1 week | Medium |
| M3 | Dependency graph pruned invalidation | ★ | 1 week | Medium |
| M4 | Binary search scope lookup | ★ | 2 days | Medium |
| L1 | Salsa-like query architecture | ★★★ | 4-6 weeks | Strategic |
| L2 | Durability version vectors | ★★ | 2 weeks | Strategic |
| L3 | Snapshot parallelism | ★★ | 2 weeks | Strategic |

---

## Phase 1: Quick Wins (Week 1)

**Target**: 323s → <30s
**Effort**: 1 engineer, 5 working days
**Risk**: Low — all changes are localized, no architectural shifts.

### Q1: Cache utf8ToUtf16 Results in findScopeForNode

**Priority**: P0 — single highest-impact fix
**Estimated effort**: 1 day (5-10 lines of code)
**Risk**: Minimal — additive caching, no behavior change

**Problem**: `findScopeForNode()` (in `server/src/features/scope-helpers.ts:341-361`) calls `containsPosition()` for every scope in `state.scopes`. Each `containsPosition()` call (line 62-72) invokes `utf8ToUtf16()` twice — once for `startCol`, once for `endCol`. For master.pike with ~5,650 references and ~1,000 scopes, this produces:

```
utf8ToUtf16 calls ≈ 2 × R × S = 2 × 5,650 × 1,000 = 11,300,000
```

Each call re-encodes the full line text via `encoder.encode(lineText).byteLength` — even when the same (line, column) pair was converted milliseconds prior.

**Fix**: Add a `Map<string, number>` cache to `BuildState`. Key = `${row}:${column}`, value = UTF-16 offset. Compute only on cache miss.

```typescript
// In scope-helpers.ts or a new positionCache field on BuildState
export function cachedUtf8ToUtf16(
  lines: string[],
  row: number,
  column: number,
  cache: Map<string, number>
): number {
  const key = `${row}:${column}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const result = utf8ToUtf16(lines[row] ?? '', column);
  cache.set(key, result);
  return result;
}
```

**Expected savings**: ~160s eliminated. The 11.3M calls reduce to ~unique (row, column) pairs — approximately 2 × number of distinct positions, roughly ~20K-50K unique conversions. That is a **~250× reduction** in utf8ToUtf16 invocations.

**Verification**: Run the existing perf benchmarks before and after:
```bash
bun test tests/perf/
```
Expect wall-clock for master.pike to drop from ~160s to <1s for the reference pass.

---

### Q2: Pre-compute Byte-Offset → UTF-16-Offset Map Per File

**Priority**: P1
**Estimated effort**: 2 days
**Risk**: Low — replaces per-call conversion with a one-time scan

**Problem**: `utf8ToUtf16()` in `server/src/util/positionConverter.ts:24-57` is called from 15+ files across the codebase. Even with Q1's cache inside `findScopeForNode`, other callers (declaration collectors, reference collectors, feature providers) still pay the per-call encoding cost.

**Fix**: At parse time, compute a full line-by-line byte→UTF-16 offset table for each file. Store it alongside the parsed tree in `BuildState` (the `lines[]` array is already split). Replace all `utf8ToUtf16(line, byteOffset)` calls with `offsetMap[row][byteOffset]` — an O(1) array lookup instead of an O(n) character scan.

```typescript
// Pre-compute at parse time
interface OffsetMap {
  // offsetMap[row][byteColumn] = utf16Column
  lines: Int32Array[];  // one Int32Array per line, indexed by byte offset
}

function buildOffsetMap(lines: string[]): OffsetMap {
  const result: Int32Array[] = [];
  for (const line of lines) {
    const utf8 = encoder.encode(line);
    const map = new Int32Array(utf8.byteLength + 1);
    let byteCount = 0;
    let charIndex = 0;
    map[0] = 0;
    while (charIndex < line.length) {
      const cp = line.codePointAt(charIndex)!;
      const charBytes = encoder.encode(String.fromCodePoint(cp)).byteLength;
      byteCount += charBytes;
      const advance = cp > 0xffff ? 2 : 1;
      for (let b = byteCount - charBytes + 1; b < byteCount; b++) {
        map[b] = charIndex;  // mid-character byte offsets map to char start
      }
      map[byteCount] = charIndex + advance;
      charIndex += advance;
    }
    result.push(map);
  }
  return { lines: result };
}
```

**Expected savings**: Eliminates all remaining `utf8ToUtf16` overhead. For ASCII-heavy Pike code, this is a few microseconds per file. Total savings: ~10-30s across all features that call position conversion.

**Dependencies**: None — can be done in parallel with Q1.

---

### Q3: Profile and Optimize Index Upsert Path

**Priority**: P1
**Estimated effort**: 3 days (1 day profiling, 2 days fixes)
**Risk**: Medium — bottleneck could be in serialization, I/O, or data structure

**Problem**: The index upsert path consumes ~163s of the 323s total. Three code paths exist in `server/src/features/workspaceIndex.ts`:
- `upsertFile()` (lines 103-137): Full async path with dependency resolution
- `upsertBackgroundFile()` (lines 147-178): Fast sync path, used for bulk indexing
- `upsertCachedFile()` (lines 223-242): Cache restore path

The background path is already claimed to be ~10× faster than the full path, but it still accounts for significant time.

**Investigation steps**:
1. Add per-operation timing to `upsertBackgroundFile()` using the existing `profiler.ts` instrumentation
2. Measure: (a) `buildSymbolTable()` time, (b) `hashContent()` time, (c) `extractDependencies()` time
3. Profile memory allocation patterns — the `BuildState` creates many intermediate objects
4. Check if `generation++` triggers any cascading invalidation
5. Measure `registerReverseDeps()` cost for the full path

**Hypothesized bottlenecks**:
- `hashContent()` (DJB2) on large files is O(n) per file — consider xxHash or skipping if content hasn't changed
- `buildSymbolTable()` for background files still runs the full reference pass (the expensive part)
- Object allocation pressure: each file creates `Declaration[]`, `Reference[]`, `Scope[]` arrays

**Success metric**: Upsert time drops to <10s for the full workspace.

---

## Phase 2: Medium-Term Optimizations (Weeks 2-4)

**Target**: <2s first response after startup
**Effort**: 3-4 weeks
**Risk**: Medium — involves architectural changes but no breaking API changes.

### M1: Content-Addressed Disk Cache

**Priority**: P2
**Estimated effort**: 1 week
**Risk**: Low

**Current state**: `server/src/features/persistentCache.ts` (246 lines) already implements a JSON-based disk cache at `.pike-lsp/cache.json`, keyed by content hash. It invalidates on grammar changes (WASM hash).

**Improvements needed**:
1. Replace JSON serialization with binary serialization (MessagePack or protobuf). Symbol tables are large structured data — JSON parsing is ~5-10× slower than binary.
2. Split the monolithic `cache.json` into per-file cache entries. Currently, loading one file requires parsing the entire cache.
3. Add content-hash-based invalidation per file instead of global WASM-hash invalidation.
4. Implement atomic writes (write to temp file, rename) to prevent corruption on crash.

**Expected savings**: Cold-start indexing eliminated for unchanged files. A workspace where 95% of files are unchanged sees ~20× reduction in startup time.

**Relevant precedent**: gopls `filecache` package uses SHA-256 keys with machine-global shared storage (see `gopls-indexing-research.md`).

---

### M2: Two-Phase Startup (Serve Stale, Refresh in Background)

**Priority**: P3
**Estimated effort**: 1 week
**Risk**: Medium — must handle stale data gracefully in feature providers

**Approach**:
1. On startup, immediately load the persistent cache into the workspace index via `upsertCachedFile()`.
2. Begin serving LSP requests using cached data. Mark all cached entries as "stale".
3. In background, re-parse and re-index files. Swap in fresh results as they complete.
4. Feature providers check staleness and can choose to wait for fresh data or use cached.

**This already partially exists**: ADR 0023 implements lazy on-demand indexing. The missing piece is serving stale results immediately rather than blocking.

**Expected savings**: Time-to-first-response drops from 323s to <500ms (disk cache load time).

---

### M3: Include/Inherit Dependency Graph for Pruned Invalidation

**Priority**: P3
**Estimated effort**: 1 week
**Risk**: Medium — requires accurate dependency tracking

**Current state**: `server/src/features/workspaceDependencies.ts` (134 lines) extracts inherit/import relationships. `wireInheritance()` in `scopeBuilder.ts` does cross-file class wiring. But when a file changes, the system re-indexes it without knowing what depends on it.

**Fix**: Build a reverse dependency graph during indexing. When file A changes:
1. Re-index A.
2. Find all files that inherit from or import A (reverse deps).
3. Only re-index those files, not the entire workspace.

**Expected savings**: For a single-file edit, re-indexing drops from O(workspace) to O(dependents). Typically 1-5 files instead of hundreds.

---

### M4: Binary Search Scope Lookup

**Priority**: P3
**Estimated effort**: 2 days
**Risk**: Low

**Problem**: `findScopeForNode()` does a linear scan over ALL scopes (O(S)). For 1,000 scopes, each reference pays 1,000 iterations.

**Fix**: After the declaration pass completes (when all scopes are known), sort scopes by start position. Replace the linear scan with binary search to find the candidate scope, then walk outward checking containment.

```typescript
function findScopeForNodeFast(
  node: Node,
  sortedScopes: Scope[],
  offsetMap: OffsetMap
): number | null {
  const nodeStart = offsetMap.lines[node.startPosition.row][node.startPosition.column];
  // Binary search for smallest scope containing nodeStart
  let lo = 0, hi = sortedScopes.length - 1;
  let best: number | null = null;
  // ... binary search + containment check
  return best;
}
```

**Expected savings**: O(S) → O(log S) per reference. For 1,000 scopes, ~10× fewer comparisons per reference. Combined with Q1's cache, this makes the reference pass sub-second.

---

## Phase 3: Long-Term Architecture (Months 2-3)

**Target**: Sub-100ms incremental updates
**Effort**: 6-10 weeks
**Risk**: High — fundamental architecture change

### L1: Salsa-like Demand-Driven Query Architecture

**Priority**: P4 (strategic)
**Estimated effort**: 4-6 weeks
**Risk**: High — full rewrite of the indexing pipeline

**What**: Replace the batch indexing pipeline with a demand-driven query system modeled on rust-analyzer's Salsa framework. Each piece of analysis (parse, declarations, references, types) becomes a memoized query that automatically tracks dependencies and only recomputes when inputs change.

**Why**: The current architecture re-indexes entire files even when only a function body changed. Salsa's invalidation barriers would prevent this — editing inside a function body would only re-run type inference for that function, not re-resolve names for the entire file.

**Adaptation challenges**:
- TypeScript doesn't have Rust's macro system for generating query boilerplate. Would need a code generator or manual query registration.
- The current imperative BuildState must be decomposed into pure query functions.
- Cancellation support is critical for IDE responsiveness — Salsa's revision-based cancellation is ideal.

**Expected savings**: Incremental updates drop to O(changed item + dependents) instead of O(file).

**Reference**: See `rust-analyzer-indexing-research.md` for detailed Salsa analysis.

---

### L2: Durability Version Vectors

**Priority**: P5
**Estimated effort**: 2 weeks
**Risk**: Medium

**What**: Assign monotonic version vectors to cache entries. When the LSP restarts, it can determine which cache entries are still valid by comparing version vectors with the current file system state, instead of re-hashing all file contents.

**Why**: Current cache invalidation requires reading every file to compute its content hash. Version vectors allow O(1) validity checks for files with known modification times.

---

### L3: Snapshot Parallelism

**Priority**: P5
**Estimated effort**: 2 weeks
**Risk**: Medium — requires careful synchronization

**What**: Index multiple files concurrently on immutable snapshots of their content. Use worker threads or structured concurrency (e.g., `Promise.all` with bounded parallelism).

**Why**: The current `backgroundIndex.ts` processes files in batches of 8 for parsing, but the upsert phase is sequential. The upsert phase is where most time is spent. Parallelizing it (with per-file isolation) would use available CPU cores.

**Constraint**: The shared `ModuleResolver` cache (bounded at 2000 entries) would need to be made thread-safe or duplicated per worker.

**Expected savings**: ~N× speedup where N = CPU cores, assuming I/O is not the bottleneck.

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Q1 cache causes OOM on huge files | Low | Medium | Limit cache size; fallback to direct computation |
| Q2 offset map memory overhead | Low | Low | ~4 bytes per byte offset per line; ~1MB for a 50K-line file |
| Q3 profiling reveals architectural bottleneck | Medium | High | May require Phase 2 work earlier |
| M1 binary serialization breaks cache compat | Medium | Low | Version the cache format; clear on format change |
| M2 stale data causes incorrect completions | Medium | High | Mark stale entries; re-validate before presenting |
| L1 Salsa rewrite introduces regressions | High | High | Incremental migration; keep old path as fallback |

---

## Success Metrics

| Phase | Metric | Current | Target |
|-------|--------|---------|--------|
| Phase 1 | Full workspace index time | 323s | <30s |
| Phase 1 | utf8ToUtf16 call count (master.pike) | 11.3M | <50K |
| Phase 1 | findScopeForNode time (master.pike) | ~160s | <0.5s |
| Phase 1 | Index upsert time (full workspace) | ~163s | <10s |
| Phase 2 | Time-to-first-response (warm cache) | 323s | <2s |
| Phase 2 | Single-file re-index time | ~323s (full) | <200ms |
| Phase 3 | Incremental update latency | N/A | <100ms |

---

## Implementation Order

```
Week 1: Q1 (utf8 cache) → Q2 (offset map) → Q3 (profile upsert)
Week 2: M4 (binary search scopes) → M1 (disk cache improvements)
Week 3: M3 (dependency graph) → M2 (stale serve)
Week 4: Validation, benchmarking, documentation
Month 2-3: L1 (Salsa architecture) → L2 (version vectors) → L3 (parallelism)
```
