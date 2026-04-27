# Decision 0001: Pike as Oracle

**Date:** 2026-04-26
**Status:** Accepted
**Context:** Phase 0 investigation

## Decision

Use the Pike compiler (`pike` binary) as the oracle for diagnostics, type information, and symbol resolution. Prefer pike-ai-kb's MCP tools over direct invocation where they cover the need.

## Alternatives Considered

### 1. Own type checker (rejected)

Build a Pike type checker from scratch in TypeScript.

- **Pros:** No external dependency; potentially faster for incremental checks.
- **Cons:** Pike's type system is complex (intersection types, program/function types, generic types with value ranges like `int(0..2)`, `string(97..98)`). Re-implementing it would take months and would always lag behind what `pike` actually does. The tree-sitter-pike project spent 22 rounds on parsing alone; a type checker is a substantially harder problem.
- **Verdict:** Not feasible for a tier-3 project. Would be a multi-month side project in itself.

### 2. Static analysis only (rejected)

Parse Pike source with tree-sitter and derive information structurally, without invoking pike.

- **Pros:** Fast, no subprocess overhead, works offline.
- **Cons:** Cannot detect type errors, undefined identifiers, wrong arity, or any semantic issue. Would be tier-1 at best (syntax highlighting, bracket matching). The phase plan explicitly requires tier-3 features.
- **Verdict:** Useful as a complement (tree-sitter provides the parse tree) but insufficient alone.

### 3. No oracle (rejected)

Ship the LSP with only tree-sitter-based features.

- **Pros:** Simple deployment, no pike dependency.
- **Cons:** Cannot provide diagnostics, hover types, or semantic completion. Not tier-3.
- **Verdict:** Incompatible with project goals.

## Reasoning

The Phase 0 investigation (see `docs/pike-interface.md`) confirms:

1. **Diagnostics are fully achievable.** Running `pike file.pike 2>&1` produces stable, parseable error output in `<filepath>:<line>:<message>` format. Exit code 1 = compilation failure.
2. **Type information is partially available.** `typeof()` works for expressions and locals. `pike-signature` and `pike-describe-symbol` cover stdlib. Object members return `mixed` at runtime — a real limitation.
3. **pike-ai-kb's MCP tools wrap the most common operations** (syntax check, evaluate, describe symbol, list modules/methods, get signatures). Using these avoids reimplementing invocation, output parsing, and error normalization.

The oracle approach is the only one that can deliver tier-3 features within the project scope. The `typeof() → mixed` limitation for object members is a known constraint that requires source-level parsing as a complement (see decision 0002).

## Consequences

- The LSP requires `pike` to be installed and on PATH.
- Diagnostics latency depends on pike compilation speed (measurable in Phase 1).
- Some type information (object member types) requires source parsing, not oracle queries.
- The harness must capture and normalize pike's text-based error format.
- pike-ai-kb is a runtime dependency; if unavailable, the LSP falls back to direct pike invocation for some features (see decision 0003).
