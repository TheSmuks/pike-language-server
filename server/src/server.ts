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

import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  TextDocumentSyncKind,
  Connection,
  DidChangeWatchedFilesNotification,
  FileChangeType,
  DocumentHighlight,
  DocumentHighlightKind,
} from "vscode-languageserver/node";
import type { InitializeParams, InitializeResult } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { initParser, parse, deleteTree, clearTreeCache } from "./parser";
import { WorkspaceIndex, ModificationSource } from "./features/workspaceIndex";
import { indexWorkspaceFiles } from "./features/backgroundIndex";
import {
  saveCache,
  loadCache,
  deserializeSymbolTable,
  computeWasmHash,
} from "./features/persistentCache";
import { PikeWorker } from "./features/pikeWorker";
import {
  DiagnosticManager,
  type PikeCacheEntry,
} from "./features/diagnosticManager";
import { registerHoverHandler } from "./features/hoverHandler";
import { registerNavigationHandlers } from "./features/navigationHandler";
import { LRUCache } from "./util/lruCache";
import type { SymbolTable } from "./features/symbolTable";
import { SEMANTIC_TOKENS_LEGEND } from "./features/semanticTokens";
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
  const worker = new PikeWorker();

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
      connection.console.error(
        `symbolTable build failed: ${(err as Error).message}`,
      );
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

  // -----------------------------------------------------------------------
  // Initialization
  // -----------------------------------------------------------------------

  // Track whether the client supports dynamic file watcher registration
  let clientSupportsWatchedFiles = false;

  connection.onInitialize(async (params: InitializeParams) => {
    const rootUri = params.rootUri ?? params.rootPath ?? "";
    const rootPath = rootUri.startsWith("file://") ? rootUri.slice(7) : rootUri;
    clientSupportsWatchedFiles =
      params.capabilities?.workspace?.didChangeWatchedFiles?.dynamicRegistration === true;
    index = await WorkspaceIndex.create(rootPath);
    diagnosticManager.setIndex(index);
    // Update handler context with resolved index
    (handlerContext as any).index = index;

    // Read diagnostic mode from initializationOptions
    const initOpts = params.initializationOptions as {
      diagnosticMode?: string;
      pikeBinaryPath?: string;
      diagnosticDebounceMs?: number;
      maxNumberOfProblems?: number;
    } | undefined;
    if (initOpts?.diagnosticMode) {
      const mode = initOpts.diagnosticMode;
      if (mode === "realtime" || mode === "saveOnly" || mode === "off") {
        diagnosticManager.setDiagnosticMode(mode);
      }
    }
    if (initOpts?.pikeBinaryPath) {
      worker.updateConfig({ pikeBinaryPath: initOpts.pikeBinaryPath });
    }
    if (initOpts?.diagnosticDebounceMs && initOpts.diagnosticDebounceMs > 0) {
      diagnosticManager.setDebounceMs(initOpts.diagnosticDebounceMs);
    }
    if (initOpts?.maxNumberOfProblems && initOpts.maxNumberOfProblems > 0) {
      diagnosticManager.setMaxNumberOfProblems(initOpts.maxNumberOfProblems);
    }

    return {
      capabilities: {
        textDocumentSync: {
          openClose: true,
          change: TextDocumentSyncKind.Full,
          save: { includeText: true },
        },
        documentSymbolProvider: true,
        definitionProvider: true,
        referencesProvider: true,
        renameProvider: { prepareProvider: true },
        hoverProvider: true,
        completionProvider: {
          triggerCharacters: ['.', '>', ':'],
        },
        semanticTokensProvider: {
          legend: SEMANTIC_TOKENS_LEGEND,
          full: true,
        },
        documentHighlightProvider: true,
        foldingRangeProvider: true,
        signatureHelpProvider: {
          triggerCharacters: ['(', ','],
        },
        codeActionProvider: true,
        workspaceSymbolProvider: true,
        workspace: {
          fileOperations: {
            didRename: { filters: [{ pattern: { glob: '**/*.pike' } }, { pattern: { glob: '**/*.pmod' } }] },
          },
        },
      },
    } satisfies InitializeResult;
  });

  connection.onInitialized(async () => {
    try {
      await initParser();
      connection.console.log("Pike LSP: parser initialized");
    } catch (err) {
      connection.console.error(
        `Pike LSP: parser init failed: ${(err as Error).message}`,
      );
    }

    // Register file watchers for .pike and .pmod files.
    // Enables notifications when files change externally
    // (git checkout, file creation/deletion outside the editor).
    // Only register if the client supports dynamic registration;
    // the test harness does not, and calling register() on it
    // causes an unhandled JSON-RPC error.
    if (clientSupportsWatchedFiles) {
      connection.client.register(
        DidChangeWatchedFilesNotification.type,
        {
          watchers: [
            { globPattern: '**/*.pike' },
            { globPattern: '**/*.pmod' },
          ],
        },
      ).catch(() => {
        // Registration may still fail (e.g., client rejects it)
      });
    }

    // Load persistent cache
    const wasmPath = resolve(import.meta.dir, 'tree-sitter-pike.wasm');
    const currentWasmHash = computeWasmHash(wasmPath);

    try {
      const cached = await loadCache(index.workspaceRoot, currentWasmHash);
      if (cached) {
        let restored = 0;
        for (const entry of cached) {
          if (entry.symbolTable) {
            const table = deserializeSymbolTable(entry.symbolTable);
            // Rebuild only if not already indexed (open doc takes precedence)
            if (!index.getFile(entry.uri)) {
              index.upsertCachedFile(entry.uri, entry.version, table, entry.contentHash);
              restored++;
            }
          }
        }
        connection.console.log(`Pike LSP: restored ${restored} files from cache`);
      }
    } catch (err) {
      connection.console.error(`Pike LSP: cache load failed: ${(err as Error).message}`);
    }

    // Background workspace indexing — fire-and-forget
    // Discovers and indexes all .pike/.pmod files for workspace/symbol
    // and cross-file navigation.
    indexWorkspaceFiles({
      connection,
      index,
      workspaceRoot: index.workspaceRoot,
    }).catch((err) => {
      connection.console.error(
        `Pike LSP: background indexing failed: ${(err as Error).message}`,
      );
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

  // -----------------------------------------------------------------------
  // Configuration changes (US-023)
  // -----------------------------------------------------------------------

  connection.onDidChangeConfiguration(async (settings) => {
    const config = settings.settings?.pike?.languageServer;
    if (!config) return;

    if (config.diagnosticMode) {
      const mode = config.diagnosticMode;
      if (mode === "realtime" || mode === "saveOnly" || mode === "off") {
        diagnosticManager.setDiagnosticMode(mode);
      }
    }

    if (config.diagnosticDebounceMs && config.diagnosticDebounceMs > 0) {
      diagnosticManager.setDebounceMs(config.diagnosticDebounceMs);
    }

    if (config.maxNumberOfProblems && config.maxNumberOfProblems > 0) {
      diagnosticManager.setMaxNumberOfProblems(config.maxNumberOfProblems);
    }
  });

  // -----------------------------------------------------------------------
  // Register extracted handlers
  // -----------------------------------------------------------------------

  registerHoverHandler(connection, handlerContext);
  registerNavigationHandlers(connection, handlerContext);

  // -----------------------------------------------------------------------
  // Shutdown
  // -----------------------------------------------------------------------

  connection.onShutdown(async () => {
    diagnosticManager.dispose();

    // Save persistent cache before clearing
    try {
      const wasmPath = resolve(import.meta.dir, 'tree-sitter-pike.wasm');
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

    try {
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
        connection.console.log(
          `Invalidated ${invalidated.length} files (change in ${doc.uri})`,
        );
      }
    } catch (err) {
      connection.console.error(
        `parse failed: ${(err as Error).message}`,
      );
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

  return { connection, documents, get index() { return index; }, worker, autodocCache, diagnosticManager };
}

// ---------------------------------------------------------------------------
// Production entry point: stdio transport
// Only runs when this module is executed directly, not when imported by tests.
// ---------------------------------------------------------------------------

// Production entry point: stdio transport.
// Only runs when this module is executed directly, not when imported by tests.
// Bun: import.meta.main, Node: not available (ESM mode only).
const isMain = typeof (import.meta as unknown as Record<string, unknown>).main === 'boolean'
  ? (import.meta as unknown as Record<string, unknown>).main === true
  : false;
if (isMain) {
  const connection = createConnection(ProposedFeatures.all);
  const server = createPikeServer(connection);
  server.connection.listen();
}
