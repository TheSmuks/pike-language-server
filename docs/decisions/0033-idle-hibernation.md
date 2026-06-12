# ADR 0033: Idle Hibernation Without Server Self-Exit

**Date**: 2026-06-12
**Status**: Proposed
**Deciders**: Pike LSP team

---

## Context

VSCode Remote sessions can stay idle for hours or days. The LSP server process keeps the Pike worker running, all index entries in memory, and the cache open. On shared SSH dev servers with many users, this is a significant resource drain.

A previous version of the server would exit after sustained idle, relying on VSCode to restart it on next request. This is fragile: some VSCode Remote configurations do not reliably restart a self-exited server, leaving the user without language features.

---

## Decision

1. **Hibernate, don't exit**: After a configurable idle threshold (default: 10 minutes), the server enters hibernation:
   - Cancels background indexing and on-demand work.
   - Saves the cache with a deadline (best-effort, bounded).
   - Clears in-memory index entries (the dependency map and cache stubs remain).
   - Stops the Pike worker (no heartbeat, no process).

2. **Lazy wake**: The server process stays alive. On the next request, a lazy wake gate rehydrates open-file entries from cache/source before processing. Full/auto re-indexing resumes only after sustained activity, not on a single wake-up request.

3. **File-watch independence**: Watched-file events do NOT reset the idle timer when no documents are open. External edits are noted but don't keep the server awake.

4. **Honest degradation during wake**: During rehydration, features that need global state return honest "temporarily unavailable" errors rather than stale results.

---

## Consequences

- Idle remote sessions drop to near-zero footprint (no Pike process, minimal heap).
- The server process never exits — VSCode Remote reliability is preserved.
- First request after hibernation has a rehydration latency penalty.
- Full workspace indexing resumes gradually after sustained activity.

---

## Validation

- 14 hibernation state-machine tests pass (`bun test tests/lsp/hibernation.test.ts`)
- 497 total tests pass with 0 failures after integration
- Typecheck passes (`bun run typecheck`)
- No-self-exit rationale: the LSP process stays alive during hibernation. Only
  the Pike worker subprocess is killed and the in-memory index is cleared. This
  is required for VSCode Remote reliability — VSCode does not auto-restart
  crashed LSP servers in remote sessions.
- [ ] Fake-clock hibernation transition test result
- [ ] Post-hibernation lazy wake correctness test result
- [ ] Watched-file-events-do-not-reset-idle test result
