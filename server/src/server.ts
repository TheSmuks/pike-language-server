/**
 * Pike Language Server — main entry point.
 *
 * Communicates over stdio. Provides documentSymbol, definition, references,
 * hover, completion, rename, and diagnostics (parse errors + Pike compilation).
 *
 * Architecture:
 * - `createPikeServer(connection)` — wires all handlers onto a connection.
 *   Used by tests to create an in-process server with PassThrough streams.
 * - Top-level `connection.listen()` — the production entry point over stdio.
 */

import {
  createConnection,
  type Connection,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";

import { registerHoverHandler } from "./features/hoverHandler";
import { registerFormattingHandler } from "./features/formattingHandler";
import { registerNavigationHandlers } from "./features/navigationHandler";
import { handleInitialized, handleConfigurationChange } from "./serverLifecycle";

import {
  createServerContext,
  getSymbolTable,
  type ServerContext,
  type AutodocEntry,
} from "./serverContext";
import { PikeWorker } from "./features/pikeWorker";
import { LRUCache } from "./util/lruCache";
import type { WorkspaceIndex } from "./features/workspaceIndex";
import type { DiagnosticManager } from "./features/diagnosticManager";
import { registerInitHandler } from "./serverInitHandler";
import { registerFileWatchHandlers } from "./serverFileWatchHandler";
import { registerShutdownHandler } from "./serverShutdownHandler";
import { registerDocumentHandlers } from "./serverDocumentHandler";

// ---------------------------------------------------------------------------
// Server factory — reusable for production and tests
// ---------------------------------------------------------------------------

export interface PikeServer {
  connection: Connection;
  documents: import("vscode-languageserver/node").TextDocuments<TextDocument>;
  index: WorkspaceIndex;
  worker: PikeWorker;
  autodocCache: LRUCache<AutodocEntry>;
  diagnosticManager: DiagnosticManager;
}

export function createPikeServer(connection: Connection): PikeServer {
  const ctx = createServerContext(connection);

  // -- Initialization handlers --
  registerInitHandler(connection, ctx);

  registerPostInitHandler(connection, ctx);

  // -- File watchers & renames --
  registerFileWatchHandlers(connection, ctx);

  // -- Configuration changes --
  registerConfigHandler(connection, ctx);

  // -- Extracted feature handlers --
  registerFeatureHandlers(connection, ctx);

  // -- Shutdown --
  registerShutdownHandler(connection, ctx);

  // -- Text document lifecycle --
  registerDocumentHandlers(ctx.documents, ctx);

  ctx.documents.listen(connection);
  return buildReturn(ctx);
}

// ---------------------------------------------------------------------------
// Thin registration helpers (each under 50 lines)
// ---------------------------------------------------------------------------

function registerPostInitHandler(
  connection: Connection,
  ctx: ServerContext,
): void {
  connection.onInitialized(async () => {
    await handleInitialized({
      connection,
      documents: ctx.documents,
      index: ctx.index,
      worker: ctx.worker,
      diagnosticManager: ctx.diagnosticManager,
      formattingConfig: ctx.formattingConfig,
      backgroundIndexEnabled: ctx.backgroundIndexEnabled,
      backgroundIndexBatchSize: ctx.backgroundIndexBatchSize,
      clientSupportsWatchedFiles: ctx.clientSupportsWatchedFiles,
      clientSupportsSemanticTokensRefresh: ctx.clientSupportsSemanticTokensRefresh,
    });
  });
}

function registerConfigHandler(
  connection: Connection,
  ctx: ServerContext,
): void {
  connection.onDidChangeConfiguration(async (settings) => {
    handleConfigurationChange(
      {
        worker: ctx.worker,
        diagnosticManager: ctx.diagnosticManager,
        formattingConfig: ctx.formattingConfig,
      },
      settings,
    );
  });
}

function registerFeatureHandlers(
  connection: Connection,
  ctx: ServerContext,
): void {
  // Use getters for fields that are replaced during initialization.
  // ctx.index is a placeholder at registration time; handleInitialize
  // replaces it with the real index. A direct value capture would hold
  // the stale placeholder forever.
  const handlerContext = {
    documents: ctx.documents,
    get index() { return ctx.index; },
    worker: ctx.worker,
    getSymbolTable: (uri: string) => getSymbolTable(ctx, uri),
    autodocCache: ctx.autodocCache,
    get stdlibIndex() { return ctx.stdlibIndex; },
    get predefBuiltins() { return ctx.predefBuiltins; },
    get predefAutodoc() { return ctx.predefAutodoc; },
    diagnosticManager: ctx.diagnosticManager,
    semanticTokensCache: ctx.semanticTokensCache,
    get debugTelemetry() { return ctx.debugTelemetry; },
    connection: ctx.connection,
  };

  registerHoverHandler(connection, handlerContext);
  registerNavigationHandlers(connection, handlerContext);
  registerFormattingHandler(connection, {
    documents: ctx.documents,
    formattingConfig: ctx.formattingConfig,
  });
}

function buildReturn(ctx: ServerContext): PikeServer {
  return {
    connection: ctx.connection,
    documents: ctx.documents,
    get index() { return ctx.index; },
    worker: ctx.worker,
    autodocCache: ctx.autodocCache,
    diagnosticManager: ctx.diagnosticManager,
  };
}

// ---------------------------------------------------------------------------
// Production entry: handled by main.ts
// ---------------------------------------------------------------------------

// server.ts is imported by main.ts, which handles process entry.
// Do NOT start listening here — main.ts owns the entry point.
// Having two connection.listen() calls on the same stdio causes protocol
// corruption (undefined document content → "Cannot read properties of
// undefined (reading 'charAt')").
