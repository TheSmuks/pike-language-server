/**
 * Completion trigger detection and support utilities for Pike LSP.
 *
 * Extracted from completion.ts: trigger context detection, type member
 * resolution, and shared helper functions used across completion providers.
 */

import { Tree, Node } from "web-tree-sitter";
import type { WorkspaceIndex } from "./workspaceIndex";
import type { ResolveResult } from "./pikeWorker";
import { type StdlibEntry, resetStdlibCache, resetAutoImportCache } from "./completion-stdlib";
import type { RoxenIndexData } from "./roxenIndex";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CompletionContext {
  index: WorkspaceIndex;
  stdlibIndex: Record<string, StdlibEntry>;
  predefBuiltins: Record<string, string>;
  predefAutodoc: Record<string, { signature: string; markdown: string; params?: Array<{ name: string; type: string }>; returnType?: string }>;
  uri: string;
  /** Full document text — used for line extraction in detectTriggerContext. */
  source: string;
  /** Bundled Roxen vocabulary. Offered only when `roxenActive` says so. */
  roxenIndex?: RoxenIndexData;
  /**
   * Whether this file is a Roxen file. False (or absent) in a plain Pike
   * program, which is what keeps Roxen names out of its completion list.
   */
  roxenActive?: boolean;
  /** Optional runtime type inferrer (PikeWorker.typeof_()). */
  typeInferrer?: (varName: string) => Promise<string | null>;
  /**
   * Optional runtime member resolver (PikeWorker.resolve()). Enumerates the
   * methods/constants of a type the static stdlib index doesn't cover. Used as
   * a fallback in member-access completion; results are cached per type name by
   * the worker, so repeated completions on the same type hit memory.
   */
  memberResolver?: (typeName: string) => Promise<ResolveResult | null>;
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
    if (scopeNode && cursorIsPastScopeOperator(scopeNode, line, character)) {
      return { type: "scope", scopeNode };
    }
  }

  // Check parent chain for scope_expr
  const scopeFromParent = findScopeInParentChain(current, line, character);
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

/**
 * True when the cursor sits at or past the `::` of a scope qualifier.
 *
 * The enclosing `scope_expr` is reachable from anywhere inside it, qualifier
 * included. On `A::value()` with the cursor on the `A`, the user is naming the
 * scope rather than indexing into it, so A's members are the wrong answer —
 * the symbols visible at that point are. A qualifier still being typed has no
 * `::` yet, and stays a scope trigger.
 */
function cursorIsPastScopeOperator(scopeNode: Node, line: number, character: number): boolean {
  const operator = findScopeOperator(scopeNode);
  if (!operator) return true;
  const end = operator.endPosition;
  return line > end.row || (line === end.row && character >= end.column);
}

/** The `::` token of a scope qualifier, searched one level into the node. */
function findScopeOperator(scopeNode: Node): Node | null {
  if (scopeNode.type === "::") return scopeNode;
  for (const child of scopeNode.children) {
    if (child.type === "::") return child;
  }
  return null;
}

/** Walk parent chain looking for a scope_expr node. */
function findScopeInParentChain(node: Node, line: number, character: number): TriggerContext | null {
  let parent: Node | null = node.parent;
  while (parent) {
    if (parent.type === "scope_expr") {
      const scopeNode = parent.childForFieldName("scope");
      if (scopeNode && cursorIsPastScopeOperator(scopeNode, line, character)) {
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

function resolveTriggerFromLineText(
  character: number,
  lineText: string,
  tree: Tree,
  line: number,
): TriggerContext {
  // Column 0. There is no preceding character to read a trigger out of, which
  // is not the same as there being nothing to complete: a statement, a
  // declaration or a type name can all begin here.
  if (character < 1) return { type: "unqualified" };

  const oneBefore = lineText[character - 1];
  const rootNode = tree.rootNode;

  if (oneBefore === ":" && (character < 2 || lineText[character - 2] !== ":")) {
    return { type: "none" };
  }

  const dotCtx = tryDotOrArrowFromChar(oneBefore, character, lineText, rootNode, line);
  if (dotCtx) return dotCtx;

  if (character >= 2) {
    const twoBefore = lineText.substring(character - 2, character);
    const twoCharCtx = tryTwoCharTrigger(twoBefore, rootNode, line, character - 2);
    if (twoCharCtx) return twoCharCtx;
  }

  if (lineText[character - 1] === "(") {
    const callee = findCalleeBeforeOpenParen(rootNode, line, character - 1);
    if (callee) {
      return { type: "call_args", calleeNode: callee, calleeName: callee.text };
    }
  }

  return { type: "unqualified" };
}

function tryDotOrArrowFromChar(
  oneBefore: string,
  character: number,
  lineText: string,
  rootNode: Node,
  line: number,
): TriggerContext | null {
  if (oneBefore === ".") {
    const lhs = findLhsBeforePosition(rootNode, line, character - 1);
    if (lhs) return { type: "dot", lhsNode: lhs };
  }

  if (oneBefore === ">" && character >= 2 && lineText[character - 2] === "-") {
    const lhs = findLhsBeforePosition(rootNode, line, character - 2);
    if (lhs) return { type: "arrow", lhsNode: lhs };
  }

  return null;
}

function tryTwoCharTrigger(
  twoBefore: string,
  rootNode: Node,
  line: number,
  pos: number,
): TriggerContext | null {
  if (twoBefore === "->") {
    const lhs = findLhsBeforePosition(rootNode, line, pos);
    if (lhs) return { type: "arrow", lhsNode: lhs };
  }

  if (twoBefore === "::") {
    const lhs = findLhsBeforePosition(rootNode, line, pos);
    if (lhs) return { type: "scope", scopeNode: lhs };
  }

  return null;
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
