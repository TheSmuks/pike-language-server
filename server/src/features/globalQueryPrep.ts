/**
 * Global query preparation for WorkspaceIndex.
 *
 * Extracted from workspaceResolution.ts to keep that file under the 500-line
 * TigerStyle limit. The first global query (workspace symbol, find references,
 * rename, call hierarchy) must block to build the complete index; this module
 * owns that on-demand full-scan orchestration plus the degraded-mode guard.
 *
 * Re-exported from workspaceResolution.ts so existing import sites (and the
 * resource-resilience tests) keep working unchanged.
 */

import type { Connection } from "vscode-languageserver/node";
import type { CancellationToken } from "vscode-jsonrpc";
import type { WorkspaceIndex } from "./workspaceIndex";
import { indexWorkspaceFiles } from "./backgroundIndex";

// ---------------------------------------------------------------------------
// Options & error
// ---------------------------------------------------------------------------

/**
 * Options for ensuring the workspace is indexed before a global query.
 */
export interface GlobalQueryPrepOptions {
  connection: Connection;
  index: WorkspaceIndex;
  workspaceRoot: string;
  cancellationToken?: CancellationToken;
  ignoreGlobs?: string[];
  maxFileSizeBytes?: number;
  fullScanFileLimit?: number;
  /**
   * When true, global features are temporarily unavailable because the server
   * is under memory pressure. prepareGlobalQuery throws DegradedGlobalUnavailableError
   * instead of returning partial or empty results.
   */
  isDegraded?: () => boolean;
}

/**
 * Error thrown when a global feature is requested while the server is in
 * degraded mode (under memory pressure).
 *
 * Global features (workspace symbol, find references, rename, call hierarchy)
 * require a complete index. Under memory pressure, the index may be partially
 * demoted. Rather than returning incomplete results, the feature reports this
 * honest error so the client can show an accurate message.
 */
export class DegradedGlobalUnavailableError extends Error {
  constructor() {
    super(
      "Global features are temporarily unavailable while the server is under memory pressure. " +
      "Try again after memory pressure subsides.",
    );
    this.name = "DegradedGlobalUnavailableError";
  }
}

// ---------------------------------------------------------------------------
// prepareGlobalQuery
// ---------------------------------------------------------------------------

/**
 * Ensure the workspace is fully indexed before a global query proceeds.
 *
 * In `openFiles` mode, the first global query (workspace symbol, find
 * references, rename, call hierarchy) must block to build the complete index.
 * This function triggers a full workspace scan via indexWorkspaceFiles, which
 * discovers and indexes any unindexed files. The scan itself handles batching,
 * yielding between batches, workDoneProgress reporting, and cancellation at
 * safe boundaries.
 *
 * Per contracts/lsp-resource-state.md:
 * - The first request reports workDoneProgress and supports cancellation.
 * - Without cancellation, results must be complete — never partial.
 * - Cancelled preparation is NOT marked done; the next query retries.
 * - When degraded (memory pressure), throws DegradedGlobalUnavailableError
 *   instead of returning partial or empty results.
 *
 * Idempotent: if the index has already been globally prepared, returns 0
 * immediately without re-scanning.
 *
 * Returns the total number of indexed entries after preparation.
 */
export async function prepareGlobalQuery(
  options: GlobalQueryPrepOptions,
): Promise<number> {
  // Degraded guard: never return partial results under memory pressure.
  if (options.isDegraded?.()) {
    throw new DegradedGlobalUnavailableError();
  }

  const { connection, index, workspaceRoot } = options;

  // Idempotency: skip if a full scan has already completed.
  if (index.isGlobalPrepDone()) return index.size;

  if (!workspaceRoot) {
    index.markGlobalPrepDone();
    return index.size;
  }

  // Delegate to backgroundIndex — it handles discovery, filtering, batching,
  // yielding, progress, and cancellation between batches.
  await indexWorkspaceFiles({
    connection,
    index,
    workspaceRoot,
    indexingMode: "full",
    cancellationToken: options.cancellationToken,
    ignoreGlobs: options.ignoreGlobs,
    maxFileSizeBytes: options.maxFileSizeBytes,
    fullScanFileLimit: options.fullScanFileLimit,
  });

  // Per contract: cancelled preparation must NOT be cached as complete.
  // Leave globalPrepDone false so the next global query retries.
  if (options.cancellationToken?.isCancellationRequested) {
    return index.size;
  }

  index.markGlobalPrepDone();
  return index.size;
}
