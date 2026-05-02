/**
 * Formatting handler for textDocument/formatting (US-026).
 *
 * Registers the formatting provider using tree-sitter-based formatter.
 */

import type { Connection } from "vscode-languageserver/node";
import type {
  TextDocuments,
  DocumentFormattingParams,
  TextEdit,
} from "vscode-languageserver/node";
import type { SymbolTable } from "./symbolTable";
import type { WorkspaceIndex } from "./workspaceIndex";
import type { PikeWorker } from "./pikeWorker";
import { formatPike, type FormatOptions } from "./formatter";
import { parse } from "../parser";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FormattingContext {
  documents: TextDocuments<import("vscode-languageserver-textdocument").TextDocument>;
  index: WorkspaceIndex;
  worker: PikeWorker;
  getSymbolTable(uri: string): Promise<SymbolTable | null>;
  stdlibIndex: Record<string, { signature: string; markdown: string }>;
  predefBuiltins: Record<string, string>;
}

export interface FormattingOptions extends FormatOptions {
  /** Maximum number of edits to return. Default: unlimited. */
  maxEdits?: number;
}

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

export function registerFormattingHandler(
  connection: Connection,
  context: FormattingContext,
): void {
  connection.onDocumentFormatting(async (params: DocumentFormattingParams): Promise<TextEdit[] | null> => {
    const uri = params.textDocument.uri;

    // Get the document
    const document = context.documents.get(uri);
    if (!document) {
      return null;
    }

    const source = document.getText();
    const options = params.options as unknown as FormattingOptions | undefined;

    // Parse the source
    let tree;
    try {
      tree = parse(source, uri);
    } catch {
      // Parse error — return null
      return null;
    }

    // Format using tree-sitter
    const edits = formatPike(source, tree, options);

    // Apply maxEdits limit if specified
    if (options?.maxEdits && options.maxEdits > 0) {
      return edits.slice(0, options.maxEdits);
    }

    return edits.length > 0 ? edits : null;
  });
}