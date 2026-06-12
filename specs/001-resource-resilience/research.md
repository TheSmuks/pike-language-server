# Phase 0 Research: Resource-Resilient Language Server

## Decision: Reuse the existing server architecture and extend bounded lifecycle modules

**Rationale**: The repo already has the required seams: `WorkspaceIndex` owns file entries/dependents, `persistentCache.ts` owns cache IO, `backgroundIndex.ts` owns workspace discovery/scanning, `PikeWorker`/`PikeWorkerProcess` own subprocess lifecycle, and shutdown/init handlers centralize server lifecycle. Extending those modules keeps the change reviewable and avoids introducing a competing indexer or worker supervisor.

**Alternatives considered**:
- Replace the indexer with a new service: rejected because it risks feature regressions across definition, rename, references, hierarchies, diagnostics, and semantic tokens.
- External process supervisor for Pike: rejected because VS Code Remote sessions need in-process lifecycle decisions and tests can exercise child process contracts directly.

## Decision: Default indexing mode becomes open-files-only, with full and auto remaining supported

**Rationale**: The spec requires startup cost to scale with open files and their dependency closure, not workspace size. Existing background indexing can remain available behind `full` and `auto`, while default startup should not eagerly walk the entire workspace.

**Alternatives considered**:
- Keep full background scan as default with more yielding: rejected because discovery still scales with workspace size and violates FR-008.
- Disable global features in open-files mode: rejected because FR-010 requires correctness in all modes.

## Decision: Maintain a lightweight dependency map separate from full symbol-table retention

**Rationale**: The current index stores `dependencies` on each `FileEntry` and can reconstruct reverse deps. The new feature needs that graph to survive demotion and hibernation, while symbol tables and references can be dropped or rebuilt. A small dependency map gives correct invalidation and candidate discovery without retaining per-occurrence data for the whole workspace.

**Alternatives considered**:
- Retain every symbol table to answer global features quickly: rejected because it is the current unbounded-memory failure mode.
- Re-scan the workspace for every global request: rejected because it causes repeated stalls and unbounded IO.

## Decision: First global request may block with progress/cancellation to build needed maps, then must return complete results

**Rationale**: Clarification requires complete results, never partial or empty. Blocking the specific request with `workDoneProgress` and cancellation makes the one-time cost honest and keeps unrelated interactive requests schedulable.

**Alternatives considered**:
- Return partial results with a warning: rejected by FR-010 and FR-022.
- Always prebuild declarations at startup: rejected by lazy-start requirements.

## Decision: Degraded mode suspends new on-demand indexing and returns explicit unavailable errors for global features

**Rationale**: Under memory pressure, correctness is more important than producing plausible partial data. Open files and already-indexed dependency closure remain fully functional; global expansion reports temporary unavailability.

**Alternatives considered**:
- Continue indexing until the process OOMs: rejected by FR-001/FR-004.
- Return empty lists for workspace symbol/references: rejected as a lying success.

## Decision: Upgrade cache format with source metadata and prune by live entry set after save

**Rationale**: Current cache entries are content-hash keyed and the loader reads each JSON entry. The new cache needs mtime/size metadata so unchanged-file validation does not read file contents, and save must remove superseded entries so file count equals live entry count.

**Alternatives considered**:
- Wipe old caches on upgrade: rejected because clarification requires preserving valid warm cache entries.
- Keep old hash-only validation: rejected because it requires content reads and does not satisfy FR-003/FR-024.

## Decision: Bound cache loading with streaming/batched IO and overflow self-healing

**Rationale**: Loading ~20,000 entries in one `Promise.all` and deserializing all full symbol tables can spike memory. Cache restore should process bounded batches, drop corrupt/superseded entries, and wipe/rebuild if entry count vastly exceeds expected live count.

**Alternatives considered**:
- Raise Node heap size: rejected because it masks unbounded behavior on shared hosts.
- Load all entries and demote afterward: rejected because the OOM happens during load.

## Decision: Server-side timeout kills the Pike process, not just the request

**Rationale**: The current request timeout path rejects/returns timedOut but leaves the subprocess alive. A timed-out compile can wedge the only FIFO worker. Timeout must force-kill/restart the worker so the next request uses a fresh process.

**Alternatives considered**:
- Keep the process and reject only the request: rejected by FR-005.
- Add parallel Pike workers: rejected as unnecessary complexity before fixing single-worker liveness.

## Decision: Add outbound heartbeats plus Pike-side watchdog thread

**Rationale**: End-of-input checks only run between worker requests. If the server dies while Pike is mid-compile, the worker needs an independent watchdog thread that terminates when heartbeats stop for the configured window.

**Alternatives considered**:
- Rely on parent PID checks from Pike: less portable and can be fooled by extension-host/session parent lifetimes.
- Rely only on Node shutdown handlers: rejected because hard kills and remote disconnects bypass orderly shutdown.

## Decision: Hibernation sheds state but never exits the server process

**Rationale**: VS Code Remote treats voluntary LSP exit as a crash and may restart it in the abandoned extension host. Hibernation must cancel background work, save within a deadline, clear index/caches, stop Pike, and wait for future requests without exiting.

**Alternatives considered**:
- Self-exit after idle: rejected by clarification and FR-018.
- Keep Pike warm while hibernated: rejected because no Pike process may remain after hibernation.

## Decision: Surface persistent resource states through a non-modal status-bar contract

**Rationale**: The existing client already tracks server notification state for error counts. Resource-state notifications can use the same client pattern to show degraded/indexing/hibernating/waking without modal popups.

**Alternatives considered**:
- Log-only state: rejected by FR-023.
- Modal warnings for state changes: rejected as noisy routine behavior.
