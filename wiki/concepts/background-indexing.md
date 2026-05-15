---
title: Background Indexing
created: 2026-05-15
updated: 2026-05-15
type: concept
tags:
  - background-indexing
  - adr
  - performance
sources:
  - raw/articles/decisions-0022-background-indexing.md
---

# Background Indexing

Workspace features like `workspace/symbol` and cross-file navigation require all
workspace files to be indexed. Without background indexing, only files explicitly
opened by the user get indexed, making workspace-level features incomplete.

The server discovers, parses, and indexes all `.pike` and `.pmod` files in the
workspace on startup **without blocking editor interactions**.

## File Discovery

Uses Bun's `Glob` class to discover files matching `**/*.{pike,pmod}` relative
to the workspace root. Fast and async-native.

## Indexing Strategy

For each discovered file:

1. **Skip** if already indexed (file is open in editor — already has a symbol
   table)
2. **Read** file content from disk
3. **Parse** with tree-sitter
4. **Build** symbol table and upsert into `WorkspaceIndex`

Between files, the indexer **yields to the event loop** using
`setTimeout(resolve, 0)`. This ensures concurrent LSP requests (hover, completion,
diagnostics) are never blocked by the indexing process.

## Progress Reporting

Reports progress via `window/workDoneProgress`:

| Stage | Detail |
|-------|--------|
| Begin | Total file count |
| Report | Every 10 files with percentage |
| End | Final count and error count |

If the client doesn't support `workDoneProgress`, progress is silently skipped.

## Error Handling

Individual file failures (read errors, parse failures) are logged and skipped.
The overall indexing process completes even if some files fail.

## Trigger

Indexing starts in `onInitialized` (after parser initialization). It runs as
**fire-and-forget** — not awaited by the handler. The server is fully functional
during indexing; workspace features gradually improve as more files are indexed.

## Implementation Details

- Uses a dedicated `ModificationSource` value (`BackgroundIndex`) to distinguish
  background-indexed entries from editor-driven entries.
- The `backgroundIndex.ts` module is a standalone feature module with no
  PikeWorker dependency.
- Incremental re-indexing on file changes is handled by `didChangeWatchedFiles`
  notifications from the editor.

## Trade-Offs

| Aspect | Cost | Mitigation |
|--------|------|------------|
| Startup I/O | All workspace files read from disk | Async yielding prevents blocking |
| Memory | Each file's symbol table held in memory | Acceptable for tier-3 scope |
| Staleness | Background entries may lag behind edits | Editor notifications trigger re-index |

## Related

- [[deployment-context]] — shared server constraints that motivate non-blocking design
- [[tier-3-lsp]] — background indexing is capability #10 in scope
- [[pike-worker]] — indexes Pike source files by building symbol tables via the worker
- [[known-limitations]] — staleness on disk changes, inotify limits on Linux
