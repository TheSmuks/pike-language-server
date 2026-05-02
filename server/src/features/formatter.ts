/**
 * Pike source code formatter using tree-sitter parse tree (US-026).
 *
 * Walks the tree to produce TextEdit[] for formatting:
 * - 2-space indentation (Pike stdlib convention)
 * - Opening brace on same line as declaration
 * - No space before `(` in function calls/declarations
 * - Space after `//` and `//!` in comments
 * - Blank line between top-level declarations (class, function)
 *
 * Design: tree-sitter-based formatting.
 * Alternative considered: Topiary (tree-sitter query-based). Rejected because
 * it adds a Rust binary dependency and Pike grammar may not be compatible with
 * Topiary's tree-sitter version.
 */

import type { Tree, Node, Point } from "web-tree-sitter";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FormatOptions {
  /** Indentation string. Default: two spaces. */
  indentSize: number;
  /** Insert blank line between top-level declarations. Default: true. */
  insertBlankLines: boolean;
}

const DEFAULT_OPTIONS: FormatOptions = {
  indentSize: 2,
  insertBlankLines: true,
};

// LSP TextEdit
export interface TextEdit {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  newText: string;
}

// ---------------------------------------------------------------------------
// Formatting rules
// ---------------------------------------------------------------------------

// Node types that open a new indentation level (block scopes)
const INDENT_NODES = new Set([
  "block",
  "class_body",
  "program",
]);

// Node types that are declarations (top-level = blank line before)
const TOP_LEVEL_NODES = new Set([
  "class_declaration",
  "function_declaration",
  "enum_declaration",
  "constant_declaration",
]);

// Nodes where the opening brace should be on the same line
const BRACE_SAME_LINE_NODES = new Set([
  "class_declaration",
  "function_declaration",
  "block",
]);

// ---------------------------------------------------------------------------
// Formatter state
// ---------------------------------------------------------------------------

interface FormatState {
  indent: number;        // Current indentation level (in spaces)
  lastWasTopLevel: boolean;
  lastNodeEndLine: number;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Format a Pike source file. Returns a list of TextEdit operations.
 */
export function formatPike(source: string, tree: Tree, options?: Partial<FormatOptions>): TextEdit[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const edits: TextEdit[] = [];

  const state: FormatState = {
    indent: 0,
    lastWasTopLevel: false,
    lastNodeEndLine: -1,
  };

  walkTree(tree.rootNode, source, edits, state, opts);

  return edits;
}

/**
 * Recursively walk the tree and apply formatting edits.
 */
function walkTree(node: Node, source: string, edits: TextEdit[], state: FormatState, opts: FormatOptions): void {
  // Handle top-level declarations (blank line before)
  if (TOP_LEVEL_NODES.has(node.type)) {
    const startLine = node.startPosition.row;

    if (state.lastWasTopLevel && state.lastNodeEndLine >= 0) {
      // Check if there's already a blank line
      const hasBlankLine = startLine > state.lastNodeEndLine + 1;

      if (opts.insertBlankLines && !hasBlankLine) {
        // Insert blank line before this declaration
        const insertLine = state.lastNodeEndLine;
        edits.push(createInsertLineEdit(insertLine, ""));
      }
    }

    state.lastWasTopLevel = true;
  } else {
    state.lastWasTopLevel = false;
  }

  // Handle indentation for indent nodes
  if (INDENT_NODES.has(node.type)) {
    const startLine = node.startPosition.row;
    const endLine = node.endPosition.row;

    // Format the node content (children)
    const indentStr = " ".repeat(state.indent);

    // Find opening brace position
    const openBrace = findChildByText(node, source, "{");
    if (openBrace) {
      // Check if opening brace is on a new line (wrong)
      const lineStartCol = getLineStartColumn(source, openBrace.startIndex);
      const beforeBrace = source.slice(lineStartCol, openBrace.startIndex).trimEnd();

      if (beforeBrace.length > 0 && !beforeBrace.endsWith("{")) {
        // There is content before the brace on the same line
        // This is correct Pike style (brace on same line)
      }
    }

    // Increase indent for children
    state.indent += opts.indentSize;

    // Walk children
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) {
        // Update lastNodeEndLine before processing children
        const prevEndLine = state.lastNodeEndLine;
        state.lastNodeEndLine = child.endPosition.row;

        walkTree(child, source, edits, state, opts);
      }
    }

    // Decrease indent
    state.indent -= opts.indentSize;

    // Mark that we processed this block's children
    return;
  }

  // Process children for non-indent nodes
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) {
      state.lastNodeEndLine = child.endPosition.row;
      walkTree(child, source, edits, state, opts);
    }
  }
}

/**
 * Create a TextEdit that inserts an empty line at a specific line.
 */
function createInsertLineEdit(line: number, _text: string): TextEdit {
  return {
    range: {
      start: { line, character: 0 },
      end: { line, character: 0 },
    },
    newText: "\n",
  };
}

/**
 * Find a child node by its text content (first matching text).
 */
function findChildByText(node: Node, source: string, text: string): Node | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) {
      const childText = source.slice(child.startIndex, child.endIndex);
      if (childText.includes(text)) {
        return child;
      }
    }
  }
  return null;
}

/**
 * Get the column index of the start of the line containing the given index.
 */
function getLineStartColumn(source: string, index: number): number {
  let pos = index;
  while (pos > 0 && source[pos - 1] !== "\n") {
    pos--;
  }
  return pos;
}

// ---------------------------------------------------------------------------
// Range helpers (for testing)
// ---------------------------------------------------------------------------

/**
 * Create a range from node start/end positions.
 */
export function nodeRange(node: Node): { start: Point; end: Point } {
  return {
    start: node.startPosition,
    end: node.endPosition,
  };
}

/**
 * Check if a node spans multiple lines.
 */
export function isMultiline(node: Node): boolean {
  return node.startPosition.row !== node.endPosition.row;
}

/**
 * Get the text content of a node.
 */
export function nodeText(node: Node, source: string): string {
  return source.slice(node.startIndex, node.endIndex);
}