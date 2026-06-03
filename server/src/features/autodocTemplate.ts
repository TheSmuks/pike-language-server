/**
 * Autodoc template generator — replaces `//!!` trigger with autodoc skeleton.
 *
 * When the user types `//!!` on a line immediately above a function, method,
 * class, or variable declaration, a code action replaces it with a //! autodoc
 * skeleton populated from the declaration's signature.
 *
 * This is a refactoring-style code action, not a diagnostic quick-fix. It
 * triggers on the text pattern `//!!`, not on a diagnostic.
 */

import type { CodeAction, CodeActionParams, TextEdit } from "vscode-languageserver/node";
import { parse, isParserReady } from "../parser";
import { buildSymbolTable, type Declaration, type SymbolTable } from "./symbolTable";
import { CodeActionKindRefactorRewrite } from "../util/codeActionKinds.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Produce code actions that replace `//!!` lines with autodoc skeletons.
 *
 * Scans the requested range for lines that are exactly `//!!` (possibly with
 * leading whitespace). For each, parses the next line as a declaration and
 * generates a //! autodoc template.
 */
export function produceAutodocTemplateActions(
  params: CodeActionParams,
  text: string,
): CodeAction[] {
  if (!isParserReady()) return [];

  const uri = params.textDocument.uri;
  const startLine = params.range.start.line;
  const endLine = params.range.end.line;
  const lines = text.split("\n");

  const tree = parse(text, uri);
  if (!tree) return [];

  const table = buildSymbolTable(tree, uri, 0, undefined, text);

  const actions: CodeAction[] = [];

  for (let lineIdx = startLine; lineIdx <= Math.min(endLine, lines.length - 1); lineIdx++) {
    const action = tryBuildAutodocAction(lines, lineIdx, table, uri);
    if (action) actions.push(action);
  }

  return actions;
}

function tryBuildAutodocAction(
  lines: string[],
  lineIdx: number,
  table: SymbolTable,
  uri: string,
): CodeAction | null {
  const line = lines[lineIdx].trim();
  if (line !== "//!!") return null;
  if (lineIdx + 1 >= lines.length) return null;

  const decl = findDeclarationAtLine(table, lineIdx + 1);
  if (!decl) return null;

  const template = buildAutodocTemplate(decl, table, lines[lineIdx]);
  if (!template) return null;

  const edit: TextEdit = {
    range: {
      start: { line: lineIdx, character: 0 },
      end: { line: lineIdx, character: lines[lineIdx].length },
    },
    newText: template,
  };

  return {
    title: `Generate autodoc for ${decl.kind} "${decl.name}"`,
    kind: CodeActionKindRefactorRewrite,
    edit: { changes: { [uri]: [edit] } },
  };
}

// ---------------------------------------------------------------------------
// Internal: declaration detection
// ---------------------------------------------------------------------------

/**
 * Find the declaration starting at or near the given line.
 */
function findDeclarationAtLine(table: SymbolTable, line: number): Declaration | null {
  for (const decl of table.declarations) {
    if (decl.range.start.line === line) {
      if (decl.kind === "function" || decl.kind === "method" || decl.kind === "class" || decl.kind === "variable") {
        return decl;
      }
    }
  }
  return null;
}

// -----------------------------------------------------------------------
// Internal: template generation
// -----------------------------------------------------------------------

function buildAutodocTemplate(decl: Declaration, table: SymbolTable, triggerLine: string): string | null {
  const indent = triggerLine.match(/^(\s*)/)?.[1] ?? "";
  const prefix = `${indent}//! `;

  switch (decl.kind) {
    case "function":
    case "method":
      return generateFunctionTemplate(decl, table, prefix);
    case "class":
    case "variable":
      return `${prefix}${decl.name} — description.\n${prefix}`;
    default:
      return null;
  }
}

function generateFunctionTemplate(decl: Declaration, table: SymbolTable, prefix: string): string {
  const lines: string[] = [`${prefix}${decl.name} — description.`];
  appendParamLines(lines, decl, table, prefix);
  if (decl.declaredType && decl.declaredType !== "void") {
    lines.push(`${prefix}@returns`, `${prefix}Description.`);
  }
  return lines.join("\n");
}

function appendParamLines(lines: string[], decl: Declaration, table: SymbolTable, prefix: string): void {
  const funcScope = table.scopes.find(
    s => (s.kind === "function" || s.kind === "block") && containsRange(s.range, decl.range),
  );
  if (!funcScope) return;
  for (const param of table.declarations.filter(d => d.kind === "parameter" && d.scopeId === funcScope.id)) {
    lines.push(`${prefix}@param ${param.name}`, `${prefix}Description.`);
  }
}

function containsRange(
  a: { start: { line: number; character: number }; end: { line: number; character: number } },
  b: { start: { line: number; character: number }; end: { line: number; character: number } },
): boolean {
  if (b.start.line < a.start.line || b.end.line > a.end.line) return false;
  if (b.start.line === a.start.line && b.start.character < a.start.character) return false;
  if (b.end.line === a.end.line && b.end.character > a.end.character) return false;
  return true;
}
