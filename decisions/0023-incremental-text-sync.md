# Decision 0023: Incremental Text Document Sync

**Date**: 2026-05-12
**Status**: Accepted

## Context

The server used `TextDocumentSyncKind.Full`, meaning the client sends the entire document content on every keystroke. For a 5,000-line file (~250KB), this means 250KB transferred per keystroke over the stdio transport.

gopls and rust-analyzer both use `TextDocumentSyncKind.Incremental`, where the client sends only the changed range (~100 bytes per edit).

## Decision

Switch from Full to Incremental sync.

`vscode-languageserver-textdocument` (already in use) transparently handles incremental edits — it merges them into the full document internally. `doc.getText()` continues to work unchanged. No handler modifications needed.

## Consequences

- Lower latency on large files: ~100 bytes per edit instead of full document transfer.
- No handler changes required — the TextDocuments manager handles the merge.
- Parser receives the full text via `doc.getText()`, so incremental re-parsing (old-tree reuse) continues to work as before.
- The client must support incremental sync (all modern LSP clients do).
