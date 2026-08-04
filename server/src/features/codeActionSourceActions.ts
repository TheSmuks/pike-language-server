/**
 * Code action source actions — organize imports and extract variable.
 *
 * Extracted from codeAction.ts to keep it under 500 lines.
 * Re-exported by codeAction.ts so existing imports continue to work.
 */

import type {
  CodeActionParams,
  TextEdit,
} from "vscode-languageserver/node";
import type { Tree } from "web-tree-sitter";
import { parse } from "../parser";

// ---------------------------------------------------------------------------
// Source action: organize imports
// ---------------------------------------------------------------------------

/**
 * Organize imports: sort alphabetically and remove duplicates.
 * Returns TextEdits or empty array if no changes needed.
 */
export function organizeImports(text: string): TextEdit[] {
  const lines = text.split("\n");
  const importLines: { line: number; text: string }[] = [];
  let firstImport = -1;
  let lastImport = -1;

  // Collect all import lines and their positions
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("import ")) {
      if (firstImport === -1) firstImport = i;
      lastImport = i;
      importLines.push({ line: i, text: trimmed });
    }
    // Stop at first non-directive, non-comment, non-blank after imports start
    if (firstImport !== -1 && i > lastImport &&
        trimmed !== "" && !trimmed.startsWith("//") && !trimmed.startsWith("/*") &&
        !trimmed.startsWith("import ") && !trimmed.startsWith("inherit ") &&
        !trimmed.startsWith("#pike")) {
      break;
    }
  }

  if (importLines.length <= 1) return [];

  // Sort and deduplicate
  const sorted = [...new Set(importLines.map(i => i.text))].sort();

  // Check if already sorted and deduplicated
  const original = importLines.map(i => i.text);
  if (original.length === sorted.length && original.every((v, i) => v === sorted[i])) {
    return [];
  }

  return rewriteImportLines(lines, importLines, sorted);
}

/**
 * Write the sorted imports back onto the import lines themselves.
 *
 * Replacing the whole span from the first import to the last is what destroyed
 * everything between them: an `inherit` clause, a comment, a blank line. Those
 * lines are not imports and this action has no business touching them — losing
 * an inherit stops the file compiling. Each import line is rewritten in place,
 * and any line left over after deduplication is removed on its own.
 */
function rewriteImportLines(
  lines: string[],
  importLines: { line: number; text: string }[],
  sorted: string[],
): TextEdit[] {
  const edits: TextEdit[] = [];
  for (let i = 0; i < importLines.length; i++) {
    const { line } = importLines[i];
    if (i < sorted.length) {
      const indent = lines[line].slice(0, lines[line].length - lines[line].trimStart().length);
      edits.push({
        range: { start: { line, character: 0 }, end: { line, character: lines[line].length } },
        newText: indent + sorted[i],
      });
      continue;
    }
    // A duplicate: the line goes away entirely, newline included.
    edits.push(
      line + 1 < lines.length
        ? { range: { start: { line, character: 0 }, end: { line: line + 1, character: 0 } }, newText: "" }
        : {
            range: {
              start: { line: line - 1, character: lines[line - 1]?.length ?? 0 },
              end: { line, character: lines[line].length },
            },
            newText: "",
          },
    );
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Refactor: extract variable
// ---------------------------------------------------------------------------

/**
 * Extract the selected expression into a local variable.
 * Returns null if the selection is empty or not a valid expression.
 */
export function extractVariable(
  params: CodeActionParams,
  text: string,
): { edits: TextEdit[]; varName: string } | null {
  const range = params.range;
  const validation = validateExtractSelection(range, text);
  if (!validation) return null;

  const { line, lineText, startChar, endChar, selectedText } = validation;

  const varName = generateVarName(selectedText);
  const statementStart = findStatementStart(lineText, startChar);
  const indent = lineText.match(/^\s*/)?.[0] ?? "";

  // Decline rather than emit code the compiler rejects.
  if (!extractionParses(`${declKeyword(selectedText)} ${varName} = ${selectedText};`)) {
    return null;
  }

  const edits: TextEdit[] = [
    {
      range: {
        start: { line, character: statementStart },
        end: { line, character: statementStart },
      },
      newText: `${indent}${declKeyword(selectedText)} ${varName} = ${selectedText};\n`,
    },
    {
      range: {
        start: { line, character: startChar },
        end: { line, character: endChar },
      },
      newText: varName,
    },
  ];

  return { edits, varName };
}

function validateExtractSelection(
  range: { start: { line: number; character: number }; end: { line: number; character: number } },
  text: string,
): { line: number; lineText: string; startChar: number; endChar: number; selectedText: string } | null {
  if (range.start.line !== range.end.line) return null;
  if (range.start.character === range.end.character) return null;

  const line = range.start.line;
  const lines = text.split("\n");
  if (line >= lines.length) return null;

  const lineText = lines[line];
  const startChar = range.start.character;
  const endChar = range.end.character;

  if (endChar > lineText.length) return null;
  const selectedText = lineText.slice(startChar, endChar).trim();
  if (!selectedText) return null;

  if (selectedText.endsWith(";")) return null;
  if (/^[a-zA-Z_]\w*$/.test(selectedText)) return null;

  return { line, lineText, startChar, endChar, selectedText };
}

/**
 * Would the refactoring produce parseable Pike?
 *
 * The textual checks above reject only the obvious shapes, so a selection that
 * is not an expression sailed through: selecting `int x = 1` emitted
 * `mixed extracted = int x = 1;`, and selecting `1, 2` emitted
 * `mixed extracted = 1, 2;`. Both are rejected by the Pike compiler, from a
 * refactoring the user accepted.
 *
 * Rather than enumerate what an expression is not, this parses the declaration
 * that would actually be written. A refactoring that cannot produce parseable
 * code must not be offered at all.
 */
function extractionParses(declarationLine: string): boolean {
  // A declaration is only legal inside a program; wrap it in one.
  const probe = `void __extract_probe() {\n${declarationLine}\n}\n`;
  let tree: Tree | undefined;
  try {
    // No URI: this is a throwaway probe and must not enter the tree cache.
    tree = parse(probe);
    return !tree.rootNode.hasError;
  } catch {
    // A parser that is not up yet must not block the refactoring outright;
    // the textual checks above still apply.
    return true;
  } finally {
    tree?.delete();
  }
}

function findStatementStart(lineText: string, startChar: number): number {
  let statementStart = startChar;
  for (let c = startChar - 1; c >= 0; c--) {
    if (lineText[c] === ";") {
      statementStart = c + 1;
      break;
    }
    if (c === 0) statementStart = 0;
  }
  return statementStart;
}

/**
 * Generate a variable name from an expression.
 * Uses simple heuristics: function calls → call result, member access → member name, etc.
 */
function generateVarName(expr: string): string {
  // function_call(...) → result
  const callMatch = expr.match(/^([a-zA-Z_]\w*)\s*\(/);
  if (callMatch) return `${callMatch[1]}Result`;

  // obj.member → member
  const memberMatch = expr.match(/\.([a-zA-Z_]\w*)$/);
  if (memberMatch) return memberMatch[1];

  // obj->member → member
  const arrowMatch = expr.match(/->([a-zA-Z_]\w*)$/);
  if (arrowMatch) return arrowMatch[1];

  return "extracted";
}

/**
 * Determine declaration keyword based on expression content.
 * Pike uses `string`, `int`, `mixed`, etc. for typed declarations.
 * Use `mixed` as fallback when type is unknown.
 */
function declKeyword(_expr: string): string {
  // For now, always use mixed. Type inference could be added later.
  return "mixed";
}

/** Does `a` start before `b` ends and end after `b` starts? */
function overlaps(a: TextEdit, b: TextEdit): boolean {
  const before = (p: TextEdit["range"]["start"], q: TextEdit["range"]["start"]) =>
    p.line < q.line || (p.line === q.line && p.character <= q.character);
  return before(a.range.start, b.range.end) && before(b.range.start, a.range.end);
}

/**
 * Keep the first of any group of overlapping edits, and drop exact duplicates.
 *
 * Order-independent: edits are considered in document order so the surviving
 * set does not depend on which diagnostic happened to be produced first.
 */
export function withoutOverlaps(edits: TextEdit[]): TextEdit[] {
  const ordered = [...edits].sort(
    (a, b) => a.range.start.line - b.range.start.line ||
      a.range.start.character - b.range.start.character,
  );
  const kept: TextEdit[] = [];
  for (const edit of ordered) {
    if (kept.some(k => overlaps(k, edit))) continue;
    kept.push(edit);
  }
  return kept;
}
