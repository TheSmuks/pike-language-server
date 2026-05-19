# gopls Indexing & Caching Strategies — Research for Pike LSP

**Date**: 2026-05-19
**Source**: gopls (golang.org/x/tools/gopls) from github.com/golang/tools
**Relevance**: Pike LSP faces similar indexing challenges — large codebase, expensive type analysis, cold-start latency

---

## Strategy 1: Content-Addressed Persistent Disk Cache (`filecache`)

### What It Is

gopls maintains a **machine-global, persistent, file-based key/value store** called `filecache`. The cache maps `(kind string, key [32]byte) → []byte`, where `key` is a SHA-256 digest of the "recipe" that produced the value, and `kind` is a namespace (e.g., `"analysis"`, `"xrefs"`, `"methodsets"`).

The cache is transactional — writes are atomic — and shared across all gopls instances on the same machine. Entries persist across LSP restarts, so cold starts only need to load from disk rather than re-compute.

### Where in the Source

| Component | Path |
|-----------|------|
| `filecache` package | `gopls/internal/lsp/filecache/` |
| Cache key construction | `gopls/internal/lsp/cache/` — each handle computes a `key` incorporating local file content hashes, transitive dependency keys, Go version, and build flags |
| Usage in type-checking | `gopls/internal/lsp/cache/pkg.go` — `Package` handles store/retrieve type-checking results |
| Index serialization | `gopls/internal/lsp/cache/xrefs/`, `methodsets/`, `typerefs/` — cross-reference indexes encoded to binary and stored in filecache |

Key design decisions:
- Keys are **content-addressed** (SHA-256 of inputs), not name-addressed. Renaming a file doesn't invalidate the cache.
- Cache entries are **self-contained** — each entry bundles everything needed to reconstruct the result without accessing other entries.
- **Precise pruning**: Only dependencies reachable through the symbol reference graph (`typerefs`) affect the cache key. Unrelated changes don't invalidate.

### Adaptation for Pike LSP

The Pike LSP already has a `persistentCache` (`server/src/features/persistentCache.ts`, 246 lines) that stores serialized symbol tables in `.pike-lsp/cache.json`. However, it has several weaknesses compared to gopls's approach:

**Current gaps**:
1. **Monolithic cache**: Single `cache.json` file. Loading one entry requires parsing the entire file.
2. **JSON serialization**: Much slower than binary for large structured data.
3. **Global invalidation**: Cache is invalidated when the grammar (WASM hash) changes, not per-file.
4. **No machine-wide sharing**: Each workspace has its own cache.

**Proposed adaptation**:

```typescript
// Per-file cache entries: .pike-lsp/cache/{contentHash}.bin
// Key = SHA-256(file content + grammar version + LSP version)
// Value = MessagePack-serialized SymbolTable

interface CacheEntry {
  contentHash: string;      // SHA-256 of file content
  grammarVersion: string;   // tree-sitter WASM hash
  lspVersion: string;       // LSP package version
  symbolTable: SymbolTable; // Serialized with MessagePack
}
```

**Implementation steps**:
1. Replace `JSON.stringify/parse` with `msgpackr` (fast MessagePack for JS). Expected: 5-10× serialization speedup.
2. Write each cache entry to a separate file: `.pike-lsp/cache/{sha256}.bin`.
3. Load entries on demand, not all at once.
4. Compute cache key as `SHA-256(content + grammarHash + lspVersion)`.

**Difficulty**: Medium. The serialization change is mechanical. The per-file splitting requires changes to `persistentCache.ts`'s load/save API. Estimated effort: 3-5 days.

---

## Strategy 2: Snapshot-Based Immutable State with Precise Invalidation

### What It Is

gopls uses an **immutable snapshot** architecture. The `Snapshot` struct represents a point-in-time view of the entire workspace state. When a file changes, gopls creates a new snapshot that clones only the metadata affected by the change — not the entire workspace.

The invalidation is **precise**: only packages whose transitive inputs changed are invalidated. This is powered by the `typerefs` package, which builds a symbol-level dependency graph that enables fine-grained pruning.

### Where in the Source

| Component | Path |
|-----------|------|
| `Snapshot` struct | `gopls/internal/lsp/cache/snapshot.go` |
| Snapshot cloning | `gopls/internal/lsp/cache/snapshot.go::clone()` |
| Package handle states | `gopls/internal/lsp/cache/pkg.go` — packages flow through validation states: `validMetadata → validLocalData → validKey → validImports → validPackage` |
| Precise pruning | `gopls/internal/lsp/cache/typerefs/` — builds a type-reference graph to determine which packages must be re-type-checked |
| Reference counting | `snapshot.Acquire()` / `snapshot.release()` — snapshots are reference-counted for memory safety |

### How It Works

1. On file change, create a new `Snapshot` by cloning the previous one.
2. Only mark the changed file's package as needing re-metadata.
3. Walk the dependency graph: only invalidate packages whose `localKey` (content hash of package files) or `depKeys` (transitive dependency hashes) changed.
4. Packages whose keys are unchanged reuse cached type-checking results from the previous snapshot.
5. Old snapshots are released via reference counting when no request is using them.

### Adaptation for Pike LSP

The Pike LSP already has a `generation` counter on the workspace index (`workspaceIndex.ts`), but it's a simple global increment — every change invalidates everything.

**Proposed adaptation**:

```typescript
// Per-file generation tracking instead of global generation
interface FileEntry {
  uri: string;
  generation: number;      // When this entry was last validated
  contentHash: string;     // SHA-256 of content at generation
  dependencies: Set<string>; // URIs this file depends on
}

// On file change:
// 1. Re-index the changed file
// 2. Walk reverse dependency graph to find affected files
// 3. Only re-index those files
// 4. Bump generation for affected files only
```

The Pike LSP already extracts dependencies via `workspaceDependencies.ts`. The missing piece is the **reverse dependency map** and **per-file generation tracking**.

**Difficulty**: Medium-High. Requires building a reverse dependency map and changing the generation-based invalidation from global to per-file. The dependency graph already exists (forward direction). Estimated effort: 1-2 weeks.

---

## Strategy 3: Package-Level Granularity with Separated Syntax/Export Packages

### What It Is

In gopls v0.12+ (issue #57987, "Scaling gopls for the growing Go ecosystem"), gopls introduced a strict separation between **syntax packages** (full AST + type info for open files) and **export packages** (summarized type info loaded from disk for non-open files).

This means gopls only holds full type information for packages the user is actively editing. Everything else uses lightweight export data — just enough to resolve symbols without parsing the full AST.

The result: memory usage is **O(open packages)** instead of **O(workspace)**. For a 10,000-package workspace with 5 open files, this is ~2,000× less memory.

### Where in the Source

| Component | Path |
|-----------|------|
| Export data format | `gopls/internal/lsp/cache/export.go` — shallow export data without transitive closure |
| Syntax vs. export distinction | `gopls/internal/lsp/cache/pkg.go` — `Package` struct has modes for syntax vs. import-only |
| Scaling design doc | `golang/go#57987` — issue tracking the architectural overhaul |
| Control plane | `gopls/internal/lsp/cache/` — manages what's in memory vs. on-demand |

### Adaptation for Pike LSP

Pike doesn't have Go's package system, but it has an analogous concept: **inherited/imported modules**. The current Pike LSP's ADR 0023 (lazy dependency resolution) is a step in this direction — background-indexed files skip dependency resolution, which is resolved on-demand when files are opened.

**Proposed adaptation**:

```typescript
// Two-tier symbol table:
// Tier 1 (full): Complete declarations + references + resolved types
// Tier 2 (summary): Exported declarations only, no references, no type resolution

interface SymbolTableSummary {
  uri: string;
  exportedDeclarations: Declaration[];  // Only public/top-level symbols
  // No references, no local declarations, no type info
}

// On-demand resolution:
// When file A needs symbols from inherited file B:
// 1. Check if B has a full SymbolTable (user has it open)
// 2. If not, load B's summary from disk cache
// 3. If not cached, parse B and build summary (deferred, non-blocking)
```

**Difficulty**: Medium. The infrastructure already exists (lazy resolution via `ensureDependenciesResolved`). The main work is defining the summary format and ensuring all feature providers handle partial data gracefully. Estimated effort: 1-2 weeks.

---

## Strategy 4: Pre-computed Cross-Reference Indexes

### What It Is

gopls pre-computes and persists three types of indexes during background analysis:

1. **xrefs**: Cross-reference index mapping each identifier to all its use sites across the workspace.
2. **methodsets**: Method set index for each named type — which methods it satisfies, which interfaces it implements.
3. **typerefs**: Type reference index — which types reference which other types. Used for precise invalidation (Strategy 2).

These indexes are computed once, serialized to binary, and stored in the `filecache`. Workspace-wide queries (find references, go to implementation, call hierarchy) read from these indexes instead of walking all packages.

### Where in the Source

| Component | Path |
|-----------|------|
| xrefs index | `gopls/internal/lsp/cache/xrefs/` — `Index` type with `Encode()`/`Decode()` for filecache |
| methodsets index | `gopls/internal/lsp/cache/methodsets/` — method set index per package |
| typerefs index | `gopls/internal/lsp/cache/typerefs/` — type reference graph for invalidation |
| Index construction | Triggered after type-checking completes; stored via `filecache.Set()` |
| Index querying | `gopls/internal/lsp/source/` — references, implementations, call hierarchy use indexes |

### Adaptation for Pike LSP

The Pike LSP's workspace index (`workspaceIndex.ts`) stores per-file symbol tables but doesn't build cross-file indexes. Queries like "find all references" must iterate all files.

**Proposed adaptation**:

```typescript
// Build a global reference index during background indexing
interface GlobalRefIndex {
  // name → set of (uri, declId) for declarations
  declarations: Map<string, Set<{ uri: string; declId: number }>>;
  // (uri, declId) → set of (uri, refId) for references
  references: Map<string, Set<{ uri: string; refId: number }>>;
}

// Persist to disk cache as binary
// Update incrementally when individual files change
```

**Difficulty**: Medium. The Pike LSP already has all the raw data (declarations and references per file). The work is in: (1) building the merged index, (2) persisting it, (3) using it in feature providers. Estimated effort: 1-2 weeks.

---

## Strategy 5: Memoized Parse Cache with TTL

### What It Is

gopls maintains a **session-level LRU parse cache** with a 1-minute TTL. Recently parsed files are kept in memory to avoid re-parsing during rapid edits. The cache is keyed by `(URI, content hash)` so stale entries are never returned.

This sits on top of the tree-sitter-style incremental parsing — even when the cache misses, the parser can reuse the old tree for incremental updates.

### Where in the Source

| Component | Path |
|-----------|------|
| Parse cache | `gopls/internal/lsp/cache/session.go` — `parseCache` field with LRU + TTL |
| Parsed file | `gopls/internal/lsp/parsego/` — `File` type with syntax tree + coordinate mapper |
| Coordinate mapper | `gopls/internal/lsp/protocol/mapper.go` — `Mapper` type handles UTF-8/UTF-16/token.Pos conversion |

**Key insight**: gopls pre-computes a `Mapper` for each parsed file that handles all coordinate system conversions (UTF-8 ↔ UTF-16 ↔ token.Pos). This is exactly what the Pike LSP's `utf8ToUtf16` bottleneck needs — pre-computed offset maps instead of per-call conversion.

### Adaptation for Pike LSP

The Pike LSP already has a tree-sitter parse cache (`server/src/parser.ts`) with LRU eviction (maxEntries=50, maxBytes=50MB). But it doesn't cache the **position conversion maps**.

**Proposed adaptation**:

```typescript
// Extend TreeEntry to include pre-computed offset maps
interface TreeEntry {
  tree: Tree;
  offsetMap: OffsetMap;  // NEW: pre-computed byte→UTF-16 per line
  lineByteLengths: Int32Array[];  // NEW: per-line byte lengths
}
```

This directly addresses Bottleneck #4 (full line re-encoding in utf8ToUtf16). By computing the offset map once at parse time and caching it alongside the tree, all subsequent position conversions become O(1) array lookups.

**Difficulty**: Low. The offset map computation is straightforward (iterate characters in each line, track byte offsets). The cache already exists; just add a field. Estimated effort: 2-3 days.

---

## Summary: Applicability to Pike LSP

| Strategy | gopls Component | Pike LSP Analog | Adaptation Difficulty | Priority |
|----------|-----------------|-----------------|-----------------------|----------|
| Content-addressed disk cache | `filecache` | `persistentCache.ts` | Medium | P2 |
| Snapshot invalidation | `Snapshot` + `typerefs` | `generation` counter | Medium-High | P3 |
| Syntax/Export packages | `pkg.go` modes | ADR 0023 lazy resolution | Medium | P3 |
| Cross-reference indexes | `xrefs`/`methodsets` | None (iterates all files) | Medium | P3 |
| Pre-computed position maps | `Mapper` + parse cache | `parser.ts` + `positionConverter.ts` | Low | P1 |

The **highest-value adaptation** is Strategy 5 (pre-computed position maps), which directly addresses the utf8ToUtf16 bottleneck. The **most impactful medium-term adaptation** is Strategy 1 (content-addressed disk cache), which enables near-instant warm starts.
