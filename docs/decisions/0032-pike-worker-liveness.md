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

## Validation

RED/GREEN evidence to be filled after US3 implementation (Phase 5):
- [ ] Worker self-termination watchdog test result
- [ ] Request-timeout process replacement test result
- [ ] Health-check failure restart/backoff test result
