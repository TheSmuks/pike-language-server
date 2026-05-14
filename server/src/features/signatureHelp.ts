/**
 * SignatureHelp — provides function/method/constructor signatures.
 *
 * Resolution chain:
 * 1. Local function/method declaration (same file)
 * 2. Class constructor (ClassName → create method)
 * 3. Method on resolved type (obj->method → resolve obj's type → find method)
 * 4. Stdlib function/class
 */

import type { Tree, Node } from "web-tree-sitter";
import type { SymbolTable, Declaration } from "./symbolTable";
import { findClassScope } from "./typeResolver";
import { resolveTypeName } from "./symbolTable";
import { containsRange } from "./scopeBuilder";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SignatureInfo {
  label: string;
  documentation?: string;
  parameters: ParameterInfo[];
}

export interface ParameterInfo {
  label: string;
  documentation?: string;
}

export interface SignatureHelpResult {
  signatures: SignatureInfo[];
  activeSignature: number;
  activeParameter: number;
}

/** Extended context for type-aware signature resolution. */
export interface SignatureContext {
  table: SymbolTable;
  uri: string;
  index: import("./workspaceIndex").WorkspaceIndex;
  stdlibIndex?: Record<string, { signature: string; markdown: string }>;
  typeInferrer?: (varName: string) => Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Produce signature help for a position in the source.
 *
 * @param tree - tree-sitter parse tree
 * @param table - symbol table for the file
 * @param line - cursor line (0-based)
 * @param character - cursor character (0-based)
 * @param stdlibIndex - optional stdlib autodoc index
 * @param ctx - optional full resolution context for type-aware method resolution
 */
export function produceSignatureHelp(
  tree: Tree,
  table: SymbolTable,
  line: number,
  character: number,
  stdlibIndex?: Record<string, { signature: string; markdown: string }>,
  ctx?: SignatureContext,
): SignatureHelpResult | null {
  // Find the node at the cursor
  const node = tree.rootNode.descendantForPosition({ row: line, column: character });
  if (!node) return null;

  // Walk up to find enclosing call expression
  const callExpr = findEnclosingCall(node, line, character);
  if (!callExpr) return null;

  // Get callee name, object name, and argument list
  const calleeInfo = extractCalleeInfo(callExpr);
  if (!calleeInfo) return null;

  const { calleeName, objectName, argsNode } = calleeInfo;

  // Count active parameter (commas before cursor)
  const activeParam = countActiveParameter(argsNode, line, character);

  // Try to resolve to a local/workspace function
  const sig = resolveSignature(calleeName, objectName, table, stdlibIndex, ctx);
  if (!sig) return null;

  return {
    signatures: [sig],
    activeSignature: 0,
    activeParameter: activeParam,
  };
}

// ---------------------------------------------------------------------------
// Call expression detection
// ---------------------------------------------------------------------------

/**
 * Walk up from the cursor node to find an enclosing call expression.
 *
 * In tree-sitter-pike, calls are represented as postfix_expr nodes
 * where child 0 is the callee and there are parenthesized arguments.
 */
function findEnclosingCall(node: Node, line?: number, character?: number): Node | null {
  let current: Node | null = node;
  while (current) {
    if (current.type === "postfix_expr") {
      const children = current.children;
      let openParen: Node | null = null;
      let closeParen: Node | null = null;
      for (let i = 1; i < children.length; i++) {
        if (children[i].type === "(" && !openParen) {
          openParen = children[i];
        }
        if (children[i].type === ")") {
          closeParen = children[i];
        }
      }
      if (!openParen || !closeParen) {
        current = current.parent;
        continue;
      }
      if (line !== undefined && character !== undefined) {
        const openStart = openParen.startPosition;
        const closeStart = closeParen.startPosition;
        const cursorBeforeOpen =
          line < openStart.row || (line === openStart.row && character < openStart.column);
        const cursorAtOrAfterClose =
          line > closeStart.row || (line === closeStart.row && character >= closeStart.column);
        if (cursorBeforeOpen || cursorAtOrAfterClose) {
          current = current.parent;
          continue;
        }
      }
      return current;
    }
    current = current.parent;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Callee extraction
// ---------------------------------------------------------------------------

interface CalleeInfo {
  calleeName: string;
  /** For method calls (obj->method): the object identifier name. */
  objectName: string | null;
  argsNode: Node;
}

/**
 * Extract the callee name, optional object name, and argument list node.
 *
 * Examples:
 * - `add(1, 2)` → calleeName='add', objectName=null
 * - `d->speak("hello")` → calleeName='speak', objectName='d'
 * - `Module.func()` → calleeName='func', objectName='Module'
 * - `Dog("Rex")` → calleeName='Dog', objectName=null (constructor)
 */
function extractCalleeInfo(callExpr: Node): CalleeInfo | null {
  const children = callExpr.children;
  // Find the callee (first named child or first child before '(')
  let calleeNode: Node | null = null;
  let openParen: Node | null = null;

  for (let i = 0; i < children.length; i++) {
    if (children[i].type === "(") {
      openParen = children[i];
      // Callee is the first child before '('
      calleeNode = children[0];
      break;
    }
  }

  if (!calleeNode || !openParen) return null;

  // Extract the function/method name and object name.
  let name = calleeNode.text;
  let objectName: string | null = null;

  const arrowIdx = name.lastIndexOf("->");
  if (arrowIdx !== -1) {
    // obj->method: object is everything before ->, method is after
    objectName = name.slice(0, arrowIdx);
    name = name.slice(arrowIdx + 2);
  }
  const dotIdx = name.lastIndexOf(".");
  if (dotIdx !== -1) {
    // Module.func: object is everything before ., method is after
    objectName = name.slice(0, dotIdx);
    name = name.slice(dotIdx + 1);
  }

  // For object names like "this" or nested expressions, extract just the
  // trailing identifier to use for type resolution.
  if (objectName) {
    // Handle chained calls: extract the first identifier for type lookup.
    // E.g., "getContainer()->getItem" → objectName = "getContainer()"
    // For now, take the first identifier segment.
    const firstArrow = objectName.indexOf("->");
    const firstDot = objectName.indexOf(".");
    if (firstArrow !== -1 || firstDot !== -1) {
      // Chained call — extract the first identifier
      const cutAt = firstArrow !== -1 && firstDot !== -1
        ? Math.min(firstArrow, firstDot)
        : firstArrow !== -1 ? firstArrow : firstDot;
      objectName = objectName.slice(0, cutAt);
    }
  }

  return {
    calleeName: name,
    objectName,
    argsNode: openParen,
  };
}

// ---------------------------------------------------------------------------
// Active parameter tracking
// ---------------------------------------------------------------------------

/**
 * Count the number of commas before the cursor position inside the argument list.
 * This determines the active parameter index.
 */
function countActiveParameter(openParen: Node, line: number, character: number): number {
  const callExpr = openParen.parent;
  if (!callExpr) return 0;

  const children = callExpr.children;
  let insideArgs = false;
  let commaCount = 0;

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.type === "(") {
      insideArgs = true;
      continue;
    }
    if (child.type === ")") {
      break;
    }
    if (insideArgs) {
      // Arguments may be wrapped in an argument_list node
      if (child.type === "argument_list") {
        commaCount = countCommasInNode(child, line, character);
      } else if (child.type === ",") {
        const commaPos = child.startPosition;
        if (commaPos.row < line || (commaPos.row === line && commaPos.column < character)) {
          commaCount++;
        }
      }
    }
  }

  return commaCount;
}

// ---------------------------------------------------------------------------
// Signature resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a callee name to a signature.
 *
 * Resolution order:
 * 1. Local function/method declaration
 * 2. Method on resolved type (if objectName is provided)
 * 3. Class constructor (ClassName → create method)
 * 4. Stdlib
 */
function resolveSignature(
  calleeName: string,
  objectName: string | null,
  table: SymbolTable,
  stdlibIndex?: Record<string, { signature: string; markdown: string }>,
  ctx?: SignatureContext,
): SignatureInfo | null {
  // 1. Try local function/method declaration
  const funcDecl = table.declarations.find(
    d => d.name === calleeName && d.kind === "function",
  );

  if (funcDecl) {
    return buildSignatureFromDecl(funcDecl, table);
  }

  // 2. Method on resolved type: obj->method(
  //    Resolve obj's type, find method in that type's class scope.
  if (objectName && ctx) {
    const methodSig = resolveMethodOnType(objectName, calleeName, table, ctx);
    if (methodSig) return methodSig;
  }

  // 3. Constructor: ClassName(
  //    Look for a class named calleeName, then find its create method.
  const classDecl = table.declarations.find(
    d => d.name === calleeName && d.kind === "class",
  );
  if (classDecl) {
    const constructorSig = resolveConstructor(classDecl, table, ctx);
    if (constructorSig) return constructorSig;
  }

  // 4. Stdlib
  if (stdlibIndex) {
    const entry = stdlibIndex[`predef.${calleeName}`];
    if (entry) {
      return buildSignatureFromStdlib(calleeName, entry);
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Method resolution on type
// ---------------------------------------------------------------------------

/**
 * Resolve a method on an object's type.
 *
 * Given `obj->method(`, resolve `obj`'s declared type, find the class
 * declaration for that type, and look up `method` in its class scope.
 */
function resolveMethodOnType(
  objectName: string,
  methodName: string,
  table: SymbolTable,
  ctx: SignatureContext,
): SignatureInfo | null {
  // Find the object's declaration
  const objDecl = findDeclarationForName(table, objectName);
  if (!objDecl) return null;

  // Resolve the object's type name
  const typeName = resolveTypeName(objDecl);
  if (!typeName) return null;

  // Resolve the type to a class declaration
  const typeResult = resolveTypeSync(typeName, table, ctx);
  if (!typeResult) return null;

  // Find the method in the class scope
  const classScope = typeResult.table.scopes.find(
    s => s.kind === "class" && s.declarations.includes(typeResult.decl.id),
  );
  if (!classScope) return null;

  // Look for the method in the class scope (and inherited scopes)
  const methodDecl = findMethodInClassScope(typeResult.table, classScope, methodName);
  if (!methodDecl) return null;

  return buildSignatureFromDecl(methodDecl, typeResult.table);
}

/** Synchronous type resolution — checks same-file and cross-file index. */
function resolveTypeSync(
  typeName: string,
  table: SymbolTable,
  ctx: SignatureContext,
): { decl: Declaration; table: SymbolTable } | null {
  // Same-file: find a class declaration with this name
  const classDecl = table.declarations.find(
    d => d.name === typeName && d.kind === "class",
  );
  if (classDecl) {
    return { decl: classDecl, table };
  }

  // Cross-file: look up in workspace index
  if (ctx.index) {
    const uris = ctx.index.getAllUris();
    for (const uri of uris) {
      const targetTable = ctx.index.getSymbolTable(uri);
      if (!targetTable) continue;
      const targetDecl = targetTable.declarations.find(
        d => d.name === typeName && d.kind === "class",
      );
      if (targetDecl) {
        return { decl: targetDecl, table: targetTable };
      }
    }
  }

  return null;
}

/** Find a method declaration in a class scope or its inherited scopes. */
function findMethodInClassScope(
  table: SymbolTable,
  classScope: import("./symbolTable").Scope,
  methodName: string,
): Declaration | null {
  // Direct members
  for (const declId of classScope.declarations) {
    const decl = table.declById.get(declId);
    if (decl && decl.name === methodName && (decl.kind === "function" || decl.kind === "method")) {
      return decl;
    }
  }

  // Inherited scopes
  for (const inheritedScopeId of classScope.inheritedScopes) {
    const inheritedScope = table.scopeById.get(inheritedScopeId);
    if (!inheritedScope) continue;
    const found = findMethodInClassScope(table, inheritedScope, methodName);
    if (found) return found;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Constructor resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a constructor for a class declaration.
 *
 * Looks for a `create` method in the class scope. Also checks cross-file
 * classes via the workspace index.
 */
function resolveConstructor(
  classDecl: Declaration,
  table: SymbolTable,
  ctx?: SignatureContext,
): SignatureInfo | null {
  // Find the class scope by range overlap (the class decl is in the file
  // scope, not the class scope — the class scope contains the members).
  const classScope = table.scopes.find(
    s => s.kind === "class" && containsRange(s.range, classDecl.range),
  );
  if (!classScope) return null;

  // Look for the create method
  const createDeclId = classScope.declarations.find(id => {
    const decl = table.declById.get(id);
    return decl?.name === "create" && decl.kind === "function";
  });

  if (createDeclId !== undefined) {
    const createDecl = table.declById.get(createDeclId);
    if (createDecl) {
      const sig = buildSignatureFromDecl(createDecl, table);
      if (sig) return sig;
    }
  }

  // Check inherited scopes for create
  for (const inheritedScopeId of classScope.inheritedScopes) {
    const inheritedScope = table.scopeById.get(inheritedScopeId);
    if (!inheritedScope) continue;
    const inheritedCreateId = inheritedScope.declarations.find(id => {
      const decl = table.declById.get(id);
      return decl?.name === "create" && decl.kind === "function";
    });
    if (inheritedCreateId !== undefined) {
      const createDecl = table.declById.get(inheritedCreateId);
      if (createDecl) {
        return buildSignatureFromDecl(createDecl, table);
      }
    }
  }

  // No create method found — return a no-args constructor signature
  return {
    label: `${classDecl.name}()`,
    parameters: [],
  };
}

/** Find a declaration by name, preferring declarations in the closest scope. */
function findDeclarationForName(table: SymbolTable, name: string): Declaration | null {
  // Find any declaration matching this name (function, variable, parameter, class)
  return table.declarations.find(d => d.name === name) ?? null;
}

// ---------------------------------------------------------------------------
// Signature builders
// ---------------------------------------------------------------------------

/**
 * Build a SignatureInfo from a local function declaration.
 */
function buildSignatureFromDecl(decl: Declaration, table: SymbolTable): SignatureInfo | null {
  // Find the scope that contains this declaration.
  const containingScope = table.scopes.find(s =>
    s.declarations.includes(decl.id),
  );

  if (!containingScope) {
    return {
      label: `${decl.declaredType ?? "mixed"} ${decl.name}(...)`,
      parameters: [],
    };
  }

  // Find the function's own scope — a child of containingScope with kind
  // "function" whose range overlaps with the declaration range.
  let funcScopeId: number | null = null;
  for (const scope of table.scopes) {
    if (
      scope.parentId === containingScope.id &&
      scope.kind === "function" &&
      scope.range.start.line <= decl.range.end.line &&
      scope.range.end.line >= decl.range.start.line
    ) {
      funcScopeId = scope.id;
      break;
    }
  }

  // Collect parameters from the function scope.
  const params: ParameterInfo[] = [];
  if (funcScopeId !== null) {
    const funcScope = table.scopes.find(s => s.id === funcScopeId);
    if (funcScope) {
      for (const declId of funcScope.declarations) {
        const param = table.declById.get(declId);
        if (param && param.kind === "parameter") {
          const label = param.declaredType
            ? `${param.declaredType} ${param.name}`
            : param.name;
          params.push({ label });
        }
      }
    }
  } else {
    // Top-level function: parameters are directly in the containing scope.
    for (const declId of containingScope.declarations) {
      const param = table.declById.get(declId);
      if (param && param.kind === "parameter") {
        const label = param.declaredType
          ? `${param.declaredType} ${param.name}`
          : param.name;
        params.push({ label });
      }
    }
  }

  const retType = decl.declaredType ?? "mixed";
  const paramStr = params.map(p => p.label).join(", ");
  const label = `${retType} ${decl.name}(${paramStr})`;

  return { label, parameters: params };
}

/**
 * Build a SignatureInfo from a stdlib autodoc entry.
 */
function buildSignatureFromStdlib(
  name: string,
  entry: { signature: string; markdown: string },
): SignatureInfo {
  // Parse parameters from the signature
  const sig = entry.signature;
  const openParen = sig.indexOf("(");
  const closeParen = sig.lastIndexOf(")");

  const params: ParameterInfo[] = [];
  if (openParen !== -1 && closeParen !== -1) {
    const paramText = sig.slice(openParen + 1, closeParen).trim();
    if (paramText) {
      const parts = splitParams(paramText);
      for (const part of parts) {
        params.push({ label: part.trim() });
      }
    }
  }

  return {
    label: sig,
    documentation: entry.markdown,
    parameters: params,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Split parameter text by commas, respecting nested parentheses.
 */
export function splitParams(text: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let start = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      result.push(text.slice(start, i));
      start = i + 1;
    }
  }

  if (start < text.length) {
    result.push(text.slice(start));
  }

  return result;
}

/**
 * Count commas inside an argument_list node.
 */
function countCommasInNode(node: Node, line: number, character: number): number {
  let count = 0;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === ",") {
      const pos = child.startPosition;
      if (pos.row < line || (pos.row === line && pos.column < character)) {
        count++;
      }
    }
    if (child.childCount > 0) {
      count += countCommasInNode(child, line, character);
    }
  }
  return count;
}

/**
 * Produce signature help for a position in the source.
 *
 * Exported for direct unit testing.
 */
export function findEnclosingCallExport(tree: Tree, line: number, character: number): Node | null {
  const node = tree.rootNode.descendantForPosition({ row: line, column: character });
  if (!node) return null;
  return findEnclosingCall(node, line, character);
}
