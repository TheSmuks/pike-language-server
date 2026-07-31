/**
 * Hover backed by the bundled Roxen index.
 *
 * Split out of hoverHandler.ts, which was at the file-size limit.
 */

import type { Hover } from "vscode-languageserver/node";
import { formatHover } from "./hoverContent";
import { lookupRoxenIdentifier } from "./roxenIndex";
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
 * Render a dotted Roxen index entry, with the provenance line the bundled
 * index always carries — it tells the reader the answer came from a pinned
 * copy of Roxen rather than their installation, which is also why
 * go-to-definition declines to jump anywhere.
 */
export function roxenSymbolHover(
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
