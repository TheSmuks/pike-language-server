/**
 * SignatureHelp — provides function/method/constructor signatures.
 *
 * Resolution chain:
 * 1. Local function/method declaration (same file)
 * 2. Class constructor (ClassName → create method)
 * 3. Method on resolved type (obj->method → resolve obj's type → find method)
 * 4. Stdlib function/class
 */

import type { Tree, Node } from "web-tree-sitter";
import type { SymbolTable } from "./symbolTable";
import { resolveSignature, resolvePredefSignatures, splitParams as _splitParams } from "./signatureHelp-resolve";

// Re-export for backward compatibility (tests import splitParams directly)
export { splitParams } from "./signatureHelp-resolve";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SignatureInfo {
  label: string;
  documentation?: string;
  parameters: ParameterInfo[];
}

export interface ParameterInfo {
  label: string;
  documentation?: string;
}

export interface SignatureHelpResult {
  signatures: SignatureInfo[];
  activeSignature: number;
  activeParameter: number;
}

/** Extended context for type-aware signature resolution. */
export interface SignatureContext {
  table: SymbolTable;
  uri: string;
  index: import("./workspaceIndex").WorkspaceIndex;
  stdlibIndex?: Record<string, { signature: string; markdown: string }>;
  /** Raw efun type descriptors (predef-builtin-index.json). */
  predefBuiltins?: Record<string, string>;
  /** Efun autodoc: rendered signature + markdown (predef-autodoc.json). */
  predefAutodoc?: Record<string, { signature?: string; markdown?: string }>;
  typeInferrer?: (varName: string) => Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Produce signature help for a position in the source.
 *
 * @param tree - tree-sitter parse tree
 * @param table - symbol table for the file
 * @param line - cursor line (0-based)
 * @param character - cursor character (0-based)
 * @param stdlibIndex - optional stdlib autodoc index
 * @param ctx - optional full resolution context for type-aware method resolution
 */
export function produceSignatureHelp(
  tree: Tree,
  table: SymbolTable,
  line: number,
  character: number,
  stdlibIndex?: Record<string, { signature: string; markdown: string }>,
  ctx?: SignatureContext,
  // Unused now that no UTF-8/UTF-16 conversion happens here; kept so existing
  // callers (and tests) that still pass the source string don't break.
  source = "",
): SignatureHelpResult | null {
  // LSP characters and tree-sitter columns are both UTF-16 code units.
  const node = tree.rootNode.descendantForPosition({ row: line, column: character });
  if (!node) return null;

  // Walk up to find enclosing call expression
  const callExpr = findEnclosingCall(node, line, character);
  if (!callExpr) return null;

  // Get callee name, object name, and argument list
  const calleeInfo = extractCalleeInfo(callExpr);
  if (!calleeInfo) return null;

  const { calleeName, objectName, argsNode } = calleeInfo;

  // Count active parameter (commas before cursor)
  const activeParam = countActiveParameter(argsNode, line, character);

  // Try to resolve to a local/workspace function
  const sig = resolveSignature(calleeName, objectName, table, stdlibIndex, ctx);
  if (sig) {
    return {
      signatures: [sig],
      activeSignature: 0,
      activeParameter: activeParam,
    };
  }

  // Efun fallback: write(), sprintf(), … live in the predef indexes, not the
  // stdlib autodoc index. Their raw types carry multiple overloads — offer
  // them all and pre-select the one that can hold the active argument.
  const predefSigs = resolvePredefSignatures(calleeName, ctx);
  if (predefSigs.length === 0) return null;

  return {
    signatures: predefSigs,
    activeSignature: pickActiveOverload(predefSigs, activeParam),
    activeParameter: activeParam,
  };
}

/**
 * Pick the first overload with enough parameters for the active argument.
 * Variadic overloads (last parameter contains `...`) always qualify.
 */
function pickActiveOverload(sigs: SignatureInfo[], activeParam: number): number {
  for (let i = 0; i < sigs.length; i++) {
    const params = sigs[i].parameters;
    if (activeParam < params.length) return i;
    if (params.length > 0 && params[params.length - 1].label.includes("...")) return i;
  }
  return sigs.length - 1;
}

// ---------------------------------------------------------------------------
// Call expression detection
// ---------------------------------------------------------------------------

/**
 * Find the open and close paren nodes among the children of a postfix_expr.
 * Returns [openParen, closeParen] (closeParen may be null).
 */
function findCallParens(children: Node[]): [Node, Node | null] {
  let openParen: Node | null = null;
  let closeParen: Node | null = null;
  for (let i = 1; i < children.length; i++) {
    if (children[i].type === "(" && !openParen) openParen = children[i];
    if (children[i].type === ")") closeParen = children[i];
  }
  return [openParen!, closeParen];
}

/**
 * Check if a cursor position falls within an open/close paren range.
 * Returns true if the cursor is after openParen and (if closeParen exists)
 * before closeParen.
 */
function isCursorInParenRange(
  openParen: Node,
  closeParen: Node | null,
  line: number,
  character: number,
): boolean {
  const openStart = openParen.startPosition;
  if (line < openStart.row || (line === openStart.row && character < openStart.column)) {
    return false;
  }
  if (closeParen) {
    const closeStart = closeParen.startPosition;
    if (line > closeStart.row || (line === closeStart.row && character >= closeStart.column)) {
      return false;
    }
  }
  return true;
}

/**
 * Walk up from the cursor node to find an enclosing call expression.
 *
 * In tree-sitter-pike, calls are represented as postfix_expr nodes
 * where child 0 is the callee and there are parenthesized arguments.
 */
function findEnclosingCall(node: Node, line?: number, character?: number): Node | null {
  let current: Node | null = node;
  while (current) {
    if (current.type === "postfix_expr") {
      const [openParen, closeParen] = findCallParens(current.children);
      if (!openParen) { current = current.parent; continue; }
      if (line === undefined || character === undefined || isCursorInParenRange(openParen, closeParen, line, character)) {
        return current;
      }
      current = current.parent;
      continue;
    }
    // For ERROR nodes (common while typing), check for identifier + '(' pattern.
    if (current.type === "ERROR" && line !== undefined && character !== undefined) {
      const errChildren = current.children;
      let errIdent: Node | null = null;
      let errOpen: Node | null = null;
      for (const child of errChildren) {
        if (child.type === "identifier" && !errIdent) errIdent = child;
        if (child.type === "(" && !errOpen) errOpen = child;
      }
      if (errIdent && errOpen) {
        const openStart = errOpen.startPosition;
        if (!(line < openStart.row || (line === openStart.row && character < openStart.column))) {
          return current;
        }
      }
    }
    current = current.parent;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Callee extraction
// ---------------------------------------------------------------------------

interface CalleeInfo {
  calleeName: string;
  /** For method calls (obj->method): the object identifier name. */
  objectName: string | null;
  argsNode: Node;
}

/**
 * Extract the callee name, optional object name, and argument list node.
 *
 * Examples:
 * - `add(1, 2)` → calleeName='add', objectName=null
 * - `d->speak("hello")` → calleeName='speak', objectName='d'
 * - `Module.func()` → calleeName='func', objectName='Module'
 * - `Dog("Rex")` → calleeName='Dog', objectName=null (constructor)
 */
function extractCalleeInfo(callExpr: Node): CalleeInfo | null {
  const children = callExpr.children;
  // Find the callee (first named child or first child before '(')
  let calleeNode: Node | null = null;
  let openParen: Node | null = null;

  for (let i = 0; i < children.length; i++) {
    if (children[i].type === "(") {
      openParen = children[i];
      // Callee is the first child before '('. Walk backwards from '('
      // to find the last named child (handles arrow/dot operators).
      for (let j = i - 1; j >= 0; j--) {
        if (children[j].isNamed) {
          calleeNode = children[j];
          break;
        }
      }
      // Fallback: first child.
      if (!calleeNode && children[0]) {
        calleeNode = children[0];
      }
      break;
    }
  }

  if (!calleeNode || !openParen) return null;

  // Extract the function/method name and object name.
  const parsed = parseCalleeNameAndObject(calleeNode.text);
  if (!parsed) return null;
  return { ...parsed, argsNode: openParen };
}

function parseCalleeNameAndObject(name: string): { calleeName: string; objectName: string | null } {
  let objName: string | null = null;
  let calleeName = name;

  const arrowIdx = calleeName.lastIndexOf("->");
  if (arrowIdx !== -1) {
    objName = calleeName.slice(0, arrowIdx);
    calleeName = calleeName.slice(arrowIdx + 2);
  }
  const dotIdx = calleeName.lastIndexOf(".");
  if (dotIdx !== -1) {
    objName = calleeName.slice(0, dotIdx);
    calleeName = calleeName.slice(dotIdx + 1);
  }

  if (objName) {
    const firstArrow = objName.indexOf("->");
    const firstDot = objName.indexOf(".");
    if (firstArrow !== -1 || firstDot !== -1) {
      const cutAt = firstArrow !== -1 && firstDot !== -1
        ? Math.min(firstArrow, firstDot)
        : firstArrow !== -1 ? firstArrow : firstDot;
      objName = objName.slice(0, cutAt);
    }
  }

  return { calleeName, objectName: objName };
}

// ---------------------------------------------------------------------------
// Active parameter tracking
// ---------------------------------------------------------------------------

/**
 * Count the number of commas before the cursor position inside the argument list.
 * This determines the active parameter index.
 */
function countActiveParameter(openParen: Node, line: number, character: number): number {
  const callExpr = openParen.parent;
  if (!callExpr) return 0;

  const children = callExpr.children;
  let insideArgs = false;
  let commaCount = 0;

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.type === "(") {
      insideArgs = true;
      continue;
    }
    if (child.type === ")") {
      break;
    }
    if (insideArgs) {
      // Arguments may be wrapped in an argument_list node
      if (child.type === "argument_list") {
        commaCount = countCommasInNode(child, line, character);
      } else if (child.type === ",") {
        const commaPos = child.startPosition;
        if (commaPos.row < line || (commaPos.row === line && commaPos.column < character)) {
          commaCount++;
        }
      }
    }
  }

  return commaCount;
}

/**
 * Count commas inside an argument_list node.
 */
function countCommasInNode(node: Node, line: number, character: number): number {
  let count = 0;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === ",") {
      const pos = child.startPosition;
      if (pos.row < line || (pos.row === line && pos.column < character)) {
        count++;
      }
    }
    if (child.childCount > 0) {
      count += countCommasInNode(child, line, character);
    }
  }
  return count;
}
