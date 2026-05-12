/**
 * Code lens provider for Pike LSP.
 *
 * Shows reference counts above function and method declarations.
 * Uses the workspace index to count references across all files.
 */

import type { Tree } from "web-tree-sitter";
import type {
  CodeLens,
  CodeLensParams,
} from "vscode-languageserver/node";
import type { SymbolTable, Declaration } from "./symbolTable";
import type { WorkspaceIndex } from "./workspaceIndex";

/**
 * Produce code lenses for a document — reference count annotations
 * above function and method declarations.
 */
export function produceCodeLenses(
  table: SymbolTable,
  tree: Tree,
  uri: string,
  workspaceIndex: WorkspaceIndex,
): CodeLens[] {
  const lenses: CodeLens[] = [];

  for (const decl of table.declarations) {
    if (decl.kind !== "function" && decl.kind !== "method") continue;

    // Count references to this declaration across the workspace
    const refCount = countReferences(decl, uri, workspaceIndex);
    if (refCount === 0) continue;

    lenses.push({
      range: {
        start: {
          line: decl.nameRange.start.line,
          character: decl.nameRange.start.character,
        },
        end: {
          line: decl.nameRange.end.line,
          character: decl.nameRange.end.character,
        },
      },
      command: {
        title: `${refCount} reference${refCount !== 1 ? "s" : ""}`,
        command: "pike.showReferences",
        arguments: [
          uri,
          { line: decl.nameRange.start.line, character: decl.nameRange.start.character },
          [],
        ],
      },
    });
  }

  return lenses;
}

/**
 * Count references to a declaration across the workspace.
 */
function countReferences(
  decl: Declaration,
  uri: string,
  workspaceIndex: WorkspaceIndex,
): number {
  let count = 0;

  // Count same-file references
  const sameFileRefs = workspaceIndex.getCrossFileReferences(
    uri,
    decl.nameRange.start.line,
    decl.nameRange.start.character,
  );

  // Each reference from a different location counts
  // (exclude the declaration itself)
  for (const { ref } of sameFileRefs) {
    if (ref.line !== decl.nameRange.start.line ||
        ref.character !== decl.nameRange.start.character) {
      count++;
    }
  }

  return count;
}
