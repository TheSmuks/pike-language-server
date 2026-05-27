/**
 * Call hierarchy provider for Pike LSP.
 *
 * Implements three LSP requests:
 * - textDocument/prepareCallHierarchy: returns call hierarchy items at cursor
 * - callHierarchy/incomingCalls: returns callers of the selected item
 * - callHierarchy/outgoingCalls: returns callees from the selected item
 *
 * Architecture:
 * - prepareCallHierarchy: uses getDefinitionAt() to find the function/method
 *   at cursor, converts to CallHierarchyItem.
 * - incomingCalls: uses getCrossFileReferences() to find all references to the
 *   function, then groups by calling function.
 * - outgoingCalls: parses the function body, finds all call expressions, and
 *   resolves each callee to its definition.
 */

import type { Tree, Node } from "web-tree-sitter";
import type {
  CallHierarchyItem,
  CallHierarchyIncomingCall,
  CallHierarchyOutgoingCall,
} from "vscode-languageserver/node";
import type { SymbolTable, Declaration, Reference } from "./symbolTable";
import type { WorkspaceIndex } from "./workspaceIndex";
import { utf8ToUtf16 } from "../util/positionConverter";

// ---------------------------------------------------------------------------
// Prepare call hierarchy
// ---------------------------------------------------------------------------

/**
 * Prepare call hierarchy items at the given position.
 * Returns the function/method declaration at cursor, if any.
 */
export function prepareCallHierarchy(
  table: SymbolTable,
  uri: string,
  line: number,
  character: number,
): CallHierarchyItem[] {
  // Find the declaration at this position
  const decl = findEnclosingFunction(table, line, character);
  if (!decl) return [];

  return [declToCallHierarchyItem(decl, uri)];
}

/**
 * Find the function/method declaration that contains the given position.
 */
function findEnclosingFunction(
  table: SymbolTable,
  line: number,
  character: number,
): Declaration | null {
  // First check if cursor is directly on a function/method declaration name
  for (const decl of table.declarations) {
    if (decl.kind !== "function" && decl.kind !== "method") continue;
    if (decl.nameRange.start.line <= line &&
        decl.nameRange.end.line >= line &&
        decl.nameRange.start.character <= character &&
        decl.nameRange.end.character > character) {
      return decl;
    }
    // Also check if cursor is anywhere within the function body
    if (decl.range.start.line <= line &&
        decl.range.end.line >= line) {
      // Check if this is the innermost function containing the cursor
      // (prefer the most specific one)
    }
  }

  // If not directly on a function name, find the innermost function
  // containing the cursor position
  let best: Declaration | null = null;
  let bestSize = Infinity;

  for (const decl of table.declarations) {
    if (decl.kind !== "function" && decl.kind !== "method") continue;
    const startLine = decl.range.start.line;
    const endLine = decl.range.end.line;
    if (startLine <= line && endLine >= line) {
      const size = endLine - startLine;
      if (size < bestSize) {
        bestSize = size;
        best = decl;
      }
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// Incoming calls (who calls this function?)
// ---------------------------------------------------------------------------

/**
 * Get incoming calls for a call hierarchy item.
 * Returns all locations where this function is called.
 */
export function getIncomingCalls(
  item: CallHierarchyItem,
  workspaceIndex: WorkspaceIndex,
): CallHierarchyIncomingCall[] {
  const uri = item.uri;
  const line = item.selectionRange.start.line;
  const character = item.selectionRange.start.character;

  // Get all references to this function across the workspace
  const refs = workspaceIndex.getCrossFileReferences(uri, line, character);
  if (refs.length === 0) return [];

  // Group references by calling function (by URI + approximate range)
  const calls: CallHierarchyIncomingCall[] = [];

  for (const { uri: refUri, ref } of refs) {
    // Get the symbol table for the referencing file
    const entry = workspaceIndex.getFile(refUri);
    if (!entry?.symbolTable) continue;

    // Find the function that contains this reference
    const caller = findEnclosingFunction(
      entry.symbolTable,
      ref.loc.line,
      ref.loc.character,
    );
    if (!caller) continue;

    // Don't include self-references
    if (refUri === uri && caller.nameRange.start.line === line) continue;

    const callerItem = declToCallHierarchyItem(caller, refUri);

    // Check if we already have this caller
    const existing = calls.find(
      c => c.from.uri === callerItem.uri &&
           c.from.range.start.line === callerItem.range.start.line,
    );
    if (existing) {
      existing.fromRanges.push({
        start: { line: ref.loc.line, character: ref.loc.character },
        end: { line: ref.loc.line, character: ref.loc.character + (item.name?.length ?? 0) },
      });
    } else {
      calls.push({
        from: callerItem,
        fromRanges: [{
          start: { line: ref.loc.line, character: ref.loc.character },
          end: { line: ref.loc.line, character: ref.loc.character + (item.name?.length ?? 0) },
        }],
      });
    }
  }

  return calls;
}

// ---------------------------------------------------------------------------
// Outgoing calls (what does this function call?)
// ---------------------------------------------------------------------------

/**
 * Get outgoing calls from a call hierarchy item.
 * Parses the function body and finds all call expressions.
 */
export function getOutgoingCalls(
  item: CallHierarchyItem,
  tree: Tree,
  table: SymbolTable,
  uri: string,
  workspaceIndex: WorkspaceIndex,
): CallHierarchyOutgoingCall[] {
  const startLine = item.range.start.line;
  const endLine = item.range.end.line;

  // Find call expressions within the function range
  const root = tree.rootNode;
  const calls: CallHierarchyOutgoingCall[] = [];
  const seen = new Set<string>();
  const lines = root.text.split('\n');

  collectCallExpressions(
    root,
    startLine,
    endLine,
    table,
    uri,
    workspaceIndex,
    calls,
    seen,
    lines,
  );

  return calls;
}

/**
 * Recursively collect function calls within a line range.
 *
 * tree-sitter-pike represents calls as `postfix_expr` nodes that contain an
 * `argument_list` child. There is no `call_expression` node type. The callee
 * is extracted from the first child of the `postfix_expr` (which may itself be
 * a nested `postfix_expr` for method chains like `obj->method(args)`).
 */
function collectCallExpressions(
  node: Node,
  startLine: number,
  endLine: number,
  table: SymbolTable,
  uri: string,
  workspaceIndex: WorkspaceIndex,
  results: CallHierarchyOutgoingCall[],
  seen: Set<string>,
  lines: string[],
): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;

    // Skip nodes outside the target range.
    if (child.endPosition.row < startLine) continue;
    if (child.startPosition.row > endLine) break;

    // Detect function calls: postfix_expr with "(" child.
    if (child.type === "postfix_expr" && isCallPostfixExpr(child)) {
      const calleeName = extractCalleeName(child);
      if (calleeName) {
        const calleeDecl = resolveCallee(
          calleeName,
          table,
          uri,
          child.startPosition.row,
          workspaceIndex,
        );
        if (calleeDecl) {
          const key = `${calleeDecl.uri}:${calleeDecl.decl.nameRange.start.line}`;
          if (!seen.has(key)) {
            seen.add(key);
            // The callee name's start position within the postfix_expr.
            const calleeNode = findCalleeIdentifierNode(child);
            const fromLine = calleeNode?.startPosition.row ?? child.startPosition.row;
            const fromCol = calleeNode?.startPosition.column ?? child.startPosition.column;
            const nameLength = calleeNode?.text.length ?? calleeName.length;
            results.push({
              to: calleeDecl.item,
              fromRanges: [{
                start: {
                  line: fromLine,
                  character: utf8ToUtf16(lines[fromLine] ?? '', fromCol),
                },
                end: {
                  line: fromLine,
                  character: utf8ToUtf16(lines[fromLine] ?? '', fromCol) + nameLength,
                },
              }],
            });
          }
        }
      }
    }

    // Recurse into children.
    collectCallExpressions(
      child, startLine, endLine, table, uri, workspaceIndex, results, seen, lines,
    );
  }
}

/**
 * Check whether a postfix_expr node represents a function/method call.
 *
 * tree-sitter-pike represents calls as postfix_expr with `(` as a direct
 * child. When arguments are present, an argument_list sits between `(` and `)`.
 * When there are no arguments, `(` and `)` are the only bracketing children.
 */
function isCallPostfixExpr(node: Node): boolean {
  for (let i = 0; i < node.childCount; i++) {
    if (node.child(i)?.type === "(") return true;
  }
  return false;
}

/**
 * Extract the callee name from a postfix_expr call node.
 *
 * tree-sitter-pike structures:
 *   Simple call: postfix_expr(postfix_expr(primary_expr(identifier_expr(id)), "(", ...))
 *   Method call: postfix_expr(postfix_expr(inner, "->", id), "(", ...))
 *
 * The first child of the outer postfix_expr is the callee expression.
 * For method calls, the callee identifier follows "->" in the child.
 */
function extractCalleeName(node: Node): string | null {
  const callee = node.children[0];
  if (!callee) return null;

  // For method chains (obj->method), look for "->" operator and take
  // the identifier after it. The callee child is a postfix_expr containing
  // the chain.
  if (callee.type === "postfix_expr") {
    return extractCalleeFromChain(callee);
  }

  // Bare identifier (shouldn't normally happen, but handle defensively).
  if (callee.type === "identifier") return callee.text;

  return null;
}

/**
 * Given the first child of a call postfix_expr (which is always a
 * postfix_expr itself), extract the callee name.
 *
 * For simple calls like helper():
 *   postfix_expr -> primary_expr -> identifier_expr -> identifier
 *
 * For method calls like obj->method():
 *   postfix_expr(postfix_expr(...), "->", identifier)
 *   The callee is the identifier after "->".
 *
 * For chained calls like getDog()->bark():
 *   postfix_expr(postfix_expr(postfix_expr(...), "(", ")"), "->", identifier)
 *   Same: identifier after "->".
 */
function extractCalleeFromChain(node: Node): string | null {
  // If this node has "->" or ".", the callee is the identifier after it.
  for (let i = 0; i < node.childCount - 1; i++) {
    const child = node.child(i);
    if (child?.type === "->" || child?.type === ".") {
      const next = node.child(i + 1);
      if (next?.type === "identifier") return next.text;
    }
  }

  // No "->" or "." — this is a simple call. Drill to the innermost identifier.
  // Structure: postfix_expr -> primary_expr -> identifier_expr -> identifier
  const inner = node.child(0);
  if (!inner) return null;

  if (inner.type === "primary_expr") {
    const idExpr = inner.namedChild(0);
    if (idExpr?.type === "identifier_expr") {
      return idExpr.childForFieldName("name")?.text ?? idExpr.namedChild(0)?.text ?? null;
    }
    if (idExpr?.type === "identifier") return idExpr.text;
  }

  // Nested postfix_expr without "->" — drill further.
  if (inner.type === "postfix_expr") {
    return extractCalleeFromChain(inner);
  }

  return null;
}

/**
 * Find the AST node for the callee identifier in a postfix_expr,
 * so we can report accurate source ranges for the fromRanges field.
 */
function findCalleeIdentifierNode(node: Node): Node | null {
  const callee = node.children[0];
  if (!callee) return null;

  if (callee.type === "postfix_expr") {
    return findCalleeIdNodeInChain(callee);
  }
  if (callee.type === "identifier") return callee;
  return null;
}

/**
 * Walk a callee postfix_expr chain to find the identifier node.
 * For method calls, returns the identifier after "->".
 * For simple calls, drills to the innermost identifier.
 */
function findCalleeIdNodeInChain(node: Node): Node | null {
  // Method call: identifier after "->" or "."
  for (let i = 0; i < node.childCount - 1; i++) {
    const child = node.child(i);
    if (child?.type === "->" || child?.type === ".") {
      const next = node.child(i + 1);
      if (next?.type === "identifier") return next;
    }
  }

  // Simple call: drill to primary_expr -> identifier_expr -> identifier
  const inner = node.child(0);
  if (!inner) return null;

  if (inner.type === "primary_expr") {
    const idExpr = inner.namedChild(0);
    if (idExpr?.type === "identifier_expr") {
      return idExpr.childForFieldName("name") ?? idExpr.namedChild(0) ?? null;
    }
    if (idExpr?.type === "identifier") return idExpr;
  }

  if (inner.type === "postfix_expr") {
    return findCalleeIdNodeInChain(inner);
  }

  return null;
}

/**
 * Try to resolve a callee name to its declaration and CallHierarchyItem.
 */
function resolveCallee(
  name: string,
  table: SymbolTable,
  uri: string,
  fromLine: number,
  workspaceIndex: WorkspaceIndex,
): { item: CallHierarchyItem; decl: Declaration; uri: string } | null {
  // Search in local scope first
  for (const decl of table.declarations) {
    if (decl.name === name && (decl.kind === "function" || decl.kind === "method")) {
      return {
        item: declToCallHierarchyItem(decl, uri),
        decl,
        uri,
      };
    }
  }

  // Search cross-file via workspace index
  for (const entry of workspaceIndex.getAllEntries()) {
    if (!entry.symbolTable) continue;
    for (const decl of entry.symbolTable.declarations) {
      if (decl.name === name && (decl.kind === "function" || decl.kind === "method")) {
        return {
          item: declToCallHierarchyItem(decl, entry.uri),
          decl,
          uri: entry.uri,
        };
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function declToCallHierarchyItem(decl: Declaration, uri: string): CallHierarchyItem {
  return {
    name: decl.name,
    kind: decl.kind === "method" ? 6 : 12, // Method = 6, Function = 12
    uri,
    range: {
      start: { line: decl.range.start.line, character: decl.range.start.character },
      end: { line: decl.range.end.line, character: decl.range.end.character },
    },
    selectionRange: {
      start: { line: decl.nameRange.start.line, character: decl.nameRange.start.character },
      end: { line: decl.nameRange.end.line, character: decl.nameRange.end.character },
    },
  };
}
