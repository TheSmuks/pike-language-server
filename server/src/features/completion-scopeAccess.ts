/**
 * Scope access completion (:: operator).
 *
 * Extracted from completion.ts to reduce file size.
 */

import { Node } from "web-tree-sitter";
import { CompletionItem } from "vscode-languageserver/node";
import type { SymbolTable } from "./symbolTable";
import { getDeclarationsInScope, findClassScopeAt } from "./symbolTable";
import { declToCompletionItem } from "./completion-items";
import type { CompletionContext } from "./completionTrigger";

// ---------------------------------------------------------------------------
// Scope access completion (:: )
// ---------------------------------------------------------------------------

/** Handle local:: — gather declarations from enclosing class scope. */
async function completeLocalScope(
  table: SymbolTable,
  line: number,
  character: number,
  seenNames: Set<string>,
): Promise<CompletionItem[]> {
  const items: CompletionItem[] = [];
  const classScopeId = findClassScopeAt(table, line, character);
  if (classScopeId === null) return items;

  const classScope = table.scopeById.get(classScopeId);
  if (!classScope) return items;

  const decls = getDeclarationsInScope(table, classScopeId);
  for (const decl of decls) {
    if (seenNames.has(decl.name)) continue;
    seenNames.add(decl.name);
    items.push(declToCompletionItem(decl, 0, table));
  }
  return items;
}

/** Handle bare :: (no identifier before it) — first inherited class. */
async function completeBareScope(
  table: SymbolTable,
  line: number,
  character: number,
  scopeNode: Node,
  seenNames: Set<string>,
): Promise<CompletionItem[]> {
  const children = scopeNode.children;
  const hasIdentifier = children.some(c => c.type === "identifier");
  if (hasIdentifier) return [];

  const items: CompletionItem[] = [];
  const classScopeId = findClassScopeAt(table, line, character);
  if (classScopeId === null) return items;

  const classScope = table.scopeById.get(classScopeId);
  if (!classScope || classScope.inheritedScopes.length === 0) return items;

  const firstInherited = classScope.inheritedScopes[0];
  const decls = getDeclarationsInScope(table, firstInherited);
  for (const decl of decls) {
    if (seenNames.has(decl.name)) continue;
    seenNames.add(decl.name);
    items.push(declToCompletionItem(decl, 0, table));
  }
  return items;
}

/** Try to collect declarations from a resolved inherit target. */
async function collectFromResolvedTarget(
  decl: { name: string; alias?: string },
  targetUri: string,
  ctx: CompletionContext,
  seenNames: Set<string>,
  table: SymbolTable,
): Promise<CompletionItem[]> {
  const items: CompletionItem[] = [];
  const targetTable = ctx.index.getSymbolTable(targetUri);
  if (!targetTable) return items;

  const fileScope = targetTable.scopes.find(s => s.kind === "file");
  if (!fileScope) return items;

  const decls = getDeclarationsInScope(targetTable, fileScope.id);
  for (const td of decls) {
    if (seenNames.has(td.name)) continue;
    seenNames.add(td.name);
    items.push(declToCompletionItem(td, 0, targetTable));
  }
  return items;
}

/** Collect declarations from same-file inheritance chain. */
function collectFromSameFileInheritance(
  classScopeId: number,
  inheritName: string,
  table: SymbolTable,
  seenNames: Set<string>,
): CompletionItem[] {
  const items: CompletionItem[] = [];
  const classScope = table.scopeById.get(classScopeId);
  if (!classScope) return items;

  for (const inheritedId of classScope.inheritedScopes) {
    const inheritedScope = table.scopeById.get(inheritedId);
    if (!inheritedScope) continue;
    const parentScope = inheritedScope.parentId !== null
      ? table.scopeById.get(inheritedScope.parentId)
      : undefined;
    if (!parentScope) continue;
    for (const parentDeclId of parentScope.declarations) {
      const parentDecl = table.declById.get(parentDeclId);
      if (parentDecl && parentDecl.kind === "class" && parentDecl.name === inheritName) {
        const targetDecls = getDeclarationsInScope(table, inheritedId);
        for (const td of targetDecls) {
          if (seenNames.has(td.name)) continue;
          seenNames.add(td.name);
          items.push(declToCompletionItem(td, 5, table));
        }
      }
    }
  }
  return items;
}

/** Handle Identifier:: — resolve to inherit/import and gather declarations. */
async function completeIdentifierScope(
  inheritName: string,
  table: SymbolTable,
  line: number,
  character: number,
  seenNames: Set<string>,
  ctx: CompletionContext,
): Promise<CompletionItem[]> {
  const items: CompletionItem[] = [];
  const classScopeId = findClassScopeAt(table, line, character);
  if (classScopeId === null) return items;

  const classScope = table.scopeById.get(classScopeId);
  if (!classScope) return items;

  for (const declId of classScope.declarations) {
    const decl = table.declById.get(declId);
    if (!decl || (decl.kind !== "inherit" && decl.kind !== "import")) continue;
    if (decl.name !== inheritName && decl.alias !== inheritName) continue;

    // Try resolving through index
    const targetUri = await ctx.index.resolveInherit(decl.name, false, ctx.uri);
    if (targetUri) {
      const fromTarget = await collectFromResolvedTarget(decl, targetUri, ctx, seenNames, table);
      items.push(...fromTarget);
    }

    // Also check same-file inheritance
    const fromInherit = collectFromSameFileInheritance(classScopeId, decl.name, table, seenNames);
    items.push(...fromInherit);
    break;
  }

  return items;
}

export async function completeScopeAccess(
  table: SymbolTable,
  line: number,
  character: number,
  scopeNode: Node,
  ctx: CompletionContext,
): Promise<CompletionItem[]> {
  const seenNames = new Set<string>();
  const scopeText = scopeNode.text;

  if (scopeText === "local") {
    return completeLocalScope(table, line, character, seenNames);
  }

  if (scopeText === "::" || scopeNode.type === "inherit_specifier") {
    const bare = await completeBareScope(table, line, character, scopeNode, seenNames);
    if (bare.length > 0) return bare;
  }

  return completeIdentifierScope(scopeText, table, line, character, seenNames, ctx);
}
