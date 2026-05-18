/**
 * WorkspaceIndex: in-memory per-file symbol table index with cross-file links.
 * See architecture decision 0010 for design rationale.
 */

import { ModuleResolver, detectPikePaths, type PikePaths, type PikePathOverrides } from "./moduleResolver";
import { buildSymbolTable, type SymbolTable, type Declaration, type Reference } from "./symbolTable";
import type { Tree } from "web-tree-sitter";
import { uriToPath as uriToPathUtil, pathToUri } from "../util/uri";
import {
  resolveCrossFileDefinition as resolveCrossFileDefinitionFn,
  getCrossFileReferences as getCrossFileReferencesFn,
  type ResolutionContext,
} from "./workspaceResolution";
import { warmResolverCache, extractDependencies, type DependencyContext } from "./workspaceDependencies";

// Re-export types so all existing imports from this module continue to work.
// Interfaces/types use `export type` — runtime re-export of type-only symbols
// fails in bun's ESM loader.
export type {
  PikeVersionDirective,
  FileEntry,
  WorkspaceIndexOptions,
  OnDemandIndexFn,
} from "./workspaceTypes";
// Enums are value-level, so they use plain `export`.
export { ModificationSource, ModificationSource as ModificationSourceValue } from "./workspaceTypes";

import type { FileEntry, WorkspaceIndexOptions, OnDemandIndexFn, PikeVersionDirective } from "./workspaceTypes";
import { ModificationSource } from "./workspaceTypes";

// ---------------------------------------------------------------------------
// WorkspaceIndex
// ---------------------------------------------------------------------------

export class WorkspaceIndex {
  private readonly files = new Map<string, FileEntry>();
  private readonly dependents = new Map<string, Set<string>>();
  private readonly moduleMap = new Map<string, string>();
  private generation = 0;
  /** Cache of version-scoped resolvers to avoid creating a new ModuleResolver per call. */
  private readonly versionResolvers = new Map<string, ModuleResolver>();

  readonly resolver: ModuleResolver;
  readonly workspaceRoot: string;
  readonly pikePaths: PikePaths;
  private onDemandIndex: OnDemandIndexFn | null = null;

  constructor(options: WorkspaceIndexOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.pikePaths = options.pikePaths ?? {
      pikeHome: "",
      modulePaths: [options.workspaceRoot],
      includePaths: [options.workspaceRoot],
      programPaths: [options.workspaceRoot],
    };
    this.resolver = new ModuleResolver({
      workspaceRoot: pathToUri(this.workspaceRoot),
      pikePaths: this.pikePaths,
      pikeVersion: null,
    });
  }

  setOnDemandIndexFn(fn: OnDemandIndexFn): void {
    this.onDemandIndex = fn;
  }

  static async create(workspaceRoot: string, pikeBinaryPath?: string, overrides?: PikePathOverrides): Promise<WorkspaceIndex> {
    const pikePaths = await detectPikePaths(workspaceRoot, pikeBinaryPath, overrides);
    return new WorkspaceIndex({ workspaceRoot, pikePaths });
  }

  // -- Context helpers for delegating to sub-modules --

  private resolutionCtx(): ResolutionContext {
    return {
      files: this.files,
      getGeneration: () => this.generation,
      getDependents: (u) => this.getDependents(u),
      resolveInherit: (p, s, f) => this.resolveInherit(p, s, f),
      onDemandIndex: this.onDemandIndex,
      resolver: this.resolver,
    };
  }

  private depCtx(): DependencyContext {
    return {
      resolver: this.resolver,
      resolveImport: (p, f) => this.resolveImport(p, f),
      resolveInherit: (p, s, f) => this.resolveInherit(p, s, f),
    };
  }

  // ---------------------------------------------------------------------------
  // Index CRUD
  // ---------------------------------------------------------------------------

  /**
   * Add or update a file in the index. Full resolution: symbol table + dependencies.
   * Used for user-initiated operations (didOpen, didChange).
   */
  async upsertFile(
    uri: string, version: number, tree: Tree, content: string, modSource: ModificationSource,
  ): Promise<FileEntry> {
    const existing = this.files.get(uri);
    if (existing) this.removeDependencies(existing);

    // Pre-warm the ModuleResolver cache so buildSymbolTable can do sync cross-file wiring
    const warmCacheResult = await warmResolverCache(this.depCtx(), tree, uri);

    const symbolTable = buildSymbolTable(tree, uri, version, { index: this.createSyncIndexAdapter(uri) });
    const pikeVersion = this.parsePikeVersion(tree, content);
    const contentHash = this.hashContent(content);
    const dependencies = await extractDependencies(this.depCtx(), symbolTable, uri, warmCacheResult);

    const entry: FileEntry = {
      uri, version, symbolTable, pikeVersion, dependencies,
      lastModSource: modSource, contentHash, stale: false,
      depsResolved: true,
    };

    this.files.set(uri, entry);
    this.generation++;
    this.registerReverseDeps(uri, dependencies);
    return entry;
  }

  /**
   * Fast-path insertion for background indexing.
   *
   * Builds the symbol table synchronously but skips async dependency resolution
   * (warmResolverCache + extractDependencies). Dependencies are resolved lazily
   * when the file is opened or queried. This makes bulk indexing ~10× faster
   * because the per-file async fs operations are eliminated.
   */
  upsertBackgroundFile(
    uri: string, version: number, tree: Tree, content: string,
  ): FileEntry {
    const existing = this.files.get(uri);
    if (existing) this.removeDependencies(existing);

    // Build symbol table without cross-file wiring — the resolver cache is cold,
    // so sync resolution returns null for imports/inherits. Acceptable: local
    // declarations and references are complete; cross-file resolution happens
    // at query time via resolveCrossFileDefinition / getCrossFileReferences.
    const symbolTable = buildSymbolTable(tree, uri, version, { index: this.createSyncIndexAdapter(uri) });
    const pikeVersion = this.parsePikeVersion(tree, content);
    const contentHash = this.hashContent(content);

    const entry: FileEntry = {
      uri, version, symbolTable, pikeVersion,
      dependencies: new Set(),
      lastModSource: ModificationSource.BackgroundIndex,
      contentHash,
      stale: false,
    };

    this.files.set(uri, entry);
    this.generation++;
    // No registerReverseDeps — dependencies are empty. Resolved lazily on demand.
    return entry;
  }

  /**
   * Ensure a file's dependency links are populated.
   *
   * Background-indexed and cache-restored files skip dependency resolution for
   * speed. This method upgrades them to full resolution asynchronously — the
   * caller can proceed immediately with the local symbol table, and cross-file
   * features (go-to-def in dependents, reference counts) will work once this
   * resolves.
   *
   * Returns true if dependencies were resolved, false if already resolved or
   * the file doesn't exist.
   */
  async ensureDependenciesResolved(uri: string): Promise<boolean> {
    const entry = this.files.get(uri);
    if (!entry) return false;
    if (!entry.symbolTable) return false;

    // Already resolved — distinguish "resolved and found deps" from
    // "resolved and found nothing" via the depsResolved sentinel flag.
    if (entry.depsResolved) return false;

    // Resolve dependencies for this entry
    const deps = await extractDependencies(this.depCtx(), entry.symbolTable, uri, new Map());

    // Mark as resolved even if no deps found — avoids re-running resolution
    // for files that genuinely have no imports/inherits.
    entry.depsResolved = true;

    if (deps.size > 0) {
      entry.dependencies = deps;
      this.registerReverseDeps(uri, deps);
    }
    return true;
  }

  /**
   * Insert a file entry from persistent cache.
   *
   * Like upsertBackgroundFile, this skips dependency resolution — cache
   * restoration should be fast (just deserialize + insert). Dependencies
   * are resolved lazily when cross-file queries need them.
   */
  upsertCachedFile(
    uri: string, version: number, symbolTable: SymbolTable, contentHash: string,
  ): FileEntry {
    const entry: FileEntry = {
      uri, version, symbolTable,
      pikeVersion: null,
      dependencies: new Set(),
      lastModSource: ModificationSource.DidOpen, contentHash, stale: false,
    };

    this.files.set(uri, entry);
    this.generation++;
    // No registerReverseDeps — dependencies are empty. Resolved lazily on demand.
    return entry;
  }

  /** Remove a file from the index and invalidate dependents. */
  removeFile(uri: string): void {
    const entry = this.files.get(uri);
    if (!entry) return;
    this.removeDependencies(entry);
    this.files.delete(uri);
    this.dependents.delete(uri);
    this.generation++;
  }

  getFile(uri: string): FileEntry | undefined {
    return this.files.get(uri);
  }

  getSymbolTable(uri: string): SymbolTable | null {
    const entry = this.files.get(uri);
    if (!entry) return null;
    if (entry.stale) return null;
    return entry.symbolTable;
  }

  /** Get symbol table, triggering on-demand indexing if not yet available. */
  async getOrIndexSymbolTable(uri: string): Promise<SymbolTable | null> {
    const existing = this.getSymbolTable(uri);
    if (existing) return existing;

    if (this.onDemandIndex) {
      try {
        const indexed = await this.onDemandIndex(uri);
        if (indexed?.symbolTable && !indexed.stale) return indexed.symbolTable;
      } catch (err) { /* on-demand indexing failed */ console.debug(`[workspaceIndex] on-demand indexing failed for ${uri}:`, err); }
    }
    return null;
  }

  getDependents(uri: string): Set<string> {
    return this.dependents.get(uri) ?? new Set();
  }

  getAllUris(): string[] { return [...this.files.keys()]; }

  getAllEntries(): FileEntry[] { return [...this.files.values()]; }

  get size(): number { return this.files.size; }

  invalidate(uri: string): void {
    const entry = this.files.get(uri);
    if (entry) { entry.symbolTable = null; entry.stale = true; }
  }

  /**
   * Invalidate a file and transitively invalidate all its dependents.
   * Stale-marking with lazy rebuild avoids rebuilding entire subtrees on every keystroke.
   */
  invalidateWithDependents(uri: string): string[] {
    const invalidated: string[] = [];
    const visited = new Set<string>();
    const queue = [uri];

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) continue;
      if (visited.has(current)) continue;
      visited.add(current);

      const entry = this.files.get(current);
      if (!entry) continue;

      if (current === uri) entry.symbolTable = null;
      entry.stale = true;
      invalidated.push(current);

      const deps = this.dependents.get(current);
      if (deps) {
        for (const depUri of deps) {
          if (!visited.has(depUri)) queue.push(depUri);
        }
      }
    }
    return invalidated;
  }

  isStale(uri: string): boolean { return this.files.get(uri)?.stale ?? false; }

  clear(): void {
    this.files.clear();
    this.dependents.clear();
    this.moduleMap.clear();
    this.generation++;
    this.resolver.clearCache();
  }

  // ---------------------------------------------------------------------------
  // Module resolution
  // ---------------------------------------------------------------------------

  async resolveModule(modulePath: string, fromUri: string): Promise<string | null> {
    const entry = this.files.get(fromUri);
    const fromPath = this.uriToPath(fromUri);
    const resolver = this.scopedResolver(entry);
    const result = await resolver.resolveModule(modulePath, fromPath);
    return result?.uri ?? null;
  }

  async resolveInherit(pathText: string, isStringLiteral: boolean, fromUri: string): Promise<string | null> {
    const fromPath = this.uriToPath(fromUri);
    const result = await this.resolver.resolveInherit(pathText, isStringLiteral, fromPath);
    return result?.uri ?? null;
  }

  async resolveImport(importPath: string, fromUri: string): Promise<string | null> {
    const fromPath = this.uriToPath(fromUri);
    const result = await this.resolver.resolveImport(importPath, fromPath);
    return result?.uri ?? null;
  }

  // ---------------------------------------------------------------------------
  // Sync resolution (cache-only, for symbolTable.ts compatibility)
  // ---------------------------------------------------------------------------

  private createSyncIndexAdapter(fromUri: string): {
    getSymbolTable(uri: string): SymbolTable | null;
    resolveImport(mod: string, from: string): string | null;
    resolveInherit(path: string, isString: boolean, from: string): string | null;
  } {
    const self = this;
    return {
      getSymbolTable(uri: string): SymbolTable | null { return self.getSymbolTable(uri); },
      resolveImport(mod: string, from: string): string | null { return self.resolveImportSync(mod, from); },
      resolveInherit(path: string, isString: boolean, from: string): string | null { return self.resolveInheritSync(path, isString, from); },
    };
  }

  resolveModuleSync(modulePath: string, fromUri: string): string | null {
    const entry = this.files.get(fromUri);
    const fromPath = this.uriToPath(fromUri);
    const resolver = this.scopedResolver(entry);
    return resolver.getCachedModule(modulePath, fromPath)?.uri ?? null;
  }

  resolveInheritSync(pathText: string, isStringLiteral: boolean, fromUri: string): string | null {
    const fromPath = this.uriToPath(fromUri);
    return this.resolver.getCachedInherit(pathText, isStringLiteral, fromPath)?.uri ?? null;
  }

  resolveImportSync(importPath: string, fromUri: string): string | null {
    const fromPath = this.uriToPath(fromUri);
    return this.resolver.getCachedModule(importPath, fromPath)?.uri ?? null;
  }

  // ---------------------------------------------------------------------------
  // Cross-file resolution (delegated to workspaceResolution.ts)
  // ---------------------------------------------------------------------------

  /** Resolve a cross-file definition at a position. Returns target URI + declaration, or null. */
  async resolveCrossFileDefinition(uri: string, line: number, character: number): Promise<{
    uri: string; decl: Declaration;
  } | null> {
    // Ensure the source file's dependencies are resolved so cross-file
    // queries can follow import/inherit edges. Lazy per ADR 0023.
    await this.ensureDependenciesResolved(uri);
    return resolveCrossFileDefinitionFn(this.resolutionCtx(), uri, line, character);
  }

  /** Get all references to a declaration across the workspace. */
  getCrossFileReferences(uri: string, line: number, character: number): Array<{
    uri: string; ref: Reference;
  }> {
    // Note: dependencies are resolved lazily on the source file above, but
    // finding references IN dependents requires those dependents to also have
    // resolved dependencies. Since getCrossFileReferences is synchronous,
    // we can only work with whatever dependency data is available right now.
    // The didOpen handler (navigationAdvanced.ts) calls ensureDependenciesResolved
    // asynchronously, so most actively-edited files will have deps resolved.
    return getCrossFileReferencesFn(this.resolutionCtx(), uri, line, character);
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private registerReverseDeps(uri: string, dependencies: Set<string>): void {
    for (const depUri of dependencies) {
      let depSet = this.dependents.get(depUri);
      if (!depSet) { depSet = new Set(); this.dependents.set(depUri, depSet); }
      depSet.add(uri);
    }
  }

  private removeDependencies(entry: FileEntry): void {
    for (const depUri of entry.dependencies) {
      const depSet = this.dependents.get(depUri);
      if (depSet) {
        depSet.delete(entry.uri);
        if (depSet.size === 0) this.dependents.delete(depUri);
      }
    }
  }

  /** Create a resolver scoped to the file's #pike version, or the default resolver. */
  private scopedResolver(entry: FileEntry | undefined): ModuleResolver {
    if (entry?.pikeVersion && entry.pikeVersion !== this.resolver["pikeVersion"]) {
      const versionKey = `${entry.pikeVersion.major}.${entry.pikeVersion.minor}`;
      const cached = this.versionResolvers.get(versionKey);
      if (cached) return cached;
      const scoped = new ModuleResolver({
        workspaceRoot: pathToUri(this.workspaceRoot),
        pikePaths: this.pikePaths,
        pikeVersion: entry.pikeVersion,
      });
      this.versionResolvers.set(versionKey, scoped);
      return scoped;
    }
    return this.resolver;
  }

  /** Parse #pike version directive. Format: #pike <major>[.<minor>] */
  private parsePikeVersion(tree: Tree, content: string): PikeVersionDirective | null {
    const root = tree.rootNode;
    if (!root) return null;

    if (content.match(/#pike\s+__REAL_VERSION__/)) {
      const homeVersion = this.pikePaths.pikeHome.match(/(\d+)\.(\d+)/);
      if (homeVersion) {
        return { major: parseInt(homeVersion[1], 10), minor: parseInt(homeVersion[2], 10) };
      }
    }

    const match = content.match(/#pike\s+(\d+)(?:\.(\d+))?/);
    if (!match) return null;
    return { major: parseInt(match[1], 10), minor: match[2] ? parseInt(match[2], 10) : 0 };
  }

  /** DJB2 content hash for cache validity. */
  private hashContent(content: string): string {
    let hash = 5381;
    for (let i = 0; i < content.length; i++) {
      hash = ((hash << 5) + hash + content.charCodeAt(i)) >>> 0;
    }
    return hash.toString(16);
  }

  private uriToPath(uri: string): string { return uriToPathUtil(uri); }
}
