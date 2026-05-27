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
import { resolveSignature, splitParams as _splitParams } from "./signatureHelp-resolve";
import { utf16ToUtf8, utf8ToUtf16, getLineText } from "../util/positionConverter";

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
  source?: string,
): SignatureHelpResult | null {
  // Convert LSP character (UTF-16) to tree-sitter column (UTF-8 byte offset)
  const src = source ?? tree.rootNode.text;
  const lines = src.split('\n');
  const utf8Col = utf16ToUtf8(lines[line] ?? '', character);

  // Find the node at the cursor
  const node = tree.rootNode.descendantForPosition({ row: line, column: utf8Col });
  if (!node) return null;

  // Walk up to find enclosing call expression
  const callExpr = findEnclosingCall(node, line, character, lines);
  if (!callExpr) return null;

  // Get callee name, object name, and argument list
  const calleeInfo = extractCalleeInfo(callExpr);
  if (!calleeInfo) return null;

  const { calleeName, objectName, argsNode } = calleeInfo;

  // Count active parameter (commas before cursor)
  const activeParam = countActiveParameter(argsNode, line, character, lines);

  // Try to resolve to a local/workspace function
  const sig = resolveSignature(calleeName, objectName, table, stdlibIndex, ctx);
  if (!sig) return null;

  return {
    signatures: [sig],
    activeSignature: 0,
    activeParameter: activeParam,
  };
}

// ---------------------------------------------------------------------------
// Call expression detection
// ---------------------------------------------------------------------------

/**
 * Walk up from the cursor node to find an enclosing call expression.
 *
 * In tree-sitter-pike, calls are represented as postfix_expr nodes
 * where child 0 is the callee and there are parenthesized arguments.
 */
function findEnclosingCall(node: Node, line?: number, character?: number, lines?: string[]): Node | null {
  let current: Node | null = node;
  while (current) {
    if (current.type === "postfix_expr") {
      const children = current.children;
      let openParen: Node | null = null;
      let closeParen: Node | null = null;
      for (let i = 1; i < children.length; i++) {
        if (children[i].type === "(" && !openParen) {
          openParen = children[i];
        }
        if (children[i].type === ")") {
          closeParen = children[i];
        }
      }
      if (!openParen) {
        current = current.parent;
        continue;
      }

      if (line !== undefined && character !== undefined) {
        const openStart = openParen.startPosition;
        const openStartUtf16 = lines ? utf8ToUtf16(lines[openStart.row] ?? '', openStart.column) : openStart.column;
        // Cursor must be at or after the open paren.
        const cursorBeforeOpen =
          line < openStart.row || (line === openStart.row && character < openStartUtf16);
        if (cursorBeforeOpen) {
          current = current.parent;
          continue;
        }
        // If there is a close paren, cursor must be before it.
        if (closeParen) {
          const closeStart = closeParen.startPosition;
          const closeStartUtf16 = lines ? utf8ToUtf16(lines[closeStart.row] ?? '', closeStart.column) : closeStart.column;
          const cursorAtOrAfterClose =
            line > closeStart.row || (line === closeStart.row && character >= closeStartUtf16);
          if (cursorAtOrAfterClose) {
            current = current.parent;
            continue;
          }
        }
        // No close paren: the user is actively typing arguments.
        // Accept this as the enclosing call as long as the cursor is
        // after the open paren (checked above).
      }
      return current;
    }
    // For ERROR nodes (common while typing), check if there's an
    // incomplete call pattern: identifier followed by '('.
    if (current.type === "ERROR" && line !== undefined && character !== undefined) {
      const errChildren = current.children;
      let errIdent: Node | null = null;
      let errOpen: Node | null = null;
      for (const child of errChildren) {
        if (child.type === "identifier" && !errIdent) {
          errIdent = child;
        }
        if (child.type === "(" && !errOpen) {
          errOpen = child;
        }
      }
      if (errIdent && errOpen) {
        const openStart = errOpen.startPosition;
        const openStartUtf16 = lines ? utf8ToUtf16(lines[openStart.row] ?? '', openStart.column) : openStart.column;
        const cursorBeforeOpen =
          line < openStart.row || (line === openStart.row && character < openStartUtf16);
        if (!cursorBeforeOpen) {
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
  let name = calleeNode.text;
  let objectName: string | null = null;

  const arrowIdx = name.lastIndexOf("->");
  if (arrowIdx !== -1) {
    // obj->method: object is everything before ->, method is after
    objectName = name.slice(0, arrowIdx);
    name = name.slice(arrowIdx + 2);
  }
  const dotIdx = name.lastIndexOf(".");
  if (dotIdx !== -1) {
    // Module.func: object is everything before ., method is after
    objectName = name.slice(0, dotIdx);
    name = name.slice(dotIdx + 1);
  }

  // For object names like "this" or nested expressions, extract just the
  // trailing identifier to use for type resolution.
  if (objectName) {
    // Handle chained calls: extract the first identifier for type lookup.
    // E.g., "getContainer()->getItem" → objectName = "getContainer()"
    // For now, take the first identifier segment.
    const firstArrow = objectName.indexOf("->");
    const firstDot = objectName.indexOf(".");
    if (firstArrow !== -1 || firstDot !== -1) {
      // Chained call — extract the first identifier
      const cutAt = firstArrow !== -1 && firstDot !== -1
        ? Math.min(firstArrow, firstDot)
        : firstArrow !== -1 ? firstArrow : firstDot;
      objectName = objectName.slice(0, cutAt);
    }
  }

  return {
    calleeName: name,
    objectName,
    argsNode: openParen,
  };
}

// ---------------------------------------------------------------------------
// Active parameter tracking
// ---------------------------------------------------------------------------

/**
 * Count the number of commas before the cursor position inside the argument list.
 * This determines the active parameter index.
 */
function countActiveParameter(openParen: Node, line: number, character: number, lines?: string[]): number {
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
        commaCount = countCommasInNode(child, line, character, lines);
      } else if (child.type === ",") {
        const commaPos = child.startPosition;
        const commaColUtf16 = lines ? utf8ToUtf16(lines[commaPos.row] ?? '', commaPos.column) : commaPos.column;
        if (commaPos.row < line || (commaPos.row === line && commaColUtf16 < character)) {
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
function countCommasInNode(node: Node, line: number, character: number, lines?: string[]): number {
  let count = 0;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === ",") {
      const pos = child.startPosition;
      const colUtf16 = lines ? utf8ToUtf16(lines[pos.row] ?? '', pos.column) : pos.column;
      if (pos.row < line || (pos.row === line && colUtf16 < character)) {
        count++;
      }
    }
    if (child.childCount > 0) {
      count += countCommasInNode(child, line, character, lines);
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Test export
// ---------------------------------------------------------------------------

/**
/**
 * Find the enclosing function call for a position.
 * Exported for direct unit testing.
 */
function findEnclosingCallExport(tree: Tree, line: number, character: number, source?: string): Node | null {
  const src = source ?? tree.rootNode.text;
  const lines = src.split('\n');
  const utf8Col = utf16ToUtf8(lines[line] ?? '', character);
  const node = tree.rootNode.descendantForPosition({ row: line, column: utf8Col });
  if (!node) return null;
  return findEnclosingCall(node, line, character, lines);
}
