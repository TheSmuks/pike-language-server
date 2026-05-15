---
title: Type Inference
created: 2026-05-15
updated: 2026-05-15
type: concept
tags:
  - type-inference
  - adr
sources:
  - raw/articles/decisions-0019-type-inference.md
---

# Type Inference

Pike is dynamically typed — most variables are declared without explicit type
annotations. The language server uses a layered type inference strategy, ordered
by cost and reliability, to provide meaningful hover, completion, and navigation
for untyped variables.

## The 5-Layer Inference Stack

### Layer 1: Return Type Tracking

Functions and methods store their return type annotation (if present) in
`Declaration.declaredType`, extracted from the `return_type` field of the
tree-sitter function node. This is purely syntactic — no flow analysis is
performed on the function body.

- `Dog createDog() { … }` → `declaredType = "Dog"`
- No return type annotation → `declaredType = undefined`

### Layer 2: Assignment Narrowing

For variable declarations where the declared type is absent or `mixed`, the
symbol table extracts the initializer expression's callee or identifier name
and stores it as `assignedType`.

- `d = Dog("Rex")` → `assignedType = "Dog"`
- `d = makeDog()` → `assignedType = "makeDog"` (function name, not class)
- Extraction drills through wrapper nodes: `comma_expr`, `assign_expr`,
  `cond_expr`, `postfix_expr`, `primary_expr`, `identifier_expr`
- Primitive type names (`int`, `string`, `array`, etc.) are rejected

Single-step only — `a = b; b = Foo()` does **not** propagate the type through
to `a`.

### Layer 3: PikeWorker `typeof_()`

The [[pike-worker]] provides an async `typeof_(source, expression)` method that
evaluates `typeof()` in the Pike runtime. Used as a hover fallback for untyped
variables.

Eligibility: only `variable` or `parameter` declarations where `declaredType` is
absent, `"mixed"`, or `"auto"`. Explicitly typed variables never trigger a
runtime query.

On success, hover displays `// inferred: <type>`. On failure (worker unavailable,
timeout, returns `mixed`), the handler falls through silently.

### Layer 4: Depth Limits (`MAX_RESOLUTION_DEPTH = 5`)

`resolveType` in `typeResolver.ts` enforces a depth limit of 5 on recursive
resolution through class hierarchies. Prevents infinite recursion on circular
inheritance chains (e.g., `class A inherits B`, `class B inherits A`).

Resolution chain: same-file class → cross-file class via inherit/import →
qualified type via `WorkspaceIndex` → stdlib type via prefix index.

### Layer 5: Fallback Chain

When all inference mechanisms fail, the server falls back to basic tree-sitter
hover from `declForHover`:

1. **Tier 1**: Direct tree-sitter hover on the node
2. **Tier 2**: Symbol table declaration lookup
3. **Tier 3**: `declForHover` using `Declaration.declaredType`
4. **Tier 4**: `PikeWorker.typeof_()` for untyped variables
5. **Final**: `formatHover(declForHover(decl, uri))` — basic tree-sitter hover

The `onHover` handler always returns a result or `null`; it never surfaces
internal errors.

## Key Constraints

| Constraint | Value | Rationale |
|-----------|-------|-----------|
| `MAX_RESOLUTION_DEPTH` | 5 | Prevents infinite recursion; real Pike codebases rarely exceed 3-4 levels |
| `assignedType` scope | Single-step only | Chained assignments (`a = b; b = Foo()`) not tracked |
| `typeof_()` gating | Only for untyped variables | Explicitly typed variables never trigger runtime queries |
| `PRIMITIVE_TYPES` rejection | 15 types | `void`, `mixed`, `zero`, `int`, `float`, `string`, `array`, `mapping`, `multiset`, `object`, `function`, `program`, `bool`, `auto`, `any` |

## Related

- [[tier-3-lsp]] — the overall scope within which type inference operates
- [[pike-worker]] — provides the `typeof_()` runtime query
- [[pike]] — the language runtime
