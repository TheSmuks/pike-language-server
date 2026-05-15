---
title: Deployment Context
created: 2026-05-15
updated: 2026-05-15
type: concept
tags:
  - deployment
  - performance
sources:
  - raw/articles/deployment-context.md
---

# Deployment Context: SSH on Shared Server

The Pike Language Server deploys via VSCode Remote-SSH to a shared Linux server where multiple developers work concurrently. This constraint affects every resource-sensitive design decision.

Related: [[pike-worker]], [[ci-architecture]]

## Key Constraints

### Shared CPU

N coworkers compete for CPU. Pike compilation is CPU-intensive. Under contention, one user's slow compile should not block others' editor responsiveness.

**Mitigation:** `nice +5` on the Pike worker subprocess.

### Shared Memory

Each Pike worker process consumes memory. An idle worker is wasted memory that compounds across N users.

**Mitigation:** Idle eviction after 5 minutes of no requests.

### Finite inotify Watches

`fs.inotify.max_user_watches` is a system-wide limit. N users x M watches would exhaust the limit.

**Mitigation:** Server relies entirely on editor-pushed notifications (didChange, didSave, didClose). No server-side file watchers.

### Network Latency

VSCode Remote-SSH adds 20-100ms of round-trip latency. LSP requests that feel instant locally may feel sluggish over SSH.

**Mitigation:** Hover is parse-tree driven (sub-millisecond) specifically to avoid this. Completion routes through tree-sitter and AutoDoc only (no Pike worker) for sub-millisecond response.

### Per-User Cost Multiplication

Each open VSCode window is a separate LSP server instance. A coworker with 5 windows creates 5 Pike workers, 5 caches, 5 sets of indexed files.

**Mitigation:** Cache caps and idle eviction prevent unbounded growth.

---

## PikeWorker Configuration

All values configurable via `PikeWorkerConfig`:

| Parameter | Default | Purpose |
|-----------|---------|---------|
| `idleTimeoutMs` | 300000 (5 min) | Kill worker after this idle time |
| `maxRequestsBeforeRestart` | 100 | Force restart after this many requests |
| `maxActiveMinutes` | 30 | Force restart after this many active minutes |
| `requestTimeoutMs` | 5000 (5s) | Per-request timeout |
| `niceValue` | 5 | Linux nice value for Pike subprocess |

PikeWorker idle eviction uses SIGTERM -> SIGKILL escalation. Pending request promises are rejected on stop().

---

## Cache Limits

Cache limits in `server.ts`:

| Constant | Default | Purpose |
|----------|---------|---------|
| `CACHE_MAX_ENTRIES` | 50 | Max cached files |
| `CACHE_MAX_BYTES` | 25MB | Max total cache memory |

Memory monitoring: 60s interval checks `process.memoryUsage()`. When heapUsed > 80% of heapTotal, logs warning with cache stats and evicts 50% of tree cache.

---

## Phase Implications

### Phase 5 (Types and Diagnostics)

- Save-only diagnostics avoid real-time compilation over SSH
- AutoDoc extraction is parse-tree driven, no Pike subprocess
- Pike worker has idle eviction, memory ceiling, and nice value
- Timeout surfaced as diagnostic rather than silently dropped
- LRU cache caps at 50 entries / 25MB per server instance

### Phase 6 (Debouncing, Completion, Rename)

- **Completion**: Latency-sensitive. Route through tree-sitter and AutoDoc only (no Pike worker) for sub-millisecond response. Accept lower-quality results in exchange for responsiveness.
- **Debouncing**: Must account for FIFO queueing through the Pike worker. Tune the debounce interval to minimize queue contention.
- **Rename/code actions**: Can use Pike worker for validation (save-triggered) but not for real-time feedback. Rename previews may be stale.

---

## Benchmark Reference

Cold path = first request after idle/launch. Warm path = steady state.

### Diagnostics

| Operation | Cold | Warm p50 | Warm p95 |
|-----------|------|----------|----------|
| Diagnose | 49.5ms | 0.13ms | 0.32ms |
| Worker restart | 150ms | -- | -- |

### Hover (AutoDoc)

| Operation | Cold | Warm |
|-----------|------|------|
| PikeExtractor (in-process) | 0.58ms | 0.48ms |
| XML rendering (TypeScript) | 0.29ms/symbol | 0.29ms/symbol |
| Stdlib lookup (hash table) | -- | <0.01ms |
| Hover hot path (cache hit) | -- | ~0.3ms/symbol |

Hover hot path never calls the Pike worker -- it reads from the XML cache. Hover cold path calls worker.autodoc() once per file content change, then caches.
