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
} from "./util/staticDataValidation.js";
import stdlibAutodocIndexRaw from "./data/stdlib-autodoc.json";
import predefBuiltinIndexRaw from "./data/predef-builtin-index.json";
import { logError, ErrorCategory } from "./util/errorLog.js";
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
  stdlibIndex: Record<string, { signature: string; markdown: string }>;
  predefBuiltins: Record<string, string>;
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
  void initParser();
  const worker = new PikeWorker();

  worker.setErrorHandler((ctx, err) => {
    logError(connection, ErrorCategory.Worker, ctx, err);
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
  });

  const stdlibIndex = loadStdlibAutodocIndex(stdlibAutodocIndexRaw, connection);
  const predefBuiltins = loadPredefBuiltinIndex(predefBuiltinIndexRaw, connection);

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
    stdlibIndex,
    predefBuiltins,
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
  const entry = ctx.index.getFile(uri);
  if (entry?.symbolTable) return entry.symbolTable;

  const inFlight = ctx.upsertInFlight.get(uri);
  if (inFlight) {
    await inFlight;
    return ctx.index.getSymbolTable(uri);
  }

  const doc = ctx.documents.get(uri);
  if (!doc) return null;

  try {
    const tree = parse(doc.getText(), uri);
    const promise = ctx.index.upsertFile(
      uri, doc.version, tree, doc.getText(), ModificationSource.DidChange,
    );
    ctx.upsertInFlight.set(uri, promise);
    try {
      await promise;
    } finally {
      ctx.upsertInFlight.delete(uri);
    }
    return ctx.index.getSymbolTable(uri);
  } catch (err) {
    logError(ctx.connection, ErrorCategory.Index, `getSymbolTable(${uri})`, err);
    return null;
  }
}
