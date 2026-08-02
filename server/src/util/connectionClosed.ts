/**
 * A client can end a session without completing `shutdown` — a crash, a kill,
 * an editor dropping the transport — and the first thing that tells the server
 * is a write failing. `vscode-jsonrpc` raises the same message for both of its
 * terminal states, so match on the text rather than on an error class it does
 * not export.
 */
export function isConnectionClosed(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /connection is (closed|disposed)/i.test(message);
}
