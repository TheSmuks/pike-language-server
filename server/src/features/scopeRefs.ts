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
import { findDeclInScope, findEnclosingClassScopeId } from './scope-helpers';

/**
 * Resolve a scoped reference (e.g., `A::method`, `::create`).
 */
export function resolveScoped(name: string, scopeNode: Node, refNode: Node, state: BuildState): number | null {
  // `global::name` names the FILE scope. The token is `global`, not an
  // identifier, so without this it fell through to the bare-`::` branch below
  // and resolved to the first inherited class — a different scope entirely,
  // and the opposite of what the user wrote `global::` to ask for.
  if (scopeNode.children.some(c => c.type === 'global')) {
    return resolveGlobalScopeAccess(name, state);
  }

  // Bare `::` means parent scope (first inherited class)
  // The inherit_specifier for bare `::` has only the `::` token as child
  const isBareScope = scopeNode.type === 'inherit_specifier' &&
    !scopeNode.children.some(c => c.type === 'identifier');
  if (isBareScope) {
    return resolveBareScopeAccess(name, refNode, state);
  }

  // Identifier::name — resolve identifier to inherited class by alias or name
  const firstIdent = scopeNode.children.find(c => c.type === 'identifier');
  if (firstIdent) {
    return resolveScopedByIdentifier(name, firstIdent.text, refNode, state);
  }

  return null;
}

/** Resolve `global::name` against the file scope, ignoring any shadowing. */
export function resolveGlobalScopeAccess(name: string, state: BuildState): number | null {
  const fileScope = state.scopes.find(s => s.kind === 'file');
  if (!fileScope) return null;
  return findDeclInScope(name, fileScope.id, state);
}

/** Resolve bare `::` scope access to the first inherited class. */
export function resolveBareScopeAccess(name: string, refNode: Node, state: BuildState): number | null {
  const classScopeId = findEnclosingClassScopeId(refNode, state);
  if (classScopeId === null) return null;

  const classScope = state.scopeMap.get(classScopeId);
  if (!classScope || classScope.inheritedScopes.length === 0) return null;

  return findDeclInScope(name, classScope.inheritedScopes[0], state);
}

/** Resolve `Identifier::name` scoped access by inherit alias or path name. */
export function resolveScopedByIdentifier(
  name: string,
  inheritName: string,
  refNode: Node,
  state: BuildState,
): number | null {
  const classScopeId = findEnclosingClassScopeId(refNode, state);
  if (classScopeId === null) return null;

  const classScope = state.scopeMap.get(classScopeId);
  if (!classScope) return null;

  for (const declId of classScope.declarations) {
    const decl = state.declMap.get(declId);
    if (!decl || decl.kind !== 'inherit') continue;
    if (decl.alias !== inheritName && decl.name !== inheritName) continue;

    const match = resolveInheritedScopeMember(name, decl.name, classScope.inheritedScopes, state);
    if (match !== null) return match;
  }

  return null;
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
      if (parentDecl && parentDecl.kind === 'class' && parentDecl.name === inheritDeclName) {
        return findDeclInScope(name, inheritedId, state);
      }
    }
  }
  return null;
}
