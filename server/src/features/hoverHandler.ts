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
import { parse, withBorrowedTree } from "../parser";
import type { Tree, Node } from "web-tree-sitter";
import { getDefinitionAt, getLocalDeclarationAt, type SymbolTable, type Declaration } from "./symbolTable";
import { isWrittenInFile } from "./query";
import {
  resolveAccessDeclaration,
  resolveAccessQualifiedType,
  modulePathAtPosition,
  headOfDottedPath,
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
import { getUniqueStdlibEntryByName } from "./completion-stdlib";
import { pinHoverRange } from "./hoverRange";
import { memberOfMemberlessReceiver } from "./receiverMembers";
import { magicConstantHover } from "./pikeMagicConstants";
import { hoverFromModulePath } from "./hoverModulePath";
import { type RoxenIndexData } from "./roxenIndex";
import {
  roxenHover, roxenPathHover, roxenTypedMemberHover, roxenInheritedMemberHover,
} from "./hoverRoxen";
import {
  hoverScopeSpecifier, hoverQualifiedInheritMember, hoverFromInheritAlias,
} from "./hoverScopeAccess";

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
  /** Bundled Roxen vocabulary. */
  roxenIndex: RoxenIndexData;
  /** Which open documents are Roxen files, by URI. */
  roxenActive: Map<string, boolean>;
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
  const hover = decl
    ? await resolveHoverForDecl(decl, ctx, params)
    : await resolveHoverFallback(ctx, baseResolutionCtx, makeTypeInferrer, table, doc, params);

  // Every tier computes its own range from what it resolved; only this knows
  // what the user actually hovered.
  return pinHoverRange(hover, doc.getText(), params.position);
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

  // Every tier below reads the tree after an `await`, so the hover needs a
  // handle the parser cache cannot free out from under it.
  return withBorrowedTree(
    parse(doc.getText(), params.textDocument.uri),
    (hoverTree) => hoverFromTree(
      ctx, baseResolutionCtx, makeTypeInferrer, table, doc, params, hoverTree,
    ),
  );
}

/** Hover tiers that read the parse tree: access, qualified stdlib, builtin, alias. */
async function hoverFromTree(
  ctx: HoverContext,
  baseResolutionCtx: ResolutionContext,
  makeTypeInferrer: (source: string) => (varName: string) => Promise<string | null>,
  table: SymbolTable,
  doc: { getText(): string; uri: string },
  params: { textDocument: { uri: string }; position: { line: number; character: number } },
  hoverTree: Tree,
): Promise<Hover | null> {
  const hoverResolutionCtx: ResolutionContext = {
    ...baseResolutionCtx, typeInferrer: makeTypeInferrer(doc.getText()),
  };
  const accessDecl = await resolveAccessDeclaration(
    hoverResolutionCtx, table, params.textDocument.uri,
    params.position.line, params.position.character, hoverTree,
  );
  if (accessDecl) {
    // A variable this file declares is not the predef that shares its name.
    // Pike scoping shadows the efun, so in `int time = 5;` the name is that
    // variable. The stdlib tier below keys on a bare NAME, so it documented a
    // user's `time`, `max` or `mv` as the efun — at the declaration and at
    // every use. Describe the declaration the resolver actually found.
    const ownDeclaration = isWrittenInFile(table, accessDecl.decl) &&
      (accessDecl.decl.kind === "variable" || accessDecl.decl.kind === "parameter" ||
       accessDecl.decl.kind === "constant");

    // Unambiguous stdlib names only — see hoverFromStdlibAccess.
    const stdlibHover = ownDeclaration ? null : hoverFromStdlibAccess(accessDecl.decl, ctx);
    if (stdlibHover) return formatHover(stdlibHover);

    // An ambiguous name must not be guessed from the bare index here. The
    // qualified tier knows the receiver's type and can name the exact symbol.
    const qualified = await hoverFromQualifiedStdlib(
      ctx, hoverResolutionCtx, table, params, hoverTree,
    );
    if (qualified) return qualified;

    return formatHover(declForHover(accessDecl.decl, accessDecl.uri, ctx));
  }

  // Qualified stdlib member: when the LHS resolves to a stdlib type (e.g.
  // `Stdio.File f; f->open`), look up the precise FQN `predef.Stdio.File.open`
  // instead of the unqualified `predef.open`, which does not exist.
  const qualifiedHover = await hoverFromQualifiedStdlib(
    ctx, hoverResolutionCtx, table, params, hoverTree,
  );
  if (qualifiedHover) return qualifiedHover;

  // Ahead of the bare-name tiers: `roxen.query` and a module's bare `query`
  // are different symbols, and answering the qualified form from the bare
  // index was a wrong answer rather than a missing one.
  const roxenPath = roxenPathHover(ctx, doc, params);
  if (roxenPath) return roxenPath;

  // Ahead of the bare-name tiers for the same reason roxenPathHover is: a
  // member reached through `low_parser::` is not the same symbol as a bare one
  // of that name, and answering it from the unqualified index was the wrong
  // answer rather than a missing one.
  const qualifiedMember = await hoverQualifiedInheritMember(ctx, table, hoverTree, params);
  if (qualifiedMember) return qualifiedMember;

  // Path-aware, so it runs with roxenPathHover rather than after the bare-name
  // tiers: `ADT.Table.ASCII` is that module, not any `ASCII` in scope.
  const modulePathHover = await hoverFromModulePath(ctx, doc, params);
  if (modulePathHover) return modulePathHover;

  // Everything below answers by bare NAME. On `file->error` where `file` is a
  // mapping that handed back Pike's builtin `error`, and on `Image.PNG.encode`
  // an unrelated `encode` from an inherit chain the expression never mentions.
  if (memberOfMemberlessReceiver(table, params)) return null;

  const builtinHover = resolveHoverBuiltin(ctx, hoverTree, params);
  if (builtinHover) return builtinHover;

  // A bare member of a class this one inherits, where that class is known
  // only to the bundled index — the symbol table has no scope to search.
  const inheritedMember = roxenInheritedMemberHover(
    ctx, table, identifierAtPosition(hoverTree, params.position.line, params.position.character) ?? "", params,
  );
  if (inheritedMember) return inheritedMember;

  const aliasHover = hoverFromInheritAlias(table, hoverTree, params);
  if (aliasHover) return aliasHover;

  // The scope keywords and `::` itself are anonymous tokens with no
  // declaration anywhere, so every tier above walks past them.
  const specifierHover = hoverScopeSpecifier(table, hoverTree, params);
  if (specifierHover) return specifierHover;

  // Last resort: the cursor is on a declaration's own name and nothing above
  // could resolve what it points at — an inherit or import of a target this
  // workspace does not have. The declaration is still there to describe, and
  // hovering a use of the same name already renders it.
  const local = getLocalDeclarationAt(table, params.position.line, params.position.character);
  if (!local) return null;
  return formatHover(declForHover(local, params.textDocument.uri, ctx));
}

/**
 * Stdlib hover for a resolved access declaration, ONLY when the name is unique.
 *
 * When hovering `f->open()` where `f` is `Stdio.File`, the access resolver
 * returns the Declaration for `open` from a workspace class, and `declForHover`
 * would check `predef.open`, which does not exist. This tier consults the
 * reverse index instead — but that index is keyed on the LAST segment of an
 * FQN only, so a name carried by several modules has several entries.
 *
 * It used to answer with the first entry that had markdown, which is insertion
 * order, i.e. alphabetical by FQN. `Bz2` sorts before `Stdio`, so `Stdio.File`
 * was documented as Bz2's inherit; `ADT.Relation.Binary.map` beat `Array.map`,
 * answering "Maps every entry in the relation" for a call that has nothing to
 * do with relations. Both are confident wrong answers, and both had the right
 * entry sitting in the same index.
 *
 * This is a bare-NAME tier, and the ordering rule stated throughout this file
 * is that bare-name tiers must not pre-empt path-aware ones. So it now answers
 * only when the name is unambiguous; anything else falls through to
 * `hoverFromQualifiedStdlib`, which knows the receiver's type and builds the
 * exact FQN.
 */
function hoverFromStdlibAccess(
  decl: Declaration,
  ctx: HoverContext,
): HoverInfo | null {
  // Ambiguous names return null here: which symbol is meant depends on the
  // receiver, which this tier cannot see.
  const match = getUniqueStdlibEntryByName(ctx.stdlibIndex, decl.name);
  if (!match) return null;

  const entry = match.entry;
  return {
    name: decl.name,
    signature: entry.signature,
    documentation: entry.markdown,
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

  // Roxen's own classes first: `RequestID` and `Configuration` are declared
  // in prototypes.pike and injected as globals, so neither the workspace
  // resolver nor the stdlib index can reach their members.
  const roxenTyped = roxenTypedMemberHover(
    ctx, qualified.typeName, qualified.memberName, params,
  );
  if (roxenTyped) return roxenTyped;

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

  // Compiler-defined constants come first: none is declared in any Pike
  // source, so no index below carries them.
  const magic = magicConstantHover(identName, params.position);
  if (magic) return magic;

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

  return roxenHover(ctx, identName, params);
}
