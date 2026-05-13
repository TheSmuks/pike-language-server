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

if (shouldListen()) {
  // Install handlers before anything else so we catch startup errors.
  process.on("uncaughtException", (err: Error) => {
    logError(
      { console: { error: (msg: string) => process.stderr.write(msg + "\n") } } as never,
      ErrorCategory.System,
      "uncaughtException",
      err,
    );
  });

  process.on("unhandledRejection", (reason: unknown) => {
    logError(
      { console: { error: (msg: string) => process.stderr.write(msg + "\n") } } as never,
      ErrorCategory.System,
      "unhandledRejection",
      reason,
    );
  });

  const stderr = (msg: string) => { process.stderr.write(msg + "\n"); };

  stderr("[init] step 1/5: process started — pid=" + process.pid + " node=" + process.version);

  stderr("[init] step 2/5: creating LSP connection");
  const connection = createConnection(ProposedFeatures.all);
  stderr("[init] step 2/5: connection created");

  stderr("[init] step 3/5: creating server");
  const server = createPikeServer(connection);
  stderr("[init] step 3/5: server created");

  stderr("[init] step 4/5: registering global error handlers");
  // (already done above via process.on)

  stderr("[init] step 5/5: listening on stdio");
  server.connection.listen();
  stderr("[init] step 5/5: listening — server ready for client connection");
}

// Re-export for smoke test compatibility (smoke test imports createPikeServer)
export { createPikeServer } from "./server.js";
