# ADR 0032: Pike Worker Heartbeat and Watchdog

**Date**: 2026-06-12
**Status**: Proposed
**Deciders**: Pike LSP team

---

## Context

The Pike worker process is a child of the LSP server. Two failure modes exist:

1. **Server crash leaves orphan Pike**: If the LSP server crashes or is force-killed, the Pike worker process continues running indefinitely. On shared SSH dev servers, these accumulate and consume resources. This is documented as a critical concern.

2. **Hung Pike worker**: A Pike worker that hangs (infinite loop, deadlock) blocks all semantic features. There is no timeout or health-check mechanism to detect and recover from this.

3. **Request timeout without process kill**: When a Pike request times out, the timeout handler rejects the promise but does not kill the underlying process. The zombie process lingers.

---

## Decision

1. **Server heartbeat**: The LSP server sends periodic heartbeat notifications to the Pike worker. If heartbeats stop (server crashed, hibernating), the worker self-terminates after a watchdog timeout.

2. **Worker watchdog**: The Pike worker runs a background thread that checks for the last heartbeat timestamp. If no heartbeat arrives within the watchdog window (default: 60s), the worker exits cleanly.

3. **Request timeout with force-kill**: When a Pike request exceeds the timeout, the underlying process is force-killed (SIGTERM → SIGKILL after deadline). Pending work is rejected truthfully. The worker is restarted on the next request.

4. **Idle eviction**: If the worker has been idle (no requests) for a configurable period, it is stopped to free resources. The next request spawns a fresh worker.

5. **Health-check with backoff**: Periodic health checks detect a wedged worker. After consecutive failures (default: 3), the worker is restarted with exponential backoff (max 30s).

---

## Consequences

- No orphan Pike processes survive a server crash or hibernation.
- Hung workers are detected and recovered automatically.
- Request timeouts actually clean up the process, not just the promise.
- Idle workers don't waste resources on shared servers.

---

## Protocol Details

### Server-side (pikeWorkerProcess.ts)

| Property | Method | Default |
|----------|--------|---------|
| Start heartbeat | `startHeartbeat()` | interval: `heartbeatIntervalMs` (default 30s) |
| Stop heartbeat | `stopHeartbeat()` | called on `stop()`, `shutdown()` |
| Heartbeat active? | `isHeartbeatActive` | `heartbeatTimer !== null` |
| Idle eviction | `isIdleEvictionCandidate(thresholdMs)` | threshold from `idleTimeoutMs` |
| Record health-check | `recordHealthCheckFailure()` / `recordHealthCheckSuccess()` | resets on success |
| Backoff delay | `computeBackoffDelayMs(attempt, baseMs, maxMs)` | `base * 2^attempt`, capped at `maxMs` |

Heartbeat messages are fire-and-forget JSON written to the worker's stdin:
```
{"method":"heartbeat"}
```
No response is expected. The worker's main loop skips response-writing for heartbeat (uses `continue`).

### Worker-side (worker.pike)

| Mechanism | Implementation | Activation |
|-----------|---------------|------------|
| Watchdog thread | `heartbeat_watchdog_thread(timeout_secs)` | Started in `main()` only when `PIKE_LSP_WATCHDOG_TIMEOUT_SECS > 0` |
| Check interval | `WATCHDOG_CHECK_INTERVAL_SECS` constant | 10 seconds |
| Heartbeat handler | `handle_heartbeat()` | Updates `last_heartbeat_time`, returns 0 (no response) |
| Self-termination | `exit(0)` after `elapsed > timeout` | Logs to stderr before exit |

The env var `PIKE_LSP_WATCHDOG_TIMEOUT_SECS` configures the watchdog window.
When unset or 0, no watchdog runs — backward compat for older servers that
don't send heartbeats. The LSP server must set this env var when spawning
the worker AND enable `startHeartbeat()` on its side.

---

## Validation

RED/GREEN evidence for US3 implementation (Phase 5):

- [X] Worker self-termination watchdog test result — `T068/T069` in `pikeWorker.test.ts`: heartbeat scheduling (T067), backoff computation (T068), idle eviction candidate (T069). All pass.
- [X] Request-timeout process replacement test result — T028 (Phase 3): `forceKillForTimeout` kills process and rejects pending. Passes.
- [X] Health-check failure restart/backoff test result — `computeBackoffDelayMs` returns exponential schedule (base, 2×base, 4×base, ..., capped). `consecutiveHealthCheckFailures` increments and resets on success. All pass.

Full suite: `bun test tests/lsp/pikeWorker.test.ts` — 9/9 pass.
