/**
 * Pike Language Server — production entry point.
 *
 * This module is the entry executed by the extension (via stdio transport).
 * It always listens — tests import createPikeServer() directly from server.ts
 * and never reach this file.
 */
import { createConnection, ProposedFeatures } from "vscode-languageserver/node";
import { createPikeServer } from "./server.js";

// Only listen when running as stdio server (not imported as a module).
// PIKE_LSP_STDIO env var is set by the extension when spawning the server.
function shouldListen(): boolean {
  return process.env.PIKE_LSP_STDIO === "1";
}

if (shouldListen()) {
  const connection = createConnection(ProposedFeatures.all);
  const server = createPikeServer(connection);
  server.connection.listen();
}

// Re-export for smoke test compatibility (smoke test imports createPikeServer)
export { createPikeServer } from "./server.js";