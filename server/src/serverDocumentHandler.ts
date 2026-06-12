/**
 * Text document handlers — didChangeContent and didClose.
 *
 * Extracted from server.ts to keep createPikeServer under the 50-line
 * TigerStyle function limit.
 */

import type { TextDocuments } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { Connection } from "vscode-languageserver/node";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
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
    ctx.hibernationManager.onDocumentOpen();
    await handleDidOpen(ctx, event.document);
  });

  documents.onDidChangeContent(async (event) => {
    ctx.hibernationManager.recordActivity();
    await handleDidChangeContent(ctx, event.document);
  });

  documents.onDidClose((event) => {
    ctx.hibernationManager.onDocumentClose();
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

// ---------------------------------------------------------------------------
// Dependency-closure indexing (T053)
// ---------------------------------------------------------------------------

/**
 * Proactively index the transitive dependency closure of an opened file.
 *
 * When a document is opened in openFiles mode, only that file is indexed.
 * Cross-file features (go-to-def, references) need the file's dependencies
 * too. This function walks the dependency graph breadth-first, reading
 * and indexing each dependency from disk, bounded by depth and count caps.
 *
 * Already-indexed files are skipped — only missing dependencies are read.
 * Fire-and-forget: callers must not await this for didOpen responsiveness.
 *
 * Returns the number of newly indexed files.
 */
export async function indexDependencyClosure(
  ctx: ServerContext,
  rootUri: string,
): Promise<number> {
  const depthMax = ctx.resourceConfig.indexing.dependencyClosureDepth;
  const countMax = ctx.resourceConfig.indexing.dependencyClosureCount;
  if (depthMax <= 0 || countMax <= 0) return 0;

  const index = ctx.index;
  const visited = new Set<string>([rootUri]);
  let indexedCount = 0;
  let frontier: string[] = [rootUri];

  for (let depth = 0; depth < depthMax && frontier.length > 0; depth++) {
    const nextFrontier: string[] = [];

    for (const uri of frontier) {
      // Resolve this file's dependencies if not already done.
      await index.ensureDependenciesResolved(uri);
      const entry = index.getFile(uri);
      if (!entry) continue;

      for (const depUri of entry.dependencies) {
        if (visited.has(depUri)) continue;
        visited.add(depUri);

        // Already indexed by background scan or another closure.
        if (index.getFile(depUri)) continue;
        if (indexedCount >= countMax) return indexedCount;

        // Read dependency from disk and index it.
        const indexed = await indexDependencyFromDisk(ctx, depUri);
        if (indexed) {
          indexedCount++;
          nextFrontier.push(depUri);
        }
      }
    }

    frontier = nextFrontier;
  }

  return indexedCount;
}

/**
 * Read a single file from disk, parse it, and insert as a background entry.
 * Returns true if the file was successfully indexed, false on any error.
 */
async function indexDependencyFromDisk(
  ctx: ServerContext,
  uri: string,
): Promise<boolean> {
  let filePath: string;
  try {
    filePath = fileURLToPath(uri);
  } catch {
    // Not a file:// URI — can't read from disk.
    return false;
  }

  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    // File may not exist on disk (resolved import that's a built-in module).
    return false;
  }

  try {
    const tree = parse(content, uri);
    if (!tree) return false;
    ctx.index.upsertBackgroundFile(uri, 1, tree, content);
    return true;
  } catch {
    return false;
  }
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

  // The onDidChangeContent event (fired by TextDocuments on initial open)
  // triggers a full upsert via parseAndIndexDocument. That full upsert
  // invalidates the entry (nulls symbolTable) then asynchronously rebuilds
  // it. We must wait for that upsert to complete before indexing the
  // dependency closure — otherwise ensureDependenciesResolved sees a null
  // symbolTable and returns false.
  const inFlight = ctx.upsertInFlight.get(doc.uri);
  if (inFlight) {
    await inFlight.catch(() => {});
  }

  // Proactively index the dependency closure of the opened file.
  // Bounded by dependencyClosureDepth and dependencyClosureCount from config.
  // Fire-and-forget: didOpen must not block on closure indexing.
  void indexDependencyClosure(ctx, doc.uri).catch((err) => {
    logError(ctx.connection, ErrorCategory.System, `indexDependencyClosure(${doc.uri})`, err);
  });
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
