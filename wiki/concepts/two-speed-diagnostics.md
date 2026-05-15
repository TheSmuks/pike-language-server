---
title: Two-Speed Diagnostics
created: 2026-05-15
updated: 2026-05-15
type: concept
tags:
  - diagnostics
  - performance
  - architecture
sources:
  - raw/articles/architecture.md
---

# Two-Speed Diagnostics

The Pike Language Server uses a two-speed diagnostic architecture that balances
responsiveness with accuracy. Two independent diagnostic layers run on different
triggers with different latency profiles.

## Fast Layer: Tree-Sitter Lint

| Property | Value |
|----------|-------|
| Source | Tree-sitter parse tree |
| Latency | <5ms |
| Trigger | Every keystroke |
| Scope | Structural / syntactic issues |

The fast layer detects structural problems without invoking the Pike compiler:

- Syntax errors (parse failures)
- Unmatched braces and delimiters
- Unused variables (P3001) and parameters (P3002)
- Unreachable code (P3003)
- Missing return statements (P3004)
- Unused imports (P3005)

Lint diagnostics are **suppressed on lines where the Pike compiler provides
diagnostics** — Pike is always authoritative. This prevents duplicate or
conflicting messages from the two layers.

## Slow Layer: Pike Compilation

| Property | Value |
|----------|-------|
| Source | Pike compiler via `compile_string` |
| Latency | ~500ms (debounced) |
| Trigger | Debounced after edit |
| Scope | Semantic / type issues |

The slow layer provides ground-truth semantic diagnostics:

- Type errors (bad assignment, wrong argument types)
- Undefined identifier references
- Incorrect function arity
- Import/inherit resolution failures
- Strict types violations

The Pike worker subprocess compiles the document using `compile_string` with a
custom `CompilationHandler` that produces structured diagnostics. Error output
is parsed from the stable `<filepath>:<line>:<message>` format (or received
directly as structured JSON from the handler).

## Layer Interaction

```
User types → Fast lint (<5ms) → Immediate feedback
                ↓ (debounce ~500ms)
           Slow compile → Authoritative diagnostics
                ↓
           Fast lint suppressed on Pike-diagnosed lines
```

## Design Rationale

On the shared-server deployment (see [[deployment-context]]), CPU is contested
among multiple developers. Running Pike compilation on every keystroke would
saturate the CPU. The two-speed design ensures instant structural feedback while
debouncing the expensive semantic check.

See [[pike]] for the compiler interface and [[tree-sitter-pike]] for the
syntactic parser. The Pike subprocess is managed by [[pike-worker]] with
[[lsp-approaches]] for the design rationale (gopls-style diagnostic debouncing).
