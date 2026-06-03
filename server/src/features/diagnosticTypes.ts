/**
 * Shared diagnostic types.
 *
 * Extracted from diagnosticManager.ts to keep it under 500 lines.
 */

import type { Diagnostic } from "vscode-languageserver/node";

// ---------------------------------------------------------------------------
// Per-file state
// ---------------------------------------------------------------------------

export interface FileDiagnosticState {
  /** Active debounce timer. */
  timer: ReturnType<typeof setTimeout> | null;
  /** Document version when timer was set (for supersession). */
  version: number;
  /** Content hash when timer was set (for cache check). */
  contentHash: string;
  /** True when a diagnose request is in flight for this file. */
  inFlight: boolean;
  /** Staleness timer for long-running diagnose. */
  staleTimer: ReturnType<typeof setTimeout> | null;
  /** Last published diagnostics (for staleness overlay). */
  lastDiagnostics: Diagnostic[];
}
