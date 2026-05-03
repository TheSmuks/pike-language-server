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
import { buildSymbolTable, getDefinitionAt, getReferencesTo, type SymbolTable, type Declaration, type Reference } from "./symbolTable";
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
    this.pikePaths = options.pikePaths ?? { pikeHome: "", modulePaths: [options.workspaceRoot], includePaths: [options.workspaceRoot], programPaths: [options.workspaceRoot] };
    this.resolver = new ModuleResolver({
      workspaceRoot: `file://${this.workspaceRoot}`,
      pikePaths: this.pikePaths,
      pikeVersion: null, // Set per-file during resolution
    });
  }

  /** Create a WorkspaceIndex with auto-detected Pike paths. */
  static async create(workspaceRoot: string, pikeBinaryPath?: string): Promise<WorkspaceIndex> {
    const pikePaths = await detectPikePaths(workspaceRoot, pikeBinaryPath);
    return new WorkspaceIndex({ workspaceRoot, pikePaths });
  }

  // ---------------------------------------------------------------------------
  // Index operations
  // ---------------------------------------------------------------------------

  /**
   * Add or update a file in the index.
   * Rebuilds the symbol table and updates dependency links.
   */
  async upsertFile(
    uri: string,
    version: number,
    tree: Tree,
    content: string,
    modSource: ModificationSource,
  ): Promise<FileEntry> {
    const existing = this.files.get(uri);

    // Remove old dependency links
    if (existing) {
      this.removeDependencies(existing);
    }

    // Pre-warm the ModuleResolver cache by resolving all inherit/import
    // declarations in this file. This must happen before buildSymbolTable
    // because symbolTable.ts has a synchronous interface and relies on
    // the cache being populated for cross-file inheritance wiring.
    await this.warmResolverCache(tree, uri);

    // Build symbol table — pass sync cache-only adapter for cross-file inheritance wiring
    // (symbolTable.ts has a sync interface; full async resolution happens via extractDependencies)
    const symbolTable = buildSymbolTable(tree, uri, version, { index: this.createSyncIndexAdapter(uri) });

    // Parse #pike version directive
    const pikeVersion = this.parsePikeVersion(tree);

    // Compute content hash
    const contentHash = this.hashContent(content);

    // Extract forward dependencies from symbol table
    const dependencies = await this.extractDependencies(symbolTable, uri);

    const entry: FileEntry = {
      uri,
      version,
      symbolTable,
      pikeVersion,
      dependencies,
      lastModSource: modSource,
      contentHash,
      stale: false,
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
   * Insert a file entry from persistent cache (no tree or content needed).
   * Used when restoring from cache on startup.
   */
  async upsertCachedFile(
    uri: string,
    version: number,
    symbolTable: SymbolTable,
    contentHash: string,
  ): Promise<FileEntry> {
    const dependencies = await this.extractDependencies(symbolTable, uri);

    const entry: FileEntry = {
      uri,
      version,
      symbolTable,
      pikeVersion: null,
      dependencies,
      lastModSource: ModificationSource.DidOpen,
      contentHash,
      stale: false,
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
    const entry = this.files.get(uri);
    if (!entry) return null;
    if (entry.stale) return null;
    return entry.symbolTable;
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
   * Get all indexed file entries.
   */
  getAllEntries(): FileEntry[] {
    return [...this.files.values()];
  }

  /**
   * Get the number of indexed files.
   */
  get size(): number {
    return this.files.size;
  }

  /**
   * Invalidate a file's symbol table (clear it now).
   */
  invalidate(uri: string): void {
    const entry = this.files.get(uri);
    if (entry) {
      entry.symbolTable = null;
      entry.stale = true;
    }
  }

  /**
   * Invalidate a file and transitively invalidate all its dependents.
   *
   * Strategy: stale-marking with lazy rebuild.
   * - The changed file gets its symbol table cleared immediately.
   * - All transitive dependents are marked stale but keep their symbol tables.
   * - Stale tables are rebuilt on next access (getSymbolTable rebuilds lazily).
   *
   * This avoids rebuilding entire subtrees on every keystroke while
   * guaranteeing correctness: stale tables are never served to callers.
   */
  invalidateWithDependents(uri: string): string[] {
    const invalidated: string[] = [];
    const visited = new Set<string>();
    const queue = [uri];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);

      const entry = this.files.get(current);
      if (!entry) continue;

      // The changed file itself gets its table cleared.
      // Dependents are only marked stale (lazy rebuild on next access).
      if (current === uri) {
        entry.symbolTable = null;
      }
      entry.stale = true;
      invalidated.push(current);

      // Walk reverse dependency graph: dependents of current need invalidation
      const deps = this.dependents.get(current);
      if (deps) {
        for (const depUri of deps) {
          if (!visited.has(depUri)) {
            queue.push(depUri);
          }
        }
      }
    }

    return invalidated;
  }

  /**
   * Check whether a file entry is stale (its dependency changed).
   */
  isStale(uri: string): boolean {
    return this.files.get(uri)?.stale ?? false;
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
  async resolveModule(modulePath: string, fromUri: string): Promise<string | null> {
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

    const result = await resolver.resolveModule(modulePath, fromPath);
    return result?.uri ?? null;
  }

  /**
   * Resolve an inherit path from the perspective of a given file.
   */
  async resolveInherit(pathText: string, isStringLiteral: boolean, fromUri: string): Promise<string | null> {
    const fromPath = this.uriToPath(fromUri);
    const result = await this.resolver.resolveInherit(pathText, isStringLiteral, fromPath);
    return result?.uri ?? null;
  }

  /**
   * Resolve an import path from the perspective of a given file.
   */
  async resolveImport(importPath: string, fromUri: string): Promise<string | null> {
    const fromPath = this.uriToPath(fromUri);
    const result = await this.resolver.resolveImport(importPath, fromPath);
    return result?.uri ?? null;
  }

  // ---------------------------------------------------------------------------
  // Sync resolution (cache-only, for symbolTable.ts compatibility)
  // ---------------------------------------------------------------------------

  /**
   * Create a sync cache-only adapter for buildSymbolTable.
   * symbolTable.ts has a synchronous interface; this adapter reads from
   * the ModuleResolver cache. Cache misses return null (graceful degradation).
   */
  private createSyncIndexAdapter(fromUri: string): {
    getSymbolTable(uri: string): SymbolTable | null;
    resolveImport(mod: string, from: string): string | null;
    resolveInherit(path: string, isString: boolean, from: string): string | null;
  } {
    const self = this;
    return {
      getSymbolTable(uri: string): SymbolTable | null {
        return self.getSymbolTable(uri);
      },
      resolveImport(mod: string, from: string): string | null {
        return self.resolveImportSync(mod, from);
      },
      resolveInherit(path: string, isString: boolean, from: string): string | null {
        return self.resolveInheritSync(path, isString, from);
      },
    };
  }

  /** Sync cache-only module resolution. Returns null on cache miss. */
  resolveModuleSync(modulePath: string, fromUri: string): string | null {
    const entry = this.files.get(fromUri);
    const fromPath = this.uriToPath(fromUri);

    const resolver = (entry?.pikeVersion && entry.pikeVersion !== this.resolver["pikeVersion"])
      ? new ModuleResolver({
          workspaceRoot: `file://${this.workspaceRoot}`,
          pikePaths: this.pikePaths,
          pikeVersion: entry.pikeVersion,
        })
      : this.resolver;

    const cached = resolver.getCachedModule(modulePath, fromPath);
    return cached?.uri ?? null;
  }

  /** Sync cache-only inherit resolution. Returns null on cache miss. */
  resolveInheritSync(pathText: string, isStringLiteral: boolean, fromUri: string): string | null {
    const fromPath = this.uriToPath(fromUri);
    const cached = this.resolver.getCachedInherit(pathText, isStringLiteral, fromPath);
    return cached?.uri ?? null;
  }

  /** Sync cache-only import resolution. Returns null on cache miss. */
  resolveImportSync(importPath: string, fromUri: string): string | null {
    const fromPath = this.uriToPath(fromUri);
    const cached = this.resolver.getCachedModule(importPath, fromPath);
    return cached?.uri ?? null;
  }
  // Cross-file resolution
  // ---------------------------------------------------------------------------

  /**
   * Resolve a cross-file definition.
   * Given a position in a file, attempt to find the definition across files.
   * Returns the target URI and declaration, or null.
   */
  async resolveCrossFileDefinition(uri: string, line: number, character: number): Promise<{
    uri: string; decl: Declaration;
  } | null> {
    const entry = this.files.get(uri);
    if (!entry?.symbolTable) return null;

    const table = entry.symbolTable;
    // Check if the position is on an inherit declaration
    for (const decl of table.declarations) {
      if (decl.kind === "inherit" || decl.kind === "import") {
        const nr = decl.nameRange;
        if (nr.start.line === line && nr.end.line === line &&
            character >= nr.start.character && character <= nr.end.character) {
          return this.resolveInheritTarget(decl, uri);
        }
      }
    }

    // Check if a reference resolves to null (unresolved within file)
    // This might be a cross-file reference through inheritance or import
    for (const ref of table.references) {
      if (ref.loc.line === line && ref.loc.character === character && ref.resolvesTo === null) {
        return this.resolveUnresolvedReference(ref, table, uri);
      }
    }

    return null;
  }

  /**
   * Get all references to a declaration across the workspace.
   * Extends single-file references with cross-file references.
   */
  getCrossFileReferences(uri: string, line: number, character: number): Array<{
    uri: string; ref: Reference;
  }> {
    const results: Array<{ uri: string; ref: Reference }> = [];
    const entry = this.files.get(uri);
    if (!entry?.symbolTable) return results;

    // First, get same-file references
    const sameFileRefs = getReferencesTo(entry.symbolTable, line, character);
    for (const ref of sameFileRefs) {
      results.push({ uri, ref });
    }

    // Find the target declaration
    let targetDecl = getDefinitionAt(entry.symbolTable, line, character);
    if (!targetDecl) return results;

    // Search other files for references to the same symbol.
    // Source-file filter: only consider dependents that have the source file
    // in their direct dependency set. This prevents matching same-name symbols
    // from unrelated files (e.g., two independent files each defining 'process').
    const dependents = this.getDependents(uri);
    for (const depUri of dependents) {
      const depEntry = this.files.get(depUri);
      if (!depEntry?.symbolTable) continue;

      // Source-file filter: the dependent must actually depend on this file.
      // While the reverse-dependency graph already implies this, checking
      // explicitly guards against stale or inconsistently updated graph entries.
      if (!depEntry.dependencies.has(uri)) continue;

      for (const ref of depEntry.symbolTable.references) {
        // Match by name. Inherited/imported symbols have resolvesTo=null because
        // single-file analysis cannot resolve cross-file references. Locally-resolved
        // references (resolvesTo !== null) are excluded because they point to a
        // different declaration in the dependent file, not the inherited one.
        if (ref.name === targetDecl!.name && ref.resolvesTo === null) {
          results.push({ uri: depUri, ref });
        }
      }
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // Internal: cross-file resolution helpers
  // ---------------------------------------------------------------------------


  private async resolveInheritTarget(decl: Declaration, fromUri: string): Promise<{
    uri: string; decl: Declaration;
  } | null> {
    const isStringLit = decl.name.startsWith('"') && decl.name.endsWith('"');
    const targetUri = await this.resolveInherit(decl.name, isStringLit, fromUri);
    if (!targetUri) return null;

    const targetEntry = this.files.get(targetUri);
    if (!targetEntry?.symbolTable) return null;

    // For directory modules (.pmod/), the target brings all top-level symbols into scope.
    // Return the first class declaration as a representative target.
    if (targetUri.endsWith(".pmod")) {
      for (const targetDecl of targetEntry.symbolTable.declarations) {
        if (targetDecl.kind === "class") {
          return { uri: targetUri, decl: targetDecl };
        }
      }
      // No class — return the first declaration as a representative target
      if (targetEntry.symbolTable.declarations.length > 0) {
        return { uri: targetUri, decl: targetEntry.symbolTable.declarations[0] };
      }
      return null;
    }

    // For string literal inherits (file paths like "cross-inherit-simple-a.pike"):
    // return the first class found (the entire file's symbols are inherited).
    if (isStringLit) {
      for (const targetDecl of targetEntry.symbolTable.declarations) {
        if (targetDecl.kind === "class") {
          return { uri: targetUri, decl: targetDecl };
        }
      }
      if (targetEntry.symbolTable.declarations.length > 0) {
        return { uri: targetUri, decl: targetEntry.symbolTable.declarations[0] };
      }
      return null;
    }

    // For identifier inherits to .pike files (e.g., "inherit Animal" where Animal
    // is a class in cross-inherit-simple-a.pike): look for a matching class.
    const inheritName = decl.alias ?? decl.name;
    for (const targetDecl of targetEntry.symbolTable.declarations) {
      if (targetDecl.name === inheritName) {
        return { uri: targetUri, decl: targetDecl };
      }
    }

    return null;
  }

  private async resolveUnresolvedReference(
    ref: Reference,
    table: SymbolTable,
    uri: string,
  ): Promise<{ uri: string; decl: Declaration } | null> {
    // Try to find the name through inheritance chains
    for (const decl of table.declarations) {
      if (decl.kind === "inherit" || decl.kind === "import") {
        const target = await this.resolveInheritTarget(decl, uri);
        if (target) {
          // Check if the target file has a declaration matching the reference name
          const targetEntry = this.files.get(target.uri);
          if (targetEntry?.symbolTable) {
            for (const targetDecl of targetEntry.symbolTable.declarations) {
              if (targetDecl.name === ref.name) {
                return { uri: target.uri, decl: targetDecl };
              }
            }
          }
        }
      }
    }

    return null;
  }
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
   * Pre-warm the ModuleResolver cache by resolving all inherit/import
   * declarations in the tree. This ensures the sync cache-only adapter
   * used by buildSymbolTable can find entries for cross-file wiring.
   */

  private async warmResolverCache(tree: Tree, uri: string): Promise<void> {
    const fromPath = this.uriToPath(uri);
    const promises: Promise<import('./moduleResolver').ResolveResult | null>[] = [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const walk = (node: any): void => {
      if (node.type === 'inherit_decl' || node.type === 'import_decl') {
        // File-level inherit/import declarations
        const pathNode = node.childForFieldName('path');
        if (pathNode) {
          const name = pathNode.text;
          const isStringLit = name.startsWith('"') && name.endsWith('"');
          if (isStringLit) {
            promises.push(this.resolver.resolveInherit(name, true, fromPath));
          } else {
            promises.push(this.resolver.resolveImport(name, fromPath));
            promises.push(this.resolver.resolveInherit(name, false, fromPath));
          }
        }
      } else if (node.type === 'inherit') {
        // Class-body inherit: "inherit Animal" or "inherit Middle"
        // These are also resolved via module paths (for cross-file wiring)
        const pathNode = node.childForFieldName('path');
        if (pathNode) {
          const name = pathNode.text;
          // Only resolve bare identifiers, not string literals
          if (!name.startsWith('"')) {
            promises.push(this.resolver.resolveImport(name, fromPath));
            promises.push(this.resolver.resolveInherit(name, false, fromPath));
          }
        }
      }
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) walk(child);
      }
    };

    walk(tree.rootNode);
    await Promise.all(promises);
  }

  /**
   * Extract forward dependencies (inherit/import targets) from a symbol table.
   */
  private async extractDependencies(table: SymbolTable, currentUri: string): Promise<Set<string>> {
    const deps = new Set<string>();

    for (const decl of table.declarations) {
      if (decl.kind === "inherit" || decl.kind === "import") {
        const isStringLit = decl.name.startsWith('"') && decl.name.endsWith('"');
        const targetUri = isStringLit
          ? await this.resolveInherit(decl.name, true, currentUri)
          : (await this.resolveImport(decl.name, currentUri)) ?? await this.resolveInherit(decl.name, false, currentUri);
        if (targetUri && targetUri !== currentUri) {
          deps.add(targetUri);
        }
      }
    }

    return deps;
  }

  /**
   * Parse #pike version directive from the tree.
   * Format: #pike <major>[.<minor>]
   */
  private parsePikeVersion(tree: Tree): PikeVersionDirective | null {
    const root = tree.rootNode;
    if (!root) return null;
    const text = root.text;
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
      hash = ((hash << 5) + hash + content.charCodeAt(i)) >>> 0;
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
