import { Tree, Node, Point } from 'web-tree-sitter';

// Minimal LSP types for documentSymbol. Keep in sync with diagnostics.ts until
// a shared types module is introduced.

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export enum SymbolKind {
  File = 1,
  Module = 2,
  Namespace = 3,
  Package = 4,
  Class = 5,
  Method = 6,
  Property = 7,
  Field = 8,
  Constructor = 9,
  Enum = 10,
  Interface = 11,
  Function = 12,
  Variable = 13,
  Constant = 14,
  EnumMember = 22,
  TypeParameter = 26,
}

export interface DocumentSymbol {
  name: string;
  kind: SymbolKind;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toPosition(point: Point): Position {
  return { line: point.row, character: point.column };
}

function toRange(node: Node): Range {
  return {
    start: toPosition(node.startPosition),
    end: toPosition(node.endPosition),
  };
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
    {
      name: nameNode.text,
      kind: SymbolKind.Class,
      range: toRange(node),
      selectionRange: nameRange(nameNode, node),
      children,
    },
  ];
}

function symbolsFromFunctionDecl(node: Node): DocumentSymbol[] {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return []; // anonymous — skip
  return [
    {
      name: nameNode.text,
      kind: SymbolKind.Function,
      range: toRange(node),
      selectionRange: nameRange(nameNode, node),
    },
  ];
}

function symbolsFromVariableDecl(node: Node): DocumentSymbol[] {
  const names = collectNames(node);
  if (names.length === 0) return [];
  return names.map((nameNode) => ({
    name: nameNode.text,
    kind: SymbolKind.Variable,
    range: toRange(node),
    selectionRange: toRange(nameNode),
  }));
}

function symbolsFromConstantDecl(node: Node): DocumentSymbol[] {
  const names = collectNames(node);
  if (names.length === 0) return [];
  return names.map((nameNode) => ({
    name: nameNode.text,
    kind: SymbolKind.Constant,
    range: toRange(node),
    selectionRange: toRange(nameNode),
  }));
}

function symbolsFromEnumDecl(node: Node): DocumentSymbol[] {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return []; // anonymous enum — skip
  const members: DocumentSymbol[] = [];
  for (const child of node.children) {
    if (child.type === 'enum_member') {
      const memberName = child.childForFieldName('name');
      if (memberName) {
        members.push({
          name: memberName.text,
          kind: SymbolKind.EnumMember,
          range: toRange(child),
          selectionRange: toRange(memberName),
        });
      }
    }
  }
  return [
    {
      name: nameNode.text,
      kind: SymbolKind.Enum,
      range: toRange(node),
      selectionRange: nameRange(nameNode, node),
      children: members,
    },
  ];
}

function symbolsFromImportDecl(node: Node): DocumentSymbol[] {
  const pathNode = node.childForFieldName('path');
  if (!pathNode) return [];
  return [
    {
      name: pathNode.text,
      kind: SymbolKind.Module,
      range: toRange(node),
      selectionRange: toRange(pathNode),
    },
  ];
}

function symbolsFromInheritDecl(node: Node): DocumentSymbol[] {
  // Prefer alias over path for display
  const aliasNode = node.childForFieldName('alias');
  const pathNode = node.childForFieldName('path');
  const displayNode = aliasNode ?? pathNode;
  if (!displayNode) return [];
  return [
    {
      name: displayNode.text,
      kind: SymbolKind.Module,
      range: toRange(node),
      selectionRange: toRange(displayNode),
    },
  ];
}

function symbolsFromTypedefDecl(node: Node): DocumentSymbol[] {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return [];
  return [
    {
      name: nameNode.text,
      kind: SymbolKind.TypeParameter,
      range: toRange(node),
      selectionRange: toRange(nameNode),
    },
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
