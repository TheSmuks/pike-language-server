/**
 * DiagnosticManager — real-time diagnostics with debouncing.
 *
 * Design: decision 0013.
 *
 * Per-file debounce timers, version-gated supersession, worker priority
 * queueing, cross-file propagation, and diagnostic mode selection.
 */

import {
  Connection,
  Diagnostic,
  DiagnosticSeverity,
  TextDocuments,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { PikeWorker, type PikeDiagnostic } from "./pikeWorker";
import { getParseDiagnostics } from "./diagnostics";
import { parse } from "../parser";
import type { WorkspaceIndex } from "./workspaceIndex";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DiagnosticMode = "realtime" | "saveOnly" | "off";

export interface DiagnosticManagerOptions {
  worker: PikeWorker;
  documents: TextDocuments<TextDocument>;
  connection: Connection;
  index: WorkspaceIndex;
  /** Pike cache (shared with server.ts for LRU eviction). */
  pikeCache: Map<string, PikeCacheEntry>;
  /** Function to update the LRU cache. */
  cacheSet: (uri: string, entry: PikeCacheEntry) => void;
  /** Debounce interval in ms. Default: 500. */
  debounceMs?: number;
  /** Time before staleness warning in ms. Default: 2000. */
  staleMs?: number;
  /** Diagnostic mode. Default: "realtime". */
  mode?: DiagnosticMode;
}

export interface PikeCacheEntry {
  contentHash: string;
  diagnostics: PikeDiagnostic[];
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Per-file state
// ---------------------------------------------------------------------------

interface FileDiagnosticState {
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

// ---------------------------------------------------------------------------
// DiagnosticManager
// ---------------------------------------------------------------------------

export class DiagnosticManager {
  private readonly worker: PikeWorker;
  private readonly documents: TextDocuments<TextDocument>;
  private readonly connection: Connection;
  private index: WorkspaceIndex;
  private readonly pikeCache: Map<string, PikeCacheEntry>;
  private readonly cacheSet: (uri: string, entry: PikeCacheEntry) => void;
  private readonly debounceMs: number;
  private readonly staleMs: number;
  private mode: DiagnosticMode;
  private disposed = false;

  private readonly fileStates = new Map<string, FileDiagnosticState>();

  // Worker priority queue
  private readonly highPriorityQueue: Array<{
    resolve: (response: unknown) => void;
    reject: (error: Error) => void;
    execute: () => Promise<unknown>;
  }> = [];
  private readonly lowPriorityQueue: Array<{
    resolve: (response: unknown) => void;
    reject: (error: Error) => void;
    execute: () => Promise<unknown>;
  }> = [];
  private workerBusy = false;

  constructor(options: DiagnosticManagerOptions) {
    this.worker = options.worker;
    this.documents = options.documents;
    this.connection = options.connection;
    this.index = options.index;
    this.pikeCache = options.pikeCache;
    this.cacheSet = options.cacheSet;
    this.debounceMs = options.debounceMs ?? 500;
    this.staleMs = options.staleMs ?? 2000;
    this.mode = options.mode ?? "realtime";
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Get the current diagnostic mode. */
  get diagnosticMode(): DiagnosticMode {
    return this.mode;
  }

  /** Set the diagnostic mode. Takes effect immediately. */
  setDiagnosticMode(mode: DiagnosticMode): void {
    this.mode = mode;
    if (mode !== "realtime") {
      for (const [uri, state] of this.fileStates) {
        this.clearTimers(state);
        this.fileStates.delete(uri);
      }
    }
  }

  /** Update the workspace index reference (called after onInitialize). */
  setIndex(idx: WorkspaceIndex): void {
    this.index = idx;
  }

  /**
   * Called on didChange. In realtime mode, resets debounce timer.
   * Parse diagnostics are published immediately (they're free).
   */
  onDidChange(uri: string): void {
    if (this.disposed) return;
    const doc = this.documents.get(uri);
    if (!doc) return;

    // Always publish parse diagnostics immediately (tree-sitter, no worker)
    try {
      const tree = parse(doc.getText());
      this.connection.sendDiagnostics({
        uri,
        diagnostics: getParseDiagnostics(tree),
      });
    } catch {
      // Parse failure — don't crash the manager
    }

    if (this.mode !== "realtime") return;

    // Reset debounce timer
    const state = this.getOrCreateState(uri);
    this.clearDebounceTimer(state);

    state.version = doc.version;
    state.contentHash = computeContentHash(doc.getText());

    state.timer = setTimeout(() => {
      state.timer = null;
      this.dispatchDiagnose(uri);
    }, this.debounceMs);

    // Don't prevent process exit
    if (state.timer.unref) state.timer.unref();
  }

  /**
   * Called on didSave. Fires immediate diagnose regardless of mode.
   * In "off" mode, only parse diagnostics are published.
   */
  async onDidSave(uri: string): Promise<void> {
    if (this.mode === "off" || this.disposed) return;

    // Cancel any pending debounce timer — we're doing it now
    const state = this.fileStates.get(uri);
    if (state) {
      this.clearDebounceTimer(state);
    }

    await this.runDiagnose(uri);
  }

  /**
   * Called on didClose. Cancels timer, clears diagnostics.
   */
  onDidClose(uri: string): void {
    if (this.disposed) return;
    const state = this.fileStates.get(uri);
    if (state) {
      this.clearTimers(state);
      this.fileStates.delete(uri);
    }

    this.connection.sendDiagnostics({ uri, diagnostics: [] });
  }

  /** Dispose all timers. */
  dispose(): void {
    this.disposed = true;
    for (const [, state] of this.fileStates) {
      this.clearTimers(state);
    }
    this.fileStates.clear();
    // Silently drop queued items — don't reject, connections may be closed
    this.lowPriorityQueue.length = 0;
    this.highPriorityQueue.length = 0;
  }

  /**
   * Queue a high-priority request (hover, completion, etc.).
   * Returns a promise that resolves when the worker processes the request.
   */
  queueHighPriority<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.highPriorityQueue.push({
        resolve: resolve as (r: unknown) => void,
        reject,
        execute: fn,
      });
      this.drainQueue();
    });
  }

  // -----------------------------------------------------------------------
  // Internal: diagnose dispatch
  // -----------------------------------------------------------------------

  /**
   * Dispatch a diagnose for the given URI.
   * Checks supersession (version gate) before running.
   */
  private dispatchDiagnose(uri: string): void {
    if (this.disposed) return;
    const doc = this.documents.get(uri);
    if (!doc) return;

    const state = this.fileStates.get(uri);
    if (!state) return;

    // Supersession check: if the document version has changed since we set
    // the timer, skip — a newer timer will handle it.
    if (doc.version !== state.version) return;

    // Don't queue if already in flight (the result will cover this version)
    if (state.inFlight) return;

    // Queue as low priority
    this.enqueueLowPriority(async () => {
      await this.runDiagnose(uri);
    });
  }

  /**
   * Run diagnose for a URI. Handles caching, timeout, staleness.
   */
  private async runDiagnose(uri: string): Promise<void> {
    if (this.disposed) return;
    const doc = this.documents.get(uri);
    if (!doc) return;

    const source = doc.getText();
    const contentHash = computeContentHash(source);

    // Check cache
    const cached = this.pikeCache.get(uri);
    if (cached && cached.contentHash === contentHash) {
      const parseDiags = this.safeParseDiagnostics(source);
      const lspDiagnostics = mergeDiagnostics(parseDiags, cached.diagnostics);
      this.publishDiagnostics(uri, lspDiagnostics);
      return;
    }

    // Mark as in-flight
    const state = this.getOrCreateState(uri);
    state.inFlight = true;
    state.lastDiagnostics = [];

    // Start staleness timer
    state.staleTimer = setTimeout(() => {
      // Publish staleness warning alongside previous diagnostics
      const staleDiag: Diagnostic = {
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
        severity: DiagnosticSeverity.Information,
        source: "pike-lsp",
        message: "Diagnostics are being updated\u2026",
      };
      this.publishDiagnostics(uri, [...state.lastDiagnostics, staleDiag]);
    }, this.staleMs);
    if (state.staleTimer.unref) state.staleTimer.unref();

    try {
      const filepath = uri.startsWith("file://") ? uri.slice(7) : uri;
      const result = await this.worker.diagnose(source, filepath);

      // Clear staleness timer
      this.clearStaleTimer(state);

      if (result.timedOut) {
        const parseDiags = this.safeParseDiagnostics(source);
        const timeoutDiag: Diagnostic = {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
          severity: DiagnosticSeverity.Warning,
          source: "pike-lsp",
          message: "Compilation timed out, will retry on next save.",
        };
        this.publishDiagnostics(uri, [...parseDiags, timeoutDiag]);
        return;
      }

      // Update cache
      this.cacheSet(uri, {
        contentHash,
        diagnostics: result.diagnostics,
        timestamp: Date.now(),
      });

      // Merge and publish
      const parseDiags = this.safeParseDiagnostics(source);
      const lspDiagnostics = mergeDiagnostics(parseDiags, result.diagnostics);
      this.publishDiagnostics(uri, lspDiagnostics);

      // Cross-file propagation: schedule re-diagnosis of dependents
      this.propagateToDependents(uri);
    } catch (err) {
      this.clearStaleTimer(state);
      this.connection.console.error(
        `Pike diagnose failed for ${uri}: ${(err as Error).message}`,
      );
      // Keep only parse diagnostics
      const parseDiags = this.safeParseDiagnostics(source);
      this.publishDiagnostics(uri, parseDiags);
    } finally {
      state.inFlight = false;
    }
  }

  // -----------------------------------------------------------------------
  // Internal: cross-file propagation
  // -----------------------------------------------------------------------

  /**
   * After diagnosing file A, schedule re-diagnosis for files that depend on A.
   * Uses a short debounce so dependent files batch together.
   */
  private propagateToDependents(editedUri: string): void {
    const dependents = this.index.getDependents(editedUri);
    if (dependents.size === 0) return;

    for (const depUri of dependents) {
      // Only propagate to open files
      const depDoc = this.documents.get(depUri);
      if (!depDoc) continue;

      // Schedule a debounced diagnose for the dependent file
      const depState = this.getOrCreateState(depUri);
      this.clearDebounceTimer(depState);

      depState.version = depDoc.version;
      depState.contentHash = computeContentHash(depDoc.getText());

      depState.timer = setTimeout(() => {
        depState.timer = null;
        this.dispatchDiagnose(depUri);
      }, this.debounceMs);

      if (depState.timer.unref) depState.timer.unref();
    }
  }

  // -----------------------------------------------------------------------
  // Internal: priority queue
  // -----------------------------------------------------------------------

  private enqueueLowPriority(fn: () => Promise<void>): void {
    this.lowPriorityQueue.push({
      resolve: () => {},
      reject: (_err: Error) => {
        // Silently swallow — connection may be closed during teardown
      },
      execute: fn,
    });
    this.drainQueue();
  }

  private drainQueue(): void {
    if (this.workerBusy || this.disposed) return;

    // High priority first
    const item =
      this.highPriorityQueue.shift() ?? this.lowPriorityQueue.shift();
    if (!item) return;

    this.workerBusy = true;
    item
      .execute()
      .then((result) => {
        this.workerBusy = false;
        if (!this.disposed) {
          item.resolve(result);
          this.drainQueue();
        }
      })
      .catch((err: Error) => {
        this.workerBusy = false;
        if (!this.disposed) {
          item.reject(err);
          this.drainQueue();
        }
      });
  }

  // -----------------------------------------------------------------------
  // Internal: helpers
  // -----------------------------------------------------------------------

  private getOrCreateState(uri: string): FileDiagnosticState {
    let state = this.fileStates.get(uri);
    if (!state) {
      state = {
        timer: null,
        version: 0,
        contentHash: "",
        inFlight: false,
        staleTimer: null,
        lastDiagnostics: [],
      };
      this.fileStates.set(uri, state);
    }
    return state;
  }

  private clearDebounceTimer(state: FileDiagnosticState): void {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  }

  private clearStaleTimer(state: FileDiagnosticState): void {
    if (state.staleTimer) {
      clearTimeout(state.staleTimer);
      state.staleTimer = null;
    }
  }

  private clearTimers(state: FileDiagnosticState): void {
    this.clearDebounceTimer(state);
    this.clearStaleTimer(state);
  }

  /** Publish diagnostics and cache them for staleness overlay. */
  private publishDiagnostics(uri: string, diagnostics: Diagnostic[]): void {
    const state = this.fileStates.get(uri);
    if (state) {
      state.lastDiagnostics = diagnostics;
    }
    this.connection.sendDiagnostics({ uri, diagnostics });
  }

  /** Parse diagnostics with error suppression. */
  private safeParseDiagnostics(source: string): Diagnostic[] {
    try {
      return getParseDiagnostics(parse(source));
    } catch {
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// Standalone helpers (pure functions, easy to test)
// ---------------------------------------------------------------------------

/** Merge parse diagnostics with Pike compilation diagnostics. */
export function mergeDiagnostics(
  parseDiags: Diagnostic[],
  pikeDiags: PikeDiagnostic[],
): Diagnostic[] {
  const result = [...parseDiags];

  for (const pd of pikeDiags) {
    const line = pd.line - 1; // Pike: 1-based → LSP: 0-based

    let message = pd.message;
    if (pd.expected_type) message += `\nExpected: ${pd.expected_type}`;
    if (pd.actual_type) message += `\nGot: ${pd.actual_type}`;

    result.push({
      range: {
        start: { line, character: 0 },
        end: { line, character: 0 },
      },
      severity:
        pd.severity === "error"
          ? DiagnosticSeverity.Error
          : DiagnosticSeverity.Warning,
      source: "pike",
      message,
    });
  }

  return result;
}

/** Compute SHA-256 content hash. */
export function computeContentHash(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}
