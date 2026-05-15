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
  // -----------------------------------------------------------------------
  // Call hierarchy — incoming/outgoing calls (decision 0026)
  // -----------------------------------------------------------------------

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
      const tree = parse(doc.getText(), uri);
      if (!ctx.index) return [];
      return getOutgoingCalls(item, tree, table, uri, ctx.index);
    },
  );

  // -----------------------------------------------------------------------
  // Type hierarchy — supertypes/subtypes for class inheritance (decision 0026)
  // -----------------------------------------------------------------------

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

  // -----------------------------------------------------------------------
  // Code lens — reference counts above declarations (decision 0026)
  // -----------------------------------------------------------------------

  connection.onCodeLens(async (params, token: CancellationToken) => {
    if (token.isCancellationRequested) return null;
    const doc = ctx.documents.get(params.textDocument.uri);
    if (!doc) return null;

    const table = await ctx.getSymbolTable(params.textDocument.uri);
    if (!table) return null;

    const tree = parse(doc.getText(), params.textDocument.uri);
    return produceCodeLenses(table, tree, params.textDocument.uri, ctx.index);
  });

  // -----------------------------------------------------------------------
  // textDocument/didOpen — extract AutoDoc on document open (decision 0014)
  // -----------------------------------------------------------------------

  ctx.documents.onDidOpen((event) => {
    const doc = event.document;

    // Extract AutoDoc XML on open (non-critical, fire-and-forget)
    const source = doc.getText();
    // gopls sentinel pattern: return diagnostic-quality error for null/undefined.
    // Empty string is valid content — no guard needed.
    if (source === undefined || source === null) {
      logError(ctx.connection, ErrorCategory.System, `navigationHandler.handleHover(${doc.uri})`, new Error("unexpected null content"));
      return;
    }
    const autodocHash = computeContentHash(source);
    const cachedAutodoc = ctx.autodocCache.get(doc.uri);
    if (!cachedAutodoc || cachedAutodoc.hash !== autodocHash) {
      const filepath = uriToPath(doc.uri);
      ctx.worker
        .autodoc(source, filepath)
        .then((result) => {
          if (result.xml) {
            ctx.autodocCache.set(doc.uri, {
              xml: result.xml,
              hash: autodocHash,
              timestamp: Date.now(),
            });
          }
        })
        .catch((err: unknown) => {
          logWarn(ctx.connection, `AutoDoc extraction failed on didOpen for ${doc.uri}: ${err instanceof Error ? err.message : String(err)}`);
        });
    }
  });

  // -----------------------------------------------------------------------
  // textDocument/didSave — delegate to DiagnosticManager (decision 0013)
  // -----------------------------------------------------------------------

  ctx.documents.onDidSave(async (event) => {
    const doc = event.document;

    // Delegate to DiagnosticManager (handles cache, diagnose, publish)
    await ctx.diagnosticManager.onDidSave(doc.uri);

    // Extract AutoDoc XML alongside diagnostics (non-critical)
    const source = doc.getText();
    const autodocHash = computeContentHash(source);
    const cachedAutodoc = ctx.autodocCache.get(doc.uri);
    if (!cachedAutodoc || cachedAutodoc.hash !== autodocHash) {
      const filepath = uriToPath(doc.uri);
      ctx.worker
        .autodoc(source, filepath)
        .then((result) => {
          if (result.xml) {
            ctx.autodocCache.set(doc.uri, {
              xml: result.xml,
              hash: autodocHash,
              timestamp: Date.now(),
            });
          }
        })
        .catch((err: unknown) => {
          logWarn(ctx.connection, `AutoDoc extraction failed on didSave for ${doc.uri}: ${err instanceof Error ? err.message : String(err)}`);
        });
    }
  });

  // -----------------------------------------------------------------------
  // textDocument/documentLink (US-030)
  // -----------------------------------------------------------------------
  registerDocumentLinkHandler(connection, ctx.documents, ctx.index, ctx.index.resolver);
}
