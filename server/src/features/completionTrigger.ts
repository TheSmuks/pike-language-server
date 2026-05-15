/**
 * Completion trigger detection and support utilities for Pike LSP.
 *
 * Extracted from completion.ts: trigger context detection, type member
 * resolution, and shared helper functions used across completion providers.
 */

import { Tree, Node } from "web-tree-sitter";
import type { WorkspaceIndex } from "./workspaceIndex";
import { type StdlibEntry, resetStdlibCache, resetAutoImportCache } from "./completion-stdlib";
import { utf16ToUtf8 } from "../util/positionConverter";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CompletionContext {
  index: WorkspaceIndex;
  stdlibIndex: Record<string, StdlibEntry>;
  predefBuiltins: Record<string, string>;
  uri: string;
  /** Full document text — used for line extraction in detectTriggerContext. */
  source: string;
  /** Optional runtime type inferrer (PikeWorker.typeof_()). */
  typeInferrer?: (varName: string) => Promise<string | null>;
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
  lineText: string,
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
  // lineText is passed from the caller (document text) to avoid rootNode.text
  // which materializes the entire file into a string.

  if (character >= 1) {
    const oneBefore = lineText[character - 1];
    const rootNode = tree.rootNode;

    // Dot access: 'Foo.' → find 'Foo' before the dot
    if (oneBefore === ".") {
      const lhs = findLhsBeforePosition(rootNode, line, character - 1, lineText);
      if (lhs) return { type: "dot", lhsNode: lhs };
    }

    // Arrow access: '->' — check if preceding char is '-'
    if (oneBefore === ">" && character >= 2 && lineText[character - 2] === "-") {
      const lhs = findLhsBeforePosition(rootNode, line, character - 2, lineText);
      if (lhs) return { type: "arrow", lhsNode: lhs };
    }

    if (character >= 2) {
      const twoBefore = lineText.substring(character - 2, character);

      // Arrow access: 'obj->'
      if (twoBefore === "->") {
        const lhs = findLhsBeforePosition(rootNode, line, character - 2, lineText);
        if (lhs) return { type: "arrow", lhsNode: lhs };
      }

      // Scope access: 'Foo::'
      if (twoBefore === "::") {
        const lhs = findLhsBeforePosition(rootNode, line, character - 2, lineText);
        if (lhs) return { type: "scope", scopeNode: lhs };
      }
    }

    // Call-args trigger: cursor right after '(' typed after an identifier.
    // Pattern: 'funcName(' or 'obj->method(' — the '(' is already in the
    // document and we want to offer argument-placeholder completion.
    if (lineText[character - 1] === "(") {
      const callee = findCalleeBeforeOpenParen(rootNode, line, character - 1, lineText);
      if (callee) {
        return { type: "call_args", calleeNode: callee, calleeName: callee.text };
      }
    }
  }

  return { type: "unqualified" };
}

/**
 * Find the left-hand side identifier/expression before a trigger position.
 * Handles ERROR nodes by walking children to find the last valid identifier.
 */
function findLhsBeforePosition(rootNode: Node, line: number, column: number, lineText: string): Node | null {
  const utf8Col = utf16ToUtf8(lineText, column);
  const pos = { row: line, column: utf8Col };
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
        const fallbackUtf8 = utf16ToUtf8(lineText, column - 1);
        const fallbackPos = { row: line, column: fallbackUtf8 };
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
    const fallbackUtf8 = utf16ToUtf8(lineText, column - 1);
    const fallbackPos = { row: line, column: fallbackUtf8 };
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
function findCalleeBeforeOpenParen(rootNode: Node, line: number, parenColumn: number, lineText: string): Node | null {
  // Position just before '(' — convert UTF-16 parenColumn to UTF-8 byte offset
  const utf8Col = utf16ToUtf8(lineText, parenColumn);
  const pos = { row: line, column: utf8Col };
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
    const beforeUtf8 = utf16ToUtf8(lineText, parenColumn - 1);
    const beforePos = { row: line, column: beforeUtf8 };
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

// ---------------------------------------------------------------------------
// Reset (for testing)
// ---------------------------------------------------------------------------

/**
 * Reset cached indices. Used in tests to avoid state leaking between runs.
 */
export function resetCompletionCache(): void {
  resetStdlibCache();
  resetAutoImportCache();
}
