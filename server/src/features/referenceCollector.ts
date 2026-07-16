/**
 * Reference collector: walks the tree-sitter AST to collect
 * references and resolve them against the symbol table (pass 2).
 *
 * Extracted from symbolTable.ts (US-032/US-033).
 */
import type { Node } from 'web-tree-sitter';
import type { BuildState } from './symbolTable';
import { toLocUtf16 } from './scope-helpers';
import { lookupUtf16 } from '../util/offsetMap';
import {
  findScopeForNode,
  findEnclosingClassScopeId,
  findEnclosingClassDecl,
  findDeclInScope,
} from './scope-helpers';
import { collectPostfixRef } from './postfixRefs';

// ---------------------------------------------------------------------------
// Reference collection and resolution
// ---------------------------------------------------------------------------

/**
 * Node types `collectReferences` treats specially — either dispatched to a
 * handler or skipped entirely (inherit/import). The cursor descent below
 * materializes a JS node object ONLY for these types; all other nodes are
 * passed through inside the WASM cursor. Keep in sync with the switch in
 * `collectReferences`.
 */
const DISPATCHED_REF_TYPES = new Set<string>([
  'identifier_expr',
  'scope_expr',
  'this_expr',
  'postfix_expr',
  'type',
  'function_decl',
  'inherit_decl',
  'import_decl',
]);

/**
 * Collect references by walking the tree.
 */
export function collectReferences(node: Node, state: BuildState): void {
  // MISSING nodes are zero-width recovery tokens with no source to reference.
  if (node.isMissing) return;

  // Descend into ERROR nodes to collect references tree-sitter recovered inside
  // them (same rationale as collectDeclarations): partial-parse states during
  // editing must still produce reference tokens rather than clearing the file.
  if (node.isError) {
    descendForReferences(node, state, false);
    return;
  }

  // Skip reference collection inside inherit_decl — the inherit declaration
  // itself represents the relationship; the path identifier should not be
  // collected as a separate reference.
  if (node.type === 'inherit_decl' || node.type === 'import_decl') {
    return;
  }

  switch (node.type) {
    case 'identifier_expr':
      collectIdentifierRef(node, state);
      break;
    case 'scope_expr':
      collectScopeRef(node, state);
      break;
    case 'this_expr':
      collectThisRef(node, state);
      break;
    case 'postfix_expr':
      collectPostfixRef(node, state);
      break;
    case 'type':
      collectTypeRef(node, state);
      break;
    case 'function_decl':
      // Collect return type references for rename-through-return-types.
      // When renaming class Dog → Cat, `Dog f()` should also be renamed.
      collectFunctionReturnTypeRefs(node, state);
      break;
    default:
      break;
  }

  // Recurse into children, but skip return_type on function_decl — it's
  // already handled by collectFunctionReturnTypeRefs above. This prevents
  // the generic type walker from collecting duplicate type_refs for the
  // return type identifier.
  descendForReferences(node, state, node.type === 'function_decl');
}

/**
 * Generic descent through `node`'s subtree using a tree-sitter cursor.
 *
 * `for (const child of node.children)` materializes a JS wrapper (plus a
 * children array) for every node visited. Reference-free subtrees dominate
 * data-heavy files — a 216KB stdlib table file parses to 378k nodes, ~95% of
 * them literal/precedence-cascade nodes — and the wrapper churn cost ~70MB
 * of allocator high-water per walk. The cursor walks inside WASM; only nodes
 * whose type the reference switch dispatches get materialized, and those
 * re-enter `collectReferences`, which owns their subtree.
 *
 * @param skipReturnType Skip direct `return_type` children of `node`
 *   (function_decl return types are collected by
 *   `collectFunctionReturnTypeRefs`, not the generic walk).
 */
function descendForReferences(node: Node, state: BuildState, skipReturnType: boolean): void {
  const cursor = node.walk();
  if (!cursor.gotoFirstChild()) {
    cursor.delete();
    return;
  }

  // depth = how far the cursor is below `node`; the walk never escapes the
  // subtree because we stop when depth returns to 0.
  let depth = 1;
  // Bounded: a finite tree — every iteration descends, advances to a sibling,
  // or retreats toward `node`, and the walk ends when depth returns to 0.
  for (;;) {
    let enterChildren = false;
    // Missing nodes are zero-width recovery leaves — nothing to reference.
    if (!cursor.nodeIsMissing) {
      const type = cursor.nodeType;
      const skipped = skipReturnType && depth === 1 && type === 'return_type';
      if (!skipped) {
        if (DISPATCHED_REF_TYPES.has(type)) {
          // collectReferences dispatches this node and descends its subtree
          // itself, so the walk must not enter its children again.
          collectReferences(cursor.currentNode, state);
        } else {
          enterChildren = true;
        }
      }
    }

    if (enterChildren && cursor.gotoFirstChild()) {
      depth++;
      continue;
    }
    // Bounded: retreats one level per iteration, at most `depth` levels.
    for (;;) {
      if (cursor.gotoNextSibling()) break;
      depth--;
      if (depth === 0 || !cursor.gotoParent()) {
        cursor.delete();
        return;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Function return type references
// ---------------------------------------------------------------------------

/**
 * Collect function return type references.
 * For `Dog f()`, collects `Dog` as a type_ref to the Dog class declaration.
 * This enables rename-through-return-types: renaming Dog → Cat also updates `Dog f()`.
 */
function collectFunctionReturnTypeRefs(node: Node, state: BuildState): void {
  const returnType = node.childForFieldName('return_type');
  if (!returnType) return;

  // Walk the return_type subtree to find id_type > identifier
  collectReturnTypeIdRecursive(returnType, state);
}

function collectReturnTypeIdRecursive(node: Node, state: BuildState): void {
  for (const child of node.children) {
    if (child.type === 'id_type') {
      const identChild = child.children.find(c => c.type === 'identifier');
      if (identChild) {
        const name = identChild.text;
        const declId = resolveName(name, identChild, state);
        state.references.push({
          name,
          loc: toLocUtf16(identChild.startPosition, state.lines, state.offsetMap),
          kind: 'type_ref',
          resolvesTo: declId,
          confidence: declId !== null ? 'high' : 'low',
        });
      }
    } else if (
      child.type === 'type' ||
      child.type === 'union_type' ||
      child.type === 'intersection_type' ||
      child.type === 'generic_type' ||
      child.type === 'function_type' ||
      child.type === 'array_type' ||
      child.type === 'mapping_type' ||
      child.type === 'multiset_type'
    ) {
      collectReturnTypeIdRecursive(child, state);
    }
  }
}

// ---------------------------------------------------------------------------
// Identifier, scope, this, and postfix references
// ---------------------------------------------------------------------------

function collectIdentifierRef(node: Node, state: BuildState): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;

  const name = nameNode.text;
  const declId = resolveName(name, node, state);
  const kind = isCallTargetIdentifier(node) ? 'call' : 'identifier';

  state.references.push({
    name,
    loc: toLocUtf16(nameNode.startPosition, state.lines, state.offsetMap),
    kind,
    resolvesTo: declId,
    confidence: declId !== null ? 'high' : 'low',
  });
}

/**
 * Return true when an identifier_expr is the callee in `name(...)`.
 *
 * tree-sitter-pike represents calls as a postfix_expr with the callee in the
 * first child and an argument_list later in the same postfix_expr. Checking the
 * first-child spine keeps ordinary arguments (`write(arglist)`) as identifiers
 * while classifying the unresolved callee (`write`) as a function-shaped token.
 */
function isCallTargetIdentifier(node: Node): boolean {
  let callee: Node = node;
  while (callee.parent && isTransparentCalleeWrapper(callee.parent, callee)) {
    callee = callee.parent;
  }

  const call = callee.parent;
  if (!call || call.type !== 'postfix_expr') return false;
  const firstChild = call.child(0);
  if (!firstChild || !sameNodeRange(firstChild, callee)) return false;
  return call.children.some(child => child.type === 'argument_list');
}

function isTransparentCalleeWrapper(parent: Node, child: Node): boolean {
  if (parent.type !== 'primary_expr' && parent.type !== 'postfix_expr') return false;
  if (parent.type === 'postfix_expr' && parent.childCount !== 1) return false;
  const firstChild = parent.child(0);
  if (!firstChild || !sameNodeRange(firstChild, child)) return false;
  return !parent.children.some(node => node.type === 'argument_list');
}

function sameNodeRange(a: Node, b: Node): boolean {
  return a.startPosition.row === b.startPosition.row &&
    a.startPosition.column === b.startPosition.column &&
    a.endPosition.row === b.endPosition.row &&
    a.endPosition.column === b.endPosition.column;
}

function collectScopeRef(node: Node, state: BuildState): void {
  const nameNode = node.childForFieldName('name');
  const scopeNode = node.childForFieldName('scope');
  if (!nameNode) return;

  const name = nameNode.text;

  // Resolve via scope specifier (e.g., A::foo, ::create)
  let declId: number | null = null;
  if (scopeNode) {
    declId = resolveScoped(name, scopeNode, node, state);
  }

  state.references.push({
    name,
    loc: toLocUtf16(nameNode.startPosition, state.lines, state.offsetMap),
    kind: 'scope_access',
    resolvesTo: declId,
    confidence: declId !== null ? 'medium' : 'low',
  });
}

function collectThisRef(node: Node, state: BuildState): void {
  // Find enclosing class scope
  const classDecl = findEnclosingClassDecl(node, state);
  state.references.push({
    name: node.text,
    loc: toLocUtf16(node.startPosition, state.lines, state.offsetMap),
    kind: 'this_ref',
    resolvesTo: classDecl,
    confidence: classDecl !== null ? 'high' : 'low',
  });
}

// ---------------------------------------------------------------------------
// Type references
// ---------------------------------------------------------------------------

function collectTypeRef(node: Node, state: BuildState): void {
  // Walk for id_type children which contain user-defined type references
  collectTypeRefsRecursive(node, state);
}

function collectTypeRefsRecursive(node: Node, state: BuildState): void {
  for (const child of node.children) {
    if (child.type === 'id_type') {
      // id_type contains identifier or scope_expr
      const identChild = child.children.find(c => c.type === 'identifier');
      if (identChild) {
        const name = identChild.text;
        const declId = resolveName(name, identChild, state);
        state.references.push({
          name,
          loc: toLocUtf16(identChild.startPosition, state.lines, state.offsetMap),
          kind: 'type_ref',
          resolvesTo: declId,
          confidence: declId !== null ? 'high' : 'low',
        });
      }
    } else if (
      child.type === 'type' ||
      child.type === 'union_type' ||
      child.type === 'intersection_type' ||
      child.type === 'generic_type' ||
      child.type === 'function_type' ||
      child.type === 'array_type' ||
      child.type === 'mapping_type' ||
      child.type === 'multiset_type'
    ) {
      collectTypeRefsRecursive(child, state);
    }
  }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a name by walking the scope chain from innermost to outermost.
 * Returns the Declaration ID of the first matching declaration, or null.
 */
function resolveName(name: string, refNode: Node, state: BuildState): number | null {
  // Find which scope contains the reference
  const refScopeId = findScopeForNode(refNode, state);
  if (refScopeId === null) return null;

  // Walk scope chain outward
  let scopeId: number | null = refScopeId;
  // Bounded: each iteration moves to parentId in the finite scope tree.
  while (scopeId !== null) {
    const scope = state.scopeMap.get(scopeId);
    if (!scope) break;

    // Check declarations in this scope
    for (const declId of scope.declarations) {
      const decl = state.declMap.get(declId);
      if (decl && decl.name === name) {
        // For non-class scopes, check that declaration is before reference
        // (class scope is flat — no ordering constraint)
        if (scope.kind === 'class' || decl.kind === 'parameter') {
          return declId;
        }
        if (scope.kind === 'file') {
          // File scope: ordering doesn't matter for top-level declarations
          return declId;
        }
        // Block/function scope: declaration must be before reference
        const refColUtf16 = lookupUtf16(state.offsetMap, refNode.startPosition.row, refNode.startPosition.column);
        if (decl.range.start.line < refNode.startPosition.row ||
            (decl.range.start.line === refNode.startPosition.row &&
             decl.range.start.character <= refColUtf16)) {
          return declId;
        }
      }
    }

    // For class scopes, also check inherited scopes
    if (scope.kind === 'class') {
      for (const inheritedId of scope.inheritedScopes) {
        const match = findDeclInScope(name, inheritedId, state);
        if (match !== null) return match;
      }
    }

    scopeId = scope.parentId;
  }

  return null;
}

/**
 * Resolve a scoped reference (e.g., `A::method`, `::create`).
 */
function resolveScoped(name: string, scopeNode: Node, refNode: Node, state: BuildState): number | null {
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

/** Resolve bare `::` scope access to the first inherited class. */
function resolveBareScopeAccess(name: string, refNode: Node, state: BuildState): number | null {
  const classScopeId = findEnclosingClassScopeId(refNode, state);
  if (classScopeId === null) return null;

  const classScope = state.scopeMap.get(classScopeId);
  if (!classScope || classScope.inheritedScopes.length === 0) return null;

  return findDeclInScope(name, classScope.inheritedScopes[0], state);
}

/** Resolve `Identifier::name` scoped access by inherit alias or path name. */
function resolveScopedByIdentifier(
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
function resolveInheritedScopeMember(
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
