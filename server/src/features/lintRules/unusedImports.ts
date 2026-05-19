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
import { DiagnosticSeverity } from "vscode-languageserver-types";
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
  const diagnostics: Diagnostic[] = [];

  // Collect import declarations only — inherit is excluded because inherited
  // members are used through implicit scope access (no module prefix needed).
  const imports = table.declarations.filter(
    d => d.kind === "import",
  );

  if (imports.length === 0) return diagnostics;

  // Use the provided source text for fast string scanning

  for (const decl of imports) {
    // The name of the imported module (e.g., "Stdio", "Animal")
    const name = decl.alias || decl.name;

    // Count references: the declaration itself, plus any usage.
    // A simple approach: check if the name appears more than once in the source
    // (the declaration counts as one, any usage counts as additional).
    const occurrences = countOccurrences(source, name);

    // If the name only appears once (the declaration itself), it's unused
    if (occurrences <= 1) {
      // Double-check with the symbol table references
      const refs = table.references.filter(r => r.name === name);
      if (refs.length === 0) {
        diagnostics.push({
          severity: DiagnosticSeverity.Hint,
          range: decl.nameRange ?? decl.range,
          message: `Imported module '${name}' is never used`,
          source: "pike-lint",
          code: CODE_UNUSED_IMPORT,
        });
      }
    }
  }

  return diagnostics;
}

/**
 * Count occurrences of a word in source text.
 * Uses word-boundary-aware matching to avoid false positives
 * (e.g., "Cat" shouldn't match "Category").
 */
function countOccurrences(source: string, word: string): number {
  let count = 0;
  const pattern = new RegExp(`\\b${escapeRegex(word)}\\b`, "g");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    count++;
    // Safety limit to prevent infinite loops on pathological input
    if (count > 1000) break;
  }
  return count;
}

/** Escape special regex characters in a string. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
