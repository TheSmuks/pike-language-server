/**
 * Navigation handler hub — re-exports NavigationContext and delegates
 * handler registration to focused sub-modules.
 *
 * Sub-modules:
 *   navigationDocumentFeatures.ts — documentSymbol, selectionRange, semanticTokens,
 *       diagnostic, documentHighlight, foldingRange, signatureHelp, inlayHint
 *   navigationGoTo.ts — definition, references, implementation
 *   navigationRefactoring.ts — rename, codeAction, workspaceSymbol
 *   navigationCompletion.ts — completion, completionResolve
 *   navigationAdvanced.ts — callHierarchy, codeLens, didOpen, didSave, documentLink
 *   navigationInclude.ts — #include resolution helpers (used by navigationGoTo)
 */

import type { Connection } from "vscode-languageserver/node";
import type { TextDocuments } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { SymbolTable } from "./symbolTable";
import type { WorkspaceIndex } from "./workspaceIndex";
import type { PikeWorker } from "./pikeWorker";
import type { LRUCache } from "../util/lruCache";
import type { DiagnosticManager } from "./diagnosticManager";

import { registerDocumentFeatureHandlers } from "./navigationDocumentFeatures";
import { registerGoToHandlers } from "./navigationGoTo";
import { registerRefactoringHandlers } from "./navigationRefactoring";
import { registerCompletionHandlers } from "./navigationCompletion";
import { registerAdvancedHandlers } from "./navigationAdvanced";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface NavigationContext {
  documents: TextDocuments<TextDocument>;
  index: WorkspaceIndex;
  worker: PikeWorker;
  getSymbolTable(uri: string): Promise<SymbolTable | null>;
  autodocCache: LRUCache<{ xml: string; hash: string; timestamp: number }>;
  diagnosticManager: DiagnosticManager;
  stdlibIndex: Record<string, { signature: string; markdown: string }>;
  /** Current per-URI index updates; semantic tokens await one bounded attempt. */
  upsertInFlight: Map<string, Promise<any>>;
  predefBuiltins: Record<string, string>;
  predefAutodoc: Record<string, { signature: string; markdown: string; params?: Array<{ name: string; type: string }>; returnType?: string }>;
  /** Enables verbose internal telemetry logs for race/staleness debugging. */
  debugTelemetry: boolean;
  /** Connection for logging when content is unexpectedly null. */
  connection: Connection;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register all navigation and feature handlers on the connection.
 * Delegates to focused sub-modules.
 */
export function registerNavigationHandlers(
  connection: Connection,
  ctx: NavigationContext,
): void {
  registerDocumentFeatureHandlers(connection, ctx);
  registerGoToHandlers(connection, ctx);
  registerRefactoringHandlers(connection, ctx);
  registerCompletionHandlers(connection, ctx);
  registerAdvancedHandlers(connection, ctx);
}
