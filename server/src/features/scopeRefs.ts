/**
 * Scope-resolution for `A::member`, `::member` and `global::member`.
 *
 * Extracted from referenceCollector.ts to keep that file under the 500-line
 * TigerStyle limit — the same reason postfixRefs.ts was split out. Every
 * function here answers one question: given a scope specifier, which
 * declaration does the name after `::` refer to?
 */

import type { Node } from 'web-tree-sitter';
import type { BuildState } from './symbolTable';
import {
  findDeclInScope, findEnclosingClassScopeId, findScopeForNode, resolveName, toLoc,
} from './scope-helpers';
import { scopeQualifierText, inheritMatchesQualifier } from './scopeQualifier';

/**
 * Resolve a scoped reference (e.g., `A::method`, `::create`).
 *
 * Each qualifier selects a different scope, and Pike 8.0.1116 distinguishes
 * them. With `pown.pike` inheriting `pbase.pike` and both declaring `who()`:
 *
 *     plain=OWN  bare=INHERITED  this_program=OWN  this=OWN  local=OWN
 *
 * so a bare `::` is the ONLY one that skips the program's own declaration.
 * `this_program::onlyparent()` still reaches the parent's `onlyparent`, so the
 * inherited scopes remain a fallback rather than being excluded.
 */
export function resolveScoped(name: string, scopeNode: Node, refNode: Node, state: BuildState): number | null {
  // The grammar emits every one of these as an ANONYMOUS token, never as an
  // `identifier`, so a test for "has no identifier child" reads them all as a
  // bare `::` — which is a different scope and, for the three below, the wrong
  // answer rather than a missing one.
  const qualifier = scopeQualifierText(scopeNode);

  switch (qualifier) {
    // `global::name` names the FILE scope, ignoring anything that shadows it.
    case 'global': return resolveGlobalScopeAccess(name, state);
    // Pike's own top-level namespace. Nothing declared in this file answers
    // it; the builtin and stdlib tiers do.
    case 'predef': return null;
    case 'this': case 'this_program': case 'local':
      return resolveProgramScopeAccess(name, refNode, state);
    case '': return resolveBareScopeAccess(name, refNode, state);
    default: return resolveScopedByIdentifier(name, qualifier, refNode, state);
  }
}

/** Resolve `global::name` against the file scope, ignoring any shadowing. */
export function resolveGlobalScopeAccess(name: string, state: BuildState): number | null {
  const fileScope = state.scopes.find(s => s.kind === 'file');
  if (!fileScope) return null;
  return findDeclInScope(name, fileScope.id, state);
}

/**
 * The scope of the program a node sits in: the innermost enclosing class, or
 * the file, since a Pike source file is itself a program.
 */
function enclosingProgramScopeId(refNode: Node, state: BuildState): number | null {
  const classScopeId = findEnclosingClassScopeId(refNode, state);
  if (classScopeId !== null) return classScopeId;
  return state.scopes.find(s => s.kind === 'file')?.id ?? null;
}

/**
 * Resolve `this::`, `this_program::` and `local::` — the current program.
 *
 * `findDeclInScope` searches the scope's own declarations before its inherited
 * ones, which is exactly the order the oracle shows: the program's own `who`
 * wins, and a name only it inherits is still found.
 */
export function resolveProgramScopeAccess(name: string, refNode: Node, state: BuildState): number | null {
  const programScopeId = enclosingProgramScopeId(refNode, state);
  if (programScopeId === null) return null;
  return findDeclInScope(name, programScopeId, state);
}

/**
 * Resolve bare `::` — what the enclosing program inherits, skipping its own
 * declarations.
 *
 * Every inherit is consulted, not just the first: a file with two inherits
 * reaches members of both under Pike.
 */
export function resolveBareScopeAccess(name: string, refNode: Node, state: BuildState): number | null {
  const classScopeId = findEnclosingClassScopeId(refNode, state);
  if (classScopeId === null) return null;

  const classScope = state.scopeMap.get(classScopeId);
  if (!classScope) return null;

  for (const inheritedId of classScope.inheritedScopes) {
    const match = findDeclInScope(name, inheritedId, state);
    if (match !== null) return match;
  }
  return null;
}

/**
 * Resolve `Outer::name` where `Outer` is a lexically SURROUNDING class.
 *
 * Pike's own error text names both referents — `No inherit or surrounding
 * class Session.` — and a nested class really does reach out this way:
 * `class Session { int maxtime=1, timeout=2; class SessionQuery { …
 * Session::maxtime … } }` prints `12`, the outer class's own values. Roxen's
 * `HTTPClient.pmod` is written exactly like that.
 */
function resolveSurroundingClass(
  name: string,
  className: string,
  refNode: Node,
  state: BuildState,
): number | null {
  let scopeId: number | null = findScopeForNode(refNode, state);
  while (scopeId !== null) {
    const scope = state.scopeMap.get(scopeId);
    if (!scope) return null;
    if (scope.kind === 'class' && scope.parentId !== null) {
      const parent = state.scopeMap.get(scope.parentId);
      const owner = parent?.declarations
        .map(id => state.declMap.get(id))
        .find(d => d?.kind === 'class' && d.name === className);
      if (owner) return findDeclInScope(name, scopeId, state);
    }
    scopeId = scope.parentId;
  }
  return null;
}

/**
 * Resolve `Identifier::name` — an inherit of the enclosing program or of one
 * around it, or a surrounding class.
 *
 * The search walks OUTWARD: a nested class may name an enclosing class's
 * inherit, and Pike proves it — `class Outer { inherit "pbase" : parent;
 * class Nested { … parent::who() … } }` prints `INHERITED`. (A bare `::` in
 * that same `Nested` does not; it is program-local.)
 */
export function resolveScopedByIdentifier(
  name: string,
  inheritName: string,
  refNode: Node,
  state: BuildState,
): number | null {
  let scopeId: number | null = findEnclosingClassScopeId(refNode, state);
  while (scopeId !== null) {
    const scope = state.scopeMap.get(scopeId);
    if (!scope) break;
    for (const declId of scope.declarations) {
      const decl = state.declMap.get(declId);
      if (!decl || !inheritMatchesQualifier(decl, inheritName)) continue;

      const match = resolveInheritedScopeMember(name, decl.name, scope.inheritedScopes, state);
      if (match !== null) return match;
    }
    scopeId = scope.parentId;
  }

  return resolveSurroundingClass(name, inheritName, refNode, state);
}

/**
 * True when `scope` is the body of `classDecl`.
 *
 * A class body scope lies inside its declaration's range. Without this check a
 * qualifier resolves against whichever inherited class comes first, silently
 * returning a member of the wrong class on a name collision.
 */
function scopeIsBodyOf(
  scope: { range: { start: { line: number }; end: { line: number } } },
  classDecl: { range: { start: { line: number }; end: { line: number } } },
): boolean {
  return scope.range.start.line >= classDecl.range.start.line &&
    scope.range.start.line <= classDecl.range.end.line;
}

/** Find a member declaration in an inherited scope matching the inherit name. */
export function resolveInheritedScopeMember(
  name: string,
  inheritDeclName: string,
  inheritedScopes: number[],
  state: BuildState,
): number | null {
  for (const inheritedId of inheritedScopes) {
    const inheritedScope = state.scopeMap.get(inheritedId);
    if (!inheritedScope || inheritedScope.parentId === null) continue;

    const parentScope = state.scopeMap.get(inheritedScope.parentId);
    if (!parentScope) continue;

    for (const parentDeclId of parentScope.declarations) {
      const parentDecl = state.declMap.get(parentDeclId);
      if (!parentDecl || parentDecl.kind !== 'class') continue;
      if (parentDecl.name !== inheritDeclName) continue;
      // The class must be the one this scope is the BODY of. Matching on name
      // alone is not enough: every class body shares the file scope as its
      // parent, so `class B` is visible from `class A`'s scope too — which made
      // `B::value()` resolve to A::value whenever A was inherited first.
      if (!scopeIsBodyOf(inheritedScope, parentDecl)) continue;
      return findDeclInScope(name, inheritedId, state);
    }
  }
  return null;
}

/**
 * Record the qualifier of a scoped access — the `A` in `A::value()`.
 *
 * The qualifier names a class, exactly like a type reference does, so it
 * resolves the same way. Without this the qualifier has no entry in the
 * reference table at all, and every position-driven feature — definition,
 * declaration, references, hover, completion, documentHighlight — returns
 * null there while the member after `::` resolves fine.
 *
 * Bare `::` has no identifier child and is skipped: there is no qualifier to
 * point at.
 */
export function collectScopeQualifierRef(scopeNode: Node, state: BuildState): void {
  if (scopeNode.type !== 'inherit_specifier') return;
  const qualifier = scopeNode.children.find(c => c.type === 'identifier');
  if (!qualifier) return;

  const declId = resolveName(qualifier.text, qualifier, state);
  state.references.push({
    name: qualifier.text,
    loc: toLoc(qualifier.startPosition),
    kind: 'type_ref',
    resolvesTo: declId,
    confidence: declId !== null ? 'high' : 'low',
  });
}
