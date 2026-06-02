/**
 * Server context — shared mutable state and caches for a Pike server instance.
 *
 * Extracted from server.ts to keep createPikeServer under the 50-line
 * TigerStyle function limit.
 */

import type { Connection } from "vscode-languageserver/node";
import { TextDocuments } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { initParser } from "./parser";
import { WorkspaceIndex, ModificationSource } from "./features/workspaceIndex";
import { PikeWorker } from "./features/pikeWorker";
import { LRUCache } from "./util/lruCache";
import type { PikeCacheEntry } from "./features/diagnosticManager";
import type { SymbolTable } from "./features/symbolTable";
import {
  loadStdlibAutodocIndex,
  loadPredefBuiltinIndex,
  loadPredefAutodocIndex,
} from "./util/staticDataValidation.js";
import stdlibAutodocIndexRaw from "./data/stdlib-autodoc.json";
import predefBuiltinIndexRaw from "./data/predef-builtin-index.json";
import predefAutodocIndexRaw from "./data/predef-autodoc.json";
import { logError, logWarn, ErrorCategory } from "./util/errorLog.js";
import { parse } from "./parser";
import { DiagnosticManager } from "./features/diagnosticManager";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AutodocEntry {
  xml: string;
  hash: string;
  timestamp: number;
}

export interface FormattingConfig {
  insertFinalNewline: boolean;
  operatorSpacing: boolean;
}

export interface ServerContext {
  connection: Connection;
  documents: TextDocuments<TextDocument>;
  worker: PikeWorker;
  autodocCache: LRUCache<AutodocEntry>;
  pikeCache: LRUCache<PikeCacheEntry>;
  index: WorkspaceIndex;
  diagnosticManager: DiagnosticManager;
  upsertInFlight: Map<string, Promise<any>>;
  formattingConfig: FormattingConfig;
  backgroundIndexEnabled: boolean;
  backgroundIndexBatchSize: number;
  clientSupportsWatchedFiles: boolean;
  clientSupportsSemanticTokensRefresh: boolean;
  backgroundIndexCts?: import("vscode-languageserver/node").CancellationTokenSource;
  memoryTimer?: ReturnType<typeof setInterval>;
  stdlibIndex: Record<string, { signature: string; markdown: string }>;
  predefBuiltins: Record<string, string>;
  predefAutodoc: Record<string, {
    signature: string;
    markdown: string;
    params?: Array<{ name: string; type: string }>;
    returnType?: string;
  }>;
  /** Enables verbose internal telemetry logs for race/staleness debugging. */
  debugTelemetry: boolean;
  /** Last successful semantic token payload/version by URI (for transient-race fallback). */
  semanticTokensCache: Map<string, { version: number; data: number[] }>;
}

// ---------------------------------------------------------------------------
// Cache creation helper
// ---------------------------------------------------------------------------

/** Create the coupled autodoc + pike LRU caches. */
function createCaches(): {
  autodocCache: LRUCache<AutodocEntry>;
  pikeCache: LRUCache<PikeCacheEntry>;
} {
  const autodocCache = new LRUCache<AutodocEntry>({
    maxEntries: 50,
    maxBytes: 5 * 1024 * 1024,
    estimateSize: (entry) => entry.xml.length,
  });

  const pikeCache = new LRUCache<PikeCacheEntry>({
    maxEntries: 50,
    maxBytes: 25 * 1024 * 1024,
    estimateSize: (entry) => JSON.stringify(entry).length,
    onEvict(key) {
      autodocCache.delete(key);
    },
  });

  return { autodocCache, pikeCache };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the shared mutable server context (documents, caches, index, etc.).
 * Called once at the top of createPikeServer.
 */
export function createServerContext(
  connection: Connection,
): ServerContext {
  const documents = new TextDocuments(TextDocument);
  // Fire-and-forget parser init. handleInitialized awaits the cached promise
  // later. The .catch() suppresses the early-rejection unhandled-promise
  // warning — the same promise is re-awaitable via initParser() after the
  // retry logic in parser.ts clears it on failure.
  initParser().catch(() => {});
  const worker = new PikeWorker();

  worker.setErrorHandler((ctx, err) => {
    logError(connection, ErrorCategory.Worker, ctx, err);
  });

  worker.setWarningHandler((ctx, msg) => {
    logWarn(connection, `[${ctx}] ${msg}`);
  });

  const { autodocCache, pikeCache } = createCaches();
  const index = new WorkspaceIndex({ workspaceRoot: "/tmp/unused" });

  const cacheSet = (uri: string, entry: PikeCacheEntry): void => {
    pikeCache.set(uri, entry);
  };

  const diagnosticManager = new DiagnosticManager({
    worker,
    documents,
    connection,
    index,
    pikeCache,
    cacheSet,
    debugTelemetry: false,
  });

  const stdlibIndex = loadStdlibAutodocIndex(stdlibAutodocIndexRaw, connection);
  const predefBuiltins = loadPredefBuiltinIndex(predefBuiltinIndexRaw, connection);
  const predefAutodoc = loadPredefAutodocIndex(predefAutodocIndexRaw, connection);

  return {
    connection,
    documents,
    worker,
    autodocCache,
    pikeCache,
    index,
    diagnosticManager,
    upsertInFlight: new Map<string, Promise<any>>(),
    formattingConfig: { insertFinalNewline: true, operatorSpacing: false },
    backgroundIndexEnabled: true,
    backgroundIndexBatchSize: 8,
    clientSupportsWatchedFiles: false,
    clientSupportsSemanticTokensRefresh: false,
    stdlibIndex,
    predefBuiltins,
    predefAutodoc,
    debugTelemetry: false,
    semanticTokensCache: new Map<string, { version: number; data: number[] }>(),
  };
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

/** Clear both the pike and autodoc caches. */
export function cacheClear(ctx: ServerContext): void {
  ctx.pikeCache.clear();
  ctx.autodocCache.clear();
}

// ---------------------------------------------------------------------------
// Symbol table resolver
// ---------------------------------------------------------------------------

/**
 * Get or build the symbol table for a document.
 * Uses the workspace index for lazy rebuild.
 */
export async function getSymbolTable(
  ctx: ServerContext,
  uri: string,
): Promise<SymbolTable | null> {
  const doc = ctx.documents.get(uri);
  const entry = ctx.index.getFile(uri);
  if (entry?.symbolTable) {
    // Open documents are authoritative. Returning an older indexed table for
    // the current document lets semantic token ranges from a previous edit get
    // cached under the new version, which paints partial words after rapid edits.
    if (!doc || entry.version === doc.version) return entry.symbolTable;
  }

  const inFlight = ctx.upsertInFlight.get(uri);
  if (inFlight) {
    await inFlight;
    const currentDoc = ctx.documents.get(uri);
    const currentTable = ctx.index.getSymbolTable(uri);
    if (currentTable && (!currentDoc || currentTable.version === currentDoc.version)) {
      return currentTable;
    }
  }

  const currentDoc = ctx.documents.get(uri);
  if (!currentDoc) return null;

  try {
    const content = currentDoc.getText();
    const tree = parse(content, uri);
    const promise = ctx.index.upsertFile(
      uri, currentDoc.version, tree, content, ModificationSource.DidChange,
    );
    ctx.upsertInFlight.set(uri, promise);
    try {
      await promise;
    } finally {
      // Guard: only delete if this promise is still the in-flight one.
      // A concurrent operation for the same URI may have overwritten it.
      if (ctx.upsertInFlight.get(uri) === promise) {
        ctx.upsertInFlight.delete(uri);
      }
    }
    const updatedTable = ctx.index.getSymbolTable(uri);
    if (updatedTable?.version !== currentDoc.version) return null;
    return updatedTable;
  } catch (err) {
    logError(ctx.connection, ErrorCategory.Index, `getSymbolTable(${uri})`, err);
    return null;
  }
}
