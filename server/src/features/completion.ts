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
import { type SymbolTable, type Declaration, getSymbolsInScope, getDeclarationsInScope, findClassScopeAt, resolveTypeName } from "./symbolTable";
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
    case "none":
      return { isIncomplete: false, items: [] };
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

  collectLocalScopeItems(table, line, character, items, seenNames);
  await collectImportedItems(table, ctx, items, seenNames);
  await collectDirectoryModuleItems(ctx, items, seenNames);
  collectPredefBuiltinItems(ctx, items, seenNames);
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
    const targetTable = ctx.index.getSymbolTable(targetUri);
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
  const moduleTable = ctx.index.getSymbolTable(directoryModule);
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

/**
 * Pike keywords with snippet bodies for control flow and declarations.
 *
 * Only keywords that produce useful snippet expansions are included here.
 * Bare type keywords (int, string, array, ...) and modifiers (private, static, ...)
 * are excluded — they are too short to benefit from snippets and would pollute
 * the completion list without adding value over plain typing.
 *
 * Source: Pike lexer src/lexer.h keyword switch + Pike manual ch2-7.
 */
const KEYWORD_SNIPPETS: ReadonlyArray<{
  label: string;
  insertText: string;
  detail: string;
}> = [
  // Control flow — most common, highest utility.
  { label: "if", insertText: "if (${1:condition}) {\n\t$0\n}", detail: "if statement" },
  { label: "else", insertText: "else {\n\t$0\n}", detail: "else block" },
  { label: "else if", insertText: "else if (${1:condition}) {\n\t$0\n}", detail: "else-if chain" },
  { label: "for", insertText: "for (${1:init}; ${2:condition}; ${3:update}) {\n\t$0\n}", detail: "for loop" },
  { label: "foreach", insertText: "foreach (${1:container}; ${2:key}; ${3:value}) {\n\t$0\n}", detail: "foreach loop" },
  { label: "while", insertText: "while (${1:condition}) {\n\t$0\n}", detail: "while loop" },
  { label: "do", insertText: "do {\n\t$0\n} while (${1:condition});", detail: "do-while loop" },
  { label: "switch", insertText: "switch (${1:expression}) {\n\tcase ${2:value}:\n\t\t$0\n\t\tbreak;\n}", detail: "switch statement" },
  { label: "case", insertText: "case ${1:value}:\n\t$0\n\tbreak;", detail: "case clause" },
  { label: "default", insertText: "default:\n\t$0\n\tbreak;", detail: "default clause" },

  // Exception handling.
  { label: "catch", insertText: "catch (${1:error}) {\n\t$0\n}", detail: "catch block" },

  // Declarations — structural, high value.
  { label: "class", insertText: "class ${1:Name} {\n\t$0\n}", detail: "class declaration" },
  { label: "enum", insertText: "enum ${1:Name} {\n\t$0\n}", detail: "enum declaration" },
  { label: "typedef", insertText: "typedef ${1:type} ${2:Name};", detail: "typedef declaration" },
  { label: "constant", insertText: "constant ${1:Name} = ${2:value};", detail: "constant declaration" },

  // Lambda / inline function.
  { label: "lambda", insertText: "lambda(${1:params}) {\n\t$0\n}", detail: "lambda expression" },

  // Import / inherit.
  { label: "inherit", insertText: "inherit ${1:module};", detail: "inherit module" },
  { label: "import", insertText: "import ${1:module};", detail: "import module" },

  // Special expression keywords.
  { label: "gauge", insertText: "gauge ${1:expression};", detail: "gauge expression (timing)" },
  { label: "sscanf", insertText: "sscanf(${1:input}, \"${2:format}\", ${3:vars})", detail: "sscanf formatted input" },
  { label: "typeof", insertText: "typeof(${1:expression})", detail: "typeof expression" },
];

/**
 * Add keyword snippet completions.
 *
 * Keyword completions are sorted after all symbol completions (priority 60)
 * so that identifiers, functions, and modules always appear first.
 * Skipped if the keyword name collides with an already-seen identifier
 * (a local variable named "for" would shadow the keyword, which is unlikely
 * but handled for correctness).
 */
function collectKeywordSnippets(
  items: CompletionItem[],
  seenNames: Set<string>,
): void {
  for (const kw of KEYWORD_SNIPPETS) {
    if (seenNames.has(kw.label)) continue;
    seenNames.add(kw.label);
    items.push({
      label: kw.label,
      kind: CompletionItemKind.Keyword,
      detail: kw.detail,
      sortText: padSortKey(60) + kw.label,
      filterText: kw.label,
      insertText: kw.insertText,
      insertTextFormat: InsertTextFormat.Snippet,
    });
  }
}

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
      addStdlibMembersByType(typeName, ctx, items, seenNames);
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

  const targetTable = ctx.index.getSymbolTable(wsTarget);
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

/** Strategy 2: Resolve lhs as a stdlib module/class and collect its members. */
function addStdlibMembers(
  lhsText: string,
  ctx: CompletionContext,
  items: CompletionItem[],
  seenNames: Set<string>,
): void {
  const stdlibPrefix = "predef." + lhsText;
  const childrenMap = getStdlibChildrenMap(ctx.stdlibIndex);
  const stdlibMembers = childrenMap.get(stdlibPrefix);
  if (!stdlibMembers) return;

  for (const member of stdlibMembers) {
    if (seenNames.has(member.name)) continue;
    seenNames.add(member.name);
    items.push(buildStdlibMemberItem(member));
  }
}

/** Build a completion item for a stdlib member with optional snippet. */
function buildStdlibMemberItem(
  member: { name: string; kind: CompletionItemKind; signature?: string; fqn: string },
): CompletionItem {
  const item: CompletionItem = {
    label: member.name,
    kind: member.kind,
    detail: member.signature || undefined,
    sortText: padSortKey(10) + member.name,
    filterText: member.name,
    data: { source: "stdlib", fqn: member.fqn },
  };
  if (member.signature && (member.kind === CompletionItemKind.Method || member.kind === CompletionItemKind.Function)) {
    const params = extractParamsFromStdlibSignature(member.signature);
    if (params !== null) {
      item.insertTextFormat = InsertTextFormat.Snippet;
      item.insertText = member.name + "(" + params + ")";
    }
  }
  return item;
}

/**
 * Strategy 3b: Look up stdlib children by resolved type name.
 *
 * When a variable has declared type `Stdio.File`, the stdlib index
 * can provide members under `predef.Stdio.File`. This is the fallback
 * for types not found in the workspace.
 */
function addStdlibMembersByType(
  typeName: string,
  ctx: CompletionContext,
  items: CompletionItem[],
  seenNames: Set<string>,
): void {
  // Try multiple FQN patterns: "predef.Stdio.File", "predef.Stdio"
  const candidates = [
    "predef." + typeName,
    // Also try the first segment for module-level children
    ...typeName.split(".").length > 1
      ? ["predef." + typeName.split(".")[0]]
      : [],
  ];

  const childrenMap = getStdlibChildrenMap(ctx.stdlibIndex);
  for (const prefix of candidates) {
    const stdlibMembers = childrenMap.get(prefix);
    if (!stdlibMembers) continue;

    for (const member of stdlibMembers) {
      if (seenNames.has(member.name)) continue;
      seenNames.add(member.name);
      items.push(buildStdlibMemberItem(member));
    }
    // First match wins — don't accumulate from multiple prefixes
    // since longer prefixes are more specific.
    return;
  }
}
