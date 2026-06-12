/**
 * Shutdown handler — registered on the LSP connection.
 *
 * Extracted from server.ts to keep createPikeServer under the 50-line
 * TigerStyle function limit.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Connection } from "vscode-languageserver/node";
import { clearTreeCache } from "./parser";
import { saveCache, computeWasmHash } from "./features/persistentCache";
import { logWarn, logInfo } from "./util/errorLog.js";
import { cacheClear, type ServerContext } from "./serverContext";
import { generateReport, isProfiling } from "./features/profiler";

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Register the onShutdown handler on the connection. */
export function registerShutdownHandler(
  connection: Connection,
  ctx: ServerContext,
): void {
  connection.onShutdown(async () => {
    // Cancel background indexing if still running.
    ctx.backgroundIndexCts?.cancel();
    ctx.backgroundIndexCts?.dispose();

    // Clear timers before the connection closes so no delayed notification
    // fires against a disposed JSON-RPC stream.
    if (ctx.memoryTimer) {
      clearInterval(ctx.memoryTimer);
      ctx.memoryTimer = undefined;
    }

    ctx.diagnosticManager.dispose();

    // Emit profiling report before clearing state (step 8).
    if (isProfiling()) {
      logInfo(connection, generateReport());
    }

    await savePersistentCache(connection, ctx);

    ctx.index.clear();
    cacheClear(ctx);
    clearTreeCache();
    ctx.worker.stop();
  });
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

async function savePersistentCache(
  connection: Connection,
  ctx: ServerContext,
): Promise<void> {
  try {
    const wasmPath = resolve(import.meta.dirname ?? dirname(fileURLToPath(import.meta.url)), "tree-sitter-pike.wasm");
    const wasmHash = computeWasmHash(wasmPath);
    await saveCache(ctx.index.workspaceRoot, ctx.index, wasmHash);
  } catch (err) {
    // Cache save failure is non-critical, but log for visibility.
    logWarn(connection, `Failed to save persistent cache: ${err}`);
  }
}
