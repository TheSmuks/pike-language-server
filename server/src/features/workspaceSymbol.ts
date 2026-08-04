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
import { restoreEmptyLiveEntries } from "./restoreLiveEntries";
import type { Declaration, DeclKind } from "./symbolTable";
import type { Connection } from "vscode-languageserver/node";
import type { CancellationToken } from "vscode-jsonrpc";
import { ProgressType } from "vscode-jsonrpc";
import { prepareGlobalQuery } from "./workspaceResolution";

// ---------------------------------------------------------------------------
// Work-done progress on a client-supplied token
// ---------------------------------------------------------------------------

const workDoneProgress = new ProgressType<{
  kind: string;
  title?: string;
  message?: string;
  percentage?: number;
}>();

/**
 * Report progress on a token the client put in the request params.
 *
 * Distinct from backgroundIndex's reporter, which asks the client to create a
 * server-initiated token. When the client supplies `workDoneToken` it has
 * already created it, so `window/workDoneProgress/create` must NOT be sent —
 * we report on the given token directly (LSP 3.15 §workDoneProgress).
 *
 * Returns a no-op reporter when the client supplied no token.
 */
function beginClientProgress(
  connection: Connection,
  token: string | number | undefined,
  title: string,
): { end: (message?: string) => void } {
  if (token === undefined) return { end: () => {} };

  const send = (value: { kind: string; title?: string; message?: string }) => {
    try {
      connection.sendProgress(workDoneProgress, token, value);
    } catch {
      // A client that vanished mid-request must not fail the request.
    }
  };

  send({ kind: "begin", title });
  let ended = false;
  return {
    end: (message?: string) => {
      if (ended) return; // `end` must be sent at most once per token.
      ended = true;
      send({ kind: "end", message });
    },
  };
}

// ---------------------------------------------------------------------------
// DeclKind → LSP SymbolKind mapping
// ---------------------------------------------------------------------------

import { SymbolKind } from "vscode-languageserver/node";

const DECL_KIND_TO_SYMBOL_KIND: Record<DeclKind, SymbolKind> = {
  function: SymbolKind.Function,
  method: SymbolKind.Method,
  class: SymbolKind.Class,
  variable: SymbolKind.Variable,
  constant: SymbolKind.Constant,
  enum: SymbolKind.Enum,
  enum_member: SymbolKind.EnumMember,
  typedef: SymbolKind.TypeParameter,
  parameter: SymbolKind.Variable,
  macro_parameter: SymbolKind.Variable,
  inherit: SymbolKind.Module,
  import: SymbolKind.Module,
  include: SymbolKind.File,
  macro: SymbolKind.Constant,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Search workspace symbols by query string.
 *
 * Performs case-insensitive prefix matching on declaration names.
 * Only searches files that have been indexed (opened or changed).
 * An empty string query returns all indexed symbols.
 */
export function searchWorkspaceSymbols(
  query: string,
  index: WorkspaceIndex,
): SymbolInformation[] {
  const lowerQuery = query.toLowerCase();
  const results: SymbolInformation[] = [];
  const liveUris = new Set<string>();
  // Spans every entry: one declaration must not be listed once per includer.
  const seen = new Set<string>();

  // Live entries (open / edited / hydrated) are authoritative — they reflect
  // unsaved edits that the resident snapshot cannot.
  for (const entry of index.getAllEntries()) {
    if (!entry.symbolTable) continue;
    liveUris.add(entry.uri);
    collectMatchingSymbols(entry, entry.symbolTable.declarations, lowerQuery, results, seen);
  }

  // Resident index covers cached-but-not-loaded (stub) files with zero
  // hydration — the modern-LSP win: complete search without a full scan.
  const resident = index.symbolIndex;
  if (resident) {
    for (const ref of resident.search(lowerQuery)) {
      if (liveUris.has(ref.uri)) continue; // a live table supersedes the snapshot
      const kind = DECL_KIND_TO_SYMBOL_KIND[ref.kind as DeclKind];
      if (kind === undefined) continue;
      results.push({ name: ref.name, kind, location: { uri: ref.uri, range: ref.nameRange } });
    }
  }

  return results;
}

/**
 * Lazy workspace symbol search — ensures the workspace is indexed before searching.
 *
 * In `openFiles` mode, the first call triggers a full workspace scan via
 * prepareGlobalQuery, reporting progress and supporting cancellation. Once the
 * scan completes, the search runs against the full index.
 *
 * Per contracts/lsp-resource-state.md: results are always complete — never
 * partial. If the caller cancels, returns an empty array.
 */
export async function searchWorkspaceSymbolsLazy(
  query: string,
  index: WorkspaceIndex,
  connection: Connection,
  cancellationToken?: CancellationToken,
  workDoneToken?: string | number,
): Promise<SymbolInformation[]> {
  // A client that supplies a token is waiting on begin…end for this request, so
  // bracket the whole query — including the lazy preparation below, which is the
  // part that can take long enough to need an "Indexing…" indicator.
  const progress = beginClientProgress(connection, workDoneToken, "Searching workspace symbols");
  try {
    // With a resident symbol index, answer from it (+ live entries) — no need to
    // force-index the whole workspace into RAM. Fall back to a full scan only when
    // there is no index (old caches predating the manifest, or a fresh workspace).
    if (!index.symbolIndex) {
      await prepareGlobalQuery({
        connection,
        index,
        workspaceRoot: index.workspaceRoot,
        cancellationToken,
      });
      // Cancellation during preparation — return empty (protocol allows this).
      if (cancellationToken?.isCancellationRequested) return [];
    }

    await restoreEmptyLiveEntries(index);
    return searchWorkspaceSymbols(query, index);
  } finally {
    // `end` must be sent even when preparation throws (e.g. degraded mode),
    // or the client's progress indicator hangs forever.
    progress.end();
  }
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
  seen: Set<string>,
): void {
  for (const decl of declarations) {
    if (!decl.name) continue;

    // Case-insensitive prefix match
    if (!decl.name.toLowerCase().startsWith(lowerQuery)) continue;

    // Skip parameters and imports — not useful in workspace search. A macro
    // parameter is the strongest case of it: `X` and `Y` are scoped to one
    // `#define` line, and Roxen alone declares 920 of them.
    if (decl.kind === "parameter" || decl.kind === "macro_parameter" ||
        decl.kind === "import") continue;

    const kind = DECL_KIND_TO_SYMBOL_KIND[decl.kind];
    if (kind === undefined) continue;

    // A symbol table holds declarations CLONED from the files it #includes and
    // inherits, and those carry the coordinates they have in THEIR file.
    // Pairing them with this entry's URI pointed the result at whatever happens
    // to sit at that line here — often a random line, sometimes past the end of
    // the file. The declaration belongs to the file that actually contains it.
    const uri = decl.sourceUri ?? entry.uri;
    // Reporting the same declaration once per includer would list a header's
    // symbols as many times as the workspace includes it.
    const key = `${uri} ${decl.nameRange.start.line} ${decl.nameRange.start.character} ${decl.name}`;
    if (seen.has(key)) continue;
    seen.add(key);

    results.push({
      name: decl.name,
      kind,
      location: {
        uri,
        range: decl.nameRange,
      },
    });
  }
}
