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
 * Compute TextEdit[] that transforms original into formatted.
 *
 * Uses a single full-document replace when the formatter produces any change.
 * This is the standard LSP formatter approach — pike-fmt normalizes indentation,
 * internal whitespace, blank lines, and operator spacing, so a line-by-line
 * indentation-only diff would silently drop most formatting changes and produce
 * a corrupt half-formatted result.
 */
function computeEdits(
  original: string,
  formatted: string,
): TextEdit[] {
  if (original === formatted) return [];

  // Count lines to build a range that covers the entire document.
  // end position is start of the line after the last content line,
  // with character 0 — this captures the trailing newline if present.
  const lines = original.split("\n");
  const lastLine = lines.length - 1;

  return [
    {
      range: {
        start: { line: 0, character: 0 },
        end: { line: lastLine, character: lines[lastLine].length },
      },
      newText: formatted,
    },
  ];
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
    (params, token) => handleFormatting(connection, ctx, params, token),
  );
  connection.onDocumentOnTypeFormatting(
    (params, token) => handleOnTypeFormatting(connection, ctx, params, token),
  );
}

// ---------------------------------------------------------------------------
// Full-document formatting
// ---------------------------------------------------------------------------

async function handleFormatting(
  connection: Connection,
  ctx: FormattingContext,
  params: DocumentFormattingParams,
  token: CancellationToken,
): Promise<TextEdit[] | null> {
  if (token.isCancellationRequested) return null;
  const doc = ctx.documents.get(params.textDocument.uri);
  if (!doc) return null;

  const source = doc.getText();
  const options = params.options;

  try {
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

    return computeEdits(source, formatted);
  } catch (err) {
    logError(connection, ErrorCategory.System, "formattingHandler.handleFormatting", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// On-type formatting: fix indentation when user types '}' or ';'.
//
// Strategy: format only the affected line range rather than the full
// document. We parse the document, find the correct indentation for the
// line the trigger character is on (and for '}', also the line above if
// it's a closing block), and return minimal edits.
// ---------------------------------------------------------------------------

async function handleOnTypeFormatting(
  connection: Connection,
  ctx: FormattingContext,
  params: DocumentOnTypeFormattingParams,
  token: CancellationToken,
): Promise<TextEdit[] | null> {
  if (token.isCancellationRequested) return null;
  const doc = ctx.documents.get(params.textDocument.uri);
  if (!doc) return null;

  const source = doc.getText();
  const options = params.options;
  const triggerLine = params.position.line;

  try {
    if (!parserInstance) return null;

    const formatted = pikeFormat(source, {
      tabSize: options.tabSize ?? 4,
      useTabs: options.insertSpaces === false,
      insertFinalNewline: ctx.formattingConfig.insertFinalNewline,
      operatorSpacing: ctx.formattingConfig.operatorSpacing,
    }, parserInstance);

    return computeOnTypeEdits(source, formatted, params.ch, triggerLine);
  } catch (err) {
    logError(connection, ErrorCategory.System, "formattingHandler.handleOnTypeFormatting", err);
    return null;
  }
}

/**
 * Compute minimal on-type formatting edits.
 *
 * Compares the full original and formatted text by finding the common
 * prefix and suffix of lines, then returns a single TextEdit that replaces
 * the differing middle range. This correctly handles all cases where the
 * formatter adds, removes, or modifies lines — unlike an index-based
 * comparison which breaks when line counts differ.
 */
function computeOnTypeEdits(
  source: string,
  formatted: string,
  triggerChar: string,
  triggerLine: number,
): TextEdit[] | null {
  if (source === formatted) return null;

  const origLines = source.split("\n");
  const fmtLines = formatted.split("\n");

  // Find the first line that differs
  let startLine = 0;
  while (startLine < origLines.length && startLine < fmtLines.length) {
    if (origLines[startLine] !== fmtLines[startLine]) break;
    startLine++;
  }

  // If all lines matched up to the shorter length and lengths are equal, no change
  if (
    startLine === origLines.length &&
    startLine === fmtLines.length
  ) {
    return null;
  }

  // Find the last line that differs (walking backwards from the end)
  let endOrig = origLines.length - 1;
  let endFmt = fmtLines.length - 1;
  while (endOrig > startLine && endFmt > startLine) {
    if (origLines[endOrig] !== fmtLines[endFmt]) break;
    endOrig--;
    endFmt--;
  }

  // Build the replacement range in the original
  const newText = fmtLines.slice(startLine, endFmt + 1).join("\n");
  const oldText = origLines.slice(startLine, endOrig + 1).join("\n");
  if (oldText === newText) return null;

  return [
    {
      range: {
        start: { line: startLine, character: 0 },
        end: { line: endOrig, character: origLines[endOrig].length },
      },
      newText,
    },
  ];
}