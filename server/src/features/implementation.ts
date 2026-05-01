/**
 * Find implementations: locate classes that inherit from the class at a
 * given position.
 *
 * Strategy:
 * 1. Resolve the declaration at (uri, line, character).
 * 2. If it is a class, scan all indexed files for class scopes that
 *    contain an `inherit` declaration matching the target class name.
 * 3. For cross-file matches, only consider files that list the source
 *    file as a direct dependency (avoids false positives from unrelated
 *    files with same-name classes).
 */

import {
  getDefinitionAt,
  type Declaration,
  type Scope,
  type SymbolTable,
} from "./symbolTable";
import { containsRange } from "./scopeBuilder";
import type { WorkspaceIndex } from "./workspaceIndex";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ImplementationLocation {
  uri: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

/**
 * Find all classes that directly inherit from the class at the given position.
 *
 * Returns an array of locations pointing to the inheriting class declarations.
 */
export function findImplementations(
  index: WorkspaceIndex,
  uri: string,
  line: number,
  character: number,
): ImplementationLocation[] {
  const table = index.getSymbolTable(uri);
  if (!table) return [];

  const decl = getDefinitionAt(table, line, character);
  if (!decl || decl.kind !== "class") return [];

  const targetName = decl.name;
  const results: ImplementationLocation[] = [];

  for (const entry of index.getAllEntries()) {
    if (!entry.symbolTable) continue;

    const depTable = entry.symbolTable;
    const isSameFile = entry.uri === uri;

    // Cross-file: only consider files with a direct dependency on the source.
    if (!isSameFile && !entry.dependencies.has(uri)) continue;

    collectImplementationsInTable(depTable, entry.uri, targetName, results);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

/**
 * Scan a single symbol table for class scopes that inherit `targetName`.
 */
function collectImplementationsInTable(
  table: SymbolTable,
  fileUri: string,
  targetName: string,
  results: ImplementationLocation[],
): void {
  for (const scope of table.scopes) {
    if (scope.kind !== "class") continue;

    const hasMatch = scope.declarations.some((id) => {
      const d = table.declById.get(id);
      return d?.kind === "inherit" && d.name === targetName;
    });

    if (!hasMatch) continue;

    const classDecl = findClassDeclForScope(table, scope);
    if (!classDecl) continue;

    results.push({
      uri: fileUri,
      range: classDecl.nameRange,
    });
  }
}

/**
 * Map a class body scope back to its class declaration.
 *
 * A class body scope's `parentId` is the scope containing the class
 * declaration. We search that parent for a class declaration whose range
 * encompasses the scope's range.
 */
function findClassDeclForScope(
  table: SymbolTable,
  classScope: Scope,
): Declaration | null {
  if (classScope.parentId === null) return null;

  const parentScope = table.scopeById.get(classScope.parentId);
  if (!parentScope) return null;

  for (const declId of parentScope.declarations) {
    const decl = table.declById.get(declId);
    if (!decl || decl.kind !== "class") continue;
    if (decl.scopeId !== classScope.parentId) continue;
    if (containsRange(decl.range, classScope.range)) return decl;
  }

  return null;
}
