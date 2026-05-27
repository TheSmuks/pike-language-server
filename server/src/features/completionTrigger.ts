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
  | { type: "unqualified" }
  | { type: "none" };

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
  const scopeFromParent = findScopeInParentChain(current);
  if (scopeFromParent) return scopeFromParent;

  // Check for dot or arrow access in postfix_expr
  // Pattern: postfix_expr = expr '.' identifier | expr '->' identifier
  const accessFromPostfix = findAccessInPostfixExpr(current);
  if (accessFromPostfix) return accessFromPostfix;

  // Check if the node itself is the operator or just after it
  // Case: cursor right after typing '.' or '->'
  const accessFromOperator = findAccessFromOperatorNode(current);
  if (accessFromOperator) return accessFromOperator;

  // Check parent for the same pattern
  const accessFromParentPostfix = findAccessInParentPostfix(current);
  if (accessFromParentPostfix) return accessFromParentPostfix;

  // Check for ':' after ':' (:: trigger) — look for inherit_specifier
  if (current.type === "::" || current.type === "inherit_specifier") {
    let scopeNode: Node | null = current;
    if (current.type === "::") {
      scopeNode = current.parent; // inherit_specifier
    }
    if (scopeNode) {
      return { type: "scope", scopeNode };
    }
  }

  // Check if the text right before the cursor is "->" or "::"
  return resolveTriggerFromLineText(character, lineText, tree, line);
}

/** Walk parent chain looking for a scope_expr node. */
function findScopeInParentChain(node: Node): TriggerContext | null {
  let parent: Node | null = node.parent;
  while (parent) {
    if (parent.type === "scope_expr") {
      const scopeNode = parent.childForFieldName("scope");
      if (scopeNode) {
        return { type: "scope", scopeNode };
      }
    }
    parent = parent.parent;
  }
  return null;
}

/** Check for dot/arrow access when the current node is inside a postfix_expr. */
function findAccessInPostfixExpr(current: Node): TriggerContext | null {
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
  return null;
}

/** Check if the current node IS the operator token inside a postfix_expr. */
function findAccessFromOperatorNode(current: Node): TriggerContext | null {
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
  return null;
}

/** Check parent postfix_expr for dot/arrow access patterns. */
function findAccessInParentPostfix(current: Node): TriggerContext | null {
  const parent = current.parent;
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
  return null;
}

/**
 * Resolve trigger context from raw line text when tree-sitter hasn't
 * updated yet or produces ERROR nodes.
 */
function resolveTriggerFromLineText(
  character: number,
  lineText: string,
  tree: Tree,
  line: number,
): TriggerContext {
  if (character < 1) return { type: "none" };

  const oneBefore = lineText[character - 1];
  const rootNode = tree.rootNode;

  // A lone ':' (not '::') never triggers meaningful completions in Pike.
  // It appears in case labels, goto labels, and ternary expressions —
  // none of which should show completions.
  if (oneBefore === ":" && (character < 2 || lineText[character - 2] !== ":")) {
    return { type: "none" };
  }

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
  if (lineText[character - 1] === "(") {
    const callee = findCalleeBeforeOpenParen(rootNode, line, character - 1, lineText);
    if (callee) {
      return { type: "call_args", calleeNode: callee, calleeName: callee.text };
    }
  }

  return { type: "unqualified" };
}

import { findLhsBeforePosition, findCalleeBeforeOpenParen } from "./completionTriggerResolve.js";

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