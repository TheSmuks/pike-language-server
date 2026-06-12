# Contract: LSP Resource State and User Signals

## Server-to-client notification

Notification method: `pike/resourceState`.

Payload fields:
- `state`: `normal` | `indexing` | `degraded` | `hibernating` | `hibernated` | `waking`.
- `message`: short user-facing text for status bar.
- `reason`: machine-readable reason.
- `startedAtMs`: timestamp.
- `details`: optional object for metrics such as `heapUsedBytes`, `heapLimitBytes`, `entriesDemoted`, `filesIndexed`, `filesTotal`.

Client behavior:
- Show persistent states in a non-intrusive status-bar item.
- Do not show modal notifications for routine resource transitions.
- Clear to `normal` when the server sends `normal`.

## WorkDoneProgress

Long operations that block a specific request must use workDoneProgress when supported:
- First global query preparing dependency map/declarations index.
- Full-mode background indexing.
- Wake/rehydration when it blocks a request.

Cancellation:
- Cancellation stops candidate expansion at safe boundaries.
- Cancelled global preparation must not cache partial results as complete.

## Degraded global feature behavior

When `state=degraded`, global features that require new candidate expansion return explicit unavailability:
- Workspace symbol: return protocol error or documented unavailable result with message `temporarily unavailable under memory pressure`.
- Find references/rename/hierarchies/implementation: same message and no partial success.

Open-file hover/completion/diagnostics/semantic tokens over already-indexed closure remain available.

## Operational logs

Required log events:
- degraded-mode entry/exit, including heap/budget reason.
- memory demotion, including entries demoted and heap before/after.
- indexing mode choice and auto-mode fallback reason.
- worker timeout, force-kill, restart, health-check failures, and backoff.
- hibernation enter/exit/wake and save-deadline expiry.
- cache migration/prune counts.

Format follows project logging convention: literal `[INFO]`, `[WARN]`, `[ERROR]`, `[DEBUG]`; no emoji.
