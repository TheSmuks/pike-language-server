/**
 * Lint pipeline — orchestrates all fast tree-sitter lint rules.
 *
 * Decision 0028: The lint layer runs synchronously on every parse (<5ms total).
 * Each rule is a pure function that takes the parse tree and symbol table and
 * returns diagnostics. This module runs all rules and merges the results.
 *
 * Rules are ordered by typical output count (cheapest first):
 * 1. Unused symbols (few diagnostics, uses symbol table)
 * 2. Unreachable code (rare, pure AST walk)
 * 3. Missing return (only non-void functions)
 * 4. Unused imports (few, uses symbol table + text scan)
 */

import type { Tree } from "web-tree-sitter";
import type { SymbolTable } from "../symbolTable";
import type { Diagnostic } from "vscode-languageserver-types";
import { detectUnusedSymbols, type LintOptions } from "./unusedSymbols";
import { detectUnreachableCode } from "./unreachableCode";
import { detectMissingReturn } from "./missingReturn";
import { detectUnusedImports } from "./unusedImports";

export { detectUnusedSymbols } from "./unusedSymbols";
export { detectUnreachableCode } from "./unreachableCode";
export { detectMissingReturn } from "./missingReturn";
export { detectUnusedImports } from "./unusedImports";
export { CODE_UNUSED_VARIABLE, CODE_UNUSED_PARAMETER } from "./unusedSymbols";
export { CODE_UNREACHABLE } from "./unreachableCode";
export { CODE_MISSING_RETURN } from "./missingReturn";
export { CODE_UNUSED_IMPORT } from "./unusedImports";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface AllLintOptions extends LintOptions {
  /** Enable/disable individual rules. Default: all enabled. */
  unusedSymbols?: boolean;
  unreachableCode?: boolean;
  missingReturn?: boolean;
  unusedImports?: boolean;
}

/**
 * Run all lint rules and return merged diagnostics.
 *
 * This is the entry point called by DiagnosticManager on every parse.
 * Returns diagnostics from all enabled rules, in order.
 *
 * Performance budget: <5ms for a 500-line file.
 */
export function runLintRules(
  tree: Tree,
  table: SymbolTable,
  options?: AllLintOptions,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  if (options?.unusedSymbols !== false) {
    diagnostics.push(...detectUnusedSymbols(table, options));
  }

  if (options?.unreachableCode !== false) {
    diagnostics.push(...detectUnreachableCode(tree));
  }

  if (options?.missingReturn !== false) {
    diagnostics.push(...detectMissingReturn(tree, table));
  }

  if (options?.unusedImports !== false) {
    diagnostics.push(...detectUnusedImports(tree, table));
  }

  return diagnostics;
}
