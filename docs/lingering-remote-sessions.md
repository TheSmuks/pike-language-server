# Troubleshooting Lingering Remote Sessions

This guide helps diagnose resource-resilience issues with the Pike Language
Server, particularly on shared remote SSH hosts where memory and process
limits are constrained.

## Overview

The Pike LSP implements resource resilience through three mechanisms:

1. **Memory pressure handling** — demotes non-essential index entries when
   heap usage exceeds the budget, dropping to a degraded mode if necessary.
2. **Pike worker liveness** — heartbeat/watchdog protocol detects unresponsive
   or crashed worker subprocesses and restarts them with exponential backoff.
3. **Idle hibernation** — when no documents are open and no requests arrive
   for a configurable idle period, the server hibernates: stops the Pike
   worker, clears in-memory caches, and saves state to disk. It wakes lazily
   on the next request.

## Resource-State Notifications

The server sends `pike/resourceState` notifications to the client on every
state transition. The client displays the current state in the status bar.

| State | Meaning |
|-------|---------|
| `active` | Normal operation — full indexing and worker available. |
| `indexing` | Background indexing or reindexing in progress. |
| `degraded` | Memory pressure — some queries may return degraded-mode errors. |
| `demoted` | Non-essential index entries have been evicted to save memory. |
| `hibernating` | Transitioning to hibernation (saving state, stopping worker). |
| `hibernated` | Idle state — worker stopped, caches cleared, minimal footprint. |
| `waking` | Rehydrating after hibernation in response to a request. |

## Troubleshooting High Memory

**Symptom**: The LSP consumes excessive memory on a shared SSH host.

**Steps**:

1. Check the status bar for `degraded` or `demoted` indicators.
2. Open the Output Channel (View → Output → "Pike Language Server") and look
   for `[resource]` log lines. These show the state transition and the
   measured heap usage:

   ```
   [resource] degraded — reason=memory budget exceeded heapUsedMb=450 heapTotalMb=512
   [resource] demoted — reason=heap pressure demotedCount=42 retainedCount=15
   ```

3. If memory pressure is persistent, consider:
   - Reducing the workspace scope (fewer `.pike` files indexed).
   - Increasing the memory budget via server configuration.
   - Enabling hibernation with a shorter idle timeout.

## Troubleshooting Hibernation

**Symptom**: The server seems unresponsive after being idle, then responds
slowly on first interaction.

**Explanation**: The server hibernates after the idle timeout (default: 15
minutes with no open documents and no activity). The first request after
hibernation triggers a lazy wake — rehydrating the index and restarting the
Pike worker. This adds latency to that first request but is expected behavior.

**Steps**:

1. Check the Output Channel for `[resource] hibernating` and
   `[resource] waking` log lines.
2. If hibernation is too aggressive, increase the idle timeout or disable it
   (set to `0`) via server configuration.
3. A single request after wake does NOT trigger a full reindex — the server
   only does a full reindex after sustained activity, avoiding unnecessary
   work for brief interactions.

## Troubleshooting Worker Crashes

**Symptom**: The Pike worker repeatedly crashes and restarts.

**Steps**:

1. Check the Output Channel for `[worker]` error logs.
2. The server uses exponential backoff after repeated crashes (3 crashes
   triggers a 30-second backoff). During backoff, the server operates in
   degraded mode.
3. If the worker crash is due to resource limits (OOM killed), the hibernation
   and memory-pressure mechanisms should reduce footprint. Check that
   hibernation is enabled.

## Log Output

All server logs go to the VSCode Output Channel under "Pike Language Server".
Use the Output panel to review resource-state transitions, worker events, and
error details. The format is:

```
[HH:MM:SS.mmm] [SERVER] [resource] <state> — reason=<reason> <metrics>
```

Resource event logs are WARN-level and include structured key=value metrics
for grep-friendly filtering.

## Configuration

Resource-resilience behavior is controlled by the server's resource
configuration. Key settings include:

| Setting | Default | Description |
|---------|---------|-------------|
| Memory budget | 512 MB | Max heap before degraded mode triggers. |
| Demotion threshold | 0.80 | Fraction of budget at which demotion begins. |
| Recovery threshold | 0.60 | Fraction at which demotion stops (hysteresis). |
| Idle timeout | 15 min | Inactivity period before hibernation (0 = disabled). |
| Heartbeat interval | 5000 ms | Worker heartbeat frequency. |
| Watchdog timeout | 15000 ms | Worker unresponsive threshold before restart. |

## Indexing

Background indexing runs after workspace initialization and on detected file
changes. Indexing progress is reflected in the `indexing` resource state. If
indexing is slow or stuck, check the Output Channel for errors. The
indexing phase can be cancelled during hibernation and resumed on wake.
