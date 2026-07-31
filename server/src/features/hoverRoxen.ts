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

  return renderRoxenEntry(ctx, identName, entry, params.position);
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
 * Render one bundled-index entry.
 *
 * Entries arrive in two shapes. The harvested ones carry a bare declaration in
 * `signature` and prose in `markdown`. The AutoDoc-derived ones — the 499 that
 * come from Roxen's own documentation, `RXML.Tag` and `RXML.Frame` among
 * them — have the signature rendered INTO the markdown as well, so rendering
 * both showed `mixed result` twice, and `RXML.Tag`, whose signature is empty,
 * opened with a blank code block.
 *
 * `isAutodoc` already means "the documentation contains its own signature", so
 * the shape decides which way to render rather than the call site guessing.
 */
function renderRoxenEntry(
  ctx: HoverContext,
  name: string,
  entry: { signature: string; markdown?: string; header?: string },
  position: { line: number; character: number },
): Hover | null {
  const source = entry.header
    ? `Roxen \`${entry.header}\` (bundled index, Roxen ${ctx.roxenIndex.roxenVersion})`
    : `Roxen (bundled index, Roxen ${ctx.roxenIndex.roxenVersion})`;
  const provenance = `*${source}*`;
  const markdown = entry.markdown ?? "";
  // An entry with no signature has nothing to put in a code block — rendering
  // one anyway opened `RXML.Tag`'s hover with an empty ```pike fence.
  const selfDescribing = markdown.trimStart().startsWith("```") ||
    entry.signature.trim().length === 0;

  return formatHover({
    name,
    signature: entry.signature,
    documentation: selfDescribing
      ? `${markdown}\n\n${provenance}`
      : (markdown ? `${markdown}\n\n${provenance}` : provenance),
    line: position.line,
    character: position.character,
    isAutodoc: selfDescribing,
  });
}

/** Render a dotted Roxen index entry. */
function roxenSymbolHover(
  ctx: HoverContext,
  path: string,
  entry: { signature: string; markdown?: string },
  position: { line: number; character: number },
): Hover | null {
  return renderRoxenEntry(ctx, path, entry, position);
}
