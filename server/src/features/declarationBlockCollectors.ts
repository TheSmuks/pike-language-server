/**
 * Block-statement declaration collectors — for, foreach, if, while, do-while,
 * switch, catch, and simple declarations.
 *
 * Extracted from declarationCollector.ts to keep it under 500 lines.
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
import { DECL_KIND_MAP } from './declarationCollector';

// ---------------------------------------------------------------------------
// Block statement collectors
// ---------------------------------------------------------------------------

export function collectForStatement(node: Node, state: BuildState): void {
  // for_init_decl introduces a scope
  pushScope(state, 'for', toRange(node));

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
        nameRange: toRange(nameNode),
        range: toRange(initializer),
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

/**
 * Add a parameter declaration from an identifier node.
 */
/**
 * Declare a foreach loop variable.
 *
 * kind is 'variable', not 'parameter': `foreach(nums; int i; int val)` declares
 * locals scoped to the loop, not arguments to a call. Modelling them as
 * parameters made the linter say "Parameter 'i' is unused" and file it under
 * the unused-*parameter* rule — so turning off unused-parameter warnings (which
 * people do, since a signature can force an unused argument) silently also
 * turned off unused-loop-variable warnings, which are a different and
 * avoidable problem: Pike lets you omit the index entirely.
 */
function addLoopVarDecl(
  state: BuildState,
  idNode: Node,
  scopeId: number,
  declaredType?: string,
): void {
  addDeclaration(state, {
    name: idNode.text,
    kind: 'variable',
    nameRange: toRange(idNode),
    range: toRange(idNode),
    scopeId,
    ...(declaredType ? { declaredType } : {}),
  });
}

/**
 * Recursively collect identifier nodes from a container node
 * (comma_expr or array_destructure) and add them as loop-variable declarations.
 */
function collectIdsFromContainer(node: Node, state: BuildState, scopeId: number): void {
  for (const child of node.children) {
    if (child.type === 'identifier') {
      addLoopVarDecl(state, child, scopeId);
    }
  }
}

function collectForeachLvalues(node: Node, state: BuildState): void {
  const scopeId = currentScopeId(state);

  /**
   * Extract identifiers from a 'key' or 'value' field and add them as
   * loop-variable declarations. Handles typed form [type, identifier],
   * expression form [comma_expr], and array_destructure form.
   */
  const extractIdentifiersFromField = (fieldName: string): void => {
    const nodes = node.childrenForFieldName(fieldName);
    if (nodes.length === 0) return;

    // First pass: direct identifier children.
    for (const n of nodes) {
      if (n.type === 'identifier') addLoopVarDecl(state, n, scopeId);
    }

    // Second pass: compound expressions.
    //
    // `typed_lvalue` is the typed form — `foreach(items; int idx; string val)`.
    // The grammar wraps `type` + `name` in a typed_lvalue node, so the field
    // yields typed_lvalue, never a bare identifier. Omitting it here meant the
    // typed form declared nothing at all: no completion, hover, goto, or rename
    // for the loop variables. The bare form (`foreach(items; k; v)`) yields
    // comma_expr and worked, which is why this went unnoticed.
    if (!nodes.some(n => n.type === 'identifier')) {
      for (const n of nodes) {
        if (n.type === 'typed_lvalue') {
          // Carry the annotation through, so `foreach(dogs; int i; Dog d)`
          // can resolve `d->` to Dog's members. Without declaredType the
          // variable exists but has no type to resolve against.
          const nameNode = n.childForFieldName('name');
          const typeNode = n.childForFieldName('type');
          if (nameNode) addLoopVarDecl(state, nameNode, scopeId, typeNode?.text);
        } else if (n.type === 'comma_expr' || n.type === 'array_destructure') {
          collectIdsFromContainer(n, state, scopeId);
        }
      }
    }
  };

  extractIdentifiersFromField('key');
  extractIdentifiersFromField('value');
}

/**
 * The `cond_decl` a condition declares, or null.
 *
 * The grammar binds the `condition`/`value` field DIRECTLY to the cond_decl
 * (`condition: choice($._expr, $.cond_decl)`), so the node in hand already is
 * the declaration. Scanning its children for one — as this used to — looks one
 * level too deep and never matched, which left the scope these collectors open
 * permanently empty: `if (int last_ts = m[k])` declared nothing, so `last_ts`
 * resolved to nothing from the body and from its own name. The child scan is
 * kept as a fallback in case a future grammar wraps the condition.
 */
function condDeclOf(condition: Node | null): Node | null {
  if (!condition) return null;
  if (condition.type === 'cond_decl') return condition;
  for (const child of condition.children) {
    if (child.type === 'cond_decl') return child;
  }
  return null;
}

export function collectIfStatement(node: Node, state: BuildState): void {
  // cond_decl (declaration in condition) creates a scope for consequence + alternative
  const ifCondDecl = condDeclOf(node.childForFieldName('condition'));
  let pushedCondScope = false;
  if (ifCondDecl) {
    pushScope(state, 'if_cond', toRange(node));
    collectDeclarations(ifCondDecl, state);
    pushedCondScope = true;
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

export function collectWhileStatement(node: Node, state: BuildState): void {
  // cond_decl in condition creates a scope wrapping body
  const whileCondDecl = condDeclOf(node.childForFieldName('condition'));
  let pushedCondScope = false;
  if (whileCondDecl) {
    pushScope(state, 'while', toRange(node));
    collectDeclarations(whileCondDecl, state);
    pushedCondScope = true;
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

export function collectDoWhileStatement(node: Node, state: BuildState): void {
  // No cond_decl possible in do-while condition
  const body = node.childForFieldName('body');
  if (body) {
    pushScope(state, 'do_while', toRange(body));
    collectDeclarations(body, state);
    popScope(state);
  }
}

export function collectSwitchStatement(node: Node, state: BuildState): void {
  // cond_decl in value creates a scope wrapping body
  const switchCondDecl = condDeclOf(node.childForFieldName('value'));
  let pushedCondScope = false;
  if (switchCondDecl) {
    pushScope(state, 'switch', toRange(node));
    collectDeclarations(switchCondDecl, state);
    pushedCondScope = true;
  }

  // switch_statement has 'body' and 'value' fields (tree-sitter-pike v1.1.1+)
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

/**
 * Collect a catch expression: push a 'catch' scope for the block.
 * catch_expr has field 'value' pointing to the block (verified in WASM 2026-05-03).
 */
export function collectCatchExpr(node: Node, state: BuildState): void {
  const block = node.childForFieldName('value');
  if (block) {
    pushScope(state, 'catch', toRange(block));
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
        nameRange: toRange(recovered.nameNode),
        range: toRange(decl),
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
      nameRange: toRange(nameNode),
      range: toRange(decl),
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
export function collectModifiers(decl: Node): string[] | undefined {
  const mods: string[] = [];
  let node: Node | null = decl.parent?.type === 'declaration' ? decl.parent : decl;
  while (node) {
    for (const child of node.children) {
      if (child.type === 'modifier') mods.push(child.text);
    }
    // A modifier block — `private { … }` — applies its modifiers to every
    // declaration it wraps. Blocks nest through alternating declaration /
    // modifier_block nodes, and a class_body/block boundary ends the chain,
    // so a block's modifiers never leak into a wrapped class's own members.
    const parent: Node | null = node.parent;
    if (parent?.type === 'modifier_block') { node = parent; continue; }
    if (node.type === 'modifier_block' && parent?.type === 'declaration') { node = parent; continue; }
    break;
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
    aliasRange: aliasNode ? toRange(aliasNode) : undefined,
  });
}
