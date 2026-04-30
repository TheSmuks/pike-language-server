# 0002: Tier-3 Scope — Three-Source Resolution Boundary

**Status**: Accepted
**Date**: 2026-04-30
**Decision Maker**: Project lead

## Context

Pike 8.0.1116 provides no structured output mode. All compiler diagnostics are human-readable text. Type information is primarily a compile-time artifact; runtime introspection via `typeof()` works for locals and expressions but degrades to `mixed` for object members. The language server cannot call into compiler internals, so it must work with what Pike exposes externally.

The fundamental constraint: `typeof(o->member)` returns `mixed`. This means hover, completion, and navigation for object member access cannot rely on Pike runtime queries alone.

### What Pike Provides

| Capability | Available? | Source |
|------------|-----------|--------|
| Local variable type | Yes | `typeof(var)` runtime eval |
| Expression type | Yes | `typeof(expr)` runtime eval |
| Stdlib function signatures | Yes | `pike-signature` MCP tool |
| Stdlib module/method listing | Yes | `pike-list-modules`, `pike-list-methods` |
| Object member names | Yes | `indices(object)` |
| Object member types | **No** | `typeof(o->member)` → `mixed` |
| Inherited member types | **No** | Same limitation |
| Generic instantiation | **No** | `array(int)` → `array` at runtime |
| Diagnostics | Yes | `pike-check-syntax` / compile_string |
| Cross-file navigation | **No** | No tool support |

## Decision

The LSP is a **tier-3** implementation: it uses three complementary sources for type resolution and accepts that some information is unavailable.

### Three-Source Type Resolution

1. **Tree-sitter (syntactic)** — real-time, fast, partial. Parses declarations, extracts explicit type annotations. Covers: local variables with declared types, function signatures, class member declarations.
2. **Pike oracle (semantic)** — real-time debounced (500ms), subprocess, authoritative. Provides diagnostics, `typeof()` evaluation for locals and expressions. Covers: inferred types, runtime-verified type information.
3. **Pre-built indices** — stdlib (5,505 symbols) + predef builtins (283 symbols). Covers: standard library hover and completion.

### In Scope

- Diagnostics via Pike compilation
- Hover for locals, expressions, stdlib symbols, explicitly-typed object members
- Completion for stdlib, project-local symbols, declared-type member access
- Go-to-definition and find-references via source-level parsing
- Assignment-based type narrowing for local variables

### Out of Scope (Tier-3 Boundary)

- Code actions and refactoring beyond rename
- Full control-flow type narrowing (if/else branch analysis)
- Chained type inference across multiple assignments
- Generic type instantiation (e.g., `array(int)` tracks as `array`)
- Runtime value completion or evaluation

**MUST**: All type resolution must degrade gracefully — unavailable information shows the best available type, never blocks the response.

**SHOULD**: Use Pike oracle as the authoritative source when available; fall back to tree-sitter; fall back to `mixed`.

**MAY**: Cache oracle results across requests for the same document version.

## Consequences

### Positive

- Honest scope: users get correct information where available, and `mixed` where not
- No brittle source-level type inference beyond what tree-sitter can parse
- Pike oracle provides ground-truth verification for diagnostics
- Architecture supports incremental improvement without rework

### Negative

- Object member access on `mixed`-typed variables shows `mixed` — covers a large portion of practical Pike code
- Generic type information is lost at runtime
- Chained inference (a = b; b = c;) limited to single-step assignment narrowing

### Neutral

- The three-source architecture means hover response latency varies: tree-sitter is instant, oracle is debounced
- Pre-built indices require regeneration when Pike version changes

## Alternatives Considered

### Full Source-Level Type Inference

Build a Pike type checker in TypeScript that resolves types from source alone. Rejected: Pike's type system is complex (inheritance, mixins, generic types, compile-time constants). Building a correct type checker would approach compiler-level effort, inconsistent with tier-3 scope.

### Compiler Integration via C Extensions

Write a Pike C module that exposes compiler internals for type resolution. Rejected: fragile across Pike versions, requires C build tooling, maintenance burden disproportionate to tier-3 goals.

### LSP-Only (No Oracle)

Use only tree-sitter parsing, no Pike subprocess. Rejected: loses diagnostics, loses `typeof()` ground truth, hover quality degrades significantly.

---

## Updates

### 2026-04-30 — Phase 10/11 Type Inference Improvements

Phase 10/11 partially addressed the "object member type resolution" gap identified in this decision. Summary of changes:

| US | Capability | What Changed |
|----|-----------|--------------|
| US-008 | Assignment-based type narrowing | Symbol table tracks `assignedType` field. When a variable is assigned from a typed expression (constructor call, cast, typed variable), the assigned type is recorded and used for member resolution. Single-step only — `a = Foo(); a->bar` works; chained `a = b; b = Foo()` does not. |
| US-009 | PikeWorker typeof integration | Hover on variables declared as `mixed` now queries the Pike worker's `typeof()` for the actual runtime type. This bridges the gap for variables without explicit annotations where Pike can determine the type at eval time. |
| US-010 | Type inference corpus files | Added four corpus files (`inference-assign`, `inference-chained`, `inference-failure`, `inference-return`) with harness snapshots documenting expected behavior. The `inference-failure` corpus explicitly captures remaining limitations. |

**Remaining gaps after Phase 10/11:**

- **Chained inference**: `a = b; b = Foo()` does not propagate the type through to `a`. Only direct assignments are tracked.
- **Control flow analysis**: Variables reassigned in conditional branches keep the last-assigned type, not a union of possible types.
- **Object member types via `typeof()`**: `typeof(o->member)` still returns `mixed`. US-008 works around this via source-level assignment tracking, but dynamic/member accesses on variables without tracked assignments still fall through to `mixed`.
- **Generic instantiation**: `array(int)` → `array` at runtime — unchanged.
