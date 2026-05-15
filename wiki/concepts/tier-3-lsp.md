---
title: Tier-3 LSP
created: 2026-05-15
updated: 2026-05-15
type: concept
tags:
  - architecture
  - scope
  - adr
sources:
  - raw/articles/decisions-0002-tier-3-scope.md
  - raw/articles/pike-interface.md
---

# Tier-3 LSP

The Pike Language Server is a **tier-3** LSP implementation: it uses three
complementary sources for type resolution and explicitly accepts that some type
information is unavailable. This classification determines the scope of features,
quality expectations, and architectural boundaries.

## Three-Source Resolution

| Source | Role | Speed | Coverage |
|--------|------|-------|----------|
| **Tree-sitter** (syntactic) | Real-time parsing, declaration extraction | Instant (<1ms) | Local variables with declared types, function signatures, class member declarations |
| **Pike oracle** (semantic) | `typeof()` evaluation, compilation diagnostics | Debounced (~500ms) | Inferred types, runtime-verified type information |
| **Pre-built indices** | Stdlib (5,505 symbols) + predef builtins (283 symbols) | Instant (lookup) | Standard library hover and completion |

The fundamental constraint driving this design: `typeof(o->member)` returns
`mixed` for any object member. The compiler knows the declared type at compile
time but this information is not preserved into the runtime representation.
See [[pike]] for the full capability matrix. ([[known-limitations]] covers the permanent gaps in what Pike exposes.)

## Resolution Priority

When resolving a type, the server follows a strict priority order:

1. **Pike oracle** — authoritative source when available
2. **Tree-sitter** — fast syntactic fallback
3. **`mixed`** — honest degradation when no information is available

All type resolution degrades gracefully. Unavailable information shows the best
available type and never blocks a response.

## Capabilities In Scope (12)

1. Diagnostics via Pike compilation
2. Hover for locals, expressions, stdlib symbols, explicitly-typed object members
3. Completion for stdlib, project-local symbols, declared-type member access
4. Go-to-definition and find-references via source-level parsing
5. Assignment-based type narrowing for local variables
6. Code actions: remove unused variable, add missing import
7. Workspace symbol search across indexed files
8. Semantic tokens (syntax highlighting) from symbol table
9. Document highlight, folding ranges, signature help
10. Background workspace indexing on startup
11. Persistent cache across LSP restarts
12. Inlay hints (type hints and parameter labels)

## Capabilities Out of Scope (4)

1. **Full control-flow type narrowing** — no if/else branch analysis
2. **Chained type inference across multiple assignments** — `a = b; b = Foo()` does not propagate
3. **Generic type instantiation** — `array(int)` tracks as `array`
4. **Complex refactoring** — extract method, inline variable, move symbol

## Key Dependencies

- [[pike]] — the language runtime providing the oracle subprocess
- [[tree-sitter-pike]] — syntactic parser (WASM, v1.2.2)
- [[pike-ai-kb]] — MCP tools for stdlib symbol queries
- [[pike-worker]] — manages the Pike subprocess with idle eviction and caching

## Architectural Implications

The three-source architecture means hover response latency varies by source:
tree-sitter is instant, the Pike oracle is debounced at ~500ms, and pre-built
indices are in-memory lookups. The server maintains its own **project model**
(symbol table, import graph, type cache) because Pike and pike-ai-kb cannot
provide cross-file visibility or preserve type information at runtime boundaries.
