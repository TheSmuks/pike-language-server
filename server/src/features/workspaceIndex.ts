/**
 * WorkspaceIndex: in-memory per-file symbol table index with cross-file links.
 *
 * Architecture (decision 0010):
 * - Per-file granularity (files are the unit of change)
 * - Reverse dependency graph for invalidation
 * - Module map for name→URI resolution
 * - Lazy symbol table construction
 *
 * The index does NOT own the tree-sitter parser or file I/O.
 * It receives parsed symbol tables and file metadata from the server.
 */

import { ModuleResolver, detectPikePaths, type PikePaths } from "./moduleResolver";
import { buildSymbolTable, type SymbolTable } from "./symbolTable";
import type { Tree } from "web-tree-sitter";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Tracks what caused the last change to a file entry. */
export enum ModificationSource {
  DidOpen = "didOpen",
  DidChange = "didChange",
  DidChangeWatchedFiles = "didChangeWatchedFiles",
  DidSave = "didSave",
  DidClose = "didClose",
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
}

export interface WorkspaceIndexOptions {
  workspaceRoot: string;
  pikePaths?: PikePaths;
}

// ---------------------------------------------------------------------------
// WorkspaceIndex
// ---------------------------------------------------------------------------

export class WorkspaceIndex {
  /** Per-file entries, keyed by URI. */
  private readonly files = new Map<string, FileEntry>();

  /** Reverse dependency graph: URI → Set of URIs that depend on it. */
  private readonly dependents = new Map<string, Set<string>>();

  /** Module path → URI mapping for fast module resolution. */
  private readonly moduleMap = new Map<string, string>();

  /** Module resolver instance. */
  readonly resolver: ModuleResolver;

  /** Workspace root path (file system, not URI). */
  readonly workspaceRoot: string;

  /** Pike installation paths. */
  readonly pikePaths: PikePaths;

  constructor(options: WorkspaceIndexOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.pikePaths = options.pikePaths ?? detectPikePaths(this.workspaceRoot);
    this.resolver = new ModuleResolver({
      workspaceRoot: `file://${this.workspaceRoot}`,
      pikePaths: this.pikePaths,
      pikeVersion: null, // Set per-file during resolution
    });
  }

  // ---------------------------------------------------------------------------
  // Index operations
  // ---------------------------------------------------------------------------

  /**
   * Add or update a file in the index.
   * Rebuilds the symbol table and updates dependency links.
   */
  upsertFile(
    uri: string,
    version: number,
    tree: Tree,
    content: string,
    modSource: ModificationSource,
  ): FileEntry {
    const existing = this.files.get(uri);

    // Remove old dependency links
    if (existing) {
      this.removeDependencies(existing);
    }

    // Build symbol table
    const symbolTable = buildSymbolTable(tree, uri, version);

    // Parse #pike version directive
    const pikeVersion = this.parsePikeVersion(tree);

    // Compute content hash
    const contentHash = this.hashContent(content);

    // Extract forward dependencies from symbol table
    const dependencies = this.extractDependencies(symbolTable, uri);

    const entry: FileEntry = {
      uri,
      version,
      symbolTable,
      pikeVersion,
      dependencies,
      lastModSource: modSource,
      contentHash,
    };

    this.files.set(uri, entry);

    // Register reverse dependencies
    for (const depUri of dependencies) {
      let depSet = this.dependents.get(depUri);
      if (!depSet) {
        depSet = new Set();
        this.dependents.set(depUri, depSet);
      }
      depSet.add(uri);
    }

    return entry;
  }

  /**
   * Remove a file from the index.
   * Invalidates dependents.
   */
  removeFile(uri: string): void {
    const entry = this.files.get(uri);
    if (!entry) return;

    this.removeDependencies(entry);
    this.files.delete(uri);
    this.dependents.delete(uri);
  }

  /**
   * Get a file entry by URI.
   */
  getFile(uri: string): FileEntry | undefined {
    return this.files.get(uri);
  }

  /**
   * Get the symbol table for a file, or null if not indexed.
   */
  getSymbolTable(uri: string): SymbolTable | null {
    return this.files.get(uri)?.symbolTable ?? null;
  }

  /**
   * Get all URIs that depend on the given file.
   */
  getDependents(uri: string): Set<string> {
    return this.dependents.get(uri) ?? new Set();
  }

  /**
   * Get all indexed file URIs.
   */
  getAllUris(): string[] {
    return [...this.files.keys()];
  }

  /**
   * Get the number of indexed files.
   */
  get size(): number {
    return this.files.size;
  }

  /**
   * Invalidate a file's symbol table (mark for rebuild on next access).
   */
  invalidate(uri: string): void {
    const entry = this.files.get(uri);
    if (entry) {
      entry.symbolTable = null;
    }
  }

  /**
   * Invalidate a file and all its dependents.
   */
  invalidateWithDependents(uri: string): string[] {
    const invalidated: string[] = [uri];
    this.invalidate(uri);

    const deps = this.getDependents(uri);
    for (const depUri of deps) {
      this.invalidate(depUri);
      invalidated.push(depUri);
    }

    return invalidated;
  }

  /**
   * Clear the entire index.
   */
  clear(): void {
    this.files.clear();
    this.dependents.clear();
    this.moduleMap.clear();
    this.resolver.clearCache();
  }

  // ---------------------------------------------------------------------------
  // Module resolution helpers
  // ---------------------------------------------------------------------------

  /**
   * Resolve a module path from the perspective of a given file.
   */
  resolveModule(modulePath: string, fromUri: string): string | null {
    const entry = this.files.get(fromUri);
    const fromPath = this.uriToPath(fromUri);

    // Create a resolver scoped to this file's #pike version
    const resolver = (entry?.pikeVersion && entry.pikeVersion !== this.resolver["pikeVersion"])
      ? new ModuleResolver({
          workspaceRoot: `file://${this.workspaceRoot}`,
          pikePaths: this.pikePaths,
          pikeVersion: entry.pikeVersion,
        })
      : this.resolver;

    const result = resolver.resolveModule(modulePath, fromPath);
    return result?.uri ?? null;
  }

  /**
   * Resolve an inherit path from the perspective of a given file.
   */
  resolveInherit(pathText: string, isStringLiteral: boolean, fromUri: string): string | null {
    const fromPath = this.uriToPath(fromUri);
    const result = this.resolver.resolveInherit(pathText, isStringLiteral, fromPath);
    return result?.uri ?? null;
  }

  /**
   * Resolve an import path from the perspective of a given file.
   */
  resolveImport(importPath: string, fromUri: string): string | null {
    const fromPath = this.uriToPath(fromUri);
    const result = this.resolver.resolveImport(importPath, fromPath);
    return result?.uri ?? null;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private removeDependencies(entry: FileEntry): void {
    for (const depUri of entry.dependencies) {
      const depSet = this.dependents.get(depUri);
      if (depSet) {
        depSet.delete(entry.uri);
        if (depSet.size === 0) {
          this.dependents.delete(depUri);
        }
      }
    }
  }

  /**
   * Extract forward dependencies (inherit/import targets) from a symbol table.
   */
  private extractDependencies(table: SymbolTable, currentUri: string): Set<string> {
    const deps = new Set<string>();

    for (const decl of table.declarations) {
      if (decl.kind === "inherit") {
        const isStringLit = decl.name.startsWith('"') && decl.name.endsWith('"');
        const targetUri = this.resolveInherit(decl.name, isStringLit, currentUri);
        if (targetUri && targetUri !== currentUri) {
          deps.add(targetUri);
        }
      }
    }

    // TODO: Extract import dependencies when import resolution is implemented

    return deps;
  }

  /**
   * Parse #pike version directive from the tree.
   * Format: #pike <major>[.<minor>]
   */
  private parsePikeVersion(tree: Tree): PikeVersionDirective | null {
    const text = tree.rootNode.text;
    const match = text.match(/#pike\s+(\d+)(?:\.(\d+))?/);
    if (!match) return null;

    return {
      major: parseInt(match[1], 10),
      minor: match[2] ? parseInt(match[2], 10) : 0,
    };
  }

  /**
   * Simple content hash for cache validity.
   */
  private hashContent(content: string): string {
    // DJB2 hash — fast, good distribution for cache invalidation
    let hash = 5381;
    for (let i = 0; i < content.length; i++) {
      hash = ((hash << 5) + hash + content.charCodeAt(i)) & 0xffffffff;
    }
    return hash.toString(16);
  }

  private uriToPath(uri: string): string {
    if (uri.startsWith("file://")) {
      return uri.slice(7);
    }
    return uri;
  }
}
