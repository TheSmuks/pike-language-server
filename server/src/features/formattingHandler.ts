/**
 * Formatting handler — uses pike-fmt in-process via direct import.
 *
 * Architecture: the server already has web-tree-sitter and tree-sitter-pike.wasm
 * initialized. Instead of spawning a subprocess, we call pike-fmt's format()
 * function directly, avoiding subprocess overhead, timeouts, and PATH dependency.
 */

import {
  type Connection,
  type DocumentFormattingParams,
  type DocumentOnTypeFormattingParams,
  type TextEdit,
  type FormattingOptions,
  type CancellationToken,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { TextDocuments } from "vscode-languageserver/node";

import { format as pikeFormat } from "pike-fmt/src/formatter";
import { parserInstance } from "../parser";
import { logError, ErrorCategory } from "../util/errorLog.js";

interface FormattingContext {
  documents: TextDocuments<TextDocument>;
  /** Mutable formatting preferences — shared with server.ts, updated on setting changes. */
  formattingConfig: {
    insertFinalNewline: boolean;
    operatorSpacing: boolean;
  };
}

/**
 * Compute minimal TextEdit[] that transforms original into formatted.
 *
 * Simple line-by-line diff: for each line, if the leading whitespace differs,
 * produce a replace edit for that line's indentation.
 */
function computeIndentEdits(
  original: string,
  formatted: string,
): TextEdit[] {
  const origLines = original.split("\n");
  const fmtLines = formatted.split("\n");
  const edits: TextEdit[] = [];

  // Process line by line up to the longer of the two
  const maxLen = Math.max(origLines.length, fmtLines.length);
  for (let i = 0; i < maxLen; i++) {
    const origLine = origLines[i] ?? "";
    const fmtLine = fmtLines[i] ?? "";

    // Extract leading whitespace
    const origIndent = origLine.match(/^\s*/)?.[0] ?? "";
    const fmtIndent = fmtLine.match(/^\s*/)?.[0] ?? "";

    if (origIndent !== fmtIndent) {
      edits.push({
        range: {
          start: { line: i, character: 0 },
          end: { line: i, character: origIndent.length },
        },
        newText: fmtIndent,
      });
    }
  }

  // Handle trailing newline difference
  const origHasNewline = original.endsWith("\n");
  const fmtHasNewline = formatted.endsWith("\n");
  if (!origHasNewline && fmtHasNewline) {
    const lastLine = origLines.length > 0 ? origLines.length - 1 : 0;
    edits.push({
      range: {
        start: { line: lastLine, character: (origLines[lastLine] ?? "").length },
        end: { line: lastLine, character: (origLines[lastLine] ?? "").length },
      },
      newText: "\n",
    });
  }

  return edits;
}

/**
 * Register the document formatting handler on the connection.
 *
 * Calls pike-fmt's format() function directly using the already-initialized
 * tree-sitter parser. The parser is shared with the rest of the server.
 */
export function registerFormattingHandler(
  connection: Connection,
  ctx: FormattingContext,
): void {
  connection.onDocumentFormatting(
    async (params: DocumentFormattingParams, token: CancellationToken): Promise<TextEdit[] | null> => {
      if (token.isCancellationRequested) return null;
      const doc = ctx.documents.get(params.textDocument.uri);
      if (!doc) return null;

      const source = doc.getText();
      const options: FormattingOptions = params.options;

      try {
        // Use the server's already-initialized parser
        if (!parserInstance) {
          logError(connection, ErrorCategory.System, "formattingHandler.handleFormatting", new Error("parser not initialized"));
          return null;
        }
        const formatted = pikeFormat(source, {
          tabSize: options.tabSize ?? 4,
          useTabs: options.insertSpaces === false,
          insertFinalNewline: ctx.formattingConfig.insertFinalNewline,
          operatorSpacing: ctx.formattingConfig.operatorSpacing,
        }, parserInstance);

        // Compute indent edits (pike-fmt already handles full formatting)
        const edits = computeIndentEdits(source, formatted);
        return edits;
      } catch (err) {
        logError(connection, ErrorCategory.System, "formattingHandler.handleFormatting", err);
        return null;
      }
    },
  );

  // -----------------------------------------------------------------------
  // On-type formatting: fix indentation when user types '}' or ';'.
  //
  // Strategy: format only the affected line range rather than the full
  // document. We parse the document, find the correct indentation for the
  // line the trigger character is on (and for '}', also the line above if
  // it's a closing block), and return minimal edits.
  // -----------------------------------------------------------------------
  connection.onDocumentOnTypeFormatting(
    async (
      params: DocumentOnTypeFormattingParams,
      token: CancellationToken,
    ): Promise<TextEdit[] | null> => {
      if (token.isCancellationRequested) return null;
      const doc = ctx.documents.get(params.textDocument.uri);
      if (!doc) return null;

      const source = doc.getText();
      const options: FormattingOptions = params.options;
      const triggerLine = params.position.line;

      try {
        if (!parserInstance) return null;

        // Format the full document to get the correct indentation.
        // For on-type formatting we could optimize to only parse/indent
        // the relevant block, but the parser is fast (<1ms for typical
        // files) and this guarantees correctness.
        const formatted = pikeFormat(source, {
          tabSize: options.tabSize ?? 4,
          useTabs: options.insertSpaces === false,
          insertFinalNewline: ctx.formattingConfig.insertFinalNewline,
          operatorSpacing: ctx.formattingConfig.operatorSpacing,
        }, parserInstance);

        // Only return edits for lines near the trigger character.
        // '}' can affect the closing line and the line above (if the
        // block was empty). ';' affects only its own line.
        const rangeStart = params.ch === "}"
          ? Math.max(0, triggerLine - 1)
          : triggerLine;
        const rangeEnd = triggerLine + 1;

        const origLines = source.split("\n");
        const fmtLines = formatted.split("\n");
        const edits: TextEdit[] = [];

        for (let i = rangeStart; i < rangeEnd; i++) {
          if (i >= origLines.length || i >= fmtLines.length) break;
          const origIndent = origLines[i].match(/^\s*/)?.[0] ?? "";
          const fmtIndent = fmtLines[i].match(/^\s*/)?.[0] ?? "";
          if (origIndent !== fmtIndent) {
            edits.push({
              range: {
                start: { line: i, character: 0 },
                end: { line: i, character: origIndent.length },
              },
              newText: fmtIndent,
            });
          }
        }

        return edits.length > 0 ? edits : null;
      } catch (err) {
        // On-type formatting should be silent — never bother the user.
        return null;
      }
    },
  );
}