/**
 * Inlay hints — shows inferred types inline for variable declarations.
 *
 * Type hints (G1): For variables declared without an explicit type annotation,
 * the inlay hint displays the assigned type as a quiet label after the name:
 *
 *   string name = "Rex";      // already typed — no hint
 *   name = "Rex";             // hint: name: string
 *
 * Parameter name hints (G2): At call sites, shows the corresponding parameter
 * name before each argument:
 *
 *   create("Rex", 5);         // shows: create(name: "Rex", age: 5);
 *
 * Requires tree-sitter-pike v1.2.2+ for proper argument_list nodes.
 *
 * Decision 0028: Part of the intelligent LSP features plan (Phase G).
 */

import type { Tree, Node } from "web-tree-sitter";
import type { SymbolTable, Declaration } from "./symbolTable";
import type { Position } from "vscode-languageserver-types";
import { InlayHint, InlayHintKind } from "vscode-languageserver-types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InlayHintContext {
  tree: Tree;
  table: SymbolTable;
  /** Range to provide hints for. */
  range: { start: Position; end: Position };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Produce inlay hints for a range of source code.
 *
 * Provides:
 * - G1: Type hints for untyped variable declarations
 * - G2: Parameter name hints at call sites
 *
 * @param ctx - context with parse tree, symbol table, and range
 * @returns array of InlayHint objects
 */
export function produceInlayHints(ctx: InlayHintContext): InlayHint[] {
  const hints: InlayHint[] = [];
  const { tree, table, range } = ctx;

  const rangeStartLine = range.start.line;
  const rangeEndLine = range.end.line;

  // G1: Type hints for untyped variable declarations
  for (const decl of table.declarations) {
    if (decl.kind !== "variable" && decl.kind !== "parameter") continue;
    if (decl.range.start.line < rangeStartLine || decl.range.start.line > rangeEndLine) continue;

    const typeName = resolveTypeForHint(decl);
    if (!typeName) continue;

    if (decl.declaredType) continue;

    const nameEnd = decl.nameRange?.end ?? decl.range.end;
    hints.push(
      InlayHint.create(
        { line: nameEnd.line, character: nameEnd.character },
        `: ${typeName}`,
        InlayHintKind.Type,
      ),
    );
  }

  // G2: Parameter name hints at call sites
  collectParameterHints(tree.rootNode, table, rangeStartLine, rangeEndLine, hints);

  return hints;
}

// ---------------------------------------------------------------------------
// G1: Type hints helpers
// ---------------------------------------------------------------------------

/** Primitive types that are obvious enough to skip hints for. */
const OBVIOUS_TYPES = new Set(["mixed", "unknown"]);

function resolveTypeForHint(decl: Declaration): string | null {
  if (decl.declaredType) return null;
  if (decl.assignedType && !OBVIOUS_TYPES.has(decl.assignedType)) {
    return decl.assignedType;
  }
  return null;
}

// ---------------------------------------------------------------------------
// G2: Parameter name hints at call sites
// ---------------------------------------------------------------------------

/**
 * Walk the tree looking for argument_list nodes and produce parameter name
 * hints for each argument.
 */
function collectParameterHints(
  node: Node,
  table: SymbolTable,
  rangeStartLine: number,
  rangeEndLine: number,
  hints: InlayHint[],
): void {
  // Only recurse into nodes within the requested range.
  if (node.endPosition.row < rangeStartLine || node.startPosition.row > rangeEndLine) {
    return;
  }

  if (node.type === "argument_list") {
    const paramHints = hintsForCallSite(node, table);
    for (const h of paramHints) {
      if (h.position.line >= rangeStartLine && h.position.line <= rangeEndLine) {
        hints.push(h);
      }
    }
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) {
      collectParameterHints(child, table, rangeStartLine, rangeEndLine, hints);
    }
  }
}

/**
 * Given an argument_list node, find the callee name, resolve its declaration,
 * extract parameter names, and produce inlay hints.
 */
function hintsForCallSite(argListNode: Node, table: SymbolTable): InlayHint[] {
  const hints: InlayHint[] = [];

  // Find the callee name by looking at the parent postfix_expr.
  // Structure: postfix_expr <callee> ( argument_list )
  const parent = argListNode.parent;
  if (!parent || parent.type !== "postfix_expr") return hints;

  const calleeName = extractCalleeName(parent);
  if (!calleeName) return hints;

  // Resolve the callee to its declaration.
  const calleeDecl = findCalleeDeclaration(calleeName, argListNode, table);
  if (!calleeDecl) return hints;

  // Extract parameter names from the declaration's function definition.
  const paramNames = extractParameterNames(calleeDecl, table);
  if (paramNames.length === 0) return hints;

  // Collect arguments from the argument_list.
  const args = collectArguments(argListNode);

  // Emit one hint per argument that has a matching parameter name.
  for (let i = 0; i < args.length && i < paramNames.length; i++) {
    const paramName = paramNames[i];
    if (!paramName) continue;

    const argNode = args[i];
    hints.push(
      InlayHint.create(
        { line: argNode.startPosition.row, character: argNode.startPosition.column },
        `${paramName}: `,
        InlayHintKind.Parameter,
      ),
    );
  }

  return hints;
}

/**
 * Extract the callee name from a postfix_expr node.
 *
 * Handles:
 * - Simple function call: postfix_expr(postfix_expr("foo"), args) → "foo"
 * - Method call: postfix_expr(postfix_expr("obj", "->", "method"), args) → "method"
 */
function extractCalleeName(postfixExpr: Node): string | null {
  const children = postfixExpr.children;
  // The callee is the first child if it's an identifier postfix_expr,
  // or the identifier after -> if it's a method call.
  const callee = children[0];
  if (!callee) return null;

  // If the callee is itself a postfix_expr (common case), drill into it.
  if (callee.type === "postfix_expr") {
    const calleeChildren = callee.children;
    // Method call: postfix_expr(postfix_expr, "->", identifier)
    // The identifier after -> is the method name.
    for (let i = 0; i < calleeChildren.length; i++) {
      if ((calleeChildren[i].type === "->" || calleeChildren[i].type === "->?"
           || calleeChildren[i].type === "?->")
          && i + 1 < calleeChildren.length
          && calleeChildren[i + 1].type === "identifier") {
        return calleeChildren[i + 1].text;
      }
    }
    // Not a method call — drill for the base identifier.
    return extractCalleeName(callee);
  }

  // primary_expr wrapping an identifier.
  if (callee.type === "primary_expr") {
    const inner = callee.child(0);
    if (inner) {
      if (inner.type === "identifier_expr") {
        const nameNode = inner.childForFieldName("name");
        return nameNode?.text ?? inner.text;
      }
      return inner.text;
    }
  }

  // Direct identifier (less common but possible).
  if (callee.type === "identifier" || callee.type === "identifier_expr") {
    if (callee.type === "identifier_expr") {
      const nameNode = callee.childForFieldName("name");
      return nameNode?.text ?? callee.text;
    }
    return callee.text;
  }

  return null;
}

/**
 * Find the declaration for the callee at a call site.
 *
 * For simple function calls: look up the reference → declaration.
 * For method calls (obj->method): resolve the LHS variable's declared type
 * to a class scope, then find the method in that scope.
 */
function findCalleeDeclaration(
  calleeName: string,
  argListNode: Node,
  table: SymbolTable,
): Declaration | null {
  // 1. Try resolved references first.
  for (const ref of table.references) {
    if (ref.name === calleeName && ref.resolvesTo !== null) {
      const decl = table.declById.get(ref.resolvesTo);
      if (decl && (decl.kind === "function" || decl.kind === "method")) {
        return decl;
      }
    }
  }

  // 2. For arrow/dot access, resolve via LHS type → class scope → method.
  const lhsName = extractLhsName(argListNode, table);
  if (lhsName) {
    const methodDecl = resolveMethodFromLhs(lhsName, calleeName, table);
    if (methodDecl) return methodDecl;
  }

  // 3. Fallback: search declarations for matching function/method name.
  for (const decl of table.declarations) {
    if (decl.name === calleeName && (decl.kind === "function" || decl.kind === "method")) {
      return decl;
    }
  }

  return null;
}

/**
 * Extract the LHS identifier name from an arrow/dot method call.
 *
 * Looks for an arrow_access reference at the call site whose name
 * matches the callee, then returns its lhsName field.
 */
function extractLhsName(argListNode: Node, table: SymbolTable): string | null {
  const parent = argListNode.parent;
  if (!parent) return null;

  // Find an arrow_access or dot_access reference for the callee.
  const calleeName = extractCalleeName(parent);
  if (!calleeName) return null;

  for (const ref of table.references) {
    if (ref.name === calleeName
        && (ref.kind === "arrow_access" || ref.kind === "dot_access")
        && ref.lhsName) {
      return ref.lhsName;
    }
  }
  return null;
}

/**
 * Resolve a method call: LHS variable → declared type → class → method.
 *
 * Same-file only. Uses range-overlap to find the class scope (see memory:
 * class declarations live in FILE scope, class MEMBERS live in CLASS scope).
 */
function resolveMethodFromLhs(
  lhsName: string,
  methodName: string,
  table: SymbolTable,
): Declaration | null {
  // Find the LHS variable/parameter declaration.
  const lhsDecl = table.declarations.find(
    d => (d.kind === "variable" || d.kind === "parameter") && d.name === lhsName,
  );
  if (!lhsDecl) return null;

  // Get the declared type.
  const typeName = lhsDecl.declaredType;
  if (!typeName) return null;

  // Find the class declaration with that name.
  const classDecl = table.declarations.find(
    d => d.kind === "class" && d.name === typeName,
  );
  if (!classDecl) return null;

  // Find the class scope by range overlap (not by declaration ID membership).
  const classScope = table.scopes.find(
    s => s.kind === "class" && containsRangeSimple(classDecl.range, s.range),
  );
  if (!classScope) return null;

  // Find the method in the class scope.
  for (const declId of classScope.declarations) {
    const decl = table.declById.get(declId);
    if (decl && decl.name === methodName && (decl.kind === "function" || decl.kind === "method")) {
      return decl;
    }
  }

  return null;
}

/** Check if `inner` range is within `outer` range. */
function containsRangeSimple(
  outer: { start: { line: number; character: number }; end: { line: number; character: number } },
  inner: { start: { line: number; character: number }; end: { line: number; character: number } },
): boolean {
  if (inner.start.line < outer.start.line || inner.end.line > outer.end.line) return false;
  if (inner.start.line === outer.start.line && inner.start.character < outer.start.character) return false;
  if (inner.end.line === outer.end.line && inner.end.character > outer.end.character) return false;
  return true;
}

/**
 * Extract parameter names from a function/method declaration.
 *
 * Uses the symbol table's scope structure: parameters are declarations
 * with kind "parameter" inside the function's scope.
 */
function extractParameterNames(decl: Declaration, table: SymbolTable): string[] {
  // Find the scope that contains the parameters.
  // For functions, parameters live in the function's own scope.
  // The function declaration's scopeId points to the enclosing scope,
  // but parameters are in a child scope of the function.
  //
  // Alternative: search for the function's parameters node in the parse tree.
  // We use the declaration's range to find it.
  const paramNames: string[] = [];

  // Look for parameter declarations in scopes whose parent contains this decl.
  // Actually, the simplest approach: parameters with scopeId equal to any
  // scope that overlaps with this function's range.
  for (const scope of table.scopes) {
    // Check if this scope is a child of the function's scope and
    // its range is within the function's declaration range.
    if (scope.kind === "function" || scope.kind === "block") {
      const scopeRange = scope.range;
      const declStart = decl.range.start;
      const declEnd = decl.range.end;

      // Check if scope is within the function declaration.
      if (scopeRange.start.line >= declStart.line
          && scopeRange.end.line <= declEnd.line) {
        const declsInScope = table.declarations.filter(
          d => d.scopeId === scope.id && d.kind === "parameter",
        );
        if (declsInScope.length > 0) {
          // Sort by position to maintain order.
          declsInScope.sort((a, b) => {
            if (a.nameRange.start.line !== b.nameRange.start.line) {
              return a.nameRange.start.line - b.nameRange.start.line;
            }
            return a.nameRange.start.character - b.nameRange.start.character;
          });
          for (const pd of declsInScope) {
            paramNames.push(pd.name);
          }
          return paramNames;
        }
      }
    }
  }

  return paramNames;
}

/**
 * Collect the argument nodes from an argument_list.
 *
 * Tree-sitter wraps multiple arguments in a single `comma_expr` node:
 *   argument_list(comma_expr(arg1, ",", arg2))
 * For a single argument:
 *   argument_list(expr)
 *
 * We need to split comma_expr into individual arguments.
 */
function collectArguments(argListNode: Node): Node[] {
  const args: Node[] = [];
  for (let i = 0; i < argListNode.childCount; i++) {
    const child = argListNode.child(i);
    if (!child) continue;
    // Skip punctuation (parentheses, commas).
    if (child.type === "(" || child.type === ")" || child.type === ",") continue;
    // Unwrap top-level comma_expr into individual arguments.
    if (child.type === "comma_expr") {
      flattenCommaExpr(child, args);
    } else {
      args.push(child);
    }
  }
  return args;
}

/**
 * Recursively flatten a comma_expr into individual argument nodes.
 *
 * comma_expr is left-recursive:
 *   comma_expr(comma_expr(a, ",", b), ",", c)
 *
 * So we collect the left operand and the right operand, skipping commas.
 */
function flattenCommaExpr(node: Node, out: Node[]): void {
  if (node.type !== "comma_expr") {
    out.push(node);
    return;
  }
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === ",") continue;
    if (child.type === "comma_expr") {
      flattenCommaExpr(child, out);
    } else {
      out.push(child);
    }
  }
}
