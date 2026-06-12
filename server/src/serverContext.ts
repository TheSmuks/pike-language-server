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
import { logError, logInfo, logWarn, ErrorCategory } from "./util/errorLog.js";
import { parse } from "./parser";
import { DiagnosticManager } from "./features/diagnosticManager";
import { DEFAULT_RESOURCE_CONFIG } from "./features/resourceConfiguration";
import type { ResourceConfiguration } from "./features/resourceTypes";
import { ResourceStateTracker, createResourceStateSender } from "./features/resourceState";
import { HibernationManager, HIBERNATION_DEFAULTS } from "./features/hibernation";
import { CancellationTokenSource } from "vscode-languageserver/node";

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
  /** Latest document version dropped while parser initialization was pending. */
  pendingParserDocuments: Map<string, TextDocument>;
  /** Resource-resilience configuration (indexing, memory, worker, hibernation). */
  resourceConfig: ResourceConfiguration;
  /** Resource-state tracker (activity, hibernation, state transitions). */
  resourceState: ResourceStateTracker;
  /** Hibernation manager — tracks idle timer and triggers hibernate/wake. */
  hibernationManager: HibernationManager;
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

// ---------------------------------------------------------------------------
// Worker setup helper
// ---------------------------------------------------------------------------

function setupWorker(connection: Connection): PikeWorker {
  const worker = new PikeWorker();
  worker.setErrorHandler((ctx, err) => {
    logError(connection, ErrorCategory.Worker, ctx, err);
  });
  worker.setWarningHandler((ctx, msg) => {
    logWarn(connection, `[${ctx}] ${msg}`);
  });
  return worker;
}

// ---------------------------------------------------------------------------
// Diagnostic manager factory
// ---------------------------------------------------------------------------

function createDiagnosticManager(
  worker: PikeWorker,
  documents: TextDocuments<TextDocument>,
  connection: Connection,
  index: WorkspaceIndex,
  pikeCache: LRUCache<PikeCacheEntry>,
): DiagnosticManager {
  const cacheSet = (uri: string, entry: PikeCacheEntry): void => {
    pikeCache.set(uri, entry);
  };
  return new DiagnosticManager({
    worker,
    documents,
    connection,
    index,
    pikeCache,
    cacheSet,
    debugTelemetry: false,
  });
}

// ---------------------------------------------------------------------------
// Static data loading helper
// ---------------------------------------------------------------------------

function loadStaticIndices(connection: Connection) {
  return {
    stdlibIndex: loadStdlibAutodocIndex(stdlibAutodocIndexRaw, connection),
    predefBuiltins: loadPredefBuiltinIndex(predefBuiltinIndexRaw, connection),
    predefAutodoc: loadPredefAutodocIndex(predefAutodocIndexRaw, connection),
  };
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

  const worker = setupWorker(connection);
  const { autodocCache, pikeCache } = createCaches();
  const index = new WorkspaceIndex({ workspaceRoot: "/tmp/unused" });
  const diagnosticManager = createDiagnosticManager(
    worker, documents, connection, index, pikeCache,
  );
  const { stdlibIndex, predefBuiltins, predefAutodoc } = loadStaticIndices(connection);

  const resourceStateSender = createResourceStateSender(connection);
  const resourceCts = new CancellationTokenSource();
  const resourceState = new ResourceStateTracker(resourceStateSender, resourceCts);

  // Mutable holder for the background-index CTS. The lifecycle handler sets
  // this when background indexing starts. The hibernation callback reads it
  // to cancel indexing during hibernation. This indirection is needed because
  // the context object is not available during construction.
  const bgIndexCtsHolder: { cts?: CancellationTokenSource } = {};

  // Create hibernation manager. Callbacks reference objects created above
  // (worker, index, cache). The manager drives hibernate/wake via these hooks.
  // The idle check timer is started by the server lifecycle handler after init.
  const hibernationManager = new HibernationManager(
    {
      ...HIBERNATION_DEFAULTS,
      idleTimeoutMs: HIBERNATION_DEFAULTS.idleTimeoutMs,
    },
    {
      onCancelBackgroundIndex: async () => {
        if (bgIndexCtsHolder.cts) {
          bgIndexCtsHolder.cts.cancel();
          bgIndexCtsHolder.cts = new CancellationTokenSource();
        }
      },
      onSaveCache: async () => {
        const { saveCache, computeWasmHash } = await import("./features/persistentCache");
        const { resolve: resolvePath, dirname: dirnamePath } = await import("node:path");
        const { fileURLToPath: toFilePath } = await import("node:url");
        const wasmPath = resolvePath(
          dirnamePath(toFilePath(import.meta.url)),
          "tree-sitter-pike.wasm",
        );
        const wasmHash = computeWasmHash(wasmPath);
        await saveCache(index.workspaceRoot, index, wasmHash);
      },
      onClearIndex: () => {
        index.clear();
      },
      onStopWorker: () => {
        worker.stop();
      },
      onWakeStart: async () => {
        // Rehydration happens through normal on-demand indexing on next request.
      },
      onSustainedActivity: () => {
        logInfo(connection, "[hibernation] sustained activity — scheduling reindex");
      },
    },
  );

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
    pendingParserDocuments: new Map<string, TextDocument>(),
    resourceConfig: DEFAULT_RESOURCE_CONFIG,
    resourceState,
    hibernationManager,
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
