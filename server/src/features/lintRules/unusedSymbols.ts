/**
 * Unused symbol lint rule — detects declarations with zero references.
 *
 * Decision 0028: Fast tree-sitter lint layer. This rule examines the symbol
 * table for local variables and parameters that are declared but never
 * referenced. It runs synchronously on every parse (<1ms).
 *
 * Scope: variables (DeclKind.Variable) and parameters (DeclKind.Parameter)
 * in program, function/method, block, and class scopes.
 *
 * Exclusions:
 * - Variables/params prefixed with `_` (Pike convention for intentionally unused)
 * - The bare `_` identifier (wildcard)
 */

import {
  type SymbolTable,
  type Declaration,
} from "../symbolTable";
import { Diagnostic, DiagnosticSeverity, Range } from "../diagnostics";

// ---------------------------------------------------------------------------
// Lint rule codes (P3xxx range, per decision 0028)
// ---------------------------------------------------------------------------

export const CODE_UNUSED_VARIABLE = "P3001";
export const CODE_UNUSED_PARAMETER = "P3002";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface LintOptions {
  /** Emit diagnostics for unused parameters. Default: true. */
  checkParameters?: boolean;
}

/**
 * Detect unused local variables and parameters.
 *
 * A declaration is "unused" if:
 * 1. Its scope is not file-level (file-scope symbols may be exported)
 * 2. No reference in the symbol table resolves to its declaration ID
 * 3. Its name is not prefixed with `_` (convention for intentionally unused)
 *
 * Returns diagnostics with severity Hint.
 */
export function detectUnusedSymbols(
  table: SymbolTable,
  options?: LintOptions,
): Diagnostic[] {
  const checkParams = options?.checkParameters ?? true;
  const diagnostics: Diagnostic[] = [];

  for (const decl of table.declarations) {
    if (!isLintable(decl, table, checkParams)) continue;

    // Count references that resolve to this declaration.
    const refCount = countReferencesTo(table, decl.id);
    if (refCount > 0) continue;

    const isParam = decl.kind === "parameter";
    diagnostics.push(
      Diagnostic.create(
        nameRange(decl),
        isParam
          ? `Parameter '${decl.name}' is unused`
          : `Variable '${decl.name}' is unused`,
        DiagnosticSeverity.Hint,
        isParam ? CODE_UNUSED_PARAMETER : CODE_UNUSED_VARIABLE,
        "pike-lsp-lint",
      ),
    );
  }

  return diagnostics;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Check if a declaration should be linted for unused status. */
function isLintable(
  decl: Declaration,
  table: SymbolTable,
  checkParams: boolean,
): boolean {
  // Only variables and parameters.
  if (decl.kind !== "variable" && decl.kind !== "parameter") return false;

  // Skip parameters if not checking them.
  if (decl.kind === "parameter" && !checkParams) return false;

  // Skip `_`-prefixed names (Pike convention for intentionally unused).
  if (decl.name.startsWith("_")) return false;

  // Program-scope variables are lintable in Pike: a file is an implicit
  // program, not an external module export list. Missing diagnostics here made
  // top-level unused state invisible while locals were reported correctly.
  const scope = table.scopeById.get(decl.scopeId);
  if (!scope) return false;

  return true;
}

/** Count references that resolve to a given declaration ID. */
function countReferencesTo(table: SymbolTable, declId: number): number {
  let count = 0;
  for (const ref of table.references) {
    if (ref.resolvesTo === declId) {
      count++;
    }
  }
  return count;
}

/** Extract the name range from a declaration as an LSP Range. */
function nameRange(decl: Declaration): Range {
  return Range.create(
    { line: decl.nameRange.start.line, character: decl.nameRange.start.character },
    { line: decl.nameRange.end.line, character: decl.nameRange.end.character },
  );
}
