# Implementation Plan: Resource-Resilient Language Server

**Branch**: `001-resource-resilience` | **Date**: 2026-06-12 | **Spec**: `specs/001-resource-resilience/spec.md`

**Input**: Feature specification from `specs/001-resource-resilience/spec.md`

## Summary

Resource-proof the Pike Language Server so startup, indexing, worker lifecycle, memory pressure, and abandoned remote sessions are bounded and observable. The implementation extends the existing TypeScript/Bun LSP, `WorkspaceIndex`, persistent cache, background indexer, and Pike worker instead of replacing them. Delivery is phased: first fix crash/teardown/cache safety, then change the default to lazy open-file indexing, then add memory demotion, worker heartbeat watchdog, hibernation, and operator diagnostics.

## Technical Context

**Language/Version**: TypeScript 6.0.3, Node.js 22+, Bun test/build; Pike worker code in `harness/worker.pike`.

**Primary Dependencies**: `vscode-languageserver`, `vscode-languageclient`, `vscode-jsonrpc`, `vscode-languageserver-textdocument`, `web-tree-sitter`, Node `child_process`/`fs` APIs, existing Pike harness and `pike-fmt` dependency.

**Storage**: Workspace-local `.pike-lsp/` cache with `cacheIndex.json` and per-entry JSON files under `.pike-lsp/cache/`; new cache entries carry source metadata and dependency-map/stub data.

**Testing**: `bun test tests/ harness/`, targeted `bun test tests/lsp/ tests/perf/`, Pike tests via `bash scripts/test-pike.sh`, typecheck via `bun run typecheck`, build via `bun run build`.

**Target Platform**: VS Code workspace extension running the LSP on local or VS Code Remote/SSH Linux hosts, with Node subprocess management for a Pike worker.

**Project Type**: VS Code extension plus language server and Pike subprocess harness.

**Performance Goals**: Open-files mode time-to-first-hover and time-to-first-semantic-tokens scale with open files plus bounded dependency closure, not total workspace size. Background and on-demand indexing yield between bounded units so hover/completion/diagnostics remain responsive. Heap after demotion/hibernation scales with open dependency closure or hibernated stubs, not workspace file count.

**Constraints**: Hard default gates from the spec: Pike worker watchdog window 30 s, shutdown deadline about 1.5 s even with slow state save, idle worker eviction 300 s, idle hibernation 15 min with 0 disabling, cache file count equals live entry count after save, and all caps configurable. Functions should stay small and explicit per AGENTS.md.

**Scale/Scope**: Large Pike workspaces with thousands of files and historical cache directories around 20,000 entries; default dependency closure depth 5, file count 200, full-scan auto cap 500 files, max source file size 1 MB, and synthetic benchmark fixtures around 2,000 files.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

The repository constitution file is still the unfilled Spec Kit template, so there are no ratified constitution principles to enforce. The project-level `AGENTS.md` gates are enforceable for this repository and are applied here:

- Safety: resource loops, queues, caches, subprocesses, and timers must have explicit bounds.
- Error handling: timeout, OOM pressure, corrupt cache, and worker liveness failures must be distinguishable from success and must not be silently suppressed.
- Testing: bug fixes require regression tests; expected Pike behavior comes from Pike/oracle paths where applicable.
- Observability: every degradation, demotion, restart, hibernation, and recovery path must log an explicit signal.
- Source control: feature work is delivered in phase PRs, not direct pushes to `main`.

Gate status: PASS. No unjustified complexity or unresolved clarifications remain.

## Project Structure

### Documentation (this feature)

```text
specs/001-resource-resilience/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── cache-format.md
│   ├── configuration.md
│   ├── lsp-resource-state.md
│   └── pike-worker-liveness.md
└── tasks.md              # Created later by /speckit-tasks
```

### Source Code (repository root)

```text
client/
├── extension.ts                         # VS Code activation, settings, status-bar wiring
└── errorNotificationState.ts            # Existing client-side state pattern for server notifications

extension.package.json / package.json    # VS Code contributed configuration defaults

harness/
├── worker.pike                          # Pike worker protocol and worker-side watchdog
└── Common.pike                          # Shared Pike test/runtime helpers

server/src/
├── server.ts                            # LSP registration composition
├── serverInitHandler.ts                 # Initialization options and index setup
├── serverDocumentHandler.ts             # didOpen/didChange/didClose activity and open-file indexing
├── serverFileWatchHandler.ts            # File watcher invalidation and dependency-map maintenance
├── serverShutdownHandler.ts             # Deadline-bounded shutdown and worker termination
├── serverContext.ts                     # Resource-state/context ownership
├── util/errorLog.ts                     # Structured operational log lines
└── features/
    ├── backgroundIndex.ts               # Full/auto scan discovery, caps, yielding, progress
    ├── persistentCache.ts               # Cache metadata migration, pruning, bounded load/save
    ├── workspaceIndexClass.ts           # Entry lifecycle, dependency map, demotion stubs
    ├── workspaceTypes.ts                # Indexing mode, entry lifecycle, dependency-map types
    ├── workspaceResolution.ts           # Cross-file/global query correctness under lazy indexing
    ├── workspaceSymbol.ts               # Global request progress/cancellation/degraded errors
    ├── rename.ts / callHierarchy.ts / typeHierarchy.ts / implementation.ts
    ├── pikeWorker.ts                    # Request timeout, health checks, restart/backoff
    ├── pikeWorkerProcess.ts             # Process lifecycle, heartbeat sends, force-kill
    ├── pikeWorkerTypes.ts               # Config defaults and liveness contract types
    └── profiler.ts                      # Counters for file reads, heap, cache and benchmark evidence

tests/
├── lsp/                                 # Regression and protocol tests
├── perf/                                # Synthetic large-workspace and heap/latency benchmarks
└── pike/                                # Pike worker watchdog/protocol tests

docs/
├── decisions/                           # ADRs for indexing, memory, worker liveness, hibernation
└── lingering-remote-sessions.md         # Operator diagnostics/remediation guide
```

**Structure Decision**: Keep the existing single TypeScript server/VS Code extension layout. Add small focused modules only when needed to preserve the 50-line function and 500-line file guidance; do not introduce a new service boundary.

## Phase 0: Research Summary

See `specs/001-resource-resilience/research.md`.

## Phase 1: Design Summary

See:

- `specs/001-resource-resilience/data-model.md`
- `specs/001-resource-resilience/contracts/cache-format.md`
- `specs/001-resource-resilience/contracts/configuration.md`
- `specs/001-resource-resilience/contracts/lsp-resource-state.md`
- `specs/001-resource-resilience/contracts/pike-worker-liveness.md`
- `specs/001-resource-resilience/quickstart.md`

## Constitution Check (Post-Design)

Gate status: PASS.

- All resource-bearing structures have named bounds or an explicit task to add one.
- Degraded/global-feature behavior is explicit: unavailable under memory pressure is an error signal, never empty success.
- The cache design preserves truth during migration: valid old entries are upgraded from source-file metadata; corrupt/superseded entries are dropped and pruned.
- Worker liveness has paired enforcement: server-side timeout/kill plus worker-side heartbeat watchdog.
- Hibernation never exits the LSP process, preserving VS Code Remote behavior while dropping retained state.
- Validation is end-to-end and includes RED/GREEN regression evidence, bounded shutdown, no orphan Pike process, and cache-count invariants.

## Complexity Tracking

No constitution violations require justification.
