/**
 * Types and constants for the PikeWorker subsystem.
 *
 * Extracted from pikeWorker.ts to keep each file under 500 lines.
 */

// ---------------------------------------------------------------------------
// Configuration (tunable per deployment)
// ---------------------------------------------------------------------------

export interface PikeWorkerConfig {
  /** Idle timeout in milliseconds before killing the worker. Default: 300000 (5 min). */
  idleTimeoutMs: number;
  /** Max requests before forced restart. Default: 100. */
  maxRequestsBeforeRestart: number;
  /** Max active minutes before forced restart. Default: 30. */
  maxActiveMinutes: number;
  /** Per-request timeout in milliseconds. Default: 5000 (5s). */
  requestTimeoutMs: number;
  /** Process nice value (Linux). Default: 5. Set to 0 to disable. */
  niceValue: number;
  /** Path to the Pike binary. Default: "pike". */
  pikeBinaryPath: string;
}

export const DEFAULT_CONFIG: PikeWorkerConfig = {
  idleTimeoutMs: 5 * 60 * 1000,
  maxRequestsBeforeRestart: 100,
  maxActiveMinutes: 30,
  requestTimeoutMs: 5_000,
  niceValue: 5,
  pikeBinaryPath: process.env.PIKE_BINARY ?? "pike",
};

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface PikeDiagnostic {
  line: number;
  severity: "error" | "warning";
  message: string;
  expected_type?: string;
  actual_type?: string;
  /** Optional error code from the Pike compiler. */
  code?: string;
}

export interface DiagnoseResult {
  diagnostics: PikeDiagnostic[];
  exit_code: number;
  /** Set when the request timed out — caller should surface as diagnostic. */
  timedOut?: boolean;
}

export interface AutodocResult {
  xml: string;
  error?: string;
}

export interface TypeofResult {
  type: string;
  error?: string;
}

export interface ResolveResult {
  resolved: boolean;
  name?: string;
  kind?: string;         // "class" | "function" | "module" | "variable"
  source_file?: string;
  source_line?: number;
  methods?: Array<{ name: string; source_file?: string; source_line?: number }>;
  constants?: Array<{ name: string; source_file?: string; source_line?: number }>;
  inherits?: Array<{ name: string; source_file?: string; source_line?: number }>;
  inherited_methods?: string[];
  inherited_constants?: string[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Internal protocol types
// ---------------------------------------------------------------------------

export interface PikeRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

export interface PikeResponse {
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

// ---------------------------------------------------------------------------
// PikeUnavailableError
// ---------------------------------------------------------------------------

/**
 * Error thrown when Pike binary is not available.
 * Used for graceful degradation — callers can catch and fall back to
 * tree-sitter-only features without spamming error logs.
 */
export class PikeUnavailableError extends Error {
  readonly name = "PikeUnavailableError";
  constructor(message = "Pike binary not available") {
    super(message);
    this.constructor = PikeUnavailableError;
    Object.setPrototypeOf(this, PikeUnavailableError.prototype);
  }
}

// ---------------------------------------------------------------------------
// Priority queue types
// ---------------------------------------------------------------------------

import type { CancellationToken } from "vscode-languageserver/node";

export interface QueueItem {
  payload: string;
  resolve: (response: PikeResponse) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  token?: CancellationToken;
  /** Priority: lower number = higher priority. Default 0 (highest). */
  priority: number;
}

/** Priority constants for PikeWorker requests.
 *  Lower number = higher priority. Interactive requests (hover, completion)
 *  should be serviced before background work (diagnostics). */
export const PikePriority = {
  /** Interactive: typeof_, autodoc for hover/completion. */
  interactive: 0,
  /** Default: general requests. */
  normal: 1,
  /** Background: diagnostics, indexing. */
  background: 2,
} as const;

/** Clamp a priority number to a valid sub-queue index (0–2). */
export function clampPriority(p: number): 0 | 1 | 2 {
  if (p <= 0) return 0;
  if (p >= 2) return 2;
  return 1;
}
