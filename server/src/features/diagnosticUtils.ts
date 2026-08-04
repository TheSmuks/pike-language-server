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

/**
 * Build a notice shown when a file has more diagnostics than the configured
 * cap, so the user knows results were truncated rather than clean. Placed at
 * the top of the document; one slot is reserved for it within maxProblems.
 */
export function buildTruncationNotice(total: number, maxProblems: number): Diagnostic {
  const shown = maxProblems - 1;
  const hidden = total - shown;
  return {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    severity: DiagnosticSeverity.Information,
    source: "pike",
    code: "P0001",
    message: `Showing first ${shown} of ${total} problems (${hidden} more hidden). Raise "pike.languageServer.maxNumberOfProblems" to see them all.`,
  };
}

/** Placeholder shown while a slow diagnose is still running. */
export function buildStaleDiagnostic(): Diagnostic {
  return {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    severity: DiagnosticSeverity.Information,
    source: "pike-lsp",
    message: "Diagnostics are being updated…",
  };
}

/** Shown when the Pike worker timed out compiling the file. */
export function buildTimeoutDiagnostic(): Diagnostic {
  return {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    severity: DiagnosticSeverity.Warning,
    source: "pike-lsp",
    message: "Compilation timed out, will retry on next save.",
  };
}

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
  /** Path of the document being compiled — lets a diagnostic raised inside an
   *  #include'd file be told apart from one raised here. */
  documentPath?: string,
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
  for (const pd of pikeDiags) result.push(buildPikeDiagnostic(pd, tree, lines, documentPath));
  return result;
}

/**
 * Was this raised in a file other than the one being compiled?
 *
 * Unknown filenames count as local: the compiler omits `file` for most
 * diagnostics, and treating those as foreign would move every ordinary error
 * to the top of the document.
 */
function isForeignDiagnostic(pd: PikeDiagnostic, documentPath?: string): boolean {
  if (!pd.file || !documentPath) return false;
  return baseName(pd.file) !== baseName(documentPath);
}

/**
 * Re-anchor a diagnostic from an included file onto the include directive,
 * naming the real origin in the message so the user can find it.
 */
function foreignDiagnostic(pd: PikeDiagnostic, lines: string[]): Diagnostic {
  const line = includeDirectiveLine(lines, pd.file!);
  const text = lines[line] ?? "";
  return {
    range: {
      start: { line, character: 0 },
      end: { line, character: text.length },
    },
    severity: pd.severity === "error" ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
    source: "pike",
    message: `${baseName(pd.file!)}:${pd.line}: ${pd.message}`,
    code: pd.code ?? `P2${String(pd.line).padStart(4, "0")}`,
  };
}

/** Base name of a path, for comparing a compiler filename with a document. */
function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut >= 0 ? path.slice(cut + 1) : path;
}

/**
 * Where to put a diagnostic the compiler raised in a DIFFERENT file.
 *
 * Its line number belongs to that file, so publishing it at the same line of
 * the open document points at unrelated code — and at nothing at all when the
 * open document is shorter, which is how ranges past the end of the file got
 * out. The honest place is the `#include` directive that pulled the file in;
 * failing that, the top of the document.
 */
function includeDirectiveLine(lines: string[], file: string): number {
  const target = baseName(file);
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    if (!text.includes("#include")) continue;
    if (text.includes(target)) return i;
  }
  return 0;
}

/** Build one LSP Diagnostic from a raw Pike compiler diagnostic. */
function buildPikeDiagnostic(
  pd: PikeDiagnostic,
  tree?: Tree,
  lines?: string[],
  documentPath?: string,
): Diagnostic {
  const foreign = isForeignDiagnostic(pd, documentPath);
  if (foreign && lines) return foreignDiagnostic(pd, lines);

  // Pike: 1-based → LSP: 0-based, clamped into the document. A line past the
  // end produces a range no client can render.
  const lastLine = lines && lines.length > 0 ? lines.length - 1 : Number.MAX_SAFE_INTEGER;
  const line = Math.min(Math.max(0, pd.line - 1), lastLine);
  // NOTE: messageAwareRange/lineToColumn expect an already-0-based line.
  // Passing the raw (1-based) pd.line here would look up the wrong source
  // line entirely — a real off-by-one that was masked in earlier tests
  // because the wrong line often happened to share the same indentation
  // (and thus the same fallback column) as the right one.
  const { start, end } = tree
    ? messageAwareRange(tree, line, pd.message, lines)
    : { start: 0, end: 0 };

  let message = pd.message;
  if (pd.expected_type) message += `\nExpected: ${pd.expected_type}`;
  if (pd.actual_type) message += `\nGot: ${pd.actual_type}`;

  return {
    range: {
      start: { line, character: start },
      end: { line, character: end },
    },
    severity: pd.severity === "error"
      ? DiagnosticSeverity.Error
      : DiagnosticSeverity.Warning,
    source: "pike",
    message,
    code: pd.code ?? `P2${String(pd.line).padStart(4, '0')}`,
  };
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
// messageAwareRange
// ---------------------------------------------------------------------------

/**
 * Common Pike error message patterns that embed identifier names.
 * Each pattern captures a specific identifier that the diagnostic refers to.
 * Ordered from most specific to least specific.
 *
 * These are verified against a live Pike 8.0 compiler (per the
 * pike-is-the-oracle rule) rather than guessed from documentation — several
 * previously-guessed shapes here ("Class not found: 'X'.", "Cannot call
 * non-function in X.", "No such index: 'X'.") never match real Pike output
 * and have been replaced with the actual wording.
 */
const PIKE_MSG_PATTERNS: Array<{ re: RegExp; group: number }> = [
  // "Undefined identifier compute_greeting." — the common case.
  // Also matches the quoted form used in DiagnosticsTests.pike fixtures:
  // "Undefined identifier 'x'."
  { re: /Undefined identifier:?\s+'?(\w+)'?/, group: 1 },
  // "Index 'NoSuchThing' not present in module Stdio."
  { re: /Index '(\w+)' not present/, group: 1 },
  // "No such variable (nosuchmember) in object."
  { re: /No such variable \((\w+)\)/, group: 1 },
  // "Attempt to call a non function value gvar." (no identifier is present
  // when the callee is a bare local, e.g. "...value local variable." — the
  // trailing `\.` anchor rejects that two-word case since "local" isn't
  // immediately followed by a period).
  { re: /Attempt to call a non function value (\w+)\./, group: 1 },
  // "Too few arguments to bark (got 1)." / "Too many arguments to bark."
  { re: /Too (?:few|many) arguments to (\w+)/, group: 1 },
  // "Bad argument 1 to bark."
  { re: /Bad argument \d+ to (\w+)/, group: 1 },
  // Generic fallback: capture the last quoted or backtick'd word.
  { re: /'(\w+)'/, group: 1 },
];

/** A half-open [start, end) column range on a single diagnostic line. */
export interface ColumnRange {
  start: number;
  end: number;
}

/**
 * Find the range of the specific token referenced in a Pike error message.
 *
 * Pike diagnostics only report line numbers. When a parse tree is available,
 * this function extracts the identifier from the message text and locates it
 * on the diagnostic line, spanning the full identifier (not a zero-width
 * point) so the client can underline the actual symbol Pike is complaining
 * about.
 *
 * The tree-sitter whole-node match is tried first: it compares a node's
 * *entire* text against the identifier, so "foo" can never match inside
 * "foobar" the way a plain substring search could. The text search is only
 * a fallback for tokens that don't correspond to a single tree-sitter leaf
 * (e.g. inside an ERROR recovery region) — and even then it is identifier
 * -boundary-aware for the same reason.
 *
 * Falls back to a zero-width range at `lineToColumn` (first meaningful token
 * on the line) when the message doesn't contain an identifiable token or the
 * token isn't found on the line at all.
 */
export function messageAwareRange(
  tree: Tree,
  line: number,
  message: string,
  lines?: string[],
): ColumnRange {
  const lspLine = Math.max(0, line);
  const identifier = extractIdentifier(message);
  if (!identifier) {
    const col = lineToColumn(tree, line, lines);
    return { start: col, end: col };
  }

  const found = findIdentifierColumn(tree, lspLine, identifier);
  if (found >= 0) {
    return { start: found, end: found + identifier.length };
  }

  const idx = lines?.[lspLine] !== undefined ? indexOfWholeIdentifier(lines[lspLine], identifier) : -1;
  if (idx >= 0) {
    return { start: idx, end: idx + identifier.length };
  }

  const col = lineToColumn(tree, line, lines);
  return { start: col, end: col };
}

function extractIdentifier(message: string): string | null {
  for (const { re, group } of PIKE_MSG_PATTERNS) {
    const match = message.match(re);
    if (match && match[group]) return match[group];
  }
  return null;
}

/**
 * Find `identifier` in `text` at an identifier boundary — not preceded or
 * followed by another Pike identifier character ([A-Za-z0-9_]). Without
 * this, searching for "foo" on a line containing "foobar" before the real
 * "foo" would highlight the wrong (inner) substring.
 */
function indexOfWholeIdentifier(text: string, identifier: string): number {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`\\b${escaped}\\b`).exec(text);
  return match ? match.index : -1;
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
