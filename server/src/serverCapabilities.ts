/**
 * Server capabilities definition for the Pike Language Server.
 *
 * Extracted from server.ts so the main file stays under the 500-line
 * project convention.
 */

import {
  FileOperationPatternKind,
  TextDocumentSyncKind,
  SemanticTokensOptions,
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
    // '.' — module/dot member access; '>' — the second char of the `->`
    // object-access operator (Pike's primary member operator); ':' — the
    // second char of the `::` inherit-scope operator. Without '>' and ':'
    // the client never auto-invokes completion after `->`/`::`; the trigger
    // context is disambiguated by tree-sitter in completionTrigger.ts.
    triggerCharacters: ['.', '>', ':'],
    resolveProvider: true,
  };
}

function buildSemanticTokensProvider(): SemanticTokensOptions {
  return {
    legend: SEMANTIC_TOKENS_LEGEND,
    // Delta support: the client sends the resultId it holds and we reply with
    // only the changed slice of the token array instead of the whole file.
    full: { delta: true },
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
          {
            scheme: "file",
            pattern: {
              glob: '**/*.pike',
              matches: FileOperationPatternKind.file,
            },
          },
          {
            scheme: "file",
            pattern: {
              glob: '**/*.pmod',
              matches: FileOperationPatternKind.file,
            },
          },
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
      declarationProvider: true,
      typeDefinitionProvider: true,
      referencesProvider: true,
      renameProvider: { prepareProvider: true },
      hoverProvider: true,
      completionProvider: buildCompletionProvider(),
      semanticTokensProvider: buildSemanticTokensProvider(),
      documentHighlightProvider: true,
      foldingRangeProvider: true,
      signatureHelpProvider: {
        triggerCharacters: ['(', ','],
        // Re-resolve the active parameter as the user moves between arguments
        // while the popup is already open.
        retriggerCharacters: [','],
      },
      inlayHintProvider: { resolveProvider: false },
      codeActionProvider: buildCodeActionProvider(),
      workspaceSymbolProvider: true,
      documentLinkProvider: { resolveProvider: false },
      documentFormattingProvider: true,
      documentRangeFormattingProvider: true,
      documentOnTypeFormattingProvider: {
        firstTriggerCharacter: "}",
        moreTriggerCharacter: [";"],
      },
      selectionRangeProvider: true,
      callHierarchyProvider: true,
      typeHierarchyProvider: true,
      codeLensProvider: { resolveProvider: true },
      implementationProvider: true,
      workspace: buildWorkspaceFileOperations(),
    },
  } satisfies InitializeResult;
}
