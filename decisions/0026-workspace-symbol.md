# 0026: Workspace Symbol

**Status**: Accepted
**Date**: 2026-05-04
**Decision Maker**: Pike LSP team

## Context

The LSP `workspace/symbol` request lets users search for symbols (classes, functions, variables, etc.) across the entire workspace. The client sends a query string; the server returns matching symbols.

Pike has a rich namespace: top-level functions, classes, constants, nested classes, and imported symbols. The server must search across all indexed files efficiently.

## Decision

### Search strategy

1. **Prefix search**: Match symbols whose name starts with the query (case-insensitive)
2. **Workspace index**: Use the `WorkspaceIndex` to enumerate all indexed declarations
3. **Symbol kind filtering**: Optional filter by `SymbolKind` (class, function, variable, etc.)
4. **Limit**: Cap results at 50 to avoid flooding the client

### Implementation

1. On request, walk the `WorkspaceIndex` symbol map
2. For each symbol, check if `symbol.name` starts with `query` (case-insensitive)
3. Optionally filter by `kind` if the request specifies a `kind` set
4. Build `WorkspaceSymbol` with the symbol's name, kind, container name (file/module), and location
5. Sort by relevance: exact prefix match > partial prefix match > name contains query
6. Return the top `limit` results

### Performance

- The workspace index is built at startup and updated on file changes
- No PikeWorker involvement — purely in-memory index search
- Target: < 20ms for 300-file workspace

### Edge cases

- Empty query returns the top 50 symbols by name (useful for "show all" behavior)
- Symbols with the same name in different files: return each one with its file as container
- Imported symbols: included in the index as part of the importing file's scope

## Consequences

### Positive

- Fast, in-memory search — no disk I/O or subprocess calls
- Case-insensitive prefix match is the most useful search pattern for Pike
- Returns file location for each result — "go to symbol" is one click away

### Negative

- No fuzzy matching (query "buf" doesn't match "String.Buffer")
- No search by type (query "int" doesn't return all int-typed variables)
- Large workspaces may need pagination (not implemented yet)

### Neutral

- The 50-result cap is a tradeoff between completeness and client performance
- Workspace symbol search is read-only — no symbol modifications