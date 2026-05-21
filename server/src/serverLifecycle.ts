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

  const { readFile: readFileAsync } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  let reindexed = 0;

  for (const entry of cached) {
    if (!entry.symbolTable) continue;

    // Skip files already re-indexed by background indexing or didOpen.
    const current = index.getFile(entry.uri);
    if (!current) continue;
    if (current.lastModSource !== ModificationSource.DidOpen &&
        current.lastModSource !== ModificationSource.BackgroundIndex) {
      // This entry was restored from cache — check if stale.
    } else {
      // Already re-indexed by a later step — skip.
      continue;
    }

    let diskContent: string;
    try {
      const filePath = fileURLToPath(entry.uri);
      diskContent = await readFileAsync(filePath, "utf-8");
    } catch {
      // File deleted or unreadable — invalidate entry.
      index.invalidateWithDependents(entry.uri);
      reindexed++;
      continue;
    }

    const diskHash = hashContent(diskContent);
    if (diskHash === entry.contentHash) continue;

    // Invalidate dependents BEFORE re-indexing so that the re-indexed file
    // is immediately available (stale=false) and can serve requests.
    // Order matters: invalidateWithDependents sets stale=true on the file
    // itself; upsertBackgroundFile then sets stale=false and installs the
    // new symbol table. Reversing the order would null the symbol table
    // immediately after building it (ADR 0026 consequence).
    index.invalidateWithDependents(entry.uri);
    try {
      const tree = parse(diskContent, entry.uri);
      index.upsertBackgroundFile(entry.uri, 0, tree, diskContent);
      reindexed++;
    } catch {
      // Parse failure — already invalidated, just count it.
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

  // step 7a: parser (tree-sitter WASM + grammar)
  try {
    logInfo(connection, "[init] step 7a: initializing tree-sitter parser");
    await initParser();
    logInfo(connection, "[init] step 7a: parser initialized");
  } catch (err) {
    logError(connection, ErrorCategory.System, "[init] step 7a FAILED: parser init", err);
  }

  // step 7b: index open documents immediately (typically 0-5 files).
  // This gives full feature availability for the files the user is looking
  // at before any background work starts. Full resolution includes dependency
  // resolution so cross-file features work from the first request.
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
    logInfo(connection, `[init] step 7b: open documents indexed`);
  } else {
    logInfo(connection, "[init] step 7b: no open documents to index");
  }

  // step 7c: pike binary probe (fire-and-forget)
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

  // step 7d: file watchers
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

  // step 7e: load persistent cache, then start background indexing.
  // Cache load must complete before background indexing so that:
  //   1. Cached entries are available for immediate feature queries
  //   2. Background indexing skips already-cached files (no double work)
  // Open documents (step 7b) are already fully indexed and take precedence.
  logInfo(connection, "[init] step 7e: loading persistent cache");
  const wasmPath = resolve(import.meta.dirname ?? dirname(fileURLToPath(import.meta.url)), 'tree-sitter-pike.wasm');
  const currentWasmHash = computeWasmHash(wasmPath);

  const cacheLoadPromise = loadCache(index.workspaceRoot, currentWasmHash)
    .catch((err) => {
      logError(connection, ErrorCategory.System, "[init] step 7e FAILED: cache load", err);
      return null;
    });

  // Pre-warm the Pike worker during initialization so the first user
  // interaction doesn't pay the cold-start cost (~200ms to spawn Pike).
  if (backgroundIndexEnabled) {
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

  // Cache restore + stale refresh + background indexing, chained sequentially.
  // The .catch() prevents an unhandled rejection if the synchronous wrapper
  // throws (e.g., restoreCachedEntries fails) before reaching the inner async
  // chains that have their own .catch() handlers.
  cacheLoadPromise.then((cached) => {
    if (!cached) {
      logInfo(connection, "[init] step 7e: no cache found — fresh start");
    } else {
      const restored = restoreCachedEntries(index, cached);
      const depLinks = cached.reduce((n, e) => n + e.dependencies.length, 0);
      logInfo(connection, `[init] step 7e: restored ${restored} files from cache (${depLinks} dependency links)`);

      // Phase 2: Re-validate stale entries (content hash mismatch).
      refreshStaleCacheEntries(connection, index, cached).then((reindexed) => {
        if (reindexed > 0) {
          logInfo(connection, `[init] step 7e: refreshed ${reindexed} stale cache entries`);
        }
      }).catch((err) => {
        logError(connection, ErrorCategory.System, "[init] step 7e: cache refresh failed", err);
      });
    }

    // Phase 3: Background-index remaining unindexed files.
    if (backgroundIndexEnabled) {
      const backgroundCts = new CancellationTokenSource();
      logInfo(connection, `[init] step 7f: starting background workspace indexing (batch size ${backgroundIndexBatchSize})`);
      indexWorkspaceFiles({
        connection,
        index,
        workspaceRoot: index.workspaceRoot,
        batchSize: backgroundIndexBatchSize,
        cancellationToken: backgroundCts.token,
      }).then(() => {
        logInfo(connection, "[init] step 7f: background indexing complete");
      }).catch((err) => {
        logError(connection, ErrorCategory.Index, "[init] step 7f FAILED: background index", err);
      });
    } else {
      logInfo(connection, "[init] step 7f: background indexing disabled by settings");
    }
  }).catch((err) => {
    logError(connection, ErrorCategory.System, "[init] step 7e: cache restore failed", err);
  });

  logInfo(connection, "[init] step 7: onInitialized complete — server fully operational");

  // step 7g: periodic memory monitor — log warnings and trigger eviction
  // when heap usage is high. Checks every 60 seconds. Timer is unreffed
  // so it doesn't prevent the process from exiting.
  const MEMORY_CHECK_INTERVAL_MS = 60_000;
  const HEAP_USAGE_WARNING_RATIO = 0.80;

  const memoryTimer = setInterval(() => {
    const mem = process.memoryUsage();
    const heapRatio = mem.heapUsed / mem.heapTotal;

    if (heapRatio > HEAP_USAGE_WARNING_RATIO) {
      const treeStats = getTreeCacheStats();

      // Only warn when eviction could actually help. If the tree cache is
      // small, the heap pressure is from other sources (WASM runtime,
      // stdlib-autodoc.json, V8 internals) and reducing batchSize won't help.
      if (treeStats.size > 5) {
        logWarn(connection,
          `Memory pressure: heap ${Math.round(mem.heapUsed / 1024 / 1024)}MB / `
          + `${Math.round(mem.heapTotal / 1024 / 1024)}MB `
          + `(${Math.round(heapRatio * 100)}%). `
          + `Tree cache: ${treeStats.size} entries (${Math.round(treeStats.bytes / 1024)}KB). `
          + `Evicting ${Math.ceil(treeStats.size / 2)} entries.`
        );

        // Aggressively evict half the tree cache under memory pressure.
        const evictCount = Math.ceil(treeStats.size / 2);
        const evicted = evictTreeCacheOldest(evictCount);
        logWarn(connection, `Evicted ${evicted} tree cache entries due to memory pressure`);
      }
    }
  }, MEMORY_CHECK_INTERVAL_MS);
  if (memoryTimer.unref) memoryTimer.unref();
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

  const { worker, diagnosticManager, formattingConfig } = ctx;

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

  // Worker lifecycle config
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

  // Formatting config
  if (config.formatInsertFinalNewline != null) {
    formattingConfig.insertFinalNewline = config.formatInsertFinalNewline;
  }
  if (config.formatOperatorSpacing != null) {
    formattingConfig.operatorSpacing = config.formatOperatorSpacing;
  }
}
