/**
 * Completion handlers — textDocument/completion + completionItem/resolve.
 *
 * Extracted from navigationHandler.ts to keep file sizes under 500 lines.
 */

import {
  type Connection,
  type CancellationToken,
  type CompletionItem,
  MarkupKind,
} from "vscode-languageserver/node";
import type { NavigationContext } from "./navigationHandler";
import { getCompletions } from "./completion";
import { findIdentifierPrefixRange } from "./completion-items";
import { parse } from "../parser";
import { logError, ErrorCategory } from "../util/errorLog.js";

/**
 * Attach textEdit to each completion item that doesn't already have one,
 * replacing the identifier prefix being typed instead of inserting at cursor.
 */
function attachPrefixTextEdits(
  items: CompletionItem[],
  prefixRange: { start: { line: number; character: number }; end: { line: number; character: number } },
): void {
  for (const item of items) {
    if (!item.textEdit) {
      const newText = item.insertText ?? item.label;
      item.textEdit = { range: prefixRange, newText };
      // insertText is redundant when textEdit is present; clear it.
      delete item.insertText;
    }
  }
}

interface CompletionResolveData {
  source: "stdlib" | "autoimport";
  fqn: string;
  module?: string;
  symbolName?: string;
}

/**
 * Register completion handlers on the connection.
 */
export function registerCompletionHandlers(
  connection: Connection,
  ctx: NavigationContext,
): void {
  const makeTypeInferrer = buildTypeInferrerFactory(ctx);
  const completionBase = {
    index: ctx.index,
    stdlibIndex: ctx.stdlibIndex,
    predefBuiltins: ctx.predefBuiltins,
  };

  // -----------------------------------------------------------------------
  // textDocument/completion (decision 0012)
  // -----------------------------------------------------------------------

  connection.onCompletion((params, token: CancellationToken) =>
    handleCompletion(connection, ctx, completionBase, makeTypeInferrer, params, token),
  );

  // -----------------------------------------------------------------------
  // completionItem/resolve — lazy stdlib markdown docs (Tier 3.2)
  // -----------------------------------------------------------------------

  connection.onCompletionResolve((item: CompletionItem) =>
    resolveCompletionItem(ctx, item),
  );
}

/** Build a factory that creates source-aware type inferrers. */
function buildTypeInferrerFactory(
  ctx: NavigationContext,
): (source: string) => (varName: string) => Promise<string | null> {
  return (source: string) => async (varName: string) => {
    try {
      const result = await ctx.worker.typeof_(source, varName);
      if (result.type && !result.error) return result.type;
    } catch {
      // Worker unavailable — fall through
    }
    return null;
  };
}

/** Handle textDocument/completion requests. */
async function handleCompletion(
  connection: Connection,
  ctx: NavigationContext,
  completionBase: { index: typeof ctx.index; stdlibIndex: typeof ctx.stdlibIndex; predefBuiltins: typeof ctx.predefBuiltins },
  makeTypeInferrer: (source: string) => (varName: string) => Promise<string | null>,
  params: { textDocument: { uri: string }; position: { line: number; character: number } },
  token: CancellationToken,
): Promise<{ isIncomplete: boolean; items: CompletionItem[] }> {
  const empty: { isIncomplete: false; items: CompletionItem[] } = { isIncomplete: false, items: [] };
  if (token.isCancellationRequested) return empty;

  const doc = ctx.documents.get(params.textDocument.uri);
  if (!doc) return empty;

  const table = await ctx.getSymbolTable(params.textDocument.uri);
  if (!table || token.isCancellationRequested) return empty;

  try {
    const source = doc.getText();
    const tree = parse(source, params.textDocument.uri);
    if (token.isCancellationRequested) return empty;

    const prefixRange = findIdentifierPrefixRange(
      tree, params.position.line, params.position.character,
    );

    const result = await getCompletions(
      table, tree, params.position.line, params.position.character,
      { ...completionBase, uri: params.textDocument.uri, source, typeInferrer: makeTypeInferrer(source) },
    );

    if (prefixRange) attachPrefixTextEdits(result.items, prefixRange);
    return result;
  } catch (err) {
    logError(connection, ErrorCategory.Diagnostics, "navigationHandler.handleCompletion", err);
    return { isIncomplete: false, items: [] };
  }
}

/** Resolve a completion item with lazy stdlib markdown docs. */
function resolveCompletionItem(
  ctx: NavigationContext,
  item: CompletionItem,
): CompletionItem {
  const data = item.data as CompletionResolveData | undefined;
  if (!data) return item;
  if ((data.source === "stdlib" || data.source === "autoimport") && data.fqn) {
    const entry = ctx.stdlibIndex[data.fqn];
    if (entry?.markdown) {
      item.documentation = { kind: MarkupKind.Markdown, value: entry.markdown };
    }
    if (data.source === "autoimport" && entry?.signature) {
      item.detail = entry.signature + ` (auto-import from ${data.module})`;
    }
  }
  return item;
}
