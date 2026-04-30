/**
 * Folding range production from tree-sitter parse tree (US-016).
 *
 * Walks the tree-sitter AST to find foldable ranges:
 * - class_body
 * - block (function bodies, if/for/foreach/while/switch blocks)
 * - Comment groups (consecutive line_comment nodes)
 * - AutoDoc groups (consecutive //! comment nodes)
 */

import type { Tree, Node } from "web-tree-sitter";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FoldingRange {
  startLine: number;
  endLine: number;
  startCharacter?: number;
  endCharacter?: number;
  kind?: string;
}

// ---------------------------------------------------------------------------
// Node types that produce foldable ranges
// ---------------------------------------------------------------------------

const FOLDABLE_NODE_TYPES = new Set([
  "class_body",
  "block",
]);

// ---------------------------------------------------------------------------
// Foldable range production
// ---------------------------------------------------------------------------

/**
 * Produce folding ranges from a tree-sitter parse tree.
 *
 * Walks the tree looking for class_body and block nodes,
 * plus groups of consecutive comments.
 */
export function produceFoldingRanges(tree: Tree): FoldingRange[] {
  const ranges: FoldingRange[] = [];
  const root = tree.rootNode;

  // Walk the tree for foldable block-like nodes
  walkForFoldables(root, ranges);

  // Walk for comment groups
  collectCommentGroups(root, ranges);

  return ranges;
}

/**
 * Recursively walk the tree for foldable node types.
 */
function walkForFoldables(node: Node, ranges: FoldingRange[]): void {
  if (FOLDABLE_NODE_TYPES.has(node.type)) {
    const startLine = node.startPosition.row;
    const endLine = node.endPosition.row;

    // Only fold if it spans more than one line
    if (endLine > startLine) {
      ranges.push({
        startLine,
        endLine,
        kind: "region",
      });
    }
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkForFoldables(child, ranges);
  }
}

/**
 * Collect groups of consecutive line comments as foldable ranges.
 *
 * Groups are formed when two or more consecutive lines start with // or //!.
 * The group extends from the first comment to the last.
 */
function collectCommentGroups(node: Node, ranges: FoldingRange[]): void {
  const children = node.children;
  let groupStart: number | null = null;

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.type === "line_comment") {
      if (groupStart === null) {
        groupStart = i;
      }
    } else {
      if (groupStart !== null) {
        maybeAddCommentGroup(children, groupStart, i - 1, ranges);
        groupStart = null;
      }
    }
  }

  // Handle trailing comment group
  if (groupStart !== null) {
    maybeAddCommentGroup(children, groupStart, children.length - 1, ranges);
  }
}

/**
 * Add a comment group as a foldable range if it spans more than one line.
 */
function maybeAddCommentGroup(
  children: Node[],
  startIdx: number,
  endIdx: number,
  ranges: FoldingRange[],
): void {
  if (startIdx >= endIdx) return;

  const startLine = children[startIdx].startPosition.row;
  const endLine = children[endIdx].endPosition.row;

  if (endLine > startLine) {
    ranges.push({
      startLine,
      endLine,
      kind: "comment",
    });
  }
}
