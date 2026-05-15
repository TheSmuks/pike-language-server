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

export async function completeScopeAccess(
  table: SymbolTable,
  line: number,
  character: number,
  scopeNode: Node,
  ctx: CompletionContext,
): Promise<CompletionItem[]> {
  const items: CompletionItem[] = [];
  const seenNames = new Set<string>();
  const scopeText = scopeNode.text;

  // local:: — complete from enclosing class + inherited
  if (scopeText === "local") {
    const classScopeId = findClassScopeAt(table, line, character);
    if (classScopeId !== null) {
      const classScope = table.scopeById.get(classScopeId);
      if (classScope) {
        const decls = getDeclarationsInScope(table, classScopeId);
        for (const decl of decls) {
          if (seenNames.has(decl.name)) continue;
          seenNames.add(decl.name);
          items.push(declToCompletionItem(decl, 0, table));
        }
      }
    }
    return items;
  }

  // Bare :: — first inherited class
  if (scopeText === "::" || scopeNode.type === "inherit_specifier") {
    // Check if this is a bare :: (no identifier before it)
    const children = scopeNode.children;
    const hasIdentifier = children.some(c => c.type === "identifier");
    if (!hasIdentifier) {
      // Bare :: — members of first inherited class
      const classScopeId = findClassScopeAt(table, line, character);
      if (classScopeId !== null) {
        const classScope = table.scopeById.get(classScopeId);
        if (classScope && classScope.inheritedScopes.length > 0) {
          const firstInherited = classScope.inheritedScopes[0];
          const decls = getDeclarationsInScope(table, firstInherited);
          for (const decl of decls) {
            if (seenNames.has(decl.name)) continue;
            seenNames.add(decl.name);
            items.push(declToCompletionItem(decl, 0, table));
          }
        }
      }
      return items;
    }
  }

  // Identifier:: — resolve identifier to inherit declaration
  const inheritName = scopeText;
  // Find the inherit declaration with this name/alias in the enclosing class
  const classScopeId = findClassScopeAt(table, line, character);
  if (classScopeId !== null) {
    const classScope = table.scopeById.get(classScopeId);
    if (classScope) {
      // Find the inherit declaration
      for (const declId of classScope.declarations) {
        const decl = table.declById.get(declId);
        if (decl && (decl.kind === "inherit" || decl.kind === "import") && (decl.name === inheritName || decl.alias === inheritName)) {
          // Resolve to target
          const targetUri = await ctx.index.resolveInherit(decl.name, false, ctx.uri);
          if (targetUri) {
            const targetTable = ctx.index.getSymbolTable(targetUri);
            if (targetTable) {
              const fileScope = targetTable.scopes.find(s => s.kind === "file");
              if (fileScope) {
                const targetDecls = getDeclarationsInScope(targetTable, fileScope.id);
                for (const td of targetDecls) {
                  if (seenNames.has(td.name)) continue;
                  seenNames.add(td.name);
                  items.push(declToCompletionItem(td, 0, targetTable));
                }
              }
            }
          }
          // Also check same-file inheritance
          for (const inheritedId of classScope.inheritedScopes) {
            const inheritedScope = table.scopeById.get(inheritedId);
            if (inheritedScope) {
              const parentScope = inheritedScope.parentId !== null ? table.scopeById.get(inheritedScope.parentId) : undefined;
              if (parentScope) {
                for (const parentDeclId of parentScope.declarations) {
                  const parentDecl = table.declById.get(parentDeclId);
                  if (parentDecl && parentDecl.kind === "class" && parentDecl.name === decl.name) {
                    const targetDecls = getDeclarationsInScope(table, inheritedId);
                    for (const td of targetDecls) {
                      if (seenNames.has(td.name)) continue;
                      seenNames.add(td.name);
                      items.push(declToCompletionItem(td, 5, table));
                    }
                  }
                }
              }
            }
          }
          break;
        }
      }
    }
  }

  return items;
}
