# Decision 0002: Tier-3 Scope Definition

**Date:** 2026-04-26
**Status:** Accepted (revised)
**Context:** Phase 0 investigation + verification — precise type-resolution boundary

## Decision

Define "tier 3" for this project based on what pike can actually provide, not on an aspirational feature list.

## Type Resolution Boundary (Revised)

The LSP has three type information sources, each with a precise boundary:

### Source A: Pike runtime oracle (via `CompilationHandler` + `typeof()`)

| Query | Result | Mechanism |
|-------|--------|-----------|
| Diagnostics for a file | Structured: `{file, line, message}[]` | `compile_string` with custom handler |
| Local variable type in scope | Pike type string (e.g., `int`, `array(string)`) | `typeof(var)` via `pike-evaluate` |
| Expression type | Pike type string | `typeof(expr)` via `pike-evaluate` |
| Stdlib function signature | Parameter types + return type | `pike-signature` via pike-ai-kb |
| Stdlib module contents | Module names, method names | `pike-list-modules`, `pike-list-methods` |

**Boundary: stops at object members.** `typeof(o->member)` returns `mixed` for any object member access. Pike's compile-time type information is not preserved through runtime object boundaries. This is a fundamental limitation of Pike's execution model, not a missing API.

### Source B: AutoDoc extractor (via `Tools.AutoDoc.PikeExtractor`)

| Query | Result | Mechanism |
|-------|--------|-----------|
| Documented method return type | XML: `<returntype><int/></returntype>` | `pike -x extract_autodoc` |
| Documented method parameters | XML: `<argument name='a'><type><int/></type></argument>` | Same |
| Documented variable type | XML: `<variable name='x'><type><int/></type></variable>` | Same |
| Inheritance chain | XML: `<inherit name='Foo'><classname>Foo</classname></inherit>` | Same |
| Generic type arguments | XML: `<array><valuetype><string/></valuetype></array>` | Same |

**Caveat:** AutoDoc coverage in real Pike codebases varies widely. Some modules document every member with `//!` comments; others document almost nothing. The LSP's hover quality on third-party Pike code will track that variation. For undocumented code, Source C (source parser) is the only option, and it provides declared type text without semantic validation.
**Boundary: stops at undocumented members.** AutoDoc only extracts members with `//!` doc comments. A variable declared as `int x;` without a preceding `//! Doc for x` is invisible to AutoDoc. In practice, many Pike projects do not document every member, so AutoDoc provides partial coverage at best.

### Source C: Source parser (via tree-sitter-pike)

| Query | Result | Mechanism |
|-------|--------|-----------|
| All declared members (documented or not) | AST node with type annotation | tree-sitter parse tree |
| Class structure, method signatures | AST nodes | tree-sitter parse tree |
| Import/inherit references | AST nodes | tree-sitter parse tree |
| File structure (top-level declarations) | AST nodes | tree-sitter parse tree |

**Boundary: stops at semantic correctness.** tree-sitter accepts more than Pike does (see tree-sitter-pike KL-009). It parses syntactically correct but semantically invalid code without complaint. Type annotations in declarations are text — the source parser reads `int x` as a type node containing `int`, but does not validate it.

### Resolution Strategy Per LSP Feature

| LSP Feature | Primary Source | Fallback | Notes |
|-------------|---------------|----------|-------|
| **Diagnostics** | Source A (CompilationHandler) | stderr parsing | Structured JSON from handler; stderr only if handler unavailable |
| **Hover: stdlib symbol** | Source A (pike-signature) | — | pike-ai-kb provides exact signatures |
| **Hover: local variable** | Source A (typeof) | Source C (declaration parse) | typeof works for locals; tree-sitter extracts declared type as fallback |
| **Hover: object member (documented)** | Source B (AutoDoc) | Source C (declaration parse) | AutoDoc gives exact type; tree-sitter gives declared type |
| **Hover: object member (undocumented)** | Source C (declaration parse) | — | **Only source parsing works here.** This is the gap. |
| **Completion: stdlib** | Source A (pike-list-*) | — | Well-covered by pike-ai-kb |
| **Completion: project symbols** | Source C (symbol index) | — | Must build; no oracle provides this |
| **Go-to-definition** | Source C (symbol index + import resolution) | — | Must build |
| **Find references** | Source C (text search + symbol index) | — | Must build |

### The Gap

The gap is **undocumented object members**. Source A and Source B both fail here. Source C (tree-sitter) is the only option, and it provides the declared type text (e.g., `int`) without semantic validation.

**This gap is acceptable for tier-3** because:
1. The declared type text is usually correct — Pike enforces types at compile time, so if the code compiles, the declarations are valid.
2. For cases where declared type is `mixed` or inferred, the LSP reports `mixed` — which is what Pike itself would report at runtime.
3. Future work (beyond tier-3) could use `compile_string` with typed input to validate inferred types.

## What Pike Can Provide

Based on the Phase 0 investigation (`docs/pike-interface.md`) and verification:

| Feature | Available | Mechanism | Limitations |
|---------|-----------|-----------|-------------|
| Diagnostics (syntax errors) | Yes | `compile_string` + handler | Line numbers only, no columns |
| Diagnostics (type errors) | Yes | Same | Structured JSON via handler |
| Diagnostics (undefined identifiers) | Yes | Same | Same |
| Diagnostics (wrong arity) | Yes | Same | Same |
| Hover (stdlib types) | Yes | `pike-signature`, `pike-describe-symbol` | Requires pike-ai-kb |
| Hover (local variable types) | Yes | `typeof()` via hilfe/evaluate | Runtime evaluation needed |
| Hover (documented object members) | Yes | AutoDoc XML extraction | Only for `//!` documented members |
| Hover (undocumented object members) | **No** | `typeof(o->member) → mixed` | Source parsing required |
| Completion (stdlib) | Yes | `pike-list-modules`, `pike-list-methods` | Requires pike-ai-kb |
| Completion (project symbols) | **No** | No tool provides this | Must build from source |
| Navigation (go-to-definition) | **No** | Pike has no cross-file resolution API | Must build from source |
| Find references | **No** | No API | Text-based search or source indexing |
| Rename | **No** | No API | Text-based heuristics |

## Tier-3 Scope for This Project

### In scope (pike provides the foundation)

1. **Diagnostics** — full syntax and type checking via `compile_string` with custom `CompilationHandler`. Structured JSON output. No column info but line info is reliable.
2. **Hover (partial)** — stdlib types via pike-ai-kb, local types via typeof(), documented member types via AutoDoc.
3. **Completion (stdlib)** — module names, method names, signatures from pike-ai-kb.
4. **Document symbols** — from tree-sitter parse tree (no pike needed).
5. **Folding ranges** — from tree-sitter parse tree.
6. **Semantic tokens** — from tree-sitter + source-level type extraction.

### In scope (must build from source parsing)

7. **Project symbol index** — parse `.pike`/`.pmod` files to extract top-level declarations.
8. **Go-to-definition** — within file from tree-sitter; cross-file from symbol index + import resolution.
9. **Find-references** — text-based with symbol index filtering.
10. **Completion (project-local)** — from symbol index.
11. **Hover (undocumented object members)** — parse class declarations to extract member types from declaration AST nodes.

### Out of scope (not achievable without substantial new infrastructure)

12. **Rename refactoring** — *Implemented in Phase 8.* textDocument/rename + prepareRename. Scope-aware, cross-file via WorkspaceIndex. Keyword validation. Decision 0016.
13. **Code actions** — *Implemented in Phase 14.* Remove unused variable, add missing import. Extensible quick-fix registry. Decision 0021.
14. **Full column-accurate diagnostics** — pike does not report columns.
15. **Incremental compilation** — pike does not support it.

## Feasibility Assessment

**The project is feasible as scoped.** Pike provides enough to build a useful tier-3 LSP:

- Diagnostics are solid (full syntax + type checking via structured API).
- Stdlib completion and hover are well-covered by pike-ai-kb.
- AutoDoc provides type ground-truth for documented members.
- Source parsing fills the gaps for project-local features and undocumented members.
- The `typeof() → mixed` limitation for object members is real but the scope boundary is now precise: documented members use AutoDoc, undocumented members use source parsing.

## Consequences

- The phase plan proceeds as designed.
- Phase 1's harness uses `compile_string` with `CompilationHandler` for diagnostics ground-truth, not stderr parsing.
- Phase 3 (symbol table) feeds both navigation and hover for undocumented members.
- Phase 5 (types and diagnostics) has a three-tier type resolution strategy: oracle / AutoDoc / source parser.
- The test harness captures output from all three sources as ground truth.
