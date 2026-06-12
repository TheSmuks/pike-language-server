# Tasks: Resource-Resilient Language Server

**Input**: Design documents from `specs/001-resource-resilience/`

**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/`, `quickstart.md`

**Tests**: Required. The specification marks user scenarios/testing as mandatory, the project requires regression tests for bug fixes, and Pike LSP work follows RED-GREEN TDD. For each story, write and run the listed tests first, capture the RED failure, then implement until GREEN.

**Organization**: Tasks are grouped by user story so each story can be implemented, tested, and reviewed as an independently valuable increment.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel because it touches different files and has no dependency on an incomplete task in the same phase.
- **[Story]**: User-story label for story phases only.
- Every task includes an exact repository-relative file path.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Establish resource-resilience scaffolding, fixtures, and ADR placeholders used by all stories.

- [X] T001 Verify and append missing Node/TypeScript ignore patterns in `.gitignore`
- [X] T002 [P] Create synthetic Pike workspace fixture generator in `tests/perf/syntheticWorkspace.ts`
- [X] T003 [P] Create shared resource-resilience LSP test helpers in `tests/lsp/resourceResilienceHelpers.ts`
- [X] T004 [P] Create Pike worker process test helpers in `tests/lsp/pikeWorkerProcessHelpers.ts`
- [X] T005 [P] Create cache fixture helpers for corrupt, duplicate, old-format, and superseded entries in `tests/lsp/persistentCacheFixtures.ts`
- [X] T006 [P] Add resource-resilience profiler counters for file reads, cache entry loads, demotions, hibernations, and worker restarts in `server/src/features/profiler.ts`
- [X] T007 [P] Add ADR stub for cache and memory resilience in `docs/decisions/0030-resource-resilient-cache-and-memory.md`
- [X] T008 [P] Add ADR stub for lazy indexing and dependency-map semantics in `docs/decisions/0031-lazy-indexing-and-dependency-map.md`
- [X] T009 [P] Add ADR stub for Pike worker heartbeat/watchdog lifecycle in `docs/decisions/0032-pike-worker-liveness.md`
- [X] T010 [P] Add ADR stub for idle hibernation without server self-exit in `docs/decisions/0033-idle-hibernation.md`

**Checkpoint**: Shared fixtures and documentation targets exist; RED tests can now be added story-by-story.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Add shared resource state/configuration primitives that all user stories depend on.

**CRITICAL**: No user-story implementation should begin until this phase is complete.

### Tests First

- [X] T011 [P] Add RED configuration validation tests for indexing, memory, worker, and hibernation settings in `tests/lsp/configuration.test.ts`
- [X] T012 [P] Add RED resource-state notification tests for non-modal `pike/resourceState` payloads in `tests/lsp/resourceState.test.ts`
- [X] T013 [P] Add RED lifecycle context tests for request activity, watched-file activity, cancellation, and degraded-state transitions in `tests/lsp/lifecycle.test.ts`

### Implementation

- [X] T014 Define `ResourceState`, `IndexingMode`, `MemoryBudget`, and `HibernationState` types in `server/src/features/resourceTypes.ts`
- [X] T015 Implement configuration defaults and validation helpers in `server/src/features/resourceConfiguration.ts`
- [X] T016 Wire resource configuration from initialization options and workspace settings in `server/src/serverInitHandler.ts`
- [X] T017 Add `pike.languageServer.*` resource configuration contributions in `extension.package.json`
- [X] T018 Implement resource-state ownership, activity tracking, and cancellation registration in `server/src/serverContext.ts`
- [X] T019 Implement `pike/resourceState` server notification sender in `server/src/features/resourceState.ts`
- [X] T020 Register resource-state notification handling and non-modal status bar updates in `client/extension.ts`
- [X] T021 Reuse the existing listener pattern for resource-state disposal in `client/errorNotificationState.ts`
- [X] T022 Export shared resource helpers from `server/src/features/workspaceIndex.ts`
- [X] T023 Run foundational validation with `bun test tests/lsp/configuration.test.ts tests/lsp/resourceState.test.ts tests/lsp/lifecycle.test.ts`

**Checkpoint**: Resource state and configuration plumbing is test-covered and ready for story implementation.

---

## Phase 3: User Story 1 - Server survives startup and shuts down cleanly (Priority: P1) MVP

**Goal**: The server starts against huge/corrupt caches without OOM aborts, degrades honestly when memory is tight, kills/restarts timed-out Pike workers, and shuts down within a deadline without orphan Pike processes.

**Independent Test**: Open a workspace backed by a bloated cache directory (~20,000 entries including superseded hashes) under a constrained memory budget. Assert the server starts, serves open files, logs degraded startup if needed, kills timed-out workers, and leaves no Pike process after shutdown.

### Tests for User Story 1

- [X] T024 [P] [US1] Add RED cache migration/self-healing tests for old-format, corrupt, duplicate, and superseded entries in `tests/lsp/persistentCache.test.ts`
- [X] T025 [P] [US1] Add RED cache file-count invariant and prune tests in `tests/lsp/persistentCache.test.ts`
- [X] T026 [P] [US1] Add RED metadata-staleness test proving unchanged cache load reads zero file contents in `tests/lsp/persistentCache.test.ts`
- [X] T027 [P] [US1] Add RED bloated-cache constrained-memory startup test in `tests/lsp/resourceResilience.test.ts`
- [X] T028 [P] [US1] Add RED Pike request-timeout process replacement test in `tests/lsp/pikeWorker.test.ts`
- [X] T029 [P] [US1] Add RED shutdown deadline/no-orphan-worker test with slow cache save in `tests/lsp/shutdown.test.ts`
- [X] T030 [P] [US1] Add RED unrecoverable internal error fail-fast test in `tests/lsp/error-handling.test.ts`

### Implementation for User Story 1

- [X] T031 [US1] Extend `PersistentCacheEntry` with `mtimeMs`, `sizeBytes`, `dependencies`, and schema version handling in `server/src/features/persistentCache.ts`
- [X] T032 [US1] Implement bounded-batch cache restore and overflow wipe path in `server/src/features/persistentCache.ts`
- [X] T033 [US1] Implement old-format cache metadata upgrade by statting source files in `server/src/features/persistentCache.ts`
- [X] T034 [US1] Implement corrupt/duplicate/superseded cache self-healing and prune scheduling in `server/src/features/persistentCache.ts`
- [X] T035 [US1] Implement atomic cache save and live-entry-only prune so cache file count equals live entry count in `server/src/features/persistentCache.ts`
- [X] T036 [US1] Add memory-budget checks during startup/cache restore and enter degraded mode without aborting in `server/src/serverInitHandler.ts`
- [X] T037 [US1] Make Pike request timeout force-kill the underlying process, reject pending work truthfully, and restart on the next request in `server/src/features/pikeWorker.ts`
- [X] T038 [US1] Add force-kill/terminate deadline helpers for child processes in `server/src/features/pikeWorkerProcess.ts`
- [X] T039 [US1] Deadline-bound shutdown cache save and always terminate Pike before returning shutdown in `server/src/serverShutdownHandler.ts`
- [X] T040 [US1] Install fail-fast logging for unrecoverable server errors in `server/src/serverLifecycle.ts`
- [X] T041 [US1] Update cache/memory ADR decisions with measured RED/GREEN evidence in `docs/decisions/0030-resource-resilient-cache-and-memory.md`
- [X] T042 [US1] Validate MVP with `bun test tests/lsp/persistentCache.test.ts tests/lsp/resourceResilience.test.ts tests/lsp/pikeWorker.test.ts tests/lsp/shutdown.test.ts tests/lsp/error-handling.test.ts`

**Checkpoint**: MVP is independently shippable: crash and teardown hardening are GREEN.

---

## Phase 4: User Story 2 - Fast, lazy startup and always-responsive operation (Priority: P2)

**Goal**: Default startup indexes only open files and bounded dependency closure, full/auto modes remain supported, background/on-demand work yields, and global features stay correct with progress/cancellation.

**Independent Test**: Measure time-to-first-hover and time-to-first-semantic-tokens across growing synthetic workspaces in open-files mode and full mode. Assert open-files mode scales with dependency closure, and cross-file feature suites pass in both modes.

### Tests for User Story 2

- [X] T043 [P] [US2] Add RED default `openFiles` indexing-mode startup test in `tests/lsp/backgroundIndex.test.ts`
- [X] T044 [P] [US2] Add RED dependency-closure depth/count cap tests in `tests/lsp/importDependencies.test.ts`
- [X] T045 [P] [US2] Add RED full/auto/openFiles mode behavior tests in `tests/lsp/configuration.test.ts`
- [X] T046 [P] [US2] Add RED cross-file feature parameterized tests over indexing modes in `tests/lsp/crossFileResolution.test.ts`
- [X] T047 [P] [US2] Add RED workspace symbol progress/cancellation test in `tests/lsp/workspaceSymbol.test.ts`
- [X] T048 [P] [US2] Add RED rename/references/hierarchy/implementation lazy-candidate tests in `tests/lsp/references.test.ts`
- [X] T049 [P] [US2] Add RED large-workspace time-to-first-hover/semantic-tokens benchmark in `tests/perf/large-workspace.test.ts`

### Implementation for User Story 2

- [X] T050 [US2] Add indexing-mode config parsing and default `openFiles` selection in `server/src/features/resourceConfiguration.ts`
- [X] T051 [US2] Gate startup background indexing by `openFiles`, `full`, and `auto` modes in `server/src/serverInitHandler.ts`
- [X] T052 [US2] Implement ignore-glob, max-file-size, and full-scan file-count cap handling in `server/src/features/backgroundIndex.ts`
- [X] T053 [US2] Implement open-document dependency-closure indexing with depth/count caps in `server/src/serverDocumentHandler.ts`
- [X] T054 [US2] Maintain lightweight forward/reverse dependency map on upsert, delete, and file-watch events in `server/src/features/workspaceIndexClass.ts`
- [X] T055 [US2] Add dependency-map lifecycle fields to `FileEntry` and workspace types in `server/src/features/workspaceTypes.ts`
- [X] T056 [US2] Update file watcher invalidation to keep the dependency map current without full symbol retention in `server/src/serverFileWatchHandler.ts`
- [X] T057 [US2] Implement global query preparation with workDoneProgress and cancellation in `server/src/features/workspaceResolution.ts`
- [X] T058 [US2] Route workspace symbol through lazy global preparation and complete-result semantics in `server/src/features/workspaceSymbol.ts`
- [X] T059 [US2] Route references and rename through lazy global preparation and complete-result semantics in `server/src/features/rename.ts`
- [X] T060 [US2] Route call hierarchy, type hierarchy, and go-to-implementation through lazy global preparation in `server/src/features/callHierarchy.ts`
- [X] T061 [US2] Add yielding between background scan batches and on-demand candidate batches in `server/src/features/backgroundIndex.ts`
- [X] T062 [US2] Update lazy-indexing ADR with mode semantics and benchmark output in `docs/decisions/0031-lazy-indexing-and-dependency-map.md`
- [X] T063 [US2] Validate lazy indexing with `bun test tests/lsp/backgroundIndex.test.ts tests/lsp/importDependencies.test.ts tests/lsp/crossFileResolution.test.ts tests/lsp/workspaceSymbol.test.ts tests/lsp/references.test.ts tests/perf/large-workspace.test.ts`

**Checkpoint**: Lazy startup and global-feature correctness are independently testable and GREEN.

---

## Phase 5: User Story 3 - Bounded footprint and a self-terminating Pike worker (Priority: P2)

**Goal**: Heap pressure demotes non-essential index entries while preserving open-file functionality, degraded mode returns honest unavailable errors for global expansion, and the Pike worker terminates itself when server heartbeats stop.

**Independent Test**: Hold five files open on a large workspace, trigger pressure, assert non-closure entries demote and open-file features still work. Hard-kill the server while Pike is mid-long-compile and assert no Pike process survives the watchdog window.

### Tests for User Story 3

- [X] T064 [P] [US3] Add RED index-entry demotion and rehydration tests in `tests/lsp/workspaceIndex.test.ts`
- [X] T065 [P] [US3] Add RED degraded-mode global-feature unavailable tests in `tests/lsp/resourceResilience.test.ts`
- [X] T066 [P] [US3] Add RED memory-pressure demotion benchmark with five open files in `tests/perf/large-workspace.test.ts`
- [X] T067 [P] [US3] Add RED server-side worker heartbeat and idle-eviction tests in `tests/lsp/pikeWorker.test.ts`
- [X] T068 [P] [US3] Add RED Pike worker self-termination watchdog test in `tests/lsp/pikeWorker.test.ts`
- [X] T069 [P] [US3] Add RED worker health-check failure restart/backoff test in `tests/lsp/pikeWorker.test.ts`

### Implementation for User Story 3

- [X] T070 [US3] Add `full`, `stub`, `demoted`, and `loading` entry lifecycle support in `server/src/features/workspaceTypes.ts`
- [X] T071 [US3] Implement demotion of non-open, non-closure entries while preserving dependency map in `server/src/features/workspaceIndexClass.ts`
- [X] T072 [US3] Implement rehydration of demoted entries from cache or source in `server/src/features/workspaceIndexClass.ts`
- [X] T073 [US3] Implement heap-pressure monitor with hysteresis and demotion logging in `server/src/features/resourceState.ts`
- [X] T074 [US3] Make global features return explicit temporarily-unavailable errors while degraded in `server/src/features/workspaceResolution.ts`
- [X] T075 [US3] Add outbound heartbeat scheduling, stop rules, idle eviction, and failed-health-check restart logic in `server/src/features/pikeWorker.ts`
- [X] T076 [US3] Add heartbeat send/stop primitives and process status tracking in `server/src/features/pikeWorkerProcess.ts`
- [X] T077 [US3] Implement worker-side heartbeat watchdog thread and timeout exit in `harness/worker.pike`
- [X] T078 [US3] Document the worker heartbeat protocol in `docs/decisions/0032-pike-worker-liveness.md`
- [X] T079 [US3] Validate bounded memory and worker liveness with `bun test tests/lsp/workspaceIndex.test.ts tests/lsp/resourceResilience.test.ts tests/lsp/pikeWorker.test.ts tests/perf/large-workspace.test.ts`

**Checkpoint**: Memory pressure and worker liveness are GREEN, with no orphan Pike process after watchdog expiry.

---

## Phase 6: User Story 4 - Idle remote sessions hibernate instead of lingering (Priority: P3)

**Goal**: Idle sessions hibernate by shedding retained state and stopping Pike without exiting; first later request wakes through lazy on-demand paths and full/auto re-indexing resumes only after sustained activity.

**Independent Test**: Advance a fake clock past the hibernation threshold with no open documents and no requests. Assert heap drops, no Pike process is alive, then issue hover/definition/semantic-token requests and assert results match pre-hibernation answers.

### Tests for User Story 4

- [X] T080 [P] [US4] Add RED fake-clock idle hibernation transition tests in `tests/lsp/hibernation.test.ts`
- [X] T081 [P] [US4] Add RED hibernation cancellation and deadline-save tests in `tests/lsp/hibernation.test.ts`
- [X] T082 [P] [US4] Add RED post-hibernation lazy wake correctness tests in `tests/lsp/hibernation.test.ts`
- [X] T083 [P] [US4] Add RED watched-file-events-do-not-reset-idle tests in `tests/lsp/hibernation.test.ts`
- [X] T084 [P] [US4] Add RED sustained-activity-delayed full/auto reindex tests in `tests/lsp/hibernation.test.ts`

### Implementation for User Story 4

- [X] T085 [US4] Implement hibernation state machine and idle timer in `server/src/features/hibernation.ts`
- [X] T086 [US4] Update request/open-document activity tracking to drive hibernation in `server/src/serverContext.ts`
- [X] T087 [US4] Ensure watched-file events do not reset idle when no documents are open in `server/src/serverFileWatchHandler.ts`
- [X] T088 [US4] Cancel background indexing and on-demand work during hibernation in `server/src/features/backgroundIndex.ts`
- [X] T089 [US4] Add deadline-bound hibernation save and clear in-memory cache/index state in `server/src/features/persistentCache.ts`
- [X] T090 [US4] Stop Pike worker and heartbeat during hibernation without exiting the LSP process in `server/src/features/pikeWorker.ts`
- [X] T091 [US4] Implement lazy wake/rehydration gate before requests in `server/src/serverLifecycle.ts`
- [X] T092 [US4] Schedule delayed full/auto reindex only after sustained activity in `server/src/serverInitHandler.ts`
- [X] T093 [US4] Update hibernation ADR with no-self-exit rationale and validation output in `docs/decisions/0033-idle-hibernation.md`
- [X] T094 [US4] Validate hibernation with `bun test tests/lsp/hibernation.test.ts tests/lsp/pikeWorker.test.ts tests/lsp/backgroundIndex.test.ts`

**Checkpoint**: Idle remote sessions shed footprint, keep the LSP process alive, and wake lazily with correct answers.

---

## Phase 7: User Story 5 - Operable and diagnosable (Priority: P3)

**Goal**: Resource behavior is visible through status-bar state and logs, and operators have a practical guide to identify and clean up lingering remote sessions.

**Independent Test**: Trigger degraded startup, memory demotion, worker restart, hibernation enter/exit, and wake. Assert clear log lines and status-bar state; run the troubleshooting guide one-liners against test processes.

### Tests for User Story 5

- [X] T095 [P] [US5] Add RED log-signal tests for degraded, demotion, worker restart, and hibernation events in `tests/lsp/errorLog.test.ts`
- [X] T096 [P] [US5] Add RED client status-bar resource-state tests in `tests/lsp/resourceState.test.ts`
- [X] T097 [P] [US5] Add RED documentation command smoke checks for lingering-session diagnostics in `tests/lsp/resourceDocs.test.ts`

### Implementation for User Story 5

- [X] T098 [US5] Add standardized resource log messages with heap/count/reason details in `server/src/util/errorLog.ts`
- [X] T099 [US5] Emit resource-state notifications for degraded, indexing, hibernating, hibernated, and waking transitions in `server/src/features/resourceState.ts`
- [X] T100 [US5] Render client status-bar resource states and per-request unavailability messages in `client/extension.ts`
- [X] T101 [US5] Write lingering remote session troubleshooting guide in `docs/lingering-remote-sessions.md`
- [X] T102 [US5] Update `CHANGELOG.md` `[Unreleased]` with resource-resilience behavior changes
- [X] T103 [US5] Validate operability with `bun test tests/lsp/errorLog.test.ts tests/lsp/resourceState.test.ts tests/lsp/resourceDocs.test.ts`

**Checkpoint**: Operators and developers can see, diagnose, and remediate resource-state behavior.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Full validation, quality gates, and spec traceability across all stories.

- [X] T104 [P] Update `specs/001-resource-resilience/quickstart.md` with final measured commands and observed outputs
- [X] T105 [P] Update `docs/ci.md` with any new resource-resilience test groups or benchmark commands
- [X] T106 [P] Audit all new tests for deterministic fake clocks, bounded waits, and no external-service dependencies in `tests/lsp/`
- [X] T107 [P] Audit all new resource loops, queues, timers, and cache scans for explicit limits in `server/src/`
- [X] T108 Run full typecheck with `bun run typecheck`
- [X] T109 Run full build with `bun run build`
- [X] T110 Run full test suite with `bun run test`
- [X] T111 Run Pike harness validation with `bash scripts/test-pike.sh`
- [X] T112 Update `specs/001-resource-resilience/tasks.md` by marking all completed tasks `[X]`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 Setup**: No dependencies; can start immediately.
- **Phase 2 Foundational**: Depends on Phase 1; blocks every user story.
- **Phase 3 US1 (P1 MVP)**: Depends on Phase 2; no dependency on later stories.
- **Phase 4 US2 (P2 Lazy indexing)**: Depends on Phase 2 and should follow US1 for safer startup/shutdown baseline.
- **Phase 5 US3 (P2 Memory + worker watchdog)**: Depends on Phase 2 and benefits from US2 dependency-map/lazy-indexing primitives.
- **Phase 6 US4 (P3 Hibernation)**: Depends on US2 and US3 because hibernation reuses lazy rehydration, demotion, and worker-stop semantics.
- **Phase 7 US5 (P3 Operability)**: Can begin after Phase 2 but final validation depends on US1-US4 event emitters.
- **Phase 8 Polish**: Depends on all desired stories being complete.

### User Story Dependencies

- **US1**: MVP. Independent and highest priority.
- **US2**: Can be developed after foundational plumbing, but final integration assumes US1 shutdown/cache safety.
- **US3**: Depends on US2's dependency map for correct demotion boundaries.
- **US4**: Depends on US2 lazy wake and US3 worker/memory lifecycle.
- **US5**: Cross-cutting; documentation can start early, but log/status assertions complete after runtime stories.

### Within Each User Story

- Write tests first and capture RED output.
- Implement source changes in the same story only after corresponding RED tests exist.
- Complete the story-specific validation command before moving to the next story.
- Mark each completed task `[X]` in this file immediately after completion.

---

## Parallel Opportunities

- Setup tasks T002-T010 touch separate files and can run in parallel.
- Foundational test tasks T011-T013 can run in parallel; implementation tasks T014-T022 should be mostly sequential because they wire shared configuration/context.
- US1 tests T024-T030 can be written in parallel, but `persistentCache.ts` implementation tasks T031-T035 must be sequential.
- US2 tests T043-T049 can be written in parallel; implementation tasks touching different feature handlers can split after T050-T057.
- US3 tests T064-T069 can be written in parallel; worker tasks T075-T077 can proceed alongside index demotion tasks T070-T074 after tests are RED.
- US4 tests T080-T084 can be written in parallel; implementation should sequence state-machine first, then integrations.
- US5 documentation T101 and changelog T102 can run parallel with log/status implementation after the runtime events exist.

## Parallel Example: User Story 1

```bash
Task: "T024 [US1] Add RED cache migration/self-healing tests in tests/lsp/persistentCache.test.ts"
Task: "T027 [US1] Add RED bloated-cache constrained-memory startup test in tests/lsp/resourceResilience.test.ts"
Task: "T028 [US1] Add RED Pike request-timeout process replacement test in tests/lsp/pikeWorker.test.ts"
Task: "T029 [US1] Add RED shutdown deadline/no-orphan-worker test in tests/lsp/shutdown.test.ts"
```

## Parallel Example: User Story 2

```bash
Task: "T043 [US2] Add RED default openFiles indexing-mode startup test in tests/lsp/backgroundIndex.test.ts"
Task: "T046 [US2] Add RED cross-file feature parameterized tests in tests/lsp/crossFileResolution.test.ts"
Task: "T047 [US2] Add RED workspace symbol progress/cancellation test in tests/lsp/workspaceSymbol.test.ts"
Task: "T049 [US2] Add RED large-workspace benchmark in tests/perf/large-workspace.test.ts"
```

## Parallel Example: User Story 3

```bash
Task: "T064 [US3] Add RED index-entry demotion and rehydration tests in tests/lsp/workspaceIndex.test.ts"
Task: "T067 [US3] Add RED server-side worker heartbeat and idle-eviction tests in tests/lsp/pikeWorker.test.ts"
Task: "T068 [US3] Add RED Pike worker self-termination watchdog test in tests/lsp/pikeWorker.test.ts"
Task: "T066 [US3] Add RED memory-pressure demotion benchmark in tests/perf/large-workspace.test.ts"
```

## Parallel Example: User Story 4

```bash
Task: "T080 [US4] Add RED fake-clock idle hibernation transition tests in tests/lsp/hibernation.test.ts"
Task: "T081 [US4] Add RED hibernation cancellation and deadline-save tests in tests/lsp/hibernation.test.ts"
Task: "T082 [US4] Add RED post-hibernation lazy wake correctness tests in tests/lsp/hibernation.test.ts"
Task: "T083 [US4] Add RED watched-file-events-do-not-reset-idle tests in tests/lsp/hibernation.test.ts"
```

## Parallel Example: User Story 5

```bash
Task: "T095 [US5] Add RED log-signal tests in tests/lsp/errorLog.test.ts"
Task: "T096 [US5] Add RED client status-bar resource-state tests in tests/lsp/resourceState.test.ts"
Task: "T101 [US5] Write lingering remote session troubleshooting guide in docs/lingering-remote-sessions.md"
Task: "T102 [US5] Update CHANGELOG.md [Unreleased] with resource-resilience behavior changes"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1 setup.
2. Complete Phase 2 foundational resource configuration/state plumbing.
3. Complete Phase 3 User Story 1 tests and implementation.
4. Stop and validate US1 independently with T042.
5. Open a PR for crash and teardown hardening before starting lazy indexing.

### Incremental Delivery

1. Setup + Foundational -> shared resource primitives.
2. US1 -> cache/startup/shutdown/timeout safety MVP.
3. US2 -> lazy startup and global-feature correctness.
4. US3 -> memory demotion and heartbeat watchdog.
5. US4 -> hibernation without self-exit.
6. US5 -> operator visibility and documentation.
7. Polish -> full validation and CI-quality evidence.

### Parallel Team Strategy

After Phase 2:
- Developer A: US1 cache/startup/shutdown hardening.
- Developer B: US2 lazy-indexing tests and dependency-map design spikes.
- Developer C: US3 worker heartbeat tests and Pike watchdog protocol.
- Developer D: US5 documentation/log contract scaffolding.

Keep merges ordered by the dependency graph above even if branches are developed concurrently.

---

## Notes

- Do not silently skip pre-existing defects discovered while implementing these tasks; file an issue, fix in scope, or document explicitly in `docs/known-limitations.md` with a reason.
- Keep all resource operations bounded: cache batches, dependency closure depth/count, background scan batch size, worker deadlines, health-check counts, and hibernation timers.
- Avoid modal notifications for routine resource-state transitions; use status bar and honest per-request messages.
- Preserve VS Code Remote behavior: hibernation must never voluntarily exit the LSP process.
- Capture RED and GREEN terminal output for every story validation command before requesting review.
