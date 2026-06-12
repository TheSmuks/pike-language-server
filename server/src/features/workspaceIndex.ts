/**
 * WorkspaceIndex: in-memory per-file symbol table index with cross-file links.
 * See architecture decision 0010 for design rationale.
 *
 * This file re-exports the main class from workspaceIndexClass.ts to maintain
 * backward compatibility for existing imports.
 */

export { WorkspaceIndex } from "./workspaceIndexClass";
export type {
  PikeVersionDirective,
  FileEntry,
  WorkspaceIndexOptions,
  OnDemandIndexFn,
} from "./workspaceTypes";
export { ModificationSource, ModificationSource as ModificationSourceValue } from "./workspaceTypes";
export type { ResourceConfiguration, ResourceStateValue, ResourceStateNotification, IndexingMode, MemoryBudget, HibernationStateValue } from "./resourceTypes";
export { DEFAULT_RESOURCE_CONFIG, parseResourceConfig } from "./resourceConfiguration";
export type { RawResourceSettings } from "./resourceConfiguration";
export { ResourceStateTracker, createResourceStateSender } from "./resourceState";
