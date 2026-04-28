# State of the Project — Phase 6 Entry

> Audit date: 2026-04-27. Consolidates actual project state across all six phases.

## Project Identity

- **Name:** pike-language-server
- **Version:** 0.1.0-alpha
- **Stack:** TypeScript 5.7+ on Bun, vscode-languageserver-node 9.x, tree-sitter-pike WASM
- **Oracle:** Pike 8.0.1116 binary (long-lived subprocess)
- **Test suite:** 917 tests, 0 failures, 7,578 assertions, 22 files

## Phase History

| Phase | Status | Tests at Exit | Key Deliverable |
|-------|--------|---------------|-----------------|
| 0: Investigation | Complete | 0 | docs, corpus (37 files), 4 decisions |
| 1: Test Harness | Complete (verified) | 70 | Harness + snapshots + canaries |
| 2: Extension + Tree-sitter | Complete | 403 | documentSymbol, 227 LSP tests |
| 3: Per-file Symbol Table | Complete (verified) | 614 | go-to-def, find-refs, 10-level scope hierarchy |
| 4: Cross-file Resolution | Complete | 830 | ModuleResolver, WorkspaceIndex, 48 new tests |
| 5: Types and Diagnostics | Exit verified | 917 | PikeWorker, diagnostics, three-tier hover, shared-server hardening |
| 6: Refinement | **Pending** | — | Completion, real-time diagnostics, rename, code actions |

## LSP Feature Completeness

| Capability | Status | Details |
|------------|--------|---------|
| documentSymbol | **Implemented** | 15 node-type → SymbolKind mappings, partial results on parse errors |
| definition | **Implemented** | Same-file scope chain + cross-file inherit/import chains |
| references | **Implemented** | Same-file + cross-file via WorkspaceIndex dependency graphs |
| hover | **Implemented** | Three-tier: workspace AutoDoc → stdlib index (5,505) → predef builtins (283) → tree-sitter fallback |
| diagnostics | **Implemented** | Tree-sitter parse errors (real-time) + Pike compilation (save-only). Content-hash cached. |
| completion | **Not implemented** | Phase 6 scope |
| rename | **Not implemented** | Decision 0002 §12: out of scope (Pike has no rename support) |
| code actions | **Not implemented** | Decision 0002 §13: out of scope |
| formatting | Not planned | — |
| signature help | Not planned | — |
| folding range | Not planned | — |
| document highlight | Not planned | — |

## Architecture Summary

**Three-source type resolution:**
1. Tree-sitter (syntactic) — real-time, fast, partial
2. Pike oracle (semantic) — save-triggered, subprocess, authoritative
3. Pre-built indices — stdlib (5,505 symbols) + predef builtins (283 symbols)

**Hover routing** (declForHover):
1. Workspace AutoDoc: cached XML → renderAutodoc → markdown
2. Stdlib: hash-table lookup in stdlib-autodoc.json
3. Predef builtins: lookup in predef-builtin-index.json
4. Fallback: tree-sitter declared type

**PikeWorker lifecycle:**
- Lazy start, 5s request timeout, FIFO queueing
- Idle eviction (5min), memory ceiling (100 requests / 30min active)
- CPU politeness (nice +5 on Linux), crash recovery
- 8 resource policies, 7 tested (nice flag test deferred as minor)

## Data Assets

| File | Content | Size |
|------|---------|------|
| `stdlib-autodoc.json` | 5,505 stdlib symbol signatures + AutoDoc markdown | ~1.39 MB |
| `predef-builtin-index.json` | 283 C-level predef function type signatures | 28 KB |
| `tree-sitter-pike.wasm` | Compiled Pike grammar | ~302 KB |

## Known Limitations

**Upstream (tree-sitter-pike):**
- #2: Missing field names on for_statement children → workaround: positional scanning
- #3: catch expression lost in assignment context → no scope for catch-block variables
- #4: No scope-introducing nodes for while/switch/plain blocks → variable leakage

**Server:**
- Diagnostics are save-only (no real-time/on-keystroke)
- No column-level diagnostic positions (character: 0 always)
- Hover shows declared types, not inferred types
- AutoDoc hover requires save for cache population
- No .so binary module resolution
- No joinnode multi-path merge
- Import resolution scoped to file-system paths

**pike-ai-kb:**
- [#11](https://github.com/TheSmuks/pike-ai-kb/issues/11): pike-signature cannot resolve C-level predef builtins (mitigated by predef-builtin-index.json)

## Test Infrastructure

**Three layers:**
- Layer 1: Protocol-level (PassThrough transport, in-process) — 914 tests
- Layer 2: VSCode integration (@vscode/test-electron) — 3 tests
- Layer 3: Manual smoke tests — 3 items

**Test files (22):**
- 16 LSP protocol test files
- 4 harness test files (harness, canary, canonicalizer, tree-sitter-symbol)
- 3 integration tests
- Harness: 37 ground-truth snapshots, 11 canary tests

## Decisions (11 ADRs)

| # | Title | Key Decision |
|---|-------|-------------|
| 0001 | Pike as Oracle | Use Pike compiler as oracle for diagnostics, types, symbols |
| 0002 | Tier-3 Scope | Three-source resolution boundary; rename/code actions out of scope |
| 0003 | pike-ai-kb Integration | MCP tools first, direct invocation fallback |
| 0004 | Structured Diagnostics | compile_string + custom CompilationHandler, not stderr parsing |
| 0005 | Harness Architecture | Two-layer: Pike script + TypeScript runner, canonical JSON |
| 0006 | LSP Server Architecture | stdio transport, tree-sitter WASM, parse-error-recovery |
| 0007 | Integration Tests | @vscode/test-electron, esbuild packaging |
| 0008 | Symbol Comparison | Three symbol sources, comparison strategy |
| 0009 | Symbol Resolution | 10-level scope hierarchy, two-pass build, cache invalidation |
| 0010 | Cross-File Resolution | Workspace model, ModuleResolver, dependency graph |
| 0011 | Types, Diagnostics, Hover | Subprocess lifecycle, three-tier hover, shared-server policies |

## Corpus

37 committed files across 14 categories, 21 planned:
- Basic types (4), Classes (5), Functions (4), Imports (2), Type errors (4), Undefined identifiers (4), Arity errors (3), Syntax/recovery (1), Modifiers (2), Cross-file (4+directory), Stdlib (1), Preprocessor (1), Enums (1), AutoDoc (1)

## Phase 6 Priority Analysis

### Deployment context (SSH/shared-server)

The server runs in a shared environment with multiple concurrent users. This constrains:

1. **Worker contention**: Single PikeWorker per server, FIFO queueing. Real-time diagnostics would add 4-8x request volume.
2. **Cold-path latency**: 29-58ms for typical stdlib files. Naive real-time on every keystroke would saturate the worker.
3. **User experience**: Save-only diagnostics feel slow. Completion is the primary UX gap.

### Proposed priority order

| Priority | Feature | Rationale |
|----------|---------|-----------|
| **P1** | Completion | Highest user value. Symbol table already supports lookup; needs trigger characters, filtering, and LSP wiring. Latency-sensitive but can use tree-sitter-only results (fast) with Pike oracle enrichment (async). |
| **P2** | Real-time diagnostics with debouncing | Save-only feels slow. Requires: debouncing (300-500ms), worker saturation protection (max 1 pending diagnostic request), fallback to tree-sitter-only on contention. Worker already supports this — needs server.ts wiring. |
| **P3** | Rename | Decision 0002 §12 marks this as out of scope for Pike. Revisit only if deployment context demands it. Requires cross-file rename infrastructure (safe, already have references). |
| **P4** | Code actions | Decision 0002 §13 marks this as out of scope. Low priority, low demand. |

### Completion design considerations

- **Trigger characters**: `.`, `>`, `:`, `(` (member access, arrow access, scope access, function args)
- **Sources**: symbol table (local/param/class), workspace index (cross-file), stdlib index (pre-built)
- **Filtering**: prefix match on identifier, ranked by proximity (local > class > inherited > imported > stdlib)
- **Latency budget**: < 50ms for tree-sitter results (no worker), < 200ms for enriched results (worker async)
- **Worker interaction**: completion does NOT block on the Pike worker. Tree-sitter-only results are sufficient for the first iteration.

### Real-time diagnostics design considerations

- **Debounce**: 300ms after last keystroke (configurable)
- **Worker protection**: at most 1 pending diagnostic request; if worker is busy, skip and rely on tree-sitter parse errors
- **Cancellation**: cancel pending Pike diagnostic on new didChange
- **Merge strategy**: tree-sitter parse errors (always) + Pike compilation errors (when available)
- **Content-hash caching**: already implemented — repeated content skips Pike compilation

## Open Questions for Phase 6

1. **Completion item documentation**: Should completion items include hover documentation? If yes, stdlib items can resolve from the pre-built index. Workspace items would need PikeExtractor on save (already cached).
2. **Completion trigger on space**: Common in Pike for `import ` and `inherit `. Requires context-awareness.
3. **Snippet completions**: For common patterns (class, method, foreach). Not in initial scope but worth considering.
