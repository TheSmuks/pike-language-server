/**
 * Scope builder: scope management primitives, geometry helpers,
 * resolution helpers, inheritance wiring, and completion support.
 *
 * Extracted from symbolTable.ts (US-032/US-033).
 */
import type { Node, Point } from 'web-tree-sitter';
import type {
  BuildState,
  Declaration,
  Range,
  Scope,
  ScopeKind,
  SymbolTable,
} from './symbolTable';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function toLoc(point: Point): { line: number; character: number } {
  return { line: point.row, character: point.column };
}

export function toRange(node: Node): Range {
  return { start: toLoc(node.startPosition), end: toLoc(node.endPosition) };
}

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
 * Primitive type names that can never have members.
 * Shared with typeResolver.ts — kept as a set for O(1) lookup.
 */
export const PRIMITIVE_TYPES = new Set([
  'void', 'mixed', 'zero', 'int', 'float', 'string',
  'array', 'mapping', 'multiset', 'object', 'function', 'program',
  'bool', 'auto', 'any',
]);

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
 * Extract the type name from a variable initializer, if the RHS is a simple
 * identifier that could be a class name (e.g., Dog d = makeDog() → makeDog).
 *
 * Drills through expression wrappers (comma_expr, assign_expr, cond_expr,
 * postfix_expr) to find the innermost identifier. Returns undefined for
 * literals, complex expressions, or call expressions whose callee is not
 * a simple identifier.
 */
export function extractInitializerType(node: Node): string | undefined {
  // Only variable_decl or local_declaration has a 'value' field with an initializer
  if (node.type !== 'variable_decl' && node.type !== 'local_declaration') return undefined;

  const valueNode = node.childForFieldName('value');
  if (!valueNode) return undefined;

  // Drill through expression wrappers to find the innermost meaningful node.
  // The tree wraps expressions: comma_expr > assign_expr > cond_expr > ... >
  // postfix_expr > primary_expr > identifier_expr > identifier
  // For call expressions like Dog(), we extract the callee name as a heuristic.
  // This is correct for constructors (Dog d = Dog()) but may be wrong for
  // factory functions (Dog d = makeDog()). Downstream code validates against
  // the symbol table when resolving.
  // For simple identifier references like someVar, we want the identifier.
  let inner: Node | null = valueNode;
  while (inner !== null) {
    if (inner.type === 'postfix_expr') {
      if (inner.childCount > 1) {
        // Call expression: extract the callee (first child) as heuristic type
        inner = inner.child(0);
        // Continue drilling — callee may be wrapped in another postfix_expr
        continue;
      }
      // Single child: keep drilling
      inner = inner.child(0);
      continue;
    }

    if (inner.type === 'identifier_expr' || inner.type === 'primary_expr') {
      inner = inner.namedChild(0);
      continue;
    }

    // Expression wrappers: drill into first named child
    if (inner.namedChildCount === 1) {
      inner = inner.namedChild(0);
      continue;
    }

    // identifier, literal, etc. — stop drilling
    break;
  }

  if (!inner || inner.type !== 'identifier') return undefined;

  const name = inner.text;
  // Skip primitive types and keywords
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
// Geometry helpers
// ---------------------------------------------------------------------------

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
// Inheritance wiring
// ---------------------------------------------------------------------------

/**
 * After building the symbol table, wire up class inheritance.
 * For each class scope that contains `inherit` declarations,
 * find the inherited class's scope and add it to `inheritedScopes`.
 *
 * Two resolution paths:
 * 1. Local: class declared in the same file (existing behavior).
 * 2. Cross-file: class brought into scope via file-level inherit/import,
 *    resolved through the WorkspaceIndex.
 *
 * Cross-file classes get a synthetic scope in the local table whose
 * declarations mirror the remote class's members. This lets all
 * inheritedScopes consumers work without modification.
 */
export function wireInheritance(
  table: SymbolTable,
  index?: {
    getSymbolTable(uri: string): SymbolTable | null;
    resolveImport(mod: string, from: string): string | null;
    resolveInherit(path: string, isString: boolean, from: string): string | null;
  },
  uri?: string,
): void {
  // Track the next synthetic ID to avoid collisions with real declarations.
  let syntheticIdCounter = table.declarations.length > 0
    ? Math.max(...table.declarations.map(d => d.id)) + 1
    : 0;

  for (const scope of table.scopes) {
    if (scope.kind !== 'class') continue;

    const inheritDecls = scope.declarations
      .map(id => table.declById.get(id))
      .filter(d => d?.kind === 'inherit');

    for (const inheritDecl of inheritDecls) {
      if (!inheritDecl) continue;

      const resolvedLocally = wireLocalInheritance(table, scope, inheritDecl);
      if (resolvedLocally) continue;

      // Cross-file resolution: look up the inherited class via WorkspaceIndex.
      if (!index || !uri) continue;
      const crossFileResult = wireCrossFileInheritance(
        table, scope, inheritDecl, index, uri, syntheticIdCounter,
      );
      if (crossFileResult !== null) {
        syntheticIdCounter = crossFileResult.nextId;
        scope.inheritedScopes.push(crossFileResult.scopeId);
      }
    }
  }
}

/**
 * Try to wire an inherit declaration against same-file classes.
 * Returns true if a local class was found and wired.
 */
function wireLocalInheritance(
  table: SymbolTable,
  scope: Scope,
  inheritDecl: Declaration,
): boolean {
  const parentScope = scope.parentId !== null
    ? table.scopes.find(s => s.id === scope.parentId)
    : null;
  if (!parentScope) return false;

  for (const candidateId of parentScope.declarations) {
    const candidate = table.declById.get(candidateId);
    if (candidate && candidate.kind === 'class' && candidate.name === inheritDecl.name) {
      const classScope = table.scopes.find(s =>
        s.kind === 'class' &&
        s.parentId === scope.parentId &&
        containsRange(s.range, candidate.range),
      );
      if (classScope && classScope.id !== scope.id) {
        scope.inheritedScopes.push(classScope.id);
        return true;
      }
    }
  }
  return false;
}

/**
 * Try to wire an inherit declaration against a cross-file class.
 *
 * Resolution strategy:
 * 1. Check if the inherit name matches a class in a file-level inherit/import target.
 *    File-level `inherit "other.pike"` brings other.pike's top-level classes into scope.
 * 2. If found, create a synthetic scope in the local table that mirrors
 *    the remote class's members (including its own inherited members).
 *
 * Returns the synthetic scope ID and next available ID, or null if not found.
 */
function wireCrossFileInheritance(
  table: SymbolTable,
  scope: Scope,
  inheritDecl: Declaration,
  index: {
    getSymbolTable(uri: string): SymbolTable | null;
    resolveImport(mod: string, from: string): string | null;
    resolveInherit(path: string, isString: boolean, from: string): string | null;
  },
  fromUri: string,
  startId: number,
): { scopeId: number; nextId: number } | null {
  const inheritName = inheritDecl.name;

  // The inherit name might be a class brought into scope by a file-level
  // inherit/import. Check file-level inherit/import declarations.
  const fileScope = table.scopes.find(s => s.kind === 'file');
  if (!fileScope) return null;

  for (const fileDeclId of fileScope.declarations) {
    const fileDecl = table.declById.get(fileDeclId);
    if (!fileDecl || (fileDecl.kind !== 'inherit' && fileDecl.kind !== 'import')) continue;

    // Resolve the file-level inherit/import to a target URI.
    const isStringLit = fileDecl.name.startsWith('"') && fileDecl.name.endsWith('"');
    const targetUri = isStringLit
      ? index.resolveInherit(fileDecl.name, true, fromUri)
      : index.resolveImport(fileDecl.name, fromUri)
        ?? index.resolveInherit(fileDecl.name, false, fromUri);
    if (!targetUri) continue;

    const targetTable = index.getSymbolTable(targetUri);
    if (!targetTable) continue;

    // Look for the class in the target file.
    const targetClass = targetTable.declarations.find(
      d => d.kind === 'class' && d.name === inheritName,
    );
    if (!targetClass) continue;

    // Find the class body scope in the target table.
    const targetClassScope = targetTable.scopes.find(s =>
      s.kind === 'class' && s.parentId === targetClass.scopeId &&
      containsRange(s.range, targetClass.range),
    );
    if (!targetClassScope) continue;

    // Create a synthetic scope in the local table mirroring the remote
    // class's declarations. This allows all inheritedScopes consumers
    // to work without modification.
    const syntheticScopeId = startId;
    const syntheticDeclIds: number[] = [];
    let nextId = startId + 1;

    for (const remoteDeclId of targetClassScope.declarations) {
      const remoteDecl = targetTable.declById.get(remoteDeclId);
      if (!remoteDecl) continue;

      const syntheticDecl: Declaration = {
        id: nextId,
        name: remoteDecl.name,
        kind: remoteDecl.kind,
        nameRange: remoteDecl.nameRange,
        range: remoteDecl.range,
        scopeId: syntheticScopeId,
        declaredType: remoteDecl.declaredType,
        alias: remoteDecl.alias,
        sourceUri: targetUri,
      };
      table.declarations.push(syntheticDecl);
      table.declById.set(nextId, syntheticDecl);
      syntheticDeclIds.push(nextId);
      nextId++;
    }

    // Also include declarations from inherited scopes of the target class.
    for (const remoteInheritedId of targetClassScope.inheritedScopes) {
      const remoteInheritedScope = targetTable.scopeById.get(remoteInheritedId);
      if (!remoteInheritedScope) continue;

      for (const remoteDeclId of remoteInheritedScope.declarations) {
        const remoteDecl = targetTable.declById.get(remoteDeclId);
        if (!remoteDecl) continue;

        const syntheticDecl: Declaration = {
          id: nextId,
          name: remoteDecl.name,
          kind: remoteDecl.kind,
          nameRange: remoteDecl.nameRange,
          range: remoteDecl.range,
          scopeId: syntheticScopeId,
          declaredType: remoteDecl.declaredType,
          alias: remoteDecl.alias,
          sourceUri: targetUri,
        };
        table.declarations.push(syntheticDecl);
        table.declById.set(nextId, syntheticDecl);
        syntheticDeclIds.push(nextId);
        nextId++;
      }
    }

    const syntheticScope: Scope = {
      id: syntheticScopeId,
      kind: 'class',
      range: targetClassScope.range,
      parentId: scope.id,
      declarations: syntheticDeclIds,
      inheritedScopes: [],
    };
    table.scopes.push(syntheticScope);
    table.scopeById.set(syntheticScopeId, syntheticScope);

    return { scopeId: syntheticScopeId, nextId };
  }


  // Second resolution path: the inherit name itself might be a module/class
  // path resolvable via the module resolver, without going through file-level
  // inherit/import. This handles bare identifier inherits like "inherit Animal"
  // where Animal is a class in another file.
  if (!inheritName.startsWith('"')) {
    const resolvedUri = index.resolveImport(inheritName, fromUri)
      ?? index.resolveInherit(inheritName, false, fromUri);
    if (resolvedUri) {
      const targetTable = index.getSymbolTable(resolvedUri);
      if (targetTable) {
        const targetClass = targetTable.declarations.find(
          d => d.kind === 'class' && d.name === inheritName,
        );
        if (targetClass) {
          const targetClassScope = targetTable.scopes.find(s =>
            s.kind === 'class' && s.parentId === targetClass.scopeId &&
            containsRange(s.range, targetClass.range),
          );
          if (targetClassScope) {
            const syntheticScopeId = startId;
            const syntheticDeclIds: number[] = [];
            let nextId = startId + 1;

            for (const remoteDeclId of targetClassScope.declarations) {
              const remoteDecl = targetTable.declById.get(remoteDeclId);
              if (!remoteDecl) continue;

              const syntheticDecl: Declaration = {
                id: nextId,
                name: remoteDecl.name,
                kind: remoteDecl.kind,
                nameRange: remoteDecl.nameRange,
                range: remoteDecl.range,
                scopeId: syntheticScopeId,
                declaredType: remoteDecl.declaredType,
                alias: remoteDecl.alias,
                sourceUri: resolvedUri,
              };
              table.declarations.push(syntheticDecl);
              table.declById.set(nextId, syntheticDecl);
              syntheticDeclIds.push(nextId);
              nextId++;
            }

            for (const remoteInheritedId of targetClassScope.inheritedScopes) {
              const remoteInheritedScope = targetTable.scopeById.get(remoteInheritedId);
              if (!remoteInheritedScope) continue;

              for (const remoteDeclId of remoteInheritedScope.declarations) {
                const remoteDecl = targetTable.declById.get(remoteDeclId);
                if (!remoteDecl) continue;

                const syntheticDecl: Declaration = {
                  id: nextId,
                  name: remoteDecl.name,
                  kind: remoteDecl.kind,
                  nameRange: remoteDecl.nameRange,
                  range: remoteDecl.range,
                  scopeId: syntheticScopeId,
                  declaredType: remoteDecl.declaredType,
                  alias: remoteDecl.alias,
                  sourceUri: resolvedUri,
                };
                table.declarations.push(syntheticDecl);
                table.declById.set(nextId, syntheticDecl);
                syntheticDeclIds.push(nextId);
                nextId++;
              }
            }

            const syntheticScope: Scope = {
              id: syntheticScopeId,
              kind: 'class',
              range: targetClassScope.range,
              parentId: scope.id,
              declarations: syntheticDeclIds,
              inheritedScopes: [],
            };
            table.scopes.push(syntheticScope);
            table.scopeById.set(syntheticScopeId, syntheticScope);

            return { scopeId: syntheticScopeId, nextId };
          }
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Completion support: enumerate symbols visible at a position
// ---------------------------------------------------------------------------

/**
 * Find the scope ID that contains a given line/character position.
 * Returns the innermost scope containing the position.
 */
function findScopeAtPosition(table: SymbolTable, line: number, character: number): number | null {
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
      if (size < bestSize || (size === bestSize && scope.id > bestScopeId!)) {
        bestSize = size;
        bestScopeId = scope.id;
      }
    }
  }

  return bestScopeId;
}

/**
 * Collect all declarations from a scope and its inherited scopes.
 * Used for class scope enumeration.
 */
function collectScopeDecls(scopeId: number, table: SymbolTable, seen: Set<number>, results: Declaration[]): void {
  const scope = table.scopeById.get(scopeId);
  if (!scope || seen.has(scopeId)) return;
  seen.add(scopeId);

  for (const declId of scope.declarations) {
    const decl = table.declById.get(declId);
    if (decl && !seen.has(decl.id)) {
      // Skip inherit declarations themselves — they're not completable symbols
      if (decl.kind !== 'inherit') {
        results.push(decl);
      }
    }
  }

  // Recurse into inherited scopes
  for (const inheritedId of scope.inheritedScopes) {
    collectScopeDecls(inheritedId, table, seen, results);
  }
}

/**
 * Enumerate all declarations visible at a given position.
 * Walks the scope chain from innermost to file scope.
 * Returns declarations ordered by proximity (innermost scope first).
 * Skips duplicate names (inner scope shadows outer).
 */
export function getSymbolsInScope(
  table: SymbolTable,
  line: number,
  character: number,
): Declaration[] {
  const scopeId = findScopeAtPosition(table, line, character);
  if (scopeId === null) return [];

  const results: Declaration[] = [];
  const seenNames = new Set<string>();

  let current: number | null = scopeId;
  while (current !== null) {
    const scope = table.scopeById.get(current);
    if (!scope) break;

    // Collect direct declarations in this scope
    for (const declId of scope.declarations) {
      const decl = table.declById.get(declId);
      if (!decl) continue;

      // Skip inherit declarations
      if (decl.kind === 'inherit' || decl.kind === 'import') continue;

      // For block/function scopes, only include declarations before the cursor
      if (scope.kind !== 'class' && scope.kind !== 'file' && decl.kind !== 'parameter') {
        if (decl.range.start.line > line ||
            (decl.range.start.line === line && decl.range.start.character > character)) {
          continue;
        }
      }

      // Deduplicate by name (inner scope shadows outer)
      if (!seenNames.has(decl.name)) {
        seenNames.add(decl.name);
        results.push(decl);
      }
    }

    // For class scopes, collect inherited members
    if (scope.kind === 'class') {
      for (const inheritedId of scope.inheritedScopes) {
        const inheritedScope = table.scopeById.get(inheritedId);
        if (!inheritedScope) continue;
        for (const declId of inheritedScope.declarations) {
          const decl = table.declById.get(declId);
          if (!decl || decl.kind === 'inherit' || decl.kind === 'import') continue;
          if (!seenNames.has(decl.name)) {
            seenNames.add(decl.name);
            results.push(decl);
          }
        }
      }
    }

    current = scope.parentId;
  }

  return results;
}

/**
 * Get all declarations in a specific scope (including inherited).
 * For cross-file completion: resolve an inherit/module to a target file
 * and call this to get its class-level declarations.
 */
export function getDeclarationsInScope(table: SymbolTable, scopeId: number): Declaration[] {
  const results: Declaration[] = [];
  const seen = new Set<number>();
  collectScopeDecls(scopeId, table, seen, results);
  return results;
}

/**
 * Find the class scope ID that contains a given position.
 * Returns null if the position is not inside any class scope.
 */
export function findClassScopeAt(table: SymbolTable, line: number, character: number): number | null {
  const scopeId = findScopeAtPosition(table, line, character);
  if (scopeId === null) return null;

  let current: number | null = scopeId;
  while (current !== null) {
    const scope = table.scopeById.get(current);
    if (!scope) break;
    if (scope.kind === 'class') return current;
    current = scope.parentId;
  }
  return null;
}
