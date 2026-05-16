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
  type HoverContentContext,
} from "./hoverContent";
import { utf16ToUtf8 } from "../util/positionConverter";

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
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a cross-file resolved declaration to hover info. */
function crossFileHover(
  crossFile: { uri: string; decl: Declaration },
  ctx: HoverContext,
  /** Original hover request position — used for the response range. */
  requestPosition?: { line: number; character: number },
): Hover | null {
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
  lines: string[],
): string | null {
  // Convert LSP character (UTF-16) to tree-sitter column (UTF-8 byte offset)
  const utf8Col = utf16ToUtf8(lines[line] ?? '', character);

  // Get the deepest node at the position
  let node: Node | null = tree.rootNode.descendantForPosition({
    row: line,
    column: utf8Col,
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
  const baseResolutionCtx: ResolutionContext = {
    documents: ctx.documents,
    index: ctx.index,
    stdlibIndex: ctx.stdlibIndex,
  };
  connection.onHover((params, token) =>
    handleHover(ctx, baseResolutionCtx, makeTypeInferrer, params, token));
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
  return formatHover(declForHover(decl, params.textDocument.uri, ctx));
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
  if (accessDecl) return formatHover(declForHover(accessDecl.decl, accessDecl.uri, ctx));

  return resolveHoverBuiltin(ctx, hoverTree, doc, params);
}

/** Try to resolve hover from predef builtins or stdlib index. */
function resolveHoverBuiltin(
  ctx: HoverContext,
  hoverTree: Tree,
  doc: { getText(): string },
  params: { textDocument: { uri: string }; position: { line: number; character: number } },
): Hover | null {
  const identName = identifierAtPosition(
    hoverTree, params.position.line, params.position.character, doc.getText().split('\n'),
  );
  if (!identName) return null;

  const builtinSig = ctx.predefBuiltins[identName];
  if (builtinSig) {
    return formatHover({
      name: identName, signature: renderPredefSignature(identName, builtinSig),
      documentation: `Type signature (from Pike runtime):\n\`${builtinSig}\``,
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
