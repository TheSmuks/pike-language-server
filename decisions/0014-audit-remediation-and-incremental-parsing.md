# 0014: Audit Remediation — Incremental Parsing, IPC Security, and Event Loop Yielding

**Date:** 2026-04-28
**Status:** Accepted
**Supersedes:** Partial overlap with 0018 (which addressed incremental parsing cache and FIFO queue)

## Context

A comprehensive architectural audit of the Phase 6 P2 codebase identified several issues across the transport layer, Pike IPC bridge, Tree-sitter integration, and test suite. Many findings had already been addressed by decision 0018 (incremental parsing cache, FIFO queue, stdin backpressure, type hygiene). This decision documents the remaining fixes and the rationale for each.

### Shared-server context

The LSP server runs on shared SSH infrastructure. Memory is capped at ~25 MB per process, and CPU contention with other users is expected. Every fix must respect these constraints.

## Decisions

### 1. worker.pike typeof expression hardening

**Problem:** `handle_typeof` interpolated user-provided `expr` directly into compilable Pike code. While `;`, `\n`, and `\r` were rejected, expressions like `exit(1)` or `destruct(this_object())` could execute arbitrary code during compilation.

**Decision:** Add defense-in-depth validation:
- 200-character length limit
- Character whitelist (alphanumeric, `_`, `.`, `->`, `::`, `()`, `[]`, `{}`, `,`, arithmetic operators, comparison operators)
- Balanced parentheses check
- Dangerous identifier rejection (`exit`, `destruct`, `throw`, `catch`, `gauge`, `aggregate`, `aggregate_list`, `allocate`, `mkmapping`) — identifiers followed by `(` that could cause side effects during compilation
- `sizeof()` explicitly allowed (pure, side-effect-free)

**Rationale:** `typeof()` is a compile-time construct — the expression MUST be interpolated into compilable code. Since we cannot avoid interpolation, we constrain the input to a safe subset.

### 2. buildSymbolTableAsync — event loop yielding

**Problem:** `buildSymbolTable` walks the entire AST in 4 synchronous passes. For files with >1000 nodes, this blocks the event loop for 5-10+ ms, causing typing lag on the shared server.

**Decision:** Export `buildSymbolTableAsync` alongside the existing sync `buildSymbolTable`. The async variant yields via `setImmediate` between passes 1→3 and 3→4, but only when `tree.rootNode.descendantCount >= 1000`.

The sync variant is preserved for all existing callers (tests, WorkspaceIndex). The async variant is available for future targeted adoption in the hot path (e.g., a future change to make `WorkspaceIndex.upsertFile` async).

**Rationale:** Making `upsertFile` fully async would cascade through 25+ test files and 80+ call sites. The YIELD_THRESHOLD of 1000 nodes means zero overhead for the common case (most Pike files are <500 nodes). The async variant is opt-in, not mandatory.

### 3. Hover test — unconditional assertion

**Problem:** The stdlib hover test used `if (result) expect(...)` — a maybe-assertion that silently passes when `result` is null.

**Decision:** Rewrote the test to hover over a locally declared function that shadows a predef builtin (`int write(int x) { return x; }`), verifying the predef builtins Tier 2b lookup fires. The assertion is now unconditional.

**Rationale:** The original test used `write("hello")` as a standalone expression. Tree-sitter resolves `write` as a reference at that position, but `getDefinitionAt` finds no declaration in the file — the predef lookup only fires when a declaration IS found. Testing with a local function that shadows a predef builtin exercises the lookup path correctly.

### 4. Cross-file diagnostic propagation test — real corpus files

**Problem:** The test used virtual URIs (`file:///test/base.pike`) that bypass real filesystem module resolution. `inherit "base"` could never resolve because `base.pike` didn't exist on disk.

**Decision:** Rewrote the test to create a dedicated LSP server with `rootUri` pointing to `corpus/files/`, using real files (`cross-inherit-simple-a.pike` as base, `cross-inherit-simple-b.pike` as dependent).

**Rationale:** The `WorkspaceIndex` resolves inherit paths relative to the workspace root. Virtual URIs work for tree-sitter parsing but not for Pike's `compile_string` which needs real file resolution for `inherit` statements.

### 5. autodocCache independent size cap

**Problem:** `autodocCache` was a plain `Map` with no independent byte ceiling. It was co-evicted with `pikeCache` but could grow unbounded between evictions.

**Decision:** Added `AUTODOC_CACHE_MAX_BYTES = 5 MB` with LRU eviction. `autodocCacheBytes` is tracked independently and maintained on insert, replace, and eviction.

**Rationale:** Pike AutoDoc XML can be several KB per file. On a shared server with 25 MB total, a 5 MB autodoc ceiling leaves 20 MB for the pikeCache and tree cache.

### 6. workspace/didChangeWatchedFiles capability

**Problem:** External file changes (git checkout, file creation/deletion outside the editor) were invisible to the LSP server.

**Decision:** Register dynamic file watchers for `**/*.pike` and `**/*.pmod` in `onInitialized`, gated on client capability `workspace.didChangeWatchedFiles.dynamicRegistration`. The handler invalidates `WorkspaceIndex`, `pikeCache`, `autodocCache`, and tree cache.

**Rationale:** Without this capability, switching git branches leaves the workspace index stale — definitions, references, and diagnostics reference files that no longer exist or have different content.

## Consequences

### Positive
- `worker.pike` no longer allows arbitrary code execution through typeof expressions
- Event loop yielding available for large files without disrupting the existing sync API
- autodocCache bounded at 5 MB
- External file changes now trigger proper cache invalidation
- Tests use real files and unconditional assertions

### Negative
- `buildSymbolTableAsync` is exported but not yet wired into the hot path — the sync `buildSymbolTable` still blocks for large files in `upsertFile`. This is a conscious deferral to avoid a 80+ call-site migration.
- The character whitelist for typeof expressions may reject valid Pike expressions that use operators we didn't include (e.g., `..` range operator). This is an acceptable tradeoff for security.
