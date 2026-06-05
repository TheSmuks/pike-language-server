/**
 * Postfix member-access reference collection and resolution.
 *
 * Handles `a.b.c` (dot), `obj->a->b` (arrow), and mixed `a.b->c.d` chains.
 *
 * Extracted from referenceCollector.ts to keep that file under the
 * 500-line TigerStyle limit. The four functions in this module share a
 * single concern: figuring out which declaration (if any) a chained
 * member access resolves to, and recording the reference with the
 * correct `lhsName` so downstream type resolution and chain coloring
 * see the right receiver for each segment.
 */

import type { Node } from 'web-tree-sitter';
import type { BuildState, Declaration } from './symbolTable';
import { PRIMITIVE_TYPES } from './symbolTable';
import { toLocUtf16, resolveTypeName } from './scope-helpers';
import {
  findScopeForNode,
  findDeclInScope,
} from './scope-helpers';

/**
 * Extract the rightmost identifier text from a postfix_expr LHS chain.
 *
 * For `d->bark`, the LHS subtree is a primary_expr containing the
 * identifier 'd' — return 'd'.
 *
 * For `Container.Something.Else` evaluated at the second `.`, the LHS
 * subtree is the *nested* postfix_expr `Container.Something` (not just
 * the immediately-preceding identifier). The LHS name is the rightmost
 * identifier of that subexpression: 'Something'. Returning the leftmost
 * ('Container') would erase the distinction between accesses and
 * collapse chain coloring.
 *
 * Returns the identifier text, or undefined if not found.
 */
export function extractLhsIdentifier(lhsNode: Node | undefined): string | undefined {
  if (!lhsNode) return undefined;
  if (lhsNode.type === 'identifier' || lhsNode.type === 'magic_identifier') {
    return lhsNode.text;
  }
  // Walk the subtree. The LHS is the rightmost identifier in a
  // postfix chain (e.g. for `a.b.c` evaluated at the second `.`,
  // the LHS is `c` of the nested `a.b.c` subtree). Descend via the
  // last child, not the first — children of postfix_expr are arranged
  // [lhs, op, member] with the member as the last child.
  if (lhsNode.childCount > 0) {
    const child = lhsNode.child(lhsNode.childCount - 1);
    return child ? extractLhsIdentifier(child) : undefined;
  }
  return undefined;
}

export function collectPostfixRef(node: Node, state: BuildState): void {
  const children = node.children;

  for (let i = 0; i < children.length; i++) {
    const child = children[i];

    const isArrowOp = child.type === '->' || child.type === '->?' || child.type === '?->';
    const isDotOp = child.type === '.';
    if (!isArrowOp && !isDotOp) continue;

    const memberNode = children[i + 1];
    if (!memberNode || (memberNode.type !== 'identifier' && memberNode.type !== 'magic_identifier')) continue;

    const memberName = memberNode.text;
    const lhsName = extractLhsIdentifier(children[i - 1]);
    const kind = isArrowOp ? 'arrow_access' : 'dot_access';

    const { resolvesTo, confidence } = resolvePostfixMember(lhsName, memberName, node, state);

    state.references.push({
      name: memberName,
      loc: toLocUtf16(memberNode.startPosition, state.lines, state.offsetMap),
      kind,
      resolvesTo,
      confidence,
      lhsName,
    });
  }
}

/** Resolve a postfix member access to its declaration, if possible. */
function resolvePostfixMember(
  lhsName: string | undefined,
  memberName: string,
  node: Node,
  state: BuildState,
): { resolvesTo: number | null; confidence: 'high' | 'low' } {
  if (!lhsName) return { resolvesTo: null, confidence: 'low' };

  const lhsDeclId = findDeclInScope(lhsName, findScopeForNode(node, state) ?? -1, state);
  if (lhsDeclId === null) return { resolvesTo: null, confidence: 'low' };

  const lhsDecl = state.declMap.get(lhsDeclId);
  if (!lhsDecl) return { resolvesTo: null, confidence: 'low' };

  const typeName = resolveTypeName(lhsDecl);
  if (!typeName || PRIMITIVE_TYPES.has(typeName)) return { resolvesTo: null, confidence: 'low' };

  const typeClassDecl = state.declarations.find(
    d => d.kind === 'class' && d.name === typeName,
  );
  if (!typeClassDecl) return { resolvesTo: null, confidence: 'low' };

  return findMemberInClassScope(memberName, typeClassDecl, state);
}

/**
 * Search for a member in the class scope associated with the resolved type
 * declaration.  Uses range overlap to find the class body scope, matching
 * the pattern documented in architecture-gotchas.md: class declarations live
 * in FILE scope but class MEMBERS live in the CLASS scope whose range
 * overlaps the class declaration.
 */
function findMemberInClassScope(
  memberName: string,
  typeClassDecl: Declaration,
  state: BuildState,
): { resolvesTo: number | null; confidence: 'high' | 'low' } {
  // Find the class body scope whose range overlaps the class declaration.
  // The class scope is a child of the scope containing the class declaration
  // (typically file scope), and its range is contained within the declaration
  // range.
  for (const scope of state.scopes) {
    if (scope.kind !== 'class') continue;
    // The class body scope's parentId should be the class declaration's scopeId,
    // and the scope's range should overlap with the class declaration's range.
    if (scope.parentId === typeClassDecl.scopeId &&
        scope.range.start.line >= typeClassDecl.range.start.line &&
        scope.range.start.line <= typeClassDecl.range.end.line) {
      for (const memberDeclId of scope.declarations) {
        const memberDecl = state.declMap.get(memberDeclId);
        if (memberDecl && memberDecl.name === memberName) {
          return { resolvesTo: memberDeclId, confidence: 'high' };
        }
      }
      // Also check inherited scopes for the member.
      for (const inheritedId of scope.inheritedScopes) {
        const match = findDeclInScope(memberName, inheritedId, state);
        if (match !== null) return { resolvesTo: match, confidence: 'high' };
      }
    }
  }
  return { resolvesTo: null, confidence: 'low' };
}
