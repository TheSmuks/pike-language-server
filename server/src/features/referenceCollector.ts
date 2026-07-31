/**
 * Reference collector: walks the tree-sitter AST to collect
 * references and resolve them against the symbol table (pass 2).
 *
 * Extracted from symbolTable.ts (US-032/US-033).
 */
import type { Node } from 'web-tree-sitter';
import type { BuildState } from './symbolTable';
import { toLoc } from './scope-helpers';
import {
  resolveName,
  findScopeForNode,
  findEnclosingClassScopeId,
  findEnclosingClassDecl,
  findDeclInScope,
} from './scope-helpers';
import { collectPostfixRef } from './postfixRefs';
import { resolveScoped, collectScopeQualifierRef } from './scopeRefs';
import { scopeQualifierText } from './scopeQualifier';
import { PIKE_KEYWORDS } from './pikeKeywords';

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
  'preproc_define',
  'preproc_if',
  'preproc_undef',
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

  dispatchCollectReferences(node, state);

  // Recurse into children, but skip return_type on function_decl — it's
  // already handled by collectFunctionReturnTypeRefs above. This prevents
  // the generic type walker from collecting duplicate type_refs for the
  // return type identifier.
  descendForReferences(node, state, node.type === 'function_decl');
}

/** Route `node` to the handler for its type. Keep in sync with DISPATCHED_REF_TYPES. */
function dispatchCollectReferences(node: Node, state: BuildState): void {
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
    case 'preproc_define':
      collectPreprocDefineRefs(node, state);
      break;
    case 'preproc_if':
    case 'preproc_undef':
      collectPreprocConditionRefs(node, state);
      break;
    default:
      break;
  }
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

/**
 * Record every identifier an `id_type` names, not only the first.
 *
 * A dotted type is a path: `Stdio.File` names the member `File` of the module
 * `Stdio`. Recording just `Stdio` left the cursor on `File` sitting on no
 * reference at all, so highlight, references and rename all went silent there
 * — while the identical `Stdio.File()` one line over, in expression position,
 * answered fine.
 *
 * Only the head is resolved by name. A later segment is a member of what
 * precedes it, not something in scope, and resolving it as a scope lookup
 * would happily point `File` at any local class of that name.
 */
function collectIdTypeRefs(idType: Node, state: BuildState): void {
  const identifiers = idType.children.filter(c => c.type === 'identifier');
  for (let i = 0; i < identifiers.length; i++) {
    const ident = identifiers[i];
    if (i === 0) {
      const declId = resolveName(ident.text, ident, state);
      state.references.push({
        name: ident.text,
        loc: toLoc(ident.startPosition),
        kind: 'type_ref',
        resolvesTo: declId,
        confidence: declId !== null ? 'high' : 'low',
      });
      continue;
    }
    state.references.push({
      name: ident.text,
      loc: toLoc(ident.startPosition),
      kind: 'dot_access',
      resolvesTo: null,
      confidence: 'low',
      lhsName: identifiers[i - 1].text,
    });
  }
}

function collectReturnTypeIdRecursive(node: Node, state: BuildState): void {
  for (const child of node.children) {
    if (child.type === 'id_type') {
      collectIdTypeRefs(child, state);
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

/** The names a function-like macro binds at expansion time. */
function macroParameterNames(node: Node): Set<string> {
  const names = new Set<string>();
  const params = node.childForFieldName('parameters');
  if (!params) return names;
  for (const param of params.children) {
    if (param.type !== 'preproc_param') continue;
    const name = param.childForFieldName('name');
    if (name) names.add(name.text);
  }
  return names;
}

/**
 * References inside a `#define` body.
 *
 * A macro body is a token sequence rather than an expression, so its
 * identifiers are bare `identifier` nodes that no expression rule dispatches.
 * Collecting them here is what lets hover, go-to-definition and references
 * answer anywhere inside a macro, and what stops a symbol whose only use is a
 * macro body from being reported as unused.
 *
 * Two kinds of identifier are dropped. A macro's own parameters are bound at
 * expansion, so resolving them against the enclosing scope would point them at
 * unrelated declarations that happen to share the name — and rename would then
 * rewrite the body. Keywords reach here spelled as identifiers, because a body
 * has no keyword positions for the lexer to recognise them in; they name
 * nothing.
 */
function collectPreprocDefineRefs(node: Node, state: BuildState): void {
  const body = node.childForFieldName('body');
  if (!body) return;

  const parameters = macroParameterNames(node);
  for (const child of body.children) {
    if (child.type !== 'identifier') continue;
    const name = child.text;
    if (parameters.has(name) || PIKE_KEYWORDS.has(name)) continue;

    const declId = resolveName(name, child, state);
    state.references.push({
      name,
      loc: toLoc(child.startPosition),
      kind: 'identifier',
      resolvesTo: declId,
      confidence: declId !== null ? 'high' : 'low',
    });
  }
}

/**
 * Names a `#if` condition can contain that are not Pike symbols.
 *
 * These are directives of the preprocessor's own expression language, not
 * functions — `pike -e` accepts `#if efun(sprintf)` while warning the form is
 * deprecated, and none of the three is resolvable as a Pike identifier. Left in,
 * every `#if constant(X)` in the corpus would record an unresolved reference to
 * `constant`.
 */
const PREPROC_OPERATORS = new Set(['defined', 'constant', 'efun']);

/**
 * References inside a conditional directive: `#ifdef X`, `#if constant(Y)`,
 * `#undef Z`.
 *
 * The names that decide what compiles are written here, and until the grammar
 * modelled these directives they sat inside one opaque token — 2316 identifier
 * occurrences across the Roxen corpus at which no position-driven capability
 * could answer. Like a macro body, a condition is a token sequence rather than
 * an expression, so its identifiers are bare `identifier` nodes that no
 * expression rule dispatches.
 */
function collectPreprocConditionRefs(node: Node, state: BuildState): void {
  for (const child of node.children) {
    const identifiers = child.type === 'identifier' ? [child]
      : child.type === 'preproc_body' ? child.children.filter(c => c.type === 'identifier')
      : [];
    for (const id of identifiers) {
      const name = id.text;
      if (PIKE_KEYWORDS.has(name) || PREPROC_OPERATORS.has(name)) continue;

      const declId = resolveName(name, id, state);
      state.references.push({
        name,
        loc: toLoc(id.startPosition),
        kind: 'identifier',
        resolvesTo: declId,
        confidence: declId !== null ? 'high' : 'low',
      });
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
    loc: toLoc(nameNode.startPosition),
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
    collectScopeQualifierRef(scopeNode, state);
  }

  state.references.push({
    name,
    loc: toLoc(nameNode.startPosition),
    kind: 'scope_access',
    resolvesTo: declId,
    confidence: declId !== null ? 'medium' : 'low',
    // Recorded even when resolution succeeded: the cross-file fallback needs
    // it to tell `B::shared` from `A::shared`, and without it that fallback
    // answered whichever inherit came first.
    scopeQualifier: scopeNode ? scopeQualifierText(scopeNode) : undefined,
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
      collectIdTypeRefs(child, state);
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






