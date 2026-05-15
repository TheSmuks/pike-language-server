/**
 * Server capabilities definition for the Pike Language Server.
 *
 * Extracted from server.ts so the main file stays under the 500-line
 * project convention.
 */

import {
  TextDocumentSyncKind,
} from "vscode-languageserver/node";
import type { InitializeResult } from "vscode-languageserver/node";
import { SEMANTIC_TOKENS_LEGEND } from "./features/semanticTokens";

/**
 * Build the InitializeResult (including the capabilities object) returned
 * to the client during the `initialize` handshake.
 */
export function buildServerCapabilities(): InitializeResult {
  return {
    capabilities: {
      textDocumentSync: {
        openClose: true,
        // Incremental sync: client sends only the changed range per keystroke.
        // vscode-languageserver-textdocument merges incremental edits into
        // the full document automatically — doc.getText() still works unchanged.
        // Decision: gopls/rust-analyzer both use incremental for lower latency
        // on large files (100 bytes per edit vs full document transfer).
        change: TextDocumentSyncKind.Incremental,
        save: { includeText: true },
      },
      documentSymbolProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      renameProvider: { prepareProvider: true },
      hoverProvider: true,
      completionProvider: {
        triggerCharacters: ['.', '>', ':', '('],
        resolveProvider: true,
      },
      semanticTokensProvider: {
        legend: SEMANTIC_TOKENS_LEGEND,
        full: true,
      },
      documentHighlightProvider: true,
      foldingRangeProvider: true,
      signatureHelpProvider: {
        triggerCharacters: ['(', ','],
      },
      inlayHintProvider: { resolveProvider: false },
      codeActionProvider: {
        codeActionKinds: [
          "quickfix",
          "source.fixAll",
          "source.organizeImports",
          "refactor.extract.variable",
        ],
      },
      workspaceSymbolProvider: true,
      documentLinkProvider: { resolveProvider: false },
      documentFormattingProvider: true,
      documentOnTypeFormattingProvider: {
        firstTriggerCharacter: "}",
        moreTriggerCharacter: [";"],
      },
      selectionRangeProvider: true,
      callHierarchyProvider: true,
      typeHierarchyProvider: true,
      codeLensProvider: { resolveProvider: false },
      implementationProvider: true,
      diagnosticProvider: {
        interFileDependencies: false,
        workspaceDiagnostics: false,
      },
      workspace: {
        fileOperations: {
          didRename: { filters: [{ pattern: { glob: '**/*.pike' } }, { pattern: { glob: '**/*.pmod' } }] },
        },
      },
    },
  } satisfies InitializeResult;
}
