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

    // Deadline-bound cache save: never block shutdown longer than 5 seconds.
    // A slow or hanging cache write must not prevent Pike termination.
    await savePersistentCacheWithDeadline(connection, ctx);

    ctx.index.clear();
    cacheClear(ctx);
    clearTreeCache();

    // Always terminate Pike before returning — no orphan workers.
    // This is unconditional: even if cache save failed or timed out,
    // the worker process must be killed.
    ctx.worker.stop();
  });
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

// Maximum time to wait for cache save during shutdown (ms).
const SHUTDOWN_CACHE_DEADLINE_MS = 5_000;

/**
 * Save the persistent cache with a deadline.
 *
 * If cache save exceeds SHUTDOWN_CACHE_DEADLINE_MS, it is abandoned.
 * The caller (shutdown handler) always terminates the Pike worker
 * after this returns, regardless of cache save outcome.
 */
async function savePersistentCacheWithDeadline(
  connection: Connection,
  ctx: ServerContext,
): Promise<void> {
  const controller = new AbortController();
  const deadline = setTimeout(
    () => controller.abort(),
    SHUTDOWN_CACHE_DEADLINE_MS,
  );

  try {
    const wasmPath = resolve(
      import.meta.dirname ?? dirname(fileURLToPath(import.meta.url)),
      "tree-sitter-pike.wasm",
    );
    const wasmHash = computeWasmHash(wasmPath);

    await Promise.race([
      saveCache(ctx.index.workspaceRoot, ctx.index, wasmHash),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => {
          reject(new Error("Cache save timed out"));
        });
      }),
    ]);
  } catch (err) {
    // Cache save failure is non-critical, but log for visibility.
    const msg = err instanceof Error ? err.message : String(err);
    logWarn(connection, `Cache save during shutdown was abandoned: ${msg}`);
  } finally {
    clearTimeout(deadline);
  }
}
