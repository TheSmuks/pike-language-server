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
  getDefinitionAt,
  getReferencesTo,
  type SymbolTable,
} from "./features/symbolTable";
import { WorkspaceIndex, ModificationSource } from "./features/workspaceIndex";

// ---------------------------------------------------------------------------
// Server factory — reusable for production and tests
// ---------------------------------------------------------------------------

export interface PikeServer {
  connection: Connection;
  documents: TextDocuments<TextDocument>;
  index: WorkspaceIndex;
}

/**
 * Wire all LSP handlers onto the given connection.
 * Does NOT call connection.listen() — the caller decides when to start.
 */
export function createPikeServer(connection: Connection): PikeServer {
  const documents = new TextDocuments(TextDocument);

  // Workspace index — initialized in onInitialize with the workspace root.
  // Starts with a placeholder path; overwritten when the client sends init.
  let index = new WorkspaceIndex({ workspaceRoot: "/tmp/unused" });

  /**
   * Get or build the symbol table for a document.
   * Uses the workspace index for lazy rebuild.
   */
  function getSymbolTable(uri: string): SymbolTable | null {
    const entry = index.getFile(uri);
    if (entry?.symbolTable) return entry.symbolTable;

    const doc = documents.get(uri);
    if (!doc) return null;

    try {
      const tree = parse(doc.getText());
      index.upsertFile(uri, doc.version, tree, doc.getText(), ModificationSource.DidChange);
      return index.getSymbolTable(uri);
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

  connection.onInitialize((params: InitializeParams) => {
    const rootUri = params.rootUri ?? params.rootPath ?? "";
    const rootPath = rootUri.startsWith("file://") ? rootUri.slice(7) : rootUri;
    index = new WorkspaceIndex({ workspaceRoot: rootPath });

    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Full,
        documentSymbolProvider: true,
        definitionProvider: true,
        referencesProvider: true,
      },
    } satisfies InitializeResult;
  });

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

    // Try same-file resolution first
    const decl = getDefinitionAt(
      table,
      params.position.line,
      params.position.character,
    );

    if (decl) {
      const loc: LspLocation = {
        uri: table.uri,
        range: {
          start: { line: decl.nameRange.start.line, character: decl.nameRange.start.character },
          end: { line: decl.nameRange.end.line, character: decl.nameRange.end.character },
        },
      };
      return loc;
    }

    // Try cross-file resolution
    const crossFile = index.resolveCrossFileDefinition(
      params.textDocument.uri,
      params.position.line,
      params.position.character,
    );

    if (crossFile) {
      const loc: LspLocation = {
        uri: crossFile.uri,
        range: {
          start: { line: crossFile.decl.nameRange.start.line, character: crossFile.decl.nameRange.start.character },
          end: { line: crossFile.decl.nameRange.end.line, character: crossFile.decl.nameRange.end.character },
        },
      };
      return loc;
    }

    return null;
  });

  // -----------------------------------------------------------------------
  // textDocument/references
  // -----------------------------------------------------------------------

  connection.onReferences(async (params) => {
    const table = getSymbolTable(params.textDocument.uri);
    if (!table) return [];

    // Try cross-file references
    const crossFileRefs = index.getCrossFileReferences(
      params.textDocument.uri,
      params.position.line,
      params.position.character,
    );

    if (crossFileRefs.length > 0) {
      return crossFileRefs.map(({ uri, ref }) => ({
        uri,
        range: {
          start: { line: ref.loc.line, character: ref.loc.character },
          end: { line: ref.loc.line, character: ref.loc.character + ref.name.length },
        },
      }));
    }

    // Fallback to same-file references
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
    index.clear();
  });

  // -----------------------------------------------------------------------
  // Text document handlers
  // -----------------------------------------------------------------------

  documents.onDidChangeContent(async (event) => {
    const doc = event.document;

    try {
      const tree = parse(doc.getText());

      // Update workspace index, invalidating dependents
      const invalidated = index.invalidateWithDependents(doc.uri);
      index.upsertFile(doc.uri, doc.version, tree, doc.getText(), ModificationSource.DidChange);

      if (invalidated.length > 1) {
        connection.console.log(
          `Invalidated ${invalidated.length} files (change in ${doc.uri})`,
        );
      }

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
    index.removeFile(event.document.uri);
    connection.sendDiagnostics({
      uri: event.document.uri,
      diagnostics: [],
    });
  });

  documents.listen(connection);

  return { connection, documents, index };
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
