# 0022: Background Workspace Indexing

**Status**: Accepted
**Date**: 2026-04-30
**Decision Maker**: LSP team

## Context

Workspace features like `workspace/symbol` and cross-file navigation require all workspace files to be indexed. Without background indexing, only files explicitly opened by the user get indexed, making workspace-level features incomplete.

The server needs to discover, parse, and index all `.pike` and `.pmod` files in the workspace on startup without blocking editor interactions.

## Decision

### File Discovery

Use Bun's `Glob` class to discover files matching `**/*.{pike,pmod}` relative to the workspace root. This is fast and async-native.

### Indexing Strategy

Index each discovered file by:
1. Skip if already indexed (file is open in editor)
2. Read file content from disk
3. Parse with tree-sitter
4. Build symbol table and upsert into WorkspaceIndex

Yield to the event loop between files using `setTimeout(resolve, 0)` to avoid blocking concurrent LSP requests.

### Progress Reporting

Report progress via `window/workDoneProgress`:
- Begin: total file count
- Report: every 10 files with percentage
- End: final count and error count

If the client doesn't support workDoneProgress, progress is silently skipped.

### Error Handling

Individual file failures are logged and skipped. The overall indexing process completes even if some files fail.

### Trigger

Indexing starts in `onInitialized`, after parser initialization. It runs as fire-and-forget (not awaited by the handler).

**MUST**:
- Index all workspace .pike/.pmod files on startup
- Not block concurrent LSP requests
- Handle file read/parse failures gracefully
- Skip already-indexed files

**SHOULD**:
- Report progress to the client
- Log indexing completion status

**MAY**:
- Support incremental re-indexing on file changes (currently handled by didChangeWatchedFiles)

## Consequences

### Positive
- Workspace/symbol and cross-file navigation work immediately after startup
- No user action required to populate the index

### Negative
- Startup I/O for large workspaces (mitigated by async yielding)
- Memory usage scales with workspace size (each file's symbol table is held in memory)

### Neutral
- Uses a new ModificationSource value (BackgroundIndex) to distinguish background-indexed entries
- The `backgroundIndex.ts` module is a standalone feature module with no PikeWorker dependency

## Alternatives Considered

### Lazy indexing on demand
Only index files when workspace/symbol is first requested. This delays the first query and makes it expensive. Background indexing amortizes the cost at startup.

### Separate worker process
Run indexing in a separate process to avoid any event loop contention. This adds complexity (IPC, state sync) for marginal benefit given the yield-between-files approach.
