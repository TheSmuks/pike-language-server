/**
 * Text document handlers — didChangeContent and didClose.
 *
 * Extracted from server.ts to keep createPikeServer under the 50-line
 * TigerStyle function limit.
 */

import type { TextDocuments } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { Connection } from "vscode-languageserver/node";
import { isParserReady, parse, deleteTree } from "./parser";
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
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

async function handleDidChangeContent(
  ctx: ServerContext,
  doc: TextDocument,
): Promise<void> {
  // If the parser is not yet ready, skip processing entirely.
  // The document will be re-processed on the next didChange.
  // rust-analyzer pattern: non-blocking readiness check, no data loss.
  if (!isParserReady()) return;

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

    const tree = parse(doc.getText(), doc.uri);

    // Update workspace index, invalidating dependents
    const invalidated = ctx.index.invalidateWithDependents(doc.uri);
    const promise = ctx.index.upsertFile(
      doc.uri, doc.version, tree, doc.getText(), ModificationSource.DidChange,
    );
    ctx.upsertInFlight.set(doc.uri, promise);
    try {
      await promise;
    } finally {
      ctx.upsertInFlight.delete(doc.uri);
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

    // Request VSCode to re-fetch semantic tokens. Without this, VSCode only
    // re-requests tokens on tab switch. The token data is produced from the
    // symbol table which was just rebuilt above.
    // Note: semanticTokens.refresh() is fire-and-forget on the server side —
    // it sends a notification to the client and returns void.
    if (ctx.clientSupportsSemanticTokensRefresh) {
      ctx.connection.languages.semanticTokens.refresh();
    }
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
  ctx.diagnosticManager.onDidClose(uri);
}
