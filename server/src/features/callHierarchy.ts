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
import { isWrittenInFile } from "./symbolTable";
import type { WorkspaceIndex } from "./workspaceIndex";

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
  // First check if cursor is directly on a function/method declaration name.
  // Declarations cloned from an inherited or #include'd file carry that file's
  // coordinates, so they can never answer a position query about this one.
  for (const decl of table.declarations) {
    if (decl.kind !== "function" && decl.kind !== "method") continue;
    if (!isWrittenInFile(table, decl)) continue;
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
    if (!isWrittenInFile(table, decl)) continue;
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
    const caller = findCallerForRef(refUri, ref, uri, line, workspaceIndex);
    if (!caller) continue;

    const callerItem = declToCallHierarchyItem(caller, refUri);
    addIncomingCallToGroup(calls, callerItem, ref, item);
  }

  return calls;
}

function findCallerForRef(
  refUri: string,
  ref: Reference,
  selfUri: string,
  selfLine: number,
  workspaceIndex: WorkspaceIndex,
): Declaration | null {
  const entry = workspaceIndex.getFile(refUri);
  if (!entry?.symbolTable) return null;

  const caller = findEnclosingFunction(entry.symbolTable, ref.loc.line, ref.loc.character);
  if (!caller) return null;
  if (refUri === selfUri && caller.nameRange.start.line === selfLine) return null; // skip self
  return caller;
}

function addIncomingCallToGroup(
  calls: CallHierarchyIncomingCall[],
  callerItem: CallHierarchyItem,
  ref: Reference,
  item: CallHierarchyItem,
): void {
  const existing = calls.find(
    c => c.from.uri === callerItem.uri &&
         c.from.range.start.line === callerItem.range.start.line,
  );
  const nameLen = item.name?.length ?? 0;
  const range = { start: { line: ref.loc.line, character: ref.loc.character },
                  end: { line: ref.loc.line, character: ref.loc.character + nameLen } };

  if (existing) {
    existing.fromRanges.push(range);
  } else {
    calls.push({ from: callerItem, fromRanges: [range] });
  }
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

  collectCallExpressions(
    root,
    startLine,
    endLine,
    table,
    uri,
    workspaceIndex,
    calls,
    seen,
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
): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.endPosition.row < startLine) continue;
    if (child.startPosition.row > endLine) break;

    // Overlap is not containment. A call that STARTS before the function and
    // ENDS after it is a call the function is nested inside — an anonymous
    // class or lambda passed as an argument — not a call the function makes.
    // Reporting it put the enclosing expression in the callee list.
    const containedInFunction =
      child.startPosition.row >= startLine && child.endPosition.row <= endLine;

    if (containedInFunction &&
        child.type === "postfix_expr" && isCallPostfixExpr(child)) {
      tryPushOutgoingCall(child, table, uri, workspaceIndex, results, seen);
    }

    collectCallExpressions(
      child, startLine, endLine, table, uri, workspaceIndex, results, seen,
    );
  }
}

function tryPushOutgoingCall(
  node: Node,
  table: SymbolTable,
  uri: string,
  workspaceIndex: WorkspaceIndex,
  results: CallHierarchyOutgoingCall[],
  seen: Set<string>,
): void {
  const calleeName = extractCalleeName(node);
  if (!calleeName) return;

  const calleeDecl = resolveCallee(calleeName, table, uri, node.startPosition.row, workspaceIndex);
  if (!calleeDecl) return;

  const key = `${calleeDecl.uri}:${calleeDecl.decl.nameRange.start.line}`;
  if (seen.has(key)) return;
  seen.add(key);

  const calleeNode = findCalleeIdentifierNode(node);
  const fromLine = calleeNode?.startPosition.row ?? node.startPosition.row;
  const fromCol = calleeNode?.startPosition.column ?? node.startPosition.column;
  const nameLength = calleeNode?.text.length ?? calleeName.length;

  results.push({
    to: calleeDecl.item,
    fromRanges: [{
      start: { line: fromLine, character: fromCol },
      end: { line: fromLine, character: fromCol + nameLength },
    }],
  });
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
  // Search in local scope first. A clone from an inherited or #include'd file
  // matches by name but its ranges belong to that file — pairing them with
  // `uri` would point the call hierarchy at an arbitrary line here. The
  // cross-file sweep below finds the real declaration in its own file.
  for (const decl of table.declarations) {
    if (!isWrittenInFile(table, decl)) continue;
    if (decl.name === name && (decl.kind === "function" || decl.kind === "method")) {
      return {
        item: declToCallHierarchyItem(decl, uri),
        decl,
        uri,
      };
    }
  }

  // Search cross-file via workspace index.
  //
  // A table also holds clones merged from the files it inherits and includes,
  // and a clone's ranges are coordinates in the file it came FROM. Pairing one
  // with entry.uri pointed the item at whatever text happens to sit at those
  // coordinates in the wrong file. `decl.sourceUri` names the real home; the
  // local loop above already guards this way.
  for (const entry of workspaceIndex.getAllEntries()) {
    if (!entry.symbolTable) continue;
    for (const decl of entry.symbolTable.declarations) {
      if (decl.name === name && (decl.kind === "function" || decl.kind === "method")) {
        const declUri = decl.sourceUri ?? entry.uri;
        return {
          item: declToCallHierarchyItem(decl, declUri),
          decl,
          uri: declUri,
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
