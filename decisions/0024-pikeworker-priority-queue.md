# Decision 0024: PikeWorker Priority Queue

**Date**: 2026-05-12
**Status**: Accepted

## Context

The PikeWorker used a strict FIFO queue. All requests — interactive (hover, completion) and background (diagnostics) — were treated equally. On large workspaces, a burst of diagnostic requests could delay an interactive completion request, causing visible latency for the user.

gopls and rust-analyzer both prioritize user-facing requests over background work.

## Decision

Convert the PikeWorker queue from FIFO to priority-based.

Three priority levels:
- **interactive** (0): typeof_, autodoc, resolve — used by hover, completion, navigation
- **normal** (1): default for other requests
- **background** (2): diagnose — used by the diagnostic manager

The drain loop scans the queue for the lowest priority number and sends that item first. Within the same priority level, FIFO order is preserved.

## Consequences

- Interactive requests are never queued behind a backlog of diagnostics.
- The scan is O(n) per drain, but the queue is typically small (<10 items).
- `headIdx` field removed — no longer needed since items are picked by priority, not by head position.
- Public API unchanged — priority is an internal implementation detail of enqueue().
