/**
 * Pike Language Server — main entry point.
 *
 * Communicates over stdio. Provides documentSymbol, definition, references,
 * hover, completion, rename, and diagnostics (parse errors + Pike compilation).
 *
 * Architecture:
 * - `createPikeServer(connection)` — wires all handlers onto a connection.
 *   Used by tests to create an in-process server with PassThrough streams.
 * - Top-level `connection.listen()` — the production entry point over stdio.
 */

import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { uriToPath } from "./util/uri";


import {
  createConnection,
  TextDocuments,
  Connection,
  FileChangeType,
  DocumentHighlight,
  DocumentHighlightKind,
  MessageType,
} from "vscode-languageserver/node";
import type { InitializeParams } from "vscode-languageserver/node";
import { buildServerCapabilities } from "./serverCapabilities";
import { handleInitialized, handleConfigurationChange } from "./serverLifecycle";
import { TextDocument } from "vscode-languageserver-textdocument";
import { initParser, isParserReady, parse, deleteTree, clearTreeCache } from "./parser";
import { WorkspaceIndex, ModificationSource } from "./features/workspaceIndex";
import {
  saveCache,
  computeWasmHash,
} from "./features/persistentCache";

import { PikeWorker } from "./features/pikeWorker";
import { logError, logInfo, logWarn, ErrorCategory } from "./util/errorLog.js";
import {
  DiagnosticManager,
  type PikeCacheEntry,
} from "./features/diagnosticManager";
import { registerHoverHandler } from "./features/hoverHandler";
import { registerFormattingHandler } from "./features/formattingHandler";

import { registerNavigationHandlers } from "./features/navigationHandler";
import { LRUCache } from "./util/lruCache";
import type { SymbolTable } from "./features/symbolTable";
import stdlibAutodocIndex from "./data/stdlib-autodoc.json";
import predefBuiltinIndex from "./data/predef-builtin-index.json";

// ---------------------------------------------------------------------------
// Server factory — reusable for production and tests
// ---------------------------------------------------------------------------

export interface PikeServer {
  connection: Connection;
  documents: TextDocuments<TextDocument>;
  index: WorkspaceIndex;
  worker: PikeWorker;
  /** AutoDoc XML cache — exposed for testing. Keyed by URI. */
  autodocCache: LRUCache<{ xml: string; hash: string; timestamp: number }>;
  /** Diagnostic manager — exposed for testing. */
  diagnosticManager: DiagnosticManager;
}

export function createPikeServer(connection: Connection): PikeServer {
  const documents = new TextDocuments(TextDocument);
  // Start parser initialization early so it completes before the first parse call.
  // initParser() is idempotent — returns the same promise on subsequent calls.
  void initParser();
  const worker = new PikeWorker();

  // Wire PikeWorker critical errors through the centralized error log.
  worker.setErrorHandler((ctx, err) => {
    logError(connection, ErrorCategory.Worker, ctx, err);
  });

  // -----------------------------------------------------------------
  // Caches (local to this server instance)
  // -----------------------------------------------------------------

  interface AutodocEntry {
    xml: string;
    hash: string;
    timestamp: number;
  }

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
      // Coupled eviction: when a pike cache entry is evicted,
      // also evict the corresponding autodoc entry.
      autodocCache.delete(key);
    },
  });

  function cacheSet(uri: string, entry: PikeCacheEntry): void {
    pikeCache.set(uri, entry);
  }

  function cacheClear(): void {
    pikeCache.clear();
    autodocCache.clear();
  }
  // Workspace index — initialized in onInitialize with the workspace root.
  // Starts with a placeholder path; overwritten when the client sends init.
  let index = new WorkspaceIndex({ workspaceRoot: "/tmp/unused" });

  // DiagnosticManager — handles debouncing, supersession, priority queueing.
  // Mode defaults to realtime; can be overridden via initializationOptions.
  const diagnosticManager = new DiagnosticManager({
    worker,
    documents,
    connection,
    index,
    pikeCache,
    cacheSet,
  });
  /** In-flight upsertFile promises to avoid concurrent indexing of the same URI. */
  const upsertInFlight = new Map<string, Promise<any>>();


  /**
   * Get or build the symbol table for a document.
   * Uses the workspace index for lazy rebuild.
   */
  async function getSymbolTable(uri: string): Promise<SymbolTable | null> {
    const entry = index.getFile(uri);
    if (entry?.symbolTable) return entry.symbolTable;

    // If an upsertFile is already in progress for this URI, await it instead of starting a second one.
    const inFlight = upsertInFlight.get(uri);
    if (inFlight) {
      await inFlight;
      return index.getSymbolTable(uri);
    }

    const doc = documents.get(uri);
    if (!doc) return null;

    try {
      const tree = parse(doc.getText(), uri);
      const promise = index.upsertFile(uri, doc.version, tree, doc.getText(), ModificationSource.DidChange);
      upsertInFlight.set(uri, promise);
      try {
        await promise;
      } finally {
        upsertInFlight.delete(uri);
      }
      return index.getSymbolTable(uri);
    } catch (err) {
      logError(connection, ErrorCategory.Index, `getSymbolTable(${uri})`, err);
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // Shared context for extracted handlers
  // -----------------------------------------------------------------------

  const stdlibIndex = stdlibAutodocIndex as Record<string, { signature: string; markdown: string }>;
  const predefBuiltins: Record<string, string> = predefBuiltinIndex as Record<string, string>;
  const handlerContext = {
    documents,
    index: index as WorkspaceIndex,
    worker,
    getSymbolTable,
    autodocCache,
    stdlibIndex,
    predefBuiltins,
    diagnosticManager,
    connection,
  };

  // Mutable formatting config — updated on initialization and setting changes.
  const formattingConfig = {
    insertFinalNewline: true,
    operatorSpacing: false,
  };

  // Background index config — read before starting the index pass.
  let backgroundIndexEnabled = true;
  let backgroundIndexBatchSize = 8;

  // -----------------------------------------------------------------------
  // Initialization
  // -----------------------------------------------------------------------

  // Track whether the client supports dynamic file watcher registration
  let clientSupportsWatchedFiles = false;

  connection.onInitialize(async (params: InitializeParams) => {
    logInfo(connection, "[init] step 6: onInitialize — client connected");

    const rootUri = params.rootUri ?? params.rootPath ?? "";
    const rootPath = uriToPath(rootUri);
    clientSupportsWatchedFiles =
      params.capabilities?.workspace?.didChangeWatchedFiles?.dynamicRegistration === true;

    logInfo(connection, `[init] step 6a: workspace root = ${rootPath || "(none)"}`);

    // Read initialization options FIRST — needed for WorkspaceIndex.create
    const initOpts = params.initializationOptions as {
      diagnosticMode?: string;
      pikeBinaryPath?: string;
      diagnosticDebounceMs?: number;
      maxNumberOfProblems?: number;
      backgroundIndexEnabled?: boolean;
      backgroundIndexBatchSize?: number;
      workerRequestTimeoutMs?: number;
      workerIdleTimeoutMs?: number;
      workerMaxRequestsBeforeRestart?: number;
      workerMaxActiveMinutes?: number;
      workerNiceValue?: number;
      formatInsertFinalNewline?: boolean;
      formatOperatorSpacing?: boolean;
    } | undefined;

    logInfo(connection, `[init] step 6b: creating workspace index (pikeBinaryPath=${initOpts?.pikeBinaryPath ?? "pike"})`);
    // Pass pikeBinaryPath so module resolution uses the same binary as PikeWorker
    index = await WorkspaceIndex.create(rootPath, initOpts?.pikeBinaryPath);
    diagnosticManager.setIndex(index);

    // On-demand indexing: when go-to-definition targets a file not yet
    // indexed by the background pass, parse and index it on the spot so
    // the definition handler can resolve into it.
    index.setOnDemandIndexFn(async (targetUri: string) => {
      try {
        const filePath = uriToPath(targetUri);
        const content = await readFile(filePath, "utf-8");
        const tree = parse(content, targetUri);
        const entry = await index.upsertFile(
          targetUri, 0, tree, content, ModificationSource.BackgroundIndex,
        );
        return entry;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EACCES" || code === "EPERM" || code === "ENOENT") {
          logWarn(connection, `on-demand index: skipping ${targetUri}: ${code}`);
        }
        return null;
      }
    });
    // Update handler context with resolved index
    (handlerContext as any).index = index;
    logInfo(connection, "[init] step 6b: workspace index created");

    if (initOpts?.diagnosticMode) {
      const mode = initOpts.diagnosticMode;
      if (mode === "realtime" || mode === "saveOnly" || mode === "off") {
        diagnosticManager.setDiagnosticMode(mode);
      }
    }
    if (initOpts?.pikeBinaryPath) {
      worker.updateConfig({ pikeBinaryPath: initOpts.pikeBinaryPath });
    }
    if (initOpts?.workerRequestTimeoutMs != null && initOpts.workerRequestTimeoutMs > 0) {
      worker.updateConfig({ requestTimeoutMs: initOpts.workerRequestTimeoutMs });
    }
    if (initOpts?.workerIdleTimeoutMs != null && initOpts.workerIdleTimeoutMs >= 0) {
      worker.updateConfig({ idleTimeoutMs: initOpts.workerIdleTimeoutMs });
    }
    if (initOpts?.workerMaxRequestsBeforeRestart != null && initOpts.workerMaxRequestsBeforeRestart >= 0) {
      worker.updateConfig({ maxRequestsBeforeRestart: initOpts.workerMaxRequestsBeforeRestart });
    }
    if (initOpts?.workerMaxActiveMinutes != null && initOpts.workerMaxActiveMinutes >= 0) {
      worker.updateConfig({ maxActiveMinutes: initOpts.workerMaxActiveMinutes });
    }
    if (initOpts?.workerNiceValue != null && initOpts.workerNiceValue >= 0) {
      worker.updateConfig({ niceValue: initOpts.workerNiceValue });
    }
    if (initOpts?.diagnosticDebounceMs && initOpts.diagnosticDebounceMs > 0) {
      diagnosticManager.setDebounceMs(initOpts.diagnosticDebounceMs);
    }
    if (initOpts?.maxNumberOfProblems && initOpts.maxNumberOfProblems > 0) {
      diagnosticManager.setMaxNumberOfProblems(initOpts.maxNumberOfProblems);
    }

    // Background index config
    if (initOpts?.backgroundIndexEnabled != null) {
      backgroundIndexEnabled = initOpts.backgroundIndexEnabled;
    }
    if (initOpts?.backgroundIndexBatchSize != null && initOpts.backgroundIndexBatchSize > 0) {
      backgroundIndexBatchSize = initOpts.backgroundIndexBatchSize;
    }

    // Formatting config
    if (initOpts?.formatInsertFinalNewline != null) {
      formattingConfig.insertFinalNewline = initOpts.formatInsertFinalNewline;
    }
    if (initOpts?.formatOperatorSpacing != null) {
      formattingConfig.operatorSpacing = initOpts.formatOperatorSpacing;
    }

    return buildServerCapabilities();
  });

  connection.onInitialized(async () => {
    await handleInitialized({
      connection,
      documents,
      index,
      worker,
      diagnosticManager,
      formattingConfig,
      backgroundIndexEnabled,
      backgroundIndexBatchSize,
      clientSupportsWatchedFiles,
    });
  });

  connection.onDidChangeWatchedFiles((params) => {
    for (const event of params.changes) {
      const uri = event.uri;
      switch (event.type) {
        case FileChangeType.Created:
        case FileChangeType.Changed: {
          // Invalidate cached data so it gets re-indexed on next access
          index.removeFile(uri);
          pikeCache.delete(uri);
          autodocCache.delete(uri);
          break;
        }
        case FileChangeType.Deleted: {
          index.removeFile(uri);
          deleteTree(uri);
          pikeCache.delete(uri);
          autodocCache.delete(uri);
          diagnosticManager.onDidClose(uri);
          break;
        }
      }
    }
  });

  // Handle file renames: update the index by removing the old URI and
  // re-indexing the new one. The file watcher sends Created/Deleted but
  // that loses the old→new mapping needed for dependency propagation.
  (connection as any).onDidRenameFiles?.((params: { files: Array<{ oldUri: string; newUri: string }> }) => {
    for (const rename of params.files) {
      const dependents = index.getDependents(rename.oldUri);
      index.removeFile(rename.oldUri);
      deleteTree(rename.oldUri);

      // Re-index the renamed file if it's currently open.
      const doc = documents.get(rename.newUri);
      if (doc) {
        const tree = parse(doc.getText(), rename.newUri);
        if (tree) {
          index.upsertFile(rename.newUri, doc.version, tree, doc.getText(), ModificationSource.DidOpen);
        }
      }

      // Re-index dependents so their cross-file references point to the new URI.
      for (const depUri of dependents) {
        const depDoc = documents.get(depUri);
        if (depDoc) {
          const depTree = parse(depDoc.getText(), depUri);
          if (depTree) {
            index.upsertFile(depUri, depDoc.version, depTree, depDoc.getText(), ModificationSource.DidOpen);
          }
        }
      }
    }
  });

  // -----------------------------------------------------------------------
  // Configuration changes (US-023)
  // -----------------------------------------------------------------------

  connection.onDidChangeConfiguration(async (settings) => {
    handleConfigurationChange(
      { worker, diagnosticManager, formattingConfig },
      settings,
    );
  });

  // -----------------------------------------------------------------------
  // Register extracted handlers
  // -----------------------------------------------------------------------

  registerHoverHandler(connection, handlerContext);

  registerNavigationHandlers(connection, handlerContext);

  registerFormattingHandler(connection, {
    documents,
    formattingConfig,
  });

  // -----------------------------------------------------------------------
  // Shutdown
  // -----------------------------------------------------------------------

  connection.onShutdown(async () => {
    diagnosticManager.dispose();

    // Save persistent cache before clearing
    try {
      const wasmPath = resolve(import.meta.dirname!, 'tree-sitter-pike.wasm');
      const wasmHash = computeWasmHash(wasmPath);
      await saveCache(index.workspaceRoot, index, wasmHash);
    } catch (err) {
      // Cache save failure is non-critical
    }

    index.clear();
    cacheClear();
    clearTreeCache();
    worker.stop();
  });

  // -----------------------------------------------------------------------
  // Text document handlers
  // -----------------------------------------------------------------------

  documents.onDidChangeContent(async (event) => {
    const doc = event.document;
    // If the parser is not yet ready, skip processing entirely.
    // The document will be re-processed on the next didChange (immediate on keystroke).
    // rust-analyzer pattern: non-blocking readiness check, no data loss.
    if (!isParserReady()) return;

    try {
      const content = doc.getText();
      if (content === undefined || content === null) {
        logError(connection, ErrorCategory.System, `onDidChangeContent(${doc.uri})`, new Error("unexpected null content"));
        return;
      }

      const tree = parse(doc.getText(), doc.uri);

      // Update workspace index, invalidating dependents
      const invalidated = index.invalidateWithDependents(doc.uri);
      const promise = index.upsertFile(doc.uri, doc.version, tree, doc.getText(), ModificationSource.DidChange);
      upsertInFlight.set(doc.uri, promise);
      try {
        await promise;
      } finally {
        upsertInFlight.delete(doc.uri);
      }

      if (invalidated.length > 1) {
        logInfo(
          connection,
          `Invalidated ${invalidated.length} files (change in ${doc.uri})`,
        );
      }
    } catch (err) {
      logError(connection, ErrorCategory.Parse, `onDidChangeContent(${doc.uri})`, err);
    }

    // Delegate real-time diagnostics to DiagnosticManager
    // (publishes parse diagnostics immediately, debounces Pike diagnostics)
    diagnosticManager.onDidChange(doc.uri);
  });

  documents.onDidClose((event) => {
    const uri = event.document.uri;
    deleteTree(uri);
    index.removeFile(uri);
    pikeCache.delete(uri);
    diagnosticManager.onDidClose(uri);
  });

  documents.listen(connection);
  return {
    connection,
    documents,
    get index() { return index; },
    worker,
    autodocCache,
    diagnosticManager,
  };
}

// ---------------------------------------------------------------------------
// Production entry: handled by main.ts
// ---------------------------------------------------------------------------

// server.ts is imported by main.ts, which handles process entry.
// Do NOT start listening here — main.ts owns the entry point.
// Having two connection.listen() calls on the same stdio causes protocol
// corruption (undefined document content → "Cannot read properties of
// undefined (reading 'charAt')").