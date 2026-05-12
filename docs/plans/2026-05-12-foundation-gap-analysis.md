# Pike LSP Foundation Gap Analysis & Improvement Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Identify and prioritize architectural and feature gaps between the current Pike LSP and production-grade language servers (gopls, rust-analyzer), then define a phased plan to close them.

**Architecture:** The Pike LSP is a tree-sitter + pike-oracle hybrid. tree-sitter handles syntax; pike subprocess provides semantic truth. This is fundamentally sound. The gaps are in infrastructure quality, not architecture direction.

**Reference points:** gopls (Go), rust-analyzer (Rust), pylsp (Python), lua-language-server (Lua)

---

## Part 1: Gap Analysis

### What the Pike LSP Already Does Well

The codebase analysis shows a mature foundation:

- 17 of 20+ LSP features implemented (many FULL)
- Three-tier hover routing (AutoDoc → stdlib → tree-sitter) with graceful degradation
- Cross-file navigation via WorkspaceIndex with reverse dependency graph
- Type inference pipeline (static + runtime via typeof_)
- Debounced diagnostics with version gating and cross-file propagation
- PikeWorker FIFO queue with backpressure and IPC safety
- LRU tree cache with incremental re-parsing
- Background workspace indexing with progress reporting
- Persistent cache (.pike-lsp/cache.json) with WASM hash invalidation
- Protected name rejection in rename (5,754 predef/stdlib symbols)

This is already a competent Tier-3 LSP. The gaps below are what separates it from Tier-2 quality.

---

### Gap 1: Text Document Sync — INCREMENTAL SYNC

**Current:** Full sync (TextDocumentSyncKind.Full). Client sends entire document on every keystroke.
**Production standard:** Incremental sync (TextDocumentSyncKind.Incremental). Client sends only changed ranges.

**Why it matters:**
- On a 10,000-line file, every keystroke sends 300KB+ over stdin. With incremental sync, it sends ~100 bytes.
- gopls and rust-analyzer both use incremental sync.
- The parser already supports incremental re-parsing via old-tree reuse. The gap is only in the transport layer.

**Difficulty:** Medium. vscode-languageserver-textdocument supports incremental sync out of the box. The change is in how the server registers sync capability and applies ContentChanges.

**Impact:** Latency reduction on large files, lower memory pressure.

---

### Gap 2: Request Cancellation — THOROUGH PROPAGATION

**Current:** CancellationToken checked at entry points and between resolution stages in some handlers.
**Production standard:** Every long-running computation checks cancellation at every iteration or stage boundary.

**Why it matters:**
- When a user types fast, completion requests from 3 keystrokes ago are still computing. Without cancellation, they pile up.
- gopls uses a context.Context pattern that propagates cancellation through every function call.
- rust-analyzer checks cancellation after every salsa query evaluation.

**What's missing:**
- PikeWorker requests (typeof_, diagnose, autodoc) have a 5s timeout but no CancellationToken propagation
- Completion iteration through stdlib/predef indices doesn't check cancellation
- Background indexing doesn't respond to cancellation

**Difficulty:** Low-Medium. Add token checks at loop boundaries.

---

### Gap 3: Completion Quality — LABEL DETAILS, RESOLVE, SORT TEXT

**Current:** Completion returns label + kind + detail. isIncomplete when >50 items. No resolve, no sortText, no filterText, no labelDetails.
**Production standard:**
- `completionItem/resolve` for lazy detail fetching (rust-analyzer)
- `sortText` for relevance ranking (gopls uses fuzzy score)
- `filterText` for matching against what user typed
- `labelDetails` for signature preview without resolving
- `textEdit` instead of `insertText` for precise insertion
- Snippet support for function arguments (`$1, $2`)

**What's missing:**
- No `completionItem/resolve` handler (client gets everything upfront)
- No `sortText` — items appear in collection order, not relevance order
- No `filterText` — client does default prefix matching
- No `labelDetails` — function signatures shown in `detail` field (works but not idiomatic)
- No `textEdit` — uses `insertText` which can misposition in complex contexts
- No snippet completions for function calls with parameter placeholders

**Difficulty:** Medium. Each sub-gap is independent and can be addressed incrementally.

---

### Gap 4: Code Actions — MINIMAL

**Current:** 2 quick-fixes (remove unused variable, add missing import).
**Production standard:**
- Organize imports
- Extract to function/variable
- Inline variable
- Add missing case branches
- Fix all (apply same quick-fix to all occurrences in file)
- Source actions (organize imports, fix all)
- Refactor actions (rename is separate but extract/inline are code actions)

**What's missing:** Everything except the two existing quick-fixes.

**Priority for foundation:**
1. "Fix all" — apply same diagnostic fix to all occurrences (gopls does this)
2. Organize imports — sort and remove unused imports
3. Extract variable — selected expression → local variable declaration

**Difficulty:** Medium-High. Each action needs its own logic.

---

### Gap 5: Selection Range

**Current:** Not implemented.
**Production standard:** Returns the smallest syntactic unit containing the cursor, then progressively larger units. Used for "shrink selection" (Ctrl+Shift+← in VSCode).

**Why it matters:** Selection range is a core editing feature. Without it, VSCode's shrink/expand selection doesn't work for Pike files.

**Implementation:** Walk tree-sitter AST from cursor position upward, collecting ranges for each enclosing node. Filter to meaningful node types (function, class, block, arguments, etc.).

**Difficulty:** Low. Pure tree-sitter walk, no semantic analysis needed.

---

### Gap 6: Inlay Hints

**Current:** Not implemented.
**Production standard:** Show inferred types, parameter names, and chained types inline as virtual text.

**Why it matters:** Inlay hints are one of the highest-impact features for developer experience in typed languages. Pike has optional type annotations — inlay hints show inferred types where annotations are missing.

**What to show:**
1. Variable type hints: `x = Dog()` → `x: Dog = Dog()`
2. Parameter name hints: `create("Rex", 5)` → `create(name: "Rex", age: 5)`
3. Chained type hints: `getAnimal()->speak()` shows return type of speak()

**Difficulty:** Medium. Requires type resolution pipeline (already exists) + virtual text rendering.

---

### Gap 7: Call Hierarchy

**Current:** Not implemented.
**Production standard:** `textDocument/prepareCallHierarchy` + `callHierarchy/incomingCalls` + `callHierarchy/outgoingCalls`. Shows call graph for a function.

**Implementation approach:**
- prepareCallHierarchy: find function at cursor, return CallHierarchyItem
- incomingCalls: search all indexed files for calls to this function
- outgoingCalls: walk function body for call expressions, resolve targets

**Why it matters:** Understanding call graphs is critical for maintenance and refactoring.

**Difficulty:** Medium-High. Requires cross-file reference resolution (partially exists) + call expression identification in AST.

---

### Gap 8: On-Type Formatting

**Current:** Not implemented. Full-document formatting exists (indentation-only).
**Production standard:** Format on trigger characters (typically `}`, `;`, `\n`). Fixes indentation of the current line or block after the user types a closing brace or semicolon.

**Why it matters:** This is what makes "format on type" work in VSCode. Without it, Pike users must manually trigger formatting.

**Difficulty:** Low. Reuse existing formatting handler, apply only to changed line(s).

---

### Gap 9: Code Lens

**Current:** Not implemented.
**Production standard:** Virtual decorations in the editor showing references count, implementations, test run buttons, etc.

**Useful lenses for Pike:**
1. Reference count above function/class declarations ("3 references")
2. Implementation count above class declarations ("2 implementors")
3. "Run" lens above test functions (if test framework detected)

**Difficulty:** Medium. Reference/implementation counting already exists via cross-file resolution.

---

### Gap 10: Request Priority and Scheduling

**Current:** All LSP requests processed in FIFO order. A background indexing job can delay a completion request.
**Production standard:** User-facing requests (completion, hover, signature help) are prioritized over background work (indexing, diagnostics).

**What's missing:**
- No priority queue for incoming requests
- Background indexing can starve interactive requests on large workspaces
- Diagnostics computation blocks completion requests when PikeWorker is busy

**Approach:** 
- Interactive requests (completion, hover, sigHelp) get priority in the PikeWorker queue
- Background indexing yields more aggressively when interactive requests are pending
- Diagnostics use the existing debouncing but should be cancellable when a higher-priority request arrives

**Difficulty:** Medium. Requires restructuring the PikeWorker queue to support priorities.

---

### Gap 11: Persistent Index Correctness

**Current:** Persistent cache stores symbol tables but has edge cases:
- Cross-file type resolution freshness noted as "Medium" limitation
- Background index may not invalidate correctly when files change externally
- Cache warmup happens synchronously in some paths

**Production standard:**
- File watchers trigger invalidation of cached index entries
- Cache versioning that survives format changes
- Atomic cache reads (no partial reads)

**Difficulty:** Medium. Mostly about tightening the existing invalidation logic.

---

### Gap 12: Testing Infrastructure

**Current:** 1,051+ tests. Good coverage of individual features. Test harness uses pike as oracle.
**What's missing compared to production LSPs:**
- No performance benchmarks (only `completion (warm)` benchmark exists)
- No stress tests (rapid edits, large files, many concurrent requests)
- No snapshot testing for complex outputs (hover markdown, completion lists)
- No LSP protocol compliance tests (verify exact message shapes)
- Test harness depends on pike binary availability

**Priority for foundation:**
1. Performance benchmarks for core operations (parse, completion, hover, definition)
2. Large-file stress test (10K-line file)
3. Rapid-edit stress test (100 edits in 1 second)

**Difficulty:** Low. Tests don't need production code changes.

---

## Part 2: Prioritized Foundation Plan

The following phases are ordered by impact on daily user experience. "Foundation" means infrastructure that makes everything else better, not new features stacked on shaky ground.

### Phase A: Transport & Responsiveness (Foundation Layer)

These changes affect every single feature the LSP provides.

| # | Task | Impact | Difficulty |
|---|------|--------|------------|
| A1 | Incremental text document sync | Every keystroke faster | Medium |
| A2 | Request cancellation propagation | Responsive under load | Low-Medium |
| A3 | Request priority in PikeWorker | Completion never starved | Medium |
| A4 | Completion sortText + filterText | Completion feels right | Low |

### Phase B: Editing Quality (Daily Experience)

These make the editor feel native for Pike files.

| # | Task | Impact | Difficulty |
|---|------|--------|------------|
| B1 | Selection range | Shrink/expand selection | Low |
| B2 | On-type formatting | Auto-indent on `}` and `;` | Low |
| B3 | Completion textEdit | Precise insertion | Low |
| B4 | Completion snippets | Function argument placeholders | Low-Medium |
| B5 | Inlay hints (type hints) | See inferred types | Medium |
| B6 | Inlay hints (parameter names) | Named arguments visible | Medium |

### Phase C: Navigation & Understanding

| # | Task | Impact | Difficulty |
|---|------|--------|------------|
| C1 | Call hierarchy incoming | Who calls this function | Medium-High |
| C2 | Call hierarchy outgoing | What does this function call | Medium |
| C3 | Code lens (reference count) | Quick navigation context | Medium |
| C4 | Type definition go-to | Navigate to type source | Low |

### Phase D: Code Actions

| # | Task | Impact | Difficulty |
|---|------|--------|------------|
| D1 | Fix all code action | Batch-fix diagnostics | Medium |
| D2 | Organize imports | Clean up import section | Medium |
| D3 | Extract variable | Refactoring support | Medium |
| D4 | Add missing case | Exhaustive switch | Medium |

### Phase E: Robustness & Performance

| # | Task | Impact | Difficulty |
|---|------|--------|------------|
| E1 | Performance benchmarks | Measure before optimizing | Low |
| E2 | Large-file stress test | Verify limits hold | Low |
| E3 | Rapid-edit stress test | Verify cancellation works | Low |
| E4 | Persistent cache correctness | Reliable cold start | Medium |
| E5 | Completion resolve (lazy) | Faster initial response | Medium |

---

## Part 3: What NOT to Do

Based on the Pike LSP's Tier-3 nature and the project's operating principles:

1. **Do not build a salsa-like incremental computation framework.** The Pike LSP uses tree-sitter (syntax) + pike (semantics). This is the right architecture for Tier-3. salsa is for projects that need to recompute type checking incrementally — the Pike LSP delegates that to the pike binary.

2. **Do not implement type checking in TypeScript.** The pike binary is the oracle. Type checking belongs in pike. The LSP's job is to present pike's answers quickly.

3. **Do not implement type hierarchy.** Pike's inheritance model is single-inheritance with mixins. Type hierarchy is low-value compared to call hierarchy and implementation finder (already exists).

4. **Do not implement linked editing range.** Useful for HTML/JSX tag matching. Not useful for Pike.

5. **Do not implement inline values.** This is for debug adapters, not language servers.

6. **Do not implement moniker.** Only useful for cross-workspace symbol linking. Not needed for Pike.

7. **Do not build range formatting yet.** The formatter is indentation-only (Phase 1). Range formatting makes sense after the formatter handles operator spacing and other semantic formatting.

---

## Summary: Foundation Priority Order

```
Phase A (Transport) → Phase B (Editing) → Phase E (Robustness) → Phase C (Navigation) → Phase D (Code Actions)
```

Rationale: Transport improvements (A) make every existing feature better. Editing quality (B) is what users notice daily. Robustness (E) ensures it holds up under real use. Navigation (C) and code actions (D) are important but build on top of A+B.

The single highest-impact change is **A1: Incremental text document sync** — it reduces latency on every keystroke for every feature, with no user-facing behavior change.
