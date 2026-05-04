/**
 * Scope builder: wireInheritance and tree-sitter helpers.
 *
 * Architecture:
 * - scope-helpers.ts: geometry, node, and scope utilities
 * - completion-scope.ts: position-based scope enumeration for completion
 * - scopeBuilder.ts (this file): wireInheritance only
 *
 * Extracted from symbolTable.ts.

// This file serves as a single import point for scope operations.
// Callers may import from this module rather than the underlying
// scope-helpers.ts or completion-scope.ts directly. The re-exports
// are intentional — they provide a stable API surface for the
// symbol table and completion systems.
 */
import type { Declaration, SymbolTable } from './symbolTable';

// Re-export all helpers from the extracted modules
export {
  toLoc,
  toRange,
  getNameText,
  getNameNodes,
  extractTypeText,
  PRIMITIVE_TYPES,
  resolveTypeName,
  extractInitializerType,
  freshId,
  currentScopeId,
  pushScope,
  popScope,
  addDeclaration,
  containsPosition,
  rangeSize,
  containsRange,
  findScopeForNode,
  findEnclosingClassScopeId,
  findEnclosingClassDecl,
  findDeclInScope,
} from './scope-helpers';

export {
  getSymbolsInScope,
  getDeclarationsInScope,
  findClassScopeAt,
} from './completion-scope';

import { containsRange } from './scope-helpers';

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
  scope: { id: number; parentId: number | null; inheritedScopes: number[] },
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
 */
function wireCrossFileInheritance(
  table: SymbolTable,
  scope: { id: number; inheritedScopes: number[] },
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

  const fileScope = table.scopes.find(s => s.kind === 'file');
  if (!fileScope) return null;

  for (const fileDeclId of fileScope.declarations) {
    const fileDecl = table.declById.get(fileDeclId);
    if (!fileDecl || (fileDecl.kind !== 'inherit' && fileDecl.kind !== 'import')) continue;

    const isStringLit = fileDecl.name.startsWith('"') && fileDecl.name.endsWith('"');
    const targetUri = isStringLit
      ? index.resolveInherit(fileDecl.name, true, fromUri)
      : index.resolveImport(fileDecl.name, fromUri)
        ?? index.resolveInherit(fileDecl.name, false, fromUri);
    if (!targetUri) continue;

    const targetTable = index.getSymbolTable(targetUri);
    if (!targetTable) continue;

    const targetClass = targetTable.declarations.find(
      d => d.kind === 'class' && d.name === inheritName,
    );
    if (!targetClass) continue;

    const targetClassScope = targetTable.scopes.find(s =>
      s.kind === 'class' && s.parentId === targetClass.scopeId &&
      containsRange(s.range, targetClass.range),
    );
    if (!targetClassScope) continue;

    return createSyntheticScope(table, scope, targetClass, targetClassScope, targetTable, targetUri, startId);
  }

  // Second resolution path: bare identifier inherits
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
            return createSyntheticScope(table, scope, targetClass, targetClassScope, targetTable, resolvedUri, startId);
          }
        }
      }
    }
  }
  return null;
}

function createSyntheticScope(
  table: SymbolTable,
  scope: { id: number },
  targetClass: Declaration,
  targetClassScope: { declarations: number[]; inheritedScopes: number[]; range: { start: { line: number; character: number }; end: { line: number; character: number } } },
  targetTable: SymbolTable,
  targetUri: string,
  startId: number,
): { scopeId: number; nextId: number } {
  const syntheticScopeId = startId;
  const syntheticDeclIds: number[] = [];
  let nextId = startId + 1;

  for (const remoteDeclId of targetClassScope.declarations) {
    const remoteDecl = targetTable.declById.get(remoteDeclId);
    if (!remoteDecl) continue;
    const d: Declaration = {
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
    table.declarations.push(d);
    table.declById.set(nextId, d);
    syntheticDeclIds.push(nextId);
    nextId++;
  }

  for (const remoteInheritedId of targetClassScope.inheritedScopes) {
    const remoteInheritedScope = targetTable.scopeById.get(remoteInheritedId);
    if (!remoteInheritedScope) continue;
    for (const remoteDeclId of remoteInheritedScope.declarations) {
      const remoteDecl = targetTable.declById.get(remoteDeclId);
      if (!remoteDecl) continue;
      const d: Declaration = {
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
      table.declarations.push(d);
      table.declById.set(nextId, d);
      syntheticDeclIds.push(nextId);
      nextId++;
    }
  }

  // Recursively create nested synthetic scopes for inherited scopes, preserving
  // the full inheritance chain depth (critical for 3+ level chains like End→Middle→Base).
  const nestedScopeIds: number[] = [];
  for (const remoteInheritedId of targetClassScope.inheritedScopes) {
    const remoteInheritedScope = targetTable.scopeById.get(remoteInheritedId);
    if (!remoteInheritedScope) continue;
    // Find the class declaration for this inherited scope so we can recursively
    // create its synthetic scope.
    const remoteInheritedClass = targetTable.declarations.find(
      d => d.kind === 'class' &&
        d.scopeId === remoteInheritedScope.parentId &&
        remoteInheritedScope.range.start.line >= d.range.start.line &&
        remoteInheritedScope.range.start.line <= d.range.end.line,
    );
    if (!remoteInheritedClass) continue;
    const nestedResult = createSyntheticScope(
      table,
      { id: syntheticScopeId },
      remoteInheritedClass,
      remoteInheritedScope,
      targetTable,
      targetUri,
      nextId,
    );
    nestedScopeIds.push(nestedResult.scopeId);
    nextId = nestedResult.nextId;
  }

  const syntheticScope = {
    id: syntheticScopeId,
    kind: 'class' as const,
    range: targetClassScope.range,
    parentId: scope.id,
    declarations: syntheticDeclIds,
    inheritedScopes: nestedScopeIds,
  };
  table.scopes.push(syntheticScope);
  table.scopeById.set(syntheticScopeId, syntheticScope);

  return { scopeId: syntheticScopeId, nextId };
}
