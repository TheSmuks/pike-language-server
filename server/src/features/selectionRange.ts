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

  // Walk up the tree, collecting ranges for meaningful node types
  const ranges: SelectionRange[] = [];
  let current: Node | null = node;

  while (current) {
    if (MEANINGFUL_TYPES.has(current.type)) {
      const range = {
        start: {
          line: current.startPosition.row,
          character: current.startPosition.column,
        },
        end: {
          line: current.endPosition.row,
          character: current.endPosition.column,
        },
      };

      // Deduplicate: skip if same range as last added
      const lastRange = ranges.length > 0 ? ranges[ranges.length - 1] : null;
      if (!lastRange ||
          lastRange.range.start.line !== range.start.line ||
          lastRange.range.start.character !== range.start.character ||
          lastRange.range.end.line !== range.end.line ||
          lastRange.range.end.character !== range.end.character) {
        ranges.push({ range });
      }
    }
    current = current.parent;
  }

  if (ranges.length === 0) {
    // Fallback: return the root range
    return {
      range: {
        start: { line: root.startPosition.row, character: root.startPosition.column },
        end: { line: root.endPosition.row, character: root.endPosition.column },
      },
    };
  }

  // Build linked list from outermost to innermost.
  // ranges[] is innermost-first; we need to chain parent → child.
  for (let i = ranges.length - 1; i > 0; i--) {
    ranges[i].parent = ranges[i - 1];
  }

  // Return the outermost range (last in the array, which is now the head of the chain)
  return ranges[ranges.length - 1];
}
