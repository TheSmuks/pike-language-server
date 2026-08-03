/**
 * Recovering statements the parser folded into their predecessor.
 *
 * While a `;` is still untyped, tree-sitter does not insert a MISSING one — it
 * opens an ERROR node and the unfinished declaration swallows whatever follows.
 * `int x = 1` with `int y = 2;` beneath it parses as ONE local_declaration
 * spanning both lines, with `y` buried inside the initializer as an expression:
 *
 *     local_declaration [1,2]-[2,12]
 *       type: int
 *       name: x
 *       (ERROR [1,10]-[2,5] (identifier "int"))
 *       value: comma_expr [2,6]-[2,11]        <- `y = 2` lives in here
 *
 * So `y` is not a declaration to the symbol table at all: completion does not
 * offer it, hover and go-to-definition fail on it, and every reference to it in
 * the rest of the file goes unresolved — until the `;` above is typed.
 *
 * The grammar cannot be made to insert that `;`. Five approaches were tested
 * and disproven, including collapsing the expression cascade; see
 * docs/superpowers/plans/2026-08-03-grammar-expression-cascade.md.
 *
 * The fix is to hand the absorbed text back to the parser on its own, where it
 * is perfectly well-formed, and merge the declarations it yields at their true
 * positions. That reuses the real parser rather than pattern-matching the shape
 * of a recovery, which would be guesswork.
 */

import type { Node } from "web-tree-sitter";
import { parse } from "../parser";
import type { BuildState, Declaration } from "./symbolTable";
import { toRange } from "./scope-helpers";
import { addDeclaration, currentScopeId, popScope, pushScope } from "./scope-helpers-state";

/**
 * How deep the recovery may recurse.
 *
 * Each level re-parses a slice that starts strictly after the previous one, so
 * the text shrinks every time and termination does not depend on this cap — it
 * is a backstop, and it also bounds the work when a whole run of statements is
 * missing its semicolons.
 */
const MAX_RECOVERY_DEPTH = 8;

/** Beyond this, the absorbed region is not a statement or two — do not re-parse. */
const MAX_SLICE_LENGTH = 8192;

/**
 * The declaration collector, injected at module load.
 *
 * Injected rather than imported because the collector calls INTO this module:
 * a static import both ways is a cycle, and the lazy `require` that avoids one
 * does not survive the ESM build.
 */
let collectSubtree: (node: Node, state: BuildState) => void = () => {};

/** Wire the collector in. Called once, from declarationCollector.ts. */
export function setAbsorbedStatementCollector(
  collect: (node: Node, state: BuildState) => void,
): void {
  collectSubtree = collect;
}

/**
 * The point at which the absorbed statement begins.
 *
 * The ERROR node starts at the unfinished expression on the declaration's own
 * line and runs into the next one. The absorbed statement starts at the first
 * token inside it that sits on a LATER row — the first thing the user typed on
 * the following line.
 */
function absorbedStart(error: Node): Node | null {
  for (const child of error.children) {
    if (child.startPosition.row > error.startPosition.row) return child;
  }
  return null;
}

/** Shift a range from slice-local coordinates back to file coordinates. */
function shift(
  range: Declaration["nameRange"],
  anchorRow: number,
  anchorColumn: number,
): Declaration["nameRange"] {
  const move = (p: { line: number; character: number }) => ({
    line: p.line + anchorRow,
    // Only the slice's first line is horizontally offset; later lines start at
    // column 0 in both coordinate systems.
    character: p.line === 0 ? p.character + anchorColumn : p.character,
  });
  return { start: move(range.start), end: move(range.end) };
}

/**
 * Collect declarations from the statement(s) `decl` absorbed, into `decl`'s own
 * scope.
 *
 * A no-op unless the declaration actually contains an ERROR that reaches onto a
 * later line, which is the signature of the missing-semicolon recovery.
 */
export function recoverAbsorbedStatements(decl: Node, state: BuildState): void {
  if (state.recoveryDepth >= MAX_RECOVERY_DEPTH) return;
  if (!state.sourceText) return;

  const error = decl.children.find(child => child.isError);
  if (!error) return;
  if (error.endPosition.row <= decl.startPosition.row) return;

  const resume = absorbedStart(error);
  if (!resume) return;

  const slice = state.sourceText.slice(resume.startIndex, decl.endIndex);
  if (slice.trim().length === 0 || slice.length > MAX_SLICE_LENGTH) return;

  const declared = declarationsOf(slice, state.recoveryDepth + 1);
  mergeAt(declared, resume, state);
}

/** Top-level declarations of a standalone slice of source. */
function declarationsOf(slice: string, recoveryDepth: number): Declaration[] {
  let subRoot: Node | null;
  try {
    // No uri: this must not disturb the incremental-parse cache for the file.
    subRoot = parse(slice).rootNode;
  } catch {
    return [];
  }
  if (!subRoot) return [];

  // Built here rather than exported from symbolTable: that module is at its
  // 20-export limit, and nothing else needs a recovery state.
  const subState: BuildState = {
    nextId: 0,
    declarations: [],
    references: [],
    scopes: [],
    scopeMap: new Map(),
    declMap: new Map(),
    scopeStack: [],
    sortedScopes: [],
    sourceText: slice,
    recoveryDepth,
  };
  pushScope(subState, "file", toRange(subRoot));
  const fileScopeId = currentScopeId(subState);
  collectSubtree(subRoot, subState);
  popScope(subState);

  // Only what the absorbed statements declare at their own top level. A nested
  // scope's contents belong to a scope this merge does not recreate, and
  // hoisting them here would put them in the wrong one.
  return subState.declarations.filter(d => d.scopeId === fileScopeId);
}

/** Add slice-local declarations to `state` at their true file positions. */
function mergeAt(declared: Declaration[], resume: Node, state: BuildState): void {
  const anchorRow = resume.startPosition.row;
  const anchorColumn = resume.startPosition.column;
  const targetScope = currentScopeId(state);

  for (const found of declared) {
    addDeclaration(state, {
      name: found.name,
      kind: found.kind,
      nameRange: shift(found.nameRange, anchorRow, anchorColumn),
      range: shift(found.range, anchorRow, anchorColumn),
      scopeId: targetScope,
      ...(found.declaredType !== undefined ? { declaredType: found.declaredType } : {}),
      ...(found.assignedType !== undefined ? { assignedType: found.assignedType } : {}),
      ...(found.modifiers !== undefined ? { modifiers: found.modifiers } : {}),
    });
  }
}
