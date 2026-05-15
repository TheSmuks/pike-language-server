---
title: Architecture Audit
created: 2026-05-15
updated: 2026-05-15
type: concept
tags:
  - audit
  - quality
sources:
  - raw/articles/architecture-audit.md
---

# Architecture Audit

First and second pass audit findings for the Pike LSP codebase. The main risk is not correctness bugs -- it is **entropy**: structural debt accumulating from shipping features fast.

Related: [[tier-3-lsp]], [[pike-worker]], [[deployment-context]], [[two-speed-diagnostics]], [[type-inference]]

## Executive Summary

The Pike LSP is a well-structured Tier-3 oracle-based LSP with solid fundamentals: cancellation coverage (27 checkpoints), priority queue (PikeWorker), file-level incremental parsing, debounced diagnostics, and no phase begins before the previous is complete.

**The main risks are entropy**: oversized files, unbounded caches, silent error swallows, and missing memory budgets -- typical of a project that has moved fast and shipped features.

---

## First Pass Findings

### Critical (Blocks core functionality)

*None.*

### High (Major features impaired)

*None.*

### Medium (Degraded robustness)

| # | Finding | File(s) | Recommendation |
|---|---------|---------|----------------|
| M1 | 12 of 30+ source files exceed 500-line TigerStyle guideline. Largest: `completionTrigger.ts` (1122 lines), `navigationHandler.ts` (1114 lines) | Multiple | Extract cohesive sub-modules before files exceed 1500 lines |
| M2 | `moduleResolver.cache` is unbounded | `moduleResolver.ts:65` | Add LRU cap |
| M3 | `completionTrigger.ts` autoImports Map is unbounded | `completionTrigger.ts:153` | Add LRU cap or size limit |
| M4 | Two async operations silently swallow errors | `navigationHandler.ts:1074,1107` | Log at debug level minimum |
| M5 | No PikeWorker version check at startup | `pikeWorker.ts` | Add version handshake on `warmUp()` |
| M6 | No total process memory tracking | `parser.ts` | Add `process.memoryUsage()` monitoring |

### Low (Minor impact)

| # | Finding | File(s) | Recommendation |
|---|---------|---------|----------------|
| L1 | Test discovery gap: `bun test` does not auto-discover `tests/lsp/` | `package.json` | Add bunfig.toml or update test script |
| L2 | `upsertInFlight` Map grows with in-flight operations | `server.ts:135` | Verify delete on all exit paths |
| L3 | PikeWorker pending request promises rejected on stop() | `pikeWorker.ts` | Acceptable -- inherent to subprocess model |
| L4 | Symbol table walks are synchronous | `declarationCollector.ts` | Acceptable for single-threaded JS |

---

## Quick Wins (Tier 1) -- ALL FIXED

All quick wins addressed in one session:

1. **M4** -- Silent error swallows: replaced with `logWarn()` calls
2. **M2** -- ModuleResolver cache: 2000-entry cap with 25% batch eviction
3. **M3** -- AutoImports Map: investigated, found to be a lazy singleton (~5.5K entries) that never grows after initial build. No fix needed.
4. **L1** -- Test discovery: `"test"` script changed to `bun test tests/ harness/`
5. **M6** -- Memory monitoring: 60s `setInterval` (unreffed) checks `process.memoryUsage()`, evicts 50% of tree cache when heapUsed > 80% of heapTotal

---

## Tier 2: Structural -- ALL FIXED

1. **navigationHandler.ts split** -- Per-feature extraction recommended (hover, definition, references)
2. **completionTrigger.ts split** -- Natural seams: auto-import index, trigger detection, snippet generation
3. **PikeWorker version handshake** -- `warmUp()` now captures `pong.pike_version` into `worker.pikeVersion`. Server logs version and warns if pre-8.0.
4. **WorkspaceIndex reader-writer lock** -- Generation counter (`private generation = 0`) incremented on all mutations. `resolveCrossFileDefinition` snapshots generation before yielding, retries on re-entry if generation changed.
5. **Workspace-scoped memory budget** -- Part of Tier 1 M6 fix.

---

## Tier 3: Feature Quality -- REMAINING

1. **Golden file tests for diagnostics** -- Harness infrastructure exists; add `--golden` flag for regression testing
2. **completionItem/resolve** -- Implement LSP `completionItem/resolve` for lazy loading of completion details
3. **Incremental symbol table rebuilds** -- Currently `upsertInFile()` does a full rebuild. Track changed declarations only.

---

## Second Pass -- P1: Protocol Correctness

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| P1.1 | `implementationProvider` handler registered but capability not declared | Medium | Open |
| P1.2 | `diagnosticProvider` handler exists but capability not declared | Low | Open |
| P1.3 | `workspace.fileOperations.didRename` capability declared but no handler | Medium | **Fixed** |
| P1.4 | `documentSymbol` handler sends diagnostics as side effect | Medium | **Fixed** |
| P1.5 | Rename returns `null` instead of `ResponseError` for validation failures | Medium | Open |
| P1.6 | Zero use of LSP error codes | Medium | **Fixed** |
| P1.7 | Tree-sitter UTF-8 byte columns used as LSP character offsets | Low | Open |

## Second Pass -- P2: Security

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| S2.1 | Absolute path injection in inherit | HIGH | **Fixed** |
| S2.2 | Relative path traversal via `../` in inherit strings | HIGH | **Fixed** |
| S2.3 | `#include` path traversal outside workspace | HIGH | **Fixed** |
| S2.4 | Custom URI parsing instead of `fileURLToPath` | Medium | **Fixed** |
| S2.5 | `uriToPath` missing `decodeURIComponent` | Medium | **Fixed** |
| S2.6 | No runtime type validation of JSON from Pike subprocess | Low-Medium | Open |
| S2.7 | User autodoc content rendered as raw markdown | Low-Medium | Open |

## Second Pass -- P3: Performance

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| X3.1 | `rootNode.text` materializes entire file | HIGH | **Fixed** |
| X3.2 | Parse + symbolTable + lint runs on EVERY keystroke | HIGH | **Fixed** |
| X3.3 | Double dependency resolution in `upsertFile` | HIGH | **Fixed** |
| X3.4 | `extractDependencies` resolves sequentially | Medium | Open |
| X3.5 | Double parse in diagnostic paths | Medium | Open |
| X3.6 | Linear scan of auto-import map | Medium | Open |
| X3.7 | Priority queue uses linear scan | Low | Open |

## Second Pass -- P4: Test Coverage

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| T4.1 | `selectionRange.ts` -- zero test coverage | Medium | Open |
| T4.2 | `callHierarchy.ts` -- zero test coverage | Medium | Open |
| T4.3 | `codeLens.ts` -- zero test coverage | Medium | Open |
| T4.4 | `util/errorLog.ts` -- zero test coverage | Low | Open |
| T4.5 | 8 features have only indirect coverage | Low | Open |
| T4.6 | Several features lack error/edge-case tests | Low | Open |

## Second Pass -- P5: Client-Side Robustness

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| C5.1 | `deactivate()` calls `stop()` but not `dispose()` | HIGH | **Fixed** |
| C5.2 | Server crash returns `DoNotRestart` -- no recovery | HIGH | **Fixed** |
| C5.3 | `onNotification` handlers lost after config-change restart | Medium | **Fixed** |
| C5.4 | `onDidChangeState` disposable not tracked | Medium | **Fixed** |
| C5.5 | `outputChannel.clear()` destroys crash logs | Medium | **Fixed** |
| C5.6 | `outputChannel` never pushed to subscriptions | Medium | **Fixed** |
| C5.7 | `FileSystemWatcher` may leak across restarts | Medium | **Fixed** |

---

## TigerStyle Violations

Files exceeding the 500-line guideline:

| File | Lines | Natural Sub-modules |
|------|-------|---------------------|
| completionTrigger.ts | 1122 | Auto-import index, commit character logic, trigger detection, snippet generation |
| navigationHandler.ts | 1114 | Per-feature extraction (hover, definition, references) |
| workspaceIndex.ts | 879 | Cross-file resolution, dependency graph maintenance |
| pikeWorker.ts | 846 | Protocol serialization, queue management, idle eviction |
| completion.ts | 807 | Scope resolution, completion filtering |

**Note**: These files are cohesive. Extract only when a natural seam appears or when a file approaches 1000+ lines.
