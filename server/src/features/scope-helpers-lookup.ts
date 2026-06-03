/**
 * Scope lookup helpers — binary search and position-based lookup.
 *
 * Extracted from scope-helpers.ts to keep each file under 500 lines.
 * Contains the O(log S) binary search for findScopeForNode and helpers.
 */
import type { Node } from 'web-tree-sitter';
import type { BuildState, Range, Scope } from './symbolTable';
import { lookupUtf16 } from '../util/offsetMap';

/** Compute a rough size metric for a range (used to pick innermost scope). */
export function rangeSize(range: Range): number {
  return (range.end.line - range.start.line) * 10000 +
         (range.end.character - range.start.character);
}

/**
 * Compare a position (line, char) to a range start (line, char).
 * Returns negative if pos < rangeStart, 0 if equal, positive if pos > rangeStart.
 */
function comparePositionToRangeStart(
  posLine: number, posChar: number,
  rangeLine: number, rangeChar: number,
): number {
  const lineDiff = posLine - rangeLine;
  if (lineDiff !== 0) return lineDiff;
  return posChar - rangeChar;
}

/**
 * Check whether a scope's end position is at or after the given position.
 */
function scopeEndsAfterOrAt(scope: Scope, endRow: number, endChar: number): boolean {
  return (
    scope.range.end.line > endRow ||
    (scope.range.end.line === endRow && scope.range.end.character >= endChar)
  );
}

/**
 * Find the index of the last scope whose start is ≤ the node's start position.
 * Uses binary search on sorted scopes (sorted by start position).
 */
function binarySearchLastCandidate(
  sorted: Scope[],
  nodeStartRow: number,
  nodeStartChar: number,
): number {
  let lo = 0;
  let hi = sorted.length - 1;
  let lastCandidateIdx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const scope = sorted[mid]!;
    const cmp = comparePositionToRangeStart(
      nodeStartRow, nodeStartChar,
      scope.range.start.line, scope.range.start.character,
    );
    if (cmp >= 0) {
      lastCandidateIdx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return lastCandidateIdx;
}

/**
 * Walk backward from the rightmost candidate to find the innermost containing scope.
 * Scopes are sorted by start position, so later scopes with same-or-later start
 * positions are more deeply nested (smaller range).
 */
function findInnermostScope(
  sorted: Scope[],
  lastCandidateIdx: number,
  nodeStartRow: number,
  nodeStartChar: number,
  nodeEndRow: number,
  nodeEndChar: number,
): number | null {
  let bestScopeId: number | null = null;
  let bestSize = Infinity;
  for (let i = lastCandidateIdx; i >= 0; i--) {
    const scope = sorted[i]!;
    if (scope.range.start.line > nodeStartRow ||
        (scope.range.start.line === nodeStartRow &&
         scope.range.start.character > nodeStartChar)) {
      break;
    }
    if (scopeEndsAfterOrAt(scope, nodeEndRow, nodeEndChar)) {
      const size = rangeSize(scope.range);
      if (size < bestSize || (size === bestSize && scope.id > bestScopeId!)) {
        bestSize = size;
        bestScopeId = scope.id;
      }
    }
  }
  return bestScopeId;
}

/**
 * Find the scope ID that contains a given node.
 *
 * Uses binary search on sortedScopes (sorted by start position) to find
 * candidate scopes in O(log S) instead of O(S). For each candidate, verifies
 * containment using the pre-computed offset map for O(1) position conversion.
 *
 * Overall complexity: O(R × log S) for the reference pass instead of O(R × S).
 */
export function findScopeForNode(node: Node, state: BuildState): number | null {
  const nodeStartRow = node.startPosition.row;
  const nodeStartCol = node.startPosition.column;
  const nodeEndRow = node.endPosition.row;
  const nodeEndCol = node.endPosition.column;

  const sorted = state.sortedScopes;
  if (sorted.length === 0) return null;

  // Convert node positions to UTF-16 once for all containment checks.
  const nodeStartChar = lookupUtf16(state.offsetMap, nodeStartRow, nodeStartCol);
  const nodeEndChar = lookupUtf16(state.offsetMap, nodeEndRow, nodeEndCol);

  // Binary search: find the rightmost scope whose start is ≤ the node's start.
  // sorted is sorted by (startLine, startChar) ascending.
  let lastCandidateIdx = binarySearchLastCandidate(sorted, nodeStartRow, nodeStartChar);
  if (lastCandidateIdx === -1) return null;

  // Walk backward from the rightmost candidate to find the innermost containing scope.
  return findInnermostScope(sorted, lastCandidateIdx, nodeStartRow, nodeStartChar, nodeEndRow, nodeEndChar);
}