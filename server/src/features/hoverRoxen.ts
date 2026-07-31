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
import type { SymbolTable } from "./symbolTable";

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
 * A bare name that is a member of a class this one INHERITS, where the class
 * exists only in the bundled index.
 *
 * `class RequestID2 { inherit RequestID; … return conf; }` — Roxen's own
 * `ftp.pike` — reads `conf` with no receiver, because it is a member of the
 * `RequestID` it inherits. That class is injected as a global, so the workspace
 * never resolves the inherit and `inheritedScopes` stays empty: the symbol
 * table has nowhere to look, and every bare-name tier is about names in scope,
 * which this is not. `err`, `result`, `conf` and `id` between them account for
 * ~680 such reads in Roxen 6.1.
 *
 * Only inherits visible from the cursor are consulted — the enclosing classes
 * and the file — so a sibling class's inherit cannot answer.
 */
export function roxenInheritedMemberHover(
  ctx: HoverContext,
  table: SymbolTable,
  identName: string,
  params: { textDocument: { uri: string }; position: { line: number; character: number } },
): Hover | null {
  if (!ctx.roxenActive.get(params.textDocument.uri)) return null;

  for (const inheritName of visibleInheritNames(table, params.position.line)) {
    const entry = lookupRoxenSymbol(ctx.roxenIndex, `${inheritName}.${identName}`);
    if (entry) return roxenSymbolHover(ctx, identName, entry, params.position);
  }
  return null;
}

/** Inherit names declared by a scope covering `line`, innermost first. */
function visibleInheritNames(table: SymbolTable, line: number): string[] {
  const scopes = table.scopes
    .filter(s => (s.kind === "class" || s.kind === "file") &&
      s.range.start.line <= line && line <= s.range.end.line)
    .sort((a, b) =>
      (a.range.end.line - a.range.start.line) - (b.range.end.line - b.range.start.line));

  const names: string[] = [];
  for (const scope of scopes) {
    for (const declId of scope.declarations) {
      const decl = table.declById.get(declId);
      if (decl?.kind === "inherit") names.push(decl.name.replace(/^"|"$/g, ""));
    }
  }
  return names;
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
