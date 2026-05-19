# ADR 0024: Pre-computed byte→UTF-16 offset map and binary search scope lookup

## Status

Accepted

## Context

Profiling (see `docs/perf/profiling-report.md`) identified `utf8ToUtf16` as the #1 bottleneck in the symbol table build pipeline. On large files, it was called ~11M times, accounting for ~160s of build time.

The root cause: tree-sitter produces UTF-8 byte column offsets, but LSP requires UTF-16 code unit offsets. Every position conversion re-scanned the line text character-by-character — O(lineLength) per call. Two hot paths drove the volume:

1. **Declaration/reference collection** — every `toRangeUtf16(node, lines)` call converted two positions (start + end).
2. **Scope lookup** (`findScopeForNode`) — for each of R references, it checked containment against all S scopes. Each check converted the reference's positions to UTF-16 — O(R × S) total conversions.

## Decision

Three optimizations applied together as Phase 1:

### Q2: Pre-compute byte→UTF-16 offset map (server/src/util/offsetMap.ts)

Build a per-line `Int32Array` at parse time where `map[byteOffset] = utf16CodeUnitOffset`. Lookup is O(1) — a single array index — instead of O(lineLength).

- `buildOffsetMap(lines: string[])` — O(totalBytes), called once in `initBuildState`.
- `lookupUtf16(map, lineIndex, byteOffset)` — O(1), replaces `utf8ToUtf16(lineText, byteOffset)`.
- For ASCII-only lines, the map is a trivial identity map. For multi-byte lines, mid-character byte offsets map to the character's UTF-16 start.

### Q1: Cache position conversions in the build pipeline

`toRangeUtf16` and `toLocUtf16` in `scope-helpers.ts` now accept an optional `OffsetMap` parameter. When provided (during `buildSymbolTable`), conversions use O(1) array lookup. When omitted (feature handlers like signature help, document links), they fall back to the original `utf8ToUtf16` scan.

All build-pipeline callers (`declarationCollector.ts`, `declarationBlockCollectors.ts`, `referenceCollector.ts`) were updated to pass `state.offsetMap`.

### M4: Binary search scope lookup

Scopes are sorted by `(startLine, startChar)` after the declaration pass. `findScopeForNode` uses binary search to find candidate scopes in O(log S) instead of O(S). It walks backward from the rightmost candidate to find the innermost containing scope.

- `sortScopesByStart(scopes)` in `symbolTable.ts` — stable sort, called once after the declaration pass.
- `findScopeForNode` complexity drops from O(R × S) to O(R × log S).

## Consequences

### Positive

- Position conversion drops from O(lineLength) to O(1) per call. With ~11M calls on large files, this eliminates ~160s of work.
- Scope lookup drops from O(R × S) to O(R × log S). For files with many scopes and references, this is a significant improvement.
- No behavioral changes — all existing tests pass without modification.
- Feature handlers (signature help, document links, etc.) continue using the original `utf8ToUtf16` — they are not on the hot path and need no changes.
- Memory overhead is negligible: one `Int32Array` per line, total size proportional to file size.

### Negative

- `BuildState` interface gains two new fields (`offsetMap`, `sortedScopes`). These are internal-only and not exposed to feature handlers.
- Every new build-pipeline caller that uses `toRangeUtf16` must remember to pass `state.offsetMap`. Missing the third arg silently falls back to the slow path with no error — a correctness/performance pitfall. Mitigated by the pattern being consistent across all existing callers.

### Risks

- The offset map assumes tree-sitter column offsets are UTF-8 byte offsets. If a future tree-sitter version changes this convention, `lookupUtf16` would produce wrong results. This assumption is documented and verified by the existing snapshot tests.
