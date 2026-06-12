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

import type { FileDiagnosticState } from "./diagnosticTypes";

export interface PropagationDependencies {
  readonly index: WorkspaceIndex;
  readonly documents: TextDocuments<TextDocument>;
  readonly debounceMs: number;
  getOrCreateState(uri: string): FileDiagnosticState;
  clearDebounceTimer(state: FileDiagnosticState): void;
  dispatchDiagnose(uri: string): void;
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

  for (const depUri of dependents) {
    // Only propagate to open files
    const depDoc = deps.documents.get(depUri);
    if (!depDoc) continue;

    // Schedule a debounced diagnose for the dependent file
    const depState = deps.getOrCreateState(depUri);
    deps.clearDebounceTimer(depState);

    depState.version = depDoc.version;
    depState.contentHash = computeContentHash(depDoc.getText());

    depState.timer = setTimeout(() => {
      depState.timer = null;
      deps.dispatchDiagnose(depUri);
    }, deps.debounceMs);

    if (depState.timer.unref) depState.timer.unref();
  }
}
