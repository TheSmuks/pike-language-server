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
  pushScope,
  popScope,
} from './scopeBuilder';

/**
 * Add a `macro` declaration for a `#define` to the current scope. Returns true
 * when handled (so the caller can stop descending).
 */
export function collectPreprocDefine(node: Node, state: BuildState): boolean {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return false;

  const params = node.childForFieldName('parameters');
  addDeclaration(state, {
    name: nameNode.text,
    kind: 'macro',
    nameRange: toRange(nameNode),
    range: toRange(node),
    scopeId: currentScopeId(state),
    // A parameter list is only parsed when the paren abuts the name, which is
    // exactly the rule that makes a macro function-like.
    functionLike: params !== null,
  });

  if (params) collectMacroParameters(node, params, nameNode.text, state);
  return true;
}

/**
 * Declare a function-like macro's parameters in a scope of their own.
 *
 * They used to be skipped outright — the reference collector had an explicit
 * `if (parameters.has(name)) continue` — which kept them from resolving to the
 * wrong thing but left 1,831 positions across Roxen 6.1 with no answer at all:
 * every `X` and `Y` in `#define LOC_M(X,Y) _STR_LOCALE("roxen_message",X,Y)`,
 * on both the parameter list and its uses in the body.
 *
 * A scope rather than a flat declaration, because a macro parameter *shadows*.
 * Pike's preprocessor substitutes textually, so with `int X = 100;` at file
 * level and `#define F(X) (X + X)`, `F(1)` evaluates to 2 — verified against
 * 8.0.1116, and `cpp()` shows the substitution. Resolving the `X` in that body
 * to the file's `X` would be a wrong answer; the innermost-scope lookup now
 * finds the parameter first and falls through to the file only for names the
 * macro does not bind.
 */
function collectMacroParameters(
  node: Node,
  params: Node,
  macroName: string,
  state: BuildState,
): void {
  const macroScope = pushScope(state, 'macro', toRange(node));
  for (const param of params.children) {
    if (param.type !== 'preproc_param') continue;
    const name = param.childForFieldName('name');
    if (!name) continue;
    addDeclaration(state, {
      name: name.text,
      kind: 'macro_parameter',
      nameRange: toRange(name),
      // The whole `preproc_param`, so a varargs `Y...` reads as written.
      range: toRange(param),
      scopeId: macroScope,
      declaredType: `parameter of ${macroName}`,
    });
  }
  popScope(state);
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
