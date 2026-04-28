# Deployment Context: SSH on Shared Server

## Environment

The Pike Language Server deploys via VSCode Remote-SSH to a shared Linux server
where multiple developers work concurrently. This constraint affects every
resource-sensitive design decision.

## Key Constraints

- **Shared CPU**: N coworkers compete for CPU. Pike compilation is CPU-intensive.
  Under contention, one user's slow compile shouldn't block others' editor
  responsiveness. Mitigation: `nice +5` on the Pike worker subprocess.

- **Shared memory**: Each Pike worker process consumes memory. An idle worker
  is wasted memory that compounds across N users. Mitigation: idle eviction
  after 5 minutes of no requests.

- **Finite inotify watches**: `fs.inotify.max_user_watches` is a system-wide
  limit. If the LSP used file watchers, N users × M watches would exhaust the
  limit. Mitigation: server relies entirely on editor-pushed notifications
  (didChange, didSave, didClose). No server-side file watchers.

- **Network latency**: VSCode Remote-SSH adds 20-100ms of round-trip latency.
  LSP requests that feel instant locally may feel sluggish over SSH. Hover
  is parse-tree driven (sub-millisecond) specifically to avoid this.

- **Per-user costs multiply**: Each open VSCode window is a separate LSP
  server instance. A coworker with 5 windows creates 5 Pike workers, 5 caches,
  5 sets of indexed files. Cache caps and idle eviction prevent unbounded growth.

## Phase Implications

### Phase 5 (Types and Diagnostics)
- Save-only diagnostics avoid real-time compilation over SSH
- AutoDoc extraction is parse-tree driven, no Pike subprocess
- Pike worker has idle eviction, memory ceiling, and nice value
- Timeout surfaced as diagnostic rather than silently dropped
- LRU cache caps at 50 entries / 25MB per server instance

### Phase 6 (Debouncing, Completion, Rename)
- **Completion**: Latency-sensitive. Over SSH with a contended server,
  completion popups may not feel instant. Route completion through
  tree-sitter and AutoDoc only (no Pike worker) for sub-millisecond response.
  Accept lower-quality results in exchange for responsiveness.

- **Debouncing**: Must account for FIFO queueing through the Pike worker.
  If debounced diagnostics are in flight, hover requests queue behind them.
  Tune the debounce interval to minimize queue contention.

- **Rename/code actions**: Can use the Pike worker for validation (save-triggered)
  but not for real-time feedback. Accept that rename previews may be stale.

## Configuration Reference

All values are configurable via `PikeWorkerConfig`:

| Parameter | Default | Purpose |
|-----------|---------|---------|
| `idleTimeoutMs` | 300000 (5 min) | Kill worker after this idle time |
| `maxRequestsBeforeRestart` | 100 | Force restart after this many requests |
| `maxActiveMinutes` | 30 | Force restart after this many active minutes |
| `requestTimeoutMs` | 5000 (5s) | Per-request timeout |
| `niceValue` | 5 | Linux nice value for Pike subprocess |

Cache limits are in `server.ts`:

| Constant | Default | Purpose |
|----------|---------|---------|
| `CACHE_MAX_ENTRIES` | 50 | Max cached files |
| `CACHE_MAX_BYTES` | 25MB | Max total cache memory |

## Benchmark Reference

Cold path = first request after idle/launch. Warm path = steady state.

| Operation | Cold | Warm p50 | Warm p95 |
|-----------|------|----------|----------|
| Diagnose | 49.5ms | 0.13ms | 0.32ms |
| Hover (autodoc) | 0.005ms | 0.005ms | 0.005ms |
| Worker restart | 150ms | — | — |

Hover never involves the Pike worker. Hover latency is constant regardless of
server load or compilation state.
