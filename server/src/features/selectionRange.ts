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
  "function_decl",
  "local_function_decl",
  "class_decl",
  "anon_class",
  "named_class_expr",
  "class_body",
  "enum_decl",
  "anon_enum",
  "enum_member",
  "typedef_decl",
  "constant_decl",
  "variable_decl",
  "local_declaration",
  "declaration",
  "cond_decl",

  // Statements
  "expression_statement",
  "if_statement",
  "while_statement",
  "for_statement",
  "foreach_statement",
  "do_while_statement",
  "switch_statement",
  "case_clause",
  "default_clause",
  "labeled_statement",
  "return_statement",
  "break_statement",
  "continue_statement",
  "macro_statement",
  "macro_invocation_stmt",

  // Blocks
  "block",
  "lambda_expr",

  // Expressions (only the ones that represent meaningful selections)
  "postfix_expr",
  "scope_expr",
  "identifier_expr",
  "primary_expr",
  "cond_expr",
  "assign_expr",
  "add_expr",
  "mul_expr",
  "rel_expr",
  "eq_expr",
  "land_expr",
  "lor_expr",
  "bitand_expr",
  "bitor_expr",
  "bitxor_expr",
  "shift_expr",
  "unary_expr",
  "cast_expr",
  "soft_cast_expr",
  "catch_expr",
  "gauge_expr",
  "typeof_expr",
  "sscanf_expr",
  "class_instantiation",
  "comma_expr",
  "array_literal",
  "mapping_literal",
  "multiset_literal",
  "mapping_pair",
  "string_literal",
  "string_concat",

  // Type/reference
  "type",
  "id_type",
  "basic_type",
  "inherit_specifier",
  "inherit_decl",
  "import_decl",

  // Parameters
  "parameters",
  "parameter",
  "argument_list",

  // Top-level
  "program",
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
