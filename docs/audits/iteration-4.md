# Architecture Audit — Iteration 4

**Date:** 2026-05-27
**Scope:** Full codebase (server features, server root, client, util)
**Method:** 3 parallel delegated subagents + manual verification of all C/H findings
**Baseline:** typecheck clean, all tests pass, quality-gates.sh run

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 2     |
| High     | 3     |
| Medium   | 7     |
| Low      | 8     |
| **Total** | **20** |

---

## Critical Findings

### C-01: Duplicate background indexing on every startup

- **File:** `server/src/serverLifecycle.ts:322-339`
- **Description:** The unconditional `indexWorkspaceFiles` block at lines 322-339 runs in ADDITION to the branch-scoped calls at line 272 (no-cache path) and line 303 (cache-hit path). This means background indexing runs twice on every startup, doubling CPU, memory, and I/O during initialization.
- **Fix:** Delete the unconditional block at lines 322-339 entirely. Each branch already has its own correctly-scoped `indexWorkspaceFiles` call.

### C-02: CancellationTokenSource never cancelled or disposed

- **File:** `server/src/serverLifecycle.ts:270, 301, 324`
- **Description:** Three `CancellationTokenSource` instances are created but never stored, never cancelled on shutdown, and never disposed. If the server shuts down while background indexing is in progress, the indexing continues running against a closing connection. The tokens are in fire-and-forget `.then()` chains with no way to cancel them.
- **Fix:** Store the CTS in a variable accessible from the shutdown handler and call `.cancel()` + `.dispose()` on shutdown. Or use a single module-level CTS for the init sequence.

---

## High Findings

### H-01: Infinite loop in `collectAutodocLines` on malformed `*/` without matching `/*`

- **File:** `server/src/features/hoverContent.ts:342-349`
- **Description:** `collectAutodocLines()` scans backwards for `//!` autodoc lines. When it encounters `*/` (line 342), it enters an inner `for` loop searching backwards for `/*`. If `/*` is never found (malformed code, `*/` in a string literal, or a `/*` that was never opened), the inner loop completes without `break`, `scanLine` is NOT decremented, and `continue` on line 349 restarts the outer `while` at the same `scanLine` value — processing the same `*/` forever. This hangs the language server process.
- **Fix:** Set `scanLine = -1` as a default before the inner loop, so a missing `/*` breaks the outer loop:
  ```typescript
  if (lineText.endsWith("*/")) {
    scanLine = -1; // bail out if /* not found
    for (let bl = /* save current */; bl >= 0; bl--) {
      if ((lines[bl] ?? "").includes("/*")) {
        scanLine = bl - 1;
        break;
      }
    }
    continue;
  }
  ```

### H-02: `upsertFile` result not awaited in rename handler

- **File:** `server/src/serverFileWatchHandler.ts:160, 172`
- **Description:** `ctx.index.upsertFile(...)` returns `Promise<FileEntry>` but is called without `await` inside the synchronous `reindexRenamedFile` function. If the upsert fails, the error is silently swallowed (unhandled rejection). Also, subsequent dependents may be re-indexed before the rename's upsert completes, creating a race with the index state.
- **Fix:** Make `reindexRenamedFile` async and `await` both `upsertFile` calls. Also make `handleFileRenames` and the `onDidRenameFiles` callback async.

### H-03: Redundant filter condition in `typeHierarchy.ts`

- **File:** `server/src/features/typeHierarchy.ts:189`
- **Description:** Line 189 `if (decl.kind !== "class" && decl.name !== inheritDecl.name) continue;` is a combined OR condition that is immediately re-checked by lines 190-191. The net effect is correct but line 189 is misleading dead code. When line 189 passes, lines 190-191 must re-filter — suggesting a different filter strategy was intended.
- **Fix:** Remove line 189. Lines 190-191 already correctly filter for `class` kind AND name match.

---

## Medium Findings

### M-01: memoryTimer never cleared on shutdown

- **File:** `server/src/serverLifecycle.ts:352-378`
- **Description:** The `setInterval` memory monitor is created inside `handleInitialized` but its handle is local — there's no way to clear it on shutdown. In production this is mitigated by `unref()`, but in tests that create/destroy server instances, the timer leaks.
- **Fix:** Return the timer handle from `handleInitialized` or store it on the context, and clear it in the shutdown handler.

### M-02: `onErrorCountChange` listener accumulates without cleanup (client)

- **File:** `client/extension.ts:355` and `client/errorNotificationState.ts:25`
- **Description:** Every call to `activate()` pushes a new callback to the static `listeners[]` array. The `listeners` array is never cleared on deactivate. Over N window reloads, N callbacks accumulate, each calling `updateStatusBarWithErrors` — causing N redundant status bar updates per error notification.
- **Fix:** Return a dispose function from `onErrorCountChange` and push it onto `context.subscriptions`, or clear the listeners array in `deactivate()`.

### M-03: Client `deactivate()` calls `dispose()` without awaiting `stop()`

- **File:** `client/extension.ts:426-428`
- **Description:** `client.stop()` returns a `Thenable<void>` but `client.dispose()` is called synchronously right after, without waiting for `stop()` to resolve. Per the vscode-languageclient docs, `dispose()` should only be called after `stop()` resolves. This can cause the extension host to log warnings about disposing an active client.
- **Fix:** Return `client.stop().then(() => { client.dispose(); })` or use async/await.

### M-04: `codeLens.ts` accesses `generation` via `(workspaceIndex as any)` instead of public accessor

- **File:** `server/src/features/codeLens.ts:50`
- **Description:** `(workspaceIndex as any).generation as number` bypasses TypeScript's type checking. `WorkspaceIndex` already exposes `getGeneration()` via its context interface (line 81 of workspaceIndex.ts). If `generation` is renamed or changes type, this silently breaks at runtime.
- **Fix:** Use the public accessor: `workspaceIndex.getGeneration()`.

### M-05: `workspaceResolution.ts` non-null assertion on nullable `symbolTable`

- **File:** `server/src/features/workspaceResolution.ts:181`
- **Description:** `const table = targetEntry.symbolTable!;` — `FileEntry.symbolTable` is typed `SymbolTable | null`. The callers check `targetEntry?.symbolTable` before calling, but this function is independently callable and could receive a stale entry with `symbolTable = null`, causing a crash.
- **Fix:** Add a null guard: `const table = targetEntry.symbolTable; if (!table) return null;`

### M-06: `pikeDetection.ts` singleton cache ignores parameter changes

- **File:** `server/src/features/pikeDetection.ts:294-298`
- **Description:** `getPikePaths()` caches its result in `pikePathsPromise` but doesn't compare parameters. Subsequent calls with different `pikeBinaryPath` or `overrides` silently return the stale result. If a user changes the Pike binary path in VSCode settings without a server restart, the old paths persist.
- **Fix:** Add a cache key that includes the parameters:
  ```typescript
  const key = `${workspaceRoot}\0${pikeBinaryPath}\0${JSON.stringify(overrides)}`;
  if (key !== pikePathsKey || !pikePathsPromise) { ... }
  ```

### M-07: First `onDidChangeState` handler not tracked for disposal (client)

- **File:** `client/extension.ts:271`
- **Description:** The initial `client.onDidChangeState(...)` at line 271 is not pushed to `context.subscriptions`. When the config-change handler creates a new client, the old client's state change handler disposable is never disposed.
- **Fix:** Push the initial `client.onDidChangeState(...)` result to `context.subscriptions`.

---

## Low Findings

### L-01: Dead variable `terminatorLine` in unreachableCode lint

- **File:** `server/src/features/lintRules/unreachableCode.ts:103`
- **Description:** Variable `terminatorLine` is declared on line 103 and assigned on line 128 but never read. `foundTerminator` boolean is used instead.
- **Fix:** Remove the variable.

### L-02: Dead export `findEnclosingCallExport` in signatureHelp

- **File:** `server/src/features/signatureHelp.ts:352`
- **Description:** `export function findEnclosingCallExport(...)` is exported but never imported anywhere in the entire project (server code, tests, or scripts).
- **Fix:** Remove the `export` keyword or the function entirely.

### L-03: `xmlParser.ts` JSDoc claims CDATA handling but has no implementation

- **File:** `server/src/features/xmlParser.ts:4, 140`
- **Description:** The module's JSDoc states "Handles: ... CDATA" but the parser has zero CDATA-handling code. If Pike AutoDoc XML ever contains `<![CDATA[...]]>` sections, the `<` in `<![CDATA[` would be consumed by `parseElement()`, producing a garbled node.
- **Fix:** Either add CDATA handling or remove "CDATA" from the JSDoc.

### L-04: `workspaceSymbol.ts` unnecessary null check on typed parameter

- **File:** `server/src/features/workspaceSymbol.ts:53`
- **Description:** `if (query === undefined || query === null) return [];` — `query` is typed `string`. TypeScript enforces this at the call site. Dead code.
- **Fix:** Remove the guard or change the type if the framework can actually send nullish values.

### L-05: Unbounded buffer growth on malformed Pike output

- **File:** `server/src/features/pikeWorkerProcess.ts:249`
- **Description:** If Pike sends continuous output without newlines, `this.buffer` grows without limit until the request timeout fires. The buffer is only trimmed when a newline is found.
- **Fix:** Add a maximum buffer size check (e.g. 1MB) with overflow clearing and error notification.

### L-06: Markdown escaping gap in XML example rendering

- **File:** `server/src/features/xml-renderer-blocks.ts:126`
- **Description:** `renderExample` wraps content in fenced code blocks. If content contains triple backticks, it prematurely closes the markdown code block. Also, the leading `\n` produces a blank line inside the code block.
- **Fix:** Escape backtick sequences in content or use indented code blocks.

### L-07: `typeHierarchy.ts` body containment uses line-only comparison

- **File:** `server/src/features/typeHierarchy.ts:75`
- **Description:** When multiple classes span the same lines, tie-breaking uses only line count without character positions. Could misidentify a class if two start/end on the same lines but at different columns.
- **Fix:** Use character-based size as tiebreaker: `(endLine - startLine) * 10000 + (end.character - start.character)`.

### L-08: `logWarn` Set recreated on every call

- **File:** `server/src/util/errorLog.ts:196`
- **Description:** `new Set(Object.values(ErrorCategory))` is constructed on every `logWarn` call. Small but wasteful.
- **Fix:** Move to a module-level constant.

---

## Automated Baseline (quality-gates.sh)

### Files over 500 lines

| File | Lines | Status |
|------|-------|--------|
| `server/src/features/pikeWorkerProcess.ts` | 592 | Over limit |
| `server/src/features/scope-helpers.ts` | 584 | Over limit |
| `server/src/features/symbolTable.ts` | 523 | Over limit |
| `server/src/features/hoverContent.ts` | 520 | Over limit |
| `server/src/features/workspaceIndex.ts` | 504 | Over limit |

Per project convention, 500-line is a guideline not a gate. These are flagged for awareness.

### Functions over 50 lines (top 10 by line count)

| File | Line | Lines |
|------|------|-------|
| `server/src/serverLifecycle.ts` | 148 | 232 |
| `server/src/features/profiler.ts` | 179 | 116 |
| `server/src/features/diagnosticManager.ts` | 280 | 95 |
| `server/src/features/persistentCache.ts` | 177 | 90 |
| `server/src/features/pikeWorker.ts` | 79 | 88 |
| `server/src/features/xml-renderer-types.ts` | 11 | 86 |
| `server/src/features/rename.ts` | 214 | 87 |
| `server/src/features/completion-scopeAccess.ts` | 18 | 107 |
| `server/src/features/autodocLineRenderer.ts` | 104 | 84 |
| `server/src/features/completion-callArgs.ts` | 34 | 78 |

The 232-line `handleInitialized` in serverLifecycle.ts is the most significant TigerStyle violation. The duplicate indexing block (C-01) inflates this — fixing C-01 would reduce it to ~190 lines.

### rootNode.text materialization (6 sites)

| File | Line | Notes |
|------|------|-------|
| `signatureHelp.ts` | 73 | Fallback when `source` not provided |
| `signatureHelp.ts` | 353 | Same pattern (different function) |
| `selectionRange.ts` | 91 | Splits into lines for line-number lookup |
| `callHierarchy.ts` | 182 | Same: line-number lookup |
| `completion-items.ts` | 277 | Same: line lookup |
| `symbolTable.ts` | 210 | Same: line lookup for comment scanning |

All 6 sites are either fallback paths or need line-level access. The pattern `root.text.split('\n')` is the common form — it materializes the full file string then splits. Could be replaced with a `document.lines` array from the TextDocument if threaded through, but not urgent.

---

## Priority Matrix

| Priority | Finding | Impact | Effort |
|----------|---------|--------|--------|
| 1 | C-01 (duplicate indexing) | Halves startup CPU/memory | Low — delete block |
| 2 | C-02 (CTS leak) | Enables clean shutdown | Low — store + cancel |
| 3 | H-01 (infinite loop) | Server hang on malformed input | Low — add bail-out |
| 4 | H-02 (unawaited upsertFile) | Silent error, race condition | Low — add async/await |
| 5 | M-03 (client dispose race) | Extension host warnings | Low — chain thenable |
| 6 | M-04 (as any generation) | Silent breakage on rename | Low — use getter |
| 7 | M-02 (listener accumulation) | N× redundant updates | Low — clear on deactivate |
| 8 | M-05 (null assertion) | Potential crash | Low — add guard |
| 9 | M-06 (stale cache) | Wrong paths after settings change | Low — add cache key |
| 10 | M-01 (timer leak) | Test-only impact | Low — store handle |
| 11 | H-03, L-01–L-08 | Code quality | Low |

---

## Remediation Status

All 20 findings (2C / 3H / 7M / 8L) have been fixed in this iteration.

| ID | Status | Summary |
|----|--------|---------|
| C-01 | Fixed | Deleted duplicate `indexWorkspaceFiles` block |
| C-02 | Fixed | `backgroundIndexCts` stored on context, cancelled in shutdown |
| H-01 | Fixed | `collectAutodocLines` bails out when `*/` has no matching `/*` |
| H-02 | Fixed | `handleFileRenames` is async, `upsertFile` awaited |
| H-03 | Fixed | Redundant `&& decl.name !== identifier` removed |
| M-01 | Fixed | `memoryTimer` stored on context, cleared in shutdown |
| M-02 | Fixed | `onErrorCountChange` returns dispose fn, pushed to subscriptions |
| M-03 | Fixed | `client.dispose()` chained after `client.stop()` via `.then()` |
| M-04 | Fixed | Public `currentGeneration` getter replaces `(as any).generation` |
| M-05 | Fixed | `symbolTable!` replaced with null guard + early return |
| M-06 | Fixed | `getPikePaths` cache keyed on parameters, invalidates on change |
| M-07 | Fixed | `onDidChangeState` pushed to `context.subscriptions` |
| L-01 | Fixed | Unused `terminatorLine` variable removed |
| L-02 | Fixed | `findEnclosingCallExport` unexported (no external consumers) |
| L-03 | Fixed | xmlParser JSDoc updated (no CDATA support) |
| L-04 | Fixed | Redundant null/undefined guard removed (type already `string`) |
| L-05 | Fixed | 1MB buffer overflow guard in pikeWorkerProcess |
| L-06 | Fixed | `<example>` uses indented code block instead of triple backticks |
| L-07 | Fixed | Type hierarchy tiebreaker uses character-granular size |
| L-08 | Fixed | `ERROR_CATEGORY_VALUES` hoisted to module-level constant |

---

## Excluded (verified acceptable)

- `persistentCache.ts` bare catches: filesystem operations, failure expected
- `moduleResolver.ts` stat() catches: correct existence-check pattern
- `pikeDetection.ts` bare catches: correct binary detection pattern
- `completion-stdlib.ts` Maps: static singleton, populated once from stdlib
- `workspaceIndex.ts` Maps: workspace-bounded, entries evicted on file delete
- `codeLens.ts refCountCache`: generation-keyed with per-URI eviction
- `backgroundIndex.ts` bare catches: expected cleanup failures
