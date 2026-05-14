/**
 * Unreachable code lint rule — detects statements after return/break/continue.
 *
 * Decision 0028: Fast tree-sitter lint layer. This rule walks each block
 * scope in the AST and flags statements that follow a return, break, or
 * continue statement. It runs synchronously on every parse (<1ms).
 *
 * Scope: only within the same block. Does NOT track:
 * - Unreachable code across if/else branches (requires data flow)
 * - Code after throw (Pike uses error() function, not a keyword)
 * - Complex dead paths (if-false branches, always-throwing functions)
 */

import { Tree } from "web-tree-sitter";
import { Diagnostic, DiagnosticSeverity, Range } from "../diagnostics";

// ---------------------------------------------------------------------------
// Lint rule code (P3xxx range, per decision 0028)
// ---------------------------------------------------------------------------

export const CODE_UNREACHABLE = "P3003";

// ---------------------------------------------------------------------------
// Statement types that terminate control flow
// ---------------------------------------------------------------------------

const TERMINATOR_TYPES = new Set([
  "return_statement",
  "break_statement",
  "continue_statement",
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect unreachable code — statements after return/break/continue.
 *
 * Walks every block in the tree. When a terminator statement (return, break,
 * continue) is found, all subsequent sibling statements in the same block
 * are flagged as unreachable.
 *
 * Returns diagnostics with severity Warning.
 */
export function detectUnreachableCode(tree: Tree): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  walkBlocks(tree.rootNode, diagnostics);
  return diagnostics;
}

// ---------------------------------------------------------------------------
// Internal: tree walk
// ---------------------------------------------------------------------------

/**
 * Recursively walk the tree, finding block nodes and checking for
 * unreachable statements after terminators.
 */
function walkBlocks(node: import("web-tree-sitter").Node, diagnostics: Diagnostic[]): void {
  if (node.type === "block") {
    checkBlock(node, diagnostics);
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkBlocks(child, diagnostics);
  }
}

/**
 * Check a single block for unreachable code.
 *
 * Scans named children in order. After finding a terminator (return/break/
 * continue), all subsequent named children are flagged as unreachable.
 */
function checkBlock(
  block: import("web-tree-sitter").Node,
  diagnostics: Diagnostic[],
): void {
  const children = namedChildren(block);

  // Scan forward. Once we see a terminator, flag everything after it.
  let foundTerminator = false;
  let terminatorLine = -1;

  for (const child of children) {
    if (foundTerminator) {
      // This statement is unreachable.
      diagnostics.push(
        Diagnostic.create(
          Range.create(
            { line: child.startPosition.row, character: child.startPosition.column },
            { line: child.endPosition.row, character: child.endPosition.column },
          ),
          "Unreachable code",
          DiagnosticSeverity.Warning,
          CODE_UNREACHABLE,
          "pike-lsp-lint",
        ),
      );
      continue;
    }

    if (TERMINATOR_TYPES.has(child.type)) {
      foundTerminator = true;
      terminatorLine = child.startPosition.row;
    }
  }
}

/** Get named children of a node (skip anonymous tokens like `{`, `}`). */
function namedChildren(node: import("web-tree-sitter").Node): import("web-tree-sitter").Node[] {
  const result: import("web-tree-sitter").Node[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.isNamed) {
      result.push(child);
    }
  }
  return result;
}
