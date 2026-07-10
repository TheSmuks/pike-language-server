/**
 * Stdlib member completion for Pike LSP.
 *
 * Strategy 2 & 3b: resolve lhs as a stdlib module/class and collect its members.
 * Extracted from completion.ts.
 */

import {
  CompletionItem,
  CompletionItemKind,
  InsertTextFormat,
} from "vscode-languageserver/node";
import { getStdlibChildrenMap, isCompletableIdentifier } from "./completion-stdlib";
import { padSortKey, extractParamsFromStdlibSignature } from "./completion-items";
import type { CompletionContext } from "./completionTrigger";

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
