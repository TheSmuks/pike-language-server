/**
 * Advanced feature handlers — call hierarchy, code lens, document sync
 * (didOpen, didSave), and document links.
 *
 * Extracted from navigationHandler.ts to keep file sizes under 500 lines.
 */

import {
  type Connection,
  type CancellationToken,
} from "vscode-languageserver/node";
import type { NavigationContext } from "./navigationHandler";
import { parse } from "../parser";
import {
  prepareCallHierarchy,
  getIncomingCalls,
  getOutgoingCalls,
} from "./callHierarchy";
import {
  prepareTypeHierarchy,
  getSupertypes,
  getSubtypes,
} from "./typeHierarchy";
import { produceCodeLenses } from "./codeLens";
import { registerDocumentLinkHandler } from "./documentLink";
import { computeContentHash } from "./diagnosticManager";
import { uriToPath } from "../util/uri";
import { logError, logWarn, ErrorCategory } from "../util/errorLog.js";

/**
 * Register advanced feature handlers on the connection.
 */
export function registerAdvancedHandlers(
  connection: Connection,
  ctx: NavigationContext,
): void {
  registerCallHierarchyHandlers(connection, ctx);
  registerTypeHierarchyHandlers(connection, ctx);
  registerCodeLensHandler(connection, ctx);
  registerDidOpenHandler(ctx);
  registerDidSaveHandler(ctx);
  registerDocumentLinkHandler(connection, ctx.documents, ctx.index, ctx.index.resolver);
}

// ---------------------------------------------------------------------------
// Handler registration helpers
// ---------------------------------------------------------------------------

/** Register call hierarchy request handlers (incoming/outgoing calls). */
function registerCallHierarchyHandlers(
  connection: Connection,
  ctx: NavigationContext,
): void {
  connection.onRequest(
    "textDocument/prepareCallHierarchy",
    async (params, token: CancellationToken) => {
      if (token.isCancellationRequested) return null;
      const table = await ctx.getSymbolTable(params.textDocument.uri);
      if (!table) return null;
      return prepareCallHierarchy(
        table,
        params.textDocument.uri,
        params.position.line,
        params.position.character,
      );
    },
  );

  connection.onRequest(
    "callHierarchy/incomingCalls",
    async (params, token: CancellationToken) => {
      if (token.isCancellationRequested) return [];
      const item = params.item;
      if (!ctx.index) return [];
      return getIncomingCalls(item, ctx.index);
    },
  );

  connection.onRequest(
    "callHierarchy/outgoingCalls",
    async (params, token: CancellationToken) => {
      if (token.isCancellationRequested) return [];
      const item = params.item;
      const uri = item.uri;
      const table = await ctx.getSymbolTable(uri);
      if (!table) return [];
      const doc = ctx.documents.get(uri);
      if (!doc) return [];
      const source = doc.getText();
      const tree = parse(source, uri);
      if (!ctx.index) return [];
      const lines = source.split('\n');
      return getOutgoingCalls(item, tree, table, uri, ctx.index, lines);
    },
  );
}

/** Register type hierarchy request handlers (supertypes/subtypes). */
function registerTypeHierarchyHandlers(
  connection: Connection,
  ctx: NavigationContext,
): void {
  connection.onRequest(
    "textDocument/prepareTypeHierarchy",
    async (params, token: CancellationToken) => {
      if (token.isCancellationRequested) return null;
      const table = await ctx.getSymbolTable(params.textDocument.uri);
      if (!table) return null;
      return prepareTypeHierarchy(
        table,
        params.textDocument.uri,
        params.position.line,
        params.position.character,
      );
    },
  );

  connection.onRequest(
    "typeHierarchy/supertypes",
    async (params, token: CancellationToken) => {
      if (token.isCancellationRequested) return [];
      const item = params.item;
      if (!ctx.index) return [];
      const table = await ctx.getSymbolTable(item.uri);
      if (!table) return [];
      return getSupertypes(ctx.index, table, item.uri, item);
    },
  );

  connection.onRequest(
    "typeHierarchy/subtypes",
    async (params, token: CancellationToken) => {
      if (token.isCancellationRequested) return [];
      const item = params.item;
      if (!ctx.index) return [];
      return getSubtypes(ctx.index, item.uri, item);
    },
  );
}

/** Register code lens handler (reference counts above declarations). */
function registerCodeLensHandler(
  connection: Connection,
  ctx: NavigationContext,
): void {
  connection.onCodeLens(async (params, token: CancellationToken) => {
    if (token.isCancellationRequested) return null;
    const doc = ctx.documents.get(params.textDocument.uri);
    if (!doc) return null;

    const table = await ctx.getSymbolTable(params.textDocument.uri);
    if (!table) return null;

    const tree = parse(doc.getText(), params.textDocument.uri);
    return produceCodeLenses(table, tree, params.textDocument.uri, ctx.index);
  });
}

/** Extract AutoDoc XML if the content hash has changed. */
function extractAutodocIfStale(
  source: string,
  uri: string,
  ctx: NavigationContext,
): void {
  const autodocHash = computeContentHash(source);
  const cachedAutodoc = ctx.autodocCache.get(uri);
  if (cachedAutodoc && cachedAutodoc.hash === autodocHash) return;

  const filepath = uriToPath(uri);
  ctx.worker
    .autodoc(source, filepath)
    .then((result) => {
      if (result.xml) {
        ctx.autodocCache.set(uri, {
          xml: result.xml,
          hash: autodocHash,
          timestamp: Date.now(),
        });
      }
    })
    .catch((err: unknown) => {
      logWarn(ctx.connection, `AutoDoc extraction failed for ${uri}: ${err instanceof Error ? err.message : String(err)}`);
    });
}

/** Register didOpen handler — extract AutoDoc XML + lazy dep resolution. */
function registerDidOpenHandler(ctx: NavigationContext): void {
  ctx.documents.onDidOpen((event) => {
    const doc = event.document;
    const source = doc.getText();
    if (source === undefined || source === null) {
      logError(ctx.connection, ErrorCategory.System, `registerDidOpenHandler(${doc.uri})`, new Error("unexpected null content"));
      return;
    }
    extractAutodocIfStale(source, doc.uri, ctx);

    // Fire-and-forget: resolve dependencies for background-indexed files.
    // This is a no-op if the file was already fully resolved (upsertFile).
    ctx.index.ensureDependenciesResolved(doc.uri).catch(() => {
      // Swallow — dependency resolution failure is non-critical.
      // Cross-file features will gracefully return no results.
    });
  });
}

/** Register didSave handler — diagnostics + AutoDoc extraction. */
function registerDidSaveHandler(ctx: NavigationContext): void {
  ctx.documents.onDidSave(async (event) => {
    const doc = event.document;

    // Delegate to DiagnosticManager (handles cache, diagnose, publish)
    await ctx.diagnosticManager.onDidSave(doc.uri);

    // Extract AutoDoc XML alongside diagnostics (non-critical)
    const source = doc.getText();
    extractAutodocIfStale(source, doc.uri, ctx);
  });
}
