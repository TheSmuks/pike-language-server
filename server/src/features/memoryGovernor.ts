/**
 * Budget-aware memory governor.
 *
 * Wraps HeapPressureMonitor with the concrete relief action: when RSS crosses
 * the demotion threshold of memory.budgetMb, drop symbol tables for every file
 * not open in the editor (they rehydrate from cache/source on next query),
 * evict half the tree cache, and force a GC when --expose-gc is available so
 * the reclaim shows up in RSS. Hysteresis (recovery < demotion) guards thrash.
 *
 * Extracted from serverLifecycle so that file stays under the module-size gate.
 */

import type { Connection } from "vscode-languageserver/node";
import type { TextDocuments } from "vscode-languageserver/node";
import type { TextDocument } from "vscode-languageserver-textdocument";
import type { WorkspaceIndex } from "./workspaceIndex";
import type { ResourceStateTracker } from "./resourceState";
import { HeapPressureMonitor } from "./resourceState";
import type { MemoryBudget } from "./resourceTypes";
import { getTreeCacheStats, evictTreeCacheOldest } from "../parser";
import { logInfo, logWarn } from "../util/errorLog.js";

export interface MemoryGovernorDeps {
  index: WorkspaceIndex;
  documents: TextDocuments<TextDocument>;
  resourceState: ResourceStateTracker;
  memoryBudget: MemoryBudget;
  connection: Connection;
}

/**
 * Free memory under pressure. Runs on *every* governor check while usage stays
 * above the demotion threshold (level-triggered), so files opened after the
 * initial demotion are re-demoted rather than accumulating unbounded.
 *
 * Cheap when there is nothing left to free: dropping already-demoted files is a
 * no-op, so we only force a GC / log when this pass actually reclaimed
 * something — avoiding GC-churn every tick when RSS is pinned high by
 * non-demotable memory (tree-sitter WASM, the Pike worker).
 */
function relieveMemoryPressure(deps: MemoryGovernorDeps): void {
  const { index, documents, connection } = deps;
  const openUris = new Set(documents.all().map((doc) => doc.uri));
  const demoted = index.demoteNonEssentialEntries(openUris, new Set(), index.size);

  const treeStats = getTreeCacheStats();
  const evicted = treeStats.size > 0 ? evictTreeCacheOldest(Math.ceil(treeStats.size / 2)) : 0;

  if (demoted.length === 0 && evicted === 0) return;

  // global.gc exists only when the process was started with --expose-gc.
  (globalThis as { gc?: () => void }).gc?.();

  logWarn(connection,
    `Memory budget pressure: demoted ${demoted.length} non-open files, evicted ${evicted} tree cache entries`,
  );
}

/**
 * Create a budget-aware governor. Call `.check()` on a timer; each check runs
 * the relief action while usage is above the demotion threshold, marks the
 * server degraded once on entry, and recovers once when usage falls below the
 * recovery threshold.
 */
export function createHeapPressureGovernor(deps: MemoryGovernorDeps): HeapPressureMonitor {
  return new HeapPressureMonitor(
    deps.memoryBudget,
    () => {
      deps.resourceState.transition("degraded", "memory budget pressure — demoting non-open files");
      logWarn(deps.connection, "Entering degraded mode — memory budget pressure");
    },
    () => {
      if (deps.resourceState.getState() === "degraded") {
        deps.resourceState.transition("active", "memory recovered below recovery threshold");
        logInfo(deps.connection, "Memory recovered — exiting degraded mode");
      }
    },
    undefined,
    () => relieveMemoryPressure(deps),
  );
}
