/**
 * Type hierarchy provider for Pike LSP.
 *
 * Implements three LSP requests:
 * - textDocument/prepareTypeHierarchy: returns type hierarchy item at cursor
 * - typeHierarchy/supertypes: returns parent/inherited classes
 * - typeHierarchy/subtypes: returns classes that inherit from the given class
 *
 * Architecture:
 * - prepareTypeHierarchy: scans declarations for a class at the given position.
 * - getSupertypes: reads scope.inheritedScopes to find parent class scopes,
 *   then resolves each to its class declaration. Falls back to cross-file
 *   resolution via WorkspaceIndex for external inherits.
 * - getSubtypes: scans ALL indexed files for classes whose scope has the target
 *   class (by name + URI match) in inheritedScopes.
 */

import type {
  TypeHierarchyItem,
} from "vscode-languageserver/node";
import type { SymbolTable, Declaration, Scope } from "./symbolTable";
import type { WorkspaceIndex } from "./workspaceIndex";
import { SymbolKind } from "vscode-languageserver/node";

// ---------------------------------------------------------------------------
// Prepare type hierarchy
// ---------------------------------------------------------------------------

/**
 * Prepare type hierarchy items at the given position.
 * Returns the class declaration at cursor, if any.
 */
export function prepareTypeHierarchy(
  table: SymbolTable,
  uri: string,
  line: number,
  character: number,
): TypeHierarchyItem[] | null {
  const decl = findClassAtPosition(table, line, character);
  if (!decl) return null;

  return [declToTypeHierarchyItem(decl, uri)];
}

/**
 * Find the class declaration whose nameRange or body contains the position.
 */
function findClassAtPosition(
  table: SymbolTable,
  line: number,
  character: number,
): Declaration | null {
  // First: cursor directly on the class name
  for (const decl of table.declarations) {
    if (decl.kind !== "class") continue;
    const nr = decl.nameRange;
    if (
      nr.start.line === line &&
      nr.end.line === line &&
      character >= nr.start.character &&
      character < nr.end.character
    ) {
      return decl;
    }
  }

  // Second: cursor anywhere within the class body (pick innermost)
  let best: Declaration | null = null;
  let bestSize = Infinity;

  for (const decl of table.declarations) {
    if (decl.kind !== "class") continue;
    const startLine = decl.range.start.line;
    const endLine = decl.range.end.line;
    if (startLine <= line && endLine >= line) {
      // Use character-based size to break ties when classes span the same lines.
      const size = (endLine - startLine) * 10000
        + (decl.range.end.character - decl.range.start.character);
      if (size < bestSize) {
        bestSize = size;
        best = decl;
      }
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// Supertypes (parent classes)
// ---------------------------------------------------------------------------

/**
 * Get supertypes for a TypeHierarchyItem.
 * Resolves inherited classes from the class scope's inheritedScopes array,
 * plus cross-file resolution via the WorkspaceIndex.
 */
export function getSupertypes(
  index: WorkspaceIndex,
  table: SymbolTable,
  uri: string,
  item: TypeHierarchyItem,
): TypeHierarchyItem[] {
  const classDecl = findClassByItem(table, item);
  if (!classDecl) return [];

  const classScope = getClassBodyScope(table, classDecl);
  if (!classScope) return [];

  const results: TypeHierarchyItem[] = [];
  const seen = new Set<string>();

  // Resolve each inherited scope to a class declaration
  for (const inheritedScopeId of classScope.inheritedScopes) {
    const parentItem = resolveInheritedScopeToItem(
      table, inheritedScopeId, uri, seen,
    );
    if (parentItem) results.push(parentItem);
  }

  // Also check cross-file: scan inherit declarations in this class scope
  // that may not have been wired (e.g., unresolved at index time).
  collectCrossFileSupertypes(index, table, uri, classScope, results, seen);

  return results;
}

/**
 * Resolve an inherited scope ID back to a TypeHierarchyItem.
 */
function resolveInheritedScopeToItem(
  table: SymbolTable,
  scopeId: number,
  preferredUri: string,
  seen: Set<string>,
): TypeHierarchyItem | null {
  const scope = table.scopeById.get(scopeId);
  if (!scope) return null;

  // Find the class declaration that created this scope.
  // The scope's parentId is where the class was declared, and the
  // scope's range overlaps the class declaration's range.
  const parentScope = scope.parentId !== null
    ? table.scopeById.get(scope.parentId)
    : null;

  if (parentScope) {
    for (const declId of parentScope.declarations) {
      const decl = table.declById.get(declId);
      if (!decl || decl.kind !== "class") continue;
      // Check if this scope belongs to this class declaration
      if (scope.range.start.line >= decl.range.start.line &&
          scope.range.end.line <= decl.range.end.line) {
        const key = `${preferredUri}:${decl.nameRange.start.line}`;
        if (seen.has(key)) return null;
        seen.add(key);
        // If this declaration has a sourceUri, it came from cross-file
        const itemUri = decl.sourceUri ?? preferredUri;
        return declToTypeHierarchyItem(decl, itemUri);
      }
    }
  }

  return null;
}

/**
 * Check for cross-file supertypes not yet captured by inheritedScopes.
 * Scans inherit declarations in the class scope and resolves them through
 * the workspace index.
 */
function collectCrossFileSupertypes(
  index: WorkspaceIndex,
  table: SymbolTable,
  uri: string,
  classScope: Scope,
  results: TypeHierarchyItem[],
  seen: Set<string>,
): void {
  const inheritDecls = classScope.declarations
    .map(id => table.declById.get(id))
    .filter(d => d?.kind === "inherit");

  for (const inheritDecl of inheritDecls) {
    if (!inheritDecl) continue;

    // Try to find the class in any indexed file
    for (const entry of index.getAllEntries()) {
      if (!entry.symbolTable) continue;
      for (const decl of entry.symbolTable.declarations) {
        if (decl.kind !== "class") continue;
        if (decl.name !== inheritDecl.name) continue;
        const key = `${entry.uri}:${decl.nameRange.start.line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push(declToTypeHierarchyItem(decl, entry.uri));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Subtypes (child classes)
// ---------------------------------------------------------------------------

/**
 * Get subtypes for a TypeHierarchyItem.
 * Scans all indexed files for classes that inherit from the target class.
 */
export function getSubtypes(
  index: WorkspaceIndex,
  uri: string,
  item: TypeHierarchyItem,
): TypeHierarchyItem[] {
  const targetName = item.name;
  const results: TypeHierarchyItem[] = [];
  const seen = new Set<string>();

  for (const entry of index.getAllEntries()) {
    if (!entry.symbolTable) continue;
    const childItem = findSubtypeInTable(
      entry.symbolTable, entry.uri, targetName, uri, seen,
    );
    if (childItem) results.push(childItem);
  }

  return results;
}

/**
 * Search a single symbol table for classes inheriting from the target.
 */
function findSubtypeInTable(
  table: SymbolTable,
  tableUri: string,
  targetName: string,
  targetUri: string,
  seen: Set<string>,
): TypeHierarchyItem | null {
  for (const scope of table.scopes) {
    if (scope.kind !== "class") continue;

    // Check if any inherited scope corresponds to our target class
    for (const inheritedScopeId of scope.inheritedScopes) {
      const inheritedScope = table.scopeById.get(inheritedScopeId);
      if (!inheritedScope) continue;

      // Find the class declaration for the inherited scope
      const parentScope = inheritedScope.parentId !== null
        ? table.scopeById.get(inheritedScope.parentId)
        : null;
      if (!parentScope) continue;

      for (const declId of parentScope.declarations) {
        const decl = table.declById.get(declId);
        if (!decl || decl.kind !== "class") continue;
        if (decl.name !== targetName) continue;

        // Check URI match — must be same class
        const declUri = decl.sourceUri ?? tableUri;
        if (declUri !== targetUri && tableUri !== targetUri) continue;

        // This scope inherits from our target. Find the child class decl.
        const childDecl = findClassDeclForScope(table, scope);
        if (!childDecl) continue;

        const key = `${tableUri}:${childDecl.nameRange.start.line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        return declToTypeHierarchyItem(childDecl, tableUri);
      }
    }

    // Also check inherit declarations by name as a fallback
    const inheritDecls = scope.declarations
      .map(id => table.declById.get(id))
      .filter(d => d?.kind === "inherit");

    for (const inheritDecl of inheritDecls) {
      if (!inheritDecl || inheritDecl.name !== targetName) continue;

      const childDecl = findClassDeclForScope(table, scope);
      if (!childDecl) continue;

      const key = `${tableUri}:${childDecl.nameRange.start.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      return declToTypeHierarchyItem(childDecl, tableUri);
    }
  }

  return null;
}

/**
 * Find the class declaration that owns the given class scope.
 */
function findClassDeclForScope(
  table: SymbolTable,
  scope: Scope,
): Declaration | null {
  const parentScope = scope.parentId !== null
    ? table.scopeById.get(scope.parentId)
    : null;
  if (!parentScope) return null;

  for (const declId of parentScope.declarations) {
    const decl = table.declById.get(declId);
    if (!decl || decl.kind !== "class") continue;
    if (
      scope.range.start.line >= decl.range.start.line &&
      scope.range.end.line <= decl.range.end.line
    ) {
      return decl;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find the class body scope for a class declaration.
 * The class body scope is a child scope with kind 'class' whose range
 * overlaps the declaration's range.
 */
function getClassBodyScope(
  table: SymbolTable,
  classDecl: Declaration,
): Scope | null {
  for (const scope of table.scopes) {
    if (scope.kind !== "class") continue;
    if (scope.parentId !== classDecl.scopeId) continue;
    if (
      scope.range.start.line >= classDecl.range.start.line &&
      scope.range.end.line <= classDecl.range.end.line
    ) {
      return scope;
    }
  }
  return null;
}

/**
 * Find a class declaration matching a TypeHierarchyItem by position.
 */
function findClassByItem(
  table: SymbolTable,
  item: TypeHierarchyItem,
): Declaration | null {
  const line = item.selectionRange.start.line;
  for (const decl of table.declarations) {
    if (decl.kind !== "class") continue;
    if (decl.nameRange.start.line === line &&
        decl.nameRange.start.character === item.selectionRange.start.character) {
      return decl;
    }
  }
  return null;
}

/**
 * Convert a class Declaration to a TypeHierarchyItem.
 */
function declToTypeHierarchyItem(
  decl: Declaration,
  uri: string,
): TypeHierarchyItem {
  return {
    name: decl.name,
    kind: SymbolKind.Class,
    uri,
    range: {
      start: {
        line: decl.range.start.line,
        character: decl.range.start.character,
      },
      end: {
        line: decl.range.end.line,
        character: decl.range.end.character,
      },
    },
    selectionRange: {
      start: {
        line: decl.nameRange.start.line,
        character: decl.nameRange.start.character,
      },
      end: {
        line: decl.nameRange.end.line,
        character: decl.nameRange.end.character,
      },
    },
  };
}
