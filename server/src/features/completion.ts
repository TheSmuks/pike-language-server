/**
 * Completion provider for Pike LSP.
 *
 * Design: decision 0012.
 * Sources: symbol table (local scope), WorkspaceIndex (cross-file),
 * stdlib index (pre-built), predef builtins (pre-built).
 * No Pike worker dependency in the common case (~93% of completions).
 */

import { Tree, Node } from "web-tree-sitter";
import {
  CompletionItem,
  CompletionItemKind,
  CompletionList,
} from "vscode-languageserver/node";
import {
  type SymbolTable,
  getSymbolsInScope,
  getDeclarationsInScope,
  findClassScopeAt,
  PRIMITIVE_TYPES,
} from "./symbolTable";
import {
  type CompletionContext,
  type TriggerContext,
  detectTriggerContext,
  getStdlibChildrenMap,
  getStdlibTopLevel,
  isCompletableIdentifier,
  declToCompletionItem,
  padSortKey,
  findDeclarationForName,
  resolveTypeMembers,
  cleanPredefSignature,
  resetCompletionCache,
} from "./completionTrigger";

// Re-export for backward compatibility
export { type CompletionContext, resetCompletionCache } from "./completionTrigger";

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Get completions at a given position.
 */
export async function getCompletions(
  table: SymbolTable,
  tree: Tree,
  line: number,
  character: number,
  ctx: CompletionContext,
): Promise<CompletionList> {
  const root = tree.rootNode;
  // Position in tree-sitter is 0-indexed
  const pos = { row: line, column: character };

  // Get the node at or immediately before the cursor position
  let node = root.descendantForPosition(pos);
  if (!node) {
    return { isIncomplete: false, items: [] };
  }

  // Determine completion context
  const triggerContext = detectTriggerContext(node, line, character, tree);

  let items: CompletionItem[];

  switch (triggerContext.type) {
    case "dot":
      items = await completeDotAccess(table, tree, line, character, triggerContext.lhsNode, ctx);
      break;
    case "arrow":
      items = await completeArrowAccess(table, tree, line, character, triggerContext.lhsNode, ctx);
      break;
    case "scope":
      items = await completeScopeAccess(table, tree, line, character, triggerContext.scopeNode, ctx);
      break;
    case "unqualified":
    default:
      items = await completeUnqualified(table, line, character, ctx, node);
      break;
  }

  return { isIncomplete: items.length > 50, items };
}

// ---------------------------------------------------------------------------
// Unqualified completion
// ---------------------------------------------------------------------------

async function completeUnqualified(
  table: SymbolTable,
  line: number,
  character: number,
  ctx: CompletionContext,
  node: Node,
): Promise<CompletionItem[]> {
  const items: CompletionItem[] = [];
  const seenNames = new Set<string>();

  // 1. Local scope symbols
  const localSymbols = getSymbolsInScope(table, line, character);
  for (const decl of localSymbols) {
    if (seenNames.has(decl.name)) continue;
    seenNames.add(decl.name);
    items.push(declToCompletionItem(decl, 0));
  }

  // 2. Imported symbols (cross-file)
  const importDecls = table.declarations.filter(d => d.kind === "inherit" || d.kind === "import");
  for (const importDecl of importDecls) {
    const targetUri = await ctx.index.resolveInherit(importDecl.name, false, ctx.uri);
    if (!targetUri) continue;
    const targetTable = ctx.index.getSymbolTable(targetUri);
    if (!targetTable) continue;
    // Get top-level declarations from the imported file
    const fileScope = targetTable.scopes.find(s => s.kind === "file");
    if (!fileScope) continue;
    const importedDecls = getDeclarationsInScope(targetTable, fileScope.id);
    for (const decl of importedDecls) {
      if (seenNames.has(decl.name)) continue;
      seenNames.add(decl.name);
      items.push(declToCompletionItem(decl, 20));
    }
  }

  // 3. Predef builtins (skip operator-like backtick identifiers)
  for (const name of Object.keys(ctx.predefBuiltins)) {
    if (seenNames.has(name)) continue;
    // Skip Pike operator identifiers (backtick-prefixed, operators, brackets)
    if (!isCompletableIdentifier(name)) continue;
    seenNames.add(name);
    items.push({
      label: name,
      kind: CompletionItemKind.Function,
      detail: cleanPredefSignature(ctx.predefBuiltins[name]),
      sortText: padSortKey(30) + name,
    });
  }

  // 4. Top-level stdlib modules/classes
  const stdlibTopLevel = getStdlibTopLevel(ctx.stdlibIndex);
  for (const { name, kind } of stdlibTopLevel) {
    if (seenNames.has(name)) continue;
    seenNames.add(name);
    items.push({
      label: name,
      kind,
      sortText: padSortKey(40) + name,
    });
  }

  return items;
}

// ---------------------------------------------------------------------------
// Dot / arrow access completion
// ---------------------------------------------------------------------------

async function completeDotAccess(
  table: SymbolTable,
  tree: Tree,
  line: number,
  character: number,
  lhsNode: Node,
  ctx: CompletionContext,
): Promise<CompletionItem[]> {
  return completeMemberAccess(table, tree, line, character, lhsNode, ctx, "dot");
}

async function completeArrowAccess(
  table: SymbolTable,
  tree: Tree,
  line: number,
  character: number,
  lhsNode: Node,
  ctx: CompletionContext,
): Promise<CompletionItem[]> {
  return completeMemberAccess(table, tree, line, character, lhsNode, ctx, "arrow");
}
/**
 * Complete member access after '.' or '->'.
 *
 * Strategies:
 * 1. If lhs is a known module path (e.g., Stdio.File) → resolve via WorkspaceIndex + stdlib
 * 2. If lhs is a declared variable with known type → resolve type to class scope
 * 3. If lhs is a class name → enumerate class members
 */
async function completeMemberAccess(
  table: SymbolTable,
  tree: Tree,
  line: number,
  character: number,
  lhsNode: Node,
  ctx: CompletionContext,
  accessType: "dot" | "arrow",
): Promise<CompletionItem[]> {
  const items: CompletionItem[] = [];
  const seenNames = new Set<string>();
  const lhsText = lhsNode.text;

  // Strategy 1: lhs is a module/class name — check workspace index then stdlib
  const wsTarget = await ctx.index.resolveModule(lhsText, ctx.uri);
  if (wsTarget) {
    const targetTable = ctx.index.getSymbolTable(wsTarget);
    if (targetTable) {
      const fileScope = targetTable.scopes.find(s => s.kind === "file");
      if (fileScope) {
        const decls = getDeclarationsInScope(targetTable, fileScope.id);
        for (const decl of decls) {
          if (seenNames.has(decl.name)) continue;
          seenNames.add(decl.name);
          items.push(declToCompletionItem(decl, 0));
        }
      }
    }
  }

  // Strategy 2: Check stdlib index for this prefix
  const stdlibPrefix = "predef." + lhsText;
  const childrenMap = getStdlibChildrenMap(ctx.stdlibIndex);
  const stdlibMembers = childrenMap.get(stdlibPrefix);
  if (stdlibMembers) {
    for (const member of stdlibMembers) {
      if (seenNames.has(member.name)) continue;
      seenNames.add(member.name);
      items.push({
        label: member.name,
        kind: member.kind,
        detail: member.signature || undefined,
        sortText: padSortKey(10) + member.name,
      });
    }
  }

  // Strategy 3: lhs is a declared variable/function — resolve its type
  // For function calls (e.g., makeDog()->), extract the function name
  let lookupName = lhsText;
  if (lhsNode.type === 'postfix_expr' && lhsText.endsWith('()')) {
    // Function call — extract the innermost identifier
    const innerIdent = lhsNode.child(0);
    if (innerIdent) {
      // Drill down to the identifier inside the call expression
      let nameNode = innerIdent;
      while (nameNode.childCount > 0 && nameNode.type !== 'identifier') {
        nameNode = nameNode.child(0)!;
      }
      if (nameNode.type === 'identifier') {
        lookupName = nameNode.text;
      }
    }
  }
  const lhsDecl = findDeclarationForName(table, lookupName, line, character);
  if (lhsDecl && lhsDecl.kind !== "inherit") {
    // Try to resolve the declared type
    const typeMembers = await resolveTypeMembers(lhsDecl, table, ctx);
    for (const item of typeMembers) {
      if (seenNames.has(item.label)) continue;
      seenNames.add(item.label);
      items.push(item);
    }
  }

  // Dot access hides private members (Pike convention: __ prefix).
  // Arrow access (->) shows all members, including private.
  if (accessType === "dot") {
    return items.filter(item => !item.label.startsWith("__"));
  }
  return items;
}

// ---------------------------------------------------------------------------
// Scope access completion (:: )
// ---------------------------------------------------------------------------

async function completeScopeAccess(
  table: SymbolTable,
  tree: Tree,
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
          items.push(declToCompletionItem(decl, 0));
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
            items.push(declToCompletionItem(decl, 0));
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
                  items.push(declToCompletionItem(td, 0));
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
                      items.push(declToCompletionItem(td, 5));
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
