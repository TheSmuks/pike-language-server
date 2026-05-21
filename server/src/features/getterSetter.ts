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
  const tree = parse(text, uri);
  if (!tree) return [];

  const table = buildSymbolTable(tree, uri, 0);
  const varDecl = findVariableAtPosition(table, params.range.start.line, params.range.start.character);
  if (!varDecl) return [];

  const classDecl = findParentClass(table, varDecl);
  if (!classDecl) return [];

  return buildGetterSetterActions(uri, text, table, varDecl, classDecl);
}

// ---------------------------------------------------------------------------
// Internal: action building
// ---------------------------------------------------------------------------

/** Info needed to generate getter/setter actions. */
interface ActionContext {
  varName: string;
  varType: string;
  insertLine: number;
  methodIndent: string;
  existingMethods: Set<string>;
}

/**
 * Resolve the class scope and compute action context needed for code actions.
 */
function resolveActionContext(
  table: SymbolTable,
  text: string,
  varDecl: Declaration,
  classDecl: Declaration,
): ActionContext | null {
  const classScope = table.scopes.find(
    s => s.kind === "class" && containsRange(s.range, classDecl.range),
  );
  if (!classScope) return null;

  const existingMethods = new Set<string>();
  for (const declId of classScope.declarations) {
    const d = table.declarations.find(dd => dd.id === declId);
    if (d && (d.kind === "function" || d.kind === "method")) {
      existingMethods.add(d.name);
    }
  }

  const lines = text.split("\n");
  const classIndent = lines[classDecl.range.start.line]?.match(/^(\s*)/)?.[1] ?? "";
  return {
    varName: varDecl.name,
    varType: varDecl.declaredType || varDecl.assignedType || "mixed",
    insertLine: classDecl.range.end.line,
    methodIndent: classIndent + "  ",
    existingMethods,
  };
}

/**
 * Build a single CodeAction that inserts `body` at the insertion line.
 */
function makeInsertAction(
  title: string,
  uri: string,
  insertLine: number,
  body: string,
): CodeAction {
  return {
    title,
    kind: CodeActionKindRefactorRewrite,
    edit: {
      changes: {
        [uri]: [{
          range: { start: { line: insertLine, character: 0 }, end: { line: insertLine, character: 0 } },
          newText: body,
        }],
      },
    },
  };
}

/**
 * Build getter, setter, and combined code actions for the given variable/class.
 */
function buildGetterSetterActions(
  uri: string,
  text: string,
  table: SymbolTable,
  varDecl: Declaration,
  classDecl: Declaration,
): CodeAction[] {
  const ctx = resolveActionContext(table, text, varDecl, classDecl);
  if (!ctx) return [];

  const { varName, varType, insertLine, methodIndent, existingMethods } = ctx;
  const getterName = `get_${varName}`;
  const setterName = `set_${varName}`;
  const actions: CodeAction[] = [];

  if (!existingMethods.has(getterName)) {
    actions.push(makeInsertAction(
      `Generate getter for ${varName}`, uri, insertLine,
      generateGetter(varName, varType, methodIndent),
    ));
  }

  if (!existingMethods.has(setterName)) {
    actions.push(makeInsertAction(
      `Generate setter for ${varName}`, uri, insertLine,
      generateSetter(varName, varType, methodIndent),
    ));
  }

  if (!existingMethods.has(getterName) && !existingMethods.has(setterName)) {
    const combined = generateGetter(varName, varType, methodIndent) +
      generateSetter(varName, varType, methodIndent);
    actions.push(makeInsertAction(
      `Generate getter and setter for ${varName}`, uri, insertLine, combined,
    ));
  }

  return actions;
}

// ---------------------------------------------------------------------------
// Internal: AST helpers
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

  // Find the class declaration for this scope.
  // Class declarations live in the file scope, class members live in the class scope.
  // The class declaration's range *encloses* the class scope's range (decl starts at
  // "class" keyword, scope starts at the body), so we check d.range contains varScope.range.
  return table.declarations.find(d => d.kind === "class" && containsRange(d.range, varScope.range)) ?? null;
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
