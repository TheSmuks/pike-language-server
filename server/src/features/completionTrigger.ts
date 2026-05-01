/**
 * Completion trigger detection and support utilities for Pike LSP.
 *
 * Extracted from completion.ts: trigger context detection, stdlib index
 * building, and shared helper functions used across completion providers.
 */

import { Tree, Node } from "web-tree-sitter";
import {
  CompletionItem,
  CompletionItemKind,
} from "vscode-languageserver/node";
import {
  type SymbolTable,
  type Declaration,
  type DeclKind,
  type Range,
  getSymbolsInScope,
  getDeclarationsInScope,
  PRIMITIVE_TYPES,
} from "./symbolTable";
import type { WorkspaceIndex } from "./workspaceIndex";
import { resolveType } from "./typeResolver";
import { stripScopeWrapper } from "../util/stripScope";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StdlibEntry {
  signature: string;
  markdown: string;
}

export interface CompletionContext {
  index: WorkspaceIndex;
  stdlibIndex: Record<string, StdlibEntry>;
  predefBuiltins: Record<string, string>;
  uri: string;
}

// ---------------------------------------------------------------------------
// Stdlib secondary index — prefix → direct children
// ---------------------------------------------------------------------------

interface StdlibMember {
  name: string;
  fqn: string;
  signature: string;
  kind: CompletionItemKind;
}

let stdlibChildrenMap: Map<string, StdlibMember[]> | null = null;
let stdlibTopLevelNames: { name: string; kind: CompletionItemKind }[] | null = null;

/**
 * Build the secondary stdlib index (lazy, once).
 * Maps FQN prefixes like "predef.Stdio.File" to their direct child members.
 */
function buildStdlibChildrenMap(
  stdlibIndex: Record<string, StdlibEntry>,
): Map<string, StdlibMember[]> {
  const map = new Map<string, StdlibMember[]>();

  for (const [fqn, entry] of Object.entries(stdlibIndex)) {
    const parts = fqn.split(".");
    if (parts.length < 2 || parts[0] !== "predef") continue;

    // The direct child name is the last segment
    const childName = parts[parts.length - 1];
    // The parent prefix is everything except the last segment
    const parentPrefix = parts.slice(0, -1).join(".");

    const member: StdlibMember = {
      name: childName,
      fqn,
      signature: entry.signature,
      kind: inferStdlibKind(entry.signature),
    };

    const existing = map.get(parentPrefix);
    if (existing) {
      existing.push(member);
    } else {
      map.set(parentPrefix, [member]);
    }
  }

  return map;
}

export function getStdlibChildrenMap(
  stdlibIndex: Record<string, StdlibEntry>,
): Map<string, StdlibMember[]> {
  if (!stdlibChildrenMap) {
    stdlibChildrenMap = buildStdlibChildrenMap(stdlibIndex);
  }
  return stdlibChildrenMap;
}

/**
 * Get top-level stdlib module names (first segment after predef.).
 */
export function getStdlibTopLevel(
  stdlibIndex: Record<string, StdlibEntry>,
): { name: string; kind: CompletionItemKind }[] {
  if (!stdlibTopLevelNames) {
    const names = new Map<string, CompletionItemKind>();
    for (const fqn of Object.keys(stdlibIndex)) {
      const parts = fqn.split(".");
      if (parts.length < 2 || parts[0] !== "predef") continue;
      const mod = parts[1];
      if (!names.has(mod)) {
        const entry = stdlibIndex[fqn];
        names.set(mod, inferStdlibKind(entry.signature));
      }
    }
    stdlibTopLevelNames = [...names.entries()].map(([name, kind]) => ({ name, kind }));
  }
  return stdlibTopLevelNames;
}

/**
 * Infer CompletionItemKind from a stdlib signature string.
 */
function inferStdlibKind(signature: string): CompletionItemKind {
  if (signature.startsWith("inherit ")) return CompletionItemKind.Class;
  if (signature.includes("(")) return CompletionItemKind.Method;
  if (/^(constant|final)\s/.test(signature)) return CompletionItemKind.Constant;
  return CompletionItemKind.Variable;
}

// ---------------------------------------------------------------------------
// Trigger detection
// ---------------------------------------------------------------------------

export type TriggerContext =
  | { type: "dot"; lhsNode: Node }
  | { type: "arrow"; lhsNode: Node }
  | { type: "scope"; scopeNode: Node }
  | { type: "unqualified" };

/**
 * Determine what kind of completion is requested based on the node at the cursor.
 */
export function detectTriggerContext(
  node: Node,
  line: number,
  character: number,
  tree: Tree,
): TriggerContext {
  // Check if the cursor is right after a trigger character
  // The node at the cursor might be the trigger itself or an error node

  // Walk up from the node to find a postfix_expr or scope_expr
  let current: Node | null = node;

  // First check: is this a scope_expr? (Foo::member)
  if (current.type === "scope_expr") {
    const scopeNode = current.childForFieldName("scope");
    if (scopeNode) {
      return { type: "scope", scopeNode };
    }
  }

  // Check parent chain for scope_expr
  let parent: Node | null = current.parent;
  while (parent) {
    if (parent.type === "scope_expr") {
      const scopeNode = parent.childForFieldName("scope");
      if (scopeNode) {
        return { type: "scope", scopeNode };
      }
    }
    parent = parent.parent;
  }

  // Check for dot or arrow access in postfix_expr
  // Pattern: postfix_expr = expr '.' identifier | expr '->' identifier
  current = node;

  // If the node is an identifier inside a postfix_expr, look for the operator
  if (current.parent?.type === "postfix_expr") {
    const siblings = current.parent.children;
    for (let i = 0; i < siblings.length; i++) {
      const child = siblings[i];
      if (child.type === "." && i > 0) {
        return { type: "dot", lhsNode: siblings[i - 1] };
      }
      if ((child.type === "->" || child.type === "->?" || child.type === "?->") && i > 0) {
        return { type: "arrow", lhsNode: siblings[i - 1] };
      }
    }
  }

  // Check if the node itself is the operator or just after it
  // Case: cursor right after typing '.' or '->'
  // The tree might have the dot/arrow as a sibling of the current node
  if (current.type === "." && current.parent?.type === "postfix_expr") {
    const siblings = current.parent.children;
    const dotIdx = siblings.indexOf(current);
    if (dotIdx > 0) {
      return { type: "dot", lhsNode: siblings[dotIdx - 1] };
    }
  }

  if ((current.type === "->" || current.type === "->?" || current.type === "?->") && current.parent?.type === "postfix_expr") {
    const siblings = current.parent.children;
    const arrowIdx = siblings.indexOf(current);
    if (arrowIdx > 0) {
      return { type: "arrow", lhsNode: siblings[arrowIdx - 1] };
    }
  }

  // Check parent for the same pattern
  parent = current.parent;
  if (parent?.type === "postfix_expr") {
    const siblings = parent.children;
    for (let i = 0; i < siblings.length; i++) {
      const child = siblings[i];
      if (child.type === "." && i > 0) {
        return { type: "dot", lhsNode: siblings[i - 1] };
      }
      if ((child.type === "->" || child.type === "->?" || child.type === "?->") && i > 0) {
        return { type: "arrow", lhsNode: siblings[i - 1] };
      }
    }
  }

  // Check for ':' after ':' (:: trigger) — look for inherit_specifier
  if (current.type === "::" || current.type === "inherit_specifier") {
    // Cursor is right after ::
    let scopeNode: Node | null = current;
    if (current.type === "::") {
      scopeNode = current.parent; // inherit_specifier
    }
    if (scopeNode) {
      return { type: "scope", scopeNode };
    }
  }

  // Check if the text right before the cursor is "->" or "::"
  // This handles the case where the tree hasn't been updated yet
  // or where trailing expressions (e.g., 'Stdio.\n') produce ERROR nodes.
  const rootNode = tree.rootNode;
  const lineText = rootNode.text.split("\n")[line] ?? "";

  if (character >= 1) {
    const oneBefore = lineText[character - 1];

    // Dot access: 'Foo.' → find 'Foo' before the dot
    if (oneBefore === ".") {
      const lhs = findLhsBeforePosition(rootNode, line, character - 1);
      if (lhs) return { type: "dot", lhsNode: lhs };
    }

    // Arrow access: '->' — check if preceding char is '-'
    if (oneBefore === ">" && character >= 2 && lineText[character - 2] === "-") {
      const lhs = findLhsBeforePosition(rootNode, line, character - 2);
      if (lhs) return { type: "arrow", lhsNode: lhs };
    }
  }

  if (character >= 2) {
    const twoBefore = lineText.substring(character - 2, character);

    // Arrow access: 'obj->'
    if (twoBefore === "->") {
      const lhs = findLhsBeforePosition(rootNode, line, character - 2);
      if (lhs) return { type: "arrow", lhsNode: lhs };
    }

    // Scope access: 'Foo::'
    if (twoBefore === "::") {
      const lhs = findLhsBeforePosition(rootNode, line, character - 2);
      if (lhs) return { type: "scope", scopeNode: lhs };
    }
  }

  return { type: "unqualified" };
}

/**
 * Find the left-hand side identifier/expression before a trigger position.
 * Handles ERROR nodes by walking children to find the last valid identifier.
 */
function findLhsBeforePosition(rootNode: Node, line: number, column: number): Node | null {
  const pos = { row: line, column };
  let node = rootNode.descendantForPosition(pos);

  // If the node is an identifier, use it directly
  if (node && (node.type === "identifier" || node.type === "identifier_expr")) {
    return node;
  }

  // If the node is a postfix_expr, find the leftmost child that's an expression
  if (node && node.type === "postfix_expr") {
    return node.child(0);
  }
  // If the node is an anonymous operator token (e.g., '->', '.', '::'),
  // look at the parent for context.
  if (node && isOperatorToken(node.type)) {
    // If parent is ERROR, use the ERROR handling below
    if (node.parent?.type === "ERROR") {
      node = node.parent;
    } else if (node.parent?.type === "postfix_expr") {
      // Valid postfix_expr: the identifier before the operator is a sibling
      const siblings = node.parent.children;
      let opIdx = -1;
      for (let i = 0; i < siblings.length; i++) {
        if (siblings[i].equals(node)) { opIdx = i; break; }
      }
      if (opIdx > 0) {
        const prev = siblings[opIdx - 1];
        return findIdentifierInExpr(prev);
      }
    } else {
      // Operator token with unknown parent — try fallback
      if (column > 0) {
        const fallbackPos = { row: line, column: column - 1 };
        const fallback = rootNode.descendantForPosition(fallbackPos);
        if (fallback) return findIdentifierInExpr(fallback);
      }
      return null;
    }
  }


  // If the node is an ERROR, walk its children for the last valid identifier/expression
  if (node && node.type === "ERROR") {
    let best: Node | null = null;
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child && (child.type === "identifier" || child.type === "identifier_expr" ||
          child.type === "postfix_expr")) {
        best = child;
      }
    }
    if (best) {
      if (best.type === "postfix_expr") return best.child(0);
      return best;
    }

    // ERROR might be just the operator (e.g., '->') with the expression
    // in a previous sibling. Check previous siblings.
    if (node.parent) {
      const siblings = node.parent.children;
      // Tree-sitter node wrappers are not reference-identical;
      // use equals() to find the ERROR's index among siblings.
      let errorIdx = -1;
      for (let i = 0; i < siblings.length; i++) {
        if (siblings[i].equals(node)) { errorIdx = i; break; }
      }
      for (let i = errorIdx - 1; i >= 0; i--) {
        const sib = siblings[i];
        if (sib.type === "comma_expr" || sib.type === "expression_statement") {
          // Drill into expression to find the identifier
          return findIdentifierInExpr(sib);
        }
      }
    }
  }

  // Fall back: try position one column before the trigger
  if (column > 0) {
    const fallbackPos = { row: line, column: column - 1 };
    const fallback = rootNode.descendantForPosition(fallbackPos);
    if (fallback && (fallback.type === "identifier" || fallback.type === "identifier_expr")) {
      return fallback;
    }
    // The fallback node might be deep inside expression nesting — walk up
    // to find an identifier
    if (fallback) {
      const ident = findIdentifierInExpr(fallback);
      if (ident) return ident;
    }
  }

  return null;
}

/**
 * Drill into an expression node tree to find the leaf identifier.
 * Pike expressions nest deeply (comma_expr → assign_expr → ... → postfix_expr → identifier).
 */
function findIdentifierInExpr(node: Node): Node | null {
  if (node.type === "identifier" || node.type === "identifier_expr") {
    return node;
  }
  // Check direct children first (deepest-nested is the leaf)
  const child = node.child(node.childCount - 1);
  if (child) {
    return findIdentifierInExpr(child);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check if a node type is an anonymous operator token that triggers completion. */
const OPERATOR_TOKENS = new Set(["->", "->?", "?->", ".", "::"]);
function isOperatorToken(type: string): boolean {
  return OPERATOR_TOKENS.has(type);
}

/**
 * Check if a name is a valid completable identifier (not an operator).
 * Filters out Pike backtick identifiers and operators like `>`, `==`, `->`, etc.
 */
export function isCompletableIdentifier(name: string): boolean {
  // Skip backtick identifiers (operators like `->`, `+`, `[]`)
  if (name.startsWith("`")) return false;
  // Skip pure operator tokens
  if (/^[<>!=&|^~%/*+\-]+$/.test(name)) return false;
  // Skip bracket-like tokens
  if (/^[\[\](){}]+$/.test(name)) return false;
  // Must start with a letter or underscore
  if (!/^[a-zA-Z_]/.test(name)) return false;
  return true;
}


const DECL_KIND_TO_COMPLETION_KIND: Record<DeclKind, CompletionItemKind> = {
  function: CompletionItemKind.Function,
  class: CompletionItemKind.Class,
  variable: CompletionItemKind.Variable,
  constant: CompletionItemKind.Constant,
  enum: CompletionItemKind.Enum,
  enum_member: CompletionItemKind.EnumMember,
  typedef: CompletionItemKind.TypeParameter,
  parameter: CompletionItemKind.Variable,
  inherit: CompletionItemKind.Class,
  import: CompletionItemKind.Module,
};


export function declToCompletionItem(decl: Declaration, priority: number): CompletionItem {
  return {
    label: decl.name,
    kind: DECL_KIND_TO_COMPLETION_KIND[decl.kind] ?? CompletionItemKind.Text,
    sortText: padSortKey(priority) + decl.name,
  };
}

export function padSortKey(n: number): string {
  return String(n).padStart(4, "0");
}

/**
 * Find the declaration for a name at a given position.
 * Walks scope chain to find the innermost declaration matching the name.
 */
export function findDeclarationForName(
  table: SymbolTable,
  name: string,
  line: number,
  character: number,
): Declaration | null {
  // Look for a reference at this position matching the name
  for (const ref of table.references) {
    if (ref.name === name && ref.resolvesTo !== null) {
      const decl = table.declById.get(ref.resolvesTo);
      if (decl) return decl;
    }
  }

  // Look for a declaration with this name in scope
  const symbols = getSymbolsInScope(table, line, character);
  return symbols.find(d => d.name === name) ?? null;
}

/**
 * Try to resolve the members of a declared type.
 * For class types, find the class scope and enumerate its declarations.
 */
export async function resolveTypeMembers(
  decl: Declaration,
  table: SymbolTable,
  ctx: CompletionContext,
): Promise<CompletionItem[]> {
  const items: CompletionItem[] = [];

  // If the declaration is a class, find its class scope
  if (decl.kind === "class") {
    const classScope = table.scopes.find(s =>
      s.kind === "class" &&
      s.parentId === decl.scopeId &&
      rangeContains(s.range, decl.nameRange.start),
    );
    if (classScope) {
      const classDecls = getDeclarationsInScope(table, classScope.id);
      for (const cd of classDecls) {
        items.push(declToCompletionItem(cd, 5));
      }
    }
  }

  // If the declaration is a variable/parameter/function, resolve its type
  // Functions have declaredType set to their return type
  // Variables with assignedType use that when declaredType is absent/mixed
  if (decl.kind === "variable" || decl.kind === "parameter" || decl.kind === "function") {
    // Use assignedType when declaredType is absent or a primitive like 'mixed'
    const typeName = (decl.declaredType && !PRIMITIVE_TYPES.has(decl.declaredType))
      ? decl.declaredType
      : decl.assignedType;
    if (typeName) {
      // Use typeResolver for same-file, cross-file, and qualified type resolution
      const result = await resolveType(typeName, {
        table,
        uri: ctx.uri,
        index: ctx.index,
        stdlibIndex: ctx.stdlibIndex,
      });
      if (result?.decl.kind === "class") {
        const ownerTable = result.table;
        // Find the class body scope — it's a child of the scope containing the class declaration
        const classScope = ownerTable.scopes.find(s =>
          s.kind === "class" && s.parentId === result.decl.scopeId &&
          rangeContains(s.range, result.decl.nameRange.start),
        );
        if (classScope) {
          const classDecls = getDeclarationsInScope(ownerTable, classScope.id);
          for (const cd of classDecls) {
            items.push(declToCompletionItem(cd, 5));
          }
          // Include inherited members
          for (const inheritedId of classScope.inheritedScopes) {
            const inheritedDecls = getDeclarationsInScope(ownerTable, inheritedId);
            for (const cd of inheritedDecls) {
              items.push(declToCompletionItem(cd, 5));
            }
          }
        }
      }
    }
  }

  return items;
}

/** Check if a position is within a range (inclusive start, exclusive end). */
function rangeContains(range: Range, pos: { line: number; character: number }): boolean {
  const { start, end } = range;
  if (pos.line < start.line || pos.line > end.line) return false;
  if (pos.line === start.line && pos.character < start.character) return false;
  if (pos.line === end.line && pos.character > end.character) return false;
  return true;
}

/**
 * Clean a predef builtin signature for display.
 * Removes scope wrappers and simplifies overloaded signatures.
 */
export function cleanPredefSignature(raw: string): string {
  let sig = stripScopeWrapper(raw);
  // Take the first overload if multiple
  const parts = sig.split(" | function");
  sig = parts[0].trim();
  // Remove leading "function" if present
  if (sig.startsWith("function")) {
    sig = sig.slice(8).trim();
  }
  return sig || raw;
}

// ---------------------------------------------------------------------------
// Reset (for testing)
// ---------------------------------------------------------------------------

/**
 * Reset cached indices. Used in tests to avoid state leaking between runs.
 */
export function resetCompletionCache(): void {
  stdlibChildrenMap = null;
  stdlibTopLevelNames = null;
}
