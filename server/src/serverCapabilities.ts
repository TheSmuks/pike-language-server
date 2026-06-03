/**
 * Server capabilities definition for the Pike Language Server.
 *
 * Extracted from server.ts so the main file stays under the 500-line
 * project convention.
 */

import {
  TextDocumentSyncKind,
  SemanticTokensOptions,
  SemanticTokensRegistrationOptions,
} from "vscode-languageserver/node";
import type { InitializeResult } from "vscode-languageserver/node";
import { SEMANTIC_TOKENS_LEGEND } from "./features/semanticTokens";

// ---------------------------------------------------------------------------
// Sub-helpers
// ---------------------------------------------------------------------------

function buildTextDocumentSync(): object {
  return {
    openClose: true,
    change: TextDocumentSyncKind.Incremental,
    save: { includeText: true },
  };
}

function buildCompletionProvider(): object {
  return {
    triggerCharacters: ['.'],
    resolveProvider: true,
  };
}

function buildSemanticTokensProvider(): SemanticTokensOptions {
  return {
    legend: SEMANTIC_TOKENS_LEGEND,
    full: true,
    range: true,
  };
}

function buildCodeActionProvider(): object {
  return {
    codeActionKinds: [
      "quickfix",
      "source.fixAll",
      "source.organizeImports",
      "refactor.extract.variable",
    ],
  };
}

function buildWorkspaceFileOperations(): object {
  return {
    fileOperations: {
      didRename: {
        filters: [
          { pattern: { glob: '**/*.pike' } },
          { pattern: { glob: '**/*.pmod' } },
        ],
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Build the InitializeResult (including the capabilities object) returned
 * to the client during the `initialize` handshake.
 */
export function buildServerCapabilities(): InitializeResult {
  return {
    capabilities: {
      textDocumentSync: buildTextDocumentSync(),
      documentSymbolProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      renameProvider: { prepareProvider: true },
      hoverProvider: true,
      completionProvider: buildCompletionProvider(),
      semanticTokensProvider: buildSemanticTokensProvider(),
      documentHighlightProvider: true,
      foldingRangeProvider: true,
      signatureHelpProvider: { triggerCharacters: ['(', ','] },
      inlayHintProvider: { resolveProvider: false },
      codeActionProvider: buildCodeActionProvider(),
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
      workspace: buildWorkspaceFileOperations(),
    },
  } satisfies InitializeResult;
}
