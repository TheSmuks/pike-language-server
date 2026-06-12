# ADR 0031: Lazy Indexing and Dependency Map

**Date**: 2026-06-12
**Status**: Proposed
**Deciders**: Pike LSP team

---

## Context

The server currently indexes all Pike files in the workspace on startup (full mode). For large workspaces (thousands of files), this causes:

1. **Slow startup**: Time-to-first-hover scales linearly with workspace size because the entire workspace must be indexed before any feature is usable.

2. **Unbounded memory**: All symbol tables are held in memory regardless of whether the user will ever query them.

3. **Global feature blocking**: Workspace symbol search, rename, and references require a complete index. If indexing is incomplete, these features return stale or partial results.

---

## Decision

1. **Default indexing mode: `openFiles`**: On startup, index only currently open documents and their bounded dependency closure (import targets). This makes startup O(open files × dependency depth), not O(workspace).

2. **Preserved modes**: `full` (index everything) and `auto` (index open files first, then background-scan the rest) remain supported for users who need full global features immediately.

3. **Lightweight dependency map**: Maintain a forward/reverse dependency map at all times — even when full symbol data is demoted or never loaded. This enables correct cross-file resolution and dependency-based invalidation without retaining all symbol tables.

4. **Lazy global preparation**: Global features (workspace symbol, rename, references, hierarchy, implementation) prepare the global index on-demand with a progress token. If the user cancels, partial results are returned honestly.

5. **Yielding**: Background indexing batches yield between batches so on-demand requests are never starved.

---

## Consequences

- Default startup is fast regardless of workspace size.
- Global features have slightly higher latency on first use (on-demand preparation) but are always correct.
- Dependency map enables precise invalidation without full symbol retention.
- Full-mode users see no regression.

---

## Validation

RED/GREEN evidence to be filled after US2 implementation (Phase 4):
- [ ] Time-to-first-hover benchmark: openFiles vs full mode
- [ ] Cross-file feature correctness across indexing modes
- [ ] Dependency-closure depth/count cap validation
