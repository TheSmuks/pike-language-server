# 0011: Types, Diagnostics, and Hover

**Status:** Proposed (Phase 5 entry)
**Date:** 2026-04-28
**Depends on:** 0002 (tier-3 scope), 0010 (cross-file resolution)

## Context

Phase 4 built cross-file resolution. Phase 5 makes the LSP semantically useful: diagnostics from Pike, hover types from multiple sources.

## 1. Pike Subprocess Lifecycle

### Decision: Keep-alive subprocess (typescript-language-server pattern)

**Chosen:** One long-lived Pike process, reused across requests. The subprocess communicates over stdio using a simple JSON protocol.

**Alternatives rejected:**

| Alternative | Cost |
|-------------|------|
| Spawn per request | ~200ms startup per Pike invocation. Unacceptable for save-triggered diagnostics. |
| pike-ai-kb MCP server | Not under our control; may not be running; different interface. |
| In-process Pike | Not possible — Pike is a C program, not a library. |

### Architecture

```
┌─────────────┐  stdio (JSON)  ┌──────────────┐
│  LSP Server  │ ◄──────────► │  Pike Worker  │
│  (Node.js)   │               │  (long-lived) │
└─────────────┘               └──────────────┘
```

The Pike worker script (`harness/worker.pike`) is a long-lived process that:
1. Reads JSON requests from stdin (one per line)
2. Dispatches to the appropriate handler (diagnose, type-of, etc.)
3. Writes JSON responses to stdout (one per line)

### Lifecycle management

- **Start**: On first request that needs Pike (lazy start)
- **Keep alive**: Process stays alive across requests
- **Crash recovery**: Detect via exit code / stderr; restart on next request
- **Shutdown**: Terminate on LSP server shutdown
- **Timeout**: If Pike doesn't respond within 5s, kill and restart

### Protocol

Request:
```json
{"id": 1, "method": "diagnose", "params": {"file": "path/to/file.pike", "source": "..."})
```

Response:
```json
{"id": 1, "result": {"diagnostics": [...]}}
```

Error:
```json
{"id": 1, "error": {"code": -1, "message": "Compilation failed"}}
```

## 2. Diagnostic Pipeline

### Decision: Save-only initially

Diagnostics are triggered on `textDocument/didSave` only. Real-time-with-debouncing is Phase 6.

**Rationale:** Save-triggered diagnostics are correct by construction — the file on disk matches what Pike compiles. Real-time diagnostics would require compiling unsaved buffer content, which has edge cases with preprocessor directives, includes, and module resolution.

### Pipeline

```
User saves file
    → LSP receives didSave notification
    → Forward source to Pike worker via "diagnose" request
    → Pike worker compiles with CompilationHandler
    → Returns structured diagnostics
    → LSP maps positions and publishes via textDocument/publishDiagnostics
```

### Diagnostic normalization

Pike's diagnostics include:
- Line number (1-based)
- Message text (e.g., "Bad type in assignment.")
- Expected/Actual type lines (continuation lines starting with "Expected:" and "Got     :")

The harness already normalizes these (decision 0005). The LSP reuses the same normalization.

### Severity mapping

| Pike severity | LSP DiagnosticSeverity |
|---------------|----------------------|
| Error | Error (1) |
| Warning | Warning (2) |

## 3. Position Mapping

### Decision: Pike and LSP use the same position encoding

Both Pike and LSP use 0-based lines and 0-based columns (character offsets). Pike's CompilationHandler reports `line` as 1-based. The mapping is:

```
LSP line = Pike line - 1
LSP character = 0 (Pike doesn't report columns for diagnostics)
```

### Unicode handling

Pike's line numbers are based on the source text as-is. LSP positions use UTF-16 code units. For files with non-ASCII content:
- Line numbers are unaffected (newlines are single bytes)
- Column numbers for diagnostics are always 0 (Pike doesn't report columns)

This is acceptable because Pike doesn't report column information. When Phase 6 adds column-level diagnostics (if ever), this mapping will need revisiting.

### Line ending handling

Pike normalizes line endings during compilation. The LSP sends full document content on didSave, which preserves the file's line endings. Since Pike reports line numbers (not byte offsets), line ending differences don't affect diagnostic positions.

## 4. Hover Routing

### Decision: Three-source routing per decision 0002

Hover requests route to different sources based on the identifier type:

| Identifier type | Primary source | Fallback | Implementation |
|----------------|---------------|----------|---------------|
| Stdlib symbol (Stdio, Array, etc.) | Pike runtime (`pike-signature` via introspect) | — | Phase 5 |
| Local variable/parameter | Tree-sitter (declared type annotation) | Pike typeof (if needed) | Phase 5 |
| Same-file class member | Tree-sitter (declaration) | — | Phase 5 |
| Cross-file reference | Tree-sitter + WorkspaceIndex | — | Phase 5 |
| AutoDoc-documented symbol | AutoDoc XML | Tree-sitter | Phase 5 |

### Hover response format

```
```pike
function format_name(string first, string last) → string
```
Formats a full name from first and last name components.
```

### Source priority

For identifiers that match multiple sources:
1. **AutoDoc** — if `//!` documentation exists, prefer it (most authoritative)
2. **Tree-sitter** — always available for in-workspace code
3. **Pike runtime** — for stdlib symbols and type queries

## 5. Caching Strategy

### Decision: Content-hash keyed per-file cache

```
Cache key: sha256(content) + pike_version
Cache value: { diagnostics, symbols, timestamp }
```

**Invalidation:** When content changes, the hash changes and the cache misses. When content reverts (undo), the old hash matches and the cache hits.

**Scope:** Per-file. Cross-file dependencies are handled by the WorkspaceIndex, not the Pike cache.

**Storage:** In-memory Map. No disk persistence (not needed for a per-session cache).

**Pike worker caching:** The worker script caches compilation results internally. On a cache hit, it returns the cached result without recompiling. The LSP's content hash ensures the worker only receives requests for changed content.

## Consequences

- The Pike worker subprocess is the key new infrastructure. It must be robust against crashes and slow responses.
- Save-only diagnostics means users won't see errors until they save. This is the correct Phase 5 behavior.
- Hover uses tree-sitter for workspace symbols and Pike for stdlib symbols. Both paths are tested.
- The content-hash cache means undo operations are free (cache hit on reverted content).
- Position mapping is trivial since Pike only reports line numbers (no columns).
