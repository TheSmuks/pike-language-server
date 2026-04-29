# 0018 — Incremental Parsing and IPC Security

**Date:** 2026-04-28
**Status:** Accepted
**Supersedes:** Partially amends 0011 (PikeWorker), 0013 (DiagnosticManager)

## Context

An architectural audit identified three classes of defects:

1. **Performance**: `parser.ts` performed a full tree-sitter re-parse on every keystroke, discarding the previous AST. Tree-sitter's primary value for an LSP is incremental re-parsing (typically < 1ms), but the code never passed the old tree to `parser.parse(newText, oldTree)`.

2. **IPC Safety**: `worker.pike` used raw string interpolation for `typeof` queries (`source + "\nstring _typeof_result = typeof(" + expr + ");\n"`), allowing IDE input to inject arbitrary Pike statements. `pikeWorker.ts` had no FIFO queue — multiple concurrent callers could interleave writes to stdin, corrupting the JSON stream. stdin writes ignored Node.js backpressure.

3. **Type Hygiene**: `diagnostics.ts` and `documentSymbol.ts` defined their own `Position`, `Range`, `DiagnosticSeverity`, and `Diagnostic` types that were structurally compatible with `vscode-languageserver` but not the same types. This worked only due to TypeScript's structural typing.

All three issues conflict with the shared-server deployment constraints (decision 0011): resource waste affects other users, IPC corruption causes cascading failures, and type drift makes maintenance harder.

## Decision

### 1. Incremental Parsing with LRU Tree Cache

`parser.ts` now maintains a `Map<uri, Tree>` with:
- **LRU eviction**: 50-entry cap, ~50 MB byte ceiling.
- **Automatic incremental parsing**: `parse(source, uri)` retrieves the old tree from cache and passes it to `parser.parse(source, oldTree)`.
- **Explicit eviction on didClose**: `deleteTree(uri)` frees memory immediately.
- **Shutdown cleanup**: `clearTreeCache()` deletes all trees.

Every call site in `server.ts` now passes the URI to `parse()`:
- `didChange`, `onDocumentSymbol`, `onCompletion`, `resolveAccessCore`, `getSymbolTable`.
- `diagnosticManager.onDidChange` also passes URI.

`diagnosticManager.safeParseDiagnostics()` intentionally does NOT pass a URI — it's used for cache-hit diagnostics where a fresh parse is fine and caching is unnecessary.

### 2. PikeWorker FIFO Queue and Backpressure

The FIFO queue moved from `DiagnosticManager` to `PikeWorker`:

- **Single queue**: All public methods (`diagnose`, `autodoc`, `typeof_`, `ping`) go through `enqueue()`.
- **One-at-a-time**: `drainQueue()` sends exactly one item to stdin, waits for completion, then sends the next.
- **Backpressure**: `writeToStdin()` returns a Promise. If `stdin.write()` returns `false`, the promise waits for the `drain` event before resolving.
- **Process exit safety**: The exit handler compares the exiting process against `this.proc` to avoid rejecting requests from a new process spawned during a restart cycle.

`DiagnosticManager` no longer has a priority queue. The PikeWorker queue is sufficient — diagnostics are already debounced at the DiagnosticManager level, so only one diagnose request per file is in flight at a time.

### 3. typeof Injection Mitigation

`worker.pike` `handle_typeof()` now:
- Rejects expressions containing `;`, `\n`, or `\r`.
- Uses a function wrapper `mixed _typeof_get() { return typeof(expr); }` instead of storing into a variable.
- Still interpolates the expression, but `typeof()` is a compile-time type query — it returns a type string, not executable code. The semicolon/newline rejection prevents statement injection.

### 4. Type Hygiene

`diagnostics.ts` and `documentSymbol.ts` now import `Diagnostic`, `DiagnosticSeverity`, `Range`, `Position`, `DocumentSymbol`, and `SymbolKind` directly from `vscode-languageserver/node`. No more duplicate type definitions.

Tests that compared against `SymbolKind` values needed explicit `number[]` / `Set<number>` typing to satisfy TypeScript's const-enum narrowing.

## Consequences

**Positive:**
- Parsing cost drops from full re-parse to incremental diff on every keystroke.
- IPC is safe from concurrent write corruption.
- Type system catches mismatches between our code and the LSP library.
- stdin backpressure prevents silent data loss under load.

**Negative:**
- Tree cache uses ~50 MB (bounded). Acceptable for shared-server deployment.
- The typeof expression whitelist (no semicolons/newlines) rejects some valid Pike expressions that span multiple lines. This is acceptable — multi-line typeof queries are not a realistic use case for an IDE.
- FIFO queue adds ~0.1ms latency per request for the serialization check. Negligible.

## Testing

- Existing pikeWorker tests (10 tests) pass with the new FIFO queue.
- New FIFO integration tests: concurrent diagnose/ping/autodoc, distinct payload verification, strict_types error line-number accuracy.
- All 792 LSP tests pass, all 520 harness tests pass.
