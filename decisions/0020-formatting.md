# Decision 0020: Source Code Formatting (Phase 16)

**Date:** 2026-05-02
**Status:** Proposed

## Context

The project has implemented all core Tier-3 LSP features through Phase 15 (documentSymbol, definition, references, hover, diagnostics, completion, rename, semantic tokens, document highlight, folding range, signature help, code actions, workspace symbol). Formatting (`textDocument/formatting`) is the next feature to implement.

Pike source code formatting requirements:
- **2-space indentation** (Pike stdlib convention)
- **Opening brace on same line** as declaration (`class Foo {`, `void create() {`)
- **No space before `(`** in function declarations/calls
- **Space after `//` and `//!`** in comments
- **Blank line between top-level declarations** (class, function) — inconsistently applied

## Decision

Implement `textDocument/formatting` using a **tree-sitter-based formatter**. The formatter walks the parse tree and produces `TextEdit[]` operations.

### Design

1. **Tree-sitter-based formatting** — Walk the parse tree, identify node types, apply formatting rules.
2. **Incremental edits** — Return `TextEdit[]` that the LSP client applies. No in-memory transformation.
3. **Pike convention alignment** — Follow Pike stdlib formatting (2-space indent, brace on same line).

### Implementation

```
server/src/features/
  formatter.ts          # Tree-walking formatter producing TextEdit[]
  formattingHandler.ts   # LSP handler registration

server/src/
  server.ts              # Registered documentFormattingProvider capability + handler
```

### Alternative considered: Topiary

[Topiary](https://github.com/topiary-appointments/topiary) is a tree-sitter query-based formatter using Rust.

**Rejected because:**
- Adds a Rust binary dependency to the project
- Pike grammar version may not be compatible with Topiary's tree-sitter version
- Overkill for the scope (indentation rules, spacing)

### Future enhancements (out of scope for initial implementation)

1. **Formatting options** — `tabSize`, `insertSpaces`, `insertFinalNewline` from LSP `DocumentFormattingOptions`
2. **Range formatting** — `textDocument/formatting` range variant
3. **AutoDoc comment alignment** — Align `//!` with surrounding code
4. **Import grouping** — Sort and group imports

## Follow-up Actions

- [ ] Add formatting tests to `tests/lsp/formatting.test.ts`
- [ ] Test against corpus files to verify formatting rules
- [ ] Document formatting behavior in README or docs/