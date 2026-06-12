import type {
  BuildState,
  Declaration,
  Range,
  Scope,
  ScopeKind,
} from './symbolTable';

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
  const scope = state.scopeMap.get(decl.scopeId);
  if (scope) scope.declarations.push(id);
  return id;
}
