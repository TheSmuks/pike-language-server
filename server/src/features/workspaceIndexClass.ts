/**
 * WorkspaceIndex: in-memory per-file symbol table index with cross-file links.
 * See architecture decision 0010 for design rationale.
 */

import { ModuleResolver, detectPikePaths, type PikePaths, type PikePathOverrides } from "./moduleResolver";
import { rewireDependents as rewireDependentsFn } from "./dependentsInvalidator";
import { buildSymbolTable, type SymbolTable, type Declaration, type Reference } from "./symbolTable";
import type { Tree } from "web-tree-sitter";
import { pathToUri, uriToPath as uriToPathUtil } from "../util/uri";
import {
  resolveCrossFileDefinition as resolveCrossFileDefinitionFn,
  getCrossFileReferences as getCrossFileReferencesFn,
  type ResolutionContext,
} from "./workspaceResolution";
import { warmResolverCache, extractDependencies, type DependencyContext } from "./workspaceDependencies";
import { startSpan, stopSpan, bump, measureAsync } from "./profiler";
import { hashContent } from "./cacheHash";
import {
  normUri,
  createSyncIndexAdapter,
  registerReverseDeps,
  removeDependencies,
  parsePikeVersion,
  type SyncIndexAdapter,
} from "./workspaceIndexImpl";

import type { FileEntry, WorkspaceIndexOptions, OnDemandIndexFn, PikeVersionDirective, DependencyMap } from "./workspaceTypes";
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
  /** Pike version directives are finite in practice; cap the cache to fail-safe. */
  private static readonly VERSION_RESOLVER_MAX = 16;

  readonly resolver: ModuleResolver;
  readonly workspaceRoot: string;
  readonly pikePaths: PikePaths;
  private onDemandIndex: OnDemandIndexFn | null = null;
  /** True after a global scan has completed (full mode or on-demand prep). */
  private globalPrepDone = false;

  constructor(options: WorkspaceIndexOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.pikePaths = options.pikePaths ?? {
      pikeHome: "",
      modulePaths: [options.workspaceRoot],
      includePaths: [options.workspaceRoot],
      programPaths: [options.workspaceRoot],
      ldLibraryPath: "",
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
    return measureAsync("upsertFile", async () => {
      const normalizedUri = normUri(uri);
      const existing = this.files.get(normalizedUri);
      if (existing) removeDependencies(this.dependents, existing, normUri);

      // Pre-warm the ModuleResolver cache so buildSymbolTable can do sync cross-file wiring
      bump("depResolutionCalls");
      const warmCacheResult = await measureAsync("warmResolverCache", () =>
        warmResolverCache(this.depCtx(), tree, normalizedUri),
      );

      const symbolTable = buildSymbolTable(tree, normalizedUri, version, { index: createSyncIndexAdapter(this, normalizedUri) }, content);
      const pikeVersion = parsePikeVersion(tree, content, this.pikePaths.pikeHome);
      const contentHash = hashContent(content);
      const dependencies = await measureAsync("extractDependencies", () =>
        extractDependencies(this.depCtx(), symbolTable, normalizedUri, warmCacheResult),
      );

      const entry: FileEntry = {
        uri: normalizedUri, version, symbolTable, pikeVersion, dependencies,
        lastModSource: modSource, contentHash, stale: false,
        depsResolved: true, lifecycle: "full",
      };

      this.files.set(normalizedUri, entry);
      this.generation++;
      registerReverseDeps(this.dependents, normalizedUri, dependencies, normUri);

      bump("indexWrites");
      bump("indexWritesFull");
      return entry;
    });
  }

  /**
   * Fast-path insertion for background indexing.
   *
   * Builds the symbol table synchronously but skips async dependency resolution
   * (warmResolverCache + extractDependencies). Dependencies are resolved lazily
   * when the file is opened or queried. This makes bulk indexing ~10x faster
   * because the per-file async fs operations are eliminated.
   */
  upsertBackgroundFile(
    uri: string, version: number, tree: Tree, content: string,
  ): FileEntry {
    startSpan("upsertBackgroundFile");
    const normalizedUri = normUri(uri);
    const existing = this.files.get(normalizedUri);
    if (existing) removeDependencies(this.dependents, existing, normUri);

    // Build symbol table without cross-file wiring -- the resolver cache is cold,
    // so sync resolution returns null for imports/inherits. Acceptable: local
    // declarations and references are complete; cross-file resolution happens
    // at query time via resolveCrossFileDefinition / getCrossFileReferences.
    const symbolTable = buildSymbolTable(tree, normalizedUri, version, { index: createSyncIndexAdapter(this, normalizedUri) }, content);
    const pikeVersion = parsePikeVersion(tree, content, this.pikePaths.pikeHome);
    const contentHash = hashContent(content);

    const entry: FileEntry = {
      uri: normalizedUri, version, symbolTable, pikeVersion,
      dependencies: new Set(),
      lastModSource: ModificationSource.BackgroundIndex,
      contentHash,
      stale: false,
      lifecycle: "full",
    };

    this.files.set(normalizedUri, entry);
    this.generation++;
    // No registerReverseDeps -- dependencies are empty. Resolved lazily on demand.

    bump("indexWrites");
    bump("indexWritesBackground");
    stopSpan("upsertBackgroundFile");
    return entry;
  }

  /**
   * Ensure a file's dependency links are populated.
   *
   * Background-indexed and cache-restored files skip dependency resolution for
   * speed. This method upgrades them to full resolution asynchronously -- the
   * caller can proceed immediately with the local symbol table, and cross-file
   * features (go-to-def in dependents, reference counts) will work once this
   * resolves.
   *
   * Returns true if dependencies were resolved, false if already resolved or
   * the file doesn't exist.
   */
  async ensureDependenciesResolved(uri: string): Promise<boolean> {
    bump("lazyDepResolutionCalls");
    const normalizedUri = normUri(uri);
    const entry = this.files.get(normalizedUri);
    if (!entry) return false;
    if (!entry.symbolTable) return false;

    // Already resolved -- distinguish "resolved and found deps" from
    // "resolved and found nothing" via the depsResolved sentinel flag.
    if (entry.depsResolved) return false;

    // Resolve dependencies for this entry
    const deps = await extractDependencies(this.depCtx(), entry.symbolTable, normalizedUri, new Map());

    // Mark as resolved even if no deps found -- avoids re-running resolution
    // for files that genuinely have no imports/inherits.
    entry.depsResolved = true;

    if (deps.size > 0) {
      entry.dependencies = deps;
      registerReverseDeps(this.dependents, normalizedUri, deps, normUri);
    }
    return true;
  }

  /**
   * Insert a file entry from persistent cache.
   *
   * Like upsertBackgroundFile, this skips dependency resolution -- cache
   * restoration should be fast (just deserialize + insert). Dependencies
   * are resolved lazily when cross-file queries need them.
   */
  upsertCachedFile(
    uri: string, version: number, symbolTable: SymbolTable, contentHash: string,
  ): FileEntry {
    startSpan("upsertCachedFile");
    const normalizedUri = normUri(uri);
    const entry: FileEntry = {
      uri: normalizedUri, version, symbolTable,
      pikeVersion: null,
      dependencies: new Set(),
      lastModSource: ModificationSource.DidOpen, contentHash, stale: false,
      lifecycle: "full",
    };

    this.files.set(normalizedUri, entry);
    this.generation++;
    // No registerReverseDeps -- dependencies are empty. Resolved lazily on demand.

    bump("indexWrites");
    bump("indexWritesCached");
    stopSpan("upsertCachedFile");
    return entry;
  }

  /** Remove a file from the index and invalidate dependents. */
  removeFile(uri: string): void {
    const normalizedUri = normUri(uri);
    const entry = this.files.get(normalizedUri);
    if (!entry) return;
    removeDependencies(this.dependents, entry, normUri);
    this.files.delete(normalizedUri);
    this.dependents.delete(normalizedUri);
    this.generation++;
  }

  /**
   * Restore forward dependencies for a cache-restored file.
   *
   * Reconstructs the reverse-dependency graph from serialized forward deps
   * without requiring async resolution. Called after upsertCachedFile to
   * enable M3 pruned invalidation from the first request.
   */
  restoreDependencies(uri: string, dependencies: Set<string>): void {
    const normalizedUri = normUri(uri);
    const entry = this.files.get(normalizedUri);
    if (!entry) return;

    // Only restore if the entry has no deps yet (just cached).
    if (entry.dependencies.size > 0) return;

    // Normalize dependency URIs too -- they were serialized from a previous
    // session where the filesystem layout may have changed (symlinks added/removed).
    const normalizedDeps = new Set<string>();
    for (const depUri of dependencies) {
      normalizedDeps.add(normUri(depUri));
    }

    entry.dependencies = normalizedDeps;
    entry.depsResolved = true;
    registerReverseDeps(this.dependents, normalizedUri, normalizedDeps, normUri);
  }

  getFile(uri: string): FileEntry | undefined {
    return this.files.get(normUri(uri));
  }

  getSymbolTable(uri: string): SymbolTable | null {
    const entry = this.files.get(normUri(uri));
    if (!entry) return null;
    if (entry.stale) return null;
    return entry.symbolTable;
  }

  /** Get symbol table, triggering on-demand indexing if not yet available. */
  async getOrIndexSymbolTable(uri: string): Promise<SymbolTable | null> {
    const normalizedUri = normUri(uri);
    const existing = this.getSymbolTable(normalizedUri);
    if (existing) return existing;

    if (this.onDemandIndex) {
      try {
        const indexed = await this.onDemandIndex(normalizedUri);
        if (indexed?.symbolTable && !indexed.stale) return indexed.symbolTable;
      } catch (err) { /* on-demand indexing failed */ console.debug(`[workspaceIndex] on-demand indexing failed for ${normalizedUri}:`, err); }
    }
    return null;
  }

  getDependents(uri: string): Set<string> {
    return this.dependents.get(normUri(uri)) ?? new Set();
  }

  /**
   * Return a snapshot of the unified dependency graph.
   *
   * Forward edges are derived from each entry's `dependencies` field; reverse
   * edges from the internal `dependents` map. The generation counter reflects
   * the current mutation count, letting callers detect stale snapshots.
   *
   * The returned maps are live references — callers must not mutate them.
   * Call `getDependencyMap()` fresh each time you need a consistent snapshot.
   */
  getDependencyMap(): DependencyMap {
    const forwardEdges = new Map<string, Set<string>>();
    for (const entry of this.files.values()) {
      if (entry.dependencies.size > 0) {
        forwardEdges.set(entry.uri, entry.dependencies);
      }
    }
    return {
      forwardEdges,
      reverseEdges: this.dependents,
      generation: this.generation,
    };
  }

  /**
   * Demote an entry under memory pressure: drop the symbol table but retain
   * identity and dependency edges. The entry can be rehydrated from cache or
   * source when next queried.
   *
   * Returns true if the entry was demoted, false if it doesn't exist or is
   * already demoted/stub.
   */
  demoteEntry(uri: string): boolean {
    const normalizedUri = normUri(uri);
    const entry = this.files.get(normalizedUri);
    if (!entry) return false;
    if (entry.lifecycle === "demoted" || entry.lifecycle === "stub") return false;
    entry.symbolTable = null;
    entry.lifecycle = "demoted";
    return true;
  }

  /**
   * Get the lifecycle state of an entry, or null if not indexed.
   */
  getEntryLifecycle(uri: string): string | null {
    const entry = this.files.get(normUri(uri));
    return entry?.lifecycle ?? null;
  }

  /**
   * Demote non-essential entries under memory pressure.
   *
   * Essential entries (open files and their dependency closure) keep their
   * symbol tables. All other "full" entries have their symbol tables dropped
   * but retain identity and dependency edges for rehydration.
   *
   * Demotion stops after maxToDemote entries — the bound prevents a single
   * pressure event from dropping the entire index.
   *
   * Returns the list of demoted URIs (in iteration order).
   */
  demoteNonEssentialEntries(
    openUris: Set<string>,
    closureUris: Set<string>,
    maxToDemote: number,
  ): string[] {
    // Build the essential set (normalized) from open + closure.
    const essential = new Set<string>();
    for (const uri of openUris) essential.add(normUri(uri));
    for (const uri of closureUris) essential.add(normUri(uri));

    const demoted: string[] = [];
    for (const [uri, entry] of this.files) {
      if (demoted.length >= maxToDemote) break;
      if (essential.has(uri)) continue;
      if (entry.lifecycle !== "full") continue;

      // Demote: drop symbol table, keep identity + dependency edges.
      entry.symbolTable = null;
      entry.lifecycle = "demoted";
      demoted.push(uri);
    }
    return demoted;
  }

  /**
   * Rehydrate a demoted entry by re-indexing it via the on-demand indexer.
   *
   * Returns true if the entry was rehydrated (symbol table restored), false
   * if the entry doesn't exist, is not in the "demoted" state, or no on-demand
   * indexer is registered. Never returns true with a null symbol table.
   */
  async rehydrateEntry(uri: string): Promise<boolean> {
    const normalizedUri = normUri(uri);
    const entry = this.files.get(normalizedUri);
    if (!entry) return false;
    if (entry.lifecycle !== "demoted") return false;
    if (!this.onDemandIndex) return false;

    try {
      const indexed = await this.onDemandIndex(normalizedUri);
      if (indexed?.symbolTable) {
        return true;
      }
    } catch {
      // Re-indexing failed — entry stays demoted. Do not present false success.
    }
    return false;
  }

  /** True if the workspace has been fully scanned at least once. */
  isGlobalPrepDone(): boolean { return this.globalPrepDone; }

  /** Mark the workspace as fully scanned. Called after global prep completes. */
  markGlobalPrepDone(): void { this.globalPrepDone = true; }

  /**
   * Invalidate the global prep flag so the next global query re-scans.
   *
   * Called by the file watcher when a workspace file changes on disk — the
   * index is no longer guaranteed complete, so lazy global preparation must
   * re-run to pick up the new or changed file.
   */
  invalidateGlobalPrep(): void { this.globalPrepDone = false; }

  getAllUris(): string[] { return [...this.files.keys()]; }

  getAllEntries(): FileEntry[] { return [...this.files.values()]; }

  get size(): number { return this.files.size; }

  /** Current generation counter -- incremented on every mutation. */
  get currentGeneration(): number { return this.generation; }

  invalidate(uri: string): void {
    const entry = this.files.get(normUri(uri));
    if (entry) { entry.symbolTable = null; entry.stale = true; }
  }

  /**
   * Invalidate a file and transitively invalidate all its dependents.
   * Stale-marking with lazy rebuild avoids rebuilding entire subtrees on every keystroke.
   */
  invalidateWithDependents(uri: string): string[] {
    const invalidated: string[] = [];
    const visited = new Set<string>();
    const queue = [normUri(uri)];

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) continue;
      if (visited.has(current)) continue;
      visited.add(current);

      const entry = this.files.get(current);
      if (!entry) continue;

      const sourceUri = normUri(uri);
      if (current === sourceUri) entry.symbolTable = null;
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

  isStale(uri: string): boolean { return this.files.get(normUri(uri))?.stale ?? false; }

  rewireDependents(uri: string): string[] {
    return rewireDependentsFn(this, normUri(uri));
  }

  hasFile(uri: string): boolean { return this.files.has(uri); }

  clear(): void {
    this.files.clear();
    this.dependents.clear();
    this.moduleMap.clear();
    this.versionResolvers.clear();
    this.globalPrepDone = false;
    this.generation++;
    this.resolver.clearCache();
  }

  // ---------------------------------------------------------------------------
  // Module resolution
  // ---------------------------------------------------------------------------

  async resolveModule(modulePath: string, fromUri: string): Promise<string | null> {
    const normalizedFromUri = normUri(fromUri);
    const entry = this.files.get(normalizedFromUri);
    const fromPath = this.uriToPath(normalizedFromUri);
    const resolver = this.scopedResolver(entry);
    const result = await resolver.resolveModule(modulePath, fromPath);
    return result?.uri ?? null;
  }

  async resolveInherit(pathText: string, isStringLiteral: boolean, fromUri: string): Promise<string | null> {
    const normalizedFromUri = normUri(fromUri);
    const fromPath = this.uriToPath(normalizedFromUri);
    const result = await this.resolver.resolveInherit(pathText, isStringLiteral, fromPath);
    return result?.uri ?? null;
  }

  async resolveImport(importPath: string, fromUri: string): Promise<string | null> {
    const normalizedFromUri = normUri(fromUri);
    const fromPath = this.uriToPath(normalizedFromUri);
    const result = await this.resolver.resolveImport(importPath, fromPath);
    return result?.uri ?? null;
  }

  // ---------------------------------------------------------------------------
  // Sync resolution (cache-only, for symbolTable.ts compatibility)
  // ---------------------------------------------------------------------------

  resolveModuleSync(modulePath: string, fromUri: string): string | null {
    const normalizedFromUri = normUri(fromUri);
    const entry = this.files.get(normalizedFromUri);
    const fromPath = this.uriToPath(normalizedFromUri);
    const resolver = this.scopedResolver(entry);
    return resolver.getCachedModule(modulePath, fromPath)?.uri ?? null;
  }

  resolveInheritSync(pathText: string, isStringLiteral: boolean, fromUri: string): string | null {
    const normalizedFromUri = normUri(fromUri);
    const fromPath = this.uriToPath(normalizedFromUri);
    return this.resolver.getCachedInherit(pathText, isStringLiteral, fromPath)?.uri ?? null;
  }

  resolveImportSync(importPath: string, fromUri: string): string | null {
    const normalizedFromUri = normUri(fromUri);
    const fromPath = this.uriToPath(normalizedFromUri);
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
    return resolveCrossFileDefinitionFn(this.resolutionCtx(), normUri(uri), line, character);
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
    return getCrossFileReferencesFn(this.resolutionCtx(), normUri(uri), line, character);
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /** Create a resolver scoped to the file's #pike version, or the default resolver. */
  private scopedResolver(entry: FileEntry | undefined): ModuleResolver {
    if (entry?.pikeVersion && entry.pikeVersion !== this.resolver["pikeVersion"]) {
      const versionKey = `${entry.pikeVersion.major}.${entry.pikeVersion.minor}`;
      const cached = this.versionResolvers.get(versionKey);
      if (cached) return cached;
      this.evictVersionResolverIfNeeded();
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

  private evictVersionResolverIfNeeded(): void {
    if (this.versionResolvers.size < WorkspaceIndex.VERSION_RESOLVER_MAX) return;
    const oldestKey = this.versionResolvers.keys().next().value;
    if (oldestKey) this.versionResolvers.delete(oldestKey);
  }

  private uriToPath(uri: string): string { return uriToPathUtil(uri); }
}
