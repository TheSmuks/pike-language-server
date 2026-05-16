/**
 * LHS (left-hand side) and callee resolution helpers for completion triggers.
 *
 * Extracted from completionTrigger.ts to keep file sizes under 500 lines.
 * These functions find the identifier or expression to the left of a trigger
 * position (dot, arrow, or open paren) to determine what to complete.
 */

import { Node } from "web-tree-sitter";
import { utf16ToUtf8 } from "../util/positionConverter";

// ---------------------------------------------------------------------------
// LHS resolution (dot/arrow trigger)
// ---------------------------------------------------------------------------

/**
 * Find the left-hand side identifier/expression before a trigger position.
 * Handles ERROR nodes by walking children to find the last valid identifier.
 */
export function findLhsBeforePosition(rootNode: Node, line: number, column: number, lineText: string): Node | null {
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

  // If the node is an anonymous operator token, look at the parent for context.
  if (node && isOperatorToken(node.type)) {
    const resolved = resolveOperatorNode(node, rootNode, line, column, lineText);
    if (resolved !== undefined) return resolved;
  }

  // If the node is an ERROR, walk its children for the last valid identifier/expression
  if (node && node.type === "ERROR") {
    const errorResult = resolveErrorNode(node);
    if (errorResult) return errorResult;
  }

  // Fall back: try position one column before the trigger
  return fallbackLhsBeforePosition(rootNode, line, column, lineText);
}

/**
 * Resolve an operator token node by looking at parent context.
 * Returns undefined if the caller should continue to next resolution step,
 * or null if resolution failed.
 */
function resolveOperatorNode(
  node: Node,
  rootNode: Node,
  line: number,
  column: number,
  lineText: string,
): Node | null | undefined {
  // If parent is ERROR, use the ERROR handling
  if (node.parent?.type === "ERROR") {
    return resolveErrorNode(node.parent);
  }
  if (node.parent?.type === "postfix_expr") {
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
  }
  // Operator token with unknown parent — try fallback
  if (column > 0) {
    const fallbackUtf8 = utf16ToUtf8(lineText, column - 1);
    const fallbackPos = { row: line, column: fallbackUtf8 };
    const fallback = rootNode.descendantForPosition(fallbackPos);
    if (fallback) return findIdentifierInExpr(fallback);
  }
  return null;
}

/** Walk ERROR node children to find the last valid identifier or expression. */
function resolveErrorNode(node: Node): Node | null {
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

  // ERROR might be just the operator with the expression in a previous sibling
  if (node.parent) {
    return findIdentifierBeforeError(node);
  }
  return null;
}

/** Search previous siblings of an ERROR node for an identifier or postfix_expr. */
function findIdentifierBeforeError(node: Node): Node | null {
  const siblings = node.parent!.children;
  // Tree-sitter node wrappers are not reference-identical;
  // use equals() to find the ERROR's index among siblings.
  let errorIdx = -1;
  for (let i = 0; i < siblings.length; i++) {
    if (siblings[i].equals(node)) { errorIdx = i; break; }
  }
  for (let i = errorIdx - 1; i >= 0; i--) {
    const sib = siblings[i];
    if (sib.type === "comma_expr" || sib.type === "expression_statement") {
      const postfix = findPostfixExprOrIdentifier(sib);
      if (postfix) return postfix;
      return findIdentifierInExpr(sib);
    }
  }
  return null;
}

/** Fallback: try position one column before the trigger. */
function fallbackLhsBeforePosition(
  rootNode: Node,
  line: number,
  column: number,
  lineText: string,
): Node | null {
  if (column <= 0) return null;
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
  if (fallback) {
    const ident = findIdentifierInExpr(fallback);
    if (ident) return ident;
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
export function findCalleeBeforeOpenParen(rootNode: Node, line: number, parenColumn: number, lineText: string): Node | null {
  // Position just before '(' — convert UTF-16 parenColumn to UTF-8 byte offset
  const utf8Col = utf16ToUtf8(lineText, parenColumn);
  const pos = { row: line, column: utf8Col };
  const node = rootNode.descendantForPosition(pos);
  if (!node) return null;

  // The '(' token itself — look for an identifier sibling before it.
  if (node.type === "(" && node.parent) {
    const callee = findCalleeBeforeParenInSiblings(node, node.parent.children);
    if (callee) return callee;
  }

  // argument_list node — its parent is a postfix_expr, callee is before it
  if (node.type === "argument_list" && node.parent) {
    const callee = findCalleeBeforeParenInSiblings(node, node.parent.children);
    if (callee) return callee;
  }

  // postfix_expr that contains the '(' — find the callee before the '('
  if (node.type === "postfix_expr") {
    const callee = findCalleeInPostfixChildren(node.children);
    if (callee) return callee;
  }

  // Fallback: look at the node right before '(' using position
  return fallbackCalleeBeforeParen(rootNode, line, parenColumn, lineText);
}

/** Walk backward through siblings to find a callee identifier before a paren/argument_list. */
function findCalleeBeforeParenInSiblings(
  anchor: Node,
  siblings: Node[],
): Node | null {
  const anchorIdx = siblings.findIndex(s => s.equals(anchor));
  for (let i = anchorIdx - 1; i >= 0; i--) {
    const sib = siblings[i];
    if (sib.type === "identifier" || sib.type === "identifier_expr") {
      return sib;
    }
    if (sib.isNamed) {
      const ident = findIdentifierInExpr(sib);
      if (ident) return ident;
    }
  }
  return null;
}

/** Find the callee identifier before '(' or argument_list in a postfix_expr's children. */
function findCalleeInPostfixChildren(siblings: Node[]): Node | null {
  for (let i = siblings.length - 1; i >= 0; i--) {
    const sib = siblings[i];
    if (sib.type === "(" || sib.type === "argument_list") {
      for (let j = i - 1; j >= 0; j--) {
        const callee = siblings[j];
        if (callee.type === "identifier" || callee.type === "identifier_expr") {
          return callee;
        }
        if (callee.isNamed) {
          const ident = findIdentifierInExpr(callee);
          if (ident) return ident;
        }
      }
      break;
    }
  }
  return null;
}

/** Fallback: find callee by looking at the position right before '('. */
function fallbackCalleeBeforeParen(
  rootNode: Node,
  line: number,
  parenColumn: number,
  lineText: string,
): Node | null {
  if (parenColumn <= 0) return null;
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
