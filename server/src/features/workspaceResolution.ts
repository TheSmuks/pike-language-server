/**
 * Cross-file resolution functions for WorkspaceIndex.
 *
 * Extracted from workspaceIndex.ts to keep file sizes manageable.
 * These functions operate on a resolution context provided by WorkspaceIndex.
 */

import { type ModuleResolver } from "./moduleResolver";
import { getDefinitionAt, getReferencesTo, type SymbolTable, type Declaration, type Reference } from "./symbolTable";
import type { FileEntry, WorkspaceIndex } from "./workspaceIndex";
import { normalizeUri } from "../util/uri";
import { resolveTypeName } from "./scope-helpers";
import type { Connection } from "vscode-languageserver/node";
import type { CancellationToken } from "vscode-jsonrpc";
import { indexWorkspaceFiles } from "./backgroundIndex";

// ---------------------------------------------------------------------------
// Context interface
// ---------------------------------------------------------------------------

/**
 * Context provided by WorkspaceIndex for cross-file resolution.
 * All methods/properties are bound to the index instance.
 */
export interface ResolutionContext {
  readonly files: Map<string, FileEntry>;
  readonly getGeneration: () => number;
  readonly getDependents: (uri: string) => Set<string>;
  readonly resolveInherit: (pathText: string, isStringLiteral: boolean, fromUri: string) => Promise<string | null>;
  readonly onDemandIndex: ((uri: string) => Promise<FileEntry | null>) | null;
  readonly resolver: ModuleResolver;
}

/** Normalize and look up a file entry from the raw files map. */
function getFile(ctx: ResolutionContext, uri: string): FileEntry | undefined {
  return ctx.files.get(normalizeUri(uri));
}

// ---------------------------------------------------------------------------
// Global query preparation
// ---------------------------------------------------------------------------

/**
 * Options for ensuring the workspace is indexed before a global query.
 */
export interface GlobalQueryPrepOptions {
  connection: Connection;
  index: WorkspaceIndex;
  workspaceRoot: string;
  cancellationToken?: CancellationToken;
  ignoreGlobs?: string[];
  maxFileSizeBytes?: number;
  fullScanFileLimit?: number;
  /**
   * When true, global features are temporarily unavailable because the server
   * is under memory pressure. prepareGlobalQuery throws DegradedGlobalUnavailableError
   * instead of returning partial or empty results.
   */
  isDegraded?: () => boolean;
}

/**
 * Error thrown when a global feature is requested while the server is in
 * degraded mode (under memory pressure).
 *
 * Global features (workspace symbol, find references, rename, call hierarchy)
 * require a complete index. Under memory pressure, the index may be partially
 * demoted. Rather than returning incomplete results, the feature reports this
 * honest error so the client can show an accurate message.
 */
export class DegradedGlobalUnavailableError extends Error {
  constructor() {
    super(
      "Global features are temporarily unavailable while the server is under memory pressure. " +
      "Try again after memory pressure subsides.",
    );
    this.name = "DegradedGlobalUnavailableError";
  }
}

/**
 * Ensure the workspace is fully indexed before a global query proceeds.
 *
 * In `openFiles` mode, the first global query (workspace symbol, find
 * references, rename, call hierarchy) must block to build the complete index.
 * This function triggers a full workspace scan via indexWorkspaceFiles, which
 * discovers and indexes any unindexed files. The scan itself handles batching,
 * yielding between batches, workDoneProgress reporting, and cancellation at
 * safe boundaries.
 *
 * Per contracts/lsp-resource-state.md:
 * - The first request reports workDoneProgress and supports cancellation.
 * - Without cancellation, results must be complete — never partial.
 * - Cancelled preparation is NOT marked done; the next query retries.
 * - When degraded (memory pressure), throws DegradedGlobalUnavailableError
 *   instead of returning partial or empty results.
 *
 * Idempotent: if the index has already been globally prepared, returns 0
 * immediately without re-scanning.
 *
 * Returns the total number of indexed entries after preparation.
 */
export async function prepareGlobalQuery(
  options: GlobalQueryPrepOptions,
): Promise<number> {
  // Degraded guard: never return partial results under memory pressure.
  if (options.isDegraded?.()) {
    throw new DegradedGlobalUnavailableError();
  }

  const { connection, index, workspaceRoot } = options;

  // Idempotency: skip if a full scan has already completed.
  if (index.isGlobalPrepDone()) return index.size;

  if (!workspaceRoot) {
    index.markGlobalPrepDone();
    return index.size;
  }

  // Delegate to backgroundIndex — it handles discovery, filtering, batching,
  // yielding, progress, and cancellation between batches.
  await indexWorkspaceFiles({
    connection,
    index,
    workspaceRoot,
    indexingMode: "full",
    cancellationToken: options.cancellationToken,
    ignoreGlobs: options.ignoreGlobs,
    maxFileSizeBytes: options.maxFileSizeBytes,
    fullScanFileLimit: options.fullScanFileLimit,
  });

  // Per contract: cancelled preparation must NOT be cached as complete.
  // Leave globalPrepDone false so the next global query retries.
  if (options.cancellationToken?.isCancellationRequested) {
    return index.size;
  }

  index.markGlobalPrepDone();
  return index.size;
}

// ---------------------------------------------------------------------------
// Cross-file resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a cross-file definition.
 * Given a position in a file, attempt to find the definition across files.
 * Returns the target URI and declaration, or null.
 */
export async function resolveCrossFileDefinition(
  ctx: ResolutionContext,
  uri: string,
  line: number,
  character: number,
  maxRetries = 1,
): Promise<{
  uri: string; decl: Declaration;
} | null> {
  const snapshotGen = ctx.getGeneration();
  const entry = getFile(ctx, uri);
  if (!entry?.symbolTable) return null;

  const table = entry.symbolTable;
  // Check if the position is on an inherit declaration
  for (const decl of table.declarations) {
    if (decl.kind === "inherit" || decl.kind === "import") {
      const nr = decl.nameRange;
      if (nr.start.line === line && nr.end.line === line &&
          character >= nr.start.character && character < nr.end.character) {
        const result = await resolveInheritTarget(ctx, decl, uri);
        // If the index was mutated while we yielded, the result may be stale.
        // Retry once — the mutation already updated the data.
        if (result && ctx.getGeneration() !== snapshotGen && maxRetries > 0) {
          return resolveCrossFileDefinition(ctx, uri, line, character, maxRetries - 1);
        }
        return result;
      }
    }
  }

  // Check if a reference resolves to null (unresolved within file).
  // This might be a cross-file reference through inheritance or import.
  // Use range-based matching: the hover position may be anywhere within
  // the identifier (ref.loc is the start, name.length gives the extent).
  for (const ref of table.references) {
    if (ref.resolvesTo === null && ref.loc.line === line &&
        character >= ref.loc.character &&
        character < ref.loc.character + ref.name.length) {
      const result = await resolveUnresolvedReference(ctx, ref, table, uri);
      if (result && ctx.getGeneration() !== snapshotGen && maxRetries > 0) {
        return resolveCrossFileDefinition(ctx, uri, line, character, maxRetries - 1);
      }
      return result;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Scope-aware cross-file filtering helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a declaration is a class member (lives inside a class scope).
 */
function isClassMember(decl: Declaration, table: SymbolTable): boolean {
  // Only method/variable/constant/enum_member can be class members.
  if (decl.kind !== "method" && decl.kind !== "variable" &&
      decl.kind !== "constant" && decl.kind !== "enum_member") {
    return false;
  }
  // Find a class scope whose declarations[] contains this decl's ID.
  return table.scopes.some(
    s => s.kind === "class" && s.declarations.includes(decl.id),
  );
}

/**
 * Find the class name that owns a member declaration.
 * Returns the class name, or null if the declaration is not a class member.
 */
function findOwningClassName(decl: Declaration, table: SymbolTable): string | null {
  const classBodyScope = table.scopes.find(
    s => s.kind === "class" && s.declarations.includes(decl.id),
  );
  if (!classBodyScope) return null;

  const classDecl = table.declarations.find(
    d => d.kind === "class" && d.scopeId === classBodyScope.parentId,
  );
  return classDecl?.name ?? null;
}

/**
 * Collect references in a dependent file that match the target name and
 * are unresolved (inherited/imported symbols have resolvesTo=null).
 */
function findMatchingRefs(
  table: SymbolTable,
  targetName: string,
): Reference[] {
  return table.references.filter(
    ref => ref.name === targetName && ref.resolvesTo === null,
  );
}

/**
 * Check if a reference should be filtered out because the target is a
 * class member and the reference's receiver type doesn't match the
 * target's owning class.
 */
function shouldFilterClassMemberRef(
  ref: Reference,
  target: Declaration,
  table: SymbolTable,
): boolean {
  if (ref.kind !== 'arrow_access' && ref.kind !== 'dot_access') return false;
  if (!ref.lhsName) return false;

  const lhsDecl = table.declarations.find(
    d => d.name === ref.lhsName && (d.kind === 'variable' || d.kind === 'parameter'),
  );
  if (!lhsDecl) return false;

  const lhsType = resolveTypeName(lhsDecl);
  if (!lhsType) return false;

  const owningClass = findOwningClassName(target, table);
  return owningClass !== null && lhsType !== owningClass;
}

export function getCrossFileReferences(
  ctx: ResolutionContext,
  uri: string,
  line: number,
  character: number,
): Array<{
  uri: string; ref: Reference;
}> {
  const results: Array<{ uri: string; ref: Reference }> = [];
  const entry = getFile(ctx, uri);
  if (!entry?.symbolTable) return results;

  // Same-file references
  for (const ref of getReferencesTo(entry.symbolTable, line, character)) {
    results.push({ uri, ref });
  }

  const target = getDefinitionAt(entry.symbolTable, line, character);
  if (!target) return results;

  const targetIsMember = isClassMember(target, entry.symbolTable);

  for (const depUri of ctx.getDependents(uri)) {
    const depEntry = getFile(ctx, depUri);
    if (!depEntry?.symbolTable) continue;
    if (!depEntry.dependencies.has(uri)) continue;

    const depTable = depEntry.symbolTable;
    for (const ref of findMatchingRefs(depTable, target.name)) {
      if (targetIsMember && shouldFilterClassMemberRef(ref, target, entry.symbolTable)) {
        continue;
      }
      results.push({ uri: depUri, ref });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Internal: cross-file resolution helpers
// ---------------------------------------------------------------------------

/** Synthesize a top-of-file class declaration for files with no explicit class. */
function synthesizeFileClassDecl(name: string, uri: string): { uri: string; decl: Declaration } {
  return {
    uri,
    decl: {
      id: -1,
      name,
      kind: "class",
      nameRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      scopeId: -1,
    },
  };
}

/**
 * Find the target declaration in an indexed file based on the inherit path pattern.
 * Handles .pmod, string-literal, dotted-path, and identifier inherits.
 */
function findTargetDeclInFile(
  decl: Declaration,
  targetEntry: FileEntry,
  targetUri: string,
  isStringLit: boolean,
): { uri: string; decl: Declaration } | null {
  const table = targetEntry.symbolTable;
  if (!table) return null;

  // For directory modules (.pmod/), the target brings all top-level symbols into scope.
  // Return the first class declaration as a representative target.
  if (targetUri.endsWith(".pmod")) {
    return findFirstClassOrSynthesize(table, decl.name, targetUri);
  }

  // For string literal inherits (file paths like "cross-inherit-simple-a.pike"):
  // return the first class found (the entire file's symbols are inherited).
  if (isStringLit) {
    return findFirstClassOrSynthesize(table, decl.name, targetUri);
  }

  // For dotted-path inherits to .pike files (e.g., "inherit Cache.Storage.Base"
  // resolving to Base.pike): the .pike file is an implicit class.
  const isDottedPath = decl.name.includes(".");
  if (isDottedPath && targetUri.endsWith(".pike")) {
    return findFirstClassOrSynthesize(table, decl.name, targetUri);
  }

  // For identifier inherits/imports: look for a matching declaration first,
  // then fall back to top-of-file for implicit classes.
  const inheritName = decl.alias ?? decl.name;
  for (const targetDecl of table.declarations) {
    if (targetDecl.name === inheritName) {
      return { uri: targetUri, decl: targetDecl };
    }
  }

  // No matching declaration found — for .pike/.pmod files the file IS the class.
  if (targetUri.endsWith(".pike") || targetUri.endsWith(".pmod")) {
    return synthesizeFileClassDecl(inheritName, targetUri);
  }

  return null;
}

/** Find the first class declaration in the table, or synthesize a file-class decl. */
function findFirstClassOrSynthesize(
  table: SymbolTable,
  name: string,
  targetUri: string,
): { uri: string; decl: Declaration } {
  for (const targetDecl of table.declarations) {
    if (targetDecl.kind === "class") {
      return { uri: targetUri, decl: targetDecl };
    }
  }
  return synthesizeFileClassDecl(name, targetUri);
}

async function resolveInheritTarget(
  ctx: ResolutionContext,
  decl: Declaration,
  fromUri: string,
): Promise<{
  uri: string; decl: Declaration;
} | null> {
  const isStringLit = decl.name.startsWith('"') && decl.name.endsWith('"');
  const targetUri = await ctx.resolveInherit(decl.name, isStringLit, fromUri);
  if (!targetUri) return null;

  let targetEntry = getFile(ctx, targetUri);

  // On-demand indexing: if the target file is not yet indexed and an
  // on-demand callback is registered, trigger indexing so we can resolve
  // into it.
  if (!targetEntry?.symbolTable && ctx.onDemandIndex) {
    targetEntry = await indexOnDemand(ctx, targetUri);
  }

  if (!targetEntry?.symbolTable) return null;

  return findTargetDeclInFile(decl, targetEntry, targetUri, isStringLit);
}

/** Attempt on-demand indexing of a target URI. Returns the indexed entry or the original. */
async function indexOnDemand(
  ctx: ResolutionContext,
  targetUri: string,
): Promise<FileEntry | undefined> {
  if (!ctx.onDemandIndex) return undefined;
  try {
    const indexed = await ctx.onDemandIndex(targetUri);
    return indexed ?? undefined;
  } catch (err) {
    console.debug(`[workspaceResolution] on-demand indexing failed for ${targetUri}:`, err);
    return undefined;
  }
}

async function searchInheritChainForSymbol(
  ctx: ResolutionContext,
  ref: Reference,
  table: SymbolTable,
  uri: string,
  seen: Set<string>,
  currentDepth: number,
): Promise<{ uri: string; decl: Declaration } | null> {
  for (const decl of table.declarations) {
    if (decl.kind === "inherit" || decl.kind === "import") {
      const target = await resolveInheritTarget(ctx, decl, uri);
      if (target) {
        const targetEntry = getFile(ctx, target.uri);
        if (targetEntry?.symbolTable) {
          // Check direct declarations in the target file.
          for (const targetDecl of targetEntry.symbolTable.declarations) {
            if (targetDecl.name === ref.name) {
              return { uri: target.uri, decl: targetDecl };
            }
          }
          // Recurse: check what the target itself inherits.
          const transitive = await resolveUnresolvedReference(
            ctx, ref, targetEntry.symbolTable, target.uri, seen, currentDepth + 1,
          );
          if (transitive) return transitive;
        }
      }
    }
  }
  return null;
}

async function resolveUnresolvedReference(
  ctx: ResolutionContext,
  ref: Reference,
  table: SymbolTable,
  uri: string,
  visited?: Set<string>,
  depth?: number,
): Promise<{ uri: string; decl: Declaration } | null> {
  const MAX_DEPTH = 10;
  const seen = visited ?? new Set<string>();
  const currentDepth = depth ?? 0;

  // Cycle detection: don't revisit files already on the resolution path.
  if (seen.has(uri)) return null;
  seen.add(uri);

  // Depth limit: prevent unbounded recursion on deeply nested inherit chains.
  if (currentDepth > MAX_DEPTH) return null;

  // Try explicit inherit chain
  const fromInherit = await searchInheritChainForSymbol(ctx, ref, table, uri, seen, currentDepth);
  if (fromInherit) return fromInherit;

  // Try the implicit directory module.pmod: files inside Foo.pmod/
  // automatically see symbols from Foo.pmod/module.pmod.
  const directoryModule = await ctx.resolver.findDirectoryModulePmod(uri);
  if (directoryModule) {
    const moduleEntry = getFile(ctx, directoryModule);
    if (moduleEntry?.symbolTable) {
      for (const moduleDecl of moduleEntry.symbolTable.declarations) {
        if (moduleDecl.name === ref.name) {
          return { uri: directoryModule, decl: moduleDecl };
        }
      }
    }
  }

  return null;
}
