/**
 * Inlay hints — shows inferred types inline for variable declarations.
 *
 * For variables declared without an explicit type annotation, the inlay hint
 * displays the assigned type as a quiet label after the variable name:
 *
 *   string name = "Rex";      // already typed — no hint
 *   name = "Rex";             // hint: name: string
 *   Dog d = Dog("Rex");       // already typed — no hint
 *   d = Dog("Rex");           // hint: d: Dog
 *
 * Decision 0028: Part of the intelligent LSP features plan (Phase G).
 * Only type hints for now (InlayHintKind.Type). Parameter name hints
 * are deferred to G2.
 */

import type { Tree, Node } from "web-tree-sitter";
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

  // Filter declarations to those in the requested range
  const rangeStartLine = range.start.line;
  const rangeEndLine = range.end.line;

  for (const decl of table.declarations) {
    // Only variable and parameter declarations
    if (decl.kind !== "variable" && decl.kind !== "parameter") continue;

    // Must be in the requested range
    if (decl.range.start.line < rangeStartLine || decl.range.start.line > rangeEndLine) continue;

    // Must have a known type (declared or assigned)
    const typeName = resolveTypeForHint(decl);
    if (!typeName) continue;

    // Skip if already has an explicit type annotation — the user wrote it
    if (decl.declaredType) continue;

    // Place the hint right after the variable name
    const nameEnd = decl.nameRange?.end ?? decl.range.end;
    hints.push(
      InlayHint.create(
        {
          line: nameEnd.line,
          character: nameEnd.character,
        },
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

/**
 * Determine the type name to display for a declaration.
 * Uses assignedType when declaredType is absent.
 */
function resolveTypeForHint(decl: Declaration): string | null {
  // If the user already declared the type, no hint needed
  if (decl.declaredType) return null;

  // Use assigned type from initialization analysis
  if (decl.assignedType && !OBVIOUS_TYPES.has(decl.assignedType)) {
    return decl.assignedType;
  }

  return null;
}
