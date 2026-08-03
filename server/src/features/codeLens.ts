/**
 * Code lens provider for Pike LSP.
 *
 * Shows reference counts above function and method declarations.
 *
 * Lazy resolution (LSP codeLens/resolve): `produceCodeLenses` emits bare
 * lenses — a range plus a `data` payload identifying the declaration — without
 * touching the workspace index. The (potentially workspace-wide) reference
 * count is computed in `resolveCodeLens`, which the client calls only for the
 * lenses it actually renders. This avoids counting references for every
 * declaration in a large file when only a handful are on screen.
 */

import type {
  CodeLens,
} from "vscode-languageserver/node";
import type { SymbolTable } from "./symbolTable";
import { isWrittenInFile } from "./symbolTable";
import type { WorkspaceIndex } from "./workspaceIndex";

// ---------------------------------------------------------------------------
// Lens data payload
// ---------------------------------------------------------------------------

/** Identifies the declaration a lens annotates, for lazy resolution. */
export interface CodeLensData {
  uri: string;
  line: number;
  character: number;
}

function isCodeLensData(value: unknown): value is CodeLensData {
  if (typeof value !== "object" || value === null) return false;
  const d = value as Record<string, unknown>;
  return typeof d.uri === "string" &&
    typeof d.line === "number" &&
    typeof d.character === "number";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Produce unresolved code lenses for a document — one per function/method
 * declaration. Reference counts are filled in later by `resolveCodeLens`.
 */
export function produceCodeLenses(
  table: SymbolTable,
  uri: string,
): CodeLens[] {
  const lenses: CodeLens[] = [];

  for (const decl of table.declarations) {
    if (decl.kind !== "function" && decl.kind !== "method") continue;
    // A declaration cloned from an inherited or #include'd file carries that
    // file's coordinates — a lens built from them lands on an arbitrary line.
    if (!isWrittenInFile(table, decl)) continue;

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
      data: {
        uri,
        line: decl.nameRange.start.line,
        character: decl.nameRange.start.character,
      } satisfies CodeLensData,
    });
  }

  return lenses;
}

/**
 * Resolve a single code lens: count references to its declaration across the
 * workspace and attach the "N references" command. Returns the lens unchanged
 * if it carries no recognizable data payload.
 */
export function resolveCodeLens(
  lens: CodeLens,
  workspaceIndex: WorkspaceIndex,
): CodeLens {
  if (!isCodeLensData(lens.data)) return lens;
  const { uri, line, character } = lens.data;

  const count = countReferences(uri, line, character, workspaceIndex);

  lens.command = {
    title: `${count} reference${count !== 1 ? "s" : ""}`,
    command: "pike.showReferences",
    arguments: [uri, { line, character }, []],
  };
  return lens;
}

// ---------------------------------------------------------------------------
// Internal: reference counting
// ---------------------------------------------------------------------------

/**
 * Count references to the declaration at (line, character) across the
 * workspace, excluding the declaration site itself.
 */
function countReferences(
  uri: string,
  line: number,
  character: number,
  workspaceIndex: WorkspaceIndex,
): number {
  let count = 0;

  const refs = workspaceIndex.getCrossFileReferences(uri, line, character);
  for (const { uri: refUri, ref } of refs) {
    // Skip only the declaration's OWN occurrence, which by definition lives in
    // the lens's file. Without the URI test, a reference that happens to sit at
    // the same line and column in a DIFFERENT file was dropped too, so the lens
    // said "0 references" for a function that is genuinely called — and the
    // lens is the one-glance signal a developer uses to decide it is dead.
    if (refUri === uri && ref.loc.line === line && ref.loc.character === character) {
      continue;
    }
    count++;
  }

  return count;
}
