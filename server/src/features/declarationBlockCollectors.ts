/**
 * Block-statement declaration collectors — for, foreach, if, while, do-while,
 * switch, catch, and simple declarations.
 *
 * Extracted from declarationCollector.ts to keep it under 500 lines.
 */

import type { Node } from 'web-tree-sitter';
import type { BuildState, DeclKind } from './symbolTable';
import {
  toRangeUtf16,
  getNameNodes,
  extractTypeText,
  extractInitializerType,
  currentScopeId,
  pushScope,
  popScope,
  addDeclaration,
} from './scopeBuilder';
import { DECL_KIND_MAP } from './declarationCollector';

// ---------------------------------------------------------------------------
// Block statement collectors
// ---------------------------------------------------------------------------

export function collectForStatement(node: Node, state: BuildState): void {
  // for_init_decl introduces a scope
  pushScope(state, 'for', toRangeUtf16(node, state.lines, state.offsetMap));

  // for_statement has initializer, body, and condition fields (tree-sitter-pike v1.1.1+)
  const initializer = node.childForFieldName('initializer');
  if (initializer) {
    // for_init_decl grammar: field('type', $.type), commaSep1(seq(field('name', $.identifier), ...))
    // Use childrenForFieldName('name') to get only the variable name identifiers,
    // not the type identifiers (which would be picked up by walking bare 'identifier' children).
    const scopeId = currentScopeId(state);
    for (const nameNode of initializer.childrenForFieldName('name')) {
      addDeclaration(state, {
        name: nameNode.text,
        kind: 'variable',
        nameRange: toRangeUtf16(nameNode, state.lines, state.offsetMap),
        range: toRangeUtf16(initializer, state.lines, state.offsetMap),
        scopeId,
      });
    }
  }

  const body = node.childForFieldName('body');
  if (body) {
    collectDeclarations(body, state);
  }

  popScope(state);
}

// Re-import collectDeclarations for recursive calls
import { collectDeclarations } from './declarationCollector';

export function collectForeachStatement(node: Node, state: BuildState): void {
  pushScope(state, 'foreach', toRangeUtf16(node, state.lines, state.offsetMap));

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

/**
 * Add a parameter declaration from an identifier node.
 */
function addParamDecl(state: BuildState, idNode: Node, scopeId: number): void {
  addDeclaration(state, {
    name: idNode.text,
    kind: 'parameter',
    nameRange: toRangeUtf16(idNode, state.lines, state.offsetMap),
    range: toRangeUtf16(idNode, state.lines, state.offsetMap),
    scopeId,
  });
}

/**
 * Recursively collect identifier nodes from a container node
 * (comma_expr or array_destructure) and add them as parameter declarations.
 */
function collectIdsFromContainer(node: Node, state: BuildState, scopeId: number): void {
  for (const child of node.children) {
    if (child.type === 'identifier') {
      addParamDecl(state, child, scopeId);
    }
  }
}

function collectForeachLvalues(node: Node, state: BuildState): void {
  const scopeId = currentScopeId(state);

  /**
   * Extract identifiers from a 'key' or 'value' field and add them as
   * parameter declarations. Handles typed form [type, identifier],
   * expression form [comma_expr], and array_destructure form.
   */
  const extractIdentifiersFromField = (fieldName: string): void => {
    const nodes = node.childrenForFieldName(fieldName);
    if (nodes.length === 0) return;

    // First pass: direct identifier children (typed form).
    for (const n of nodes) {
      if (n.type === 'identifier') addParamDecl(state, n, scopeId);
    }

    // Second pass: compound expressions (bare form, comma_expr, array_destructure).
    if (!nodes.some(n => n.type === 'identifier')) {
      for (const n of nodes) {
        if (n.type === 'comma_expr' || n.type === 'array_destructure') {
          collectIdsFromContainer(n, state, scopeId);
        }
      }
    }
  };

  extractIdentifiersFromField('key');
  extractIdentifiersFromField('value');
}

export function collectIfStatement(node: Node, state: BuildState): void {
  // cond_decl (declaration in condition) creates a scope for consequence + alternative
  const condition = node.childForFieldName('condition');
  let pushedCondScope = false;
  if (condition) {
    for (const child of condition.children) {
      if (child.type === 'cond_decl') {
        pushScope(state, 'if_cond', toRangeUtf16(node, state.lines, state.offsetMap));
        collectDeclarations(child, state);
        pushedCondScope = true;
        break;
      }
    }
  }

  // Consequence gets its own block scope
  const consequence = node.childForFieldName('consequence');
  if (consequence) {
    pushScope(state, 'block', toRangeUtf16(consequence, state.lines, state.offsetMap));
    collectDeclarations(consequence, state);
    popScope(state);
  }

  // Alternative gets its own block scope
  const alternative = node.childForFieldName('alternative');
  if (alternative) {
    pushScope(state, 'block', toRangeUtf16(alternative, state.lines, state.offsetMap));
    collectDeclarations(alternative, state);
    popScope(state);
  }

  if (pushedCondScope) {
    popScope(state);
  }
}

export function collectWhileStatement(node: Node, state: BuildState): void {
  // cond_decl in condition creates a scope wrapping body
  const condition = node.childForFieldName('condition');
  let pushedCondScope = false;
  if (condition) {
    for (const child of condition.children) {
      if (child.type === 'cond_decl') {
        pushScope(state, 'while', toRangeUtf16(node, state.lines, state.offsetMap));
        collectDeclarations(child, state);
        pushedCondScope = true;
        break;
      }
    }
  }

  // Body gets its own block scope
  const body = node.childForFieldName('body');
  if (body) {
    pushScope(state, 'block', toRangeUtf16(body, state.lines, state.offsetMap));
    collectDeclarations(body, state);
    popScope(state);
  }

  if (pushedCondScope) {
    popScope(state);
  }
}

export function collectDoWhileStatement(node: Node, state: BuildState): void {
  // No cond_decl possible in do-while condition
  const body = node.childForFieldName('body');
  if (body) {
    pushScope(state, 'do_while', toRangeUtf16(body, state.lines, state.offsetMap));
    collectDeclarations(body, state);
    popScope(state);
  }
}

export function collectSwitchStatement(node: Node, state: BuildState): void {
  // cond_decl in value creates a scope wrapping body
  const value = node.childForFieldName('value');
  let pushedCondScope = false;
  if (value) {
    for (const child of value.children) {
      if (child.type === 'cond_decl') {
        pushScope(state, 'switch', toRangeUtf16(node, state.lines, state.offsetMap));
        collectDeclarations(child, state);
        pushedCondScope = true;
        break;
      }
    }


  }

  // switch_statement has 'body' and 'value' fields (tree-sitter-pike v1.1.1+)
  const body = node.childForFieldName('body');
  if (body) {
    pushScope(state, 'block', toRangeUtf16(body, state.lines, state.offsetMap));
    collectDeclarations(body, state);
    popScope(state);
  }


  if (pushedCondScope) {
    popScope(state);
  }
}

/**
 * Collect a catch expression: push a 'catch' scope for the block.
 * catch_expr has field 'value' pointing to the block (verified in WASM 2026-05-03).
 */
export function collectCatchExpr(node: Node, state: BuildState): void {
  const block = node.childForFieldName('value');
  if (block) {
    pushScope(state, 'catch', toRangeUtf16(block, state.lines, state.offsetMap));
    collectDeclarations(block, state);
    popScope(state);
  }
}

export function collectSimpleDecl(node: Node, state: BuildState): void {
  const scopeId = currentScopeId(state);
  const kind = DECL_KIND_MAP[node.type];
  if (!kind) return;

  // Unwrap declaration wrapper
  const decl = node.type === 'declaration' ? node.firstChild : node;
  if (!decl || decl.isError) return;

  const actualKind = DECL_KIND_MAP[decl.type];
  if (!actualKind) {
    for (const child of node.children) collectDeclarations(child, state);
    return;
  }

  if (decl.type === 'enum_decl') { collectEnumDecl(decl, state); return; }
  if (decl.type === 'inherit_decl' || decl.type === 'import_decl') { collectInheritDecl(decl, state); return; }

  // Typed constants (`constant int FOO = 1;`) are idiomatic Pike, but the
  // tree-sitter grammar has no rule for them: it binds the type identifier to
  // the `name` field and pushes the real name into a trailing ERROR node. Without
  // this recovery, the constant is (wrongly) named after its type and the real
  // name never becomes a symbol. Recover the real name from the ERROR node.
  if (decl.type === 'constant_decl') {
    const recovered = recoverTypedConstant(decl);
    if (recovered) {
      addDeclaration(state, {
        name: recovered.nameNode.text, kind: 'constant',
        nameRange: toRangeUtf16(recovered.nameNode, state.lines, state.offsetMap),
        range: toRangeUtf16(decl, state.lines, state.offsetMap),
        scopeId, declaredType: recovered.typeText,
      });
      return;
    }
  }

  collectNamedDecl(decl, actualKind, state, scopeId);
}

/**
 * Emit a symbol for each declared name of a plain variable/constant declaration
 * (Pike allows `int a, b, c;`), falling back to the `name` field when the
 * grammar exposes no name list.
 */
function collectNamedDecl(decl: Node, actualKind: DeclKind, state: BuildState, scopeId: number): void {
  const nameNodes = getNameNodes(decl);
  const typeText = extractTypeText(decl);
  const assignedType = (actualKind === 'variable' && (!typeText || typeText === 'mixed'))
    ? extractInitializerType(decl) : undefined;
  const modifiers = collectModifiers(decl);

  const targets = nameNodes.length > 0 ? nameNodes : [decl.childForFieldName('name')];
  for (const nameNode of targets) {
    if (!nameNode) continue;
    addDeclaration(state, {
      name: nameNode.text, kind: actualKind,
      nameRange: toRangeUtf16(nameNode, state.lines, state.offsetMap),
      range: toRangeUtf16(decl, state.lines, state.offsetMap),
      scopeId, declaredType: typeText, assignedType, modifiers,
    });
  }
}

/**
 * Collect visibility/storage modifiers (`private`, `protected`, `public`,
 * `static`, `variant`, …) for a declaration. In tree-sitter-pike the modifiers
 * are `modifier` children of the enclosing `declaration` node, not of the inner
 * `variable_decl`/`constant_decl`, so look at the parent when present.
 */
function collectModifiers(decl: Node): string[] | undefined {
  const container = decl.parent?.type === 'declaration' ? decl.parent : decl;
  const mods: string[] = [];
  for (const child of container.children) {
    if (child.type === 'modifier') mods.push(child.text);
  }
  return mods.length > 0 ? mods : undefined;
}

/**
 * Recover the real name of a typed constant (`constant <type> <name> = ...`).
 * The grammar has no rule for a type before the name, so it misparses one of the
 * two identifiers into an ERROR node — and the shape is inconsistent (at file
 * scope the type takes the `name` field and the name lands in the ERROR; inside
 * a class it is reversed). Rather than depend on which slot is which, use
 * position: in `constant <type> <name> = <value>` the name is always the
 * rightmost identifier before the `=`. Returns null for untyped constants (one
 * identifier before `=`), which the grammar already handles correctly.
 */
function recoverTypedConstant(decl: Node): { nameNode: Node; typeText: string } | null {
  let eqIndex = Number.POSITIVE_INFINITY;
  for (const child of decl.children) {
    if (child.type === '=') { eqIndex = child.startIndex; break; }
  }
  const ids: Node[] = [];
  collectIdentifiersBefore(decl, eqIndex, ids);
  if (ids.length < 2) return null;
  ids.sort((a, b) => a.startIndex - b.startIndex);
  const nameNode = ids[ids.length - 1];
  const typeText = ids.slice(0, -1).map((n) => n.text).join(' ');
  return { nameNode, typeText };
}

/** Collect `identifier` nodes under `node` that start before `limit`. */
function collectIdentifiersBefore(node: Node, limit: number, out: Node[]): void {
  if (node.startIndex >= limit) return;
  if (node.type === 'identifier') { out.push(node); return; }
  for (const child of node.children) collectIdentifiersBefore(child, limit, out);
}

function collectEnumDecl(node: Node, state: BuildState): void {
  const scopeId = currentScopeId(state);
  const nameNode = node.childForFieldName('name');
  if (nameNode) {
    addDeclaration(state, {
      name: nameNode.text,
      kind: 'enum',
      nameRange: toRangeUtf16(nameNode, state.lines, state.offsetMap),
      range: toRangeUtf16(node, state.lines, state.offsetMap),
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
          nameRange: toRangeUtf16(memberName, state.lines, state.offsetMap),
          range: toRangeUtf16(child, state.lines, state.offsetMap),
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
    nameRange: toRangeUtf16(pathNode, state.lines, state.offsetMap),
    range: toRangeUtf16(node, state.lines, state.offsetMap),
    scopeId,
    alias: aliasNode ? aliasNode.text : undefined,
  });
}
