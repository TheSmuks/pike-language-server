/**
 * Missing return lint rule — detects non-void functions with zero return statements.
 *
 * Decision 0028: Part of the fast tree-sitter lint layer. This rule examines
 * function declarations that declare a non-void, non-mixed return type and
 * checks whether the function body contains any return_statement nodes.
 *
 * Pike functions that declare a return type are expected to return a value.
 * A function like `int getAge() { write("oops"); }` would be flagged because
 * it declares `int` return type but never returns anything.
 *
 * Exclusions:
 * - Functions with `void` return type (nothing to return)
 * - Functions with `mixed` return type (may or may not return)
 * - Functions with no declared return type (untyped)
 * - Constructors (`create` method) — Pike constructors return void implicitly
 */

import type { Tree, Node } from "web-tree-sitter";
import type { Diagnostic } from "vscode-languageserver-types";
import { DiagnosticSeverity } from "vscode-languageserver-types";
import type { SymbolTable, Declaration } from "../symbolTable";

/** Diagnostic code for missing return. */
export const CODE_MISSING_RETURN = "P3004";

/** Return types that don't require an explicit return. */
const IMPLICIT_VOID_TYPES = new Set(["void", "mixed"]);

/**
 * Detect functions that declare a non-void return type but have zero
 * return statements in their body.
 *
 * @param tree - tree-sitter parse tree
 * @param table - symbol table with declarations and scopes
 * @returns diagnostics for functions missing return statements
 */
export function detectMissingReturn(
  tree: Tree,
  table: SymbolTable,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  // Walk all function declarations with a declared return type
  for (const decl of table.declarations) {
    if (decl.kind !== "function") continue;
    if (!decl.declaredType) continue;
    if (IMPLICIT_VOID_TYPES.has(decl.declaredType)) continue;

    // Skip constructors
    if (decl.name === "create") continue;

    // Find the function's AST node
    const funcNode = tree.rootNode.descendantForPosition({
      row: decl.range.start.line,
      column: decl.range.start.character,
    });
    if (!funcNode) continue;

    // Walk up to the actual function_definition or function_declaration
    const funcDef = findFunctionDefinition(funcNode, decl);
    if (!funcDef) continue;

    // Check if the function body contains any return_statement
    if (hasReturnStatement(funcDef)) continue;

    // Flag it
    diagnostics.push({
      severity: DiagnosticSeverity.Hint,
      range: decl.nameRange ?? decl.range,
      message: `Function '${decl.name}' declares return type '${decl.declaredType}' but contains no return statement`,
      source: "pike-lint",
      code: CODE_MISSING_RETURN,
    });
  }

  return diagnostics;
}

/**
 * Find the function_definition or function_declaration node for a declaration.
 * The node at the declaration's start position may be an identifier inside
 * the function. Walk up to find the enclosing function node.
 */
function findFunctionDefinition(node: Node, decl: Declaration): Node | null {
  let current: Node | null = node;
  while (current) {
    if (
      current.type === "function_definition" ||
      current.type === "function_declaration" ||
      current.type === "function_decl"
    ) {
      // Verify this function overlaps with the declaration range
      if (
        current.startPosition.row <= decl.range.start.line &&
        current.endPosition.row >= decl.range.end.line
      ) {
        return current;
      }
    }
    current = current.parent;
  }
  return null;
}

/**
 * Check whether a function node contains any return_statement children.
 */
function hasReturnStatement(funcNode: Node): boolean {
  return findReturnStatement(funcNode) !== null;
}

/**
 * Recursively search for a return_statement node within the function body.
 */
function findReturnStatement(node: Node): Node | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;

    if (child.type === "return_statement") {
      return child;
    }

    // Don't descend into nested functions/lambdas — their returns are their own
    if (
      child.type === "function_definition" ||
      child.type === "function_declaration" ||
      child.type === "lambda_expression"
    ) {
      continue;
    }

    const found = findReturnStatement(child);
    if (found) return found;
  }
  return null;
}
