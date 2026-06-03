/**
 * Dependency extraction functions for WorkspaceIndex.
 *
 * Extracted from workspaceIndex.ts to keep file sizes manageable.
 * These functions operate on a dependency context provided by WorkspaceIndex.
 */

import { type ModuleResolver } from "./moduleResolver";
import type { SymbolTable } from "./symbolTable";
import { uriToPath as uriToPathUtil } from "../util/uri";
import type { Tree } from "web-tree-sitter";

// ---------------------------------------------------------------------------
// Context interface
// ---------------------------------------------------------------------------

/**
 * Context provided by WorkspaceIndex for dependency extraction.
 * All methods/properties are bound to the index instance.
 */
export interface DependencyContext {
  readonly resolver: ModuleResolver;
  readonly resolveImport: (importPath: string, fromUri: string) => Promise<string | null>;
  readonly resolveInherit: (pathText: string, isStringLiteral: boolean, fromUri: string) => Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Dependency extraction
// ---------------------------------------------------------------------------

/**
 * Pre-warm the ModuleResolver cache by resolving all inherit/import declarations.
 * Returns a map from (name, isStringLit) to resolved URI for use by extractDependencies.
 */
export async function warmResolverCache(
  ctx: DependencyContext,
  tree: Tree,
  uri: string,
): Promise<Map<string, string | null>> {
  const fromPath = uriToPathUtil(uri);
  const promises: { key: string; promise: Promise<import("./moduleResolver").ResolveResult | null> }[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walk = (node: any): void => {
    if (!node) return;
    if (node.type === 'inherit_decl' || node.type === 'import_decl') {
      const pathNode = node.childForFieldName('path');
      if (pathNode) {
        const name = pathNode.text;
        const isStringLit = name.startsWith('"') && name.endsWith('"');
        if (isStringLit) {
          promises.push({ key: `inh:${name}:true`, promise: ctx.resolver.resolveInherit(name, true, fromPath) });
        } else {
          promises.push({ key: `imp:${name}`, promise: ctx.resolver.resolveImport(name, fromPath) });
          promises.push({ key: `inh:${name}:false`, promise: ctx.resolver.resolveInherit(name, false, fromPath) });
        }
      }
    } else if (node.type === 'inherit') {
      const pathNode = node.childForFieldName('path');
      if (pathNode) {
        const name = pathNode.text;
        if (!name.startsWith('"')) {
          promises.push({ key: `imp:${name}`, promise: ctx.resolver.resolveImport(name, fromPath) });
          promises.push({ key: `inh:${name}:false`, promise: ctx.resolver.resolveInherit(name, false, fromPath) });
        }
      }
    }
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) walk(child);
    }
  };

  walk(tree.rootNode);

  // Bounded by function execution scope (evict-eligible on GC after return).
  const resolved = new Map<string, string | null>();
  const results = await Promise.all(promises.map(p => p.promise));
  for (let i = 0; i < promises.length; i++) {
    const uri = results[i]?.uri ?? null;
    resolved.set(promises[i].key, uri);
  }
  return resolved;
}

/**
 * Extract forward dependencies (inherit/import targets) from a symbol table.
 * Uses the pre-warmed cache from warmResolverCache to avoid double resolution.
 */
export async function extractDependencies(
  ctx: DependencyContext,
  table: SymbolTable,
  currentUri: string,
  warmCache: Map<string, string | null>,
): Promise<Set<string>> {
  const deps = new Set<string>();

  // Collect all inherit/import declarations and resolve them in parallel.
  const resolutions = table.declarations
    .filter(decl => decl.kind === "inherit" || decl.kind === "import")
    .map(async (decl): Promise<string | null> => {
      const isStringLit = decl.name.startsWith('"') && decl.name.endsWith('"');

      if (isStringLit) {
        const cached = warmCache.get(`inh:${decl.name}:true`);
        if (cached !== undefined) return cached;
        return ctx.resolveInherit(decl.name, true, currentUri);
      }

      const cachedImp = warmCache.get(`imp:${decl.name}`);
      const cachedInh = warmCache.get(`inh:${decl.name}:false`);
      if (cachedImp !== undefined || cachedInh !== undefined) {
        return cachedImp ?? cachedInh ?? null;
      }
      return (await ctx.resolveImport(decl.name, currentUri))
        ?? await ctx.resolveInherit(decl.name, false, currentUri);
    });

  const results = await Promise.all(resolutions);
  for (const targetUri of results) {
    if (targetUri && targetUri !== currentUri) {
      deps.add(targetUri);
    }
  }

  // Implicit dependency: files inside a Foo.pmod/ directory inherit from
  // Foo.pmod/module.pmod. This is Pike's directory module convention —
  // symbols in module.pmod are automatically visible to siblings.
  const directoryModule = await ctx.resolver.findDirectoryModulePmod(currentUri);
  if (directoryModule && directoryModule !== currentUri) {
    deps.add(directoryModule);
  }

  return deps;
}
