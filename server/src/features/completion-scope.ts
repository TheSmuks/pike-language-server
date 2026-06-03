/**
 * Completion scope helpers: enumerate symbols visible at a position.
 *
 * Extracted from scopeBuilder.ts to reduce file size.
 */
import type { Declaration, SymbolTable } from './symbolTable';
import { findScopeAtPosition } from './scope-helpers';

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
 * Determine whether a declaration should be visible at the cursor position.
 * Non-class/non-file scopes only show declarations that precede the cursor.
 */
function declIsVisibleAtPosition(decl: Declaration, scopeKind: string, line: number, character: number): boolean {
  if (scopeKind === 'class' || scopeKind === 'file' || decl.kind === 'parameter') return true;
  return decl.range.start.line < line ||
    (decl.range.start.line === line && decl.range.start.character <= character);
}

/**
 * Add direct declarations from a scope into results, checking visibility and deduplication.
 */
function collectDeclarationsFromScope(
  scope: { declarations: number[]; kind: string },
  table: SymbolTable,
  line: number,
  character: number,
  seenNames: Set<string>,
  results: Declaration[],
): void {
  for (const declId of scope.declarations) {
    const decl = table.declById.get(declId);
    if (!decl) continue;
    if (decl.kind === 'inherit' || decl.kind === 'import') continue;
    if (!declIsVisibleAtPosition(decl, scope.kind, line, character)) continue;
    if (!seenNames.has(decl.name)) {
      seenNames.add(decl.name);
      results.push(decl);
    }
  }
}

/**
 * Add inherited declarations into results, checking deduplication by name.
 */
function collectInheritedDeclarations(
  scope: { inheritedScopes: number[] },
  table: SymbolTable,
  seenNames: Set<string>,
  results: Declaration[],
): void {
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

    collectDeclarationsFromScope(scope, table, line, character, seenNames, results);

    if (scope.kind === 'class') {
      collectInheritedDeclarations(scope, table, seenNames, results);
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
