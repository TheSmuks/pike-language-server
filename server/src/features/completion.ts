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
  MarkupKind,
} from "vscode-languageserver/node";
import { type SymbolTable, type Declaration, getSymbolsInScope, getDeclarationsInScope, findClassScopeAt, resolveTypeName } from "./symbolTable";
import {
  type CompletionContext,
  type TriggerContext,
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
import { collectKeywordSnippets } from "./completion-keywords";
import { addStdlibMembers, addStdlibMembersByType, addResolvedMembers } from "./completion-stdlib-members";
import { buildAutodocCompletion } from "./completion-autodoc";
import { roxenCompletionCandidates } from "./roxenIndex";

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
  const lines = ctx.source.split("\n");

  // Autodoc-skeleton snippet: fires only when the cursor sits on an empty
  // `//!` line above a declaration. Cheap regex guard; returns null otherwise.
  const autodocItem = buildAutodocCompletion(table, line, character, ctx.source);
  if (autodocItem) return { isIncomplete: false, items: [autodocItem] };

  // LSP characters and tree-sitter columns are both UTF-16 code units.
  const pos = { row: line, column: character };

  // Get the node at or immediately before the cursor position
  let node = root.descendantForPosition(pos);
  if (!node) {
    return { isIncomplete: false, items: [] };
  }

  // Determine completion context
  const triggerContext = detectTriggerContext(node, line, character, tree, lines[line] ?? "");
  if (triggerContext.type === "none") return { isIncomplete: false, items: [] };

  const items = await completeForTrigger(triggerContext, table, tree, line, character, ctx, node);
  return { isIncomplete: items.length > 50, items };
}

/** Dispatch to the provider the detected trigger calls for. */
async function completeForTrigger(
  triggerContext: Exclude<TriggerContext, { type: "none" }>,
  table: SymbolTable,
  tree: Tree,
  line: number,
  character: number,
  ctx: CompletionContext,
  node: Node,
): Promise<CompletionItem[]> {
  switch (triggerContext.type) {
    case "dot":
      return completeDotAccess(table, tree, line, character, triggerContext.lhsNode, ctx);
    case "arrow":
      return completeArrowAccess(table, tree, line, character, triggerContext.lhsNode, ctx);
    case "scope":
      return completeScopeAccess(table, line, character, triggerContext.scopeNode, ctx);
    case "call_args": {
      const args = await completeCallArgs(table, tree, line, character, triggerContext.calleeName, ctx);
      // An unresolvable callee says nothing about the callee — it says nothing
      // about the argument the user is about to write either. The cursor is
      // still in expression position, so the symbols in scope remain the
      // answer; returning none of them is what made this position dead.
      if (args.length > 0) return args;
      return completeUnqualified(table, tree, line, character, ctx, node);
    }
    default:
      return completeUnqualified(table, tree, line, character, ctx, node);
  }
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

  collectLocalScopeItems(table, line, character, items, seenNames);
  await collectImportedItems(table, ctx, items, seenNames);
  await collectDirectoryModuleItems(ctx, items, seenNames);
  collectPredefBuiltinItems(ctx, items, seenNames);
  collectRoxenItems(ctx, items, seenNames);
  collectStdlibTopLevelItems(ctx, items, seenNames);
  collectKeywordSnippets(items, seenNames);
  await collectAutoImportItems(table, tree, ctx, node, items, seenNames);

  return items;
}

/** Add local scope symbols to the completion list. */
function collectLocalScopeItems(
  table: SymbolTable, line: number, character: number,
  items: CompletionItem[], seenNames: Set<string>,
): void {
  const localSymbols = getSymbolsInScope(table, line, character);
  for (const decl of localSymbols) {
    if (seenNames.has(decl.name)) continue;
    seenNames.add(decl.name);
    items.push(declToCompletionItem(decl, 0, table));
  }
}

/** Add symbols from inherited/imported files (cross-file). */
async function collectImportedItems(
  table: SymbolTable, ctx: CompletionContext,
  items: CompletionItem[], seenNames: Set<string>,
): Promise<void> {
  const importDecls = table.declarations.filter(d => d.kind === "inherit" || d.kind === "import");
  for (const importDecl of importDecls) {
    const targetUri = await ctx.index.resolveInherit(importDecl.name, false, ctx.uri);
    if (!targetUri) continue;
    const targetTable = await ctx.index.getOrIndexSymbolTable(targetUri);
    if (!targetTable) continue;
    const fileScope = targetTable.scopes.find(s => s.kind === "file");
    if (!fileScope) continue;
    const importedDecls = getDeclarationsInScope(targetTable, fileScope.id);
    for (const decl of importedDecls) {
      if (seenNames.has(decl.name)) continue;
      seenNames.add(decl.name);
      items.push(declToCompletionItem(decl, 20, targetTable));
    }
  }
}

/** Add symbols from implicit directory module.pmod. */
async function collectDirectoryModuleItems(
  ctx: CompletionContext,
  items: CompletionItem[], seenNames: Set<string>,
): Promise<void> {
  const directoryModule = await ctx.index.resolver.findDirectoryModulePmod(ctx.uri);
  if (!directoryModule) return;
  const moduleTable = await ctx.index.getOrIndexSymbolTable(directoryModule);
  if (!moduleTable) return;
  const fileScope = moduleTable.scopes.find(s => s.kind === "file");
  if (!fileScope) return;
  const moduleDecls = getDeclarationsInScope(moduleTable, fileScope.id);
  for (const decl of moduleDecls) {
    if (seenNames.has(decl.name)) continue;
    seenNames.add(decl.name);
    items.push(declToCompletionItem(decl, 15, moduleTable));
  }
}

/**
 * Add the bundled Roxen vocabulary to the completion list.
 *
 * Only in a Roxen file. This is the gate the activation spec's mixed-workspace
 * requirement rests on: a plain Pike program in the same workspace must be
 * offered no Roxen symbol, and `roxenActive` is false for it.
 *
 * Names already contributed by the workspace index are skipped via
 * `seenNames`, which is what makes a detected installation's real declaration
 * win over the bundled copy — real symbols are collected first.
 */
function collectRoxenItems(
  ctx: CompletionContext,
  items: CompletionItem[], seenNames: Set<string>,
): void {
  if (!ctx.roxenActive || !ctx.roxenIndex) return;

  for (const candidate of roxenCompletionCandidates(ctx.roxenIndex)) {
    if (seenNames.has(candidate.name)) continue;
    if (!isCompletableIdentifier(candidate.name)) continue;
    seenNames.add(candidate.name);
    items.push({
      label: candidate.name,
      kind: candidate.isConstant ? CompletionItemKind.Constant : CompletionItemKind.Method,
      detail: candidate.detail,
      documentation: candidate.documentation
        ? { kind: MarkupKind.Markdown, value: candidate.documentation }
        : undefined,
      // Below locals and imports, above stdlib: Roxen names are the vocabulary
      // of the file being edited, but a local declaration still outranks them.
      sortText: padSortKey(25) + candidate.name,
      filterText: candidate.name,
      data: { source: "roxen", name: candidate.name },
    });
  }
}

/** Add predef builtin functions to the completion list. */
function collectPredefBuiltinItems(
  ctx: CompletionContext,
  items: CompletionItem[], seenNames: Set<string>,
): void {
  for (const name of Object.keys(ctx.predefBuiltins)) {
    if (seenNames.has(name)) continue;
    if (!isCompletableIdentifier(name)) continue;
    seenNames.add(name);
    const autodoc = ctx.predefAutodoc[name];
    const builtinItem: CompletionItem = {
      label: name,
      kind: CompletionItemKind.Function,
      detail: autodoc?.signature ?? cleanPredefSignature(ctx.predefBuiltins[name]),
      sortText: padSortKey(30) + name,
      filterText: name,
      data: { source: "predef", name },
    };
    // Prefer named params from autodoc when available
    if (autodoc?.params && autodoc.params.length > 0) {
      const snippetParams = autodoc.params
        .map((p, i) => `\${${i + 1}:${p.name}}`)
        .join(", ");
      builtinItem.insertTextFormat = InsertTextFormat.Snippet;
      builtinItem.insertText = name + "(" + snippetParams + ")";
    } else {
      const predefParams = extractParamsFromPredefType(ctx.predefBuiltins[name]);
      if (predefParams !== null) {
        builtinItem.insertTextFormat = InsertTextFormat.Snippet;
        builtinItem.insertText = name + "(" + predefParams + ")";
      }
    }
    items.push(builtinItem);
  }
}

/** Add top-level stdlib modules/classes to the completion list. */
function collectStdlibTopLevelItems(
  ctx: CompletionContext,
  items: CompletionItem[], seenNames: Set<string>,
): void {
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
}

// ---------------------------------------------------------------------------
// Keyword / snippet completions
// ---------------------------------------------------------------------------

// collectKeywordSnippets imported from completion-keywords.ts

/** Add auto-import suggestions for identifiers that exist in stdlib modules. */
async function collectAutoImportItems(
  table: SymbolTable, tree: Tree, ctx: CompletionContext, node: Node,
  items: CompletionItem[], seenNames: Set<string>,
): Promise<void> {
  const existingInherits = new Set(
    table.declarations.filter(d => d.kind === "inherit").map(d => d.name),
  );
  const typedPrefix = node.type === "identifier" ? node.text : "";
  const prefixLower = typedPrefix.toLowerCase();
  if (prefixLower.length < 2) return;

  const matchingEntries = getAutoImportByPrefix(ctx.stdlibIndex, prefixLower);
  let autoImportCount = 0;
  const AUTO_IMPORT_CAP = 10;

  for (const [symbolName, candidates] of matchingEntries) {
    if (autoImportCount >= AUTO_IMPORT_CAP) break;
    if (seenNames.has(symbolName)) continue;

    for (const candidate of candidates) {
      if (autoImportCount >= AUTO_IMPORT_CAP) break;
      if (existingInherits.has(candidate.module)) continue;
      const insertLine = findInheritInsertLine(tree);
      items.push(buildAutoImportItem(candidate, insertLine));
      autoImportCount++;
    }
  }
}

/** Build a single auto-import completion item. */
function buildAutoImportItem(candidate: { name: string; kind: CompletionItemKind; module: string }, insertLine: number): CompletionItem {
  return {
    label: candidate.name,
    kind: candidate.kind,
    detail: `Auto-import from ${candidate.module}`,
    sortText: padSortKey(50) + candidate.name,
    filterText: candidate.name,
    data: { source: "autoimport", fqn: "predef." + candidate.module + "." + candidate.name, module: candidate.module, symbolName: candidate.name },
    additionalTextEdits: [
      {
        range: { start: { line: insertLine, character: 0 }, end: { line: insertLine, character: 0 } },
        newText: `inherit ${candidate.module};\n`,
      },
    ],
  };
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
 * 1. If lhs is a known module path → resolve via WorkspaceIndex
 * 2. If lhs is a known stdlib path → resolve via stdlib index
 * 3. If lhs is a declared variable with known type → resolve type to class scope
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

  await addWorkspaceModuleMembers(lhsNode.text, ctx, items, seenNames);
  addStdlibMembers(lhsNode.text, ctx, items, seenNames);

  // Type-resolved member access: resolves variable type → class members.
  // Also falls back to stdlib lookup using the resolved type name when
  // direct module-name matching fails (e.g., `Stdio.File f; f->` where
  // lhsText is "f" but the type is "Stdio.File").
  const resolvedDecl = await resolveChainedType(lhsNode, table, line, character, ctx);
  if (resolvedDecl && resolvedDecl.kind !== "inherit") {
    // Try stdlib children lookup by the resolved type's FQN.
    // resolveTypeMembers handles workspace class scope, but stdlib types
    // are not in the workspace — check the stdlib index explicitly.
    const typeName = resolveTypeName(resolvedDecl);
    if (typeName) {
      const before = items.length;
      addStdlibMembersByType(typeName, ctx, items, seenNames);
      // Runtime fallback: when the static stdlib index has no members for this
      // type, ask the Pike worker to enumerate them (e.g. `Image.Image`).
      if (items.length === before) {
        await addResolvedMembers(typeName, ctx, items, seenNames);
      }
    }

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

/** Strategy 1: Resolve lhs as a workspace module and collect its members. */
async function addWorkspaceModuleMembers(
  lhsText: string,
  ctx: CompletionContext,
  items: CompletionItem[],
  seenNames: Set<string>,
): Promise<void> {
  const wsTarget = await ctx.index.resolveModule(lhsText, ctx.uri);
  if (!wsTarget) return;

  const targetTable = await ctx.index.getOrIndexSymbolTable(wsTarget);
  if (!targetTable) return;

  const fileScope = targetTable.scopes.find(s => s.kind === "file");
  if (!fileScope) return;

  const decls = getDeclarationsInScope(targetTable, fileScope.id);
  for (const decl of decls) {
    if (seenNames.has(decl.name)) continue;
    seenNames.add(decl.name);
    items.push(declToCompletionItem(decl, 0, targetTable));
  }
}

/** Strategy 2 & 3b: imported from completion-stdlib-members.ts */
