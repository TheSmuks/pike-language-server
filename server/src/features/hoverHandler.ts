/**
 * Hover handler — three-tier routing per decision 0011 §7.
 *
 * Tier 1: Workspace AutoDoc — XML from PikeExtractor (cached)
 * Tier 2: Stdlib — pre-computed index (hash lookup)
 * Tier 3: Tree-sitter — bare declared type
 *
 * Extracted from server.ts to keep the server entry point under 500 lines.
 * Content helpers live in hoverContent.ts and are imported here.
 */

import type {
  Connection,
  CancellationToken,
  Hover,
} from "vscode-languageserver/node";
import type { TextDocuments } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { parse } from "../parser";
import type { Tree, Node } from "web-tree-sitter";
import { getDefinitionAt, type SymbolTable, type Declaration } from "./symbolTable";
import {
  resolveAccessDeclaration,
  resolveAccessQualifiedType,
  modulePathAtPosition,
  type ResolutionContext,
} from "./accessResolver";
import type { PikeWorker } from "./pikeWorker";
import type { LRUCache } from "../util/lruCache";
import type { WorkspaceIndex } from "./workspaceIndex";
import {
  formatHover,
  declForHover,
  fileLevelHover,
  renderPredefSignature,
  buildPredefHoverMarkdown,
  type HoverContentContext,
  type PredefAutodocEntry,
  type HoverInfo,
} from "./hoverContent";
import { getStdlibEntriesByName } from "./completion-stdlib";

// Re-export for any external consumers
export type { HoverInfo } from "./hoverContent";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface HoverContext {
  documents: TextDocuments<TextDocument>;
  index: WorkspaceIndex;
  worker: PikeWorker;
  getSymbolTable(uri: string): Promise<SymbolTable | null>;
  autodocCache: LRUCache<{ xml: string; hash: string; timestamp: number }>;
  stdlibIndex: Record<string, { signature: string; markdown: string }>;
  predefBuiltins: Record<string, string>;
  predefAutodoc: Record<string, PredefAutodocEntry>;
  /** Called before each request — records activity and gates on wake. */
  beforeRequest?: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a cross-file resolved declaration to hover info. */
async function crossFileHover(
  crossFile: { uri: string; decl: Declaration },
  ctx: HoverContext,
  /** Original hover request position — used for the response range. */
  requestPosition?: { line: number; character: number },
): Promise<Hover | null> {
  const decl = crossFile.decl;

  // Synthesized implicit-class declarations (scopeId === -1) point at the
  // top of a .pike file. Extract the file-level autodoc comment instead of
  // trying to build a signature from the zero-width range.
  if (decl.scopeId === -1) {
    return fileLevelHover(crossFile.uri, decl.name, ctx);
  }

  const info = declForHover(decl, crossFile.uri, ctx);
  if (!info) return null;

  // For cross-file hovers, the range should highlight the identifier in
  // the requesting document (where the user hovered), not the target
  // declaration's position in a different file.
  if (requestPosition) {
    info.line = requestPosition.line;
    info.character = requestPosition.character;
  }

  return formatHover(info);
}

/**
 * Find the identifier token at a given position in the source.
 */
function identifierAtPosition(
  tree: Tree,
  line: number,
  character: number,
): string | null {
  // Get the deepest node at the position. LSP characters and tree-sitter
  // columns are both UTF-16 code units, so no conversion is needed.
  let node: Node | null = tree.rootNode.descendantForPosition({
    row: line,
    column: character,
  });
  // Walk up to find the identifier node at this position
  while (node) {
    if (node.type === "identifier" || node.type === "predef_identifier") {
      return node.text;
    }
    node = node.parent;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register the hover handler on the connection.
 */
export function registerHoverHandler(
  connection: Connection,
  ctx: HoverContext,
): void {
  const makeTypeInferrer = buildHoverTypeInferrer(ctx);
  // Getters, not value captures: registration runs before `initialize`
  // replaces ctx.index / ctx.stdlibIndex with the real instances. A value
  // capture here would freeze the empty placeholders into every request.
  const baseResolutionCtx: ResolutionContext = {
    documents: ctx.documents,
    get index() { return ctx.index; },
    get stdlibIndex() { return ctx.stdlibIndex; },
  };
  connection.onHover(async (params, token) => {
    await ctx.beforeRequest?.();
    return handleHover(ctx, baseResolutionCtx, makeTypeInferrer, params, token);
  });
}

/** Build a type inferrer factory for hover. */
function buildHoverTypeInferrer(
  ctx: HoverContext,
): (source: string) => (varName: string) => Promise<string | null> {
  return (source: string) => async (varName: string) => {
    try {
      const result = await ctx.worker.typeof_(source, varName);
      if (result.type && !result.error) return result.type;
    } catch {
      // Worker unavailable — fall through
    }
    return null;
  };
}

/** Handle a hover request. */
async function handleHover(
  ctx: HoverContext,
  baseResolutionCtx: ResolutionContext,
  makeTypeInferrer: (source: string) => (varName: string) => Promise<string | null>,
  params: { textDocument: { uri: string }; position: { line: number; character: number } },
  token: CancellationToken,
): Promise<Hover | null> {
  if (token.isCancellationRequested) return null;
  const doc = ctx.documents.get(params.textDocument.uri);
  if (!doc) return null;

  const table = await ctx.getSymbolTable(params.textDocument.uri);
  if (!table) return null;

  const decl = getDefinitionAt(table, params.position.line, params.position.character);
  if (decl) return resolveHoverForDecl(decl, ctx, params);

  return resolveHoverFallback(ctx, baseResolutionCtx, makeTypeInferrer, table, doc, params);
}

/** Resolve hover when a local declaration is found. */
async function resolveHoverForDecl(
  decl: Declaration,
  ctx: HoverContext,
  params: { textDocument: { uri: string }; position: { line: number; character: number } },
): Promise<Hover | null> {
  // For inherit/import, resolve to target file autodoc.
  if (decl.kind === "inherit" || decl.kind === "import") {
    const crossFile = await ctx.index.resolveCrossFileDefinition(
      params.textDocument.uri, params.position.line, params.position.character,
    );
    if (crossFile) return crossFileHover(crossFile, ctx, params.position);
  }
  // Symbols merged from a `#include`d file carry the header's coordinates in
  // their ranges, so render the signature against the header's source.
  const declUri = decl.sourceUri ?? params.textDocument.uri;
  return formatHover(declForHover(decl, declUri, ctx));
}

/** Resolve hover when no local declaration is found (cross-file, access, predef). */
async function resolveHoverFallback(
  ctx: HoverContext,
  baseResolutionCtx: ResolutionContext,
  makeTypeInferrer: (source: string) => (varName: string) => Promise<string | null>,
  table: SymbolTable,
  doc: { getText(): string; uri: string },
  params: { textDocument: { uri: string }; position: { line: number; character: number } },
): Promise<Hover | null> {
  const crossFile = await ctx.index.resolveCrossFileDefinition(
    params.textDocument.uri, params.position.line, params.position.character,
  );
  if (crossFile) return crossFileHover(crossFile, ctx, params.position);

  const hoverTree = parse(doc.getText(), params.textDocument.uri);
  const hoverResolutionCtx: ResolutionContext = {
    ...baseResolutionCtx, typeInferrer: makeTypeInferrer(doc.getText()),
  };
  const accessDecl = await resolveAccessDeclaration(
    hoverResolutionCtx, table, params.textDocument.uri,
    params.position.line, params.position.character, hoverTree,
  );
  if (accessDecl) {
    // Try stdlib hover with the resolved access FQN before falling through
    // to declForHover which only checks unqualified names.
    const stdlibHover = hoverFromStdlibAccess(accessDecl.decl, ctx);
    if (stdlibHover) return formatHover(stdlibHover);

    return formatHover(declForHover(accessDecl.decl, accessDecl.uri, ctx));
  }

  // Qualified stdlib member: when the LHS resolves to a stdlib type (e.g.
  // `Stdio.File f; f->open`), look up the precise FQN `predef.Stdio.File.open`
  // instead of the unqualified `predef.open`, which does not exist.
  const qualifiedHover = await hoverFromQualifiedStdlib(
    ctx, hoverResolutionCtx, table, params, hoverTree,
  );
  if (qualifiedHover) return qualifiedHover;

  const builtinHover = resolveHoverBuiltin(ctx, hoverTree, params);
  if (builtinHover) return builtinHover;

  const aliasHover = hoverFromInheritAlias(table, hoverTree, params);
  if (aliasHover) return aliasHover;

  return hoverFromModulePath(ctx, doc, params);
}

/**
 * Hover on an inherit alias — `inherit Vec : base;` on `base`, or the
 * `base` in `base::create()`. The alias is not a reference in the symbol
 * table, so the earlier tiers miss it; show the inherit it names.
 */
function hoverFromInheritAlias(
  table: SymbolTable,
  hoverTree: Tree,
  params: { position: { line: number; character: number } },
): Hover | null {
  const identName = identifierAtPosition(
    hoverTree, params.position.line, params.position.character,
  );
  if (!identName) return null;

  const inheritDecl = table.declarations.find(
    d => d.kind === "inherit" && d.alias === identName,
  );
  if (!inheritDecl) return null;

  return formatHover({
    name: identName,
    signature: `inherit ${inheritDecl.name} : ${identName}`,
    documentation: "",
    line: params.position.line,
    character: params.position.character,
  });
}

/**
 * Hover on a dotted type/module path — `Stdio.File` in a declaration, or a
 * relative module reference like `.Util`. Tries the static stdlib index
 * (rich class docs), then the workspace module resolver, then the Pike
 * worker's runtime resolve for stdlib types the index doesn't carry
 * (e.g. `String.Buffer`).
 */
async function hoverFromModulePath(
  ctx: HoverContext,
  doc: { getText(): string },
  params: { textDocument: { uri: string }; position: { line: number; character: number } },
): Promise<Hover | null> {
  const lines = doc.getText().split('\n');
  const path = modulePathAtPosition(lines, params.position.line, params.position.character);
  if (!path) return null;

  // Static stdlib entry: class/module docs. Signatures are empty for class
  // entries (`predef.Stdio.File`), so synthesize a readable header.
  if (!path.startsWith(".")) {
    const entry = ctx.stdlibIndex[`predef.${path}`];
    if (entry) {
      return formatHover({
        name: path,
        signature: entry.signature || `class ${path}`,
        documentation: entry.markdown,
        line: params.position.line,
        character: params.position.character,
        isAutodoc: true,
      });
    }
  }

  // Workspace module (including Pike's relative `.Util` form).
  const moduleUri = await ctx.index.resolveModule(path, params.textDocument.uri);
  if (moduleUri) {
    const basename = moduleUri.replace(/\/+$/, "").split("/").pop() ?? moduleUri;
    return formatHover({
      name: path,
      signature: `module ${path}`,
      documentation: `Defined in \`${basename}\``,
      line: params.position.line,
      character: params.position.character,
    });
  }

  // Runtime resolve: stdlib types absent from the static index.
  if (!path.startsWith(".") && path.includes(".")) {
    try {
      const resolved = await ctx.worker.resolve(path);
      if (resolved.resolved && resolved.kind) {
        return formatHover({
          name: path,
          signature: `${resolved.kind} ${path}`,
          documentation: "",
          line: params.position.line,
          character: params.position.character,
        });
      }
    } catch { /* Worker unavailable — no hover */ }
  }

  return null;
}

/**
 * Try to find stdlib hover info for a resolved access declaration.
 *
 * When hovering over `f->open()` where `f` is `Stdio.File`, the access
 * resolver returns the Declaration for `open` from a workspace class.
 * `declForHover` checks `predef.open` (wrong) — this function uses the
 * reverse index to find all stdlib entries with that name and returns
 * the first match with rich markdown documentation.
 */
function hoverFromStdlibAccess(
  decl: Declaration,
  ctx: HoverContext,
): HoverInfo | null {
  const matches = getStdlibEntriesByName(ctx.stdlibIndex, decl.name);
  if (!matches || matches.length === 0) return null;

  // Use the first match that has markdown docs.
  for (const { entry } of matches) {
    if (entry.markdown && entry.markdown.length > 0) {
      return {
        name: decl.name,
        signature: entry.signature,
        documentation: entry.markdown,
        line: decl.nameRange.start.line,
        character: decl.nameRange.start.character,
        isAutodoc: true,
      };
    }
  }

  // Fall back to first match even without docs.
  const first = matches[0].entry;
  return {
    name: decl.name,
    signature: first.signature,
    documentation: first.markdown,
    line: decl.nameRange.start.line,
    character: decl.nameRange.start.character,
    isAutodoc: true,
  };
}

/**
 * Resolve hover for a qualified stdlib member by building the precise FQN
 * from the LHS type name.
 *
 * `hoverFromStdlibAccess` only fires when the member resolves to a workspace
 * Declaration; pure stdlib types (e.g. `Stdio.File`) resolve to a synthetic
 * class with an empty member table, so that path returns null. Here we recover
 * the LHS type name, build `predef.<Type>.<member>`, and look up rich docs.
 */
async function hoverFromQualifiedStdlib(
  ctx: HoverContext,
  resolutionCtx: ResolutionContext,
  table: SymbolTable,
  params: { textDocument: { uri: string }; position: { line: number; character: number } },
  tree: Tree,
): Promise<Hover | null> {
  const qualified = await resolveAccessQualifiedType(
    resolutionCtx, table, params.textDocument.uri,
    params.position.line, params.position.character, tree,
  );
  if (!qualified) return null;

  const fqn = `predef.${qualified.typeName}.${qualified.memberName}`;
  const entry = ctx.stdlibIndex[fqn];
  if (!entry) return null;

  return formatHover({
    name: qualified.memberName,
    signature: entry.signature,
    documentation: entry.markdown,
    line: params.position.line,
    character: params.position.character,
    isAutodoc: true,
  });
}

/** Try to resolve hover from predef builtins or stdlib index. */
function resolveHoverBuiltin(
  ctx: HoverContext,
  hoverTree: Tree,
  params: { textDocument: { uri: string }; position: { line: number; character: number } },
): Hover | null {
  const identName = identifierAtPosition(
    hoverTree, params.position.line, params.position.character,
  );
  if (!identName) return null;

  const builtinSig = ctx.predefBuiltins[identName];
  if (builtinSig) {
    const overloads = renderPredefSignature(identName, builtinSig);
    const autodocEntry = ctx.predefAutodoc?.[identName];
    return formatHover({
      name: identName, signature: overloads.join("\n"),
      documentation: buildPredefHoverMarkdown(identName, overloads, autodocEntry),
      line: params.position.line, character: params.position.character, isAutodoc: true,
    });
  }

  const stdlibEntry = ctx.stdlibIndex[`predef.${identName}`];
  if (stdlibEntry) {
    return formatHover({
      name: identName, signature: stdlibEntry.signature, documentation: stdlibEntry.markdown,
      line: params.position.line, character: params.position.character, isAutodoc: true,
    });
  }

  return null;
}
