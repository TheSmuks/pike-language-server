# ADR 0030: Resource-Resilient Cache and Memory Management

**Date**: 2026-06-12
**Status**: Proposed
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

RED/GREEN evidence to be filled after US1 implementation (Phase 3):
- [ ] Bloated-cache constrained-memory startup test result
- [ ] Cache migration/self-healing test result
- [ ] Cache file-count invariant test result
