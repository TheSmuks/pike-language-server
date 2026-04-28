import { Tree, Node, Point } from 'web-tree-sitter';

// ---------------------------------------------------------------------------
// Types — mirrors decision 0009
// ---------------------------------------------------------------------------

export interface Location {
  line: number;
  character: number;
}

export interface Range {
  start: Location;
  end: Location;
}

export interface Declaration {
  id: number;
  name: string;
  kind: DeclKind;
  nameRange: Range;
  range: Range;
  scopeId: number;
  /** For inherit declarations: local alias (e.g. 'creature' in 'inherit Animal : creature'). */
  alias?: string;
}

export type DeclKind =
  | 'function'
  | 'class'
  | 'variable'
  | 'constant'
  | 'enum'
  | 'enum_member'
  | 'typedef'
  | 'parameter'
  | 'inherit';

export interface Reference {
  name: string;
  loc: Location;
  kind: RefKind;
  resolvesTo: number | null; // Declaration.id, null if unresolved
  confidence: 'high' | 'medium' | 'low';
}

export type RefKind =
  | 'identifier'
  | 'call'
  | 'arrow_access'
  | 'dot_access'
  | 'scope_access'
  | 'type_ref'
  | 'this_ref'
  | 'label'
  | 'inherit_ref';

export interface Scope {
  id: number;
  kind: ScopeKind;
  range: Range;
  parentId: number | null;
  declarations: number[]; // Declaration IDs
  inheritedScopes: number[]; // Scope IDs (class inheritance)
}

export type ScopeKind =
  | 'file'
  | 'class'
  | 'function'
  | 'lambda'
  | 'block'
  | 'for'
  | 'foreach'
  | 'if_cond';

export interface SymbolTable {
  uri: string;
  version: number;
  declarations: Declaration[];
  references: Reference[];
  scopes: Scope[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toLoc(point: Point): Location {
  return { line: point.row, character: point.column };
}

function toRange(node: Node): Range {
  return { start: toLoc(node.startPosition), end: toLoc(node.endPosition) };
}

/** Get the text of the `name` field child, if any. */
function getNameText(node: Node): string | null {
  const nameNode = node.childForFieldName('name');
  return nameNode?.text ?? null;
}

/** Get all identifier nodes from the `name` field (multi-name variable/constant decls). */
function getNameNodes(node: Node): Node[] {
  return node.childrenForFieldName('name');
}

// ---------------------------------------------------------------------------
// Builder state
// ---------------------------------------------------------------------------

interface BuildState {
  nextId: number;
  declarations: Declaration[];
  references: Reference[];
  scopes: Scope[];
  scopeMap: Map<number, Scope>; // ID → Scope for O(1) lookup
  declMap: Map<number, Declaration>; // ID → Declaration for O(1) lookup
  scopeStack: number[]; // stack of scope IDs (innermost last)
}

function freshId(state: BuildState): number {
  return state.nextId++;
}

function currentScopeId(state: BuildState): number {
  return state.scopeStack[state.scopeStack.length - 1];
}

function pushScope(state: BuildState, kind: ScopeKind, range: Range): number {
  const id = freshId(state);
  const parentId = state.scopeStack.length > 0 ? currentScopeId(state) : null;
  const scope: Scope = { id, kind, range, parentId, declarations: [], inheritedScopes: [] };
  state.scopes.push(scope);
  state.scopeMap.set(id, scope);
  state.scopeStack.push(id);
  return id;
}

function popScope(state: BuildState): void {
  state.scopeStack.pop();
}

function addDeclaration(state: BuildState, decl: Omit<Declaration, 'id'>): number {
  const id = freshId(state);
  const full: Declaration = { ...decl, id };
  state.declarations.push(full);
  state.declMap.set(id, full);
  // Register in scope
  const scope = state.scopeMap.get(decl.scopeId);
  if (scope) scope.declarations.push(id);
  return id;
}

// ---------------------------------------------------------------------------
// Scope-aware tree walker
// ---------------------------------------------------------------------------

/**
 * Build a symbol table from a tree-sitter parse tree.
 *
 * Two passes:
 * 1. Collect declarations and build scope tree
 * 2. Collect references and resolve them
 */
export function buildSymbolTable(tree: Tree, uri: string, version: number): SymbolTable {
  const state: BuildState = {
    nextId: 0,
    declarations: [],
    references: [],
    scopes: [],
    scopeMap: new Map(),
    declMap: new Map(),
    scopeStack: [],
  };

  // Pass 1: declarations + scope tree
  const fileScopeId = pushScope(state, 'file', toRange(tree.rootNode));
  collectDeclarations(tree.rootNode, state);
  popScope(state); // file scope

  // Pass 2: build the table so we can wire inheritance
  const table: SymbolTable = {
    uri,
    version,
    declarations: state.declarations,
    references: [], // filled in pass 4
    scopes: state.scopes,
  };

  // Pass 3: wire inheritance BEFORE reference resolution
  wireInheritance(table);

  // Pass 4: collect and resolve references (inheritance now wired)
  state.references = table.references;
  collectReferences(tree.rootNode, state);
  table.references = state.references;

  return table;
}

// ---------------------------------------------------------------------------
// Pass 1: Declaration collection
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
  import_decl: 'inherit',
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

/**
 * Collect declarations by walking the tree and creating scopes as needed.
 */
function collectDeclarations(node: Node, state: BuildState): void {
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
  const declId = addDeclaration(state, {
    name: nameNode.text,
    kind: 'class',
    nameRange: toRange(nameNode),
    range: toRange(node),
    scopeId,
  });

  // Enter class scope
  const classScopeId = pushScope(state, 'class', toRange(node));

  const body = node.childForFieldName('body');
  if (body) {
    collectDeclarations(body, state);
  }

  popScope(state);
}

function collectFunctionDecl(node: Node, state: BuildState): void {
  const nameNode = node.childForFieldName('name');
  const scopeId = currentScopeId(state);

  if (nameNode) {
    addDeclaration(state, {
      name: nameNode.text,
      kind: 'function',
      nameRange: toRange(nameNode),
      range: toRange(node),
      scopeId,
    });
  }

  // Enter function scope — parameters are in this scope
  const funcScopeId = pushScope(state, 'function', toRange(node));

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
        });
      }
    }
    // Variadic parameters: `string ... parts` — the name is also in a parameter node
  }
}

function collectForStatement(node: Node, state: BuildState): void {
  // for_init_decl introduces a scope
  pushScope(state, 'for', toRange(node));

  // tree-sitter-pike does not assign field names to for_statement children
  // Walk children directly for for_init_decl
  for (const child of node.children) {
    if (child.type === 'for_init_decl') {
      // for_init_decl has structure: type? identifier = expr
      // The identifier is the variable name, not in a named field
      const scopeId = currentScopeId(state);
      for (const sub of child.children) {
        if (sub.type === 'identifier') {
          addDeclaration(state, {
            name: sub.text,
            kind: 'variable',
            nameRange: toRange(sub),
            range: toRange(child),
            scopeId,
          });
        }
      }
    }
  }

  const body = node.childForFieldName('body');
  if (body) {
    collectDeclarations(body, state);
  } else {
    // Fallback: look for block or expression_statement child
    for (const child of node.children) {
      if (child.type === 'block' || child.type === 'expression_statement') {
        collectDeclarations(child, state);
      }
    }
  }

  popScope(state);
}

function collectForeachStatement(node: Node, state: BuildState): void {
  pushScope(state, 'foreach', toRange(node));

  // foreach_lvalues contains the loop variables
  const lvals = node.childForFieldName('lvalue');
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
  // Walk children for typed identifier patterns: `int idx`, `mixed val`
  for (const child of node.children) {
    if (child.type === 'identifier') {
      addDeclaration(state, {
        name: child.text,
        kind: 'parameter',
        nameRange: toRange(child),
        range: toRange(child),
        scopeId,
      });
    } else if (child.type === 'type') {
      // Typed lvalue: `int idx` — the identifier follows the type
      // The structure varies; look for identifier children
      for (const sub of child.children) {
        if (sub.type === 'identifier') {
          addDeclaration(state, {
            name: sub.text,
            kind: 'parameter',
            nameRange: toRange(sub),
            range: toRange(sub),
            scopeId,
          });
        }
      }
    }
  }
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
  if (nameNodes.length > 0) {
    for (const nameNode of nameNodes) {
      addDeclaration(state, {
        name: nameNode.text,
        kind: actualKind,
        nameRange: toRange(nameNode),
        range: toRange(decl),
        scopeId,
      });
    }
  } else {
    // Single name or no name field
    const nameText = getNameText(decl);
    if (nameText) {
      addDeclaration(state, {
        name: nameText,
        kind: actualKind,
        nameRange: toRange(decl.childForFieldName('name')!),
        range: toRange(decl),
        scopeId,
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
  addDeclaration(state, {
    name: pathNode.text,
    kind: 'inherit',
    nameRange: toRange(pathNode),
    range: toRange(node),
    scopeId,
    alias: aliasNode ? aliasNode.text : undefined,
  });
}

// ---------------------------------------------------------------------------
// Pass 2: Reference collection and resolution
// ---------------------------------------------------------------------------

function collectReferences(node: Node, state: BuildState): void {
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

function collectPostfixRef(node: Node, state: BuildState): void {
  // postfix_expr is polymorphic — dispatch based on children
  const children = node.children;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    // Arrow access: `obj->member`
    if (child.type === '->' || child.type === '->?' || child.type === '?->') {
      const memberNode = children[i + 1];
      if (memberNode && (memberNode.type === 'identifier' || memberNode.type === 'magic_identifier')) {
        state.references.push({
          name: memberNode.text,
          loc: toLoc(memberNode.startPosition),
          kind: 'arrow_access',
          resolvesTo: null, // TODO: resolve through object type (Phase 3 basic)
          confidence: 'low',
        });
      }
    }
    // Dot access: `Module.member`
    if (child.type === '.') {
      const memberNode = children[i + 1];
      if (memberNode && memberNode.type === 'identifier') {
        state.references.push({
          name: memberNode.text,
          loc: toLoc(memberNode.startPosition),
          kind: 'dot_access',
          resolvesTo: null, // Cross-file for now
          confidence: 'low',
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
    const scope: Scope = state.scopeMap.get(scopeId)!;
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
      const classScope = state.scopeMap.get(classScopeId)!;
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
      const classScope = state.scopeMap.get(classScopeId)!;
      // Find the inherit declaration matching this name (by alias or path name)
      for (const declId of classScope.declarations) {
        const decl = state.declMap.get(declId);
        if (decl && decl.kind === 'inherit') {
          const matches = decl.alias === inheritName || decl.name === inheritName;
          if (matches) {
            // Find the inherited scope that wireInheritance wired for this inherit
            // by looking for a class declaration with name == decl.name
            for (const inheritedId of classScope.inheritedScopes) {
              const inheritedScope = state.scopeMap.get(inheritedId)!;
              const parentScope = state.scopeMap.get(inheritedScope.parentId!)!;
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

/**
 * Find a declaration by name in a specific scope (and its inherited scopes).
 */
function findDeclInScope(name: string, scopeId: number, state: BuildState): number | null {
  const scope = state.scopeMap.get(scopeId)!;
  if (!scope) return null;

  for (const declId of scope.declarations) {
    const decl = state.declMap.get(declId);
    if (decl && decl.name === name) return declId;
  }

  // Check inherited scopes
  for (const inheritedId of scope.inheritedScopes) {
    const match = findDeclInScope(name, inheritedId, state);
    if (match !== null) return match;
  }

  return null;
}

/**
 * Find the scope ID that contains a given node.
 */
function findScopeForNode(node: Node, state: BuildState): number | null {
  const nodeStart = node.startPosition;
  const nodeEnd = node.endPosition;

  // Find the innermost scope that contains the node
  // When scopes have equal range size, prefer higher ID (deeper nesting)
  let bestScopeId: number | null = null;
  let bestSize = Infinity;

  for (const scope of state.scopes) {
    if (containsPosition(scope.range, nodeStart, nodeEnd)) {
      const size = rangeSize(scope.range);
      if (size < bestSize || (size === bestSize && scope.id > bestScopeId!)) {
        bestSize = size;
        bestScopeId = scope.id;
      }
    }
  }

  return bestScopeId;
}

function containsPosition(range: Range, start: Point, end: Point): boolean {
  return (
    (range.start.line < start.row ||
     (range.start.line === start.row && range.start.character <= start.column)) &&
    (range.end.line > end.row ||
     (range.end.line === end.row && range.end.character >= end.column))
  );
}

function rangeSize(range: Range): number {
  return (range.end.line - range.start.line) * 10000 +
         (range.end.character - range.start.character);
}

/**
 * Find the enclosing class scope for a node.
 */
function findEnclosingClassScopeId(node: Node, state: BuildState): number | null {
  const scopeId = findScopeForNode(node, state);
  if (scopeId === null) return null;

  let current: number | null = scopeId;
  while (current !== null) {
    const scope: Scope = state.scopeMap.get(current)!;
    if (scope.kind === 'class') return current;
    current = scope.parentId;
  }
  return null;
}

function findEnclosingClassDecl(node: Node, state: BuildState): number | null {
  const classScopeId = findEnclosingClassScopeId(node, state);
  if (classScopeId === null) return null;

  const classScope = state.scopeMap.get(classScopeId)!;
  // The class declaration is in the parent scope
  if (classScope.parentId !== null) {
    const parentScope = state.scopeMap.get(classScope.parentId)!;
    for (const declId of parentScope.declarations) {
      const decl = state.declMap.get(declId);
      if (decl && decl.kind === 'class') {
        // Check that this class's scope matches
        // (the class scope should be created by this class decl)
        return declId;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public query API
// ---------------------------------------------------------------------------

/**
 * Find the declaration at a given position (for go-to-definition).
 */
export function getDefinitionAt(
  table: SymbolTable,
  line: number,
  character: number,
): Declaration | null {
  // Find a reference at this position
  for (const ref of table.references) {
    if (ref.loc.line === line && ref.loc.character === character) {
      if (ref.resolvesTo !== null) {
        return table.declarations.find(d => d?.id === ref.resolvesTo) ?? null;
      }
    }
  }

  // Also check if the position is on a declaration name itself
  for (const decl of table.declarations) {
    const nr = decl.nameRange;
    if (nr.start.line === line && nr.end.line === line &&
        character >= nr.start.character && character <= nr.end.character) {
      // For inherit declarations, follow through to the target class
      if (decl.kind === 'inherit') {
        const target = resolveInheritToClass(decl, table);
        if (target) return target;
      }
      return decl;
    }
    // For inherit declarations with alias, also check the alias position
    if (decl.kind === 'inherit' && decl.alias) {
      // The alias is in the range but after the nameRange
      // Check if the position is within the declaration range and matches the alias text
      if (decl.range.start.line === line && decl.range.end.line === line &&
          character >= decl.range.start.character && character <= decl.range.end.character) {
        // Verify it's actually on the alias by checking the source text
        const target = resolveInheritToClass(decl, table);
        if (target) return target;
      }
    }
  }
  return null;
}

/**
 * Resolve an inherit declaration to the target class declaration.
 * Returns the class Declaration if found, null otherwise.
 */
function resolveInheritToClass(decl: Declaration, table: SymbolTable): Declaration | null {
  // Find the class scope that contains this inherit declaration
  const classScope = table.scopes.find(s => s.id === decl.scopeId);
  if (!classScope) return null;

  // Find the inherited scope wired by wireInheritance
  const parentScope = classScope.parentId !== null
    ? table.scopes.find(s => s.id === classScope.parentId)
    : null;
  if (!parentScope) return null;

  for (const parentDeclId of parentScope.declarations) {
    const parentDecl = table.declarations.find(d => d?.id === parentDeclId);
    if (parentDecl && parentDecl.kind === 'class' && parentDecl.name === decl.name) {
      return parentDecl;
    }
  }
  return null;
}

/**
 * Find all references to a declaration (for find-references).
 */
export function getReferencesTo(
  table: SymbolTable,
  line: number,
  character: number,
): Reference[] {
  // Find what's at this position
  let targetDeclId: number | null = null;

  // Is it a declaration?
  for (const decl of table.declarations) {
    const nr = decl.nameRange;
    if (nr.start.line === line && nr.end.line === line &&
        character >= nr.start.character && character <= nr.end.character) {
      targetDeclId = decl.id;
      break;
    }
  }

  // Is it a reference?
  if (targetDeclId === null) {
    for (const ref of table.references) {
      if (ref.loc.line === line && ref.loc.character === character) {
        targetDeclId = ref.resolvesTo;
        break;
      }
    }
  }

  if (targetDeclId === null) return [];

  // Collect all references that resolve to this declaration
  const results: Reference[] = [];
  for (const ref of table.references) {
    if (ref.resolvesTo === targetDeclId) {
      results.push(ref);
    }
  }

  // Also include the declaration itself as a "reference" (definition site)
  const decl = table.declarations.find(d => d?.id === targetDeclId);
  if (decl) {
    results.unshift({
      name: decl.name,
      loc: decl.nameRange.start,
      kind: 'identifier',
      resolvesTo: targetDeclId,
      confidence: 'high',
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Completion support: enumerate symbols visible at a position
// ---------------------------------------------------------------------------

/**
 * Find the scope ID that contains a given line/character position.
 * Returns the innermost scope containing the position.
 */
function findScopeAtPosition(table: SymbolTable, line: number, character: number): number | null {
  let bestScopeId: number | null = null;
  let bestSize = Infinity;

  for (const scope of table.scopes) {
    const r = scope.range;
    if ((
      r.start.line < line ||
      (r.start.line === line && r.start.character <= character)
    ) && (
      r.end.line > line ||
      (r.end.line === line && r.end.character >= character)
    )) {
      const size = rangeSize(r);
      if (size < bestSize || (size === bestSize && scope.id > bestScopeId!)) {
        bestSize = size;
        bestScopeId = scope.id;
      }
    }
  }

  return bestScopeId;
}

/**
 * Collect all declarations from a scope and its inherited scopes.
 * Used for class scope enumeration.
 */
function collectScopeDecls(scopeId: number, table: SymbolTable, seen: Set<number>, results: Declaration[]): void {
  const scope = table.scopes.find(s => s.id === scopeId);
  if (!scope || seen.has(scopeId)) return;
  seen.add(scopeId);

  for (const declId of scope.declarations) {
    const decl = table.declarations.find(d => d?.id === declId);
    if (decl && !seen.has(decl.id)) {
      // Skip inherit declarations themselves — they're not completable symbols
      if (decl.kind !== 'inherit') {
        results.push(decl);
      }
    }
  }

  // Recurse into inherited scopes
  for (const inheritedId of scope.inheritedScopes) {
    collectScopeDecls(inheritedId, table, seen, results);
  }
}

/**
 * Enumerate all declarations visible at a given position.
 * Walks the scope chain from innermost to file scope.
 * Returns declarations ordered by proximity (innermost scope first).
 * Skips duplicate names (inner scope shadows outer).
 */
export function getSymbolsInScope(
  table: SymbolTable,
  line: number,
  character: number,
): Declaration[] {
  const scopeId = findScopeAtPosition(table, line, character);
  if (scopeId === null) return [];

  const results: Declaration[] = [];
  const seenNames = new Set<string>();
  const seenScopes = new Set<number>();

  let current: number | null = scopeId;
  while (current !== null) {
    const scope = table.scopes.find(s => s.id === current);
    if (!scope) break;

    // Collect direct declarations in this scope
    for (const declId of scope.declarations) {
      const decl = table.declarations.find(d => d?.id === declId);
      if (!decl) continue;

      // Skip inherit declarations
      if (decl.kind === 'inherit') continue;

      // For block/function scopes, only include declarations before the cursor
      if (scope.kind !== 'class' && scope.kind !== 'file' && decl.kind !== 'parameter') {
        if (decl.range.start.line > line ||
            (decl.range.start.line === line && decl.range.start.character > character)) {
          continue;
        }
      }

      // Deduplicate by name (inner scope shadows outer)
      if (!seenNames.has(decl.name)) {
        seenNames.add(decl.name);
        results.push(decl);
      }
    }

    // For class scopes, collect inherited members
    if (scope.kind === 'class') {
      for (const inheritedId of scope.inheritedScopes) {
        const inheritedScope = table.scopes.find(s => s.id === inheritedId);
        if (!inheritedScope) continue;
        for (const declId of inheritedScope.declarations) {
          const decl = table.declarations.find(d => d?.id === declId);
          if (!decl || decl.kind === 'inherit') continue;
          if (!seenNames.has(decl.name)) {
            seenNames.add(decl.name);
            results.push(decl);
          }
        }
      }
    }

    current = scope.parentId;
  }

  return results;
}

/**
 * Get all declarations in a specific scope (including inherited).
 * For cross-file completion: resolve an inherit/module to a target file
 * and call this to get its class-level declarations.
 */
export function getDeclarationsInScope(table: SymbolTable, scopeId: number): Declaration[] {
  const results: Declaration[] = [];
  const seen = new Set<number>();
  collectScopeDecls(scopeId, table, seen, results);
  return results;
}

/**
 * Find the class scope ID that contains a given position.
 * Returns null if the position is not inside any class scope.
 */
export function findClassScopeAt(table: SymbolTable, line: number, character: number): number | null {
  const scopeId = findScopeAtPosition(table, line, character);
  if (scopeId === null) return null;

  let current: number | null = scopeId;
  while (current !== null) {
    const scope = table.scopes.find(s => s.id === current);
    if (!scope) break;
    if (scope.kind === 'class') return current;
    current = scope.parentId;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Scope wiring: resolve inherit declarations to inherited scopes
// ---------------------------------------------------------------------------

/**
 * After building the symbol table, wire up class inheritance.
 * For each class scope that contains `inherit` declarations,
 * find the inherited class's scope and add it to `inheritedScopes`.
 */
export function wireInheritance(table: SymbolTable): void {
  for (const scope of table.scopes) {
    if (scope.kind !== 'class') continue;

    const inheritDecls = scope.declarations
      .map(id => table.declarations.find(d => d?.id === id))
      .filter(d => d?.kind === 'inherit');

    for (const inheritDecl of inheritDecls) {
      if (!inheritDecl) continue;
      // Find a class declaration with this name in the parent (file) scope
      const parentScope = scope.parentId !== null ? table.scopes.find(s => s.id === scope.parentId) : null;
      if (!parentScope) continue;

      for (const candidateId of parentScope.declarations) {
        const candidate = table.declarations.find(d => d?.id === candidateId);
        if (candidate && candidate.kind === 'class' && candidate.name === inheritDecl.name) {
          // Find the class scope for this class declaration
          const classScope = table.scopes.find(s =>
            s.kind === 'class' &&
            s.parentId === scope.parentId &&
            containsRange(s.range, candidate.range)
          );
          if (classScope && classScope.id !== scope.id) {
            scope.inheritedScopes.push(classScope.id);
          }
        }
      }
    }
  }
}

function containsRange(outer: Range, inner: Range): boolean {
  return (
    (outer.start.line < inner.start.line ||
     (outer.start.line === inner.start.line && outer.start.character <= inner.start.character)) &&
    (outer.end.line > inner.end.line ||
     (outer.end.line === inner.end.line && outer.end.character >= inner.end.character))
  );
}
