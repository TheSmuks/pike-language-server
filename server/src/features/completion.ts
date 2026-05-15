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
  InsertTextFormat,
} from "vscode-languageserver/node";
import { type SymbolTable, type Declaration, getSymbolsInScope, getDeclarationsInScope, findClassScopeAt } from "./symbolTable";
import {
  type CompletionContext,
  detectTriggerContext,
  resetCompletionCache,
} from "./completionTrigger";
import {
  getStdlibChildrenMap,
  getStdlibTopLevel,
  isCompletableIdentifier,
  getAutoImportByPrefix,
} from "./completion-stdlib";
import {
  resolveTypeMembers,
  declToCompletionItem,
  padSortKey,
  findDeclarationForName,
  cleanPredefSignature,
  extractParamsFromPredefType,
  extractParamsFromStdlibSignature,
  extractConstructorParams,
  extractParamsFromType,
} from "./completion-items";
import { resolveChainedType } from "./completion-chain";
import { completeScopeAccess } from "./completion-scopeAccess";
import { completeCallArgs } from "./completion-callArgs";
import { utf16ToUtf8 } from "../util/positionConverter";

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
  // Convert LSP character (UTF-16) to tree-sitter column (UTF-8 byte offset)
  const lines = ctx.source.split("\n");
  const utf8Col = utf16ToUtf8(lines[line] ?? "", character);
  const pos = { row: line, column: utf8Col };

  // Get the node at or immediately before the cursor position
  let node = root.descendantForPosition(pos);
  if (!node) {
    return { isIncomplete: false, items: [] };
  }

  // Determine completion context
  const triggerContext = detectTriggerContext(node, line, character, tree, lines[line] ?? "");

  let items: CompletionItem[];

  switch (triggerContext.type) {
    case "dot":
      items = await completeDotAccess(table, tree, line, character, triggerContext.lhsNode, ctx);
      break;
    case "arrow":
      items = await completeArrowAccess(table, tree, line, character, triggerContext.lhsNode, ctx);
      break;
    case "scope":
      items = await completeScopeAccess(table, line, character, triggerContext.scopeNode, ctx);
      break;
    case "call_args":
      items = await completeCallArgs(table, tree, line, character, triggerContext.calleeName, ctx);
      break;
    case "unqualified":
    default:
      items = await completeUnqualified(table, tree, line, character, ctx, node);
      break;
  }

  return { isIncomplete: items.length > 50, items };
}

// ---------------------------------------------------------------------------
// Unqualified completion
// ---------------------------------------------------------------------------

/**
 * Find the line number where a new `inherit` statement should be inserted.
 *
 * Strategy: insert after the last existing inherit/import declaration.
 * If no inherits exist, insert at line 0 (before any code).
 *
 * Pike wraps inherit/import in `declaration` nodes containing `inherit_decl`
 * or `import_decl` children.
 */
function findInheritInsertLine(tree: Tree): number {
  const root = tree.rootNode;
  let lastInheritLine = -1;

  for (let i = 0; i < root.childCount; i++) {
    const child = root.child(i);
    if (!child) continue;
    // Pike wraps inherit/import in `declaration` nodes.
    if (child.type === "declaration") {
      const inner = child.child(0);
      if (inner && (inner.type === "inherit_decl" || inner.type === "import_decl")) {
        const endLine = child.endPosition.row;
        if (endLine > lastInheritLine) {
          lastInheritLine = endLine;
        }
      }
    }
  }

  // Insert after the last inherit, or at line 0 if none found.
  return lastInheritLine >= 0 ? lastInheritLine + 1 : 0;
}

async function completeUnqualified(
  table: SymbolTable,
  tree: Tree,
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
    items.push(declToCompletionItem(decl, 0, table));
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
      items.push(declToCompletionItem(decl, 20, targetTable));
    }
  }

  // 2b. Implicit directory module.pmod — files inside Foo.pmod/ see symbols
  // from Foo.pmod/module.pmod without explicit inherit/import.
  const directoryModule = await ctx.index.resolver.findDirectoryModulePmod(ctx.uri);
  if (directoryModule) {
    const moduleTable = ctx.index.getSymbolTable(directoryModule);
    if (moduleTable) {
      const fileScope = moduleTable.scopes.find(s => s.kind === "file");
      if (fileScope) {
        const moduleDecls = getDeclarationsInScope(moduleTable, fileScope.id);
        for (const decl of moduleDecls) {
          if (seenNames.has(decl.name)) continue;
          seenNames.add(decl.name);
          items.push(declToCompletionItem(decl, 15, moduleTable));
        }
      }
    }
  }

  // 3. Predef builtins (skip operator-like backtick identifiers)
  for (const name of Object.keys(ctx.predefBuiltins)) {
    if (seenNames.has(name)) continue;
    // Skip Pike operator identifiers (backtick-prefixed, operators, brackets)
    if (!isCompletableIdentifier(name)) continue;
    seenNames.add(name);
    const builtinItem: CompletionItem = {
      label: name,
      kind: CompletionItemKind.Function,
      detail: cleanPredefSignature(ctx.predefBuiltins[name]),
      sortText: padSortKey(30) + name,
      // filterText: plain identifier so VSCode fuzzy-matches correctly
      // even though detail contains a full signature.
      filterText: name,
    };
    // Add argument snippet for predef builtins
    const predefParams = extractParamsFromPredefType(ctx.predefBuiltins[name]);
    if (predefParams !== null) {
      builtinItem.insertTextFormat = InsertTextFormat.Snippet;
      builtinItem.insertText = name + "(" + predefParams + ")";
    }
    items.push(builtinItem);
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
      filterText: name,
    });
  }

  // 5. Auto-import suggestions (F5)
  // When the user types an identifier that exists in a stdlib module but is
  // not yet imported, offer it with an additionalTextEdits that inserts
  // `inherit Module;` at the top of the file.
  const existingInherits = new Set(
    table.declarations
      .filter(d => d.kind === "inherit")
      .map(d => d.name),
  );

  // The node at cursor is the partial identifier being typed.
  const typedPrefix = node.type === "identifier" ? node.text : "";
  const prefixLower = typedPrefix.toLowerCase();

  if (prefixLower.length >= 2) {
    const matchingEntries = getAutoImportByPrefix(ctx.stdlibIndex, prefixLower);
    // Cap auto-import results to avoid flooding the completion list.
    let autoImportCount = 0;
    const AUTO_IMPORT_CAP = 10;

    for (const [symbolName, candidates] of matchingEntries) {
      if (autoImportCount >= AUTO_IMPORT_CAP) break;
      // Skip symbols already available in the completion list
      if (seenNames.has(symbolName)) continue;

      for (const candidate of candidates) {
        if (autoImportCount >= AUTO_IMPORT_CAP) break;
        // Skip if module is already inherited
        if (existingInherits.has(candidate.module)) continue;

        const insertLine = findInheritInsertLine(tree);

        items.push({
          label: candidate.name,
          kind: candidate.kind,
          detail: `Auto-import from ${candidate.module}`,
          sortText: padSortKey(50) + candidate.name,
          filterText: candidate.name,
          data: { source: "autoimport", fqn: "predef." + candidate.module + "." + candidate.name, module: candidate.module, symbolName: candidate.name },
          additionalTextEdits: [
            {
              range: {
                start: { line: insertLine, character: 0 },
                end: { line: insertLine, character: 0 },
              },
              newText: `inherit ${candidate.module};\n`,
            },
          ],
        });
        autoImportCount++;
      }
    }
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
          items.push(declToCompletionItem(decl, 0, targetTable));
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
      const memberItem: CompletionItem = {
        label: member.name,
        kind: member.kind,
        detail: member.signature || undefined,
        sortText: padSortKey(10) + member.name,
        filterText: member.name,
        data: { source: "stdlib", fqn: member.fqn },
      };
      // Add argument snippet for stdlib methods/functions
      if (member.signature && (member.kind === CompletionItemKind.Method || member.kind === CompletionItemKind.Function)) {
        const stdlibParams = extractParamsFromStdlibSignature(member.signature);
        if (stdlibParams !== null) {
          memberItem.insertTextFormat = InsertTextFormat.Snippet;
          memberItem.insertText = member.name + "(" + stdlibParams + ")";
        }
      }
      items.push(memberItem);
    }
  }

  // Strategy 3: Resolve the type of the LHS expression.
  //
  // For simple identifiers (variable, parameter, function), look up the
  // declaration and resolve its declared/assigned type.
  // For chained calls (getContainer()->getItem()->), walk the postfix_expr
  // chain left-to-right, resolving the return type at each step.
  //
  // postfix_expr chain structure:
  //   postfix_expr
  //     postfix_expr
  //       postfix_expr
  //         primary_expr "getContainer"
  //       -> "getItem"
  //     ( argument_list )
  //
  // The rightmost call's return type is what we need.
  const resolvedDecl = await resolveChainedType(lhsNode, table, line, character, ctx);
  if (resolvedDecl && resolvedDecl.kind !== "inherit") {
    const typeMembers = await resolveTypeMembers(resolvedDecl, table, ctx);
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
