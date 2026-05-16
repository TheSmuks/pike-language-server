/**
 * Pike Language Server — production entry point.
 *
 * This module is the entry executed by the extension (via stdio transport).
 * It always listens — tests import createPikeServer() directly from server.ts
 * and never reach this file.
 */
import { createConnection, ProposedFeatures } from "vscode-languageserver/node";
import { createPikeServer } from "./server.js";
import { logError, ErrorCategory } from "./util/errorLog.js";

function shouldListen(): boolean {
  return process.env.PIKE_LSP_STDIO === "1";
}

// ─── Global error handlers ──────────────────────────────────────────────────
//
// These catch errors that escape the LSP handler stack and log them to the
// ErrorLog singleton (ring buffer, max 200 entries). From there they are
// forwarded to the connection console. The client also receives the error
// count via a custom notification so it can update the status bar badge.
//
// Note: logError needs a Connection to write to the LSP console. During early
// startup the connection may not exist yet, so we fall back to process.stderr.
// The cast through `unknown` is intentional — we provide only the subset of
// Connection needed by logError (console.error) before the real connection
// exists.

if (shouldListen()) {
  // Install handlers before anything else so we catch startup errors.
  process.on("uncaughtException", (err: Error) => {
    logError(
      { console: { error: (msg: string) => process.stderr.write(msg + "\n") } } as unknown as Parameters<typeof logError>[0],
      ErrorCategory.System,
      "uncaughtException",
      err,
    );
  });

  process.on("unhandledRejection", (reason: unknown) => {
    logError(
      { console: { error: (msg: string) => process.stderr.write(msg + "\n") } } as unknown as Parameters<typeof logError>[0],
      ErrorCategory.System,
      "unhandledRejection",
      reason,
    );
  });

  const connection = createConnection(ProposedFeatures.all);

  const server = createPikeServer(connection);

  // Safety net: ensure Pike worker subprocess is killed if the server Node
  // process exits unexpectedly (VSCode force-close, OOM kill, etc.).
  // Without this, the Pike worker becomes an orphan consuming resources
  // on shared development servers.
  const cleanupWorker = () => { server.worker.stop(); };
  process.on("exit", cleanupWorker);
  process.on("SIGTERM", () => { cleanupWorker(); process.exit(0); });
  process.on("SIGINT", () => { cleanupWorker(); process.exit(0); });

  server.connection.listen();
}

// Re-export for smoke test compatibility (smoke test imports createPikeServer)
export { createPikeServer } from "./server.js";
