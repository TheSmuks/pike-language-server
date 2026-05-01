/**
 * Arrow/dot access resolution — shared core for definition and hover.
 *
 * Extracted from server.ts to decouple access resolution logic from the
 * server wiring.  Callers provide a `ResolutionContext` that supplies
 * the document store, parse function, workspace index, and stdlib index.
 *
 * Supports chained access (e.g. a.b.c, obj->method()->field) by
 * recursively unwrapping nested postfix_expr nodes.
 */

import type { TextDocuments } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { Location as LspLocation } from "vscode-languageserver/node";
import type { SymbolTable, Declaration } from "./symbolTable";
import type { TypeResolutionContext } from "./typeResolver";
import { resolveMemberAccess } from "./typeResolver";
import type { WorkspaceIndex } from "./workspaceIndex";
import { parse } from "../parser";
import type { Tree, Node } from "web-tree-sitter";
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResolutionContext {
  documents: TextDocuments<TextDocument>;
  index: WorkspaceIndex;
  stdlibIndex: Record<string, { signature: string; markdown: string }>;
}

export interface AccessResult {
  decl: Declaration;
  uri: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_CHAIN_DEPTH = 10;

// ---------------------------------------------------------------------------
// Core resolution
// ---------------------------------------------------------------------------

/**
 * Resolve an arrow/dot access at the given position to its target declaration.
 *
 * Walks the tree-sitter tree to find the LHS operand, resolves its type,
 * then resolves the member access on that type.  For chained access
 * (a.b.c), recursively resolves each intermediate postfix_expr.
 *
 * @param tree  Optional pre-parsed tree.  If omitted, the document is parsed.
 */
export async function resolveAccessCore(
  ctx: ResolutionContext,
  table: SymbolTable,
  uri: string,
  line: number,
  character: number,
  tree?: Tree,
): Promise<AccessResult | null> {
  const ref = table.references.find(
    r => r.loc.line === line && r.loc.character === character &&
      (r.kind === 'arrow_access' || r.kind === 'dot_access'),
  );
  if (!ref) {
    return null;
  }

  const doc = ctx.documents.get(uri);
  if (!doc) return null;

  const parsedTree = tree ?? parse(doc.getText(), uri);

  const node = parsedTree.rootNode.descendantForPosition({ row: line, column: character });
  if (!node) return null;

  let postfixNode: Node = node;
  while (postfixNode.parent && postfixNode.type !== 'postfix_expr') {
    postfixNode = postfixNode.parent;
  }
  if (postfixNode.type !== 'postfix_expr') return null;

  const lhsNode = findLhsNode(postfixNode, node);
  if (!lhsNode) return null;

  const typeCtx: TypeResolutionContext = { table, uri, index: ctx.index, stdlibIndex: ctx.stdlibIndex };
  const lhsDecl = await resolveLhsDeclaration(lhsNode, table, typeCtx, 0);
  if (!lhsDecl) return null;

  const targetDecl = await resolveMemberAccess(
    lhsNode.type === 'identifier' ? lhsNode.text : '',
    ref.name,
    lhsDecl,
    typeCtx,
  );
  if (!targetDecl) return null;

  const targetUri = findDeclUri(ctx, targetDecl, table, uri);
  return { decl: targetDecl, uri: targetUri };
}

// ---------------------------------------------------------------------------
// Convenience wrappers
// ---------------------------------------------------------------------------

/** Resolve arrow/dot access to a LSP definition location. */
export async function resolveAccessDefinition(
  ctx: ResolutionContext,
  table: SymbolTable,
  uri: string,
  line: number,
  character: number,
  tree?: Tree,
): Promise<LspLocation | null> {
  const result = await resolveAccessCore(ctx, table, uri, line, character, tree);
  if (!result) return null;
  return {
    uri: result.uri,
    range: {
      start: { line: result.decl.nameRange.start.line, character: result.decl.nameRange.start.character },
      end: { line: result.decl.nameRange.end.line, character: result.decl.nameRange.end.character },
    },
  };
}

/** Resolve arrow/dot access to a declaration (for hover). */
export async function resolveAccessDeclaration(
  ctx: ResolutionContext,
  table: SymbolTable,
  uri: string,
  line: number,
  character: number,
  tree?: Tree,
): Promise<AccessResult | null> {
  return resolveAccessCore(ctx, table, uri, line, character, tree);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ACCESS_OPS = new Set(['->', '.', '->?', '?->']);

/**
 * Find the LHS node of the access operator whose RHS matches `target`.
 */
function findLhsNode(postfixNode: Node, target: Node): Node | null {
  const children = postfixNode.children;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (ACCESS_OPS.has(child.type) &&
        i + 1 < children.length &&
        children[i + 1].startPosition.row === target.startPosition.row &&
        children[i + 1].startPosition.column === target.startPosition.column) {
      return children[i - 1] ?? null;
    }
  }
  return null;
}

/**
 * Resolve an LHS node to its Declaration.
 *
 * For a simple identifier, looks it up in the symbol table.
 * For a nested postfix_expr (chained access like a.b.c), recursively
 * resolves the chain and returns the intermediate declaration.
 */
async function resolveLhsDeclaration(
  lhsNode: Node,
  table: SymbolTable,
  typeCtx: TypeResolutionContext,
  depth: number,
): Promise<Declaration | null> {
  if (depth >= MAX_CHAIN_DEPTH) return null;

  // Chained access: LHS is itself a postfix_expr — resolve recursively
  if (lhsNode.type === 'postfix_expr') {
    return resolvePostfixChain(lhsNode, table, typeCtx, depth);
  }

  // Simple identifier — look up in symbol table
  return resolveIdentifierDecl(lhsNode, table);
}

/**
 * Resolve a chained postfix_expr to its target Declaration.
 *
 * For `a.b.c` the outer postfix_expr has children [inner_postfix, '.', 'c'].
 * We find the rightmost operator, resolve its LHS recursively, then
 * resolve the member on that intermediate declaration.
 */
async function resolvePostfixChain(
  postfixNode: Node,
  table: SymbolTable,
  typeCtx: TypeResolutionContext,
  depth: number,
): Promise<Declaration | null> {
  if (depth >= MAX_CHAIN_DEPTH) return null;

  const children = postfixNode.children;

  // Find the rightmost access operator
  let opIdx = -1;
  for (let i = children.length - 2; i >= 1; i--) {
    if (ACCESS_OPS.has(children[i].type)) {
      opIdx = i;
      break;
    }
  }
  if (opIdx < 0) {
    // No access operator — postfix_expr wraps a simple expression (identifier,
    // call, etc.).  Drill into the first child to find the identifier.
    const firstChild = children[0];
    if (!firstChild) return null;
    if (firstChild.type === 'postfix_expr') {
      return resolvePostfixChain(firstChild, table, typeCtx, depth);
    }
    return resolveIdentifierDecl(firstChild, table);
  }

  const innerLhs = children[opIdx - 1];
  const innerRhs = children[opIdx + 1];
  if (!innerLhs || !innerRhs) return null;

  const memberName = innerRhs.text;
  const innerDecl = await resolveLhsDeclaration(innerLhs, table, typeCtx, depth + 1);
  if (!innerDecl) return null;

  return resolveMemberAccess(
    innerLhs.type === 'identifier' ? innerLhs.text : '',
    memberName,
    innerDecl,
    typeCtx,
  );
}

/**
 * Look up an identifier node in the symbol table to find its Declaration.
 */
function resolveIdentifierDecl(
  node: Node,
  table: SymbolTable,
): Declaration | null {
  const name = node.text;
  const ref = table.references.find(
    r => r.name === name && r.resolvesTo !== null &&
      r.loc.line === node.startPosition.row &&
      r.loc.character === node.startPosition.column,
  );
  if (ref && ref.resolvesTo !== null) {
    return table.declById.get(ref.resolvesTo) ?? null;
  }
  return table.declarations.find(d => d.name === name) ?? null;
}

/** Find the URI of a declaration by searching the workspace index.
 *
 * For synthetic declarations from cross-file inheritance, uses sourceUri.
 */
function findDeclUri(
  ctx: ResolutionContext,
  targetDecl: Declaration,
  localTable: SymbolTable,
  localUri: string,
): string {
  // Synthetic declarations from cross-file inheritance carry their origin URI.
  if (targetDecl.sourceUri) return targetDecl.sourceUri;

  if (localTable.declarations.some(d => d.id === targetDecl.id)) return localUri;
  for (const uri of ctx.index.getAllUris()) {
    if (uri === localUri) continue;
    const t = ctx.index.getSymbolTable(uri);
    if (t?.declarations.some(d => d.id === targetDecl.id)) return uri;
  }
  return localUri;
}
