/**
 * Shared types for the workspace index system.
 *
 * Re-exported from workspaceIndex.ts so external imports continue to work.
 */

import type { SymbolTable } from "./symbolTable";
import type { PikePaths } from "./moduleResolver";

// ---------------------------------------------------------------------------
// Enums & interfaces
// ---------------------------------------------------------------------------

/** Tracks what caused the last change to a file entry. */
export enum ModificationSource {
  DidOpen = "didOpen",
  DidChange = "didChange",
  DidChangeWatchedFiles = "didChangeWatchedFiles",
  DidSave = "didSave",
  DidClose = "didClose",
  BackgroundIndex = "backgroundIndex",
  DidChangeConfiguration = "didChangeConfiguration",
}

/** #pike version directive parsed from a file. */
export interface PikeVersionDirective {
  major: number;
  minor: number;
}

// ---------------------------------------------------------------------------
// Index entry lifecycle (resource resilience)
// ---------------------------------------------------------------------------

/**
 * Lifecycle state of an index entry.
 *
 * - `full`: symbol table present; the entry is query-ready.
 * - `loading`: an async resolution (symbol table or dependencies) is in flight.
 * - `stub`: only identity + dependency edges retained (e.g. hibernation save).
 * - `demoted`: symbol table dropped under memory pressure; dependency edges kept.
 *
 * Open documents and their active dependency closure stay `full` unless
 * explicitly reloading. Demoted/stub entries retain enough data to rehydrate
 * from cache or source. See data-model.md (IndexEntry state transitions).
 */
export type IndexEntryLifecycle = "full" | "loading" | "stub" | "demoted";

// ---------------------------------------------------------------------------
// Dependency map (resource resilience)
// ---------------------------------------------------------------------------

/**
 * Lightweight forward/reverse dependency graph.
 *
 * Separate from full symbol-table retention so it survives entry demotion and
 * hibernation. Drives dependency-closure indexing, changed-file invalidation,
 * global candidate discovery, and cross-file diagnostics. See data-model.md
 * (DependencyMap).
 */
export interface DependencyMap {
  /** Forward edges: source URI to its dependency URI set. */
  readonly forwardEdges: Map<string, Set<string>>;
  /** Reverse edges: dependency URI to its dependent URI set. */
  readonly reverseEdges: Map<string, Set<string>>;
  /** Monotonic mutation counter, bumped on every edge change. */
  readonly generation: number;
}

export interface FileEntry {
  uri: string;
  version: number;
  symbolTable: SymbolTable | null;
  /** #pike version directive, if present. */
  pikeVersion: PikeVersionDirective | null;
  /** Files this file depends on (inherit/import targets). */
  dependencies: Set<string>;
  /** Source of last modification. */
  lastModSource: ModificationSource;
  /** Content hash for fast cache validity check. */
  contentHash: string;
  /** True when a dependency changed and this entry's symbol table may be stale. */
  stale: boolean;
  /**
   * Whether dependency resolution has been attempted.
   * Distinguishes "not yet resolved" (false) from "resolved, found nothing" (true + empty deps).
   * Set true by upsertFile (full resolution) and ensureDependenciesResolved.
   */
  depsResolved?: boolean;
  /**
   * Lifecycle state for memory management. Defaults to "full" for entries
   * created by upsert paths. See IndexEntryLifecycle.
   */
  lifecycle?: IndexEntryLifecycle;
  /**
   * Monotonic timestamp of last access, for demotion ordering under memory
   * pressure. Set/updated on read paths by the memory manager (US3).
   */
  lastAccessMonotonicMs?: number;
}

export interface WorkspaceIndexOptions {
  workspaceRoot: string;
  pikePaths?: PikePaths;
}

/**
 * Callback type for on-demand file indexing.
 * The server provides this so WorkspaceIndex stays free of parser/file I/O imports.
 */
export type OnDemandIndexFn = (uri: string) => Promise<FileEntry | null>;
