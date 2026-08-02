/**
 * Stdlib and module member completion for Pike LSP.
 *
 * Strategies 1, 2 & 3b: resolve lhs as a module file or stdlib path and
 * collect its members. Extracted from completion.ts.
 */

import {
  CompletionItem,
  CompletionItemKind,
  InsertTextFormat,
} from "vscode-languageserver/node";
import { getStdlibChildrenMap, isCompletableIdentifier } from "./completion-stdlib";
import { padSortKey, extractParamsFromStdlibSignature, declToCompletionItem } from "./completion-items";
import { type Declaration, getDeclarationsInScope } from "./symbolTable";
import type { CompletionContext } from "./completionTrigger";

/** Strategy 1: Resolve lhs as a module file and collect its declarations. */
export async function addWorkspaceModuleMembers(
  lhsText: string,
  ctx: CompletionContext,
  items: CompletionItem[],
  seenNames: Set<string>,
): Promise<void> {
  const resolved = await ctx.index.resolveModuleWithSource(lhsText, ctx.uri);
  if (!resolved) return;

  // For an installed stdlib module the bundled index is authoritative — it is
  // reconciled against `indices()` on the real runtime at generation time and
  // covers inherited C-module members the source file never names. Parsing
  // the installed source instead leaks symbols Pike cannot index from outside
  // (macros, protected declarations, inactive #ifdef blocks). The `reconciled.`
  // marker is written only for modules the generation-host oracle actually
  // answered for; a module it could not reconcile (absent or gutted on that
  // host) falls through to the filtered source parse below — keying this on
  // "children exist" instead used to miss modules whose children were all
  // pruned and re-leak the source symbols.
  if (
    resolved.source === "system_module" &&
    ctx.stdlibIndex["reconciled." + lhsText] !== undefined
  ) {
    return;
  }

  const targetTable = await ctx.index.getOrIndexSymbolTable(resolved.uri);
  if (!targetTable) return;

  const fileScope = targetTable.scopes.find(s => s.kind === "file");
  if (!fileScope) return;

  for (const decl of getDeclarationsInScope(targetTable, fileScope.id)) {
    if (!isIndexableModuleMember(decl)) continue;
    if (seenNames.has(decl.name)) continue;
    seenNames.add(decl.name);
    items.push(declToCompletionItem(decl, 0, targetTable));
  }
}

/**
 * Whether a file-scope declaration can be reached as `Module.name` from
 * outside. Pike does not expose protected/private/static symbols through
 * module indexing, and macros, imports and the inherit name itself are not
 * members at all.
 */
function isIndexableModuleMember(decl: Declaration): boolean {
  if (decl.kind === "macro" || decl.kind === "inherit" || decl.kind === "import" || decl.kind === "include") {
    return false;
  }
  const mods = decl.modifiers;
  if (!mods) return true;
  return !mods.includes("protected") && !mods.includes("private") && !mods.includes("static");
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
  // Exact FQN only. Falling back to the parent module's children
  // (predef.String for String.Buffer) is wrong: a module's functions are
  // not members of an object of that type (`buf->implode_nicely` does not
  // exist). When the static index has nothing for the exact type, the
  // caller's runtime-resolve fallback enumerates the true members.
  const childrenMap = getStdlibChildrenMap(ctx.stdlibIndex);
  const stdlibMembers = childrenMap.get("predef." + typeName);
  if (!stdlibMembers) return;

  for (const member of stdlibMembers) {
    if (seenNames.has(member.name)) continue;
    seenNames.add(member.name);
    items.push(buildStdlibMemberItem(member));
  }
}

/**
 * Strategy 3c: Runtime member resolution via PikeWorker.resolve().
 *
 * Fallback for types the static stdlib index doesn't cover (e.g. `Image.Image`,
 * `Protocols.HTTP.Session`) and for the fuller inherited member set introspect
 * enumerates. Only called when the static index yields nothing for the type, so
 * the common completion path never pays the subprocess round-trip. Members are
 * enriched with static-index docs when a matching FQN entry exists.
 */
export async function addResolvedMembers(
  typeName: string,
  ctx: CompletionContext,
  items: CompletionItem[],
  seenNames: Set<string>,
): Promise<void> {
  if (!ctx.memberResolver) return;
  const result = await ctx.memberResolver(typeName);
  if (!result || !result.resolved) return;

  const fqnPrefix = "predef." + typeName + ".";
  addResolvedGroup(result.methods, CompletionItemKind.Method, fqnPrefix, ctx, items, seenNames);
  addResolvedGroup(result.constants, CompletionItemKind.Constant, fqnPrefix, ctx, items, seenNames);
}

/** Convert one group (methods or constants) of resolved members to items. */
function addResolvedGroup(
  members: Array<{ name: string }> | undefined,
  kind: CompletionItemKind,
  fqnPrefix: string,
  ctx: CompletionContext,
  items: CompletionItem[],
  seenNames: Set<string>,
): void {
  if (!members) return;
  for (const member of members) {
    const name = member.name;
    if (seenNames.has(name)) continue;
    // Skip operator overloads (`<<, `%, …) — not meaningful `->` members.
    if (!isCompletableIdentifier(name)) continue;
    seenNames.add(name);
    const fqn = fqnPrefix + name;
    const entry = ctx.stdlibIndex[fqn];
    items.push({
      label: name,
      kind,
      detail: entry?.signature || undefined,
      sortText: padSortKey(10) + name,
      filterText: name,
      // Only tag a resolve-data source when the static index can supply
      // markdown for completionItem/resolve; otherwise leave it undocumented.
      data: entry ? { source: "stdlib", fqn } : undefined,
    });
  }
}
