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
import roxenIndexRaw from "./data/roxen-index.json";
import predefAutodocIndexRaw from "./data/predef-autodoc.json";
import { logError, logInfo, logWarn, ErrorCategory } from "./util/errorLog.js";
import { parse } from "./parser";
import { DiagnosticManager } from "./features/diagnosticManager";
import { parseResourceConfig } from "./features/resourceConfiguration";
import type { ResourceConfiguration } from "./features/resourceTypes";
import { ResourceStateTracker, createResourceStateSender } from "./features/resourceState";
import { HibernationManager, HIBERNATION_DEFAULTS } from "./features/hibernation";
import { CancellationTokenSource } from "vscode-languageserver/node";
import { DEFAULT_ROXEN_MODE } from "./features/roxenActivation";
import { asRoxenIndex, type RoxenIndexData } from "./features/roxenIndex";

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
  /** `pike.roxen.mode` — whether files may be treated as Roxen files. */
  roxenMode: import("./features/roxenActivation").RoxenMode;
  /** Bundled Roxen vocabulary, used when no installation resolves a symbol. */
  roxenIndex: RoxenIndexData;
  /**
   * Which open documents are Roxen files, keyed by URI.
   *
   * Activation is decided once per document change, where the text is already
   * in hand and the handler is already async, rather than on every hover and
   * keystroke — the directory-inheritance tier reads the filesystem, and
   * completion must not.
   */
  roxenActive: Map<string, boolean>;
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
    roxenIndex: asRoxenIndex(roxenIndexRaw),
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create hibernation hooks referencing the worker, index, and bg-index CTS holder.
 * The manager drives hibernate/wake via these callbacks.
 *
 * The index arrives as a mutable ref, not a value. These hooks are built before
 * `initialize`, while `ctx.index` is still the `/tmp/unused` placeholder, and
 * `serverInitHandler` swaps in the real index once it knows the workspace root.
 * Capturing the placeholder by value meant hibernation saved an empty index
 * under `/tmp/unused` and cleared one nobody read — silently, since neither
 * operation errors, so waking simply never found a warm cache.
 */
export function createHibernationHooks(
  connection: Connection,
  worker: PikeWorker,
  indexRef: { current: WorkspaceIndex },
  bgIndexCtsHolder: { cts?: CancellationTokenSource },
): import("./features/hibernation").HibernationCallbacks {
  return {
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
      await saveCache(indexRef.current.workspaceRoot, indexRef.current, wasmHash);
    },
    onClearIndex: () => { indexRef.current.clear(); },
    onStopWorker: () => { worker.stop(); },
    onWakeStart: async () => {
      // Rehydration happens through normal on-demand indexing on next request.
    },
    onSustainedActivity: () => {
      logInfo(connection, "[hibernation] sustained activity — scheduling reindex");
    },
  };
}

/**
 * Create the shared mutable server context (documents, caches, index, etc.).
 * Called once at the top of createPikeServer.
 */
/** Resource-resilience tracker, with the cancellation source it owns. */
function createResourceState(connection: Connection): ResourceStateTracker {
  return new ResourceStateTracker(
    createResourceStateSender(connection),
    new CancellationTokenSource(),
  );
}

export function createServerContext(
  connection: Connection,
): ServerContext {
  const documents = new TextDocuments(TextDocument);
  // Fire-and-forget parser init. handleInitialized awaits the cached promise.
  initParser().catch(() => {});

  const worker = setupWorker(connection);
  const { autodocCache, pikeCache } = createCaches();
  // Placeholder until `initialize` supplies the real workspace root. Held in a
  // ref so everything built before then — the hibernation hooks below — follows
  // the swap instead of freezing onto `/tmp/unused`.
  const indexRef = { current: new WorkspaceIndex({ workspaceRoot: "/tmp/unused" }) };
  const diagnosticManager = createDiagnosticManager(
    worker, documents, connection, indexRef.current, pikeCache,
  );
  const { stdlibIndex, predefBuiltins, predefAutodoc, roxenIndex } = loadStaticIndices(connection);

  const resourceState = createResourceState(connection);

  // Mutable holder for the background-index CTS.
  const bgIndexCtsHolder: { cts?: CancellationTokenSource } = {};

  const hibernationManager = new HibernationManager(
    { ...HIBERNATION_DEFAULTS, idleTimeoutMs: HIBERNATION_DEFAULTS.idleTimeoutMs },
    createHibernationHooks(connection, worker, indexRef, bgIndexCtsHolder),
  );

  return {
    connection,
    documents,
    worker,
    autodocCache,
    pikeCache,
    // Backed by the ref so `ctx.index = …` in serverInitHandler is visible to
    // everything that captured it before initialize.
    get index() { return indexRef.current; },
    set index(next: WorkspaceIndex) { indexRef.current = next; },
    diagnosticManager,
    stdlibIndex,
    predefBuiltins,
    predefAutodoc,
    roxenIndex,
    resourceState,
    hibernationManager,
    ...mutableContextDefaults(),
  };
}

/**
 * The context fields that start at a fixed value and are rewritten later by
 * `initialize` or by request handlers. Fresh objects every call — sharing a
 * Map between connections would leak one workspace's state into another.
 */
function mutableContextDefaults() {
  return {
    upsertInFlight: new Map<string, Promise<any>>(),
    formattingConfig: { insertFinalNewline: true, operatorSpacing: false },
    backgroundIndexEnabled: true,
    backgroundIndexBatchSize: 8,
    clientSupportsWatchedFiles: false,
    clientSupportsSemanticTokensRefresh: false,
    debugTelemetry: false,
    roxenMode: DEFAULT_ROXEN_MODE,
    roxenActive: new Map<string, boolean>(),
    pendingParserDocuments: new Map<string, TextDocument>(),
    // Own a fresh config rather than aliasing the frozen defaults singleton.
    resourceConfig: parseResourceConfig(undefined),
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
