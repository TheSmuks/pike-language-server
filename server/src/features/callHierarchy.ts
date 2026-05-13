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
  // First check if cursor is directly on a function/method declaration
  for (const decl of table.declarations) {
    if (decl.kind !== "function" && decl.kind !== "method") continue;
    if (decl.nameRange.start.line <= line &&
        decl.nameRange.end.line >= line &&
        decl.range.start.character <= character &&
        decl.range.end.character >= character) {
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
 * Recursively collect call expressions within a line range.
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

    // Skip nodes outside the target range
    if (child.endPosition.row < startLine) continue;
    if (child.startPosition.row > endLine) break;

    if (child.type === "call_expression") {
      // The callee is the first named child (the function being called)
      const callee = child.firstChild;
      if (callee) {
        const calleeName = callee.text;
        if (calleeName && !seen.has(calleeName)) {
          // Try to resolve the callee to its declaration
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
              results.push({
                to: calleeDecl.item,
                fromRanges: [{
                  start: {
                    line: child.startPosition.row,
                    character: child.startPosition.column,
                  },
                  end: {
                    line: child.startPosition.row,
                    character: child.startPosition.column + calleeName.length,
                  },
                }],
              });
            }
          }
        }
      }
    }

    // Recurse into children
    collectCallExpressions(
      child, startLine, endLine, table, uri, workspaceIndex, results, seen,
    );
  }
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
