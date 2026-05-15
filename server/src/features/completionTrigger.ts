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
  InsertTextFormat,
} from "vscode-languageserver/node";
import {
  type SymbolTable,
  type Declaration,
  type DeclKind,
  getSymbolsInScope,
  getDeclarationsInScope,
  resolveTypeName,
  PRIMITIVE_TYPES,
} from "./symbolTable";
import type { WorkspaceIndex } from "./workspaceIndex";
import { resolveType, collectClassMembers } from "./typeResolver";
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
  /** Optional runtime type inferrer (PikeWorker.typeof_()). */
  typeInferrer?: (varName: string) => Promise<string | null>;
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

// ---------------------------------------------------------------------------
// Auto-import reverse index — unqualified name → modules providing it
// ---------------------------------------------------------------------------

interface AutoImportEntry {
  /** Unqualified symbol name (e.g. "write"). */
  name: string;
  /** Top-level module providing it (e.g. "Stdio"). */
  module: string;
  /** CompletionItemKind inferred from signature. */
  kind: CompletionItemKind;
  /** Signature from stdlib index. */
  signature: string;
}

let autoImportMap: Map<string, AutoImportEntry[]> | null = null;

/**
 * Build the reverse index: unqualified symbol name → modules that provide it.
 *
 * Only indexes symbols from top-level modules (second segment in the FQN).
 * Deeply nested class members are excluded — they require qualified access
 * anyway and auto-importing the parent module wouldn't bring them into scope.
 */
function buildAutoImportMap(
  stdlibIndex: Record<string, StdlibEntry>,
): Map<string, AutoImportEntry[]> {
  const map = new Map<string, AutoImportEntry[]>();

  for (const [fqn, entry] of Object.entries(stdlibIndex)) {
    const parts = fqn.split(".");
    // Need at least: predef.Module.Symbol (3 segments)
    if (parts.length < 3 || parts[0] !== "predef") continue;

    const moduleName = parts[1];
    const symbolName = parts[parts.length - 1];

    // Skip operator identifiers and private symbols
    if (!isCompletableIdentifier(symbolName)) continue;
    if (symbolName.startsWith("_")) continue;

    const autoEntry: AutoImportEntry = {
      name: symbolName,
      module: moduleName,
      kind: inferStdlibKind(entry.signature),
      signature: entry.signature,
    };

    const existing = map.get(symbolName);
    if (existing) {
      // Avoid duplicates from the same module
      if (!existing.some(e => e.module === moduleName)) {
        existing.push(autoEntry);
      }
    } else {
      map.set(symbolName, [autoEntry]);
    }
  }

  return map;
}

/**
 * Get all auto-import entries from the stdlib index.
 * Used by completion to filter by prefix and add auto-import suggestions.
 */
export function getAllAutoImportEntries(
  stdlibIndex: Record<string, StdlibEntry>,
): Map<string, AutoImportEntry[]> {
  if (!autoImportMap) {
    autoImportMap = buildAutoImportMap(stdlibIndex);
  }
  return autoImportMap;
}

/**
 * Reset the auto-import index. Called when the stdlib index is rebuilt.
 */
export function resetAutoImportCache(): void {
  autoImportMap = null;
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
  | { type: "call_args"; calleeNode: Node; calleeName: string }
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

  // Call-args trigger: cursor right after '(' typed after an identifier.
  // Pattern: 'funcName(' or 'obj->method(' — the '(' is already in the
  // document and we want to offer argument-placeholder completion.
  if (character >= 1 && lineText[character - 1] === "(") {
    const callee = findCalleeBeforeOpenParen(rootNode, line, character - 1);
    if (callee) {
      return { type: "call_args", calleeNode: callee, calleeName: callee.text };
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
          // For chained calls (a()->b()->), we need the postfix_expr node
          // so decomposePostfixChain can walk the full chain. For simple
          // identifiers, the postfix_expr is a single-child wrapper and
          // the chain decomposition produces the same result.
          const postfix = findPostfixExprOrIdentifier(sib);
          if (postfix) return postfix;
          return findIdentifierInExpr(sib);
        }
      }
    }
  }

  // Fall back: try position one column before the trigger
  if (column > 0) {
    const fallbackPos = { row: line, column: column - 1 };
    const fallback = rootNode.descendantForPosition(fallbackPos);
    // Prefer postfix_expr (for chained calls) over bare identifiers.
    if (fallback) {
      const postfix = findPostfixExprOrIdentifier(fallback);
      if (postfix) return postfix;
    }
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

/**
 * Drill into an expression node tree to find the outermost postfix_expr.
 * Returns the postfix_expr node for chained calls (e.g., getContainer()->getItem())
 * so that decomposePostfixChain can walk the full chain.
 * Falls back to the leaf identifier for simple expressions.
 */
function findPostfixExprOrIdentifier(node: Node): Node | null {
  // If we've reached a postfix_expr, return it — the caller will
  // decompose the chain.
  if (node.type === "postfix_expr") return node;
  if (node.type === "identifier" || node.type === "identifier_expr") {
    return node;
  }
  const child = node.child(node.childCount - 1);
  if (child) {
    return findPostfixExprOrIdentifier(child);
  }
  return null;
}

/**
 * Find the callee identifier/node immediately before an opening paren '('.
 *
 * Used by the call_args trigger to detect `funcName(` or `obj->method(`
 * patterns. Walks backward from the '(' position to find the function
 * name or method-access expression.
 *
 * Returns the identifier node for simple calls, or the full postfix_expr
 * for chained access like `obj->method(`.
 */
function findCalleeBeforeOpenParen(rootNode: Node, line: number, parenColumn: number): Node | null {
  // Position just before '('
  const pos = { row: line, column: parenColumn };
  const node = rootNode.descendantForPosition(pos);
  if (!node) return null;

  // The '(' token itself — look for an identifier sibling before it.
  if (node.type === "(" && node.parent) {
    const siblings = node.parent.children;
    const parenIdx = siblings.findIndex(s => s.equals(node));
    // Walk backward from '(' to find the callee
    for (let i = parenIdx - 1; i >= 0; i--) {
      const sib = siblings[i];
      if (sib.type === "identifier" || sib.type === "identifier_expr") {
        return sib;
      }
      // For `obj->method(`, the callee is the `->` + identifier pair inside
      // a postfix_expr. The last named child before '(' is the method name.
      if (sib.isNamed) {
        const ident = findIdentifierInExpr(sib);
        if (ident) return ident;
      }
    }
  }

  // argument_list node — its parent is a postfix_expr, callee is before it
  if (node.type === "argument_list" && node.parent) {
    const siblings = node.parent.children;
    const argIdx = siblings.findIndex(s => s.equals(node));
    for (let i = argIdx - 1; i >= 0; i--) {
      const sib = siblings[i];
      if (sib.type === "identifier" || sib.type === "identifier_expr") {
        return sib;
      }
      if (sib.isNamed) {
        const ident = findIdentifierInExpr(sib);
        if (ident) return ident;
      }
    }
  }

  // postfix_expr that contains the '(' — find the callee before the '('
  if (node.type === "postfix_expr") {
    const siblings = node.children;
    // Find the '(' or argument_list, then look before it
    for (let i = siblings.length - 1; i >= 0; i--) {
      const sib = siblings[i];
      if (sib.type === "(" || sib.type === "argument_list") {
        // Look at the node just before the paren
        for (let j = i - 1; j >= 0; j--) {
          const callee = siblings[j];
          if (callee.type === "identifier" || callee.type === "identifier_expr") {
            return callee;
          }
          // For `obj->method(`, the last named child before '(' is the method
          if (callee.isNamed) {
            const ident = findIdentifierInExpr(callee);
            if (ident) return ident;
          }
        }
        break;
      }
    }
  }

  // Fallback: look at the node right before '(' using position
  if (parenColumn > 0) {
    const beforePos = { row: line, column: parenColumn - 1 };
    const beforeNode = rootNode.descendantForPosition(beforePos);
    if (beforeNode && (beforeNode.type === "identifier" || beforeNode.type === "identifier_expr")) {
      return beforeNode;
    }
    // Might be inside a postfix_expr — walk up
    let cur: Node | null = beforeNode;
    while (cur) {
      if (cur.type === "identifier" || cur.type === "identifier_expr") return cur;
      cur = cur.parent;
    }
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
  method: CompletionItemKind.Method,
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


export function declToCompletionItem(decl: Declaration, priority: number, table?: SymbolTable): CompletionItem {
  const isFunction = decl.kind === "function" || decl.kind === "method";
  const item: CompletionItem = {
    label: decl.name,
    kind: DECL_KIND_TO_COMPLETION_KIND[decl.kind] ?? CompletionItemKind.Text,
    sortText: padSortKey(priority) + decl.name,
    // filterText ensures the client matches against the plain identifier,
    // even if the label were to change (e.g., adding signature suffix).
    filterText: decl.name,
    // Add detail for function/method/variable declarations when available.
    // Type information helps the user pick the right completion without
    // needing to resolve or hover.
    detail: decl.declaredType ?? undefined,
  };

  // For functions/methods, add snippet support with parameter placeholders.
  // The snippet looks like: functionName(${1:param1}, ${2:param2})
  if (isFunction && decl.declaredType) {
    const params = extractParamsFromType(decl.declaredType);
    if (params !== null) {
      item.insertTextFormat = InsertTextFormat.Snippet;
      item.insertText = decl.name + "(" + params + ")";
    }
  }

  // For classes, generate a constructor snippet from the create() method's
  // parameters. This gives the user tab-to-fill when constructing: ClassName(${1:arg1}).
  if (decl.kind === "class" && table) {
    const createParams = extractConstructorParams(decl, table);
    if (createParams !== null) {
      item.insertTextFormat = InsertTextFormat.Snippet;
      item.insertText = decl.name + "(" + createParams + ")";
    }
  }

  // Commit characters: typing these after selecting a completion item
  // commits the item and inserts the character, triggering the next
  // action (dot-access completion or function-call parens).
  const commitChars = computeCommitCharacters(decl, isFunction);
  if (commitChars.length > 0) {
    item.commitCharacters = commitChars;
  }

  return item;
}

/**
 * Determine commit characters for a completion item.
 *
 * - Functions/methods: no commit characters — the snippet already includes
 *   the opening paren, so adding '(' as a commit char would double it.
 * - Classes: "." triggers dot completion. "(" is NOT included because
 *   constructor snippets already include it.
 * - Variables/parameters/inherit with a non-primitive type: "." triggers
 *   dot completion on the instance.
 */
function computeCommitCharacters(decl: Declaration, isFunction: boolean): string[] {
  if (isFunction) {
    // The snippet insertText already includes '(' — adding it as a commit
    // character causes double parens: name(${1:arg})( instead of name(arg).
    return [];
  }

  if (decl.kind === "class") {
    // Classes can be dot-accessed for static members.
    // '(' omitted for the same reason as functions (constructor snippet).
    return ["."];
  }

  // Variables, parameters, and inherit aliases with a known class type
  // get dot-commit so the user can chain into member access.
  const hasClassType = decl.kind === "variable"
    || decl.kind === "parameter"
    || decl.kind === "inherit";

  if (hasClassType && hasNonPrimitiveType(decl)) {
    return ["."];
  }

  return [];
}

/**
 * Check if a declaration has a declared or assigned type that is a class
 * (non-primitive) type. Primitive types like "string", "int", "mixed" etc.
 * never have members, so dot-access would not be useful.
 */
function hasNonPrimitiveType(decl: Declaration): boolean {
  const typeStr = decl.declaredType ?? decl.assignedType;
  if (!typeStr) return false;
  // The type string may contain qualifiers or whitespace — trim before
  // checking against the primitive set.
  return !PRIMITIVE_TYPES.has(typeStr.trim());
}

/**
 * Extract parameter placeholders from a Pike function type string.
 *
 * Input:  "function(string, int:void)" or "function(void)"
 * Output: "${1:string}, ${2:int}" or "" (for void/no params)
 * Returns null if the type string is not a function type.
 */
export function extractParamsFromType(typeStr: string): string | null {
  // Match function(params:return_type) pattern
  const match = typeStr.match(/^function\s*\(([^)]*)\)/);
  if (!match) return null;

  const paramList = match[1].trim();
  if (!paramList || paramList === "void" || paramList === "...") {
    return "";
  }

  const parts = paramList.split(",").map(p => p.trim());
  // Filter out trailing return type separator (":void" etc.)
  // Pike function types: function(param1, param2 : return_type)
  const colonIdx = parts.findIndex(p => p.startsWith(":"));
  let paramTypes: string[];
  if (colonIdx !== -1) {
    paramTypes = parts.slice(0, colonIdx);
  } else {
    // Check if the last part looks like ":type" attached to previous param
    const lastPart = parts[parts.length - 1];
    if (lastPart.includes(":")) {
      // The last element contains ":returnType" — strip it
      const beforeColon = lastPart.split(":")[0].trim();
      paramTypes = [...parts.slice(0, -1), beforeColon];
    } else {
      paramTypes = parts;
    }
  }

  // Generate snippet tab stops: ${1:type1}, ${2:type2}, ...
  const placeholders = paramTypes
    .filter(p => p.length > 0)
    .map((p, i) => `\${${i + 1}:${p}}`);

  return placeholders.join(", ");
}

/**
 * Extract constructor parameter placeholders for a class declaration.
 *
 * Looks up the class scope, finds the `create()` method, and extracts
 * its parameters as snippet tab stops.
 * Returns null if the class has no create() method or it has no parameters.
 */
export function extractConstructorParams(classDecl: Declaration, table: SymbolTable): string | null {
  // Find the class scope that overlaps with the class declaration range
  const classScope = table.scopes.find(
    s => s.kind === "class" && rangesOverlap(s.range, classDecl.range),
  );
  if (!classScope) return null;

  // Find the create() method declaration in the class scope (or inherited)
  const createDecl = findCreateMethod(table, classScope);
  if (!createDecl || !createDecl.declaredType) return null;

  const params = extractParamsFromType(createDecl.declaredType);
  return params; // null if not a function type, "" if void/no-params
}

/**
 * Walk inheritance chain to find a create() method.
 */
function findCreateMethod(table: SymbolTable, scope: { id: number }): Declaration | null {
  const decls = getDeclarationsInScope(table, scope.id);
  const create = decls.find(d => d.name === "create" && (d.kind === "method" || d.kind === "function"));
  if (create) return create;

  // Check inherited scopes
  for (const decl of decls) {
    if (decl.kind === "inherit" && decl.scopeId != null) {
      const inherited = findCreateMethod(table, { id: decl.scopeId });
      if (inherited) return inherited;
    }
  }
  return null;
}

/**
 * Check if two ranges overlap (used to match class scope to class declaration).
 */
function rangesOverlap(a: { start: { line: number; character: number }; end: { line: number; character: number } }, b: { start: { line: number; character: number }; end: { line: number; character: number } }): boolean {
  if (a.start.line > b.end.line || (a.start.line === b.end.line && a.start.character > b.end.character)) return false;
  if (a.end.line < b.start.line || (a.end.line === b.start.line && a.end.character < b.start.character)) return false;
  return true;
}

/**
 * Extract parameter placeholders from a predef builtin type string.
 *
 * Predef signatures look like:
 *   "function(string, int:void)"
 *   "scope(0, function(string, int | string, void | int : int) | function(...))"
 *   "function( : int)"          (no params)
 *
 * Takes the first overload, strips scope wrapper, extracts param types.
 */
export function extractParamsFromPredefType(raw: string): string | null {
  let sig = stripScopeWrapper(raw);
  // Take the first overload if multiple (separated by " | function")
  const overloadSplit = sig.split(" | function");
  sig = overloadSplit[0].trim();
  // Strip leading "function" keyword
  if (sig.startsWith("function")) sig = sig.slice(8).trim();

  // Now parse function(params : returnType) or function(params)
  const match = sig.match(/^\(([^)]*)\)/);
  if (!match) return null;

  const paramList = match[1].trim();
  if (!paramList || paramList === "void" || paramList === "...") return "";

  // Split by comma, stop at colon (return type separator)
  const parts = paramList.split(",").map(p => p.trim());
  const colonIdx = parts.findIndex(p => p.startsWith(":"));
  const paramTypes = colonIdx !== -1
    ? parts.slice(0, colonIdx)
    : parts;

  // Filter out empty and produce tab stops
  const placeholders = paramTypes
    .filter(p => p.length > 0)
    .map((p, i) => `\${${i + 1}:${p}}`);

  return placeholders.join(", ");
}

/**
 * Extract parameter placeholders from a stdlib C-style signature.
 *
 * Stdlib signatures look like:
 *   "mixed get_value(array(string) argv, mapping(string : string) env, int|string previous)"
 *   "string __sprintf()"
 *   "inherit Opt"
 *
 * Parses the param list to extract param names (or types if no names).
 */
export function extractParamsFromStdlibSignature(signature: string): string | null {
  // Match returnType functionName(params) pattern
  const match = signature.match(/\(([^)]*)\)\s*$/);
  if (!match) return null;

  const paramList = match[1].trim();
  if (!paramList) return "";

  // Split params by comma, handling nested parens/angles
  const paramParts = splitParams(paramList);
  if (paramParts.length === 0) return "";

  const placeholders: string[] = [];
  for (let i = 0; i < paramParts.length; i++) {
    const part = paramParts[i].trim();
    if (!part || part === "void") continue;
    // Try to extract the param name (last word after type)
    const nameMatch = part.match(/(\w+)\s*$/);
    const label = nameMatch ? nameMatch[1] : part;
    placeholders.push(`\${${i + 1}:${label}}`);
  }

  if (placeholders.length === 0) return "";
  return placeholders.join(", ");
}

/**
 * Split a parameter list by commas, respecting nested parens and angles.
 */
function splitParams(paramList: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of paramList) {
    if (ch === "(" || ch === "<" || ch === "[") depth++;
    else if (ch === ")" || ch === ">" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
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

  // If the declaration is a class, collect its members
  if (decl.kind === "class") {
    const memberDecls = collectClassMembers(table, decl);
    for (const cd of memberDecls) {
      items.push(declToCompletionItem(cd, 5, table));
    }
  }

  // If the declaration is a variable/parameter/function, resolve its type
  // Functions have declaredType set to their return type
  // Variables with assignedType use that when declaredType is absent/mixed
  if (decl.kind === "variable" || decl.kind === "parameter" || decl.kind === "function") {
    // Use assignedType when declaredType is absent or a primitive like 'mixed'
    let typeName = resolveTypeName(decl);

    // If static type resolution yields nothing, try runtime inference
    if (!typeName && decl.name && ctx.typeInferrer) {
      if (decl.kind === 'variable' || decl.kind === 'parameter') {
        try {
          typeName = await ctx.typeInferrer(decl.name);
        } catch {
          // Worker unavailable — proceed without inferred type
        }
      }
    }

    if (typeName) {
      const typeCtx = {
        table,
        uri: ctx.uri,
        index: ctx.index,
        stdlibIndex: ctx.stdlibIndex,
        typeInferrer: ctx.typeInferrer,
      };
      const result = await resolveType(typeName, typeCtx);
      if (result?.decl.kind === "class") {
        const ownerTable = result.table;
        const memberDecls = collectClassMembers(ownerTable, result.decl);
        for (const cd of memberDecls) {
          items.push(declToCompletionItem(cd, 5, ownerTable));
        }
      }
    }
  }

  return items;
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

// ---------------------------------------------------------------------------
// Identifier prefix range detection for textEdit
// ---------------------------------------------------------------------------

/**
 * Find the range of the identifier prefix the user has typed.
 * Used to generate textEdit ranges for completion items.
 *
 * Walks the tree-sitter node at the cursor position. If the cursor is
 * inside an identifier node, returns the range from the identifier start
 * to the cursor. For dot/arrow/scope access, returns only the trailing
 * identifier part (after the dot/arrow/scope).
 *
 * Returns null if no identifier prefix is found (e.g., completion
 * triggered right after a dot with nothing typed yet).
 */
export function findIdentifierPrefixRange(
  tree: Tree,
  line: number,
  character: number,
): { start: { line: number; character: number }; end: { line: number; character: number } } | null {
  const root = tree.rootNode;
  if (!root) return null;
  const pos = { row: line, column: character };

  // Try to find a node at this position. Use namedDescendantForPosition
  // to skip anonymous nodes (punctuation, whitespace).
  let node = root.namedDescendantForPosition(pos);
  if (!node) return null;

  // If the cursor is at the end of an identifier, use its range.
  // If the cursor is inside an identifier, use from start to cursor.
  if (node.type === "identifier") {
    return {
      start: {
        line: node.startPosition.row,
        character: node.startPosition.column,
      },
      end: { line, character },
    };
  }

  // For error nodes (common during typing), look for an identifier child.
  if (node.type === "ERROR") {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child && child.type === "identifier") {
        // Only use if the cursor is inside or at the end of this identifier
        if (child.endPosition.row >= line && child.startPosition.column <= character) {
          return {
            start: {
              line: child.startPosition.row,
              character: child.startPosition.column,
            },
            end: { line, character },
          };
        }
      }
    }
  }

  // No identifier prefix found — completion was triggered at a structural
  // boundary (e.g., right after a dot with nothing typed yet).
  return null;
}
