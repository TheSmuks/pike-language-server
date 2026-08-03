import type { SymbolTable, Declaration, Reference } from './symbolTable';
import { resolveTypeName } from './scope-helpers';

// ---------------------------------------------------------------------------
// Public query API
// ---------------------------------------------------------------------------

/**
 * True when a declaration's ranges are coordinates in this table's own file.
 *
 * `wireInheritance` and `wireIncludes` clone declarations out of inherited and
 * `#include`d files into this table so references can resolve to them. A clone
 * keeps the *other* file's line and character numbers and records where it came
 * from in `sourceUri`. Matching a cursor position against those coordinates
 * compares two different files' geometry: that is how CTRL+CLICK on a call
 * answered an unrelated line of an included header.
 *
 * Resolution by name or by reference is unaffected — only queries that ask
 * "what is written at this position" must exclude clones.
 */
export function isWrittenInFile(table: SymbolTable, decl: Declaration): boolean {
  return decl.sourceUri === undefined || decl.sourceUri === table.uri;
}

/**
 * Find the declaration at a given position (for go-to-definition).
 */
export function getDefinitionAt(
  table: SymbolTable,
  line: number,
  character: number,
): Declaration | null {
  // Find a reference at this position.
  // References store only the start position, so check if the cursor is
  // anywhere within the identifier name (start..start+name.length).
  for (const ref of table.references) {
    if (ref.loc.line === line) {
      const nameStart = ref.loc.character;
      const nameEnd = nameStart + ref.name.length;
      if (character >= nameStart && character < nameEnd) {
        if (ref.resolvesTo !== null) {
          return table.declById.get(ref.resolvesTo) ?? null;
        }
      }
    }
  }

  // Also check if the position is on a declaration name itself
  for (const decl of table.declarations) {
    if (!isWrittenInFile(table, decl)) continue;
    const nr = decl.nameRange;
    if (nr.start.line === line && nr.end.line === line &&
        character >= nr.start.character && character < nr.end.character) {
      // For inherit declarations, follow through to the target class.
      // If the target isn't resolvable locally (external module), return
      // null so the caller falls through to cross-file resolution.
      if (decl.kind === 'inherit' || decl.kind === 'import') {
        const target = resolveInheritToClass(decl, table);
        if (target) return target;
        return null;
      }
      return decl;
    }
    // For inherit declarations with alias, also check the alias position
    if (decl.kind === 'inherit' && decl.alias) {
      // The alias is in the range but after the nameRange
      // Check if the position is within the declaration range and matches the alias text
      if (decl.range.start.line === line && decl.range.end.line === line &&
          character >= decl.range.start.character && character < decl.range.end.character) {
        // Verify it's actually on the alias by checking the source text
        const target = resolveInheritToClass(decl, table);
        if (target) return target;
      }
    }
  }
  return null;
}

/**
 * The declaration whose own name sits under the cursor, in this file.
 *
 * Unlike getDefinitionAt this never follows an inherit or import through to
 * what it names. Go-to-definition wants the target and answers null when the
 * target is in another file, so navigation can resolve it cross-file. Document
 * highlight and `includeDeclaration` want the opposite: the occurrence the
 * cursor is on, which for `import Stdio;` is the word `Stdio` right there.
 */
export function getLocalDeclarationAt(
  table: SymbolTable,
  line: number,
  character: number,
): Declaration | null {
  for (const decl of table.declarations) {
    if (!isWrittenInFile(table, decl)) continue;
    if (declOccurrenceRangeAt(decl, line, character)) return decl;
  }
  return null;
}

/**
 * The written occurrence of a declaration's name at a position, or null.
 *
 * An inherit has two: the path it names and, when renamed, the alias. Only the
 * alias is a name this file introduces — `inherit "engine.pike" : motor;` puts
 * `motor` in scope and nothing called `"engine.pike"` — so a position query
 * must be able to land on either and say which.
 */
export function declOccurrenceRangeAt(
  decl: Declaration,
  line: number,
  character: number,
): Declaration['nameRange'] | null {
  for (const range of [decl.nameRange, decl.aliasRange]) {
    if (!range) continue;
    if (range.start.line === line && range.end.line === line &&
        character >= range.start.character && character < range.end.character) {
      return range;
    }
  }
  return null;
}

/**
 * Resolve an inherit declaration to the target class declaration.
 * Returns the class Declaration if found, null otherwise.
 */
// Note: matches by name within the wired parent scope. Pike does not support
// multiple classes with the same name in the same scope, so the first match is correct.

function resolveInheritToClass(decl: Declaration, table: SymbolTable): Declaration | null {
  // Find the class scope that contains this inherit declaration
  const classScope = table.scopeById.get(decl.scopeId);
  if (!classScope) return null;

  // Find the inherited scope wired by wireInheritance
  const parentScope = classScope.parentId !== null
    ? table.scopeById.get(classScope.parentId)
    : null;
  if (!parentScope) return null;

  for (const parentDeclId of parentScope.declarations) {
    const parentDecl = table.declById.get(parentDeclId);
    if (parentDecl && parentDecl.kind === 'class' && parentDecl.name === decl.name) {
      return parentDecl;
    }
  }
  return null;
}

/**
 * Find a declaration by name that is visible at the given line.
 * Searches scopes from innermost to outermost.
 */
function findDeclInScopeAt(
  table: SymbolTable,
  name: string,
  line: number,
): Declaration | undefined {
  // Find the innermost scope containing this line.
  let bestScopeId: number | null = null;
  let bestDepth = -1;
  for (const scope of table.scopes) {
    if (line >= scope.range.start.line && line <= scope.range.end.line) {
      let depth = 0;
      let parentId = scope.parentId;
      while (parentId !== null) {
        depth++;
        const parent = table.scopeById.get(parentId);
        if (!parent) break;
        parentId = parent.parentId;
      }
      if (depth > bestDepth) {
        bestDepth = depth;
        bestScopeId = scope.id;
      }
    }
  }

  // Walk up scopes to find the declaration
  let scopeId = bestScopeId;
  while (scopeId !== null) {
    const scope = table.scopeById.get(scopeId);
    if (!scope) break;
    for (const declId of scope.declarations) {
      const decl = table.declById.get(declId);
      if (decl && decl.name === name) return decl;
    }
    scopeId = scope.parentId;
  }

  return undefined;
}

/**
 * Check if a declaration is a member (direct or inherited) of a class.
 *
 * classDecl.scopeId is the scope CONTAINING the class (e.g., file scope),
 * not the class body scope. We find the class body scope by looking for a
 * child scope with kind === 'class'.
 */
function isMemberOfClass(
  table: SymbolTable,
  targetDeclId: number,
  classDecl: Declaration,
): boolean {
  // Find the class body scope — it's a child scope with kind 'class'
  // whose range matches the class declaration's range.
  let classBodyScope = null;
  for (const scope of table.scopes) {
    if (scope.parentId === classDecl.scopeId && scope.kind === 'class' &&
        scope.range.start.line >= classDecl.range.start.line &&
        scope.range.end.line <= classDecl.range.end.line) {
      classBodyScope = scope;
      break;
    }
  }
  if (!classBodyScope) return false;

  // Direct member of the class body scope
  if (classBodyScope.declarations.includes(targetDeclId)) return true;

  // Inherited member
  for (const inheritedScopeId of classBodyScope.inheritedScopes) {
    const inheritedScope = table.scopeById.get(inheritedScopeId);
    if (inheritedScope?.declarations.includes(targetDeclId)) return true;
  }

  return false;
}

/**
 * Find all references to a declaration (for find-references).
 */
export function getReferencesTo(
  table: SymbolTable,
  line: number,
  character: number,
): Reference[] {
  const targetDeclId = findDeclIdAtPosition(table, line, character);
  if (targetDeclId === null) return collectSiblingUnresolvedRefs(table, line, character);

  const results = collectResolvedReferences(table, targetDeclId);
  collectUnresolvedArrowDotRefs(table, targetDeclId, results);
  return results;
}

/**
 * Occurrences of a name whose declaration this file cannot see.
 *
 * A member of an imported module, a macro from an include, a method reached
 * through `->` on an untyped receiver: the reference is recorded with
 * `resolvesTo: null`, and every position query treated that as "nothing here".
 * The declaration is indeed elsewhere, but the uses *in this file* are known,
 * and they are what document-local callers are asking for.
 *
 * Matching is by name and by receiver: `a->greet()` and `b->greet()` are two
 * different symbols that happen to share a name, so an unresolved member only
 * ever groups with uses reached the same way.
 */
function collectSiblingUnresolvedRefs(
  table: SymbolTable,
  line: number,
  character: number,
): Reference[] {
  const anchor = table.references.find(
    r => r.resolvesTo === null && r.loc.line === line &&
      character >= r.loc.character && character < r.loc.character + r.name.length,
  );
  if (!anchor) return [];

  const results: Reference[] = [];
  const seenLocs = new Set<string>();
  for (const ref of table.references) {
    if (ref.resolvesTo !== null || ref.name !== anchor.name) continue;
    if (ref.lhsName !== anchor.lhsName) continue;
    const locKey = `${ref.loc.line}:${ref.loc.character}`;
    if (seenLocs.has(locKey)) continue;
    seenLocs.add(locKey);
    results.push(ref);
  }
  return results;
}

/** Find the declaration ID at the given position (declaration or reference). */
function findDeclIdAtPosition(
  table: SymbolTable,
  line: number,
  character: number,
): number | null {
  // Check declarations first. Clones from an inherited or #include'd file carry
  // that file's coordinates, so matching a position against them anchored the
  // whole reference set to another document's geometry — document highlight
  // painted a 6-character range onto a blank line, and rename offered to write
  // there.
  for (const decl of table.declarations) {
    if (!isWrittenInFile(table, decl)) continue;
    if (declOccurrenceRangeAt(decl, line, character)) return decl.id;
  }

  // Check references
  for (const ref of table.references) {
    if (ref.loc.line === line) {
      const nameStart = ref.loc.character;
      const nameEnd = nameStart + ref.name.length;
      if (character >= nameStart && character < nameEnd) {
        return ref.resolvesTo;
      }
    }
  }
  return null;
}

/** Collect deduplicated references that resolve to a given declaration. */
function collectResolvedReferences(table: SymbolTable, targetDeclId: number): Reference[] {
  const results: Reference[] = [];
  const seenLocs = new Set<string>();
  for (const ref of table.references) {
    // `this`, `this_object()` and `this_program` bind to the enclosing class so
    // that go-to-definition on them lands there — which is correct, and stays
    // correct: that path reads table.references directly. They are NOT written
    // occurrences of the class name, and everything downstream of here rewrites
    // or paints what it is handed. Renaming `Builder` to `Maker` turned
    // `return this;` into `return Maker;`, which returns the program instead of
    // the instance; the corpus fixture stopped running.
    if (ref.kind === 'this_ref') continue;
    if (ref.resolvesTo === targetDeclId) {
      const locKey = `${ref.loc.line}:${ref.loc.character}`;
      if (!seenLocs.has(locKey)) {
        seenLocs.add(locKey);
        results.push(ref);
      }
    }
  }
  return results;
}

/** Append unresolved arrow/dot access refs matching the target by name (type-aware). */
function collectUnresolvedArrowDotRefs(
  table: SymbolTable,
  targetDeclId: number,
  results: Reference[],
): void {
  const targetDecl = table.declById.get(targetDeclId);
  if (!targetDecl) return;

  const targetName = targetDecl.name;
  for (const ref of table.references) {
    if (ref.resolvesTo === null && ref.name === targetName &&
        (ref.kind === 'arrow_access' || ref.kind === 'dot_access')) {
      if (ref.lhsName && !lhsTypeContainsDecl(table, targetDeclId, ref)) continue;
      results.push(ref);
    }
  }
}

/** Check whether the LHS variable's declared type contains the target declaration. */
function lhsTypeContainsDecl(table: SymbolTable, targetDeclId: number, ref: Reference): boolean {
  if (!ref.lhsName) return true; // no LHS name — include by default
  const lhsDecl = findDeclInScopeAt(table, ref.lhsName, ref.loc.line);
  const lhsTypeName = lhsDecl ? resolveTypeName(lhsDecl) : null;
  if (!lhsTypeName) return true; // no type info — include by default
  const typeClass = table.declarations.find(
    d => d.kind === 'class' && d.name === lhsTypeName,
  );
  if (!typeClass) return true; // unknown type — include
  return isMemberOfClass(table, targetDeclId, typeClass);
}
