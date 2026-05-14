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

  const table = buildSymbolTable(tree, uri, 0);

  const actions: CodeAction[] = [];

  for (let lineIdx = startLine; lineIdx <= Math.min(endLine, lines.length - 1); lineIdx++) {
    const line = lines[lineIdx].trim();

    // Match the //!! trigger — exact match, possibly with trailing whitespace
    if (line !== "//!!") continue;

    // Look at the next line for a declaration
    if (lineIdx + 1 >= lines.length) continue;
    const nextLineNum = lineIdx + 1;

    const decl = findDeclarationAtLine(table, nextLineNum);
    if (!decl) continue;

    const indent = lines[lineIdx].match(/^(\s*)/)?.[1] ?? "";
    const template = generateAutodocTemplate(decl, table, indent);
    if (!template) continue;

    // Replace the //!! line with the template
    const edit: TextEdit = {
      range: {
        start: { line: lineIdx, character: 0 },
        end: { line: lineIdx, character: lines[lineIdx].length },
      },
      newText: template,
    };

    actions.push({
      title: `Generate autodoc for ${decl.kind} "${decl.name}"`,
      kind: "refactor.rewrite" as any,
      edit: {
        changes: {
          [uri]: [edit],
        },
      },
    });
  }

  return actions;
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

// ---------------------------------------------------------------------------
// Internal: template generation
// ---------------------------------------------------------------------------

/**
 * Generate a //! autodoc template for a declaration.
 */
function generateAutodocTemplate(decl: Declaration, table: SymbolTable, indent: string): string | null {
  const prefix = `${indent}//! `;

  switch (decl.kind) {
    case "function":
    case "method":
      return generateFunctionTemplate(decl, table, prefix);
    case "class":
      return `${prefix}${decl.name} — description.\n${prefix}`;
    case "variable":
      return `${prefix}${decl.name} — description.\n${prefix}`;
    default:
      return null;
  }
}

/**
 * Generate autodoc template for a function or method declaration.
 *
 * Finds parameters by looking for `parameter` declarations in the same scope
 * as the function, then generates @param and @returns sections.
 */
function generateFunctionTemplate(decl: Declaration, table: SymbolTable, prefix: string): string {
  const lines: string[] = [];

  // Brief description
  lines.push(`${prefix}${decl.name} — description.`);

  // Find parameters: they are declarations with kind="parameter" whose scopeId
  // matches a scope whose parent declaration is this function.
  // Parameters live in the function's inner scope, which has this decl's
  // ID as the sole declaration... actually, parameters have scopeId pointing
  // to the function's inner scope. Find that scope.
  const funcScope = table.scopes.find(
    s => (s.kind === "function" || s.kind === "block")
      && containsRange(s.range, decl.range),
  );

  if (funcScope) {
    const params = table.declarations.filter(
      d => d.kind === "parameter" && d.scopeId === funcScope.id,
    );

    for (const param of params) {
      lines.push(`${prefix}@param ${param.name}`);
      lines.push(`${prefix}Description.`);
    }
  }

  // Returns section — only for non-void functions
  if (decl.declaredType && decl.declaredType !== "void") {
    lines.push(`${prefix}@returns`);
    lines.push(`${prefix}Description.`);
  }

  return lines.join("\n");
}

/**
 * Check if range b is contained within range a.
 */
function containsRange(a: { start: { line: number; character: number }; end: { line: number; character: number } }, b: { start: { line: number; character: number }; end: { line: number; character: number } }): boolean {
  if (b.start.line < a.start.line || b.end.line > a.end.line) return false;
  if (b.start.line === a.start.line && b.start.character < a.start.character) return false;
  if (b.end.line === a.end.line && b.end.character > a.end.character) return false;
  return true;
}
