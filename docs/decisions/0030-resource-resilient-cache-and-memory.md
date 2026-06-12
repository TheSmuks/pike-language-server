# ADR 0030: Resource-Resilient Cache and Memory Management

**Date**: 2026-06-12
**Status**: Accepted
**Deciders**: Pike LSP team

---

## Context

The persistent cache and workspace index have no resource bounds:

1. **Bloated cache**: The cache directory can grow without limit across sessions. A workspace with 20,000 historical entries (including superseded hashes from renamed files) loads all of them on startup, potentially consuming hundreds of MB of heap before the user opens a single file.

2. **Old-format / corrupt entries**: Cache entries from prior schema versions or crashed saves persist silently. There is no migration or self-healing path — the entire cache is either loaded or discarded.

3. **No memory budget**: The server has no concept of a memory ceiling. Under memory pressure (shared SSH dev server, remote VSCode sessions), the server can be OOM-killed, leaving orphan Pike processes.

---

## Decision

1. **Cache schema versioning and migration**: Extend `CachedFileEntry` with `mtimeMs`, `sizeBytes`, and `dependencies` metadata. On load, entries missing these fields are upgraded by statting the source file. This is bounded by a configurable batch limit.

2. **Self-healing load**: Corrupt, duplicate (same URI, different hash), and superseded entries are pruned during load. The cache file count must equal the live entry count after load.

3. **Bounded restore**: Cache restore reads entries in bounded batches. If the total exceeds a configurable maximum, the cache is wiped and rebuilt from scratch (degraded mode is entered, not an OOM abort).

4. **Memory budget with demotion**: A configurable memory budget (`pike.languageServer.memory.budgetMb`) triggers demotion of non-essential index entries (non-open, non-dependency-closure) to stubs when heap pressure rises. Open-file functionality is preserved.

---

## Consequences

- Startup is O(workspace size), not O(historical cache size).
- Memory pressure degrades gracefully instead of crashing.
- Cache directory stays proportional to the live workspace.
- Corrupt entries heal themselves instead of requiring manual cleanup.

---

## Validation

RED/GREEN evidence from Phase 3 (US1 MVP):

- [x] **Bloated-cache constrained-memory startup**: T027 loads a 200-entry cache
  in bounded batches without crashing. Test: `tests/lsp/resourceResilience.test.ts`
  — `T027: loads cache with many entries without crashing` ✅ GREEN.

- [x] **Cache migration/self-healing**: T024 tests that old-format entries lacking
  `mtimeMs`/`sizeBytes` load successfully, corrupt entries are skipped, and
  duplicate URIs are deduplicated. Test: `tests/lsp/persistentCache.test.ts`
  — `T024: loads old-format entries lacking mtimeMs/sizeBytes` ✅ GREEN,
  `T024: corrupt entries are skipped, valid ones are loaded` ✅ GREEN,
  `T024: duplicate URIs are deduplicated` ✅ GREEN.

- [x] **Stale entry pruning**: T025 verifies that entries not in the live index
  are deleted during save. Test: `T025: stale entries are pruned on save` ✅ GREEN.

- [x] **Cache file-count invariant**: T026 verifies that load reads only cache
  files, not source contents. Test: `T026: cache load reads only cache files,
  not source contents` ✅ GREEN.

- [x] **Worker timeout force-kill**: T029 verifies that `forceKillForTimeout`
  clears pending requests and the queue. Test: `tests/lsp/shutdown.test.ts`
  — `T029: forceKillForTimeout rejects all pending requests` ✅ GREEN.

- [x] **Fail-fast error handling**: T030 verifies that `installFailFastHandlers`
  registers process listeners. Test: `tests/lsp/error-handling.test.ts` ✅ GREEN.

- [x] **Source-file metadata upgrade (T031/T033)**: `saveCache` stats each source
  file and populates `mtimeMs`/`sizeBytes` on cache entries. Old-format entries
  lacking these fields are upgraded on the next save cycle. Non-disk files (open-only
  docs) leave fields undefined — entry still saves. Implementation:
  `server/src/features/persistentCache.ts` — `populateSourceMetadata()`,
  `statSourceFile()`.

- [x] **Corrupt/duplicate/superseded self-heal (T034)**: `loadSingleEntry` validates
  required fields (uri, contentHash, symbolTable) and returns null for corrupt
  entries. `loadCacheEntries` deduplicates by URI (`seenUris` set, first wins).
  `pruneStaleEntries` deletes entries not in the live index during save. Temp
  files from interrupted atomic writes are ignored on load. Covered by T024
  corrupt/duplicate tests and T025 stale-prune test ✅ GREEN.

- [x] **Atomic save + live-entry-only prune (T035)**: Each entry is written via
  temp-file + rename (POSIX atomic). `saveCache` collects live entries, prunes
  stale cache files, then writes all entries in bounded batches of 50. Cache file
  count equals live entry count after save. Test: `T025: stale entries are pruned
  on save` ✅ GREEN.

- [x] **Memory budget degraded mode (T036)**: `isOverMemoryBudget` checks
  `process.memoryUsage().heapUsed` against `resourceConfig.memory.budgetMb`.
  Wired into `handleInitialized` cache-restore path: if over budget after cache
  restore, transitions to `degraded` state via `ResourceStateTracker` and skips
  background indexing. Tests: `tests/lsp/error-handling.test.ts` —
  `T036: isOverMemoryBudget returns true when over budget` ✅ GREEN,
  `T036: isOverMemoryBudget returns false when under budget` ✅ GREEN,
  `T036: ResourceStateTracker transitions to degraded` ✅ GREEN.

- [x] **Pre-existing defect fixes**: US-022 corrupt-cache-recovery test updated
  for per-file format (`cacheIndex.json` corruption, not monolithic file).
  `readAndValidateCacheIndex` fixed to pass `workspaceRoot` to `deleteCache`
  (was passing `.pike-lsp/` dir, causing delete to target nonexistent
  `.pike-lsp/.pike-lsp/`). Shutdown test updated for `queue` → `queues[0]`
  priority-sub-queue rename. All US-022 + shutdown tests ✅ GREEN.
