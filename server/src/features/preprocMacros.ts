/**
 * Preprocessor handling for the declaration pass: `#define` macros and
 * `#include` directives.
 *
 * tree-sitter-pike does NOT give `#define` a structured node — it emits a flat
 * `preprocessor_directive` node whose `.text` is the whole line (e.g.
 * `"#define MAX 10"`). We recover the macro name (and whether it is defined
 * function-like, `NAME(args)`) by matching the directive text, then synthesize a
 * name range from the match offset.
 *
 * `#include` IS structured (`preproc_include` with a `string_literal` or
 * `system_lib_string` `path` child); we record it as an `include` declaration
 * whose `name` is the raw path text. wireIncludes (scopeBuilder) later resolves
 * it and merges the target file's symbols.
 */
import type { Node } from 'web-tree-sitter';
import type { BuildState } from './symbolTable';
import {
  toLoc,
  toRange,
  addDeclaration,
  currentScopeId,
} from './scopeBuilder';

// `#define NAME` or `#define NAME(args)`. Group 1 = everything up to the name,
// group 2 = the macro name, group 3 = `(` only when function-like (no space
// between the name and the paren, per C/Pike macro rules).
const DEFINE_RE = /^(#\s*define\s+)([A-Za-z_]\w*)(\()?/;

/**
 * If `node` is a `#define` directive, add a `macro` declaration to the current
 * scope. Returns true when handled (so the caller can stop descending).
 */
export function collectPreprocDirective(node: Node, state: BuildState): boolean {
  const m = DEFINE_RE.exec(node.text);
  if (!m) return false;

  const prefixLen = m[1].length;
  const name = m[2];
  const functionLike = m[3] !== undefined;

  // The `#define <name>` prefix is ASCII, so the name's UTF-16 column is the
  // directive's start column plus the prefix length. The name lives on the
  // directive's first row even when the body uses `\` line continuations.
  const row = node.startPosition.row;
  const startCol = node.startPosition.column + prefixLen;
  const nameRange = {
    start: toLoc({ row, column: startCol }),
    end: toLoc({ row, column: startCol + name.length }),
  };

  addDeclaration(state, {
    name,
    kind: 'macro',
    nameRange,
    range: toRange(node),
    scopeId: currentScopeId(state),
    functionLike,
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
