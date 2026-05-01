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
  getNameNodes,
  extractTypeText,
  extractInitializerType,
  currentScopeId,
  pushScope,
  popScope,
  addDeclaration,
} from './scopeBuilder';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DECL_KIND_MAP: Record<string, DeclKind> = {
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

const SCOPE_INTRODUCERS = new Set([
  'class_decl',
  'function_decl',
  'local_function_decl',
  'lambda_expr',
]);

const BLOCK_SCOPES = new Set([
  'block',
  'for_statement',
  'foreach_statement',
  'if_statement',
  'while_statement',
  'do_while_statement',
  'switch_statement',
]);

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

function collectForStatement(node: Node, state: BuildState): void {
  // for_init_decl introduces a scope
  pushScope(state, 'for', toRange(node));

  // Find for_init_decl child — field name 'initializer' may not be available
  // in older WASM builds, so walk children by type.
  for (const child of node.children) {
    if (child.type === 'for_init_decl') {
      // for_init_decl grammar: field('type', $.type), commaSep1(seq(field('name', $.identifier), ...))
      // Use childrenForFieldName('name') to get only the variable name identifiers,
      // not the type identifiers (which would be picked up by walking bare 'identifier' children).
      const scopeId = currentScopeId(state);
      for (const nameNode of child.childrenForFieldName('name')) {
        addDeclaration(state, {
          name: nameNode.text,
          kind: 'variable',
          nameRange: toRange(nameNode),
          range: toRange(child),
          scopeId,
        });
      }
      break;
    }
  }

  const body = node.childForFieldName('body');
  if (body) {
    collectDeclarations(body, state);
  }

  popScope(state);
}

function collectForeachStatement(node: Node, state: BuildState): void {
  pushScope(state, 'foreach', toRange(node));

  // foreach_lvalues is an unnamed child — find it by type, not by field name
  let lvals: Node | null = null;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.type === 'foreach_lvalues') {
      lvals = child;
      break;
    }
  }
  if (lvals) {
    collectForeachLvalues(lvals, state);
  }

  const body = node.childForFieldName('body');
  if (body) {
    collectDeclarations(body, state);
  }

  popScope(state);
}

function collectForeachLvalues(node: Node, state: BuildState): void {
  const scopeId = currentScopeId(state);

  // foreach_lvalues grammar defines field('key', ...) and field('value', ...).
  // _foreach_lvalue is: choice($._expr, seq($.type, $.identifier), $.array_destructure)
  //
  // When tree-sitter flattens seq($.type, $.identifier), both the type and identifier
  // nodes get tagged with the same field name. So childrenForFieldName('key') may
  // return [type_node, identifier_node]. We extract identifiers from the field children.
  const extractIdentifiersFromField = (fieldName: string): void => {
    const nodes = node.childrenForFieldName(fieldName);
    if (nodes.length === 0) return;

    // Find identifier nodes among the field children.
    // Typed form: [type, identifier] — take the identifier.
    // Expression form: [comma_expr] — may contain bare identifier children.
    for (const n of nodes) {
      if (n.type === 'identifier') {
        addDeclaration(state, {
          name: n.text,
          kind: 'parameter',
          nameRange: toRange(n),
          range: toRange(n),
          scopeId,
        });
      }
    }

    // If no direct identifier was found, the field captured a compound expression.
    // Walk its children for identifiers (handles comma_expr and array_destructure).
    const identifiers = nodes.filter(n => n.type === 'identifier');
    if (identifiers.length === 0) {
      for (const n of nodes) {
        if (n.type === 'comma_expr') {
          // Bare identifier in untyped foreach: foreach(x; key; val)
          // The comma_expr may contain identifier_expr children
          for (const child of n.children) {
            if (child.type === 'identifier') {
              addDeclaration(state, {
                name: child.text,
                kind: 'parameter',
                nameRange: toRange(child),
                range: toRange(child),
                scopeId,
              });
            }
          }
        } else if (n.type === 'array_destructure') {
          for (const child of n.children) {
            if (child.type === 'identifier') {
              addDeclaration(state, {
                name: child.text,
                kind: 'parameter',
                nameRange: toRange(child),
                range: toRange(child),
                scopeId,
              });
            }
          }
        }
      }
    }
  };

  extractIdentifiersFromField('key');
  extractIdentifiersFromField('value');
}

function collectIfStatement(node: Node, state: BuildState): void {
  // cond_decl (declaration in condition) creates a scope for consequence + alternative
  const condition = node.childForFieldName('condition');
  let pushedCondScope = false;
  if (condition) {
    for (const child of condition.children) {
      if (child.type === 'cond_decl') {
        pushScope(state, 'if_cond', toRange(node));
        collectDeclarations(child, state);
        pushedCondScope = true;
        break;
      }
    }
  }

  // Consequence gets its own block scope
  const consequence = node.childForFieldName('consequence');
  if (consequence) {
    pushScope(state, 'block', toRange(consequence));
    collectDeclarations(consequence, state);
    popScope(state);
  }

  // Alternative gets its own block scope
  const alternative = node.childForFieldName('alternative');
  if (alternative) {
    pushScope(state, 'block', toRange(alternative));
    collectDeclarations(alternative, state);
    popScope(state);
  }

  if (pushedCondScope) {
    popScope(state);
  }
}

function collectWhileStatement(node: Node, state: BuildState): void {
  // cond_decl in condition creates a scope wrapping body
  const condition = node.childForFieldName('condition');
  let pushedCondScope = false;
  if (condition) {
    for (const child of condition.children) {
      if (child.type === 'cond_decl') {
        pushScope(state, 'while', toRange(node));
        collectDeclarations(child, state);
        pushedCondScope = true;
        break;
      }
    }
  }

  // Body gets its own block scope
  const body = node.childForFieldName('body');
  if (body) {
    pushScope(state, 'block', toRange(body));
    collectDeclarations(body, state);
    popScope(state);
  }

  if (pushedCondScope) {
    popScope(state);
  }
}

function collectDoWhileStatement(node: Node, state: BuildState): void {
  // No cond_decl possible in do-while condition
  const body = node.childForFieldName('body');
  if (body) {
    pushScope(state, 'do_while', toRange(body));
    collectDeclarations(body, state);
    popScope(state);
  }
}

function collectSwitchStatement(node: Node, state: BuildState): void {
  // cond_decl in value creates a scope wrapping body
  const value = node.childForFieldName('value');
  let pushedCondScope = false;
  if (value) {
    for (const child of value.children) {
      if (child.type === 'cond_decl') {
        pushScope(state, 'switch', toRange(node));
        collectDeclarations(child, state);
        pushedCondScope = true;
        break;
      }
    }
  }

  // Body block has no field name — find it by type
  let body: Node | null = null;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type === 'block') {
      body = child;
      break;
    }
  }
  if (body) {
    pushScope(state, 'block', toRange(body));
    collectDeclarations(body, state);
    popScope(state);
  }

  if (pushedCondScope) {
    popScope(state);
  }
}

function collectSimpleDecl(node: Node, state: BuildState): void {
  const scopeId = currentScopeId(state);
  const kind = DECL_KIND_MAP[node.type];
  if (!kind) return;

  // Unwrap declaration wrapper
  const decl = node.type === 'declaration' ? node.firstChild : node;
  if (!decl || decl.isError) return;

  const actualKind = DECL_KIND_MAP[decl.type];
  if (!actualKind) {
    // Recurse into children of the wrapper
    for (const child of node.children) {
      collectDeclarations(child, state);
    }
    return;
  }

  if (decl.type === 'enum_decl') {
    collectEnumDecl(decl, state);
    return;
  }

  if (decl.type === 'inherit_decl' || decl.type === 'import_decl') {
    collectInheritDecl(decl, state);
    return;
  }

  // Multi-name declarations (variable, constant)
  const nameNodes = getNameNodes(decl);
  const typeText = extractTypeText(decl);
  // Only extract assignedType for variable declarations without a useful declared type
  const assignedType = (actualKind === 'variable' && (!typeText || typeText === 'mixed'))
    ? extractInitializerType(decl)
    : undefined;
  if (nameNodes.length > 0) {
    for (const nameNode of nameNodes) {
      addDeclaration(state, {
        name: nameNode.text,
        kind: actualKind,
        nameRange: toRange(nameNode),
        range: toRange(decl),
        scopeId,
        declaredType: typeText,
        assignedType,
      });
    }
  } else {
    // Single name or no name field
    const nameNode = decl.childForFieldName('name');
    if (nameNode) {
      addDeclaration(state, {
        name: nameNode.text,
        kind: actualKind,
        nameRange: toRange(nameNode),
        range: toRange(decl),
        scopeId,
        declaredType: typeText,
        assignedType,
      });
    }
  }
}

function collectEnumDecl(node: Node, state: BuildState): void {
  const scopeId = currentScopeId(state);
  const nameNode = node.childForFieldName('name');
  if (nameNode) {
    addDeclaration(state, {
      name: nameNode.text,
      kind: 'enum',
      nameRange: toRange(nameNode),
      range: toRange(node),
      scopeId,
    });
  }

  // Enum members
  for (const child of node.children) {
    if (child.type === 'enum_member') {
      const memberName = child.childForFieldName('name');
      if (memberName) {
        addDeclaration(state, {
          name: memberName.text,
          kind: 'enum_member',
          nameRange: toRange(memberName),
          range: toRange(child),
          scopeId,
        });
      }
    }
  }
}

function collectInheritDecl(node: Node, state: BuildState): void {
  const scopeId = currentScopeId(state);
  const aliasNode = node.childForFieldName('alias');
  const pathNode = node.childForFieldName('path');

  if (!pathNode) return;

  // Name is the path (class to look up). Alias is the local rename.
  // For `inherit Animal : creature`, name="Animal", alias="creature".
  // For `inherit Animal`, name="Animal", no alias.
  const kind = node.type === 'import_decl' ? 'import' : 'inherit';
  addDeclaration(state, {
    name: pathNode.text,
    kind,
    nameRange: toRange(pathNode),
    range: toRange(node),
    scopeId,
    alias: aliasNode ? aliasNode.text : undefined,
  });
}
