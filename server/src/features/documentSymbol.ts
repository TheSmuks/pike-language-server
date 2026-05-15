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
import { utf8ToUtf16 } from '../util/positionConverter';

export { DocumentSymbol, SymbolKind };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toPosition(point: Point, lines: string[]): Position {
  return Position.create(point.row, utf8ToUtf16(lines[point.row] ?? '', point.column));
}

function toRange(node: Node, lines: string[]): Range {
  return Range.create(toPosition(node.startPosition, lines), toPosition(node.endPosition, lines));
}

function nameRange(nameNode: Node | null, fallback: Node, lines: string[]): Range {
  return nameNode ? toRange(nameNode, lines) : toRange(fallback, lines);
}

// ---------------------------------------------------------------------------
// Declaration extraction
// ---------------------------------------------------------------------------

/** Collect all identifier names from a node's children with field name 'name'. */
function collectNames(node: Node): Node[] {
  return node.childrenForFieldName('name');
}

function symbolsFromClassDecl(node: Node, lines: string[]): DocumentSymbol[] {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return []; // anonymous class — skip
  const body = node.childForFieldName('body');
  // Pass parentKind="class" so that nested function/variable declarations
  // are emitted with kind Method/Field instead of Function/Variable.
  const children = body ? collectSymbols(body, 'class', lines) : [];
  return [
    DocumentSymbol.create(
      nameNode.text,
      undefined,
      SymbolKind.Class,
      toRange(node, lines),
      nameRange(nameNode, node, lines),
      children,
    ),
  ];
}

function symbolsFromFunctionDecl(node: Node, lines: string[], parentKind?: string): DocumentSymbol[] {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return []; // anonymous — skip
  return [
    DocumentSymbol.create(
      nameNode.text,
      undefined,
      parentKind === 'class' ? SymbolKind.Method : SymbolKind.Function,
      toRange(node, lines),
      nameRange(nameNode, node, lines),
    ),
  ];
}

function symbolsFromVariableDecl(node: Node, lines: string[], parentKind?: string): DocumentSymbol[] {
  const names = collectNames(node);
  if (names.length === 0) return [];
  return names.map((nameNode) =>
    DocumentSymbol.create(
      nameNode.text,
      undefined,
      parentKind === 'class' ? SymbolKind.Field : SymbolKind.Variable,
      toRange(node, lines),
      toRange(nameNode, lines),
    ),
  );
}

function symbolsFromConstantDecl(node: Node, lines: string[]): DocumentSymbol[] {
  const names = collectNames(node);
  if (names.length === 0) return [];
  return names.map((nameNode) =>
    DocumentSymbol.create(
      nameNode.text,
      undefined,
      SymbolKind.Constant,
      toRange(node, lines),
      toRange(nameNode, lines),
    ),
  );
}

function symbolsFromEnumDecl(node: Node, lines: string[]): DocumentSymbol[] {
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
            toRange(child, lines),
            toRange(memberName, lines),
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
      toRange(node, lines),
      nameRange(nameNode, node, lines),
      members,
    ),
  ];
}

function symbolsFromImportDecl(node: Node, lines: string[]): DocumentSymbol[] {
  const pathNode = node.childForFieldName('path');
  if (!pathNode) return [];
  return [
    DocumentSymbol.create(
      pathNode.text,
      undefined,
      SymbolKind.Module,
      toRange(node, lines),
      toRange(pathNode, lines),
    ),
  ];
}

function symbolsFromInheritDecl(node: Node, lines: string[]): DocumentSymbol[] {
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
      toRange(node, lines),
      toRange(displayNode, lines),
    ),
  ];
}

function symbolsFromTypedefDecl(node: Node, lines: string[]): DocumentSymbol[] {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return [];
  return [
    DocumentSymbol.create(
      nameNode.text,
      undefined,
      SymbolKind.TypeParameter,
      toRange(node, lines),
      toRange(nameNode, lines),
    ),
  ];
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

type DeclHandler = (node: Node, lines: string[], parentKind?: string) => DocumentSymbol[];

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
 *
 * @param container - the node whose children to walk
 * @param parentKind - optional context hint: when "class", function/variable
 *                    declarations inside the container are emitted as
 *                    Method/Field rather than Function/Variable.
 */
function collectSymbols(container: Node, parentKind: string | undefined, lines: string[]): DocumentSymbol[] {
  const symbols: DocumentSymbol[] = [];
  for (const child of container.children) {
    // Skip ERROR / missing nodes
    if (child.isError || child.isMissing) continue;

    // Unwrap `declaration` wrapper if present
    const decl = child.type === 'declaration' ? child.firstChild : child;
    if (!decl || decl.isError || decl.isMissing) continue;

    const handler = DECL_HANDLERS[decl.type];
    if (handler) {
      symbols.push(...handler(decl, lines, parentKind));
    }
    // Unknown node types are silently ignored — not an error.
  }
  return symbols;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getDocumentSymbols(tree: Tree): DocumentSymbol[] {
  const lines = tree.rootNode.text.split('\n');
  return collectSymbols(tree.rootNode, undefined, lines);
}
