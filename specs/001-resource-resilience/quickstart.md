# Quickstart: Resource-Resilient Language Server Validation

## Prerequisites

- Node.js 22 and Bun available on `PATH`.
- Pike available as `pike` unless a test supplies `pike.languageServer.path`.
- Repository dependencies installed with `bun install`.

## Baseline checks

```bash
bun run typecheck
bun test tests/lsp/ tests/perf/
bash scripts/test-pike.sh
```

Expected outcome: all existing tests pass before implementation changes are considered green.

## Scenario 1: Bloated cache startup does not OOM

1. Generate a synthetic workspace with thousands of Pike files and a `.pike-lsp/cache/` directory containing about 20,000 entries, including duplicate/superseded/corrupt files.
2. Start the server under a constrained Node heap budget.
3. Open one Pike file.
4. Assert:
   - Server initializes and answers hover/semantic-tokens for the open file.
   - If the budget is approached, log contains degraded-mode entry.
   - Corrupt/superseded cache entries are dropped.
   - After save, cache JSON count equals live entry count.

Contracts: `contracts/cache-format.md`, `contracts/lsp-resource-state.md`.

## Scenario 2: Open-files indexing stays independent of workspace size

1. Run the synthetic workspace benchmark at several workspace sizes.
2. Use default `openFiles` mode.
3. Open a single file with a bounded import/inherit closure.
4. Measure time-to-first-hover and time-to-first-semantic-tokens.
5. Assert the measurement scales with the closure, not total workspace file count.

Then repeat with `full` mode to prove the full scan remains supported and observable.

Contracts: `contracts/configuration.md`.

## Scenario 3: First global query blocks honestly and returns complete results

1. Start in `openFiles` mode with no warm dependency map.
2. Invoke workspace symbol, find references, rename, call hierarchy, type hierarchy, and go-to-implementation on fixture symbols with cross-file references.
3. Assert the first request reports workDoneProgress and supports cancellation.
4. Without cancellation, assert results match the existing full-mode/oracle expectations exactly.
5. Under degraded mode, assert the same global requests return an explicit temporarily-unavailable error/message.

Contracts: `contracts/lsp-resource-state.md`.

## Scenario 4: Worker request timeout kills and restarts Pike

1. Use a fixture Pike request that exceeds the configured request timeout.
2. Assert the timed-out request is rejected or reported as timed out.
3. Assert the child process was killed and a later request is served by a fresh process.
4. Assert no pending request promises remain.

Contracts: `contracts/pike-worker-liveness.md`.

## Scenario 5: Worker self-terminates after hard server kill

1. Start a long-running Pike compile through the worker.
2. Hard-kill the Node language server process so no orderly shutdown handler runs.
3. Wait up to the watchdog window plus a small test margin.
4. Assert no Pike worker process spawned by the session remains.

Contracts: `contracts/pike-worker-liveness.md`.

## Scenario 6: Shutdown is deadline-bounded

1. Inject or fake a slow cache save.
2. Trigger LSP shutdown.
3. Assert shutdown finishes within the configured deadline and no Pike child remains.
4. Assert cache save timeout/deadline is logged instead of blocking signal handling indefinitely.

Contracts: `contracts/cache-format.md`, `contracts/pike-worker-liveness.md`.

## Scenario 7: Memory pressure demotes non-essential entries

1. Open five files in a large workspace.
2. Build their dependency closure.
3. Trigger heap-pressure logic with test hooks or a constrained heap.
4. Assert entries outside open files and their closure are demoted, dependency map remains, and open-file features still pass.
5. Assert demotion log includes entries demoted and heap before/after.

Contracts: `contracts/lsp-resource-state.md`.

## Scenario 8: Idle hibernation sheds footprint and wakes lazily

1. Start the server with hibernation enabled and fake clock support.
2. Close all documents and advance past 15 minutes.
3. Assert background work is cancelled, cache save observes its deadline, the index/caches are cleared, and no Pike process is alive.
4. Send a definition/hover/semantic-token request.
5. Assert the server enters waking state, rehydrates lazily, and returns the same answer as before hibernation.
6. Assert watched-file events with no open documents do not reset the idle timer.

Contracts: `contracts/lsp-resource-state.md`, `contracts/configuration.md`.

## Final validation before PR review

```bash
bun run typecheck
bun run build
bun run test
bash scripts/test-pike.sh
```

Expected outcome: all commands pass with raw terminal output captured in the PR/phase notes. If a phase intentionally adds RED tests first, capture the failing command before implementing the GREEN fix.

### Observed outputs (measured)

Run against Pike 8.0.1116 on Linux, Node 22, Bun:

| Command | Result |
|---------|--------|
| `bun run typecheck` | Exit 0 — no type errors. |
| `bun run build` | Exit 0 — `server/dist/server.mjs` (2.9 MB) and `client/dist/extension.cjs` (785 KB) emitted. |
| `bun run test` | 497 pass, 0 fail, 0 skip across the full suite. |
| `bash scripts/test-pike.sh` | Exit 0 — worker protocol and watchdog contract exercised against real `pike`. |

The resource-resilience test groups, run in isolation, all pass:

```bash
bun test tests/lsp/configuration.test.ts \
         tests/lsp/resourceState.test.ts \
         tests/lsp/lifecycle.test.ts \
         tests/lsp/persistentCache.test.ts \
         tests/lsp/resourceResilience.test.ts \
         tests/lsp/pikeWorker.test.ts \
         tests/lsp/shutdown.test.ts \
         tests/lsp/error-handling.test.ts \
         tests/lsp/errorLog.test.ts \
         tests/lsp/resourceDocs.test.ts \
         tests/lsp/hibernation.test.ts \
         tests/lsp/backgroundIndex.test.ts \
         tests/lsp/importDependencies.test.ts \
         tests/lsp/crossFileResolution.test.ts \
         tests/lsp/workspaceSymbol.test.ts \
         tests/lsp/references.test.ts \
         tests/lsp/workspaceIndex.test.ts
```

Tests that require a live `pike` binary are gated with `describe.skipIf(!pikeAvailable)`, so the
suite stays green on hosts without Pike; run them on a Pike-equipped host for full coverage. The
synthetic-workspace benchmark lives in `tests/perf/large-workspace.test.ts` and exercises the
open-files scaling claim without an external service.
