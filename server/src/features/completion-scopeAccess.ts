/**
 * Scope access completion (:: operator).
 *
 * Extracted from completion.ts to reduce file size.
 */

import { Node } from "web-tree-sitter";
import { CompletionItem, CompletionItemKind } from "vscode-languageserver/node";
import type { SymbolTable } from "./symbolTable";
import { getDeclarationsInScope, findClassScopeAt } from "./symbolTable";
import { declToCompletionItem, cleanPredefSignature, padSortKey } from "./completion-items";
import { addStdlibMembersByType, addResolvedMembers } from "./completion-stdlib-members";
import { roxenInjectedGlobals } from "./roxenIndex";
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

/** Handle global:: — the file scope, whatever shadows it further in. */
function completeFileScope(table: SymbolTable, seenNames: Set<string>): CompletionItem[] {
  const fileScope = table.scopes.find(s => s.kind === "file");
  if (!fileScope) return [];

  const items: CompletionItem[] = [];
  for (const decl of getDeclarationsInScope(table, fileScope.id)) {
    if (seenNames.has(decl.name)) continue;
    seenNames.add(decl.name);
    items.push(declToCompletionItem(decl, 0, table));
  }
  return items;
}

/**
 * Handle predef:: — Pike's predefined namespace.
 *
 * A Roxen file reaches more through `predef::` than a plain Pike file does:
 * roxenloader adds `report_fatal` and its neighbours to that same namespace at
 * run time. Those come from the bundled Roxen index and only in a Roxen file,
 * so a plain Pike program still sees exactly what Pike predefines.
 */
function completePredefScope(ctx: CompletionContext, seenNames: Set<string>): CompletionItem[] {
  const items: CompletionItem[] = [];
  for (const name of Object.keys(ctx.predefBuiltins)) {
    if (seenNames.has(name)) continue;
    seenNames.add(name);
    items.push({
      label: name,
      kind: CompletionItemKind.Function,
      detail: cleanPredefSignature(ctx.predefBuiltins[name]),
      sortText: padSortKey(0) + name,
      filterText: name,
    });
  }

  if (!ctx.roxenActive || !ctx.roxenIndex) return items;
  for (const global of roxenInjectedGlobals(ctx.roxenIndex)) {
    if (seenNames.has(global.name)) continue;
    seenNames.add(global.name);
    items.push({
      label: global.name,
      kind: CompletionItemKind.Function,
      detail: global.detail,
      sortText: padSortKey(0) + global.name,
      filterText: global.name,
    });
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
  ctx: CompletionContext,
): Promise<CompletionItem[]> {
  const children = scopeNode.children;
  const hasIdentifier = children.some(c => c.type === "identifier");
  if (hasIdentifier) return [];

  const items: CompletionItem[] = [];
  const classScopeId = findClassScopeAt(table, line, character);
  if (classScopeId === null) return items;

  const classScope = table.scopeById.get(classScopeId);
  if (!classScope) return items;

  if (classScope.inheritedScopes.length > 0) {
    const firstInherited = classScope.inheritedScopes[0];
    const decls = getDeclarationsInScope(table, firstInherited);
    for (const decl of decls) {
      if (seenNames.has(decl.name)) continue;
      seenNames.add(decl.name);
      items.push(declToCompletionItem(decl, 0, table));
    }
    if (items.length > 0) return items;
  }

  // `inheritedScopes` only holds inherits wired to a class in this file. Roxen
  // inherits a cross-file module or a stdlib class far more often than a
  // sibling class — `class CacheStatsMIB { inherit SNMP.SimpleMIB; … ::create(…) }`
  // — and for those the list is empty, which read as "nothing to offer".
  const firstInherit = classScope.declarations
    .map(id => table.declById.get(id))
    .find(decl => decl?.kind === "inherit");
  if (!firstInherit) return items;

  return completeFromInheritDecl(firstInherit.name, table, classScopeId, seenNames, ctx);
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
  const targetTable = await ctx.index.getOrIndexSymbolTable(targetUri);
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
    return completeFromInheritDecl(decl.name, table, classScopeId, seenNames, ctx);
  }

  return items;
}

/**
 * Members of whatever an inherit names, wherever it lives.
 *
 * Four tiers, most specific first: a workspace file the index resolves, a
 * class declared in this file, the static stdlib index, and finally the Pike
 * worker's runtime resolve for types the static index does not carry
 * (`SNMP.SimpleMIB`, `Image.Image`). Only the first two existed, so an inherit
 * of anything outside the workspace completed to nothing.
 */
async function completeFromInheritDecl(
  inheritName: string,
  table: SymbolTable,
  classScopeId: number,
  seenNames: Set<string>,
  ctx: CompletionContext,
): Promise<CompletionItem[]> {
  const items: CompletionItem[] = [];

  const targetUri = await ctx.index.resolveInherit(inheritName, false, ctx.uri);
  if (targetUri) {
    items.push(...await collectFromResolvedTarget({ name: inheritName }, targetUri, ctx, seenNames, table));
  }

  items.push(...collectFromSameFileInheritance(classScopeId, inheritName, table, seenNames));
  if (items.length > 0) return items;

  addStdlibMembersByType(inheritName, ctx, items, seenNames);
  if (items.length > 0) return items;

  await addResolvedMembers(inheritName, ctx, items, seenNames);
  return items;
}

/**
 * The qualifier name a scope node names, without the `::`.
 *
 * The node arrives in two shapes. A half-typed `Base::` does not parse, so the
 * trigger falls back to a lexical scan and hands over the bare identifier
 * `Base`. A complete `A::value()` parses, and the trigger hands over the
 * `inherit_specifier`, whose text is `A::` — which matches no inherit named
 * `A` and is why qualified completion found nothing on anything that parsed.
 */
function qualifierName(scopeNode: Node): string {
  if (scopeNode.type !== "inherit_specifier") return scopeNode.text;
  for (const child of scopeNode.children) {
    if (child.type === "identifier") return child.text;
  }
  return scopeNode.text.replace(/::$/, "");
}

export async function completeScopeAccess(
  table: SymbolTable,
  line: number,
  character: number,
  scopeNode: Node,
  ctx: CompletionContext,
): Promise<CompletionItem[]> {
  const seenNames = new Set<string>();
  const scopeText = qualifierName(scopeNode);

  if (scopeText === "local") {
    return completeLocalScope(table, line, character, seenNames);
  }

  // `global::` names the file scope, which is what the reference collector
  // already resolves it to (see resolveGlobalScopeAccess). Completion did not
  // know the keyword, looked for an inherit named `global`, and found none.
  if (scopeText === "global") {
    return completeFileScope(table, seenNames);
  }

  // `predef::` names Pike's predefined namespace. Without this the qualifier
  // fell through to the inherit search, which looked for something the file
  // inherits called `predef` and of course found none.
  if (scopeText === "predef") {
    return completePredefScope(ctx, seenNames);
  }

  if (scopeText === "::" || scopeNode.type === "inherit_specifier") {
    const bare = await completeBareScope(table, line, character, scopeNode, seenNames, ctx);
    if (bare.length > 0) return bare;
  }

  return completeIdentifierScope(scopeText, table, line, character, seenNames, ctx);
}
