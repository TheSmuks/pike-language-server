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
 */

import { Tree } from "web-tree-sitter";
import type { SymbolTable } from "../symbolTable";
import { Diagnostic } from "../diagnostics";
import { detectUnusedSymbols, type LintOptions } from "./unusedSymbols";
import { detectUnreachableCode } from "./unreachableCode";

export { detectUnusedSymbols } from "./unusedSymbols";
export { detectUnreachableCode } from "./unreachableCode";
export { CODE_UNUSED_VARIABLE, CODE_UNUSED_PARAMETER } from "./unusedSymbols";
export { CODE_UNREACHABLE } from "./unreachableCode";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface AllLintOptions extends LintOptions {
  /** Enable/disable individual rules. Default: all enabled. */
  unusedSymbols?: boolean;
  unreachableCode?: boolean;
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

  return diagnostics;
}
