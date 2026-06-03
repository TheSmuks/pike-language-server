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
import { utf8ToUtf16, utf16ToUtf8 } from "../util/positionConverter";

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
 * @param character Cursor character (0-based UTF-16)
 * @param lines Pre-split source lines.
 */
export function getSelectionRange(
  tree: Tree,
  line: number,
  character: number,
  lines: string[],
): SelectionRange | null {
  const root = tree.rootNode;
  // Convert LSP character (UTF-16) to tree-sitter column (UTF-8 byte offset)
  const utf8Col = utf16ToUtf8(lines[line] ?? '', character);
  const pos = { row: line, column: utf8Col };

  // Find the deepest node at this position
  let node: Node | null = root.descendantForPosition(pos);
  if (!node) return null;

  const ranges = collectRangesUp(node, lines);
  if (ranges.length === 0) return makeRootRange(root, lines);

  // Build linked list from outermost to innermost.
  // ranges[] is innermost-first; we need to chain parent → child.
  for (let i = ranges.length - 1; i > 0; i--) {
    ranges[i].parent = ranges[i - 1];
  }

  // Return the outermost range (last in the array, which is now the head of the chain)
  return ranges[ranges.length - 1];
}

/**
 * Walk from node up to root, collecting meaningful selection ranges.
 * Returns innermost-first order.
 */
function collectRangesUp(node: Node | null, lines: string[]): SelectionRange[] {
  const ranges: SelectionRange[] = [];
  while (node) {
    if (MEANINGFUL_TYPES.has(node.type)) {
      const range = nodeToRange(node, ranges[ranges.length - 1], lines);
      if (range) ranges.push(range);
    }
    node = node.parent;
  }
  return ranges;
}

function nodeToRange(node: Node, lastRange: SelectionRange | null, lines: string[]): SelectionRange | null {
  const range: SelectionRange = {
    range: {
      start: {
        line: node.startPosition.row,
        character: utf8ToUtf16(lines[node.startPosition.row] ?? '', node.startPosition.column),
      },
      end: {
        line: node.endPosition.row,
        character: utf8ToUtf16(lines[node.endPosition.row] ?? '', node.endPosition.column),
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

function makeRootRange(root: Node, lines: string[]): SelectionRange {
  return {
    range: {
      start: { line: root.startPosition.row, character: utf8ToUtf16(lines[root.startPosition.row] ?? '', root.startPosition.column) },
      end: { line: root.endPosition.row, character: utf8ToUtf16(lines[root.endPosition.row] ?? '', root.endPosition.column) },
    },
  };
}