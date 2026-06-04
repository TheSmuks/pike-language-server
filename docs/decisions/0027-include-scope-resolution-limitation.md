# Decision 0027: Keep `#include` LSP scope merging out of this fix

## Status

Accepted

## Context

Pike `#include` is textual. The compiler preprocesses the included file before
parsing the program, so symbols declared in an included file can be visible in
the including file at runtime.

The LSP currently builds symbol tables from one parsed file at a time. It does
not preprocess the source stream or merge declarations from included files into
the including file's scope. The TextMate grammar highlights `#include`, but LSP
features such as go-to-definition, hover, completion, and references do not treat
included declarations as local declarations.

## Decision

Document `#include` symbol resolution as a known limitation instead of merging
included scopes in the cross-file refresh fix.

This change focuses on import/inherit resolution, stale CodeLens/diagnostics
after background indexing, and the unused-import false positive. Include-aware
scope merging is a separate feature because it must define ordering, duplicate
symbol behavior, include cycles, include-path resolution, and cache invalidation
for textual expansion.

## Consequences

- `#include` directives remain syntax-highlighted.
- Symbols that only exist in included files may not resolve from the including
  file in LSP features.
- Future work should add a bounded include graph and merge included declarations
  before building the final symbol table for the including file.
- The limitation is tracked in `docs/known-limitations.md`.
