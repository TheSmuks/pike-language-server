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
  TextDocuments,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { namesRoxenRuntime } from "./roxenActivation";

import { PikeWorker } from "./pikeWorker.js";
import { isPikeUnavailable } from "./pikeWorkerTypes";
import type { PikeDiagnostic } from "./pikeWorkerTypes.js";
import { getParseDiagnostics } from "./diagnostics";
import { runLintRules } from "./lintRules";
import { parse, type Tree } from "../parser";
import { buildSymbolTable, type SymbolTable } from "./symbolTable";
import type { WorkspaceIndex } from "./workspaceIndex";
import { logError, logInfo, ErrorCategory } from "../util/errorLog.js";
import { uriToPath } from "../util/uri";
import { isConnectionClosed } from "../util/connectionClosed";
import {
  computeContentHash, mergeDiagnostics, buildTruncationNotice,
  buildStaleDiagnostic, buildTimeoutDiagnostic,
} from "./diagnosticUtils";
import { type FileDiagnosticState } from "./diagnosticTypes";
import { propagateToDependents, collectDependencyOverlays } from "./diagnosticPropagation";

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

// --------------------------------------------------------------------------
// DiagnosticManager
// --------------------------------------------------------------------------

export class DiagnosticManager {
  private readonly worker: PikeWorker;
  private readonly documents: TextDocuments<TextDocument>;
  private readonly connection: Connection;
  private index: WorkspaceIndex;
  private readonly pikeCache: { get(key: string): PikeCacheEntry | undefined; delete(key: string): boolean };
  private readonly cacheSet: (uri: string, entry: PikeCacheEntry) => void;
  private debounceMs: number;
  private readonly staleMs: number;
  private mode: DiagnosticMode;
  private maxProblems: number;
  private debugTelemetry: boolean;
  private readonly isRoxenDocument?: (uri: string) => boolean;
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
    this.isRoxenDocument = options.isRoxenDocument;
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
        const parseDiags = getParseDiagnostics(tree);
        const cached = this.pikeCache.get(uri);
        const pikeDiags = cached ? cached.diagnostics : [];
        const merged = mergeDiagnostics(parseDiags, pikeDiags, tree, [], lines);
        this.connection.sendDiagnostics({
          uri,
          diagnostics: merged,
        });
      }
    } catch (err) {
      // The session is over; every publish path already stops on `disposed`,
      // so recording it keeps an in-flight edit from retrying a dead socket.
      if (isConnectionClosed(err)) {
        this.disposed = true;
        return;
      }
      // Parse failure — log but don't crash the manager
      logError(this.connection, ErrorCategory.Parse, `diagnosticManager.publishParseDiags(${uri})`, err);
    }

    if (this.mode !== "realtime") return;

    // Reset debounce timer
    const state = this.getOrCreateState(uri);
    this.clearDebounceTimer(state);

    state.version = doc.version;
    state.contentHash = computeContentHash(doc.getText());
    state.propagationChain = null; // a real edit starts a new wave

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

  private publishParseAndLintDiagnostics(uri: string, source: string, doc: { version: number }, pikeDiagnostics: PikeDiagnostic[] = []): void {
    const { tree: parseTree, diagnostics: parseDiags, lines } = this.safeParse(source, uri);
    const lintDiags = this.safeLintDiagnostics(parseTree, uri, doc.version, source);
    const lspDiagnostics = mergeDiagnostics(parseDiags, pikeDiagnostics, parseTree ?? undefined, lintDiags, lines);
    this.publishDiagnostics(uri, lspDiagnostics, doc.version);
  }

  /**
   * Run diagnose for a URI. Handles caching, timeout, staleness.
   */
  private requestDiagnose(uri: string, source: string) {
    return this.worker.diagnose(source, uriToPath(uri), {
      modulePaths: this.index.pikePaths.modulePaths,
      includePaths: this.index.pikePaths.includePaths,
      programPaths: this.index.pikePaths.programPaths,
      dependencies: collectDependencyOverlays(uri, this.index, this.documents, {
        connection: this.connection,
      }),
    });
  }

  private async runDiagnose(uri: string): Promise<void> {
    if (this.disposed) return;
    const doc = this.documents.get(uri);
    if (!doc) return;
    const source = doc.getText();
    const contentHash = computeContentHash(source);

    const cached = this.pikeCache.get(uri);
    if (cached && cached.contentHash === contentHash) {
      this.publishParseAndLintDiagnostics(uri, source, doc, cached.diagnostics);
      return;
    }

    // A Roxen file cannot be compiled by the stock pike binary: Roxen's
    // runtime — `Roxen`, `RXML`, `Variable`, `inherit "module"` — exists only
    // inside a running Roxen server, and Roxen 6.1 does not even run on Pike
    // 8.0. Every resulting error is noise about the environment rather than
    // the code: one 709-line module produced 75 of them, led by "Undefined
    // identifier Roxen." Parse and lint diagnostics still run, so a genuine
    // syntax error is still reported.
    // Either a Roxen file by activation, or any file naming Roxen's runtime:
    // both are files the stock binary cannot check. The second is a weaker
    // claim on purpose — it decides nothing about hover or completion, only
    // that asking the compiler is pointless.
    if (this.isRoxenDocument?.(uri) || namesRoxenRuntime(source)) {
      this.publishParseAndLintDiagnostics(uri, source, doc);
      return;
    }

    const state = this.getOrCreateState(uri);
    state.inFlight = true;
    state.lastDiagnostics = [];

    state.staleTimer = setTimeout(() => {
      this.publishDiagnostics(uri, [...state.lastDiagnostics, buildStaleDiagnostic()], doc.version);
    }, this.staleMs);
    if (state.staleTimer.unref) state.staleTimer.unref();

    try {
      const result = await this.requestDiagnose(uri, source);
      this.clearStaleTimer(state);

      if (result.timedOut) {
        const { diagnostics: parseDiags } = this.safeParse(source, uri);
        this.publishDiagnostics(uri, [...parseDiags, buildTimeoutDiagnostic()], doc.version);
        return;
      }

      this.cacheSet(uri, { contentHash, diagnostics: result.diagnostics, timestamp: Date.now() });
      this.publishParseAndLintDiagnostics(uri, source, doc, result.diagnostics);
      this.propagateToDependents(uri);

    } catch (err) {
      this.clearStaleTimer(state);
      if (!this.disposed) {
        if (!isPikeUnavailable(err)) {
          logError(this.connection, ErrorCategory.Diagnostics, `diagnosticManager.dispatchDiagnose(${uri})`, err);
        }
      }
      this.publishParseAndLintDiagnostics(uri, source, doc);
    } finally {
      state.inFlight = false;
      state.propagationChain = null;
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
    propagateToDependents(editedUri, {
      index: this.index,
      documents: this.documents,
      debounceMs: this.debounceMs,
      getOrCreateState: this.getOrCreateState.bind(this),
      clearDebounceTimer: this.clearDebounceTimer.bind(this),
      dispatchDiagnose: this.dispatchDiagnose.bind(this),
      invalidatePikeCache: (uri) => { this.pikeCache.delete(uri); },
    }, this.fileStates);
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
        propagationChain: null,
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

    let truncated = diagnostics;
    if (diagnostics.length > this.maxProblems) {
      // Keep room for the notice so the total stays within maxProblems, and
      // tell the user results were capped instead of silently dropping them.
      truncated = diagnostics.slice(0, Math.max(0, this.maxProblems - 1));
      truncated.push(buildTruncationNotice(diagnostics.length, this.maxProblems));
    }
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
      return { tree, diagnostics: getParseDiagnostics(tree), lines };
    } catch (err) {
      logError(this.connection, ErrorCategory.Parse, `safeParse(${uri ?? "unknown"})`, err);
      return { tree: null, diagnostics: [], lines: [] };
    }
  }

  /** Lint diagnostics (unused vars, unreachable code). Returns [] on parse failure. */
  private safeLintDiagnostics(tree: Tree | null, uri: string, version: number, source: string): Diagnostic[] {
    if (tree === null) return [];
    try {
      // Reuse the symbol table the workspace index already built for this exact
      // version instead of rebuilding it — buildSymbolTable is the single most
      // expensive step of the diagnose path (~5x a parse). The index builds a
      // table on every upsert (i.e. every didChange), so by the time the
      // debounced diagnose fires, a matching table is almost always present.
      const table = this.getIndexedSymbolTable(uri, version)
        ?? buildSymbolTable(tree, uri, version, undefined, source);
      return runLintRules(tree, table, source);
    } catch (err) {
      logError(this.connection, ErrorCategory.Diagnostics, `safeLintDiagnostics(${uri})`, err);
      return [];
    }
  }

  /**
   * Return the index's cached symbol table for `uri` only when it matches the
   * requested version and is not stale; otherwise null so the caller rebuilds.
   * Guards against serving a table that predates the content being linted.
   */
  private getIndexedSymbolTable(uri: string, version: number): SymbolTable | null {
    const entry = this.index.getFile(uri);
    if (!entry) return null;
    if (entry.stale) return null;
    if (entry.version !== version) return null;
    return entry.symbolTable;
  }
}
