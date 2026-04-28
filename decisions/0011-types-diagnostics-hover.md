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


## 6. Shared-Server Deployment Policies

The deployment environment is SSH on a shared Linux server with limited resources and multiple concurrent users. Per-user costs compound across coworkers.

### 6a. Idle worker eviction

**Policy**: Kill the Pike worker after 5 minutes of no requests. Restart on next request.

**Rationale**: On a shared server, an idle worker is wasted memory. With 10 coworkers and only 3 actively coding, the server holds 3 Pike processes instead of 10.

**Cost**: One cold-path latency hit (150ms) when the user returns from idle.

**Configuration**: `idleTimeoutMs` (default: 300000)

**Implementation**: `resetIdleTimer()` called on every request. Timer uses `unref()` to not prevent process exit.

### 6b. Worker memory ceiling and reset

**Policy**: Force restart after 100 requests or 30 minutes of continuous use, whichever comes first.

**Rationale**: Pike's `compile_string` accumulates program state. A long-lived worker's memory grows unbounded. Periodic reset returns to clean baseline.

**Cost**: One longer-latency request (the one that triggers restart). Subsequent requests are at clean baseline.

**Configuration**: `maxRequestsBeforeRestart` (default: 100), `maxActiveMinutes` (default: 30)

### 6c. Reduced timeout with timeout-as-diagnostic

**Policy**: 5-second per-request timeout (configurable). On timeout, surface a warning diagnostic to the user.

**Rationale**: On a shared server, 10s of Pike CPU during a slow compile blocks other coworkers. Shorter timeout improves fairness. The diagnostic informs the user why their diagnostics are stale.

**Message**: "Compilation timed out, will retry on next save."

**Configuration**: `requestTimeoutMs` (default: 5000)

### 6d. File watching strategy

**Policy**: Rely entirely on editor-pushed change notifications (didChange, didSave, didClose). No server-side file watchers.

**Rationale**: On Linux shared servers, `fs.inotify.max_user_watches` is a finite resource shared across all coworkers. VSCode-over-SSH watches files on the remote side and pushes changes via the LSP protocol. The server doesn't need its own watchers.

**Limitation**: Some LSP clients may not support `didChangeWatchedFiles`. The server already works without it — it relies on `didChange` for content updates.

### 6e. Cache size cap

**Policy**: LRU eviction at 50 entries or 25MB total, whichever comes first.

**Rationale**: Per-user cost matters. A coworker with 5 VSCode windows shouldn't multiply this. The cap prevents memory growth from large files or many open documents.

**Configuration**: `CACHE_MAX_ENTRIES` (default: 50), `CACHE_MAX_BYTES` (default: 25MB)

### 6f. Concurrent request queueing

**Policy**: FIFO. One request at a time through the Pike worker.

**Rationale**: The Pike worker handles one stdio request at a time. When a diagnose is in flight and a hover arrives, the hover queues. This is the simplest correct model.

**Phase 6 implication**: Real-time debouncing will need to be aware of this queue. If debounced diagnostics are in flight, hover will wait. The debounce interval (Phase 6) should be tuned to minimize queue contention.

### 6g. CPU politeness

**Policy**: Spawn Pike worker with `nice +5` on Linux.

**Rationale**: Under CPU contention on a shared server, the Pike subprocess yields to other system processes (including other coworkers' editors). Editor responsiveness improves.

**Fallback**: On non-Linux platforms, nice is not applied.

**Configuration**: `niceValue` (default: 5, set to 0 to disable)

### 6h. Cold/warm latency separation

**Measured benchmarks** (single-user on development machine):

| Operation | Cold | Warm p50 | Warm p95 |
|-----------|------|----------|----------|
| diagnose | 49.5ms | 0.13ms | 0.32ms |
| hover (autodoc) | 0.005ms | 0.005ms | 0.005ms |
| worker restart | 150ms | — | — |
| post-restart diagnose | — | 0.3ms | — |

**Cold path** is what the user feels on first save after opening a workspace or returning from idle. **Warm path** is steady-state editing.

Hover never involves the Pike worker — it's parse-tree driven (autodoc) or tree-sitter driven (fallback). Hover latency is sub-millisecond.

## 7. AutoDoc Routing (revised — PikeExtractor XML boundary)

### Decision: PikeExtractor for source-to-XML, TypeScript for XML-to-markdown

The right boundary is XML, not Pike comments. The TypeScript code never parses `//!` syntax directly; it parses the XML that PikeExtractor produces.

**Why this boundary:**
- No reimplementation of Pike's autodoc comment syntax in TypeScript
- Bounded input format (XML conforming to the documented schema)
- Existing XML parsing libraries handle the parsing layer
- The transform from XML to markdown is a switch statement on element names

**Chosen:**
1. Source-to-XML happens in Pike worker via `Tools.AutoDoc.PikeExtractor.extractNamespace()`
2. XML-to-markdown happens in TypeScript renderer (`autodocRenderer.ts`)
3. Stdlib index is pre-computed at build time using the same renderer
4. The renderer covers every tag in the autodoc.xml spec

**Alternatives rejected:**

| Alternative | Cost |
|-------------|------|
| Parse `//!` comments in TypeScript | Reimplements Pike's comment syntax parser. Fragile — two sources of truth for the same format. |
| `pike -x extract_autodoc` per hover request | File I/O + subprocess per request. Deployment-hostile on shared servers. |
| XML parsing of extract_autodoc output without renderer | Correct but incomplete — need a renderer anyway for hover. |

### Architecture

```
                    Pike Worker
                    ┌─────────────────────────────────┐
  Source text ────▶ │ PikeExtractor.extractNamespace() │
                    └──────────┬──────────────────────┘
                               │ XML string
                               ▼
                    ┌─────────────────────────────────┐
                    │ Content-hash cache (LRU, 50/25MB)│
                    └──────────┬──────────────────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
         Cache Hit        Cache Miss      No Docs
              │                │                │
              │         Pike worker          Tree-sitter
              │         .autodoc()            fallback
              │                │                │
              ▼                ▼                ▼
        ┌──────────────────────────────┐   Bare
        │  autodocRenderer.ts          │   signature
        │  parseXml → findDocGroup →   │
        │  renderAutodoc → Markdown    │
        └──────────────────────────────┘
```

### Hover routing (final)

```
Resolve identifier → declaration (phase 3+4)
  → Workspace declaration:
    → Get file's XML from cache (or worker.autodoc on cache miss)
    → Walk XML to find the declaration's docgroup
    → Render that element to MarkupContent
    → If no documentation in XML: fall through to bare declared type
  → Stdlib declaration:
    → Hash-table lookup in stdlib index (pre-computed at build time)
    → If found: return cached MarkupContent
    → If not found: fall back to pike-ai-kb query (Phase 6+)
  → Fall-through: tree-sitter's bare declared type
```

### Pike worker autodoc method

- **Input:** source string
- **Output:** XML string from `PikeExtractor.extractNamespace(source, filename, "predef", FLAG_KEEP_GOING)`
- **Caching:** Content-hash keyed, same LRU eviction as diagnostics
- **Cold path:** One worker call per file content change (~0.5ms)
- **Hot path:** Cache hit + XML walk + markdown render (~0.3ms per symbol)

### TypeScript renderer

- **Module:** `src/features/autodocRenderer.ts`
- **Input:** Parsed XML (DOM-like tree) + symbol name
- **Output:** `RenderedAutodoc { markdown: string, signature: string }`
- **Every tag** in the autodoc.xml schema has a case in the switch:
  - Structural: `<method>`, `<param>`, `<returntype>`, `<variable>`, `<class>`, `<module>` → markdown headers/lists
  - Inline: `<p>`, `<code>`, `<i>`, `<b>` → standard markdown equivalents
  - Block: `<mapping>`, `<array>`, `<dl>` → markdown tables/lists
  - Examples: `<example>` → markdown code blocks
  - Cross-references: `<ref>` → plain text in v1, LSP locations in v2
  - Rare markup: plain text fallback that preserves content

### Stdlib index

- **Build:** `scripts/build-stdlib-index.ts` runs PikeExtractor over Pike's stdlib
- **Output:** `server/src/data/stdlib-autodoc.json` — hash table keyed on FQN
- **Size:** 1.39 MB, 5,471 symbols
- **Limitation:** C-level builtins (`write`, `arrayp`, etc.) are not in Pike source files — not indexed
- **Resolution:** pike-ai-kb `pike-signature` tool as fallback for unindexed stdlib symbols (Phase 6+)
- **Temporary workaround:** `predef-builtin-index.json` (283 symbols) covers C-level builtins via Pike's `_typeof()` output. This index is a stopgap pending [TheSmuks/pike-ai-kb#11](https://github.com/TheSmuks/pike-ai-kb/issues/11), which will add `all_constants()` fallback to `pikeResolvePreamble()`. When that fix ships, evaluate removing the predef index in favor of kb queries.

### AutoDoc coverage on corpus

| File | Documented docgroups |
|------|---------------------|
| autodoc-documented.pike | 4 |
| compat-pike78.pike | 1 |
| All other corpus files | 0 |
| **Total** | **5** |

The corpus is designed to exercise language features, not documentation. Production codebases with `//!` conventions will have higher coverage.

### Performance

| Operation | Cold | Warm |
|-----------|------|------|
| PikeExtractor (in-process) | 0.58ms | 0.48ms |
| XML rendering (TypeScript) | 0.29ms/symbol | 0.29ms/symbol |
| Stdlib lookup (hash table) | — | <0.01ms |
| Worker restart | 150ms | — |

Hover hot path (cache hit): ~0.3ms per symbol. No Pike worker involvement.
Hover cold path (cache miss): worker.autodoc() ~0.5ms + render ~0.3ms = ~0.8ms total.

## Consequences (updated)

- The Pike worker handles both diagnostics AND autodoc extraction (cached).
- Hover never calls the worker on the hot path — it reads from the XML cache.
- AutoDoc extraction is PikeExtractor-driven: source-to-XML in Pike, XML-to-markdown in TypeScript.
- The XML boundary means TypeScript never reimplements Pike's `//!` syntax.
- Stdlib index ships with the LSP at build time — 5,471 symbols, 1.39 MB.
- C-level builtins are not indexed — pike-ai-kb provides fallback in Phase 6+.
- Shared-server policies compound correctly: N users × idle eviction = only active workers consume memory.
- The LRU cache cap prevents per-user memory growth across multiple VSCode windows.
- Timeout-as-diagnostic surfaces information to users rather than silently dropping results.
- Phase 6's debouncing must account for FIFO queueing through the Pike worker.