# 0013: Real-Time Diagnostics with Debouncing

**Status:** Approved (Phase 6 P2)
**Date:** 2026-04-27
**Depends on:** 0011 (diagnostics pipeline), 0012 (completion, worker fairness context)

## Context

Phase 5 shipped save-only diagnostics. Phase 6 P2 adds real-time diagnostics that fire as the user types, with debouncing to prevent worker thrashing. The design must account for the shared-server deployment context (decision 0011 §6) where multiple users share a single machine.

## 1. Per-File Debouncing

### Decision: Independent timers per open document

Each open file has its own debounce timer. On `didChange`, the file's timer resets to the debounce interval. When the timer expires, a diagnose is queued for that file. Edits to file A do not reset file B's timer.

On `didSave`, diagnostics fire immediately — the user explicitly saved and wants to know the result now.

### Debounce interval

**Default: 500ms.**

| Interval | Behavior | Risk |
|----------|----------|------|
| 200ms | Feels responsive; diagnose fires often during steady typing | Worker thrashes on shared servers under load |
| 500ms | Good balance; diagnose fires once per typing pause | Diagnostics feel slightly stale during rapid edits |
| 1000ms | Conservative; minimal worker load | Feels sluggish; user may save before diagnostics appear |

500ms is the right default because:
- The Pike worker's warm-path diagnose latency is ~0.3ms (decision 0011 §6h), so the worker won't be the bottleneck
- The debounce interval primarily controls how many diagnose invocations happen during continuous typing
- On shared servers under load, the operator can increase the interval via configuration

**Configuration:** `diagnosticDebounceMs` (default: 500, minimum: 100, maximum: 5000)

### Implementation

```typescript
interface FileDiagnosticState {
  timer: ReturnType<typeof setTimeout> | null;
  version: number;       // document version when timer was set
  contentHash: string;   // content hash when timer was set
  pending: boolean;      // true when a diagnose request is in flight
}
```

The `DiagnosticManager` holds a `Map<string, FileDiagnosticState>` keyed by URI.

## 2. Supersession Before Worker Dispatch

### Decision: Version-gated dispatch

When a debounce timer fires, it checks whether the current document version matches the version captured when the timer was set. If the versions differ, the user has typed more since the timer was set — skip the diagnose and let the newer timer handle it.

This is simpler than cancelling an in-flight worker request (which the FIFO worker can't support) and more reliable than trying to cancel between the timer firing and the worker dispatch. The version check is atomic in the single-threaded Node.js event loop.

### Flow

```
didChange arrives for file X (version N)
  → reset debounce timer for file X
  → capture version=N, contentHash=H
timer fires for file X
  → check: current doc version == N?
    → yes: dispatch diagnose(version N, contentHash H)
    → no: skip (superseded by newer edit)
```

## 3. Diagnostic Lifecycle and Staleness

### Decision: Keep previous diagnostics during computation; stale warning at 2s

While the worker computes diagnose for file X:

1. **Keep previous diagnostics.** They're the best information available. Clearing them would cause a distracting flash.
2. **After 2 seconds** (configurable), publish a staleness warning diagnostic alongside the previous diagnostics. This tells the user "these diagnostics may be stale; we're still computing."
3. **When diagnose completes**, replace previous diagnostics with the new result.

### Staleness warning format

```
range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
severity: Information (3)
source: "pike-lsp"
message: "Diagnostics are being updated..."
```

Using `Information` severity avoids the warning/error color coding. It's informational only.

**Rationale for not clearing:** gopls keeps previous diagnostics during recomputation. VSCode's Problems panel would flash empty then re-fill if we clear. The staleness warning is the least visually disruptive approach.

**Configuration:** `diagnosticStaleMs` (default: 2000, minimum: 500)

### didClose behavior

When a file is closed, clear all diagnostics for that file and cancel any pending debounce timer. This prevents stale diagnostics from appearing after the user closes a file.

## 4. Worker Priority Model

### Decision: Non-preemptive with priority queueing

The Pike worker processes one request at a time (FIFO). Diagnose requests are lower priority than hover/completion. The implementation:

1. **Diagnose requests enter a low-priority queue.** Hover/completion requests go directly to the worker.
2. **When the worker is idle**, drain from the high-priority queue first, then the low-priority queue.
3. **When the worker is busy**, incoming hover/completion requests queue at high priority; they'll be processed before any pending diagnose requests.

In practice, since the worker's warm-path latency is ~0.3ms for diagnose and hover doesn't use the worker at all (decision 0011 §6h), contention is rare. The priority queue prevents pathological cases where many files are debouncing simultaneously.

### Priority levels

| Priority | Request type | Rationale |
|----------|-------------|-----------|
| High | hover, completion, definition, references | User is waiting; visible latency target < 50ms |
| Low | diagnose | Background computation; user is not directly waiting |

### Implementation

The `PikeWorker` gains a `requestWithPriority(priority, method, params)` method. Internally, it maintains two queues. When the worker finishes a request, it checks the high-priority queue first.

## 5. Cross-File Diagnostic Propagation

### Decision: Publish diagnostics for dependent files

When diagnose returns diagnostics with locations in files other than edited file, publish those diagnostics to the affected files too. This uses the `invalidateWithDependents()` mechanism from the WorkspaceIndex.

### Flow

```
didChange for file A
  → debounce timer fires for file A
  → diagnose(A)
  → get diagnostics for A
  → get dependents of A from WorkspaceIndex (files that inherit/import A)
  → for each dependent file B:
    → if B is open in the editor:
      → diagnose(B) (debounced — uses B's own timer)
    → if diagnose(A) returned errors with locations in B:
      → publish those diagnostics for B immediately
```

The key insight: Pike's compiler may report errors in files other than the one being compiled when `#include` or `inherit` brings in broken code. The diagnostics already have file locations; the LSP just needs to route them to the right URI.

### Caveat

Pike's `compile_string` compiles a single file. Errors reference line numbers in the compiled file, not in inherited files. Cross-file error propagation via Pike diagnostics is limited to the compile unit boundary. The more useful signal is the dependency graph: when A changes, B (which inherits A) should be re-diagnosed on its own timer.

The implementation will:
1. Publish Pike diagnostics to the edited file (existing behavior)
2. Schedule re-diagnosis of dependent files (new behavior — each on their own debounce timer)
3. NOT attempt to parse Pike's error messages for foreign file locations (unreliable)

## 6. Diagnostic Mode Setting

### Decision: Three modes, configurable via `initializationOptions`

| Mode | Behavior | Use case |
|------|----------|----------|
| `realtime` | Debounced diagnostics on didChange + immediate on didSave | Default; best experience |
| `saveOnly` | Diagnostics only on didSave (Phase 5 behavior) | Shared servers under heavy load |
| `off` | No Pike diagnostics; parse diagnostics still shown | Reading code; minimal resource usage |

**Default:** `realtime`

**Configuration:** Via `initializationOptions.diagnosticMode` in the `initialize` request. The VSCode extension sends this based on user settings.

Parse diagnostics (tree-sitter ERROR nodes) are always published on didChange regardless of mode — they're free (no worker involved).

## 7. DiagnosticManager Architecture

The DiagnosticManager encapsulates all debounce, supersession, staleness, and cross-file logic. It replaces the inline save-only code in server.ts.

```
DiagnosticManager
  ├── Per-file debounce timers
  ├── Version-gated supersession
  ├── Staleness tracking
  ├── Cross-file propagation (via WorkspaceIndex.dependents)
  ├── Diagnostic mode (realtime/saveOnly/off)
  └── Integrates with PikeWorker (priority queue)
```

### Public API

```typescript
class DiagnosticManager {
  constructor(options: {
    worker: PikeWorker;
    documents: TextDocuments<TextDocument>;
    connection: Connection;
    index: WorkspaceIndex;
    debounceMs?: number;
    staleMs?: number;
    mode?: "realtime" | "saveOnly" | "off";
  });

  /** Called on didChange. Resets debounce timer (realtime mode) or does nothing. */
  onDidChange(uri: string): void;

  /** Called on didSave. Fires immediate diagnose. */
  onDidSave(uri: string): Promise<void>;

  /** Called on didClose. Cancels timer, clears diagnostics. */
  onDidClose(uri: string): void;

  /** Dispose all timers. */
  dispose(): void;
}
```

## Consequences

- Real-time diagnostics with debouncing provides a significantly better editing experience than save-only
- The 500ms default is conservative enough for shared servers; operators can increase it
- Supersession prevents stale diagnoses from reaching the worker, saving CPU cycles
- Worker priority queueing ensures interactive features (hover, completion) remain responsive
- Cross-file propagation means editing a base class triggers re-diagnosis of inheriting files
- The three-mode setting allows users on heavily loaded shared servers to opt out of real-time
- The DiagnosticManager encapsulation keeps server.ts clean and the debounce logic testable
- Parse diagnostics (tree-sitter) remain immediate on every keystroke — they're free
