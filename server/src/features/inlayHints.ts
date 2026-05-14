/**
 * Inlay hints — shows inferred types inline for variable declarations.
 *
 * Type hints (G1): For variables declared without an explicit type annotation,
 * the inlay hint displays the assigned type as a quiet label after the name:
 *
 *   string name = "Rex";      // already typed — no hint
 *   name = "Rex";             // hint: name: string
 *
 * Parameter name hints (G2): BLOCKED — tree-sitter-pike does not produce
 * dedicated AST nodes for function call arguments. Function calls like
 * `greet("Rex", 5)` are parsed as `comma_expr > assign_expr` with no
 * `argument_list` or `postfix_expr` wrapper. This makes it impossible to
 * reliably distinguish call arguments from other comma-separated expressions.
 * Filed as upstream issue (see docs/known-limitations.md).
 *
 * Decision 0028: Part of the intelligent LSP features plan (Phase G).
 */

import type { Tree } from "web-tree-sitter";
import type { SymbolTable, Declaration } from "./symbolTable";
import type { Position } from "vscode-languageserver-types";
import { InlayHint, InlayHintKind } from "vscode-languageserver-types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InlayHintContext {
  tree: Tree;
  table: SymbolTable;
  /** Range to provide hints for. */
  range: { start: Position; end: Position };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Produce inlay hints for a range of source code.
 *
 * Currently provides type hints for:
 * - Variable declarations without an explicit type annotation
 *
 * @param ctx - context with parse tree, symbol table, and range
 * @returns array of InlayHint objects
 */
export function produceInlayHints(ctx: InlayHintContext): InlayHint[] {
  const hints: InlayHint[] = [];
  const { tree, table, range } = ctx;

  const rangeStartLine = range.start.line;
  const rangeEndLine = range.end.line;

  for (const decl of table.declarations) {
    if (decl.kind !== "variable" && decl.kind !== "parameter") continue;
    if (decl.range.start.line < rangeStartLine || decl.range.start.line > rangeEndLine) continue;

    const typeName = resolveTypeForHint(decl);
    if (!typeName) continue;

    if (decl.declaredType) continue;

    const nameEnd = decl.nameRange?.end ?? decl.range.end;
    hints.push(
      InlayHint.create(
        { line: nameEnd.line, character: nameEnd.character },
        `: ${typeName}`,
        InlayHintKind.Type,
      ),
    );
  }

  return hints;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Primitive types that are obvious enough to skip hints for. */
const OBVIOUS_TYPES = new Set(["mixed", "unknown"]);

function resolveTypeForHint(decl: Declaration): string | null {
  if (decl.declaredType) return null;
  if (decl.assignedType && !OBVIOUS_TYPES.has(decl.assignedType)) {
    return decl.assignedType;
  }
  return null;
}
