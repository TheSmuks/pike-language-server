# Contract: Pike Worker Liveness

## Scope

Defines the lifecycle contract between the TypeScript LSP server and `harness/worker.pike`.

## Server responsibilities

- Spawn at most one worker per LSP server instance unless future work explicitly changes the architecture.
- Serialize requests through the existing FIFO/priority queue.
- Send outbound heartbeats at `workerHeartbeatIntervalMs` only while the worker is alive.
- Do not count heartbeats as user activity for idle eviction or hibernation.
- Stop heartbeats before/when stopping the worker.
- On request timeout, remove the pending request, force-kill the worker, reject queued work truthfully, and start a fresh worker for later requests.
- On failed health-check threshold, mark worker wedged, kill/restart with backoff, and log the event.
- On shutdown/hibernation, terminate the worker within the configured deadline.

## Worker responsibilities

- Track the monotonic time of the last heartbeat received from the server.
- Run a watchdog that can fire even while the main worker is in a long compile/request.
- Exit the Pike process when no heartbeat has arrived within `workerWatchdogWindowMs`.
- Keep end-of-input detection as a fallback, not the primary orphan defense.

## Protocol messages

Request methods remain newline-delimited JSON. Heartbeat may be represented as either:
- a dedicated lightweight method that the worker handles without resetting request activity, or
- an out-of-band line/control message documented in the worker implementation.

The chosen representation must be covered by Pike worker protocol tests.

## Required test evidence

- A timed-out request kills and replaces the underlying process.
- A hard-killed Node server leaves no Pike worker after the watchdog window.
- Idle eviction stops the worker and no subsequent heartbeat restarts it.
- Crash-loop backoff still prevents rapid repeated respawn.
