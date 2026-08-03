/**
 * Selection range provider for Pike LSP.
 *
 * Implements textDocument/selectionRange — returns progressively larger
 * syntactic ranges containing the cursor position. Used by VSCode's
 * "shrink selection" (Ctrl+Shift+←) and "expand selection" commands.
 *
 * Architecture: pure tree-sitter walk. No semantic analysis needed.
 * Walk from the deepest node at cursor position upward to the root,
 * collecting ranges for meaningful node types only (not every anonymous
 * intermediate node).
 */

import { Tree, Node } from "web-tree-sitter";
import type { SelectionRange } from "vscode-languageserver/node";

// ---------------------------------------------------------------------------
// Node types that produce meaningful selection ranges.
// Anonymous tokens (punctuation, operators) and overly granular nodes
// (identifier_expr wrapping identifier) are skipped to avoid noise.
// ---------------------------------------------------------------------------

const MEANINGFUL_TYPES = new Set([
  // Declarations
  "function_definition",
  "class_definition",
  "enum_definition",
  "typedef_definition",
  "constant_definition",
  "variable_declaration",

  // Statements
  "expression_statement",
  "if_statement",
  "else_clause",
  "while_statement",
  "for_statement",
  "foreach_statement",
  "do_while_statement",
  "switch_statement",
  "case_statement",
  "default_statement",
  "return_statement",
  "break_statement",
  "continue_statement",

  // Blocks
  "block",
  "lambda_expression",

  // Expressions (only the ones that represent meaningful selections)
  "call_expression",
  "index_expression",
  "postfix_expr",
  "scope_expr",
  "ternary_expression",
  "binary_expression",
  "unary_expression",
  "assignment_expression",
  "cast_expression",
  "comma_expr",
  "array_expression",
  "mapping_expression",
  "multiset_expression",
  "string_expression",

  // Type/reference
  "type",
  "inherit_specifier",
  "import_declaration",

  // Parameters
  "parameter_list",
  "argument_list",

  // Top-level
  "source_file",
]);

/**
 * Get the selection range at a given position.
 * Returns a linked list of SelectionRange objects, from innermost to outermost.
 *
 * @param tree Parse tree
 * @param line Cursor line (0-based)
 * @param character Cursor character (0-based UTF-16, same units as tree-sitter columns)
 */
export function getSelectionRange(
  tree: Tree,
  line: number,
  character: number,
): SelectionRange | null {
  const root = tree.rootNode;
  const pos = { row: line, column: character };

  // Find the deepest node at this position
  let node: Node | null = root.descendantForPosition(pos);
  if (!node) return null;

  const ranges = collectRangesUp(node);
  if (ranges.length === 0) return makeRootRange(root);

  // LSP 3.17: SelectionRange.parent is "the parent selection range CONTAINING
  // this range", and the response is the innermost range for the position.
  // This chained the list the other way round and returned the outermost, so
  // every parent was contained BY its child. VSCode's SelectionRange
  // constructor throws on that (`parent must contain this range`), which takes
  // out expand-selection entirely rather than merely reversing it.
  //
  // ranges[] is innermost-first, so each element's parent is the next one.
  for (let i = 0; i < ranges.length - 1; i++) {
    ranges[i].parent = ranges[i + 1];
  }

  return ranges[0];
}

/**
 * Walk from node up to root, collecting meaningful selection ranges.
 * Returns innermost-first order.
 */
function collectRangesUp(node: Node | null): SelectionRange[] {
  const ranges: SelectionRange[] = [];
  while (node) {
    if (MEANINGFUL_TYPES.has(node.type)) {
      const range = nodeToRange(node, ranges[ranges.length - 1]);
      if (range) ranges.push(range);
    }
    node = node.parent;
  }
  return ranges;
}

function nodeToRange(node: Node, lastRange: SelectionRange | null): SelectionRange | null {
  const range: SelectionRange = {
    range: {
      start: {
        line: node.startPosition.row,
        character: node.startPosition.column,
      },
      end: {
        line: node.endPosition.row,
        character: node.endPosition.column,
      },
    },
  };
  if (lastRange &&
      lastRange.range.start.line === range.range.start.line &&
      lastRange.range.start.character === range.range.start.character &&
      lastRange.range.end.line === range.range.end.line &&
      lastRange.range.end.character === range.range.end.character) {
    return null; // deduplicate
  }
  return range;
}

function makeRootRange(root: Node): SelectionRange {
  return {
    range: {
      start: { line: root.startPosition.row, character: root.startPosition.column },
      end: { line: root.endPosition.row, character: root.endPosition.column },
    },
  };
}
