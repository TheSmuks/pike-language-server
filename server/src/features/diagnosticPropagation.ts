/**
 * Cross-file diagnostic propagation.
 *
 * Extracted from diagnosticManager.ts to keep it under 500 lines.
 *
 * After diagnosing file A, schedules re-diagnosis for files that depend on A.
 * Uses a debounce so dependent files batch together.
 */

import type { TextDocuments } from "vscode-languageserver/node";
import type { TextDocument } from "vscode-languageserver-textdocument";

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

/** Hard cap on dependency payloads per diagnose, guarding degenerate graphs. */
const DEPENDENCY_OVERLAY_CAP = 64;

export interface DiagnoseDependency {
  /** Absolute filesystem path of the dependency. */
  file: string;
  /** Live buffer content when the dependency is open in the editor. */
  source?: string;
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
 */
export function collectDependencyOverlays(
  uri: string,
  index: WorkspaceIndex,
  documents: TextDocuments<TextDocument>,
): DiagnoseDependency[] {
  const root = index.workspaceRoot;
  if (!root) return [];
  const visited = new Set<string>([uri]);
  const ordered: DiagnoseDependency[] = [];

  const visit = (fromUri: string): void => {
    const entry = index.getFile(fromUri);
    if (!entry) return;
    for (const depUri of entry.dependencies) {
      if (visited.has(depUri) || ordered.length >= DEPENDENCY_OVERLAY_CAP) continue;
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
      visit(depUri);
      const depDoc = documents.get(depUri);
      ordered.push(depDoc ? { file: depPath, source: depDoc.getText() } : { file: depPath });
    }
  };

  visit(uri);
  return ordered;
}
