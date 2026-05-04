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
import { PikeWorker, type PikeDiagnostic } from "./pikeWorker";
import { getParseDiagnostics } from "./diagnostics";
import { parse, type Tree } from "../parser";
import type { WorkspaceIndex } from "./workspaceIndex";

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
   * Parse diagnostics are published immediately (they're free).
   */
  onDidChange(uri: string): void {
    if (this.disposed) return;
    const doc = this.documents.get(uri);
    if (!doc) return;

    // Always publish parse diagnostics immediately (tree-sitter, no worker)
    try {
      const tree = parse(doc.getText(), uri);
      if (!this.disposed) {
        this.connection.sendDiagnostics({
          uri,
          diagnostics: getParseDiagnostics(tree),
        });
      }
    } catch (err) {
      // Parse failure — log but don't crash the manager
      try {
        this.connection.console.error(`parse failed for ${uri}: ${(err as Error).message}`);
      } catch {
        // Connection closed during teardown
      }
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

    // Check cache
    const cached = this.pikeCache.get(uri);
    if (cached && cached.contentHash === contentHash) {
      const parseDiags = this.safeParseDiagnostics(source);
      const tree = parse(source);
      const lspDiagnostics = mergeDiagnostics(parseDiags, cached.diagnostics, tree);
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
      const tree = parse(source);
      const lspDiagnostics = mergeDiagnostics(parseDiags, result.diagnostics, tree);
      this.publishDiagnostics(uri, lspDiagnostics);

      // Cross-file propagation: schedule re-diagnosis of dependents
      this.propagateToDependents(uri);
    } catch (err) {
      this.clearStaleTimer(state);
      if (!this.disposed) {
        try {
          this.connection.console.error(
            `Pike diagnose failed for ${uri}: ${(err as Error).message},`,
          );
        } catch {
          // Connection may be closed during teardown
        }
      }
      // Keep only parse diagnostics
      const parseDiags = this.safeParseDiagnostics(source);
      if (!this.disposed) {
        this.publishDiagnostics(uri, parseDiags);
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
  private publishDiagnostics(uri: string, diagnostics: Diagnostic[]): void {
    if (this.disposed) return;
    const truncated = diagnostics.length > this.maxProblems
      ? diagnostics.slice(0, this.maxProblems)
      : diagnostics;
    const state = this.fileStates.get(uri);
    if (state) {
      state.lastDiagnostics = truncated;
    }
    try {
      this.connection.sendDiagnostics({ uri, diagnostics: truncated });
    } catch {
      // Connection may be closed during teardown — not an error
    }
  }

  /** Parse diagnostics with error suppression. */
  private safeParseDiagnostics(source: string): Diagnostic[] {
    try {
      return getParseDiagnostics(parse(source));
    } catch {
      // Tree-sitter parse threw (OOM or invalid input) — return no diagnostics
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// Standalone helpers (pure functions, easy to test)
// ---------------------------------------------------------------------------
/**
 * Merge parse diagnostics with Pike compilation diagnostics.
 *
 * Pike diagnostics report only line numbers (no column data). When a parsed
 * tree is available, lineToColumn uses it to find the first meaningful
 * token on the diagnostic line, providing column-level precision.
 *
 * Deduplication: Parse diagnostics on lines that have Pike diagnostics are
 * suppressed. Pike diagnostics are more semantically accurate.
 *
 * Both diagnostic types receive codes: parse errors get P1xxx, Pike errors
 * get P2xxxx (or the Pike compiler's own code if available).
 */
export function mergeDiagnostics(
  parseDiags: Diagnostic[],
  pikeDiags: PikeDiagnostic[],
  tree?: Tree,
): Diagnostic[] {
  // Build set of line numbers that have Pike diagnostics.
  // Parse diagnostics on these lines will be suppressed (Pike is more precise).
  const pikeLines = new Set<number>();
  for (const pd of pikeDiags) {
    pikeLines.add(pd.line - 1); // Pike 1-based → LSP 0-based
  }

  // Filter parse diagnostics: suppress if the same line has a Pike diagnostic.
  const suppressedParseDiags = parseDiags.filter((diag) => {
    return !pikeLines.has(diag.range.start.line);
  });

  const result: Diagnostic[] = [...suppressedParseDiags];

  for (const pd of pikeDiags) {
    const line = Math.max(0, pd.line - 1); // Pike: 1-based → LSP: 0-based
    const character = tree ? lineToColumn(tree, pd.line) : 0;

    let message = pd.message;
    if (pd.expected_type) message += `\nExpected: ${pd.expected_type}`;
    if (pd.actual_type) message += `\nGot: ${pd.actual_type}`;

    result.push({
      range: {
        start: { line, character },
        end: { line, character },
      },
      severity: pd.severity === "error"
        ? DiagnosticSeverity.Error
        : DiagnosticSeverity.Warning,
      source: "pike",
      message,
      code: pd.code ?? `P2${String(pd.line).padStart(4, '0')}`,
    });
  }

  return result;
}

/** Compute FNV-1a 64-bit content hash (fast, non-cryptographic). */
export function computeContentHash(source: string): string {
  let hash = 14695981039346656037n;
  for (let i = 0; i < source.length; i++) {
    hash ^= BigInt(source.charCodeAt(i));
    hash = (hash * 1099511628211n) & 0xffffffffffffffffn;
  }
  return hash.toString(36);
}

/**
 * Find the column of the first non-whitespace meaningful token on a given line
 * using tree-sitter. Returns 0 if the line is empty or cannot be determined.
 *
 * Used to provide column-level precision for Pike diagnostics, which only
 * report line numbers (Pike compile_error provides no column data).
 */
export function lineToColumn(tree: Tree, line: number): number {
  // line is 0-based in tree-sitter; Pike diagnostics are 1-based
  const lspLine = Math.max(0, line);
  const node = tree.rootNode.descendantForPosition({ row: lspLine, column: 0 });
  if (!node) return 0;

  // Walk through root children to find the first named node starting on this line.
  // We want the first meaningful token, skipping whitespace, comments, and ERROR nodes.
  for (const child of tree.rootNode.children) {
    const startRow = child.startPosition.row;
    if (startRow !== lspLine) continue;
    if (child.type === "comment" || child.type === "preprocessor") continue;
    if (!child.isError && !child.isMissing) {
      return child.startPosition.column;
    }
  }

  // Fallback: scan the text for first non-whitespace character
  const lines = tree.rootNode.text.split("\n");
  const lineText = lines[lspLine];
  if (lineText !== undefined) {
    const match = lineText.match(/\S/);
    if (match) return match.index ?? 0;
  }

  return 0;
}
