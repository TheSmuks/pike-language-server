/**
 * Diagnostic merge utilities — pure functions for combining diagnostic sources.
 *
 * Extracted from diagnosticManager.ts to keep it under 500 lines.
 * Re-exported by diagnosticManager.ts so existing imports continue to work.
 */

import {
  Diagnostic,
  DiagnosticSeverity,
} from "vscode-languageserver/node";

import type { PikeDiagnostic } from "./pikeWorker";
import type { Tree } from "../parser";

// ---------------------------------------------------------------------------
// mergeDiagnostics
// ---------------------------------------------------------------------------

/**
 * Merge parse diagnostics with Pike compilation diagnostics.
 *
 * Pike diagnostics report only line numbers (no column data). When a parsed
 * tree is available, lineToColumn uses it to find the first meaningful
 * token on the diagnostic line, providing column-level precision.
 *
 * Deduplication: Parse diagnostics on lines that have Pike diagnostics are
 * suppressed. Pike diagnostics are more semantically accurate.
 *
 * Both diagnostic types receive codes: parse errors get P1xxx, Pike errors
 * get P2xxxx (or the Pike compiler's own code if available).
 */
export function mergeDiagnostics(
  parseDiags: Diagnostic[],
  pikeDiags: PikeDiagnostic[],
  tree?: Tree,
  lintDiags?: Diagnostic[],
  lines?: string[],
): Diagnostic[] {
  // Build set of line numbers that have Pike diagnostics.
  // Parse diagnostics on these lines will be suppressed (Pike is more precise).
  const pikeLines = new Set<number>();
  for (const pd of pikeDiags) {
    pikeLines.add(pd.line - 1); // Pike 1-based → LSP 0-based
  }

  // Filter parse diagnostics: suppress if the same line has a Pike diagnostic.
  const suppressedParseDiags = parseDiags.filter((diag) => {
    return !pikeLines.has(diag.range.start.line);
  });

  // Filter lint diagnostics: suppress if the same line has a Pike diagnostic.
  const suppressedLintDiags = (lintDiags ?? []).filter((diag) => {
    return !pikeLines.has(diag.range.start.line);
  });

  const result: Diagnostic[] = [...suppressedParseDiags, ...suppressedLintDiags];

  for (const pd of pikeDiags) {
    const line = Math.max(0, pd.line - 1); // Pike: 1-based → LSP: 0-based
    const character = tree ? messageAwareColumn(tree, pd.line, pd.message, lines) : 0;

    let message = pd.message;
    if (pd.expected_type) message += `\nExpected: ${pd.expected_type}`;
    if (pd.actual_type) message += `\nGot: ${pd.actual_type}`;

    result.push({
      range: {
        start: { line, character },
        end: { line, character },
      },
      severity: pd.severity === "error"
        ? DiagnosticSeverity.Error
        : DiagnosticSeverity.Warning,
      source: "pike",
      message,
      code: pd.code ?? `P2${String(pd.line).padStart(4, '0')}`,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// computeContentHash
// ---------------------------------------------------------------------------

/** Compute FNV-1a 64-bit content hash (fast, non-cryptographic). */
export function computeContentHash(source: string): string {
  let hash = 14695981039346656037n;
  for (let i = 0; i < source.length; i++) {
    hash ^= BigInt(source.charCodeAt(i));
    hash = (hash * 1099511628211n) & 0xffffffffffffffffn;
  }
  return hash.toString(36);
}

// ---------------------------------------------------------------------------
// messageAwareColumn
// ---------------------------------------------------------------------------

/**
 * Common Pike error message patterns that embed identifier names.
 * Each pattern captures a specific identifier that the diagnostic refers to.
 * Ordered from most specific to least specific.
 */
const PIKE_MSG_PATTERNS: Array<{ re: RegExp; group: number }> = [
  // "Undefined identifier: bark."
  { re: /Undefined identifier:\s+(\w+)/, group: 1 },
  // "Too few arguments to bark."
  { re: /Too (?:few|many) arguments to (\w+)/, group: 1 },
  // "Bad argument 1 to bark()."
  { re: /Bad argument \d+ to (\w+)/, group: 1 },
  // "Cannot call non-function in foo()."
  { re: /Cannot call non-function in (\w+)/, group: 1 },
  // "Class not found: 'MissingClass'."
  { re: /Class not found:\s+'(\w+)'/, group: 1 },
  // "No such index: 'bark'."
  { re: /No such (?:index|member):\s+'(\w+)'/, group: 1 },
  // "No such symbol: bark."
  { re: /No such symbol:\s+(\w+)/, group: 1 },
  // "Cannot index TYPE with..." — no useful identifier for column
  // Generic fallback: capture the last quoted or backtick'd word
  { re: /'(\w+)'/, group: 1 },
];

/**
 * Find the column of the specific token referenced in a Pike error message.
 *
 * Pike diagnostics only report line numbers. When a parse tree is available,
 * this function extracts the identifier from the message text and locates it
 * on the diagnostic line using tree-sitter, providing column-level precision.
 *
 * Falls back to `lineToColumn` (first meaningful token on the line) when the
 * message doesn't contain an identifiable token or the token isn't found on
 * the line.
 */
export function messageAwareColumn(
  tree: Tree,
  line: number,
  message: string,
  lines?: string[],
): number {
  const lspLine = Math.max(0, line);
  const identifier = extractIdentifier(message);
  if (!identifier) return lineToColumn(tree, line, lines);

  const idx = lines?.[lspLine]?.indexOf(identifier);
  if (idx !== undefined && idx >= 0) return idx;

  const result = findIdentifierColumn(tree, lspLine, identifier);
  return result >= 0 ? result : lineToColumn(tree, line, lines);
}

function extractIdentifier(message: string): string | null {
  for (const { re, group } of PIKE_MSG_PATTERNS) {
    const match = message.match(re);
    if (match && match[group]) return match[group];
  }
  return null;
}

function findIdentifierColumn(tree: Tree, lspLine: number, identifier: string): number {
  const root = tree.rootNode;
  const stack: number[] = [0];
  const nodeStack: any[] = [root];

  while (nodeStack.length > 0) {
    const node = nodeStack[nodeStack.length - 1];
    const childIdx = stack[stack.length - 1] ?? 0;

    if (childIdx < node.childCount) {
      stack[stack.length - 1] = childIdx + 1;
      const child = node.child(childIdx);

      if (child.startPosition.row > lspLine) continue;
      if (child.endPosition.row < lspLine) continue;

      if (child.startPosition.row === lspLine && child.text === identifier) {
        return child.startPosition.column;
      }

      nodeStack.push(child);
      stack.push(0);
    } else {
      nodeStack.pop();
      stack.pop();
    }
  }

  return -1;
}

// ---------------------------------------------------------------------------
// lineToColumn
// ---------------------------------------------------------------------------

/**
 * Find the column of the first non-whitespace meaningful token on a given line
 * using tree-sitter. Returns 0 if the line is empty or cannot be determined.
 *
 * Used to provide column-level precision for Pike diagnostics, which only
 * report line numbers (Pike compile_error provides no column data).
 */
export function lineToColumn(tree: Tree, line: number, lines?: string[]): number {
  const lspLine = Math.max(0, line);
  const first = firstMeaningfulChild(tree.rootNode, lspLine);
  if (first >= 0) return first;

  const fallback = walkToMeaningfulNode(tree, lspLine);
  if (fallback >= 0) return fallback;

  return lastResortColumn(lines, lspLine);
}

function firstMeaningfulChild(root: any, lspLine: number): number {
  for (const child of root.children) {
    if (child.startPosition.row !== lspLine) continue;
    if (child.type === "comment" || child.type === "preprocessor") continue;
    if (!child.isError && !child.isMissing) return child.startPosition.column;
  }
  return -1;
}

function walkToMeaningfulNode(tree: Tree, lspLine: number): number {
  const node = tree.rootNode.descendantForPosition({ row: lspLine, column: 0 });
  if (!node) return -1;

  let candidate: typeof node | null = node;
  while (candidate) {
    let found = false;
    for (const child of candidate.children) {
      if (child.startPosition.row === lspLine) {
        if (
          child.type !== "comment" &&
          child.type !== "preprocessor" &&
          !child.isError &&
          !child.isMissing
        ) {
          return child.startPosition.column;
        }
        candidate = child;
        found = true;
        break;
      }
      if (child.startPosition.row < lspLine && child.endPosition.row >= lspLine) {
        candidate = child;
        found = true;
        break;
      }
    }
    if (!found) break;
  }
  return -1;
}

function lastResortColumn(lines: string[] | undefined, lspLine: number): number {
  const lineText = lines?.[lspLine];
  if (lineText !== undefined) {
    const match = lineText.match(/\S/);
    if (match) return match.index ?? 0;
  }
  return 0;
}
