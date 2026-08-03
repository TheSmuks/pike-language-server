/**
 * Declaration collector: walks the tree-sitter AST to collect
 * declarations and build scope tree (pass 1 of symbol table build).
 *
 * Extracted from symbolTable.ts (US-032/US-033).
 */
import type { Node } from 'web-tree-sitter';
import type { BuildState, DeclKind } from './symbolTable';
import {
  toRange,
  pushScope,
  popScope,
  addDeclaration,
  extractTypeText,
  currentScopeId,
} from './scopeBuilder';
import {
  collectForStatement,
  collectForeachStatement,
  collectIfStatement,
  collectWhileStatement,
  collectDoWhileStatement,
  collectSwitchStatement,
  collectCatchExpr,
  collectSimpleDecl,
  collectModifiers,
} from './declarationBlockCollectors';
import { collectPreprocDefine, collectPreprocInclude } from './preprocMacros';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DECL_KIND_MAP: Record<string, DeclKind> = {
  class_decl: 'class',
  function_decl: 'function',
  local_function_decl: 'function',
  variable_decl: 'variable',
  local_declaration: 'variable',
  // `if (int last_ts = seen[hash])` — Pike lets a condition declare a variable
  // that is in scope for the body. The block collectors already open a scope
  // for it; without this the scope stayed empty, so the name resolved to
  // nothing from its own declaration and from every use in the body.
  cond_decl: 'variable',
  constant_decl: 'constant',
  enum_decl: 'enum',
  enum_member: 'enum_member',
  import_decl: 'import',
  inherit_decl: 'inherit',
  typedef_decl: 'typedef',
};


// ---------------------------------------------------------------------------
// Collect declarations by walking the tree and creating scopes as needed.
// ---------------------------------------------------------------------------

/**
 * Node types `dispatchCollectDeclarations` handles specially. The cursor
 * descent below materializes a JS node object ONLY for these types; every
 * other node is passed through inside the WASM cursor. Keep this set exactly
 * in sync with the dispatch function — a type listed here but not dispatched
 * loses its subtree; a dispatched type missing here is never dispatched
 * during generic descent.
 */
const DISPATCHED_DECL_TYPES = new Set<string>([
  ...Object.keys(DECL_KIND_MAP),
  'preproc_include',
  'preproc_define',
  'preprocessor_directive',
  'preproc_if',
  'preproc_undef',
  'local_function_decl',
  'lambda_expr',
  'for_statement',
  'foreach_statement',
  'if_statement',
  'while_statement',
  'do_while_statement',
  'catch_expr',
  'switch_statement',
]);

/**
 * Collect declarations by walking the tree and creating scopes as needed.
 */
export function collectDeclarations(node: Node, state: BuildState): void {
  // MISSING nodes are zero-width tokens the parser invents to recover; they hold
  // no source and cannot be declarations.
  if (node.isMissing) return;

  // An ERROR node is not itself a declaration, but tree-sitter is error-tolerant
  // and routinely recovers real declarations inside one — e.g. a function whose
  // closing brace has not been typed yet keeps its `local_declaration` children.
  // Descend and collect what parsed instead of dropping the whole subtree, which
  // used to blank every semantic token in the file on almost every keystroke.
  if (node.isError) {
    descendForDeclarations(node, state);
    return;
  }

  // Dispatch by node type
  dispatchCollectDeclarations(node, state);
}

/**
 * Generic descent through `node`'s subtree using a tree-sitter cursor.
 *
 * The naive `for (const child of node.children)` recursion materializes a JS
 * wrapper object (plus a children array) for EVERY node. Data-heavy files
 * make that catastrophic: a 216KB stdlib table file (FIPS10_4.pmod) parses to
 * 378k nodes — mostly literal/precedence-cascade nodes that can never hold a
 * declaration — and the wrapper churn alone cost ~70MB of allocator
 * high-water per walk. The cursor walks inside WASM and only nodes whose
 * type is actually dispatched get materialized.
 */
function descendForDeclarations(node: Node, state: BuildState): void {
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
    // Missing nodes are zero-width recovery leaves — nothing to collect or
    // descend into (mirrors the isMissing guard in collectDeclarations).
    if (!cursor.nodeIsMissing) {
      if (DISPATCHED_DECL_TYPES.has(cursor.nodeType)) {
        // The dispatch handler manages its own subtree (scopes + descent),
        // so the walk must not enter this node's children again.
        dispatchCollectDeclarations(cursor.currentNode, state);
      } else {
        enterChildren = true;
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

/** Handle block-scoped statements — returns true if node was handled. */
function dispatchBlockStatement(node: Node, state: BuildState): boolean {
  switch (node.type) {
    case 'for_statement':       collectForStatement(node, state); return true;
    case 'foreach_statement':   collectForeachStatement(node, state); return true;
    case 'if_statement':        collectIfStatement(node, state); return true;
    case 'while_statement':      collectWhileStatement(node, state); return true;
    case 'do_while_statement':   collectDoWhileStatement(node, state); return true;
    case 'catch_expr':          collectCatchExpr(node, state); return true;
    case 'switch_statement':    collectSwitchStatement(node, state); return true;
  }
  return false;
}

/** Dispatch collectDeclarations to the appropriate handler based on node type. */
function dispatchCollectDeclarations(node: Node, state: BuildState): void {
  // Handle preprocessor directives: `#include` targets and `#define` macros.
  if (node.type === 'preproc_include') { collectPreprocInclude(node, state); return; }
  if (node.type === 'preproc_define') {
    // The body is not descended into: its identifiers are uses of names
    // declared elsewhere, and its parameters are bound only at expansion time,
    // so neither belongs in the enclosing scope.
    collectPreprocDefine(node, state);
    return;
  }
  if (node.type === 'preprocessor_directive') {
    // Every remaining directive is a flat text token that declares nothing.
    return;
  }
  if (node.type === 'preproc_if' || node.type === 'preproc_undef') {
    // A conditional directive names macros rather than declaring anything; its
    // identifiers are uses, collected by the reference collector.
    return;
  }

  // Handle scope introducers
  if (node.type === 'class_decl') { collectClassDecl(node, state); return; }
  if (node.type === 'function_decl' || node.type === 'local_function_decl') {
    collectFunctionDecl(node, state); return;
  }
  if (node.type === 'lambda_expr') { collectLambda(node, state); return; }

  // Handle block-scoped constructs
  if (dispatchBlockStatement(node, state)) return;

  // Handle declarations in current scope
  if (DECL_KIND_MAP[node.type]) {
    collectSimpleDecl(node, state);
    descendForDeclarations(node, state);
    return;
  }

  // Recurse into children
  descendForDeclarations(node, state);
}

function collectClassDecl(node: Node, state: BuildState): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) {
    // Anonymous class — still enter scope for children
    const body = node.childForFieldName('body');
    if (body) {
      pushScope(state, 'class', toRange(node));
      collectDeclarations(body, state);
      popScope(state);
    }
    return;
  }

  const scopeId = currentScopeId(state);
  addDeclaration(state, {
    name: nameNode.text,
    kind: 'class',
    nameRange: toRange(nameNode),
    range: toRange(node),
    scopeId,
    modifiers: collectModifiers(node),
  });

  // Enter class scope
  pushScope(state, 'class', toRange(node));

  const body = node.childForFieldName('body');
  if (body) {
    collectDeclarations(body, state);
  }

  popScope(state);
}

/**
 * The property name a `\`name` / `\`name=` declaration contributes.
 *
 * Only a backtick followed by an identifier is a property. An operator
 * overload — `\`+`, `\`[]`, `\`()`, `\`->` — keeps its declared spelling,
 * because it is not a member anyone reads by name.
 */
function propertyNameOf(declared: string): string | null {
  const match = /^`([A-Za-z_][A-Za-z0-9_]*)=?$/.exec(declared);
  return match ? match[1] : null;
}

/** The declared type of a function's first parameter, for a setter. */
function firstParameterType(node: Node): string | undefined {
  const params = node.childForFieldName('parameters');
  for (const param of params?.children ?? []) {
    const type = param.childForFieldName?.('type') ??
      param.children?.find(c => c.type === 'type');
    if (type) return type.text;
  }
  return undefined;
}

/** True when `name` is already declared directly in `scopeId`. */
function declaredInScope(state: BuildState, name: string, scopeId: number): boolean {
  const scope = state.scopeMap.get(scopeId);
  if (!scope) return false;
  return scope.declarations.some(id => state.declMap.get(id)?.name === name);
}

/** Enter the function's own scope and collect its parameters and body. */
function collectFunctionBody(node: Node, state: BuildState): void {
  pushScope(state, 'function', toRange(node));
  const params = node.childForFieldName('parameters');
  if (params) collectParameters(params, state);
  const body = node.childForFieldName('body');
  if (body) collectDeclarations(body, state);
  popScope(state);
}

function collectFunctionDecl(node: Node, state: BuildState): void {
  const nameNode = node.childForFieldName('name');
  const returnType = node.childForFieldName('return_type');
  const scopeId = currentScopeId(state);

  if (nameNode) {
    // Pike spells a property as a getter/setter pair — `int `v()` and
    // `void `v=(int x)` — and every reader writes it as a plain `v`, including
    // through inheritance: with `class Sub { inherit R; … v = 5; … }` the
    // compiler prints 10 for a setter that doubles, so `v` is genuinely the
    // member's name. Recorded under the declared spelling, `v` matched nothing
    // at all — not bare in a subclass, not as `obj->v`.
    const property = propertyNameOf(nameNode.text);
    // The getter and the setter are two declarations of ONE member. Recording
    // both put `conf` in the scope twice, so every lookup had to pick and
    // rename would have rewritten only one of them.
    if (property && declaredInScope(state, property, scopeId)) {
      collectFunctionBody(node, state);
      return;
    }
    addDeclaration(state, {
      name: property ?? nameNode.text,
      // A property reads as a value, not as something to call.
      kind: property ? 'variable' : 'function',
      nameRange: toRange(nameNode),
      range: toRange(node),
      scopeId,
      // The setter's parameter type is what the property holds; the getter's
      // return type is the same thing. Either way the return type is right,
      // except for the setter, whose `void` says nothing about the property.
      declaredType: property && returnType?.text === 'void'
        ? firstParameterType(node)
        : returnType?.text,
      modifiers: collectModifiers(node),
    });
  }

  collectFunctionBody(node, state);
}

function collectLambda(node: Node, state: BuildState): void {
  // Enter lambda scope
  pushScope(state, 'lambda', toRange(node));

  const params = node.childForFieldName('parameters');
  if (params) {
    collectParameters(params, state);
  }

  const body = node.childForFieldName('body');
  if (body) {
    collectDeclarations(body, state);
  }

  popScope(state);
}

function collectParameters(paramsNode: Node, state: BuildState): void {
  const scopeId = currentScopeId(state);
  for (const child of paramsNode.children) {
    if (child.type === 'parameter') {
      const nameNode = child.childForFieldName('name');
      if (nameNode) {
        // Variadic parameters parse as `parameter -> [type, ..., identifier]`;
        // the marker is a child node, not part of the type.
        const varargs = child.children.some(c => c.type === '...');
        addDeclaration(state, {
          name: nameNode.text,
          kind: 'parameter',
          nameRange: toRange(nameNode),
          range: toRange(child),
          scopeId,
          declaredType: extractTypeText(child),
          ...(varargs ? { varargs: true } : {}),
        });
      }
    }
  }
}
