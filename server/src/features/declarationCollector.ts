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
} from './declarationBlockCollectors';
import { collectPreprocDirective, collectPreprocInclude } from './preprocMacros';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DECL_KIND_MAP: Record<string, DeclKind> = {
  class_decl: 'class',
  function_decl: 'function',
  local_function_decl: 'function',
  variable_decl: 'variable',
  local_declaration: 'variable',
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
  'preprocessor_directive',
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
  if (node.type === 'preprocessor_directive') {
    // Only `#define` produces a symbol; other directives are ignored. Either
    // way there is nothing to descend into (the node is a flat text token).
    collectPreprocDirective(node, state);
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
  });

  // Enter class scope
  pushScope(state, 'class', toRange(node));

  const body = node.childForFieldName('body');
  if (body) {
    collectDeclarations(body, state);
  }

  popScope(state);
}

function collectFunctionDecl(node: Node, state: BuildState): void {
  const nameNode = node.childForFieldName('name');
  const returnType = node.childForFieldName('return_type');
  const scopeId = currentScopeId(state);

  if (nameNode) {
    addDeclaration(state, {
      name: nameNode.text,
      kind: 'function',
      nameRange: toRange(nameNode),
      range: toRange(node),
      scopeId,
      declaredType: returnType?.text,
    });
  }

  // Enter function scope — parameters are in this scope
  pushScope(state, 'function', toRange(node));

  // Collect parameters
  const params = node.childForFieldName('parameters');
  if (params) {
    collectParameters(params, state);
  }

  // Collect body
  const body = node.childForFieldName('body');
  if (body) {
    collectDeclarations(body, state);
  }

  popScope(state);
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
        addDeclaration(state, {
          name: nameNode.text,
          kind: 'parameter',
          nameRange: toRange(nameNode),
          range: toRange(child),
          scopeId,
          declaredType: extractTypeText(child),
        });
      }
    }
    // Variadic parameters: `string ... parts` — the name is also in a parameter node
  }
}
