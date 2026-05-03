# State of the Project — Phase 19 Complete

> Audit date: 2026-05-03. Updated after Phase 19 completion (scope leakage fixes).

## Project Identity

- **Name:** pike-language-server
- **Version:** 0.1.0-alpha
- **Stack:** TypeScript 5.7+ on Bun, vscode-languageserver-node 9.x, tree-sitter-pike WASM
- **Oracle:** Pike 8.0.1116 binary (long-lived subprocess)
- **Test suite:** 1,619 tests, 0 fail, 1 todo, 13,205 assertions, 44 files

## Phase History

| Phase | Status | Tests at Exit | Key Deliverable |
|-------|--------|---------------|-----------------|
| 0: Investigation | Complete | 0 | docs, corpus (37 files), 4 decisions |
| 1: Test Harness | Complete (verified) | 70 | Harness + snapshots + canaries |
| 2: Extension + Tree-sitter | Complete | 403 | documentSymbol, 227 LSP tests |
| 3: Per-file Symbol Table | Complete (verified) | 614 | go-to-def, find-refs, 10-level scope hierarchy |
| 4: Cross-file Resolution | Complete | 830 | ModuleResolver, WorkspaceIndex, 48 new tests |
| 5: Types and Diagnostics | Exit verified | 917 | PikeWorker, diagnostics, three-tier hover, shared-server hardening |
| 6: Refinement | Complete (verified) | 979 | P1: Completion. P2: Real-time diagnostics. P3 rename deferred. |
| 7: Type Resolution + Import Tracking | Complete | 1,016 | resolveType/resolveMemberAccess, DeclKind 'import', 37 new tests |
| 8: Rename | Complete + post-audit fixes | 1,051 | textDocument/rename, textDocument/prepareRename, 30 rename tests, 3 audit bugs fixed |
| 9: Stabilize and Multi-editor | Complete | 1,311 | Standalone build, Neovim verified, real-codebase tested (0 P1), performance measured |
| 10: Type Inference | Complete | 1,356 | assignedType, extractInitializerType, PRIMITIVE_TYPES, typeof integration |
| 11: Inference Docs | Complete | 1,356 | Decision 0019, corpus files, harness snapshots, known-limitations |
| 12: Semantic Tokens | Complete | 1,425 | Token type/modifier mapping, production, delta encoding. Decision 0020. |
| 13: LSP Features | Complete | 1,530 | documentHighlight, foldingRange, signatureHelp, semanticTokens handler. Decisions 0020, 0021. |
| 14: Workspace Features | Complete | 1,565 | Code actions, workspace symbol, background indexing, persistent cache, configuration, cancellation. |
| 15: Correctness Foundations | Complete | 1,612 | Completion refinements, rename bug fix, diagnostics fix, CI canary fix. Decisions 0017, 0018. |
| 16: pike-introspect Integration | Complete | 1,619 | pike-introspect v0.2.0 integration: resolve method, ResolveResult type, inheritance chain support. Decision 0019 updated. |

## LSP Feature Completeness
| capability | status | Details |
|------------|--------|---------|
| documentSymbol | **Implemented** | 15 node-type to SymbolKind mappings, partial results on parse errors |
| definition | **Implemented** | Same-file scope chain + cross-file inherit/import chains + arrow/dot via type resolution |
| references | **Implemented** | Same-file + cross-file via WorkspaceIndex dependency graphs |
| hover | **Implemented** | Three-tier: workspace AutoDoc -> stdlib index (5,505) -> predef builtins (283) -> tree-sitter fallback |
| diagnostics | **Implemented** | Tree-sitter parse errors (real-time) + Pike compilation (real-time debounced, 500ms). Content-hash cached. Three modes: realtime/saveOnly/off. Decision 0013. |
| completion | **Implemented** | Unqualified (local scope + predef 283 + stdlib 5,471). Dot/arrow/scope access via tree-sitter. Decision 0012. |
| rename | **Implemented** | textDocument/rename + prepareRename. Scope-aware, cross-file via WorkspaceIndex. Keyword validation. Decision 0016. |
| code actions | **Implemented** | Remove unused variable, add missing import. Extensible quick-fix registry. Decision 0021. |
| semanticTokens | **Implemented** | 9 token types + 5 modifiers. Function→method promotion in class scope. Decision 0020. |
| documentHighlight | **Implemented** | Read/Write highlighting for declarations and references. |
| foldingRange | **Implemented** | class_body, block, comment group folding. |
| signatureHelp | **Implemented** | Parameter hints with active parameter tracking. Stdlib + local function support. Decision 0021. |
| workspaceSymbol | **Implemented** | Cross-file prefix search, case-insensitive. Decision 0022. |
| formatting | Not planned | — |

## Architecture Summary

**Three-source type resolution:**
1. Tree-sitter (syntactic) — real-time, fast, partial
2. Pike oracle (semantic) — real-time debounced (500ms), subprocess, authoritative
3. Pre-built indices — stdlib (5,505 symbols) + predef builtins (283 symbols)

**Hover routing** (declForHover):
1. Workspace AutoDoc: cached XML -> renderAutodoc -> markdown
2. Stdlib: hash-table lookup in stdlib-autodoc.json
3. Predef builtins: lookup in predef-builtin-index.json
4. Fallback: tree-sitter declared type

**Rename routing:**
1. Locate declaration via `getDefinitionAt()` (same-file scope chain)
2. Enumerate references via `getReferencesTo()` + `getCrossFileReferences()`
3. Build `WorkspaceEdit` replacing all occurrences
4. Pike keyword validation rejects invalid names

**PikeWorker lifecycle:**
- Lazy start, 5s request timeout, FIFO queueing
- Idle eviction (5min), memory ceiling (100 requests / 30min active)
- CPU politeness (nice +5 on Linux), crash recovery
- 8 resource policies (7 tested)

## Data Assets

| File | Content | Size |
|------|---------|------|
| `stdlib-autodoc.json` | 5,505 stdlib symbol signatures + AutoDoc markdown | ~1.39 MB |
| `predef-builtin-index.json` | 283 C-level predef function type signatures | 28 KB |
| `tree-sitter-pike.wasm` | Compiled Pike grammar | ~302 KB |

## Known Limitations

**Upstream (tree-sitter-pike):**
- #2: Missing field names on for_statement children -> workaround: positional scanning
- #3: catch expression lost in assignment context -> no scope for catch-block variables
- #4: No scope-introducing nodes for while/switch/plain blocks -> variable leakage

**Server:**
- Diagnostics are real-time with 500ms debounce (configurable, decision 0013)
- No column-level diagnostic positions (character: 0 always)
- Hover shows declared types, not inferred types
- AutoDoc hover requires save for cache population
- No .so binary module resolution
- No joinnode multi-path merge
- Import resolution scoped to file-system paths
- Arrow/dot access rename uses name-based matching for unresolved references, which may include call sites on different classes sharing the same method name
- Cross-file inherited member completion returns only same-file members (wireInheritance does not resolve cross-file inheritance)

**pike-ai-kb:**
- [#11](https://github.com/TheSmuks/pike-ai-kb/issues/11): pike-signature cannot resolve C-level predef builtins (mitigated by predef-builtin-index.json)

## Test Infrastructure

**Three layers:**
- Layer 1: Protocol-level (PassThrough transport, in-process) — ~1,040 tests
- Layer 2: VSCode integration (@vscode/test-electron) — 3 tests
- Layer 3: Manual smoke tests — 3 items

**Test files (28):**
- 20 LSP protocol test files
- 4 harness test files (harness, canary, canonicalizer, tree-sitter-symbol)
- 4 integration tests
- Harness: 37 ground-truth snapshots, 11 canary tests

## Decisions (17 ADRs)

| # | Title | Key Decision |
|---|-------|-------------|
| 0001 | Pike as Oracle | Use Pike compiler as oracle for diagnostics, types, symbols |
| 0002 | Tier-3 Scope | Three-source resolution boundary; code actions out of scope |
| 0003 | pike-ai-kb Integration | MCP tools first, direct invocation fallback |
| 0004 | Structured Diagnostics | compile_string + custom CompilationHandler, not stderr parsing |
| 0005 | Harness Architecture | Two-layer: Pike script + TypeScript runner, canonical JSON |
| 0006 | LSP Server Architecture | stdio transport, tree-sitter WASM, parse-error-recovery |
| 0007 | Integration Tests | @vscode/test-electron, esbuild packaging |
| 0008 | Symbol Comparison | Three symbol sources, comparison strategy |
| 0009 | Symbol Resolution | 10-level scope hierarchy, two-pass build, cache invalidation |
| 0010 | Cross-File Resolution | Workspace model, ModuleResolver, dependency graph |
| 0011 | Types, Diagnostics, Hover | Subprocess lifecycle, three-tier hover, shared-server policies |
| 0012 | Completion | Tree-sitter-first completion, unqualified + dot/arrow/scope access, stdlib prefix index |
| 0013 | Real-time Diagnostics | Per-file debouncing (500ms), supersession, priority queue, cross-file propagation, three modes |
| 0013-verification | P2 Verification Report | Bugs found (onDidSave, disposed guards), measurements, rename deferral rationale |
| 0014 | Type Resolution | Pure-function resolveType/resolveMemberAccess, depth-limited chain, no worker |
| 0015 | Import Tracking | DeclKind 'import', extractDependencies for imports, cross-file propagation |
| 0016 | Rename | textDocument/rename via existing reference resolution, scope-aware, keyword validation |

## Performance Baseline

| Operation | Measurement |
|-----------|-------------|
| PikeExtractor cold | 29-58ms (scales with file size) |
| Hover hot path warm | ~0.3ms/symbol |
| Stdlib lookup | <0.01ms |
| Unqualified completion cold/warm | 6ms / 0.5ms (small file), 5.3ms / 2.6ms (large file) |
| Dot completion (Stdio.) cold/warm | 8.3ms / 0.06ms |
| Cross-file go-to-definition p50 | 0.001ms |
| Semantic tokens (300-line file) | < 50ms |
| Document symbols (300-line file) | < 30ms |
| Workspace symbol search (300-line file) | < 20ms |
| Folding ranges (300-line file) | < 20ms |
| Document highlight | < 20ms |

See tests/perf/benchmarks.test.ts for regression tests (3x slack for CI variability).
## Corpus

64 committed files across 14 categories, 21 planned:
- Basic types (4), Classes (5), Functions (4), Imports (2), Type errors (4), Undefined identifiers (4), Arity errors (3), Syntax/recovery (1), Modifiers (2), Cross-file (4+directory), Stdlib (1), Preprocessor (1), Enums (1), AutoDoc (1)