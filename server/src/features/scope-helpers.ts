/**
 * Scope helpers: geometry, resolution, and tree-sitter utilities.
 *
 * Extracted from scopeBuilder.ts to reduce file size.
 */
import type { Node, Point } from 'web-tree-sitter';
import type {
  BuildState,
  Declaration,
  Range,
  Scope,
  ScopeKind,
} from './symbolTable';

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
 * Shared with typeResolver.ts — kept as a set for O(1) lookup.
 */
export const PRIMITIVE_TYPES = new Set([
  'void', 'mixed', 'zero', 'int', 'float', 'string',
  'array', 'mapping', 'multiset', 'object', 'function', 'program',
  'bool', 'auto', 'any',
]);

export function containsPosition(range: Range, start: Point, end: Point): boolean {
  return (
    (range.start.line < start.row ||
     (range.start.line === start.row && range.start.character <= start.column)) &&
    (range.end.line > end.row ||
     (range.end.line === end.row && range.end.character >= end.column))
  );
}

export function rangeSize(range: Range): number {
  return (range.end.line - range.start.line) * 10000 +
         (range.end.character - range.start.character);
}

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

/** Get all identifier nodes from the `name` field (multi-name variable/constant decls). */
export function getNameNodes(node: Node): Node[] {
  return node.childrenForFieldName('name');
}

/** Extract the declared type text from a variable_decl or parameter node. */
export function extractTypeText(node: Node): string | undefined {
  // constant_decl has no type field; childForFieldName returns undefined, which is correct.
  if (node.type === 'constant_decl') return undefined;
  const typeNode = node.childForFieldName('type');
  return typeNode?.text;
}

/**
 * Resolve the effective type name for a declaration.
 *
 * Priority: declaredType (if present and not primitive) > assignedType > null.
 * Primitives (int, float, mixed, etc.) have no members, so we skip them
 * and fall through to assignedType or null.
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
 * Drill through expression wrappers (postfix_expr, identifier_expr, primary_expr,
 * single-child wrappers) to find the innermost identifier Node.
 * Returns null if the drill path ends without reaching an identifier.
 * Does NOT descend into cond_expr — callers must handle that separately.
 */
export function drillForIdentifier(node: Node): Node | null {
  // Returns identifier or cond_expr nodes (for nested ternary handling)
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
 * Extract the type name from a variable initializer, if the RHS is a simple
 * identifier that could be a class name (e.g., Dog d = makeDog() → makeDog).
 *
 * Drills through expression wrappers (comma_expr, assign_expr, cond_expr,
 * postfix_expr) to find the innermost identifier. Returns undefined for
 * literals, complex expressions, or call expressions whose callee is not
 * a simple identifier.
 */
export function extractInitializerType(node: Node): string | undefined {
  // Bare cond_expr (no variable_decl/local_declaration wrapper): handle it directly
  if (node.type === 'cond_expr') {
    if (node.childCount === 1) return undefined;
    const consequence = node.child(2);
    if (consequence) {
      // Drill through wrappers to find the actual expression
      let expr: Node | undefined = consequence;
      while (expr && expr.type !== 'cond_expr' && expr.type !== 'identifier') {
        if (expr.type === 'postfix_expr') {
          const id = drillForIdentifier(expr);
          if (id && !PRIMITIVE_TYPES.has(id.text)) return id.text;
          break;
        }
        if (expr.namedChildCount === 1) {
          expr = expr.namedChild(0) ?? undefined;
        } else {
          break;
        }
      }
      if (expr?.type === 'cond_expr') {
        // Nested ternary in consequence
        const nestedType = extractInitializerType(expr);
        if (nestedType) return nestedType;
      } else if (expr?.type === 'identifier') {
        if (!PRIMITIVE_TYPES.has(expr.text)) return expr.text;
      }
    }
    const alternate = node.child(4);
    if (alternate) {
      const id = drillForIdentifier(alternate);
      if (id && !PRIMITIVE_TYPES.has(id.text)) return id.text;
    }
    return undefined;
  }

  // Only variable_decl or local_declaration has a 'value' field with an initializer
  if (node.type !== 'variable_decl' && node.type !== 'local_declaration') return undefined;

  const valueNode = node.childForFieldName('value');
  if (!valueNode) return undefined;

  let inner: Node | null = valueNode;
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
    if (inner.type === 'cond_expr') {
      if (inner.childCount === 1) {
        // Fall through to single-child wrapper
      } else {
        const consequence = inner.child(2);
        if (consequence) {
          const id = drillForIdentifier(consequence);
          if (id?.type === 'cond_expr') {
            const nestedType = extractInitializerType(id);
            if (nestedType) return nestedType;
          } else if (id && !PRIMITIVE_TYPES.has(id.text)) {
            return id.text;
          }
        }
        const alternate = inner.child(4);
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
    }
    if (inner.namedChildCount === 1) {
      inner = inner.namedChild(0);
      continue;
    }
    break;
  }

  if (!inner || inner.type !== 'identifier') return undefined;

  const name = inner.text;
  if (PRIMITIVE_TYPES.has(name)) return undefined;

  return name;
}

// ---------------------------------------------------------------------------
// Scope management
// ---------------------------------------------------------------------------

export function freshId(state: BuildState): number {
  return state.nextId++;
}

export function currentScopeId(state: BuildState): number {
  return state.scopeStack[state.scopeStack.length - 1];
}

export function pushScope(state: BuildState, kind: ScopeKind, range: Range): number {
  const id = freshId(state);
  const parentId = state.scopeStack.length > 0 ? currentScopeId(state) : null;
  const scope: Scope = { id, kind, range, parentId, declarations: [], inheritedScopes: [] };
  state.scopes.push(scope);
  state.scopeMap.set(id, scope);
  state.scopeStack.push(id);
  return id;
}

export function popScope(state: BuildState): void {
  state.scopeStack.pop();
}

export function addDeclaration(state: BuildState, decl: Omit<Declaration, 'id'>): number {
  const id = freshId(state);
  const full: Declaration = { ...decl, id };
  state.declarations.push(full);
  state.declMap.set(id, full);
  // Register in scope
  const scope = state.scopeMap.get(decl.scopeId);
  if (scope) scope.declarations.push(id);
  return id;
}

// ---------------------------------------------------------------------------
// Scope lookup helpers
// ---------------------------------------------------------------------------

/**
 * Find the scope ID that contains a given node.
 */
export function findScopeForNode(node: Node, state: BuildState): number | null {
  const nodeStart = node.startPosition;
  const nodeEnd = node.endPosition;

  // Find the innermost scope that contains the node
  // When scopes have equal range size, prefer higher ID (deeper nesting)
  let bestScopeId: number | null = null;
  let bestSize = Infinity;

  for (const scope of state.scopes) {
    if (containsPosition(scope.range, nodeStart, nodeEnd)) {
      const size = rangeSize(scope.range);
      if (size < bestSize || (size === bestSize && scope.id > bestScopeId!)) {
        bestSize = size;
        bestScopeId = scope.id;
      }
    }
  }

  return bestScopeId;
}

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
  // The class declaration is in the parent scope
  if (classScope.parentId !== null) {
    const parentScope = state.scopeMap.get(classScope.parentId);
    if (!parentScope) return null;
    for (const declId of parentScope.declarations) {
      const decl = state.declMap.get(declId);
      if (decl && decl.kind === 'class') {
        // Check that this class's scope matches
        // (the class scope should be created by this class decl)
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

  // Check inherited scopes
  for (const inheritedId of scope.inheritedScopes) {
    const match = findDeclInScope(name, inheritedId, state);
    if (match !== null) return match;
  }

  return null;
}
// ---------------------------------------------------------------------------
// Position-based scope lookup
// ---------------------------------------------------------------------------

/**
 * Find the scope ID that contains a given line/character position.
 * Returns the innermost scope containing the position.
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
