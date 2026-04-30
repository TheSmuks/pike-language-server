/**
 * Workspace symbol search (workspace/symbol).
 *
 * Searches across all indexed files for symbols matching a query.
 * Uses prefix matching on symbol names, case-insensitive.
 *
 * Design: iterates over WorkspaceIndex file entries, collects declarations
 * from each symbol table, filters by query. No PikeWorker needed.
 */

import type {
  SymbolInformation,
} from "vscode-languageserver/node";
import type { WorkspaceIndex, FileEntry } from "./workspaceIndex";
import type { Declaration, DeclKind } from "./symbolTable";

// ---------------------------------------------------------------------------
// DeclKind → LSP SymbolKind mapping
// ---------------------------------------------------------------------------

import { SymbolKind } from "vscode-languageserver/node";

const DECL_KIND_TO_SYMBOL_KIND: Record<DeclKind, SymbolKind> = {
  function: SymbolKind.Function,
  class: SymbolKind.Class,
  variable: SymbolKind.Variable,
  constant: SymbolKind.Constant,
  enum: SymbolKind.Enum,
  enum_member: SymbolKind.EnumMember,
  typedef: SymbolKind.TypeParameter,
  parameter: SymbolKind.Variable,
  inherit: SymbolKind.Module,
  import: SymbolKind.Module,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Search workspace symbols by query string.
 *
 * Performs case-insensitive prefix matching on declaration names.
 * Only searches files that have been indexed (opened or changed).
 */
export function searchWorkspaceSymbols(
  query: string,
  index: WorkspaceIndex,
): SymbolInformation[] {
  if (!query) return [];

  const lowerQuery = query.toLowerCase();
  const results: SymbolInformation[] = [];

  const entries = index.getAllEntries();

  for (const entry of entries) {
    if (!entry.symbolTable) continue;

    collectMatchingSymbols(
      entry,
      entry.symbolTable.declarations,
      lowerQuery,
      results,
    );
  }

  return results;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

/**
 * Collect declarations whose name starts with the lowercased query.
 */
function collectMatchingSymbols(
  entry: FileEntry,
  declarations: Declaration[],
  lowerQuery: string,
  results: SymbolInformation[],
): void {
  for (const decl of declarations) {
    if (!decl.name) continue;

    // Case-insensitive prefix match
    if (!decl.name.toLowerCase().startsWith(lowerQuery)) continue;

    // Skip parameters and imports — not useful in workspace search
    if (decl.kind === "parameter" || decl.kind === "import") continue;

    const kind = DECL_KIND_TO_SYMBOL_KIND[decl.kind];
    if (kind === undefined) continue;

    results.push({
      name: decl.name,
      kind,
      location: {
        uri: entry.uri,
        range: decl.nameRange,
      },
    });
  }
}
