/**
 * Server lifecycle handlers — post-initialization and configuration changes.
 *
 * Extracted from server.ts to keep the main file under the 500-line
 * project convention.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Connection,
  TextDocuments,
  DidChangeWatchedFilesNotification,
  CancellationTokenSource,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { isParserReady, parse, initParser, getTreeCacheStats, evictTreeCacheOldest } from "./parser";
import type { WorkspaceIndex } from "./features/workspaceIndex";
import { ModificationSource } from "./features/workspaceIndex";
import { indexWorkspaceFiles } from "./features/backgroundIndex";
import {
  loadCache,
  deserializeSymbolTable,
  computeWasmHash,
  type CachedFileEntry,
} from "./features/persistentCache";
import { PikeWorker, PikeUnavailableError } from "./features/pikeWorker";
import { logError, logInfo, logWarn, ErrorCategory } from "./util/errorLog.js";
import type { DiagnosticManager } from "./features/diagnosticManager";
import { hashContent } from "./features/cacheHash";

// ---------------------------------------------------------------------------
// Cache restore + refresh (M2: two-phase startup)
// ---------------------------------------------------------------------------

/**
 * Restore cached entries into the index. Skips files already present
 * (open documents take precedence). Reconstructs forward dependencies
 * from the serialized dependency lists.
 */
function restoreCachedEntries(
  index: WorkspaceIndex,
  cached: CachedFileEntry[],
): number {
  let restored = 0;
  for (const entry of cached) {
    if (!entry.symbolTable) continue;
    if (index.getFile(entry.uri)) continue;

    const table = deserializeSymbolTable(entry.symbolTable);
    const fileEntry = index.upsertCachedFile(
      entry.uri, entry.version, table, entry.contentHash,
    );
    if (entry.dependencies.length > 0) {
      index.restoreDependencies(fileEntry.uri, new Set(entry.dependencies));
    }
    restored++;
  }
  return restored;
}

/**
 * Check if a single cached entry's content hash matches disk.
 * Returns the disk content string if stale, undefined if up-to-date.
 */
async function checkEntryStaleness(
  entry: CachedFileEntry,
  index: WorkspaceIndex,
): Promise<string | undefined> {
  const { readFile: readFileAsync } = await import("node:fs/promises");
  const current = index.getFile(entry.uri);
  if (!current) return undefined;
  if (
    current.lastModSource !== ModificationSource.DidOpen &&
    current.lastModSource !== ModificationSource.BackgroundIndex
  ) {
    // Entry was restored from cache — check staleness
  } else {
    return undefined; // Already re-indexed
  }

  try {
    const filePath = fileURLToPath(entry.uri);
    const diskContent = await readFileAsync(filePath, "utf-8");
    const diskHash = hashContent(diskContent);
    if (diskHash === entry.contentHash) return undefined;
    return diskContent;
  } catch {
    return undefined;
  }
}

/**
 * Background refresh of cached entries whose content has changed on disk.
 *
 * After the cache is restored (phase 1), this function reads each cached
 * file from disk, computes its content hash, and compares against the cached
 * hash. Changed files are re-indexed, and their dependents are invalidated
 * via invalidateWithDependents (M3: pruned invalidation).
 *
 * This runs asynchronously — the server is already serving requests from
 * cached data. Re-indexed entries replace stale data in-place.
 */
async function refreshStaleCacheEntries(
  connection: Connection,
  index: WorkspaceIndex,
  cached: CachedFileEntry[],
): Promise<number> {
  if (!isParserReady()) return 0;

  let reindexed = 0;

  for (const entry of cached) {
    if (!entry.symbolTable) continue;

    const diskContent = await checkEntryStaleness(entry, index);
    if (!diskContent) continue;

    index.invalidateWithDependents(entry.uri);
    try {
      const tree = parse(diskContent, entry.uri);
      index.upsertBackgroundFile(entry.uri, 0, tree, diskContent);
      reindexed++;
    } catch {
      reindexed++;
    }
  }

  return reindexed;
}

// ---------------------------------------------------------------------------
// Post-initialization handler (registered via connection.onInitialized)
// ---------------------------------------------------------------------------

export interface InitializedContext {
  connection: Connection;
  documents: TextDocuments<TextDocument>;
  index: WorkspaceIndex;
  worker: PikeWorker;
  diagnosticManager: DiagnosticManager;
  formattingConfig: { insertFinalNewline: boolean; operatorSpacing: boolean };
  backgroundIndexEnabled: boolean;
  backgroundIndexBatchSize: number;
  clientSupportsWatchedFiles: boolean;
  clientSupportsSemanticTokensRefresh: boolean;
  backgroundIndexCts?: import("vscode-languageserver-protocol").CancellationTokenSource;
  memoryTimer?: ReturnType<typeof setInterval>;
}

// ---------------------------------------------------------------------------
// Post-initialization handler (registered via connection.onInitialized)
// ---------------------------------------------------------------------------

async function initParserStep(connection: Connection): Promise<void> {
  try {
    logInfo(connection, "[init] step 7a: initializing tree-sitter parser");
    await initParser();
    logInfo(connection, "[init] step 7a: parser initialized");
  } catch (err) {
    logError(connection, ErrorCategory.System, "[init] step 7a FAILED: parser init", err);
  }
}

async function indexOpenDocumentsStep(
  connection: Connection,
  documents: TextDocuments<TextDocument>,
  index: WorkspaceIndex,
): Promise<void> {
  const openDocs = documents.all();
  if (openDocs.length > 0) {
    logInfo(connection, `[init] step 7b: indexing ${openDocs.length} open document(s)`);
    for (const doc of openDocs) {
      try {
        const content = doc.getText();
        const tree = parse(content, doc.uri);
        await index.upsertFile(
          doc.uri, doc.version, tree, content, ModificationSource.DidOpen,
        );
      } catch (err) {
        logError(connection, ErrorCategory.Index, `[init] step 7b: failed to index ${doc.uri}`, err);
      }
    }
    logInfo(connection, "[init] step 7b: open documents indexed");
  } else {
    logInfo(connection, "[init] step 7b: no open documents to index");
  }
}

function probePikeBinaryStep(connection: Connection, worker: PikeWorker): void {
  logInfo(connection, "[init] step 7c: probing Pike binary");
  worker.ping().catch((err: unknown) => {
    if (err instanceof PikeUnavailableError) {
      logInfo(connection, "[init] step 7c: Pike binary NOT found — degraded mode");
      try {
        connection.window.showWarningMessage(
          "Pike binary not found. Syntax highlighting and navigation still work. " +
          "Install Pike for diagnostics, hover info, and completion.",
        );
      } catch {
        // Connection may be closed during teardown
      }
    } else {
      logError(connection, ErrorCategory.Worker, "[init] step 7c: Pike ping failed", err);
    }
  });
}

function registerFileWatchersStep(connection: Connection, clientSupportsWatchedFiles: boolean): void {
  if (clientSupportsWatchedFiles) {
    logInfo(connection, "[init] step 7d: registering file watchers");
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
  } else {
    logInfo(connection, "[init] step 7d: skipped — client does not support file watchers");
  }
}

function warmUpPikeWorker(connection: Connection, worker: PikeWorker, backgroundIndexEnabled: boolean): void {
  if (!backgroundIndexEnabled) return;
  worker.warmUp().then((ready) => {
    if (ready) {
      const version = worker.pikeVersion ?? "unknown";
      logInfo(connection, `[init] Pike worker pre-warmed successfully (Pike ${version})`);
      if (version && !version.startsWith("8.")) {
        logWarn(connection, `[init] Pike version ${version} predates 8.0 — some features may not work correctly`);
      }
    } else {
      logInfo(connection, "[init] Pike worker warm-up skipped (Pike unavailable)");
    }
  });
}

function startBackgroundIndexing(
  connection: Connection,
  documents: TextDocuments<TextDocument>,
  index: WorkspaceIndex,
  backgroundIndexEnabled: boolean,
  backgroundIndexBatchSize: number,
  ctx: InitializedContext,
): void {
  if (!backgroundIndexEnabled) {
    logInfo(connection, "[init] step 7f: background indexing disabled by settings");
    return;
  }
  ctx.backgroundIndexCts = new CancellationTokenSource();

  // Debounce/Coalesce refresh calls — O(batches) not O(files).
  // Collect pending open doc URIs that depend on indexed files, then refresh.
  const pendingRefresh = new Set<string>();
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;

  const requestCodeLensRefresh = (): void => {
    try {
      const result = connection.sendRequest("workspace/codeLens/refresh") as unknown;
      if (result && typeof (result as Promise<void>).catch === "function") {
        void (result as Promise<void>).catch((err: unknown) => {
          logError(connection, ErrorCategory.System, "workspace/codeLens/refresh", err);
        });
      }
    } catch (err) {
      logError(connection, ErrorCategory.System, "workspace/codeLens/refresh", err);
    }
  };

  const requestSemanticTokensRefresh = (): void => {
    if (!ctx.clientSupportsSemanticTokensRefresh) return;
    try {
      const result = connection.languages.semanticTokens.refresh() as unknown;
      if (result && typeof (result as Promise<void>).catch === "function") {
        void (result as Promise<void>).catch((err: unknown) => {
          logError(connection, ErrorCategory.System, "semanticTokens.refresh", err);
        });
      }
    } catch (err) {
      logError(connection, ErrorCategory.System, "semanticTokens.refresh", err);
    }
  };

  const scheduleRefresh = (depUri: string) => {
    pendingRefresh.add(depUri);
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      if (pendingRefresh.size === 0) return;

      let openAffectedCount = 0;
      for (const uri of pendingRefresh) {
        const isOpen = documents.all().some(d => d.uri === uri);
        if (isOpen) {
          openAffectedCount++;
          ctx.diagnosticManager.onDidChange(uri);
        }
      }

      if (openAffectedCount > 0) {
        requestCodeLensRefresh();
        requestSemanticTokensRefresh();
      }
      pendingRefresh.clear();
    }, 200);
  };

  const onFileIndexed = (uri: string) => {
    // Find all dependents of the newly-indexed file and mark them for refresh
    const dependents = index.getDependents(uri);
    for (const dep of dependents) {
      scheduleRefresh(dep);
    }
    // Also re-wire any dependent's inheritance chain now that target is available
    index.rewireDependents(uri);
  };

  logInfo(connection, `[init] step 7f: starting background workspace indexing (batch size ${backgroundIndexBatchSize})`);
  indexWorkspaceFiles({
    connection,
    index,
    workspaceRoot: index.workspaceRoot,
    batchSize: backgroundIndexBatchSize,
    cancellationToken: ctx.backgroundIndexCts.token,
    onFileIndexed,
  }).then(() => {
    logInfo(connection, "[init] step 7f: background indexing complete");
  }).catch((err) => {
    logError(connection, ErrorCategory.Index, "[init] step 7f FAILED: background index", err);
  });
}

function startMemoryMonitorStep(ctx: InitializedContext, connection: Connection): void {
  const MEMORY_CHECK_INTERVAL_MS = 60_000;
  const HEAP_USAGE_WARNING_RATIO = 0.80;

  ctx.memoryTimer = setInterval(() => {
    const mem = process.memoryUsage();
    const heapRatio = mem.heapUsed / mem.heapTotal;

    if (heapRatio > HEAP_USAGE_WARNING_RATIO) {
      const treeStats = getTreeCacheStats();

      if (treeStats.size > 5) {
        logWarn(connection,
          `Memory pressure: heap ${Math.round(mem.heapUsed / 1024 / 1024)}MB / `
          + `${Math.round(mem.heapTotal / 1024 / 1024)}MB `
          + `(${Math.round(heapRatio * 100)}%). `
          + `Tree cache: ${treeStats.size} entries (${Math.round(treeStats.bytes / 1024)}KB). `
          + `Evicting ${Math.ceil(treeStats.size / 2)} entries.`
        );

        const evictCount = Math.ceil(treeStats.size / 2);
        const evicted = evictTreeCacheOldest(evictCount);
        logWarn(connection, `Evicted ${evicted} tree cache entries due to memory pressure`);
      }
    }
  }, MEMORY_CHECK_INTERVAL_MS);
  if (ctx.memoryTimer.unref) ctx.memoryTimer.unref();
}

export async function handleInitialized(ctx: InitializedContext): Promise<void> {
  const {
    connection,
    documents,
    index,
    worker,
    clientSupportsWatchedFiles,
    backgroundIndexEnabled,
    backgroundIndexBatchSize,
  } = ctx;

  logInfo(connection, "[init] step 7: onInitialized — starting post-init");

  await initParserStep(connection);
  await indexOpenDocumentsStep(connection, documents, index);
  probePikeBinaryStep(connection, worker);
  registerFileWatchersStep(connection, clientSupportsWatchedFiles);

  const wasmPath = resolve(import.meta.dirname ?? dirname(fileURLToPath(import.meta.url)), 'tree-sitter-pike.wasm');
  const currentWasmHash = computeWasmHash(wasmPath);

  const cacheLoadPromise = loadCache(index.workspaceRoot, currentWasmHash)
    .catch((err) => {
      logError(connection, ErrorCategory.System, "[init] step 7e FAILED: cache load", err);
      return null;
    });

  warmUpPikeWorker(connection, worker, backgroundIndexEnabled);

  cacheLoadPromise.then((cached) => {
    if (!cached) {
      logInfo(connection, "[init] step 7e: no cache found — fresh start");
      startBackgroundIndexing(connection, documents, index, backgroundIndexEnabled, backgroundIndexBatchSize, ctx);
    } else {
      const restored = restoreCachedEntries(index, cached);
      const depLinks = cached.reduce((n, e) => n + e.dependencies.length, 0);
      logInfo(connection, `[init] step 7e: restored ${restored} files from cache (${depLinks} dependency links)`);

      refreshStaleCacheEntries(connection, index, cached).then((reindexed) => {
        if (reindexed > 0) {
          logInfo(connection, `[init] step 7e: refreshed ${reindexed} stale cache entries`);
        }
        startBackgroundIndexing(connection, documents, index, backgroundIndexEnabled, backgroundIndexBatchSize, ctx);
      }).catch((err) => {
        logError(connection, ErrorCategory.System, "[init] step 7e: cache refresh failed", err);
      });
    }
  }).catch((err) => {
    logError(connection, ErrorCategory.System, "[init] step 7e: cache restore failed", err);
  });

  logInfo(connection, "[init] step 7: onInitialized complete — server fully operational");
  startMemoryMonitorStep(ctx, connection);
}

// ---------------------------------------------------------------------------
// Configuration change handler (registered via connection.onDidChangeConfiguration)
// ---------------------------------------------------------------------------

export interface ConfigContext {
  worker: PikeWorker;
  diagnosticManager: DiagnosticManager;
  formattingConfig: { insertFinalNewline: boolean; operatorSpacing: boolean };
}

export function handleConfigurationChange(
  ctx: ConfigContext,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  settings: any,
): void {
  const config = settings.settings?.pike?.languageServer;
  if (!config) return;

  applyDiagnosticConfig(config, ctx.diagnosticManager);
  applyWorkerConfig(config, ctx.worker);
  applyFormattingConfig(config, ctx.formattingConfig);
}

interface DiagnosticConfig {
  diagnosticMode?: string;
  diagnosticDebounceMs?: number;
  maxNumberOfProblems?: number;
  pikeBinaryPath?: string;
  workerRequestTimeoutMs?: number;
  workerIdleTimeoutMs?: number;
  workerMaxRequestsBeforeRestart?: number;
  workerMaxActiveMinutes?: number;
  workerNiceValue?: number;
  formatInsertFinalNewline?: boolean;
  formatOperatorSpacing?: boolean;
}

function applyDiagnosticConfig(
  config: DiagnosticConfig,
  diagnosticManager: DiagnosticManager,
): void {
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
}

function applyWorkerConfig(
  config: DiagnosticConfig,
  worker: PikeWorker,
): void {
  const workerUpdate: Partial<{
    pikeBinaryPath: string;
    requestTimeoutMs: number;
    idleTimeoutMs: number;
    maxRequestsBeforeRestart: number;
    maxActiveMinutes: number;
    niceValue: number;
  }> = {};
  if (config.pikeBinaryPath) {
    workerUpdate.pikeBinaryPath = config.pikeBinaryPath;
  }
  if (config.workerRequestTimeoutMs != null && config.workerRequestTimeoutMs > 0) {
    workerUpdate.requestTimeoutMs = config.workerRequestTimeoutMs;
  }
  if (config.workerIdleTimeoutMs != null && config.workerIdleTimeoutMs >= 0) {
    workerUpdate.idleTimeoutMs = config.workerIdleTimeoutMs;
  }
  if (config.workerMaxRequestsBeforeRestart != null && config.workerMaxRequestsBeforeRestart >= 0) {
    workerUpdate.maxRequestsBeforeRestart = config.workerMaxRequestsBeforeRestart;
  }
  if (config.workerMaxActiveMinutes != null && config.workerMaxActiveMinutes >= 0) {
    workerUpdate.maxActiveMinutes = config.workerMaxActiveMinutes;
  }
  if (config.workerNiceValue != null && config.workerNiceValue >= 0) {
    workerUpdate.niceValue = config.workerNiceValue;
  }
  if (Object.keys(workerUpdate).length > 0) {
    worker.updateConfig(workerUpdate);
  }
}

function applyFormattingConfig(
  config: DiagnosticConfig,
  formattingConfig: { insertFinalNewline: boolean; operatorSpacing: boolean },
): void {
  if (config.formatInsertFinalNewline != null) {
    formattingConfig.insertFinalNewline = config.formatInsertFinalNewline;
  }
  if (config.formatOperatorSpacing != null) {
    formattingConfig.operatorSpacing = config.formatOperatorSpacing;
  }
}
