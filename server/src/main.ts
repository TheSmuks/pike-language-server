/**
 * Pike Language Server — production entry point.
 *
 * This module is the entry executed by the extension (via stdio transport).
 * It always listens — tests import createPikeServer() directly from server.ts
 * and never reach this file.
 */
import { createConnection, ProposedFeatures } from "vscode-languageserver/node";
import { createPikeServer } from "./server.js";
import { installFailFastHandlers } from "./serverLifecycle.js";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { saveCache, computeWasmHash } from "./features/persistentCache.js";

// Either signal starts the server: PIKE_LSP_STDIO=1 (what the VSCode client
// sets) or an explicit --stdio flag (what every other LSP client passes).
// Tests import createPikeServer() from server.ts and reach neither.
function shouldListen(): boolean {
  return process.env.PIKE_LSP_STDIO === "1" || process.argv.includes("--stdio");
}

if (shouldListen()) {
  // Install fail-fast handlers before anything else so we catch startup errors.
  // These log uncaughtException/unhandledRejection to the ErrorLog ring buffer
  // and then exit(1) — see serverLifecycle.ts for details.
  installFailFastHandlers();

  // createConnection() needs a transport flag in argv regardless of which
  // signal got us here — PIKE_LSP_STDIO=1 alone otherwise throws a fatal
  // "Connection input stream is not set" before the server ever listens.
  // Every in-repo caller also passes --stdio, which is why this stayed
  // latent; the env var is documented as sufficient on its own.
  const hasTransportFlag = process.argv.some(
    (a) => a === "--stdio" || a === "--node-ipc" || a.startsWith("--socket="),
  );
  if (!hasTransportFlag) {
    process.argv.push("--stdio");
  }

  const connection = createConnection(ProposedFeatures.all);

  const server = createPikeServer(connection);

  // Safety net: ensure Pike worker subprocess is killed if the server Node
  // process exits unexpectedly (VSCode force-close, OOM kill, etc.).
  // Without this, the Pike worker becomes an orphan consuming resources
  // on shared development servers.
  const cleanupWorker = () => { server.worker.stop(); };

  // SIGTERM/SIGINT: save the persistent cache before exiting.
  // Without this, force-close loses the entire workspace index built during
  // the session. The LSP onShutdown handler does this normally, but signals
  // bypass it. Cache save is non-critical — if it fails, we still exit.
  const saveCacheAndExit = async () => {
    try {
      const wasmPath = resolve(import.meta.dirname ?? dirname(fileURLToPath(import.meta.url)), "tree-sitter-pike.wasm");
      const wasmHash = computeWasmHash(wasmPath);
      await saveCache(server.index.workspaceRoot, server.index, wasmHash);
    } catch {
      // Cache save failure is non-critical — proceed to exit.
    }
    cleanupWorker();
    process.exit(0);
  };

  process.on("exit", cleanupWorker);
  process.on("SIGTERM", saveCacheAndExit);
  process.on("SIGINT", saveCacheAndExit);

  server.connection.listen();
}

// Re-export for smoke test compatibility (smoke test imports createPikeServer)
export { createPikeServer } from "./server.js";
