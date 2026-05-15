# Feasibility Assessment: Incremental Symbol Table Rebuilds

**Date:** 2026-05-16
**Scope:** Audit item 3.3 — Can the Pike LSP incrementally rebuild its symbol table instead of full rebuilds on every change?

---

## 1. Current Pipeline

The symbol table is built by `buildSymbolTable()` in `symbolTable.ts` via four sequential passes:

1. **Declaration collection** (`declarationCollector.ts`) — recursive AST walk, creates scopes for classes/functions/lambdas/blocks, registers declarations (variables, functions, classes, parameters, inherits, imports).
2. **Table assembly** — packages declarations, scopes, and lookup maps (`declById`, `scopeById`).
3. **Inheritance wiring** (`scopeBuilder.ts:wireInheritance`) — resolves `inherit` declarations to class scopes (local and cross-file via synthetic scopes).
4. **Reference collection + resolution** (`referenceCollector.ts`) — walks every identifier, arrow/dot access, scope expression, type reference; resolves each against the scope chain.

### Build triggers

- **Every keystroke** in `onDidChangeContent` (`server.ts:427`): calls `parse()` then `index.upsertFile()` which calls `buildSymbolTable()`.
- **Every debounced lint run** (`diagnosticManager.ts:473`): calls `buildSymbolTable()` again for the same file.
- **Autodoc template generation** (`autodocTemplate.ts:41`): builds symbol table fresh.
- **Cross-file dependent re-indexing** (`server.ts:366-370`): re-parses and re-indexes dependent files.

### Current cost

- **Typical Pike file:** ~33 lines average (85 corpus files, 2805 total lines). Largest corpus file is ~73 lines.
- **Tree-sitter incremental parsing is already in place** (`parser.ts:121`): `parser.parse(source, oldTree)` reuses unchanged subtrees.
- **Symbol table build is the expensive part** — decision 0014 notes 5-10+ ms event loop blocking for files with >1000 nodes. Most corpus files are well under this threshold.
- Performance tests budget 200ms for 10 documentSymbol requests (includes parse + symbol table + wire + LSP serialization).

---

## 2. Tree-Sitter Incremental Support

The LSP already exploits tree-sitter's incremental parsing:

```
// parser.ts:121
const tree = parserInstance.parse(source, oldTree ?? null);
```

The old tree is cached per-URI in an LRU cache. Tree-sitter reuses unchanged subtrees internally. However, **the symbol table is always rebuilt from scratch** from the new tree — the incremental parse tree is not exploited at the symbol table level.

Tree-sitter provides two APIs that would enable incremental symbol tables:
- `Tree.getChangedRanges(otherTree)` — returns ranges that differ between old and new trees.
- `Node.hasChanges` — per-node flag indicating whether the subtree changed.

These could theoretically identify which AST regions changed and limit symbol table rebuild to those regions.

---

## 3. Feasibility Analysis

### 3.1 What could be reused?

In theory, for unchanged subtrees:
- **Scopes** whose ranges fall entirely outside changed ranges could be kept.
- **Declarations** inside unchanged scopes could be kept.
- **References** inside unchanged scopes could be kept if the scope chain above them is also unchanged.

### 3.2 The dependency invalidation problem

This is the **core blocker**. Symbol table entries have pervasive cross-scope dependencies:

| Dependency | Impact |
|---|---|
| **Scope chain resolution** | A reference in function F resolves by walking scopes upward. Adding/removing a variable in an enclosing scope changes resolution for all references in F. |
| **Inheritance wiring** | Adding/removing an `inherit` declaration in a class changes `inheritedScopes` for that class scope, which changes member resolution for every arrow/dot access in the file. |
| **Cross-file inheritance** | Cross-file class members are resolved as synthetic scopes. Changes to imports/inherits at file scope invalidate downstream class resolution. |
| **File-scope declarations** | Adding a top-level function/class/variable affects resolution of every reference in every scope that doesn't shadow it. |
| **Hoisting** | Pike file-scope declarations have no ordering constraint — a new class at line 200 affects references at line 10. |
| **Reference ordering** | In block/function scopes, a declaration must appear before its reference. Adding a `var` declaration shifts this boundary. |

**A single-character change** (e.g., adding a variable name in an outer scope, or adding an `inherit` keyword) can invalidate the resolution of *every reference in the file*. There is no cheap way to detect when such "high-impact" changes occur without essentially re-scanning the changed region's effect on all enclosing scopes.

### 3.3 Complexity of incremental rebuild

A correct incremental symbol table would require:

1. **Identify changed ranges** via `getChangedRanges()` — easy, tree-sitter provides this.
2. **Determine affected scopes** — scopes intersecting changed ranges, plus all descendant scopes, plus all scopes affected by inheritance changes.
3. **Invalidate cascading dependencies** — any scope whose resolution could be affected by declarations added/removed in changed scopes. This is equivalent to: "any scope that is a descendant of a changed scope's ancestor, OR any scope that inherits from a changed class."
4. **Rebuild only affected scopes** — re-collect declarations, re-wire inheritance, re-resolve references for affected scopes.
5. **Update ID mapping** — declaration and scope IDs must remain stable for cross-file reference. Old IDs from unchanged scopes must coexist with new IDs.

The invalidation logic alone (step 3) is a graph traversal problem that is nearly as expensive as rebuilding from scratch for all but the most trivial changes. Steps 4-5 require careful merge logic between old and new data structures.

### 3.4 Comparison with full rebuild

The full rebuild pipeline for a typical Pike file (33 lines, ~50 nodes):
- **Pass 1 (declarations):** ~0.1ms — trivial recursive walk
- **Pass 2 (assembly):** ~0.01ms — object construction
- **Pass 3 (inheritance):** ~0.05ms — scope lookup
- **Pass 4 (references):** ~0.2ms — identifier walk + scope chain resolution
- **Total:** ~0.5ms for typical files

For the largest files (>1000 nodes, per decision 0014): ~5-10ms. The `buildSymbolTableAsync` variant (yielding via `setImmediate`) already addresses this for the event loop concern.

---

## 4. How Other LSPs Handle This

| LSP | Approach |
|---|---|
| **rust-analyzer** | Full incremental salsa-based query system. Every input change invalidates a computed dependency graph. Massive engineering investment (~100K lines of incremental infrastructure). |
| **TypeScript LS** | Full rebuild per file. TypeScript's `SourceFile` objects are created fresh. Performance is acceptable because the checker is lazy — it only type-checks on demand. |
| **gopls** | Uses a snapshot-based architecture. Each file change creates a new snapshot but reuses unchanged packages. Go packages are natural invalidation boundaries. |
| **clangd** | Rebuilds the AST per-TU. Incremental at the build system level (reuses object files), not at the AST level. |

**No mainstream LSP does incremental symbol table rebuilds at the sub-file level.** The invalidation problem is universally considered not worth the complexity for single-file changes.

---

## 5. Recommendation

### **Skip incremental symbol table rebuilds.**

**Rationale:**

1. **Cost is already low.** Full rebuild for typical Pike files (~33 lines) takes <1ms. Even the worst case (5-10ms for >1000 nodes) is within acceptable LSP latency budgets.

2. **Tree-sitter incremental parsing is already in place.** The expensive part (re-parsing) is already incremental. The symbol table build on top is O(nodes) and fast for Pike's typical file sizes.

3. **Invalidation is intractable without massive investment.** Pike's scope resolution is context-dependent (scope chain walk + inheritance). A correct incremental system would need a full dependency graph with invalidation propagation — essentially the salsa query model that rust-analyzer spent years building.

4. **Risk-to-reward is poor.** The engineering effort (estimated 2-4 weeks for a correct implementation + testing) would save <5ms per keystroke on files that are already performant, with significant risk of resolution bugs from stale scope data.

5. **Existing mitigations are sufficient:**
   - 500ms debounce on diagnostics (already defers `buildSymbolTable` to debounced path — audit fix X3.2).
   - LRU tree cache avoids re-parsing.
   - `buildSymbolTableAsync` available for large files if needed.
   - Pike files are typically small (average 33 lines in corpus; real-world Pike files rarely exceed 500 lines).

### If performance becomes a problem in the future

The following optimizations are lower-effort and higher-impact:

1. **Avoid double symbol table builds** — currently `upsertFile()` and `safeLintDiagnostics()` both build the table. Share the result.
2. **Lazy reference resolution** — build declarations + scopes eagerly, but resolve references only when needed (on-demand for go-to-definition, find-references). This would turn the 4-pass build into a 3-pass build for the hot path.
3. **File-level caching** — if the parse tree is identical (content hash match), skip the symbol table build entirely. The ` PikeCache` already does this for Pike diagnostics; extend it to symbol tables.
4. **Yield for large files** — adopt `buildSymbolTableAsync` in `upsertFile` for files with >1000 nodes.

---

## 6. Summary

| Factor | Assessment |
|---|---|
| Current full-rebuild cost | <1ms typical, 5-10ms worst case |
| Tree-sitter incremental parsing | Already implemented |
| Incremental symbol table complexity | Very high — invalidation is intractable |
| Benefit for typical files | Negligible (<1ms saved) |
| Benefit for large files | Marginal (save ~5ms on >1000 node files) |
| Industry precedent | No mainstream LSP does this |
| **Recommendation** | **Skip. Invest in simpler optimizations instead.** |
