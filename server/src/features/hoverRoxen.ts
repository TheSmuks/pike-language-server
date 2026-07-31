/**
 * Hover backed by the bundled Roxen index.
 *
 * Split out of hoverHandler.ts, which was at the file-size limit.
 */

import type { Hover } from "vscode-languageserver/node";
import { formatHover } from "./hoverContent";
import { modulePathAtPosition } from "./accessResolver";
import { lookupRoxenIdentifier, lookupRoxenSymbol } from "./roxenIndex";
import type { HoverContext } from "./hoverHandler";

/**
 * Last resort: the bundled Roxen index.
 *
 * Reached only after the symbol table, a detected installation's real sources,
 * and Pike's own vocabulary have all come up empty — which is what makes a
 * local Roxen take precedence over the bundled one without any explicit
 * precedence check. Gated on the file being a Roxen file, so a plain Pike
 * program is never told about `TYPE_STRING`.
 */
export function roxenHover(
  ctx: HoverContext,
  identName: string,
  params: { textDocument: { uri: string }; position: { line: number; character: number } },
): Hover | null {
  if (!ctx.roxenActive.get(params.textDocument.uri)) return null;

  const entry = lookupRoxenIdentifier(ctx.roxenIndex, identName);
  if (!entry) return null;

  // The provenance line matters: it tells the reader this came from a pinned
  // copy of Roxen rather than from their installation, which is also why
  // go-to-definition will decline to jump anywhere.
  const provenance = entry.header
    ? `\n\n*Roxen \`${entry.header}\` (bundled index, Roxen ${ctx.roxenIndex.roxenVersion})*`
    : `\n\n*Roxen (bundled index, Roxen ${ctx.roxenIndex.roxenVersion})*`;

  // Not `isAutodoc`: that flag means the documentation already contains a
  // rendered signature, and these entries keep the two apart. Setting it would
  // silently drop the declaration and hover would show only the provenance.
  return formatHover({
    name: identName,
    signature: entry.signature,
    documentation: entry.markdown ? `${entry.markdown}\n${provenance}` : provenance.trimStart(),
    line: params.position.line,
    character: params.position.character,
    isAutodoc: false,
  });
}

/**
 * A dotted Roxen path — `RXML.Tag`, `Roxen.True`, `roxen.store`.
 *
 * Runs ahead of the bare-name tiers, not after them, because a qualified name
 * and a bare one are different symbols: `roxen.query` is the server object's
 * `query`, while the bare `query` a module writes is the module prototype's.
 * Answering the qualified form from `RoxenModule.query` is a wrong answer, and
 * 74 members of the two Roxen globals share a name with some bare tier.
 *
 * Only paths that contain a dot can match, since every index key is prefixed,
 * so a bare identifier still falls through to the tiers below. Gated on the
 * file being a Roxen file, like every other Roxen tier.
 */
export function roxenPathHover(
  ctx: HoverContext,
  doc: { getText(): string },
  params: { textDocument: { uri: string }; position: { line: number; character: number } },
): Hover | null {
  if (!ctx.roxenActive.get(params.textDocument.uri)) return null;

  const lines = doc.getText().split("\n");
  const path = modulePathAtPosition(lines, params.position.line, params.position.character);
  if (!path) return null;

  const entry = lookupRoxenSymbol(ctx.roxenIndex, path);
  return entry ? roxenSymbolHover(ctx, path, entry, params.position) : null;
}

/**
 * A member reached through a receiver whose declared type is a Roxen class —
 * `RequestID id; id->real_variables`.
 *
 * These classes live in `prototypes.pike` and are injected as globals, so no
 * inherit or import leads there from the file writing `id->misc`: the
 * type-driven resolver finds no workspace class and the stdlib index has never
 * heard of them. `RequestID` alone is the receiver at 847 `->` positions in
 * Roxen 6.1 — the most-used type in the tree — and every one answered nothing.
 *
 * Keyed `Class.member`, exactly as the dotted path tier is, so the index needs
 * no second shape.
 */
export function roxenTypedMemberHover(
  ctx: HoverContext,
  typeName: string,
  memberName: string,
  params: { textDocument: { uri: string }; position: { line: number; character: number } },
): Hover | null {
  if (!ctx.roxenActive.get(params.textDocument.uri)) return null;

  const entry = lookupRoxenSymbol(ctx.roxenIndex, `${typeName}.${memberName}`);
  if (!entry) return null;
  return roxenSymbolHover(ctx, memberName, entry, params.position);
}

/**
 * Render a dotted Roxen index entry, with the provenance line the bundled
 * index always carries — it tells the reader the answer came from a pinned
 * copy of Roxen rather than their installation, which is also why
 * go-to-definition declines to jump anywhere.
 */
function roxenSymbolHover(
  ctx: HoverContext,
  path: string,
  entry: { signature: string; markdown?: string },
  position: { line: number; character: number },
): Hover | null {
  const provenance = `\n\n*Roxen (bundled index, Roxen ${ctx.roxenIndex.roxenVersion})*`;
  return formatHover({
    name: path,
    signature: entry.signature,
    documentation: entry.markdown ? `${entry.markdown}\n${provenance}` : provenance.trimStart(),
    line: position.line,
    character: position.character,
    isAutodoc: false,
  });
}
