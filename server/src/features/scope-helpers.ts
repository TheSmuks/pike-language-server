/**
 * Scope helpers: geometry, resolution, and tree-sitter utilities.
 *
 * Extracted from scopeBuilder.ts to reduce file size.
 *
 * Performance note: all position conversion functions accept an optional
 * OffsetMap for O(1) byte→UTF-16 lookup. When the map is provided (during
 * buildSymbolTable), conversions are array-index lookups instead of
 * per-character scans. When omitted (feature handlers), falls back to
 * the original utf8ToUtf16 function.
 */
import type { Node, Point } from 'web-tree-sitter';
import type {
  BuildState,
  Declaration,
  Range,
  Scope,
  ScopeKind,
} from './symbolTable';
import type { OffsetMap } from '../util/offsetMap';
import { lookupUtf16 } from '../util/offsetMap';
import { utf8ToUtf16 } from '../util/positionConverter';

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
 * Convert a tree-sitter Point (UTF-8 byte column) to an LSP Location
 * with UTF-16 character offset, using pre-split source lines.
 *
 * When offsetMap is provided, uses O(1) array lookup.
 * When omitted, falls back to the per-character utf8ToUtf16 scan.
 */
export function toLocUtf16(
  point: Point,
  lines: string[],
  offsetMap?: OffsetMap,
): { line: number; character: number } {
  if (offsetMap) {
    return { line: point.row, character: lookupUtf16(offsetMap, point.row, point.column) };
  }
  const lineText = lines[point.row];
  if (lineText === undefined) {
    return { line: point.row, character: point.column };
  }
  return { line: point.row, character: utf8ToUtf16(lineText, point.column) };
}

/**
 * Convert a tree-sitter Node to an LSP Range with UTF-16 character offsets,
 * using pre-split source lines.
 *
 * When offsetMap is provided, uses O(1) array lookup.
 * When omitted, falls back to the per-character utf8ToUtf16 scan.
 */
export function toRangeUtf16(node: Node, lines: string[], offsetMap?: OffsetMap): Range {
  return {
    start: toLocUtf16(node.startPosition, lines, offsetMap),
    end: toLocUtf16(node.endPosition, lines, offsetMap),
  };
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

/**
 * Check whether a range contains the position spanned by (start, end).
 *
 * When offsetMap is provided, converts tree-sitter byte columns to UTF-16
 * using O(1) array lookups. When omitted, uses the original utf8ToUtf16 scan.
 */
export function containsPosition(
  range: Range,
  start: Point,
  end: Point,
  lines?: string[],
  offsetMap?: OffsetMap,
): boolean {
  let startCol: number;
  let endCol: number;
  if (offsetMap) {
    startCol = lookupUtf16(offsetMap, start.row, start.column);
    endCol = lookupUtf16(offsetMap, end.row, end.column);
  } else if (lines) {
    startCol = utf8ToUtf16(lines[start.row] ?? '', start.column);
    endCol = utf8ToUtf16(lines[end.row] ?? '', end.column);
  } else {
    startCol = start.column;
    endCol = end.column;
  }
  return (
    (range.start.line < start.row ||
     (range.start.line === start.row && range.start.character <= startCol)) &&
    (range.end.line > end.row ||
     (range.end.line === end.row && range.end.character >= endCol))
  );
}

export function rangeSize(range: Range): number {
  return (range.end.line - range.start.line) * 10000 +
         (range.end.character - range.start.character);
}

/**
 * Check whether `outer` range fully contains `inner` range.
 *
 * Boundary inclusion: uses `<=` and `>=` (not `<` and `>`) so that the
 * closing brace character of a Pike scope is considered part of the scope.
 * Tree-sitter ranges for blocks include the closing `}`, so a node ending
 * at the brace position should still be considered inside the scope.
 * This is intentional — do NOT change to strict inequality.
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
    return extractCondExprType(node);
  }

  // Only variable_decl or local_declaration has a 'value' field with an initializer
  if (node.type !== 'variable_decl' && node.type !== 'local_declaration') return undefined;

  const valueNode = node.childForFieldName('value');
  if (!valueNode) return undefined;

  return extractInitializerExprType(valueNode);
}

/**
 * Extract the type name from a bare cond_expr node.
 * Handles consequence and alternate branches, including nested ternaries.
 */
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

/**
 * Drill through wrappers in a cond_expr branch to find the type.
 * Returns undefined for primitives or complex expressions.
 */
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

/**
 * Extract the type name from an initializer expression node.
 * Drills through wrappers and handles cond_expr branches.
 */
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

/**
 * Extract the type from a cond_expr encountered during initializer drilling.
 * Checks consequence and alternate branches.
 */
function extractCondExprBranchType(condNode: Node): string | undefined {
  // Single-child cond_expr is just an expression-precedence wrapper,
  // not a real ternary — fall through to normal drilling.
  if (condNode.childCount === 1) return extractInitializerExprType(condNode.namedChild(0)!);

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
 *
 * Uses binary search on sortedScopes (sorted by start position) to find
 * candidate scopes in O(log S) instead of O(S). For each candidate, verifies
 * containment using the pre-computed offset map for O(1) position conversion.
 *
 * Overall complexity: O(R × log S) for the reference pass instead of O(R × S).
 */
export function findScopeForNode(node: Node, state: BuildState): number | null {
  const nodeStartRow = node.startPosition.row;
  const nodeStartCol = node.startPosition.column;
  const nodeEndRow = node.endPosition.row;
  const nodeEndCol = node.endPosition.column;

  const sorted = state.sortedScopes;
  if (sorted.length === 0) return null;

  // Convert node positions to UTF-16 once for all containment checks.
  const nodeStartChar = lookupUtf16(state.offsetMap, nodeStartRow, nodeStartCol);
  const nodeEndChar = lookupUtf16(state.offsetMap, nodeEndRow, nodeEndCol);

  // Binary search: find the rightmost scope whose start is ≤ the node's start.
  // sorted is sorted by (startLine, startChar) ascending.
  let lo = 0;
  let hi = sorted.length - 1;
  let bestScopeId: number | null = null;
  let bestSize = Infinity;

  // Find the index of the last scope whose start is ≤ node start position.
  // We want all scopes that could possibly contain this node.
  let lastCandidateIdx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const scope = sorted[mid]!;
    const cmp = comparePositionToRangeStart(
      nodeStartRow, nodeStartChar,
      scope.range.start.line, scope.range.start.character,
    );
    if (cmp >= 0) {
      // Scope starts at or before node — this is a candidate.
      lastCandidateIdx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (lastCandidateIdx === -1) return null;

  // Walk backward from the rightmost candidate to find the innermost containing scope.
  // Scopes are sorted by start position, so later scopes with same-or-later start
  // positions are more deeply nested (smaller range). We check all candidates that
  // start at or before the node, picking the one with the smallest range (innermost).
  for (let i = lastCandidateIdx; i >= 0; i--) {
    const scope = sorted[i]!;
    // Stop early: if this scope starts after the node, no more candidates can contain it.
    if (scope.range.start.line > nodeStartRow ||
        (scope.range.start.line === nodeStartRow &&
         scope.range.start.character > nodeStartChar)) {
      break;
    }

    // Check containment: scope.start ≤ node.start AND scope.end ≥ node.end
    if (scopeEndsAfterOrAt(scope, nodeEndRow, nodeEndChar)) {
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
 * Compare a position (line, char) to a range start (line, char).
 * Returns negative if pos < rangeStart, 0 if equal, positive if pos > rangeStart.
 */
function comparePositionToRangeStart(
  posLine: number, posChar: number,
  rangeLine: number, rangeChar: number,
): number {
  const lineDiff = posLine - rangeLine;
  if (lineDiff !== 0) return lineDiff;
  return posChar - rangeChar;
}

/**
 * Check whether a scope's end position is at or after the given position.
 */
function scopeEndsAfterOrAt(scope: Scope, endRow: number, endChar: number): boolean {
  return (
    scope.range.end.line > endRow ||
    (scope.range.end.line === endRow && scope.range.end.character >= endChar)
  );
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
