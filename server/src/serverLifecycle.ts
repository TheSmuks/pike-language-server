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
} from "./features/persistentCache";
import { PikeWorker, PikeUnavailableError } from "./features/pikeWorker";
import { logError, logInfo, logWarn, ErrorCategory } from "./util/errorLog.js";
import type { DiagnosticManager } from "./features/diagnosticManager";

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

  // step 7e + 7f: cache loading and background indexing — both fire-and-forget.
  // Open documents (step 7b) are already fully indexed. Cache and background
  // indexing pre-populate the rest of the workspace. They run in parallel since:
  //   - Cache loading writes via upsertCachedFile (sync, no deps — see ADR 0023)
  //   - Background indexing writes via upsertBackgroundFile (sync, no deps)
  //   - Both skip files already in the index (open docs take precedence)
  //   - Single-threaded JS — Map mutations are atomic

  // step 7e: load persistent cache (fire-and-forget)
  logInfo(connection, "[init] step 7e: loading persistent cache (non-blocking)");
  const wasmPath = resolve(import.meta.dirname ?? dirname(fileURLToPath(import.meta.url)), 'tree-sitter-pike.wasm');
  const currentWasmHash = computeWasmHash(wasmPath);

  loadCache(index.workspaceRoot, currentWasmHash).then((cached) => {
    if (!cached) {
      logInfo(connection, "[init] step 7e: no cache found — fresh start");
      return;
    }

    let restored = 0;
    for (const entry of cached) {
      if (entry.symbolTable) {
        const table = deserializeSymbolTable(entry.symbolTable);
        // Skip files already indexed (open doc or previous entry takes precedence)
        if (!index.getFile(entry.uri)) {
          index.upsertCachedFile(entry.uri, entry.version, table, entry.contentHash);
          restored++;
        }
      }
    }
    logInfo(connection, `[init] step 7e: restored ${restored} files from cache`);
  }).catch((err) => {
    logError(connection, ErrorCategory.System, "[init] step 7e FAILED: cache load", err);
  });

  // step 7f: background workspace indexing — fire-and-forget, cancellable
  if (backgroundIndexEnabled) {
    // Pre-warm the Pike worker during initialization so the first user
    // interaction doesn't pay the cold-start cost (~200ms to spawn Pike).
    worker.warmUp().then((ready) => {
      if (ready) {
        const version = worker.pikeVersion ?? "unknown";
        logInfo(connection, `[init] Pike worker pre-warmed successfully (Pike ${version})`);

        // Warn if Pike version predates 8.0 — features may not work correctly.
        if (version && !version.startsWith("8.")) {
          logWarn(connection, `[init] Pike version ${version} predates 8.0 — some features may not work correctly`);
        }
      } else {
        logInfo(connection, "[init] Pike worker warm-up skipped (Pike unavailable)");
      }
    });

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

      logWarn(connection,
        `Memory pressure: heap ${Math.round(mem.heapUsed / 1024 / 1024)}MB / `
        + `${Math.round(mem.heapTotal / 1024 / 1024)}MB `
        + `(${Math.round(heapRatio * 100)}%). `
        + `Tree cache: ${treeStats.size} entries (${Math.round(treeStats.bytes / 1024)}KB). `
        + `Consider reducing backgroundIndex.batchSize.`
      );

      // Aggressively evict half the tree cache under memory pressure.
      if (treeStats.size > 5) {
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
