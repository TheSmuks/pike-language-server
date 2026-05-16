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
  (connection as any).onDidRenameFiles?.((params: { files: Array<{ oldUri: string; newUri: string }> }) => {
    handleFileRenames(ctx, params.files);
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
  ctx.index.removeFile(uri);
  ctx.pikeCache.delete(uri);
  ctx.autodocCache.delete(uri);
}

function handleFileDeleted(
  ctx: ServerContext,
  uri: string,
): void {
  ctx.index.removeFile(uri);
  deleteTree(uri);
  ctx.pikeCache.delete(uri);
  ctx.autodocCache.delete(uri);
  ctx.diagnosticManager.onDidClose(uri);
}

interface FileRename {
  oldUri: string;
  newUri: string;
}

function handleFileRenames(
  ctx: ServerContext,
  files: readonly FileRename[],
): void {
  for (const rename of files) {
    reindexRenamedFile(ctx, rename);
  }
}

function reindexRenamedFile(
  ctx: ServerContext,
  rename: FileRename,
): void {
  const dependents = ctx.index.getDependents(rename.oldUri);
  ctx.index.removeFile(rename.oldUri);
  deleteTree(rename.oldUri);

  // Re-index the renamed file if it's currently open.
  const doc = ctx.documents.get(rename.newUri);
  if (doc) {
    const tree = parse(doc.getText(), rename.newUri);
    if (tree) {
      ctx.index.upsertFile(
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
        ctx.index.upsertFile(
          depUri, depDoc.version, depTree, depDoc.getText(), ModificationSource.DidOpen,
        );
      }
    }
  }
}
