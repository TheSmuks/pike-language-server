/**
 * The options and cache entry DiagnosticManager is constructed with.
 *
 * Split out of diagnosticManager.ts to keep it under the 500-line limit.
 */

import type { Connection, TextDocuments } from "vscode-languageserver/node";
import type { TextDocument } from "vscode-languageserver-textdocument";
import type { PikeWorker } from "./pikeWorker";
import type { WorkspaceIndex } from "./workspaceIndex";
import type { PikeDiagnostic } from "./pikeWorkerTypes.js";

export type DiagnosticMode = "realtime" | "saveOnly" | "off";

export interface DiagnosticManagerOptions {
  worker: PikeWorker;
  documents: TextDocuments<TextDocument>;
  connection: Connection;
  index: WorkspaceIndex;
  /** Pike cache (shared with server.ts for LRU eviction). */
  pikeCache: { get(key: string): PikeCacheEntry | undefined; delete(key: string): boolean };
  /** Function to update the LRU cache. */
  cacheSet: (uri: string, entry: PikeCacheEntry) => void;
  /** Debounce interval in ms. Default: 500. */
  debounceMs?: number;
  /** Time before staleness warning in ms. Default: 2000. */
  staleMs?: number;
  /** Diagnostic mode. Default: "realtime". */
  mode?: DiagnosticMode;
  /** Maximum number of diagnostics to publish per file. Default: 100. */
  maxNumberOfProblems?: number;
  /** Enables verbose internal telemetry logs for race/staleness debugging. */
  debugTelemetry?: boolean;
  /**
   * True when this document is a Roxen file, and the pike compile must be
   * skipped for it. See runDiagnose.
   */
  isRoxenDocument?: (uri: string) => boolean;
}

export interface PikeCacheEntry {
  contentHash: string;
  diagnostics: PikeDiagnostic[];
  timestamp: number;
}

