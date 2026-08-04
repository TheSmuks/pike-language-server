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
  type DocumentRangeFormattingParams,
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
  /** Called before each request — records activity and gates on wake. */
  beforeRequest?: () => Promise<void>;
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
 * Edits confined to `[startLine, endLine]`, as whole lines.
 *
 * Range formatting used to reformat the whole document and hand back one edit
 * spanning it, so VSCode's Format Selection — and format-on-paste, which routes
 * through the same request — silently rewrote every line of the file. The
 * formatter still runs over the whole text, because indentation depends on
 * enclosing context, but only the requested lines are written back.
 *
 * A formatter that changed the line COUNT cannot be mapped line-for-line, and
 * guessing would put the wrong text on the wrong line. In that case the edit is
 * dropped rather than widened back to the whole document.
 */
function editsForLineRange(
  original: string,
  formatted: string,
  startLine: number,
  endLine: number,
): TextEdit[] {
  if (original === formatted) return [];

  const originalLines = original.split("\n");
  const formattedLines = formatted.split("\n");
  if (originalLines.length !== formattedLines.length) return [];

  const first = Math.max(0, startLine);
  const last = Math.min(endLine, originalLines.length - 1);
  if (first > last) return [];

  const replacement = formattedLines.slice(first, last + 1).join("\n");
  if (replacement === originalLines.slice(first, last + 1).join("\n")) return [];

  return [{
    range: {
      start: { line: first, character: 0 },
      end: { line: last, character: originalLines[last].length },
    },
    newText: replacement,
  }];
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
    async (params, token) => {
      await ctx.beforeRequest?.();
      return handleFormatting(connection, ctx, params, token);
    },
  );
  connection.onDocumentRangeFormatting(
    async (params, token) => {
      await ctx.beforeRequest?.();
      return handleRangeFormatting(connection, ctx, params, token);
    },
  );
  connection.onDocumentOnTypeFormatting(
    async (params, token) => {
      await ctx.beforeRequest?.();
      return handleOnTypeFormatting(connection, ctx, params, token);
    },
  );
}

// ---------------------------------------------------------------------------
// Range formatting
//
// pike-fmt operates on whole documents (it re-derives indentation from the
// full parse tree), so true selection-only formatting is not available. Rather
// than leave "Format Selection" as a dead menu item, we format the whole
// document — a predictable, non-corrupting transformation — and return no
// edits when the document is already formatted.
// ---------------------------------------------------------------------------

async function handleRangeFormatting(
  connection: Connection,
  ctx: FormattingContext,
  params: DocumentRangeFormattingParams,
  token: CancellationToken,
): Promise<TextEdit[] | null> {
  if (token.isCancellationRequested) return null;
  const doc = ctx.documents.get(params.textDocument.uri);
  if (!doc) return null;

  const source = doc.getText();
  const options = params.options;

  try {
    if (!parserInstance) {
      logError(connection, ErrorCategory.System, "formattingHandler.handleRangeFormatting", new Error("parser not initialized"));
      return null;
    }
    const formatted = pikeFormat(source, {
      tabSize: options.tabSize ?? 4,
      useTabs: options.insertSpaces === false,
      insertFinalNewline: ctx.formattingConfig.insertFinalNewline,
      operatorSpacing: ctx.formattingConfig.operatorSpacing,
    }, parserInstance);

    // LSP: a range-formatting edit must stay inside the requested range. The
    // range is treated as whole lines, which is what clients send for Format
    // Selection and what the formatter can meaningfully act on.
    return editsForLineRange(
      source, formatted, params.range.start.line, params.range.end.line,
    );
  } catch (err) {
    logError(connection, ErrorCategory.System, "formattingHandler.handleRangeFormatting", err);
    return null;
  }
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
