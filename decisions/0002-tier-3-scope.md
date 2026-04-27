# Decision 0002: Tier-3 Scope Definition

**Date:** 2026-04-26
**Status:** Accepted
**Context:** Phase 0 investigation — what pike actually exposes

## Decision

Define "tier 3" for this project based on what pike can actually provide, not on an aspirational feature list.

## What Pike Can Provide

Based on the Phase 0 investigation (`docs/pike-interface.md`):

| Feature | Available | Mechanism | Limitations |
|---------|-----------|-----------|-------------|
| Diagnostics (syntax errors) | Yes | `pike file.pike 2>&1` | Line numbers only, no columns |
| Diagnostics (type errors) | Yes | Same as above | Only for files that compile far enough |
| Diagnostics (undefined identifiers) | Yes | Same as above | Only within compilation scope |
| Diagnostics (wrong arity) | Yes | Same as above | Same |
| Hover (stdlib types) | Yes | `pike-signature`, `pike-describe-symbol` | Requires pike-ai-kb |
| Hover (local variable types) | Yes | `typeof()` via hilfe/evaluate | Runtime evaluation needed |
| Hover (object member types) | **No** | `typeof(o->member) → mixed` | Source parsing required |
| Completion (stdlib) | Yes | `pike-list-modules`, `pike-list-methods` | Requires pike-ai-kb |
| Completion (project symbols) | **No** | No tool provides this | Must build from source |
| Navigation (go-to-definition) | **No** | Pike has no cross-file resolution API | Must build from source |
| Find references | **No** | No API | Text-based search or source indexing |
| Rename | **No** | No API | Text-based heuristics |

## Tier-3 Scope for This Project

### In scope (pike provides the foundation)

1. **Diagnostics** — full syntax and type checking via pike compilation. Parse stderr, map to LSP Diagnostic. No column info but line info is reliable.
2. **Hover (partial)** — stdlib types via pike-ai-kb, local types via typeof(). Object member types from source parsing of class declarations.
3. **Completion (stdlib)** — module names, method names, signatures from pike-ai-kb.
4. **Document symbols** — from tree-sitter parse tree (no pike needed).
5. **Folding ranges** — from tree-sitter parse tree.
6. **Semantic tokens** — from tree-sitter + source-level type extraction.

### In scope (must build from source parsing)

7. **Project symbol index** — parse `.pike`/`.pmod` files to extract top-level declarations.
8. **Go-to-definition** — within file from tree-sitter; cross-file from symbol index + import resolution.
9. **Find-references** — text-based with symbol index filtering.
10. **Completion (project-local)** — from symbol index.
11. **Hover (object members)** — parse class declarations to extract member types.

### Out of scope (not achievable without substantial new infrastructure)

12. **Rename refactoring** — text-based heuristics only. Pike has no rename support.
13. **Code actions** — would be entirely custom.
14. **Full column-accurate diagnostics** — pike does not report columns.
15. **Incremental compilation** — pike does not support it.

### Critical constraint: `typeof() → mixed` for object members

This is the fundamental limitation. Pike's compile-time type information is not available through runtime introspection for object members. The LSP must parse Pike source code to extract types from declarations:

```pike
class Foo {
    int x;                    // Type: int — extractable from source
    string bar(int a) { ... } // Return type: string — extractable from source
}
```

This means the LSP needs a **two-tier type resolution strategy**:
- **Tier A (oracle):** Use pike/pike-ai-kb for stdlib, for diagnostics, and for expression types via typeof().
- **Tier B (source):** Parse class and function declarations to extract declared types for object members, function parameters, and return types.

## Feasibility Assessment

**The project is feasible as scoped.** Pike provides enough to build a useful tier-3 LSP:

- Diagnostics are solid (full syntax + type checking).
- Stdlib completion and hover are well-covered by pike-ai-kb.
- Source parsing fills the gaps for project-local features.
- The `typeof() → mixed` limitation is real but manageable with source-level parsing.

The project does NOT need to pause at Phase 0. Pike can give us types for stdlib and locals; source parsing covers the rest.

## Consequences

- The phase plan proceeds as designed.
- Phase 3 (symbol table) becomes more important — it's not just for navigation, it's also for hover types.
- Phase 5 (types and diagnostics) will have a two-tier implementation strategy.
- The test harness must capture both oracle outputs and source-parsed outputs as ground truth.
