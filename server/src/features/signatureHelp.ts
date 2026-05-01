/**
 * Signature help production (US-017).
 *
 * Provides parameter hints for function/method calls by:
 * 1. Finding the enclosing call expression at the cursor
 * 2. Identifying the callee and resolving to a declaration
 * 3. Extracting parameter info from the declaration or stdlib
 * 4. Tracking active parameter via comma count
 */

import type { Tree, Node } from "web-tree-sitter";
import type { SymbolTable, Declaration } from "./symbolTable";

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
 */
export function produceSignatureHelp(
  tree: Tree,
  table: SymbolTable,
  line: number,
  character: number,
  stdlibIndex?: Record<string, { signature: string; markdown: string }>,
): SignatureHelpResult | null {
  // Find the node at the cursor
  const node = tree.rootNode.descendantForPosition({ row: line, column: character });
  if (!node) return null;

  // Walk up to find enclosing call expression
  const callExpr = findEnclosingCall(node, line, character);
  if (!callExpr) return null;

  // Get callee name and argument list
  const calleeInfo = extractCalleeInfo(callExpr);
  if (!calleeInfo) return null;

  const { calleeName, argsNode } = calleeInfo;

  // Count active parameter (commas before cursor)
  const activeParam = countActiveParameter(argsNode, line, character);

  // Try to resolve to a local/workspace function
  const sig = resolveSignature(calleeName, table, stdlibIndex);
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
function findEnclosingCall(node: Node, line?: number, character?: number): Node | null {
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
      if (!openParen || !closeParen) {
        current = current.parent;
        continue;
      }
      if (line !== undefined && character !== undefined) {
        const openStart = openParen.startPosition;
        const closeStart = closeParen.startPosition;
        const cursorBeforeOpen =
          line < openStart.row || (line === openStart.row && character < openStart.column);
        const cursorAtOrAfterClose =
          line > closeStart.row || (line === closeStart.row && character >= closeStart.column);
        if (cursorBeforeOpen || cursorAtOrAfterClose) {
          current = current.parent;
          continue;
        }
      }
      return current;
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
  argsNode: Node;
}

/**
 * Extract the callee name and argument list node from a call expression.
 */
function extractCalleeInfo(callExpr: Node): CalleeInfo | null {
  const children = callExpr.children;
  // Find the callee (first named child or first child before '(')
  let calleeNode: Node | null = null;
  let openParen: Node | null = null;

  for (let i = 0; i < children.length; i++) {
    if (children[i].type === "(") {
      openParen = children[i];
      // Callee is the first child before '('
      calleeNode = children[0];
      break;
    }
  }

  if (!calleeNode || !openParen) return null;

  // Extract just the function/method name from the callee text.
  // For 'add' → 'add', for 'd->speak' → 'speak', for 'Module.func' → 'func'
  let name = calleeNode.text;
  const arrowIdx = name.lastIndexOf("->");
  if (arrowIdx !== -1) {
    name = name.slice(arrowIdx + 2);
  }
  const dotIdx = name.lastIndexOf(".");
  if (dotIdx !== -1) {
    name = name.slice(dotIdx + 1);
  }

  // Build argsNode: everything from '(' to ')'
  // Find the matching ')'
  const argsStart = openParen.startPosition;
  let argsEnd = argsStart;
  for (let i = children.length - 1; i >= 0; i--) {
    if (children[i].type === ")") {
      argsEnd = children[i].endPosition;
      break;
    }
  }

  return {
    calleeName: name,
    argsNode: openParen, // We'll use the parent callExpr for position counting
  };
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

// ---------------------------------------------------------------------------
// Signature resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a callee name to a signature.
 *
 * Tries local workspace functions first, then stdlib.
 */
function resolveSignature(
  calleeName: string,
  table: SymbolTable,
  stdlibIndex?: Record<string, { signature: string; markdown: string }>,
): SignatureInfo | null {
  // Try local function/method declaration
  const funcDecl = table.declarations.find(
    d => d.name === calleeName && (d.kind === "function"),
  );

  if (funcDecl) {
    return buildSignatureFromDecl(funcDecl, table);
  }

  // Try stdlib
  if (stdlibIndex) {
    const entry = stdlibIndex[`predef.${calleeName}`];
    if (entry) {
      return buildSignatureFromStdlib(calleeName, entry);
    }
  }

  return null;
}

/**
 * Build a SignatureInfo from a local function declaration.
 */
function buildSignatureFromDecl(decl: Declaration, table: SymbolTable): SignatureInfo | null {
  // Find parameters in the function's scope
  // The function creates a scope — parameters are in the first child scope
  const funcScope = table.scopes.find(s =>
    s.declarations.includes(decl.id),
  );

  if (!funcScope) {
    // Fallback: use the declaration range text
    return {
      label: `${decl.declaredType ?? "mixed"} ${decl.name}(...)`,
      parameters: [],
    };
  }

  // Find the function body scope — child of funcScope that overlaps with the declaration range
  const paramScopeIds: number[] = [];
  for (const scope of table.scopes) {
    if (scope.parentId === funcScope.id && scope.kind === "function") {
      // Check if this scope's range overlaps with the declaration's range
      if (scope.range.start.line >= decl.range.start.line &&
          scope.range.start.character >= decl.range.start.character &&
          scope.range.end.line <= decl.range.end.line) {
        paramScopeIds.push(scope.id);
        break;
      }
    }
  }

  // Collect parameters
  const params: ParameterInfo[] = [];
  for (const scopeId of paramScopeIds) {
    const scope = table.scopes.find(s => s.id === scopeId);
    if (!scope) continue;
    for (const declId of scope.declarations) {
      const param = table.declById.get(declId);
      if (param && param.kind === "parameter") {
        const label = param.declaredType
          ? `${param.declaredType} ${param.name}`
          : param.name;
        params.push({ label });
      }
    }
  }

  const retType = decl.declaredType ?? "mixed";
  const paramStr = params.map(p => p.label).join(", ");
  const label = `${retType} ${decl.name}(${paramStr})`;

  return { label, parameters: params };
}

/**
 * Build a SignatureInfo from a stdlib autodoc entry.
 */
function buildSignatureFromStdlib(
  name: string,
  entry: { signature: string; markdown: string },
): SignatureInfo {
  // Parse parameters from the signature
  const sig = entry.signature;
  const openParen = sig.indexOf("(");
  const closeParen = sig.lastIndexOf(")");

  const params: ParameterInfo[] = [];
  if (openParen !== -1 && closeParen !== -1) {
    const paramText = sig.slice(openParen + 1, closeParen).trim();
    if (paramText) {
      // Split by comma — simple approach, doesn't handle nested parens perfectly
      const parts = splitParams(paramText);
      for (const part of parts) {
        params.push({ label: part.trim() });
      }
    }
  }

  return {
    label: sig,
    documentation: entry.markdown,
    parameters: params,
  };
}

/**
 * Split parameter text by commas, respecting nested parentheses.
 */
export function splitParams(text: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let start = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      result.push(text.slice(start, i));
      start = i + 1;
    }
  }

  if (start < text.length) {
    result.push(text.slice(start));
  }

  return result;
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
    // Recurse into child nodes (e.g., comma_expr wraps comma-separated args)
    if (child.childCount > 0) {
      count += countCommasInNode(child, line, character);
    }
  }
  return count;
}

/**
 * Produce signature help for a position in the source.
 *
 * Exported for direct unit testing.
 */
export function findEnclosingCallExport(tree: Tree, line: number, character: number): Node | null {
  const node = tree.rootNode.descendantForPosition({ row: line, column: character });
  if (!node) return null;
  return findEnclosingCall(node, line, character);
}