# Feature Specification: Resource-Resilient Language Server

**Feature Branch**: `001-resource-resilience`

**Created**: 2026-06-12

**Status**: Draft

**Input**: User description: "Resource-proof the Pike LSP: lazy indexing, crash and teardown hardening, memory bounding, Pike worker heartbeat watchdog and self-termination, and idle session hibernation."

## Clarifications

### Session 2026-06-12

- Q: When the server enters degraded mode under memory pressure, what happens to global/lazy features (find references, workspace symbol, rename, hierarchies)? → A: Suspend new on-demand indexing; keep open files and their already-indexed dependency closure fully functional; global features invoked while degraded return an explicit "temporarily unavailable under memory pressure" signal rather than silent partial results.
- Q: For the first global feature call in openFiles mode that requires building the dependency map / declarations index, does the request block or return non-blocking? → A: Block the specific request with workDoneProgress + cancellation until the dependency map and needed candidate indexing are ready, then return complete results. The cost is one-time per session (the map is then warm); never partial or empty results.
- Q: Should success criteria pin concrete numeric gates now or stay relative? → A: Hard-gate only the safety/resource bounds tied to explicit defaults (watchdog window, shutdown deadline, idle/hibernate thresholds, cache-equals-live-entry invariant); keep latency/heap performance metrics relative until benchmarked, then record tuned values in ADRs/tests.
- Q: Should resource state changes (degradation, demotion, hibernation) be surfaced to the user in the editor, or log-only? → A: A non-intrusive status-bar indicator for persistent resource states (degraded, indexing, hibernating/waking) plus honest per-request messages when a feature is unavailable; no modal popups.
- Q: How is an existing old-format on-disk cache (no mtime+size metadata, accumulated superseded entries) handled on first launch with the new version? → A: Stat each old-format entry's source file to reconstruct mtime+size on first load; keep valid entries, drop superseded/corrupt. Preserves the warm cache and makes metadata-staleness effective from session 1; the "wipe and rebuild when count vastly exceeds expected" overflow valve still applies.

## User Scenarios & Testing *(mandatory)*

<!--
  This feature is technical infrastructure: the "users" are the developers and
  operators who run the Pike Language Server. Each user story is an independently
  shippable increment that delivers value on its own. Stories are prioritized by
  urgency: the active crash is P1; lazy/responsive operation and bounded footprint
  are P2; hibernation and operability are P3.
-->

### User Story 1 - Server survives startup and shuts down cleanly (Priority: P1)

A developer opens a Pike project whose on-disk cache has grown large over many
sessions (including superseded entries). Today this can abort the language server
with a fatal out-of-memory crash, and torn-down or timed-out Pike processes can be
left running as orphans on the host. The server must instead start reliably —
degrading rather than aborting when memory is tight — and guarantee that every
Pike process it spawned is gone within a bounded deadline on shutdown.

**Why this priority**: This fixes an active crash and a resource-leak class of bug.
It is the most urgent because it affects every window open on a non-trivial
workspace and leaves orphan processes on shared hosts. It is fully valuable on its
own: a server that never OOM-crashes on startup and never leaks Pike processes is a
strict improvement regardless of the later phases.

**Independent Test**: Open a workspace backed by a bloated cache directory
(~20,000 entries including superseded hashes) under a deliberately small memory
budget. Assert the server starts (degraded mode if needed), serves open files, and
that after shutdown no `pike` process remains on the host.

**Acceptance Scenarios**:

1. **Given** a cache directory with ~20,000 entries including superseded hashes,
   **When** the server starts under a constrained memory budget,
   **Then** it does not abort with a fatal out-of-memory error; it logs degraded
   startup if the budget is hit and continues serving open files.
2. **Given** the server is running with a live Pike worker,
   **When** a Pike request times out,
   **Then** the wedged Pike process is killed and restarted (not merely rejected),
   so the next request is served by a fresh process.
3. **Given** the server is shutting down while cache saving is slow,
   **When** shutdown is triggered,
   **Then** the server exits within a bounded deadline and no orphan Pike process
   remains, regardless of how long a full cache save would have taken.
4. **Given** the server hits an unrecoverable internal error,
   **When** the error occurs,
   **Then** the server logs and exits so the client restarts a clean process, rather
   than continuing silently in a corrupt state.

---

### User Story 2 - Fast, lazy startup and always-responsive operation (Priority: P2)

A developer opens a large Pike workspace. Today the server eagerly scans and builds
symbol tables for every file at startup, blocking interactive requests and holding
the whole workspace's symbol data resident forever. The server should instead start
ready nearly instantly — scaling with the files the developer actually has open, not
the total workspace size — and stay responsive while any background indexing runs.
Global features (workspace symbol search, find references, rename, call/type
hierarchy, go-to-implementation) must remain correct.

**Why this priority**: Responsiveness and correctness of language features are core
to the developer experience. This is the largest behavior change and must land
before the memory-bounding and hibernation work that build on top of it.

**Independent Test**: Measure time-to-first-hover and time-to-first-semantic-tokens
in open-files mode versus full mode across workspaces of increasing size; assert
open-files mode is near-constant in workspace size, and that all cross-file feature
suites pass in both modes.

**Acceptance Scenarios**:

1. **Given** a workspace of thousands of Pike files in the default indexing mode,
   **When** the developer opens a single file,
   **Then** the server indexes that file and its transitive dependency closure
   (inherit/import targets) only, bounded by depth and count, and unrelated
   workspace files are never read.
2. **Given** the developer needs a global feature (e.g. workspace symbol search,
   find references, rename, call/type hierarchy, go-to-implementation),
   **When** the feature is invoked in open-files mode,
   **Then** it returns correct results, using on-demand indexing of candidates where
   needed, reporting progress and supporting cancellation — never silently falling
   back to a full eager scan.
3. **Given** a background scan is running in full mode,
   **When** the developer hovers, requests completion, or runs diagnostics,
   **Then** those interactive requests are not queued behind indexing and return
   within interactive latency bounds.
4. **Given** the developer changes the indexing mode to `full`, `auto`, or
   `openFiles`,
   **When** the server applies the setting,
   **Then** each mode behaves as documented and remains fully supported.

---

### User Story 3 - Bounded footprint and a self-terminating Pike worker (Priority: P2)

On large workspaces the server holds full per-file symbol data (dominated by
per-occurrence reference data) for every file forever, so memory grows with the
workspace. Separately, when the language server process is killed or hangs, the
Pike worker it spawned can linger because its only orphan defense is noticing the
end of its input stream between requests — useless mid-compile. The server must
bound its resident memory by shedding non-essential data under pressure, and the
Pike worker must terminate itself when the server stops sending heartbeats, even
during a long compile.

**Why this priority**: Together these make the server's footprint predictable on
large workspaces and eliminate a whole class of orphan/zombie Pike processes. They
pair naturally with the lazy-indexing work and are prerequisites for trustworthy
hibernation.

**Independent Test**: Hold 5 files open on a large workspace and assert resident
memory is bounded by the open files' dependency closure (not workspace size), then
re-measure after a pressure-triggered demotion; separately, hard-kill the server
while Pike is mid-long-compile and assert no `pike` process survives the watchdog
window.

**Acceptance Scenarios**:

1. **Given** the server is under heap pressure with several files open,
   **When** pressure crosses the configured threshold,
   **Then** the server sheds retained data for files that are not open and not in any
   open file's dependency closure, while keeping open files fully functional.
2. **Given** the Pike worker is mid-way through a long compile,
   **When** the language server is hard-killed (so it can no longer send heartbeats),
   **Then** the Pike worker exits on its own within the watchdog window, leaving no
   orphan process.
3. **Given** the Pike worker has become unresponsive (not answering health checks),
   **When** it misses the configured number of consecutive health checks,
   **Then** the server declares it wedged, force-kills it, and respawns it with
   backoff.
4. **Given** the Pike worker is idle,
   **When** it has been unused past the configured idle timeout,
   **Then** it is evicted and no further heartbeats are sent to a stopped worker.
5. **Given** the server is in degraded mode under memory pressure,
   **When** the developer invokes a global feature (e.g. find references),
   **Then** the server returns an explicit "temporarily unavailable under memory
   pressure" signal rather than a partial or empty result; editing open files keeps
   working normally.

---

### User Story 4 - Idle remote sessions hibernate instead of lingering (Priority: P3)

On VS Code Remote (SSH/CLI) hosts, a hard disconnect can leave the extension host
and its language server alive indefinitely, holding a full index and a Pike process
resident. The parent-process watchdog correctly does not fire (the host is still
alive), so the server must make itself cheap on its own: hibernate after a sustained
idle period and rehydrate lazily when activity resumes — without ever exiting, since
a voluntary exit is treated as a crash and restarts the server inside the same
zombie session.

**Why this priority**: This is the lowest-urgency but highest-leverage story for
shared multi-user hosts: it collapses the footprint of abandoned sessions to
near-zero automatically. It depends on the memory-bounding and worker-liveness work
landing first.

**Independent Test**: Advance a fake clock past the hibernation threshold with no
open documents and no requests; assert resident heap drops below the stated bound
and no Pike process is alive, then issue a definition/hover/semantic-tokens request
and assert the result matches the pre-hibernation answer exactly.

**Acceptance Scenarios**:

1. **Given** the server has been idle past the configured hibernation threshold,
   **When** the threshold is reached,
   **Then** the server hibernates: it cancels background work, saves state within a
   deadline, sheds all retained data, stops the Pike worker, and clears caches — but
   does NOT exit the process.
2. **Given** the server is hibernated,
   **When** the next request arrives,
   **Then** the server rehydrates lazily through the existing on-demand paths and
   returns the correct result; it does not eagerly re-run the full background index.
3. **Given** no documents are open,
   **When** watched-file events fire (e.g. background version-control activity),
   **Then** those events do not reset the idle/hibernation timer.
4. **Given** the server is in full/auto mode and just woke from hibernation,
   **When** sustained activity resumes,
   **Then** re-indexing is scheduled only after a short sustained-activity window,
   not eagerly on the first request.

---

### User Story 5 - Operable and diagnosable (Priority: P3)

Operators of shared hosts need to detect, understand, and clean up lingering remote
sessions, and to trust that the server's new resource behavior is observable rather
than silent. The feature must ship with operational documentation and emit clear
signals for every degradation, demotion, restart, and hibernation event.

**Why this priority**: Without operability the resource savings are invisible and
the zombie-session problem is only mitigated, not managed. It is lower priority
because it does not change runtime behavior, but it is required for the feature to
be supportable.

**Independent Test**: Trigger each observable event (degraded startup, memory-driven
demotion, worker restart, hibernation enter/exit) and assert each produces a clear
log entry; follow the new troubleshooting guide's one-liners to identify and clean
up a lingering session on a host.

**Acceptance Scenarios**:

1. **Given** the server enters degraded mode, demotes entries, restarts the worker,
   or hibernates/wakes,
   **When** each event occurs,
   **Then** a clear log line is emitted (including, for demotion, entries demoted and
   heap before/after).
2. **Given** an operator suspects a lingering remote session on a shared host,
   **When** they consult the troubleshooting guide,
   **Then** they find diagnostic one-liners to identify heavy server/extension/Pike
   processes and documented remedies to reap them.
3. **Given** the new resource behavior is in place,
   **When** a session is abandoned on a shared host,
   **Then** its footprint collapses to lightweight stubs with no Pike process,
   without operator intervention.

---

### Edge Cases

- What happens when the cache directory contains corrupt, duplicate, or superseded
  entries across sessions? (Must self-heal: keep the entry matching on-disk metadata,
  delete the rest; prune superseded entries after a save.)
- What happens when the cache entry count vastly exceeds the expected live count?
  (Wipe and rebuild rather than loading garbage.)
- What happens when the Pike worker is wedged mid-compile at the moment the server is
  killed? (The in-process watchdog thread must still fire and exit Pike; the
  end-of-input check is only a last-resort fallback.)
- What happens when a workspace exceeds the configured full-scan file limit, or a
  single file exceeds the size limit? (Scan warns and skips oversized files; auto mode
  falls back to open-files behavior for very large workspaces.)
- What happens when hibernation is triggered while a long background operation is
  in-flight? (Cancel it, deadline-bound the state save, then hibernate.)
- What happens to idle worker eviction vs. hibernation? (Heartbeats do not reset
  idle eviction; only real requests do. A stopped worker is never pinged back to
  relevance.)
- What happens when an open-files-mode user invokes a global feature that genuinely
  needs all declarations? (Run a one-time declarations-only background index with
  progress and cancellation — never a silent full eager scan, never an empty result.)

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The server MUST NOT abort with a fatal out-of-memory error when
  starting on a workspace whose on-disk cache contains thousands of entries,
  including superseded entries. If the configured memory budget is exceeded during
  startup, the server MUST start in a degraded mode that keeps open files functional.
- **FR-002**: The server MUST prevent unbounded cache growth: after saving, superseded
  cache entries MUST be removed so the on-disk cache file count equals the live entry
  count. On load, duplicate or corrupt entries MUST be self-healed (keep the entry
  matching on-disk metadata, delete the rest).
- **FR-003**: The server MUST determine cache staleness during startup from file
  metadata (modification time and size) without reading file contents for unchanged
  files.
- **FR-004**: The server MUST have an explicit, documented memory budget and MUST
  degrade (cancel remaining startup/background work, keep serving) rather than abort
  when that budget is approached.
- **FR-005**: A Pike request that times out MUST result in the underlying Pike process
  being killed and restarted, not merely a rejected response.
- **FR-006**: On shutdown, the server MUST guarantee the Pike process is terminated
  within a bounded deadline even if saving state is slow, so no orphan Pike process
  can remain. The signal path MUST not be indefinitely blocked by a slow state save.
- **FR-007**: On an unrecoverable internal error, the server MUST log and exit so the
  client restarts a clean process; it MUST NOT continue silently in a corrupt state.
- **FR-008**: By default, the server MUST NOT scan the entire workspace at startup.
  It MUST index open files and their transitive dependency closure (inherit/import
  targets), bounded by configurable depth and count, as a background task that yields
  between files.
- **FR-009**: The server MUST expose an indexing-mode setting with at least these
  options: open-files-only (the new default), full workspace, and auto (full scan only
  when discovery finds fewer than a configurable file limit).
- **FR-010**: Cross-file and global features (workspace symbol search, find
  references, rename, call hierarchy, type hierarchy, go-to-implementation) MUST
  return correct results in all indexing modes, using on-demand indexing of
  candidates where needed. Every lazy/on-demand operation MUST report progress and
  support cancellation.
- **FR-011**: The server MUST build and maintain a lightweight dependency map
  (file-level inherit/import edges, no per-occurrence symbol data retained, validated
  by metadata) so that dependents of changed/open files and cross-file diagnostics
  work in open-files mode. It MUST be built lazily on first use and kept current by
  the file watcher.
- **FR-012**: Background scanning and on-demand indexing MUST NOT block interactive
  requests (hover, completion, diagnostics). There MUST be no silent multi-second
  stalls; any operation that became lazy reports progress and is cancellable.
- **FR-013**: Discovery and scanning MUST honor a configurable ignore list (defaulting
  to common non-source directories), skip files exceeding a size limit with a logged
  warning, and warn when a file-count cap is reached.
- **FR-014**: The server MUST bound resident memory: under heap pressure it MUST shed
  non-essential retained data (files that are not open and not in any open file's
  dependency closure) while keeping open files and their closures functional. The
  dependency map itself (small) MUST survive demotion.
- **FR-015**: The Pike worker MUST self-terminate when the server stops sending
  heartbeats, even while blocked in a long compile, within a bounded watchdog window.
  The end-of-input check MUST remain as a last-resort fallback.
- **FR-016**: The server MUST detect a wedged/unresponsive Pike worker after a
  configurable number of consecutive failed health checks and force-kill and respawn
  it with backoff.
- **FR-017**: Worker heartbeats MUST be outbound only and MUST NOT count as activity
  for idle eviction or hibernation; only real requests do. A stopped worker MUST
  receive no further heartbeats.
- **FR-018**: The server MUST hibernate after a configurable idle period (default 15
  minutes; 0 disables): cancel background work, save state within a deadline, shed all
  retained data, stop the Pike worker and its heartbeat, and clear caches. The server
  MUST NOT exit the process on idle.
- **FR-019**: Hibernation MUST be reversible: the first request after hibernation MUST
  rehydrate lazily through existing on-demand paths and return correct results. In
  full/auto modes, re-indexing MUST resume only after a sustained-activity window, not
  eagerly on wake.
- **FR-020**: The server MUST emit clear operational log signals for: degraded-mode
  entry, memory-driven demotion (with entries demoted and heap before/after), worker
  restarts, and hibernation enter/exit.
- **FR-021**: While in degraded mode (memory budget approached), the server MUST keep
  open files and their already-indexed dependency closure fully functional, MUST
  suspend new on-demand indexing/candidate expansion, and MUST make global features
  invoked during degradation return an explicit "temporarily unavailable under memory
  pressure" signal — never silent, incomplete, or empty results.
- **FR-022**: The first invocation in a session of a global feature whose complete
  answer requires the dependency map / declarations index MUST block that request
  (reporting workDoneProgress, supporting cancellation) until the map and needed
  candidate indexing are ready, then return complete results. The dependency map is
  built once per session and then kept warm; results MUST never be partial or empty.
- **FR-023**: Persistent resource states (degraded, indexing in progress,
  hibernating/waking) MUST be surfaced to the developer via a non-intrusive status-bar
  indicator, and per-request unavailability MUST carry an honest message. The server
  MUST NOT use modal popups/notifications for routine resource-state transitions.
- **FR-024**: On first launch against an existing old-format cache (entries lacking
  mtime+size metadata), the server MUST stat each entry's source file to reconstruct
  the metadata, keep valid entries, and drop superseded/corrupt ones — preserving the
  warm cache and making metadata-staleness (FR-003) effective from the first upgraded
  session. The "wipe and rebuild when entry count vastly exceeds the expected live
  count" overflow path remains available.

### Key Entities *(include if feature involves data)*

- **Indexing Mode (configuration)**: The user-selected strategy — open-files-only
  (default), full, or auto — governing how much of the workspace is indexed and when.
- **Cache Entry (on-disk)**: A persisted record of one file's indexed data, keyed by
  content hash, augmented with file metadata (modification time and size) and its
  dependency list. Subject to pruning and self-healing.
- **Dependency Map**: A lightweight structure of file-level inherit/import edges,
  persisted with metadata validation, retained even when individual file entries are
  demoted. Enables dependents lookup and cross-file diagnostics in open-files mode.
- **Index Entry (in-memory lifecycle)**: A file's data exists in a full form while
  relevant and a lightweight stub form (identity, hash, dependencies) when demoted
  under pressure; stubs are rebuilt on demand from disk.
- **Pike Worker**: The spawned Pike process, governed by a liveness contract —
  parent-to-child heartbeat, a worker-side watchdog, end-of-input fallback, idle
  eviction, and crash-restart backoff.
- **Hibernation State**: Whether the idle server is active or hibernated, driven by an
  activity tracker that counts real requests (and watched-file events only when
  documents are open).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Opening a workspace backed by an accumulated cache of ~20,000 entries
  (including superseded hashes) never crashes the language server, regardless of the
  memory budget; the server starts (degraded if needed) and serves open files.
- **SC-002**: After a normal session save cycle, the number of on-disk cache files
  equals the number of live entries; running the cycle repeatedly does not grow the
  cache.
- **SC-003**: During startup, the staleness check reads zero file contents for
  unchanged files (verifiable via profiler counters).
- **SC-004**: Time-to-first-hover and time-to-first-semantic-tokens in open-files mode
  is near-constant as workspace size grows (bounded by the open files' dependency
  closure), whereas full mode scales with total file count.
- **SC-005**: Interactive request latency (p95 hover, sampled every 100 ms) during a
  full-mode background scan stays within interactive bounds after the
  responsiveness/yielding work.
- **SC-006**: All cross-file feature suites (references, rename, workspace symbol,
  call/type hierarchy, cross-file propagation) pass in both open-files and full modes
  (the test harness parameterized over indexing mode).
- **SC-007**: With 5 files open on a large workspace, resident memory is bounded by the
  open files' dependency closure size — not workspace size — and returns below the
  stated bound after a pressure-triggered demotion.
- **SC-008**: After the language server is hard-killed while Pike is mid-long-compile,
  no orphan Pike process remains on the host within the watchdog window.
- **SC-009**: A Pike worker that fails the configured consecutive health checks is
  automatically killed and restarted with backoff, transparently to the developer.
- **SC-010**: After hibernation (idle past threshold), resident heap drops below the
  stated bound and no Pike process is alive; the next definition/hover/semantic-tokens
  result matches the pre-hibernation answer exactly.
- **SC-011**: Watched-file events with no open documents do not reset the
  hibernation/idle timer; genuine requests do.
- **SC-012**: Worker heartbeats do not reset idle eviction; a stopped worker receives
  no further heartbeats and is not pinged back to relevance.
- **SC-013**: A shutdown with an artificially slow state save still exits within the
  stated deadline with no orphan Pike process.
- **SC-014 (hard-gated resource/safety bounds; default values, all configurable)**:
  the Pike worker self-terminates within the watchdog window (30 s) of the last
  heartbeat; shutdown completes within ~1.5 s even when a state save is slow; idle
  hibernation triggers at 15 min (0 disables); idle worker eviction triggers at 300 s;
  and after a save cycle the on-disk cache file count equals the live entry count.
  These are asserted as hard pass/fail gates in tests. Latency targets (SC-004,
  SC-005) and heap targets (SC-007, SC-010) remain relative until tuned against the
  synthetic-workspace benchmarks, at which point concrete values are recorded in the
  relevant ADRs and tests.

## Assumptions

- **Default change is intentional.** Open-files becomes the new default indexing mode;
  full mode remains fully supported and selectable. This is a deliberate behavior
  change (faster startup, lower footprint) and is documented as such, not a regression.
- **Reasonable defaults (documented, configurable).** Idle hibernation = 15 minutes
  (0 disables); worker heartbeat = 10 s; worker watchdog = 30 s; idle worker eviction
  = 300 s; full-scan file limit = 500; dependency-closure depth = 5 and file count =
  200; ignore list defaults to common non-source directories; max file size = 1 MB;
  memory budget set to an explicit, documented value with a ~80% pressure hysteresis.
  These values are starting points to be tuned against benchmarks.
- **Delivery is phased.** Work ships as one PR per phase, ordered by urgency, following
  the project's conventional-commit and CHANGELOG conventions. Each PR includes raw
  before/after benchmark or terminal output from fixtures — no summaries.
- **Architecture decisions are recorded.** ADRs will capture: indexing modes and the
  dependency-map design; the memory budget and the "degrade, don't die" principle; the
  worker liveness contract (heartbeat / watchdog / end-of-input fallback); and the
  "idle sessions hibernate, never self-exit" principle.
- **Benchmarking harness.** A synthetic-workspace generator (e.g. ~2,000 Pike files
  with realistic inherit/import fan-out) is produced under a performance-tests area to
  validate every phase with numbers rather than impressions.
- **Semantic-token lifecycle is out of scope.** That work is a separate track and is
  not touched by this feature.
- **Existing machinery is reused, not reinvented.** The on-demand indexing hook,
  deferred-dependency resolution, the persistent cache, idle eviction, and crash
  backoff are extended rather than replaced.

## Scope and Delivery *(informational)*

The feature is delivered as independently-mergeable increments, ordered by urgency.
Implementation specifics (file/line references, configuration keys, code structure,
and the detailed per-step designs) are deferred to the implementation-planning phase,
for which the originating master prompt is the source input.

1. **Crash and teardown hardening (P1).** Stream the cache restore; metadata-based
   staleness; cache pruning and self-healing; explicit memory budget with
   degrade-don't-die; fix global error handlers; kill the worker on request timeout;
   effective exit-handler kill; deadline the signal path.
2. **Lazy indexing (P2).** Indexing-mode setting; open-files mode with dependency
   closure; the dependency map; global features via on-demand indexing.
3. **Memory bounding (P2).** A demotion routine; heap-pressure-triggered demotion;
   profiler/cache hardening.
4. **Discovery and scan ergonomics (P2/P3).** Ignore list, size/count caps; per-file
   yielding or off-thread parsing; batched invalidation during bulk scans.
5. **Pike worker heartbeat watchdog and self-termination (P2).** Node-to-Pike
   heartbeat; Pike-side watchdog thread; health-check semantics; configurable idle
   eviction; documented liveness contract (ADR).
6. **Idle hibernation (P3).** Never self-exit on idle; activity tracker; hibernate
   after threshold; lazy rehydration.
7. **Operability (P3).** Lingering-remote-session documentation and diagnostic
   guidance.
