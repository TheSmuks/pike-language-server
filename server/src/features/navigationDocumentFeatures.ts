/**
 * Document feature handlers — documentSymbol, selectionRange, semanticTokens,
 * diagnostic (pull), documentHighlight, foldingRange, signatureHelp, inlayHint.
 *
 * Extracted from navigationHandler.ts to keep file sizes under 500 lines.
 */

import {
  type Connection,
  type CancellationToken,
  type DocumentHighlight,
  type Position,
  DocumentHighlightKind,
} from "vscode-languageserver/node";
import type { NavigationContext } from "./navigationHandler";
import { parse } from "../parser";
import { getDocumentSymbols } from "./documentSymbol";
import { getParseDiagnostics } from "./diagnostics";
import {
  getDefinitionAt,
  getReferencesTo,
} from "./symbolTable";
import { produceSemanticTokens, deltaEncodeTokens } from "./semanticTokens";
import { produceFoldingRanges } from "./foldingRange";
import { produceSignatureHelp } from "./signatureHelp";
import { produceInlayHints } from "./inlayHints";
import { getSelectionRange } from "./selectionRange";
import { logError, ErrorCategory } from "../util/errorLog.js";

/**
 * Register document analysis feature handlers on the connection.
 */
export function registerDocumentFeatureHandlers(
  connection: Connection,
  ctx: NavigationContext,
): void {
  // -----------------------------------------------------------------------
  // documentSymbol
  // -----------------------------------------------------------------------

  connection.onDocumentSymbol(async (params, token: CancellationToken) => {
    if (token.isCancellationRequested) return [];
    const doc = ctx.documents.get(params.textDocument.uri);
    if (!doc) return [];

    try {
      const tree = parse(doc.getText(), doc.uri);

      // Return partial symbols — never crash on parse errors.
      // Note: parse diagnostics are handled by the diagnostic manager on didChange.
      return getDocumentSymbols(tree);
    } catch (err) {
      logError(connection, ErrorCategory.Parse, "navigationHandler.handleDocumentSymbol", err);
      return [];
    }
  });

  // -----------------------------------------------------------------------
  // textDocument/selectionRange — shrink/expand selection
  // -----------------------------------------------------------------------

  connection.onRequest(
    "textDocument/selectionRange",
    async (params, token: CancellationToken) => {
      if (token.isCancellationRequested) return null;
      const doc = ctx.documents.get(params.textDocument.uri);
      if (!doc) return null;

      // selectionRange supports multiple positions; handle each
      const results = [];
      for (const pos of params.positions) {
        if (token.isCancellationRequested) return results;
        const tree = parse(doc.getText(), doc.uri);
        const range = getSelectionRange(tree, pos.line, pos.character);
        results.push(range);
      }
      return results;
    },
  );

  // -----------------------------------------------------------------------
  // textDocument/semanticTokens/full
  // -----------------------------------------------------------------------

  connection.onRequest(
    "textDocument/semanticTokens/full",
    async (params, token: CancellationToken) => {
      if (token.isCancellationRequested) return { data: [] };
      const doc = ctx.documents.get(params.textDocument.uri);
      if (!doc) return { data: [] };

      const table = await ctx.getSymbolTable(params.textDocument.uri);
      if (!table) return { data: [] };

      const tokens = produceSemanticTokens(table);
      const data = deltaEncodeTokens(tokens);

      return { data };
    },
  );

  // -----------------------------------------------------------------------
  // textDocument/diagnostic (pull diagnostics — diagnosticProvider capability)
  // -----------------------------------------------------------------------

  connection.onRequest(
    "textDocument/diagnostic",
    async (params: { textDocument: { uri: string } }, token: CancellationToken) => {
      if (token.isCancellationRequested) return { kind: "full", items: [] };
      const doc = ctx.documents.get(params.textDocument.uri);
      if (!doc) return { kind: "full", items: [] };

      try {
        const tree = parse(doc.getText(), params.textDocument.uri);
        const diagnostics = getParseDiagnostics(tree);
        return { kind: "full", items: diagnostics };
      } catch (err) {
        logError(connection, ErrorCategory.Diagnostics, "navigationHandler.handleDiagnostics", err);
        return { kind: "full", items: [] };
      }
    },
  );

  // -----------------------------------------------------------------------
  // textDocument/documentHighlight (US-015)
  // -----------------------------------------------------------------------

  connection.onDocumentHighlight(async (params, token: CancellationToken) => {
    if (token.isCancellationRequested) return null;
    const table = await ctx.getSymbolTable(params.textDocument.uri);
    if (!table || token.isCancellationRequested) return null;

    const refs = getReferencesTo(
      table,
      params.position.line,
      params.position.character,
    );

    if (refs.length === 0) return null;

    // Map references to DocumentHighlight
    // Declaration sites → Write, reference sites → Read
    // Find the target declaration to distinguish
    const targetDecl = getDefinitionAt(
      table,
      params.position.line,
      params.position.character,
    );

    const highlights: DocumentHighlight[] = [];

    // Add the declaration itself as a Write highlight
    if (targetDecl) {
      highlights.push({
        range: {
          start: {
            line: targetDecl.nameRange.start.line,
            character: targetDecl.nameRange.start.character,
          },
          end: {
            line: targetDecl.nameRange.end.line,
            character: targetDecl.nameRange.end.character,
          },
        },
        kind: DocumentHighlightKind.Write,
      });
    }

    // Add all references as Read highlights
    for (const ref of refs) {
      // Skip if same position as declaration (already added as Write)
      if (
        targetDecl &&
        ref.loc.line === targetDecl.nameRange.start.line &&
        ref.loc.character === targetDecl.nameRange.start.character
      ) {
        continue;
      }

      highlights.push({
        range: {
          start: { line: ref.loc.line, character: ref.loc.character },
          end: {
            line: ref.loc.line,
            character: ref.loc.character + ref.name.length,
          },
        },
        kind: DocumentHighlightKind.Read,
      });
    }

    return highlights.length > 0 ? highlights : null;
  });

  // -----------------------------------------------------------------------
  // textDocument/foldingRange (US-016)
  // -----------------------------------------------------------------------

  connection.onRequest("textDocument/foldingRange", async (params, token: CancellationToken) => {
    if (token.isCancellationRequested) return [];
    const doc = ctx.documents.get(params.textDocument.uri);
    if (!doc) return [];

    const tree = parse(doc.getText(), doc.uri);
    if (!tree) return [];

    return produceFoldingRanges(tree);
  });

  // -----------------------------------------------------------------------
  // textDocument/signatureHelp (US-017)
  // -----------------------------------------------------------------------

  connection.onRequest("textDocument/signatureHelp", async (params, token: CancellationToken) => {
    if (token.isCancellationRequested) return null;
    const doc = ctx.documents.get(params.textDocument.uri);
    if (!doc) return null;

    const table = await ctx.getSymbolTable(params.textDocument.uri);
    if (!table || token.isCancellationRequested) return null;

    const tree = parse(doc.getText(), doc.uri);
    if (!tree) return null;

    return produceSignatureHelp(
      tree,
      table,
      params.position.line,
      params.position.character,
      ctx.stdlibIndex,
      {
        table,
        uri: params.textDocument.uri,
        index: ctx.index,
        stdlibIndex: ctx.stdlibIndex,
        typeInferrer: ctx.worker
          ? async (varName: string) => {
              try {
                const result = await ctx.worker.typeof_(doc.uri, varName);
                return result.type ?? null;
              } catch {
                return null;
              }
            }
          : undefined,
      },
    );
  });

  // -----------------------------------------------------------------------
  // textDocument/inlayHint (G1)
  // -----------------------------------------------------------------------

  connection.onRequest(
    "textDocument/inlayHint",
    async (params: { textDocument: { uri: string }; range: { start: Position; end: Position } }, token: CancellationToken) => {
      if (token.isCancellationRequested) return [];

      const doc = ctx.documents.get(params.textDocument.uri);
      if (!doc) return [];

      const table = await ctx.getSymbolTable(params.textDocument.uri);
      if (!table || token.isCancellationRequested) return [];

      const tree = parse(doc.getText(), doc.uri);
      if (!tree) return [];

      return produceInlayHints({
        tree,
        table,
        range: params.range,
      });
    },
  );
}
