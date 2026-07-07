/**
 * Include wiring: merge the top-level symbols of `#include`d files into the
 * includer's file scope during symbol-table build.
 *
 * Preprocessor `#include` is textual — a header's top-level definitions become
 * part of the including file. We merge names (not full scopes), which is enough
 * for completion, hover, and go-to-definition (which jumps to the header via
 * `sourceUri`). Runs after wireInheritance and before the reference pass so
 * references can resolve to included symbols.
 */
import type { BuildIndex, DeclKind, Declaration, Scope, SymbolTable } from './symbolTable';

/** Declaration kinds a `#include`d file contributes to the includer. */
const MERGEABLE_INCLUDE_KINDS: ReadonlySet<DeclKind> = new Set<DeclKind>([
  'function', 'method', 'class', 'variable', 'constant',
  'enum', 'enum_member', 'typedef', 'macro',
]);

/**
 * Merge the top-level symbols of each `#include`d file into this file's file
 * scope.
 *
 * Each included file's own table was built with its includes already merged, so
 * merging one level deep yields transitive symbols. A per-target guard avoids
 * re-merging a file included twice, and a (kind,name,origin) guard dedups the
 * diamond case (two headers that both include a third).
 */
export function wireIncludes(
  table: SymbolTable,
  index?: BuildIndex,
  uri?: string,
): void {
  if (!index || !uri) return;

  const fileScope = table.scopes.find(s => s.kind === 'file');
  if (!fileScope) return;

  const includeDecls = fileScope.declarations
    .map(id => table.declById.get(id))
    .filter((d): d is Declaration => d?.kind === 'include');
  if (includeDecls.length === 0) return;

  let nextId = nextSyntheticId(table);
  const mergedTargets = new Set<string>([uri]); // self + duplicate-include guard
  const seen = new Set<string>();               // (kind,name,origin) diamond guard

  for (const inc of includeDecls) {
    const isSystem = inc.name.startsWith('<');
    const targetUri = index.resolveInclude(inc.name, isSystem, uri);
    if (!targetUri || mergedTargets.has(targetUri)) continue;
    mergedTargets.add(targetUri);

    const targetTable = index.getSymbolTable(targetUri);
    if (!targetTable) continue;

    nextId = mergeIncludedDeclarations(table, fileScope, targetTable, targetUri, seen, nextId);
  }
}

/**
 * Clone the mergeable top-level declarations of one included file into the
 * includer's file scope. Returns the next free synthetic ID. `seen` dedups the
 * diamond case across multiple includes.
 */
function mergeIncludedDeclarations(
  table: SymbolTable,
  fileScope: Scope,
  targetTable: SymbolTable,
  targetUri: string,
  seen: Set<string>,
  startId: number,
): number {
  const targetFileScope = targetTable.scopes.find(s => s.kind === 'file');
  if (!targetFileScope) return startId;

  let nextId = startId;
  for (const remoteId of targetFileScope.declarations) {
    const remote = targetTable.declById.get(remoteId);
    if (!remote || !MERGEABLE_INCLUDE_KINDS.has(remote.kind)) continue;

    // Follow the chain to the original defining file so go-to-definition lands
    // there even when the symbol was itself merged from a nested include.
    const origin = remote.sourceUri ?? targetUri;
    const key = `${remote.kind}:${remote.name}:${origin}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const d: Declaration = {
      id: nextId,
      name: remote.name,
      kind: remote.kind,
      nameRange: remote.nameRange,
      range: remote.range,
      scopeId: fileScope.id,
      declaredType: remote.declaredType,
      assignedType: remote.assignedType,
      functionLike: remote.functionLike,
      sourceUri: origin,
    };
    table.declarations.push(d);
    table.declById.set(nextId, d);
    fileScope.declarations.push(nextId);
    nextId++;
  }
  return nextId;
}

/** Next synthetic ID above every existing declaration and scope ID. */
function nextSyntheticId(table: SymbolTable): number {
  const maxDeclId = table.declarations.length > 0
    ? Math.max(...table.declarations.map(d => d.id))
    : -1;
  const maxScopeId = table.scopes.length > 0
    ? Math.max(...table.scopes.map(s => s.id))
    : -1;
  return Math.max(maxDeclId, maxScopeId) + 1;
}
