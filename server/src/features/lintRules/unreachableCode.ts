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
import { Diagnostic, DiagnosticSeverity, DiagnosticTag, Range } from "../diagnostics";

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

// Node types that are not executable code and should never be flagged.
const COMMENT_TYPES = new Set([
  "line_comment",
  "block_comment",
  "autodoc_comment",
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
export function detectUnreachableCode(tree: Tree, uri: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  walkBlocks(tree.rootNode, diagnostics, uri);
  return diagnostics;
}

// ---------------------------------------------------------------------------
// Internal: tree walk
// ---------------------------------------------------------------------------

/**
 * Recursively walk the tree, finding block nodes and checking for
 * unreachable statements after terminators.
 */
function walkBlocks(node: import("web-tree-sitter").Node, diagnostics: Diagnostic[], uri: string): void {
  if (node.type === "block") {
    // Switch bodies contain case/default clauses as direct children in a
    // flat block. Each case is an independent control-flow entry point, so
    // a terminator in one case does not make subsequent cases unreachable.
    // Use segmented checking for switch blocks.
    const parent = node.parent;
    if (parent && parent.type === "switch_statement") {
      checkSwitchBlock(node, diagnostics, uri);
      return;
    }
    checkBlock(node, diagnostics, uri);
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkBlocks(child, diagnostics, uri);
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
  uri: string,
): void {
  const children = namedChildren(block);

  // Scan forward. Once we see a terminator, flag everything after it and point
  // related information back at the terminator that made it unreachable.
  let terminator: import("web-tree-sitter").Node | null = null;

  for (const child of children) {
    // Comments are not executable code — never flag them.
    if (COMMENT_TYPES.has(child.type)) continue;

    if (terminator) {
      diagnostics.push(makeUnreachableDiagnostic(child, terminator, uri));
      continue;
    }

    if (TERMINATOR_TYPES.has(child.type)) {
      terminator = child;
    }
  }
}

/** Build an LSP Range spanning a tree-sitter node. */
function nodeRange(node: import("web-tree-sitter").Node): Range {
  return Range.create(
    { line: node.startPosition.row, character: node.startPosition.column },
    { line: node.endPosition.row, character: node.endPosition.column },
  );
}

/**
 * Build an "Unreachable code" diagnostic tagged Unnecessary so the editor
 * fades the dead statement grey (matching how modern language servers render
 * unreachable code), with related information pointing at the terminator
 * (return/break/continue) that makes the statement unreachable.
 */
function makeUnreachableDiagnostic(
  child: import("web-tree-sitter").Node,
  terminator: import("web-tree-sitter").Node,
  uri: string,
): Diagnostic {
  const diag = Diagnostic.create(
    nodeRange(child),
    "Unreachable code",
    DiagnosticSeverity.Warning,
    CODE_UNREACHABLE,
    "pike-lsp-lint",
  );
  diag.tags = [DiagnosticTag.Unnecessary];
  diag.relatedInformation = [{
    location: { uri, range: nodeRange(terminator) },
    message: `Any code below this ${terminatorLabel(terminator.type)} is never executed`,
  }];
  return diag;
}

/** Human-readable label for a control-flow terminator node type. */
function terminatorLabel(nodeType: string): string {
  switch (nodeType) {
    case "return_statement": return "return";
    case "break_statement": return "break";
    case "continue_statement": return "continue";
    default: return "statement";
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

// Node types that start a new case segment in a switch block.
const CASE_ENTRY_TYPES = new Set(["case_clause", "default_clause"]);

/**
 * Check a switch body block for unreachable code.
 *
 * The switch body is a flat block where case/default clauses and their
 * statements are siblings. Each case/default starts a new control-flow
 * segment. We check reachability only within a segment (between two
 * case/default entries), not across segments.
 */
function checkSwitchBlock(
  block: import("web-tree-sitter").Node,
  diagnostics: Diagnostic[],
  uri: string,
): void {
  const children = namedChildren(block);

  // Build segments: each segment starts at a case/default clause (or the
  // beginning of the block for statements before the first case).
  let currentSegment: import("web-tree-sitter").Node[] = [];
  const segments: import("web-tree-sitter").Node[][] = [currentSegment];

  for (const child of children) {
    if (CASE_ENTRY_TYPES.has(child.type)) {
      currentSegment = [];
      segments.push(currentSegment);
    }
    currentSegment.push(child);
  }

  // Check each segment independently.
  for (const segment of segments) {
    let terminator: import("web-tree-sitter").Node | null = null;
    for (const child of segment) {
      // Comments are not executable code — never flag them.
      if (COMMENT_TYPES.has(child.type)) continue;

      if (terminator) {
        // Still flag unreachable code within a single case segment.
        // E.g.: `case 1: return 1; foo();` — foo() is unreachable.
        // But skip case/default entries and break statements — break after
        // return/continue is a common defensive pattern in switch cases.
        if (!CASE_ENTRY_TYPES.has(child.type) && child.type !== "break_statement") {
          diagnostics.push(makeUnreachableDiagnostic(child, terminator, uri));
        }
        continue;
      }

      if (TERMINATOR_TYPES.has(child.type)) {
        terminator = child;
      }
    }
  }
}
