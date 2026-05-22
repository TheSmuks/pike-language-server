# ADR 0029: Tree Cache Eviction Policy

**Date:** 2026-05-19
**Status:** Accepted
**Authors:** Hermes Agent (for TheSmuks)

## Context

During background workspace indexing, memory pressure warnings were observed
(heap 51MB / 52MB at 97%) with a tree cache of only 1 entry (719KB). The warning
message suggested reducing `backgroundIndex.batchSize`, which was misleading —
batch size does not control tree cache eviction. The noise obscured actionable
diagnostics.

The question arose: should we adopt the 3-zone LRU (green/yellow/red) strategy
used by rust-analyzer's Salsa framework, replacing our current strict LRU?

## Decision

We retain the strict LRU implementation in `server/src/util/lruCache.ts`. The
memory monitor warning in `serverLifecycle.ts` is restructured so it only fires
when the tree cache has enough entries (> 5) for eviction to actually reclaim
memory.

## Reasoning

### Why the warning was noise

The tree cache was 1 entry (719KB) while heap usage was 51MB. The dominant memory
consumers were:

- tree-sitter WASM runtime (~10-15MB, fixed)
- stdlib-autodoc.json (~15-20MB, loaded at startup)
- V8 internals and parser state (~15-20MB)

`backgroundIndex.batchSize` controls how many files are read/parsed concurrently
during initial indexing — it has no effect on the tree cache, which is keyed by
URI of open/edited documents only. Reporting "consider reducing batchSize" when
the tree cache had 1 entry was not actionable.

### Why 3-zone LRU is overkill for our tree cache

rust-analyzer's Salsa 3-zone LRU solves a real problem: managing thousands of
incremental query results where access patterns can cause pathological eviction
behavior. Our tree cache has a hard cap of 50 entries.

| Factor | Our tree cache | Salsa query cache |
|--------|---------------|-------------------|
| Scale | ≤ 50 entries | Thousands |
| Eviction candidates | All reachable | All reachable |
| Recomputation cost | Tree re-parse (fast) | Semantic analysis (slow) |
| Access pattern | Open docs / recent hover | Complex, interdependent |
| Strict LRU pathology | Rare at this scale | Common without zones |

The pathologies 3-zone solves — starvation under scan access, clock algorithm
edge cases — don't manifest at 50 entries. Strict LRU is simple, predictable,
and correct for our access pattern: a document being actively edited/hovered is
exactly the one that should be retained.

### What we actually needed

The real issue was not eviction algorithm sophistication but:

1. **Actionable warnings only.** Only warn when eviction would reclaim something.
2. **Show eviction count.** Tell the user how many entries will be evicted so
   they can judge whether tuning helps.

## Changes Made

**serverLifecycle.ts** — restructure the memory monitor:

```
BEFORE: warn every 60s regardless of tree cache size
AFTER:  warn only when treeStats.size > 5, include evict count
```

**lruCache.ts** — unchanged. Strict LRU with byte + entry count ceiling remains
correct for our use case.

## Future Consideration

If Phase 3 (demand-driven semantic queries) introduces new caches with
substantially larger entry counts and complex access patterns, revisit the
3-zone approach for those caches specifically. The tree cache at 50-entry scale
does not need this sophistication.

## References

- rust-analyzer / Salsa memory management:
  https://deepwiki.com/rust-analyzer/salsa/5-memory-management
- rust-analyzer measuring memory:
  https://rust-analyzer.github.io/blog/2020/12/04/measuring-memory-usage-in-rust.html
- gopls memory handling (accepted that memory scales with workspace size):
  https://github.com/golang/go/issues/47855