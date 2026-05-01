/**
 * Reference collector: walks the tree-sitter AST to collect
 * references and resolve them against the symbol table (pass 2).
 *
 * Extracted from symbolTable.ts (US-032/US-033).
 */
import type { Node } from 'web-tree-sitter';
import type { BuildState } from './symbolTable';
import {
  toLoc,
  findScopeForNode,
  findEnclosingClassScopeId,
  findEnclosingClassDecl,
  findDeclInScope,
} from './scopeBuilder';

// ---------------------------------------------------------------------------
// Reference collection and resolution
// ---------------------------------------------------------------------------

/**
 * Collect references by walking the tree.
 */
export function collectReferences(node: Node, state: BuildState): void {
  if (node.isError || node.isMissing) return;

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
    default:
      break;
  }

  // Recurse into children
  for (const child of node.children) {
    collectReferences(child, state);
  }
}

function collectIdentifierRef(node: Node, state: BuildState): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;

  const name = nameNode.text;
  const declId = resolveName(name, node, state);

  state.references.push({
    name,
    loc: toLoc(nameNode.startPosition),
    kind: 'identifier',
    resolvesTo: declId,
    confidence: declId !== null ? 'high' : 'low',
  });
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
    loc: toLoc(nameNode.startPosition),
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
    loc: toLoc(node.startPosition),
    kind: 'this_ref',
    resolvesTo: classDecl,
    confidence: classDecl !== null ? 'high' : 'low',
  });
}

/**
 * Extract the leftmost identifier text from a postfix_expr chain.
 * For d->bark, the LHS postfix_expr contains [primary_expr [identifier_expr [identifier 'd']]].
 * Returns the identifier text, or undefined if not found.
 */
function extractLhsIdentifier(lhsNode: Node | undefined): string | undefined {
  if (!lhsNode) return undefined;
  if (lhsNode.type === 'identifier') return lhsNode.text;
  // Drill into first child recursively
  if (lhsNode.childCount > 0) {
    return extractLhsIdentifier(lhsNode.child(0)!);
  }
  return undefined;
}

function collectPostfixRef(node: Node, state: BuildState): void {
  // postfix_expr is polymorphic — dispatch based on children
  const children = node.children;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    // Arrow access: `obj->member`
    if (child.type === '->' || child.type === '->?' || child.type === '?->') {
      const memberNode = children[i + 1];
      if (memberNode && (memberNode.type === 'identifier' || memberNode.type === 'magic_identifier')) {
        // Capture LHS identifier for type-aware filtering (US-004).
        const lhsName = extractLhsIdentifier(children[i - 1]);
        state.references.push({
          name: memberNode.text,
          loc: toLoc(memberNode.startPosition),
          kind: 'arrow_access',
          resolvesTo: null, // TODO: resolve through object type (Phase 3 basic)
          confidence: 'low',
          lhsName,
        });
      }
    }
    // Dot access: `Module.member`
    if (child.type === '.') {
      const memberNode = children[i + 1];
      if (memberNode && memberNode.type === 'identifier') {
        const lhsName = extractLhsIdentifier(children[i - 1]);
        state.references.push({
          name: memberNode.text,
          loc: toLoc(memberNode.startPosition),
          kind: 'dot_access',
          resolvesTo: null, // Cross-file for now
          confidence: 'low',
          lhsName,
        });
      }
    }
  }
}

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
          loc: toLoc(identChild.startPosition),
          kind: 'type_ref',
          resolvesTo: declId,
          confidence: declId !== null ? 'high' : 'low',
        });
      }
    } else if (child.type === 'type' || child.type === 'union_type' || child.type === 'intersection_type') {
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
        if (decl.range.start.line < refNode.startPosition.row ||
            (decl.range.start.line === refNode.startPosition.row &&
             decl.range.start.character <= refNode.startPosition.column)) {
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
    const classScopeId = findEnclosingClassScopeId(refNode, state);
    if (classScopeId !== null) {
      const classScope = state.scopeMap.get(classScopeId);
      if (classScope && classScope.inheritedScopes.length > 0) {
        const firstInherited = classScope.inheritedScopes[0];
        return findDeclInScope(name, firstInherited, state);
      }
    }
    return null;
  }

  // Identifier::name — resolve identifier to inherited class by alias or name
  const firstIdent = scopeNode.children.find(c => c.type === 'identifier');
  if (firstIdent) {
    const inheritName = firstIdent.text;
    const classScopeId = findEnclosingClassScopeId(refNode, state);
    if (classScopeId !== null) {
      const classScope = state.scopeMap.get(classScopeId);
      if (!classScope) return null;
      // Find the inherit declaration matching this name (by alias or path name)
      for (const declId of classScope.declarations) {
        const decl = state.declMap.get(declId);
        if (decl && decl.kind === 'inherit') {
          const matches = decl.alias === inheritName || decl.name === inheritName;
          if (matches) {
            // Find the inherited scope that wireInheritance wired for this inherit
            // by looking for a class declaration with name == decl.name
            for (const inheritedId of classScope.inheritedScopes) {
              const inheritedScope = state.scopeMap.get(inheritedId);
              if (!inheritedScope || inheritedScope.parentId === null) continue;
              const parentScope = state.scopeMap.get(inheritedScope.parentId);
              if (parentScope) {
                for (const parentDeclId of parentScope.declarations) {
                  const parentDecl = state.declMap.get(parentDeclId);
                  if (parentDecl && parentDecl.kind === 'class' && parentDecl.name === decl.name) {
                    return findDeclInScope(name, inheritedId, state);
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  return null;
}
