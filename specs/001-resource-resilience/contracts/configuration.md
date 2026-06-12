# Contract: Resource Configuration

## VS Code settings / initialization options

All options are documented, validated at the client/server boundary, and passed explicitly through initialization options.

## Indexing

- `pike.languageServer.indexingMode`: `openFiles` | `full` | `auto`; default `openFiles`.
- `pike.languageServer.fullScanFileLimit`: integer >= 0; default 500.
- `pike.languageServer.dependencyClosureDepthMax`: integer >= 0; default 5.
- `pike.languageServer.dependencyClosureFileCountMax`: integer >= 0; default 200.
- `pike.languageServer.ignoreGlobs`: string array; defaults include common non-source directories.
- `pike.languageServer.maxFileSizeBytes`: integer > 0; default 1,048,576.

Behavior:
- `openFiles`: index opened documents and bounded dependency closure only.
- `full`: discover and index workspace files subject to ignore/size/count caps.
- `auto`: use full only when discovery count is at or below `fullScanFileLimit`; otherwise behave as `openFiles` and log why.

## Memory

- `pike.languageServer.memoryBudgetBytes`: integer > 0, documented default chosen during implementation.
- `pike.languageServer.memoryPressureRatio`: number in `(0, 1]`; default around 0.8.

Behavior:
- Crossing pressure cancels new background/on-demand expansion and demotes non-essential entries.
- Open documents and their already-indexed dependency closure remain functional.

## Pike worker

- `pike.languageServer.workerRequestTimeoutMs`: existing request timeout, positive integer.
- `pike.languageServer.workerIdleTimeoutMs`: default 300,000; `0` disables idle eviction.
- `pike.languageServer.workerHeartbeatIntervalMs`: default 10,000.
- `pike.languageServer.workerWatchdogWindowMs`: default 30,000.
- `pike.languageServer.workerHealthCheckIntervalMs`: positive integer.
- `pike.languageServer.workerFailedHealthCheckLimit`: positive integer.

Behavior:
- Request timeout kills and restarts the worker.
- Missed health checks kill/restart with crash-loop backoff.
- Heartbeats are outbound only and do not count as user activity.

## Hibernation

- `pike.languageServer.hibernateIdleTimeoutMs`: default 900,000; `0` disables.
- `pike.languageServer.hibernateSaveDeadlineMs`: positive integer.
- `pike.languageServer.sustainedActivityDelayMs`: positive integer used before resuming full/auto background scan after wake.

Behavior:
- Hibernation cancels background work, deadline-saves state, clears retained data/caches, stops Pike, and does not exit the process.
