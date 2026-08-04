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

// LSP characters and tree-sitter columns are both UTF-16 code units.
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
  // Pass parentKind="class" so that nested function/variable declarations
  // are emitted with kind Method/Field instead of Function/Variable.
  const children = body ? collectSymbols(body, 'class') : [];
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

function symbolsFromFunctionDecl(node: Node, parentKind?: string): DocumentSymbol[] {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return []; // anonymous — skip
  return [
    DocumentSymbol.create(
      nameNode.text,
      undefined,
      parentKind === 'class' ? SymbolKind.Method : SymbolKind.Function,
      toRange(node),
      nameRange(nameNode, node),
    ),
  ];
}

function symbolsFromVariableDecl(node: Node, parentKind?: string): DocumentSymbol[] {
  const names = collectNames(node);
  if (names.length === 0) return [];

  // `object handler = class { ... }();` — a class written as an expression.
  // Its members belong to the variable that holds it, not to the file, and
  // without this the outline showed only `handler` and nothing inside it.
  // Only meaningful when the declaration names one thing.
  const anonBody = names.length === 1 ? findAnonClassBody(node) : null;
  const children = anonBody ? collectSymbols(anonBody, 'class') : [];

  return names.map((nameNode) =>
    DocumentSymbol.create(
      nameNode.text,
      undefined,
      parentKind === 'class' ? SymbolKind.Field : SymbolKind.Variable,
      toRange(node),
      toRange(nameNode),
      children.length > 0 ? children : undefined,
    ),
  );
}

/**
 * The `class_body` of an `anon_class` initialising this declaration, if any.
 *
 * The initializer sits under a cascade of expression nodes, so this searches
 * rather than indexes — but it stops at the first `anon_class` and never enters
 * a nested one, so a class inside a class inside an initializer is described by
 * its own outer entry rather than flattened into this one.
 */
function findAnonClassBody(node: Node): Node | null {
  const stack: Node[] = [...node.children];
  // Bounded: the subtree is finite and every node is pushed at most once.
  while (stack.length > 0) {
    const current = stack.shift();
    if (!current) break;
    if (current.type === 'anon_class') {
      return current.childForFieldName('body')
        ?? current.children.find(c => c.type === 'class_body')
        ?? null;
    }
    stack.push(...current.children);
  }
  return null;
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
  // An anonymous enum still declares program constants. There is no enum name
  // to carry a parent symbol, so expose its members at the surrounding level.
  if (!nameNode) return members;
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

/** Extract members declared by an anonymous enum expression. */
function symbolsFromAnonymousEnum(node: Node): DocumentSymbol[] {
  const enumNode = findAnonymousEnum(node);
  if (!enumNode) return [];
  return symbolsFromEnumDecl(enumNode);
}

function findAnonymousEnum(node: Node): Node | null {
  const stack: Node[] = [...node.children];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    if (current.type === 'anon_enum') return current;
    stack.push(...current.children);
  }
  return null;
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

type DeclHandler = (node: Node, parentKind?: string) => DocumentSymbol[];

// No `preproc_define` handler, deliberately. Macros are gone by compile time,
// so Pike's own introspection does not report them as file symbols, and the
// oracle cross-check in tests/lsp/documentSymbol.test.ts asserts that every
// top-level LSP symbol exists in the Pike snapshot. `#define LOG` can also
// appear once per `#ifdef` branch, which would put duplicate siblings in the
// outline. Completeness sweeps will flag macros as "missing" — they are not.
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
 * The declaration inside a `declaration` wrapper, skipping leading modifiers.
 *
 * Returns null when the wrapper holds nothing this module knows how to emit,
 * so the caller's existing "unknown types are silently ignored" behaviour is
 * unchanged for genuinely unknown shapes.
 */
function declNodeOf(wrapper: Node): Node | null {
  for (const child of wrapper.children) {
    if (child.isError || child.isMissing) continue;
    if (child.type === 'modifier' || child.type === 'modifiers') continue;
    return child;
  }
  return null;
}

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
function collectSymbols(container: Node, parentKind: string | undefined): DocumentSymbol[] {
  const symbols: DocumentSymbol[] = [];
  for (const child of container.children) {
    // Skip ERROR / missing nodes
    if (child.isError || child.isMissing) continue;

    // Unwrap the `declaration` wrapper if present.
    //
    // Taking firstChild is not enough: modifiers are siblings inside the
    // wrapper, so `protected int f()` parses as
    // `declaration -> [modifier, function_decl]` and firstChild is the
    // modifier. No handler matched it, so EVERY `protected`, `private`,
    // `static` or `public` declaration was silently dropped from the outline —
    // which in idiomatic Pike is most of the file.
    const decl = child.type === 'declaration' ? declNodeOf(child) : child;
    if (!decl || decl.isError || decl.isMissing) continue;

    // `private { ... }` applies one modifier to a whole group. The block is not
    // a declaration itself — its children are — so flatten it into the same
    // level rather than dropping every declaration inside it.
    if (decl.type === 'modifier_block') {
      symbols.push(...collectSymbols(decl, parentKind));
      continue;
    }

    const handler = DECL_HANDLERS[decl.type];
    if (handler) {
      symbols.push(...handler(decl, parentKind));
      continue;
    }
    symbols.push(...symbolsFromAnonymousEnum(decl));
    // Unknown node types are silently ignored — not an error.
  }
  return symbols;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getDocumentSymbols(tree: Tree): DocumentSymbol[] {
  return collectSymbols(tree.rootNode, undefined);
}
