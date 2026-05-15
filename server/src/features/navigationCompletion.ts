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
 * Register completion handlers on the connection.
 */
export function registerCompletionHandlers(
  connection: Connection,
  ctx: NavigationContext,
): void {
  /** Build a source-aware type inferrer using PikeWorker.typeof_(). */
  const makeTypeInferrer = (source: string): ((varName: string) => Promise<string | null>) => {
    return async (varName: string) => {
      try {
        const result = await ctx.worker.typeof_(source, varName);
        if (result.type && !result.error) return result.type;
      } catch {
        // Worker unavailable — fall through
      }
      return null;
    };
  };

  const completionBase = {
    index: ctx.index,
    stdlibIndex: ctx.stdlibIndex,
    predefBuiltins: ctx.predefBuiltins,
  };

  // -----------------------------------------------------------------------
  // textDocument/completion (decision 0012)
  // -----------------------------------------------------------------------

  connection.onCompletion(async (params, token: CancellationToken) => {
    // Check cancellation early — if a new keystroke already came in, bail
    if (token.isCancellationRequested) return { isIncomplete: false, items: [] };

    const doc = ctx.documents.get(params.textDocument.uri);
    if (!doc) return { isIncomplete: false, items: [] };

    const table = await ctx.getSymbolTable(params.textDocument.uri);
    if (!table || token.isCancellationRequested)
      return { isIncomplete: false, items: [] };

    try {
      const source = doc.getText();
      const tree = parse(source, params.textDocument.uri);
      if (token.isCancellationRequested)
        return { isIncomplete: false, items: [] };

      // Capture the identifier prefix range synchronously before any async
      // gap. The tree is stored in the parse() LRU cache and can be evicted
      // (and deleted) during an await — after which tree.rootNode is null.
      const prefixRange = findIdentifierPrefixRange(
        tree,
        params.position.line,
        params.position.character,
      );

      const result = await getCompletions(table, tree, params.position.line, params.position.character, {
        ...completionBase,
        uri: params.textDocument.uri,
        source,
        typeInferrer: makeTypeInferrer(source),
      });

      // Add textEdit to each item so the client replaces the identifier
      // prefix being typed instead of inserting at the cursor position.
      // This prevents doubled text like "foo.bbar" when completing "bar"
      // after typing "foo.b".
      //
      // For call_args items (triggered by '('), the insertText is a snippet
      // that should be inserted at the cursor (right after the '('). These
      // items already have insertText but no textEdit — VSCode will insert
      // at cursor position, which is the desired behavior.
      if (prefixRange) {
        for (const item of result.items) {
          if (!item.textEdit) {
            // Use insertText (which may be a snippet) if available, else label.
            const newText = item.insertText ?? item.label;
            item.textEdit = {
              range: prefixRange,
              newText,
            };
            // insertText is redundant when textEdit is present; clear it
            // unless it's a snippet (in which case the textEdit carries it).
            delete item.insertText;
          }
        }
      }

      return result;
    } catch (err) {
      logError(connection, ErrorCategory.Diagnostics, "navigationHandler.handleCompletion", err);
      return { isIncomplete: false, items: [] };
    }
  });

  // -----------------------------------------------------------------------
  // completionItem/resolve — lazy stdlib markdown docs (Tier 3.2)
  // -----------------------------------------------------------------------

  interface CompletionResolveData {
    source: "stdlib" | "autoimport";
    fqn: string;
    module?: string;
    symbolName?: string;
  }

  connection.onCompletionResolve(async (item: CompletionItem) => {
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
  });
}
