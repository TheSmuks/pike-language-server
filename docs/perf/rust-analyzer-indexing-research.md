# rust-analyzer Indexing & Caching Strategies — Research for Pike LSP

**Date**: 2026-05-19
**Source**: rust-analyzer (github.com/rust-lang/rust-analyzer)
**Relevance**: rust-analyzer solves exactly the same problem — fast incremental analysis for IDE features. Its Salsa-based architecture is the gold standard for demand-driven indexing.

---

## Strategy 1: Salsa Framework — Demand-Driven Incremental Computation

### What It Is

Salsa is a Rust framework for **demand-driven, incremental, memoized computation**. Instead of eagerly building a full index, rust-analyzer registers a set of **queries** — pure functions from inputs to outputs. Each query automatically:

1. **Tracks dependencies**: When query A calls query B, Salsa records this edge.
2. **Caches results**: Query results are memoized. If inputs haven't changed, the cached result is returned.
3. **Invalidates precisely**: When an input changes (e.g., file content), only queries that transitively depended on that input are invalidated.
4. **Cancels stale work**: Long-running queries periodically check if their inputs have changed and abort if so, ensuring responsiveness.

This is the **core architectural innovation** of rust-analyzer. Every analysis layer — parsing, name resolution, type inference, trait solving — is expressed as Salsa queries.

### Where in the Source

| Component | Path |
|-----------|------|
| Salsa framework | `crates/salsa/` (vendored from github.com/salsa-rs/salsa, version 0.25.2) |
| Database trait hierarchy | `crates/base-db/src/lib.rs` — `RootDatabase` composes all query traits |
| Input queries | `crates/base-db/src/input.rs` — `FileText`, `FileSourceRoot` etc. |
| Parse queries | `crates/base-db/src/parse.rs` — `parse()` query: `FileId → Parse<SourceFile>` |
| Name resolution queries | `crates/hir-def/src/db.rs` — `crate_def_map()` query |
| Type inference queries | `crates/hir-ty/src/db.rs` — `infer()` query per function |
| Cancellation | `crates/salsa/src/runtime.rs` — `unwind_if_revision_cancelled()` |

### Database Trait Hierarchy

rust-analyzer organizes queries into a layered trait hierarchy where lower layers don't depend on higher ones:

```
RootQueryDb        (no dependencies)
  └─ SourceDatabase  (file contents, syntax trees)
       └─ ExpandDatabase  (macro expansion)
            └─ InternDatabase  (interning for IDs)
                 └─ DefDatabase  (item definitions, name resolution)
                      └─ HirDatabase  (type inference, trait solving)
```

### Query Types

| Type | Behavior | Use Case |
|------|----------|----------|
| **Input** | Set explicitly by user; forms base of dependency graph | File contents |
| **Tracked** | Cached + dependency tracked; invalidated when deps change | Parse, name resolution |
| **Interned** | Creates unique IDs; structural equality → pointer equality | FunctionId, StructId |
| **LRU** | Bounded cache; evicts old entries | Expensive queries |
| **Transparent** | No caching; convenience wrappers | Simple adapters |

### Adaptation for Pike LSP

The Pike LSP currently uses an **eager batch pipeline**: parse all files → build all symbol tables → upsert all to index. There is no dependency tracking between files or between analysis phases.

**Proposed adaptation**:

Express the indexing pipeline as queries:

```typescript
// Conceptual query graph (TypeScript doesn't have Rust's proc macros,
// so this would be a manual or code-generateed registration)

// Input queries (set by file watcher)
query fileContent(uri: URI): string;
query fileVersion(uri: URI): number;

// Derived queries (cached, dependency-tracked)
query parseTree(uri: URI): Tree {
  // Depends on: fileContent(uri)
  return parser.parse(fileContent(uri));
}

query offsetMap(uri: URI): OffsetMap {
  // depends on: fileContent(uri)
  return buildOffsetMap(fileContent(uri).split('\n'));
}

query declarations(uri: URI): Declaration[] {
  // depends on: parseTree(uri)
  return collectDeclarations(parseTree(uri));
}

query scopes(uri: URI): Scope[] {
  // depends on: parseTree(uri), declarations(uri)
  return buildScopes(parseTree(uri), declarations(uri));
}

query references(uri: URI): Reference[] {
  // depends on: parseTree(uri), scopes(uri), declarations(uri)
  return resolveReferences(parseTree(uri), scopes(uri));
}

query symbolTable(uri: URI): SymbolTable {
  // depends on: declarations(uri), references(uri), scopes(uri)
  return buildTable(declarations(uri), references(uri), scopes(uri));
}
```

When file A changes:
1. `fileContent(A)` is invalidated.
2. All queries that transitively depend on `fileContent(A)` are invalidated: `parseTree(A)`, `declarations(A)`, `scopes(A)`, `references(A)`, `symbolTable(A)`.
3. **All other files' queries remain valid** — no wasted work.
4. Feature providers call `symbolTable(uri)` which triggers lazy recomputation only for invalidated queries.

**Challenges**:
- TypeScript has no macro system for query boilerplate. Options: (a) manual registration with a `QueryRegistry` class, (b) code generation, (c) Proxy-based dependency tracking.
- The current `BuildState` is mutable and imperative. Queries must be pure functions.
- Cross-file dependencies (inherit/import) create inter-query dependencies that need careful handling.

**Difficulty**: High. This is a fundamental architecture change. However, it can be done incrementally — start by expressing just the parse/declaration/reference pipeline as queries, then expand. Estimated effort: 4-6 weeks for the core query system + migration.

---

## Strategy 2: Virtual File System (`vfs`) with Change Notification

### What It Is

rust-analyzer uses a **virtual file system** (`vfs` crate) that abstracts all file access. Key properties:

1. **FileId-based**: Files are identified by compact `FileId` integers (interned paths), not strings. This makes all file references O(1) comparisons.
2. **Change tracking**: The VFS records all changes pushed to it. Changes are retrieved via `take_changes()` and pushed to Salsa to trigger incremental recomputation.
3. **No direct I/O**: The VFS itself doesn't perform I/O. A separate `loader` module (with a `Handle` trait) handles file loading and watching asynchronously.
4. **File partitioning**: `FileSet` partitions the flat file list into disjoint sets (e.g., per crate), enabling efficient "find neighbor" operations.

### Where in the Source

| Component | Path |
|-----------|------|
| `vfs` crate | `crates/vfs/` |
| `Vfs` struct | `crates/vfs/src/vfs.rs` — stores file changes, maps `FileId ↔ VfsPath` |
| `FileId` | `crates/vfs/src/vfs_path.rs` — interned file identifier |
| `ChangedFile` | `crates/vfs/src/vfs.rs` — represents a file change event |
| `loader` module | `crates/vfs/src/loader.rs` — `Handle` trait for async file loading/watching |
| `FileSet` | `crates/vfs/src/file_set.rs` — partitions files into disjoint sets |
| `path_interner` | `crates/vfs/src/path_interner.rs` — maps paths to compact `FileId` integers |

### How It Works

```
Editor edit → LSP didChange notification
  → vfs.set_file_contents(path, Some(new_content))
    → vfs records ChangedFile { file_id, change_type: Create/Modify/Delete }
  → main loop calls vfs.take_changes()
    → returns list of ChangedFile entries
  → for each change: db.set_file_text(file_id, new_content)
    → Salsa increments revision, invalidates dependent queries
```

The VFS never stores the "current state" of files — only the **delta** (changes). The actual content is managed by Salsa's input queries.

### Adaptation for Pike LSP

The Pike LSP currently uses VSCode's `TextDocument` for open files and reads from disk for closed files. There's no unified file abstraction.

**Proposed adaptation**:

```typescript
// Replace URI strings with integer FileId for all internal operations
type FileId = number;

class Vfs {
  private pathToInterner: Map<string, FileId>;
  private internerToPath: Map<FileId, string>;
  private changes: ChangedFile[];
  private nextId: number = 0;

  setFileContents(path: string, content: string | null): FileId {
    const id = this.intern(path);
    this.changes.push({ fileId: id, changeType: content === null ? 'delete' : 'modify' });
    return id;
  }

  takeChanges(): ChangedFile[] {
    const changes = this.changes;
    this.changes = [];
    return changes;
  }

  private intern(path: string): FileId {
    let id = this.pathToInterner.get(path);
    if (id === undefined) {
      id = this.nextId++;
      this.pathToInterner.set(path, id);
      this.internerToPath.set(id, path);
    }
    return id;
  }
}
```

**Benefits**:
- All internal data structures (symbol tables, scope maps, declaration maps) use `FileId` instead of URI strings — faster comparison, less memory.
- Change tracking enables incremental invalidation.
- Decouples file I/O from analysis.

**Difficulty**: Medium. The main challenge is migrating all URI-based lookups to FileId-based. The Pike LSP has ~15 files that use URI strings. Estimated effort: 1-2 weeks.

---

## Strategy 3: Syntax Tree Interning and ItemTree as Invalidation Barrier

### What It Is

rust-analyzer uses two levels of syntax representation:

1. **Full syntax tree** (CST): The complete concrete syntax tree from the parser. Stored per file, includes every token and trivia (whitespace, comments).

2. **ItemTree**: A simplified, syntax-level representation that **excludes function bodies**. It contains only item headers (signatures, struct fields, trait method signatures, impl blocks).

The ItemTree acts as an **invalidation barrier** — the key insight that makes rust-analyzer fast:

- When editing inside a function body, the syntax tree changes but the ItemTree does NOT change.
- Since the ItemTree hasn't changed, name resolution (DefMap) remains valid.
- Only the type inference for the changed function is re-run.

This means typing inside a function body triggers: re-parse (fast with tree-sitter) → recompute Body for that function → re-infer types for that function. **Name resolution for the entire file and all dependents is skipped.**

Additionally, rust-analyzer **interns** all major definitions (functions, structs, enums, traits, impls) into small integer IDs (`FunctionId`, `StructId`, etc.). Structural equality becomes pointer equality, making hashing and comparison O(1).

### Where in the Source

| Component | Path |
|-----------|------|
| `ItemTree` definition | `crates/hir-def/src/item_tree.rs` — simplified item representation |
| `ItemTree` as barrier | `crates/hir-def/src/item_tree.rs` — header comment: "provides an 'invalidation barrier' for incremental computations" |
| Interning queries | `crates/hir-def/src/db.rs` — `intern_function()`, `intern_struct()`, etc. |
| ID types | `crates/hir-def/src/hir_def.rs` — `FunctionId`, `StructId`, `EnumId`, `TraitId`, `ImplId` |
| Location types | `crates/hir-def/src/src.rs` — `FunctionLoc`, `StructLoc`, etc. — map IDs back to (file, item) |
| Body query | `crates/hir-def/src/body.rs` — `body(query)` per function, invalidated only when ItemTree body changes |

### Adaptation for Pike LSP

The Pike LSP's `Declaration` and `Scope` types already serve a similar purpose to ItemTree entries — they capture the structure without function bodies. But the invalidation is still file-granular.

**Proposed adaptation**:

```typescript
// Two-tier representation:
// 1. ItemTree: class signatures, function signatures, module-level declarations
//    - Excludes function bodies, lambda bodies
//    - Computed once, cached, only invalidated when structural changes occur
// 2. Body: references inside function/lambda bodies
//    - Computed per-function
//    - Only invalidated when that specific function's body changes

interface ItemTree {
  uri: string;
  classes: ClassSignature[];    // name, members (types), inherits
  functions: FuncSignature[];   // name, parameters (types), return type
  variables: VarDeclaration[];  // name, type
  imports: ImportDecl[];
  inherits: InheritDecl[];
}

interface ClassSignature {
  name: string;
  range: Range;
  members: { name: string; type: string; range: Range }[];
}

// The ItemTree is the invalidation barrier:
// - Body edits: only re-resolve references in the changed function
// - Signature edits: re-resolve names for the entire file + dependents
```

**Difficulty**: Medium-High. Requires separating the declaration pass into two phases: (1) collect ItemTree (signatures), (2) collect Bodies (references per function). The current `declarationCollector.ts` mixes both. Estimated effort: 2-3 weeks.

---

## Strategy 4: On-Demand Symbol Resolution with Lazy Evaluation

### What It Is

rust-analyzer never resolves all symbols for the entire workspace eagerly. Instead, it resolves **on demand** — when a feature provider needs information about a specific symbol, it triggers a query chain that resolves only what's needed.

For example, "go to definition" for `foo.bar()`:
1. Look up `foo` in the local scope → find its type.
2. Resolve `bar` on that type → find the method definition.
3. Only the queries needed for these steps are computed.

If the user is looking at file A and file B hasn't been touched, file B's type information is never fully computed — only the minimal subset needed to answer the query.

### Where in the Source

| Component | Path |
|-----------|------|
| On-demand parsing | `crates/base-db/src/parse.rs` — `parse()` query only runs for files actually needed |
| Name resolution on demand | `crates/hir-def/src/nameres.rs` — `crate_def_map()` resolved lazily per crate |
| Type inference on demand | `crates/hir-ty/src/infer.rs` — `infer()` query per function, not per crate |
| HIR layer | `crates/hir/src/` — wraps DefDatabase/HirDatabase queries into a convenient API |
| Source-to-def mapping | `crates/hir-def/src/source_to_def.rs` — maps source positions to definitions on demand |

### How It Works

The key is Salsa's **demand-driven** nature: queries are only executed when their result is requested. If nobody asks for the type of function X, it's never computed.

```
User requests "go to definition" at position P in file F
  → source_to_def(P, F) → FunctionId(42)
  → function_data(42) → signature info
  → infer(42) → type info (only for this function)
  → return definition location
```

No other functions in the file (or workspace) are type-checked. This is O(1) per query instead of O(workspace).

### Adaptation for Pike LSP

The Pike LSP already has a form of lazy resolution via ADR 0023: background-indexed files skip dependency resolution, and `ensureDependenciesResolved()` resolves on demand when files are opened.

But the current system still eagerly builds **complete symbol tables** (declarations + references) for every file during background indexing. The reference pass is the expensive part (Bottleneck #1).

**Proposed adaptation**:

```typescript
// Three-phase approach:
// Phase 1 (background, fast): Parse + collect declarations only (no references)
// Phase 2 (on-demand, per-file): When file is opened, resolve references
// Phase 3 (on-demand, per-symbol): When user queries a specific symbol, resolve its type

// This directly addresses the 160s bottleneck:
// - Background indexing only runs Phase 1 (declarations)
// - Phase 2 (references) only runs for open files
// - Phase 3 (types) only runs for queried symbols

async function backgroundIndexFile(uri: string): Promise<void> {
  const tree = parseFile(content, uri);
  const declarations = collectDeclarations(tree.rootNode);  // Fast: ~10ms
  const scopes = buildScopes(tree.rootNode, declarations);  // Fast: ~5ms
  // DO NOT resolve references — that's the 160s bottleneck
  upsertDeclarationsOnly(uri, declarations, scopes);
}

function onFileOpen(uri: string): void {
  // Now resolve references for this specific file
  const tree = parseTree(uri);
  const table = buildFullSymbolTable(tree.rootNode, uri);  // ~100ms for one file
  upsertFullTable(uri, table);
}
```

**This single change eliminates the 160s bottleneck for background indexing** — the reference pass simply doesn't run for non-open files. Features like "find all references" would need to resolve on-demand, but that's acceptable.

**Difficulty**: Medium. The main challenge is ensuring all feature providers handle the case where references aren't available (i.e., file hasn't been opened yet). Estimated effort: 1-2 weeks.

---

## Strategy 5: Parallel File Processing with Snapshot Isolation

### What It Is

rust-analyzer processes files in parallel using Salsa's built-in parallelism. Since queries are pure functions with tracked dependencies, they can be executed concurrently without locks. Salsa ensures:

1. **Snapshot isolation**: Each request sees a consistent snapshot of the database. Concurrent edits create new revisions but don't affect in-flight queries.
2. **Deduplication**: If two concurrent requests both need `parse(fileA)`, Salsa only runs the query once and shares the result.
3. **Work stealing**: The rayon-based parallelism distributes query execution across CPU cores.

### Where in the Source

| Component | Path |
|-----------|------|
| Salsa parallelism | `crates/salsa/src/` — `parallel.rs` handles concurrent query execution |
| Database snapshot | `crates/base-db/src/lib.rs` — `RootDatabase` implements `Upstream` with `parity_db` |
| Parallel type checking | `crates/hir-ty/src/infer.rs` — multiple functions inferred concurrently |
| Cancellation | `crates/salsa/src/runtime.rs` — check revision in parallel workers |

### How It Works

```
Request 1 (hover): starts on thread A
  → parse(file1)  ← shared result
  → infer(func1)  ← thread A computes

Request 2 (completion): starts on thread B
  → parse(file1)  ← reuses shared result from Request 1
  → resolve_scope(file1)  ← thread B computes

File change arrives during both requests:
  → Salsa increments revision
  → Both requests check revision periodically
  → If their inputs changed, they abort and restart
```

### Adaptation for Pike LSP

The Pike LSP currently has limited parallelism:
- Parsing is parallelized in batches of 8 (`backgroundIndex.ts:90-150`)
- Upsert is sequential
- Symbol table building is sequential per file

**Proposed adaptation**:

```typescript
// Parallel symbol table building with bounded concurrency
async function parallelBuild(
  files: ParsedFile[],
  concurrency: number = navigator.hardwareConcurrency || 4
): Promise<SymbolTable[]> {
  const results: SymbolTable[] = [];
  const semaphore = new Semaphore(concurrency);

  const tasks = files.map(async (file) => {
    await semaphore.acquire();
    try {
      // Each file is independent — no shared mutable state
      return buildSymbolTable(file.tree.rootNode, file.uri, file.version);
    } finally {
      semaphore.release();
    }
  });

  return Promise.all(tasks);
}
```

**Key requirement**: `buildSymbolTable()` must be pure (no shared mutable state). The current implementation uses a `BuildState` with mutable arrays — this would need to be created per-file (it already is, but the `ModuleResolver` cache is shared).

**Difficulty**: Medium. The main challenge is ensuring the `ModuleResolver` cache is thread-safe or duplicated per worker. JavaScript's single-threaded model means true parallelism requires worker threads, but `Promise.all` with I/O-bound work already provides concurrency. For CPU-bound work (symbol table building), consider `worker_threads` with `SharedArrayBuffer` for shared caches. Estimated effort: 1-2 weeks.

---

## Summary: Applicability to Pike LSP

| Strategy | rust-analyzer Component | Pike LSP Analog | Adaptation Difficulty | Impact |
|----------|------------------------|-----------------|-----------------------|--------|
| Salsa query framework | `crates/salsa/` + `base-db/` | None (eager batch pipeline) | High | Transformative |
| VFS with FileId interning | `crates/vfs/` | URI strings everywhere | Medium | Moderate |
| ItemTree invalidation barrier | `crates/hir-def/src/item_tree.rs` | Full symbol table every time | Medium-High | High |
| On-demand symbol resolution | `base-db/src/parse.rs` + `hir-def/src/nameres.rs` | ADR 0023 (partial) | Medium | High |
| Parallel file processing | Salsa parallelism + rayon | Batch-8 parsing, sequential upsert | Medium | Moderate |

### Recommended Adoption Order

1. **Strategy 4 (On-demand resolution)** — Highest impact, lowest disruption. Skip reference pass for background files. Directly eliminates the 160s bottleneck without architectural changes.
2. **Strategy 5 (Parallelism)** — Moderate effort, moderate impact. Parallelize symbol table building.
3. **Strategy 2 (VFS/FileId)** — Foundation for later work. Replaces URI strings with integer IDs.
4. **Strategy 3 (ItemTree barrier)** — Requires refactoring the declaration pass, but enables fine-grained invalidation.
5. **Strategy 1 (Salsa)** — Long-term goal. Only worth doing after simpler strategies are exhausted.

The key insight from rust-analyzer is that **on-demand computation combined with precise invalidation** eliminates the need for fast batch indexing entirely. If the LSP only computes what's needed, when it's needed, the total work is O(open files + queried symbols) instead of O(workspace). This is the north-star architecture.
