/**
 * Cross-file diagnostic propagation.
 *
 * Extracted from diagnosticManager.ts to keep it under 500 lines.
 *
 * After diagnosing file A, schedules re-diagnosis for files that depend on A.
 * Uses a debounce so dependent files batch together.
 */

import type { Connection, TextDocuments } from "vscode-languageserver/node";
import type { TextDocument } from "vscode-languageserver-textdocument";

import { logWarn } from "../util/errorLog";

import type { WorkspaceIndex } from "./workspaceIndex";
import { computeContentHash } from "./diagnosticUtils";
import { uriToPath } from "../util/uri";

import type { FileDiagnosticState } from "./diagnosticTypes";

export interface PropagationDependencies {
  readonly index: WorkspaceIndex;
  readonly documents: TextDocuments<TextDocument>;
  readonly debounceMs: number;
  getOrCreateState(uri: string): FileDiagnosticState;
  clearDebounceTimer(state: FileDiagnosticState): void;
  dispatchDiagnose(uri: string): void;
  invalidatePikeCache(uri: string): void;
}

/**
 * After diagnosing file A, schedule re-diagnosis for files that depend on A.
 * Uses a short debounce so dependent files batch together.
 */
export function propagateToDependents(
  editedUri: string,
  deps: PropagationDependencies,
  fileStates: Map<string, FileDiagnosticState>,
): void {
  const dependents = deps.index.getDependents(editedUri);
  if (dependents.size === 0) return;

  // Everything already re-diagnosed upstream in this propagation wave.
  const chain = new Set(fileStates.get(editedUri)?.propagationChain ?? []);
  chain.add(editedUri);

  for (const depUri of dependents) {
    if (chain.has(depUri)) continue;

    // Only propagate to open files
    const depDoc = deps.documents.get(depUri);
    if (!depDoc) continue;

    // The dependent's own content is unchanged, so its cached verdict would
    // be republished verbatim — but that verdict was computed against the old
    // dependency. Evict it so the re-diagnose actually recompiles.
    deps.invalidatePikeCache(depUri);

    // Schedule a debounced diagnose for the dependent file
    const depState = deps.getOrCreateState(depUri);
    deps.clearDebounceTimer(depState);

    depState.version = depDoc.version;
    depState.contentHash = computeContentHash(depDoc.getText());
    depState.propagationChain = chain;

    depState.timer = setTimeout(() => {
      depState.timer = null;
      deps.dispatchDiagnose(depUri);
    }, deps.debounceMs);

    if (depState.timer.unref) depState.timer.unref();
  }
}

// ---------------------------------------------------------------------------
// Dependency payloads for the Pike worker
// ---------------------------------------------------------------------------

/**
 * Hard cap on dependency payloads per diagnose, guarding degenerate graphs.
 *
 * Do not raise it without a measurement showing real code exceeding it: every
 * overlay is a cache eviction plus a recompile in the worker, so the cap is
 * what keeps a pathological graph from making one keystroke recompile the
 * world. Truncation is reported (see `reportTruncation`) rather than silent,
 * so a workspace that does exceed it says so instead of quietly serving
 * diagnostics computed against stale modules.
 */
export const DEPENDENCY_OVERLAY_CAP = 64;

export interface DiagnoseDependency {
  /** Absolute filesystem path of the dependency. */
  file: string;
  /** Live buffer content when the dependency is open in the editor. */
  source?: string;
}

export interface DependencyOverlayOptions {
  /** Connection to warn on when the cap truncates the closure. */
  readonly connection?: Connection;
  /** Overridable for tests; production always uses DEPENDENCY_OVERLAY_CAP. */
  readonly cap?: number;
}

/**
 * Files already warned about, mapped to the drop count they were warned with.
 *
 * diagnose runs per keystroke, so an unconditional warn would flood the output
 * channel exactly the way the AutoDoc-per-save warning once did. Warn again
 * only when the number dropped changes, i.e. when the truncation is materially
 * different from the one already reported.
 */
const warnedTruncations = new Map<string, number>();

/** Test seam: forget which truncations have already been reported. */
export function resetDependencyOverlayWarnings(): void {
  warnedTruncations.clear();
}

/**
 * Workspace dependencies of `uri`, leaf-first, for `worker.diagnose()`.
 *
 * The worker is a long-lived Pike process whose master caches every module it
 * resolves, so compiling an importer would otherwise use whatever version of a
 * workspace module it saw first. For each entry the worker evicts its caches,
 * and for open documents registers the live buffer so unsaved edits are
 * visible too. Leaf-first order matters: an overlay compiles at registration
 * time, and its own imports must already be fresh. System modules are
 * excluded — they do not change mid-session, and evicting them would recompile
 * the stdlib on every diagnose.
 *
 * The closure is capped. Truncation is reported through `options.connection`
 * rather than silently swallowed: what gets dropped is a cache eviction the
 * worker then does not perform, so the diagnose can report an error from a
 * stale version of a module — a wrong answer whose only visible trace is this
 * warning.
 */
export function collectDependencyOverlays(
  uri: string,
  index: WorkspaceIndex,
  documents: TextDocuments<TextDocument>,
  options: DependencyOverlayOptions = {},
): DiagnoseDependency[] {
  const root = index.workspaceRoot;
  if (!root) return [];
  const cap = options.cap ?? DEPENDENCY_OVERLAY_CAP;
  const visited = new Set<string>([uri]);
  const ordered: DiagnoseDependency[] = [];
  /** Dependencies the cap kept out, counted once each. */
  const dropped = new Set<string>();
  /**
   * Overlays admitted so far. Counted on the way *down*, not from
   * `ordered.length`: entries are pushed post-order, so a count taken from the
   * output array is still zero all the way down a chain and the cap would not
   * bound depth at all.
   */
  let admitted = 0;

  const visit = (fromUri: string): void => {
    const entry = index.getFile(fromUri);
    if (!entry) return;
    for (const depUri of entry.dependencies) {
      if (visited.has(depUri)) continue;
      visited.add(depUri);
      let depPath: string;
      try {
        depPath = uriToPath(depUri);
      } catch {
        continue; // not a file:// URI
      }
      if (!depPath.startsWith(root)) continue;
      // Headers spliced by cpp are read from disk directly; only files the
      // master resolves as programs/modules go through its caches.
      if (!depPath.endsWith(".pike") && !depPath.endsWith(".pmod")) continue;
      if (admitted >= cap) {
        dropped.add(depUri);
        continue;
      }
      admitted++;
      visit(depUri);
      const depDoc = documents.get(depUri);
      ordered.push(depDoc ? { file: depPath, source: depDoc.getText() } : { file: depPath });
    }
  };

  visit(uri);
  reportTruncation(uri, cap, dropped.size, options.connection);
  return ordered;
}

/** Warn once per distinct truncation that a diagnose ran on a partial closure. */
function reportTruncation(
  uri: string,
  cap: number,
  droppedCount: number,
  connection: Connection | undefined,
): void {
  if (droppedCount === 0) {
    warnedTruncations.delete(uri);
    return;
  }
  if (warnedTruncations.get(uri) === droppedCount) return;
  warnedTruncations.set(uri, droppedCount);
  if (!connection) return;
  logWarn(
    connection,
    `[diagnostics] dependency overlay cap (${cap}) reached for ${uri} — ` +
    `${droppedCount} dependenc${droppedCount === 1 ? "y" : "ies"} left un-refreshed; ` +
    `diagnostics for this file may reflect a stale version of them`,
  );
}
