# Phase 6 P2 Verification Report

Date: 2026-04-27
Commit: c707886 (pre-verification), plus fixes committed separately

## V1: Worker Thrashing Prevention — Measured

### V1a: Rapid typing simulation
- **Test**: 50 didChange events over 2.5 seconds (20 events/second, faster than human typing)
- **Result**: Diagnose invocations ≤ 3 (target: ≤ 3) ✅
- **Mechanism**: Debounce timer resets on every didChange. Only fires once after the burst ends. Version-gating ensures only the final content is diagnosed.

### V1b: Realistic pauses
- **Test**: 15 didChange events with 200ms gaps (3 seconds total)
- **Result**: Diagnose invocations ≤ 2 (target: ≤ 2) ✅
- **Mechanism**: 200ms gap < 500ms debounce interval, so timer never fires during the burst. Fires once after the burst ends.

### V1c: saveOnly baseline
- **Test**: 10 didChange events in saveOnly mode → 0 diagnose invocations ✅
- **Test**: 1 didSave in saveOnly mode → 1 diagnose invocation ✅
- **Measurement**: Realtime mode produces bounded overhead (2-5 diagnose calls per realistic edit session) vs saveOnly (0 without manual saves). Not 10x more.

### Finding
Debouncing works as intended. The 500ms interval effectively collapses bursts into single diagnose calls. Version-gating prevents stale diagnoses from dispatching.

## V2: Priority Queue Effectiveness — Measured

### V2-idle: Baseline hover latency
- Hover latency at idle: < 100ms (tree-sitter only, no worker)

### V2-during: Hover during in-flight diagnose
- Hover latency during in-flight diagnose: < 100ms (same as idle)
- **Hover is unaffected by in-flight diagnose.**

### V2-arch: Architectural finding
**The priority queue in DiagnosticManager does NOT preempt hover/completion.** Hover and completion in server.ts call `worker.request()` directly via PikeWorker's own FIFO, not through DiagnosticManager's priority queue.

This is acceptable because:
1. Hover is tree-sitter-only for the common case (no worker dependency). Latency < 100ms.
2. The priority queue's real value is: if 10 files are queued for diagnose, a higher-priority operation (e.g., a forced diagnose triggered by hover) would jump ahead. But no such operation currently exists.
3. PikeWorker's FIFO allows concurrent requests (each gets a unique ID, subprocess processes sequentially). Hover doesn't block on diagnose.

**Recommendation**: Document that the priority queue controls DiagnosticManager's own dispatch order only. It does not provide cross-subsystem preemption. If future features (e.g., completion that queries the Pike worker) need priority, they should route through `diagnosticManager.queueHighPriority()`.

## V3: Cross-File Propagation Correctness

### Finding: Dependency graph requires on-disk files

The cross-file propagation infrastructure (`propagateToDependents`) is architecturally correct but **the dependency graph is empty in the test environment** because:

1. `WorkspaceIndex.extractDependencies()` resolves inherit declarations via `ModuleResolver.resolveInherit()`
2. `ModuleResolver` resolves paths against the file system
3. Test documents are in-memory only (no files on disk)
4. In-memory `didOpen` documents don't have file-system paths that `ModuleResolver` can resolve

### What was verified
- `propagateToDependents()` code is correct (calls `index.getDependents()`, schedules debounced diagnose)
- `getDependents()` correctly returns the reverse dependency set
- The dependency extraction code in `WorkspaceIndex` is correct for string-literal inherits
- The limitation is test infrastructure, not the propagation code itself

### What needs verification
A layer-2 (VSCode integration) test with actual workspace files to confirm:
1. `inherit "Base"` in `Dependent.pike` creates a dependency edge
2. Editing `Base.pike` triggers re-diagnosis of `Dependent.pike`
3. Three-file chains propagate transitively

### Action item
Add a layer-2 integration test for cross-file propagation with real files.

## V4: Mode Switching and Lifecycle — Verified

### V4a: realtime → saveOnly mid-session
- Pending debounce timers are cleared ✅
- Subsequent didChange events don't trigger diagnose ✅
- didSave triggers diagnose ✅

### V4b: realtime → off mid-session
- didChange produces 0 diagnose invocations ✅
- didSave produces 0 diagnose invocations ✅

### V4c: Open/close/reopen lifecycle
- Reopened file gets fresh diagnose ✅

### V4d: Server shutdown with pending timers
- `dispose()` clears all timers ✅
- No errors logged during teardown ✅
- Teardown completes in < 2 seconds ✅

### Bug found and fixed
**`connection.onDidSave` was never registered.** The original code used `(connection as any).onDidSave(...)` which evaluated to `undefined` — the handler was silently never registered. Fixed by switching to `documents.onDidSave(...)` which is the correct API for `TextDocuments`-based servers.

This means save-triggered diagnostics were non-functional from the initial P2 implementation. The fix is in the verification commit.

Additional fixes:
- `publishDiagnostics` now checks `disposed` flag to prevent post-teardown errors
- `onDidChange` parse diagnostic send now checks `disposed` flag
- `onDidClose` diagnostic clear now checks `disposed` flag
- Error logging in `runDiagnose` catch block now checks `disposed` flag

## V5: Manual Smoke Test Scenarios (Automated)

### V5a: Syntax error appears within 1 second
- Parse diagnostics appear in ~50ms (tree-sitter, immediate) ✅

### V5b: Supersession — error then fix within debounce window
- Pike diagnose fires ≤ 1 time for the final clean content ✅
- No error "flash" in Pike diagnostics (intermediate error was superseded) ✅
- Note: Parse diagnostics DO flash (2 notifications, one for error, one for fix) — this is by design (immediate, free, tree-sitter-based)

### V5c: Continuous typing — monotonic diagnostic count
- Diagnostic count grows monotonically during 3 seconds of continuous typing ✅
- No flicker between states ✅

### V5d: Cross-file propagation
- Dependent file gets re-diagnosed after base edit (in the in-process test, this is from the initial diagnose completing, not from dependency-graph propagation — see V3 finding)

### V5 manual tests (requires VSCode)
The following require manual verification with the extension running:
1. Open a Pike file, type a syntax error → confirm it appears within 1 second
2. Type a syntax error, fix before 1 second → confirm no error flash (Pike diagnostics; parse diagnostics will flash)
3. Open two files where A inherits B, edit B to remove a method → confirm A shows error
4. Type continuously for 10 seconds → confirm no lag or flicker
5. Configure saveOnly mode → confirm only Ctrl+S triggers diagnostics

These are documented in `MANUAL_SMOKE_TESTS.md` for Layer 3 verification.

## V6: Rename Re-evaluation

### Scope estimate
- ~600 LOC across 4 files (1 new: `rename.ts`, 1 new test file)
- Reuses ~60% of Phase 4 infrastructure: `getReferencesTo()`, `getDefinitionAt()`, cross-file reference enumeration

### Why defer
1. **Arrow/dot access resolution is null.** `obj->method()` and `Module.function()` references always resolve to null. These are the most common rename targets. Without resolving them, rename would silently miss references.
2. **Cross-file references are name-based** without scope-chain verification in dependents. Could rename unrelated identifiers with the same name.
3. **Import tracking creates no dependency edges.** `import Stdio;` doesn't create a dependency, so references through imported modules aren't tracked.

### Updated rationale
The third option (tree-sitter-driven workspace-wide rename using Phase 4's resolver) exists and is bounded scope (~600 LOC). However, its correctness depends on reference resolution completeness that Phase 4 doesn't yet provide. Specifically:
- Arrow/dot access resolution requires type inference (deferred to a future phase)
- Import dependency tracking is not implemented
- Cross-file scope verification needs the dependency graph to be populated

Defer rename to after type inference and import tracking are implemented. The Phase 4 infrastructure is sufficient for same-file rename today, but workspace-wide rename needs more resolver work.

## Summary of Findings

| Finding | Severity | Action |
|---------|----------|--------|
| `connection.onDidSave` never registered (dead code) | **Bug** | Fixed: switched to `documents.onDidSave` |
| Post-teardown connection errors | **Bug** | Fixed: `disposed` guards on all `sendDiagnostics` calls |
| Priority queue doesn't preempt hover/completion | **Architecture** | Document; not a bug (hover doesn't use worker) |
| Dependency graph empty in test environment | **Infrastructure** | Add layer-2 integration test for cross-file propagation |
| Cross-file propagation untested with real files | **Gap** | Requires layer-2 VSCode integration test |
| Rename needs type inference + import tracking | **Scope** | Defer; updated rationale in decision |

## Phase 6 P2 Status

**P2 verification complete with findings.** All findings addressed:
- 2 bugs fixed (onDidSave registration, disposed guards)
- 1 architectural note documented (priority queue scope)
- 1 test gap identified (cross-file propagation needs real files)
- Rename deferral reaffirmed with updated rationale

Test suite: 979 pass, 0 fail, 8,697 assertions across 24 files.
