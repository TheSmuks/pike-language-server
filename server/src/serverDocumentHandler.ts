/**
 * Text document handlers — didChangeContent and didClose.
 *
 * Extracted from server.ts to keep createPikeServer under the 50-line
 * TigerStyle function limit.
 */

import type { TextDocuments } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { Connection } from "vscode-languageserver/node";
import { initParser, isParserReady, parse, deleteTree } from "./parser";
import { ModificationSource } from "./features/workspaceIndex";
import { logError, logInfo, ErrorCategory } from "./util/errorLog.js";
import type { ServerContext } from "./serverContext";

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Register text document event handlers. */
export function registerDocumentHandlers(
  documents: TextDocuments<TextDocument>,
  ctx: ServerContext,
): void {
  documents.onDidChangeContent(async (event) => {
    await handleDidChangeContent(ctx, event.document);
  });

  documents.onDidClose((event) => {
    handleDidClose(ctx, event.document.uri);
  });

  initParser().then(() => {
    void flushPendingParserDocuments(ctx);
  }).catch((err) => {
    logError(ctx.connection, ErrorCategory.Parse, "initParser.flushPending", err);
  });
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

async function handleDidChangeContent(
  ctx: ServerContext,
  doc: TextDocument,
): Promise<void> {
  if (!isParserReady()) {
    ctx.pendingParserDocuments.set(doc.uri, doc);
    return;
  }

  try {
    const content = doc.getText();
    if (content === undefined || content === null) {
      logError(
        ctx.connection, ErrorCategory.System,
        `onDidChangeContent(${doc.uri})`,
        new Error("unexpected null content"),
      );
      return;
    }

    const tree = parse(content, doc.uri);

    // Update workspace index, invalidating dependents
    const invalidated = ctx.index.invalidateWithDependents(doc.uri);
    const promise = ctx.index.upsertFile(
      doc.uri, doc.version, tree, content, ModificationSource.DidChange,
    );
    ctx.upsertInFlight.set(doc.uri, promise);
    try {
      await promise;
    } finally {
      // Guard: only delete if this promise is still the in-flight one.
      // A concurrent didChange for the same URI may have overwritten it.
      if (ctx.upsertInFlight.get(doc.uri) === promise) {
        ctx.upsertInFlight.delete(doc.uri);
      }
    }

    if (invalidated.length > 1) {
      logInfo(
        ctx.connection,
        `Invalidated ${invalidated.length} files (change in ${doc.uri})`,
      );
    }
  } catch (err) {
    logError(ctx.connection, ErrorCategory.Parse, `onDidChangeContent(${doc.uri})`, err);
    return;
  }

  // Delegate real-time diagnostics to DiagnosticManager.
  // These run after the index upsert succeeds — diagnostics depend on the
  // updated symbol table. Wrapped in try/catch because sendDiagnostics and
  // semanticTokens.refresh() both cross the LSP connection boundary where
  // the client may have disconnected.
  try {
    ctx.diagnosticManager.onDidChange(doc.uri);

    scheduleSemanticTokensRefresh(ctx);
  } catch (err) {
    logError(ctx.connection, ErrorCategory.System, `post-didChange(${doc.uri})`, err);
  }
}

function handleDidClose(
  ctx: ServerContext,
  uri: string,
): void {
  deleteTree(uri);
  ctx.index.removeFile(uri);
  ctx.pikeCache.delete(uri);
  ctx.semanticTokensCache.delete(uri);
  ctx.pendingParserDocuments.delete(uri);
  ctx.diagnosticManager.onDidClose(uri);
}

async function flushPendingParserDocuments(ctx: ServerContext): Promise<void> {
  const pending = [...ctx.pendingParserDocuments.values()];
  ctx.pendingParserDocuments.clear();
  for (const doc of pending) {
    await handleDidChangeContent(ctx, doc);
  }
}

function scheduleSemanticTokensRefresh(ctx: ServerContext): void {
  if (!ctx.clientSupportsSemanticTokensRefresh) return;
  if (ctx.semanticTokensRefreshTimer) return;
  ctx.semanticTokensRefreshTimer = setTimeout(() => {
    ctx.semanticTokensRefreshTimer = undefined;
    ctx.connection.languages.semanticTokens.refresh();
  }, 50);
}
