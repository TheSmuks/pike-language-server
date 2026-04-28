# State of the Project — Phase 7 Exit

> Audit date: 2026-04-28. Updated after Phase 7 completion.

## Project Identity

- **Name:** pike-language-server
- **Version:** 0.1.0-alpha
- **Stack:** TypeScript 5.7+ on Bun, vscode-languageserver-node 9.x, tree-sitter-pike WASM
- **Oracle:** Pike 8.0.1116 binary (long-lived subprocess)
- **Test suite:** 1,043 tests, 0 failures, 8,861 assertions, 28 files

## Phase History

| Phase | Status | Tests at Exit | Key Deliverable |
|-------|--------|---------------|-----------------|
| 0: Investigation | Complete | 0 | docs, corpus (37 files), 4 decisions |
| 1: Test Harness | Complete (verified) | 70 | Harness + snapshots + canaries |
| 2: Extension + Tree-sitter | Complete | 403 | documentSymbol, 227 LSP tests |
| 3: Per-file Symbol Table | Complete (verified) | 614 | go-to-def, find-refs, 10-level scope hierarchy |
| 4: Cross-file Resolution | Complete | 830 | ModuleResolver, WorkspaceIndex, 48 new tests |
| 5: Types and Diagnostics | Exit verified | 917 | PikeWorker, diagnostics, three-tier hover, shared-server hardening |
| 6: Refinement | **Complete (verified)** | 979 | P1: Completion ✓. P2: Real-time diagnostics ✓. P3 rename deferred. |
| 7: Type Resolution + Import Tracking | **Complete** | 1,016 | resolveType/resolveMemberAccess, DeclKind 'import', 37 new tests |
| 8: Rename | **In progress** | 1,043 | textDocument/rename, textDocument/prepareRename, 27 new tests |

## LSP Feature Completeness

| Capability | Status | Details |
|------------|--------|---------|
| documentSymbol | **Implemented** | 15 node-type → SymbolKind mappings, partial results on parse errors |
| definition | **Implemented** | Same-file scope chain + cross-file inherit/import chains |
| references | **Implemented** | Same-file + cross-file via WorkspaceIndex dependency graphs |
| hover | **Implemented** | Three-tier: workspace AutoDoc → stdlib index (5,505) → predef builtins (283) → tree-sitter fallback |
| diagnostics | **Implemented** | Tree-sitter parse errors (real-time) + Pike compilation (real-time debounced, 500ms). Content-hash cached. Three modes: realtime/saveOnly/off. Decision 0013. |
| completion | **Implemented** | Unqualified (local scope + predef 283 + stdlib 5,471). Dot/arrow/scope access via tree-sitter. Decision 0012. |
| rename | **Implemented** | textDocument/rename + prepareRename. Scope-aware, cross-file via WorkspaceIndex. Keyword validation. Decision 0016. |
| code actions | **Not implemented** | Decision 0002 §13: out of scope |
| formatting | Not planned | — |
| signature help | Not planned | — |
| folding range | Not planned | — |
| document highlight | Not planned | — |

## Architecture Summary

**Three-source type resolution:**
1. Tree-sitter (syntactic) — real-time, fast, partial
2. Pike oracle (semantic) — real-time debounced (500ms), subprocess, authoritative
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
- Diagnostics are real-time with 500ms debounce (configurable, decision 0013)
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
- Layer 1: Protocol-level (PassThrough transport, in-process) — 1,011 tests
- Layer 2: VSCode integration (@vscode/test-electron) — 3 tests
- Layer 3: Manual smoke tests — 3 items

**Test files (27):**
- 19 LSP protocol test files
- 4 harness test files (harness, canary, canonicalizer, tree-sitter-symbol)
- 4 integration tests
- Harness: 37 ground-truth snapshots, 11 canary tests

## Decisions (17 ADRs)

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
| 0012 | Completion | Tree-sitter-first completion, unqualified + dot/arrow/scope access, stdlib prefix index |
| 0013 | Real-time Diagnostics | Per-file debouncing (500ms), supersession, priority queue, cross-file propagation, three modes |
| 0013-verification | P2 Verification Report | Bugs found (onDidSave, disposed guards), measurements, rename deferral rationale |
| 0014 | Type Resolution | Pure-function resolveType/resolveMemberAccess, depth-limited chain, no worker |
| 0015 | Import Tracking | DeclKind 'import', extractDependencies for imports, cross-file propagation |
| 0016 | Rename | textDocument/rename via existing reference resolution, scope-aware, keyword validation |
## Corpus

37 committed files across 14 categories, 21 planned:
- Basic types (4), Classes (5), Functions (4), Imports (2), Type errors (4), Undefined identifiers (4), Arity errors (3), Syntax/recovery (1), Modifiers (2), Cross-file (4+directory), Stdlib (1), Preprocessor (1), Enums (1), AutoDoc (1)

## Phase 6 Priority Analysis

### Deployment context (SSH/shared-server)

The server runs in a shared environment with multiple concurrent users. This constrains:

1. **Worker contention**: Single PikeWorker per server, FIFO queueing. Real-time diagnostics would add 4-8x request volume.
2. **Cold-path latency**: 29-58ms for typical stdlib files. Naive real-time on every keystroke would saturate the worker.
3. **User experience**: Save-only diagnostics feel slow. Completion is the primary UX gap.

### Risk profile: completion vs. diagnostics

Two competing principles for ordering:

1. **Ship the higher-value thing first**: Completion is the most-requested LSP feature. Users notice its absence immediately. Diagnostics that arrive on save are mildly slow but still useful.

2. **Ship the easier-to-get-right thing first**: Wrong completions are actively harmful — users learn to ignore the completion list and may disable it entirely ("cry wolf" degradation). Diagnostics that show up a second late are still correct when they arrive.

**Assessment:** The risk asymmetry favors diagnostics-first in isolation. However, the "wrong completion" risk is mitigable:
- Tree-sitter-only completions (local scope, declared types) are structurally correct — they show symbols that actually exist in scope.
- The failure mode is *missing* completions (not showing a valid option), not *wrong* completions (showing something invalid).
- Stdlib completions from the pre-built index are authoritative.
- The Pike worker is not needed for the majority of completion scenarios (see walkthrough below).

Missing completions are annoying but not trust-destroying. Wrong completions destroy trust. The design constraint is: **never suggest something that isn't a real symbol at the cursor position.** Tree-sitter symbol tables enforce this by construction.

### Worker dependency walkthrough for completion

Completion scenarios, ordered by frequency in typical Pike editing:

| # | Scenario | Example | Tree-sitter alone? | Worker needed? | Estimated frequency |
|---|----------|---------|-------------------|----------------|--------------------:|
| 1 | Local/param in scope | `int x; x`↓ | Yes — symbol table scope walk | No | 30% |
| 2 | Class member (declared type) | `Stdio.File f; f->`↓ | Yes — resolve declared type → class scope | No | 15% |
| 3 | Inherited member | `f->read` (inherited from Stdio.File) | Yes — WorkspaceIndex resolves inherit chain | No | 10% |
| 4 | Stdlib module member | `Stdio.`↓ | Yes — pre-built stdlib index (5,505 symbols) | No | 15% |
| 5 | Predef builtin | `write`↓ | Yes — predef-builtin-index.json (283 symbols) | No | 5% |
| 6 | Cross-file imported symbol | `import Foo; F`↓ | Yes — WorkspaceIndex resolves import | No | 10% |
| 7 | Return type of stdlib method | `Stdio.read_file("...")->`↓ (string result) | Yes — stdlib index has return types | No | 5% |
| 8 | Return type of user method (declared) | `int foo() { ... }; foo()`↓ | Yes — declared return type in symbol table | No | 3% |
| 9 | Return type of user method (inferred/`mixed`) | `mixed bar() { ... }; bar()`↓ | Partial — shows `mixed`, can't enumerate members | Yes, for type narrowing | 5% |
| 10 | Expression context (mid-expression) | `string s = `↓ | Partial — knows expected type, can filter | Yes, for non-trivial cases | 2% |

**Summary:**
- **~93% of completions** resolve from tree-sitter + pre-built indices + WorkspaceIndex. No worker dependency.
- **~7% of completions** (inferred/mixed return types, complex expression context) would benefit from the worker but degrade gracefully (show declared `mixed` or skip member enumeration).
- The FIFO queueing concern is not a practical problem for completion: the worker path is rare enough that queueing delays won't affect the completion experience.

### Confirmed priority order

| Priority | Feature | Rationale |
|----------|---------|-----------|
| **P1** | Completion | ~93% of requests resolve without worker. Tree-sitter symbol tables guarantee structural correctness (no invalid suggestions). Highest UX value. Failure mode is *missing* items, not *wrong* items. |
| **P2** | Real-time diagnostics with debouncing | Save-only feels slow. Worker dependency is unavoidable but manageable with debouncing and saturation protection. Lower risk — wrong diagnostics are impossible (Pike is authoritative). |
| **P3** | Rename | Re-evaluated below. Still deferred for Phase 6 initial scope but acknowledged as higher value in shared-codebase context. |
| **P4** | Code actions | Decision 0002 §13 marks as out of scope. Low priority, low demand. |

### Rename re-evaluation (Decision 0002 §12)

Decision 0002 §12 deferred rename based on "Pike has no rename support." This decision was made during Phase 0 (investigation), before the SSH/shared-server deployment context was established.

**Original reasoning:** Low demand, Pike has no built-in rename API, text-based heuristics required.

**New context:** In a multi-coworker shared codebase, rename-across-files pays off proportionally to team size. The cost of manual rename scales with the number of call sites and the number of coworkers affected by inconsistent renames.

**Current assessment:**
- The LSP already has the infrastructure needed for rename: symbol table (scope-aware definitions), WorkspaceIndex (cross-file references), and ModuleResolver (cross-file symbol resolution).
- The `references` provider already finds all references across the workspace.
- A rename implementation would combine `references` output with workspace edits — no new resolution infrastructure needed.
- The risk is correctness: Pike has no rename API, so the LSP must verify that a rename doesn't break semantics. For Pike's strong type system, most renames are safe if all references are found (which the existing `references` provider does).
- The deferral is **still justified for Phase 6 initial scope** — completion and real-time diagnostics are higher priority for single-user and shared-server contexts alike. But the reasoning should not inherit from "low demand" without acknowledging that shared-codebase usage increases demand.
- **Recommendation:** Revisit rename after P1 and P2 ship. The infrastructure is ready; the scope decision is about priority, not feasibility.

### Completion design considerations

- **Trigger characters**: `.`, `>`, `:`, `(` (member access, arrow access, scope access, function args)
- **Sources**: symbol table (local/param/class), workspace index (cross-file), stdlib index (pre-built), predef index (pre-built)
- **Filtering**: prefix match on identifier, ranked by proximity (local > class > inherited > imported > stdlib)
- **Latency budget**: < 50ms for tree-sitter results (no worker), < 200ms for enriched results (worker async)
- **Worker interaction**: completion does NOT block on the Pike worker in the common case (~93%). Tree-sitter-only results are sufficient for the first iteration.

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
