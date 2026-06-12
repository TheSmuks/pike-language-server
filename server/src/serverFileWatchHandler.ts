/**
 * File watcher and rename handlers — registered on the LSP connection.
 *
 * Extracted from server.ts to keep createPikeServer under the 50-line
 * TigerStyle function limit.
 */

import type { Connection } from "vscode-languageserver/node";
import { FileChangeType } from "vscode-languageserver/node";
import { parse, deleteTree } from "./parser";
import { ModificationSource } from "./features/workspaceIndex";
import type { ServerContext } from "./serverContext";

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Register file watcher and rename handlers on the connection. */
export function registerFileWatchHandlers(
  connection: Connection,
  ctx: ServerContext,
): void {
  connection.onDidChangeWatchedFiles((params) => {
    handleWatchedFilesChange(ctx, params.changes);
  });

  // Handle file renames — the file watcher sends Created/Deleted but
  // that loses the old→new mapping needed for dependency propagation.
  (connection as any).onDidRenameFiles?.(async (params: { files: Array<{ oldUri: string; newUri: string }> }) => {
    await handleFileRenames(ctx, params.files);
  });
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface FileEvent {
  uri: string;
  type: FileChangeType;
}

function handleWatchedFilesChange(
  ctx: ServerContext,
  changes: readonly FileEvent[],
): void {
  // Watched-file events do NOT reset the idle timer when no documents are open.
  // They only count as activity if documents ARE open (the editor is in use).
  ctx.hibernationManager.onWatchedFileEvent();

  for (const event of changes) {
    const uri = event.uri;
    switch (event.type) {
      case FileChangeType.Created:
      case FileChangeType.Changed:
        handleFileCreatedOrChanged(ctx, uri);
        break;
      case FileChangeType.Deleted:
        handleFileDeleted(ctx, uri);
        break;
    }
  }
}

function handleFileCreatedOrChanged(
  ctx: ServerContext,
  uri: string,
): void {
  // Capture dependents BEFORE removing the file — removeFile clears the
  // reverse-dependency map entries, so getDependents would return empty after.
  const dependents = ctx.index.getDependents(uri);

  ctx.index.removeFile(uri);
  ctx.pikeCache.delete(uri);
  ctx.autodocCache.delete(uri);

  // Invalidate global prep — the workspace is no longer guaranteed complete.
  // The next global query (workspace symbol, references, etc.) will re-scan
  // to pick up this changed file. Per contracts/lsp-resource-state.md, this
  // keeps lazy indexing honest: the index reflects the actual workspace state.
  ctx.index.invalidateGlobalPrep();

  // File not open in editor — the on-demand indexer will re-index it
  // when cross-file queries need it (file watchers only provide URIs,
  // not content). Open files are managed by the didChange handler.

  // Invalidate and refresh open dependents so they pick up the external change.
  propagateDependentInvalidation(ctx, dependents);
}

function handleFileDeleted(
  ctx: ServerContext,
  uri: string,
): void {
  // Capture dependents before removing — same pattern as handleFileCreatedOrChanged.
  const dependents = ctx.index.getDependents(uri);

  ctx.index.removeFile(uri);
  deleteTree(uri);
  ctx.pikeCache.delete(uri);
  ctx.autodocCache.delete(uri);
  ctx.diagnosticManager.onDidClose(uri);

  // Invalidate global prep — the workspace file set has changed.
  ctx.index.invalidateGlobalPrep();

  // Invalidate and refresh open dependents — they now have a broken dependency.
  propagateDependentInvalidation(ctx, dependents);
}

/**
 * Propagate invalidation to dependents after a file is removed or changed.
 *
 * Shared by handleFileCreatedOrChanged and handleFileDeleted. Invalidates
 * each dependent's symbol table, clears pike/autodoc caches (so stale
 * diagnostics don't get merged), and triggers diagnostic refresh for open
 * dependents. Also requests a semantic token refresh.
 */
function propagateDependentInvalidation(
  ctx: ServerContext,
  dependents: Set<string>,
): void {
  if (dependents.size === 0) return;

  for (const depUri of dependents) {
    ctx.index.invalidate(depUri);
    // Clear caches so stale pike diagnostics aren't merged.
    ctx.pikeCache.delete(depUri);
    ctx.autodocCache.delete(depUri);

    const depDoc = ctx.documents.get(depUri);
    if (depDoc) {
      ctx.diagnosticManager.onDidChange(depUri);
    }
  }

  if (ctx.clientSupportsSemanticTokensRefresh) {
    try {
      ctx.connection.languages.semanticTokens.refresh();
    } catch {
      // Connection may be closed during teardown
    }
  }
}

interface FileRename {
  oldUri: string;
  newUri: string;
}

async function handleFileRenames(
  ctx: ServerContext,
  files: readonly FileRename[],
): Promise<void> {
  for (const rename of files) {
    await reindexRenamedFile(ctx, rename);
  }
}

async function reindexRenamedFile(
  ctx: ServerContext,
  rename: FileRename,
): Promise<void> {
  const dependents = ctx.index.getDependents(rename.oldUri);
  ctx.index.removeFile(rename.oldUri);
  deleteTree(rename.oldUri);

  // Invalidate global prep — the workspace file set has changed (rename).
  ctx.index.invalidateGlobalPrep();

  // Re-index the renamed file if it's currently open.
  const doc = ctx.documents.get(rename.newUri);
  if (doc) {
    const tree = parse(doc.getText(), rename.newUri);
    if (tree) {
      await ctx.index.upsertFile(
        rename.newUri, doc.version, tree, doc.getText(), ModificationSource.DidOpen,
      );
    }
  }

  // Re-index dependents so their cross-file references point to the new URI.
  for (const depUri of dependents) {
    const depDoc = ctx.documents.get(depUri);
    if (depDoc) {
      const depTree = parse(depDoc.getText(), depUri);
      if (depTree) {
        await ctx.index.upsertFile(
          depUri, depDoc.version, depTree, depDoc.getText(), ModificationSource.DidOpen,
        );
      }
    }
  }
}
