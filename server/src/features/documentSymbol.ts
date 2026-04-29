/**
 * DocumentSymbol provider — converts tree-sitter AST to LSP DocumentSymbol[].
 *
 * Uses canonical LSP types from vscode-languageserver (decision 0018).
 */

import {
  DocumentSymbol,
  SymbolKind,
  Range,
  Position,
} from 'vscode-languageserver/node';
import { Tree, Node, Point } from 'web-tree-sitter';

export { DocumentSymbol, SymbolKind };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toPosition(point: Point): Position {
  return Position.create(point.row, point.column);
}

function toRange(node: Node): Range {
  return Range.create(toPosition(node.startPosition), toPosition(node.endPosition));
}

function nameRange(nameNode: Node | null, fallback: Node): Range {
  return nameNode ? toRange(nameNode) : toRange(fallback);
}

// ---------------------------------------------------------------------------
// Declaration extraction
// ---------------------------------------------------------------------------

/** Collect all identifier names from a node's children with field name 'name'. */
function collectNames(node: Node): Node[] {
  return node.childrenForFieldName('name');
}

function symbolsFromClassDecl(node: Node): DocumentSymbol[] {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return []; // anonymous class — skip
  const body = node.childForFieldName('body');
  const children = body ? collectSymbols(body) : [];
  return [
    DocumentSymbol.create(
      nameNode.text,
      undefined,
      SymbolKind.Class,
      toRange(node),
      nameRange(nameNode, node),
      children,
    ),
  ];
}

function symbolsFromFunctionDecl(node: Node): DocumentSymbol[] {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return []; // anonymous — skip
  return [
    DocumentSymbol.create(
      nameNode.text,
      undefined,
      SymbolKind.Function,
      toRange(node),
      nameRange(nameNode, node),
    ),
  ];
}

function symbolsFromVariableDecl(node: Node): DocumentSymbol[] {
  const names = collectNames(node);
  if (names.length === 0) return [];
  return names.map((nameNode) =>
    DocumentSymbol.create(
      nameNode.text,
      undefined,
      SymbolKind.Variable,
      toRange(node),
      toRange(nameNode),
    ),
  );
}

function symbolsFromConstantDecl(node: Node): DocumentSymbol[] {
  const names = collectNames(node);
  if (names.length === 0) return [];
  return names.map((nameNode) =>
    DocumentSymbol.create(
      nameNode.text,
      undefined,
      SymbolKind.Constant,
      toRange(node),
      toRange(nameNode),
    ),
  );
}

function symbolsFromEnumDecl(node: Node): DocumentSymbol[] {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return []; // anonymous enum — skip
  const members: DocumentSymbol[] = [];
  for (const child of node.children) {
    if (child.type === 'enum_member') {
      const memberName = child.childForFieldName('name');
      if (memberName) {
        members.push(
          DocumentSymbol.create(
            memberName.text,
            undefined,
            SymbolKind.EnumMember,
            toRange(child),
            toRange(memberName),
          ),
        );
      }
    }
  }
  return [
    DocumentSymbol.create(
      nameNode.text,
      undefined,
      SymbolKind.Enum,
      toRange(node),
      nameRange(nameNode, node),
      members,
    ),
  ];
}

function symbolsFromImportDecl(node: Node): DocumentSymbol[] {
  const pathNode = node.childForFieldName('path');
  if (!pathNode) return [];
  return [
    DocumentSymbol.create(
      pathNode.text,
      undefined,
      SymbolKind.Module,
      toRange(node),
      toRange(pathNode),
    ),
  ];
}

function symbolsFromInheritDecl(node: Node): DocumentSymbol[] {
  // Prefer alias over path for display
  const aliasNode = node.childForFieldName('alias');
  const pathNode = node.childForFieldName('path');
  const displayNode = aliasNode ?? pathNode;
  if (!displayNode) return [];
  return [
    DocumentSymbol.create(
      displayNode.text,
      undefined,
      SymbolKind.Module,
      toRange(node),
      toRange(displayNode),
    ),
  ];
}

function symbolsFromTypedefDecl(node: Node): DocumentSymbol[] {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return [];
  return [
    DocumentSymbol.create(
      nameNode.text,
      undefined,
      SymbolKind.TypeParameter,
      toRange(node),
      toRange(nameNode),
    ),
  ];
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

type DeclHandler = (node: Node) => DocumentSymbol[];

const DECL_HANDLERS: Record<string, DeclHandler> = {
  class_decl: symbolsFromClassDecl,
  function_decl: symbolsFromFunctionDecl,
  local_function_decl: symbolsFromFunctionDecl,
  variable_decl: symbolsFromVariableDecl,
  local_declaration: symbolsFromVariableDecl,
  constant_decl: symbolsFromConstantDecl,
  enum_decl: symbolsFromEnumDecl,
  import_decl: symbolsFromImportDecl,
  inherit_decl: symbolsFromInheritDecl,
  typedef_decl: symbolsFromTypedefDecl,
};

/**
 * Walk children of a container node (program, class_body, etc.) and collect
 * symbols.  Each child is expected to be a `declaration` wrapper around the
 * actual declaration node, or the declaration node itself.
 */
function collectSymbols(container: Node): DocumentSymbol[] {
  const symbols: DocumentSymbol[] = [];
  for (const child of container.children) {
    // Skip ERROR / missing nodes
    if (child.isError || child.isMissing) continue;

    // Unwrap `declaration` wrapper if present
    const decl = child.type === 'declaration' ? child.firstChild : child;
    if (!decl || decl.isError || decl.isMissing) continue;

    const handler = DECL_HANDLERS[decl.type];
    if (handler) {
      symbols.push(...handler(decl));
    }
    // Unknown node types are silently ignored — not an error.
  }
  return symbols;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getDocumentSymbols(tree: Tree): DocumentSymbol[] {
  return collectSymbols(tree.rootNode);
}
