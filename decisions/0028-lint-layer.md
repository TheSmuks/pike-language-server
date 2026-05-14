# Decision 0028: Fast Tree-Sitter Lint Layer

**Status:** Accepted  
**Date:** 2026-05-14  
**Context:** Phase E of the intelligent LSP features plan.

## Problem

The Pike LSP currently relies on the Pike compiler for all diagnostics. The Pike compiler is thorough (type errors, wrong arity, undefined symbols) but has two limitations:

1. **Latency.** Pike compilation takes ~500ms after debounce (total ~1s from last keystroke). The user sees no diagnostics during this window except parse errors from tree-sitter ERROR nodes.

2. **Fragility.** If the file has a compilation error early on, Pike stops before reaching later analysis phases. Unused variable warnings, for example, only appear when the file compiles cleanly. A single syntax error suppresses all code quality diagnostics.

## Decision

Add a **fast lint layer** that runs synchronously on every tree-sitter parse (i.e., on every keystroke) and produces diagnostics from the AST and symbol table alone. This layer does NOT attempt type checking — it catches structural issues:

| Rule | Severity | Condition |
|------|----------|-----------|
| Unused local variable | Hint | Variable declared in local scope with zero references and not `_`-prefixed |
| Unused parameter | Hint | Function parameter with zero references and not `_`-prefixed |
| Unreachable code | Warning | Statements following `return`/`break`/`continue` in the same block |
| Missing return | Hint | Non-void function with zero `return` statements |
| Unused import/inherit | Hint | Import/inherit with no references to its symbols |

All lint diagnostics use source `pike-lsp-lint` and severity `Hint` or `Warning`. They are published immediately on parse and merged with Pike compiler diagnostics. When Pike produces a diagnostic on the same line, Pike takes precedence.

## Architecture

```
                    textDocument/didChange
                           │
                     tree-sitter parse
                           │
                ┌──────────┼──────────┐
                │          │          │
          parse errors   lint rules  (existing)
          (P1xxx)        (P3xxx)     PikeWorker
                │          │        diagnose (debounced)
                │          │          │
                └──────────┼──────────┘
                           │
                    diagnosticManager
                    (merge + dedup)
                           │
                    publishDiagnostics
```

Lint rules are pure functions: `(tree: Tree, symbolTable: SymbolTable, source: string) => Diagnostic[]`. They have no side effects and no async operations. They run in the same microtask as the parse.

## Diagnostic Code Ranges

| Source | Range |
|--------|-------|
| `pike-lsp` (parse) | P1000–P1999 |
| `pike-lsp-lint` | P3000–P3999 |
| `pike` (compiler) | Pike's own codes |

| Code | Rule |
|------|------|
| P3001 | Unused local variable |
| P3002 | Unused parameter |
| P3003 | Unreachable code |
| P3004 | Missing return statement |
| P3005 | Unused import/inherit |

## Merge Strategy

Diagnostics from all sources are merged per-file. The merge strategy:

1. Parse diagnostics (`pike-lsp`) are always shown (they indicate broken syntax).
2. Lint diagnostics (`pike-lsp-lint`) are shown unless a Pike compiler diagnostic exists on the same line.
3. Pike compiler diagnostics (`pike`) are authoritative — they supersede lint on the same line.

Rationale: Pike's type errors are more specific than lint's structural analysis. If Pike says "Bad type in assignment on line 5," lint's "Unused variable on line 5" is likely wrong (the variable IS used, just incorrectly).

## Performance Budget

Each lint rule MUST complete in <2ms on a 500-line file. Total lint pipeline <5ms. This is measured by adding timing in the lint orchestrator and asserting in tests.

The symbol table and parse tree are already in memory (from the incremental parse on keystroke). No additional I/O or async work is needed.

## Why Not In TypeScript

We could build a full type checker in TypeScript (like rust-analyzer's HIR). We deliberately don't. Rationale:

1. Pike's type system is complex (nominal + structural, compile-time evaluation, dynamic inheritance). Reimplementing it would be a multi-month project with ongoing maintenance burden as Pike evolves.

2. The Pike compiler is already correct and comprehensive. The LSP's job is to surface its output quickly, not to replace it.

3. The structural checks (unused, unreachable) provide 80% of the value with 5% of the effort. They don't require type information.

## Testing Strategy

Each lint rule gets its own test file with corpus files. Tests follow the existing pattern:
1. Create a Pike source file that triggers the rule
2. Build the symbol table via `parse()` + `buildSymbolTable()`
3. Run the lint rule
4. Assert the expected diagnostics

The Pike compiler is NOT used for lint rule tests — lint rules are pure tree-sitter + symbol table analysis. This makes them fast and deterministic.

## Future Extensions

- P3006: Unused class field (low value — may be used externally)
- P3007: Duplicate import (same module imported twice)
- P3008: Shadowed variable (local shadows outer scope)
- Inlay hints (Phase G) — not diagnostics but related to code quality display

These are NOT in the initial implementation. YAGNI.
