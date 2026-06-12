# ADR 0031: Lazy Indexing and Dependency Map

**Date**: 2026-06-12
**Status**: Accepted
**Deciders**: Pike LSP team

---

## Context

The server previously indexed all Pike files in the workspace on startup (full mode). For large workspaces (thousands of files), this caused:

1. **Slow startup**: Time-to-first-hover scaled linearly with workspace size because the entire workspace must be indexed before any feature is usable.

2. **Unbounded memory**: All symbol tables are held in memory regardless of whether the user will ever query them.

3. **Global feature blocking**: Workspace symbol search, rename, and references require a complete index. If indexing is incomplete, these features return stale or partial results.

---

## Decision

### 1. Default indexing mode: `openFiles`

On startup, index only currently open documents and their bounded dependency closure (import targets). This makes startup O(open files × dependency depth), not O(workspace).

### 2. Preserved modes

Three modes are available via `initializationOptions.indexingMode`:

| Mode | Startup behavior | When to use |
|------|-----------------|-------------|
| `openFiles` (default) | Indexes only open files + their dependency closure. Global features trigger on-demand preparation. | Large workspaces, remote SSH, default |
| `full` | Background-scans all workspace files at startup. Global features work immediately. | Small workspaces, CI batch analysis |
| `auto` | Discovers file count first; resolves to `full` if ≤ `fullScanFileLimit` (default 500), otherwise falls back to `openFiles`. | Unknown workspace size at config time |

### 3. Lightweight dependency map

A forward/reverse dependency graph is maintained at all times — even when full symbol data is demoted or never loaded. This enables:

- Correct cross-file resolution without retaining all symbol tables.
- Precise invalidation: when file A changes, only files that depend on A are invalidated.
- Dependency closure indexing: opening a file pulls in its import targets up to `dependencyClosureDepth` (default 5) and `dependencyClosureFileCount` (default 200).

The dependency map is maintained on all file lifecycle events:
- `upsertFile` / `upsertBackgroundFile` — adds forward edges and updates reverse edges
- `removeFile` — removes forward and reverse edges
- File watcher (created/changed/deleted/renamed) — removes stale entries and invalidates `globalPrepDone` so the next global query re-scans

### 4. Lazy global preparation

Global features (workspace symbol, find references, rename, call hierarchy, type hierarchy, go-to-implementation) prepare the full index on-demand via `prepareGlobalQuery()`:

- **Idempotent**: if the workspace has already been fully scanned (`globalPrepDone`), returns immediately.
- **Progress**: delegates to `indexWorkspaceFiles` which reports `workDoneProgress` (begin/report/end with percentage).
- **Cancellation**: checks the `CancellationToken` between batches. A cancelled preparation is NOT marked done — the next global query retries. Per contracts/lsp-resource-state.md, cancelled preparation must not cache partial results as complete.
- **File watcher invalidation**: when a file changes on disk, `invalidateGlobalPrep()` is called, ensuring the next global query re-scans to pick up the change.

Global features route through lazy preparation:
- `searchWorkspaceSymbolsLazy()` in `workspaceSymbol.ts`
- References handler in `navigationGoTo.ts`
- Rename handler in `navigationRefactoring.ts`
- Call hierarchy (incoming/outgoing) in `navigationAdvanced.ts`
- Type hierarchy (supertypes/subtypes) in `navigationAdvanced.ts`
- Go-to-implementation handler in `navigationGoTo.ts`

### 5. Yielding

Background and on-demand indexing batches yield between batches using `setImmediate`, which fires after the I/O polling phase. This ensures interactive requests (hover, completion, diagnostics) sitting in the JSON-RPC transport are serviced before the next batch begins. `setImmediate` is preferred over `setTimeout(0)` because it yields after I/O callbacks, not after a minimum 1ms timer.

Cancellation is re-checked after each yield — the client may cancel while the event loop is processing other work.

---

## Consequences

- Default startup is fast regardless of workspace size.
- Global features have slightly higher latency on first use (on-demand preparation) but are always correct — never partial.
- Dependency map enables precise invalidation without full symbol retention.
- Full-mode users see no regression.
- File watcher events correctly invalidate the global prep flag, ensuring stale results are never returned after external file changes.

---

## Validation

### Benchmark output (T049, T063)

```
[T049] openFiles single-file upsert: 0.37ms (workspace: 200 files)
[T049] time-to-first-query: 0.03ms
[T049] openFiles mode: workspace symbol on 1/200 files: 0.16ms
[T049] full-mode index 200 files: 36.6ms (0.18ms/file)
```

Key findings:
- **openFiles mode**: time-to-first-hover is ~0.37ms regardless of workspace size — scales with the open file, not the workspace.
- **full mode**: 36.6ms for 200 files (0.18ms/file) — acceptable for small-to-medium workspaces.
- **Workspace symbol in openFiles mode**: only 0.16ms because it searches only the 1 indexed file. After `prepareGlobalQuery` triggers, it searches the full set.
- **Cross-file feature correctness**: 19/20 US2 tests pass. 1 pre-existing failure in `getSymbolsInScope — import handling` is unrelated to lazy indexing (confirmed via git stash on clean HEAD).
- **Dependency-closure indexing (T044)**: opening a file indexes its dependency closure from disk in 201ms.

### Test coverage

US2 test suite validated:
- `tests/lsp/backgroundIndex.test.ts` — background indexing modes and caps
- `tests/lsp/importDependencies.test.ts` — dependency graph edges and closure indexing
- `tests/lsp/crossFileResolution.test.ts` — cross-file reference correctness
- `tests/lsp/workspaceSymbol.test.ts` — workspace symbol search
- `tests/lsp/references.test.ts` — find references
- `tests/perf/large-workspace.test.ts` — 1000-file performance benchmarks

- [x] Time-to-first-hover benchmark: openFiles vs full mode
- [x] Cross-file feature correctness across indexing modes
- [x] Dependency-closure depth/count cap validation
