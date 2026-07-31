/**
 * Members a file-valued inherit contributes, following the chain.
 *
 * `inherit "global_variables";` names a whole FILE, and in Pike that file is
 * itself a program: everything it declares at top level becomes a member, and
 * so does everything *it* inherits. `roxen.pike` calls
 * `::remove_configuration(name)` whose declaration sits two files up, in
 * `read_config.pike`, reached through `global_variables.pike`.
 *
 * The single-file lookup this replaced stopped at the first hop, so a member
 * of any grandparent read as "does not exist".
 */

import type { CompletionItem } from "vscode-languageserver/node";
import type { SymbolTable, Declaration } from "./symbolTable";
import { getDeclarationsInScope } from "./symbolTable";
import { declToCompletionItem } from "./completion-items";

/**
 * How far the inherit chain is followed.
 *
 * Roxen's deepest run is four files (`roxen.pike` → `global_variables` →
 * `read_config` → `newdecode`); the bound exists so a cyclic or pathological
 * chain cannot stall a completion request, not because depth 8 is meaningful.
 */
const MAX_INHERIT_DEPTH = 8;

/** The index surface this module needs — a subset of WorkspaceIndex. */
export interface InheritFileIndex {
  getOrIndexSymbolTable(uri: string): Promise<SymbolTable | null>;
  resolveInherit(path: string, isString: boolean, from: string): Promise<string | null>;
}

/** True when an inherit path is a string literal, quotes included. */
export function isStringLiteralInherit(name: string): boolean {
  return name.length >= 2 && name.startsWith('"') && name.endsWith('"');
}

/**
 * Resolve an inherit path to a workspace file.
 *
 * String-literal paths must be resolved AS string literals: the resolver
 * treats `"global_variables"` and `global_variables` differently, and passing
 * a quoted path through the identifier route matched nothing at all.
 */
export async function resolveInheritTargetUri(
  index: InheritFileIndex,
  inheritPath: string,
  fromUri: string,
): Promise<string | null> {
  const asString = isStringLiteralInherit(inheritPath);
  const direct = await index.resolveInherit(inheritPath, asString, fromUri);
  if (direct) return direct;
  // A bare identifier can name a sibling FILE, not only a module: Pike
  // 8.0.1116 accepts `inherit base;` against a sibling `base.pike` and
  // resolves `::describe_base()` through it. The identifier route misses that
  // spelling on some layouts, so the same path is retried as a file name.
  return asString ? null : index.resolveInherit(`"${inheritPath}"`, true, fromUri);
}

/**
 * Completion items for every member a target FILE contributes, following that
 * file's own file-level inherits.
 *
 * Names already in `seenNames` are skipped, so a member declared closer to the
 * caller keeps its own entry — Pike resolves `::name` to the nearest
 * definition on the chain, and so does this.
 */
export async function collectFileInheritMembers(
  index: InheritFileIndex,
  targetUri: string,
  seenNames: Set<string>,
): Promise<CompletionItem[]> {
  const items: CompletionItem[] = [];
  const visited = new Set<string>();
  await collectInto(index, targetUri, seenNames, items, visited, 0);
  return items;
}

async function collectInto(
  index: InheritFileIndex,
  targetUri: string,
  seenNames: Set<string>,
  items: CompletionItem[],
  visited: Set<string>,
  depth: number,
): Promise<void> {
  if (depth > MAX_INHERIT_DEPTH || visited.has(targetUri)) return;
  visited.add(targetUri);

  const table = await index.getOrIndexSymbolTable(targetUri);
  if (!table) return;
  const fileScope = table.scopes.find(s => s.kind === "file");
  if (!fileScope) return;

  for (const decl of getDeclarationsInScope(table, fileScope.id)) {
    if (seenNames.has(decl.name)) continue;
    seenNames.add(decl.name);
    items.push(declToCompletionItem(decl, 0, table));
  }

  for (const next of fileLevelInheritPaths(table, fileScope.id)) {
    const nextUri = await resolveInheritTargetUri(index, next, targetUri);
    if (!nextUri) continue;
    await collectInto(index, nextUri, seenNames, items, visited, depth + 1);
  }
}

/** The inherit paths declared directly in a file's own top-level scope. */
export function fileLevelInheritPaths(table: SymbolTable, fileScopeId: number): string[] {
  const scope = table.scopeById.get(fileScopeId);
  if (!scope) return [];
  const paths: string[] = [];
  for (const declId of scope.declarations) {
    const decl: Declaration | undefined = table.declById.get(declId);
    if (decl?.kind === "inherit") paths.push(decl.name);
  }
  return paths;
}
