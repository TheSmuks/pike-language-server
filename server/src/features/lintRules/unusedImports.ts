/**
 * Unused import lint rule — detects import declarations with no references.
 *
 * Decision 0028: Part of the fast tree-sitter lint layer. This rule examines
 * import declarations and checks whether the imported module name is referenced
 * anywhere in the file. If no reference is found, the import is flagged as unused.
 *
 * Detection strategy:
 * - For `import Stdio;`, check if `Stdio` appears in any expression
 *
 * Exclusions:
 * - `inherit` declarations are excluded entirely. Inherited members become part
 *   of the current class scope and are used without the module prefix. Detecting
 *   whether inherited members are actually used requires cross-file type analysis,
 *   which is Pike's job (and Pike's runtime behavior of returning 0 for null
 *   means removing a "seemingly unused" inherit silently breaks code).
 * - Imported modules that bring names into scope implicitly (same class of
 *   false positive as inherit) — left to Pike diagnostics.
 */

import type { Tree } from "web-tree-sitter";
import type { Diagnostic } from "vscode-languageserver-types";
import type { SymbolTable } from "../symbolTable";

/** Diagnostic code for unused import. */
export const CODE_UNUSED_IMPORT = "P3005";

/**
 * Detect import declarations that are never referenced in the file.
 *
 * Inherit declarations are excluded — their members are used through implicit
 * scope access and cannot be reliably detected without cross-file type analysis.
 * Pike itself handles this at runtime.
 *
 * @param tree - tree-sitter parse tree
 * @param table - symbol table with declarations
 * @returns diagnostics for unused imports
 */
export function detectUnusedImports(
  tree: Tree,
  table: SymbolTable,
  source: string,
): Diagnostic[] {
  void tree;
  void table;
  void source;

  // Imports are intentionally excluded. Pike imports expose names through
  // implicit scope access, so `import Stdio; write("x");` uses Stdio even
  // though the literal module token appears only in the import declaration.
  // Precise unused-import detection needs resolved exported symbols; leave it
  // to Pike diagnostics until the LSP has that analysis.
  return [];
}
