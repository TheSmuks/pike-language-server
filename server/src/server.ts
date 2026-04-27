/**
 * Pike Language Server — main entry point.
 *
 * Communicates over stdio. Provides documentSymbol, definition, references,
 * and parse-error diagnostics.
 *
 * Architecture:
 * - `createPikeServer(connection)` — wires all handlers onto a connection.
 *   Used by tests to create an in-process server with PassThrough streams.
 * - Top-level `connection.listen()` — the production entry point over stdio.
 */

import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  InitializeResult,
  TextDocumentSyncKind,
  Connection,
  Location as LspLocation,
  Range as LspRange,
  Position as LspPosition,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { initParser, parse } from "./parser";
import { getDocumentSymbols } from "./features/documentSymbol";
import { getParseDiagnostics } from "./features/diagnostics";
import {
  buildSymbolTable,
  wireInheritance,
  getDefinitionAt,
  getReferencesTo,
  type SymbolTable,
} from "./features/symbolTable";

// ---------------------------------------------------------------------------
// Server factory — reusable for production and tests
// ---------------------------------------------------------------------------

export interface PikeServer {
  connection: Connection;
  documents: TextDocuments<TextDocument>;
}

/**
 * Wire all LSP handlers onto the given connection.
 * Does NOT call connection.listen() — the caller decides when to start.
 */
export function createPikeServer(connection: Connection): PikeServer {
  const documents = new TextDocuments(TextDocument);

  // Track document versions for cache invalidation.
  const versionCache = new Map<string, number>();

  // Symbol table cache — invalidated on document change, rebuilt lazily.
  const symbolTableCache = new Map<string, SymbolTable>();

  /**
   * Get or build the symbol table for a document.
   * Lazy rebuild: only computed when requested, cached until document changes.
   */
  function getSymbolTable(uri: string): SymbolTable | null {
    const cached = symbolTableCache.get(uri);
    if (cached) return cached;

    const doc = documents.get(uri);
    if (!doc) return null;

    try {
      const tree = parse(doc.getText());
      const table = buildSymbolTable(tree, uri, doc.version);
      symbolTableCache.set(uri, table);
      return table;
    } catch (err) {
      connection.console.error(
        `symbolTable build failed: ${(err as Error).message}`,
      );
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // Initialization
  // -----------------------------------------------------------------------

  connection.onInitialize(
    (_params: InitializeParams): InitializeResult => {
      return {
        capabilities: {
          textDocumentSync: TextDocumentSyncKind.Full,
          documentSymbolProvider: true,
          definitionProvider: true,
          referencesProvider: true,
        },
      };
    },
  );

  connection.onInitialized(async () => {
    try {
      await initParser();
      connection.console.log("Pike LSP: parser initialized");
    } catch (err) {
      connection.console.error(
        `Pike LSP: parser init failed: ${(err as Error).message}`,
      );
    }
  });

  // -----------------------------------------------------------------------
  // documentSymbol
  // -----------------------------------------------------------------------

  connection.onDocumentSymbol(async (params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];

    try {
      const tree = parse(doc.getText());

      // Report parse errors as diagnostics.
      const diagnostics = getParseDiagnostics(tree);
      connection.sendDiagnostics({ uri: doc.uri, diagnostics });

      // Return partial symbols — never crash on parse errors.
      return getDocumentSymbols(tree);
    } catch (err) {
      connection.console.error(
        `documentSymbol failed: ${(err as Error).message}`,
      );
      return [];
    }
  });

  // -----------------------------------------------------------------------
  // textDocument/definition
  // -----------------------------------------------------------------------

  connection.onDefinition(async (params) => {
    const table = getSymbolTable(params.textDocument.uri);
    if (!table) return null;

    const decl = getDefinitionAt(
      table,
      params.position.line,
      params.position.character,
    );

    if (!decl) return null;

    const loc: LspLocation = {
      uri: table.uri,
      range: {
        start: { line: decl.nameRange.start.line, character: decl.nameRange.start.character },
        end: { line: decl.nameRange.end.line, character: decl.nameRange.end.character },
      },
    };

    return loc;
  });

  // -----------------------------------------------------------------------
  // textDocument/references
  // -----------------------------------------------------------------------

  connection.onReferences(async (params) => {
    const table = getSymbolTable(params.textDocument.uri);
    if (!table) return [];

    const refs = getReferencesTo(
      table,
      params.position.line,
      params.position.character,
    );

    return refs.map((ref) => ({
      uri: table.uri,
      range: {
        start: { line: ref.loc.line, character: ref.loc.character },
        end: { line: ref.loc.line, character: ref.loc.character + ref.name.length },
      },
    }));
  });

  // -----------------------------------------------------------------------
  // Shutdown
  // -----------------------------------------------------------------------

  connection.onShutdown(() => {
    symbolTableCache.clear();
    versionCache.clear();
  });

  // -----------------------------------------------------------------------
  // Text document handlers
  // -----------------------------------------------------------------------

  documents.onDidChangeContent(async (event) => {
    const doc = event.document;
    const prevVersion = versionCache.get(doc.uri) ?? -1;
    if (doc.version <= prevVersion) return;
    versionCache.set(doc.uri, doc.version);

    // Invalidate symbol table cache
    symbolTableCache.delete(doc.uri);

    try {
      const tree = parse(doc.getText());
      connection.sendDiagnostics({
        uri: doc.uri,
        diagnostics: getParseDiagnostics(tree),
      });
    } catch (err) {
      connection.console.error(
        `parse failed: ${(err as Error).message}`,
      );
    }
  });

  documents.onDidClose((event) => {
    versionCache.delete(event.document.uri);
    symbolTableCache.delete(event.document.uri);
    connection.sendDiagnostics({
      uri: event.document.uri,
      diagnostics: [],
    });
  });

  documents.listen(connection);

  return { connection, documents };
}

// ---------------------------------------------------------------------------
// Production entry point: stdio transport
// Only runs when this module is executed directly, not when imported by tests.
// ---------------------------------------------------------------------------

// @ts-ignore — Bun import.meta.main is true only when run directly
if (import.meta?.main) {
  const connection = createConnection(ProposedFeatures.all);
  const server = createPikeServer(connection);
  server.connection.listen();
}
