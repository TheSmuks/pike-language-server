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

  // Replace the import block
  const edits: TextEdit[] = [
    {
      range: {
        start: { line: firstImport, character: 0 },
        end: { line: lastImport + 1, character: 0 },
      },
      newText: sorted.join("\n") + "\n",
    },
  ];

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
