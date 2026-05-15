/**
 * Declaration collector: walks the tree-sitter AST to collect
 * declarations and build scope tree (pass 1 of symbol table build).
 *
 * Extracted from symbolTable.ts (US-032/US-033).
 */
import type { Node } from 'web-tree-sitter';
import type { BuildState, DeclKind } from './symbolTable';
import {
  toRangeUtf16,
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
 * Collect declarations by walking the tree and creating scopes as needed.
 */
export function collectDeclarations(node: Node, state: BuildState): void {
  // Skip ERROR / missing nodes
  if (node.isError || node.isMissing) return;

  // Handle scope introducers
  if (node.type === 'class_decl') {
    collectClassDecl(node, state);
    return;
  }

  if (node.type === 'function_decl' || node.type === 'local_function_decl') {
    collectFunctionDecl(node, state);
    return;
  }

  if (node.type === 'lambda_expr') {
    collectLambda(node, state);
    return;
  }

  // Handle block-scoped constructs
  if (node.type === 'for_statement') {
    collectForStatement(node, state);
    return;
  }

  if (node.type === 'foreach_statement') {
    collectForeachStatement(node, state);
    return;
  }

  if (node.type === 'if_statement') {
    collectIfStatement(node, state);
    return;
  }

  if (node.type === 'while_statement') {
    collectWhileStatement(node, state);
    return;
  }

  if (node.type === 'do_while_statement') {
    collectDoWhileStatement(node, state);
    return;
  }

  if (node.type === 'catch_expr') {
    collectCatchExpr(node, state);
    return;
  }
  if (node.type === 'switch_statement') {
    collectSwitchStatement(node, state);
    return;
  }

  // Handle declarations in current scope
  if (DECL_KIND_MAP[node.type]) {
    collectSimpleDecl(node, state);
    // Still recurse into children to find nested lambdas in initializers
    for (const child of node.children) {
      collectDeclarations(child, state);
    }
    return;
  }

  // Recurse into children
  for (const child of node.children) {
    collectDeclarations(child, state);
  }
}

function collectClassDecl(node: Node, state: BuildState): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) {
    // Anonymous class — still enter scope for children
    const body = node.childForFieldName('body');
    if (body) {
      pushScope(state, 'class', toRangeUtf16(node, state.lines));
      collectDeclarations(body, state);
      popScope(state);
    }
    return;
  }

  const scopeId = currentScopeId(state);
  addDeclaration(state, {
    name: nameNode.text,
    kind: 'class',
    nameRange: toRangeUtf16(nameNode, state.lines),
    range: toRangeUtf16(node, state.lines),
    scopeId,
  });

  // Enter class scope
  pushScope(state, 'class', toRangeUtf16(node, state.lines));

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
      nameRange: toRangeUtf16(nameNode, state.lines),
      range: toRangeUtf16(node, state.lines),
      scopeId,
      declaredType: returnType?.text,
    });
  }

  // Enter function scope — parameters are in this scope
  pushScope(state, 'function', toRangeUtf16(node, state.lines));

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
  pushScope(state, 'lambda', toRangeUtf16(node, state.lines));

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
          nameRange: toRangeUtf16(nameNode, state.lines),
          range: toRangeUtf16(child, state.lines),
          scopeId,
          declaredType: extractTypeText(child),
        });
      }
    }
    // Variadic parameters: `string ... parts` — the name is also in a parameter node
  }
}
