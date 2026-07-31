/**
 * Scope helpers: geometry, resolution, and tree-sitter utilities.
 *
 * Extracted from scopeBuilder.ts to reduce file size.
 *
 * Position conversion is a straight passthrough: web-tree-sitter indexes JS
 * string input in UTF-16 code units, which is exactly what LSP wants, so
 * `toLoc`/`toRange` need no byte-to-UTF-16 conversion step. An offset map
 * used to sit here converting an already-correct value as if it were a UTF-8
 * byte offset, corrupting ranges on lines with non-ASCII characters
 * preceding a token; it has been removed (Task 4).
 */
import type { Node, Point } from 'web-tree-sitter';
import type { BuildState, Declaration, Range } from './symbolTable';

// Import from the extracted lookup module
import { findScopeForNode, rangeSize } from './scope-helpers-lookup';

// Re-export for callers
export { findScopeForNode, rangeSize } from './scope-helpers-lookup';

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

export function toLoc(point: Point): { line: number; character: number } {
  return { line: point.row, character: point.column };
}

export function toRange(node: Node): Range {
  return { start: toLoc(node.startPosition), end: toLoc(node.endPosition) };
}

/**
 * Primitive type names that can never have members.
 */
export const PRIMITIVE_TYPES = new Set([
  'void', 'mixed', 'zero', 'int', 'float', 'string',
  'array', 'mapping', 'multiset', 'object', 'function', 'program',
  'bool', 'auto', 'any',
]);

/**
 * Check whether `outer` range fully contains `inner` range.
 */
export function containsRange(outer: Range, inner: Range): boolean {
  return (
    (outer.start.line < inner.start.line ||
     (outer.start.line === inner.start.line && outer.start.character <= inner.start.character)) &&
    (outer.end.line > inner.end.line ||
     (outer.end.line === inner.end.line && outer.end.character >= inner.end.character))
  );
}

// ---------------------------------------------------------------------------
// Node helpers
// ---------------------------------------------------------------------------

/** Get the text of the `name` field child, if any. */
export function getNameText(node: Node): string | null {
  const nameNode = node.childForFieldName('name');
  return nameNode?.text ?? null;
}

/** Get all identifier nodes from the `name` field. */
export function getNameNodes(node: Node): Node[] {
  return node.childrenForFieldName('name');
}

/** Extract the declared type text from a variable_decl or parameter node. */
export function extractTypeText(node: Node): string | undefined {
  if (node.type === 'constant_decl') return undefined;
  const typeNode = node.childForFieldName('type');
  return typeNode?.text;
}

/**
 * Resolve the effective type name for a declaration.
 */
export function resolveTypeName(decl: { declaredType?: string; assignedType?: string }): string | null {
  if (decl.declaredType && !PRIMITIVE_TYPES.has(decl.declaredType)) {
    return decl.declaredType;
  }
  if (decl.assignedType) {
    return decl.assignedType;
  }
  return null;
}

/**
 * Drill through expression wrappers to find the innermost identifier Node.
 */
export function drillForIdentifier(node: Node): Node | null {
  let inner: Node | null = node;
  while (inner !== null) {
    if (inner.type === 'postfix_expr') {
      if (inner.childCount > 1) {
        inner = inner.child(0);
        continue;
      }
      inner = inner.child(0);
      continue;
    }
    if (inner.type === 'identifier_expr' || inner.type === 'primary_expr') {
      inner = inner.namedChild(0);
      continue;
    }
    if (inner.namedChildCount === 1) {
      inner = inner.namedChild(0);
      continue;
    }
    break;
  }
  const t = inner?.type;
  return (t === 'identifier' || t === 'cond_expr') ? inner : null;
}

/**
 * Extract the type name from a variable initializer.
 */
export function extractInitializerType(node: Node): string | undefined {
  if (node.type === 'cond_expr') {
    return extractCondExprType(node);
  }
  if (node.type !== 'variable_decl' && node.type !== 'local_declaration') return undefined;
  const valueNode = node.childForFieldName('value');
  if (!valueNode) return undefined;
  return extractInitializerExprType(valueNode);
}

function extractCondExprType(node: Node): string | undefined {
  if (node.childCount === 1) return undefined;
  const consequence = node.child(2);
  if (consequence) {
    const result = drillCondExprBranch(consequence);
    if (result) return result;
  }
  const alternate = node.child(4);
  if (alternate) {
    const id = drillForIdentifier(alternate);
    if (id && !PRIMITIVE_TYPES.has(id.text)) return id.text;
  }
  return undefined;
}

function drillCondExprBranch(expr: Node): string | undefined {
  let current: Node | undefined = expr;
  while (current && current.type !== 'cond_expr' && current.type !== 'identifier') {
    if (current.type === 'postfix_expr') {
      const id = drillForIdentifier(current);
      if (id && !PRIMITIVE_TYPES.has(id.text)) return id.text;
      break;
    }
    if (current.namedChildCount === 1) {
      current = current.namedChild(0) ?? undefined;
    } else {
      break;
    }
  }
  if (current?.type === 'cond_expr') {
    return extractInitializerType(current);
  }
  if (current?.type === 'identifier' && !PRIMITIVE_TYPES.has(current.text)) {
    return current.text;
  }
  return undefined;
}

function extractInitializerExprType(valueNode: Node): string | undefined {
  let inner: Node | null = valueNode;
  while (inner !== null) {
    if (inner.type === 'postfix_expr') {
      inner = inner.child(0);
      continue;
    }
    if (inner.type === 'identifier_expr' || inner.type === 'primary_expr') {
      inner = inner.namedChild(0);
      continue;
    }
    if (inner.type === 'cond_expr') {
      return extractCondExprBranchType(inner);
    }
    if (inner.namedChildCount === 1) {
      inner = inner.namedChild(0);
      continue;
    }
    break;
  }
  if (!inner || inner.type !== 'identifier') return undefined;
  if (PRIMITIVE_TYPES.has(inner.text)) return undefined;
  return inner.text;
}

function extractCondExprBranchType(condNode: Node): string | undefined {
  if (condNode.childCount === 1) {
    const single = condNode.namedChild(0);
    if (single) return extractInitializerExprType(single);
    return undefined;
  }
  const consequence = condNode.child(2);
  if (consequence) {
    const id = drillForIdentifier(consequence);
    if (id?.type === 'cond_expr') {
      const nestedType = extractInitializerType(id);
      if (nestedType) return nestedType;
    } else if (id && !PRIMITIVE_TYPES.has(id.text)) {
      return id.text;
    }
  }
  const alternate = condNode.child(4);
  if (alternate) {
    const id = drillForIdentifier(alternate);
    if (id?.type === 'cond_expr') {
      const nestedType = extractInitializerType(id);
      if (nestedType) return nestedType;
    } else if (id && !PRIMITIVE_TYPES.has(id.text)) {
      return id.text;
    }
  }
  return undefined;
}


// ---------------------------------------------------------------------------
// Scope lookup helpers
// ---------------------------------------------------------------------------

/**
 * Find the enclosing class scope for a node.
 */
export function findEnclosingClassScopeId(node: Node, state: BuildState): number | null {
  const scopeId = findScopeForNode(node, state);
  if (scopeId === null) return null;
  let current: number | null = scopeId;
  while (current !== null) {
    const scope = state.scopeMap.get(current);
    if (!scope) break;
    if (scope.kind === 'class') return current;
    current = scope.parentId;
  }
  return null;
}

export function findEnclosingClassDecl(node: Node, state: BuildState): number | null {
  const classScopeId = findEnclosingClassScopeId(node, state);
  if (classScopeId === null) return null;
  const classScope = state.scopeMap.get(classScopeId);
  if (!classScope) return null;
  if (classScope.parentId !== null) {
    const parentScope = state.scopeMap.get(classScope.parentId);
    if (!parentScope) return null;
    for (const declId of parentScope.declarations) {
      const decl = state.declMap.get(declId);
      if (decl && decl.kind === 'class') {
        return declId;
      }
    }
  }
  return null;
}

/**
 * Find a declaration by name in a specific scope (and its inherited scopes).
 */
export function findDeclInScope(name: string, scopeId: number, state: BuildState): number | null {
  const scope = state.scopeMap.get(scopeId);
  if (!scope) return null;
  for (const declId of scope.declarations) {
    const decl = state.declMap.get(declId);
    if (decl && decl.name === name) return declId;
  }
  for (const inheritedId of scope.inheritedScopes) {
    const match = findDeclInScope(name, inheritedId, state);
    if (match !== null) return match;
  }
  return null;
}

/**
 * Find the scope ID that contains a given line/character position.
 */
export function findScopeAtPosition(
  table: { scopes: { id: number; range: Range }[] },
  line: number,
  character: number,
): number | null {
  let bestScopeId: number | null = null;
  let bestSize = Infinity;
  for (const scope of table.scopes) {
    const r = scope.range;
    if ((
      r.start.line < line ||
      (r.start.line === line && r.start.character <= character)
    ) && (
      r.end.line > line ||
      (r.end.line === line && r.end.character >= character)
    )) {
      const size = rangeSize(r);
      if (size < bestSize || (size === bestSize && scope.id > (bestScopeId ?? -1))) {
        bestSize = size;
        bestScopeId = scope.id;
      }
    }
  }
  return bestScopeId;
}

/**
 * Resolve a name by walking the scope chain from innermost to outermost.
 * Returns the Declaration ID of the first matching declaration, or null.
 */
export function resolveName(name: string, refNode: Node, state: BuildState): number | null {
  // Find which scope contains the reference
  const refScopeId = findScopeForNode(refNode, state);
  if (refScopeId === null) return null;

  // Walk scope chain outward
  let scopeId: number | null = refScopeId;
  // Bounded: each iteration moves to parentId in the finite scope tree.
  while (scopeId !== null) {
    const scope = state.scopeMap.get(scopeId);
    if (!scope) break;

    // Check declarations in this scope
    for (const declId of scope.declarations) {
      const decl = state.declMap.get(declId);
      if (decl && decl.name === name) {
        // For non-class scopes, check that declaration is before reference
        // (class scope is flat — no ordering constraint)
        if (scope.kind === 'class' || decl.kind === 'parameter') {
          return declId;
        }
        if (scope.kind === 'file') {
          // File scope: ordering doesn't matter for top-level declarations
          return declId;
        }
        // Block/function scope: declaration must be before reference
        if (decl.range.start.line < refNode.startPosition.row ||
            (decl.range.start.line === refNode.startPosition.row &&
             decl.range.start.character <= refNode.startPosition.column)) {
          return declId;
        }
      }
    }

    // For class scopes, also check inherited scopes
    if (scope.kind === 'class') {
      for (const inheritedId of scope.inheritedScopes) {
        const match = findDeclInScope(name, inheritedId, state);
        if (match !== null) return match;
      }
    }

    scopeId = scope.parentId;
  }

  return null;
}
