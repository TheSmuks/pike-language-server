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
  /**
   * URIs already re-diagnosed in the propagation wave that scheduled this
   * diagnose, or null when scheduled by a real edit. Cycle guard: a
   * propagated re-diagnose bypasses the content-hash cache, so an import
   * cycle would otherwise ping-pong forever.
   */
  propagationChain: Set<string> | null;
}
