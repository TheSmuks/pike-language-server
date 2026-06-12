/**
 * Dot/arrow/member access completions.
 *
 * Extracted from completion.ts to keep each file under 500 lines.
 */

import { Tree, Node } from "web-tree-sitter";
import {
  CompletionItem,
  CompletionItemKind,
  InsertTextFormat,
} from "vscode-languageserver/node";
import type { SymbolTable } from "./symbolTable";
import type { CompletionContext } from "./completionTrigger";
import {
  getStdlibChildrenMap,
} from "./completion-stdlib";
import {
  resolveTypeMembers,
  declToCompletionItem,
  padSortKey,
  findDeclarationForName,
  extractParamsFromStdlibSignature,
} from "./completion-items";
import { resolveChainedType } from "./completion-chain";

// Re-export for convenience
export type { SymbolTable, CompletionContext };

/**
 * Complete member access after '.' or '->'.
 *
 * Strategies:
 * 1. If lhs is a known module path → resolve via WorkspaceIndex
 * 2. If lhs is a known stdlib path → resolve via stdlib index
 * 3. If lhs is a declared variable with known type → resolve type to class scope
 */
export async function completeMemberAccess(
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
  const { resolveTypeName } = await import("./symbolTable");
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
export async function addWorkspaceModuleMembers(
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

  const { getDeclarationsInScope } = await import("./symbolTable");
  const decls = getDeclarationsInScope(targetTable, fileScope.id);
  for (const decl of decls) {
    if (seenNames.has(decl.name)) continue;
    seenNames.add(decl.name);
    items.push(declToCompletionItem(decl, 0, targetTable));
  }
}

/** Strategy 2: Resolve lhs as a stdlib module/class and collect its members. */
export function addStdlibMembers(
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
export function buildStdlibMemberItem(
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
export function addStdlibMembersByType(
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
