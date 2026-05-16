/**
 * Shutdown handler — registered on the LSP connection.
 *
 * Extracted from server.ts to keep createPikeServer under the 50-line
 * TigerStyle function limit.
 */

import { resolve } from "node:path";
import type { Connection } from "vscode-languageserver/node";
import { clearTreeCache } from "./parser";
import { saveCache, computeWasmHash } from "./features/persistentCache";
import { logWarn } from "./util/errorLog.js";
import { cacheClear, type ServerContext } from "./serverContext";

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Register the onShutdown handler on the connection. */
export function registerShutdownHandler(
  connection: Connection,
  ctx: ServerContext,
): void {
  connection.onShutdown(async () => {
    ctx.diagnosticManager.dispose();

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
    const wasmPath = resolve(import.meta.dirname!, "tree-sitter-pike.wasm");
    const wasmHash = computeWasmHash(wasmPath);
    await saveCache(ctx.index.workspaceRoot, ctx.index, wasmHash);
  } catch (err) {
    // Cache save failure is non-critical, but log for visibility.
    logWarn(connection, `Failed to save persistent cache: ${err}`);
  }
}
