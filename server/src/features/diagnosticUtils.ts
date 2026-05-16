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
    const character = tree ? lineToColumn(tree, pd.line, lines) : 0;

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
  // line is 0-based in tree-sitter; Pike diagnostics are 1-based
  const lspLine = Math.max(0, line);
  const node = tree.rootNode.descendantForPosition({ row: lspLine, column: 0 });
  if (!node) return 0;

  // Walk through root children to find the first named node starting on this line.
  // We want the first meaningful token, skipping whitespace, comments, and ERROR nodes.
  for (const child of tree.rootNode.children) {
    const startRow = child.startPosition.row;
    if (startRow !== lspLine) continue;
    if (child.type === "comment" || child.type === "preprocessor") continue;
    if (!child.isError && !child.isMissing) {
      return child.startPosition.column;
    }
  }

  // Fallback: scan the text for first non-whitespace character
  const lineText = lines?.[lspLine];
  if (lineText !== undefined) {
    const match = lineText.match(/\S/);
    if (match) return match.index ?? 0;
  }

  return 0;
}
