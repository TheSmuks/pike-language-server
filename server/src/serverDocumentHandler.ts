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
  documents.onDidOpen(async (event) => {
    await handleDidOpen(ctx, event.document);
  });

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
// Queue management
// ---------------------------------------------------------------------------

/** Queue a document for processing once the parser is ready. */
function queuePendingDocument(ctx: ServerContext, doc: TextDocument): void {
  ctx.pendingParserDocuments.set(doc.uri, doc);
}

// ---------------------------------------------------------------------------
// Content validation
// ---------------------------------------------------------------------------

/**
 * Validate that document content is non-null.
 * Returns the content string or null if invalid.
 */
function validateDocumentContent(
  connection: Connection,
  doc: TextDocument,
): string | null {
  const content = doc.getText();
  if (content === undefined || content === null) {
    logError(
      connection, ErrorCategory.System,
      `onDidChangeContent(${doc.uri})`,
      new Error("unexpected null content"),
    );
    return null;
  }
  return content;
}

// ---------------------------------------------------------------------------
// Index upsert helper
// ---------------------------------------------------------------------------

/**
 * Parse a document and upsert it into the workspace index.
 * Returns the invalidated file count on success, or -1 on parse failure.
 */
async function parseAndIndexDocument(
  ctx: ServerContext,
  doc: TextDocument,
  content: string,
  source: ModificationSource,
): Promise<number> {
  const promise = (async () => {
    const tree = parse(content, doc.uri);
    const invalidated = ctx.index.invalidateWithDependents(doc.uri);
    await ctx.index.upsertFile(doc.uri, doc.version, tree, content, source);
    const reWired = ctx.index.rewireDependents(doc.uri);
    return invalidated.length + reWired.length;
  })();

  ctx.upsertInFlight.set(doc.uri, promise);
  try {
    return await promise;
  } finally {
    if (ctx.upsertInFlight.get(doc.uri) === promise) {
      ctx.upsertInFlight.delete(doc.uri);
    }
  }
}

// ---------------------------------------------------------------------------
// Diagnostics trigger
// ---------------------------------------------------------------------------

/**
 * Trigger real-time diagnostics for a document.
 * Errors are swallowed since sendDiagnostics crosses the LSP boundary
 * and the client may have disconnected.
 */
function triggerDiagnostics(ctx: ServerContext, uri: string): void {
  try {
    ctx.diagnosticManager.onDidChange(uri);
  } catch (err) {
    logError(ctx.connection, ErrorCategory.System, `post-didChange(${uri})`, err);
  }
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

async function handleOpenedOrChangedContent(
  ctx: ServerContext,
  doc: TextDocument,
  source: ModificationSource,
): Promise<void> {
  if (!isParserReady()) {
    queuePendingDocument(ctx, doc);
    return;
  }

  const content = validateDocumentContent(ctx.connection, doc);
  if (content === null) return;

  let invalidatedCount: number;
  try {
    invalidatedCount = await parseAndIndexDocument(ctx, doc, content, source);
  } catch (err) {
    logError(ctx.connection, ErrorCategory.Parse, `onDidChangeContent(${doc.uri})`, err);
    return;
  }

  if (invalidatedCount > 1) {
    logInfo(ctx.connection, `Invalidated ${invalidatedCount} files (change in ${doc.uri})`);
  }

  triggerDiagnostics(ctx, doc.uri);
}

async function indexOpenedDocumentFast(
  ctx: ServerContext,
  doc: TextDocument,
): Promise<number> {
  const content = validateDocumentContent(ctx.connection, doc);
  if (content === null) return 0;

  const tree = parse(content, doc.uri);
  const invalidated = ctx.index.invalidateWithDependents(doc.uri);
  ctx.index.upsertBackgroundFile(doc.uri, doc.version, tree, content);
  const reWired = ctx.index.rewireDependents(doc.uri);
  return invalidated.length + reWired.length;
}

async function handleDidOpen(
  ctx: ServerContext,
  doc: TextDocument,
): Promise<void> {
  if (!isParserReady()) {
    queuePendingDocument(ctx, doc);
    return;
  }

  try {
    const invalidatedCount = await indexOpenedDocumentFast(ctx, doc);
    if (invalidatedCount > 1) {
      logInfo(ctx.connection, `Invalidated ${invalidatedCount} files (open ${doc.uri})`);
    }
  } catch (err) {
    logError(ctx.connection, ErrorCategory.Parse, `onDidOpen(${doc.uri})`, err);
    return;
  }

}

async function handleDidChangeContent(
  ctx: ServerContext,
  doc: TextDocument,
): Promise<void> {
  await handleOpenedOrChangedContent(ctx, doc, ModificationSource.DidChange);
}

function handleDidClose(
  ctx: ServerContext,
  uri: string,
): void {
  deleteTree(uri);
  ctx.index.removeFile(uri);
  ctx.pikeCache.delete(uri);
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