/**
 * Getters/setters generation — code actions for class member variables.
 *
 * When the cursor is on a variable declaration inside a class, offers code
 * actions to generate getter and/or setter methods. In Pike, these are
 * methods on the class:
 *
 *   mixed get_name() { return name; }
 *   void set_name(mixed value) { name = value; }
 *
 * Uses the variable's declared type for the parameter type if available,
 * falls back to `mixed`.
 */

import type { CodeAction, CodeActionParams, TextEdit } from "vscode-languageserver/node";
import { parse, isParserReady } from "../parser";
import { buildSymbolTable, type Declaration, type SymbolTable } from "./symbolTable";
import { CodeActionKindRefactorRewrite } from "../util/codeActionKinds.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface GetterSetterContext {
  /** Known stdlib module names (unused here, kept for API consistency). */
  stdlibModules: Set<string>;
}

/**
 * Produce code actions for generating getters/setters for class variables.
 *
 * Detects if the cursor is on a variable declaration inside a class, then
 * offers "Generate getter for X" and "Generate setter for X" code actions.
 */
export function produceGetterSetterActions(
  params: CodeActionParams,
  text: string,
  _ctx: GetterSetterContext,
): CodeAction[] {
  if (!isParserReady()) return [];

  const uri = params.textDocument.uri;
  const line = params.range.start.line;
  const character = params.range.start.character;

  const tree = parse(text, uri);
  if (!tree) return [];

  const table = buildSymbolTable(tree, uri, 0);

  // Find a variable declaration at the cursor position
  const varDecl = findVariableAtPosition(table, line, character);
  if (!varDecl) return [];

  // Check that the variable is inside a class scope
  const classDecl = findParentClass(table, varDecl);
  if (!classDecl) return [];

  // Check that getter/setter don't already exist
  const className = classDecl.name;
  const varName = varDecl.name;
  const varType = varDecl.declaredType || varDecl.assignedType || "mixed";

  const classScope = table.scopes.find(
    s => s.kind === "class" && containsRange(s.range, classDecl.range),
  );
  if (!classScope) return [];

  const existingMethods = new Set<string>();
  for (const declId of classScope.declarations) {
    const d = table.declarations.find(dd => dd.id === declId);
    if (d && (d.kind === "function" || d.kind === "method")) {
      existingMethods.add(d.name);
    }
  }

  const getterName = `get_${varName}`;
  const setterName = `set_${varName}`;

  const actions: CodeAction[] = [];
  const lines = text.split("\n");

  // Find the end of the class body for insertion
  const insertLine = classDecl.range.end.line;
  const insertChar = classDecl.range.end.character;

  // Indent: match the class body indentation (typically 2 spaces)
  const classIndent = lines[classDecl.range.start.line]?.match(/^(\s*)/)?.[1] ?? "";
  const methodIndent = classIndent + "  ";

  if (!existingMethods.has(getterName)) {
    const getterBody = generateGetter(varName, varType, methodIndent);
    const getterEdit: TextEdit = {
      range: {
        start: { line: insertLine, character: 0 },
        end: { line: insertLine, character: 0 },
      },
      newText: getterBody,
    };

    actions.push({
      title: `Generate getter for ${varName}`,
      kind: CodeActionKindRefactorRewrite,
      edit: {
        changes: { [uri]: [getterEdit] },
      },
    });
  }

  if (!existingMethods.has(setterName)) {
    const setterBody = generateSetter(varName, varType, methodIndent);
    const setterEdit: TextEdit = {
      range: {
        start: { line: insertLine, character: 0 },
        end: { line: insertLine, character: 0 },
      },
      newText: setterBody,
    };

    actions.push({
      title: `Generate setter for ${varName}`,
      kind: CodeActionKindRefactorRewrite,
      edit: {
        changes: { [uri]: [setterEdit] },
      },
    });
  }

  // Offer combined getter+setter action if both are available
  if (!existingMethods.has(getterName) && !existingMethods.has(setterName)) {
    const combinedBody = generateGetter(varName, varType, methodIndent) +
      generateSetter(varName, varType, methodIndent);
    const combinedEdit: TextEdit = {
      range: {
        start: { line: insertLine, character: 0 },
        end: { line: insertLine, character: 0 },
      },
      newText: combinedBody,
    };

    actions.push({
      title: `Generate getter and setter for ${varName}`,
      kind: CodeActionKindRefactorRewrite,
      edit: {
        changes: { [uri]: [combinedEdit] },
      },
    });
  }

  return actions;
}

// ---------------------------------------------------------------------------
// Internal: helpers
// ---------------------------------------------------------------------------

function findVariableAtPosition(
  table: SymbolTable,
  line: number,
  character: number,
): Declaration | null {
  for (const decl of table.declarations) {
    if (decl.kind !== "variable") continue;
    if (decl.nameRange.start.line === line &&
        decl.nameRange.start.character <= character &&
        decl.nameRange.end.character >= character) {
      return decl;
    }
    // Also match by range
    if (decl.range.start.line === line &&
        decl.range.end.line === line &&
        decl.range.start.character <= character &&
        decl.range.end.character >= character) {
      return decl;
    }
  }
  return null;
}

function findParentClass(table: SymbolTable, varDecl: Declaration): Declaration | null {
  // Find the class scope that contains this variable
  const varScope = table.scopes.find(s => s.kind === "class" && containsRange(s.range, varDecl.range));
  if (!varScope) return null;

  // Find the class declaration for this scope
  // Class declarations live in the file scope, class members live in the class scope
  return table.declarations.find(d => d.kind === "class" && containsRange(varScope.range, d.range)) ?? null;
}

function generateGetter(varName: string, varType: string, indent: string): string {
  return `${indent}${varType} get_${varName}() {\n${indent}  return ${varName};\n${indent}}\n`;
}

function generateSetter(varName: string, varType: string, indent: string): string {
  return `${indent}void set_${varName}(${varType} value) {\n${indent}  ${varName} = value;\n${indent}}\n`;
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
