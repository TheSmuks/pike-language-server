/**
 * Cross-file resolution functions for WorkspaceIndex.
 *
 * Extracted from workspaceIndex.ts to keep file sizes manageable.
 * These functions operate on a resolution context provided by WorkspaceIndex.
 */

import { type ModuleResolver } from "./moduleResolver";
import { getDefinitionAt, getReferencesTo, type SymbolTable, type Declaration, type Reference } from "./symbolTable";
import type { FileEntry } from "./workspaceIndex";

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
  const entry = ctx.files.get(uri);
  if (!entry?.symbolTable) return null;

  const table = entry.symbolTable;
  // Check if the position is on an inherit declaration
  for (const decl of table.declarations) {
    if (decl.kind === "inherit" || decl.kind === "import") {
      const nr = decl.nameRange;
      if (nr.start.line === line && nr.end.line === line &&
          character >= nr.start.character && character <= nr.end.character) {
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

/**
 * Get all references to a declaration across the workspace.
 * Extends single-file references with cross-file references.
 */
export function getCrossFileReferences(
  ctx: ResolutionContext,
  uri: string,
  line: number,
  character: number,
): Array<{
  uri: string; ref: Reference;
}> {
  const results: Array<{ uri: string; ref: Reference }> = [];
  const entry = ctx.files.get(uri);
  if (!entry?.symbolTable) return results;

  // First, get same-file references
  const sameFileRefs = getReferencesTo(entry.symbolTable, line, character);
  for (const ref of sameFileRefs) {
    results.push({ uri, ref });
  }

  // Find the target declaration
  let targetDecl = getDefinitionAt(entry.symbolTable, line, character);
  if (!targetDecl) return results;

  // Local alias so TypeScript narrows the type (avoid non-null assertion).
  const target = targetDecl;

  // Search other files for references to the same symbol.
  // Source-file filter: only consider dependents that have the source file
  // in their direct dependency set. This prevents matching same-name symbols
  // from unrelated files (e.g., two independent files each defining 'process').
  const dependents = ctx.getDependents(uri);
  for (const depUri of dependents) {
    const depEntry = ctx.files.get(depUri);
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
      if (ref.name === target.name && ref.resolvesTo === null) {
        results.push({ uri: depUri, ref });
      }
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
  const table = targetEntry.symbolTable!;

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

  let targetEntry = ctx.files.get(targetUri);

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

async function resolveUnresolvedReference(
  ctx: ResolutionContext,
  ref: Reference,
  table: SymbolTable,
  uri: string,
): Promise<{ uri: string; decl: Declaration } | null> {
  // Try to find the name through explicit inheritance/import chains.
  for (const decl of table.declarations) {
    if (decl.kind === "inherit" || decl.kind === "import") {
      const target = await resolveInheritTarget(ctx, decl, uri);
      if (target) {
        // Check if the target file has a declaration matching the reference name.
        const targetEntry = ctx.files.get(target.uri);
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

  // Try the implicit directory module.pmod: files inside Foo.pmod/
  // automatically see symbols from Foo.pmod/module.pmod.
  const directoryModule = await ctx.resolver.findDirectoryModulePmod(uri);
  if (directoryModule) {
    const moduleEntry = ctx.files.get(directoryModule);
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
