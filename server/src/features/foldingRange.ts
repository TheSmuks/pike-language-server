/**
 * Folding range production from tree-sitter parse tree (US-016).
 *
 * Walks the tree-sitter AST to find foldable ranges:
 * - class_body
 * - block (function bodies, if/for/foreach/while blocks)
 * - switch case groups (case/default clauses + their body statements)
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

/** Label nodes that start a new case group inside a switch body. */
const CASE_LABEL_TYPES = new Set(["case_clause", "default_clause"]);

// ---------------------------------------------------------------------------
// Foldable range production
// ---------------------------------------------------------------------------

/**
 * Produce folding ranges from a tree-sitter parse tree.
 *
 * Walks the tree looking for class_body and block nodes,
 * switch case groups, plus groups of consecutive comments.
 */
export function produceFoldingRanges(tree: Tree): FoldingRange[] {
  const ranges: FoldingRange[] = [];
  const root = tree.rootNode;

  // Walk the tree for foldable block-like nodes and switch case groups
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

    // If this block is the body of a switch_statement, also produce
    // foldable ranges for each case/default group. In tree-sitter-pike,
    // case_clause and default_clause are flat siblings of the statements
    // inside the switch's block — they are not containers. We group
    // consecutive children by their leading label.
    if (isSwitchBody(node)) {
      collectCaseGroups(node, ranges);
    }
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkForFoldables(child, ranges);
  }
}

/** Check whether a block node is the body of a switch_statement. */
function isSwitchBody(block: Node): boolean {
  const parent = block.parent;
  if (!parent) return false;
  return parent.type === "switch_statement";
}

/**
 * Group the children of a switch body block into foldable case groups.
 *
 * Each group starts at a case_clause or default_clause and extends to
 * just before the next label (or the closing brace). Consecutive labels
 * (fall-through: "case 2: case 3: body") are merged into a single group
 * starting at the first label. A group is foldable if it spans more than
 * one line.
 */
function collectCaseGroups(block: Node, ranges: FoldingRange[]): void {
  const children = block.children;
  // Track the start of the current group.
  let groupStart: { idx: number; line: number } | null = null;

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (CASE_LABEL_TYPES.has(child.type)) {
      if (groupStart !== null) {
        // If the previous group only had a label with no body statements,
        // this is a fall-through — extend the group rather than closing it.
        if (groupStart.idx === i - 1) {
          continue;
        }
        // Close the previous group: ends at the child just before this label.
        emitCaseGroup(children, groupStart, i - 1, ranges);
      }
      groupStart = { idx: i, line: child.startPosition.row };
    }
  }

  // Close the final group — extends to the last child before the closing `}`.
  // The closing brace is the last child, so we stop at second-to-last.
  if (groupStart !== null) {
    const lastIdx = children.length - 1;
    // The last child is the closing `}` — don't include it in the fold range.
    const endIdx = children[lastIdx].type === "}" ? lastIdx - 1 : lastIdx;
    emitCaseGroup(children, groupStart, endIdx, ranges);
  }
}

/**
 * Emit a foldable range for a case group if it spans more than one line.
 */
function emitCaseGroup(
  children: Node[],
  start: { idx: number; line: number },
  endIdx: number,
  ranges: FoldingRange[],
): void {
  // The group must include at least one statement after the label.
  if (endIdx <= start.idx) return;

  const endLine = children[endIdx].endPosition.row;

  // Only fold if the group spans more than one line.
  if (endLine > start.line) {
    ranges.push({
      startLine: start.line,
      endLine,
      kind: "region",
    });
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
