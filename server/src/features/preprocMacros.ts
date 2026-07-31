/**
 * Preprocessor handling for the declaration pass: `#define` macros and
 * `#include` directives.
 *
 * `#define` is a `preproc_define` node with a `name` field, an optional
 * `parameters` field (present exactly when the macro is function-like) and an
 * optional `body`. Identifiers inside the body are real nodes, so every other
 * feature can resolve them by position.
 *
 * `#include` IS structured (`preproc_include` with a `string_literal` or
 * `system_lib_string` `path` child); we record it as an `include` declaration
 * whose `name` is the raw path text. wireIncludes (scopeBuilder) later resolves
 * it and merges the target file's symbols.
 */
import type { Node } from 'web-tree-sitter';
import type { BuildState } from './symbolTable';
import {
  toRange,
  addDeclaration,
  currentScopeId,
} from './scopeBuilder';

/**
 * Add a `macro` declaration for a `#define` to the current scope. Returns true
 * when handled (so the caller can stop descending).
 */
export function collectPreprocDefine(node: Node, state: BuildState): boolean {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return false;

  addDeclaration(state, {
    name: nameNode.text,
    kind: 'macro',
    nameRange: toRange(nameNode),
    range: toRange(node),
    scopeId: currentScopeId(state),
    // A parameter list is only parsed when the paren abuts the name, which is
    // exactly the rule that makes a macro function-like.
    functionLike: node.childForFieldName('parameters') !== null,
  });
  return true;
}

/**
 * Record a `#include` directive as an `include` declaration in the current
 * scope. The `name` is the raw path node text (with quotes or angle brackets);
 * wireIncludes derives system-vs-quoted from the leading delimiter.
 */
export function collectPreprocInclude(node: Node, state: BuildState): void {
  const pathNode = node.childForFieldName('path');
  if (!pathNode) return;
  const name = pathNode.text;
  if (name.length === 0) return;

  addDeclaration(state, {
    name,
    kind: 'include',
    nameRange: toRange(pathNode),
    range: toRange(node),
    scopeId: currentScopeId(state),
  });
}
