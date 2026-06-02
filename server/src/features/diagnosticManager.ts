/**
 * DiagnosticManager — real-time diagnostics with debouncing.
 *
 * Design: decision 0013 (debouncing/supersession), decision 0018 (FIFO
 * queue moved to PikeWorker).
 *
 * Per-file debounce timers, version-gated supersession, cross-file
 * propagation, and diagnostic mode selection.
 *
 * The PikeWorker now owns the FIFO queue — DiagnosticManager no longer
 * maintains its own.  All calls to worker.diagnose(), worker.autodoc(),
 * etc. are automatically serialized by PikeWorker.enqueue().
 */

import {
  Connection,
  Diagnostic,
  DiagnosticSeverity,
  TextDocuments,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";

import { PikeWorker, PikeUnavailableError, type PikeDiagnostic } from "./pikeWorker";
import { getParseDiagnostics } from "./diagnostics";
import { runLintRules } from "./lintRules";
import { parse, type Tree } from "../parser";
import { buildSymbolTable } from "./symbolTable";
import type { WorkspaceIndex } from "./workspaceIndex";
import { logError, logInfo, ErrorCategory } from "../util/errorLog.js";
import { uriToPath } from "../util/uri";
import { computeContentHash, mergeDiagnostics } from "./diagnosticUtils";

// Re-export utilities for backward compatibility
export {
  mergeDiagnostics,
  computeContentHash,
  lineToColumn,
} from "./diagnosticUtils";

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
  pikeCache: { get(key: string): PikeCacheEntry | undefined };
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
  private readonly pikeCache: { get(key: string): PikeCacheEntry | undefined };
  private readonly cacheSet: (uri: string, entry: PikeCacheEntry) => void;
  private debounceMs: number;
  private readonly staleMs: number;
  private mode: DiagnosticMode;
  private maxProblems: number;
  private debugTelemetry: boolean;
  private disposed = false;

  private readonly fileStates = new Map<string, FileDiagnosticState>();

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
    this.maxProblems = options.maxNumberOfProblems ?? 100;
    this.debugTelemetry = options.debugTelemetry ?? false;
  }

  setDebugTelemetry(enabled: boolean): void {
    this.debugTelemetry = enabled;
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

  /** Update the debounce interval. Takes effect on next timer reset. */
  setDebounceMs(ms: number): void {
    this.debounceMs = ms;
  }

  /** Update the maximum number of diagnostics per file. */
  setMaxNumberOfProblems(max: number): void {
    this.maxProblems = max;
  }

  /**
   * Called on didChange. In realtime mode, resets debounce timer.
   * Parse diagnostics are published immediately (they're cheap — tree-sitter ERROR scan).
   * Lint diagnostics (unused vars, unreachable code) are deferred to the debounced path
   * because buildSymbolTable is expensive.
   */
  onDidChange(uri: string): void {
    if (this.disposed) return;
    const doc = this.documents.get(uri);
    if (!doc) return;

    // Always publish parse diagnostics immediately (tree-sitter, no worker).
    // Only scan for ERROR nodes — buildSymbolTable is deferred to the debounced path.
    // Merge with last known pike diagnostics so that existing pike diagnostics
    // are not cleared while a debounced run is pending or skipped.
    try {
      const source = doc.getText();
      const tree = parse(source, uri);
      if (!this.disposed) {
        const lines = source.split('\n');
        const parseDiags = getParseDiagnostics(tree, lines);
        const cached = this.pikeCache.get(uri);
        const pikeDiags = cached ? cached.diagnostics : [];
        const merged = mergeDiagnostics(parseDiags, pikeDiags, tree, [], lines);
        this.connection.sendDiagnostics({
          uri,
          diagnostics: merged,
        });
      }
    } catch (err) {
      // Parse failure — log but don't crash the manager
      logError(this.connection, ErrorCategory.Parse, `diagnosticManager.publishParseDiags(${uri})`, err);
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

    if (!this.disposed) {
      this.connection.sendDiagnostics({ uri, diagnostics: [] });
    }
  }

  /** Dispose all timers. */
  dispose(): void {
    this.disposed = true;
    for (const [, state] of this.fileStates) {
      this.clearTimers(state);
    }
    this.fileStates.clear();
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

    // Fire-and-forget: PikeWorker's FIFO queue handles serialization
    this.runDiagnose(uri);
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
    const requestedVersion = doc.version;

    // Check cache
    const cached = this.pikeCache.get(uri);
    if (cached && cached.contentHash === contentHash) {
      const { tree: parseTree, diagnostics: parseDiags, lines } = this.safeParse(source, uri);
      const lintDiags = this.safeLintDiagnostics(parseTree, uri, doc.version, source);
      const lspDiagnostics = mergeDiagnostics(parseDiags, cached.diagnostics, parseTree ?? undefined, lintDiags, lines);
      this.publishDiagnostics(uri, lspDiagnostics, requestedVersion);
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
      this.publishDiagnostics(uri, [...state.lastDiagnostics, staleDiag], requestedVersion);
    }, this.staleMs);
    if (state.staleTimer.unref) state.staleTimer.unref();

    try {
      const filepath = uriToPath(uri);
      const result = await this.worker.diagnose(source, filepath);

      // Clear staleness timer
      this.clearStaleTimer(state);

      if (result.timedOut) {
        const { diagnostics: parseDiags } = this.safeParse(source, uri);
        const timeoutDiag: Diagnostic = {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
          severity: DiagnosticSeverity.Warning,
          source: "pike-lsp",
          message: "Compilation timed out, will retry on next save.",
        };
        this.publishDiagnostics(uri, [...parseDiags, timeoutDiag], requestedVersion);
        return;
      }

      // Update cache
      this.cacheSet(uri, {
        contentHash,
        diagnostics: result.diagnostics,
        timestamp: Date.now(),
      });

      // Merge and publish
      const { tree: parseTree, diagnostics: parseDiags, lines } = this.safeParse(source, uri);
      const lintDiags = this.safeLintDiagnostics(parseTree, uri, doc.version, source);
      const lspDiagnostics = mergeDiagnostics(parseDiags, result.diagnostics, parseTree ?? undefined, lintDiags, lines);
      this.publishDiagnostics(uri, lspDiagnostics, requestedVersion);

      // Cross-file propagation: schedule re-diagnosis of dependents
      this.propagateToDependents(uri);

    } catch (err) {
      this.clearStaleTimer(state);
      if (!this.disposed) {
        const isPikeUnavailable = err instanceof Error
          && err.name === "PikeUnavailableError";
        if (!isPikeUnavailable) {
          logError(this.connection, ErrorCategory.Diagnostics, `diagnosticManager.dispatchDiagnose(${uri})`, err);
        }
      }
      // Keep only parse diagnostics
      const { diagnostics: parseDiags } = this.safeParse(source, uri);
      if (!this.disposed) {
        this.publishDiagnostics(uri, parseDiags, requestedVersion);
      }
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
  private publishDiagnostics(
    uri: string,
    diagnostics: Diagnostic[],
    expectedVersion?: number,
  ): void {
    if (this.disposed) return;

    if (expectedVersion !== undefined) {
      const liveDoc = this.documents.get(uri);
      if (!liveDoc) {
        if (this.debugTelemetry) {
          logInfo(this.connection, `[telemetry] diagnostics drop-no-live-doc uri=${uri} expectedVersion=${expectedVersion}`);
        }
        return;
      }
      if (liveDoc.version !== expectedVersion) {
        if (this.debugTelemetry) {
          logInfo(this.connection, `[telemetry] diagnostics drop-version-mismatch uri=${uri} expectedVersion=${expectedVersion} liveVersion=${liveDoc.version}`);
        }
        return;
      }
    }

    const truncated = diagnostics.length > this.maxProblems
      ? diagnostics.slice(0, this.maxProblems)
      : diagnostics;
    const state = this.fileStates.get(uri);
    if (state) {
      state.lastDiagnostics = truncated;
    }
    try {
      this.connection.sendDiagnostics({ uri, diagnostics: truncated });
      if (this.debugTelemetry) {
        logInfo(this.connection, `[telemetry] diagnostics published uri=${uri} count=${truncated.length}${expectedVersion !== undefined ? ` version=${expectedVersion}` : ""}`);
      }
    } catch {
      // Connection may be closed during teardown — not an error
    }
  }

  /** Parse the source and extract parse diagnostics. Returns both to avoid double-parsing.
   *  When uri is provided, the parser cache is used instead of re-parsing from scratch. */
  private safeParse(source: string, uri?: string): { tree: Tree | null; diagnostics: Diagnostic[]; lines: string[] } {
    try {
      const lines = source.split('\n');
      const tree = parse(source, uri);
      return { tree, diagnostics: getParseDiagnostics(tree, lines), lines };
    } catch (err) {
      logError(this.connection, ErrorCategory.Parse, `safeParse(${uri ?? "unknown"})`, err);
      return { tree: null, diagnostics: [], lines: [] };
    }
  }

  /** Lint diagnostics (unused vars, unreachable code). Returns [] on parse failure. */
  private safeLintDiagnostics(tree: Tree | null, uri: string, version: number, source: string): Diagnostic[] {
    if (tree === null) return [];
    try {
      const table = buildSymbolTable(tree, uri, version);
      return runLintRules(tree, table, source);
    } catch (err) {
      logError(this.connection, ErrorCategory.Diagnostics, `safeLintDiagnostics(${uri})`, err);
      return [];
    }
  }
}
