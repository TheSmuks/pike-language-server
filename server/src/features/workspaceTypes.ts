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
