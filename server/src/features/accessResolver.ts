/**
 * Arrow/dot access resolution — shared core for definition and hover.
 *
 * Extracted from server.ts to decouple access resolution logic from the
 * server wiring.  Callers provide a `ResolutionContext` that supplies
 * the document store, parse function, workspace index, and stdlib index.
 */

import type { TextDocuments } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { Location as LspLocation } from "vscode-languageserver/node";
import type { SymbolTable, Declaration } from "./symbolTable";
import type { TypeResolutionContext } from "./typeResolver";
import { resolveMemberAccess } from "./typeResolver";
import type { WorkspaceIndex } from "./workspaceIndex";
import { parse } from "../parser";

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
// Core resolution
// ---------------------------------------------------------------------------

/**
 * Resolve an arrow/dot access at the given position to its target declaration.
 *
 * Walks the tree-sitter tree to find the LHS operand, resolves its type,
 * then resolves the member access on that type.
 */
export function resolveAccessCore(
  ctx: ResolutionContext,
  table: SymbolTable,
  uri: string,
  line: number,
  character: number,
): AccessResult | null {
  const ref = table.references.find(
    r => r.loc.line === line && r.loc.character === character &&
      (r.kind === 'arrow_access' || r.kind === 'dot_access'),
  );
  if (!ref) {
    return null;
  }

  const doc = ctx.documents.get(uri);
  if (!doc) return null;
  // parse() uses the LRU cache — typically a cache hit for open documents
  const tree = parse(doc.getText(), uri);
  if (!tree) return null;

  const node = tree.rootNode.descendantForPosition({ row: line, column: character });
  if (!node) return null;

  let postfixNode = node;
  while (postfixNode.parent && postfixNode.type !== 'postfix_expr') {
    postfixNode = postfixNode.parent;
  }
  if (postfixNode.type !== 'postfix_expr') return null;

  const children = postfixNode.children;
  let lhsNode = null;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if ((child.type === '->' || child.type === '.' || child.type === '->?' || child.type === '?->') &&
        i + 1 < children.length &&
        children[i + 1].startPosition.row === node.startPosition.row &&
        children[i + 1].startPosition.column === node.startPosition.column) {
      lhsNode = children[i - 1];
      break;
    }
  }
  if (!lhsNode) {
    return null;
  }

  const lhsName = lhsNode.text;
  const lhsRef = table.references.find(
    r => r.name === lhsName && r.resolvesTo !== null &&
      r.loc.line === lhsNode.startPosition.row &&
      r.loc.character === lhsNode.startPosition.column,
  );
  const lhsDecl = lhsRef && lhsRef.resolvesTo !== null
    ? table.declById.get(lhsRef.resolvesTo) ?? null
    : table.declarations.find(d => d.name === lhsName) ?? null;

  if (!lhsDecl) {
    return null;
  }

  const typeCtx: TypeResolutionContext = { table, uri, index: ctx.index, stdlibIndex: ctx.stdlibIndex };
  const targetDecl = resolveMemberAccess(lhsName, ref.name, lhsDecl, typeCtx);
  if (!targetDecl) return null;

  const targetUri = findDeclUri(ctx, targetDecl, table, uri);
  return { decl: targetDecl, uri: targetUri };
}

// ---------------------------------------------------------------------------
// Convenience wrappers
// ---------------------------------------------------------------------------

/** Resolve arrow/dot access to a LSP definition location. */
export function resolveAccessDefinition(
  ctx: ResolutionContext,
  table: SymbolTable,
  uri: string,
  line: number,
  character: number,
): LspLocation | null {
  const result = resolveAccessCore(ctx, table, uri, line, character);
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
export function resolveAccessDeclaration(
  ctx: ResolutionContext,
  table: SymbolTable,
  uri: string,
  line: number,
  character: number,
): AccessResult | null {
  return resolveAccessCore(ctx, table, uri, line, character);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
