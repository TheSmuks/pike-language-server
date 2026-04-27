/**
 * Pike Language Server — main entry point.
 *
 * Communicates over stdio. Provides documentSymbol and parse-error diagnostics.
 */

import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  InitializeResult,
  TextDocumentSyncKind,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { initParser, parse } from "./parser";
import { getDocumentSymbols } from "./features/documentSymbol";
import { getParseDiagnostics } from "./features/diagnostics";

// ---------------------------------------------------------------------------
// Connection & document manager
// ---------------------------------------------------------------------------

const connection = createConnection(ProposedFeatures.all);

const documents = new TextDocuments(TextDocument);

// Track document versions for cache invalidation.
const versionCache = new Map<string, number>();

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

connection.onInitialize((_params: InitializeParams): InitializeResult => {
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Full,
      documentSymbolProvider: true,
    },
  };
});

connection.onInitialized(async () => {
  try {
    await initParser();
    connection.console.log("Pike LSP: parser initialized");
  } catch (err) {
    connection.console.error(`Pike LSP: parser init failed: ${(err as Error).message}`);
  }
});

// ---------------------------------------------------------------------------
// documentSymbol
// ---------------------------------------------------------------------------

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
    connection.console.error(`documentSymbol failed: ${(err as Error).message}`);
    return [];
  }
});

// ---------------------------------------------------------------------------
// Text document handlers
// ---------------------------------------------------------------------------

documents.onDidChangeContent(async (event) => {
  const doc = event.document;
  const prevVersion = versionCache.get(doc.uri) ?? -1;
  if (doc.version <= prevVersion) return;
  versionCache.set(doc.uri, doc.version);

  try {
    const tree = parse(doc.getText());
    connection.sendDiagnostics({
      uri: doc.uri,
      diagnostics: getParseDiagnostics(tree),
    });
  } catch (err) {
    connection.console.error(`parse failed: ${(err as Error).message}`);
  }
});

documents.onDidClose((event) => {
  versionCache.delete(event.document.uri);
  connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});

// ---------------------------------------------------------------------------
// Listen
// ---------------------------------------------------------------------------

documents.listen(connection);
connection.listen();
