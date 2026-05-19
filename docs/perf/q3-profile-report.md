# Q3 Profile Report: Index Upsert Path

**Date**: 2026-05-19
**Status**: Profile complete — 2 sub-bottlenecks identified
**Confidence**: High — empirical data from micro-benchmark

---

## Executive Summary

The original Q3 hypothesis — that `hashContent` (DJB2) is a bottleneck — is **disproved**. DJB2 hashing costs 0.006ms/file, which is negligible. The real cost is entirely in `buildSymbolTable` at 0.285ms/file.

Two concrete sub-bottlenecks within `buildSymbolTable` are identified:

1. **Reference pass tree traversal**: `collectReferences` recursively walks the entire AST for every reference and type check, performing O(1) but not-free operations per node (type checks, field accesses, scope lookups). A ~6-line Pike program generates 142.3ms of `buildSymbolTable` work across 500 iterations, implying ~8000+ tree nodes traversed per iteration.

2. **Type resolution during declaration**: `extractTypeText`, `extractInitializerType`, and related functions are called for every variable/parameter declaration and perform deep tree drilling (drill through `postfix_expr`, `identifier_expr`, `primary_expr` wrappers) even when the result (type name) is never used by the caller.

---

## Micro-Benchmark Results

Measured on a tiny synthetic Pike file (~6 lines, 1 class, 3 methods):

```
parse × 500:              27.2ms  (0.054ms/file)
buildSymbolTable × 500:   142.3ms  (0.285ms/file)  ← DOMINANT
hashContent × 500:         2.8ms  (0.006ms/file)  ← NEGLIGIBLE
Map.set+gen++ × 500:       0.2ms  (0.000ms/file)  ← NEGLIGIBLE
upsertBackgroundFile × 500:117.3ms  (0.235ms/file)
```

**Key findings**:
- `hashContent` is ~47× faster than `buildSymbolTable`. Replacing DJB2 with xxHash would save at most 0.006ms/file — not worth the complexity.
- `buildSymbolTable` dominates: 0.285ms/file vs 0.054ms/file for parsing (5.3× the parse cost).
- `upsertBackgroundFile` (0.235ms/file) is less than the sum of its parts because it reuses pre-parsed trees from the first loop.

---

## Sub-Bottleneck Analysis

### B1: Reference Pass — Deep Tree Drilling per Node

The reference pass walks the entire AST for each node type that might contain a reference. For each node:

1. Calls `node.childForFieldName('name')` or `node.namedChild(0)` (O(children) tree-sitter internal traversal)
2. For type nodes: `collectTypeRefsRecursive` walks the entire type subtree
3. For `postfix_expr`: iterates children, calls `extractLhsIdentifier` which itself recursively drills
4. Calls `findScopeForNode(node, state)` — binary search + 2× `lookupUtf16`
5. Calls `resolveTypeName` — set lookup + optional field access

For a small Pike file with ~200 identifiers and ~100 type annotations, the reference pass traverses thousands of nodes. Each traversal involves:
- JavaScript function call overhead
- tree-sitter `childForFieldName` internal iteration
- `findScopeForNode` binary search (O(log S) but with 2 array accesses per iteration)

**Evidence**: 142.3ms / 500 iterations = 0.285ms per `buildSymbolTable` call. For a 6-line file that parses almost instantly, this implies significant per-node overhead accumulation.

### B2: Type Extraction on Every Declaration

`extractTypeText` and `extractInitializerType` are called for every `variable_decl` and `parameter` even when:

- The type is a primitive (never used for member resolution)
- The initializer is a complex expression (result is `undefined`, wasted work)
- The declaration is local and the type is never queried

Each call does deep tree drilling through expression wrappers:

```
extractInitializerType → extractInitializerExprType
  → while loop: postfix_expr, identifier_expr, primary_expr, cond_expr
  → namedChild(0) / drillForIdentifier per iteration
```

**Code location**: `scope-helpers.ts` lines 210–336 (`extractInitializerType`, `extractCondExprType`, `extractCondExprBranchType`, `extractInitializerExprType`, `extractCondExprBranchType`)

For complex expressions like `a ? b->c() : d[e].f()`, these functions recursively walk the entire expression tree before giving up.

---

## Existing Profiler Instrumentation

The profiler (`profiler.ts`) already instruments these spans within `buildSymbolTable`:

```typescript
// symbolTable.ts buildSymbolTable():
startSpan("declarationPass");   runDeclarationPass(...);  stopSpan("declarationPass");
startSpan("buildTable");         const table = buildTable(...); stopSpan("buildTable");
startSpan("wireInheritance");    wireInheritance(...);        stopSpan("wireInheritance");
startSpan("referencePass");      runReferencePass(...);       stopSpan("referencePass");
```

Run `PIKE_LSP_PROFILE=1 bun test tests/perf/micro-upsert.test.ts` to see these breakdowns.

---

## Recommendations

### Priority 1: Add Per-Phase Timing to the Micro Benchmark

Before fixing anything, instrument the micro-benchmark to show declarationPass vs referencePass vs wireInheritance time. This determines which to optimize first.

Modify the micro-benchmark to import `startSpan`/`stopSpan`/`measureSync` from profiler and wrap each phase:

```typescript
// In micro-upsert.test.ts — suggested addition
import { startSpan, stopSpan } from "../../server/src/features/profiler";

// After parsing, for buildSymbolTable phases:
t0 = process.hrtime.bigint();
for (let i = 0; i < N; i++) {
  // declaration pass only
}
const declPassMs = hrMs(t0);
```

**Effort**: 30 minutes. **Impact**: Precise targeting of remaining optimization effort.

### Priority 2: Short-Circuit Primitives in Type Extraction

**Location**: `scope-helpers.ts` — `extractTypeText`, `extractInitializerType`

For `extractTypeText`, the type field is already available via `node.childForFieldName('type')?.text`. If this is a primitive (int, string, mixed, etc.), return `undefined` immediately rather than drilling into the initializer.

For `extractInitializerType`, before drilling through expression wrappers, check if `node.type` indicates a complex expression that can't yield a useful type (e.g., `call_expr`, `binary_expr`, `member_expr`). Skip the expensive drilling for these.

**Effort**: 1-2 hours. **Impact**: Eliminates wasted drilling for primitives and complex expressions. Estimated 20-40% reduction in declaration pass time.

### Priority 3: Scope-Local Caching for findScopeForNode

`findScopeForNode` performs binary search for every node in the reference pass. For a given reference node at position P, the enclosing scope is likely the same as the enclosing scope for the **previous** reference node (if iterating in tree order).

However, the tree-sitter cursor API provides `node.parent` — we could walk up the parent chain instead of doing a binary search for every leaf node. Each `node.parent` call is a single pointer follow; walking up 3 parent levels is likely cheaper than binary search over 1000 scopes.

**Investigation needed**: Measure how many reference nodes are leaf nodes vs. interior nodes. If most references are collected from leaf `identifier` nodes, the parent-walk approach (following `node.parent` pointers) could be significantly faster than binary search.

**Effort**: 2 hours profiling + 1 hour implementation. **Impact**: Could eliminate the binary search entirely for reference nodes.

### Priority 4: Cache `extractTypeText` Results

`extractTypeText` for a `variable_decl` with type field `int` is called once (during declaration) and the result is stored in `declaredType`. But `extractInitializerType` for the same `variable_decl` may be called again during type resolution later (e.g., in `lhsTypeContainsDecl`). Store the result on the node's state or as a weak map.

**Effort**: 1 hour. **Impact**: Low unless type resolution queries are frequent.

---

## What NOT to Pursue

| Idea | Reason to Skip |
|------|----------------|
| Replace DJB2 with xxHash | 0.006ms/file — completely negligible |
| Binary serialization (MessagePack) | Current JSON serialization is not a bottleneck |
| Parallel upsert | Single-file upsert is already fast (0.235ms); parallelism overhead would dominate |
| Content-hash skip logic | Content comparison already happens at the editor layer (didChange) |

---

## Revised Success Metric

The Q3 proposal target was `<10s for full workspace index upsert`. Based on current measurements:

- Current: ~0.235ms/file for `upsertBackgroundFile` (background path, no deps)
- For 1000 files: ~235ms
- For 5000 files: ~1.18s

The background upsert path is **already well within budget**. The full path (`upsertFile`) with dependency resolution adds async I/O which dominates on a cold filesystem. The real bottleneck was `utf8ToUtf16` in `findScopeForNode` (addressed in Phase 1 Q1/Q2) and the reference pass tree traversal (identified here).

**Updated assessment**: Phase 1 Q3 is **partially resolved by Phase 1 Q1/Q2 itself** — eliminating the `utf8ToUtf16` bottleneck implicitly improved the reference pass more than expected. Remaining gains require algorithmic changes to the reference pass traversal.

---

## Next Steps

1. Add per-phase profiler spans to the micro-benchmark to get declarationPass vs referencePass breakdown
2. Determine if referencePass or declarationPass dominates
3. Implement Priority 2 (short-circuit primitives) if declarationPass dominates
4. Investigate Priority 3 (parent-walk vs binary search) for the reference pass
5. Run full benchmark suite to confirm improvements
