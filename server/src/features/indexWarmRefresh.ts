/**
 * Wiring for "index-warm refresh" of CodeLens / diagnostics / semantic tokens.
 *
 * The background indexer walks the workspace and inserts files into the
 * WorkspaceIndex asynchronously. Features that depend on cross-file data
 * (CodeLens reference counts, diagnostics for the open file, semantic tokens)
 * are computed against the index at open time, so they stay stale until the
 * next edit if a dependency was missing at open.
 *
 * This module installs a debounced (200 ms) refresh scheduler that:
 *   1. Looks up dependents of each newly-indexed file via
 *      `WorkspaceIndex.getDependents()`.
 *   2. If a dependent is currently open, republishes its diagnostics and
 *      requests CodeLens + semantic-tokens refresh.
 *   3. Invalidates the dependent's symbol table via
 *      `WorkspaceIndex.rewireDependents()` so the next analysis sees the
 *      newly-available target.
 *
 * Refreshes are coalesced — a full workspace scan triggers one refresh per
 * batch, not one per file.
 */

import type { Connection } from "vscode-languageserver/node";
import type { TextDocuments } from "vscode-languageserver/node";
import type { TextDocument } from "vscode-languageserver-textdocument";
import { logError, ErrorCategory } from "../util/errorLog";
import type { WorkspaceIndex } from "./workspaceIndex";

export interface IndexWarmRefreshContext {
  connection: Connection;
  documents: TextDocuments<TextDocument>;
  index: WorkspaceIndex;
  clientSupportsSemanticTokensRefresh: boolean;
  diagnosticManager: { onDidChange(uri: string): void };
}

export interface IndexWarmRefreshHandle {
  onFileIndexed: (uri: string) => void;
  cancel: () => void;
}

const REFRESH_DEBOUNCE_MS = 200;

export function createIndexWarmRefresh(
  ctx: IndexWarmRefreshContext,
): IndexWarmRefreshHandle {
  const pendingRefresh = new Set<string>();
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;

  const flush = (): void => {
    refreshTimer = undefined;
    if (pendingRefresh.size === 0) return;
    const openAffected = countOpenAffected(ctx, pendingRefresh);
    if (openAffected > 0) {
      requestCodeLensRefresh(ctx);
      requestSemanticTokensRefresh(ctx);
    }
    pendingRefresh.clear();
  };

  const schedule = (depUri: string): void => {
    pendingRefresh.add(depUri);
    if (refreshTimer !== undefined) return;
    refreshTimer = setTimeout(flush, REFRESH_DEBOUNCE_MS);
  };

  const onFileIndexed = (uri: string): void => {
    // 1. Invalidate dependents so wireInheritance re-runs with the new
    //    target table now present in the WorkspaceIndex.
    ctx.index.rewireDependents(uri);
    // 2. Schedule a UI refresh for each open dependent of the new file.
    for (const dep of ctx.index.getDependents(uri)) {
      schedule(dep);
    }
  };

  const cancel = (): void => {
    if (refreshTimer !== undefined) {
      clearTimeout(refreshTimer);
      refreshTimer = undefined;
    }
    pendingRefresh.clear();
  };

  return { onFileIndexed, cancel };
}

function requestCodeLensRefresh(ctx: IndexWarmRefreshContext): void {
  try {
    const result = ctx.connection.sendRequest(
      "workspace/codeLens/refresh",
    ) as unknown;
    if (result && typeof (result as Promise<void>).catch === "function") {
      void (result as Promise<void>).catch((err: unknown) => {
        logError(
          ctx.connection,
          ErrorCategory.System,
          "workspace/codeLens/refresh",
          err,
        );
      });
    }
  } catch (err) {
    logError(
      ctx.connection,
      ErrorCategory.System,
      "workspace/codeLens/refresh",
      err,
    );
  }
}

function requestSemanticTokensRefresh(ctx: IndexWarmRefreshContext): void {
  if (!ctx.clientSupportsSemanticTokensRefresh) return;
  try {
    const result = ctx.connection.languages.semanticTokens.refresh() as unknown;
    if (result && typeof (result as Promise<void>).catch === "function") {
      void (result as Promise<void>).catch((err: unknown) => {
        logError(
          ctx.connection,
          ErrorCategory.System,
          "semanticTokens.refresh",
          err,
        );
      });
    }
  } catch (err) {
    logError(
      ctx.connection,
      ErrorCategory.System,
      "semanticTokens.refresh",
      err,
    );
  }
}

function countOpenAffected(
  ctx: IndexWarmRefreshContext,
  uris: Set<string>,
): number {
  const open = new Set<string>();
  for (const doc of ctx.documents.all()) {
    open.add(doc.uri);
  }
  let count = 0;
  for (const uri of uris) {
    if (!open.has(uri)) continue;
    count += 1;
    ctx.diagnosticManager.onDidChange(uri);
  }
  return count;
}
